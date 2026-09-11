// The interpolator's output source: an ol/source/ImageCanvas that renders
// the warp for the view alone, under a pixel budget, and tells the layer
// renderer so through the image's pixel ratio.
//
// WHY. The frames being warped are DPR-1 bitmaps (hidpi: false on every
// slot), so a warp canvas above the view's CSS size only upscales —
// bilinear, exactly what the compositor does for free — and it used to be
// asked for at viewSize × 1.5 (the fetch buffer) × devicePixelRatio: a 4K
// desktop at DPR 1 rendered and copied 18.7 Mpx per frame per pool at 60 Hz
// playback and the whole page stalled; a 2× laptop 11.7 Mpx for a 1.3 Mpx
// view. Now: the view (WARP_RATIO 1 — the shader samples the stored,
// buffered frames through renderAt's UV transform, so the buffer is still
// there for the flow to read, it just is not painted), at CSS size or
// less, never above WARP_PIXEL_BUDGET.
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
  }

  getImageInternal(extent, resolution, pixelRatio, projection) {
    const res = this.findNearestResolution(resolution);
    const paddedExtent = extent.slice();
    scaleFromCenter(paddedExtent, this.ratio_);
    const width = getWidth(paddedExtent) / res;
    const height = getHeight(paddedExtent) / res;
    // No DPR upscale of DPR-1 frames, and never above the budget.
    const k = Math.min(1, 1 / pixelRatio, Math.sqrt(WARP_PIXEL_BUDGET / (width * height * pixelRatio * pixelRatio)));
    const imagePixelRatio = pixelRatio * k;
    let canvas = this.canvas_;
    if (canvas && this.renderedRevision_ === this.getRevision()
      && canvas.getResolution() === res
      && canvas.getPixelRatio() === imagePixelRatio
      && containsExtent(canvas.getExtent(), extent)) {
      return canvas;
    }
    const size = [Math.round(width * imagePixelRatio), Math.round(height * imagePixelRatio)];
    const canvasElement = this.canvasFunction_.call(this, paddedExtent, res, pixelRatio, size, projection);
    if (canvasElement) {
      canvas = new ImageCanvas(paddedExtent, res, imagePixelRatio, canvasElement);
    }
    this.canvas_ = canvas;
    this.renderedRevision_ = this.getRevision();
    return canvas;
  }
}
