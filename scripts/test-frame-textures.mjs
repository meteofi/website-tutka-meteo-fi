/* eslint-disable import/extensions, no-console */
// GPU residency is independent of the 13-frame observation window. Exercise
// actual upload helpers with counted allocations, including eviction order.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { FRAME_COUNT, FRAME_STEPS } from '../src/constants.js';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(specifier === './glUtils' ? './glUtils.js' : specifier, context);
  },
});
const { default: FrameTextures } = await import('../src/animation/interpolation/frameTextures.js');
hooks.deregister();

const callbacks = new Map();
let request = 0;
globalThis.requestAnimationFrame = (callback) => { callbacks.set(++request, callback); return request; };
globalThis.cancelAnimationFrame = (id) => callbacks.delete(id);
const tick = () => {
  const batch = [...callbacks.values()]; callbacks.clear();
  for (const callback of batch) callback();
};
let serial = 0;
let peak = 0;
let bound;
let uploads = 0;
const allocated = new Map();
const gl = {
  lost: false,
  isContextLost() { return this.lost; },
  createTexture() {
    const texture = { id: ++serial };
    allocated.set(texture, null);
    peak = Math.max(peak, allocated.size);
    return texture;
  },
  deleteTexture(texture) {
    assert.equal(this.lost, false, 'do not operate on lost handles');
    allocated.delete(texture);
  },
  bindTexture(target, texture) { bound = texture; },
  texImage2D(...args) { uploads++; allocated.set(bound, args.at(-1)); },
  pixelStorei() {},
  texParameteri() {},
};
const cache = new FrameTextures(gl);
const frames = Array.from({ length: FRAME_COUNT }, (_, i) => ({
  image: { id: `image-${i}` }, width: 2400, height: 1350,
}));
const first = cache.get(frames[0]);
cache.get(frames[1]); cache.get(frames[2]); cache.get(frames[3]);
assert.equal(cache.get(frames[0]), first, 'recent use retains the same GPU object');
cache.get(frames[4]);
assert.equal(cache.entries.has(frames[1]), false, 'evict least recently used, not the active pair');
assert.equal(cache.entries.has(frames[0]), true);
for (const frame of frames) cache.get(frame);
assert.equal(peak, 4, 'evict before allocating a fifth full-resolution texture');
assert.equal(allocated.size, 4);
assert.equal(allocated.has(first), false);
const restored = cache.get(frames[0]);
assert.notEqual(restored, first);
assert.equal(allocated.get(restored), frames[0].image, 're-upload the original decoded image');
const before = uploads;
for (let i = 0; i < 120; i++) { cache.get(frames[0]); cache.get(frames[1]); }
assert.equal(uploads - before, 1, 'upload missing B once, never on subsequent animation ticks');
cache.delete(frames[0]);
assert.equal(allocated.has(restored), false);
const replacement = { ...frames[0], image: { id: 'replacement image' } };
assert.equal(allocated.get(cache.get(replacement)), replacement.image);
cache.dispose();
assert.equal(allocated.size, 0);
assert.equal(cache.entries.size, 0, 'release image references as well as GPU handles');
cache.get(frames[0]);
gl.lost = true;
cache.dispose();
assert.equal(cache.entries.size, 0);
allocated.clear();
gl.lost = false;
const afterLoss = cache.get(frames[0]);
assert.notEqual(afterLoss, restored);
cache.dispose();

// Four panes share one upload per animation frame. Upcoming frames are ready
// before the pair changes; repeatedly requesting them must not re-upload them.
const panes = Array.from({ length: 4 }, () => new FrameTextures(gl));
for (const pane of panes) {
  pane.get(frames[0]); pane.get(frames[1]);
  pane.prefetch([frames[2], frames[3]]);
}
for (let i = 0; i < 8; i++) {
  const previous = uploads;
  tick();
  assert.equal(uploads - previous, 1, 'spread uploads across frames and panes');
  for (const pane of panes) {
    pane.get(frames[0]); pane.get(frames[1]);
    pane.prefetch([frames[2], frames[3]]);
  }
}
assert.equal(callbacks.size, 0);
const warm = uploads;
for (const pane of panes) {
  pane.get(frames[1]); pane.get(frames[2]);
  assert.equal(pane.entries.size, 4);
}
assert.equal(uploads, warm, 'pair transition needs no upload after prefetch');
for (let i = 1; i < FRAME_COUNT * 2; i++) {
  const a = i % FRAME_COUNT;
  const b = Math.min(a + 1, FRAME_STEPS);
  const upcoming = [frames[(b + 1) % FRAME_COUNT], frames[(b + 2) % FRAME_COUNT]];
  const beforeTransition = uploads;
  let missing = 0;
  for (const pane of panes) {
    pane.get(frames[b - 1]); pane.get(frames[b]);
    missing += upcoming.filter((frame) => !pane.entries.has(frame)).length;
    pane.prefetch(upcoming);
  }
  assert.equal(uploads, beforeTransition, 'sequential playback and wrap use prepared images');
  for (let j = 0; j < 8; j++) {
    tick();
    for (const pane of panes) {
      pane.get(frames[b - 1]); pane.get(frames[b]);
      pane.prefetch(upcoming);
    }
  }
  assert.equal(uploads - beforeTransition, missing, 'retain already prepared images instead of churning them');
}
for (const pane of panes) pane.dispose();
assert.equal(allocated.size, 0);

cache.prefetch([frames[0], frames[1]]);
cache.delete(frames[0]);
tick();
assert.equal(cache.entries.has(frames[0]), false, 'invalidated pending frame cannot resurrect');
assert.equal(cache.entries.has(frames[1]), true);
cache.prefetch([frames[2]]);
cache.dispose();
assert.equal(callbacks.size, 0, 'disposing a pane cancels pending work');
cache.prefetch([frames[0]]);
gl.lost = true;
tick();
assert.equal(cache.entries.size, 0, 'loss before its event prevents pending upload');
assert.equal(callbacks.size, 0);
gl.lost = false;
console.log('Frame textures: bounded allocations, reuse, eviction, prefetch, invalidation and context loss passed.');
