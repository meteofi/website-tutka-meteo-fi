import { Map, View } from 'ol';
import Geolocation from 'ol/Geolocation';
import TileLayer from 'ol/layer/Tile';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import XYZ from 'ol/source/XYZ';
import ImageWMS from 'ol/source/ImageWMS';
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
import wmsServerConfiguration from './config';
import createLongPressHandler from './longpress';
import initTools from './tools';
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

const icaoStyle = new Style({
  image: new CircleStyle({
    radius: 4,
    fill: null,
    stroke: new Stroke({ color: 'blue', width: 2 }),
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

const radarSiteLayer = new VectorLayer({
  source: new Vector({
    format: new GeoJSON(),
    url: 'radars-finland.json',
  }),
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

function setMapLayer(maplayer) {
  debug(`Set ${maplayer} map.`);
  switch (maplayer) {
    case 'light':
      darkGrayBaseLayer.setVisible(false);
      darkGrayReferenceLayer.setVisible(false);
      lightGrayBaseLayer.setVisible(true);
      lightGrayReferenceLayer.setVisible(true);
      break;
    case 'dark':
      darkGrayBaseLayer.setVisible(true);
      darkGrayReferenceLayer.setVisible(true);
      lightGrayBaseLayer.setVisible(false);
      lightGrayReferenceLayer.setVisible(false);
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
  if (currentStyle && info && info.style) {
    const validStyles = info.style.map((s) => s.Name);
    if (!validStyles.includes(currentStyle)) {
      layer.getSource().updateParams({ LAYERS: wmslayer, STYLES: '' });
    } else {
      layer.getSource().updateParams({ LAYERS: wmslayer });
    }
  } else if (currentStyle) {
    // No style info available for new layer, reset to default
    layer.getSource().updateParams({ LAYERS: wmslayer, STYLES: '' });
  } else {
    layer.getSource().updateParams({ LAYERS: wmslayer });
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
}

// Restore the user's previously selected sublayer for one category (e.g.
// 'radarLayer') after that category's WMS GetCapabilities has populated
// layerInfo. If the stored layer is no longer advertised by the server,
// drop it — the layer stays at its constructor-time default.
function restoreActiveLayer(category) {
  if (!category) return;
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
      guideLayer.getSource().clear(true);
    }
    if (feature && feature.getGeometry().getType() === 'Point') {
      featureOverlay.getSource().addFeature(feature);
      const coords = transform(feature.getGeometry().getCoordinates(), map.getView().getProjection(), 'EPSG:4326');
      [50000, 100000, 150000, 200000, 250000].forEach((range) => rangeRings(guideLayer, coords, range));
      Array.from({ length: 360 / options.radialSpacing }, (_, index) => index * options.radialSpacing)
        .forEach((bearing) => bearingLine(guideLayer, coords, 250, bearing));
      map.getView().fit(guideLayer.getSource().getExtent(), map.getSize());
    }
    highlight = feature;
  }
};

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
  // Visibility change may invalidate the current timeline window
  // (e.g. activating a stale satellite caps `end` to its old time.end,
  // or hiding it releases the cap). Recompute window + per-layer
  // in-range state immediately so the map time, stale colour and
  // layer opacity update without waiting for a tick or manual step.
  setTime('keep');
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

// Toggle wrapper for segment-originated actions (button taps + keyboard
// shortcuts). Announces the Finnish layer name via coachmark only when the
// toggle turned the layer on. Deliberately not used by the playlist eye icon
// or long-press variant selection so those paths stay quiet.
function toggleAndAnnounce(layer, segId, source) {
  toggleLayerVisibility(layer, source);
  if (layer.getVisible()) {
    const seg = document.getElementById(segId);
    if (seg && typeof showCoachmark === 'function') {
      showCoachmark(seg.getAttribute('data-name'));
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

document.getElementById('lightningLayerButton').addEventListener('mouseup', () => {
  toggleAndAnnounce(lightningLayer, 'lightningLayerButton', 'button');
});

document.getElementById('lightningLayerTitle').addEventListener('mouseup', () => {
  toggleLayerVisibility(lightningLayer, 'playlist');
});

// Long press menus for layer buttons
const observationMenu = createLongPressHandler(
  'observationLayerButton',
  'observationLongPressMenu',
  () => { toggleAndAnnounce(observationLayer, 'observationLayerButton', 'button'); },
  (id) => { updateLayer(observationLayer, id, { source: 'longpress' }); observationMenu.hide(); },
  () => observationLayer.getSource().getParams().LAYERS,
  () => observationLayer.getVisible(),
);

const satelliteMenu = createLongPressHandler(
  'satelliteLayerButton',
  'satelliteLongPressMenu',
  () => { toggleAndAnnounce(satelliteLayer, 'satelliteLayerButton', 'button'); },
  (id) => { updateLayer(satelliteLayer, id, { source: 'longpress' }); satelliteMenu.hide(); },
  () => satelliteLayer.getSource().getParams().LAYERS,
  () => satelliteLayer.getVisible(),
);

const radarMenu = createLongPressHandler(
  'radarLayerButton',
  'radarLongPressMenu',
  () => { toggleAndAnnounce(radarLayer, 'radarLayerButton', 'button'); },
  (id) => { updateLayer(radarLayer, id, { source: 'longpress' }); radarMenu.hide(); },
  () => radarLayer.getSource().getParams().LAYERS,
  () => radarLayer.getVisible(),
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
    entry.layerRef().setVisible(!!POI_STATE[entry.id]);
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
// so icon-only segments stay learnable.
const coachmarkEl = document.getElementById('coachmark');
let coachmarkTimer = null;
function showCoachmark(text) {
  if (!text) return;
  coachmarkEl.textContent = text;
  coachmarkEl.hidden = false;
  coachmarkEl.getBoundingClientRect();
  coachmarkEl.classList.add('show');
  if (coachmarkTimer) clearTimeout(coachmarkTimer);
  coachmarkTimer = setTimeout(() => {
    coachmarkEl.classList.remove('show');
    setTimeout(() => {
      if (!coachmarkEl.classList.contains('show')) coachmarkEl.hidden = true;
    }, 220);
  }, 1400);
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
  // debug(type)
  // debug(ollayer)
  const parent = document.getElementById('layers');
  document.querySelectorAll(`.${type}LayerSelect`).forEach((child) => {
    parent.removeChild(child);
  });
  Object.keys(layerInfo).sort().forEach((layer) => {
    if (layerInfo[layer].layer.includes(filter)) {
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
  const layer = wms.layer ? `&layer=${wms.layer}` : '';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => { controller.abort(); }, 30000);
  debug(`Request WMS Capabilities ${wms.url}`);

  fetch(`${wms.url}?SERVICE=WMS&version=1.3.0&request=GetCapabilities${namespace}${layer}`, {
    signal: controller.signal,
  }).then((response) => response.text()).then((text) => {
    clearTimeout(timeoutId);
    debug(`Received WMS Capabilities ${wms.url}`);
    failCount = 0;
    const result = parser.read(text);
    if (result && result.Capability && result.Capability.Layer && result.Capability.Layer.Layer) {
      getLayers(result.Capability.Layer.Layer, wms);
      debug(layerInfo);
      satelliteLayer.set('info', layerInfo[satelliteLayer.getSource().getParams().LAYERS]);
      radarLayer.set('info', layerInfo[radarLayer.getSource().getParams().LAYERS]);
      lightningLayer.set('info', layerInfo[lightningLayer.getSource().getParams().LAYERS]);
      observationLayer.set('info', layerInfo[observationLayer.getSource().getParams().LAYERS]);
      switch (wms.category) {
        case 'satelliteLayer':
          updateLayerSelection(satelliteLayer, 'satellite', 'msg_');
          break;
        case 'observationLayer':
          updateLayerSelection(observationLayer, 'observation', 'observation:');
          break;
        case 'radarLayer':
          updateLayerSelection(radarLayer, 'radar', 'suomi_');
          break;
        case 'lightningLayer':
          updateLayerSelection(lightningLayer, 'lightning', 'lightning');
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

function getLayers(parentlayer, wms) {
  const products = {};
  parentlayer.forEach((layer) => {
    if (Array.isArray(layer.Layer)) {
      getLayers(layer.Layer, wms);
    } else {
      let name = layer.Name;
      // FMI GeoServer returns unprefixed names; meteo.fi returns prefixed.
      // Add namespace prefix only when it's not already present.
      if (wms.namespace && name.indexOf(`${wms.namespace}:`) !== 0) {
        name = `${wms.namespace}:${name}`;
      }
      layerInfo[name] = getLayerInfo(layer, wms);
      layerInfo[name].layer = name;
    }
  });
  return products;
}

function getLayerInfo(layer, wms) {
  const product = {
    category: wms.category,
    url: wms.url,
    layer: layer.Name,
  };

  if (typeof layer.CRS !== 'undefined') {
    [product.crs] = layer.CRS;
  } else {
    product.crs = 'EPSG:4326';
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

  Object.values(options.wmsServerConfiguration).forEach((value) => {
    if (!value.disabled) {
      getWMSCapabilities(value);
    }
  });

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

  tools = initTools({
    map,
    getOwnPosition: () => ownPosition4326,
    getFrameTimestamp: () => (startDate ? startDate.getTime() : Date.now()),
  });

  const measureToolBtn = document.getElementById('measureTool');
  if (measureToolBtn) {
    measureToolBtn.addEventListener('click', () => {
      closeOverflowMenu();
      tools.arm();
    });
  }

  const measureFabBtn = document.getElementById('measureFab');
  if (measureFabBtn) {
    measureFabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (tools.isArmed()) tools.disarm();
      else tools.arm();
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

    if (pin && hit === pin) {
      // Tap on our own marker pin — toggle its readout card.
      tools.toggleCard();
      return;
    }

    if (hit) {
      // Airfield / radar site etc. — keep existing feature-info behaviour.
      displayFeatureInfo(evt.pixel);
      return;
    }

    // Empty map — clear any highlighted feature, then drop/move the marker.
    displayFeatureInfo(evt.pixel);
    if (tools) tools.dropOrMove(evt.coordinate);
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
