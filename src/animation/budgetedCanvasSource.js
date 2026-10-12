// The interpolator's output source: an ol/source/ImageCanvas that renders
// the warp for the view alone, under a pixel budget, and tells the layer
// renderer so through the image's pixel ratio.
//
// WHY. An unbounded canvas used to be
// asked for at viewSize × 1.5 (the fetch buffer) × devicePixelRatio: a 4K
// desktop at DPR 1 rendered and copied 18.7 Mpx per frame per pool at 60 Hz
// playback and the whole page stalled; a 2× laptop 11.7 Mpx for a 1.3 Mpx
// view. Now: the view (WARP_RATIO 1 — the shader samples the stored,
// buffered frames through renderAt's UV transform, so the buffer is still
// there for the flow to read, it just is not painted), never above
// WARP_PIXEL_BUDGET. Radar may use up to 2x display sampling within that
// budget: warping DPR-1 bitmaps onto a CSS-sized canvas then enlarging it
// filters their edges twice. Sampling directly at display resolution avoids
// that extra blur; it does not request higher-resolution WMS images.
//
// HOW. The canvas renderer sizes a drawn image as
//   width × (pixelRatio · resolution) / (viewResolution · imagePixelRatio)
// so a canvas k× smaller reported with an image pixel ratio k× smaller lands
// on exactly the same screen rectangle. getImageInternal is OL's own with
// that one scale folded in.

import ImageCanvasSource from 'ol/source/ImageCanvas';
import ImageCanvas from 'ol/ImageCanvas';
import {
  containsExtent, getHeight, getWidth, scaleFromCenter,
} from 'ol/extent';

export const WARP_RATIO = 1;
export const WARP_PIXEL_BUDGET = 4e6;

export default class BudgetedCanvasSource extends ImageCanvasSource {
  constructor(options) {
    super(options);
    this.canvasFunction_ = options.canvasFunction;
    this.ratio_ = options.ratio !== undefined ? options.ratio : WARP_RATIO;
    this.maxPixelRatio = options.maxPixelRatio ?? 1;
  }

  getImageInternal(extent, resolution, pixelRatio, projection) {
    const res = this.findNearestResolution(resolution);
    const paddedExtent = extent.slice();
    scaleFromCenter(paddedExtent, this.ratio_);
    const width = getWidth(paddedExtent) / res;
    const height = getHeight(paddedExtent) / res;
    const imagePixelRatio = Math.min(pixelRatio, this.maxPixelRatio, Math.sqrt(WARP_PIXEL_BUDGET / (width * height)));
    let canvas = this.canvas_;
    if (canvas && this.renderedRevision_ === this.getRevision()
      && canvas.getResolution() === res
      && canvas.getPixelRatio() === imagePixelRatio
      && containsExtent(canvas.getExtent(), extent)) {
      return canvas;
    }
    const size = [Math.max(1, Math.round(width * imagePixelRatio)), Math.max(1, Math.round(height * imagePixelRatio))];
    // Whole-pixel rounding must not exceed the area budget.
    if (size[0] * size[1] > WARP_PIXEL_BUDGET) {
      size[0] = Math.max(1, Math.floor(width * imagePixelRatio));
      size[1] = Math.max(1, Math.floor(height * imagePixelRatio));
    }
    const canvasElement = this.canvasFunction_.call(this, paddedExtent, res, pixelRatio, size, projection);
    if (canvasElement) {
      canvas = new ImageCanvas(paddedExtent, res, imagePixelRatio, canvasElement);
    }
    this.canvas_ = canvas;
    this.renderedRevision_ = this.getRevision();
    return canvas;
  }
}
