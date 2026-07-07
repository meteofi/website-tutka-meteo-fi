// deploy-marker: sw-update-flow-test — bump on PR #87 to force a fresh
// radar.[contenthash].js so the deployed test build differs from the
// previous one and the new banner flow can be exercised end-to-end.
import { View } from 'ol';
import Geolocation from 'ol/Geolocation';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import Vector from 'ol/source/Vector';
import { fromLonLat, transform, transformExtent } from 'ol/proj';
import sync from 'ol-hashed';
import Feature from 'ol/Feature';
import Polygon, { circular } from 'ol/geom/Polygon';
import Point from 'ol/geom/Point';
import {
  Circle as CircleStyle, Fill, Stroke, Style, Text,
} from 'ol/style';
import LatLon from 'geodesy/latlon-spherical';
import WMSCapabilities from 'ol/format/WMSCapabilities';
import { VERSION as OL_VERSION } from 'ol/util';
import dayjs from 'dayjs';
import 'dayjs/locale/fi';
import utcPlugin from 'dayjs/plugin/utc';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import durationPlugin from 'dayjs/plugin/duration';
import Timeline from './timeline';
import createPane from './pane';
import wmsServerConfiguration from './config';
import createLongPressHandler, { longPressMenuOpener } from './longpress';
import initTools from './tools';
import initProbe from './probe';
import initRadarSite from './radarSite';
import initCrosshair from './crosshair';
import FramePool from './animation/framePool';
import { canInterpolate, RadarInterpolator } from './animation/interpolation';
import { track } from './analytics';

dayjs.locale('fi');
dayjs.extend(utcPlugin);
dayjs.extend(localizedFormat);
dayjs.extend(durationPlugin);

const options = {
  defaultRadarLayer: 'fmi-radar-composite-dbz',
  defaultLightningLayer: 'observation:lightning',
  defaultObservationLayer: 'observation:airtemperature',
  radialSpacing: 30,
  frameRate: 2, // fps
  defaultFrameRate: 2, // fps
  imageRatio: 1.5,
  wmsServerConfiguration,
};

const DEBUG = false;

function safeParseJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v != null ? v : fallback; } catch (e) { return fallback; }
}

const metPosition = safeParseJSON('metPosition', []);
const metZoom = Number(localStorage.getItem('metZoom')) || 9;
let ownPosition = [];
let ownPosition4326 = [];
let geolocation;
let tools = null;
let probe = null;
let radarSite = null;
let crosshair = null;
let startDate = new Date(Math.floor(Date.now() / 300000) * 300000 - 300000 * 12);
// Handle of the currently-running playback loop (now a requestAnimationFrame
// id — was a setInterval handle before the RAF refactor). Null when paused.
let animationId = null;
let lastAdvance = 0;
let lastWarpTick = 0;
// True while the user is mid pan/zoom on any pane — gates clock advance and
// warp renders. Declared up here (used by the pane clock-gating helpers and
// renderTick) so it precedes its first reference.
let isInteracting = false;
const layerInfo = {};
let timeline;
let mapTime = '';
let appFullscreen = false;
const framePools = {
  satelliteLayer: null,
  radarLayer: null,
  lightningLayer: null,
  observationLayer: null,
};
// All created panes (index 0..3), cached across layout switches. Declared early
// so the interpolator/timeline helpers above the pane bootstrap can reference
// it. pane 0 is pushed in the bootstrap below; setLayout() adds the rest.
const panes = [];

// The four content categories + their pill icon and shared sublayer-menu id.
// Declared up here so the per-pane init helpers (initNewPane / buildPanePill)
// can reference them.
const PILL_CATEGORIES = ['satelliteLayer', 'radarLayer', 'lightningLayer', 'observationLayer'];
const CATEGORY_UI = {
  satelliteLayer: { icon: 'satellite_alt', menu: 'satelliteLongPressMenu', aria: 'Satelliitti' },
  radarLayer: { icon: 'radar', menu: 'radarLongPressMenu', aria: 'Säätutka' },
  lightningLayer: { icon: 'bolt', menu: 'lightningLongPressMenu', aria: 'Salamat' },
  observationLayer: { icon: 'thermostat', menu: 'observationLongPressMenu', aria: 'Havainto' },
};

// Three interpolation modes:
//   - 'off'       : no warp layer; animation shows discrete frames only.
//   - 'crossfade' : warp layer with zero-flow — smooth A→B fade.
//   - 'flow'      : warp layer with LK-computed optical flow — motion-
//                   compensated interpolation.
// Resolved on boot from URL override (?interp=…) then localStorage.
// Default is 'off' (discrete frames, the historical behavior). A
// stored mode that's no longer in VALID_INTERP_MODES — e.g. if we
// ever rename or drop an option — is ignored and the default wins,
// so the live storage format is self-healing across releases.
const VALID_INTERP_MODES = ['off', 'crossfade', 'flow'];
const INTERP_MODE_KEY = 'interpMode';
const DEFAULT_INTERP_MODE = 'off';
let interpMode = DEFAULT_INTERP_MODE;
let interpCapable = false;

function readInitialInterpMode() {
  const urlMode = new URLSearchParams(window.location.search).get('interp');
  if (VALID_INTERP_MODES.includes(urlMode)) return urlMode;
  const stored = localStorage.getItem(INTERP_MODE_KEY);
  if (VALID_INTERP_MODES.includes(stored)) return stored;
  return DEFAULT_INTERP_MODE;
}

canInterpolate().then((ok) => {
  interpCapable = ok;
  interpMode = ok ? readInitialInterpMode() : DEFAULT_INTERP_MODE;
  debug(`[tutka] INTERP: capable=${ok} mode=${interpMode}`);
  trackBoot({ capable: ok, mode: interpMode });
  attachInterpolators();
  updateInterpChipsState();
}).catch((err) => {
  debug(`[tutka] INTERP probe failed: ${err && err.message}`);
  trackBoot({ capable: false, mode: DEFAULT_INTERP_MODE, error: true });
});

function attachInterpolators() {
  if (interpMode === 'off') return;
  const playing = animationId !== null;
  const useFlow = interpMode === 'flow';
  for (const pane of activePanes()) {
    for (const name of ['radarLayer', 'satelliteLayer']) {
      const pool = pane.framePools[name];
      if (pool && !pool.interpolator) {
        // WebGL2 context creation can fail even though the boot probe
        // passed: browsers cap live contexts (~8-16) and 4-up with radar +
        // satellite wants up to 8. Leave this pool on discrete frames
        // instead of letting the throw abort the caller mid-layout with a
        // half-initialized split.
        let interpolator = null;
        try {
          interpolator = new RadarInterpolator({ useFlow });
        } catch (err) {
          debug(`RadarInterpolator unavailable (pane ${pane.index} ${name}): ${err.message}`);
        }
        if (interpolator) {
          pool.setInterpolator(interpolator);
          pool.refreshFlows();
          if (playing) pool.setInterpActive(true);
        }
      }
    }
  }
}

// Tear down one pane's interpolators, releasing their GL resources. Used both
// when interp is switched off and when a pane drops out of the active set.
function detachPaneInterpolators(pane) {
  for (const name of ['radarLayer', 'satelliteLayer']) {
    const pool = pane.framePools[name];
    if (pool && pool.interpolator) {
      pool.setInterpActive(false);
      pool.setInterpolator(null);
    }
  }
}

function detachInterpolators() {
  // Detach from ALL panes (including inactive ones) so toggling interp off
  // fully releases GPU resources regardless of the current layout.
  for (const pane of panes) detachPaneInterpolators(pane);
}

function setInterpMode(mode) {
  if (!VALID_INTERP_MODES.includes(mode)) return;
  if (mode !== 'off' && !interpCapable) return;
  if (interpMode === mode) return;
  const prev = interpMode;
  interpMode = mode;
  localStorage.setItem(INTERP_MODE_KEY, mode);
  if (mode === 'off') {
    detachInterpolators();
  } else if (prev === 'off') {
    attachInterpolators();
  } else {
    // Swap between crossfade and flow on existing interpolators —
    // cheaper than rebuilding the whole pipeline.
    const useFlow = mode === 'flow';
    for (const pane of activePanes()) {
      for (const name of ['radarLayer', 'satelliteLayer']) {
        const pool = pane.framePools[name];
        if (pool && pool.interpolator) {
          pool.interpolator.setUseFlow(useFlow);
          pool.refreshFlows();
        }
      }
    }
  }
  updateInterpChipsState();
  track('interp-mode', { mode });
}

function updateInterpChipsState() {
  document.querySelectorAll('#overflowMenu .chip[data-interp]').forEach((chip) => {
    const m = chip.getAttribute('data-interp');
    chip.setAttribute('aria-checked', String(m === interpMode));
    if (!interpCapable && m !== 'off') {
      chip.setAttribute('aria-disabled', 'true');
    } else {
      chip.removeAttribute('aria-disabled');
    }
  });
}
// Per-(pane, category) timeline state, keyed `${paneIndex}:${name}`. A timeline
// cell is "loaded" only when every visible (pane, layer) pool has that index
// loaded; "flow pending" if any interpolator-bearing pool isn't flow-ready.
// buildPanePools() seeds the keys for each pane as it's created.
//
// poolFlowStates is only populated for pools that have an interpolator attached
// (radar, satellite when interp is enabled). True means both endpoints of the
// pair starting at this index are loaded AND the interpolator has a computed
// flow field — playback through this timestep shows a motion-compensated warp
// instead of a jump to the next discrete frame.
const poolLoadStates = {};
const poolFlowStates = {};

const VISIBLE = new Set(safeParseJSON('VISIBLE', ['radarLayer']));
// Per-layer "is the chosen time inside this layer's data range?" — updated
// by setTime, read by renderTick. Out-of-range layers must skip both
// pool.setWindow/showTime (in setTime) AND pool.showInterpolated (in
// renderTick) — otherwise the FramePool keeps swapping sources for the
// requested old time and the WMS server returns whatever it has closest,
// painting wrong-timestep frames.
const LAYER_IN_RANGE = {};

// Per-category sublayer memory: { radarLayer: 'fmi-radar-composite-dbz', ... }
// Saved on every updateLayer() call, restored when the matching WMS
// GetCapabilities response confirms the stored sublayer is still
// supported. Unknown / dropped layers are evicted automatically.
const ACTIVE_LAYERS = (() => {
  const raw = safeParseJSON('ACTIVE_LAYERS', null);
  return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
})();
function persistActiveLayers() {
  localStorage.setItem('ACTIVE_LAYERS', JSON.stringify(ACTIVE_LAYERS));
}

function updateTimelineCell(i) {
  if (!timeline) return;
  let allLoaded = true;
  let flowPending = false;
  // Aggregate across every active pane's visible pools — the shared timeline
  // reflects the whole split: a cell is ready only when all panes have it.
  for (const pane of activePanes()) {
    for (const name of Object.keys(pane.framePools)) {
      const pool = pane.framePools[name];
      if (!pool || !pane.VISIBLE.has(name)) continue; // eslint-disable-line no-continue
      const key = `${pane.index}:${name}`;
      const load = poolLoadStates[key];
      if (!load || !load[i]) allLoaded = false;
      // A pool only marks flow-pending if it actually has an interpolator
      // attached. Lightning/observation (no interp) and radar/satellite with
      // mode=off never flag this cell.
      const flow = poolFlowStates[key];
      if (pool.interpolator && (!flow || !flow[i])) flowPending = true;
    }
  }
  timeline.setLoadState(i, allLoaded);
  // Flow-pending only meaningful when the cell is loaded — a not-
  // yet-loaded cell is shown as "loading" with priority anyway.
  timeline.setFlowPending(i, allLoaded && flowPending);
}

function recomputeAllTimelineCells() {
  for (let i = 0; i < 13; i++) updateTimelineCell(i);
}

// One-time migration of a deprecated FMI openwms layer name.
if (ACTIVE_LAYERS.radarLayer === 'suomi_dbz_eureffin') {
  ACTIVE_LAYERS.radarLayer = 'fmi-radar-composite-dbz';
  persistActiveLayers();
}
// IS_DARK: null = auto (follow OS), true = user picked dark, false = user picked light
let IS_DARK = safeParseJSON('IS_DARK', null);
let IS_TRACKING = safeParseJSON('IS_TRACKING', false);
let IS_FOLLOWING = safeParseJSON('IS_FOLLOWING', false);

function debug(str) {
  if (DEBUG) {
    try {
      // eslint-disable-next-line no-console
      console.log(str);
    } catch (e) { /* ignore */ }
  }
}

// OL layer name → headline event name. Only the four content categories
// emit per-category events; helper layers (basemap, position, etc.) are
// silent.
const CATEGORY_EVENT = {
  satelliteLayer: 'satellite',
  radarLayer: 'radar',
  lightningLayer: 'lightning',
  observationLayer: 'observation',
};

function trackCategory(layer, props) {
  const event = CATEGORY_EVENT[layer.get('name')];
  if (event) track(event, props);
}

ImageLayer.prototype.setLayerUrl = function (url) {
  debug(`Set layer url: ${url}`);
  this.getSource().setUrl(url);
};

ImageLayer.prototype.setLayerStyle = function (style, source) {
  debug(`Set layer style: ${style}`);
  this.getSource().updateParams({ STYLES: style });
  if (source) trackCategory(this, { action: 'style', style, source });
};

// STYLES
const style = new Style({
  fill: new Fill({
    color: 'rgba(255, 255, 255, 0.6)',
  }),
  stroke: new Stroke({
    color: '#D32D25',
    width: 1,
  }),
  text: new Text({
    font: '16px Calibri,sans-serif',
    fill: new Fill({
      color: '#fff',
    }),
    stroke: new Stroke({
      color: '#000',
      width: 2,
    }),
    offsetX: 0,
    offsetY: -20,
  }),
});

const radarStyle = new Style({
  image: new CircleStyle({
    radius: 4,
    fill: null,
    stroke: new Stroke({ color: 'red', width: 2 }),
  }),
  text: new Text({
    font: '12px Calibri,sans-serif',
    fill: new Fill({
      color: '#fff',
    }),
    stroke: new Stroke({
      color: '#000',
      width: 3,
    }),
    offsetX: 0,
    offsetY: -15,
  }),
});

