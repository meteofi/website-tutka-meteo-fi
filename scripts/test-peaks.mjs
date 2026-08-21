// Contract test for src/edr/peaks.js — the peak-per-frame rule shared by the
// probe chart (src/probe.js) and the crosshair readout (src/crosshair.js).
//
//   node scripts/test-peaks.mjs        (or: npm test)
//
// Why this one module has a test when nothing else in the repo does: the two
// callers must agree about every point on the map, they used to do that by
// hand-copying the rule (issue #126), and the ways this can go wrong are all
// silent. A wrong answer here does not throw — it draws a slightly different
// number under the reticle than in the chart, or hides a real 0 dBZ echo as
// "no data". Nothing in lint, build or a smoke test would catch that, so the
// rule is pinned here instead.
//
// Plain node, no dependencies, no runner. Exit code 0 = pass.

// The .js extension is required: node's ESM resolver does not guess extensions,
// and this runs in bare node, not through webpack. eslint-disable rather than
// "fix", or the script stops running.
// eslint-disable-next-line import/extensions
import { peaksByFrame, frameIndexAt } from '../src/edr/peaks.js';

const FRAME_COUNT = 13;
const STEP = 300000; // 5 min
const T0 = Date.parse('2026-08-18T06:50:00Z');

// A series is written as [minutesFromWindowStart, value] pairs; expectations
// are sparse — every frame not named must come back null.
const mk = (pairs) => pairs.map(([mins, v]) => ({ t: T0 + mins * 60000, v }));

const CASES = [
  {
    name: 'one sample per frame lands in its own cell',
    series: [[0, 10], [5, 20], [10, 30], [60, 5]],
    floor: 0,
    expect: {
      0: 10, 1: 20, 2: 30, 12: 5,
    },
  },
  {
    name: 'several samples in one cell -> the peak wins',
    series: [[0, 10], [1, 35], [2, 12], [5, 7], [6, 41]],
    floor: 0,
    expect: { 0: 35, 1: 41 },
  },
  {
    name: 'exactly 0 survives a floor of 0 (it is a reading, not absence)',
    series: [[0, 0], [5, 0]],
    floor: 0,
    expect: { 0: 0, 1: 0 },
  },
  {
    name: 'samples below the floor are dropped, not clamped',
    series: [[0, -5], [5, 3], [10, -0.1]],
    floor: 0,
    expect: { 1: 3 },
  },
  {
    name: 'null values are skipped',
    series: [[0, null], [5, 12], [10, null]],
    floor: 0,
    expect: { 1: 12 },
  },
  {
    // The rule that separates this from a plain max. For a signed moment a
    // strong inbound velocity must beat a weaker outbound one.
    name: 'signed moment: largest MAGNITUDE wins, not largest value',
    series: [[0, -30], [1, 12], [5, 8], [6, -9]],
    floor: null,
    expect: { 0: -30, 1: -9 },
  },
  {
    name: 'signed moment: -22 beats +21',
    series: [[0, -22], [1, 21]],
    floor: null,
    expect: { 0: -22 },
  },
  {
    name: 'samples before the window are ignored',
    series: [[-30, 50], [0, 10]],
    floor: 0,
    expect: { 0: 10 },
  },
  {
    name: 'samples after the window are ignored',
    series: [[60, 10], [90, 99]],
    floor: 0,
    expect: { 12: 10 },
  },
  {
    name: 'edge: index 0 exactly',
    series: [[0, 17]],
    floor: 0,
    expect: { 0: 17 },
  },
  {
    name: 'edge: index 12 exactly (the last frame)',
    series: [[60, 23]],
    floor: 0,
    expect: { 12: 23 },
  },
  {
    // EDR reports arrive on their own cadence, not the animation's, so a
    // sample is attributed to the cell it is nearest.
    name: 'off-grid samples round to the nearest cell',
    series: [[2.4, 11], [2.6, 12]],
    floor: 0,
    expect: { 0: 11, 1: 12 },
  },
  {
    name: 'half-step boundaries round up (Math.round)',
    series: [[2.5, 44], [7.5, 45]],
    floor: 0,
    expect: { 1: 44, 2: 45 },
  },
  {
    // Note the split: with nearest-cell rounding on a 5-min step, 0/1/2 min
    // round to frame 0 and 3/4 min round to frame 1 — a 1-minute feed does NOT
    // pile into a single cell, it straddles the 2.5-min boundary.
    name: 'cadence finer than the animation step: peak per cell, split at the boundary',
    series: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]],
    floor: 0,
    expect: { 0: 3, 1: 5 },
  },
  {
    name: 'empty series', series: [], floor: 0, expect: {},
  },
  {
    name: 'all values null', series: [[0, null], [5, null]], floor: 0, expect: {},
  },
];

