// Controller regressions: model-run refresh and metadata backoff must hold
// across pans, toggles and asynchronous responses. Real controller, query and
// parser modules; only the browser/GPU, network and clock are replaced.
// Run with Node 24 (the same version as CI): node scripts/test-wind-particles.mjs
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fromLonLat } from 'ol/proj.js';
import { FRAME_STEPS } from '../src/constants.js';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './particleGl' || specifier === 'test:particleGl') {
      return { url: 'test:particleGl', shortCircuit: true };
    }
    // Webpack supplies extensions in production; Node needs them explicitly.
    if ((specifier.startsWith('.') || specifier === 'ol/proj') && !specifier.endsWith('.js')) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== 'test:particleGl') return next(url, context);
    return { format: 'module', shortCircuit: true, source: `
      export const ZERO_COPY = false;
      export default class Renderer {
        static instances = [];
        constructor() { this.field = null; this.siteCount = 0; Renderer.instances.push(this); }
        setColor() {} setMask() {} stateFor() {} clearTrails() {} dispose() {}
        setField(field) { this.field = field; }
        clearField() { this.field = null; }
        hasField() { return !!this.field; }
        hasState() { return false; }
        render() { return false; }
      }
    ` };
  },
});
const { default: initWindParticles } = await import('../src/particles/windParticles.js');
const { default: Renderer } = await import('test:particleGl');
hooks.deregister();

const START = Date.parse('2026-09-13T12:00:00Z');
const STEP = 300000;
const REFRESH = 30 * 60000;
const settle = () => new Promise(setImmediate);
const originals = Object.fromEntries(['window', 'document', 'fetch', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame']
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const realNow = Date.now;

function harness(paneCount = 1) {
  let now = START;
  let nextId = 0;
  const timers = new Map();
  const frames = new Map();
  const requests = [];
  const config = { metadataStatus: 200, generation: 0, speed: 1, holdArea: false };
  const pendingAreas = [];
  let longitude = 25;
  const timer = (callback, delay, repeat = false) => {
    timers.set(++nextId, { callback, at: now + delay, delay, repeat });
    return nextId;
  };
  const grid = () => ({
    type: 'Coverage',
    domain: { domainType: 'Grid', axes: { x: { values: [20, 30] }, y: { values: [60, 70] } } },
    ranges: Object.fromEntries(['10u', '10v'].map((name) => [name, {
      axisNames: ['y', 'x'], shape: [2, 2], values: Array(4).fill(config.speed),
    }])),
  });
  Object.assign(globalThis, {
    window: { location: { search: '' }, matchMedia: () => ({ matches: false }), devicePixelRatio: 1 },
    document: { createElement() {
      const canvas = { width: 1, height: 1, style: {} };
      canvas.getContext = () => ({ canvas });
      return canvas;
    } },
    setTimeout: (callback, delay) => timer(callback, delay),
    setInterval: (callback, delay) => timer(callback, delay, true),
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: (id) => frames.delete(id),
    fetch: async (url, options) => {
      requests.push({ url, ...options });
      if (url.includes('/area?')) {
        if (config.holdArea) await new Promise((resolve) => pendingAreas.push(resolve));
        return { ok: true, json: async () => grid() };
      }
      if (config.metadataStatus !== 200) return { ok: false, status: config.metadataStatus };
      const times = config.generation ? [START, START + 3 * 3600000] : [START - 3 * 3600000, START];
      return { ok: true, json: async () => ({
        extent: { temporal: { values: times.map((ms) => new Date(ms).toISOString()) } },
      }) };
    },
  });
  Date.now = () => now;
  const controller = initWindParticles();
  const view = {
    getCenter: () => fromLonLat([longitude, 65]),
    getResolution: () => 1000,
    calculateExtent: () => [...fromLonLat([longitude - 2, 63]), ...fromLonLat([longitude + 2, 67])],
  };
  const map = {
    getView: () => view, getSize: () => [800, 600], on() {},
    getViewport: () => ({ querySelector: () => null, insertBefore() {} }),
  };
  for (let index = 0; index < paneCount; index++) {
    const layer = controller.createPaneLayer(index);
    controller.attachPane(map, index);
    layer.setVisible(true);
  }
  controller.setCursor(START, START - FRAME_STEPS * STEP, STEP);
  async function frame() {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback());
    await settle();
  }
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      now = t.at;
      if (t.repeat) t.at += t.delay;
      else timers.delete(id);
      t.callback();
      await settle();
    }
    now = end;
  }
  return {
    config, controller, requests, advance, frame,
    get renderer() { return Renderer.instances.at(-1); },
    areas: () => requests.filter((r) => r.url.includes('/area?')),
    metadata: () => requests.filter((r) => !r.url.includes('/area?')),
    async start() { controller.setEnabled(true); await settle(); await frame(); await advance(300); },
    async pan() { longitude += 1; await frame(); await advance(300); },
    async releaseAreas() { pendingAreas.splice(0).forEach((resolve) => resolve()); await settle(); },
    async releaseNextArea() { pendingAreas.shift()(); await settle(); },
    stop() { controller.setEnabled(false); },
  };
}

