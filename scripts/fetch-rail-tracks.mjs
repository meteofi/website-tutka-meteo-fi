// Regenerate src/data/railway-tracks-finland.geojson from Väylä's rail network.
//
//   node scripts/fetch-rail-tracks.mjs
//
// Source: `ratatiedot:locationtracks_simplified` on the vaylapilvi OGC API — the
// same host the Vesiväylät layers use, no key needed.
//
// The snapshot is bundled rather than fetched at runtime for the same reasons as
// the stations: it goes in the service-worker precache, needs no CSP host and
// has no runtime failure mode. Vector tiles would only earn their keep if the
// full network (every siding and yard track) had to be served with per-zoom
// simplification; the main network is 12k vertices, which is nothing.
//
// WHAT IS KEPT. The endpoint returns 5315 track segments of four kinds:
//
//   pääraide     1436   6217 km   main track — the network people think of
//   sivuraide    3036   1878 km   side tracks: yards, passing loops, sidings
//   kujaraide     613     63 km   short connecting tracks inside yards
//   turvaraide    230     15 km   safety tracks (a dead end to catch runaways)
//
// Only `pääraide` in state `IN USE` is kept. The rest is yard detail that draws
// as a thicket around every station at the zooms this layer is meant for.
//
// SIZE. The raw response is ~850 kB gzipped, but that is almost entirely
// property overhead — 24 fields on every feature, of which this layer needs
// none. Geometry alone is 12k vertices. Stripping the properties and rounding
// coordinates to 4 decimals (~11 m, far finer than any zoom draws) gives ~300 kB
// raw / ~65 kB gzipped, a quarter of the place-name snapshot that already ships.
//
// Rounding can collapse consecutive vertices onto each other, so duplicates are
// dropped afterwards and any segment left with fewer than two distinct points is
// discarded rather than emitted as a degenerate line.

const URL_ = 'https://avoinapi.vaylapilvi.fi/vaylatiedot/ogc/features/v1/collections'
  + '/ratatiedot:locationtracks_simplified/items?f=application%2Fgeo%2Bjson&limit=6000';

const PRECISION = 4;

const res = await fetch(URL_);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const raw = await res.json();

let dropped = 0;
const features = [];
for (const f of raw.features || []) {
  const p = f.properties || {};
  if (p.type !== 'pääraide' || p.state !== 'IN USE') continue;
  if (!f.geometry || f.geometry.type !== 'LineString') continue;
  const coords = [];
  for (const v of f.geometry.coordinates) {
    const pt = [Number(v[0].toFixed(PRECISION)), Number(v[1].toFixed(PRECISION))];
    const last = coords[coords.length - 1];
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) coords.push(pt);
  }
  if (coords.length < 2) { dropped += 1; continue; }
  // No properties at all: the layer draws every main track identically, and
  // 1400 empty objects are pure bytes.
  features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
}

const out = { type: 'FeatureCollection', features };
const json = JSON.stringify(out);
const { writeFile } = await import('node:fs/promises');
const target = new URL('../src/data/railway-tracks-finland.geojson', import.meta.url);
await writeFile(target, json);

const verts = features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
console.log(`${raw.features.length} segments -> ${features.length} main-track segments`);
console.log(`${verts} vertices, ${(json.length / 1024).toFixed(0)} kB raw`);
if (dropped) console.log(`${dropped} degenerate after rounding, dropped`);
console.log(`wrote ${target.pathname}`);
