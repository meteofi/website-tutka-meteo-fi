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

// Geometry of the bilinear field, in its own grid pixels. A negative Jacobian
// of x +/- t*flow means a warp folds a cell over itself. Test both directions
// through the pair and all four corners of each bilinear cell.
export function flowGeometry({ width, height, data }, mask) {
  const vector = (x, y) => {
    const i = 4 * (y * width + x);
    const v = [data[i] * width, data[i + 1] * height];
    if (!v.every(Number.isFinite)) throw new Error('Non-finite flow');
    return v;
  };
  let cells = 0;
  let foldedCells = 0;
  let maxNeighborJump = 0;
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      if (mask && !mask[y * width + x]) continue; // eslint-disable-line no-continue
      const a = vector(x, y);
      const b = vector(x + 1, y);
      const c = vector(x, y + 1);
      const d = vector(x + 1, y + 1);
      let folded = false;
      for (const [left, right] of [[a, b], [c, d]]) {
        for (const [bottom, top] of [[a, c], [b, d]]) {
          const ux = right[0] - left[0];
          const vx = right[1] - left[1];
          const uy = top[0] - bottom[0];
          const vy = top[1] - bottom[1];
          for (const t of [-1, -0.75, -0.5, -0.25, 0.25, 0.5, 0.75, 1]) {
            if ((1 + t * ux) * (1 + t * vy) - t * t * uy * vx <= 0) folded = true;
          }
          maxNeighborJump = Math.max(maxNeighborJump, Math.hypot(ux, vx), Math.hypot(uy, vy));
        }
      }
      cells++;
      if (folded) foldedCells++;
    }
  }
  return {
    width, height, cells, foldedCells, maxNeighborJump,
  };
}
