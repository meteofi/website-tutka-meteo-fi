// Contract test for src/edr/seriesFetch.js — the request/window bookkeeping
// shared by the probe chart and the crosshair readout.
//
//   node scripts/test-series-fetch.mjs
//
// The piece worth pinning is createFetchSlot's supersede rule. A stale response
// that arrives after a newer request has started must be DROPPED, not applied.
// Get that wrong and the symptom is a readout that briefly shows the value from
// where you just panned away — intermittent, unreproducible on demand, and
// invisible to lint, build and any smoke test.
//
// Plain node, no dependencies, no runner. Exit code 0 = pass.

// The .js extension is required: node's ESM resolver does not guess extensions.
// Block form, not disable-next-line: `eslint --fix` re-wraps this import and
// the reported line moves to the `from` clause.
/* eslint-disable import/extensions */
import {
  createFetchSlot, frameWindow, sameWindow, sameTarget,
} from '../src/edr/seriesFetch.js';
/* eslint-enable import/extensions */

let failures = 0;
const check = (name, cond) => {
  if (!cond) { failures++; console.error(`  FAIL  ${name}`); }
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// A task that resolves after `ms`, or rejects AbortError if its signal fires.
const task = (value, ms) => (signal) => new Promise((resolve, reject) => {
  const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  const t = setTimeout(() => resolve(value), ms);
  if (signal.aborted) { clearTimeout(t); reject(abortErr()); return; }
  signal.addEventListener('abort', () => { clearTimeout(t); reject(abortErr()); });
});

// --- createFetchSlot -----------------------------------------------------
{
  const slot = createFetchSlot();
  const r = await slot.run(task('A', 5));
  check('success returns ok + data', r && r.ok === true && r.data === 'A');
  check('slot is idle after success', slot.isBusy() === false);
}

{
  // The core rule: starting a second request supersedes the first.
  const slot = createFetchSlot();
  const p1 = slot.run(task('first', 50));
  await sleep(5);
  const p2 = slot.run(task('second', 10));
  const [r1, r2] = await Promise.all([p1, p2]);
  check('superseded request resolves undefined', r1 === undefined);
  check('winning request returns its data', r2 && r2.ok && r2.data === 'second');
  check('slot is idle after a supersede', slot.isBusy() === false);
}

{
  // A task that ignores its AbortSignal must STILL be dropped once superseded.
  // This is the guard that stops a stale value repainting fresh UI.
  const slot = createFetchSlot();
  const stubborn = () => new Promise((resolve) => { setTimeout(() => resolve('stale'), 40); });
  const p1 = slot.run(stubborn);
  await sleep(5);
  const p2 = slot.run(task('fresh', 5));
  const [r1, r2] = await Promise.all([p1, p2]);
  check('stale response from a signal-ignoring task is dropped', r1 === undefined);
  check('fresh response survives', r2 && r2.data === 'fresh');
}

{
  // A real failure must be reported, not swallowed as if it were an abort.
  const slot = createFetchSlot();
  const r = await slot.run(async () => { throw new Error('EDR 500'); });
  check('real error returns ok:false', r && r.ok === false);
  check('real error carries its cause', r && r.error && /EDR 500/.test(r.error.message));
  check('slot is idle after an error', slot.isBusy() === false);
}

{
  const slot = createFetchSlot();
  const p = slot.run(task('X', 50));
  check('isBusy is true while in flight', slot.isBusy() === true);
  slot.abort();
  check('explicit abort resolves undefined', (await p) === undefined);
  check('slot is idle after abort', slot.isBusy() === false);
}

{
  const slot = createFetchSlot();
  slot.abort();
  check('abort with nothing in flight is safe', slot.isBusy() === false);
}

// --- window / target helpers ---------------------------------------------
{
  const T0 = Date.parse('2026-08-18T06:50:00Z');
  const STEP = 300000;
  const w = frameWindow(T0, STEP);
  check('window starts at the given start', w[0] === T0);
  check('window spans 12 steps (60 min), not 13', (w[1] - w[0]) === 12 * STEP);

  check('sameWindow: equal', sameWindow([1, 2], [1, 2]) === true);
  check('sameWindow: different end', sameWindow([1, 2], [1, 3]) === false);
  check('sameWindow: null is never equal', sameWindow(null, [1, 2]) === false);

  const t = { collection: 'c', parameter: 'p', z: null };
  check('sameTarget: equal', sameTarget(t, { collection: 'c', parameter: 'p', z: null }) === true);
  check('sameTarget: elevation change', sameTarget(t, { collection: 'c', parameter: 'p', z: 1.5 }) === false);
  check('sameTarget: collection change', sameTarget(t, { collection: 'd', parameter: 'p', z: null }) === false);
  check('sameTarget: null is never equal', sameTarget(null, t) === false);
  // A null collection is a real state: a layer with no EDR equivalent.
  const none = { collection: null, parameter: 'reflectivity', z: null };
  check('sameTarget: null collection compares equal to itself', sameTarget(none, { ...none }) === true);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('seriesFetch contract: supersede, abort, error and window/target rules — all pass');
