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
// a FramePool. Every animation frame shows the snapshot the server holds for
// that frame's instant (`?datetime=<frame instant>`), fetched per frame and
// cached; the window is prefetched displayed-frame-first, then outward (the
// crossSection.js ordering), <= 3 in flight.
//
// NOTHING IS EXTRAPOLATED. Earlier revisions advected cells along their motion
// vectors to fill frames the server had no snapshot for; that is gone by
// explicit choice. What the collection reports for a frame is what the layer
// draws, and a frame the server has nothing for — older than the retained
// range, or ahead of the newest analysis, since there are no forecast cells —
// draws empty. Only frames inside the advertised retained range are requested
// at all, so the empty ones cost no traffic. The single stale-tolerating step
// is holding the previous frame's cells while a fetch is in flight rather than
// blanking mid-playback (the StickyImageWMS rule); the moment the response
// lands the display is exactly that response.
//
// The motion arrows are not extrapolation either: they draw `speed_ms` and
// `bearing_deg` as the server reports them, projected 30 min ahead as an
// annotation, and only for tracks old enough to carry a smoothed velocity.
//
// Server contract notes (measured against the live API on 2026-07-25):
//   * retention is read, never assumed, because it changed under the client:
//     the server first held ONE analysis instant (any other `datetime=`
//     returned numberMatched 0, in every spelling), then gained ~4 h of
//     snapshots — starting from empty and filling one analysis at a time. The
//     poll re-reads `extent.temporal` every minute instead of latching a mode
//     once, which is also how a new analysis is detected: the range moving is
//     the signal to clear misses and refill. That range decides which frames
//     are requested, so the layer needs no coordinated deploy and behaves
//     correctly while the history fills;
//   * `datetime=` takes the frame instant in any ISO spelling (`.000Z` included)
//     and answers with the newest snapshot at or before it; future instants have
//     no cells at all, since the collection carries no forecast;
//   * property filters (`severity=`, `observed=`, …) are silently IGNORED — the
//     server advertises only the OGC API Features core conformance classes and
//     its /queryables response is empty. Filtering is the client's job;
//   * a snapshot is ~200 features / ~13 kB gzipped, requested whole — no bbox
//     slicing, which would defeat cache reuse for no real gain;
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
// `deviant_mover` (it already encodes 2+ generations of persistence).
//
// Lightning (`flash_rate_per_min` / `lightning_jump`) is feature-detected: the
// properties appear only once a lightning source is wired to the collection,
// and while they are absent the layer renders no lightning UI whatsoever. When
// present they are TRI-STATE, and the guide is emphatic that the states differ:
// a number is measured, `null` is a data gap that must read as "–" rather than
// as zero, and only `lightning_jump === true` escalates. A jump already means
// the rate broke 2σ over the cell's own baseline at >= 10 flashes/min — rare,
// and typically 10-20 min ahead of severe weather — so it gets the violet ring
// and a bold chip that ignores the zoom gate, while an ordinary nonzero rate
// gets a plain chip and nothing more.
//
// The guide also warns that velocities and `deviant_mover` from before
// 2026-07-25 could point against the flow. A nearest-neighbour check across two
// consecutive analyses that day came out clearly forward (median 2.46 km to the
// next analysis's nearest cell, vs 4.62 km reversed and 2.99 km static), so the
// arrows point the way the storms are actually going.

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

// Velocities are EMA-smoothed only from the third generation on; age-2 is a
// single-displacement estimate that jitters, so below this age a cell draws no
// motion arrow — its position is still exactly where the server put it.
const MIN_TRACKED_AGE = 3;

// Noise tier (client-guide rule): weak cells under this footprint are real
// 35 dBZ specks, but at map zooms they read as markers detached from any echo.
const NOISE_TIER_MAX_AREA_KM2 = 10;

// How far ahead the motion vector is drawn.
const VECTOR_MINUTES = 30;
// Below this the motion solution is noise, not a direction worth drawing.
const MIN_VECTOR_SPEED_MS = 1;

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
// Gap between the footprint ring and the lightning-jump ring drawn around it.
const JUMP_RING_GAP_PX = 5;
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

