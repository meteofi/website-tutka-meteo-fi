// EDR observation data client — PR 1 of the obs WMS→EDR migration.
//
// Fetches multi-station surface observations from the MeteoCore EDR `fmi-obs`
// collection (area queries, CoverageJSON) and snaps them onto the app's
// 13-frame animation window. Pure data module: no OpenLayers, no DOM — the
// browser and plain node can both run it, so it is verifiable stand-alone
// before any UI exists. The vector obs layer (PR 2) is the intended caller.
//
// Live-server facts this module is built around (measured 2026-07-11):
//   - Server request-size limits (deployed 2026-07-11): a 500,000-value
//     budget (stations × parameters × timesteps), a 20,000 station×parameter
//     fan-out bound per area query, and HTTP 400 fast-fails whose message
//     names the dimension to narrow — never 5xx. A whole-viewport window
//     fetch (~500 stations × ≤7 params × ~13 values per param-hour) sits far
//     below both, so one request covers the viewport; the polygon is still
//     clamped to the Nordic coverage box (WMS-parity) and an area budget so
//     world-scale zooms can't approach the fan-out bound.
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
// produce byte-identical URLs, and parameter order is stable (shared EDR
// helpers in ../edr/areaQuery.js). Re-fetching is range-based, so a 60 s
// refresh that nudges the window forward costs one small delta request
// instead of a full window.

import {
  quantizedAreaBounds as quantizedBoundsFor,
  buildAreaUrl as buildAreaUrlFor,
  floorToMinute,
  ceilToMinute,
} from '../edr/areaQuery';

const ENDPOINT = 'https://meteocore.app.meteo.fi/edr/collections/fmi-obs/area';

// Snap tolerance = the WMS obs layer's accumulation window (TIME=PT10M/…):
// a station labels a frame only with an observation at most this old.
export const SNAP_TOLERANCE_MS = 10 * 60 * 1000;

// Coverage box (Fennoscandia + Baltics — parity with what the old raster
// usefully showed; the EDR collection itself is global WIGOS). Grid-aligned
// lon/lat bounds.
const COVERAGE_BBOX = [4, 53, 42, 72];

// Polygon area budget (deg²): the ENTIRE coverage box fits in one request
// under the server's limits — measured 2026-07-12: 2 065 stations report
// within an hour over the full box, i.e. ~12.4k station×param fan-out at
// all six parameters (bound 20k) and ~60k values (budget 500k), 128 KB
// gzipped in ~1.3 s. So the budget equals the box: zoomed-out views get
// observations across the whole coverage instead of a center-clamped square
// (the 240 deg² clamp this replaces dated from the old 500-station server
// cap). The shrink-around-center logic still guards world-scale views whose
// center is far outside coverage.
const MAX_AREA_DEG2 = (COVERAGE_BBOX[2] - COVERAGE_BBOX[0]) * (COVERAGE_BBOX[3] - COVERAGE_BBOX[1]);

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

// Obs-specific bindings of the shared area-query helpers (../edr/areaQuery):
// same signatures this module always exported, so the client below and the
// verification harness are unchanged.
export function quantizedAreaBounds(viewExtent) {
  return quantizedBoundsFor(viewExtent, { coverageBbox: COVERAGE_BBOX, maxAreaDeg2: MAX_AREA_DEG2 });
}

