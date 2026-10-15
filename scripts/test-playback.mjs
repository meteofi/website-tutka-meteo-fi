// Run the actual RAF/control functions and FramePool pair selection with a
// deterministic clock. Browser scheduling, GPU output and WMS loads are faked;
// no copied playback algorithm. These mistakes still draw plausible pictures.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import vm from 'node:vm';
/* eslint-disable import/extensions */
import ImageLayer from 'ol/layer/Image.js';
import ImageWMS from 'ol/source/ImageWMS.js';
import { FRAME_COUNT, FRAME_STEPS } from '../src/constants.js';
import playbackPhase from '../src/animation/playbackPhase.js';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next((specifier.startsWith('.') || specifier.startsWith('ol/')) && !specifier.endsWith('.js')
      ? `${specifier}.js` : specifier, context);
  },
});
const { default: FramePool } = await import('../src/animation/framePool.js');
hooks.deregister();
/* eslint-enable import/extensions */

// The entry point also boots the whole UI; evaluate just its clock/control
// region, keeping its actual dependencies injectable. Fail if it moves.
const source = await readFile(new URL('../src/radar.js', import.meta.url), 'utf8');
const begin = source.indexOf('function anyPoolZooming()');
const end = source.indexOf('// Start Animation', begin);
assert.ok(begin >= 0 && end > begin, 'locate the production clock/control region');
const code = `${source.slice(begin, end)}\nglobalThis.controls = { play, stop, skipNext, skipPrevious };`;
const times = Array.from({ length: FRAME_COUNT }, (_, i) => new Date(Date.UTC(2026, 9, 10, 6, i * 5)).toISOString());

function harness({
  paneCount = 1, frameRate = 2, start = 0, initialIndex = 0,
} = {}) {
  let now = start;
  let index = initialIndex;
  let nextId = 0;
  const callbacks = new Map();
  const advances = [];
  const draws = [];
  const state = { animating: false, zooming: false, ready: true };
  const panes = Array.from({ length: paneCount }, (_, paneIndex) => {
    const pool = Object.create(FramePool.prototype);
    const primary = new ImageLayer({ opacity: 0.6, visible: true });
    const warpSource = {
      changed() {
        if (!pool.interpActive) return;
        const { timeA, timeB, t } = pool._warpState;
        draws.push({
          now, paneIndex, timeA, timeB, t,
        });
      },
    };
    Object.assign(pool, {
      primary,
      size: FRAME_COUNT,
      slots: times.map((time) => ({
        time,
        source: new ImageWMS({
          url: 'https://example.test/wms', params: { TIME: time, STYLES: 'radar_fmi', ELEVATION: '500' },
        }),
      })),
      windowTimes: times,
      currentTime: null,
      interpActive: false,
      _userOpacity: 0.6,
      _warpState: { timeA: null, timeB: null, t: 0 },
      _flowQueue: { prioritize() {} },
      interpolator: {
        hasFlow: () => state.ready,
        prefetch(upcoming) { state.prefetched = upcoming; },
      },
      warpLayer: { getSource: () => warpSource, setVisible() {} },
      _viewExtent: () => [0, 0, 100, 100],
      _pumpLoads() {},
      isZoomGestureActive: () => state.zooming,
    });
    pool.showTime(times[index]);
    return { framePools: { radarLayer: pool }, VISIBLE: new Set(['radarLayer']), LAYER_IN_RANGE: {} };
  });
  const context = {
    playbackPhase,
    animationId: null,
    lastAdvance: 0,
    lastWarpTick: 0,
    isInteracting: false,
    IS_FOLLOWING: false,
    options: { frameRate },
    debug() {},
    document: { getElementById: () => ({ innerHTML: '' }) },
    window: {
      performance: { now: () => now },
      requestAnimationFrame: (callback) => { callbacks.set(++nextId, callback); return nextId; },
      cancelAnimationFrame: (id) => callbacks.delete(id),
    },
    map: { getView: () => ({ getAnimating: () => state.animating }) },
    activePanes: () => panes,
    setTime(action) {
      index = (index + (action === 'previous' ? FRAME_STEPS : 1)) % FRAME_COUNT;
      advances.push(now);
      for (const pane of panes) pane.framePools.radarLayer.showTime(times[index]);
    },
  };
  vm.runInNewContext(code, context, { filename: 'radar.js playback controls' });
  context.controls.play();
  draws.length = 0; // activation invalidates an empty canvas; not a sampled pair
  return {
    state,
    context,
    panes,
    draws,
    advances,
    frame(at) {
      now = at;
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach((callback) => callback(at));
      assert.ok(callbacks.size <= 1, 'one shared RAF, regardless of pane count');
    },
  };
}

for (const paneCount of [1, 2, 4]) {
  const h = harness({ paneCount });
  h.frame(480);
  assert.deepEqual(h.state.prefetched, [times[2], times[3]], 'first pair prepares its successors');
  h.frame(500); // only 20 ms since last warp: the boundary must bypass throttling
  assert.equal(h.advances.length, 1);
  for (let i = 0; i < paneCount; i++) {
    const last = h.draws.filter((d) => d.paneIndex === i).at(-1);
    assert.equal(last.now, 500, 'advance and warp happen in the same RAF');
    assert.equal(last.timeA, times[1]);
    assert.equal(last.timeB, times[2]);
    assert.equal(last.t, 0);
  }
}

