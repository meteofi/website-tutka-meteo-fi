// Contract test for the wind barb in src/metar/stationPlot.js.
//
//   node scripts/test-barb.mjs        (or: npm test)
//
// Why this one has a test: a barb is wrong silently. It draws, it looks like a
// barb, and it says the wrong thing about the weather — which is exactly what
// happened. The feathers leaned back toward the station instead of out toward
// the tip of the staff for as long as the layer existed, and nothing in lint, a
// build or a screenshot glance caught it; a user did.
//
// Three properties are pinned here, each of which has a way of going quietly
// wrong:
//
//   * the staff points FROM the direction the wind blows from, which is the
//     meteorological convention and the opposite of an arrow;
//   * the feathers are on the left of the staff looking outward, the northern-
//     hemisphere convention;
//   * the feathers sweep OUTWARD, their tips further along the staff than their
//     roots — matplotlib's `Barbs._make_barbs` puts each barb tip at
//     `endy + offset + full_width / 2`, i.e. beyond its root, and that is the
//     reference every meteorological plot follows.
//
// Plain node, no dependencies, no runner. Exit code 0 = pass.

// The .js extension is required: node's ESM resolver does not guess extensions,
// and this runs in bare node, not through webpack.
// eslint-disable-next-line import/extensions
import { barbParts, barbShape } from '../src/metar/barbShape.js';

let failures = 0;
function check(name, ok, detail) {
  if (ok) return;
  failures += 1;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
}

// Speed -> pennants / full / half. The rounding is to the nearest 5 kt.
const PARTS = [
  [0, { pennants: 0, full: 0, half: 0 }],
  [2, { pennants: 0, full: 0, half: 0 }],
  [3, { pennants: 0, full: 0, half: 1 }],
  [5, { pennants: 0, full: 0, half: 1 }],
  [10, { pennants: 0, full: 1, half: 0 }],
  [15, { pennants: 0, full: 1, half: 1 }],
  [25, { pennants: 0, full: 2, half: 1 }],
  [50, { pennants: 1, full: 0, half: 0 }],
  [65, { pennants: 1, full: 1, half: 1 }],
  [100, { pennants: 2, full: 0, half: 0 }],
];
PARTS.forEach(([kt, want]) => {
  const got = barbParts(kt);
  check(
    `barbParts(${kt})`,
    got.pennants === want.pennants && got.full === want.full && got.half === want.half,
    `wanted ${JSON.stringify(want)}, got ${JSON.stringify({
      pennants: got.pennants, full: got.full, half: got.half,
    })}`,
  );
});

// Geometry, read in the frame of the wind: `along` is distance from the station
// in the direction the wind comes from, `across` is to the left of that looking
// outward. Both are what the drawing code builds its points from, recovered here
// by projecting, so the test does not care which compass direction it is given.
function frame(directionDeg) {
  const rad = (directionDeg * Math.PI) / 180;
  const u = [Math.sin(rad), Math.cos(rad)];
  const v = [-u[1], u[0]];
  return (point) => ({
    along: point[0] * u[0] + point[1] * u[1],
    across: point[0] * v[0] + point[1] * v[1],
  });
}

// Every compass point, so no test passes by accident of symmetry.
[0, 45, 90, 135, 180, 225, 270, 315, 350].forEach((dir) => {
  const project = frame(dir);
  const { lines, polygons } = barbShape(dir, 65);
  const [shaft, ...feathers] = lines;
  const [start, end] = shaft.map(project);

  check(
    `dir ${dir}: staff points away from the station`,
    end.along > start.along && start.along > 0,
    `start ${start.along.toFixed(2)}, end ${end.along.toFixed(2)}`,
  );
  check(
    `dir ${dir}: staff is straight along the wind`,
    Math.abs(start.across) < 1e-9 && Math.abs(end.across) < 1e-9,
    `across ${start.across.toFixed(3)} / ${end.across.toFixed(3)}`,
  );

  feathers.forEach((feather, i) => {
    const [root, tip] = feather.map(project);
    check(
      `dir ${dir}: feather ${i} is on the left of the staff`,
      Math.abs(root.across) < 1e-9 && tip.across > 0,
      `root ${root.across.toFixed(2)}, tip ${tip.across.toFixed(2)}`,
    );
    // The property the layer got wrong.
    check(
      `dir ${dir}: feather ${i} sweeps outward, not back at the station`,
      tip.along > root.along,
      `root ${root.along.toFixed(2)}, tip ${tip.along.toFixed(2)}`,
    );
  });

  polygons.forEach((pennant, i) => {
    const ring = pennant.map(project);
    const apex = ring.reduce((best, p) => (p.across > best.across ? p : best), ring[0]);
    const root = ring.reduce((best, p) => (p.along > best.along
      && Math.abs(p.across) < 1e-9 ? p : best), { along: -Infinity, across: 0 });
    check(
      `dir ${dir}: pennant ${i} points left of the staff`,
      apex.across > 0,
      `apex across ${apex.across.toFixed(2)}`,
    );
    check(
      `dir ${dir}: pennant ${i} leans outward with the feathers`,
      apex.along > root.along,
      `apex ${apex.along.toFixed(2)}, root ${root.along.toFixed(2)}`,
    );
  });
});

// A lone half feather is set in from the end, or it reads as a full one at a
// glance — the difference between 5 kt and 10 kt.
{
  const project = frame(0);
  const staffEnd = project(barbShape(0, 5).lines[0][1]);
  const halfRoot = project(barbShape(0, 5).lines[1][0]);
  const fullRoot = project(barbShape(0, 10).lines[1][0]);
  check(
    'a lone half feather is set in from the end',
    halfRoot.along < staffEnd.along - 1e-9,
    `half at ${halfRoot.along.toFixed(2)}, staff ends ${staffEnd.along.toFixed(2)}`,
  );
  check(
    'a full feather sits at the end',
    Math.abs(fullRoot.along - staffEnd.along) < 1e-9,
    `full at ${fullRoot.along.toFixed(2)}, staff ends ${staffEnd.along.toFixed(2)}`,
  );
}

// Calm draws no barb at all: the plot says "tyyni" in words instead, and a
// zero-length staff would read as a 5 kt one.
{
  const { lines, polygons } = barbShape(0, 0);
  check(
    'calm draws the staff and nothing else',
    lines.length === 1 && polygons.length === 0,
    `${lines.length} lines, ${polygons.length} polygons`,
  );
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('barb geometry: all checks passed');
