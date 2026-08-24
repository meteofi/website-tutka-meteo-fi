// Regenerate the bundled aerodrome snapshots from the national eAIPs:
// src/data/airfields-finland.geojson and src/data/airfields-france.geojson.
//
//   node scripts/fetch-airfields.mjs                    # both countries
//   node scripts/fetch-airfields.mjs --country fr       # one of them
//   node scripts/fetch-airfields.mjs --limit 5          # smoke test, writes nothing
//   node scripts/fetch-airfields.mjs --country fi --cycle "003-2026_2026_06_11"
//
// Neither authority publishes the eAIP as data — no GeoJSON, no API, no bulk
// download — so this parses the HTML. That is inherently brittle, and the answer
// to brittleness here is not cleverness but noise: every step below states what
// it expected, and the script REFUSES TO WRITE if anything looks wrong. A
// silently short or silently stale aerodrome file is far worse than a failed
// run, because nothing downstream would ever notice.
//
// The two eAIPs share a publishing standard and nothing else: different cycle
// indices, different filenames, different coordinate notation, different label
// languages. So the machinery below — fetching, retries, concurrency, the
// refuse-to-write checks, the output shape — is shared, and each country
// contributes an adapter that knows how to find its cycle, list its aerodromes
// and read one of its pages.
//
// WHY THE eAIP AND NOT openAIP. openAIP publishes the same aerodromes as proper
// GeoJSON and carries more per field (runways, frequencies, elevations), but it
// records no AIRAC cycle at all: its Finnish aerodromes were last touched
// between 2022 and 2024, and its airspace is largely a June 2025 snapshot. The
// eAIP is the authority, it moves on the 28-day AIRAC cycle, and this script
// pins the output to the cycle it came from.
//
// STRUCTURE OF THE FINNISH SOURCE, as measured on 2026-08-13:
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
//   AD 2.11 item 1, "Associated MET Office"        the aerodrome's meteorological
//                                                  office, or NIL when it has none
//
// STRUCTURE OF THE FRENCH SOURCE, as measured on 2026-08-21:
//
//   .../media/dvd/eAIP_DD_MON_YYYY/FRANCE/         one folder per cycle, named
//   AIRAC-YYYY-MM-DD/html/                         by effective date twice over.
//                                                  There is NO index of cycles:
//                                                  the vAIP portal is a JS app
//                                                  with no crawlable listing, so
//                                                  the folder is derived from the
//                                                  AIRAC series (28 days) and
//                                                  probed. Only the current and
//                                                  previous cycles stay online —
//                                                  June 2026 was already gone
//                                                  while August was current.
//   eAIP/FR-menu-fr-FR.html                        2.3 MB table of contents. The
//                                                  aerodromes sit under three
//                                                  AD 2 subsections (civil IFR,
//                                                  civil VFR with heliport IFR
//                                                  procedures, military), and
//                                                  every entry carries its ICAO
//                                                  and name in gaixm spans
//   eAIP/FR-AD-2.<ICAO>-fr-FR.html                 one page per aerodrome,
//                                                  190 kB for a small field and
//                                                  2.1 MB for Paris-CDG
//   AD 2.2 item 1, "Position GEO ARP"              the reference point, in a
//                                                  different notation from
//                                                  Finland's: DD°MM'SS"N
//   AD 2.2 item 3, "Reference elevation"           in feet, followed by the geoid
//                                                  undulation — take the first
//   AD 2.11 item 1, "Associated MET Office"        as in Finland, but the pages
//                                                  are bilingual, so the English
//                                                  label is present too
//
// The French pages are the -fr-FR edition because that is what SIA links to, and
// they carry both languages anyway; there is no monolingual English edition to
// prefer the way there is in Finland.
//
// WHICH AERODROMES ISSUE A METAR. AD 2.11 item 1 names the responsible MET
// office, or says NIL. In Finland that is an exact predictor: measured over all
// 80 aerodromes on 2026-08-16, precisely the 24 with a named office answer with
// a METAR from MET Norway, and precisely the 56 with NIL do not — no
// disagreement in either direction. GEN 3.5 corroborates the mechanism: METAR
// is issued every 30 minutes in Finland, by these offices ("LEN Etelä / LEN
// South" and "LEN Pohjoinen / LEN North").
//
// France is NOT that, and it was measured before being believed. Of its 141
// AD 2 aerodromes on 2026-08-21, 135 name a MET office but only 85 of those
// answer met.no with a METAR — and LFMC, which names none, answers anyway. The
// AIP is wrong in both directions here, so following it would ask about 50
// stations that never reply AND permanently hide one that does.
//
// So the flag is a per-country policy rather than a transcription: Finland
// carries it where AD 2.11 says so, because there it is exact; France carries it
// on every AD 2 aerodrome, because there it predicts nothing and the METAR
// source narrows to the stations that actually replied on its first answer.
// Being generous costs one wasted code in one request; being strict costs a
// station that is never asked about again.
//
// AD 2.11 is still parsed for France — a cycle where it stops parsing at all is
// a broken run, and the count is printed — it just does not decide the flag.
//
// AD 2 IS AERODROMES; AD 3 IS HELIPORTS. The index at AD 1.3 lists both and
// marks which section each belongs to. Only AD 2 is taken, which is why this
// produces ~80 features rather than the ~100 openAIP reports for Finland: the
// difference is almost entirely hospital helipads.

