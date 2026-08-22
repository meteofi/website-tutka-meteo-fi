// Regenerate the bundled airspace snapshots from the openAIP country exports:
// src/data/airspace-finland.geojson and src/data/airspace-france.geojson.
//
//   node scripts/fetch-airspace.mjs
//
// One country per file, deliberately, because the app fetches them one country
// at a time — see the load gate in src/airspace.js. France alone is ~1.2 MB,
// five times Finland, and a Finnish user must not pay for it to see Helsinki.
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
// WHY THE FILE SHRINKS SO MUCH. The Finnish export is 1206 kB, of which the
// geometry is only 173 kB. The rest is openAIP bookkeeping, and one field
// dominates: `hoursOfOperation` is 631 kB of placeholder — every one of the 684
// airspaces carries all seven days as 00:00-00:00. The five state flags
// (onDemand, onRequest, byNotam, specialAgreement, requestCompliance) are false
// on every feature, and _id/createdBy/updatedBy/createdAt/updatedAt/
// dataIngestion/country/deletable are of no use to a map. Dropping all of it and
// keeping name, category, class and the two vertical limits gets the bundle to
// ~200 kB. France shrinks by the same ratio, from 3.9 MB to ~1.2 MB — its file
// stays large because its geometry genuinely is: 1770 airspaces and 53 000
// vertices against Finland's 684 and 17 000.
//
// THE TYPE ENUM IS DERIVED, NOT ASSUMED. openAIP encodes airspace type as a
// number and the export carries no legend. Rather than trust a remembered
// table for something aviation-adjacent, the mapping below was read off the
// national naming conventions in the data itself — EFR* are restricted, EFD*
// danger, EFP* prohibited, LF-P prohibited, SIV a flight information sector,
// and so on — and every type present in both countries was accounted for. The
// two countries also cross-check each other: types 1/2/3/4/6/7/26/29 appear in
// both and mean the same thing under two unrelated naming conventions. Verify
// the same way if a future export introduces a new number: this script fails
// loudly on one rather than guessing.

import { writeFile } from 'node:fs/promises';

const SOURCE = (code) => `https://s3.openaip.net/openaip-system-exports/${code}_asp.geojson`;

// One entry per bundled snapshot. `out` is also what src/airspace.js imports,
// and the bbox this script prints per country is what its load gate compares
// the viewport against — if a future export grows past that box, update it
// there.
const COUNTRIES = [
  { code: 'fi', name: 'Finland', out: 'airspace-finland.geojson' },
  { code: 'fr', name: 'France', out: 'airspace-france.geojson' },
];

