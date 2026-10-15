/* global DIAGNOSTIC_BUILD */
// Import the real production pipeline. No copied shaders or corrected variant.
import { RadarInterpolator } from '../../src/animation/interpolation';
import { ANALYSIS_SIZE, canvas, pixels } from './cases';
import { flowError, flowGeometry, pixelError } from './metrics.mjs';
import { measureEdgeVelocities, measureTrajectoryContracts, measureRenderCost } from './trajectoryMeasurements';
import measureDisplaySampling from './displayMeasurements';
import measureContextRecovery from './contextRecoveryMeasurements';

export function createEngine(useFlow = true, motionProfile = 'radar') {
  return new RadarInterpolator({ useFlow, motionProfile });
}

export function loadEngine(engine, testCase) {
  for (const key of [...engine.frames.keys()]) engine.invalidateSlot(key);
  const { width, height } = testCase.frames[0];
  testCase.frames.forEach((image, i) => engine.onSlotLoaded({ time: String(i) }, image, [0, 0, width, height]));
  for (let i = 0; i < testCase.frames.length - 1; i++) engine.computeFlow(String(i), String(i + 1));
  if (testCase.knownFlow && engine.useFlow) {
    const { gl } = engine;
    for (let pair = 0; pair < testCase.frames.length - 1; pair++) {
      const f = engine.flows.get(`${pair}|${pair + 1}`);
      const data = new Float32Array(f.width * f.height * 4);
      for (let y = 0; y < f.height; y++) {
        for (let x = 0; x < f.width; x++) {
          data.set([...testCase.knownFlow(pair, (x + 0.5) / f.width, (y + 0.5) / f.height), 1, 1], 4 * (y * f.width + x));
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, f.texture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.width, f.height, gl.RGBA, gl.FLOAT, data);
    }
  }
  if (engine.gl.getError() !== engine.gl.NO_ERROR) throw new Error('WebGL error while computing flow');
}

export function render(engine, position, width, height, extent = null) {
  const last = engine.frames.size - 1;
  const pair = Math.min(Math.floor(position), last - 1);
  const result = engine.renderAt(String(pair), String(pair + 1), position - pair, width, height, extent);
  if (!result || engine.contextLost) throw new Error('Interpolation context unavailable');
  return result;
}

function measureField(engine, testCase) {
  const { gl } = engine;
  const flow = engine.flows.get('0|1');
  const { width, height } = flow;
  const size = ANALYSIS_SIZE;
  const fbo = gl.createFramebuffer();
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, engine.flows.get('0|1').texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Flow readback framebuffer incomplete');
    const data = new Float32Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('RGBA/FLOAT flow readback unsupported on this device');
    const source = testCase.frames[0];
    const rgba = pixels(source);
    const samples = [];
    const mask = new Uint8Array(width * height);
    for (let y = 8; y < height - 8; y++) {
      for (let x = 8; x < width - 8; x++) {
        // GL rows start at the bottom, fixture rows at the top.
        const sx = Math.floor(((x + 0.5) * source.width) / width);
        const sy = Math.floor(((height - y - 0.5) * source.height) / height);
        if (rgba[4 * (sy * source.width + sx) + 3] < 20) continue; // eslint-disable-line no-continue
        mask[y * width + x] = 1;
        if (testCase.synthetic && Math.hypot(x - 128, size - 1 - y - 128) > 19) continue; // eslint-disable-line no-continue
        const i = 4 * (y * width + x);
        samples.push([data[i] * size, -data[i + 1] * size]);
      }
    }
    return {
      flow: testCase.displacement ? flowError(samples, testCase.displacement) : undefined,
      geometry: flowGeometry({ width, height, data }, mask),
    };
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
  }
}

export function cropReference(frame, width, height, extent) {
  const result = canvas(width, height);
  result.getContext('2d').drawImage(
    frame,
    extent[0],
    frame.height - extent[3],
    extent[2] - extent[0],
    extent[3] - extent[1],
    0,
    0,
    width,
    height,
  );
  return result;
}

function measureCrops(engine, testCase) {
  const { width, height } = testCase.frames[0];
  const outWidth = 800;
  const outHeight = Math.round((outWidth * height) / width);
  return [[0.25, 0.25, 0.75, 0.75], [0.17, 0.31, 0.67, 0.81]].map((crop) => {
    const extent = crop.map((v, i) => v * (i % 2 ? height : width));
    const compare = (position, expected) => pixelError(
      pixels(render(engine, position, outWidth, outHeight, extent)),
      pixels(cropReference(expected, outWidth, outHeight, extent)),
    );
    return {
      extent,
      endpoints: testCase.frames.map((frame, position) => compare(position, frame)),
      intermediate: testCase.expected
        ? [0.25, 0.5, 0.75, 1.25, 1.5, 1.75].map((position) => compare(position, testCase.expected(position))) : undefined,
    };
  });
}

