// Regenerate src/data/railway-stations-finland.geojson from the Digitraffic
// rail metadata API.
//
//   node scripts/fetch-rail-stations.mjs
//
// No API key and no `Digitraffic-User` header are needed for this endpoint
// (verified live) — but gzip is MANDATORY across Digitraffic: a request without
// `Accept-Encoding: gzip` is answered HTTP 406, not identity-encoded. `fetch`
// always sends it, so this only bites hand-rolled curl checks.
//
// The snapshot is bundled rather than fetched at runtime because it is ~15 kB
// and station metadata changes a few times a year: bundling puts it in the
// service-worker precache, needs no CSP host, and has no runtime failure mode.
//
// WHAT IS KEPT. The endpoint returns 563 traffic points, most of which are not
// railway stations in any sense a user means:
//
//   type STATION                    455
//   type STOPPING_POINT              64
//   type TURNOUT_IN_THE_OPEN_LINE    44   (a switch in open track, not a place)
//   passengerTraffic false          348   (freight yards and operating points)
//
// Only `passengerTraffic: true` is kept — the places where trains actually stop
// for people. The rest would put markers on freight sidings and lineside
// turnouts, which is noise on a weather map. Widening this is a one-line change
// if the freight network ever becomes interesting.
//
// Russian stations are dropped too. The metadata lists five as passenger
// destinations of the suspended Allegro/Tolstoi services — Vyborg, St Petersburg
// (x2), Tver and Moscow, the last some 1100 km beyond any view a Finnish radar
// user has. Haaparanta (SE) is kept: it is a border station inside the Tornio
// urban area and well within the radar composite.

const URL_ = 'https://rata.digitraffic.fi/api/v1/metadata/stations.geojson';

const res = await fetch(URL_, { headers: { 'Digitraffic-User': 'tutka.meteo.fi' } });
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const raw = await res.json();

const collator = new Intl.Collator('fi');
const features = (raw.features || [])
  .filter((f) => f.geometry && f.geometry.type === 'Point' && f.properties)
  .filter((f) => f.properties.passengerTraffic === true)
  .filter((f) => f.properties.countryCode !== 'RU')
  .map((f) => {
    const p = f.properties;
    // "Helsinki asema" / "Tampere asema" — the API suffixes some names with the
    // word the marker itself already conveys. Underscores stand in for spaces
    // on some entries.
    const name = String(p.stationName || '')
      .replace(/_/g, ' ')
      .replace(/\s+asema$/i, '')
      .trim();
    return {
      type: 'Feature',
      geometry: {
        type: 'Point',
        // 5 decimals ~1 m, plenty for a station marker and it halves the file.
        coordinates: f.geometry.coordinates.slice(0, 2).map((v) => Number(v.toFixed(5))),
      },
      properties: {
        n: name,
        // Short code (HKI, TPE) — shown instead of the name at wider zooms.
        s: p.stationShortCode || '',
        // Non-Finnish border stations (10 RU, 1 SE) are kept but flagged, so the
        // layer can treat them differently if that is ever wanted.
        c: p.countryCode || 'FI',
      },
    };
  })
  .sort((a, b) => collator.compare(a.properties.n, b.properties.n));

const out = { type: 'FeatureCollection', features };
const { writeFile } = await import('node:fs/promises');
const target = new URL('../src/data/railway-stations-finland.geojson', import.meta.url);
await writeFile(target, JSON.stringify(out));

const byCountry = {};
for (const f of features) byCountry[f.properties.c] = (byCountry[f.properties.c] || 0) + 1;
console.log(`${raw.features.length} traffic points -> ${features.length} passenger stations`);
console.log('by country:', byCountry);
console.log(`wrote ${target.pathname}`);
