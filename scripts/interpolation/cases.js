import manifest from './fixtures/manifest.json';

export const ANALYSIS_SIZE = 256;

export function canvas(width, height = width) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

export function pixels(image) {
  const c = canvas(image.width, image.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

function shape(stepped) {
  const c = canvas(ANALYSIS_SIZE);
  const ctx = c.getContext('2d');
  const data = ctx.createImageData(c.width, c.height);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const r = Math.hypot(x - 128, y - 128);
      const g = 255 * Math.exp(-(r * r) / (2 * 15 * 15));
      const color = stepped
        ? (r < 6 ? [255, 0, 0, 255] : r < 12 ? [255, 255, 0, 255] : r < 20 ? [0, 180, 0, 255] : [0, 0, 0, 0])
        : [g, g, g, 255];
      data.data.set(color, 4 * (y * c.width + x));
    }
  }
  ctx.putImageData(data, 0, 0);
  return c;
}

function translated(id, label, image, displacement, synthetic = false) {
  // Displacements are analysis pixels; +y means down in image coordinates.
  const frame = (position) => {
    const c = canvas(image.width, image.height);
    c.getContext('2d').drawImage(
      image,
      (position * displacement[0] * image.width) / ANALYSIS_SIZE,
      (position * displacement[1] * image.height) / ANALYSIS_SIZE,
    );
    return c;
  };
  return {
    id,
    motionProfile: id.startsWith('goes19') || id === 'satellite' ? 'satellite' : 'radar',
    label,
    frames: [frame(0), frame(1), frame(2)],
    expected: frame,
    displacement,
    synthetic,
    description: `Tunnettu siirto: (${displacement.join(', ')}) analyysipikseliä / askel. Kolme kuvaa; ei sään kehitystä.`,
  };
}

export async function loadCases() {
  const images = new Map(await Promise.all(manifest.frames.map(async (entry) => {
    // Same-origin bundled files; no changing live data or external requests.
    const response = await fetch(`fixtures/${entry.file}`);
    if (!response.ok) throw new Error(`Fixture ${entry.file}: HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (image.width !== entry.width || image.height !== entry.height) throw new Error(`Fixture size: ${entry.file}`);
      return [entry.file, image];
    } finally {
      URL.revokeObjectURL(url);
    }
  })));
  const cases = [
    ['radar-default', 'Tutka — Suomi, oletustyyli', 'default'],
    ['radar-fmi', 'Tutka — Suomi, FMI-tyyli', 'radar_fmi'],
    ['satellite', 'Satelliitti — GOES-19 infrapuna', 'goes19'],
  ].map(([id, label, prefix]) => ({
    id,
    motionProfile: id.startsWith('goes19') || id === 'satellite' ? 'satellite' : 'radar',
    label,
    frames: [0, 1, 2].map((i) => images.get(`${prefix}-${i}.png`)),
    times: [0, 1, 2].map((i) => manifest.frames.find((f) => f.file === `${prefix}-${i}.png`).time),
    description: 'Kolme peräkkäistä havaintoa. Väliajan todellista kuvaa ei tunneta; vertailukuva on lähin havainto.',
  }));
  for (const stepped of [false, true]) {
    for (const dx of [1, 4, 8]) {
      cases.push(translated(
        `${stepped ? 'stepped' : 'smooth'}-${dx}`,
        `${stepped ? 'Porrastettu solu' : 'Pehmeä pilvi'} — ${dx} px`,
        shape(stepped),
        [dx, 0],
        true,
      ));
    }
  }
  cases.push(translated('diagonal', 'Pehmeä pilvi — vino liike', shape(false), [4, -2], true));
  for (const [prefix, label] of [['default', 'Tutka, oletus'], ['radar_fmi', 'Tutka, FMI'], ['goes19', 'Satelliitti']]) {
    cases.push(translated(`${prefix}-translated`, `${label} — tunnettu 4 px siirto`, images.get(`${prefix}-0.png`), [4, 0]));
  }
  // Exercise the app's wide buffered-image shape and upload/downsampling cost.
  // This is a resized fixture, not additional meteorological detail.
  const wide = canvas(1920, 1080);
  wide.getContext('2d').drawImage(images.get('default-0.png'), 0, 0, wide.width, wide.height);
  cases.push(translated('radar-wide', 'Tutka — leveä 1920 × 1080 kuva, 4 px siirto', wide, [4, 0]));
  cases.push(translated('stationary', 'Tutka — paikallaan', images.get('default-0.png'), [0, 0]));
  const fade = (position) => {
    const c = canvas(ANALYSIS_SIZE);
    const ctx = c.getContext('2d');
    ctx.fillStyle = `rgba(255, 0, 0, ${Math.abs(1 - position)})`;
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  };
  cases.push({
    id: 'transparency',
    label: 'Läpinäkyvyys — häviäminen ja ilmestyminen',
    frames: [fade(0), fade(1), fade(2)],
    expected: fade,
    description: 'Punainen pinta häviää ja ilmestyy. Puolivälissä peittävyys on 50 %, värin tulee säilyä punaisena.',
  });
  return cases;
}
