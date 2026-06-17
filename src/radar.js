// deploy-marker: sw-update-flow-test — bump on PR #87 to force a fresh
// radar.[contenthash].js so the deployed test build differs from the
// previous one and the new banner flow can be exercised end-to-end.
import { Map, View } from 'ol';
import Geolocation from 'ol/Geolocation';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import VectorTileLayer from 'ol/layer/VectorTile';
import XYZ from 'ol/source/XYZ';
import ImageWMS from 'ol/source/ImageWMS';
import VectorTileSource from 'ol/source/VectorTile';
import GeoJSON from 'ol/format/GeoJSON';
import MVT from 'ol/format/MVT';
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
import wmsServerConfiguration from './config';
import createLongPressHandler from './longpress';
import initTools from './tools';
import initProbe from './probe';
import initRadarSite from './radarSite';
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
  rangeRingSpacing: 50,
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
let startDate = new Date(Math.floor(Date.now() / 300000) * 300000 - 300000 * 12);
// Handle of the currently-running playback loop (now a requestAnimationFrame
// id — was a setInterval handle before the RAF refactor). Null when paused.
let animationId = null;
let lastAdvance = 0;
let lastWarpTick = 0;
const layerInfo = {};
let timeline;
let mapTime = '';
const framePools = {
  satelliteLayer: null,
  radarLayer: null,
  lightningLayer: null,
  observationLayer: null,
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
  // eslint-disable-next-line no-console
  console.info(`[tutka] INTERP: capable=${ok} mode=${interpMode}`);
  trackBoot({ capable: ok, mode: interpMode });
  attachInterpolators();
  updateInterpChipsState();
}).catch((err) => {
  // eslint-disable-next-line no-console
  console.warn('[tutka] INTERP probe failed:', err);
  trackBoot({ capable: false, mode: DEFAULT_INTERP_MODE, error: true });
});

function attachInterpolators() {
  if (interpMode === 'off') return;
  const playing = animationId !== null;
  const useFlow = interpMode === 'flow';
  for (const name of ['radarLayer', 'satelliteLayer']) {
    const pool = framePools[name];
    if (pool && !pool.interpolator) {
      pool.setInterpolator(new RadarInterpolator({ useFlow }));
      pool.refreshFlows();
      if (playing) pool.setInterpActive(true);
    }
  }
}

function detachInterpolators() {
  for (const name of ['radarLayer', 'satelliteLayer']) {
    const pool = framePools[name];
    if (pool && pool.interpolator) {
      pool.setInterpActive(false);
      pool.setInterpolator(null);
    }
  }
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
    for (const name of ['radarLayer', 'satelliteLayer']) {
      const pool = framePools[name];
      if (pool && pool.interpolator) {
        pool.interpolator.setUseFlow(useFlow);
        pool.refreshFlows();
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
const poolLoadStates = {
  satelliteLayer: new Array(13).fill(false),
  radarLayer: new Array(13).fill(false),
  lightningLayer: new Array(13).fill(false),
  observationLayer: new Array(13).fill(false),
};
// Per-cell "flow ready" state. Only populated for pools that have an
// interpolator attached (radar, satellite when interp is enabled).
// True means both endpoints of the pair starting at this index are
// loaded AND the interpolator has a computed flow field — playback
// through this timestep will show a motion-compensated warp instead
// of a jump to the next discrete frame.
const poolFlowStates = {
  satelliteLayer: new Array(13).fill(false),
  radarLayer: new Array(13).fill(false),
  lightningLayer: new Array(13).fill(false),
  observationLayer: new Array(13).fill(false),
};

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
  for (const name of Object.keys(framePools)) {
    const pool = framePools[name];
    if (!pool || !VISIBLE.has(name)) continue; // eslint-disable-line no-continue
    if (!poolLoadStates[name][i]) allLoaded = false;
    // A pool only marks flow-pending if it actually has an
    // interpolator attached. Lightning/observation (no interp) and
    // radar/satellite with mode=off never flag this cell.
    if (pool.interpolator && !poolFlowStates[name][i]) flowPending = true;
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
// FEATURES
//
const positionFeature = new Feature();
positionFeature.setStyle(new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({
      color: '#3399CC',
    }),
    stroke: new Stroke({
      color: '#fff',
      width: 2,
    }),
  }),
}));

const accuracyFeature = new Feature();
accuracyFeature.setStyle(new Style({
  fill: new Fill({
    color: [128, 128, 128, 0.3],
  }),
}));

