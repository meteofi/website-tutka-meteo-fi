// Contract test for src/particles/windField.js — the EDR Grid → texture path
// behind the wind particle layer (src/particles/windParticles.js).
//
//   node scripts/test-wind-field.mjs        (or: npm test)
//
// Everything pinned here fails silently in the app: a grid read in the wrong
// axis order, or with its rows upside down, still animates a perfectly
// plausible wind — it just blows the wrong way, and nobody comparing it with a
// forecast chart would guess the client rather than the model is wrong. Lint,
// build and a smoke test all pass either way, so the rules live here.
//
// Plain node, no dependencies, no runner. Exit code 0 = pass.

// The .js extension is required: node's ESM resolver does not guess extensions,
// and this runs in bare node, not through webpack.
/* eslint-disable import/extensions */
import {
  buildGridUrl, timeRangeIso, parseTemporalValues, pickFieldTime, parseGridCoverage, encodeField, decodeComponent,
} from '../src/particles/windField.js';
import { buildAreaUrl } from '../src/edr/areaQuery.js';
/* eslint-enable import/extensions */

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// A 3 × 2 grid whose value encodes its own position, so a misread shows up
// as a value at the wrong place: u = 10·col + row, v = -(10·col + row).
// Columns are lon 20, 21, 22; rows are lat 60, 61.
function grid({ xs, ys, axisNames, extraAxis = null }) {
  const nx = xs.length;
  const ny = ys.length;
  const u = [];
  const v = [];
  // Values are laid out in the order the axisNames say, so build the index
  // space generically: iterate the outer axis first.
  const order = axisNames.filter((n) => n === 'x' || n === 'y');
  const outerIsY = order[0] === 'y';
  const lonOf = (ix) => xs[ix];
  const latOf = (iy) => ys[iy];
  const cell = (ix, iy) => 10 * (lonOf(ix) - 20) + (latOf(iy) - 60);
  for (let a = 0; a < (outerIsY ? ny : nx); a++) {
    for (let b = 0; b < (outerIsY ? nx : ny); b++) {
      const ix = outerIsY ? b : a;
      const iy = outerIsY ? a : b;
      u.push(cell(ix, iy));
      v.push(-cell(ix, iy));
    }
  }
  const shape = order.map((n) => (n === 'x' ? nx : ny));
  const names = [...order];
  if (extraAxis) {
    names.unshift(extraAxis);
    shape.unshift(1);
  }
  return {
    type: 'Coverage',
    domain: {
      type: 'Domain',
      domainType: 'Grid',
      axes: { x: { values: xs }, y: { values: ys } },
    },
    ranges: {
      '10u': { type: 'NdArray', axisNames: names, shape, values: u },
      '10v': { type: 'NdArray', axisNames: names, shape, values: v },
    },
  };
}

// Every layout must decode to the same normalised field: row 0 = lat 60,
// col 0 = lon 20, u(col, row) = 10·col + row.
function expectCanonical(name, field) {
  check(`${name}: parsed`, !!field);
  if (!field) return;
  check(`${name}: size`, field.nx === 3 && field.ny === 2, `${field.nx}x${field.ny}`);
  check(`${name}: origin is the south-west cell centre`, near(field.lon0, 20) && near(field.lat0, 60), `${field.lon0},${field.lat0}`);
  check(`${name}: steps positive`, near(field.dLon, 1) && near(field.dLat, 1));
  let ok = true;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const i = row * 3 + col;
      if (!near(field.u[i], 10 * col + row) || !near(field.v[i], -(10 * col + row)) || field.valid[i] !== 1) ok = false;
    }
  }
  check(`${name}: every cell lands in its own place`, ok);
}

expectCanonical('y-outer ascending (the live shape)', parseGridCoverage(grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] }), '10u', '10v'));
expectCanonical('x-outer', parseGridCoverage(grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['x', 'y'] }), '10u', '10v'));
expectCanonical('descending latitude rows flip', parseGridCoverage(grid({ xs: [20, 21, 22], ys: [61, 60], axisNames: ['y', 'x'] }), '10u', '10v'));
expectCanonical('descending longitude columns flip', parseGridCoverage(grid({ xs: [22, 21, 20], ys: [60, 61], axisNames: ['y', 'x'] }), '10u', '10v'));
expectCanonical('length-1 time axis is accepted', parseGridCoverage(grid({
  xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'], extraAxis: 't',
}), '10u', '10v'));

{
  // start/stop/num axis form
  const g = grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] });
  g.domain.axes = { x: { start: 20, stop: 22, num: 3 }, y: { start: 60, stop: 61, num: 2 } };
  expectCanonical('start/stop/num axes', parseGridCoverage(g, '10u', '10v'));
}