/* eslint-disable no-await-in-loop, no-cond-assign, no-console --
   A generator script, not app code: it retries sequentially on purpose, walks
   regex matches with exec, and its whole user interface is stdout. */

import { writeFile } from 'node:fs/promises';

const FI_ROOT = 'https://www.ais.fi/eaip/';
const FR_ROOT = 'https://www.sia.aviation-civile.gouv.fr/media/dvd/';
// openAIP's public export bucket, the same one the airspace snapshots come from
// (scripts/fetch-airspace.mjs): no key, no signature, one file per country.
const OPENAIP_ROOT = 'https://s3.openaip.net/openaip-system-exports/';

// Fetched in parallel, but gently: these are public authorities' web servers
// publishing a legal document, not an API, and one regeneration should not look
// like a scrape.
const CONCURRENCY = 4;
const RETRIES = 3;
const RETRY_DELAY_MS = 2000;

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

async function fetchJson(url, what) {
  const text = await fetchText(url, what);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${what}: response was not JSON (${err.message})\n  ${url}`);
  }
}

// Each path segment is encoded separately: cycle folders contain spaces, and so
// do the aerodrome filenames. Those filenames are used EXACTLY as the table of
// contents gives them — some carry a double space ("EF-AD  2 EFAA …") and
// others a single one, so anything that tidied the whitespace would 404.
const finnishCycleBaseUrl = (folder) => `${FI_ROOT}${encodeURIComponent(folder)}/eAIP/`;

// The currently effective cycle: the newest folder whose effective date has
// arrived. Not simply the newest folder — the eAIP publishes the next cycle in
// advance, so at any time the top of that list may be a future one.
async function resolveFinnishCycle(explicit) {
  const ROOT = FI_ROOT;
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
function parseFinnishMenu(html) {
  const re = /href='(EF-AD\s+2\s+([A-Z]{4})\s+-\s+(.*?)\s+1-en-GB\.html)#/g;
  const found = new Map();
  let m;
  while ((m = re.exec(html))) {
    if (!found.has(m[2])) found.set(m[2], { icao: m[2], name: m[3].trim(), file: m[1] });
  }
  return [...found.values()].sort((a, b) => a.icao.localeCompare(b.icao));
}

// France's table of contents names each aerodrome in a pair of gaixm spans —
// the ICAO code and the name — inside the heading anchor for its page. The
// heading's own id carries the section: AD-2.eAIP.<ICAO> for an aerodrome,
// AD-3.eAIP.<ICAO> for a heliport, so requiring the AD-2 form leaves the
// heliports out without needing to slice the document into sections.
//
// All three AD 2 subsections are taken — civil IFR, the one civil VFR field
// with heliport IFR procedures, and the military aerodromes. A military field
// is a place with a runway and a METAR, which is what this layer is about.
function parseFrenchMenu(html) {
  const re = new RegExp(
    'id="AD-2\\.eAIP\\.([A-Z0-9]{4})"[\\s\\S]{0,600}?'
    + 'ADHP\\.CODE_ICAO[^>]*>([A-Z0-9]{4})</span>\\s*'
    + '<span[^>]*ADHP\\.TXT_NAME[^>]*>([^<]*)</span>',
    'g',
  );
  const found = new Map();
  let m;
  while ((m = re.exec(html))) {
    if (!found.has(m[2])) {
      found.set(m[2], {
        icao: m[2],
        name: m[3].trim(),
        file: `FR-AD-2.${m[2]}-fr-FR.html`,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.icao.localeCompare(b.icao));
}

const stripTags = (html) => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&#160;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

// France publishes no index of cycles — the vAIP portal is a JavaScript
// application with nothing crawlable behind it — but it does not need one: AIRAC
// effective dates are a fixed 28-day series, and the folder name is that date
// written twice. So the date is derived and the folder PROBED, which has the
// useful property of also detecting the case this must not get wrong: a cycle
// whose date has arrived but which SIA has not published yet. Then the previous
// cycle is still the effective one, and stepping back finds it.
//
// Only the current and previous cycles stay online — June 2026 had already been
// removed while August was current — so two steps back is generous.
const AIRAC_ANCHOR = Date.UTC(2026, 7, 6); // 2026-08-06, verified live
const AIRAC_DAYS = 28;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const frenchCycleBaseUrl = (date) => {
  const [y, m, d] = date.split('-');
  return `${FR_ROOT}eAIP_${d}_${MONTHS[Number(m) - 1]}_${y}/FRANCE/AIRAC-${date}/html/eAIP/`;
};

async function resolveFrenchCycle(explicit) {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  let candidates;
  if (explicit) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicit)) {
      throw new Error(`--cycle for France is an AIRAC effective date, e.g. 2026-08-06 (got "${explicit}")`);
    }
    candidates = [explicit];
  } else {
    const today = Date.UTC(...new Date().toISOString().slice(0, 10).split('-')
      .map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
    const elapsed = Math.floor((today - AIRAC_ANCHOR) / (AIRAC_DAYS * 86400000));
    candidates = [0, 1, 2].map(
      (back) => iso(AIRAC_ANCHOR + (elapsed - back) * AIRAC_DAYS * 86400000),
    );
  }
  for (const date of candidates) {
    const resp = await fetch(`${frenchCycleBaseUrl(date)}FR-menu-fr-FR.html`, {
      method: 'HEAD',
      headers: { 'User-Agent': 'tutka.meteo.fi airfield generator (+https://tutka.meteo.fi)' },
    }).catch(() => null);
    if (resp && resp.ok) return { folder: date, date };
    console.log(`  ${date} not published yet, trying the cycle before it`);
  }
  throw new Error(
    `None of ${candidates.join(', ')} is published at ${FR_ROOT}. Either the URL `
    + 'shape has changed or the AIRAC series has drifted from its anchor; check '
    + 'https://www.sia.aviation-civile.gouv.fr/ before trusting this script again.',
  );
}

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
function parseFinnishArp(text, icao, country) {
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
      return withinBounds(dms(m[3], m[4], 3), dms(m[1], m[2], 2), icao, country);
    }
    from = at + 3;
  }
  throw new Error(`${icao}: no ARP coordinate found on its AD 2 page`);
}

// France writes the same point in a different hand: DD°MM'SS"N, in AD 2.2 item
// 1 behind a label that is French only ("Position GEO ARP" — the English column
// of that row holds the ARP's site description instead). One label, one window,
// and the same bounds check standing behind it.
function parseFrenchArp(text, icao, country) {
  const at = text.indexOf('Position GEO ARP');
  if (at < 0) throw new Error(`${icao}: no "Position GEO ARP" row on its AD 2 page`);
  const points = [...text.slice(at, at + 300).matchAll(/(\d{2,3})°(\d{2})'(\d{2}(?:\.\d+)?)"([NSEW])/g)];
  const decimal = (m) => {
    const value = Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600;
    return 'SW'.includes(m[4]) ? -value : value;
  };
  const lat = points.find((m) => 'NS'.includes(m[4]));
  const lon = points.find((m) => 'EW'.includes(m[4]));
  if (!lat || !lon) throw new Error(`${icao}: no ARP coordinate pair after the "Position GEO ARP" label`);
  return withinBounds(decimal(lon), decimal(lat), icao, country);
}

// A parsed point, or a loud failure. An ARP outside the country is a parse that
// has locked onto the wrong number — a runway bearing, a navaid, a frequency —
// rather than a real aerodrome somewhere surprising.
function withinBounds(lon, lat, icao, country) {
  const b = country.bounds;
  if (lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat) {
    return [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];
  }
  throw new Error(
    `${icao}: ARP parsed as ${lat}, ${lon}, which is outside ${country.name}. `
    + 'The value cell is probably no longer the one after the ARP label.',
  );
}

// Does this aerodrome have a meteorological office, and therefore a METAR?
// AD 2.11 item 1 is the responsible office or NIL. Read from the ENGLISH label
// backwards, since the value sits between the Finnish and English labels of the
// same row, and matching on the Finnish one alone would break if the page ever
// went single-language.
function parseFinnishMetOffice(text) {
  const at = text.indexOf('AD 2.11 METEOROLOGICAL INFORMATION PROVIDED');
  if (at < 0) return false;
  const m = /Vastuussa oleva lentosääkeskus\s+(.*?)\s+Associated MET Office/.exec(
    text.slice(at, at + 400),
  );
  if (!m) return false;
  const office = m[1].trim();
  return office !== '' && office.toUpperCase() !== 'NIL';
}

// The same question of a French page. Here the row prints both labels together
// and the value follows them, so the office is what sits between the English
// label and the next numbered item.
function parseFrenchMetOffice(text) {
  const at = text.indexOf('Renseignements météorologiques');
  if (at < 0) return false;
  const m = /Centre MET associé \/ Associated MET Office\s+(.*?)\s+2\s+Horaires/.exec(
    text.slice(at, at + 2000),
  );
  if (!m) return false;
  const office = m[1].trim();
  return office !== '' && office.toUpperCase() !== 'NIL';
}

// Aerodrome elevation, from AD 2.2 item 3. Published in feet, and kept in feet:
// that is the unit the AIP states it in and the one an aerodrome's elevation is
// quoted in everywhere else, so converting here would only invite the reader to
// wonder what was rounded.
//
// Unlike the ARP this is not fatal when missing — an aerodrome without a stated
// elevation is a gap in the source, not a broken parse — but the caller counts
// them, because a sudden crop of them IS a broken parse.
function parseElevationAfter(text, label) {
  const at = text.search(label);
  if (at < 0) return null;
  const m = text.slice(at, at + 200).match(/(-?\d+(?:\.\d+)?)\s*(FT|M)\b/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  // Metres appear nowhere in the current cycles, but the field is free text and
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

// One aerodrome, in the shape every snapshot carries.
//
// `icao` is what the map labels with at a distance, `name` once there is room
// for it, and `elevationFt` is carried for whatever wants it next. `metar` is
// set only on the aerodromes worth asking MET Norway about, so its absence is
// the common case and no file carries a crowd of `metar: false`.
function feature(icao, name, coordinates, elevFt, metar, arp) {
  return {
    type: 'Feature',
    properties: {
      icao,
      name,
      ...(elevFt === null || elevFt === undefined ? {} : { elevationFt: elevFt }),
      ...(metar ? { metar: true } : {}),
      // Whether this position is the aerodrome's PUBLISHED reference point or
      // openAIP's idea of where the aerodrome is. Only France carries both kinds
      // in one file, and the difference is a median 154 m — nothing on a map at
      // this layer's zooms, everything if anyone ever reads a coordinate out of
      // this file for something else.
      ...(arp ? { arp: true } : {}),
    },
    geometry: { type: 'Point', coordinates },
  };
}

// openAIP states elevation in metres (unit 0) or feet (unit 1); this app keeps
// feet, the unit an aerodrome's elevation is quoted in everywhere else.
//
// Worth knowing before trusting it: measured against the French eAIP, openAIP's
// elevations agree to within a foot for most fields but run tens of feet low at
// the big ones — Paris-CDG 331 against a published 392, Zurich 1378 against
// 1416 — and disagree by more than 20 ft on 27% of French aerodromes.
function openAipElevationFt(elevation) {
  if (!elevation || !Number.isFinite(elevation.value)) return null;
  return Math.round(elevation.unit === 0 ? elevation.value / 0.3048 : elevation.value);
}

// openAIP airport `type` -> what it is, and whether this app calls it an
// aerodrome. The enum carries no legend in the export, so it was read off the
// names in the Swiss and French exports, and the two agree on every value
// present in both (counts CH/FR, 2026-08-25):
//
//   0  LSZC BUOCHS, LSGS SION / LFXA AMBERIEU      5 / 12   civil + military
//   1  LSPA AMLIKON "R", LSZJ COURTELARY           9 /  7   glider site
//   2  LSZF BIRRFELD / LFOI ABBEVILLE             35 / 384  civil airfield
//   3  LSZH ZUERICH / LFML MARSEILLE PROVENCE      3 /  8   international
//   4  MARSEILLE LAVERAN HOPITAL                   — /  1   military heliport
//   5  LSMD DUEBENDORF / LFOA AVORD                4 / 19   military aerodrome
//   6  AIGNES ET PUYPEROUX                         — / 553  ultralight site
//   7  LSVE AESCHHORN / hospital pads             96 / 296  heliport, and the
//                                                           Swiss mountain
//                                                           landing sites
//   8  LSMI INTERLAKEN AIR BASE                    4 / 42   closed
//   9  LSZS SAMEDAN / LFBA AGEN LA GARENNE         5 / 112  IFR airfield
//   10 LSPW LACHEN / LFHB BISCAROSSE HYDROBASE     1 / 18   water
//   13 LFLJ COURCHEVEL                             — /  52  altiport
//
// `aerodrome` is what this app draws: somewhere with a runway you could land a
// aeroplane on. Heliports are out for the same reason AD 3 is out of the eAIP
// countries — 96 Swiss mountain landing sites would swamp the Alps — and so are
// the closed fields, which are not places you can go.
const OPENAIP_TYPES = {
  0: { label: 'civil + military', aerodrome: true },
  1: { label: 'glider site', aerodrome: true },
  2: { label: 'civil airfield', aerodrome: true },
  3: { label: 'international', aerodrome: true },
  4: { label: 'military heliport', aerodrome: false },
  5: { label: 'military aerodrome', aerodrome: true },
  6: { label: 'ultralight site', aerodrome: false },
  7: { label: 'heliport / mountain landing site', aerodrome: false },
  8: { label: 'closed', aerodrome: false },
  9: { label: 'IFR airfield', aerodrome: true },
  10: { label: 'water', aerodrome: false },
  11: { label: 'landing strip', aerodrome: true },
  12: { label: 'agricultural strip', aerodrome: false },
  13: { label: 'altiport', aerodrome: true },
};

// ---------------------------------------------------------------------------
// The countries. Everything above is machinery; everything a country does
// differently is here.
// ---------------------------------------------------------------------------

const FINLAND = {
  key: 'fi',
  name: 'Finland',
  out: 'airfields-finland.geojson',
  source: 'eaip',
  attribution: 'Aerodromes © Fintraffic ANS / Finnish eAIP',
  note: 'Not for navigation. Aerodrome reference points only, from AD 2.2; '
    + 'consult the current AIP and NOTAMs for flight planning.',
  // Finland including Åland, with room to spare.
  bounds: {
    minLon: 19.0, maxLon: 32.0, minLat: 59.0, maxLat: 70.5,
  },
  // If a cycle ever yields fewer than this, something has changed in the source
  // and the output should not be trusted. 80 in the 2026-08-06 cycle.
  minAerodromes: 60,
  cycleHint: 'a cycle folder name, e.g. "003-2026_2026_06_11"',
  resolveCycle: resolveFinnishCycle,
  sourceUrl: (cycle) => `${FI_ROOT}${cycle.folder}/eAIP/`,
  async listAerodromes(cycle) {
    const base = finnishCycleBaseUrl(cycle.folder);
    const menu = await fetchText(`${base}menu.html`, 'eAIP table of contents');
    return { base, aerodromes: parseFinnishMenu(menu) };
  },
  // The filenames come from the table of contents and are used EXACTLY as given:
  // some carry a double space ("EF-AD  2 EFAA …"), so tidying would 404.
  pageUrl: (base, ad) => base + encodeURIComponent(ad.file),
  parsePage(text, icao) {
    return {
      coordinates: parseFinnishArp(text, icao, FINLAND),
      elevationFt: parseElevationAfter(text, /ELEV\s*\/\s*REF\s*T/i),
      metOffice: parseFinnishMetOffice(text),
    };
  },
  // Exact in Finland: the 24 aerodromes with an office are precisely the 24
  // that answer with a METAR.
  metarFlag: (metOffice) => metOffice,
};

const FRANCE = {
  key: 'fr',
  name: 'France',
  out: 'airfields-france.geojson',
  source: 'eaip',
  // …TOPPED UP FROM openAIP, because France's AD 2 is only the IFR-capable and
  // military aerodromes. Every VFR field — which is most of them, and all the
  // ones gliders fly from: Challes-les-Eaux, Saint-Auban, Mont-Dauphin — lives
  // in the VAC chart collection instead, which the eAIP publishes as charts
  // rather than as anything a script can read. openAIP has them: of its 450
  // French entries with an ICAO code, 309 are absent from AD 2, and 274 of
  // those are plain civil airfields.
  //
  // So the eAIP set is taken first and openAIP fills in what it does not carry,
  // deduplicated by ICAO. The two are NOT of equal quality and the file says so
  // per feature (`arp: true` on the eAIP ones): an AD 2 position is the
  // published reference point, an openAIP position is somewhere on the
  // aerodrome — half of them more than 154 m from the ARP, the worst 1.7 km.
  supplement: {
    export: 'fr',
    // Everything openAIP calls an aerodrome except the water bases: the same
    // rule Switzerland uses. Heliports, ultralight sites and closed fields stay
    // out, and entries without an ICAO code cannot be labelled by this layer.
    types: new Set([0, 1, 2, 3, 5, 9, 11, 13]),
  },
  // The supplement's METAR flag follows the type, the way Switzerland's does —
  // AD 2.11 cannot speak for aerodromes AD 2 does not contain. Measured against
  // the nine it adds of these types: one answers (LFYR Romorantin), which is
  // exactly the kind of station the flag exists to catch, and the 274 civil
  // airfields it does not flag answer not at all.
  metarTypes: new Set([0, 3, 5, 9]),
  attribution: 'Aerodromes © SIA / DGAC — French eAIP; VFR aerodromes © openAIP (CC BY-NC 4.0)',
  note: 'Not for navigation. AD 2 aerodromes carry their published reference '
    + 'point (arp: true); the rest are openAIP positions, which are not, and '
    + 'carry no AIRAC cycle. Consult the current AIP and NOTAMs for flight '
    + 'planning.',
  // Metropolitan France and Corsica. The overseas territories are published as
  // separate eAIP volumes (Antilles-Guyane, Nouvelle-Calédonie, …) and are not
  // in this one: every aerodrome here has an LF ICAO code.
  bounds: {
    minLon: -5.5, maxLon: 10.0, minLat: 41.0, maxLat: 51.5,
  },
  // 141 in the 2026-08-06 cycle: 118 civil IFR, 1 civil VFR, 22 military.
  minAerodromes: 110,
  cycleHint: 'an AIRAC effective date, e.g. 2026-08-06',
  resolveCycle: resolveFrenchCycle,
  sourceUrl: (cycle) => frenchCycleBaseUrl(cycle.date),
  async listAerodromes(cycle) {
    const base = frenchCycleBaseUrl(cycle.date);
    const menu = await fetchText(`${base}FR-menu-fr-FR.html`, 'eAIP table of contents');
    return { base, aerodromes: parseFrenchMenu(menu) };
  },
  pageUrl: (base, ad) => base + ad.file,
  parsePage(text, icao) {
    return {
      coordinates: parseFrenchArp(text, icao, FRANCE),
      elevationFt: parseElevationAfter(text, /Altitude de référence \/ Reference elevation/),
      metOffice: parseFrenchMetOffice(text),
    };
  },
  // Not exact in France, in both directions — see the note at the top. Every
  // AD 2 aerodrome is worth asking about; the METAR source narrows to the ones
  // that reply.
  metarFlag: () => true,
};

// Switzerland comes from openAIP rather than an eAIP, because Skyguide does not
// publish one a script can read. That trade is measured rather than assumed —
// see the note on buildFromOpenAip — and it shows in this file's metadata: no
// AIRAC cycle, a CC BY-NC licence, and positions that are somewhere on the
// aerodrome rather than its published reference point.
const SWITZERLAND = {
  key: 'ch',
  name: 'Switzerland',
  out: 'airfields-switzerland.geojson',
  source: 'openaip',
  export: 'ch',
  attribution: 'Aerodromes © openAIP (CC BY-NC 4.0)',
  note: 'Not for navigation. Aerodrome positions are openAIP\'s, which are not '
    + 'the published reference points and carry no AIRAC cycle; consult the '
    + 'current AIP and NOTAMs for flight planning.',
  // Switzerland with room to spare. The kept aerodromes span 6.11-9.95 E,
  // 46.00-47.69 N.
  bounds: {
    minLon: 5.5, maxLon: 10.7, minLat: 45.5, maxLat: 48.0,
  },
  // 60 in the 2026-08-25 export: 5 civil+military, 9 glider, 35 civil, 3
  // international, 4 military, 5 IFR.
  minAerodromes: 45,
  // WHICH ONES GET ASKED FOR A METAR, and this one was measured rather than
  // guessed: of the 60 kept, exactly 16 answer MET Norway, and the openAIP type
  // predicts them almost perfectly — 16 of the 17 aerodromes of the IFR-capable
  // and major types report, and 0 of the 43 glider and VFR-civil ones do. So the
  // type is the flag here, the way AD 2.11 is in Finland, and it wastes one code
  // (LSZM Mollis) rather than the 44 that flagging everything would.
  metarTypes: new Set([0, 3, 5, 9]),
};

const COUNTRIES = [FINLAND, FRANCE, SWITZERLAND];

const wanted = argValue('--country');
const selected = wanted
  ? COUNTRIES.filter((c) => c.key === wanted.toLowerCase())
  : COUNTRIES;
if (!selected.length) {
  throw new Error(`Unknown --country "${wanted}". Known: ${COUNTRIES.map((c) => c.key).join(', ')}`);
}
const explicitCycle = argValue('--cycle');
if (explicitCycle && selected.length > 1) {
  throw new Error('--cycle applies to one country at a time; name it with --country.');
}

// One country's aerodromes out of its eAIP: resolve the cycle, list what AD 2
// holds, then read every page.
async function buildFromEaip(country) {
  const cycle = await country.resolveCycle(explicitCycle);
  console.log(`  AIRAC cycle: ${cycle.folder}  (effective ${cycle.date})`);

  const { base, aerodromes: listed } = await country.listAerodromes(cycle);
  console.log(`  AD 2 aerodromes listed: ${listed.length}`);
  if (!limit && listed.length < country.minAerodromes) {
    throw new Error(
      `Only ${listed.length} aerodromes found in the table of contents, expected at `
      + `least ${country.minAerodromes}. The menu's link format has probably changed — `
      + 'refusing to overwrite the bundled file with a short list.',
    );
  }
  const aerodromes = limit ? listed.slice(0, limit) : listed;
  if (limit) {
    console.log(`  --limit ${limit}: parsing ${aerodromes.length}, nothing will be written`);
  }

  let done = 0;
  // Which aerodromes named a MET office — the AD 2.11 parse, kept apart from the
  // flag the file ends up carrying (see the note at the top: the two agree in
  // Finland and do not in France).
  const offices = new Set();
  const features = await mapWithConcurrency(aerodromes, async (ad) => {
    const html = await fetchText(country.pageUrl(base, ad), `${ad.icao} AD 2 page`);
    const { coordinates, elevationFt, metOffice } = country.parsePage(stripTags(html), ad.icao);
    if (metOffice) offices.add(ad.icao);
    const metar = country.metarFlag(metOffice);
    done += 1;
    if (done % 20 === 0) console.log(`  …${done}/${aerodromes.length}`);
    return feature(ad.icao, ad.name, coordinates, elevationFt, metar, true);
  });

  // A cycle in which NO aerodrome names a MET office means AD 2.11 has changed
  // shape, not that a country stopped reporting weather. Checked on the parsed
  // office rather than on the flag, because France's flag does not come from it
  // and so could never fail this.
  if (!limit && !offices.size) {
    throw new Error(
      'No aerodrome named an associated MET office. AD 2.11 item 1 has probably '
      + 'changed shape — refusing to write a file whose METAR list was built blind.',
    );
  }

  // Countries whose AD 2 is only part of the story top it up from openAIP; see
  // the note on the France adapter.
  let all = features;
  if (country.supplement && !limit) {
    const have = new Set(features.map((f) => f.properties.icao));
    const extra = await openAipAerodromes(country, country.supplement.export, country.supplement.types, have);
    all = features.concat(extra);
    console.log(`  ${features.length} from the eAIP + ${extra.length} from openAIP`);
  }
  all.sort((a, b) => a.properties.icao.localeCompare(b.properties.icao));

  return {
    features: all,
    metadata: {
      source: country.sourceUrl(cycle),
      ...(country.supplement
        ? { supplement: `${OPENAIP_ROOT}${country.supplement.export}_apt.geojson` } : {}),
      airacCycle: cycle.folder,
      // The date this data legally took effect, not the date it was downloaded —
      // which is the whole reason for preferring the eAIP over a dataset that
      // records neither.
      effective: cycle.date,
    },
    summary: `effective ${cycle.date}, ${offices.size} name a MET office`,
  };
}