//
// LAYERS
//
const imageryBaseLayer = new TileLayer({
  visible: false,
  source: new XYZ({
    attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer">ArcGIS</a>',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  }),
});

const lightGrayBaseLayer = new TileLayer({
  visible: false,
  preload: Infinity,
  source: new XYZ({
    attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer">ArcGIS</a>',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  }),
});

const lightGrayReferenceLayer = new TileLayer({
  visible: false,
  source: new XYZ({
    attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer">ArcGIS</a>',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  }),
});

const darkGrayBaseLayer = new TileLayer({
  preload: Infinity,
  source: new XYZ({
    attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer">ArcGIS</a>',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  }),
});

const darkGrayReferenceLayer = new TileLayer({
  source: new XYZ({
    attributions: 'Tiles © <a href="https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer">ArcGIS</a>',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
  }),
});

// Satellite Layer
const satelliteLayer = new ImageLayer({
  name: 'satelliteLayer',
  visible: VISIBLE.has('satelliteLayer'),
  opacity: 0.7,
  source: new ImageWMS({
    url: options.wmsServerConfiguration.eumetsat1.url,
    params: { FORMAT: 'image/jpeg', LAYERS: 'rgb_eview' },
    hidpi: false,
    attributions: 'EUMETSAT',
    ratio: options.imageRatio,
    serverType: 'geoserver',
  }),
});
// Default wire format / transparency — restored by updateLayer when the
// user picks a layer that doesn't carry per-layer overrides. Without
// this, switching from a transparent overlay back to a full-disc RGB
// would inherit `TRANSPARENT=TRUE` and waste bandwidth on a PNG.
satelliteLayer.set('defaultFormat', 'image/jpeg');
satelliteLayer.set('defaultTransparent', false);

// Radar Layer
const radarLayer = new ImageLayer({
  name: 'radarLayer',
  visible: VISIBLE.has('radarLayer'),
  opacity: 0.7,
  source: new ImageWMS({
    url: options.wmsServerConfiguration.fi.url,
    params: { LAYERS: options.defaultRadarLayer },
    attributions: 'FMI (CC-BY-4.0)',
    ratio: options.imageRatio,
    hidpi: false,
    serverType: 'geoserver',
  }),
});
// Category default wire format. updateLayer / applyWireFormat substitute
// image/webp when the serving WMS advertises it in GetCapabilities (see
// resolveFormat) — this is the fallback for servers that don't.
radarLayer.set('defaultFormat', 'image/png');
// Opt out of the webp wire format for radar specifically. Lossless webp
// encoding on the meteocore server side is currently too slow to keep up
// with retina-fullscreen request sizes; image/png is cached and served
// more cheaply on that path. Revisit once requests are clamped to the
// radar's native resolution (then payload size is bounded and the
// encoding-time cost of lossless webp becomes worth the smaller bytes).
radarLayer.set('disableWebp', true);

// Lightning Layer
const lightningLayer = new ImageLayer({
  name: 'lightningLayer',
  visible: VISIBLE.has('lightningLayer'),
  source: new ImageWMS({
    url: options.wmsServerConfiguration['meteo-obs-new'].url,
    params: { FORMAT: 'image/png8', LAYERS: options.defaultLightningLayer },
    ratio: options.imageRatio,
    hidpi: false,
    serverType: 'geoserver',
  }),
});
lightningLayer.set('defaultFormat', 'image/png8');

// Observation Layer
const observationLayer = new ImageLayer({
  name: 'observationLayer',
  visible: VISIBLE.has('observationLayer'),
  source: new ImageWMS({
    url: options.wmsServerConfiguration['meteo-obs-new'].url,
    params: { FORMAT: 'image/png8', LAYERS: options.defaultObservationLayer },
    ratio: options.imageRatio,
    hidpi: false,
    serverType: 'geoserver',
  }),
});
observationLayer.set('defaultFormat', 'image/png8');

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

const radarSiteLayer = new VectorLayer({
  source: radarSiteSource,
  style(feature) {
    radarStyle.getText().setText(feature.get('name'));
    return radarStyle;
  },
});

const icaoLayer = new VectorLayer({
  source: new Vector({
    format: new GeoJSON(),
    url: 'airfields-finland.json',
  }),
  visible: false,
  style(feature) {
    icaoStyle.getText().setText(feature.get('icao'));
    return icaoStyle;
  },
});

const municipalityLayer = new VectorTileLayer({
  visible: false,
  // Re-render features per frame instead of rasterising them once per
  // tile. Hybrid mode (the default) makes the strokes scale like raster
  // pixels between integer zoom levels — visible as "thick then snaps
  // thin" while zooming. Vector mode keeps the 1.5 px stroke crisp.
  renderMode: 'vector',
  source: new VectorTileSource({
    format: new MVT(),
    url: 'https://meteocore.app.meteo.fi/tiles/collections/fi-municipalities/tiles/WebMercatorQuad/{z}/{y}/{x}?f=mvt',
    attributions: 'Statistics Finland / Tilastokeskus',
    maxZoom: 14,
  }),
  // Initial style is set below by setMapLayer once the effective theme
  // is known. Default to the light variant so the layer is renderable
  // even if a future code path skips the theme bootstrap.
  style: municipalityStyleLight,
});

// Fairways (Vesiväylät) — OGC API Features from Väylävirasto. The
// dataset is ~770 KB gzipped (1901 LineString features as of 2026-05),
// small enough to fetch once on first toggle-on using OL's default
// "all" loading strategy. Limit=10000 leaves headroom; if the dataset
// ever exceeds it, switch to bbox strategy with a tilegrid snap.
const vesivaylaAreaLayer = new VectorLayer({
  visible: false,
  source: new Vector({
    format: new GeoJSON(),
    url: 'https://avoinapi.vaylapilvi.fi/vaylatiedot/ogc/features/v1/collections/vesivaylatiedot:vaylaalueet_uusi/items?f=application/geo%2Bjson&limit=10000',
    attributions: 'Väylävirasto',
  }),
  style: vesivaylaAreaStyle,
});

const vesivaylatLayer = new VectorLayer({
  visible: false,
  // Declutter so overlapping nimifi labels along parallel fairway segments
  // don't pile up at harbours. Stroke geometry still renders fully — only
  // text participates in the decluttering.
  declutter: true,
  source: new Vector({
    format: new GeoJSON(),
    url: 'https://avoinapi.vaylapilvi.fi/vaylatiedot/ogc/features/v1/collections/vesivaylatiedot:vaylat_uusi/items?f=application/geo%2Bjson&limit=10000',
    attributions: 'Väylävirasto',
  }),
  style: vesivaylatStyleFn,
});

const guideLayer = new VectorLayer({
  source: new Vector(),
  style: rangeStyle,
});

const ownPositionLayer = new VectorLayer({
  visible: false,
  source: new Vector({
    features: [accuracyFeature, positionFeature],
  }),
});

const layerss = {
  satelliteLayer,
  radarLayer,
  observationLayer,
  lightningLayer,
};

const layers = [
  lightGrayBaseLayer,
  darkGrayBaseLayer,
  imageryBaseLayer,
  // s57Layer,
  satelliteLayer,
  radarLayer,
  guideLayer,
  lightningLayer,
  lightGrayReferenceLayer,
  darkGrayReferenceLayer,
  municipalityLayer,
  vesivaylaAreaLayer,
  vesivaylatLayer,
  radarSiteLayer,
  icaoLayer,
  ownPositionLayer,
  observationLayer,
];

const map = new Map({
  target: 'map',
  layers,
  controls: [],
  view: new View({
    enableRotation: false,
    center: fromLonLat([26, 65]),
    maxZoom: 16,
    zoom: 5,
  }),
  keyboardEventTarget: document,
});

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
    new Feature({ name: `${direction}dasd`, geometry: line.transform('EPSG:4326', map.getView().getProjection()) }),
  ]);
}

// GEOLOCATION Functions

function onChangeAccuracyGeometry(event) {
  debug('Accuracy geometry changed.');
  accuracyFeature.setGeometry(event.target.getAccuracyGeometry());
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
  positionFeature.setGeometry(coordinates
    ? new Point(coordinates) : null);
  document.getElementById('gpsStatus').innerHTML = 'gps_fixed';
  localStorage.setItem('metLatitude', ownPosition4326[1]);
  localStorage.setItem('metLongitude', ownPosition4326[0]);
  localStorage.setItem('metPosition', JSON.stringify(ownPosition));
  if (tools) tools.refresh();
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
  }
}

function getActiveLayers() {
  const active = [];
  if (satelliteLayer.getVisible()) {
    active.push(satelliteLayer.getSource().getParams().LAYERS);
  }
  if (radarLayer.getVisible()) {
    active.push(radarLayer.getSource().getParams().LAYERS);
  }
  if (lightningLayer.getVisible()) {
    active.push(lightningLayer.getSource().getParams().LAYERS);
  }
  if (observationLayer.getVisible()) {
    active.push(observationLayer.getSource().getParams().LAYERS);
  }
  return active;
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

  for (const item of VISIBLE) {
    const wmslayer = layerss[item].getSource().getParams().LAYERS;
    if (wmslayer in layerInfo) {
      if (item === 'radarLayer' || item === 'satelliteLayer' || item === 'observationLayer') {
        end = Math.min(end, Math.floor(layerInfo[wmslayer].time.end / resolution) * resolution);
      }
      resolution = Math.max(resolution, layerInfo[wmslayer].time.resolution);
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
    startDate = new Date(start);
    timeline = new Timeline(13, document.getElementById('timeline'));
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
  const routeLayer = (name, window, currentTime) => {
    const olLayer = layerss[name];
    const button = document.getElementById(`${name}Button`);

    if (!VISIBLE.has(name)) {
      if (button) button.classList.remove('stale-data');
      olLayer.setOpacity(1);
      LAYER_IN_RANGE[name] = true;
      return;
    }

    const wmslayer = olLayer.getSource().getParams().LAYERS;
    const info = wmslayer in layerInfo ? layerInfo[wmslayer].time : null;

    const isStale = !!(info && info.end && Date.now() - info.end > STALE_THRESHOLD_MS);
    if (button) button.classList.toggle('stale-data', isStale);

    const inRange = !info || !info.start || !info.end
      || (tNow >= info.start && tNow <= info.end);
    olLayer.setOpacity(inRange ? 1 : 0);
    LAYER_IN_RANGE[name] = inRange;

    if (!inRange) return;

    const pool = framePools[name];
    pool.setWindow(window);
    pool.showTime(currentTime);
  };
  routeLayer('satelliteLayer', windowInstant, timeISO);
  routeLayer('radarLayer', windowInstant, timeISO);
  routeLayer('lightningLayer', windowInterval, timeInterval);
  routeLayer('observationLayer', windowInterval, timeInterval);
  updateMapTimeDisplay(timeISO);
}

//
// TIME CONTROLS
//

let isInteracting = false;

function anyPoolZooming() {
  for (const name of Object.keys(framePools)) {
    const p = framePools[name];
    if (p && p.isZoomGestureActive && p.isZoomGestureActive()) return true;
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
  for (const name of Object.keys(framePools)) {
    if (!VISIBLE.has(name)) continue; // eslint-disable-line no-continue
    if (LAYER_IN_RANGE[name] === false) continue; // eslint-disable-line no-continue
    const pool = framePools[name];
    if (pool) pool.showInterpolated(t);
  }
};

function setInterpActiveAll(active) {
  for (const name of Object.keys(framePools)) {
    const pool = framePools[name];
    if (pool && pool.interpolator) pool.setInterpActive(active);
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

function applyIcaoTheme(theme) {
  const t = icaoTextColors[theme] || icaoTextColors.dark;
  icaoStyle.getText().getFill().setColor(t.fill);
  icaoStyle.getText().getStroke().setColor(t.halo);
  icaoLayer.changed();
}

function applyVesivaylatTheme(theme) {
  vesivaylatStyleSet = theme === 'light' ? vesivaylatStylesLight : vesivaylatStylesDark;
  const t = vesivaylatLabelColors[theme] || vesivaylatLabelColors.dark;
  vesivaylatLabelStyle.getText().getFill().setColor(t.fill);
  vesivaylatLabelStyle.getText().getStroke().setColor(t.halo);
  vesivaylatLayer.changed();
  vesivaylaAreaStyle.getFill().setColor(vesivaylaAreaFills[theme] || vesivaylaAreaFills.light);
  vesivaylaAreaLayer.changed();
}

function setMapLayer(maplayer) {
  debug(`Set ${maplayer} map.`);
  switch (maplayer) {
    case 'light':
      darkGrayBaseLayer.setVisible(false);
      darkGrayReferenceLayer.setVisible(false);
      lightGrayBaseLayer.setVisible(true);
      lightGrayReferenceLayer.setVisible(true);
      municipalityLayer.setStyle(municipalityStyleLight);
      applyIcaoTheme('light');
      applyVesivaylatTheme('light');
      break;
    case 'dark':
      darkGrayBaseLayer.setVisible(true);
      darkGrayReferenceLayer.setVisible(true);
      lightGrayBaseLayer.setVisible(false);
      lightGrayReferenceLayer.setVisible(false);
      municipalityLayer.setStyle(municipalityStyleDark);
      applyIcaoTheme('dark');
      applyVesivaylatTheme('dark');
      break;
    default:
      break;
  }
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

function removeSelectedParameter(selector) {
  const els = document.querySelectorAll(selector);
  els.forEach((elem) => {
    elem.classList.remove('selected');
  });
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
    skipVisibility = false, skipTracking = false, skipPersist = false, source,
  } = opts;
  debug(`Activated layer ${wmslayer}`);
  if (!skipTracking && source) {
    trackCategory(layer, { action: 'pick', layer: wmslayer, source });
  }
  debug(layerInfo[wmslayer]);
  const info = layerInfo[wmslayer];
  layer.set('info', info);
  if (document.getElementById(wmslayer)) {
    removeSelectedParameter(`#${layer.get('name')} > div`);
    document.getElementById(wmslayer).classList.add('selected');
  }
  if (info && info.url) {
    layer.setLayerUrl(info.url);
  }
  // Reset style if the new layer doesn't support the currently active style
  const currentStyle = layer.getSource().getParams().STYLES || '';
  const baseUpdate = { LAYERS: wmslayer };
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
    if (category && ACTIVE_LAYERS[category] !== wmslayer) {
      ACTIVE_LAYERS[category] = wmslayer;
      persistActiveLayers();
    }
  }
  if (!skipVisibility) {
    if (layer.getVisible()) {
      updateCanonicalPage();
    } else {
      layer.setVisible(true);
    }
  }
  updateLayerSelectionSelected();
  if (probe && layer === radarLayer) {
    // Pass the elevation (set in single-site mode) so the EDR probe queries the
    // displayed sweep; composites carry no ELEVATION param (z stays null).
    probe.setActiveLayer(layer.getVisible() ? wmslayer : null, {
      z: layer.getSource().getParams().ELEVATION,
    });
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
function restoreActiveLayer(category) {
  if (!category) return;
  // While drilled into a single radar site, the radar layer intentionally runs
  // a transient `<collection>/DBZH` product that is NOT in ACTIVE_LAYERS. Skip
  // the restore so the periodic (60 s) capabilities refresh doesn't revert it
  // back to the stored composite mid-session.
  if (category === 'radarLayer' && radarSite && radarSite.isSingleSiteActive()) return;
  const olLayer = layerss[category];
  if (!olLayer) return;
  const stored = ACTIVE_LAYERS[category];
  if (!stored) return;

  if (!layerInfo[stored] || layerInfo[stored].category !== category) {
    delete ACTIVE_LAYERS[category];
    persistActiveLayers();
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

function createLayerInfoElement(content, className, isHTML) {
  const div = document.createElement('div');
  div.classList.add(className);
  if (typeof content !== 'undefined' && content !== null) {
    if (isHTML) {
      div.innerHTML = content;
    } else {
      div.textContent = content;
    }
  }
  return div;
}

function layerInfoDiv(wmslayer) {
  const info = layerInfo[wmslayer];
  const div = document.createElement('div');
  const resolution = info && info.time ? Math.round(info.time.resolution / 60000) : 0;

  div.id = `${wmslayer}Meta`;
  div.setAttribute('data-layer-name', wmslayer);
  div.setAttribute('data-layer-category', info ? info.category : '');

  div.appendChild(createLayerInfoElement(info ? info.title : '', 'title'));

  const previewDiv = document.createElement('div');
  previewDiv.classList.add('preview');
  if (info && info.url && info.layer) {
    const img = document.createElement('img');
    img.className = 'responsiveImage';
    img.loading = 'lazy';
    img.src = `${info.url}?TIME=PT1H/PRESENT&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image%2Fpng8&TRANSPARENT=true&CRS=EPSG%3A3067&STYLES=&WIDTH=300&HEIGHT=300&BBOX=-183243.50620644476%2C6575998.62606195%2C1038379.8685031873%2C7797622.000771582&LAYERS=${encodeURIComponent(info.layer)}`;
    previewDiv.appendChild(img);
  }
  div.appendChild(previewDiv);
  div.appendChild(createLayerInfoElement(info ? info.abstract : '', 'abstract'));
  if (info && info.time && info.time.end) {
    div.appendChild(createLayerInfoElement((resolution > 60 ? `${resolution / 60} tuntia ` : `${resolution} minuuttia, viimeisin: `) + dayjs(info.time.end).format('LT'), 'time'));
  } else {
    div.appendChild(createLayerInfoElement('Aikatiedot ei saatavilla', 'time'));
  }
  if (info && info.attribution && info.attribution.Title) {
    let attrText = info.attribution.Title;
    if (info.license) attrText += ` (${info.license})`;
    div.appendChild(createLayerInfoElement(attrText, 'attribution'));
  } else {
    div.appendChild(createLayerInfoElement('', 'attribution'));
  }
  return div;
}

const _playlistSliderHandlers = {};

function layerInfoPlaylist(event) {
  const layer = event.target;
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
  removeSelectedParameter(`#${name} > div`);
  if (isVisible) {
    debug(`Activated ${name}`);
    VISIBLE.add(name);
    localStorage.setItem('VISIBLE', JSON.stringify([...VISIBLE]));
    if (document.getElementById(wmslayer)) {
      document.getElementById(wmslayer).classList.add('selected');
    }
    setButtonState(`${name}Button`, true);
    document.getElementById(`${name}Info`).classList.remove('playListDisabled');
    const toggleIcon = document.querySelector(`#${name}Info .card-visibility-toggle .material-icons`);
    if (toggleIcon) toggleIcon.textContent = 'visibility';
  } else {
    debug(`Deactivated ${name}`);
    VISIBLE.delete(name);
    localStorage.setItem('VISIBLE', JSON.stringify([...VISIBLE]));
    setButtonState(`${name}Button`, false);
    document.getElementById(`${name}Info`).classList.add('playListDisabled');
    const toggleIcon = document.querySelector(`#${name}Info .card-visibility-toggle .material-icons`);
    if (toggleIcon) toggleIcon.textContent = 'visibility_off';
  }
  updateCanonicalPage();
  updateLayerSelectionSelected();
  recomputeAllTimelineCells();
  if (probe && layer === radarLayer) {
    probe.setActiveLayer(isVisible ? wmslayer : null, {
      z: layer.getSource().getParams().ELEVATION,
    });
  }
  // Visibility change may invalidate the current timeline window
  // (e.g. activating a stale satellite caps `end` to its old time.end,
  // or hiding it releases the cap). Recompute window + per-layer
  // in-range state immediately so the map time, stale colour and
  // layer opacity update without waiting for a tick or manual step.
  setTime('keep');
  // Turning the radar layer off exits single-site mode, restoring the composite
  // product (while hidden) so re-enabling the layer shows the composite again.
  if (layer === radarLayer && !isVisible && radarSite) {
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

// Close playlist if clicked outside of playlist
window.addEventListener('mouseup', (e) => {
  // playlist
  if (!document.getElementById('playList').contains(e.target)) {
    if (document.getElementById('playlistButton').contains(e.target)) return;
    closePlaylist();
  }

  // Close long-press menus when clicking/touching outside
  const longPressMenus = [
    { menuId: 'observationLongPressMenu', buttonId: 'observationLayerButton' },
    { menuId: 'satelliteLongPressMenu', buttonId: 'satelliteLayerButton' },
    { menuId: 'radarLongPressMenu', buttonId: 'radarLayerButton' },
    { menuId: 'lightningLongPressMenu', buttonId: 'lightningLayerButton' },
  ];
  longPressMenus.forEach((cfg) => {
    if (!document.getElementById(cfg.menuId).contains(e.target)) {
      if (document.getElementById(cfg.buttonId).contains(e.target)) return;
      document.getElementById(cfg.menuId).style.display = 'none';
    }
  });
});

window.addEventListener('touchend', (e) => {
  const longPressMenus = [
    { menuId: 'observationLongPressMenu', buttonId: 'observationLayerButton' },
    { menuId: 'satelliteLongPressMenu', buttonId: 'satelliteLayerButton' },
    { menuId: 'radarLongPressMenu', buttonId: 'radarLayerButton' },
    { menuId: 'lightningLongPressMenu', buttonId: 'lightningLayerButton' },
  ];
  longPressMenus.forEach((cfg) => {
    if (!document.getElementById(cfg.menuId).contains(e.target)) {
      if (document.getElementById(cfg.buttonId).contains(e.target)) return;
      document.getElementById(cfg.menuId).style.display = 'none';
    }
  });
});

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
    ownPositionLayer.setVisible(false);
    track('tracking-off');
  } else {
    IS_TRACKING = true;
    localStorage.setItem('IS_TRACKING', JSON.stringify(true));
    geolocation.setTracking(true);
    ownPositionLayer.setVisible(true);
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
const TOOL_ICONS = { measure: 'straighten', pistemittaus: 'colorize' };
let lastTool = 'pistemittaus';

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

// POI layers — map features that users can toggle independently of data layers.
// Adding a future POI = one entry in this registry; the overflow menu row and
// localStorage persistence fall out automatically.
const poiRegistry = [
  {
    id: 'radars',
    label: 'Tutka-asemat',
    icon: 'cell_tower',
    defaultOn: true,
    layerRef: () => radarSiteLayer,
  },
  {
    id: 'airfields',
    label: 'Lentokentät',
    icon: 'flight',
    defaultOn: false,
    layerRef: () => icaoLayer,
  },
  {
    id: 'municipalities',
    label: 'Kunnat',
    icon: 'location_city',
    defaultOn: false,
    layerRef: () => municipalityLayer,
  },
  {
    id: 'vesivaylat',
    label: 'Vesiväylät',
    icon: 'directions_boat',
    defaultOn: false,
    // Area fill renders behind the line geometry — both flip together
    // off the same toggle. Order here doesn't drive z-order; the layers
    // array does (vesivaylaAreaLayer sits before vesivaylatLayer there).
    layerRef: () => [vesivaylaAreaLayer, vesivaylatLayer],
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
    const ref = entry.layerRef();
    const visible = !!POI_STATE[entry.id];
    (Array.isArray(ref) ? ref : [ref]).forEach((l) => l.setVisible(visible));
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
  } else if (event.key === 'Escape') {
    if (overflowMenuEl.classList.contains('open')) closeOverflowMenu();
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

function updateLayerSelection(ollayer, type, filter) {
  // `filter` may be a single substring (original API) or an array of
  // substrings — the lightning menu uses an array so it can collect
  // both the FMI lightning-network layer (`observation:lightning`) and
  // the EUMETSAT MTG Lightning Imager layer (`li_afa`) under the same
  // category card.
  const filters = Array.isArray(filter) ? filter : [filter];
  const parent = document.getElementById('layers');
  document.querySelectorAll(`.${type}LayerSelect`).forEach((child) => {
    parent.removeChild(child);
  });
  Object.keys(layerInfo).sort().forEach((layer) => {
    if (filters.some((f) => layerInfo[layer].layer.includes(f))) {
      const div = layerInfoDiv(layer);
      div.onclick = function () {
        if (ollayer.getVisible() && getActiveLayers().includes(layer)) {
          toggleLayerVisibility(ollayer, 'playlist');
        } else {
          updateLayer(ollayer, layerInfo[layer].layer, { source: 'playlist' });
        }
      };
      div.classList.add(`${type}LayerSelect`);
      div.classList.add('layerSelectItem');
      const ollayerInfo = ollayer.get('info');
      if (ollayerInfo && ollayerInfo.layer === layer) {
        div.classList.add('selectedLayer');
      }
      document.getElementById('layers').appendChild(div);
    }
  });
  updateLayerSelectionSelected();
}

function updateLayerSelectionSelected() {
  debug('UPDATE Layer Selection Selected called');
  const activeLayers = getActiveLayers();
  document.querySelectorAll('.layerSelectItem').forEach((div) => {
    div.classList.remove('selectedLayer');
    if (VISIBLE.has(div.getAttribute('data-layer-category'))) {
      if (activeLayers.includes(div.getAttribute('data-layer-name'))) {
        div.classList.add('selectedLayer');
      }
    }
  });
}

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
      satelliteLayer.set('info', layerInfo[satelliteLayer.getSource().getParams().LAYERS]);
      radarLayer.set('info', layerInfo[radarLayer.getSource().getParams().LAYERS]);
      lightningLayer.set('info', layerInfo[lightningLayer.getSource().getParams().LAYERS]);
      observationLayer.set('info', layerInfo[observationLayer.getSource().getParams().LAYERS]);
      // Adopt webp for any category already showing a layer from a
      // webp-capable server, including the boot defaults.
      applyWireFormat(satelliteLayer);
      applyWireFormat(radarLayer);
      applyWireFormat(lightningLayer);
      applyWireFormat(observationLayer);
      switch (wms.category) {
        case 'satelliteLayer':
          updateLayerSelection(satelliteLayer, 'satellite', 'msg_');
          break;
        case 'observationLayer':
          updateLayerSelection(observationLayer, 'observation', 'observation:');
          // The FMI observation server is what publishes `observation:lightning`,
          // so refresh the lightning menu too — otherwise the order in which
          // GetCapabilities responses arrive decides whether the FMI entry
          // ends up listed alongside the EUMETSAT MTG one.
          updateLayerSelection(lightningLayer, 'lightning', ['lightning', 'li_afa', 'rdt']);
          break;
        case 'radarLayer':
          updateLayerSelection(radarLayer, 'radar', 'suomi_');
          break;
        case 'lightningLayer':
          updateLayerSelection(lightningLayer, 'lightning', ['lightning', 'li_afa', 'rdt']);
          break;
        default:
          debug('No wms.category set');
      }
      restoreActiveLayer(wms.category);
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
  // Plain object (not a Map) because `Map` is imported from 'ol' at the
  // top of this file — `new Map()` here would build an OpenLayers Map.
  const seenEndpoints = Object.create(null);
  Object.values(options.wmsServerConfiguration).forEach((value) => {
    if (value.disabled) return;
    const layerKey = value.narrowByLayer ? (value.layer || '') : '';
    const key = `${value.url}|${value.namespace || ''}|${layerKey}`;
    if (!(key in seenEndpoints)) seenEndpoints[key] = value;
  });
  Object.values(seenEndpoints).forEach((wms) => getWMSCapabilities(wms));

  setButtonStates();

  const pairs = [
    ['satelliteLayer', satelliteLayer],
    ['radarLayer', radarLayer],
    ['lightningLayer', lightningLayer],
    ['observationLayer', observationLayer],
  ];
  for (const [name, layer] of pairs) {
    const pool = new FramePool({ primaryLayer: layer, map });
    pool.onLoadStateChange = (idx, loaded) => {
      poolLoadStates[name][idx] = loaded;
      updateTimelineCell(idx);
    };
    pool.onFlowStateChange = (idx, ready) => {
      poolFlowStates[name][idx] = ready;
      updateTimelineCell(idx);
    };
    framePools[name] = pool;
  }
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

  window.__tutka = { map, framePools, tools };

  // GEOLOCATION
  geolocation = new Geolocation({
    trackingOptions: {
      enableHighAccuracy: true,
    },
    projection: map.getView().getProjection(),
  });

  geolocation.on('error', (error) => { debug(error.message); });
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

  map.on('pointerdrag', () => { isInteracting = true; });
  map.on('moveend', () => {
    isInteracting = false;
    // Defer the next playback advance by a full stepDuration after any
    // view change. Without this, the advance cadence fires on the very
    // next RAF tick after a pan (since lastAdvance accumulated while
    // isInteracting was true), which races with the moveend-triggered
    // prefetch in FramePool — second prefetch aborts the first, noisy
    // "Image load error" shows up in the console for every aborted
    // request.
    lastAdvance = window.performance.now();
    const zoom = Math.min(map.getView().getZoom(), 16);
    localStorage.setItem('metZoom', zoom);
  });

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
    ownPositionLayer.setVisible(true);
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
  VISIBLE.forEach((name) => {
    const olLayer = layerss[name];
    if (!olLayer) return;
    const wmslayer = olLayer.getSource().getParams().LAYERS;
    const info = layerInfo[wmslayer] && layerInfo[wmslayer].time;
    if (!info || !info.end || !info.resolution) return;
    if (Date.now() - info.end > ETA_STALE_THRESHOLD_MS) return;
    if (!best || info.resolution < best.resolution) best = info;
  });
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
// time vs UTC; the choice persists across sessions.
let timeIsUtc = safeParseJSON('timeIsUtc', false);
const timeChipEl = document.getElementById('timeChip');
if (timeChipEl) {
  const tcTime = timeChipEl.querySelector('.tc-time');
  const tcDate = timeChipEl.querySelector('.tc-date');

  const renderTimeChip = () => {
    const d = timeIsUtc ? dayjs().utc() : dayjs();
    tcTime.textContent = d.format('HH:mm');
    tcDate.textContent = timeIsUtc
      ? `${d.format('dd D.M.')} UTC`
      : d.format('dd D.M.');
    timeChipEl.classList.toggle('utc-mode', timeIsUtc);
  };

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

main();
