// Place-name search index over the bundled MML snapshot
// (src/data/placenames-fi.geojson: properties n = name, s = scaleRelevance
// band, c = class). Same philosophy as edr/trajectoryQuery.js: pure functions
// only — no fetch, no state, no OL imports — runnable in plain node for
// verification harnesses. The ~9.6k-record corpus is small enough that every
// keystroke can re-rank the full index (<2 ms), so there is no debounce and
// no incremental index structure.

// Class ordering for ties: cities before settlements before water before
// terrain — matches the "which Saarijärvi did you mean" intuition.
const CLASS_RANK = {
  c: 0,
  a: 1,
  w: 2,
  t: 3,
};

// Landing zoom per scaleRelevance band. Every value satisfies the label
// gate in placeNames.js minBandForResolution (z9 shows bands >= 1M, z10+
// shows all), so the searched name is on screen after the fly-to. 500k
// lands one step deeper than its gate: at z10 all 9.6k labels compete and
// a village can lose the declutter contest to a bigger neighbour.
const ZOOM_BY_BAND = {
  8000000: 9,
  4500000: 9,
  2000000: 9,
  1000000: 10,
  500000: 11,
};

// Finnish-aware case fold + diacritic strip: NFD splits ä/ö/å (and the
// Sámi/Swedish á/é/š in northern place names) into base + combining mark,
// which the range strip removes — no per-character fold table needed.
export function foldFi(s) {
  return s.toLocaleLowerCase('fi').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// GeoJSON FeatureCollection -> flat search records with match keys
// precomputed once (lower for exact-diacritic matching, folded for
// diacritic-insensitive matching).
export function buildIndex(geojson) {
  return geojson.features.map((f) => {
    const name = f.properties.n;
    const lower = name.toLocaleLowerCase('fi');
    return {
      name,
      lower,
      folded: foldFi(lower),
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      band: f.properties.s,
      cls: f.properties.c,
    };
  });
}

// Match quality against one precomputed key: 0 = prefix, 1 = word start
// (after space or hyphen), 2 = substring, Infinity = no match.
function matchType(key, q) {
  const at = key.indexOf(q);
  if (at === -1) return Infinity;
  if (at === 0) return 0;
  const before = key[at - 1];
  if (before === ' ' || before === '-') return 1;
  // A word start deeper in the string still beats a plain substring.
  if (key.includes(` ${q}`) || key.includes(`-${q}`)) return 1;
  return 2;
}

// Ranked search. Tier interleaves exact-diacritic and folded matches so an
// exact prefix ("hä…") outranks a folded prefix ("ha…" typed without
// umlauts) at every match type: exact prefix 0, folded prefix 1, exact word
// start 2, folded word start 3, exact substring 4, folded substring 5.
export function searchPlaces(index, query, limit = 8) {
  const qLower = query.trim().toLocaleLowerCase('fi');
  if (!qLower) return [];
  const qFolded = foldFi(qLower);

  const hits = [];
  index.forEach((rec) => {
    const tier = Math.min(
      matchType(rec.lower, qLower) * 2,
      matchType(rec.folded, qFolded) * 2 + 1,
    );
    if (tier !== Infinity) hits.push({ rec, tier });
  });

  hits.sort((x, y) => x.tier - y.tier
    || y.rec.band - x.rec.band
    || CLASS_RANK[x.rec.cls] - CLASS_RANK[y.rec.cls]
    || x.rec.name.localeCompare(y.rec.name, 'fi'));

  return hits.slice(0, limit).map((h) => h.rec);
}

export function targetZoomForBand(band) {
  return ZOOM_BY_BAND[band] || 10;
}