// Light + dark label colours swap from setMapLayer. A single colour set
// can't satisfy both: a black halo on the light basemap reads as thick
// and dominates the dim-white fill; a white halo on the dark basemap
// glows around the dim-grey fill. Invert per theme so the halo always
// sinks into the background rather than ringing the text.
const icaoTextColors = {
  light: { fill: '#222', halo: '#ffffff' },
  dark: { fill: '#cccccc', halo: '#000000' },
};
const icaoStyle = new Style({
  image: new CircleStyle({
    radius: 4,
    fill: null,
    stroke: new Stroke({ color: '#a040c0', width: 2 }),
  }),
  text: new Text({
    font: '12px Calibri,sans-serif',
    fill: new Fill({ color: icaoTextColors.dark.fill }),
    stroke: new Stroke({ color: icaoTextColors.dark.halo, width: 2.5 }),
    offsetX: 0,
    offsetY: -15,
  }),
});

// Municipality polygons (Kunnat) — boundary-only stroke. No labels: every
// municipality is a multipolygon (islands, exclaves) so the per-polygon
// interior-point placement scatters the name across the map, often well
// away from the population centre.
//
// Two style variants because a single neutral gray reads poorly at both
// extremes: the previous near-black stroke dominated the light basemap
// and vanished into the dark one. Light theme gets a soft dark gray at
// low alpha so it sits behind the radar without competing; dark theme
// gets a lavender tint that lifts the borders off the near-black map and
// stays legible on small mobile screens.
const municipalityStyleLight = new Style({
  stroke: new Stroke({
    color: [80, 80, 80, 0.45],
    width: 1,
  }),
});
const municipalityStyleDark = new Style({
  stroke: new Stroke({
    color: [130, 110, 220, 0.95],
    width: 1.5,
  }),
});

// Waterways / fairways (Vesiväylät). Stroke weight follows the fairway
// class — VL1 (commercial main route) reads heaviest, minor routes
// tail off. Cyan/teal hue keeps the layer from colliding with the blue
// of the airspace layer when both are on.
function makeVesivaylatStyles(palette) {
  const stroke = (color, width) => new Style({ stroke: new Stroke({ color, width }) });
  return {
    1: stroke(palette.main, 1.8),
    2: stroke(palette.main, 1.4),
    3: stroke(palette.secondary, 1.1),
    default: stroke(palette.secondary, 0.8),
  };
}
const vesivaylatStylesLight = makeVesivaylatStyles({
  main: [0, 110, 160, 0.7],
  secondary: [0, 130, 180, 0.5],
});
const vesivaylatStylesDark = makeVesivaylatStyles({
  main: [100, 220, 240, 0.9],
  secondary: [80, 190, 220, 0.7],
});
let vesivaylatStyleSet = vesivaylatStylesLight;

// Fairway navigation areas (vaylaalueet_uusi) — MultiPolygons of the
// channel footprint, rendered as a subtle dark wash behind the line
// geometry so the user sees "this whole zone is the fairway, not just
// the centreline". Theme-aware alpha: dark basemap needs more opacity
// to register, light basemap needs less so the wash doesn't dominate.
const vesivaylaAreaFills = {
  light: 'rgba(0, 0, 0, 0.13)',
  dark: 'rgba(0, 0, 0, 0.35)',
};
const vesivaylaAreaStyle = new Style({
  fill: new Fill({ color: vesivaylaAreaFills.light }),
});

// Label nimifi along each fairway when zoomed in enough to actually read
// it. Resolution is m/pixel; ≤ 200 m/px lands around zoom 10-11, which is
// roughly "looking at a single bay or harbour". Above that threshold the
// labels would just be a smear of unreadable text across the country.
const VESIVAYLAT_LABEL_MAX_RES = 200;
const vesivaylatLabelColors = {
  light: { fill: '#003e58', halo: '#ffffff' },
  dark: { fill: '#e0f6ff', halo: '#000000' },
};
const vesivaylatLabelStyle = new Style({
  text: new Text({
    font: '11px Calibri,sans-serif',
    placement: 'line',
    overflow: false,
    fill: new Fill({ color: vesivaylatLabelColors.light.fill }),
    stroke: new Stroke({ color: vesivaylatLabelColors.light.halo, width: 2.5 }),
  }),
});

function vesivaylatStyleFn(feature, resolution) {
  const cls = feature.get('vaylaluokkakoodi');
  const base = vesivaylatStyleSet[cls] || vesivaylatStyleSet.default;
  if (resolution > VESIVAYLAT_LABEL_MAX_RES) return base;
  const name = feature.get('nimifi');
  if (!name) return base;
  vesivaylatLabelStyle.getText().setText(name);
  return [base, vesivaylatLabelStyle];
}

const rangeStyle = new Style({
  stroke: new Stroke({
    color: [128, 128, 128, 0.7],
    width: 0.5,
  }),
  text: new Text({
    font: '16px Calibri,sans-serif',
    fill: new Fill({
      color: '#fff',
    }),
    stroke: new Stroke({
      color: '#000',
      width: 2,
    }),
    offsetX: 0,
    offsetY: 0,
    textAlign: 'left',
  }),
});

//
// LAYERS + MAP
//
// The basemaps, content layers, vector overlays and the OpenLayers Map are now
// built per pane by createPane() in src/pane.js — OL layers cannot be shared
// across maps, so each split pane needs its own instances. The single shared
// `radarSiteSource` below feeds every pane's radar-site layer. The pane
// bootstrap (createPane + pane-0 aliases) runs just below the source.

// Radar-site markers track the live radar network rather than a hand-edited
// file: two meteocore OGC API Features collections are fetched and merged —
// Finland (fi-radar-pvol) and Estonia (ee-radar-volume). Each feature's
// `name` is the official station name used for the label. If both live
// fetches fail (offline PWA, meteocore unreachable), fall back to the bundled
// snapshot so markers still render. Default 'all' loading strategy → the
// loader runs once for the world extent.
const RADAR_SITE_COLLECTIONS = [
  'https://meteocore.app.meteo.fi/features/collections/fi-radar-pvol/items?f=application/geo%2Bjson&limit=1000',
  'https://meteocore.app.meteo.fi/features/collections/ee-radar-volume/items?f=application/geo%2Bjson&limit=1000',
];
const RADAR_SITE_FALLBACK_URL = 'radars-finland.json';

const radarSiteSource = new Vector({
  format: new GeoJSON(),
  attributions: 'FMI / Estonian Environment Agency (CC BY 4.0)',
  loader: (extent, resolution, projection, success, failure) => {
    const readInto = (geojson) => {
      const features = radarSiteSource.getFormat()
        .readFeatures(geojson, { featureProjection: projection });
      radarSiteSource.addFeatures(features);
      return features;
    };
    const fetchJson = (url) => fetch(url).then((res) => {
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res.json();
    });

    Promise.all(RADAR_SITE_COLLECTIONS.map(fetchJson))
      .then((collections) => success(collections.flatMap(readInto)))
      .catch((err) => {
        debug(`Live radar sites unavailable (${err}); using bundled fallback.`);
        fetchJson(RADAR_SITE_FALLBACK_URL)
          .then((geojson) => success(readInto(geojson)))
          .catch(() => {
            radarSiteSource.removeLoadedExtent(extent);
            failure();
          });
      });
  },
});

//
// PANES — one OpenLayers Map per split pane, all sharing ONE View so they
// pan/zoom in lockstep (the canonical OL "shared view" pattern). Pane 0 is the
// original single map; its layer/state objects are aliased to the module
// globals below so the rest of this file is unchanged. setLayout() adds further
// panes on the same shared view.
//
const sharedView = new View({
  enableRotation: false,
  center: fromLonLat([26, 65]),
  maxZoom: 16,
  zoom: 5,
  // MeteoCore server contract (see CLAUDE.md): GetMap requests must sit on
  // the discrete Web-Mercator zoom ladder — the server's render/tile cache is
  // keyed on it, and every fractional zoom pays a fresh cold render. Snapping
  // the shared View keeps all panes' requests cache-aligned; pinch/wheel
  // gestures stay smooth and settle on an integer level at gesture end.
  constrainResolution: true,
});

// Shared dependencies every pane's layers reference — Style objects/functions
// and the radar-site VectorSource. Passed into createPane so src/pane.js stays
// free of app state.
const paneDeps = {
  options,
  radarSiteSource,
  radarStyle,
  icaoStyle,
  municipalityStyleLight,
  vesivaylatStyleFn,
  vesivaylaAreaStyle,
  rangeStyle,
};

const pane0 = createPane(document.getElementById('map'), sharedView, {
  ...paneDeps,
  index: 0,
  // Pane 0 reuses the existing module-global state objects so the aliases
  // below point at the very same instances the rest of the file mutates.
  visible: VISIBLE,
  activeLayers: ACTIVE_LAYERS,
  layerInRange: LAYER_IN_RANGE,
  framePools,
});
panes.push(pane0);

// Pane-0 aliases — keep the original single-map identifiers working unchanged.
// Only the handles still referenced directly by radar.js are aliased; the
// basemaps, municipality and fairway layers are now reached via `pane.*` in the
// theme/POI fan-outs.
const { map, layerss } = pane0;
const {
  satelliteLayer,
  radarLayer,
  lightningLayer,
  observationLayer,
  radarSiteLayer,
  guideLayer,
} = pane0;

//
// LAYOUT — 1-up (default) / 2-up / 4-up. Panes are created lazily and cached;
// the active count drives which ones the clock + UI fan out to. Inactive panes'
// divs are display:none, so their map size is 0 and their FramePools idle via
// the FramePool getSize/getVisible guards (no special teardown needed).
//
const LAYOUT_ACTIVE_COUNT = { '1-up': 1, '2-up': 2, '4-up': 4 };
let layoutMode = '1-up';
let activeCount = 1;

function activePanes() {
  return panes.slice(0, activeCount);
}

// Clock interaction gating, wired on EVERY active pane's map. A drag fires
// pointerdrag on the pane the user touched; the shared view means moveend then
// fires on every pane. Both are idempotent, so binding to all panes is safe and
// keeps `isInteracting` correct no matter which pane is dragged.
function onPanePointerDrag() { isInteracting = true; }
function onPaneMoveEnd() {
  isInteracting = false;
  // Defer the next advance by a full step after any view change (see the
  // original moveend note: avoids racing the moveend-triggered prefetch).
  lastAdvance = window.performance.now();
  const zoom = Math.min(sharedView.getZoom(), 16);
  localStorage.setItem('metZoom', zoom);
}
function wirePaneClockGating(pane) {
  pane.map.on('pointerdrag', onPanePointerDrag);
  pane.map.on('moveend', onPaneMoveEnd);
}

// Copy pane 0's current display state (sublayer params, info, opacity,
// visibility) onto a freshly-created pane so a new split starts as a mirror of
// what's on screen; the user then edits it independently (Stage 3).
function clonePaneDisplay(src, dst) {
  ['satelliteLayer', 'radarLayer', 'lightningLayer', 'observationLayer'].forEach((name) => {
    const s = src.layerss[name];
    const d = dst.layerss[name];
    const ssrc = s.getSource();
    const dsrc = d.getSource();
    if (dsrc.getUrl() !== ssrc.getUrl()) dsrc.setUrl(ssrc.getUrl());
    dsrc.updateParams({ ...ssrc.getParams() });
    d.set('info', s.get('info'));
    // The interpolator's transparent swap holds the actual opacity at 0 while
    // the warp renders; _userOpacity carries the user's chosen value (and is
    // undefined whenever no interpolator is attached). Cloning getOpacity()
    // here would capture the swap state and leave the new pane invisible.
    const srcUserOpacity = s.get('_userOpacity');
    d.setOpacity(srcUserOpacity !== undefined ? srcUserOpacity : s.getOpacity());
    d.setVisible(s.getVisible());
    if (s.getVisible()) dst.VISIBLE.add(name); else dst.VISIBLE.delete(name);
    dst.ACTIVE_LAYERS[name] = src.ACTIVE_LAYERS[name];
    // Single-site drill-in is a pane-0-only mode (radarSite holds only pane
    // 0's radar layer), so a new pane can't participate in it: exit would
    // never restore it, and the next 60 s capabilities refresh would silently
    // flip it to the stored composite anyway (restoreActiveLayer's skip guard
    // covers pane 0 only). Start the new pane on the saved composite instead;
    // updateLayer clears the cloned site ELEVATION in its params update.
    if (name === 'radarLayer' && radarSite && radarSite.isSingleSiteActive()) {
      const composite = radarSite.getSavedComposite();
      if (composite) {
        updateLayer(d, composite, { skipVisibility: true, skipTracking: true, skipPersist: true });
      }
    }
  });
}

// One-time wiring for a newly-created pane: build its pools, mirror pane 0's
// content, apply the current theme + POI visibility, attach interpolators, and
// gate the clock off its interactions.
function initNewPane(pane) {
  buildPanePools(pane);
  clonePaneDisplay(pane0, pane);
  // Attach the per-pane visibility listener AFTER mirroring (so the clone
  // doesn't fire a burst of change events before the pane is ready). The
  // playlist propertychange listener is pane-0 only, so it's not attached here.
  for (const name of PILL_CATEGORIES) {
    pane.layerss[name].on('change:visible', onChangeVisible);
  }
  buildPanePill(pane);
  setMapLayer(getEffectiveTheme());
  applyPoiVisibility();
  attachInterpolators();
  wirePaneClockGating(pane);
  // Mirror the GPS marker into the new pane if tracking is on.
  if (IS_TRACKING) {
    pane.ownPositionLayer.setVisible(true);
    if (ownPosition && ownPosition.length > 1) {
      pane.positionFeature.setGeometry(new Point(ownPosition));
    }
  }
}

// Create any panes up to `count` that don't exist yet (targets #map-1..#map-3),
// all sharing the single View.
function ensurePanes(count) {
  for (let i = panes.length; i < count; i++) {
    const el = document.getElementById(`map-${i}`);
    const pane = createPane(el, sharedView, {
      ...paneDeps,
      index: i,
      visible: new Set(pane0.VISIBLE),
      activeLayers: { ...pane0.ACTIVE_LAYERS },
      layerInRange: {},
    });
    panes.push(pane);
    initNewPane(pane);
  }
}

function updateLayoutChipsState() {
  document.querySelectorAll('#overflowMenu .chip[data-layout]').forEach((chip) => {
    chip.setAttribute('aria-checked', String(chip.getAttribute('data-layout') === layoutMode));
  });
}

function resizeAllPanes() {
  for (const pane of panes) pane.updateSize();
}