try {
  for (const count of [2, 4]) {
    const h = harness(count);
    await h.start();
    await h.frame();
    await h.advance(300);
    assert.equal(h.areas().length, 1, `${count} panes share one field request`);
    h.config.speed = 6;
    await h.advance(REFRESH);
    assert.equal(h.areas().length, 2, `${count} panes share one refresh`);
    assert.equal(h.renderer.field.range, 6);
    h.stop();
    console.log(`ok   ${count} panes share fetching and refresh`);
  }
  {
    const h = harness();
    await h.start();
    assert.equal(h.renderer.field.range, 1);
    h.stop();
    h.controller.setEnabled(true);
    await settle();
    assert.equal(h.areas().length, 1, 'quick toggle reuses the decoded field');
    h.config.generation = 1;
    h.config.speed = 9;
    h.config.holdArea = true;
    // Toggling refreshes metadata before the field TTL expires.
    h.stop();
    h.controller.setEnabled(true);
    await settle();
    assert.equal(h.areas().length, 2, 'new run refreshes an overlapping valid time');
    assert.equal(h.areas()[1].url, h.areas()[0].url, 'refresh preserves the deterministic URL');
    assert.equal(h.areas()[1].cache, 'no-cache', 'refresh revalidates the browser HTTP cache');
    assert.equal(h.renderer.field.range, 1, 'last good field stays visible during refresh');
    await h.releaseAreas();
    assert.equal(h.renderer.field.range, 9, 'revised wind replaces the old run');
    h.stop();
    console.log('ok   model-run refresh, HTTP revalidation and sticky field');
  }
  {
    const h = harness();
    await h.start();
    h.config.speed = 7;
    await h.advance(REFRESH);
    assert.equal(h.areas().length, 2, 'unchanged metadata cannot keep a field forever');
    assert.equal(h.renderer.field.range, 7);
    h.stop();
    console.log('ok   unchanged advertised steps still expire after 30 minutes');
  }
  {
    const h = harness();
    await h.start();
    h.stop();
    await h.advance(REFRESH);
    h.config.speed = 5;
    h.controller.setEnabled(true);
    await settle();
    assert.equal(h.areas().length, 2, 'long-disabled layer revalidates expired fields with unchanged metadata');
    assert.equal(h.renderer.field.range, 5);
    h.stop();
    console.log('ok   cache expiry survives disabling the metadata timer');
  }
  {
    const h = harness();
    h.config.metadataStatus = 503;
    await h.start();
    await h.pan();
    await h.pan();
    assert.equal(h.metadata().length, 1, 'settles cannot bypass the initial 15-second backoff');
    await h.advance(15000 - 900);
    assert.equal(h.metadata().length, 2, 'first timed retry runs');
    await h.pan();
    await h.advance(29000);
    assert.equal(h.metadata().length, 2, 'second failure backs off for 30 seconds');
    h.config.metadataStatus = 200;
    await h.advance(700);
    assert.equal(h.metadata().length, 3);
    assert.equal(h.areas().length, 1, 'recovery fetches the field without another pan');
    h.config.metadataStatus = 503;
    await h.advance(REFRESH - 45000);
    const failedRefreshCount = h.metadata().length;
    h.config.metadataStatus = 200;
    await h.advance(15000);
    assert.equal(h.metadata().length, failedRefreshCount + 1,
      'a failed periodic refresh retries even with old steps available; success reset its backoff');
    h.stop();
    const stoppedCount = h.requests.length;
    await h.advance(REFRESH);
    assert.equal(h.requests.length, stoppedCount, 'disable cancels all fetch timers');
    console.log('ok   metadata backoff, recovery, refresh retry and teardown');
  }
  {
    const h = harness();
    await h.start();
    // A request started before a run change must not repopulate the fresh cache.
    h.config.holdArea = true;
    await h.pan();
    const oldRequest = h.areas().at(-1);
    h.config.generation = 1;
    h.config.speed = 8;
    await h.advance(REFRESH);
    assert.equal(oldRequest.signal.aborted, true, 'new metadata aborts the old-run request');
    await h.releaseAreas();
    assert.equal(h.renderer.field.range, 8);
    h.stop();
    console.log('ok   in-flight field is superseded when advertised steps change');
  }
  {
    const h = harness();
    h.config.holdArea = true;
    await h.start();
    await h.advance(REFRESH);
    assert.equal(h.areas().length, 2);
    assert.equal(h.areas()[0].signal.aborted, true);
    await h.releaseNextArea();
    h.controller.setCursor(START + 1000, START - FRAME_STEPS * STEP + 1000, STEP);
    assert.equal(h.areas().length, 2,
      'an aborted response cannot clear the replacement request for the same URL');
    await h.releaseAreas();
    assert.equal(h.renderer.field.range, 1);
    h.stop();
    console.log('ok   same-URL refresh keeps ownership of its in-flight request');
  }
  {
    const h = harness();
    h.config.metadataStatus = 503;
    await h.start();
    h.stop();
    await h.advance(REFRESH);
    assert.equal(h.metadata().length, 1, 'disable cancels a pending metadata retry');
    console.log('ok   disable cancels metadata backoff');
  }
} finally {
  Date.now = realNow;
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
console.log('all passed');
