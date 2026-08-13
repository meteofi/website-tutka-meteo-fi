// Regenerate src/data/airfields-finland.geojson from the Finnish eAIP.
//
//   node scripts/fetch-airfields.mjs              # current AIRAC cycle
//   node scripts/fetch-airfields.mjs --limit 5    # smoke test, writes nothing
//   node scripts/fetch-airfields.mjs --cycle "003-2026_2026_06_11"
//
// Fintraffic publishes the eAIP as a website, not as data — there is no GeoJSON,
// no API and no bulk download — so this parses the HTML. That is inherently
// brittle, and the answer to brittleness here is not cleverness but noise: every
// step below states what it expected, and the script REFUSES TO WRITE if
// anything looks wrong. A silently short or silently stale aerodrome file is far
// worse than a failed run, because nothing downstream would ever notice.
//
// WHY THE eAIP AND NOT openAIP. openAIP publishes the same aerodromes as proper
// GeoJSON and carries more per field (runways, frequencies, elevations), but it
// records no AIRAC cycle at all: its Finnish aerodromes were last touched
// between 2022 and 2024, and its airspace is largely a June 2025 snapshot. The
// eAIP is the authority, it moves on the 28-day AIRAC cycle, and this script
// pins the output to the cycle it came from.
//
// STRUCTURE OF THE SOURCE, as measured on 2026-08-13:
//
//   https://www.ais.fi/eaip/                       index of every AIRAC cycle,
//                                                  one folder each, named
//                                                  "…_YYYY_MM_DD" by effective
//                                                  date. The newest folder whose
//                                                  date has arrived is the
//                                                  currently effective cycle.
//   <cycle>/eAIP/menu.html                         8.8 MB table of contents; the
//                                                  only place the per-aerodrome
//                                                  filenames are listed
//   "EF-AD 2 <ICAO> - <NAME> 1-en-GB.html"         one page per aerodrome,
//                                                  370 kB for a grass strip and
//                                                  1.9 MB for Helsinki-Vantaa
//   AD 2.2 item 1, "ARP"                           the aerodrome reference point,
//                                                  as DDMMSS N / DDDMMSS E
//   AD 2.2 item 3, "ELEV / REF T / MEAN LOW T"     aerodrome elevation, published
//                                                  in feet ("180 FT / 23° C / NIL")
//
// AD 2 IS AERODROMES; AD 3 IS HELIPORTS. The index at AD 1.3 lists both and
// marks which section each belongs to. Only AD 2 is taken, which is why this
// produces ~80 features rather than the ~100 openAIP reports for Finland: the
// difference is almost entirely hospital helipads.

/* eslint-disable no-await-in-loop, no-cond-assign, no-console --
   A generator script, not app code: it retries sequentially on purpose, walks
   regex matches with exec, and its whole user interface is stdout. */

import { writeFile } from 'node:fs/promises';

const ROOT = 'https://www.ais.fi/eaip/';
const OUT = new URL('../src/data/airfields-finland.geojson', import.meta.url);

// Fetched in parallel, but gently: this is a public authority's web server
// publishing a legal document, not an API, and one regeneration should not look
// like a scrape.
const CONCURRENCY = 4;
const RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Sanity bounds. Finland including Åland, with room to spare. An ARP outside
// this is a parse that has locked onto the wrong number — a runway bearing, a
// frequency — rather than a real aerodrome somewhere surprising.
const BOUNDS = {
  minLon: 19.0, maxLon: 32.0, minLat: 59.0, maxLat: 70.5,
};

// If a cycle ever yields fewer than this, something has changed in the source
// and the output should not be trusted. 80 in the 2026-08-06 cycle.
const MIN_AERODROMES = 60;

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const limit = Number(argValue('--limit')) || 0;