function setLayout(mode) {
  if (!(mode in LAYOUT_ACTIVE_COUNT)) return;
  layoutMode = mode;
  activeCount = LAYOUT_ACTIVE_COUNT[mode];
  ensurePanes(activeCount);
  // Release interpolator GL resources on panes that just dropped out of the
  // active set (e.g. 4-up → 2-up). They re-attach via attachInterpolators()
  // below when they come back. Without this, up to 8 idle GL interpolators
  // would linger in 4-up after shrinking the layout.
  for (let i = activeCount; i < panes.length; i++) detachPaneInterpolators(panes[i]);
  document.body.classList.toggle('split-2', mode === '2-up');
  document.body.classList.toggle('split-4', mode === '4-up');
  // Let the grid reflow before measuring; then size every map (inactive panes
  // collapse to 0 and idle) and re-drive the active panes for the current time.
  window.requestAnimationFrame(() => {
    resizeAllPanes();
    attachInterpolators();
    setTime('keep');
    recomputeAllTimelineCells();
  });
  updateLayoutChipsState();
  track('layout', { mode });
}

function rangeRings(layer, coordinates, range) {
  if (typeof range === 'number' && layer && coordinates) {
    const ring = circular(coordinates, range);
    const transformedRing = ring.transform('EPSG:4326', map.getView().getProjection());
    const feature = new Feature({
      name: `${range / 1000} km`,
      geometry: transformedRing,
    });

    layer.getSource().addFeatures([feature]);
  }
}

function bearingLine(layer, coordinates, range, direction) {
  const c = new LatLon(coordinates[1], coordinates[0]);
  const p1 = c.destinationPoint(50000, direction);
  const p2 = c.destinationPoint(range * 1000, direction);
  const line = new Polygon([[[p1.lon, p1.lat], [p2.lon, p2.lat]]]);
  layer.getSource().addFeatures([
    new Feature({ name: `${direction}-bearing`, geometry: line.transform('EPSG:4326', map.getView().getProjection()) }),
  ]);
}

// GEOLOCATION Functions

function onChangeAccuracyGeometry(event) {
  debug('Accuracy geometry changed.');
  // One device position, shown in every pane (each pane owns its own feature).
  const geom = event.target.getAccuracyGeometry();
  for (const pane of panes) {
    pane.accuracyFeature.setGeometry(geom ? geom.clone() : null);
  }
}

function onChangeSpeed(event) {
  debug('Speed changed.');
  const speed = event.target.getSpeed();
  if (Number.isFinite(speed)) {
    document.getElementById('currentSpeed').style.display = 'block';
    document.getElementById('currentSpeedValue').innerHTML = Math.round((speed * 3600) / 1000);
  } else {
    document.getElementById('currentSpeed').style.display = 'none';
  }
}

function onChangePosition(event) {
  debug('Position changed.');
  const coordinates = event.target.getPosition();
  ownPosition = coordinates;
  ownPosition4326 = transform(coordinates, map.getView().getProjection(), 'EPSG:4326');
  for (const pane of panes) {
    pane.positionFeature.setGeometry(coordinates ? new Point(coordinates) : null);
  }
  document.getElementById('gpsStatus').innerHTML = 'gps_fixed';
  localStorage.setItem('metPosition', JSON.stringify(ownPosition));
  if (tools) tools.refresh();
}

// Show/hide the GPS marker layer in every pane.
function setOwnPositionVisible(visible) {
  for (const pane of panes) pane.ownPositionLayer.setVisible(visible);
}

// WMS
const currentMapTimeDiv = document.getElementById('currentMapTime');
const currentMapDateDiv = document.getElementById('currentMapDate');
function updateMapTimeDisplay(time) {
  const t = dayjs(time);
  if (t.isValid() && mapTime !== time) {
    currentMapDateDiv.textContent = t.format('l');
    currentMapTimeDiv.textContent = t.format('LT');
    mapTime = time;
    // Flag the play-bar time when the displayed frame is far behind real-clock
    // now — typically means an upstream feed is lagging (e.g. satellite frozen
    // for days) or the user has scrubbed deliberately into the past.
    const ageHours = dayjs().diff(t, 'hour');
    const stale = ageHours >= 24;
    currentMapTimeDiv.classList.toggle('stale', stale);
    currentMapDateDiv.classList.toggle('stale', stale);
    // In fullscreen the bottom-left chip mirrors this data time — refresh it
    // now so it tracks each frame without waiting for the 1 s clock tick.
    if (appFullscreen) renderTimeChip();
  }
}

function updateCanonicalPage() {
  let page = '';
  if (satelliteLayer.getVisible()) {
    const split = satelliteLayer.getSource().getParams().LAYERS.split(':');
    page = `${page}/${(split.length > 1) ? split[1] : split[0]}`;
  }
  if (radarLayer.getVisible()) {
    const split = radarLayer.getSource().getParams().LAYERS.split(':');
    page = `${page}/${(split.length > 1) ? split[1] : split[0]}`;
  }
  if (lightningLayer.getVisible()) {
    const split = lightningLayer.getSource().getParams().LAYERS.split(':');
    page = `${page}/${(split.length > 1) ? split[1] : split[0]}`;
  }
  if (observationLayer.getVisible()) {
    const split = observationLayer.getSource().getParams().LAYERS.split(':');
    page = `${page}/${(split.length > 1) ? split[1] : split[0]}`;
  }
  debug(`Set page: ${page}`);
}

function setTime(action = 'next') {
  let resolution = 300000;
  let end = Math.floor(Date.now() / resolution) * resolution - resolution;
  let start = end - resolution * 12;

  // Compute the shared 13-frame window from the UNION of every active pane's
  // visible layers — time is identical across panes, so one window drives them
  // all. The newest-frame cap (end) and the resolution come from whichever
  // visible layer in any pane is freshest / coarsest.
  for (const pane of activePanes()) {
    for (const item of pane.VISIBLE) {
      const wmslayer = pane.layerss[item].getSource().getParams().LAYERS;
      // getLayerInfo only sets `.time` when GetCapabilities advertises a
      // Dimension, and a malformed dimension can yield non-numeric fields.
      // A layer without a valid time can't constrain the window — skip it
      // rather than throwing here on every tick (which freezes playback).
      const t = wmslayer in layerInfo ? layerInfo[wmslayer].time : null;
      if (t && Number.isFinite(t.end) && Number.isFinite(t.resolution)) {
        if (item === 'radarLayer' || item === 'satelliteLayer' || item === 'observationLayer') {
          end = Math.min(end, Math.floor(t.end / resolution) * resolution);
        }
        resolution = Math.max(resolution, t.resolution);
      }
    }
  }

  end = Math.floor(end / resolution) * resolution;
  start = Math.floor(end / resolution) * resolution - resolution * 12;

  switch (action) {
    case 'first':
      startDate = new Date(start);
      break;
    case 'last':
      startDate = new Date(end);
      break;
    case 'previous':
      startDate.setMinutes(Math.floor(startDate.getMinutes() / (resolution / 60000)) * (resolution / 60000) - resolution / 60000);
      break;
    case 'keep':
      // No-op on startDate; the clamp below will pull it into [start, end]
      // if a visibility change shrunk the window.
      break;
    case 'next':
    default:
      startDate.setMinutes(Math.floor(startDate.getMinutes() / (resolution / 60000)) * (resolution / 60000) + resolution / 60000);
  }

  if (startDate.getTime() > end) {
    // Wrap the cursor back to the window start. Do NOT recreate the Timeline
    // here: rebuilding wipes every cell's loading/flow class, and nothing
    // re-emits them (the pool state callbacks fire only on change), so the
    // indicators went permanently blank after the first playback loop. A pure
    // wrap doesn't change the window, so the existing cell state stays valid;
    // when the window really shifts, pool.setWindow below triggers per-cell
    // load-state callbacks that repaint through updateTimelineCell.
    startDate = new Date(start);
  } else if (startDate.getTime() < start) {
    startDate = new Date(end);
  }

  if (startDate.getTime() === end && animationId === null) {
    IS_FOLLOWING = true;
    localStorage.setItem('IS_FOLLOWING', JSON.stringify(true));
    debug('MODE: FOLLOW');
    document.getElementById('skipNextButton').classList.add('selectedButton');
  } else {
    IS_FOLLOWING = false;
    localStorage.setItem('IS_FOLLOWING', JSON.stringify(false));
    document.getElementById('skipNextButton').classList.remove('selectedButton');
  }

  // updateTimeLine((startDate.getTime()-start)/resolution);
  timeline.update((startDate.getTime() - start) / resolution);
  if (probe) probe.setCursor(startDate.getTime(), start, resolution);
  if (crosshair) crosshair.setCursor(startDate.getTime(), start, resolution);

  // var startDateFormat = moment(startDate.toISOString()).utc().format()
  // debug("---");
  // debug(startDateFormat);
  // debug(startDate.toISOString());
  const timeISO = startDate.toISOString();
  const tNow = startDate.getTime();
  const timeInterval = `PT${resolution / 60000}M/${timeISO}`;
  const windowInstant = [];
  const windowInterval = [];
  for (let i = 0; i <= 12; i++) {
    const t = new Date(start + i * resolution).toISOString();
    windowInstant.push(t);
    windowInterval.push(`PT${resolution / 60000}M/${t}`);
  }
  // Two concerns handled here:
  //   1. Mark the layer that has *stale upstream data* (newest frame older
  //      than 24h). The cause of "everything looks weird" is this layer,
  //      not whichever other layer happens to lose its time-overlap.
  //   2. When the chosen time falls outside this layer's data range, hide
  //      its image (opacity 0) so a previously-loaded frame doesn't stay
  //      stuck on screen.
  const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
  // Route one (pane, category) for the current window. Per-pane concerns —
  // opacity, LAYER_IN_RANGE and the pool's window/time. The shared top toolbar's
  // stale-data button reflects pane 0 only; per-pane pills own their own state.
  const routeLayer = (pane, name, window, currentTime) => {
    const olLayer = pane.layerss[name];
    const button = pane.index === 0 ? document.getElementById(`${name}Button`) : null;
    const pillBtn = pane.pillButtons && pane.pillButtons[name];

    if (!pane.VISIBLE.has(name)) {
      if (button) button.classList.remove('stale-data');
      if (pillBtn) pillBtn.classList.remove('stale-data');
      olLayer.setOpacity(1);
      pane.LAYER_IN_RANGE[name] = true;
      return;
    }

    const wmslayer = olLayer.getSource().getParams().LAYERS;
    const info = wmslayer in layerInfo ? layerInfo[wmslayer].time : null;

    const isStale = !!(info && info.end && Date.now() - info.end > STALE_THRESHOLD_MS);
    if (button) button.classList.toggle('stale-data', isStale);
    if (pillBtn) pillBtn.classList.toggle('stale-data', isStale);

    const inRange = !info || !info.start || !info.end
      || (tNow >= info.start && tNow <= info.end);
    olLayer.setOpacity(inRange ? 1 : 0);
    pane.LAYER_IN_RANGE[name] = inRange;

    if (!inRange) return;

    const pool = pane.framePools[name];
    if (!pool) return;
    pool.setWindow(window);
    pool.showTime(currentTime);
  };
  for (const pane of activePanes()) {
    routeLayer(pane, 'satelliteLayer', windowInstant, timeISO);
    routeLayer(pane, 'radarLayer', windowInstant, timeISO);
    routeLayer(pane, 'lightningLayer', windowInterval, timeInterval);
    routeLayer(pane, 'observationLayer', windowInterval, timeInterval);
  }
  updateMapTimeDisplay(timeISO);
}

//
// TIME CONTROLS
//

function anyPoolZooming() {
  for (const pane of activePanes()) {
    for (const name of Object.keys(pane.framePools)) {
      const p = pane.framePools[name];
      if (p && p.isZoomGestureActive && p.isZoomGestureActive()) return true;
    }
  }
  return false;
}

// Playback loop. Split into two cadences so interpolation can layer on
// top cleanly in later phases:
//   - Advance (slow): bump the discrete timestep by a full frame when
//     wall-clock elapsed exceeds stepDuration. This is today's setTime
//     call. stepDuration is read from options.frameRate on every tick
//     so the speed button takes effect without restart.
//   - Render (fast): every RAF, ask each visible pool to render at the
//     current fractional `t` between the last advance and the next.
//     Phase 1's showInterpolated is a no-op, so playback is visually
//     identical to the previous setInterval-based loop.
//
// isInteracting gates both cadences — OL won't redraw during pan/zoom
// and advancing the clock while the image is frozen would desync the
// timeline from what's on screen.
const renderTick = function (now) {
  animationId = window.requestAnimationFrame(renderTick);
  // Skip both advance and warp render while the user is mid-drag,
  // while OL is mid-tween (e.g., smooth zoom from a scroll wheel),
  // or while any pool is inside an active wheel-zoom gesture (we
  // hold the pause until 300ms after the last wheel event so slow
  // scrolls don't fire prefetch bursts between tween gaps).
  // Without these gates, every wheel tick keeps playback
  // advancing, and each advance fires pool.showTime →
  // _prefetchAroundCurrent → 3-6 WMS fetches per visible pool.
  if (isInteracting || map.getView().getAnimating() || anyPoolZooming()) return;

  const stepDuration = 1000 / options.frameRate;
  if (now - lastAdvance >= stepDuration) {
    lastAdvance = now;
    setTime();
    return;
  }

  // Throttle warp updates to ~30 Hz. Crossfade is visually smooth
  // at 30 fps and halves the number of full OL renders we trigger
  // (each showInterpolated call bumps the warp source's revision,
  // which schedules an OL layer re-render).
  if (now - lastWarpTick < 33) return;
  lastWarpTick = now;

  const t = (now - lastAdvance) / stepDuration;
  for (const pane of activePanes()) {
    for (const name of Object.keys(pane.framePools)) {
      if (!pane.VISIBLE.has(name)) continue; // eslint-disable-line no-continue
      if (pane.LAYER_IN_RANGE[name] === false) continue; // eslint-disable-line no-continue
      const pool = pane.framePools[name];
      if (pool) pool.showInterpolated(t);
    }
  }
};

function setInterpActiveAll(active) {
  for (const pane of activePanes()) {
    for (const name of Object.keys(pane.framePools)) {
      const pool = pane.framePools[name];
      if (pool && pool.interpolator) pool.setInterpActive(active);
    }
  }
}

