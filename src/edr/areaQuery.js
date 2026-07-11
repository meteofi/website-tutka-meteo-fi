// Shared helpers for MeteoCore OGC EDR *area* queries (CoverageJSON).
// Extracted from src/obs/edrObservations.js so every EDR-backed layer
// (observations, lightning, …) shapes its requests identically — the same
// quantized polygons across collections and users maximize server-side
// efficiency and make equal-ish views produce byte-identical URLs (the
// GetMap request-shaping philosophy of src/wms/requestShape.js, applied to
// EDR). Pure functions only: no fetch, no state, no OL imports — runnable
// in plain node for verification harnesses.

// Polygon corners snap outward to this grid (degrees) so panning away and
// back reuses URLs, and all users converge on the same server queries.
export const GRID_DEG = 0.5;

// Pan buffer per side, as a fraction of the viewport span. Same rationale as
// requestShape.js MIN_RATIO: a casual pan must not leave the fetched area.
const MARGIN_FRACTION = 0.25;

// Duplicated from probe.js normalizeLonLat so this module stays free of UI
// imports (node-runnable). OL hands back longitudes outside [-180, 180]
// across world copies.
function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function clampLat(lat) {
  return Math.max(-90, Math.min(90, lat));
}

export const floorToMinute = (ms) => Math.floor(ms / 60000) * 60000;
export const ceilToMinute = (ms) => Math.ceil(ms / 60000) * 60000;

// ms epoch → 'YYYY-MM-DDTHH:mm:ssZ' (no milliseconds — smaller, stable URLs).
export function isoSeconds(ms) {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

// Viewport extent [lonMin, latMin, lonMax, latMax] (degrees) → the quantized,
// buffered query bounds, clamped to the collection's coverage box and an
// area budget, or null when the view doesn't touch the coverage at all.
// Pure and deterministic: equal-ish views → equal bounds → recurring URLs.
//
//   coverageBbox — grid-aligned [w, s, e, n] the collection covers; requests
//     outside it would only burn the server's fan-out budget.
//   maxAreaDeg2 — polygon area budget keeping worst-case responses well
//     inside the server's 500k-value / 20k-fan-out limits. Beyond it the box
//     shrinks around the view center — matching how far out point symbols
//     are readable anyway.
export function quantizedAreaBounds(viewExtent, { coverageBbox, maxAreaDeg2 }) {
  const [vw, vs, ve, vn] = viewExtent;
  let w = wrapLon(vw);
  let e = wrapLon(ve);
  // A view spanning the antimeridian (or ≥ a full world copy) degenerates
  // after wrapping; the coverage box is nowhere near it, so treat the wrap
  // ambiguity by falling back to the full coverage box clamp below.
  if (e <= w) { [w, e] = [coverageBbox[0], coverageBbox[2]]; }
  let s = clampLat(vs);
  let n = clampLat(vn);
  const marginLon = (e - w) * MARGIN_FRACTION;
  const marginLat = (n - s) * MARGIN_FRACTION;
  w -= marginLon; e += marginLon; s -= marginLat; n += marginLat;
  // Shrink around the view center while the box exceeds the area budget.
  // Linear scale on both axes keeps the aspect.
  const rawArea = (e - w) * (n - s);
  if (rawArea > maxAreaDeg2) {
    const scale = Math.sqrt(maxAreaDeg2 / rawArea);
    const cx = (w + e) / 2;
    const cy = (s + n) / 2;
    const halfW = ((e - w) / 2) * scale;
    const halfH = ((n - s) / 2) * scale;
    w = cx - halfW; e = cx + halfW; s = cy - halfH; n = cy + halfH;
  }
  // Snap outward to the grid, then clamp to coverage (grid-aligned, so the
  // result stays on the grid and toFixed(1) below is lossless).
  w = Math.max(coverageBbox[0], Math.floor(w / GRID_DEG) * GRID_DEG);
  s = Math.max(coverageBbox[1], Math.floor(s / GRID_DEG) * GRID_DEG);
  e = Math.min(coverageBbox[2], Math.ceil(e / GRID_DEG) * GRID_DEG);
  n = Math.min(coverageBbox[3], Math.ceil(n / GRID_DEG) * GRID_DEG);
  if (e <= w || n <= s) return null;
  // The outward snap can re-inflate the box past the budget; trim whole grid
  // steps off the longer axis (alternating sides) until it holds. Stays
  // grid-aligned and deterministic, so URLs still recur.
  let flip = false;
  while ((e - w) * (n - s) > maxAreaDeg2 && e - w > GRID_DEG && n - s > GRID_DEG) {
    if (e - w >= n - s) {
      if (flip) w += GRID_DEG; else e -= GRID_DEG;
    } else if (flip) s += GRID_DEG; else n -= GRID_DEG;
    flip = !flip;
  }
  return [w, s, e, n];
}

// Deterministic query URL: sorted parameters, minute-aligned datetime range,
// one-decimal polygon coords (exact — corners live on the 0.5° grid).
export function buildAreaUrl(endpoint, bounds, params, startMs, endMs) {
  const [w, s, e, n] = bounds;
  const c = (v) => v.toFixed(1);
  const poly = `POLYGON((${c(w)} ${c(s)},${c(e)} ${c(s)},${c(e)} ${c(n)},${c(w)} ${c(n)},${c(w)} ${c(s)}))`;
  const names = [...params].sort().join(',');
  const datetime = `${isoSeconds(startMs)}/${isoSeconds(endMs)}`;
  return `${endpoint}?f=CoverageJSON`
    + `&parameter-name=${encodeURIComponent(names)}`
    + `&datetime=${encodeURIComponent(datetime)}`
    + `&coords=${encodeURIComponent(poly)}`;
}
