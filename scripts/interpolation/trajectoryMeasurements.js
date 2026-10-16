import { pixels } from './cases';

function readField(engine, texture, width, height) {
  const { gl } = engine;
  const fbo = gl.createFramebuffer();
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete trajectory readback');
    const data = new Float32Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Trajectory float readback unavailable');
    return { data, width, height };
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
  }
}

function sample(field, u, v) {
  const xx = u * field.width - 0.5;
  const yy = v * field.height - 0.5;
  const x = Math.floor(xx);
  const y = Math.floor(yy);
  const a = xx - x;
  const b = yy - y;
  const at = (i, j, k) => field.data[4 * (Math.max(0, Math.min(field.height - 1, j)) * field.width
    + Math.max(0, Math.min(field.width - 1, i))) + k];
  return [0, 1, 2, 3].map((k) => (1 - b) * ((1 - a) * at(x, y, k) + a * at(x + 1, y, k))
    + b * ((1 - a) * at(x, y + 1, k) + a * at(x + 1, y + 1, k)));
}

function stats(values) {
  if (!values.length) throw new Error('No edge samples');
  values.sort((a, b) => a - b);
  return {
    samples: values.length,
    median: values[Math.floor(values.length * 0.5)],
    p95: values[Math.floor(values.length * 0.95)],
    max: values[values.length - 1],
  };
}

// Compare arrival and departure at the SAME advected feature, not at the
// same pixel in two different observations. Units are native analysis-grid
// pixels per observation interval. This measures paths, not meteorological truth.
export function measureEdgeVelocities(engine, testCase) {
  const a = engine.flows.get('0|1');
  const b = engine.flows.get('1|2');
  const before = readField(engine, a.texture, a.width, a.height);
  const after = readField(engine, b.texture, b.width, b.height);
  const ca = readField(engine, engine.trajectories.get('0|1', engine.flows, 0.5), a.width, a.height);
  const cb = readField(engine, engine.trajectories.get('1|2', engine.flows, 0.5), b.width, b.height);
  const source = testCase.frames[0];
  const rgba = pixels(source);
  const alpha = (x, y) => rgba[4 * (Math.max(0, Math.min(source.height - 1, y)) * source.width
    + Math.max(0, Math.min(source.width - 1, x))) + 3];
  const raw = [];
  const curved = [];
  for (let y = 8; y < a.height - 8; y++) {
    for (let x = 8; x < a.width - 8; x++) {
      const u = (x + 0.5) / a.width;
      const v = (y + 0.5) / a.height;
      const sx = Math.floor(u * source.width);
      const sy = Math.floor((1 - v) * source.height);
      if (alpha(sx, sy) <= 20 || ![[-3, 0], [3, 0], [0, -3], [0, 3]]
        .some(([dx, dy]) => alpha(sx + dx, sy + dy) < 20)) continue; // eslint-disable-line no-continue
      const f = sample(before, u, v);
      const g = sample(after, u + f[0], v + f[1]);
      const end = sample(ca, u, v);
      const start = sample(cb, u + f[0], v + f[1]);
      raw.push(Math.hypot((g[0] - f[0]) * a.width, (g[1] - f[1]) * a.height));
      curved.push(Math.hypot(
        (g[0] + start[0] - f[0] + end[2]) * a.width,
        (g[1] + start[1] - f[1] + end[3]) * a.height,
      ));
    }
  }
  return { raw: stats(raw), curved: stats(curved) };
}

function centroid(image, nativeWidth) {
  const rgba = pixels(image);
  let mass = 0;
  let x = 0;
  let y = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    const pixel = (i - 3) / 4;
    mass += rgba[i];
    x += ((pixel % image.width) + 0.5) * rgba[i];
    y += (Math.floor(pixel / image.width) + 0.5) * rgba[i];
  }
  return [x, y].map((value) => (value / mass / image.width) * nativeWidth);
}

export function measureTrajectoryContracts(engine, testCase, load, render, check) {
  load(engine, testCase);
  const h = 1 / 16;
  const positions = [-2, -1, 0, 1, 2].map((i) => centroid(render(engine, 1 + i * h, 1024, 1024), 256));
  const arrival = [0, 1].map((axis) => (3 * positions[2][axis] - 4 * positions[1][axis] + positions[0][axis]) / (2 * h));
  const departure = [0, 1].map((axis) => (-3 * positions[2][axis] + 4 * positions[3][axis] - positions[4][axis]) / (2 * h));
  check('trajectory:rendered-velocity-join', 'correctness', Math.hypot(arrival[0] - departure[0], arrival[1] - departure[1]), 0.3);
  check('trajectory:shared-velocity', 'correctness', Math.max(...[arrival, departure].map((v) => Math.hypot(v[0] - 12, v[1]))), 0.3);

  engine.trajectories.clear();
  const next = engine.flows.get('1|2');
  engine.flows.delete('1|2');
  render(engine, 0.25, 256, 256);
  const single = engine.trajectories.cache.get('0|1').texture;
  const f = engine.flows.get('0|1');
  const coefficients = readField(engine, single, f.width, f.height).data;
  check('trajectory:missing-neighbour-linear', 'correctness', coefficients.reduce((max, value) => Math.max(max, Math.abs(value)), 0), 0);
  engine.flows.set('1|2', next);
  render(engine, 0.5, 256, 256);
  check('trajectory:late-load-keeps-active-path', 'correctness', engine.trajectories.cache.get('0|1').texture === single ? 0 : 1, 0);
  render(engine, 1.25, 256, 256);
  render(engine, 0.25, 256, 256);
  const updated = engine.trajectories.cache.get('0|1').texture;
  check('trajectory:next-visit-picks-up-neighbour', 'correctness', updated !== single && !engine.gl.isTexture(single) ? 0 : 1, 0);

  engine.onSlotLoaded({ time: '0' }, testCase.frames[0], [0, 0, 256, 256]);
  engine.computeFlow('0', '1');
  render(engine, 0.5, 256, 256);
  check('trajectory:replacement-invalidates-path', 'correctness', engine.trajectories.cache.get('0|1').texture !== updated && !engine.gl.isTexture(updated) ? 0 : 1, 0);
  engine.setUseFlow(false);
  check('trajectory:mode-clears-paths', 'correctness', engine.trajectories.cache.size, 0);
  engine.setUseFlow(true);
  load(engine, testCase);
  render(engine, 0.5, 256, 256);
  engine.onParamsChanged({ flowInvariant: false });
  check('trajectory:identity-clears-paths', 'correctness', engine.trajectories.cache.size, 0);
  return { arrival, departure };
}

export function measureRenderCost(engine, render, position = null) {
  const { gl } = engine;
  const pixel = new Uint8Array(4);
  return [[390, 844], [1920, 1080], [2666, 1500]].map(([width, height]) => {
    // A readback forces actual completion across the browser/GPU processes;
    // finish() alone can measure only command submission on Chrome. This
    // includes readback overhead and is never used by production playback.
    const complete = () => gl.readPixels(Math.floor(width / 2), Math.floor(height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    for (let i = 0; i < 5; i++) render(engine, position ?? 0.5, width, height);
    complete();
    const times = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      render(engine, position ?? (0.2 + i / 50), width, height);
      complete();
      times.push(performance.now() - start);
    }
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Render timing readback failed');
    return { width, height, milliseconds: stats(times) };
  });
}