const play = function () {
  if (animationId === null) {
    debug('PLAY');
    IS_FOLLOWING = false;
    lastAdvance = window.performance.now();
    animationId = window.requestAnimationFrame(renderTick);
    document.getElementById('playstopButton').innerHTML = 'pause';
    setInterpActiveAll(true);
  }
};

const stop = function () {
  if (animationId !== null) {
    debug('STOP');
    IS_FOLLOWING = false;
    window.cancelAnimationFrame(animationId);
    animationId = null;
    document.getElementById('playstopButton').innerHTML = 'play_arrow';
    setInterpActiveAll(false);
  }
};

const skipNext = function () {
  debug('NEXT');
  IS_FOLLOWING = false;
  stop();
  setTime('next');
};

const skipPrevious = function () {
  debug('PREVIOUS');
  IS_FOLLOWING = false;
  stop();
  setTime('previous');
};

const playstop = function () {
  IS_FOLLOWING = false;
  if (animationId !== null) {
    stop();
  } else {
    play();
  }
};

// Start Animation

function getEffectiveTheme() {
  if (IS_DARK !== null) return IS_DARK ? 'dark' : 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Theme is global — the shared Style singletons are mutated once, then every
// pane's vector layers are told to re-render with the new colours.
function applyIcaoTheme(theme) {
  const t = icaoTextColors[theme] || icaoTextColors.dark;
  icaoStyle.getText().getFill().setColor(t.fill);
  icaoStyle.getText().getStroke().setColor(t.halo);
  for (const pane of panes) pane.icaoLayer.changed();
}

function applyVesivaylatTheme(theme) {
  vesivaylatStyleSet = theme === 'light' ? vesivaylatStylesLight : vesivaylatStylesDark;
  const t = vesivaylatLabelColors[theme] || vesivaylatLabelColors.dark;
  vesivaylatLabelStyle.getText().getFill().setColor(t.fill);
  vesivaylatLabelStyle.getText().getStroke().setColor(t.halo);
  vesivaylaAreaStyle.getFill().setColor(vesivaylaAreaFills[theme] || vesivaylaAreaFills.light);
  for (const pane of panes) {
    pane.vesivaylatLayer.changed();
    pane.vesivaylaAreaLayer.changed();
  }
}

function setMapLayer(maplayer) {
  debug(`Set ${maplayer} map.`);
  if (maplayer !== 'light' && maplayer !== 'dark') return;
  const light = maplayer === 'light';
  for (const pane of panes) {
    pane.darkGrayBaseLayer.setVisible(!light);
    pane.darkGrayReferenceLayer.setVisible(!light);
    pane.lightGrayBaseLayer.setVisible(light);
    pane.lightGrayReferenceLayer.setVisible(light);
    pane.municipalityLayer.setStyle(light ? municipalityStyleLight : municipalityStyleDark);
  }
  applyIcaoTheme(maplayer);
  applyVesivaylatTheme(maplayer);
}

function getThemeMode() {
  if (IS_DARK === null) return 'auto';
  return IS_DARK ? 'dark' : 'light';
}

function updateThemeChipsState() {
  const mode = getThemeMode();
  document.querySelectorAll('#overflowMenu .chip[data-theme]').forEach((chip) => {
    const match = chip.getAttribute('data-theme') === mode;
    chip.setAttribute('aria-checked', String(match));
  });
}

function setUserTheme(mode) {
  if (mode === 'auto') {
    IS_DARK = null;
    localStorage.removeItem('IS_DARK');
    setMapLayer(getEffectiveTheme());
  } else {
    IS_DARK = mode === 'dark';
    localStorage.setItem('IS_DARK', JSON.stringify(IS_DARK));
    setMapLayer(mode);
  }
  updateThemeChipsState();
  track('theme-change', { pref: mode, shown: getEffectiveTheme() });
}

// Resolve the GetMap wire format for a sublayer. Precedence: an explicit
// per-layer config override (`info.format`) wins; otherwise image/webp
// when the serving WMS advertised it in GetCapabilities (smaller payload,
// also supports transparency); otherwise the category default. Always
// returns a concrete format, so switching FROM a webp-capable server back
// to one that lacks it resets FORMAT instead of leaving a stale webp.
function resolveFormat(layer, info) {
  if (info && info.format) return info.format;
  if (info && info.webp && !layer.get('disableWebp')) return 'image/webp';
  return layer.get('defaultFormat') || 'image/png';
}

// Re-apply the wire format to a category's source for whatever sublayer
// it currently shows. Called after each GetCapabilities response so a
// server that advertises image/webp is adopted even when the sublayer
// itself didn't change (e.g. the boot-default layer, which updateLayer
// never re-runs for). FramePool mirrors the FORMAT change to its slots
// via its primary-source `change` listener.
function applyWireFormat(layer) {
  const wmslayer = layer.getSource().getParams().LAYERS;
  const info = layerInfo[wmslayer];
  // Until this sublayer's own GetCapabilities has populated layerInfo we
  // don't yet know whether its server advertises webp. Leave FORMAT at
  // the constructor default rather than churning it to png now and to
  // webp later — the intermediate updateParams triggers a needless
  // FramePool resync and an extra round of slot re-requests at startup.
  if (!info) return;
  const fmt = resolveFormat(layer, info);
  if (layer.getSource().getParams().FORMAT !== fmt) {
    layer.getSource().updateParams({ FORMAT: fmt });
  }
}

function updateLayer(layer, wmslayer, opts = {}) {
  const {
    skipVisibility = false, skipTracking = false, skipPersist = false, source, elevation,
  } = opts;
  debug(`Activated layer ${wmslayer}`);
  if (!skipTracking && source) {
    trackCategory(layer, { action: 'pick', layer: wmslayer, source });
  }
  debug(layerInfo[wmslayer]);
  const pane = paneOf(layer);
  const isPane0 = pane === pane0;
  const info = layerInfo[wmslayer];
  layer.set('info', info);
  if (info && info.url) {
    layer.setLayerUrl(info.url);
  }
  // Reset style if the new layer doesn't support the currently active style
  const currentStyle = layer.getSource().getParams().STYLES || '';
  const baseUpdate = { LAYERS: wmslayer };
  // ELEVATION is only meaningful for single-site radar products (radarSite
  // passes it via opts). Set it in the SAME params update as LAYERS: this
  // clears a previous drill-in's sweep on every layer switch — otherwise
  // composite GetMap requests keep carrying the stale ELEVATION to the
  // server. ol/uri drops undefined-valued params from the request URL.
  baseUpdate.ELEVATION = elevation != null ? elevation : undefined;
  // Apply the resolved wire format (webp / per-layer override / category
  // default) and transparency, falling back to the layer's category
  // default so a switch FROM a transparent overlay back to a full-disc
  // image resets the params correctly.
  const defaultTransparent = layer.get('defaultTransparent');
  baseUpdate.FORMAT = resolveFormat(layer, info);
  const wantTransparent = info && info.transparent !== undefined
    ? info.transparent
    : defaultTransparent;
  if (wantTransparent !== undefined) {
    baseUpdate.TRANSPARENT = wantTransparent ? 'TRUE' : 'FALSE';
  }
  if (currentStyle && info && info.style) {
    const validStyles = info.style.map((s) => s.Name);
    if (!validStyles.includes(currentStyle)) {
      layer.getSource().updateParams({ ...baseUpdate, STYLES: '' });
    } else {
      layer.getSource().updateParams(baseUpdate);
    }
  } else if (currentStyle) {
    // No style info available for new layer, reset to default
    layer.getSource().updateParams({ ...baseUpdate, STYLES: '' });
  } else {
    layer.getSource().updateParams(baseUpdate);
  }
  if (!skipPersist) {
    const category = layer.get('name');
    if (category && pane.ACTIVE_LAYERS[category] !== wmslayer) {
      pane.ACTIVE_LAYERS[category] = wmslayer;
      // Only the primary pane persists to localStorage; background panes are
      // re-seeded by mirroring when a split is (re)entered.
      if (isPane0) persistActiveLayers();
    }
  }
  if (!skipVisibility) {
    if (layer.getVisible()) {
      if (isPane0) updateCanonicalPage();
    } else {
      layer.setVisible(true);
    }
  }
  if (isPane0 && probe && layer === radarLayer) {
    // Pass the elevation (set in single-site mode) so the EDR probe queries the
    // displayed sweep; composites carry no ELEVATION param (z stays null).
    probe.setActiveLayer(layer.getVisible() ? wmslayer : null, {
      z: layer.getSource().getParams().ELEVATION,
    });
    if (crosshair) {
      crosshair.setActiveLayer(layer.getVisible() ? wmslayer : null, {
        z: layer.getSource().getParams().ELEVATION,
      });
    }
  }
}

// Pan/zoom the map to a layer's advertised coverage. Used by the radar
// long-press menu so picking e.g. "Ruotsi" recentres on Sweden's radar
// footprint. No-op until the layer's GetCapabilities has populated a
// geographic bounding box, or if the transform yields a degenerate extent
// (e.g. a full-disc box clipped at the Web Mercator poles).
function fitToLayerExtent(wmslayer) {
  const info = layerInfo[wmslayer];
  if (!info || !Array.isArray(info.bbox)) return;
  const view = map.getView();
  const extent = transformExtent(info.bbox, 'EPSG:4326', view.getProjection());
  if (!extent || !extent.every(Number.isFinite)) return;
  view.fit(extent, {
    size: map.getSize(),
    // Leave room for the top toolbar and bottom timeline so the footprint
    // isn't tucked under the chrome.
    padding: [60, 30, 90, 30],
    // Guard against zooming to street level on a tiny footprint; country-
    // and continent-scale boxes land well below this and are unaffected.
    maxZoom: 12,
    duration: 500,
  });
}

// Restore the user's previously selected sublayer for one category (e.g.
// 'radarLayer') after that category's WMS GetCapabilities has populated
// layerInfo. If the stored layer is no longer advertised by the server,
// drop it — the layer stays at its constructor-time default.
function restoreActiveLayer(category, pane = pane0) {
  if (!category) return;
  // While drilled into a single radar site (primary pane only), the radar layer
  // runs a transient `<collection>/DBZH` product that is NOT in ACTIVE_LAYERS.
  // Skip the restore so the periodic (60 s) capabilities refresh doesn't revert
  // it back to the stored composite mid-session.
  if (category === 'radarLayer' && pane === pane0 && radarSite && radarSite.isSingleSiteActive()) return;
  const olLayer = pane.layerss[category];
  if (!olLayer) return;
  const stored = pane.ACTIVE_LAYERS[category];
  if (!stored) return;

  if (!layerInfo[stored] || layerInfo[stored].category !== category) {
    delete pane.ACTIVE_LAYERS[category];
    if (pane === pane0) persistActiveLayers();
    return;
  }

  const currentLayers = olLayer.getSource().getParams().LAYERS;
  if (currentLayers !== stored) {
    updateLayer(olLayer, stored, {
      skipVisibility: true,
      skipTracking: true,
      skipPersist: true,
    });
  }
}

const featureOverlay = new VectorLayer({
  source: new Vector(),
  map,
  style() {
    return style;
  },
});
let highlight;

const displayFeatureInfo = function (pixel) {
  const feature = map.forEachFeatureAtPixel(pixel, (f) => f);

  if (feature !== highlight) {
    if (highlight) {
      featureOverlay.getSource().removeFeature(highlight);
    }
    if (feature && feature.getGeometry().getType() === 'Point') {
      featureOverlay.getSource().addFeature(feature);
    }
    highlight = feature;
  }
};

// Radar coverage overlay (range rings + radial bearings) for the radar shown in
// single-site mode. Owned by radarSite's enter/exit so the rings appear and
// clear together with the single-radar display — not on a bare marker tap.
function drawRadarCoverage(feature) {
  guideLayer.getSource().clear(true);
  if (!feature) return;
  const coords = transform(feature.getGeometry().getCoordinates(), map.getView().getProjection(), 'EPSG:4326');
  [50000, 100000, 150000, 200000, 250000].forEach((range) => rangeRings(guideLayer, coords, range));
  Array.from({ length: 360 / options.radialSpacing }, (_, index) => index * options.radialSpacing)
    .forEach((bearing) => bearingLine(guideLayer, coords, 250, bearing));
}

function clearRadarCoverage() {
  guideLayer.getSource().clear(true);
}

const _playlistSliderHandlers = {};

function layerInfoPlaylist(event) {
  const layer = event.target;
  // The playlist reflects the primary pane only; ignore background panes'
  // property changes entirely (FIRST check — this fires on every source swap
  // during playback, so it must stay cheap for non-pane-0 layers).
  if (layer.get('_paneIndex')) return;
  const name = layer.get('name');
  const info = layer.get('info');
  // Prefer the user-chosen opacity when the interpolator has zeroed
  // the layer's actual opacity for its transparent swap. Falls back
  // to layer.opacity for non-interp layers (lightning, observation,
  // or any layer when interp is off).
  const userOp = layer.get('_userOpacity');
  const effectiveOpacity = userOp !== undefined ? userOp : layer.get('opacity');
  const opacity = effectiveOpacity * 100;

  if (typeof info === 'undefined') return;

  // FramePool.showTime swaps primary.setSource(slot.source) every
  // discrete frame advance during playback. That fires propertychange
  // with key='source'. Without this guard the whole playlist DOM
  // rebuilds 2× per second during playback (visible as a pulsing
  // hover state on style chips), churning CPU for no user-visible
  // reason — source swaps within the pool never change which WMS
  // layer/style/URL the user selected.
  if (event.key === 'source') return;

  // If only opacity changed, update slider value without full DOM rebuild.
  // Skip updates triggered by the interpolator's internal transparent
  // swap (framepool._setPrimaryTransparent), which marks the layer
  // with `_interpHiding` before writing opacity — otherwise the slider
  // would jump to 0 whenever the warp takes over.
  if (event.key === 'opacity') {
    if (layer.get('_interpHiding') !== undefined && layer.get('_interpHiding') !== false) {
      return;
    }
    const existingSlider = document.getElementById(`${name}Slider`);
    if (existingSlider) {
      existingSlider.value = opacity;
      existingSlider.style.background = `linear-gradient(to right, var(--dark-primary-color) ${opacity}%, var(--dark-theme-overlay-06dp) ${opacity}%)`;
      const valEl = document.getElementById(`${name}OpacityValue`);
      if (valEl) valEl.textContent = `${Math.round(opacity)}%`;
    }
    return;
  }

  // Always update text content and visibility state (cheap DOM updates)
  document.getElementById(`${name}Title`).textContent = info.title || '';
  document.getElementById(`${name}Abstract`).textContent = info.abstract || '';
  let attributionText = (info.attribution && info.attribution.Title) || '';
  if (info.license) {
    attributionText += (attributionText ? ` (${info.license})` : info.license);
  }
  document.getElementById(`${name}Attribution`).textContent = attributionText;
  if (layer.getVisible()) {
    document.getElementById(`${name}Info`).classList.remove('playListDisabled');
    const ti = document.querySelector(`#${name}Info .card-visibility-toggle .material-icons`);
    if (ti) ti.textContent = 'visibility';
  } else {
    document.getElementById(`${name}Info`).classList.add('playListDisabled');
    const ti = document.querySelector(`#${name}Info .card-visibility-toggle .material-icons`);
    if (ti) ti.textContent = 'visibility_off';
  }

  // Only do full DOM rebuild (slider, style chips) when playlist is visible
  const playList = document.getElementById('playList');
  if (!playList.classList.contains('open')) {
    return;
  }

  debug(`Updating playlist for ${name}`);

  const activeStyleParam = layer.getSource().getParams().STYLES || '';
  if (typeof info.style !== 'undefined') {
    if (info.style.length > 1) {
      // If no explicit style set, first style is the WMS default
      const activeStyleName = activeStyleParam || (info.style[0] && info.style[0].Name) || '';
      const parent = document.getElementById(`${name}Styles`);
      while (parent.firstChild) parent.removeChild(parent.firstChild);
      info.style.forEach((layerStyle) => {
        const div = document.createElement('div');
        div.textContent = layerStyle.Title;
        div.id = layerStyle.Name;
        if (layerStyle.Name === activeStyleName) {
          div.classList.add('activeStyle');
        }
        div.addEventListener('mouseup', () => {
          layer.setLayerStyle(layerStyle.Name, 'playlist');
          // Update active chip immediately
          parent.querySelectorAll('.activeStyle').forEach((el) => { el.classList.remove('activeStyle'); });
          div.classList.add('activeStyle');
        });
        parent.appendChild(div);
      });
    } else {
      document.getElementById(`${name}Styles`).textContent = '';
    }
  } else {
    document.getElementById(`${name}Styles`).textContent = '';
  }

  // Build opacity control with label row + slider
  const opacityContainer = document.getElementById(`${name}Opacity`);
  opacityContainer.textContent = '';

  const labelRow = document.createElement('div');
  labelRow.className = 'opacity-label-row';

  const label = document.createElement('label');
  label.setAttribute('for', `${name}Slider`);
  label.className = 'opacity-label';
  label.textContent = 'Läpikuultavuus';

  const valueSpan = document.createElement('span');
  valueSpan.className = 'opacity-value';
  valueSpan.id = `${name}OpacityValue`;
  valueSpan.textContent = `${Math.round(opacity)}%`;

  labelRow.appendChild(label);
  labelRow.appendChild(valueSpan);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '1';
  slider.max = '100';
  slider.value = opacity;
  slider.className = 'slider';
  slider.id = `${name}Slider`;
  slider.style.background = `linear-gradient(to right, var(--dark-primary-color) ${opacity}%, var(--dark-theme-overlay-06dp) ${opacity}%)`;

  opacityContainer.appendChild(labelRow);
  opacityContainer.appendChild(slider);

  // Remove previous slider listener to prevent leaks
  const oldSlider = document.getElementById(`${name}Slider`);
  if (oldSlider && _playlistSliderHandlers[name]) {
    oldSlider.removeEventListener('input', _playlistSliderHandlers[name]);
  }
  _playlistSliderHandlers[name] = function (e) {
    const val = e.target.value;
    layer.setOpacity(val / 100);
    const valEl = document.getElementById(`${name}OpacityValue`);
    if (valEl) valEl.textContent = `${Math.round(val)}%`;
    e.target.style.background = `linear-gradient(to right, var(--dark-primary-color) ${val}%, var(--dark-theme-overlay-06dp) ${val}%)`;
    e.stopPropagation();
  };
  slider.addEventListener('input', _playlistSliderHandlers[name]);
}

function onChangeVisible(event) {
  const layer = event.target;
  const wmslayer = layer.getSource().getParams().LAYERS;
  const name = layer.get('name');
  const isVisible = layer.getVisible();
  const pane = paneOf(layer);
  const isPane0 = pane === pane0;

  if (isVisible) pane.VISIBLE.add(name); else pane.VISIBLE.delete(name);
  debug(`${isVisible ? 'Activated' : 'Deactivated'} ${name} (pane ${pane.index})`);

  // The global toolbar and the playlist card reflect the primary pane
  // (pane 0). Per-pane state lives on the pill.
  if (isPane0) {
    localStorage.setItem('VISIBLE', JSON.stringify([...pane.VISIBLE]));
    setButtonState(`${name}Button`, isVisible);
    const info = document.getElementById(`${name}Info`);
    if (info) info.classList.toggle('playListDisabled', !isVisible);
    const toggleIcon = document.querySelector(`#${name}Info .card-visibility-toggle .material-icons`);
    if (toggleIcon) toggleIcon.textContent = isVisible ? 'visibility' : 'visibility_off';
    updateCanonicalPage();
  }

  refreshPanePillButton(pane, name);
  recomputeAllTimelineCells();

  if (isPane0 && probe && layer === radarLayer) {
    probe.setActiveLayer(isVisible ? wmslayer : null, {
      z: layer.getSource().getParams().ELEVATION,
    });
    if (crosshair) {
      crosshair.setActiveLayer(isVisible ? wmslayer : null, {
        z: layer.getSource().getParams().ELEVATION,
      });
    }
  }
  // Visibility change may invalidate the current timeline window
  // (e.g. activating a stale satellite caps `end` to its old time.end,
  // or hiding it releases the cap). Recompute window + per-layer
  // in-range state immediately so the map time, stale colour and
  // layer opacity update without waiting for a tick or manual step.
  setTime('keep');
  // Turning the primary pane's radar off exits single-site mode, restoring the
  // composite (while hidden) so re-enabling shows the composite again.
  if (isPane0 && layer === radarLayer && !isVisible && radarSite) {
    radarSite.exitSingleSite({ restore: true });
  }
}

/**
 * Toggles the visibility of a given layer.
 * If the layer is currently visible, it will be set to invisible, and vice versa.
 *
 * @param {ol.layer} layer - The layer whose visibility will be toggled.
 */
function toggleLayerVisibility(layer, source) {
  layer.setVisible(!layer.getVisible());
  if (source) {
    trackCategory(layer, { action: 'toggle', visible: layer.getVisible(), source });
  }
}

// Whether the user has already opened a long-press menu (persisted), so the
// discovery hint in the coachmark stops appearing once the gesture is learned.
let longPressDiscovered = safeParseJSON('LP_HINT_SEEN', false);

// Toggle wrapper for segment-originated actions (button taps + keyboard
// shortcuts). Announces the Finnish layer name via coachmark only when the
// toggle turned the layer on. Deliberately not used by the playlist eye icon
// or long-press variant selection so those paths stay quiet.
function toggleAndAnnounce(layer, segId, source) {
  toggleLayerVisibility(layer, source);
  if (layer.getVisible()) {
    const seg = document.getElementById(segId);
    if (seg && typeof showCoachmark === 'function') {
      // Teach the long-press menu on real button taps, until the user discovers
      // it. Keyboard shortcuts (source: 'key') skip the "hold the button" hint.
      showCoachmark(seg.getAttribute('data-name'), {
        longPressHint: source === 'button' && !longPressDiscovered,
      });
    }
  }
}

//
// PER-PANE MINI CONTROLS (split mode)
//
// In split layouts each pane carries its own compact category pill so the user
// edits that pane's content directly; the global top toolbar is hidden. The
// pill reuses the shared sublayer long-press menus, targeted at the pane.
// (CATEGORY_UI / PILL_CATEGORIES are declared near the top of the module so the
// layout helpers above can reference them.)

// Resolve which pane owns an OL content layer (back-ref set in createPane).
function paneOf(layer) {
  const idx = layer.get('_paneIndex') || 0;
  return panes[idx] || pane0;
}

// Apply a sublayer pick (from a long-press menu) to one pane's category.
function applySublayerToPane(pane, category, id) {
  if (category === 'radarLayer') {
    // Single-site drill-in lives only on the primary pane (radarSite is bound
    // to pane 0); exit it before swapping the composite there.
    if (pane === pane0 && radarSite) radarSite.exitSingleSite({ restore: false });
    updateLayer(pane.layerss.radarLayer, id, { source: 'longpress' });
    // Recentre the shared view to the picked radar's footprint only for the
    // primary pane — a background pane's pick shouldn't yank every pane around.
    if (pane === pane0) fitToLayerExtent(id);
  } else {
    updateLayer(pane.layerss[category], id, { source: 'longpress' });
  }
  const menu = document.getElementById(CATEGORY_UI[category].menu);
  if (menu) menu.style.display = 'none';
}

function refreshPanePillButton(pane, category) {
  const btn = pane.pillButtons && pane.pillButtons[category];
  if (!btn) return;
  const on = pane.VISIBLE.has(category);
  btn.classList.toggle('selectedButton', on);
  btn.setAttribute('aria-pressed', String(on));
}

function refreshPanePill(pane) {
  PILL_CATEGORIES.forEach((c) => refreshPanePillButton(pane, c));
}

// Build a pane's pill (once) and wire each button: tap toggles that pane's
// category, long-press opens the shared sublayer menu targeted at the pane.
function buildPanePill(pane) {
  if (pane.pill) return;
  const pill = document.createElement('div');
  pill.className = 'pane-pill noselect';
  pane.pillButtons = {};
  PILL_CATEGORIES.forEach((category) => {
    const cfg = CATEGORY_UI[category];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pane-seg';
    btn.setAttribute('aria-label', cfg.aria);
    const icon = document.createElement('i');
    icon.className = 'material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = cfg.icon;
    btn.appendChild(icon);
    pill.appendChild(btn);
    pane.pillButtons[category] = btn;
    createLongPressHandler(
      btn,
      cfg.menu,
      () => toggleLayerVisibility(pane.layerss[category], 'pane-pill'),
      (id) => applySublayerToPane(pane, category, id),
      () => pane.layerss[category].getSource().getParams().LAYERS,
      () => pane.layerss[category].getVisible(),
      () => { hideCoachmarkNow(); markLongPressDiscovered(); },
    );
  });
  pane.el.appendChild(pill);
  pane.pill = pill;
  refreshPanePill(pane);
}

//
// EVENTS
//

document.getElementById('speedButton').addEventListener('mouseup', () => {
  switch (options.frameRate) {
    case options.defaultFrameRate:
      options.frameRate = options.defaultFrameRate * 2;
      break;
    case options.defaultFrameRate * 2:
      options.frameRate = options.defaultFrameRate * 0.5;
      break;
    default:
      options.frameRate = options.defaultFrameRate;
  }
  document.getElementById('speedButton').innerHTML = `${options.frameRate / options.defaultFrameRate}×`;
  stop();
  play();
  debug(`SPEED: ${options.frameRate}`);
});

document.getElementById('playButton').addEventListener('mouseup', () => {
  playstop();
});

document.getElementById('skipNextButton').addEventListener('mouseup', () => {
  skipNext();
});

document.getElementById('skipPreviousButton').addEventListener('mouseup', () => {
  skipPrevious();
});

function openPlaylist() {
  document.getElementById('playList').classList.add('open');
  document.getElementById('playListBackdrop').classList.add('open');
  // Force full rebuild of all layer cards (slider, style chips)
  [satelliteLayer, radarLayer, lightningLayer, observationLayer].forEach((layer) => {
    layerInfoPlaylist({ target: layer, key: 'info' });
  });
}

function closePlaylist() {
  document.getElementById('playList').classList.remove('open');
  document.getElementById('playListBackdrop').classList.remove('open');
}

function togglePlaylist() {
  debug('playlist');
  if (document.getElementById('playList').classList.contains('open')) {
    closePlaylist();
  } else {
    openPlaylist();
  }
}

document.getElementById('playlistButton').addEventListener('mouseup', togglePlaylist);

document.getElementById('playlistCloseButton').addEventListener('mouseup', closePlaylist);

document.getElementById('playListBackdrop').addEventListener('mouseup', closePlaylist);

// Visibility toggle buttons inside layer cards
document.querySelectorAll('.card-visibility-toggle').forEach((toggle) => {
  toggle.addEventListener('mouseup', (e) => {
    const layerName = toggle.getAttribute('data-layer');
    const layerObj = layerss[layerName];
    if (layerObj) toggleLayerVisibility(layerObj, 'playlist');
    e.stopPropagation();
  });
});

// The four shared sublayer menus, opened from the global toolbar (1-up) OR any
// pane's mini pill (split). longPressMenuOpener() reports which button owns each
// open menu, so the outside-click closer below doesn't dismiss it when that very
// button is released after a long press.
const LP_MENU_IDS = [
  'observationLongPressMenu',
  'satelliteLongPressMenu',
  'radarLongPressMenu',
  'lightningLongPressMenu',
];

function closeLongPressMenusOutside(e) {
  LP_MENU_IDS.forEach((menuId) => {
    const menu = document.getElementById(menuId);
    if (!menu || menu.style.display === 'none') return;
    if (menu.contains(e.target)) return;
    const opener = longPressMenuOpener(menu);
    if (opener && opener.contains(e.target)) return;
    menu.style.display = 'none';
  });
}

// Close playlist if clicked outside of playlist
window.addEventListener('mouseup', (e) => {
  // playlist
  if (!document.getElementById('playList').contains(e.target)) {
    if (document.getElementById('playlistButton').contains(e.target)) return;
    closePlaylist();
  }
  closeLongPressMenusOutside(e);
});

window.addEventListener('touchend', closeLongPressMenusOutside);

function setButtonState(id, active) {
  const el = document.getElementById(id);
  el.classList.toggle('selectedButton', active);
  el.setAttribute('aria-pressed', String(active));
}

function setButtonStates() {
  setButtonState('locationLayerButton', IS_TRACKING);
  setButtonState('satelliteLayerButton', VISIBLE.has('satelliteLayer'));
  setButtonState('radarLayerButton', VISIBLE.has('radarLayer'));
  setButtonState('lightningLayerButton', VISIBLE.has('lightningLayer'));
  setButtonState('observationLayerButton', VISIBLE.has('observationLayer'));
  updateThemeChipsState();
}

// Press feedback for all floating controls
document.querySelectorAll('.pill .seg, #menuButton, .location-fab').forEach((btn) => {
  function addPress() { btn.classList.add('pressing'); }
  function removePress() { btn.classList.remove('pressing'); }
  btn.addEventListener('mousedown', addPress);
  btn.addEventListener('mouseup', removePress);
  btn.addEventListener('mouseleave', removePress);
  btn.addEventListener('touchstart', addPress);
  btn.addEventListener('touchend', removePress);
  btn.addEventListener('touchcancel', removePress);
});

document.getElementById('locationLayerButton').addEventListener('mouseup', () => {
  if (IS_TRACKING) {
    IS_TRACKING = false;
    localStorage.setItem('IS_TRACKING', JSON.stringify(false));
    geolocation.setTracking(false);
    setOwnPositionVisible(false);
    track('tracking-off');
  } else {
    IS_TRACKING = true;
    localStorage.setItem('IS_TRACKING', JSON.stringify(true));
    geolocation.setTracking(true);
    setOwnPositionVisible(true);
    if (ownPosition.length > 1) {
      map.getView().setCenter(ownPosition);
    }
    track('tracking-on');
  }
  setButtonStates();
});

document.getElementById('radarLayerTitle').addEventListener('mouseup', () => {
  toggleLayerVisibility(radarLayer, 'playlist');
});

document.getElementById('lightningLayerTitle').addEventListener('mouseup', () => {
  toggleLayerVisibility(lightningLayer, 'playlist');
});

// Long press menus for layer buttons. Opening any menu dismisses a lingering
// discovery hint and records that the gesture has been learned.
const onLongPressDiscovered = () => { hideCoachmarkNow(); markLongPressDiscovered(); };

const observationMenu = createLongPressHandler(
  'observationLayerButton',
  'observationLongPressMenu',
  () => { toggleAndAnnounce(observationLayer, 'observationLayerButton', 'button'); },
  (id) => { updateLayer(observationLayer, id, { source: 'longpress' }); observationMenu.hide(); },
  () => observationLayer.getSource().getParams().LAYERS,
  () => observationLayer.getVisible(),
  onLongPressDiscovered,
);

const satelliteMenu = createLongPressHandler(
  'satelliteLayerButton',
  'satelliteLongPressMenu',
  () => { toggleAndAnnounce(satelliteLayer, 'satelliteLayerButton', 'button'); },
  (id) => { updateLayer(satelliteLayer, id, { source: 'longpress' }); satelliteMenu.hide(); },
  () => satelliteLayer.getSource().getParams().LAYERS,
  () => satelliteLayer.getVisible(),
  onLongPressDiscovered,
);

const radarMenu = createLongPressHandler(
  'radarLayerButton',
  'radarLongPressMenu',
  () => { toggleAndAnnounce(radarLayer, 'radarLayerButton', 'button'); },
  (id) => {
    // Picking a composite from the menu exits single-site mode first (clears
    // the ELEVATION param + card toggle) without restoring, since the line
    // below sets the new composite itself.
    if (radarSite) radarSite.exitSingleSite({ restore: false });
    updateLayer(radarLayer, id, { source: 'longpress' });
    fitToLayerExtent(id);
    radarMenu.hide();
  },
  () => radarLayer.getSource().getParams().LAYERS,
  () => radarLayer.getVisible(),
  onLongPressDiscovered,
);

const lightningMenu = createLongPressHandler(
  'lightningLayerButton',
  'lightningLongPressMenu',
  () => { toggleAndAnnounce(lightningLayer, 'lightningLayerButton', 'button'); },
  (id) => { updateLayer(lightningLayer, id, { source: 'longpress' }); lightningMenu.hide(); },
  () => lightningLayer.getSource().getParams().LAYERS,
  () => lightningLayer.getVisible(),
  onLongPressDiscovered,
);

// Overflow menu (three-dots) — open/close + theme chip wiring
const overflowMenuEl = document.getElementById('overflowMenu');
const overflowBackdropEl = document.getElementById('overflowMenuBackdrop');
const menuButtonEl = document.getElementById('menuButton');

function openOverflowMenu() {
  overflowMenuEl.hidden = false;
  // force reflow so the CSS transition runs from the initial state
  overflowMenuEl.getBoundingClientRect();
  overflowMenuEl.classList.add('open');
  overflowBackdropEl.classList.add('open');
  menuButtonEl.setAttribute('aria-expanded', 'true');
  updateThemeChipsState();
  updateLayoutChipsState();
  updatePoiMenuState();
}

function closeOverflowMenu() {
  overflowMenuEl.classList.remove('open');
  overflowBackdropEl.classList.remove('open');
  menuButtonEl.setAttribute('aria-expanded', 'false');
  setTimeout(() => {
    if (!overflowMenuEl.classList.contains('open')) overflowMenuEl.hidden = true;
  }, 200);
}

menuButtonEl.addEventListener('mouseup', () => {
  if (overflowMenuEl.classList.contains('open')) closeOverflowMenu();
  else openOverflowMenu();
});

overflowBackdropEl.addEventListener('mouseup', closeOverflowMenu);

function closeOverflowIfOutside(e) {
  if (!overflowMenuEl.classList.contains('open')) return;
  if (overflowMenuEl.contains(e.target)) return;
  if (menuButtonEl.contains(e.target)) return;
  closeOverflowMenu();
}
window.addEventListener('mouseup', closeOverflowIfOutside);
// Mirror on touchend for touch-only devices where upstream preventDefault
// can swallow the synthesized mouseup (same pattern the long-press menus use).
window.addEventListener('touchend', closeOverflowIfOutside);

// Tool group (Mittaa + Pistemittaus) — the FAB doubles as a Photoshop-style
// tool group. Tapping it opens a sideways flyout AND re-arms the last-used
// tool; picking a tool in the flyout arms it (auto-disarming the other), and
// picking the active tool disarms it. Mirrors the overflow menu's
// open/close + outside-click pattern.
const toolGroupEl = document.getElementById('toolGroup');
const toolFabBtn = document.getElementById('measureFab');
const toolFlyoutEl = document.getElementById('toolFlyout');
const toolFlyoutBackdropEl = document.getElementById('toolFlyoutBackdrop');
const toolGroupIconEl = toolFabBtn ? toolFabBtn.querySelector('.tool-group-icon') : null;
const TOOL_ICONS = { measure: 'straighten', pistemittaus: 'colorize', crosshair: 'center_focus_weak' };
// Default tool the FAB arms on a plain tap (and shows in its icon) until the
// user picks another from the flyout — the centre-crosshair reticle.
let lastTool = 'crosshair';

function openToolFlyout() {
  toolFlyoutEl.hidden = false;
  toolFlyoutEl.getBoundingClientRect(); // force reflow so the transition runs
  toolFlyoutEl.classList.add('open');
  toolFlyoutBackdropEl.classList.add('open');
  toolFabBtn.setAttribute('aria-expanded', 'true');
}

function closeToolFlyout() {
  toolFlyoutEl.classList.remove('open');
  toolFlyoutBackdropEl.classList.remove('open');
  toolFabBtn.setAttribute('aria-expanded', 'false');
  setTimeout(() => {
    if (!toolFlyoutEl.classList.contains('open')) toolFlyoutEl.hidden = true;
  }, 200);
}

// Reflect the active tool (or the last-used tool when nothing is armed) in the
// FAB icon and the flyout items' pressed state. Passed to initTools as
// onToolChange so Esc / chip-× / mutual exclusion all keep the FAB in sync.
// (tools.js owns the FAB's tool-armed ring + aria-pressed.)
function syncToolGroup() {
  const active = tools ? tools.getActiveTool() : null;
  if (toolGroupIconEl) toolGroupIconEl.textContent = TOOL_ICONS[active || lastTool];
  if (toolFlyoutEl) {
    toolFlyoutEl.querySelectorAll('.tool-flyout-item').forEach((item) => {
      item.setAttribute('aria-pressed', item.dataset.tool === active ? 'true' : 'false');
    });
  }
  // The crosshair is a passive screen-centre overlay rather than a map-tap
  // tool, so its visibility is driven here from the single-select tool state.
  if (crosshair) {
    if (active === 'crosshair') crosshair.show();
    else crosshair.hide();
  }
}

if (toolFabBtn && toolFlyoutEl) {
  // Tap toggles the active/last tool so it's usable immediately (no flyout to
  // dismiss first). Press-and-hold opens the flyout to switch tools — same
  // gesture as the app's long-press layer menus. Pointer events unify
  // mouse/touch and avoid the touch "ghost click" double-firing.
  const toggleActiveTool = () => {
    if (!tools) return;
    if (tools.getActiveTool()) tools.setActiveTool(null);
    else tools.setActiveTool(lastTool);
  };
  let pressTimer = null;
  const cancelPress = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  };
  toolFabBtn.addEventListener('pointerdown', () => {
    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = null; // mark the long-press as consumed
      openToolFlyout();
    }, 500);
  });
  toolFabBtn.addEventListener('pointerup', () => {
    // A pending timer means this was a short press (tap) → toggle. A null
    // timer means the long-press already fired and opened the flyout.
    if (!pressTimer) return;
    cancelPress();
    toggleActiveTool();
  });
  toolFabBtn.addEventListener('pointerleave', cancelPress);
  toolFabBtn.addEventListener('pointercancel', cancelPress);
  // Keyboard activation (Enter/Space) fires a click with detail 0 and no
  // pointer sequence; pointer-driven clicks (detail >= 1) are already handled.
  toolFabBtn.addEventListener('click', (e) => {
    if (e.detail === 0) toggleActiveTool();
  });

  toolFlyoutEl.querySelectorAll('.tool-flyout-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!tools) return;
      const { tool } = item.dataset;
      if (tools.getActiveTool() === tool) {
        tools.setActiveTool(null);
      } else {
        tools.setActiveTool(tool);
        lastTool = tool;
      }
      closeToolFlyout();
    });
  });

  if (toolFlyoutBackdropEl) toolFlyoutBackdropEl.addEventListener('click', closeToolFlyout);

  const closeToolFlyoutIfOutside = (e) => {
    if (!toolFlyoutEl.classList.contains('open')) return;
    if (toolGroupEl.contains(e.target)) return;
    closeToolFlyout();
  };
  window.addEventListener('mouseup', closeToolFlyoutIfOutside);
  window.addEventListener('touchend', closeToolFlyoutIfOutside);
}