async function fetchText(url, what) {
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const resp = await fetch(url, {
        headers: {
          // Identify the tool rather than pretending to be a browser.
          'User-Agent': 'tutka.meteo.fi airfield generator (+https://tutka.meteo.fi)',
          Accept: 'text/html',
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (err) {
      lastError = err;
      if (attempt < RETRIES) {
        await new Promise((r) => { setTimeout(r, RETRY_DELAY_MS * attempt); });
      }
    }
  }
  throw new Error(`${what}: ${lastError.message}\n  ${url}`);
}

// Each path segment is encoded separately: cycle folders contain spaces, and so
// do the aerodrome filenames. Those filenames are used EXACTLY as the table of
// contents gives them — some carry a double space ("EF-AD  2 EFAA …") and
// others a single one, so anything that tidied the whitespace would 404.
const cycleBaseUrl = (folder) => `${ROOT}${encodeURIComponent(folder)}/eAIP/`;

// The currently effective cycle: the newest folder whose effective date has
// arrived. Not simply the newest folder — the eAIP publishes the next cycle in
// advance, so at any time the top of that list may be a future one.
async function resolveCycle(explicit) {
  const html = await fetchText(ROOT, 'AIRAC cycle index');
  const cycles = [];
  // Hrefs look like "06 AUG 2026_2026_08_06\index.html" — a Windows-style
  // separator — so both slashes are accepted.
  const re = /href="([^"]*?_(\d{4})_(\d{2})_(\d{2}))[\\/]index\.html"/gi;
  let m;
  while ((m = re.exec(html))) {
    cycles.push({ folder: m[1], date: `${m[2]}-${m[3]}-${m[4]}` });
  }
  if (!cycles.length) {
    throw new Error(
      `No AIRAC cycle folders found at ${ROOT}. The index format has changed; `
      + 'this script cannot tell which cycle it would be reading.',
    );
  }
  cycles.sort((a, b) => (a.date < b.date ? 1 : -1));
  if (explicit) {
    const found = cycles.find((c) => c.folder === explicit);
    if (!found) throw new Error(`Cycle "${explicit}" not listed at ${ROOT}`);
    return found;
  }
  const today = new Date().toISOString().slice(0, 10);
  const effective = cycles.find((c) => c.date <= today);
  if (!effective) throw new Error(`Every listed cycle is in the future (today ${today})`);
  const ahead = cycles.filter((c) => c.date > today);
  if (ahead.length) {
    console.log(`  next cycle already published: ${ahead[ahead.length - 1].date}`);
  }
  return effective;
}

// The table of contents is the only place the per-aerodrome filenames appear.
// Only the English pages, and only AD 2 — AD 3 is heliports.
function parseMenu(html) {
  const re = /href='(EF-AD\s+2\s+([A-Z]{4})\s+-\s+(.*?)\s+1-en-GB\.html)#/g;
  const found = new Map();
  let m;
  while ((m = re.exec(html))) {
    if (!found.has(m[2])) found.set(m[2], { icao: m[2], name: m[3].trim(), file: m[1] });
  }
  return [...found.values()].sort((a, b) => a.icao.localeCompare(b.icao));
}

const stripTags = (html) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

// DDMMSS[.s] -> decimal degrees.
function dms(value, hemisphere, degreeDigits) {
  const deg = Number(value.slice(0, degreeDigits));
  const min = Number(value.slice(degreeDigits, degreeDigits + 2));
  const sec = Number(value.slice(degreeDigits + 2));
  const dec = deg + min / 60 + sec / 3600;
  return 'SW'.includes(hemisphere) ? -dec : dec;
}

