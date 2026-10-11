// Pin the image/canvas geometry against OpenLayers' real image wrappers.
// Wrong pixel ratios still draw, but silently blur or move the radar.
/* eslint-disable import/extensions, no-console */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { get as getProjection } from 'ol/proj.js';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(specifier.startsWith('ol/') && !specifier.endsWith('.js')
      ? `${specifier}.js` : specifier, context);
  },
});
const { default: BudgetedCanvasSource, WARP_PIXEL_BUDGET } = await import('../src/animation/budgetedCanvasSource.js');
hooks.deregister();
const projection = getProjection('EPSG:3857');

for (const [width, height] of [[390, 844], [1759, 991], [1920, 1080], [3840, 2160], [960, 540], [195, 422]]) {
  for (const dpr of [1, 1.25, 2, 3]) {
    const extent = [103.3, 211.7, 103.3 + width * 100, 211.7 + height * 100];
    let calls = 0;
    const source = new BudgetedCanvasSource({
      maxPixelRatio: 2,
      canvasFunction(view, resolution, pixelRatio, size) {
        calls++;
        assert.deepEqual(view, extent, 'retain world coverage without a fetch buffer');
        assert.equal(resolution, 100);
        assert.equal(pixelRatio, dpr);
        return { width: size[0], height: size[1] };
      },
    });
    const image = source.getImageInternal(extent, 100, dpr, projection);
    const bitmap = image.getImage();
    assert.ok(bitmap.width * bitmap.height <= WARP_PIXEL_BUDGET, 'hard allocation budget');
    assert.ok(image.getPixelRatio() <= Math.min(dpr, 2), 'do not exceed screen density or 2x');
    // ImageLayerRenderer scales by deviceRatio / imageRatio. Rounding the
    // bitmap may change the far edge by less than one source pixel only.
    assert.ok(Math.abs(bitmap.width / image.getPixelRatio() - width) < 1 / image.getPixelRatio());
    assert.ok(Math.abs(bitmap.height / image.getPixelRatio() - height) < 1 / image.getPixelRatio());
    if (dpr <= 2 && width * height * dpr * dpr <= WARP_PIXEL_BUDGET) {
      assert.equal(image.getPixelRatio(), dpr, 'use display density when the budget permits');
    }
    assert.equal(source.getImageInternal(extent, 100, dpr, projection), image, 'reuse unchanged canvas');
    assert.equal(calls, 1);
    source.changed();
    assert.notEqual(source.getImageInternal(extent, 100, dpr, projection), image, 'redraw each animation revision');
    assert.equal(calls, 2);
  }
}
const unchanged = new BudgetedCanvasSource({ canvasFunction: (extent, res, dpr, size) => ({ width: size[0], height: size[1] }) });
assert.equal(unchanged.getImageInternal([0, 0, 390, 844], 1, 3, projection).getPixelRatio(), 1, 'other profiles retain CSS sampling');
console.log('Warp display: high-DPI sampling, world placement, caching and pixel budget passed.');
