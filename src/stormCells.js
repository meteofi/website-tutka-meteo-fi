// Storm cells (Myrskysolut) — cell identification + tracking from the MeteoCore
// OGC API Features collection `fmi-radar-nowcast`. Each feature is one
// convective cell detected in the Finnish radar composite, carrying its
// severity class, peak reflectivity, footprint area and a tracked motion
// vector (speed + bearing).
//
// Cross-pane pattern (same as placeNames/searchHighlight): ONE shared
// VectorSource, one VectorLayer per pane created through the paneDeps factory,
// so split screen costs no extra fetches.
//
// Unlike the other POI layers this one is NOT wall-clock static — it is
// clock-coupled, but through `setCursor` (like crossSection.js), never through
// a FramePool. Cells must match the frame under them: the analysis lags the
// newest radar frame by ~5-10 min, and playback sweeps a 1 h window, so one
// "now" snapshot held across the loop puts markers nowhere near their echoes.
//
// Two paths, picked per frame by what the server actually holds — read from
// `extent.temporal` on every poll by `refreshRetention`, never assumed:
//
//   1. PER-FRAME SNAPSHOTS (server >= 2026-07-25, ~4 h / 48 snapshots
//      retained). `?datetime=<frame instant>` returns the snapshot for that
//      frame, so every frame of the window shows the cells that were actually
//      there. Only frames inside the advertised retained range are requested:
//      right after a deploy that range grows one snapshot at a time, and
//      asking for the rest would be a dozen requests answered with 0 features.
//      The window is prefetched displayed-frame-first, then outward (the
//      crossSection.js ordering), <= 3 in flight, and the last good set stays
//      on screen while a frame loads (StickyImageWMS philosophy).
//   2. ADVECTION FALLBACK. Used wherever a snapshot cannot exist: a server
//      without retention, and the leading frames that run past the newest
//      analysis (there are no forecast cells — a future instant returns 0
//      features). The newest snapshot's cells are then extrapolated along
//      their own motion vectors to the frame time.
//
// The fallback follows the server author's reliability rules: only tracks with
// `track_age >= 3` carry an EMA-smoothed velocity, so younger cells are never
// advected — they are pinned to their analysis frame and hidden elsewhere — and
// no cell is extrapolated back past its own track length, where it would invent
// a cell that had not formed yet. The layer also fades with distance from the
// snapshot it is showing, so an extrapolated position never reads as an
// observation. On path 1 that distance is zero and the fade never engages.
//
// Server contract notes (measured against the live API on 2026-07-25):
//   * retention is the one thing this module reads rather than assumes, because
//     it changed under the client: the server first held ONE analysis instant
//     (any other `datetime=` returned numberMatched 0, in every spelling), then
//     gained ~4 h of snapshots — starting from empty and filling one analysis at
//     a time. `refreshRetention` therefore re-reads `extent.temporal` on every
//     poll instead of latching a mode once. No coordinated deploy, correct
//     behaviour while the history fills, and a rollback degrades to advection
//     instead of an empty layer;
//   * `datetime=` takes the frame instant in any ISO spelling (`.000Z` included)
//     and answers with the newest snapshot at or before it; future instants have
//     no cells at all, since the collection carries no forecast;
//   * property filters (`severity=`, `observed=`, …) are silently IGNORED — the
//     server advertises only the OGC API Features core conformance classes and
//     its /queryables response is empty. Filtering is the client's job;
//   * the whole collection is ~200 features / ~13 kB gzipped — fetched in one
//     unfiltered request, no bbox slicing (bbox would defeat cache reuse for no
//     real gain);
//   * responses carry NO ETag/Cache-Control, so a refresh is always a full
//     transfer — poll only while the layer is actually on and the tab visible;
//   * `id` is a persistent track id (same storm keeps it across refreshes,
//     never reused). Verified after the 2026-07-25 track-association fix: of
//     190 ids common to two consecutive analyses, every single one advanced
//     `track_age` by exactly 1 and the id-matched displacement matched the
//     advertised speed (median 11.3 vs 10.1 m/s). Before that fix the same test
//     gave implausible 30-70 m/s, so treat pre-fix behaviour as unrelated.
//     Nothing here depends on id stability yet — it is the seam for in-place
//     marker animation and client-side track trails.
//
// Client-guide rules from the server author, followed below: draw markers only
// for `severity != weak || area_km2 >= 10` (the weak tier is real 35 dBZ specks
// but reads as detached from the echo at map zooms — 61% of the collection on a
// live check), motion arrows only for `track_age >= 3` (age-2 velocities are
// single-displacement estimates that jitter), and no extra hysteresis on
// `deviant_mover` (it already encodes 2+ generations of persistence). The same
// note warns that velocities and `deviant_mover` from before 2026-07-25 could
// point against the flow; a nearest-neighbour check across two consecutive
// analyses on 2026-07-25 came out clearly forward (median 2.46 km to the next
// analysis's nearest cell, vs 4.62 km reversed and 2.99 km static), so the
// advection above is sound on current data.