let failures = 0;
const fail = (msg) => { failures++; console.error(`  FAIL  ${msg}`); };

for (const c of CASES) {
  const got = peaksByFrame(mk(c.series), T0, STEP, FRAME_COUNT, c.floor);
  if (got.length !== FRAME_COUNT) {
    fail(`${c.name}: length ${got.length}, expected ${FRAME_COUNT}`);
    continue; // eslint-disable-line no-continue
  }
  for (let i = 0; i < FRAME_COUNT; i++) {
    const want = Object.prototype.hasOwnProperty.call(c.expect, i) ? c.expect[i] : null;
    // Strict: 0 must not compare equal to null, which is the whole point.
    if (got[i] !== want) fail(`${c.name}: frame ${i} = ${JSON.stringify(got[i])}, expected ${JSON.stringify(want)}`);
  }
}

// --- frameIndexAt --------------------------------------------------------
if (frameIndexAt(T0, T0, STEP) !== 0) fail('frameIndexAt: window start should be index 0');
if (frameIndexAt(T0 + 12 * STEP, T0, STEP) !== 12) fail('frameIndexAt: window end should be index 12');
if (frameIndexAt(T0 + 2.6 * 60000, T0, STEP) !== 1) fail('frameIndexAt: should round to nearest cell');
for (const bad of [0, -1, null, undefined, NaN]) {
  if (frameIndexAt(T0, T0, bad) !== null) fail(`frameIndexAt: step ${bad} should give null`);
}

// --- degenerate inputs must not throw ------------------------------------
for (const bad of [0, -1, null, undefined, NaN]) {
  const got = peaksByFrame(mk([[0, 10]]), T0, bad, FRAME_COUNT, 0);
  if (got.length !== FRAME_COUNT || got.some((v) => v !== null)) {
    fail(`peaksByFrame: step ${bad} should give all-null, got ${JSON.stringify(got)}`);
  }
}
for (const bad of [null, undefined, 'nope', 42, {}]) {
  const got = peaksByFrame(bad, T0, STEP, FRAME_COUNT, 0);
  if (got.length !== FRAME_COUNT || got.some((v) => v !== null)) {
    fail(`peaksByFrame: series ${JSON.stringify(bad)} should give all-null`);
  }
}

// --- the 0-dBZ trap, called out explicitly -------------------------------
// probe.js once stored cells as { val } and read them with `cell ? cell.val
// : null`. With plain numbers that test reports a real 0 as no-data.
const zero = peaksByFrame(mk([[0, 0]]), T0, STEP, FRAME_COUNT, 0);
if (zero[0] !== 0) fail('0 dBZ did not survive aggregation');
if (zero[0] == null) fail('0 dBZ reads as null');
if (zero[1] !== null) fail('empty cell should be null');

const total = CASES.length;
if (failures) {
  console.error(`\n${failures} failure(s) across ${total} cases`);
  process.exit(1);
}
console.log(`peaks.js contract: ${total} cases x ${FRAME_COUNT} frames + edge cases — all pass`);