// Trend badge after the reflectivity: ▲ intensifying, ▼ weakening, nothing
// while a cell is holding steady. A word ("voimistuu") would double the label
// width on every marker, so it stays one character.
//
// Driven by `intensity_trend_dbz_min` — the EMA'd mean-intensity trend — rather
// than `volume_trend`: what the label already reports is reflectivity, so a
// badge on the same quantity reads as "and it is rising", while a footprint
// growing on the volume trend can mean the storm merely spread out. The two
// disagree often enough to matter: on a live sample of 97 tracked cells, 27 of
// the volume-growing ones were flat or falling in intensity.
//
// The deadband keeps the badge off noise. Measured live, the trend spans about
// ±0.25 dBZ/min (median -0.03), so ±0.1 — half a dBZ over a 5-minute analysis
// step — marks the cells that are genuinely moving and leaves the middle half
// unbadged. `null` (newborn, or the property missing) never badges.
const INTENSITY_TREND_DEADBAND = 0.1;

function trendMark(trend) {
  if (!Number.isFinite(trend)) return '';
  if (trend > INTENSITY_TREND_DEADBAND) return ' ▲';
  if (trend < -INTENSITY_TREND_DEADBAND) return ' ▼';
  return '';
}

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
    // Lightning jump. Deliberately outside the severity ramp — violet cannot be
    // mistaken for "one step more severe", which is exactly what an electric
    // yellow next to the amber/orange tiers would look like.
    jump: '#7b1fd6',
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
    jump: '#c77dff',
  },
};

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