{
  const g = grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] });
  g.ranges['10u'].values[4] = null; // row 1, col 1
  const f = parseGridCoverage(g, '10u', '10v');
  check('null → invalid cell, others untouched', f && f.valid[4] === 0 && f.valid[3] === 1 && f.valid[5] === 1);
  const enc = encodeField(f);
  check('invalid cell encodes calm with alpha 0', enc.data[4 * 4] === 128 && enc.data[4 * 4 + 1] === 128 && enc.data[4 * 4 + 3] === 0);
  check('valid cell has alpha 255', enc.data[3 * 4 + 3] === 255);
}

{
  const bad = [
    ['not a Grid', { type: 'Coverage', domain: { domainType: 'PointSeries', axes: { x: { values: [1] }, y: { values: [1] } } }, ranges: {} }],
    ['missing component', (() => { const g = grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] }); delete g.ranges['10v']; return g; })()],
    ['shape mismatch', (() => { const g = grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] }); g.ranges['10u'].shape = [3, 2]; return g; })()],
    ['irregular axis', (() => { const g = grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] }); g.domain.axes.x.values = [20, 21, 23]; return g; })()],
    ['single column', (() => { const g = grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] }); g.domain.axes.x.values = [20]; return g; })()],
    ['extra axis longer than 1', (() => {
      const g = grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] });
      g.ranges['10u'].axisNames = ['t', 'y', 'x']; g.ranges['10u'].shape = [2, 2, 3];
      g.ranges['10u'].values = g.ranges['10u'].values.concat(g.ranges['10u'].values);
      return g;
    })()],
    ['null json', null],
  ];
  for (const [name, json] of bad) {
    check(`rejects ${name}`, parseGridCoverage(json, '10u', '10v') === null);
  }
}

{
  // Encoding round-trips within one byte step, and the range is symmetric so
  // calm is the same byte on both channels.
  const f = parseGridCoverage(grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] }), '10u', '10v');
  const { data, range } = encodeField(f);
  check('range is the largest magnitude', near(range, 21));
  let worst = 0;
  for (let i = 0; i < 6; i++) {
    worst = Math.max(worst, Math.abs(decodeComponent(data[i * 4], range) - f.u[i]));
    worst = Math.max(worst, Math.abs(decodeComponent(data[i * 4 + 1], range) - f.v[i]));
  }
  check('round trip within one byte step', worst <= (2 * range) / 255 + 1e-9, `worst ${worst}`);
  const calm = parseGridCoverage(grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] }), '10u', '10v');
  calm.u.fill(0); calm.v.fill(0);
  const enc = encodeField(calm);
  check('all-calm field still has a usable range', enc.range >= 1 && enc.data[0] === 128 && enc.data[1] === 128);
}