import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import LineString from 'ol/geom/LineString';
import CircleGeom from 'ol/geom/Circle';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { fromLonLat } from 'ol/proj';
import {
  Fill, Stroke, Style, Text,
} from 'ol/style';

const COLLECTION_URL = 'https://meteocore.app.meteo.fi/features/collections/fmi-radar-nowcast';
const ITEMS_URL = `${COLLECTION_URL}/items?f=application/geo%2Bjson&limit=1000`;
const META_URL = COLLECTION_URL;

// Retention span (from `extent.temporal`) at which per-frame snapshots become
// worth requesting: one analysis step, i.e. the moment the collection holds
// more than the single newest instant. Which frames actually get requested is
// then decided per frame against the advertised range, so a server whose
// history is still filling after a deploy serves the frames it has and the
// rest fall back to advection — no threshold to wait out.
const MIN_RETENTION_MS = 5 * 60 * 1000;

// Per-frame fetches in flight. The window is 13 frames of ~13 kB gzipped; a
// small cap keeps the displayed frame's request from queueing behind a dozen
// prefetches on a cold start.
const MAX_IN_FLIGHT = 3;

// The animation window is exactly 13 frames (CLAUDE.md hard rule 4). This is
// one more copy of that constant — audit it with the others (radar.js,
// framePool.js `size`, probe.js STRIP_CELLS, crosshair.js WINDOW_FRAMES) if the
// window length ever changes.
const FRAME_COUNT = 13;

// The analysis runs on the 5-minute radar cadence; a 60 s poll picks a new one
// up within a minute of it landing. Cheap enough (~13 kB gzipped) that the
// simple fixed interval beats trying to predict the publish moment.
const REFRESH_MS = 60000;

// Cell lifetime guards for the advection, in seconds of cursor offset from the
// analysis time. Backwards: never further than the cell's own track length.
// Forwards: the cursor only ever runs ~10 min past the analysis (newest radar
// frame vs. cell analysis lag), so 30 min is a safety cap, not a nowcast.
const TRACK_STEP_S = 300;
const MAX_FORWARD_S = 1800;
// Cells whose velocity is not trustworthy yet can only be drawn where they were
// seen — show them on frames within one radar step of the analysis instead.
const STATIC_CELL_TOLERANCE_S = 600;

// Velocities are EMA-smoothed only from the third generation on; age-2 is a
// single-displacement estimate that jitters. Below this age a cell neither
// advects nor draws an arrow.
const MIN_TRACKED_AGE = 3;

// Noise tier (client-guide rule): weak cells under this footprint are real
// 35 dBZ specks, but at map zooms they read as markers detached from any echo.
const NOISE_TIER_MAX_AREA_KM2 = 10;

// How far ahead the motion vector is drawn.
const VECTOR_MINUTES = 30;
// Below this the motion solution is noise, not a direction worth drawing.
const MIN_VECTOR_SPEED_MS = 1;

// Extrapolation fade (client-guide rule 1): markers are positioned for the
// analysis frame, so the further the cursor sits from it the less they should
// assert. Full strength within one radar step, floor at the window edge.
const FADE_FULL_S = 600;
const FADE_MAX_S = 2700;
const FADE_MIN_OPACITY = 0.45;