document.querySelectorAll('#overflowMenu .chip[data-theme]').forEach((chip) => {
  chip.addEventListener('mouseup', () => {
    setUserTheme(chip.getAttribute('data-theme'));
  });
});

document.querySelectorAll('#overflowMenu .chip[data-interp]').forEach((chip) => {
  chip.addEventListener('mouseup', () => {
    if (chip.getAttribute('aria-disabled') === 'true') return;
    setInterpMode(chip.getAttribute('data-interp'));
  });
});
// Initialise chip disabled/selected state up front — before the
// capability probe resolves, interpCapable is false so only 'off'
// is tappable. Otherwise taps arrive at setInterpMode which
// silently rejects non-'off' modes, and the user sees no feedback.
updateInterpChipsState();

// Layout chips (Näkymä): 1-up / 2-up / 4-up.
document.querySelectorAll('#overflowMenu .chip[data-layout]').forEach((chip) => {
  chip.addEventListener('mouseup', () => {
    setLayout(chip.getAttribute('data-layout'));
  });
});

// POI layers — map features that users can toggle independently of data layers.
// Adding a future POI = one entry in this registry; the overflow menu row and
// localStorage persistence fall out automatically.
// `layerKeys` are pane property names — a POI toggle fans its visibility out to
// the matching layer in EVERY pane so context overlays stay consistent across
// the split.
const poiRegistry = [
  {
    id: 'radars',
    label: 'Tutka-asemat',
    icon: 'cell_tower',
    defaultOn: true,
    layerKeys: ['radarSiteLayer'],
  },
  {
    id: 'airfields',
    label: 'Lentokentät',
    icon: 'flight',
    defaultOn: false,
    layerKeys: ['icaoLayer'],
  },
  {
    id: 'municipalities',
    label: 'Kunnat',
    icon: 'location_city',
    defaultOn: false,
    layerKeys: ['municipalityLayer'],
  },
  {
    id: 'vesivaylat',
    label: 'Vesiväylät',
    icon: 'directions_boat',
    defaultOn: false,
    // Area fill renders behind the line geometry — both flip together
    // off the same toggle. Order here doesn't drive z-order; the layers
    // array does (vesivaylaAreaLayer sits before vesivaylatLayer there).
    layerKeys: ['vesivaylaAreaLayer', 'vesivaylatLayer'],
  },
];

