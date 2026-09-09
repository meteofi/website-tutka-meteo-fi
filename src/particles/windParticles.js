// Tuuli / Sateen liike — Windy-style flowing particles driven by a lon/lat
// grid of east/north m/s components, from one of two sources through one
// layer (issue #256):
//   - MODEL WIND: ECMWF IFS 10 m wind through the MeteoCore EDR area query
//     (a CoverageJSON Grid). Only this source may be called wind.
//   - RADAR MOTION: the nowcast engine's per-generation precipitation motion
//     field, served as motion_u / motion_v / motion_quality on the nowcast
//     collection (meteocore#661, same Grid shape). Echo motion is steering
//     flow plus propagation, not surface wind, so it is "sateen liike" in the
//     UI and nowhere near the word tuuli.
// The two are exclusive POI rows in radar.js; the controller just switches
// its source spec (setSource) and refetches.
//
// Shape of the thing:
//   - one controller, one WebGL2 context (src/particles/particleGl.js), one
//     field texture; a per-pane ol/layer/Image over an ImageCanvas source whose
//     canvas the controller repaints from the shared context. Panes share a
//     view, so they share a field and differ only in canvas size;
//   - a requestAnimationFrame loop that marks every visible pane's source
//     changed, which makes OpenLayers call the canvasFunction — where the
//     simulation actually steps. The loop runs while the layer is on, playing
//     or paused: the flow is the point, not the frame;
//   - one field per (view box, time). The box is the viewport plus a pan
//     margin quantized to the shared 0.5° grid (src/edr/areaQuery.js), so
//     panning away and back reuses a URL the browser cached. The time is the
//     animation window's NEWEST frame: for a model it is snapped to the
//     advertised step nearest that frame (verbatim from the collection
//     metadata), so it changes once per model step rather than flipping
//     mid-loop as the cursor crosses a step boundary; for the radar it is the
//     frame time itself, because the nowcast area query returns the newest
//     generation at or before the requested time (meteocore#662) and a new
//     URL every 5 min is exactly the frame pool's own refetch cadence. Field
//     requests are one abortable slot (seriesFetch.js): a pan during a fetch
//     cancels it. The last good field stays on screen while the next loads.
//
// Coordinates, colour and the shaders are documented in particleGl.js; the
// wire format and its pitfalls in windField.js.

import ImageLayer from 'ol/layer/Image';
import ImageCanvasSource from 'ol/source/ImageCanvas';
import { transformExtent } from 'ol/proj';
import { FRAME_STEPS } from '../constants';
import { quantizedAreaBounds, isoSeconds } from '../edr/areaQuery';
import { createFetchSlot } from '../edr/seriesFetch';
import {
  buildGridUrl, parseTemporalValues, pickFieldTime, parseGridCoverage, encodeField,
} from './windField';
import ParticleRenderer from './particleGl';

const EDR = 'https://meteocore.app.meteo.fi/edr/collections';

// The model sources known to render through this layer. ECMWF is the
// product; GFS stays as a diagnostic reachable with `?wind=gfs` in the URL
// (the `?interp=` precedent) because the two answer the same Grid shape from
// different engines, which is how a renderer bug and a server outage were
// told apart the day the ecmwf-ifs area query answered 502 on everything.
// The menu label reads from here, so it can never drift from the source.
const MODEL_SOURCES = {
  ecmwf: {
    id: 'ecmwf',
    kind: 'model',
    collection: 'ecmwf-ifs',
    u: '10u',
    v: '10v',
    label: 'Tuuli 10 m (ECMWF)',
    attribution: 'Tuuli © ECMWF (CC BY 4.0)',
  },
  gfs: {
    id: 'gfs',
    kind: 'model',
    collection: 'noaa-gfs',
    u: 'UGRD',
    v: 'VGRD',
    label: 'Tuuli 10 m (GFS)',
    attribution: 'Tuuli © NOAA GFS',
  },
};

// The radar source: the nowcast engine's block motion field (~16 km blocks,
// outlier-rejected, filled, smoothed, EMA-blended across generations). The
// collection id is the production one (the storm-cell layer reads the same
// collection's features). Contract, from meteocore#662: area query → Grid
// [t, y, x] with one t (the generation anchor); motion in m/s east/north;
// motion_quality 1 where the block was matched, 0 where it was filled from
// its neighbours (drawn fainter — the shader's alpha); `datetime` picks the
// newest generation at or before the given time, a time before every kept
// generation is a 404. Needs `edr` in the collection's `apis` server-side —
// until the production config has it the collection is not on /edr at all
// and every request 404s (poisoned per URL, one try per frame slide).
const RADAR_SOURCE = {
  id: 'radar',
  kind: 'radar',
  collection: 'fmi-radar-nowcast',
  u: 'motion_u',
  v: 'motion_v',
  quality: 'motion_quality',
  label: 'Sateen liike (tutka)',
  attribution: 'Sateen liike © FMI (CC BY 4.0)',
};