// Exercise the production texture allocation and warp, independently of LK's
// accuracy. Four flow quadrants meet at the center: their bilinear mean is
// 0.25 grid pixels in each axis at the output. The radar inverse solves
// f=0.25-0.25*f, hence f=0.2. At t=0.5 the red/green step samples 0.4 of
// its bright texel and blends with black: round(255*0.4/2)=51. The satellite
// warp retains its output-space lookup, giving 48. NEAREST fails either case.
function measureFlowFiltering(engine) {
  const { gl } = engine;
  const size = engine.flowResolution;
  const ramp = document.createElement('canvas');
  ramp.width = size;
  ramp.height = size;
  const ctx = ramp.getContext('2d');
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = 4 * (y * size + x);
      image.data[i] = x < size / 2 ? 0 : 255;
      image.data[i + 1] = size - 1 - y < size / 2 ? 0 : 255; // GL's Y axis points up.
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const black = document.createElement('canvas');
  black.width = size;
  black.height = size;
  black.getContext('2d').fillRect(0, 0, size, size);
  loadEngine(engine, { frames: [ramp, black] });
  const channels = engine.motionProfile === 'radar' ? 4 : 2;
  const data = new Float32Array(size * size * channels);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      data[channels * (y * size + x)] = x < size / 2 ? 0 : 0.5 / size;
      data[channels * (y * size + x) + 1] = y < size / 2 ? 0 : 0.5 / size;
    }
  }
  gl.bindTexture(gl.TEXTURE_2D, engine.flows.get('0|1').texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, channels === 4 ? gl.RGBA : gl.RG, gl.FLOAT, data);
  const value = engine.motionProfile === 'radar' ? 51 : 48;
  const expected = new Uint8Array([value, value, 0, 255]);
  const samples = [3, size * 2 + 1].map((outputSize) => {
    const rgba = pixels(render(engine, 0.5, outputSize, outputSize));
    const center = 4 * (Math.floor(outputSize / 2) * outputSize + Math.floor(outputSize / 2));
    const actual = rgba.slice(center, center + 4);
    return { outputSize, rgba: Array.from(actual), ...pixelError(actual, expected) };
  });
  if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error while measuring flow filtering');
  return samples;
}

function measureDeformationGuard(engine) {
  // Deliberately corrupt an otherwise valid displacement field. At the center
  // its gradient is far above 1, so the renderer must show the unwarped fade.
  const { gl } = engine;
  const size = engine.flowResolution;
  const data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) data[4 * (y * size + x)] = x < size / 2 ? 0 : 0.25;
  }
  gl.bindTexture(gl.TEXTURE_2D, engine.flows.get('0|1').texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.FLOAT, data);
  const output = size * 2 + 1;
  const center = 4 * (Math.floor(output / 2) * output + Math.floor(output / 2));
  return [1, 2, 4].flatMap((zoom) => [0.25, 0.5, 0.75].map((position) => {
    const lo = size * (0.5 - 0.5 / zoom);
    const hi = size - lo;
    const rgba = pixels(render(engine, position, output, output, [lo, lo, hi, hi]));
    const value = Math.round(127.5 * (1 - position));
    return { zoom, position, ...pixelError(rgba.slice(center, center + 4), [value, value, 0, 255]) };
  }));
}

