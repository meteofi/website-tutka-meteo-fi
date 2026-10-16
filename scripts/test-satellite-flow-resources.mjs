/* eslint-disable no-console */
// GPU diagnostics check pixels. This test pins ownership when a multi-pass
// satellite solve succeeds or stops partway through a driver/framebuffer error.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(specifier.startsWith('.') && !specifier.endsWith('.js') ? `${specifier}.js` : specifier, context);
  },
});
const { default: FlowLK } = await import('../src/animation/interpolation/flowLK.js');
hooks.deregister();

function gpu() {
  const gl = {
    textures: new Set(), programs: new Set(), buffers: new Set(), framebuffers: new Set(),
    draws: 0, framebuffer: null,
    RG16F: 'RG16F', RG: 'RG', HALF_FLOAT: 'HALF_FLOAT', FRAMEBUFFER_COMPLETE: 'complete',
    createShader: () => ({}), getShaderParameter: () => true, getProgramParameter: () => true,
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    bindFramebuffer(target, value) { this.framebuffer = value; },
    checkFramebufferStatus() { return this.incomplete ? 'incomplete' : this.FRAMEBUFFER_COMPLETE; },
    texImage2D(target, level, format, width, height) {
      assert.equal(format, this.RG16F);
      assert.ok(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0);
    },
    drawArrays() {
      this.draws++;
      if (this.draws === this.failAt) throw new Error('Injected GPU pass failure');
    },
  };
  for (const [name, collection] of [['Texture', 'textures'], ['Program', 'programs'], ['Buffer', 'buffers'], ['Framebuffer', 'framebuffers']]) {
    gl[`create${name}`] = () => { const value = {}; gl[collection].add(value); return value; };
    gl[`delete${name}`] = (value) => { assert.ok(gl[collection].delete(value), `only delete owned ${name}`); };
  }
  for (const name of ['shaderSource', 'compileShader', 'deleteShader', 'attachShader', 'linkProgram',
    'bindBuffer', 'bufferData', 'bindTexture', 'texParameteri', 'framebufferTexture2D', 'viewport',
    'disable', 'useProgram', 'activeTexture', 'uniform1i', 'uniform2f', 'enableVertexAttribArray',
    'vertexAttribPointer']) gl[name] = () => {};
  return gl;
}

const a = { texture: { source: 'A' }, width: 640, height: 640 };
const b = { texture: { source: 'B' }, width: 1280, height: 720 };
for (const failure of [null, 'framebuffer', 'pass']) {
  const gl = gpu();
  const solver = new FlowLK(gl);
  gl.incomplete = failure === 'framebuffer';
  gl.failAt = failure === 'pass' ? 5 : Infinity;
  if (failure) {
    assert.throws(() => solver.compute(a, b), /framebuffer incomplete|Injected GPU pass failure/);
    assert.equal(gl.textures.size, 0, 'a failed pair must release all intermediate textures');
  } else {
    const first = solver.compute(a, b);
    assert.deepEqual([...gl.textures], [first], 'only the caller-owned result survives');
    const second = solver.compute(a, b);
    assert.notEqual(second, first);
    assert.deepEqual([...gl.textures], [first, second], 'a later pair cannot delete an earlier result');
    gl.deleteTexture(first);
    gl.deleteTexture(second);
  }
  assert.equal(gl.framebuffer, null, 'success and failure both restore the default framebuffer');
  solver.dispose();
  for (const key of ['textures', 'programs', 'buffers', 'framebuffers']) assert.equal(gl[key].size, 0, key);
}
console.log('Satellite flow: result ownership, repeated pairs, intermediate cleanup and GPU errors passed.');
