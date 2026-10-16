// Crossfade must keep the same premultiplied colours and bounded source UVs
// with both cold resources and a previously used motion renderer.
import { RadarInterpolator } from '../../src/animation/interpolation';
import { canvas, pixels } from './cases';
import { pixelError } from './metrics.mjs';

export default function measureCrossfade(check) {
  const frames = ['#ff4000', '#0080ff'].map((colour, index) => {
    const image = canvas(32, 32);
    const ctx = image.getContext('2d');
    ctx.fillStyle = colour;
    ctx.globalAlpha = index ? 0.5 : 1;
    ctx.fillRect(4 + index * 8, 4, 16, 24);
    return image;
  });
  const results = [];
  for (const profile of ['radar', 'satellite']) {
    const engine = new RadarInterpolator({ motionProfile: profile, flowResolution: 32 });
    try {
      frames.forEach((image, i) => engine.onSlotLoaded({ time: String(i) }, image, [0, 0, 32, 32]));
      for (const warm of [false, true]) {
        if (warm) {
          engine.setUseFlow(true);
          engine.computeFlow('0', '1');
          engine.renderAt('0', '1', 0.5);
          engine.setUseFlow(false);
        }
        engine.computeFlow('0', '1');
        for (const [view, size] of [[[0, 0, 32, 32], 32], [[8, 8, 24, 24], 32], [[-8, -8, 24, 24], 64]]) {
          for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            const reference = canvas(size, size);
            const ctx = reference.getContext('2d');
            // Add weighted premultiplied samples, including alpha. Ordinary
            // source-over would attenuate the first image a second time.
            ctx.globalCompositeOperation = 'lighter';
            frames.forEach((frame, i) => {
              ctx.globalAlpha = i ? t : 1 - t;
              ctx.drawImage(frame, view[0], 32 - view[3], view[2] - view[0], view[3] - view[1], 0, 0, size, size);
            });
            const error = pixelError(pixels(engine.renderAt('0', '1', t, size, size, view)), pixels(reference));
            check(`crossfade:${profile}-${warm ? 'warm' : 'cold'}-${view.join(',')}-${t}`, 'correctness', error.max, 3);
            results.push({
              profile, warm, view, size, t, ...error,
            });
          }
        }
        check(`crossfade:${profile}-${warm ? 'warm' : 'cold'}:gl`, 'correctness', engine.gl.getError(), engine.gl.NO_ERROR);
      }
    } finally {
      engine.dispose();
    }
  }
  return results;
}
