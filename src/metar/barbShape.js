// The wind barb, as pure geometry: how many feathers a speed makes, and where
// each of them goes. No OpenLayers, no map, no style — src/metar/stationPlot.js
// turns what this returns into LineStrings and Polygons and puts it on the map.
//
// SPLIT OUT SO IT CAN BE TESTED, and that is not hypothetical tidiness. A barb
// is wrong silently: it still draws, it still looks like a barb, and it says
// something untrue about the weather. The feathers leaned back toward the
// station for as long as this layer existed — they belong swept outward, toward
// the tip of the staff — and lint, build and every glance at a screenshot let it
// through until a user noticed. scripts/test-barb.mjs now pins it, which it
// could not do while this arithmetic lived behind an `ol/geom` import.
//
// Coordinates come back as pixel offsets from the station, y up, so the caller
// scales by the map resolution and adds the station's position. The frame is the
// wind's: `along` runs from the station in the direction the wind blows FROM
// (the meteorological convention, the opposite of an arrow), and `across` is to
// the left of that looking outward, which is where the feathers sit in the
// northern hemisphere. Finland-only, so that is unconditional here.

// Screen pixels, shared with the plot around them.
export const CIRCLE_R = 6;
const BARB_LEN = 26;
const FEATHER_LEN = 9;
const FEATHER_STEP = 4.5;
const PENNANT_W = 5;

// How many pennants (50 kt), full feathers (10) and half feathers (5) a speed
// makes. Rounded to the nearest 5 kt, which is how barbs are always drawn.
//
// Pure and exported for the tests: this is the function whose off-by-one would
// be a silent 5-knot lie.
export function barbParts(speedKt) {
  const rounded = Math.round((Number.isFinite(speedKt) ? speedKt : 0) / 5) * 5;
  return {
    rounded,
    pennants: Math.floor(rounded / 50),
    full: Math.floor((rounded % 50) / 10),
    half: Math.floor((rounded % 10) / 5),
  };
}

// The staff, its feathers and its pennants for one wind, in pixel offsets from
// the station.
//
// THE FEATHERS SWEEP OUTWARD, tips further along the staff than their roots, and
// it is worth recording why that is the right way round rather than a taste: the
// barb descends from a feathered arrow flying into the wind, so its feathers are
// the fletching at the tail — the end away from the station. Matplotlib, which
// is what meteorology actually draws these with, puts each tip half a barb-width
// beyond its root (`endy + offset + full_width / 2` in `Barbs._make_barbs`).
export function barbShape(directionDeg, speedKt) {
  const parts = barbParts(speedKt);
  // Unit vector from the station toward where the wind comes from. Screen y is
  // up in map coordinates, so sin/cos land as usual for a compass bearing.
  const rad = (directionDeg * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = Math.cos(rad);
  // Perpendicular, for the feathers: to the left looking outward.
  const vx = -uy;
  const vy = ux;
  const at = (along, across) => [ux * along + vx * across, uy * along + vy * across];

  const lines = [];
  const polygons = [];
  const root = CIRCLE_R + 1;
  const tip = root + BARB_LEN;
  lines.push([at(root, 0), at(tip, 0)]);

  // Feathers are laid from the OUTER end inward, which is the convention and
  // also what keeps a 5 kt half-feather off the circle.
  let along = tip;
  for (let i = 0; i < parts.pennants; i += 1) {
    polygons.push([at(along, 0), at(along + PENNANT_W, FEATHER_LEN), at(along - PENNANT_W, 0), at(along, 0)]);
    along -= PENNANT_W + FEATHER_STEP * 0.5;
  }
  for (let i = 0; i < parts.full; i += 1) {
    lines.push([at(along, 0), at(along + FEATHER_STEP, FEATHER_LEN)]);
    along -= FEATHER_STEP;
  }
  if (parts.half) {
    // A lone half feather is set in from the end, or it reads as a full one —
    // the difference between 5 kt and 10 kt.
    if (parts.pennants === 0 && parts.full === 0) along -= FEATHER_STEP;
    lines.push([at(along, 0), at(along + FEATHER_STEP / 2, FEATHER_LEN / 2)]);
  }
  return { lines, polygons };
}