// Property presence, not truthiness: the lightning fields are absent when the
// feature is off but null when the data is momentarily missing, and the two
// must render differently.
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Flash rate as shown on the chip: whole numbers once the storm is busy, one
// decimal while it is still ticking over, so "0.4/min" does not round to "0".
function formatRate(rate) {
  return rate >= 10 ? String(Math.round(rate)) : String(Math.round(rate * 10) / 10);
}

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
  let shown = null;
  // Bounds of the server's retained snapshot range, refreshed on every poll:
  // the window slides, and after a deploy the range grows one snapshot at a
  // time until it reaches its full depth.
  let retainedStartMs = 0;
  let retainedEndMs = 0;
  let cursorMs = Date.now();
  let enabled = false;
  let timerId = 0;
  let refreshInFlight = null;
  let lastRefreshMs = 0;

  // Frame instants are the request key, so they must round-trip exactly: the
  // clock hands out 5-minute steps, and `toISOString` gives the millisecond
  // form the server accepts (the `Z` spelling is honoured alongside the
  // collection's own `+00:00`).
  const isoOf = (ms) => new Date(ms).toISOString();

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
      severity: p.severity || 'weak',
      maxDbz: Number.isFinite(p.max_dbz) ? p.max_dbz : null,
      areaKm2: Number.isFinite(p.area_km2) ? p.area_km2 : 0,
      trackAge: age,
      deviant: !!p.deviant_mover,
      // Intensity trend as a badge. Absent on servers before the property
      // existed, and null until the tracker has two analyses of the cell —
      // both mean "no badge".
      trend: trendMark(p.intensity_trend_dbz_min),
      // Motion is only meaningful once the tracker has two analyses of the
      // cell; before that the server sends nulls rather than zeros. `tracked`
      // is the stronger test the arrows use — the velocity is EMA-smoothed only
      // from the third generation on.
      speedMs: speed,
      bearingDeg: bearing,
      tracked: speed !== null && bearing !== null && age >= MIN_TRACKED_AGE,
      // Lightning is tri-state and the three states mean different things:
      //   ABSENT — no lightning source wired to the collection. Render no
      //            lightning UI at all, which is why presence is captured
      //            separately instead of collapsing to a number.
      //   null   — the lightning DB was unreachable for this snapshot. A data
      //            gap, NOT quiet: it shows as "–", never as 0.
      //   0      — measured, and the cell is quiet. Shows nothing.
      hasLightning: has(p, 'flash_rate_per_min'),
      flashRate: Number.isFinite(p.flash_rate_per_min) ? p.flash_rate_per_min : null,
      // Same tri-state. `null` is unknown-this-snapshot and must never be read
      // as "no jump", so the escalation tests `=== true` rather than truthiness.
      jump: has(p, 'lightning_jump') && typeof p.lightning_jump === 'boolean'
        ? p.lightning_jump
        : null,
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

  // Show the snapshot the server holds for the cursor's frame, and nothing
  // else: no extrapolation, no borrowing a neighbouring frame's cells. A frame
  // the server has nothing for — older than retention, or ahead of the newest
  // analysis, where there are no forecast cells — draws empty.
  //
  // The one exception is a request still in flight: the previous frame's cells
  // stay up rather than blanking for the length of a fetch (the StickyImageWMS
  // rule the raster layers follow). Nothing stale ever *settles* on screen —
  // the moment the answer arrives the display is exactly that answer.
  function render() {
    const entry = snapshots.get(isoOf(cursorMs));
    if (entry === PENDING) return;
    const snapshot = entry && entry !== MISS ? entry : null;
    if (snapshot === shown) return;
    shown = snapshot;
    source.clear(true);
    if (snapshot) source.addFeatures(snapshot.features);
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
    if (!windowFrames.length) return;
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

  // The one poll: re-read the retained range. It slides with every new analysis
  // and, right after a server deploy, grows one snapshot at a time from nothing,
  // so it is read fresh rather than latched — and it doubles as the "a new
  // analysis landed" signal, which is why no separate unfiltered fetch of the
  // newest snapshot exists any more. ~1 kB per poll against 13 kB.
  function refresh() {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = fetch(META_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`storm cells: HTTP ${res.status}`);
        return res.json();
      })
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
        lastRefreshMs = Date.now();
        if (!changed) return;
        // Frames the server had nothing for may have a snapshot now. Requests
        // still in flight (PENDING) are deliberately left alone — clearing
        // those re-queued them and fetched the same frame twice.
        for (const [key, value] of [...snapshots.entries()]) {
          if (value === MISS) snapshots.delete(key);
        }
        requestWindow();
      })
      .catch((err) => {
        // Offline / server hiccup: keep whatever is on screen and try again on
        // the next tick.
        console.warn(`Storm cells unavailable: ${err}`); // eslint-disable-line no-console
      })
      .finally(() => { refreshInFlight = null; });
    return refreshInFlight;
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
    if (Date.now() - lastRefreshMs >= REFRESH_MS) refresh();
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

    // Lightning styles are severity-independent, so they live here rather than
    // in the per-severity cache. The jump ring is a second, wider circle around
    // the footprint: an outline the eye catches at any zoom, and it survives
    // declutter because it is geometry rather than a symbol.
    const jumpHalo = new Style({ stroke: new Stroke({ color: palette.halo, width: 5 }) });
    const jumpRing = new Style({ stroke: new Stroke({ color: palette.jump, width: 2.5 }) });
    const chipText = (color, weight) => new Style({
      text: new Text({
        font: `${weight}11px Roboto, sans-serif`,
        fill: new Fill({ color }),
        stroke: new Stroke({ color: palette.textHalo, width: 2.5 }),
        textBaseline: 'bottom',
      }),
    });
    // Plain rate reads like the other numbers; only a jump escalates (rule 5 —
    // a jump means the rate broke 2σ over the cell's own baseline, so it must
    // not look like every thundery cell on the map).
    const chip = chipText(palette.textFill, '');
    const chipJump = chipText(palette.jump, '700 ');

    return (feature, resolution) => {
      const severity = feature.get('severity');
      const rank = SEVERITY_RANK[severity] ?? 0;
      const lon = feature.get('lon');
      const lat = feature.get('lat');
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

      // Lightning. Nothing at all when the server sends no lightning fields —
      // an absent feature must not leave a hole in the UI where a chip would be.
      const isJump = feature.get('jump') === true;
      const ringEdgePx = Math.min(radiusUnits / resolution, MAX_LABEL_OFFSET_PX);
      if (isJump) {
        const jumpGeom = new CircleGeom(center, radiusUnits + JUMP_RING_GAP_PX * resolution);
        jumpHalo.setGeometry(jumpGeom);
        jumpRing.setGeometry(jumpGeom);
        out.push(jumpHalo, jumpRing);
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
        entry.label.getText().setOffsetY(ringEdgePx + 4);
        out.push(entry.label);
      }

      if (feature.get('hasLightning')) {
        const rate = feature.get('flashRate');
        // A measured zero renders nothing; an unknown renders a dash, so a
        // lightning outage never reads as "no thunder here".
        const text = rate === null ? '⚡ –' : (rate > 0 ? `⚡ ${formatRate(rate)}/min` : '');
        // A jump is rare and time-critical, so its chip ignores the zoom gate
        // the other labels obey — it is the one thing worth seeing at synoptic
        // zoom. Sits above the ring, clear of the dBZ/speed lines below it.
        if (text && (isJump || resolution <= LABEL_MAX_RESOLUTION)) {
          const style = isJump ? chipJump : chip;
          style.setGeometry(new Point(center));
          style.getText().setText(text);
          style.getText().setOffsetY(-(ringEdgePx + (isJump ? JUMP_RING_GAP_PX : 0) + 4));
          out.push(style);
        }
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
      if (Date.now() - lastRefreshMs >= REFRESH_MS) refresh();
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
      if (windowChanged || !snapshots.has(isoOf(timeMs))) requestWindow();
      render();
    },

  };
}
