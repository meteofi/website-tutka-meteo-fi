#!/usr/bin/env node
// Regenerates src/data/placenames-fi.geojson — the bundled place-name label
// data — from the MML (Maanmittauslaitos) geographic names OGC API Features
// service. The app never talks to this API at runtime: the output ships as a
// hashed immutable asset (see webpack.config.js), so the API key stays on the
// machine that runs this script.
//
// Usage:
//   MML_API_KEY=<key> node scripts/fetch-placenames.mjs
//
// A free personal key: https://www.maanmittauslaitos.fi/en/rajapinnat/api-avaimen-ohje
// Names change rarely — rerun a couple of times a year and commit the diff.
// Output is sorted deterministically so regeneration diffs stay reviewable.

const API_KEY = process.env.MML_API_KEY;
if (!API_KEY) {
  console.error('MML_API_KEY env var is required (free key: https://www.maanmittauslaitos.fi/en/rajapinnat/api-avaimen-ohje)');
  process.exit(1);
}

const ITEMS_URL = 'https://avoin-paikkatieto.maanmittauslaitos.fi/geographic-names/features/v1/collections/placenames_simple/items';

// scaleRelevance bands the app renders. 1:500k and coarser covers the radar
// app's zoom range (country -> region); the finer bands (250k..25k) are
// hiking-map detail and would grow the file ~4x-30x.
const BANDS = [8000000, 2000000, 1000000, 500000];

// placeTypeGroup -> single-char style class shipped to the client:
//   c  city (401 kaupunki)
//   a  settlement (301 village, 302 village part, 701 industrial locality)
//   w  water (201 lakes/sea areas, 202 rivers)
//   t  terrain + protected areas (101/102/199 fells, bogs..., 501/599 parks)
const CLASS_BY_GROUP = new Map([
  [101, 't'], [102, 't'], [199, 't'],
  [201, 'w'], [202, 'w'],
  [301, 'a'], [302, 'a'],
  [401, 'c'],
  [501, 't'], [599, 't'],
  [701, 'a'],
]);

async function fetchBand(scale) {
  const features = [];
  let url = `${ITEMS_URL}?f=json&limit=10000&scaleRelevance=${scale}&api-key=${API_KEY}`;
  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} for scaleRelevance=${scale}`);
    const page = await res.json();
    features.push(...page.features);
    const next = (page.links || []).find((l) => l.rel === 'next');
    url = next ? `${next.href}${next.href.includes('api-key') ? '' : `&api-key=${API_KEY}`}` : null;
  }
  return features;
}

const raw = (await Promise.all(BANDS.map(fetchBand))).flat();

// placenames_simple has one feature per spelling, so bilingual places appear
// 2-3 times at the same point. Keep one name per placeId: the dominant
// language's name (languageDominance 1 = majority language of the area —
// Swedish on Åland/the coast, Sámi in northern Lapland), tie-broken by
// officiality. ~165 places have no dominance-1 name at all, hence the sort
// instead of a server-side languageDominance filter.
const byPlace = new Map();
for (const f of raw) {
  const p = f.properties;
  const prev = byPlace.get(p.placeId);
  if (!prev
    || p.languageDominance < prev.properties.languageDominance
    || (p.languageDominance === prev.properties.languageDominance
      && p.languageOfficiality < prev.properties.languageOfficiality)) {
    byPlace.set(p.placeId, f);
  }
}

const collator = new Intl.Collator('fi');
const features = [...byPlace.values()]
  .map((f) => ({
    type: 'Feature',
    geometry: {
      type: 'Point',
      // 4 decimals ≈ 6 m at 61°N — plenty for a label anchor.
      coordinates: f.geometry.coordinates.map((v) => Math.round(v * 1e4) / 1e4),
    },
    properties: {
      n: f.properties.spelling,
      s: f.properties.scaleRelevance,
      c: CLASS_BY_GROUP.get(f.properties.placeTypeGroup) || 'a',
    },
  }))
  .sort((a, b) => (b.properties.s - a.properties.s)
    || collator.compare(a.properties.n, b.properties.n));

const out = { type: 'FeatureCollection', features };
const json = JSON.stringify(out);
const { writeFile } = await import('node:fs/promises');
const target = new URL('../src/data/placenames-fi.geojson', import.meta.url);
await writeFile(target, json);

const perBand = {};
for (const f of features) perBand[f.properties.s] = (perBand[f.properties.s] || 0) + 1;
console.log(`wrote ${features.length} names (${(json.length / 1e6).toFixed(2)} MB) to src/data/placenames-fi.geojson`);
console.log('per band:', perBand);