// POI_STATE is reconciled against the current registry on every load: unknown
// persisted keys are dropped, and new registry entries fall back to defaultOn.
const POI_STATE = (() => {
  const persisted = safeParseJSON('POI_STATE', null) || {};
  const state = {};
  poiRegistry.forEach((entry) => {
    state[entry.id] = Object.prototype.hasOwnProperty.call(persisted, entry.id)
      ? !!persisted[entry.id]
      : entry.defaultOn;
  });
  return state;
})();

function persistPoiState() {
  localStorage.setItem('POI_STATE', JSON.stringify(POI_STATE));
}

function applyPoiVisibility() {
  poiRegistry.forEach((entry) => {
    const visible = !!POI_STATE[entry.id];
    for (const pane of panes) {
      entry.layerKeys.forEach((key) => {
        if (pane[key]) pane[key].setVisible(visible);
      });
    }
  });
}

function updatePoiMenuState() {
  document.querySelectorAll('#poiList .menu-row[data-poi]').forEach((row) => {
    const id = row.getAttribute('data-poi');
    row.setAttribute('aria-checked', String(!!POI_STATE[id]));
  });
}

function togglePoi(id) {
  POI_STATE[id] = !POI_STATE[id];
  applyPoiVisibility();
  persistPoiState();
  updatePoiMenuState();
  track('poi-toggle', { id, visible: POI_STATE[id] });
}