// openAIP airspace `type` -> what it is, and which of the layer's three groups
// it belongs to. Names in the data confirm each one (FI counts from 2026-08-12,
// FR counts from 2026-08-21):
//
//                                          FI    FR
//   0  FL115 MAX                            —     1  (unnamed remnant)
//   1  EFR11 SANTAHAMINA / LF-R1A LANESTER 102   652  restricted
//   2  EFD100 KATAJALUOTO / LF-D16A         136    81  danger
//   3  EFP10 LOVIISA / LF-P1 BLAYAIS          7   108  prohibited
//   4  EFHA CTR / CTR AGEN                   19    92  control zone
//   5  TMZ SEINE 7.1                          —     9  transponder mandatory
//   6  EFET FIZ UPPER / RMZ ANGERS           11    22  information / radio zone
//   7  EFHA TMA / TMA AJACCIO 1               22   352  terminal area
//   8  EFTRAA04                              225     —  temporary reserved
//   9  EFTSAA07                              153     —  temporary segregated
//   10 BORDEAUX FIR LFBB                       —     5  flight information region
//   12 EF-ADIZ                                 1     —  air defence identification
//   15 B31                                     —     1  airway
//   21 TRANSIT VV AXE 1, MONT-MOIRAN …         —   157  gliding / free flight
//   26 EFHK CTA EAST / CTA AJACCIO             7    61  control area
//   28 PARA LILLE MARCQ, VOLTIGE VINON …       —    33  sporting activity
//   29 EFNOISE01 / PARC/RESERVE ECRINS, ZSM    1    71  overflight restriction
//   33 SIV AJACCIO, SIV AQUITAINE 1 …          —   106  flight information sector
//   34 LTA FRANCE 1, LTA 3 ALPES 1 …           —    19  lower traffic area
//
// The `label` is documentation only — nothing downstream reads it; the layer
// styles on `code` and prints the airspace's own name.
const TYPES = {
  // One French feature carries a vertical limit where its name should be and
  // sits over Provence at FL115-FL195, so it is a piece of the upper structure
  // that lost its name upstream. Kept rather than dropped, because a polygon
  // the source publishes is not ours to hide, but it gets no code of its own.
  0: { code: 'OTH', label: 'Muu ilmatila', group: 'controlled' },
  // France files its permanent LF-R areas and its temporary ZRT/CBA zones under
  // the same type. A ZRT is a schedule rather than a wall — the same thing
  // Finland's TRA/TSA are — so it belongs with the reservation areas, which are
  // dashed and off by default, and not among the 488 permanent restrictions.
  1: {
    code: 'R',
    label: 'Rajoitusalue',
    group: 'restricted',
    variant: (name) => (/^(ZRT|CBA)\b/.test(name)
      ? { code: 'ZRT', label: 'Tilapäinen rajoitusalue', group: 'reserved' } : null),
  },
  2: { code: 'D', label: 'Vaara-alue', group: 'restricted' },
  3: { code: 'P', label: 'Kieltoalue', group: 'restricted' },
  4: { code: 'CTR', label: 'Lähialue', group: 'controlled' },
  5: { code: 'TMZ', label: 'Transponderivyöhyke', group: 'controlled' },
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
  // The outermost container: five polygons covering all of French airspace.
  // Grouped with the controlled airspace because that is where a reader looks
  // for "who am I talking to", though a FIR is not controlled — the layer
  // draws it as information airspace, unfilled, for exactly that reason.
  10: { code: 'FIR', label: 'Lentotiedotusalue', group: 'controlled' },
  12: { code: 'ADIZ', label: 'Tunnistusvyöhyke', group: 'controlled' },
  15: { code: 'AWY', label: 'Ilmatie', group: 'controlled' },
  // Gliding and free-flight (vol libre) sectors and transit corridors: the
  // Alpine and Pyrenean traverses plus the local soaring areas. Reserved rather
  // than controlled — an area whose use is an activity and a schedule.
  21: { code: 'GLD', label: 'Purjelentoalue', group: 'reserved' },
  // CTA is a control area, not a flight information area — that is the FIR
  // above. (The Finnish label here read 'Lentotiedotusalue' until France made
  // the two collide; it was only ever a comment, so no data changes with it.)
  26: { code: 'CTA', label: 'Valvonta-alue', group: 'controlled' },
  // Parachuting, aerobatics and the like. Same reasoning as the gliding
  // sectors: an activity with a schedule, so it lives with the reservations.
  28: { code: 'SPO', label: 'Ilmailu-urheilualue', group: 'reserved' },
  // Finland's one noise-abatement zone and France's national parks and wildlife
  // sensitivity zones (ZSM). Grouped with the restrictions because that is what
  // it is to a pilot, even though nothing is prohibited.
  29: { code: 'RES', label: 'Ylilentorajoitus', group: 'restricted' },
  // SIV — secteur d'information de vol. Class G with an information service,
  // which is what a Finnish FIZ is, so the layer dresses it the same way.
  33: { code: 'SIV', label: 'Lentotiedotussektori', group: 'controlled' },
  // LTA — the class D/E airspace between FL115 and FL195 over France and its
  // Alpine and Pyrenean subdivisions.
  34: { code: 'LTA', label: 'Alempi liikennealue', group: 'controlled' },
};