// Resolutions are map units per pixel in EPSG:3857 (inflated by 1/cos(lat) —
// ~2.4x at 65°N), the same scale placeNames.js bands against.
// Labels for everything once zoomed in; severe cells stay labelled at any zoom.
// The cut sits just above z8 (res ~611), the zoom where a handful of cells fill
// the screen and their numbers are the point — z7 and out would be a wall of
// text over the whole country.
const LABEL_MAX_RESOLUTION = 700;

// Minimum on-screen radius: a 1.8 km² cell is sub-pixel at synoptic zoom, and
// an invisible marker is worse than a slightly exaggerated one.
const MIN_RADIUS_PX = 5;
// Arrowhead barbs are a constant screen size, so the vector reads the same at
// every zoom.
const ARROW_HEAD_PX = 9;
const MIN_VECTOR_PX = 2.5 * ARROW_HEAD_PX;
const MAX_LABEL_OFFSET_PX = 48;
const ARROW_HEAD_ANGLE = 2.6; // rad off the shaft direction (~149°)

const SEVERITY_RANK = {
  weak: 0,
  moderate: 1,
  severe: 2,
  very_severe: 3,
};

// `volume_trend` as a one-character badge after the reflectivity: a growing
// cell is the one worth watching, and a word ("kasvaa") would double the label
// width for every marker. Anything else — including the null a newborn carries
// and the property being absent on older servers — gets no badge.
const TREND_MARKS = {
  growing: ' ▲',
  decaying: ' ▼',
};

// Severity ramp + halo per theme, same inversion rationale as icaoTextColors in
// radar.js — and it matters more here, because these marks are only sometimes
// over an echo: a cell ring drawn in the dark theme's bright amber sits on the
// light basemap's white with almost no contrast. Light theme therefore gets
// darkened, saturated colours under a white halo; dark theme keeps the bright
// ramp over a black halo.
//
// The ramp stays warm-to-hot and skips the blue/green end on purpose: the marks
// are drawn ON TOP of dBZ imagery whose light end is blue/green, and a cool
// outline over a cool echo disappears. Every stroke is drawn twice — wide halo
// underneath, colour on top — so the ring separates from whatever is below it.
const PALETTES = {
  light: {
    halo: 'rgba(255,255,255,0.9)',
    severity: {
      // Neutral slate rather than a blue-grey: the light theme's weak ring is
      // often over the dBZ palette's blue low end, where a blue-tinted outline
      // stops reading as annotation.
      weak: '#55606b',
      moderate: '#b87500',
      severe: '#d94f00',
      very_severe: '#c4003a',
    },
    textFill: '#222222',
    textHalo: '#ffffff',
  },
  dark: {
    halo: 'rgba(0,0,0,0.6)',
    severity: {
      weak: '#9fb3c8',
      moderate: '#ffd166',
      severe: '#ff7a29',
      very_severe: '#ff2d55',
    },
    textFill: '#e8e8e8',
    textHalo: '#000000',
  },
};

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

// Great-circle destination from [lon, lat] along `bearingDeg` (degrees
// clockwise from north = the direction the cell travels). A negative
// `distanceM` walks the track backwards, which is what a cursor on an older
// frame asks for.
function destination(lon, lat, bearingDeg, distanceM) {
  const d = distanceM / EARTH_RADIUS_M;
  const br = toRad(bearingDeg);
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const sinLat2 = Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br);
  const lat2 = Math.asin(sinLat2);
  const lon2 = lon1 + Math.atan2(
    Math.sin(br) * Math.sin(d) * Math.cos(lat1),
    Math.cos(d) - Math.sin(lat1) * sinLat2,
  );
  return [toDeg(lon2), toDeg(lat2)];
}

// EPSG:3857 distances are inflated by 1/cos(lat) — a circle that should be
// 10 km on the ground must be drawn with a 3857 radius of 10 km / cos(lat), or
// it renders ~2.4x too small at Finnish latitudes.
function metersToMapUnits(meters, lat) {
  return meters / Math.cos(toRad(lat));
}

