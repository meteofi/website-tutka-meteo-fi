// Pure helpers for the particle layer's vector field (src/particles/): the
// EDR Grid CoverageJSON → a regular lon/lat grid of east/north m/s components,
// then that grid → the RGBA8 bytes the particle shaders sample. No fetch, no
// OpenLayers, no DOM — plain node runs this, and scripts/test-wind-field.mjs
// pins the rules below because every one of them fails silently: a flipped row
// order draws a perfectly plausible wind that blows the wrong way.
//
// One wire shape for two sources. Model wind (ECMWF IFS 10u/10v, the first
// iteration) and, once MeteoCore serves it, radar precipitation motion
// (motion_u / motion_v on the nowcast collection) both arrive as a `Grid`
// domain with a regular x (longitude) and y (latitude) axis and one NdArray
// per component. Everything here is written against that shape, not against
// either collection.
//
// Measured against the live server (noaa-gfs area query, 2026-09-08 — the
// ecmwf-ifs area query answered 502 that day, the grid engine is the same):
//   - axes.x / axes.y carry explicit `values`, ascending, 0.25° apart
//   - ranges.<param> is { axisNames: ['y','x'], shape: [ny, nx], values }
//     — y OUTER, so consecutive values run along a row of constant latitude
//   - values are floats or null (null = no data, e.g. outside the model's
//     domain)
//   - a 25° × 16° box (6 400 points × 2 params) is 236 kB raw / 23 kB gzipped
// CoverageJSON also allows the `{ start, stop, num }` axis form and other
// axis orders; both are handled so a server-side change cannot silently
// invert the field.

// Explicit .js extension, unlike the rest of src/: webpack resolves either
// form, but bare node does not guess, and this module is meant to be runnable
// from scripts/test-wind-field.mjs (the seriesFetch.js precedent). Do not
// "tidy" it away.
// eslint-disable-next-line import/extensions
import { polygonWkt } from '../edr/areaQuery.js';

// Deterministic URL for one field: sorted parameter names, the model step
// VERBATIM from the collection metadata (never a rounded local guess — the
// crossSection.js lesson: an off-grid datetime is a 404, and an omitted one
// defeats every cache), polygon corners on the shared 0.5° grid.
export function buildGridUrl(endpoint, bounds, params, timeIso) {
  const names = [...params].sort().join(',');
  return `${endpoint}?f=CoverageJSON`
    + `&parameter-name=${encodeURIComponent(names)}`
    + `&datetime=${encodeURIComponent(timeIso)}`
    + `&coords=${encodeURIComponent(polygonWkt(bounds))}`;
}

// Collection metadata → the advertised time steps, ascending, each kept as
// the server's own string (what goes back out in `datetime=`) plus its epoch.
export function parseTemporalValues(collectionJson) {
  const values = collectionJson && collectionJson.extent && collectionJson.extent.temporal
    && Array.isArray(collectionJson.extent.temporal.values)
    ? collectionJson.extent.temporal.values : [];
  const out = [];
  for (const iso of values) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) out.push({ iso, ms });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

// The advertised step nearest to `targetMs` — the field the animation window
// shows. Beyond either end of the run the nearest end is used, so a window
// that has slid ahead of the latest step keeps the latest field instead of
// going blank. A tie goes to the later step (the more recent forecast).
export function pickFieldTime(values, targetMs) {
  if (!values || values.length === 0 || !Number.isFinite(targetMs)) return null;
  let best = values[0];
  let bestDist = Math.abs(values[0].ms - targetMs);
  for (let i = 1; i < values.length; i++) {
    const d = Math.abs(values[i].ms - targetMs);
    if (d <= bestDist) {
      best = values[i];
      bestDist = d;
    }
  }
  return best;
}

// A CoverageJSON axis in either of its forms → an explicit value array, or
// null when it is neither.
function axisValues(axis) {
  if (!axis) return null;
  if (Array.isArray(axis.values)) return axis.values;
  if (Number.isFinite(axis.start) && Number.isFinite(axis.stop) && Number.isInteger(axis.num)) {
    const n = axis.num;
    if (n < 1) return null;
    if (n === 1) return [axis.start];
    const step = (axis.stop - axis.start) / (n - 1);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = axis.start + i * step;
    return out;
  }
  return null;
}

// Spacing of a regular axis, or null when the axis has fewer than two points
// or is not regular (a texture can only hold a regular grid).
function regularStep(values) {
  if (values.length < 2) return null;
  const step = (values[values.length - 1] - values[0]) / (values.length - 1);
  if (!Number.isFinite(step) || step === 0) return null;
  const tol = Math.abs(step) * 1e-3;
  for (let i = 1; i < values.length; i++) {
    if (Math.abs(values[i] - values[i - 1] - step) > tol) return null;
  }
  return step;
}