// …and out of an openAIP country export, for the countries whose eAIP is not
// published as anything a script can read. One GeoJSON file, no cycle, no pages.
//
// WHAT THIS COSTS, measured against France where we have both (2026-08-25):
// openAIP knew every one of the 141 aerodromes the French eAIP lists, and nine
// more. But its positions are not the ARP — half of them sit more than 154 m
// from it, a tenth more than 649 m, the worst 1.7 km — and its elevations
// disagree with the published figure by more than 20 ft on 38 of the 141, by as
// much as 154 ft. It also records no AIRAC cycle at all, so a snapshot cannot
// say which edition it is; half of France's records had not been touched since
// 2024. Good enough to put a marker and a code on a weather map, not good
// enough to plan a flight with, which is what the file's own note says.
// The aerodromes in one openAIP country export, filtered to what this app draws.
// `keep` decides which types count as an aerodrome here; `skip` is the set of
// ICAO codes a better source has already provided.
async function openAipAerodromes(country, exportKey, keep, skip = new Set()) {
  const url = `${OPENAIP_ROOT}${exportKey}_apt.geojson`;
  const json = await fetchJson(url, `openAIP ${exportKey} airport export`);
  if (!Array.isArray(json.features)) throw new Error(`unexpected ${exportKey} export shape`);

  const unknown = new Set();
  const skipped = {
    type: 0, noIcao: 0, duplicate: 0,
  };
  const features = [];
  json.features.forEach((f) => {
    const p = f.properties || {};
    const spec = OPENAIP_TYPES[p.type];
    if (!spec) { unknown.add(p.type); return; }
    if (!keep.has(p.type)) { skipped.type += 1; return; }
    // The layer labels by ICAO code and the METAR layer asks by it, so an entry
    // without one has nothing this app can do with it.
    if (!p.icaoCode) { skipped.noIcao += 1; return; }
    if (skip.has(p.icaoCode)) { skipped.duplicate += 1; return; }
    const [lon, lat] = f.geometry.coordinates;
    features.push(feature(
      p.icaoCode,
      (p.name || '').trim(),
      withinBounds(lon, lat, p.icaoCode, country),
      openAipElevationFt(p.elevation),
      country.metarTypes.has(p.type),
      false,
    ));
  });

  if (unknown.size) {
    throw new Error(
      `openAIP ${exportKey} export contains unmapped airport types: ${[...unknown].join(', ')}. `
      + 'Add them to OPENAIP_TYPES (check the names in the export to identify them) '
      + 'rather than letting them disappear from the map.',
    );
  }

  console.log(`  openAIP: ${features.length} aerodromes kept; skipped ${skipped.type} by type, `
    + `${skipped.noIcao} with no ICAO code${
      skipped.duplicate ? `, ${skipped.duplicate} already in the eAIP set` : ''}`);
  return features;
}