// Both models are global; the box is clamped only by the area budget. At the
// models' 0.25° spacing 1 200 deg² is 19 200 points × 2 components — about
// 70 kB gzipped, the most a zoomed-out view is allowed to cost. Finland at z5
// is ~380 deg² with the margin.
const WORLD_BBOX = [-180, -90, 180, 90];
const MAX_AREA_DEG2 = 1200;

// Metadata (the advertised time steps) refreshes on this timer while the layer
// is on — a new model run appears four times a day.
const METADATA_REFRESH_MS = 30 * 60 * 1000;
// A failed request (5xx, network) is retried after this; 4xx is poisoned.
const RETRY_MS = 60 * 1000;
// Fetch after the view has stopped moving for this long (the moveend idea,
// read off the canvasFunction's extent so no map wiring is needed).
const VIEW_SETTLE_MS = 300;
// Fields kept decoded in memory so a pan back or a step flip is instant.
const FIELD_CACHE_SIZE = 4;

// Simulation size: the particle canvas is rendered at a capped pixel ratio and
// upscaled in the 2D copy. Trails are soft lines and survive the upscale; the
// fade pass over a DPR-3 phone screen at full size would not survive the
// battery. The area cap bounds the desktop retina case.
const MAX_SIM_RATIO = 1.5;
const MAX_SIM_PX = 2e6;
const PARTICLES_PER_MPX = 1500;
const MIN_PARTICLES = 1024;
const MAX_PARTICLES = 16384;
// A pane that has not asked for a frame in this long is off-screen (layout
// shrank) — free its textures.
const IDLE_RELEASE_MS = 5000;

// Particle colour per theme, premultiplied by the renderer. White over the
// dark basemap (the windy look); ink over the light one, where white vanishes.
// Alpha is kept low on purpose: the radar underneath is the product, the wind
// is context over it.
const COLORS = {
  dark: [1, 1, 1, 0.45],
  light: [0.1, 0.15, 0.25, 0.55],
};

// `?wind=ecmwf|gfs` chooses the model behind the Tuuli row; `?wind=radar`
// forces the radar source whichever row is on. Diagnostics only.
function readSourceOverride() {
  try {
    return new URLSearchParams(window.location.search).get('wind');
  } catch (e) {
    return null;
  }
}

