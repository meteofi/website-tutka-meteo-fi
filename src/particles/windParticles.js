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
//     field texture; a per-pane OVERLAY CANVAS over the pane's OpenLayers
//     viewport (a `canvas.ol-layer` sibling of `.ol-layers`, so share.js
//     composites it like any layer canvas), repainted from the shared context.
//     Panes share a view, so they share a field and differ only in canvas
//     size;
//   - a requestAnimationFrame loop of its own that steps and repaints every
//     visible pane's canvas, reading the view extent straight off the map.
//     Particles are ANCHORED to the map: the overlay is drawn for the view as
//     it was when the move began and, while the view moves, carries the same
//     translate/scale OL puts on its own layer canvases (an OL drag is a CSS
//     transform between renders, so this is what "moving with the map" is);
//     when the move ends the trails re-anchor to the new view. The frame is
//     handed over as an ImageBitmap where the browser can (particleGl.js
//     ZERO_COPY) and the overlay is CSS-scaled from the simulation size, so
//     no full-screen copy or upscale pass runs per frame.
//     OpenLayers is NOT re-rendered per frame: the first version went through
//     an ImageCanvas source and marked it changed every frame, which made OL
//     redraw the whole map at 60 Hz — with the radar on that is a 16 Mpx
//     image blit per frame on a 4K canvas, the frame rate collapsed, the
//     simulation took 3× steps to keep pace and every tail smeared. Now the
//     map renders only when it has a reason to, and the particles run at the
//     display's rate whatever else is on. The loop runs while the layer is
//     on, playing or paused: the flow is the point, not the frame. The
//     overlay sits above every OL layer (labels included) and below OL
//     overlays; the sprites are small and mostly transparent, so a label
//     under a passing particle stays readable;
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

import { transformExtent } from 'ol/proj';
import { FRAME_STEPS } from '../constants';
import { quantizedAreaBounds } from '../edr/areaQuery';
import { createFetchSlot } from '../edr/seriesFetch';
import {
  buildGridUrl, timeRangeIso, parseTemporalValues, pickFieldTime, parseGridCoverage, encodeField,
} from './windField';
import ParticleRenderer, { ZERO_COPY } from './particleGl';

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
// collection's features). Contract as measured live on 2026-09-11:
//   - area query → Grid [t, y, x] with one t (the generation anchor), 78 × 115
//     cells over the composite's whole raster rectangle, 0.47° × 0.118°, no
//     nulls: every cell is either block-matched (motion_quality 1 — 317 of
//     8 970 that day) or filled from its neighbours (0). The fill is honest
//     motion for advection but says nothing about where there is rain, which
//     is why particles are dimmed on filled blocks AND confined to the
//     radars' coverage discs (radar.js supplies them; particleGl.js masks);
//   - `datetime` MUST be an interval — the server answers with the newest
//     generation anchored inside it, and reads an instant as the empty
//     interval t/t (404 "no nowcast generation anchored inside"). The
//     animation window is the interval sent: its newest frame is the time the
//     particles are meant to describe, and a generation anchored at or just
//     before it is always inside the hour. The URL then slides with the frame
//     pool's cadence, and the browser cache (max-age 60) covers the rest;
//   - a polygon outside the collection's bbox is a 400, so the request box is
//     the domain itself — 19 kB gzipped for the whole thing, one URL per
//     window instead of one per pan;
//   - the whole rectangle is bigger than the radars see (corners over the
//     Norwegian Sea and Russia); see the coverage mask.
const RADAR_SOURCE = {
  id: 'radar',
  kind: 'radar',
  collection: 'fmi-radar-nowcast',
  u: 'motion_u',
  v: 'motion_v',
  quality: 'motion_quality',
  // The collection's advertised bbox ([6.68, 55.93, 43.12, 72.86]) snapped
  // outward to the shared 0.5° grid.
  bbox: [6.5, 55.5, 43.5, 73],
  label: 'Sateen liike (tutka)',
  attribution: 'Sateen liike © FMI (CC BY 4.0)',
};

// Both models are global; the box is clamped only by the area budget. The
// budget must hold the VIEW, not just a comfortable margin: quantizedAreaBounds
// shrinks an over-budget box around the view centre, and a box smaller than
// the view leaves its edges without a field — particles simply do not exist
// there, and a small pan does not move the quantized box, so the gap stays
// "until panned a lot". 1 200 deg² did exactly that from z4 out (a Nordic
// view is ~2 400 deg² with the margin). At the models' 0.25° spacing 4 000
// deg² is 64 000 points × 2 components, ~2.4 MB raw / ~250 kB gzipped, and
// the ECMWF engine answers a 3 600 deg² box in 1.5 s — affordable for the
// rare continent-scale view, and still inside the server's 500k-value limit.
// Only a world-scale view (z ≤ 3) is left partially covered.
const WORLD_BBOX = [-180, -90, 180, 90];
const MAX_AREA_DEG2 = 4000;

