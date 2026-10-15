/* eslint-disable import/extensions, no-console */
// Real interpolator lifecycle + FramePool/StickyImageWMS bookkeeping. Only GPU
// operations, map painting and network completion are replaced. Browser tests
// separately exercise actual WEBGL_lose_context and rendered pixels.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import Collection from 'ol/Collection.js';
import View from 'ol/View.js';
import ImageLayer from 'ol/layer/Image.js';
import ImageState from 'ol/ImageState.js';
import { FRAME_COUNT, FRAME_STEPS } from '../src/constants.js';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/interpolation/index.js')
      && ['./warp', './flowRadar', './flowLK', './trajectories'].includes(specifier)) {
      return { url: `test:${specifier.slice(2)}`, shortCircuit: true };
    }
    if ((specifier.startsWith('.') || specifier.startsWith('ol/')) && !/\.[a-z]+$/.test(specifier)) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith('test:')) return next(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
      export const RADAR_FLOW_RESOLUTION = 384;
      export default class Resource {
        constructor(gl) {
          if (gl.failBuild) throw new Error('Injected build failure');
          this.gl = gl; this.generation = gl.generation; gl.builds++;
        }
        compute() {
          if (this.gl.loseDuringCompute) { this.gl.lost = true; throw new Error('Lost during compute'); }
          if (this.gl.failCompute) throw new Error('Injected compute failure');
          const texture = this.gl.createTexture();
          return ${url === 'test:flowLK' ? 'texture' : '{texture, width: 32, height: 32}'};
        }
        get() {
          if (this.gl.loseDuringDraw) { this.gl.lost = true; throw new Error('Lost during draw'); }
          return this.gl.createTexture();
        }
        render() { if (this.generation !== this.gl.generation) throw new Error('Old GPU resource'); }
        clear() {} dispose() { this.gl.releases++; }
      }
    `,
    };
  },
});
const { RadarInterpolator } = await import('../src/animation/interpolation/index.js');
const { default: FramePool } = await import('../src/animation/framePool.js');
const { default: StickyImageWMS } = await import('../src/animation/stickyImageWMS.js');
hooks.deregister();

class Canvas extends EventTarget {
  constructor() {
    super();
    this.gl = {
      generation: 0,
      builds: 0,
      releases: 0,
      lost: false,
      extensions: 0,
      getExtension() { this.extensions++; return {}; },
      isContextLost() { return this.lost; },
      createTexture() { return { generation: this.generation }; },
      deleteTexture() {},
      bindTexture() {},
      pixelStorei() {},
      texImage2D() {},
      texParameteri() {},
      bindFramebuffer() {},
      clearColor() {},
      clear() {},
      flush() {},
    };
  }

  getContext() { return this.gl; }
}
const originalDocument = globalThis.document;
globalThis.document = { createElement: () => new Canvas() };
// Upload scheduling is exercised separately by test-frame-textures.mjs.
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const extent = [-32, -32, 32, 32];
const times = Array.from({ length: FRAME_COUNT + 1 }, (_, i) => new Date(Date.UTC(2026, 9, 14, 12, i * 5)).toISOString());

function harness(profile = 'radar') {
  const layers = new Collection();
  const view = new View({ center: [0, 0], resolution: 1 });
  const primary = new ImageLayer({
    name: 'radar',
    opacity: 0.37,
    source: new StickyImageWMS({
      url: 'https://example.invalid/wms', params: { LAYERS: 'radar', STYLES: 'radar_fmi', ELEVATION: '500' },
    }),
  });
  layers.push(primary);
  const map = {
    addLayer: (l) => layers.push(l),
    removeLayer: (l) => layers.remove(l),
    getLayers: () => layers,
    getView: () => view,
    getSize: () => [32, 32],
    on() {},
    render() {},
  };
  const pool = new FramePool({ primaryLayer: primary, map });
  const requests = [];
  for (const slot of pool.slots) {
    slot.source.triggerLoad = () => {
      slot.source.image = { getState: () => ImageState.LOADING };
      requests.push(slot.time);
    };
  }
  const complete = (time, color = 'current', bounds = extent) => {
    const slot = pool.slots.find((s) => s.time === time);
    const image = {
      complete: true, naturalWidth: 64, naturalHeight: 64, color,
    };
    const wrapper = { getImage: () => image, getExtent: () => bounds.slice(), getState: () => ImageState.LOADED };
    slot.source.image = wrapper;
    slot.source.dispatchEvent({ type: 'imageloadend', image: wrapper });
    return wrapper;
  };
  pool.setWindow(times.slice(0, FRAME_COUNT));
  pool.showTime(times[0]); // Establish the real request anchor before completions.
  for (const time of pool.windowTimes) complete(time);
  const engine = new RadarInterpolator({ useFlow: true, motionProfile: profile });
  pool.setInterpolator(engine);
  pool.refreshFlows();
  pool.setInterpActive(true);
  pool.showInterpolated(0.4);
  assert.equal(primary.getOpacity(), 0);
  const lose = () => {
    engine.gl.lost = true;
    // Calls before the asynchronous loss event must not use dead handles.
    assert.equal(engine.hasFlow(times[0], times[1]), false);
    const event = new Event('webglcontextlost', { cancelable: true });
    engine.canvas.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(primary.getOpacity(), primary.get('_userOpacity'));
    assert.equal(pool._warpState.timeA, null);
    assert.equal(engine.frames.size, 0);
    assert.equal(engine.flows.size, 0);
  };
  const restore = () => {
    const before = requests.length;
    engine.gl.generation++;
    engine.gl.lost = false;
    engine.canvas.dispatchEvent(new Event('webglcontextrestored'));
    assert.equal(requests.length, before, 'restoration must not refetch WMS images');
  };
  return {
    pool, engine, primary, view, complete, lose, restore, layers,
  };
}

try {
  for (const profile of ['radar', 'satellite']) {
    const h = harness(profile);
    const { pool, engine, primary } = h;
    const ready = [];
    pool.onFlowStateChange = (i, value) => { ready[i] = value; };
    for (let cycle = 0; cycle < 3; cycle++) {
      h.lose();
      assert.ok(ready.slice(0, FRAME_STEPS).every((v) => !v));
      h.restore();
      assert.equal(engine.contextLost, false);
      assert.equal(engine.frames.size, FRAME_COUNT);
      assert.equal(engine.flows.size, FRAME_STEPS);
      assert.ok(ready.slice(0, FRAME_STEPS).every(Boolean));
      assert.equal(engine.gl.extensions, 2 * (cycle + 2));
      for (const index of [0, FRAME_STEPS]) {
        pool.showTime(times[index]); pool.showInterpolated(0.4);
        assert.equal(primary.getOpacity(), 0);
        assert.equal(pool._warpState.t, index === FRAME_STEPS ? 1 : 0.4);
        const { timeA, timeB, t } = pool._warpState;
        assert.ok(engine.renderAt(timeA, timeB, t));
      }
      assert.equal(engine.hasFlow(times[FRAME_STEPS], times[0]), false, 'never bridge loop end');
    }
    pool.setInterpActive(false);
    h.lose();
    primary.setOpacity(0.61);
    engine.setUseFlow(false);
    pool.refreshFlows();
    h.restore();
    assert.equal(primary.getOpacity(), 0.61);
    assert.equal(pool.interpActive, false);
    assert.equal(pool.warpLayer.getVisible(), false);
    assert.ok([...engine.flows.values()].every((f) => f.width === 1), 'honour mode changed while lost');
    pool.setInterpolator(null);
  }
  console.log('ok repeated radar/satellite recovery, endpoints, paused opacity and mode changes');

  {
    const h = harness(); const { pool, engine } = h;
    h.lose();
    pool.setWindow(times.slice(1));
    h.complete(times[FRAME_COUNT], 'arrived during loss');
    assert.equal(engine.frames.size, 0);
    h.restore();
    assert.equal(engine.frames.size, FRAME_COUNT);
    assert.equal(engine.frames.has(times[0]), false);
    assert.ok(engine.frames.has(times[FRAME_COUNT]));
    assert.equal(engine.flows.size, FRAME_STEPS);
    pool.setInterpolator(null);
  }
  console.log('ok window slide and frame arriving while the GPU is unavailable');

  {
    const h = harness(); const { pool, engine, primary } = h;
    const slot = pool.slots.find((s) => s.time === times[0]);
    const superseded = slot.source.image;
    h.lose();
    primary.getSource().updateParams({ LAYERS: 'replacement', STYLES: 'default', ELEVATION: '1000' });
    h.complete(times[0], 'replacement');
    h.complete(times[1], 'replacement');
    slot.source.dispatchEvent({ type: 'imageloadend', image: superseded });
    h.restore();
    assert.deepEqual([...engine.frames.keys()], [times[0], times[1]]);
    assert.equal(engine.flows.size, 1);
    assert.equal(slot.source._sticky.getImage().color, 'replacement');
    h.complete(times[2], 'late replacement');
    assert.equal(engine.flows.size, 2, 'normal loading resumes after restoration');
    pool.setInterpolator(null);
  }
  console.log('ok product/style/elevation change and obsolete in-flight image completion');

  {
    const h = harness(); const { pool, engine, view } = h;
    h.lose();
    view.setCenter([1000, 1000]);
    pool._handleMoveend();
    h.complete(times[0], 'new extent', [968, 968, 1032, 1032]);
    h.complete(times[1], 'new extent', [968, 968, 1032, 1032]);
    h.restore();
    assert.equal(engine.frames.size, 2, 'do not restore stale pan-buffer bitmaps');
    assert.equal(engine.hasFlow(times[0], times[1], [984, 984, 1016, 1016]), true);
    pool.setInterpolator(null);
  }
  console.log('ok pan invalidation during context loss');

  {
    const h = harness(); const { pool, engine, layers } = h;
    h.lose();
    pool.setInterpolator(null);
    const count = layers.getLength(); const { builds } = engine.gl;
    h.restore();
    assert.equal(pool.interpolator, null);
    assert.equal(layers.getLength(), count);
    assert.equal(engine.gl.builds, builds, 'detached renderer must not rebuild');
    assert.equal(engine.onContextChange, null);
    engine.dispose();
  }
  console.log('ok interpolation disabled or pane detached before restore');

  {
    const h = harness(); const { pool, engine, primary } = h;
    h.lose(); engine.gl.failBuild = true;
    const originalWarn = console.warn; const warnings = [];
    console.warn = (...args) => warnings.push(args);
    try { h.restore(); } finally { console.warn = originalWarn; }
    assert.equal(warnings.length, 1);
    assert.equal(engine.contextLost, true);
    assert.equal(primary.getOpacity(), 0.37);
    assert.equal(engine.frames.size, 0);
    pool.setInterpolator(null);
  }
  console.log('ok failed rebuild retains ordinary radar and can be disposed');

  for (const count of [2, 4]) {
    const panes = Array.from({ length: count }, () => harness());
    panes[0].lose();
    for (const h of panes.slice(1)) assert.equal(h.primary.getOpacity(), 0);
    panes[0].restore();
    for (const h of panes) {
      h.pool.showInterpolated(0.5);
      assert.equal(h.primary.getOpacity(), 0);
      h.pool.setInterpolator(null);
    }
  }
  {
    const h = harness(); const { engine, pool } = h;
    engine.invalidateSlot(times[1]);
    engine.gl.loseDuringCompute = true;
    assert.doesNotThrow(() => h.complete(times[1]));
    assert.equal(engine.gl.isContextLost(), true);
    h.lose(); engine.gl.loseDuringCompute = false; h.restore();
    engine.gl.loseDuringDraw = true;
    assert.equal(engine.renderAt(times[0], times[1], 0.5), null);
    h.lose(); engine.gl.loseDuringDraw = false; h.restore();
    engine.invalidateSlot(times[1]);
    engine.gl.failCompute = true;
    assert.throws(() => h.complete(times[1]), /Injected compute failure/, 'do not suppress unrelated errors');
    pool.setInterpolator(null);
  }
  console.log('ok loss during a GPU pass does not abort loading or rendering');
  console.log('ok independent recovery in 2 and 4 panes');
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}
