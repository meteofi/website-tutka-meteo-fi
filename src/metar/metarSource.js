// Fetching METAR from MET Norway.
//
// WHY NOT aviationweather.gov, which the user first suggested and which is the
// obvious source: it sends NO `Access-Control-Allow-Origin` header at all.
// Verified from a third-party origin so it is CORS rather than our own CSP —
// a browser simply cannot read it, whatever we put in connect-src. Its JSON is
// already decoded, which is a real loss; a MeteoCore proxy would recover that
// and is the natural follow-up.
//
// api.met.no answers with `access-control-allow-origin: *`, needs no key, and
// returns ~24 h of reports per station in one 2.4 kB request. That history is
// what makes clock-following free: scrubbing the radar back an hour is a lookup,
// not a fetch.
//
// One request per station, so the fleet costs ~24 requests. MET Norway asks that
// clients identify themselves; a browser cannot set User-Agent, so the Origin
// header does that for us. Requests are spaced rather than fired at once, which
// is both politer and avoids a burst of 24 connections on a phone.

import { parseMetarFeed } from './metarParse';

const ENDPOINT = 'https://api.met.no/weatherapi/tafmetar/1.0/metar';

// Reports land at :20 and :50. Polling every 5 minutes finds a new one within a
// few minutes of publication without asking 24 times an hour for nothing.
const REFRESH_MS = 5 * 60 * 1000;

// Spacing between station requests on a full refresh.
const STAGGER_MS = 120;

export default function createMetarSource({ fetchImpl = fetch } = {}) {
  // icao -> parsed reports, oldest first
  const byStation = new Map();
  let stations = [];
  let timer = 0;
  let running = false;
  let onUpdate = () => {};

  async function fetchStation(icao) {
    try {
      const resp = await fetchImpl(`${ENDPOINT}?icao=${encodeURIComponent(icao)}`);
      if (!resp.ok) return;
      const text = await resp.text();
      const reports = parseMetarFeed(text);
      // An aerodrome with no METAR service answers 200 with nothing usable —
      // EFHF (closed) and EFNU do exactly this. Leaving the key absent is what
      // keeps them off the map.
      if (reports.length) byStation.set(icao, reports);
    } catch (err) {
      // Keep whatever that station had. A refresh failing is not a reason to
      // blank a plot that was correct a minute ago.
    }
  }

  async function refresh() {
    if (running) return;
    running = true;
    // Sequential with a small gap rather than Promise.all: 24 simultaneous
    // requests from a phone is a burst nobody benefits from. The serialisation
    // IS the feature here, which is what the rule below would otherwise flag.
    /* eslint-disable no-await-in-loop */
    for (const icao of stations) {
      await fetchStation(icao);
      await new Promise((r) => { setTimeout(r, STAGGER_MS); });
    }
    /* eslint-enable no-await-in-loop */
    running = false;
    onUpdate();
  }

  return {
    // `list` is the ICAO codes to watch — for us, the bundled aerodromes.
    start(list, updateCallback) {
      stations = list;
      onUpdate = typeof updateCallback === 'function' ? updateCallback : () => {};
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = 0;
      byStation.clear();
    },

    // Every station that has usable reports, as [icao, reports] pairs.
    entries() {
      return [...byStation.entries()];
    },
  };
}
