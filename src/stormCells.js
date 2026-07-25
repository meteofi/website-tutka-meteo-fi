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
// a FramePool:
//   * the analysis lags the newest radar frame by ~5-10 min, so cells drawn at
//     their observed position sit visibly behind the echo they belong to;
//   * playback sweeps a 1 h window, and "now" cells over a 55-min-old frame
//     read as plain wrong.
// So each cell is advected along its own motion vector to the displayed frame
// time — exactly the extrapolation the collection is built on. Cells are
// suppressed on frames older than their track (`track_age` frames back), where
// backwards extrapolation would invent a cell that did not exist yet.
//
// Server contract notes (measured against the live API on 2026-07-25):
//   * the collection holds ONE analysis instant — the newest. `datetime=` is
//     honoured (the collection's own `.extent.temporal` value, verbatim with
//     the `+00:00` offset, returns the full set; the `Z` spelling works too),
//     but every other instant — 5 minutes old, or any future lead time —
//     returns numberMatched 0. So a per-frame datetime request would leave 12
//     of the 13 animation frames empty; the advection above is what ties cells
//     to frames instead. If the server ever starts retaining a history of
//     analyses, per-frame fetching becomes the better design and this module is
//     where it lands;
//   * property filters (`severity=`, `observed=`, …) are silently IGNORED — the
//     server advertises only the OGC API Features core conformance classes and
//     its /queryables response is empty. Filtering is the client's job;
//   * the whole collection is ~180 features / ~13 kB gzipped — fetched in one
//     unfiltered request, no bbox slicing (bbox would defeat cache reuse for no
//     real gain);
//   * responses carry NO ETag/Cache-Control, so a refresh is always a full
//     transfer — poll only while the layer is actually on and the tab visible.

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

const ITEMS_URL = 'https://meteocore.app.meteo.fi/features/collections/fmi-radar-nowcast/items?f=application/geo%2Bjson&limit=1000';

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
// Cells with no motion solution yet (track_age 1) can only be drawn where they
// were seen — show them on frames within one radar step of the analysis.
const STATIC_CELL_TOLERANCE_S = 600;

// How far ahead the motion vector is drawn.
const VECTOR_MINUTES = 30;
// Below this the motion solution is noise, not a direction worth drawing.
const MIN_VECTOR_SPEED_MS = 1;

// Resolutions are map units per pixel in EPSG:3857 (inflated by 1/cos(lat) —
// ~2.4x at 65°N), the same scale placeNames.js bands against.
// Weak cells are two thirds of the collection; at synoptic zoom they turn the
// map into confetti, so they only appear from z8 in.
const WEAK_MAX_RESOLUTION = 1200;
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

  let cursorMs = Date.now();
  let enabled = false;
  let timerId = 0;
  let inFlight = null;
  let lastLoadMs = 0;

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

    // No motion solution yet — the cell can only be drawn where it was seen,
    // so nothing to move; only its visibility window changes.
    if (speed === null || bearing === null) {
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

  //
  // DATA
  //
  function toFeature(json) {
    const [lon, lat] = json.geometry.coordinates;
    const p = json.properties || {};
    const speed = Number.isFinite(p.speed_ms) ? p.speed_ms : null;
    const bearing = Number.isFinite(p.bearing_deg) ? p.bearing_deg : null;
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
      trackAge: Number.isFinite(p.track_age) ? p.track_age : 1,
      deviant: !!p.deviant_mover,
      // Motion is only meaningful once the tracker has two analyses of the
      // cell; before that the server sends nulls rather than zeros.
      speedMs: speed,
      bearingDeg: bearing,
      hidden: false,
    });
    return feature;
  }

  function load() {
    if (inFlight) return inFlight;
    const controller = new AbortController();
    inFlight = fetch(ITEMS_URL, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`storm cells: HTTP ${res.status}`);
        return res.json();
      })
      .then((geojson) => {
        const features = (geojson.features || [])
          .filter((f) => f.geometry && f.geometry.type === 'Point'
            && Number.isFinite(Date.parse((f.properties || {}).observed)))
          .map(toFeature);
        source.clear(true);
        source.addFeatures(features);
        lastLoadMs = Date.now();
        advectAll();
      })
      .catch((err) => {
        // Offline / server hiccup: keep whatever is on screen (StickyImageWMS
        // philosophy) and try again on the next tick.
        console.warn(`Storm cells unavailable: ${err}`); // eslint-disable-line no-console
      })
      .finally(() => { inFlight = null; });
    return inFlight;
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
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (!enabled || document.visibilityState !== 'visible') return;
    if (Date.now() - lastLoadMs >= REFRESH_MS) load();
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
      if (rank === 0 && resolution > WEAK_MAX_RESOLUTION) return null;

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
      const head = speed !== null && bearing !== null && speed >= MIN_VECTOR_SPEED_MS
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
        const lines = [dbz === null ? '' : `${Math.round(dbz)} dBZ`];
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
      return new VectorLayer({
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
      if (Date.now() - lastLoadMs >= REFRESH_MS) load();
      startPolling();
    },

    // Routed from setTime (radar.js) on every clock move, like crossSection.
    setCursor(timeMs) {
      if (cursorMs === timeMs) return;
      cursorMs = timeMs;
      if (!enabled) return;
      advectAll();
    },

  };
}