// Metadata (the advertised time steps) refreshes on this timer while the layer
// is on — a new model run appears four times a day.
const METADATA_REFRESH_MS = 30 * 60 * 1000;
// A failed request (5xx, network) is retried after this; 4xx is poisoned.
// Short, because the layer has nothing else to show while it waits and the
// ECMWF engine does hiccup (502s for whole days have happened).
const RETRY_MS = 15 * 1000;
// Fetch after the view has stopped moving for this long (the moveend idea,
// read off the canvasFunction's extent so no map wiring is needed).
const VIEW_SETTLE_MS = 300;
// Fields kept decoded in memory so a pan back or a step flip is instant.
const FIELD_CACHE_SIZE = 4;

// Simulation size: the particle canvas is rendered at a capped pixel ratio and
// upscaled in the 2D copy. Trails are soft lines and survive the upscale; the
// fade pass over a DPR-3 phone screen at full size would not survive the
// battery. The area cap bounds the desktop retina case (a 2× laptop lands
// near ratio 1.2 from the cap alone); the ratio cap is what a phone hits —
// at 2 a DPR-3 iPhone simulates 780 × 1690, 1.3 Mpx, and a point is still
// crisp after the 1.5× copy, where at 1.5 it blurred into a faint smudge.
const MAX_SIM_RATIO = 2;
// 4 Mpx: a 4K monitor at DPR 1 (8.3 M CSS px) simulates at ratio 0.7 rather
// than the 0.5 a 2 Mpx budget forced, which blurred every sprite into a
// smudge on exactly the screens with the smallest pixels. Phones never get
// near it — the ratio cap holds them at ~1.3 Mpx.
const MAX_SIM_PX = 4e6;
// Particles per million CSS pixels of VIEWPORT — not of simulation pixels,
// which made a 4K viewport (simulated small) six times sparser than a laptop.
const PARTICLES_PER_MPX = 3000;
// Bigger viewports get bigger sprites: nothing reports physical pixel size,
// but a viewport far wider than a laptop's is a big monitor whose pixels are
// smaller and which is read from farther away, and a sprite sized in CSS px
// alone was "so thin that even the strong wind areas are hard to see" on one.
// Scale with the square root of the area ratio to a 1440 × 900 laptop, capped.
const LAPTOP_CSS_PX = 1440 * 900;
const MAX_SCREEN_POINT_SCALE = 1.8;
// Phones get larger, brighter particles: a 1 px line at arm's length on a
// bright screen outdoors is the thing users called "very small and not very
// visible", while the same line on a desktop is the calm look asked for. A
// coarse pointer on a small viewport is the phone test; a tablet keeps the
// desktop look.
const PHONE_POINT_SCALE = 1.3;
const PHONE_ALPHA_SCALE = 1.2;
const PHONE_MAX_CSS_PX = 600;
const MIN_PARTICLES = 1024;
const MAX_PARTICLES = 32768;
// A pane that has not asked for a frame in this long is off-screen (layout
// shrank) — free its textures.
const IDLE_RELEASE_MS = 5000;