{
  const meta = {
    extent: {
      temporal: {
        values: ['2026-09-08T09:00:00+00:00', '2026-09-08T06:00:00+00:00', 'garbage', '2026-09-08T12:00:00+00:00'],
      },
    },
  };
  const values = parseTemporalValues(meta);
  check('temporal values sorted, bad ones dropped, strings kept verbatim',
    values.length === 3 && values[0].iso === '2026-09-08T06:00:00+00:00' && values[2].iso === '2026-09-08T12:00:00+00:00');
  const t = (h, m = 0) => Date.parse(`2026-09-08T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  check('nearest step', pickFieldTime(values, t(8, 20)).iso === '2026-09-08T09:00:00+00:00');
  check('tie goes to the later step', pickFieldTime(values, t(7, 30)).iso === '2026-09-08T09:00:00+00:00');
  check('before the run → first step', pickFieldTime(values, t(1)).iso === '2026-09-08T06:00:00+00:00');
  check('after the run → last step', pickFieldTime(values, t(23)).iso === '2026-09-08T12:00:00+00:00');
  check('no steps → null', pickFieldTime([], t(8)) === null);
  check('no metadata → empty', parseTemporalValues(null).length === 0);
}

{
  const url = buildGridUrl('https://x/edr/collections/ecmwf-ifs/area', [19.5, 59, 32, 70.5], ['10v', '10u'], '2026-09-08T09:00:00+00:00');
  check('grid URL: sorted params, verbatim datetime, one-decimal polygon',
    url === 'https://x/edr/collections/ecmwf-ifs/area?f=CoverageJSON&parameter-name=10u%2C10v'
      + '&datetime=2026-09-08T09%3A00%3A00%2B00%3A00'
      + '&coords=POLYGON((19.5%2059.0%2C32.0%2059.0%2C32.0%2070.5%2C19.5%2070.5%2C19.5%2059.0))', url);
  // The polygon helper was extracted from buildAreaUrl — the observation and
  // lightning URLs must not have moved a byte.
  const area = buildAreaUrl('https://x/area', [19.5, 59, 32, 70.5], ['b', 'a'], Date.parse('2026-09-08T09:00:00Z'), Date.parse('2026-09-08T10:00:00Z'));
  check('area URL unchanged by the polygon extraction',
    area === 'https://x/area?f=CoverageJSON&parameter-name=a%2Cb&datetime=2026-09-08T09%3A00%3A00Z%2F2026-09-08T10%3A00%3A00Z'
      + '&coords=POLYGON((19.5%2059.0%2C32.0%2059.0%2C32.0%2070.5%2C19.5%2070.5%2C19.5%2059.0))', area);
}

{
  // The radar source's quality mask rides in as a third parameter and lands
  // in the B channel; a model field (no quality asked for) is full quality.
  const g = grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'], extraAxis: 't' });
  g.ranges.motion_quality = { type: 'NdArray', axisNames: ['t', 'y', 'x'], shape: [1, 2, 3], values: [1, 0, 1, 0, null, 1] };
  const f = parseGridCoverage(g, '10u', '10v', 'motion_quality');
  check('quality parsed per cell, null → 0', f && f.q[0] === 1 && f.q[1] === 0 && f.q[4] === 0 && f.q[5] === 1);
  const enc = encodeField(f);
  check('quality encodes into B', enc.data[0 * 4 + 2] === 255 && enc.data[1 * 4 + 2] === 0);
  check('motion is untouched by the mask', enc.data[1 * 4 + 3] === 255 && decodeComponent(enc.data[1 * 4], enc.range) > 9);
  check('asked-for quality that is missing rejects the document', parseGridCoverage(g, '10u', '10v', 'nope') === null);
  const model = parseGridCoverage(grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] }), '10u', '10v');
  check('no quality parameter → full quality', model.q.every((v) => v === 1) && encodeField(model).data[2] === 255);
  const flipped = grid({ xs: [20, 21, 22], ys: [61, 60], axisNames: ['y', 'x'] });
  flipped.ranges.motion_quality = { type: 'NdArray', axisNames: ['y', 'x'], shape: [2, 3], values: [0, 0, 0, 1, 1, 1] };
  const ff = parseGridCoverage(flipped, '10u', '10v', 'motion_quality');
  check('quality rows flip with the motion rows', ff && ff.q[0] === 1 && ff.q[3] === 0);
}

{
  // The radar's datetime is the animation window as an interval, seconds
  // precision, and it survives the URL builder intact.
  const range = timeRangeIso(Date.parse('2026-09-11T10:20:00.000Z'), Date.parse('2026-09-11T11:20:00.000Z'));
  check('window interval', range === '2026-09-11T10:20:00Z/2026-09-11T11:20:00Z', range);
  const url = buildGridUrl('https://x/area', [6.5, 55.5, 43.5, 73], ['motion_v', 'motion_u', 'motion_quality'], range);
  check('radar URL carries the interval and the sorted quality parameter',
    url === 'https://x/area?f=CoverageJSON&parameter-name=motion_quality%2Cmotion_u%2Cmotion_v'
      + '&datetime=2026-09-11T10%3A20%3A00Z%2F2026-09-11T11%3A20%3A00Z'
      + '&coords=POLYGON((6.5%2055.5%2C43.5%2055.5%2C43.5%2073.0%2C6.5%2073.0%2C6.5%2055.5))', url);
}

{
  // Clipped edge cells (the live radar grid's first row) are accepted with
  // the lattice anchored on the interior; an irregular interior is not.
  const g = grid({ xs: [20, 21, 22], ys: [60, 61], axisNames: ['y', 'x'] });
  g.domain.axes.y.values = [60.2, 61, 62, 63];
  g.ranges['10u'].shape = [4, 3]; g.ranges['10v'].shape = [4, 3];
  g.ranges['10u'].values = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3];
  g.ranges['10v'].values = g.ranges['10u'].values.map((v) => -v);
  const f = parseGridCoverage(g, '10u', '10v');
  check('clipped first row accepted', !!f && f.ny === 4);
  check('lattice anchored on the interior', f && near(f.lat0, 60) && near(f.dLat, 1), f && `${f.lat0} ${f.dLat}`);
  g.domain.axes.y.values = [63, 62, 61, 60.2];
  g.ranges['10u'].values.reverse(); g.ranges['10v'].values.reverse();
  const fd = parseGridCoverage(g, '10u', '10v');
  check('clipped edge on a descending axis', !!fd && near(fd.lat0, 60) && fd.u[0] === 0 && fd.u[9] === 3);
  // Irregularity inside the axis is still refused — on an axis long enough
  // to have an interior (four points give the edge rule nothing to check
  // against, which is fine: a four-cell field is not a field).
  g.domain.axes.y.values = [60, 61, 62, 62.4, 64, 65];
  g.ranges['10u'].shape = [6, 3]; g.ranges['10v'].shape = [6, 3];
  g.ranges['10u'].values = new Array(18).fill(1); g.ranges['10v'].values = new Array(18).fill(1);
  check('irregular interior still rejected', parseGridCoverage(g, '10u', '10v') === null);
  g.domain.axes.y.values = [60, 61, 62, 63, 64, 65.8];
  check('an edge cell wider than the step is not a clipped cell', parseGridCoverage(g, '10u', '10v') === null);
  g.domain.axes.y.values = [60.3, 61, 62, 63, 64, 64.7];
  check('both edges clipped is fine', parseGridCoverage(g, '10u', '10v') !== null);
}

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall passed');