export default function initWindParticles() {
  const override = readSourceOverride();
  const modelSource = MODEL_SOURCES[override] || MODEL_SOURCES.ecmwf;
  const forceRadar = override === 'radar';
  let source = forceRadar ? RADAR_SOURCE : modelSource;
  let areaEndpoint = `${EDR}/${source.collection}/area`;
  let metadataUrl = `${EDR}/${source.collection}`;

  let enabled = false;
  let theme = 'dark';
  let renderer = null;
  let rebuilds = 0;
  let rafId = null;
  const entries = [];

  // Fetch state.
  let steps = [];
  let targetMs = NaN;
  let pendingView = null;
  let settleTimer = null;
  let retryTimer = null;
  let metadataTimer = null;
  let currentUrl = null;
  const fieldCache = new Map();
  const poisoned = new Set();
  const fieldSlot = createFetchSlot();
  const metadataSlot = createFetchSlot();

  // Returned from the canvasFunction when there is nothing to draw. Returning
  // null would make ol/source/ImageCanvas keep its last canvas (the FramePool
  // lesson), so an empty one is handed back instead.
  const emptyCanvas = document.createElement('canvas');
  emptyCanvas.width = 1;
  emptyCanvas.height = 1;

  function warn(msg) {
    console.warn(`Tuuli: ${msg}`); // eslint-disable-line no-console
  }

  //
  // RENDERER LIFECYCLE
  //
  function createRenderer() {
    try {
      renderer = new ParticleRenderer();
    } catch (err) {
      renderer = null;
      warn(`renderer unavailable: ${err.message}`);
      return;
    }
    renderer.setColor(COLORS[theme]);
    const field = currentUrl ? fieldCache.get(currentUrl) : null;
    if (field) renderer.setField(field);
  }

  function disposeRenderer() {
    if (renderer) renderer.dispose();
    renderer = null;
  }

  //
  // FIELD FETCHING
  //
  function rememberField(url, field) {
    fieldCache.delete(url);
    fieldCache.set(url, field);
    while (fieldCache.size > FIELD_CACHE_SIZE) {
      fieldCache.delete(fieldCache.keys().next().value);
    }
  }

  function applyField(url) {
    currentUrl = url;
    if (renderer) renderer.setField(fieldCache.get(url));
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      planFetch();
    }, RETRY_MS);
  }

  async function fetchField(url) {
    const result = await fieldSlot.run(async (signal) => {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        const err = new Error(`HTTP ${response.status}`);
        err.status = response.status;
        throw err;
      }
      const json = await response.json();
      const parsed = parseGridCoverage(json, source.u, source.v, source.quality || null);
      if (!parsed) throw new Error('unreadable grid');
      return { ...parsed, ...encodeField(parsed) };
    });
    if (result === undefined) return;
    if (!result.ok) {
      const { status } = result.error;
      if (status >= 400 && status < 500) {
        // A request the server rejects is never retried verbatim — the
        // EDR-client rule everywhere in this app.
        poisoned.add(url);
        warn(`${url} rejected (${status}), not retrying`);
      } else {
        warn(`field fetch failed (${result.error.message}), retrying in ${RETRY_MS / 1000} s`);
        scheduleRetry();
      }
      return;
    }
    rememberField(url, result.data);
    if (enabled) applyField(url);
  }

  // The single funnel: whatever changed (view settled, cursor moved to a new
  // model step, metadata arrived, retry timer), decide which field the layer
  // should be showing and fetch it if it is not the one on screen.
  // The datetime for the field: a model's advertised step nearest the window's
  // newest frame, or for the radar that frame's own time (see the header).
  function timeFor() {
    if (!Number.isFinite(targetMs)) return null;
    if (source.kind === 'radar') return isoSeconds(targetMs);
    const step = pickFieldTime(steps, targetMs);
    return step ? step.iso : null;
  }

  function planFetch() {
    if (!enabled || !renderer || !pendingView) return;
    const bounds = quantizedAreaBounds(pendingView, { coverageBbox: WORLD_BBOX, maxAreaDeg2: MAX_AREA_DEG2 });
    const time = timeFor();
    if (!bounds || !time) return;
    const params = source.quality ? [source.u, source.v, source.quality] : [source.u, source.v];
    const url = buildGridUrl(areaEndpoint, bounds, params, time);
    if (url === currentUrl) {
      fieldSlot.abort();
      return;
    }
    if (fieldCache.has(url)) {
      fieldSlot.abort();
      applyField(url);
      return;
    }
    if (poisoned.has(url)) return;
    fetchField(url);
  }

  async function loadMetadata() {
    const result = await metadataSlot.run(async (signal) => {
      // No `f=` here: the collection document takes none (crossSection.js).
      const response = await fetch(metadataUrl, { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseTemporalValues(await response.json());
    });
    if (result === undefined || !enabled) return;
    if (!result.ok || result.data.length === 0) {
      warn(`metadata unavailable (${result.ok ? 'no time steps' : result.error.message}), retrying`);
      scheduleRetry();
      return;
    }
    steps = result.data;
    planFetch();
  }

  // Called from the canvasFunction with the extent the pane is drawing.
  // Debounced: a pan streams a new extent every frame, and the fetch belongs
  // after the last one.
  function noteView(extent) {
    const view = transformExtent(extent, 'EPSG:3857', 'EPSG:4326');
    const same = pendingView && view.every((v, i) => Math.abs(v - pendingView[i]) < 1e-3);
    if (same) return;
    pendingView = view;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      planFetch();
    }, VIEW_SETTLE_MS);
  }

  //
  // DRAWING
  //
  function simPixelRatio(cssW, cssH, pixelRatio) {
    const byArea = Math.sqrt(MAX_SIM_PX / Math.max(1, cssW * cssH));
    return Math.max(0.5, Math.min(pixelRatio, MAX_SIM_RATIO, byArea));
  }

  // ol/source/ImageCanvas contract: `size` is the canvas size in device
  // pixels for `extent` at `resolution`; with ratio 1 the extent is exactly
  // the pane's view. Steps this pane's particles and paints the result.
  function draw(entry, extent, resolution, pixelRatio, size) {
    if (!enabled || !renderer || renderer.contextLost) return emptyCanvas;
    const w = Math.round(size[0]);
    const h = Math.round(size[1]);
    if (w < 1 || h < 1) return emptyCanvas;
    noteView(extent);
    if (entry.canvas.width !== w || entry.canvas.height !== h) {
      entry.canvas.width = w;
      entry.canvas.height = h;
    }
    const now = performance.now();
    entry.lastRenderMs = now;
    entry.ctx.clearRect(0, 0, w, h);
    if (!renderer.hasField()) return entry.canvas;

    const cssW = w / pixelRatio;
    const cssH = h / pixelRatio;
    const ratio = simPixelRatio(cssW, cssH, pixelRatio);
    const simW = Math.max(1, Math.round(cssW * ratio));
    const simH = Math.max(1, Math.round(cssH * ratio));
    const count = Math.round(Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, (simW * simH * PARTICLES_PER_MPX) / 1e6)));
    renderer.stateFor(entry.index, simW, simH, count);
    // A moved view: positions are canvas fractions and stay put, but the
    // trails drawn for the old extent would smear across the jump.
    const moved = !entry.extent || entry.extent.some((v, i) => v !== extent[i]);
    if (moved) {
      renderer.clearTrails(entry.index);
      entry.extent = extent.slice();
    }
    if (renderer.render(entry.index, extent, ratio, now)) {
      entry.ctx.drawImage(renderer.canvas, 0, 0, w, h);
    }
    return entry.canvas;
  }

  //
  // FRAME LOOP
  //
  function tick() {
    rafId = null;
    if (!enabled) return;
    if (renderer && renderer.contextLost) {
      // iOS evicts contexts under memory pressure. One rebuild is cheap; a
      // second loss in the same session means the device has no room for
      // this, and the layer goes quiet rather than fighting the browser.
      disposeRenderer();
      if (rebuilds < 1) {
        rebuilds += 1;
        createRenderer();
      }
    }
    const now = performance.now();
    for (const entry of entries) {
      if (entry.layer.getVisible()) entry.source.changed();
      if (renderer && renderer.hasState(entry.index) && now - entry.lastRenderMs > IDLE_RELEASE_MS) {
        renderer.releaseState(entry.index);
        entry.extent = null;
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  // Everything a source needs running: the radar needs no metadata (its
  // datetime is the frame time), a model needs the advertised steps first.
  function startSource() {
    if (source.kind === 'radar') {
      planFetch();
      return;
    }
    loadMetadata();
    metadataTimer = setInterval(loadMetadata, METADATA_REFRESH_MS);
  }

  function stopFetching() {
    fieldSlot.abort();
    metadataSlot.abort();
    clearInterval(metadataTimer);
    metadataTimer = null;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  //
  // PUBLIC API
  //
  return {
    // Menu labels per row, read from the source tables so they cannot drift.
    modelLabel: modelSource.label,
    radarLabel: RADAR_SOURCE.label,
    // The credit for whichever source is drawing right now.
    get attribution() { return source.attribution; },

    // Pane factory for paneDeps. Starts hidden; the POI toggle fans visibility
    // out per pane and setEnabled gates everything that costs.
    createPaneLayer(index) {
      const canvas = document.createElement('canvas');
      const entry = {
        index,
        canvas,
        ctx: canvas.getContext('2d'),
        extent: null,
        lastRenderMs: 0,
        source: null,
        layer: null,
      };
      entry.source = new ImageCanvasSource({
        canvasFunction: (extent, resolution, pixelRatio, size) => draw(entry, extent, resolution, pixelRatio, size),
        ratio: 1,
        attributions: source.attribution,
      });
      entry.layer = new ImageLayer({
        name: 'windLayer',
        visible: false,
        source: entry.source,
      });
      entries.push(entry);
      return entry.layer;
    },

    // Called from the POI toggle. On: build the GL context, start the loop,
    // fetch metadata then the field. Off: tear all of it down — the context
    // is only borrowed while the layer is on.
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (on) {
        rebuilds = 0;
        createRenderer();
        startLoop();
        startSource();
        return;
      }
      stopLoop();
      stopFetching();
      disposeRenderer();
      for (const entry of entries) entry.extent = null;
      // Keep currentUrl and the cache: switching the layer back on inside the
      // same step and view shows the field again without a request.
    },

    // 'model' | 'radar' — which of the two exclusive POI rows is on. Called
    // before setEnabled from applyPoiVisibility, so a switch while on drops the
    // old field at once (a wind field must not keep flowing under the radar
    // label while the motion field loads) and refetches; the settled view is
    // still known, so no pan is needed to trigger it.
    setSource(kind) {
      const next = forceRadar || kind === 'radar' ? RADAR_SOURCE : modelSource;
      if (next === source) return;
      source = next;
      areaEndpoint = `${EDR}/${source.collection}/area`;
      metadataUrl = `${EDR}/${source.collection}`;
      steps = [];
      currentUrl = null;
      if (enabled) {
        stopFetching();
        if (renderer) renderer.clearField();
        startSource();
      }
    },

    // Routed from setTime (radar.js) on every clock move — the probe /
    // stormCells signature. The field follows the window's newest frame.
    setCursor(timeMs, windowStartMs, stepMs) {
      const next = windowStartMs + FRAME_STEPS * stepMs;
      if (next === targetMs) return;
      targetMs = next;
      planFetch();
    },

    // 'light' | 'dark', from setMapLayer.
    setTheme(next) {
      if (!COLORS[next]) return;
      theme = next;
      if (renderer) renderer.setColor(COLORS[theme]);
    },
  };
}
