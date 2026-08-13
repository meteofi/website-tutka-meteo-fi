// Regenerate src/data/airspace-finland.geojson from the openAIP Finland
// airspace export.
//
//   node scripts/fetch-airspace.mjs
//
// No API key: the export bucket is publicly readable. openAIP's download page
// hands out a presigned S3 link, but the same object answers without any of the
// signature parameters — verified byte-identical against a presigned copy on
// 2026-08-12 — so this uses the stable URL rather than a link that expires
// after 24 hours.
//
// LICENCE. openAIP data is CC BY-NC 4.0: attribution required, non-commercial
// use only. That makes it the first non-commercial dataset in this app — the
// others (MML, Fintraffic, Väylä, Ilmailuliitto) are plain CC BY — so the
// attribution string is not optional and the layer cannot be carried into a
// commercial build. It is also not navigation data; see the disclaimer emitted
// into the file's metadata below.
//
// WHY THE FILE SHRINKS SO MUCH. The export is 1206 kB, of which the geometry is
// only 173 kB. The rest is openAIP bookkeeping, and one field dominates:
// `hoursOfOperation` is 631 kB of placeholder — every one of the 684 airspaces
// carries all seven days as 00:00-00:00. The five state flags (onDemand,
// onRequest, byNotam, specialAgreement, requestCompliance) are false on every
// feature, and _id/createdBy/updatedBy/createdAt/updatedAt/dataIngestion/
// country/deletable are of no use to a map. Dropping all of it and keeping
// name, category, class and the two vertical limits gets the bundle to ~200 kB.
//
// THE TYPE ENUM IS DERIVED, NOT ASSUMED. openAIP encodes airspace type as a
// number and the export carries no legend. Rather than trust a remembered
// table for something aviation-adjacent, the mapping below was read off the
// Finnish naming convention in the data itself — EFR* are restricted, EFD*
// danger, EFP* prohibited, and so on — and every type present was accounted
// for. Verify the same way if a future export introduces a new number: this
// script fails loudly on one rather than guessing.

import { writeFile } from 'node:fs/promises';

const SOURCE = 'https://s3.openaip.net/openaip-system-exports/fi_asp.geojson';
const OUT = new URL('../src/data/airspace-finland.geojson', import.meta.url);

// openAIP airspace `type` -> what it is, and which of the layer's three groups
// it belongs to. Names in the data confirm each one (counts from 2026-08-12):
//
//   1  EFR11 SANTAHAMINA, EFR12 KEMIÖ …      102  restricted
//   2  EFD100 KATAJALUOTO …                  136  danger
//   3  EFP10 LOVIISA, EFP25 OLKILUOTO …        7  prohibited
//   4  EFHA CTR, EFIV CTR …                   19  control zone
//   6  EFET FIZ UPPER …                       11  flight information zone
//   7  EFHA TMA, EFHK TMA LOWER …             22  terminal area
//   8  EFTRAA04 …                            225  temporary reserved
//   9  EFTSAA07 …                            153  temporary segregated
//   12 EF-ADIZ                                 1  air defence identification
//   26 EFHK CTA EAST, EFIV CTA …               7  control area
//   29 EFNOISE01                               1  overflight restriction
const TYPES = {
  1: { code: 'R', label: 'Rajoitusalue', group: 'restricted' },
  2: { code: 'D', label: 'Vaara-alue', group: 'restricted' },
  3: { code: 'P', label: 'Kieltoalue', group: 'restricted' },
  4: { code: 'CTR', label: 'Lähialue', group: 'controlled' },
  // openAIP's type 6 is a Radio Mandatory Zone, and Finland files both its
  // flight information zones AND at least one genuine RMZ (EFNU) under it —
  // ten FIZ against one RMZ in the 2026-08-12 export. Telling them apart by
  // name keeps the layer from calling Nummela's radio zone a FIZ.
  6: {
    code: 'FIZ',
    label: 'Lentotiedotusvyöhyke',
    group: 'controlled',
    variant: (name) => (/\bRMZ\b/.test(name)
      ? { code: 'RMZ', label: 'Radiovyöhyke' } : null),
  },
  7: { code: 'TMA', label: 'Lähestymisalue', group: 'controlled' },
  8: { code: 'TRA', label: 'Tilapäinen varausalue', group: 'reserved' },
  9: { code: 'TSA', label: 'Tilapäisesti erotettu alue', group: 'reserved' },
  12: { code: 'ADIZ', label: 'Tunnistusvyöhyke', group: 'controlled' },
  26: { code: 'CTA', label: 'Lentotiedotusalue', group: 'controlled' },
  // A noise-abatement overflight restriction. Grouped with the restrictions
  // because that is what it is to a pilot, even though nothing is prohibited.
  29: { code: 'RES', label: 'Ylilentorajoitus', group: 'restricted' },
};

