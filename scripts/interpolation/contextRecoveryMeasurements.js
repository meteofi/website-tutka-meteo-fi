// Real browser/GPU lifecycle check, complementary to the FramePool race tests.
// WEBGL_lose_context is used only by this preview diagnostic, never by the app.
import { RadarInterpolator } from '../../src/animation/interpolation';
import { canvas, pixels } from './cases';
import { pixelError } from './metrics.mjs';

function eventAfter(target, name, action) {
  return new Promise((resolve, reject) => {
    let timeout;
    const handler = () => {
      clearTimeout(timeout);
      resolve();
    };
    timeout = setTimeout(() => {
      target.removeEventListener(name, handler);
      reject(new Error(`Timed out waiting for ${name}`));
    }, 5000);
    target.addEventListener(name, handler, { once: true });
    // Let the previous context event finish dispatching before requesting the
    // next transition; restoring inside the loss event is rejected by WebGL.
    setTimeout(action, 0);
  });
}

function frame(offset, colour = '#4fafff') {
  const image = canvas(32, 32);
  const ctx = image.getContext('2d');
  ctx.fillStyle = colour;
  ctx.fillRect(8 + offset, 10, 12, 12);
  ctx.fillStyle = '#80ff40';
  ctx.fillRect(10 + offset, 14, 5, 4);
  return image;
}

export default async function measureContextRecovery(check) {
  const results = [];
  for (const [profile, useFlow] of [['radar', true], ['satellite', true], ['radar', false]]) {
    const engine = new RadarInterpolator({ motionProfile: profile, useFlow, flowResolution: 32 });
    const name = `${profile}-${useFlow ? 'flow' : 'crossfade'}`;
    const { gl } = engine;
    const extension = gl.getExtension('WEBGL_lose_context');
    try {
      if (!extension) throw new Error('WEBGL_lose_context unavailable for recovery test');
      let frames = [frame(0), frame(1), frame(2)];
      let restores = 0;
      const load = () => {
        frames.forEach((image, i) => engine.onSlotLoaded({ time: String(i) }, image, [0, 0, 32, 32]));
        engine.computeFlow('0', '1');
        engine.computeFlow('1', '2');
      };
      engine.onContextChange = () => {
        if (!engine.contextLost) { restores++; load(); }
      };
      load();
      const samples = [0, 0.5, 1].map((t) => pixels(engine.renderAt('0', '1', t)));
      for (let cycle = 0; cycle < 2; cycle++) {
        const oldWarp = engine.warp;
        const oldFlow = engine.flows.get('0|1').texture;
        const oldTrajectory = engine.trajectories;
        // eslint-disable-next-line no-await-in-loop
        await eventAfter(engine.canvas, 'webglcontextlost', () => extension.loseContext());
        check(
          `recovery:${name}-${cycle}:fallback`,
          'correctness',
          Number(engine.hasFlow('0', '1') || engine.renderAt('0', '1', 0.5) !== null),
          0,
        );
        // eslint-disable-next-line no-await-in-loop
        await eventAfter(engine.canvas, 'webglcontextrestored', () => extension.restoreContext());
        check(`recovery:${name}-${cycle}:resources`, 'correctness', Number(
          !engine.hasFlow('0', '1') || engine.warp === oldWarp
          || engine.flows.get('0|1')?.texture === oldFlow
          || (profile === 'radar' && engine.trajectories === oldTrajectory),
        ), 0);
        const errors = [0, 0.5, 1].map((t, i) => pixelError(pixels(engine.renderAt('0', '1', t)), samples[i]).max);
        check(`recovery:${name}-${cycle}:pixels`, 'correctness', Math.max(...errors), 1);
        check(`recovery:${name}-${cycle}:gl`, 'correctness', gl.getError(), gl.NO_ERROR);
        results.push({ name, cycle, maxPixelError: Math.max(...errors) });
      }
      // The owner may have newer images by the time restoration is allowed.
      // eslint-disable-next-line no-await-in-loop
      await eventAfter(engine.canvas, 'webglcontextlost', () => extension.loseContext());
      frames = [frame(0, '#ff4040'), frame(1, '#ff4040'), frame(2, '#ff4040')];
      // eslint-disable-next-line no-await-in-loop
      await eventAfter(engine.canvas, 'webglcontextrestored', () => extension.restoreContext());
      check(
        `recovery:${name}:new-images`,
        'correctness',
        pixelError(pixels(engine.renderAt('0', '1', 0)), pixels(frames[0])).max,
        1,
      );
      check(`recovery:${name}:notifications`, 'correctness', Math.abs(restores - 3), 0);
      // A late restore must not recreate an interpolator that the owner removed.
      // eslint-disable-next-line no-await-in-loop
      await eventAfter(engine.canvas, 'webglcontextlost', () => extension.loseContext());
      engine.dispose();
      // eslint-disable-next-line no-await-in-loop
      await eventAfter(engine.canvas, 'webglcontextrestored', () => extension.restoreContext());
      check(`recovery:${name}:disposed`, 'correctness', Number(
        engine.warp !== null || engine.frames.size !== 0 || restores !== 3,
      ), 0);
    } finally {
      engine.dispose();
    }
  }
  return results;
}
