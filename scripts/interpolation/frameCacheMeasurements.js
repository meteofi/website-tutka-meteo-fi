// A complete observation window must keep its motion fields and pixels even
// when the first pair's full-resolution textures have been evicted.
import { FRAME_COUNT, FRAME_STEPS } from '../../src/constants';
import { pixels } from './cases';
import { pixelError } from './metrics.mjs';

export default function measureFrameCache(engine, testCase, check) {
  for (const key of [...engine.frames.keys()]) engine.invalidateSlot(key);
  const { width, height } = testCase.frames[0];
  const load = (i) => engine.onSlotLoaded({ time: String(i) }, testCase.frames[i % testCase.frames.length], [0, 0, width, height]);
  const sample = (t) => pixels(engine.renderAt('0', '1', t, 800, 450));
  for (let i = 0; i < testCase.frames.length; i++) load(i);
  engine.computeFlow('0', '1');
  engine.computeFlow('1', '2');
  const before = [0, 0.5, 1].map(sample);
  const first = engine.frames.get('0');
  const oldTexture = engine.frameTextures.entries.get(first);
  const oldFlow = engine.flows.get('0|1');
  for (let i = testCase.frames.length; i < FRAME_COUNT; i++) {
    load(i);
    engine.computeFlow(String(i - 1), String(i));
  }
  const resident = engine.frameTextures.entries;
  check('frame-cache:displayed-pair-retained', 'correctness', Number(resident.get(first) !== oldTexture || !engine.gl.isTexture(oldTexture)), 0);
  const backfillErrors = [0, 0.5, 1].map((t, i) => pixelError(sample(t), before[i]).max);
  check('frame-cache:pixels-after-backfill', 'correctness', Math.max(...backfillErrors), 0);
  // Pausing releases the displayed pair. Backfill can then evict its GPU
  // copies, while the same flow and original decoded images remain usable.
  engine.prefetch([]);
  for (let i = 2; i < FRAME_COUNT; i++) engine.frameTextures.get(engine.frames.get(String(i)));
  check('frame-cache:evicted-first-pair', 'correctness', Number(resident.has(first) || engine.gl.isTexture(oldTexture)), 0);
  check('frame-cache:four-texture-limit', 'correctness', resident.size, 4);
  check('frame-cache:whole-window-retained', 'correctness', Math.abs(engine.frames.size - FRAME_COUNT), 0);
  check('frame-cache:all-motion-retained', 'correctness', Math.abs(engine.flows.size - FRAME_STEPS), 0);
  const imageBytes = [...resident.keys()].reduce((sum, frame) => sum + frame.width * frame.height * 4, 0);
  const errors = [0, 0.5, 1].map((t, i) => pixelError(sample(t), before[i]).max);
  check('frame-cache:pixels-after-eviction', 'correctness', Math.max(...errors), 0);
  check('frame-cache:flow-identity', 'correctness', Number(engine.flows.get('0|1') !== oldFlow), 0);
  const textureA = resident.get(first);
  sample(0.6);
  check('frame-cache:reuse-within-pair', 'correctness', Number(resident.get(first) !== textureA), 0);
  // The last observation is the t=1 end of the preceding pair, with no wrap.
  const last = pixels(engine.renderAt(String(FRAME_STEPS - 1), String(FRAME_STEPS), 1, width, height));
  check('frame-cache:last-observation', 'correctness', pixelError(last, pixels(testCase.frames[FRAME_STEPS % testCase.frames.length])).max, 3);
  check('frame-cache:no-wrap', 'correctness', Number(engine.hasFlow(String(FRAME_STEPS), '0')), 0);
  check('frame-cache:gl', 'correctness', engine.gl.getError(), engine.gl.NO_ERROR);
  return { imageBytes, fullyResidentBytes: FRAME_COUNT * width * height * 4, maxPixelError: Math.max(...errors) };
}
