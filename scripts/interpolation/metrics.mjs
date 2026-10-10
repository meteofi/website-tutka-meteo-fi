// Visible (premultiplied) colour and alpha, independent of hidden RGB.
export function pixelError(actual, expected) {
  if (actual.length !== expected.length || !actual.length || actual.length % 4) {
    throw new Error('Pixel arrays must have the same nonzero RGBA length');
  }
  let sum = 0;
  let max = 0;
  for (let i = 0; i < actual.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const a = c === 3 ? actual[i + c] : (actual[i + c] * actual[i + 3]) / 255;
      const b = c === 3 ? expected[i + c] : (expected[i + c] * expected[i + 3]) / 255;
      const error = Math.abs(a - b);
      sum += error;
      max = Math.max(max, error);
    }
  }
  return { mean: sum / actual.length, max };
}

export function flowError(vectors, expected) {
  if (!vectors.length) throw new Error('No eligible flow samples');
  const xs = [];
  const ys = [];
  let sum = 0;
  let stationary = 0;
  for (const [x, y] of vectors) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Non-finite flow');
    xs.push(x);
    ys.push(y);
    sum += Math.hypot(x - expected[0], y - expected[1]);
    if (Math.hypot(x, y) < 0.001) stationary++;
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  return {
    samples: vectors.length,
    medianX: xs[Math.floor(xs.length / 2)],
    medianY: ys[Math.floor(ys.length / 2)],
    meanVectorError: sum / vectors.length,
    stationaryFraction: stationary / vectors.length,
  };
}
