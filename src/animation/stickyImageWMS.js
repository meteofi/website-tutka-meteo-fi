import ImageWMS from 'ol/source/ImageWMS';
import ImageState from 'ol/ImageState';

// ImageWMS that returns the last successfully-loaded image while a new
// request is loading. The renderer keeps drawing old pixels at their
// original world coordinates — OL's compositor translates/scales them
// to the current view, so a pan slides the old image under the viewport
// and a zoom rescales it (blurry but present) until the new image lands.
//
// When a fresh LOADED image arrives it becomes the new sticky reference
// on the next getImage call.
export default class StickyImageWMS extends ImageWMS {
  constructor(options) {
    super(options);
    this._sticky = null;
  }

  getImage(extent, resolution, pixelRatio, projection) {
    const image = super.getImage(extent, resolution, pixelRatio, projection);
    if (!image) return this._sticky || image;
    const state = image.getState();
    if (state === ImageState.LOADED) {
      this._sticky = image;
      return image;
    }
    if (this._sticky && this._sticky.getState() === ImageState.LOADED) {
      return this._sticky;
    }
    return image;
  }

  // Explicitly start loading for the current view. Called from FramePool
  // on moveend only — NOT from getImage, which would fire once per RAF
  // during a drag/zoom gesture and create dozens of requests per pan.
  triggerLoad(extent, resolution, pixelRatio, projection) {
    const image = super.getImage(extent, resolution, pixelRatio, projection);
    if (image && image.getState() === ImageState.IDLE) image.load();
  }

  // Drop the cached "last good" image. Call when the slot's semantic
  // identity changes (product/style/URL switch, TIME reassignment) —
  // otherwise the next pan would render the previous product's pixels
  // under the stale-while-loading path.
  invalidateSticky() {
    this._sticky = null;
  }
}