// ICAO airspace class. Only C, D, G and "unclassified" appear in Finland; the
// rest are here so a future export does not silently print a number.
const CLASSES = {
  0: 'A', 1: 'B', 2: 'C', 3: 'D', 4: 'E', 5: 'F', 6: 'G',
};

// openAIP limit units and reference datums.
const UNIT_FT = 1;
const UNIT_FL = 6;
const DATUM_GND = 0;
const DATUM_MSL = 1;

// One vertical limit as the string a chart would print. Flight levels stay
// flight levels; feet keep their datum, because 2500 ft above the ground and
// 2500 ft above the sea are different airspace and the difference matters most
// exactly where the terrain is high.
function limitText(limit) {
  if (!limit || !Number.isFinite(limit.value)) return '';
  const { value, unit, referenceDatum } = limit;
  // FL999 is openAIP's sentinel for "no upper limit", not a flight level: 187
  // of the 578 flight-level limits use it, while the highest real one is FL660.
  // Printed as a number it would read as an altitude nobody flies at.
  if (unit === UNIT_FL && value >= 999) return 'UNL';
  if (unit === UNIT_FL) return `FL${value}`;
  if (value === 0 && referenceDatum === DATUM_GND) return 'GND';
  if (unit === UNIT_FT) {
    if (referenceDatum === DATUM_GND) return `${value} ft GND`;
    if (referenceDatum === DATUM_MSL) return `${value} ft MSL`;
    return `${value} ft`;
  }
  return `${value}`;
}

// 5 decimal places is about a metre at these latitudes — far finer than any
// airspace boundary is surveyed to, and finer than one screen pixel until well
// past the zooms this layer draws at.
const round = (n) => Math.round(n * 1e5) / 1e5;

const resp = await fetch(SOURCE);
if (!resp.ok) throw new Error(`openAIP export ${resp.status} ${resp.statusText}`);
const source = await resp.json();
if (!Array.isArray(source.features)) throw new Error('unexpected export shape');

const unknown = new Set();
const features = [];
const counts = {};

for (const f of source.features) {
  const p = f.properties || {};
  const spec = TYPES[p.type];
  if (!spec) {
    // Loudly, not silently: an unmapped type would otherwise vanish from the
    // map with no sign that anything was missing.
    unknown.add(p.type);
    continue;
  }
  if (!f.geometry || f.geometry.type !== 'Polygon') {
    unknown.add(`geometry:${f.geometry && f.geometry.type}`);
    continue;
  }
  counts[spec.group] = (counts[spec.group] || 0) + 1;
  const variant = spec.variant && spec.variant(p.name || '');
  features.push({
    type: 'Feature',
    properties: {
      n: p.name || '',
      // Short keys: this file ships to every visitor who switches the layer on.
      k: variant ? variant.code : spec.code,
      g: spec.group,
      c: CLASSES[p.icaoClass] || '',
      u: limitText(p.upperLimit),
      l: limitText(p.lowerLimit),
    },
    geometry: {
      type: 'Polygon',
      coordinates: f.geometry.coordinates.map(
        (ring) => ring.map(([lon, lat]) => [round(lon), round(lat)]),
      ),
    },
  });
}

if (unknown.size) {
  throw new Error(
    `openAIP export contains unmapped airspace types: ${[...unknown].join(', ')}. `
    + 'Add them to TYPES (check the names in the export to identify them) rather '
    + 'than letting them disappear from the map.',
  );
}

const out = {
  type: 'FeatureCollection',
  metadata: {
    source: SOURCE,
    generated: new Date().toISOString().slice(0, 10),
    license: 'CC BY-NC 4.0',
    attribution: 'Ilmatilat © openAIP',
    note: 'Not for navigation. Airspace shown for situational context only; '
      + 'consult the current AIP and NOTAMs for flight planning.',
  },
  features,
};

await writeFile(OUT, JSON.stringify(out));
const bytes = JSON.stringify(out).length;
console.log(`airspace: ${features.length} features -> ${(bytes / 1024).toFixed(0)} kB`);
console.log('  by group:', counts);
