// Include the app's intermediate canvas and its enlargement onto a high-DPI
// display. Comparing the warp alone misses this extra filtering entirely.
import BudgetedCanvasSource from '../../src/animation/budgetedCanvasSource';
import { ANALYSIS_SIZE, canvas, pixels } from './cases';
import { pixelError } from './metrics.mjs';

export default function measureDisplaySampling(engine, testCase, load, render, crop, check) {
  // Exact translation isolates display sampling from flow-estimation error.
  const [dx, dy] = testCase.displacement;
  load(engine, { ...testCase, knownFlow: () => [dx / ANALYSIS_SIZE, -dy / ANALYSIS_SIZE] });
  const { width, height } = testCase.frames[0];
  const extent = [0.253 * width, 0.253 * height, 0.753 * width, 0.753 * height];
  const outputWidth = width;
  const outputHeight = height;
  let position = 0;
  const source = new BudgetedCanvasSource({
    maxPixelRatio: 2,
    canvasFunction: (view, resolution, dpr, size) => render(engine, position, ...size, view),
  });
  return [0, 0.5, 1, 1.5, 2].map((t) => {
    position = t;
    source.changed();
    const image = source.getImageInternal(extent, 1, 2, null);
    const displayed = canvas(outputWidth, outputHeight);
    // Same size relationship as OL's ImageLayerRenderer: device / image DPR.
    const bitmap = image.getImage();
    const scale = 2 / image.getPixelRatio();
    displayed.getContext('2d').drawImage(bitmap, 0, 0, bitmap.width * scale, bitmap.height * scale);
    const error = pixelError(pixels(displayed), pixels(crop(testCase.expected(t), outputWidth, outputHeight, extent)));
    check(`display:retina-sharpness-${t}`, 'correctness', error.mean, 0.1);
    return {
      position: t, width: bitmap.width, height: bitmap.height, ...error,
    };
  });
}