// Equivalent-circle radius of the cell footprint.
function footprintRadiusM(areaKm2) {
  return Math.sqrt(Math.max(areaKm2, 0) / Math.PI) * 1000;
}

export default function initStormCells() {
  const source = new VectorSource({
    attributions: 'Myrskysolut © FMI (CC BY 4.0)',
  });

  const paneLayers = [];
  // frame instant (ISO) -> snapshot, PENDING while a request is in flight, or
  // MISS when the server has no snapshot for that frame. The three states must
  // stay distinct: misses are cleared when a new analysis lands (the frame may
  // exist now), while pending requests must survive that sweep — folding them
  // together re-queued in-flight frames and fetched them twice.
  const PENDING = Symbol('pending');
  const MISS = Symbol('miss');
  const snapshots = new Map();
  let queue = [];
  let windowFrames = [];
  let inFlight = 0;
  let latest = null;
  let shown = null;
  let perFrameMode = false;
  // Bounds of the server's retained snapshot range, refreshed on every poll:
  // the window slides, and after a deploy the range grows one snapshot at a
  // time until it reaches its full depth.
  let retainedStartMs = 0;
  let retainedEndMs = 0;
  let cursorMs = Date.now();
  let analysisMs = 0;
  let enabled = false;
  let timerId = 0;
  let latestInFlight = null;
  let lastLoadMs = 0;

  // Frame instants are the request key, so they must round-trip exactly: the
  // clock hands out 5-minute steps, and `toISOString` gives the millisecond
  // form the server accepts (the `Z` spelling is honoured alongside the
  // collection's own `+00:00`).
  const isoOf = (ms) => new Date(ms).toISOString();

  //
  // ADVECTION
  //
  // Positions are recomputed on the shared source, so every pane's layer picks
  // the move up from one mutation. `hidden` is a plain feature property the
  // style function reads — cheaper than adding/removing features per tick.
  function advectFeature(feature) {
    const lon = feature.get('lon');
    const lat = feature.get('lat');
    const speed = feature.get('speedMs');
    const bearing = feature.get('bearingDeg');
    const dt = (cursorMs - feature.get('observedMs')) / 1000;

    // No trustworthy motion solution (newborn, or a single-displacement age-2
    // estimate) — the cell can only be drawn where it was seen, so nothing to
    // move; only its visibility window changes.
    if (!feature.get('tracked')) {
      feature.set('hidden', Math.abs(dt) > STATIC_CELL_TOLERANCE_S, true);
      return;
    }

    // track_age is in analysis steps; a cell tracked for 4 steps has existed
    // for 4 * 5 min. Older than that and we would be drawing a cell that had
    // not formed yet.
    const maxBackS = Math.max(feature.get('trackAge'), 1) * TRACK_STEP_S;
    if (dt < -maxBackS || dt > MAX_FORWARD_S) {
      feature.set('hidden', true, true);
      return;
    }

    const [curLon, curLat] = destination(lon, lat, bearing, speed * dt);
    feature.set('hidden', false, true);
    feature.setProperties({ curLon, curLat }, true);
    feature.getGeometry().setCoordinates(fromLonLat([curLon, curLat]));
  }

  function advectAll() {
    const features = source.getFeatures();
    if (!features.length) return;
    features.forEach(advectFeature);
    source.changed();
  }

  // Client-guide rule 1: the markers describe the analysis frame, so the
  // further the cursor is from it the more they are extrapolation rather than
  // observation. Fading the whole layer says that without hiding information
  // the user scrubbed to on purpose.
  function applyFade() {
    if (!analysisMs) return;
    const dt = Math.abs(cursorMs - analysisMs) / 1000;
    const t = Math.min(Math.max((dt - FADE_FULL_S) / (FADE_MAX_S - FADE_FULL_S), 0), 1);
    const opacity = 1 - (1 - FADE_MIN_OPACITY) * t;
    paneLayers.forEach((layer) => layer.setOpacity(opacity));
  }

  //
  // DATA
  //
  function toFeature(json) {
    const [lon, lat] = json.geometry.coordinates;
    const p = json.properties || {};
    const speed = Number.isFinite(p.speed_ms) ? p.speed_ms : null;
    const bearing = Number.isFinite(p.bearing_deg) ? p.bearing_deg : null;
    const age = Number.isFinite(p.track_age) ? p.track_age : 1;
    const feature = new Feature({
      geometry: new Point(fromLonLat([lon, lat])),
    });
    feature.setProperties({
      lon,
      lat,
      curLon: lon,
      curLat: lat,
      observedMs: Date.parse(p.observed),
      severity: p.severity || 'weak',
      maxDbz: Number.isFinite(p.max_dbz) ? p.max_dbz : null,
      areaKm2: Number.isFinite(p.area_km2) ? p.area_km2 : 0,
      trackAge: age,
      deviant: !!p.deviant_mover,
      // Volume trend over the last interval. Absent on servers before the
      // property existed, and null on newborns — both mean "no badge".
      trend: TREND_MARKS[p.volume_trend] || '',
      // Motion is only meaningful once the tracker has two analyses of the
      // cell; before that the server sends nulls rather than zeros. `tracked`
      // is the stronger test the arrows and the advection both use — the
      // velocity is EMA-smoothed only from the third generation on.
      speedMs: speed,
      bearingDeg: bearing,
      tracked: speed !== null && bearing !== null && age >= MIN_TRACKED_AGE,
      hidden: false,
    });
    return feature;
  }

  // Client-guide rule 2: the weak tier under ~10 km² is real 35 dBZ pixels but
  // renders as markers with no visible echo under them — 60% of the collection,
  // all of it noise at map zooms.
  function isNoiseTier(p) {
    return p.severity === 'weak' && (p.area_km2 || 0) < NOISE_TIER_MAX_AREA_KM2;
  }

  // One response -> one snapshot: the parsed features plus the analysis instant
  // they describe. `null` features means the server had no snapshot for that
  // request (a frame ahead of the newest analysis).
  function toSnapshot(geojson) {
    const items = (geojson.features || [])
      .filter((f) => f.geometry && f.geometry.type === 'Point'
        && Number.isFinite(Date.parse((f.properties || {}).observed)));
    if (!items.length) return null;
    return {
      observedMs: Date.parse(items[0].properties.observed),
      // The noise tier is dropped here rather than in the style function so it
      // costs nothing per render and never enters the spatial index.
      features: items.filter((f) => !isNoiseTier(f.properties)).map(toFeature),
    };
  }

  function fetchSnapshot(frameIso) {
    const url = frameIso ? `${ITEMS_URL}&datetime=${encodeURIComponent(frameIso)}` : ITEMS_URL;
    return fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`storm cells: HTTP ${res.status}`);
        return res.json();
      })
      .then(toSnapshot);
  }

  // Show the snapshot that belongs to the cursor's frame. Exact snapshot when
  // the server has one; otherwise the latest, advected across the residual gap
  // and faded — which is also the whole behaviour on a server without history.
  function render() {
    const exact = snapshots.get(isoOf(cursorMs));
    const usable = exact && exact !== PENDING && exact !== MISS ? exact : null;
    const snapshot = usable || latest;
    if (!snapshot) return;
    if (snapshot !== shown) {
      shown = snapshot;
      source.clear(true);
      source.addFeatures(snapshot.features);
    }
    analysisMs = snapshot.observedMs;
    advectAll();
    applyFade();
  }

  // Fetch queue: the displayed frame first, then the rest of the window
  // outward from it (the crossSection.js ordering — the user is only waiting
  // for the frame in front of them). Cursor moves never cancel work in flight;
  // a queued frame that scrolled out of the window is dropped when it surfaces.
  function startFetch(frameIso) {
    inFlight += 1;
    snapshots.set(frameIso, PENDING); // reserve, so it is not queued twice
    fetchSnapshot(frameIso)
      .then((snapshot) => {
        // A frame the server has nothing for is recorded as a miss rather than
        // dropped, so it is not asked for again until a new analysis lands.
        snapshots.set(frameIso, snapshot || MISS);
        if (frameIso === isoOf(cursorMs)) render();
      })
      .catch((err) => {
        snapshots.delete(frameIso);
        console.warn(`Storm cells unavailable: ${err}`); // eslint-disable-line no-console
      })
      .finally(() => { inFlight -= 1; pump(); });
  }

  function pump() {
    while (inFlight < MAX_IN_FLIGHT && queue.length) {
      const frameIso = queue.shift();
      if (!snapshots.has(frameIso)) startFetch(frameIso);
    }
  }

  // A frame is worth requesting only if the server says it still holds that
  // instant. Retention starts empty after a deploy and fills one snapshot per
  // analysis, so early on most of the window is outside it — and the leading
  // frames are always outside it, since there are no forecast cells. Asking
  // anyway would be 10+ requests per window answered with 0 features.
  function isRetained(frameIso) {
    const t = Date.parse(frameIso);
    return t >= retainedStartMs && t <= retainedEndMs;
  }

  function requestWindow() {
    if (!perFrameMode || !windowFrames.length) return;
    // Drop frames that scrolled out of the window, but never the misses of the
    // current window — those are re-tried by the poll below.
    for (const key of [...snapshots.keys()]) {
      if (!windowFrames.includes(key)) snapshots.delete(key);
    }
    const wanted = windowFrames.filter(isRetained);
    if (!wanted.length) return;
    const cursorIso = isoOf(cursorMs);
    const byDistance = [...wanted]
      .sort((a, b) => Math.abs(Date.parse(a) - cursorMs) - Math.abs(Date.parse(b) - cursorMs));
    // Displayed frame first when the server has it, then outward from it. The
    // queue is rebuilt wholesale rather than appended to, so priority follows
    // the cursor; anything already fetched or in flight is in `snapshots` and
    // filtered out here. (Testing against the old `!queue.includes` guard: it
    // dropped frames that were queued but not yet started.)
    const ordered = isRetained(cursorIso) ? [cursorIso, ...byDistance] : byDistance;
    queue = ordered.filter((iso, i, all) => all.indexOf(iso) === i && !snapshots.has(iso));
    pump();
  }

  // Retention probe, run on every poll rather than once: the retained range
  // slides with each new analysis, and right after a server deploy it grows one
  // snapshot at a time from nothing. Reading it (instead of assuming a server
  // version) means the client needs no redeploy when retention appears, keeps
  // requesting only frames that exist while the range fills, and falls back to
  // advection untouched if retention is rolled back.
  function refreshRetention() {
    return fetch(META_URL)
      .then((res) => (res.ok ? res.json() : null))
      .then((meta) => {
        const interval = meta && meta.extent && meta.extent.temporal
          && meta.extent.temporal.interval && meta.extent.temporal.interval[0];
        if (!interval) return;
        const startMs = Date.parse(interval[0]);
        const endMs = Date.parse(interval[1]);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return;
        const changed = startMs !== retainedStartMs || endMs !== retainedEndMs;
        retainedStartMs = startMs;
        retainedEndMs = endMs;
        // A collection without history advertises one instant (span 0) and
        // stays on the advection path; anything wider has real snapshots to
        // ask for, even if only a couple of frames' worth so far.
        perFrameMode = endMs - startMs >= MIN_RETENTION_MS;
        if (changed) requestWindow();
      })
      .catch(() => { /* probe again on the next poll */ });
  }

  function load() {
    if (latestInFlight) return latestInFlight;
    latestInFlight = fetchSnapshot(null)
      .then((snapshot) => {
        if (!snapshot) return;
        if (!latest || snapshot.observedMs !== latest.observedMs) {
          latest = snapshot;
          // A new analysis landed: frames the server had nothing for may have a
          // snapshot now, so clear the misses and refill. Requests still in
          // flight (PENDING) are deliberately left alone — clearing those
          // re-queued them and fetched the same frame twice.
          for (const [key, value] of [...snapshots.entries()]) {
            if (value === MISS) snapshots.delete(key);
          }
          requestWindow();
        }
        lastLoadMs = Date.now();
        render();
      })
      .catch((err) => {
        // Offline / server hiccup: keep whatever is on screen (StickyImageWMS
        // philosophy) and try again on the next tick.
        console.warn(`Storm cells unavailable: ${err}`); // eslint-disable-line no-console
      })
      .finally(() => { latestInFlight = null; });
    return latestInFlight;
  }

  function refresh() {
    refreshRetention();
    load();
  }

  function stopPolling() {
    if (timerId) clearInterval(timerId);
    timerId = 0;
  }

  function startPolling() {
    stopPolling();
    timerId = setInterval(() => {
      // A hidden tab has nothing to show and its timers are throttled anyway;
      // the visibilitychange handler below catches up on return.
      if (document.visibilityState === 'visible') refresh();
    }, REFRESH_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (!enabled || document.visibilityState !== 'visible') return;
    if (Date.now() - lastLoadMs >= REFRESH_MS) refresh();
  });

  //
  // STYLE
  //
  // One cached Style per (theme, severity, role); per-feature geometry and text
  // are stamped into the shared instances at build time — the radarStyle /
  // placeNames pattern. Nothing here uses an image style, so the layer's
  // declutter group only ever thins labels: the rings and motion vectors are
  // real geometry and always draw.
  function makeStyleFunction(theme) {
    const palette = PALETTES[theme];
    const cache = new Map();

    const styles = (severity, deviant) => {
      const key = `${severity}/${deviant}`;
      let entry = cache.get(key);
      if (!entry) {
        const color = palette.severity[severity] || palette.severity.weak;
        // A deviant mover is a cell tracking off the mean flow (splitting or
        // rotating storms do this) — worth flagging, so its ring is dashed.
        const dash = deviant ? [5, 4] : undefined;
        entry = {
          ringHalo: new Style({ stroke: new Stroke({ color: palette.halo, width: 4, lineDash: dash }) }),
          ring: new Style({ stroke: new Stroke({ color, width: 2, lineDash: dash }) }),
          vectorHalo: new Style({ stroke: new Stroke({ color: palette.halo, width: 4 }) }),
          vector: new Style({ stroke: new Stroke({ color, width: 2 }) }),
          label: new Style({
            text: new Text({
              font: '11px Roboto, sans-serif',
              fill: new Fill({ color: palette.textFill }),
              stroke: new Stroke({ color: palette.textHalo, width: 2.5 }),
              textBaseline: 'top',
            }),
          }),
        };
        cache.set(key, entry);
      }
      return entry;
    };

    return (feature, resolution) => {
      if (feature.get('hidden')) return null;
      const severity = feature.get('severity');
      const rank = SEVERITY_RANK[severity] ?? 0;
      const lon = feature.get('curLon');
      const lat = feature.get('curLat');
      const center = feature.getGeometry().getCoordinates();
      const entry = styles(severity, feature.get('deviant'));

      const radiusUnits = Math.max(
        metersToMapUnits(footprintRadiusM(feature.get('areaKm2')), lat),
        MIN_RADIUS_PX * resolution,
      );
      const ring = new CircleGeom(center, radiusUnits);
      entry.ringHalo.setGeometry(ring);
      entry.ring.setGeometry(ring);
      const out = [entry.ringHalo, entry.ring];

      const speed = feature.get('speedMs');
      const bearing = feature.get('bearingDeg');
      // `tracked` (track_age >= 3) is the client-guide gate on drawing motion
      // at all: younger tracks have a velocity, but it jitters generation to
      // generation and an arrow states more confidence than the number carries.
      const head = feature.get('tracked') && speed >= MIN_VECTOR_SPEED_MS
        ? fromLonLat(destination(lon, lat, bearing, speed * VECTOR_MINUTES * 60))
        : null;
      // A shaft shorter than its own arrowhead renders as a bare chevron stuck
      // on the ring — slow cell at low zoom. Drop the vector instead; the ring
      // alone says "not going anywhere fast".
      const vectorPx = head
        ? Math.hypot(head[0] - center[0], head[1] - center[1]) / resolution
        : 0;
      if (vectorPx >= MIN_VECTOR_PX) {
        // Barbs are computed in projected space off the shaft's on-screen
        // direction, so they stay symmetric about the drawn line even where
        // the great circle and the Mercator straight line diverge.
        const dir = Math.atan2(head[1] - center[1], head[0] - center[0]);
        const barb = ARROW_HEAD_PX * resolution;
        const shaft = new LineString([
          [head[0] + barb * Math.cos(dir + ARROW_HEAD_ANGLE), head[1] + barb * Math.sin(dir + ARROW_HEAD_ANGLE)],
          head,
          [head[0] + barb * Math.cos(dir - ARROW_HEAD_ANGLE), head[1] + barb * Math.sin(dir - ARROW_HEAD_ANGLE)],
          head,
          center,
        ]);
        entry.vectorHalo.setGeometry(shaft);
        entry.vector.setGeometry(shaft);
        out.push(entry.vectorHalo, entry.vector);
      }

      if (resolution <= LABEL_MAX_RESOLUTION || rank >= SEVERITY_RANK.severe) {
        const dbz = feature.get('maxDbz');
        const lines = [dbz === null ? '' : `${Math.round(dbz)} dBZ${feature.get('trend')}`];
        if (speed !== null) lines.push(`${Math.round(speed * 3.6)} km/h`);
        entry.label.setGeometry(new Point(center));
        entry.label.getText().setText(lines.filter(Boolean).join('\n'));
        // Hug the bottom of the ring — the ring grows with the map, the label
        // offset is in pixels. Capped so a zoomed-in giant cell keeps its label
        // near the marker instead of parking it hundreds of pixels away.
        entry.label.getText().setOffsetY(Math.min(radiusUnits / resolution, MAX_LABEL_OFFSET_PX) + 4);
        out.push(entry.label);
      }
      return out;
    };
  }

  const styleLight = makeStyleFunction('light');
  const styleDark = makeStyleFunction('dark');

  return {
    styleLight,
    styleDark,

    // Pane factory for paneDeps. Starts hidden and on the light style; POI
    // visibility and setMapLayer take over immediately after pane creation.
    createPaneLayer() {
      const layer = new VectorLayer({
        source,
        visible: false,
        // Labels only — see the style function. Own group so cell labels never
        // knock out place names (OL declutters shared groups together).
        declutter: 'storm-cells',
        // Strongest cells render first so declutter keeps their labels when
        // they collide with a weaker neighbour's.
        renderOrder: (a, b) => (SEVERITY_RANK[b.get('severity')] ?? 0) - (SEVERITY_RANK[a.get('severity')] ?? 0),
        style: styleLight,
      });
      // Kept so the extrapolation fade can reach every pane's layer. Panes are
      // never destroyed — setLayout hides them — so this never leaks.
      paneLayers.push(layer);
      applyFade();
      return layer;
    },

    // Called from the POI toggle: fetching and polling only run while the
    // layer is actually on.
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (!on) {
        stopPolling();
        return;
      }
      if (Date.now() - lastLoadMs >= REFRESH_MS) refresh();
      // The clock may not tick again on its own (paused playback), so seed the
      // window prefetch here too rather than waiting for the next setCursor.
      requestWindow();
      startPolling();
    },

    // Routed from setTime (radar.js) on every clock move — same signature as
    // probe/crossSection, because the window is what tells this module which
    // frame snapshots to prefetch.
    setCursor(timeMs, windowStartMs, stepMs) {
      const frames = [];
      for (let i = 0; i < FRAME_COUNT; i++) frames.push(isoOf(windowStartMs + i * stepMs));
      const windowChanged = frames.length !== windowFrames.length
        || frames.some((iso, i) => iso !== windowFrames[i]);
      if (!windowChanged && cursorMs === timeMs) return;
      cursorMs = timeMs;
      windowFrames = frames;
      if (!enabled) return;
      if (windowChanged) requestWindow();
      else if (perFrameMode && !snapshots.has(isoOf(timeMs))) requestWindow();
      render();
    },

  };
}