// One NdArray → a reader `(iy, ix) => value` honouring its axisNames, or null
// when the array cannot be read as a (y, x) grid of the expected size. Extra
// axes (t, z, …) are accepted only at length 1 — one field per document.
function gridReader(range, nx, ny) {
  if (!range || !Array.isArray(range.values)) return null;
  const names = Array.isArray(range.axisNames) ? range.axisNames : ['y', 'x'];
  const shape = Array.isArray(range.shape) ? range.shape : [ny, nx];
  if (names.length !== shape.length) return null;
  let strideX = 0;
  let strideY = 0;
  let stride = 1;
  for (let k = names.length - 1; k >= 0; k--) {
    const len = shape[k];
    if (names[k] === 'x') {
      if (len !== nx) return null;
      strideX = stride;
    } else if (names[k] === 'y') {
      if (len !== ny) return null;
      strideY = stride;
    } else if (len !== 1) {
      return null;
    }
    stride *= len;
  }
  if (!strideX || !strideY || range.values.length !== stride) return null;
  const { values } = range;
  return (iy, ix) => values[iy * strideY + ix * strideX];
}

// Grid coverage → { nx, ny, lon0, lat0, dLon, dLat, u, v, valid } with the
// rows normalised to ASCENDING latitude (row 0 = south) and the columns to
// ascending longitude, whatever order the server used — the shaders assume
// exactly that, and lon0/lat0 are the CENTRE of cell (0, 0). Returns null for
// anything that is not a readable two-component grid (the caller then keeps
// the previous field on screen, the StickyImageWMS philosophy).
export function parseGridCoverage(json, uName, vName) {
  if (!json || json.type !== 'Coverage' || !json.domain) return null;
  if (json.domain.domainType !== 'Grid') return null;
  const axes = json.domain.axes || {};
  const xs = axisValues(axes.x);
  const ys = axisValues(axes.y);
  if (!xs || !ys) return null;
  const dx = regularStep(xs);
  const dy = regularStep(ys);
  if (dx == null || dy == null) return null;
  const nx = xs.length;
  const ny = ys.length;
  const readU = gridReader(json.ranges && json.ranges[uName], nx, ny);
  const readV = gridReader(json.ranges && json.ranges[vName], nx, ny);
  if (!readU || !readV) return null;
  const flipX = dx < 0;
  const flipY = dy < 0;
  const u = new Float32Array(nx * ny);
  const v = new Float32Array(nx * ny);
  const valid = new Uint8Array(nx * ny);
  for (let row = 0; row < ny; row++) {
    const iy = flipY ? ny - 1 - row : row;
    for (let col = 0; col < nx; col++) {
      const ix = flipX ? nx - 1 - col : col;
      const a = readU(iy, ix);
      const b = readV(iy, ix);
      const i = row * nx + col;
      if (typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)) {
        u[i] = a;
        v[i] = b;
        valid[i] = 1;
      }
    }
  }
  return {
    nx,
    ny,
    lon0: flipX ? xs[nx - 1] : xs[0],
    lat0: flipY ? ys[ny - 1] : ys[0],
    dLon: Math.abs(dx),
    dLat: Math.abs(dy),
    u,
    v,
    valid,
  };
}

// Field → RGBA8 texture bytes. R/G hold the east/north components mapped from
// [-range, +range] onto [0, 255] (a symmetric range so calm is the same byte
// on both channels); B is reserved for the radar source's quality mask; A is
// 255 where the cell has data and 0 where it does not — the shaders treat a
// sample under 0.5 as "no field here" and let the particle die, which is what
// keeps particles out of a masked region instead of smearing its edge inward.
// Cells without data carry the calm byte in R/G so bilinear filtering across a
// mask edge biases toward stillness rather than toward garbage.
//
// 8 bits over ±range (range ≥ 1 m/s, typically 15–30) is 0.1–0.25 m/s per
// step: far below anything a moving particle shows. Bytes rather than half
// floats because RGBA8 samples LINEAR on every WebGL2 device, whereas
// half-float filtering is the driver-dependent path the interpolator already
// has to work around.
export function encodeField(field) {
  const n = field.nx * field.ny;
  let range = 1;
  for (let i = 0; i < n; i++) {
    if (field.valid[i]) {
      const m = Math.max(Math.abs(field.u[i]), Math.abs(field.v[i]));
      if (m > range) range = m;
    }
  }
  const data = new Uint8Array(n * 4);
  const scale = 255 / (2 * range);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (field.valid[i]) {
      data[o] = Math.round((field.u[i] + range) * scale);
      data[o + 1] = Math.round((field.v[i] + range) * scale);
      data[o + 3] = 255;
    } else {
      data[o] = 128;
      data[o + 1] = 128;
    }
  }
  return { data, range };
}

// Byte → m/s, the shader's decode in JS for the test and for any readout.
export function decodeComponent(byte, range) {
  return (byte / 255) * 2 * range - range;
}
