// EDR observation data client — PR 1 of the obs WMS→EDR migration.
//
// Fetches multi-station surface observations from the MeteoCore EDR `fmi-obs`
// collection (area queries, CoverageJSON) and snaps them onto the app's
// 13-frame animation window. Pure data module: no OpenLayers, no DOM — the
// browser and plain node can both run it, so it is verifiable stand-alone
// before any UI exists. The vector obs layer (PR 2) is the intended caller.
//
// Live-server facts this module is built around (measured 2026-07-11):
//   - The server rejects area queries matching more than ~500 stations with
//     HTTP 500 (a whole-Finland polygon already fails). Until the server
//     grows a graceful `limit`, requests are chunked into latitude bands
//     small enough to stay under the cap, and clamped to the Nordic coverage
//     box the WMS layer usefully showed anyway.
//   - Responses carry RAW per-station observation times — no resampling.
//     Time axes within one response ranged from 1 to 59 points per hour, and
//     ~53% of values are null. Snapping to animation frames happens here:
//     for each frame T take the newest value in [T - tolerance, T], which is
//     exactly the WMS layer's `TIME=PT10M/{ISO}` interval semantics.
//   - Exact-instant datetime queries match almost nothing (only stations
//     reporting at that second), so window growth is fetched as short ranges.
//
// Request shaping mirrors the GetMap rules (CLAUDE.md "MeteoCore
// request-shape rules") in spirit: the queried polygon is the viewport plus
// a pan buffer, its corners quantized to a coarse grid so equal-ish views
// produce byte-identical URLs, and parameter order is stable. Re-fetching is
// range-based per chunk, so a 60 s refresh that nudges the window forward
// costs one small delta request instead of a full window.

const ENDPOINT = 'https://meteocore.app.meteo.fi/edr/collections/fmi-obs/area';

// Snap tolerance = the WMS obs layer's accumulation window (TIME=PT10M/…):
// a station labels a frame only with an observation at most this old.
export const SNAP_TOLERANCE_MS = 10 * 60 * 1000;

// Polygon corners snap outward to this grid (degrees) so panning away and
// back reuses URLs, and all users converge on the same server queries.
const GRID_DEG = 0.5;

// Pan buffer per side, as a fraction of the viewport span. Same rationale as
// requestShape.js MIN_RATIO: a casual pan must not leave the fetched area.
const MARGIN_FRACTION = 0.25;

// Station-cap guards (tunables, pending the server-side `limit` fix):
// chunks of ≤60 deg² stayed well under the ~500-station cap at Finnish
// density (half-Finland ≈ 49 deg² → ~250 stations), and 4 chunks bound the
// total work at synoptic zooms. Beyond that the box shrinks around the view
// center — matching how far out the label raster was readable anyway.
const CHUNK_MAX_AREA_DEG2 = 60;
const MAX_CHUNKS = 4;

// v1 coverage parity: the WMS layer only usefully showed Fennoscandia + the
// Baltics; the EDR collection is global (WIGOS), where an unclamped synoptic
// viewport would blow the station cap. Grid-aligned lon/lat bounds.
const COVERAGE_BBOX = [4, 53, 42, 72];

// WMS sublayer id → EDR parameter list. The `observation:*` ids are kept
// verbatim so ACTIVE_LAYERS persistence, canonical URLs and the product menu
// need no migration. `observation:wind` maps to two parameters — one EDR
// request carries both (speed labels + direction for future barbs).
// `observation:lightning` is deliberately absent: it is not in the fmi-obs
// collection and stays on WMS.
export const OBS_PRODUCTS = {
  'observation:airtemperature': { params: ['air_temperature'] },
  'observation:dew_point_temperature': { params: ['dew_point_temperature'] },
  'observation:relative_humidity': { params: ['relative_humidity'] },
  'observation:wind_speed': { params: ['wind_speed'] },
  'observation:wind_speed_of_gust': { params: ['wind_speed_of_gust'] },
  'observation:wind': { params: ['wind_speed', 'wind_from_direction'] },
};

// Duplicated from probe.js normalizeLonLat so this module stays free of UI
// imports (node-runnable); the planned src/edr/ helper extraction unifies
// them. OL hands back longitudes outside [-180, 180] across world copies.
function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function clampLat(lat) {
  return Math.max(-90, Math.min(90, lat));
}

const floorToMinute = (ms) => Math.floor(ms / 60000) * 60000;
const ceilToMinute = (ms) => Math.ceil(ms / 60000) * 60000;

