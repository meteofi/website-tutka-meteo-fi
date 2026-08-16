// Fetching METAR from MET Norway.
//
// WHY NOT aviationweather.gov, which is the obvious source: it sends NO
// `Access-Control-Allow-Origin` header at all. Verified from a third-party
// origin so it is CORS rather than our own CSP — a browser simply cannot read
// it, whatever we put in connect-src. Its JSON is already decoded, which is a
// real loss; a MeteoCore proxy would recover that and is the natural follow-up.
//
// api.met.no answers with `access-control-allow-origin: *`, needs no key, and
// returns ~24 h of reports per station. That history is what makes clock-
// following free: scrubbing the radar back an hour is a lookup, not a fetch.
//
// ONE REQUEST FOR THE WHOLE FLEET. `icao=` takes a comma-separated list —
// undocumented in the parameter table but verified live: all 80 bundled
// aerodromes in a single call, 59 kB, 816 ms, with every one of the 24 that
// report answering. (A repeated `icao=A&icao=B` is rejected with a 400; only
// the comma form works.) The first version asked per station, which meant 80
// requests every refresh — and 56 of those were for aerodromes that have no
// METAR service at all and answer with nothing, every five minutes, forever.
//
// After the first response the list narrows to the stations that actually
// replied, so the steady-state request carries 24 codes rather than 80.
//
// MET Norway asks that clients identify themselves; a browser cannot set
// User-Agent, so the Origin header does that for us.

import { parseMetarFeed } from './metarParse';

const ENDPOINT = 'https://api.met.no/weatherapi/tafmetar/1.0/metar';

// Reports land at :20 and :50. Polling every 5 minutes finds a new one within a
// few minutes of publication without asking twelve times an hour for nothing.
const REFRESH_MS = 5 * 60 * 1000;

// A ceiling on the codes per request, so a future station list an order of
// magnitude longer degrades into a handful of calls rather than one URL the
// server may refuse. 80 is verified to work; this leaves room.
const MAX_CODES_PER_REQUEST = 100;

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export default function createMetarSource({ fetchImpl = fetch } = {}) {
  // icao -> parsed reports, oldest first
  const byStation = new Map();
  // Every station we were asked to watch, and — once we know — the subset that
  // actually answers. Kept apart so a station that is merely down for a while
  // is not struck off permanently: `wanted` is what we narrow back to if the
  // reporting set ever empties.
  let wanted = [];
  let reporting = null;
  let timer = 0;
  let running = false;
  let onUpdate = () => {};

  async function fetchBatch(codes) {
    const resp = await fetchImpl(`${ENDPOINT}?icao=${codes.join(',')}`);
    if (!resp.ok) throw new Error(`METAR ${resp.status}`);
    const text = await resp.text();
    // The response is one flat stream of reports for every station asked for,
    // each line starting with its own ICAO — so the parser needs no help
    // splitting it, and a station that has nothing simply contributes no lines.
    const reports = parseMetarFeed(text);
    const grouped = new Map();
    reports.forEach((report) => {
      if (!grouped.has(report.icao)) grouped.set(report.icao, []);
      grouped.get(report.icao).push(report);
    });
    return grouped;
  }

  async function refresh() {
    if (running) return;
    running = true;
    const codes = reporting && reporting.length ? reporting : wanted;
    try {
      const batches = await Promise.all(
        chunk(codes, MAX_CODES_PER_REQUEST).map((part) => fetchBatch(part)),
      );
      const answered = [];
      batches.forEach((grouped) => {
        grouped.forEach((reports, icao) => {
          byStation.set(icao, reports);
          answered.push(icao);
        });
      });
      // Narrow to what replied. Only ever narrows from the full list — an
      // aerodrome with no METAR service (EFHF, closed; EFNU) is asked once and
      // then left alone, rather than re-asked every five minutes forever.
      if (answered.length) reporting = answered;
    } catch (err) {
      // Keep whatever was already held. A refresh failing is not a reason to
      // blank plots that were correct a minute ago.
    }
    running = false;
    onUpdate();
  }

  return {
    // `list` is the ICAO codes to watch — for us, the bundled aerodromes.
    start(list, updateCallback) {
      wanted = list;
      reporting = null;
      onUpdate = typeof updateCallback === 'function' ? updateCallback : () => {};
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = 0;
      byStation.clear();
      reporting = null;
    },

    // Every station that has usable reports, as [icao, reports] pairs.
    entries() {
      return [...byStation.entries()];
    },
  };
}
