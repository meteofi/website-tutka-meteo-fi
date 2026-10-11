// Exact fields isolate the renderer from motion-estimation errors. The oracle
// constructs each image directly from the analytic forward transform.
function canvas(size) {
  const result = document.createElement('canvas');
  result.width = size;
  result.height = size;
  return result;
}

function affine(id, label, matrix, shift) {
  const size = 512;
  const original = (u, v, t) => {
    const [a, b, c, d] = matrix;
    const x = u - 0.5 - t * shift[0];
    const y = v - 0.5 - t * shift[1];
    const det = (1 + t * a) * (1 + t * d) - t * t * b * c;
    return [((1 + t * d) * x - t * b * y) / det, ((1 + t * a) * y - t * c * x) / det];
  };
  const expected = (t) => {
    const image = canvas(size);
    const ctx = image.getContext('2d');
    const data = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [u, v] = original((x + 0.5) / size, 1 - (y + 0.5) / size, t);
        const radius = 0.16 + 0.02 * Math.sin(7 * Math.atan2(v, u));
        if (Math.hypot(u, v) < radius) {
          data.data.set(Math.abs(u) < 0.045 && Math.abs(v) < 0.045
            ? [255, 220, 0, 255] : [0, 180, 255, 255], 4 * (y * size + x));
        }
      }
    }
    ctx.putImageData(data, 0, 0);
    return image;
  };
  return {
    id,
    label,
    expected,
    synthetic: true,
    motionProfile: 'radar',
    frames: [0, 1, 2].map(expected),
    knownFlow: (pair, u, v) => {
      const [x, y] = original(u, v, pair);
      return [matrix[0] * x + matrix[1] * y + shift[0], matrix[2] * x + matrix[3] * y + shift[1]];
    },
    description: 'Tunnettu muuttuva liike ja tarkka virtauskenttä. Terävän reunan tulee liikkua ilman kaksoiskuvaa.',
  };
}

export default function trajectoryCases() {
  const source = canvas(256);
  const ctx = source.getContext('2d');
  ctx.fillStyle = '#00b4ff';
  ctx.beginPath();
  ctx.arc(90, 128, 19, 0, 2 * Math.PI);
  ctx.fill();
  const positions = [[0, 0], [8, -4], [32, 4]];
  const velocities = [[8, -4], [12, 0], [24, 8]];
  const expected = (position) => {
    const pair = Math.min(1, Math.floor(position));
    const t = position - pair;
    const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
    const h10 = t ** 3 - 2 * t ** 2 + t;
    const h01 = -2 * t ** 3 + 3 * t ** 2;
    const h11 = t ** 3 - t ** 2;
    const p = [0, 1].map((axis) => h00 * positions[pair][axis] + h10 * velocities[pair][axis]
      + h01 * positions[pair + 1][axis] + h11 * velocities[pair + 1][axis]);
    const image = canvas(256);
    image.getContext('2d').drawImage(source, p[0], p[1]);
    return image;
  };
  return [
    affine('affine-expansion', 'Tarkka liike — laajeneva solu', [0.3, 0, 0, 0.3], [0.08, 0]),
    affine('affine-shear', 'Tarkka liike — leikkaus', [0, 0.4, 0, 0], [0.02, -0.01]),
    affine('affine-contraction', 'Tarkka liike — supistuva solu', [-0.2, 0, 0, -0.2], [-0.01, 0.02]),
    {
      id: 'turning-motion',
      label: 'Tarkka liike — nopeuden ja suunnan muutos',
      frames: [0, 1, 2].map(expected),
      expected,
      synthetic: true,
      motionProfile: 'radar',
      knownFlow: (pair) => (pair ? [24 / 256, -8 / 256] : [8 / 256, 4 / 256]),
      description: 'Nopeus ja suunta muuttuvat yhteisen havainnon kohdalla. Reunan liikkeen tulee jatkua ilman nykäystä.',
    },
  ];
}
