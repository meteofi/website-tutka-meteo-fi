// Shared helpers for MeteoCore OGC EDR *trajectory* queries (CoverageJSON
// vertical sections along a line — the poikkileikkaus feature). Same
// philosophy as areaQuery.js: deterministic URLs (quantized coordinates,
// stable parameter order, verbatim advertised datetimes) so equal-ish lines
// produce byte-identical URLs that recur in the server's URL cache — a cold
// S3-backed pvol render can take ~18 s, a repeat of the same URL ~0.2 s.
// Pure functions only: no fetch, no state, no OL imports — runnable in plain
// node for verification harnesses.

export const ENDPOINT_BASE = 'https://meteocore.app.meteo.fi/edr/collections';

// Endpoint coordinates round to this many decimals (~110 m in longitude at
// 60°N) — far below the server's ~500 m sampling step along the line, so the
// section is visually identical while near-equal drags converge on one URL.
const COORD_DECIMALS = 3;

// Frame times farther than this from every advertised time are "missing" —
// half the radar's 5-minute scan cadence.
const SNAP_TOLERANCE_MS = 150000;

// Duplicated from probe.js normalizeLonLat so this module stays free of UI
// imports (node-runnable). OL hands back longitudes outside [-180, 180]
// across world copies, and the EDR server rejects those with HTTP 400.
function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function clampLat(lat) {
  return Math.max(-90, Math.min(90, lat));
}

// [lon, lat] → normalized + quantized [lon, lat] safe to put in a query.
export function quantizeEndpoint([lon, lat]) {
  const f = 10 ** COORD_DECIMALS;
  return [
    Math.round(wrapLon(lon) * f) / f,
    Math.round(clampLat(lat) * f) / f,
  ];
}

// Deterministic trajectory URL. `isoAdvertised` must be a datetime string
// taken VERBATIM from the collection's .extent.temporal.values (the
// "+00:00" form) — the server 404s any datetime it did not advertise, so
// reformatting (e.g. via Date#toISOString) would break every request.
export function buildTrajectoryUrl(collection, parameter, isoAdvertised, [a, b]) {
  const c = (v) => v.toFixed(COORD_DECIMALS);
  const line = `LINESTRING(${c(a[0])} ${c(a[1])},${c(b[0])} ${c(b[1])})`;
  return `${ENDPOINT_BASE}/${encodeURIComponent(collection)}/trajectory`
    + '?f=CoverageJSON'
    + `&parameter-name=${encodeURIComponent(parameter)}`
    + `&datetime=${encodeURIComponent(isoAdvertised)}`
    + `&coords=${encodeURIComponent(line)}`;
}

// Collection metadata document (advertised times live in
// .extent.temporal.values). No `f=` parameter: the server rejects
// `f=application/json` here with HTTP 400 but defaults to JSON anyway.
export function collectionMetadataUrl(collection) {
  return `${ENDPOINT_BASE}/${encodeURIComponent(collection)}`;
}

// Collection document → { timesMs: ascending epoch ms, isoByMs: Map back to
// the verbatim advertised strings }. Returns empty containers when the
// document has no usable temporal extent.
export function parseTemporalValues(doc) {
  const values = doc && doc.extent && doc.extent.temporal
    && Array.isArray(doc.extent.temporal.values)
    ? doc.extent.temporal.values : [];
  const isoByMs = new Map();
  for (const iso of values) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) isoByMs.set(ms, iso);
  }
  const timesMs = [...isoByMs.keys()].sort((x, y) => x - y);
  return { timesMs, isoByMs };
}

// Nearest advertised time to frameMs within the tolerance, else null (the
// frame is simply missing — never invent a datetime the server didn't
// advertise). Equidistant ties break toward the earlier time.
export function snapToAdvertised(frameMs, timesMs, toleranceMs = SNAP_TOLERANCE_MS) {
  let best = null;
  let bestDelta = Infinity;
  for (const t of timesMs) {
    const delta = Math.abs(t - frameMs);
    if (delta < bestDelta) {
      best = t;
      bestDelta = delta;
    }
    if (t > frameMs + toleranceMs) break;
  }
  return bestDelta <= toleranceMs ? best : null;
}

// Great-circle meters between [lon, lat] pairs. Small local haversine so the
// module stays node-runnable (no ol/sphere); matches getDistance well within
// the section's ~500 m sampling step.
function haversineM(a, b) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// CoverageJSON Section → render-ready struct, or null when the response
// isn't the shape we expect. The server returns:
//   domain.axes.composite.values — [tISO, lon, lat] tuples along the line
//     (~500 m apart, server-chosen count)
//   domain.axes.z.values — heights in meters above the radar antenna
//     (~250 m steps, ascending)
//   ranges[parameter] — axisNames ["composite","z"], row-major values,
//     JSON null = no echo / outside coverage
// Output values are a Float32Array indexed [i * nZ + j] (i = point along the
// line, j = height bin) with NaN standing in for null.
export function parseSection(cov, parameter) {
  const axes = cov && cov.domain && cov.domain.axes;
  const points = axes && axes.composite && Array.isArray(axes.composite.values)
    ? axes.composite.values : null;
  const heights = axes && axes.z && Array.isArray(axes.z.values)
    ? axes.z.values : null;
  const range = cov && cov.ranges && cov.ranges[parameter];
  const raw = range && Array.isArray(range.values) ? range.values : null;
  if (!points || !heights || !raw) return null;
  const nPts = points.length;
  const nZ = heights.length;
  if (nPts === 0 || nZ === 0 || raw.length !== nPts * nZ) return null;

  const distancesKm = new Float64Array(nPts);
  for (let i = 1; i < nPts; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    distancesKm[i] = distancesKm[i - 1]
      + haversineM([prev[1], prev[2]], [cur[1], cur[2]]) / 1000;
  }

  const values = new Float32Array(nPts * nZ);
  let allNull = true;
  for (let k = 0; k < raw.length; k += 1) {
    const v = raw[k];
    if (v == null) {
      values[k] = NaN;
    } else {
      values[k] = v;
      allNull = false;
    }
  }

  return {
    nPts,
    nZ,
    heights: Float64Array.from(heights),
    distancesKm,
    totalKm: distancesKm[nPts - 1],
    values,
    allNull,
  };
}

// Disk-served single-site variant of an S3-backed pvol collection name, or
// null when the name doesn't follow the fi/dk pvol pattern (Estonian
// ee-radar-volume-* collections fall through and are used as-is). Same
// pattern as resolveProduct in src/radarSite.js applies to WMS layer names —
// whether the variant actually exists is the caller's isLayerAdvertised
// check, exactly like there.
export function singleVariantOf(collection) {
  const m = /^([a-z]{2})-radar-pvol-([a-z0-9]+)$/.exec(collection || '');
  return m ? `${m[1]}-radar-single-${m[2]}-pvol-${m[2]}` : null;
}