// ms epoch → 'YYYY-MM-DDTHH:mm:ssZ' (no milliseconds — smaller, stable URLs).
function isoSeconds(ms) {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

const areaDeg2 = ([w, s, e, n]) => Math.max(0, e - w) * Math.max(0, n - s);

// Viewport extent [lonMin, latMin, lonMax, latMax] (degrees) → the quantized,
// buffered, coverage-clamped query bounds, or null when the view doesn't
// touch the coverage box. Pure and deterministic: equal-ish views → equal
// bounds → recurring URLs (requestShape.js philosophy).
export function quantizedAreaBounds(viewExtent) {
  const [vw, vs, ve, vn] = viewExtent;
  let w = wrapLon(vw);
  let e = wrapLon(ve);
  // A view spanning the antimeridian (or ≥ a full world copy) degenerates
  // after wrapping; the coverage box is nowhere near it, so treat the wrap
  // ambiguity by falling back to the full coverage box clamp below.
  if (e <= w) { [w, e] = [COVERAGE_BBOX[0], COVERAGE_BBOX[2]]; }
  let s = clampLat(vs);
  let n = clampLat(vn);
  const marginLon = (e - w) * MARGIN_FRACTION;
  const marginLat = (n - s) * MARGIN_FRACTION;
  w -= marginLon; e += marginLon; s -= marginLat; n += marginLat;
  // Shrink around the view center while the box exceeds the chunked-request
  // budget (station-cap guard). Linear scale on both axes keeps the aspect.
  const maxArea = CHUNK_MAX_AREA_DEG2 * MAX_CHUNKS;
  const rawArea = (e - w) * (n - s);
  if (rawArea > maxArea) {
    const scale = Math.sqrt(maxArea / rawArea);
    const cx = (w + e) / 2;
    const cy = (s + n) / 2;
    const halfW = ((e - w) / 2) * scale;
    const halfH = ((n - s) / 2) * scale;
    w = cx - halfW; e = cx + halfW; s = cy - halfH; n = cy + halfH;
  }
  // Snap outward to the grid, then clamp to coverage (grid-aligned, so the
  // result stays on the grid and toFixed(1) below is lossless).
  w = Math.max(COVERAGE_BBOX[0], Math.floor(w / GRID_DEG) * GRID_DEG);
  s = Math.max(COVERAGE_BBOX[1], Math.floor(s / GRID_DEG) * GRID_DEG);
  e = Math.min(COVERAGE_BBOX[2], Math.ceil(e / GRID_DEG) * GRID_DEG);
  n = Math.min(COVERAGE_BBOX[3], Math.ceil(n / GRID_DEG) * GRID_DEG);
  if (e <= w || n <= s) return null;
  // The outward snap can re-inflate the box past the budget; trim whole grid
  // steps off the longer axis (alternating sides) until it holds. Stays
  // grid-aligned and deterministic, so URLs still recur.
  let flip = false;
  while ((e - w) * (n - s) > maxArea && e - w > GRID_DEG && n - s > GRID_DEG) {
    if (e - w >= n - s) {
      if (flip) w += GRID_DEG; else e -= GRID_DEG;
    } else if (flip) s += GRID_DEG; else n -= GRID_DEG;
    flip = !flip;
  }
  return [w, s, e, n];
}

// Split bounds into ≤ MAX_CHUNKS grid-aligned latitude bands of
// ≤ CHUNK_MAX_AREA_DEG2 each, so no single request risks the station cap and
// one failing band degrades that band only. Band edges are shared lines; a
// station exactly on one may appear in both bands and dedups by key on merge.
export function chunkBounds(bounds) {
  const [w, s, e, n] = bounds;
  const bandCount = Math.min(MAX_CHUNKS, Math.max(1, Math.ceil(areaDeg2(bounds) / CHUNK_MAX_AREA_DEG2)));
  const bandLat = Math.ceil((n - s) / bandCount / GRID_DEG) * GRID_DEG;
  const chunks = [];
  for (let s0 = s; s0 < n; s0 += bandLat) {
    chunks.push([w, s0, e, Math.min(n, s0 + bandLat)]);
  }
  return chunks;
}

// Deterministic query URL: sorted parameters, minute-aligned datetime range,
// one-decimal polygon coords (exact — corners live on the 0.5° grid).
export function buildAreaUrl(bounds, params, startMs, endMs) {
  const [w, s, e, n] = bounds;
  const c = (v) => v.toFixed(1);
  const poly = `POLYGON((${c(w)} ${c(s)},${c(e)} ${c(s)},${c(e)} ${c(n)},${c(w)} ${c(n)},${c(w)} ${c(s)}))`;
  const names = [...params].sort().join(',');
  const datetime = `${isoSeconds(startMs)}/${isoSeconds(endMs)}`;
  return `${ENDPOINT}?f=CoverageJSON`
    + `&parameter-name=${encodeURIComponent(names)}`
    + `&datetime=${encodeURIComponent(datetime)}`
    + `&coords=${encodeURIComponent(poly)}`;
}

// CoverageCollection → station records. One PointSeries coverage per
// station; the area response carries no station ids, so stations are keyed
// by rounded coordinates (~11 m — stable across responses). Null values
// (~53% of the payload) are dropped here so every stored series point is a
// real observation; series are kept ascending in time.
export function parseCoverageCollection(json, params) {
  const out = [];
  const coverages = json && Array.isArray(json.coverages) ? json.coverages : [];
  for (const cov of coverages) {
    const axes = cov && cov.domain && cov.domain.axes;
    const lon = axes && axes.x && Array.isArray(axes.x.values) ? axes.x.values[0] : null;
    const lat = axes && axes.y && Array.isArray(axes.y.values) ? axes.y.values[0] : null;
    const ts = axes && axes.t && Array.isArray(axes.t.values) ? axes.t.values : null;
    if (lon != null && lat != null && ts) {
      const times = ts.map((t) => new Date(t).getTime());
      const series = {};
      let hasAny = false;
      for (const param of params) {
        const range = cov.ranges && cov.ranges[param];
        const vs = range && Array.isArray(range.values) ? range.values : null;
        if (vs && vs.length === times.length) {
          const points = [];
          for (let i = 0; i < vs.length; i += 1) {
            if (vs[i] != null) points.push({ t: times[i], v: vs[i] });
          }
          if (points.length) {
            points.sort((a, b) => a.t - b.t);
            series[param] = points;
            hasAny = true;
          }
        }
      }
      if (hasAny) {
        out.push({
          key: `${lon.toFixed(4)}|${lat.toFixed(4)}`, lon, lat, series,
        });
      }
    }
  }
  return out;
}

// Snap one ascending series onto ascending frame times: for each frame, the
// newest observation in [frame - tolerance, frame], else NaN. Two-pointer,
// O(frames + points). Frame 0 can reach back before the window start — the
// fetch range below extends the query start by the tolerance for exactly
// this reason; the last frame gets NaN when a station's data lags more than
// the tolerance, which is the same gap the WMS raster showed.
export function snapSeriesToFrames(points, frameTimes, toleranceMs = SNAP_TOLERANCE_MS) {
  const values = new Float64Array(frameTimes.length).fill(NaN);
  let i = -1;
  for (let f = 0; f < frameTimes.length; f += 1) {
    const frame = frameTimes[f];
    while (i + 1 < points.length && points[i + 1].t <= frame) i += 1;
    if (i >= 0 && frame - points[i].t <= toleranceMs) values[f] = points[i].v;
  }
  return values;
}

// Merge a freshly parsed station list into a chunk's station map, replacing
// each station's series for the covered range: points older than rangeStart
// are kept from the previous store (delta fetches only carry the new tail),
// points inside the fetched range come from the new response.
function mergeStations(stationMap, fresh, rangeStartMs) {
  for (const station of fresh) {
    const prev = stationMap.get(station.key);
    if (prev) {
      for (const [param, points] of Object.entries(station.series)) {
        const old = prev.series[param] || [];
        const kept = old.filter((p) => p.t < rangeStartMs);
        prev.series[param] = kept.concat(points.filter((p) => p.t >= rangeStartMs));
      }
    } else {
      stationMap.set(station.key, station);
    }
  }
}

// Drop series points that fell behind the window (minus tolerance) so the
// store doesn't grow without bound while following.
function pruneStations(stationMap, keepFromMs) {
  for (const station of stationMap.values()) {
    for (const [param, points] of Object.entries(station.series)) {
      if (points.length && points[0].t < keepFromMs) {
        station.series[param] = points.filter((p) => p.t >= keepFromMs);
      }
    }
  }
}

// The stateful client. One instance per app (panes share it — same data
// feeds every pane's vector layer, the radarSiteSource pattern).
//
//   const client = createObsClient();
//   await client.ensureWindow({ viewExtent, product, startMs, endMs });
//   const rows = client.snapToFrames(frameTimes, product);
//
// ensureWindow is cheap to call repeatedly (every setTime): it no-ops when
// the quantized bounds, product and fetched range already cover the request,
// delta-fetches when only the window end moved forward, and refetches fully
// (aborting anything in flight) when the polygon or product changed. Chunks
// fetch in parallel and fail independently: a chunk that errors (e.g. the
// station cap) keeps its previous data and is retried on the next call,
// while the other bands stay live.
export function createObsClient({ fetchImpl } = {}) {
  const doFetch = fetchImpl || ((url, opts) => fetch(url, opts));
  // chunkKey → { bounds, startMs, endMs, stations: Map(stationKey → record) }
  let chunkStates = new Map();
  let boundsKey = null;
  let paramsKey = null;
  let controller = null;
  let inflight = null; // { key, promise }

  async function fetchChunk(state, startMs, endMs, signal, params) {
    const url = buildAreaUrl(state.bounds, params, startMs, endMs);
    const r = await doFetch(url, { signal });
    if (!r.ok) throw new Error(`EDR ${r.status}`);
    const fresh = parseCoverageCollection(await r.json(), params);
    mergeStations(state.stations, fresh, startMs);
    state.startMs = state.startMs == null ? startMs : Math.min(state.startMs, startMs);
    state.endMs = endMs;
  }

  async function run(key, params, fetchStartMs, fetchEndMs) {
    controller = typeof AbortController === 'undefined' ? null : new AbortController();
    const signal = controller ? controller.signal : undefined;
    const jobs = [];
    for (const state of chunkStates.values()) {
      const hasWindow = state.endMs != null && state.startMs <= fetchStartMs;
      if (!hasWindow || state.endMs < fetchEndMs) {
        // Extend forward from what this chunk already has; anything else
        // (fresh chunk, backward jump) fetches the full range.
        const deltaStart = hasWindow ? state.endMs : fetchStartMs;
        jobs.push(fetchChunk(state, deltaStart, fetchEndMs, signal, params));
      }
    }
    const results = await Promise.allSettled(jobs);
    for (const state of chunkStates.values()) pruneStations(state.stations, fetchStartMs);
    const failures = results.filter((res) => res.status === 'rejected');
    if (failures.length === results.length && results.length > 0) throw failures[0].reason;
    return failures.length;
  }

  function mergeView() {
    const merged = new Map();
    for (const state of chunkStates.values()) {
      for (const [k, station] of state.stations) {
        if (!merged.has(k)) merged.set(k, station);
      }
    }
    return merged;
  }

  return {
    // viewExtent: [lonMin, latMin, lonMax, latMax] in degrees (CRS84).
    // startMs/endMs: the animation window; the query start is extended by
    // the snap tolerance so frame 0 has its lookback data.
    async ensureWindow({
      viewExtent, product, startMs, endMs,
    }) {
      const spec = OBS_PRODUCTS[product];
      if (!spec) throw new Error(`unknown observation product: ${product}`);
      const bounds = quantizedAreaBounds(viewExtent);
      const fetchStartMs = floorToMinute(startMs - SNAP_TOLERANCE_MS);
      const fetchEndMs = ceilToMinute(endMs);
      if (!bounds) {
        chunkStates = new Map();
        boundsKey = null;
        return { stations: 0, failedChunks: 0 };
      }
      const bKey = bounds.join(',');
      const pKey = spec.params.join(',');
      if (bKey !== boundsKey || pKey !== paramsKey) {
        if (controller) controller.abort();
        inflight = null;
        boundsKey = bKey;
        paramsKey = pKey;
        chunkStates = new Map(chunkBounds(bounds).map((b) => [b.join(','), {
          bounds: b, startMs: null, endMs: null, stations: new Map(),
        }]));
      }
      const key = `${bKey}|${pKey}|${fetchStartMs}|${fetchEndMs}`;
      if (!inflight || inflight.key !== key) {
        const promise = run(key, spec.params, fetchStartMs, fetchEndMs)
          .finally(() => { if (inflight && inflight.key === key) inflight = null; });
        inflight = { key, promise };
      }
      const failedChunks = await inflight.promise;
      return { stations: mergeView().size, failedChunks };
    },

    // frameTimes (ms, ascending, typically the 13-frame window) →
    // [{ key, lon, lat, values: { param: Float64Array(frames) } }], NaN for
    // frames a station has no fresh-enough observation for.
    snapToFrames(frameTimes, product) {
      const spec = OBS_PRODUCTS[product];
      if (!spec) return [];
      const rows = [];
      for (const station of mergeView().values()) {
        const values = {};
        let hasAny = false;
        for (const param of spec.params) {
          const points = station.series[param];
          if (points && points.length) {
            values[param] = snapSeriesToFrames(points, frameTimes);
            hasAny = true;
          }
        }
        if (hasAny) {
          rows.push({
            key: station.key, lon: station.lon, lat: station.lat, values,
          });
        }
      }
      return rows;
    },

    abort() {
      if (controller) controller.abort();
      inflight = null;
    },

    clear() {
      this.abort();
      chunkStates = new Map();
      boundsKey = null;
      paramsKey = null;
    },
  };
}
