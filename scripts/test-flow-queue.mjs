/* eslint-disable import/extensions, no-console */
// Scheduling is shared by independent pools; verify fairness and cancellation
// with an actual callback queue rather than replacing the scheduler itself.
import assert from 'node:assert/strict';
import FlowQueue from '../src/animation/flowQueue.js';
import { FRAME_STEPS } from '../src/constants.js';

const callbacks = new Map();
let serial = 0;
globalThis.requestAnimationFrame = (run) => { callbacks.set(++serial, run); return serial; };
globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
const tick = () => {
  const batch = [...callbacks.values()]; callbacks.clear();
  for (const run of batch) run();
};
const completed = [];
const panes = Array.from({ length: 4 }, () => new FlowQueue());
for (const [pane, queue] of panes.entries()) {
  for (let pair = 0; pair < FRAME_STEPS; pair++) {
    queue.add(pair, () => completed.push([pane, pair]));
  }
  queue.prioritize(5);
}
assert.equal(completed.length, 0, 'enqueueing a full window cannot run GPU work inline');
assert.equal(callbacks.size, 1, 'one shared callback regardless of pane count');
for (let i = 0; i < panes.length; i++) {
  tick();
  assert.equal(completed.length, i + 1, 'at most one pair per animation frame');
  assert.deepEqual(completed[i], [i, 5], 'visible pairs in all panes precede backfill');
}
panes[0].prioritize(7);
panes[0].add(7, () => completed.push([0, 'replacement']));
tick();
assert.deepEqual(completed.at(-1), [0, 'replacement'], 'a seek reprioritizes and duplicate jobs replace');
for (const queue of panes) queue.retain(new Set([0, 1]));
panes[0].clear();
const count = completed.length;
for (let i = 0; i < 6; i++) tick();
assert.equal(completed.length - count, 6, 'only the retained pairs of remaining panes run');
assert.equal(callbacks.size, 0, 'drained queues do not keep an animation loop alive');
assert.ok(panes.every((q) => q.jobs.size === 0));

panes[0].add('obsolete', () => assert.fail('cancelled job ran'));
panes[0].clear();
assert.equal(callbacks.size, 0, 'clearing the last owner cancels its callback');
panes[0].add('failure', () => { throw new Error('renderer failure'); });
panes[1].add('survivor', () => completed.push('survivor'));
assert.throws(tick, /renderer failure/);
tick();
assert.equal(completed.at(-1), 'survivor', 'one renderer error must not strand other panes');
assert.equal(callbacks.size, 0);

panes[0].add('outer', () => panes[0].add('inner', () => completed.push('inner')));
tick();
assert.notEqual(completed.at(-1), 'inner', 'new work yields to the next frame');
tick();
assert.equal(completed.at(-1), 'inner');
assert.equal(callbacks.size, 0);
console.log('Flow queue: bounded work, visible-pair priority, fairness, deduplication, cancellation and errors passed.');