// Particle colours per theme, premultiplied by the renderer: a core and the
// opposite-tone halo around it (particleGl.js DRAW_FS). White over the dark
// basemap (the windy look); ink over the light one, where white vanishes. The
// halo is what keeps the core readable over a satellite cloud or light-theme
// water; it stays faint so the pair never reads as an outlined dot. Alpha is
// moderate on purpose: the radar underneath is the product.
const COLORS = {
  dark: { core: [1, 1, 1, 0.8], halo: [0, 0, 0, 0.3] },
  light: { core: [0.1, 0.15, 0.25, 0.8], halo: [1, 1, 1, 0.35] },
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

//   radarCoverage — () => [{ x, y, radius }] in EPSG:3857 units, the discs
//     the composite's radars actually see; read whenever a radar field is
//     applied, so a site list that loads after the layer is switched on is
//     picked up on the next field. [] (or absent) draws the whole field.
export default function initWindParticles({ radarCoverage = () => [] } = {}) {
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
  let windowStartMs = NaN;
  let pendingView = null;
  let settleTimer = null;
  let retryTimer = null;
  let metadataTimer = null;
  let currentUrl = null;
  const fieldCache = new Map();
  const poisoned = new Set();
  const fieldSlot = createFetchSlot();
  const metadataSlot = createFetchSlot();

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
    renderer.setColor(COLORS[theme].core, COLORS[theme].halo);
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
    if (!renderer) return;
    renderer.setField(fieldCache.get(url));
    renderer.setMask(source.kind === 'radar' ? radarCoverage() : []);
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
  // newest frame, or for the radar the window itself as an interval (see the
  // RADAR_SOURCE notes).
  function timeFor() {
    if (!Number.isFinite(targetMs)) return null;
    if (source.kind === 'radar') return timeRangeIso(windowStartMs, targetMs);
    const step = pickFieldTime(steps, targetMs);
    return step ? step.iso : null;
  }

  // The polygon: the buffered, quantized view for a model; the whole domain
  // for the radar (one URL per window, and a box outside the domain is a
  // 400), but only while the view touches it — nothing is fetched for a view
  // over central Europe.
  function boundsFor() {
    if (source.kind !== 'radar') {
      return quantizedAreaBounds(pendingView, { coverageBbox: WORLD_BBOX, maxAreaDeg2: MAX_AREA_DEG2 });
    }
    const touches = quantizedAreaBounds(pendingView, { coverageBbox: source.bbox, maxAreaDeg2: Infinity });
    return touches ? source.bbox : null;
  }

  function planFetch() {
    if (!enabled || !renderer || !pendingView) return;
    // A model with no steps yet needs its metadata before any field can be
    // named — including after a failed metadata load, whose retry lands
    // here through scheduleRetry. Without this a transient metadata failure
    // left the layer empty until the 30-minute refresh.
    if (source.kind !== 'radar' && steps.length === 0) {
      if (!metadataSlot.isBusy()) loadMetadata();
      return;
    }
    const bounds = boundsFor();
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

  // Called from the frame loop with the extent the pane is drawing.
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
  const coarsePointer = typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
  const isPhone = (cssW, cssH) => coarsePointer && Math.min(cssW, cssH) <= PHONE_MAX_CSS_PX;

  function simPixelRatio(cssW, cssH, pixelRatio) {
    const byArea = Math.sqrt(MAX_SIM_PX / Math.max(1, cssW * cssH));
    return Math.max(0.5, Math.min(pixelRatio, MAX_SIM_RATIO, byArea));
  }

  // Blank a pane's overlay (nothing to show, or hidden).
  function blank(entry) {
    if (entry.canvas.width === 1 && entry.canvas.height === 1) return;
    if (ZERO_COPY) {
      entry.ctx.transferFromImageBitmap(null);
    }
    entry.canvas.width = 1;
    entry.canvas.height = 1;
  }

  // One frame for one pane: `extent` is the ANCHORED view extent (EPSG:3857)
  // the overlay is drawn for, `cssW`/`cssH` its size in CSS px. Steps the
  // pane's particles and hands the frame to the overlay.
  function draw(entry, extent, cssW, cssH, pixelRatio) {
    if (cssW < 1 || cssH < 1) return;
    const now = performance.now();
    entry.lastRenderMs = now;
    if (!renderer.hasField()) {
      blank(entry);
      return;
    }

    const ratio = simPixelRatio(cssW, cssH, pixelRatio);
    const simW = Math.max(1, Math.round(cssW * ratio));
    const simH = Math.max(1, Math.round(cssH * ratio));
    const cssArea = cssW * cssH;
    const count = Math.round(Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, (cssArea * PARTICLES_PER_MPX) / 1e6)));
    renderer.stateFor(entry.index, simW, simH, count);
    // A moved view: positions are canvas fractions and stay put, but the
    // trails drawn for the old extent would smear across the jump.
    const moved = !entry.extent || entry.extent.some((v, i) => v !== extent[i]);
    if (moved) {
      renderer.clearTrails(entry.index);
      entry.extent = extent.slice();
    }
    const phone = isPhone(cssW, cssH);
    const screenScale = Math.min(MAX_SCREEN_POINT_SCALE, Math.max(1, Math.sqrt(cssArea / LAPTOP_CSS_PX)));
    const look = phone
      ? { pointScale: PHONE_POINT_SCALE, alphaScale: PHONE_ALPHA_SCALE }
      : { pointScale: screenScale, alphaScale: 1 };
    if (renderer.render(entry.index, extent, ratio, now, look)) {
      renderer.present(entry.ctx);
    } else {
      blank(entry);
    }
  }

  // The view as the overlay is drawn for it. Re-anchored when a move ends
  // (moveend clears it) or the pane changes size; in between, the overlay
  // is transformed to follow the live view exactly as OL transforms its
  // layer canvases during a drag or an animated zoom.
  function anchorFor(entry, size) {
    const view = entry.map.getView();
    const center = view.getCenter();
    const resolution = view.getResolution();
    const a = entry.anchor;
    if (a && a.size[0] === size[0] && a.size[1] === size[1]) {
      const scale = a.resolution / resolution;
      const dx = (a.center[0] - center[0]) / resolution;
      const dy = (center[1] - a.center[1]) / resolution;
      const moving = Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01 || Math.abs(scale - 1) > 1e-6;
      const transform = moving ? `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) scale(${scale.toFixed(6)})` : '';
      if (entry.canvas.style.transform !== transform) entry.canvas.style.transform = transform;
      return a;
    }
    entry.anchor = {
      center: center.slice(), resolution, size: size.slice(), extent: view.calculateExtent(size),
    };
    // A fresh anchor means fresh trails: the old ones belong to another view.
    entry.extent = null;
    if (entry.canvas.style.transform) entry.canvas.style.transform = '';
    return entry.anchor;
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
      // An attached, visible pane with a real size (inactive split panes
      // are display:none and report no size) gets a frame.
      const size = entry.map && entry.visible && renderer && !renderer.contextLost ? entry.map.getSize() : null;
      if (size && size[0] > 0 && size[1] > 0) {
        // Fetching follows the live view; drawing follows the anchor.
        noteView(entry.map.getView().calculateExtent(size));
        const anchor = anchorFor(entry, size);
        draw(entry, anchor.extent, anchor.size[0], anchor.size[1], window.devicePixelRatio || 1);
      } else {
        // Hidden or detached: blank the canvas once so nothing stale shows
        // when it comes back, and let its GPU state go below.
        blank(entry);
        entry.anchor = null;
      }
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

    // Pane factory for paneDeps: the pane's overlay canvas, wrapped in the
    // two methods the POI fan-out uses on a layer. Not an OL layer and not in
    // the pane's layer stack — attachPane puts it into the viewport once the
    // map exists. Starts hidden; the POI toggle fans visibility out per pane
    // and setEnabled gates everything that costs.
    createPaneLayer(index) {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      // `ol-layer` so share.js composites it (it scales a transform-less
      // canvas by the viewport rect, which is exactly this canvas's mapping).
      canvas.className = 'ol-layer wind-canvas';
      Object.assign(canvas.style, {
        position: 'absolute',
        top: '0',
        left: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: '0',
      });
      canvas.hidden = true;
      const entry = {
        index,
        canvas,
        ctx: canvas.getContext(ZERO_COPY ? 'bitmaprenderer' : '2d'),
        map: null,
        visible: false,
        anchor: null,
        extent: null,
        lastRenderMs: 0,
      };
      entries.push(entry);
      return {
        setVisible(on) {
          entry.visible = !!on;
          canvas.hidden = !on;
        },
        getVisible: () => entry.visible,
      };
    },

    // Called once the pane's map exists (radar.js initPaneTraffic): the
    // canvas goes into the OL viewport after the layers container and before
    // the overlay containers, so it draws over every layer and under popups.
    attachPane(map, index) {
      const entry = entries.find((e) => e.index === index);
      if (!entry || entry.map) return;
      entry.map = map;
      const viewport = map.getViewport();
      const overlays = viewport.querySelector('.ol-overlaycontainer');
      viewport.insertBefore(entry.canvas, overlays || null);
      // A finished move (drag, animated zoom, programmatic jump) re-anchors
      // the overlay to the new view on the next frame.
      map.on('moveend', () => { entry.anchor = null; });
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
        if (!renderer) {
          // No WebGL2: nothing can ever draw, so no loop, no timers, no
          // requests. Left disabled; the next applyPoiVisibility tries again,
          // which is cheap and covers a context budget that frees up later.
          enabled = false;
          return;
        }
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
    setCursor(timeMs, startMs, stepMs) {
      const next = startMs + FRAME_STEPS * stepMs;
      if (next === targetMs) return;
      windowStartMs = startMs;
      targetMs = next;
      planFetch();
    },

    // 'light' | 'dark', from setMapLayer.
    setTheme(next) {
      if (!COLORS[next]) return;
      theme = next;
      if (renderer) renderer.setColor(COLORS[theme].core, COLORS[theme].halo);
    },
  };
}