function buildPoiMenuRows() {
  const container = document.getElementById('poiList');
  if (!container) return;
  container.textContent = '';
  poiRegistry.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'menu-row';
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', String(!!POI_STATE[entry.id]));
    row.setAttribute('data-poi', entry.id);
    row.setAttribute('tabindex', '0');

    const iconEl = document.createElement('i');
    iconEl.className = 'material-icons';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = entry.icon;

    const labelEl = document.createElement('span');
    labelEl.className = 'menu-label';
    labelEl.textContent = entry.label;

    const switchEl = document.createElement('span');
    switchEl.className = 'switch';
    switchEl.setAttribute('aria-hidden', 'true');

    row.appendChild(iconEl);
    row.appendChild(labelEl);
    row.appendChild(switchEl);

    row.addEventListener('mouseup', () => togglePoi(entry.id));
    row.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        togglePoi(entry.id);
      }
    });

    container.appendChild(row);
  });
}

// Reconcile persisted state against layer visibility (handles the case where
// persisted state diverges from the layer's declared default), then render the
// menu rows once. Also re-persists cleaned state so stale keys drop from
// localStorage the first time a user opens the page after a registry change.
applyPoiVisibility();
persistPoiState();
buildPoiMenuRows();

// Coachmark: briefly surfaces the Finnish layer name after it becomes visible,
// so icon-only segments stay learnable. When the long-press menu hasn't been
// discovered yet, the toast also teaches the hold gesture for ~3 s; the hint
// stops appearing once any long-press menu has been opened (see LP_HINT_SEEN).
const coachmarkEl = document.getElementById('coachmark');
const coachmarkTitleEl = coachmarkEl.querySelector('.coach-title');
const coachmarkHintEl = coachmarkEl.querySelector('.coach-hint');
const LONG_PRESS_HINT_TEXT = 'Pidä pohjassa → lisää vaihtoehtoja';
let coachmarkTimer = null;

function markLongPressDiscovered() {
  if (longPressDiscovered) return;
  longPressDiscovered = true;
  localStorage.setItem('LP_HINT_SEEN', JSON.stringify(true));
}

function showCoachmark(text, { longPressHint = false } = {}) {
  if (!text) return;
  coachmarkTitleEl.textContent = text;
  coachmarkHintEl.textContent = longPressHint ? LONG_PRESS_HINT_TEXT : '';
  coachmarkHintEl.hidden = !longPressHint;
  coachmarkEl.hidden = false;
  coachmarkEl.getBoundingClientRect();
  coachmarkEl.classList.add('show');
  if (coachmarkTimer) clearTimeout(coachmarkTimer);
  coachmarkTimer = setTimeout(() => {
    coachmarkEl.classList.remove('show');
    setTimeout(() => {
      if (!coachmarkEl.classList.contains('show')) coachmarkEl.hidden = true;
    }, 220);
  }, longPressHint ? 3000 : 1400);
}

// Immediately tear down the coachmark — used when a long-press succeeds so the
// "hold the button" hint doesn't linger after the gesture has been performed.
function hideCoachmarkNow() {
  if (coachmarkTimer) clearTimeout(coachmarkTimer);
  coachmarkEl.classList.remove('show');
  coachmarkEl.hidden = true;
}

document.addEventListener('keyup', (event) => {
  if (event.defaultPrevented) {
    return;
  }

  const key = event.key || event.keyCode;
  let handled = true;
  if (key === ' ' || key === 'Space' || key === 32) {
    skipNext();
  } else if (key === ',' || key === 'Comma') {
    skipPrevious();
  } else if (key === '.' || key === 'Period') {
    skipNext();
  } else if (key === 'j' || key === 'KeyJ') {
    skipPrevious();
  } else if (key === 'k' || key === 'KeyK') {
    playstop();
  } else if (key === 'l' || key === 'KeyL') {
    skipNext();
  } else if (key === '1' || key === 'Digit1') {
    toggleAndAnnounce(satelliteLayer, 'satelliteLayerButton', 'key');
  } else if (key === '2' || key === 'Digit2') {
    toggleAndAnnounce(radarLayer, 'radarLayerButton', 'key');
  } else if (key === '3' || key === 'Digit3') {
    toggleAndAnnounce(lightningLayer, 'lightningLayerButton', 'key');
  } else if (key === '4' || key === 'Digit4') {
    toggleAndAnnounce(observationLayer, 'observationLayerButton', 'key');
  } else if ((key === 'f' || key === 'KeyF')
    && !event.ctrlKey && !event.metaKey && !event.altKey) {
    // Bare `f` only — don't hijack Cmd/Ctrl+F (find-in-page) etc.
    setAppFullscreen(!appFullscreen);
  } else if (event.key === 'Escape') {
    if (overflowMenuEl.classList.contains('open')) closeOverflowMenu();
    else if (appFullscreen) setAppFullscreen(false);
    else handled = false;
  } else if (event.key === 'Control') {
    document.getElementById('help').style.display = 'none';
  } else if (event.key === 'Home') {
    stop();
    setTime('last');
  } else {
    handled = false;
    debug(event);
  }

  if (handled) {
    event.preventDefault();
  }
});

function getWMSCapabilities(wms, failCountArg = 0) {
  let failCount = failCountArg;
  const parser = new WMSCapabilities();
  const namespace = wms.namespace ? `&namespace=${wms.namespace}` : '';
  // `&layer=` is a non-standard GeoServer/MapServer extension. Only servers
  // that explicitly need it set `narrowByLayer: true` in their config —
  // e.g. GeoMet (Canada), which advertises thousands of layers and would
  // otherwise return a huge document. Everywhere else we drop the param
  // and let the (url, namespace) dedup at the caller collapse identical
  // requests (see `main`).
  const layerParam = (wms.narrowByLayer && wms.layer) ? `&layer=${wms.layer}` : '';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => { controller.abort(); }, 30000);
  debug(`Request WMS Capabilities ${wms.url}`);

  fetch(`${wms.url}?SERVICE=WMS&version=1.3.0&request=GetCapabilities${namespace}${layerParam}`, {
    signal: controller.signal,
  }).then((response) => {
    // An HTTP error (typically 5xx from an overloaded WMS server)
    // still resolves the fetch — without this check the error body
    // flows on to .text()/parser.read, fails the structure check
    // silently, and .finally reschedules at the flat full rate. The
    // exponential backoff below only ever engages via .catch, so
    // throwing here is what routes 4xx/5xx into the backoff.
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  }).then((text) => {
    clearTimeout(timeoutId);
    debug(`Received WMS Capabilities ${wms.url}`);
    failCount = 0;
    const result = parser.read(text);
    if (result && result.Capability && result.Capability.Layer && result.Capability.Layer.Layer) {
      // A server "supports webp" when its GetCapabilities advertises
      // image/webp as a GetMap output format (e.g. meteocore). Prefer it
      // there to shrink GetMap payloads — and let servers that don't
      // advertise it (the GeoServer endpoints) keep png/jpeg.
      const getMap = result.Capability.Request && result.Capability.Request.GetMap;
      const supportsWebp = !!(getMap && Array.isArray(getMap.Format)
        && getMap.Format.includes('image/webp'));
      getLayers(result.Capability.Layer.Layer, wms, supportsWebp);
      debug(layerInfo);
      // Set each visible category's `info` and adopt webp (where advertised)
      // for every active pane's layers, including the boot defaults.
      for (const pane of activePanes()) {
        for (const name of ['satelliteLayer', 'radarLayer', 'lightningLayer', 'observationLayer']) {
          const olLayer = pane.layerss[name];
          olLayer.set('info', layerInfo[olLayer.getSource().getParams().LAYERS]);
          applyWireFormat(olLayer);
        }
      }
      for (const pane of activePanes()) restoreActiveLayer(wms.category, pane);
      if (IS_FOLLOWING) {
        setTime('last');
      }
    } else {
      debug(`Invalid WMS Capabilities response structure for ${wms.url}`);
      debug(result);
    }
  }).catch((error) => {
    clearTimeout(timeoutId);
    failCount++;
    debug(`Error fetching WMS Capabilities from ${wms.url}: ${error.message} (fail #${failCount})`);
  })
    .finally(() => {
    // Exponential backoff on failure: refresh, 2x, 4x, max 5 min
      const delay = failCount > 0
        ? Math.min(wms.refresh * 2 ** failCount, 300000)
        : wms.refresh;
      setTimeout(() => { getWMSCapabilities(wms, failCount); }, delay);
    });
}

// Per-layer override map: any wms entry that declares a specific `layer`
// (e.g. de/fi/eu/no/se/dk on the meteocore endpoint) provides the
// attribution/license/title fallback for THAT layer specifically. Lets a
// single GetCapabilities fetch serve a multi-source group correctly.
const wmsByLayerName = (() => {
  const byLayer = {};
  Object.values(wmsServerConfiguration).forEach((value) => {
    if (value.disabled || !value.layer) return;
    byLayer[value.layer] = value;
  });
  return byLayer;
})();

function getLayers(parentlayer, wms, supportsWebp = false) {
  const products = {};
  parentlayer.forEach((layer) => {
    if (Array.isArray(layer.Layer)) {
      getLayers(layer.Layer, wms, supportsWebp);
    } else {
      let name = layer.Name;
      // FMI GeoServer returns unprefixed names; meteo.fi returns prefixed.
      // Add namespace prefix only when it's not already present.
      if (wms.namespace && name.indexOf(`${wms.namespace}:`) !== 0) {
        name = `${wms.namespace}:${name}`;
      }
      const candidate = wmsByLayerName[name] || wmsByLayerName[layer.Name];
      const sameEndpoint = candidate
        && candidate.url === wms.url
        && (candidate.namespace || '') === (wms.namespace || '');
      const ownerWms = sameEndpoint ? candidate : wms;
      layerInfo[name] = getLayerInfo(layer, ownerWms, supportsWebp);
      layerInfo[name].layer = name;
    }
  });
  return products;
}

function getLayerInfo(layer, wms, supportsWebp = false) {
  const product = {
    category: wms.category,
    url: wms.url,
    layer: layer.Name,
    // Whether the serving WMS advertised image/webp in its
    // GetCapabilities — resolveFormat prefers it over the default.
    webp: supportsWebp,
  };

  if (typeof layer.CRS !== 'undefined') {
    [product.crs] = layer.CRS;
  } else {
    product.crs = 'EPSG:4326';
  }

  // Geographic coverage advertised in GetCapabilities, as
  // [minLon, minLat, maxLon, maxLat] in EPSG:4326. Used to pan/zoom the
  // map to a radar source's footprint when it's picked from the radar
  // long-press menu (see fitToLayerExtent).
  if (Array.isArray(layer.EX_GeographicBoundingBox)) {
    product.bbox = layer.EX_GeographicBoundingBox;
  }

  if (typeof wms.title !== 'undefined') {
    product.title = wms.title;
  } else {
    product.title = layer.Title;
  }

  if (typeof wms.abstract !== 'undefined') {
    product.abstract = wms.abstract;
  } else {
    product.abstract = layer.Abstract;
  }

  if (typeof layer.Attribution !== 'undefined') {
    product.attribution = layer.Attribution;
  } else if (typeof wms.attribution !== 'undefined') {
    product.attribution = { Title: wms.attribution };
  }

  if (typeof wms.license !== 'undefined') {
    product.license = wms.license;
  }

  // Per-layer wire-format overrides — used by sparse overlay products
  // (e.g. MSG RDT) that need PNG + transparency on a category whose
  // default is opaque JPEG.
  if (typeof wms.format !== 'undefined') {
    product.format = wms.format;
  }
  if (typeof wms.transparent !== 'undefined') {
    product.transparent = wms.transparent;
  }

  if (typeof layer.Dimension !== 'undefined') {
    product.time = getTimeDimension(layer.Dimension);
  }

  if (typeof layer.Style !== 'undefined') {
    product.style = layer.Style;
  }
  return product;
}

function getTimeDimension(dimensions) {
  // var time = {}
  let beginTime;
  let endTime;
  let resolutionTime;
  let prevtime;
  let defaultTime;

  dimensions.forEach((dimension) => {
    if (dimension.name === 'time') {
      defaultTime = dimension.default ? dayjs(dimension.default).valueOf() : NaN;
      dimension.values.split(',').forEach((times) => {
        const time = times.split('/');
        // Time dimension is list of times separated by comma
        if (time.length === 1) {
          // var timeValue = dayjs(time[0]).valueOf()
          const timeValue = dayjs(new Date(time[0])).valueOf();
          // begin time is the smallest of listed times
          beginTime = beginTime || timeValue;
          beginTime = Math.min(beginTime, timeValue);
          // end time is the bigest of listed times
          endTime = endTime || timeValue;
          endTime = Math.max(endTime, timeValue);
          // resolution is the difference of the last two times listed
          resolutionTime = prevtime ? (timeValue - prevtime) : 3600000;
          prevtime = timeValue;
        } else if (time.length === 3) {
          // Time dimension is starttime/endtime/period
          beginTime = dayjs(time[0]).valueOf();
          endTime = dayjs(time[1]).valueOf();
          resolutionTime = dayjs.duration(time[2]).asMilliseconds();
        }
      }); // forEach
    } // if
  }); // forEach
  const currentTime = new Date().getTime();
  const type = endTime > currentTime ? 'for' : 'obs';
  // console.log("start: " + beginTime + " end: " + endTime + " resolution: " + resolutionTime + " type: " + type + " default: " + defaultTime)
  return {
    start: beginTime, end: endTime, resolution: resolutionTime, type, default: defaultTime,
  };
}

// Build the four FramePools (one per content layer) for a pane and wire each
// pool's load/flow callbacks into the shared timeline aggregation. For pane 0
// `pane.framePools` is the module-global `framePools`, so this is identical to
// the old inline construction on the single-map path.
function buildPanePools(pane) {
  const pairs = [
    ['satelliteLayer', pane.layerss.satelliteLayer],
    ['radarLayer', pane.layerss.radarLayer],
    ['lightningLayer', pane.layerss.lightningLayer],
    ['observationLayer', pane.layerss.observationLayer],
  ];
  for (const [name, layer] of pairs) {
    const key = `${pane.index}:${name}`;
    poolLoadStates[key] = new Array(13).fill(false);
    poolFlowStates[key] = new Array(13).fill(false);
    const pool = new FramePool({ primaryLayer: layer, map: pane.map });
    pool.onLoadStateChange = (idx, loaded) => {
      poolLoadStates[key][idx] = loaded;
      updateTimelineCell(idx);
    };
    pool.onFlowStateChange = (idx, ready) => {
      poolFlowStates[key][idx] = ready;
      updateTimelineCell(idx);
    };
    pane.framePools[name] = pool;
  }
}