export async function measure(cases, onProgress = () => {}) {
  const radar = createEngine();
  const satellite = createEngine(true, 'satellite');
  const engine = radar;
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
    report.contextRecovery = await measureContextRecovery(check);
    report.flowFiltering = measureFlowFiltering(engine);
    check('flow-filtering:bilinear-warp', 'correctness', Math.max(...report.flowFiltering.map((s) => s.max)), 2);
    report.deformationGuard = measureDeformationGuard(engine);
    check('flow-filtering:deformation-fallback', 'correctness', Math.max(...report.deformationGuard.map((s) => s.max)), 2);
    report.trajectoryContracts = measureTrajectoryContracts(engine, cases.find((c) => c.id === 'turning-motion'), loadEngine, render, check);
    report.displaySampling = measureDisplaySampling(engine, cases.find((c) => c.id === 'default-translated'), loadEngine, render, cropReference, check);
    for (const c of cases) {
      onProgress(c.label);
      // Yield so mobile Safari paints progress between cases.
      await new Promise((resolve) => { setTimeout(resolve, 0); }); // eslint-disable-line no-await-in-loop
      const current = c.motionProfile === 'satellite' ? satellite : radar;
      const started = performance.now();
      loadEngine(current, c);
      // Diagnostics only: include completed GPU work, not just command enqueue.
      current.gl.finish();
      const pairMilliseconds = (performance.now() - started) / (c.frames.length - 1);
      const { width, height } = c.frames[0];
      const endpoints = c.frames.map((frame, i) => pixelError(pixels(render(current, i, width, height)), pixels(frame)));
      const before = pixels(current.renderAt('0', '1', 1, width, height));
      const after = pixels(current.renderAt('1', '2', 0, width, height));
      const boundary = pixelError(before, after);
      const result = {
        id: c.id, motionProfile: current.motionProfile, pairMilliseconds, endpoints, boundary,
      };
      check(`${c.id}:endpoints`, 'correctness', Math.max(...endpoints.map((e) => e.max)), 3);
      check(`${c.id}:pair-boundary`, 'correctness', boundary.max, 3);
      try {
        const field = measureField(current, c);
        result.geometry = field.geometry;
        if (c.displacement) {
          result.flow = field.flow;
          check(`${c.id}:motion`, c.id === 'stationary' ? 'correctness' : 'quality', result.flow.meanVectorError, 0.5);
        }
        if (c.motionProfile !== 'satellite') check(`${c.id}:folds`, 'quality', field.geometry.foldedCells, 0);
        if (c.id.startsWith('radar-') || c.id.startsWith('desktop-') || c.id === 'turning-motion') {
          result.edgeVelocities = measureEdgeVelocities(current, c);
          check(`${c.id}:shared-edge-velocity`, 'quality', result.edgeVelocities.curved.p95, 0.1);
        }
      } catch (error) {
        // Some mobile drivers cannot read float targets. Never call this a pass.
        result.flowUnavailable = error.message;
      }
      if (!c.synthetic || c.id === 'stepped-4' || c.knownFlow) {
        result.cropped = measureCrops(current, c);
        check(`${c.id}:cropped-endpoints`, 'correctness', Math.max(...result.cropped.flatMap((crop) => crop.endpoints.map((e) => e.max))), 3);
        if (c.expected && c.motionProfile !== 'satellite') {
          check(`${c.id}:cropped-motion`, 'quality', Math.max(...result.cropped.flatMap((crop) => crop.intermediate.map((e) => e.mean))), 1);
          if (c.id.endsWith('-detail')) {
            check(`${c.id}:detail-alignment`, 'quality', Math.max(...result.cropped.flatMap((crop) => crop.intermediate.map((e) => e.mean))), 0.2);
          }
        }
      }
      if (c.expected) {
        result.intermediate = [0.25, 0.5, 0.75, 1.25, 1.5, 1.75].map((position) => ({
          position, ...pixelError(pixels(render(current, position, width, height)), pixels(c.expected(position))),
        }));
        if (c.id === 'transparency' || c.id === 'stationary') {
          check(
            `${c.id}:intermediate`,
            c.id === 'stationary' ? 'correctness' : 'quality',
            Math.max(...result.intermediate.map((e) => e.max)),
            3,
          );
        }
        if (c.knownFlow) {
          check(`${c.id}:known-warp`, 'correctness', Math.max(...result.intermediate.map((e) => e.mean)), 1);
        }
      }
      if (current.gl.getError() !== current.gl.NO_ERROR) throw new Error(`WebGL rendering error: ${c.id}`);
      report.results.push(result);
    }
    if (/swiftshader|llvmpipe|software/i.test(report.environment.renderer)) {
      report.renderCostSkipped = 'Software rendering is not a device GPU performance measurement.';
    } else {
      loadEngine(engine, cases.find((c) => c.id === 'desktop-default'));
      report.renderCost = measureRenderCost(engine, render);
    }
  } finally {
    for (const current of [radar, satellite]) {
      current.dispose();
      current.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }
  report.summary = {
    correctnessFailures: report.checks.filter((c) => c.kind === 'correctness' && !c.passed).length,
    qualityFailures: report.checks.filter((c) => c.kind === 'quality' && !c.passed).length,
    unavailableMeasurements: report.results.filter((r) => r.flowUnavailable).length,
  };
  return report;
}
