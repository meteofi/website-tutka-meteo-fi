/* eslint-disable import/extensions, no-console */
// The throwaway probe must free its context on every exit without changing
// capability decisions. Keeping a JS reference must not keep GPU resources live.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(specifier === './glUtils' ? './glUtils.js' : specifier, context);
  },
});
const { default: canInterpolate } = await import('../src/animation/interpolation/capabilities.js');
hooks.deregister();

const originals = Object.fromEntries(['window', 'document', 'navigator']
  .map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
try {
  for (const options of [
    { result: true },
    { memory: undefined, result: true },
    { half: false, result: true },
    { full: false, result: true },
    { half: false, full: false, result: false },
    { complete: false, result: false },
    { memory: 2, result: false },
    { noGl: true, result: false },
    { release: false, result: true },
    { lost: true, complete: false, result: false },
    { throws: true },
    { override: 'on', result: true },
    { override: 'off', result: false },
  ]) {
    let contexts = 0; let releases = 0; let lost = !!options.lost;
    const gl = {
      FRAMEBUFFER_COMPLETE: 1,
      isContextLost: () => lost,
      getExtension(name) {
        if (name === 'WEBGL_lose_context') {
          return options.release === false ? null : {
            loseContext() {
              assert.equal(lost, false); lost = true; releases++;
            },
          };
        }
        return (name === 'EXT_color_buffer_half_float' ? options.half : options.full) === false ? null : {};
      },
      createTexture() { return {}; },
      bindTexture() {},
      texImage2D() { if (options.throws) throw new Error('Probe failed'); },
      texParameteri() {},
      createFramebuffer() { return {}; },
      bindFramebuffer() {},
      framebufferTexture2D() {},
      checkFramebufferStatus: () => (options.complete === false ? 0 : 1),
      deleteFramebuffer() {},
      deleteTexture() {},
    };
    const globals = {
      window: { location: { search: `?interp=${options.override || 'flow'}` } },
      document: { createElement: () => ({ getContext() { contexts++; return options.noGl ? null : gl; } }) },
      navigator: { deviceMemory: 'memory' in options ? options.memory : 8 },
    };
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, name, { configurable: true, value });
    }
    // eslint-disable-next-line no-await-in-loop
    if (options.throws) await assert.rejects(canInterpolate, /Probe failed/);
    // eslint-disable-next-line no-await-in-loop
    else assert.equal(await canInterpolate(), options.result);
    const created = options.override ? 0 : 1;
    assert.equal(contexts, created);
    assert.equal(releases, created && !options.noGl && !options.lost && options.release !== false ? 1 : 0);
  }
  console.log('ok probe cleanup on success, rejection, exceptions and overrides; optional extension');
} finally {
  for (const [name, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
