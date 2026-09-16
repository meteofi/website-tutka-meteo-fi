// Filtered-request ownership: selecting another hazard must never publish an
// incomplete snapshot as an empty result, or let an aborted response win.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './warnings/warningSheet') return { url: 'test:warningSheet', shortCircuit: true };
    if ((specifier.startsWith('.') || specifier.startsWith('ol/')) && !specifier.endsWith('.js')) return next(`${specifier}.js`, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url !== 'test:warningSheet') return next(url, context);
    return { format: 'module', shortCircuit: true, source: `export default callbacks => {
      globalThis.warningSheetCallbacks = callbacks;
      return { update: state => globalThis.warningSheetStates.push(state), open() {} };
    };` };
  },
});
const { default: initWeatherWarnings } = await import('../src/weatherWarnings.js');
hooks.deregister();
const originals = Object.fromEntries(['window', 'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const realNow = Date.now;
let now = Date.parse('2026-09-16T12:00:00Z');
let hold = false;
let fail = false;
const requests = [];
const timers = new Map();
let nextTimer = 0;
const settle = () => new Promise(setImmediate);
const state = () => globalThis.warningSheetStates.at(-1);
const feature = (type, generation) => ({
  type: 'Feature', id: `type-${type}`, geometry: { type: 'Polygon', coordinates: [[[24, 60], [25, 60], [25, 61], [24, 60]]] },
  properties: {
    identifier: `alert-${type}`, awareness_type: `${type}; test`, awareness_level: '2; yellow; Moderate',
    status: 'Actual', scope: 'Public', msgType: 'Alert', areaDesc: `generation-${generation}`,
    onset: '2026-09-16T00:00:00Z', expires: '2026-09-17T00:00:00Z', sent: '2026-09-16T00:00:00Z',
  },
});
let generation = 0;
try {
  globalThis.warningSheetStates = [];
  Object.assign(globalThis, {
    window: { addEventListener() {} }, document: { visibilityState: 'visible', addEventListener() {} },
    setTimeout: () => 0, clearTimeout() {},
    setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearInterval: id => timers.delete(id),
    fetch: (url, { signal }) => {
      const type = Number(new URL(url).searchParams.get('awareness_type')?.split(';')[0]);
      const data = { type: 'FeatureCollection', features: type ? [feature(type, generation)] : [] };
      const response = { ok: !fail, status: fail ? 503 : 200, json: async () => data };
      let resolve;
      const pending = new Promise(r => { resolve = r; });
      requests.push({ url, signal, finish: () => resolve(response) });
      if (!hold) resolve(response);
      return pending;
    },
  });
  Date.now = () => now;
  const warnings = initWeatherWarnings();
  // All pane layers share the same source and never start their own fetches.
  const layers = Array.from({ length: 4 }, () => warnings.createPaneLayer());
  assert(layers.every(layer => layer.getSource() === layers[0].getSource()));
  warnings.setTypes([3]); await settle();
  assert.equal(requests.length, 3); assert.equal(layers[0].getSource().getFeatures().length, 1);
  assert(state().lastSuccess); assert.equal(timers.size, 1);
  warnings.setTypes([3]); assert.equal(requests.length, 3);

  hold = true; generation = 1;
  warnings.setTypes([1, 3]);
  assert.equal(requests.length, 8);
  assert.equal(state().lastSuccess, 0, 'newly selected type is unknown while loading');
  assert(state().loading);
  assert.equal(layers[0].getSource().getFeatures().length, 1, 'existing warnings remain visible');
  const abandoned = requests.slice(3);
  generation = 2; hold = false;
  warnings.setTypes([10]); await settle();
  assert(abandoned.every(r => r.signal.aborted));
  assert.deepEqual(layers[0].getSource().getFeatures().map(f => f.get('type')), [10]);
  const success = state().lastSuccess;
  abandoned.forEach(r => r.finish()); await settle();
  assert.deepEqual(layers[0].getSource().getFeatures().map(f => f.get('type')), [10], 'late superseded responses cannot replace the selected type');
  assert.equal(state().lastSuccess, success); assert.equal(timers.size, 1);

  warnings.setTypes([1, 3, 10]); await settle();
  const afterAll = requests.length;
  warnings.setTypes([1]); await settle();
  assert.equal(requests.length, afterAll, 'removing a type reuses the broader snapshot');
  warnings.setTypes([]); assert.equal(timers.size, 0);
  warnings.setTypes([3]); await settle();
  assert.equal(requests.length, afterAll, 'fresh covered type is reused after re-enabling');
  assert.equal(timers.size, 1);
  globalThis.warningSheetCallbacks.onWindow(true);
  globalThis.warningSheetCallbacks.onScope(true);
  assert.equal(requests.length, afterAll, 'view filters remain local');
  assert.equal(state().warnings.length, 1);

  now += 300001;
  for (const tick of timers.values()) tick();
  await settle();
  assert.equal(requests.length, afterAll + 3, 'polling fetches only the currently enabled type and cancellations');
  fail = true;
  globalThis.warningSheetCallbacks.onRetry(); await settle();
  assert(state().failed); assert(state().lastSuccess);
  assert.equal(layers[0].getSource().getFeatures().length, 1, 'failed refresh keeps the last good snapshot');
  fail = false; hold = true;
  warnings.setTypes([1]); const pending = requests.slice(-3);
  warnings.setTypes([]); assert(pending.every(r => r.signal.aborted));
  pending.forEach(r => r.finish()); await settle();
  assert.equal(state().enabled, false); assert.equal(timers.size, 0);
  console.log('ok   warning type switching, complete-state reporting, late responses, shared source, cache reuse, polling and disable');
} finally {
  Date.now = realNow;
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  delete globalThis.warningSheetStates; delete globalThis.warningSheetCallbacks;
}