// The aerodrome reference point out of one AD 2 page.
//
// The page is bilingual and the label differs by language ("ARP coordinates and
// site at AD" / "Mittapisteen (ARP) sijainti"), but both contain "ARP" and the
// value cell follows immediately. So: find each mention of ARP and take the
// first coordinate pair close after it. Every other coordinate on the page —
// thresholds, navaids, taxiway holding points — is further down and behind a
// different label, and the bounds check catches it if that ever stops being so.
function parseArp(html, icao) {
  const text = stripTags(html);
  const coord = /(\d{6}(?:\.\d+)?)([NS])\s+(\d{7}(?:\.\d+)?)([EW])/;
  let from = 0;
  for (;;) {
    const at = text.indexOf('ARP', from);
    if (at < 0) break;
    // 400 characters is comfortably past the label cell and its markup but
    // nowhere near the next table row.
    const window = text.slice(at, at + 400);
    const m = window.match(coord);
    if (m) {
      const lat = dms(m[1], m[2], 2);
      const lon = dms(m[3], m[4], 3);
      if (lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon
        && lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat) {
        return [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
      }
      throw new Error(
        `${icao}: ARP parsed as ${lat}, ${lon}, which is outside Finland. `
        + 'The value cell is probably no longer the one after the ARP label.',
      );
    }
    from = at + 3;
  }
  throw new Error(`${icao}: no ARP coordinate found on its AD 2 page`);
}

// Aerodrome elevation, from AD 2.2 item 3. Published in feet, and kept in feet:
// that is the unit the AIP states it in and the one an aerodrome's elevation is
// quoted in everywhere else, so converting here would only invite the reader to
// wonder what was rounded.
//
// Unlike the ARP this is not fatal when missing — an aerodrome without a stated
// elevation is a gap in the source, not a broken parse — but the caller counts
// them, because a sudden crop of them IS a broken parse.
function parseElevation(html) {
  const text = stripTags(html);
  const at = text.search(/ELEV\s*\/\s*REF\s*T/i);
  if (at < 0) return null;
  const m = text.slice(at, at + 200).match(/(-?\d+(?:\.\d+)?)\s*(FT|M)\b/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  // Metres appear nowhere in the current cycle, but the field is free text and
  // one day might: converting is safer than silently mixing units.
  return Math.round(m[2].toUpperCase() === 'M' ? value / 0.3048 : value);
}

async function mapWithConcurrency(items, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

const cycle = await resolveCycle(argValue('--cycle'));
console.log(`AIRAC cycle: ${cycle.folder}  (effective ${cycle.date})`);

const base = cycleBaseUrl(cycle.folder);
const menu = await fetchText(`${base}menu.html`, 'eAIP table of contents');
let aerodromes = parseMenu(menu);
console.log(`  AD 2 aerodromes listed: ${aerodromes.length}`);

if (!limit && aerodromes.length < MIN_AERODROMES) {
  throw new Error(
    `Only ${aerodromes.length} aerodromes found in the table of contents, expected at `
    + `least ${MIN_AERODROMES}. The menu's link format has probably changed — refusing `
    + 'to overwrite the bundled file with a short list.',
  );
}
if (limit) {
  aerodromes = aerodromes.slice(0, limit);
  console.log(`  --limit ${limit}: parsing ${aerodromes.length}, nothing will be written`);
}

let done = 0;
const features = await mapWithConcurrency(aerodromes, async (ad) => {
  const html = await fetchText(base + encodeURIComponent(ad.file), `${ad.icao} AD 2 page`);
  const coordinates = parseArp(html, ad.icao);
  const elevationFt = parseElevation(html);
  done += 1;
  if (done % 20 === 0) console.log(`  …${done}/${aerodromes.length}`);
  return {
    type: 'Feature',
    // `icao` is what the map labels with at a distance, `name` once there is
    // room for it, and `elevationFt` is carried for whatever wants it next.
    properties: {
      icao: ad.icao,
      name: ad.name,
      ...(elevationFt === null ? {} : { elevationFt }),
    },
    geometry: { type: 'Point', coordinates },
  };
});

const withElevation = features.filter((f) => f.properties.elevationFt !== undefined).length;
if (!limit && withElevation < features.length * 0.9) {
  throw new Error(
    `Only ${withElevation} of ${features.length} aerodromes yielded an elevation. `
    + 'AD 2.2 item 3 has probably changed shape — refusing to write a file that '
    + 'is mostly missing it.',
  );
}

const out = {
  type: 'FeatureCollection',
  metadata: {
    source: `${ROOT}${cycle.folder}/eAIP/`,
    airacCycle: cycle.folder,
    // The date this data legally took effect, not the date it was downloaded —
    // which is the whole reason for preferring the eAIP over a dataset that
    // records neither.
    effective: cycle.date,
    generated: new Date().toISOString().slice(0, 10),
    attribution: 'Aerodromes © Fintraffic ANS / Finnish eAIP',
    note: 'Not for navigation. Aerodrome reference points only, from AD 2.2; '
      + 'consult the current AIP and NOTAMs for flight planning.',
  },
  features,
};

if (limit) {
  console.log(JSON.stringify(out.features.map((f) => ({
    ...f.properties, at: f.geometry.coordinates,
  })), null, 1));
  console.log('\n--limit run: not written');
} else {
  await writeFile(OUT, JSON.stringify(out));
  console.log(`airfields: ${features.length} aerodromes -> ${(JSON.stringify(out).length / 1024).toFixed(0)} kB`);
  console.log(`  effective ${cycle.date} (${cycle.folder}), ${withElevation} with elevation`);
}