//
// MAIN
//
const main = () => {
  timeline = new Timeline(13, document.getElementById('timeline'));

  setMapLayer(getEffectiveTheme());

  // Multiple wms entries can share a (url, namespace) endpoint — e.g. all
  // six radar nations served from meteocore.app.meteo.fi/wms point at the
  // same GetCapabilities document. Fetch each unique endpoint exactly once;
  // getLayers populates layerInfo for every layer the server advertises,
  // so the remaining entries' product names resolve naturally.
  //
  // Entries with `narrowByLayer: true` (e.g. GeoMet's Canadian radar) opt
  // out of dedup: the server returns a different document per `&layer=`,
  // so each filtered request must run on its own.
  //
  // Plain null-prototype object used as a string-keyed set of endpoints.
  const seenEndpoints = Object.create(null);
  Object.values(options.wmsServerConfiguration).forEach((value) => {
    if (value.disabled) return;
    const layerKey = value.narrowByLayer ? (value.layer || '') : '';
    const key = `${value.url}|${value.namespace || ''}|${layerKey}`;
    if (!(key in seenEndpoints)) seenEndpoints[key] = value;
  });
  Object.values(seenEndpoints).forEach((wms) => getWMSCapabilities(wms));

  setButtonStates();

  buildPanePools(pane0);
  // Pools are now in framePools. If the capability probe has already
  // resolved, wire interpolators up now; otherwise the probe's .then
  // will call attachInterpolators once the verdict lands.
  attachInterpolators();
  recomputeAllTimelineCells();

  probe = initProbe({
    container: document.getElementById('probeChart'),
    onValueChange: (v) => { if (tools) tools.setProbeValue(v); },
  });
  if (radarLayer.getVisible()) {
    probe.setActiveLayer(radarLayer.getSource().getParams().LAYERS);
  }

  tools = initTools({
    map,
    getOwnPosition: () => ownPosition4326,
    getFrameTimestamp: () => (startDate ? startDate.getTime() : Date.now()),
    onPinChange: (lonLat) => probe && probe.setPin(lonLat),
    onToolChange: syncToolGroup,
  });
  syncToolGroup();

  radarSite = initRadarSite({
    map,
    radarLayer,
    updateLayer,
    setTime,
    drawCoverage: drawRadarCoverage,
    clearCoverage: clearRadarCoverage,
  });

  crosshair = initCrosshair({
    map,
    radarLayer,
    radarSiteSource,
    getActiveSiteLonLat: radarSite.getActiveSiteLonLat,
  });
  if (radarLayer.getVisible()) {
    crosshair.setActiveLayer(radarLayer.getSource().getParams().LAYERS, {
      z: radarLayer.getSource().getParams().ELEVATION,
    });
  }

  // Overflow "Mittaa" row still arms the measure tool; remember it as the
  // last-used tool so the FAB reflects it. (The FAB itself is wired above as a
  // tool-group flyout.)
  const measureToolBtn = document.getElementById('measureTool');
  if (measureToolBtn) {
    measureToolBtn.addEventListener('click', () => {
      closeOverflowMenu();
      lastTool = 'measure';
      tools.setActiveTool('measure');
    });
  }

  window.__tutka = {
    panes, map, framePools, tools, sharedView,
  };

  // GEOLOCATION
  geolocation = new Geolocation({
    trackingOptions: {
      enableHighAccuracy: true,
    },
    projection: map.getView().getProjection(),
  });

  geolocation.on('error', (error) => {
    debug(error.message);
    // PERMISSION_DENIED (code 1): tracking can never succeed, so turn it off
    // fully — otherwise the location button and the (empty) own-position
    // layer keep advertising a fix that will never come, and a persisted
    // IS_TRACKING re-arms the dead state on every boot. Transient errors
    // (POSITION_UNAVAILABLE / TIMEOUT) keep tracking armed and may recover.
    if (error.code === 1 && IS_TRACKING) {
      IS_TRACKING = false;
      localStorage.setItem('IS_TRACKING', JSON.stringify(false));
      geolocation.setTracking(false);
      setOwnPositionVisible(false);
      document.getElementById('gpsStatus').innerHTML = 'gps_not_fixed';
      setButtonStates();
      track('tracking-denied');
    }
  });
  geolocation.on('change:accuracyGeometry', onChangeAccuracyGeometry);
  geolocation.on('change:position', onChangePosition);
  geolocation.on('change:speed', onChangeSpeed);

  // Layers
  satelliteLayer.on('change:visible', onChangeVisible);
  satelliteLayer.on('propertychange', layerInfoPlaylist);
  radarLayer.on('change:visible', onChangeVisible);
  radarLayer.on('propertychange', layerInfoPlaylist);
  lightningLayer.on('change:visible', onChangeVisible);
  lightningLayer.on('propertychange', layerInfoPlaylist);
  observationLayer.on('change:visible', onChangeVisible);
  observationLayer.on('propertychange', layerInfoPlaylist);

  // Pane 0's own mini pill — hidden in 1-up (the global toolbar drives pane 0),
  // shown when a split layout is active.
  buildPanePill(pane0);

  map.on('click', (evt) => {
    const hit = map.forEachFeatureAtPixel(evt.pixel, (f) => f);
    const pin = tools && tools.getPinFeature();

    // Measurement mode: route taps to the measure tool. Snap to the
    // feature's own coordinate when the tap hits a Point feature so
    // users can measure from a radar site or airfield exactly.
    if (tools && tools.isArmed()) {
      let coord = evt.coordinate;
      if (hit && hit.getGeometry && hit.getGeometry().getType() === 'Point') {
        coord = hit.getGeometry().getCoordinates();
      }
      tools.handleMeasureTap(coord);
      return;
    }

    // Pistemittaus mode: tapping our own pin toggles its card; otherwise
    // drop/move the probe pin (which opens the dBZ chart).
    if (tools && tools.isProbeArmed()) {
      if (pin && hit === pin) {
        tools.toggleCard();
        return;
      }
      displayFeatureInfo(evt.pixel);
      tools.dropOrMove(evt.coordinate);
      return;
    }

    // No tool armed: tap on our own pin (if one lingers) toggles its card;
    // otherwise just feature info for stations. Empty-map taps are inert —
    // no pin is dropped (this is the touch-annoyance fix).
    if (pin && hit === pin) {
      tools.toggleCard();
      return;
    }

    // Tap on a radar-site marker → open its drill-in card (single-site WMS
    // toggle). Coverage rings are coupled to the single-site display (drawn on
    // toggle-on, cleared on toggle-off), not to the tap. The layer-aware lookup
    // distinguishes radar sites from airfield markers (icaoLayer) regardless of
    // z-order.
    if (radarSite && radarSiteLayer.getVisible()) {
      let radarSiteHit = null;
      // hitTolerance enlarges the tap target around the small radar symbol
      // (touch-friendly) without changing how the marker is drawn.
      map.forEachFeatureAtPixel(evt.pixel, (f, layer) => {
        if (layer === radarSiteLayer) { radarSiteHit = f; return true; }
        return false;
      }, { hitTolerance: 12 });
      if (radarSiteHit) {
        // Just open the card — coverage rings are coupled to the single-site
        // display (drawn on toggle-on, cleared on toggle-off), not to the tap.
        // Drop any leftover station highlight from a previous plain-feature tap.
        if (highlight) {
          featureOverlay.getSource().removeFeature(highlight);
          highlight = null;
        }
        radarSite.openCardForFeature(radarSiteHit);
        return;
      }
    }
    displayFeatureInfo(evt.pixel);
  });

  // Clock interaction gating + metZoom persistence, wired per pane (see
  // wirePaneClockGating / onPaneMoveEnd). pane 0 is wired here; new panes get
  // wired in initNewPane.
  wirePaneClockGating(pane0);

  // Keep every pane's map sized on viewport resize and orientation flips (the
  // 2-up grid swaps cols↔rows on rotation purely in CSS; JS just re-measures).
  window.addEventListener('resize', resizeAllPanes);
  window.matchMedia('(orientation: portrait)').addEventListener('change', resizeAllPanes);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Control') {
      document.getElementById('help').style.display = 'block';
    }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (x) => {
    // Only follow OS changes while in auto mode (no explicit user choice)
    if (IS_DARK !== null) return;
    const shown = x.matches ? 'dark' : 'light';
    setMapLayer(shown);
    track('theme-change', { pref: 'auto', shown });
  });

  if (IS_FOLLOWING) {
    setTime('last');
  } else {
    play();
  }

  if (IS_TRACKING) {
    geolocation.setTracking(true);
    setOwnPositionVisible(true);
  }

  // Position map
  if (metPosition.length > 1) {
    map.getView().setCenter(metPosition);
    map.getView().setZoom(metZoom);
  } else {
    map.getView().fit(transformExtent([19.24, 58.5, 31.59, 71.0], 'EPSG:4326', map.getView().getProjection()));
  }
  sync(map);
};

function trackBoot({ capable, mode, error }) {
  const displayMode = window.matchMedia('(display-mode: standalone)').matches ? 'standalone'
    : window.matchMedia('(display-mode: fullscreen)').matches ? 'fullscreen'
      : window.matchMedia('(display-mode: minimal-ui)').matches ? 'minimal-ui'
        : 'browser';
  const props = {
    'display-mode': displayMode,
    'theme-pref': getThemeMode(),
    'theme-shown': getEffectiveTheme(),
    'radar-visible': VISIBLE.has('radarLayer'),
    'satellite-visible': VISIBLE.has('satelliteLayer'),
    'lightning-visible': VISIBLE.has('lightningLayer'),
    'observation-visible': VISIBLE.has('observationLayer'),
    'interp-capable': capable,
    'interp-mode': mode,
    'build-date': BUILD_DATE,
    'ol-version': OL_VERSION,
  };
  if (error) props['interp-error'] = true;
  track('app-boot', props);
}

// Listen for the appinstalled event
window.addEventListener('appinstalled', () => {
  debug('PWA was installed');
  // Track successful PWA installation
  track('pwa-installed');
});

// Map-time ETA: countdown to the next image arrival.
// Behaviour: on first detection (page load) start at the layer's full
// resolution (e.g. 5:00 for a 5-min layer). Decrement each second.
// When a new image actually lands — detected by info.time.end advancing
// — RESET the counter back to the full resolution. The first wait may
// be inaccurate (we don't know how recent the latest frame is) but
// subsequent cycles align with real arrival cadence.
const ETA_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const etaEl = document.getElementById('currentMapEta');
const etaValueEl = etaEl ? etaEl.querySelector('.eta-value') : null;

let etaSeenEnd = null;
let etaResolution = null;
let etaResetAt = Date.now();

function pickEtaSourceLayer() {
  let best = null;
  // The ETA chip is shared, so pick the freshest source across every active
  // pane's visible layers (matches the shared timeline window).
  for (const pane of activePanes()) {
    for (const name of pane.VISIBLE) {
      const olLayer = pane.layerss[name];
      const wmslayer = olLayer && olLayer.getSource().getParams().LAYERS;
      const info = wmslayer && layerInfo[wmslayer] && layerInfo[wmslayer].time;
      if (info && info.end && info.resolution
        && Date.now() - info.end <= ETA_STALE_THRESHOLD_MS
        && (!best || info.resolution < best.resolution)) {
        best = info;
      }
    }
  }
  return best;
}

function updateMapEta() {
  if (!etaEl || !etaValueEl) return;
  const info = pickEtaSourceLayer();
  if (!info) {
    etaEl.hidden = true;
    etaSeenEnd = null;
    etaResolution = null;
    return;
  }

  // Reset whenever we first see a layer or its newest frame advances.
  if (info.end !== etaSeenEnd || info.resolution !== etaResolution) {
    etaSeenEnd = info.end;
    etaResolution = info.resolution;
    etaResetAt = Date.now();
  }

  const remaining = etaResolution - (Date.now() - etaResetAt);
  etaEl.hidden = false;
  if (remaining > 0) {
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    etaValueEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
  } else {
    etaValueEl.textContent = 'odotetaan';
  }
}

setInterval(updateMapEta, 1000);
updateMapEta();

// Time chip — small clock in the bottom-left corner. Click to toggle local
// time vs UTC; the choice persists across sessions. In app-fullscreen mode the
// same pill instead shows the displayed frame's DATA time (see renderTimeChip).
let timeIsUtc = safeParseJSON('timeIsUtc', false);
const timeChipEl = document.getElementById('timeChip');
const tcTime = timeChipEl && timeChipEl.querySelector('.tc-time');
const tcDate = timeChipEl && timeChipEl.querySelector('.tc-date');

function renderTimeChip() {
  if (!timeChipEl) return;
  // Fullscreen shows the displayed frame's data time (mapTime); otherwise the
  // wall-clock "now". Falls back to now if no frame has loaded yet.
  const base = (appFullscreen && mapTime) ? dayjs(mapTime) : dayjs();
  const d = timeIsUtc ? base.utc() : base;
  tcTime.textContent = d.format('HH:mm');
  tcDate.textContent = timeIsUtc
    ? `${d.format('dd D.M.')} UTC`
    : d.format('dd D.M.');
  timeChipEl.classList.toggle('utc-mode', timeIsUtc);
}

if (timeChipEl) {
  timeChipEl.addEventListener('click', (e) => {
    e.stopPropagation();
    timeIsUtc = !timeIsUtc;
    localStorage.setItem('timeIsUtc', JSON.stringify(timeIsUtc));
    renderTimeChip();
    track('time-chip-toggle', { utc: timeIsUtc });
  });

  renderTimeChip();
  setInterval(renderTimeChip, 1000);
}

// App-level fullscreen ("Koko ruutu") — hides all chrome except the data-time
// chip (bottom-left) and the exit FAB (bottom-right). Transient view mode, not
// persisted across reloads.
function setAppFullscreen(on) {
  appFullscreen = on;
  document.body.classList.toggle('app-fullscreen', on);
  if (on) {
    closeOverflowMenu();
    closePlaylist();
    closeToolFlyout();
  }
  renderTimeChip(); // swap now ⇄ data time immediately
  track(on ? 'fullscreen-on' : 'fullscreen-off');
}

const fullscreenEnterButton = document.getElementById('fullscreenEnterButton');
const fullscreenExitButton = document.getElementById('fullscreenExitButton');
if (fullscreenEnterButton) {
  fullscreenEnterButton.addEventListener('click', () => setAppFullscreen(true));
}
if (fullscreenExitButton) {
  fullscreenExitButton.addEventListener('click', () => setAppFullscreen(false));
}

main();
