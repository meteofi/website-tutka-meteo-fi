/* global DIAGNOSTIC_BUILD */
// Import the real production pipeline. No copied shaders or corrected variant.
import { RadarInterpolator } from '../../src/animation/interpolation';
import { ANALYSIS_SIZE, pixels } from './cases';
import { flowError, pixelError } from './metrics.mjs';

export function createEngine(useFlow = true) {
  return new RadarInterpolator({ useFlow, flowResolution: ANALYSIS_SIZE });
}

export function loadEngine(engine, testCase) {
  for (const key of [...engine.frames.keys()]) engine.invalidateSlot(key);
  const { width, height } = testCase.frames[0];
  testCase.frames.forEach((image, i) => engine.onSlotLoaded({ time: String(i) }, image, [0, 0, width, height]));
  for (let i = 0; i < testCase.frames.length - 1; i++) engine.computeFlow(String(i), String(i + 1));
  if (engine.gl.getError() !== engine.gl.NO_ERROR) throw new Error('WebGL error while computing flow');
}

export function render(engine, position, width, height) {
  const last = engine.frames.size - 1;
  const pair = Math.min(Math.floor(position), last - 1);
  const result = engine.renderAt(String(pair), String(pair + 1), position - pair, width, height);
  if (!result || engine.contextLost) throw new Error('Interpolation context unavailable');
  return result;
}

function vectors(engine, testCase) {
  const { gl } = engine;
  const size = engine.flowResolution;
  const fbo = gl.createFramebuffer();
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, engine.flows.get('0|1').texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Flow readback framebuffer incomplete');
    const data = new Float32Array(size * size * 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, data);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('RGBA/FLOAT flow readback unsupported on this device');
    const source = testCase.frames[0];
    const rgba = pixels(source);
    const samples = [];
    for (let y = 8; y < size - 8; y++) {
      for (let x = 8; x < size - 8; x++) {
        // GL rows start at the bottom, fixture rows at the top.
        const sx = Math.floor(((x + 0.5) * source.width) / size);
        const sy = Math.floor(((size - y - 0.5) * source.height) / size);
        if (testCase.synthetic && Math.hypot(x - 128, size - 1 - y - 128) > 19) continue; // eslint-disable-line no-continue
        if (rgba[4 * (sy * source.width + sx) + 3] < 20) continue; // eslint-disable-line no-continue
        const i = 4 * (y * size + x);
        samples.push([data[i] * size, -data[i + 1] * size]);
      }
    }
    return samples;
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
  }
}

export async function measure(cases, onProgress = () => {}) {
  const engine = createEngine();
  const { gl } = engine;
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    build: DIAGNOSTIC_BUILD,
    environment: {
      userAgent: navigator.userAgent,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      flowResolution: engine.flowResolution,
      flowFilter: engine.flowFilter === gl.LINEAR ? 'LINEAR' : 'NEAREST',
      halfFloatLinearExtension: !!gl.getExtension('OES_texture_half_float_linear'),
    },
    results: [],
    checks: [],
  };
  const check = (id, kind, value, limit) => report.checks.push({
    id, kind, value, limit, passed: value <= limit,
  });
  try {
    for (const c of cases) {
      onProgress(c.label);
      // Yield so mobile Safari paints progress between cases.
      await new Promise((resolve) => { setTimeout(resolve, 0); }); // eslint-disable-line no-await-in-loop
      loadEngine(engine, c);
      const { width, height } = c.frames[0];
      const endpoints = c.frames.map((frame, i) => pixelError(pixels(render(engine, i, width, height)), pixels(frame)));
      const before = pixels(engine.renderAt('0', '1', 1, width, height));
      const after = pixels(engine.renderAt('1', '2', 0, width, height));
      const boundary = pixelError(before, after);
      const result = { id: c.id, endpoints, boundary };
      check(`${c.id}:endpoints`, 'correctness', Math.max(...endpoints.map((e) => e.max)), 3);
      check(`${c.id}:pair-boundary`, 'correctness', boundary.max, 3);
      if (c.displacement) {
        try {
          result.flow = flowError(vectors(engine, c), c.displacement);
          check(`${c.id}:motion`, c.id === 'stationary' ? 'correctness' : 'quality', result.flow.meanVectorError, 0.5);
        } catch (error) {
          // Some mobile drivers cannot read float targets. Never call this a pass.
          result.flowUnavailable = error.message;
        }
      }
      if (c.expected) {
        result.intermediate = [0.25, 0.5, 0.75, 1.25, 1.5, 1.75].map((position) => ({
          position, ...pixelError(pixels(render(engine, position, width, height)), pixels(c.expected(position))),
        }));
        if (c.id === 'transparency' || c.id === 'stationary') {
          check(
            `${c.id}:intermediate`,
            c.id === 'stationary' ? 'correctness' : 'quality',
            Math.max(...result.intermediate.map((e) => e.max)),
            3,
          );
        }
      }
      if (gl.getError() !== gl.NO_ERROR) throw new Error(`WebGL rendering error: ${c.id}`);
      report.results.push(result);
    }
  } finally {
    engine.dispose();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  report.summary = {
    correctnessFailures: report.checks.filter((c) => c.kind === 'correctness' && !c.passed).length,
    qualityFailures: report.checks.filter((c) => c.kind === 'quality' && !c.passed).length,
    unavailableMeasurements: report.results.filter((r) => r.flowUnavailable).length,
  };
  return report;
}