// ICAO airspace class. Only C, D, G and "unclassified" appear in Finland, and
// A, C, D, E and "unclassified" in France; the rest are here so a future export
// does not silently print a number.
const CLASSES = {
  0: 'A', 1: 'B', 2: 'C', 3: 'D', 4: 'E', 5: 'F', 6: 'G',
};

// openAIP limit units and reference datums.
// Metres are how France publishes its national-park overflight ceilings (300 m
// above the ground); nothing in the Finnish export uses them for a non-zero
// value, which is why the unit only surfaced with France.
const UNIT_M = 0;
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
  if (unit === UNIT_FT || unit === UNIT_M) {
    const u = unit === UNIT_FT ? 'ft' : 'm';
    if (referenceDatum === DATUM_GND) return `${value} ${u} GND`;
    if (referenceDatum === DATUM_MSL) return `${value} ${u} MSL`;
    return `${value} ${u}`;
  }
  return `${value}`;
}

// 5 decimal places is about a metre at these latitudes — far finer than any
// airspace boundary is surveyed to, and finer than one screen pixel until well
// past the zooms this layer draws at.
const round = (n) => Math.round(n * 1e5) / 1e5;

for (const country of COUNTRIES) {
  const url = SOURCE(country.code);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`openAIP ${country.code} export ${resp.status} ${resp.statusText}`);
  const source = await resp.json();
  if (!Array.isArray(source.features)) throw new Error(`unexpected ${country.code} export shape`);

  const unknown = new Set();
  const features = [];
  const counts = {};
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];

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
    // A variant may move the feature to another group as well as rename it —
    // France's ZRT zones are the case: same openAIP type as a permanent
    // restricted area, but a reservation in everything but the number.
    const variant = spec.variant && spec.variant(p.name || '');
    const group = (variant && variant.group) || spec.group;
    counts[group] = (counts[group] || 0) + 1;
    const coordinates = f.geometry.coordinates.map(
      (ring) => ring.map(([lon, lat]) => {
        const x = round(lon);
        const y = round(lat);
        if (x < bbox[0]) bbox[0] = x;
        if (y < bbox[1]) bbox[1] = y;
        if (x > bbox[2]) bbox[2] = x;
        if (y > bbox[3]) bbox[3] = y;
        return [x, y];
      }),
    );
    features.push({
      type: 'Feature',
      properties: {
        n: p.name || '',
        // Short keys: this file ships to every visitor who switches the layer on.
        k: variant ? variant.code : spec.code,
        g: group,
        c: CLASSES[p.icaoClass] || '',
        u: limitText(p.upperLimit),
        l: limitText(p.lowerLimit),
      },
      geometry: { type: 'Polygon', coordinates },
    });
  }

  if (unknown.size) {
    throw new Error(
      `openAIP ${country.code} export contains unmapped airspace types: `
      + `${[...unknown].join(', ')}. `
      + 'Add them to TYPES (check the names in the export to identify them) rather '
      + 'than letting them disappear from the map.',
    );
  }

  const out = {
    type: 'FeatureCollection',
    metadata: {
      source: url,
      generated: new Date().toISOString().slice(0, 10),
      license: 'CC BY-NC 4.0',
      attribution: 'Ilmatilat © openAIP',
      note: 'Not for navigation. Airspace shown for situational context only; '
        + 'consult the current AIP and NOTAMs for flight planning.',
    },
    features,
  };

  const json = JSON.stringify(out);
  await writeFile(new URL(`../src/data/${country.out}`, import.meta.url), json);
  console.log(`${country.name}: ${features.length} features -> ${(json.length / 1024).toFixed(0)} kB`);
  console.log('  by group:', counts);
  // The load gate in src/airspace.js keeps its own copy of this box, because it
  // has to know where a snapshot applies BEFORE fetching it. Printed on every
  // run so a country that grows past its box is visible here.
  console.log('  bbox:', bbox.map((n) => n.toFixed(3)).join(', '));
}