async function buildFromOpenAip(country) {
  const keep = new Set(Object.entries(OPENAIP_TYPES)
    .filter(([, spec]) => spec.aerodrome).map(([t]) => Number(t)));
  const features = await openAipAerodromes(country, country.export, keep);
  features.sort((a, b) => a.properties.icao.localeCompare(b.properties.icao));
  if (!limit && features.length < country.minAerodromes) {
    throw new Error(
      `Only ${features.length} aerodromes kept, expected at least ${country.minAerodromes}. `
      + 'The export or its type enum has probably changed — refusing to overwrite the '
      + 'bundled file with a short list.',
    );
  }

  return {
    features: limit ? features.slice(0, limit) : features,
    metadata: {
      source: `${OPENAIP_ROOT}${country.export}_apt.geojson`,
      // No AIRAC cycle, and saying so is the point: openAIP records none, so
      // unlike the eAIP snapshots this file cannot state which edition it is.
      airacCycle: null,
      license: 'CC BY-NC 4.0',
    },
    summary: 'openAIP export, no AIRAC cycle recorded',
  };
}

for (const country of selected) {
  console.log(`\n${country.name}:`);
  if (explicitCycle && country.source === 'openaip') {
    throw new Error(`--cycle does not apply to ${country.name}: openAIP publishes no cycles.`);
  }
  const built = country.source === 'openaip'
    ? await buildFromOpenAip(country)
    : await buildFromEaip(country);
  const { features } = built;

  const withMetar = features.filter((f) => f.properties.metar).length;
  const withElevation = features.filter((f) => f.properties.elevationFt !== undefined).length;
  if (!limit && withElevation < features.length * 0.9) {
    throw new Error(
      `Only ${withElevation} of ${features.length} aerodromes yielded an elevation. `
      + 'The source has probably changed shape — refusing to write a file that '
      + 'is mostly missing it.',
    );
  }

  const out = {
    type: 'FeatureCollection',
    metadata: {
      ...built.metadata,
      generated: new Date().toISOString().slice(0, 10),
      attribution: country.attribution,
      note: country.note,
    },
    features,
  };

  if (limit) {
    console.log(JSON.stringify(out.features.map((f) => ({
      ...f.properties, at: f.geometry.coordinates,
    })), null, 1));
    console.log('  --limit run: not written');
  } else {
    await writeFile(new URL(`../src/data/${country.out}`, import.meta.url), JSON.stringify(out));
    console.log(`  ${features.length} aerodromes -> ${(JSON.stringify(out).length / 1024).toFixed(0)} kB`);
    console.log(`  ${built.summary}, ${withElevation} with elevation, ${withMetar} flagged for METAR`);
  }
}