// Non-aligned starts matter: RAF samples are tied to the display clock, not
// play(). The displayed phase must track elapsed time without cumulative drift.
for (const refresh of [60, 120, 144]) {
  for (const frameRate of [1, 2, 4]) {
    const start = 7;
    const interval = 1000 / refresh;
    const h = harness({ frameRate, start });
    for (let i = 1; i <= 2 * refresh; i++) h.frame(i * interval);
    for (const d of h.draws) {
      assert.ok(d.t >= 0 && d.t < 1, 'fraction stays inside the observation pair');
      const position = times.indexOf(d.timeA) + d.t;
      assert.ok(
        Math.abs(position - ((d.now - start) * frameRate) / 1000) < 1e-9,
        `${refresh} Hz / ${frameRate} fps: no lost overshoot`,
      );
    }
    const gaps = h.draws.slice(1).map((d, i) => d.now - h.draws[i].now);
    assert.ok(
      Math.max(...gaps) <= Math.ceil(33 / interval) * interval + 1e-9,
      `${refresh} Hz / ${frameRate} fps: no extra gap at observation boundaries`,
    );
  }
}

{
  const h = harness({ start: 100 });
  h.frame(99);
  h.frame(134);
  assert.ok(h.draws.every((d) => d.t >= 0), 'RAF timestamp before play() cannot run backwards');
}

{
  const h = harness();
  h.frame(480);
  h.frame(517);
  assert.ok(Math.abs(h.draws.at(-1).t - 0.034) < 1e-9, 'short stalls carry their remainder');
  h.frame(10000);
  assert.equal(h.advances.length, 2, 'suspended tabs advance only one observation on resume');
  assert.equal(h.draws.at(-1).timeA, times[2]);
  assert.equal(h.draws.at(-1).t, 0, 'resume starts at the new observation');
  h.frame(10017);
  assert.equal(h.advances.length, 2, 'no catch-up burst on subsequent RAFs');
}

for (const gate of ['drag', 'animating', 'zooming']) {
  const h = harness();
  if (gate === 'drag') h.context.isInteracting = true;
  else h.state[gate] = true;
  h.frame(1000);
  assert.equal(h.advances.length, 0, `${gate} blocks advance`);
  assert.equal(h.draws.length, 0, `${gate} blocks warp rendering`);
}

for (const mode of ['hidden', 'out-of-range', 'no-interpolator']) {
  const h = harness();
  const pane = h.panes[0];
  if (mode === 'hidden') pane.VISIBLE.clear();
  if (mode === 'out-of-range') pane.LAYER_IN_RANGE.radarLayer = false;
  if (mode === 'no-interpolator') pane.framePools.radarLayer.interpolator = null;
  h.frame(500);
  assert.equal(h.advances.length, 1, `${mode} does not stop the shared clock`);
  assert.equal(h.draws.length, 0, `${mode} must not render a warp`);
}

{
  const h = harness({ initialIndex: FRAME_STEPS - 1 });
  h.frame(480);
  h.frame(500);
  assert.equal(h.draws.at(-1).timeA, times[FRAME_STEPS - 1]);
  assert.equal(h.draws.at(-1).timeB, times[FRAME_STEPS]);
  assert.equal(h.draws.at(-1).t, 1, 'last frame holds the previous pair at its endpoint');
  assert.deepEqual(h.state.prefetched, [times[0], times[1]], 'last pair prepares loop start without a wrap flow');
  h.frame(1000);
  assert.equal(h.draws.at(-1).timeA, times[0]);
  assert.equal(h.draws.at(-1).timeB, times[1]);
  assert.equal(h.draws.at(-1).t, 0, 'wrap paints the first pair immediately, never end-to-start flow');
}

{
  const h = harness();
  const pool = h.panes[0].framePools.radarLayer;
  h.frame(480);
  assert.equal(pool.primary.getOpacity(), 0);
  h.state.ready = false;
  h.frame(500);
  assert.equal(pool.primary.getOpacity(), 0.6, 'missing flow restores the user opacity in the boundary RAF');
  assert.equal(h.draws.at(-1).timeA, null, 'missing flow clears the previous pair immediately');
  h.state.ready = true;
  h.frame(540);
  assert.equal(h.draws.at(-1).timeA, times[1]);
  assert.equal(pool.primary.getOpacity(), 0);
  h.context.controls.stop();
  assert.deepEqual(h.state.prefetched, [], 'pause cancels pending uploads');
  assert.equal(pool.primary.getOpacity(), 0.6, 'pause restores the discrete frame');
  const count = h.advances.length;
  h.frame(2000);
  assert.equal(h.advances.length, count, 'stopped playback cannot advance');
  h.context.controls.skipNext();
  assert.equal(pool.currentTime, times[2], 'step remains discrete');
  h.context.controls.skipPrevious();
  assert.equal(pool.currentTime, times[1]);
  h.context.controls.play();
  h.frame(2020);
  assert.equal(h.draws.at(-1).timeA, times[1], 'play starts from the chosen observation');
  assert.equal(h.draws.at(-1).t, 0.04);
  assert.equal(pool.primary.getSource().getParams().STYLES, 'radar_fmi');
  assert.equal(pool.primary.getSource().getParams().ELEVATION, '500');
}

console.log('Playback: boundary timing, drift, suspension, gates, wrap, opacity and 1/2/4 panes passed.'); // eslint-disable-line no-console