export function buildAreaUrl(bounds, params, startMs, endMs) {
  return buildAreaUrlFor(ENDPOINT, bounds, params, startMs, endMs);
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
// feeds every pane's vector layer, the radarSiteSource pattern). `products`
// is a list because split-screen panes can show different obs products; one
// request set fetches the union of their parameters.
//
//   const client = createObsClient();
//   await client.ensureWindow({ viewExtent, products: [product], startMs, endMs });
//   const rows = client.snapToFrames(frameTimes, product);
//
// ensureWindow is cheap to call repeatedly (every setTime): it no-ops when
// the quantized bounds, product and fetched range already cover the request,
// delta-fetches when only the window end moved forward, and refetches fully
// (aborting anything in flight) when the polygon or product changed. A fetch
// that errors keeps the previous store and is retried on the next call.
export function createObsClient({ fetchImpl } = {}) {
  const doFetch = fetchImpl || ((url, opts) => fetch(url, opts));
  const stations = new Map(); // stationKey → record
  let fetchBounds = null;
  let fetchedStartMs = null;
  let fetchedEndMs = null;
  let boundsKey = null;
  let paramsKey = null;
  let controller = null;
  let inflight = null; // { key, promise }
  // Bumped whenever fetched data lands in the store — callers compare it to
  // decide whether derived state (rendered features) needs a rebuild.
  let revision = 0;

  async function run(params, fetchStartMs, fetchEndMs) {
    const covered = fetchedEndMs != null && fetchedStartMs <= fetchStartMs && fetchedEndMs >= fetchEndMs;
    if (!covered) {
      // Extend forward from what the store already has; anything else
      // (fresh store, backward jump) fetches the full range.
      const extendsForward = fetchedEndMs != null && fetchedStartMs <= fetchStartMs && fetchedEndMs < fetchEndMs;
      const deltaStart = extendsForward ? fetchedEndMs : fetchStartMs;
      controller = typeof AbortController === 'undefined' ? null : new AbortController();
      const url = buildAreaUrl(fetchBounds, params, deltaStart, fetchEndMs);
      const r = await doFetch(url, { signal: controller ? controller.signal : undefined });
      if (!r.ok) throw new Error(`EDR ${r.status}`);
      const fresh = parseCoverageCollection(await r.json(), params);
      mergeStations(stations, fresh, deltaStart);
      fetchedStartMs = fetchedStartMs == null ? deltaStart : Math.min(fetchedStartMs, deltaStart);
      fetchedEndMs = fetchEndMs;
      revision += 1;
    }
    pruneStations(stations, fetchStartMs);
  }

  return {
    // viewExtent: [lonMin, latMin, lonMax, latMax] in degrees (CRS84).
    // products: `observation:*` ids whose parameter union to fetch.
    // startMs/endMs: the animation window; the query start is extended by
    // the snap tolerance so frame 0 has its lookback data.
    async ensureWindow({
      viewExtent, products, startMs, endMs,
    }) {
      const params = [...new Set(products.flatMap((product) => {
        const spec = OBS_PRODUCTS[product];
        if (!spec) throw new Error(`unknown observation product: ${product}`);
        return spec.params;
      }))].sort();
      const bounds = quantizedAreaBounds(viewExtent);
      const fetchStartMs = floorToMinute(startMs - SNAP_TOLERANCE_MS);
      const fetchEndMs = ceilToMinute(endMs);
      if (!bounds) {
        stations.clear();
        boundsKey = null;
        return { stations: 0 };
      }
      const bKey = bounds.join(',');
      const pKey = params.join(',');
      if (bKey !== boundsKey || pKey !== paramsKey) {
        if (controller) controller.abort();
        inflight = null;
        boundsKey = bKey;
        paramsKey = pKey;
        fetchBounds = bounds;
        fetchedStartMs = null;
        fetchedEndMs = null;
        stations.clear();
      }
      const key = `${bKey}|${pKey}|${fetchStartMs}|${fetchEndMs}`;
      if (!inflight || inflight.key !== key) {
        const promise = run(params, fetchStartMs, fetchEndMs)
          .finally(() => { if (inflight && inflight.key === key) inflight = null; });
        inflight = { key, promise };
      }
      await inflight.promise;
      return { stations: stations.size };
    },

    // frameTimes (ms, ascending, typically the 13-frame window) →
    // [{ key, lon, lat, values: { param: Float64Array(frames) } }], NaN for
    // frames a station has no fresh-enough observation for.
    snapToFrames(frameTimes, product) {
      const spec = OBS_PRODUCTS[product];
      if (!spec) return [];
      const rows = [];
      for (const station of stations.values()) {
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

    // Monotonic data-store version — compare across calls to skip rebuilding
    // derived state when nothing new arrived.
    revision() {
      return revision;
    },

    abort() {
      if (controller) controller.abort();
      inflight = null;
    },

    clear() {
      this.abort();
      stations.clear();
      fetchedStartMs = null;
      fetchedEndMs = null;
      boundsKey = null;
      paramsKey = null;
    },
  };
}
