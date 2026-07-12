// EDR lightning data client — PR C of the lightning WMS→EDR migration
// (the wms-obs GeoServer that rendered observation:lightning is permanently
// offline). Fetches individual strike events from the MeteoCore EDR
// `fmi-lightning` collection and keeps a deduplicated, prunable store the
// vector lightning layer renders from. Pure data module: no OL, no DOM —
// node-runnable for the verification harness.
//
// Collection contract (server guide, deployed 2026-07-12; verified live):
//   - Area query ONLY — position/locations return 400 by design (there are
//     no stations), and there is no z axis.
//   - CoverageCollection of Point coverages, ONE strike per coverage,
//     ordered newest-first. Ranges are single-value NdArrays WITHOUT
//     `shape`/`axisNames` — only values[0] may be read. Values can be null.
//   - `coverages: []` with HTTP 200 is a normal "no strikes" answer, never
//     an error and never a retry trigger.
//   - Strikes are immutable and append-only: fetched ranges never change,
//     so range bookkeeping is exact and re-fetching covered ranges is waste.
//   - Budget: strikes × parameters ≤ 500k per response, HTTP 400 fast-fail.
//     A heavy storm hour over all of Finland is a few thousand strikes, so
//     viewport windows never approach it — but a 400 must NEVER be retried
//     verbatim (the identical query fails identically): the failing request
//     key is poisoned until the polygon or range changes.
//
// Request shaping shares ../edr/areaQuery.js with the obs client — the same
// quantized anchor polygons across collections, per the server guide.

import {
  quantizedAreaBounds as quantizedBoundsFor,
  buildAreaUrl as buildAreaUrlFor,
  floorToMinute,
  ceilToMinute,
} from '../edr/areaQuery';

const ENDPOINT = 'https://meteocore.app.meteo.fi/edr/collections/fmi-lightning/area';

// Detection-network coverage advertised by the collection (CRS84 w,s,e,n).
const COVERAGE_BBOX = [4, 54, 42, 72];

// Area budget = the whole coverage box (same reasoning as the obs client:
// a full-box window fetch sits far below the server's 500k-value budget —
// a 30k-strike storm night over the full box was ~62k values). Zoomed-out
// views show strikes across the whole coverage instead of a center-clamped
// square.
const MAX_AREA_DEG2 = (COVERAGE_BBOX[2] - COVERAGE_BBOX[0]) * (COVERAGE_BBOX[3] - COVERAGE_BBOX[1]);

// peak_current: kA, sign is polarity, |value| drives the symbol size.
// cloud_indicator: 0 = cloud-to-ground, 1 = intra-cloud (styled smaller).
// Position and time come free from the domain; requesting only these two
// keeps ~250k strikes of budget headroom per response.
const PARAMS = ['peak_current', 'cloud_indicator'];

export function quantizedLightningBounds(viewExtent) {
  return quantizedBoundsFor(viewExtent, { coverageBbox: COVERAGE_BBOX, maxAreaDeg2: MAX_AREA_DEG2 });
}

export function buildLightningUrl(bounds, startMs, endMs) {
  return buildAreaUrlFor(ENDPOINT, bounds, PARAMS, startMs, endMs);
}

// CoverageCollection → strike records. Dedup key is the (t, x, y) triple —
// the server's own uniqueness contract for strikes.
export function parseStrikes(json) {
  const out = [];
  const coverages = json && Array.isArray(json.coverages) ? json.coverages : [];
  for (const cov of coverages) {
    const axes = cov && cov.domain && cov.domain.axes;
    const lon = axes && axes.x && Array.isArray(axes.x.values) ? axes.x.values[0] : null;
    const lat = axes && axes.y && Array.isArray(axes.y.values) ? axes.y.values[0] : null;
    const t = axes && axes.t && Array.isArray(axes.t.values) ? axes.t.values[0] : null;
    if (lon != null && lat != null && t != null) {
      const tMs = new Date(t).getTime();
      const ranges = cov.ranges || {};
      const value = (param) => {
        const r = ranges[param];
        const v = r && Array.isArray(r.values) ? r.values[0] : null;
        return v == null ? NaN : v;
      };
      out.push({
        key: `${tMs}|${lon}|${lat}`,
        t: tMs,
        lon,
        lat,
        peakCurrent: value('peak_current'),
        cloud: value('cloud_indicator') === 1,
      });
    }
  }
  return out;
}

// The stateful client — one instance per app, shared by every pane's
// lightning layer (same pattern as the obs client).
//
//   const client = createLightningClient();
//   await client.ensureRange({ viewExtent, startMs, endMs }); // window + lookback
//   await client.pollLatest(Date.now());                      // live top-up
//   const strikes = client.all();                             // render from this
//
// ensureRange no-ops when the quantized bounds and fetched range already
// cover the request, extends forward with a delta fetch when only the end
// moved (window advance), and refetches fully when the polygon changed.
// pollLatest fetches newestSeen→now so the newest frame can show strikes
// fresher than the animation window's end.
export function createLightningClient({ fetchImpl } = {}) {
  const doFetch = fetchImpl || ((url, opts) => fetch(url, opts));
  const strikes = new Map(); // key → strike record
  let fetchBounds = null;
  let boundsKey = null;
  let fetchedStartMs = null;
  let fetchedEndMs = null;
  let newestSeenMs = null;
  let controller = null;
  let inflight = null; // { key, promise }
  let poisonedKey = null; // last request key that 400'd — never retried verbatim
  let revision = 0;

  function merge(fresh) {
    let added = 0;
    for (const strike of fresh) {
      if (!strikes.has(strike.key)) {
        strikes.set(strike.key, strike);
        added += 1;
      }
      if (newestSeenMs == null || strike.t > newestSeenMs) newestSeenMs = strike.t;
    }
    if (added > 0) revision += 1;
    return added;
  }

  async function fetchRange(startMs, endMs, signal) {
    const url = buildLightningUrl(fetchBounds, startMs, endMs);
    const r = await doFetch(url, { signal });
    if (!r.ok) {
      const err = new Error(`EDR ${r.status}`);
      err.status = r.status;
      throw err;
    }
    merge(parseStrikes(await r.json()));
    fetchedStartMs = fetchedStartMs == null ? startMs : Math.min(fetchedStartMs, startMs);
    fetchedEndMs = fetchedEndMs == null ? endMs : Math.max(fetchedEndMs, endMs);
  }

  function prune(keepFromMs) {
    let dropped = 0;
    for (const [key, strike] of strikes) {
      if (strike.t < keepFromMs) {
        strikes.delete(key);
        dropped += 1;
      }
    }
    if (dropped > 0) revision += 1;
  }

  // Runs `job` deduplicated on `key`: concurrent callers share one promise,
  // and a key that 400'd is skipped until the polygon/range changes.
  async function dedupedRun(key, job) {
    if (key === poisonedKey) return;
    if (!inflight || inflight.key !== key) {
      const promise = job()
        .catch((err) => {
          if (err && err.status === 400) poisonedKey = key;
          throw err;
        })
        .finally(() => { if (inflight && inflight.key === key) inflight = null; });
      inflight = { key, promise };
    }
    await inflight.promise;
  }

  return {
    // viewExtent: [lonMin, latMin, lonMax, latMax] degrees (CRS84).
    // startMs/endMs: the range the renderer needs (window start minus the
    // frame-slice lookback → window end). Caller computes the lookback.
    async ensureRange({ viewExtent, startMs, endMs }) {
      const bounds = quantizedLightningBounds(viewExtent);
      const fetchStartMs = floorToMinute(startMs);
      const fetchEndMs = ceilToMinute(endMs);
      if (!bounds) {
        strikes.clear();
        boundsKey = null;
        newestSeenMs = null;
        return { strikes: 0 };
      }
      const bKey = bounds.join(',');
      if (bKey !== boundsKey) {
        if (controller) controller.abort();
        inflight = null;
        poisonedKey = null;
        boundsKey = bKey;
        fetchBounds = bounds;
        fetchedStartMs = null;
        fetchedEndMs = null;
        newestSeenMs = null;
        strikes.clear();
      }
      const key = `${bKey}|${fetchStartMs}|${fetchEndMs}`;
      await dedupedRun(key, async () => {
        const covered = fetchedEndMs != null
          && fetchedStartMs <= fetchStartMs && fetchedEndMs >= fetchEndMs;
        if (!covered) {
          const extendsForward = fetchedEndMs != null
            && fetchedStartMs <= fetchStartMs && fetchedEndMs < fetchEndMs;
          const deltaStart = extendsForward ? fetchedEndMs : fetchStartMs;
          controller = typeof AbortController === 'undefined' ? null : new AbortController();
          await fetchRange(deltaStart, fetchEndMs, controller ? controller.signal : undefined);
        }
        prune(fetchStartMs);
      });
      return { strikes: strikes.size };
    },

    // Live top-up: fetch strikes newer than anything seen so far, up to
    // `nowMs`. Strikes land seconds behind wall clock, so a 30–60 s cadence
    // keeps the newest frame current. No-op until a range has been fetched.
    async pollLatest(nowMs) {
      if (fetchedEndMs == null || !fetchBounds) return 0;
      // Overlap one minute behind the watermark: the boundary strike is
      // re-returned and dedupes, nothing can slip between polls.
      const from = floorToMinute((newestSeenMs != null ? newestSeenMs : fetchedEndMs) - 60000);
      const to = ceilToMinute(nowMs);
      if (to <= from) return 0;
      const before = strikes.size;
      const key = `poll|${boundsKey}|${from}|${to}`;
      await dedupedRun(key, async () => {
        controller = typeof AbortController === 'undefined' ? null : new AbortController();
        await fetchRange(from, to, controller ? controller.signal : undefined);
      });
      return strikes.size - before;
    },

    // Current store as an array — the renderer filters by strike.t per frame.
    all() {
      return [...strikes.values()];
    },

    // Monotonic store version — compare across calls to skip rebuilding
    // derived state (features) when nothing changed.
    revision() {
      return revision;
    },

    abort() {
      if (controller) controller.abort();
      inflight = null;
    },

    clear() {
      this.abort();
      strikes.clear();
      boundsKey = null;
      fetchedStartMs = null;
      fetchedEndMs = null;
      newestSeenMs = null;
      poisonedKey = null;
    },
  };
}
