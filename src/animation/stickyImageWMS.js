import ImageWMS from 'ol/source/ImageWMS';
import ImageState from 'ol/ImageState';

// fetch() + AbortController based image loader. Each source tracks the
// in-flight request; a new call aborts the previous one. This prevents
// superseded requests (after rapid pan/zoom) from wasting server cycles
// and bandwidth after the user has moved on.
//
// OL's default loader sets `img.src = url`, which the browser can't
// reliably cancel. fetch() supports AbortSignal and has consistent
// cancellation behavior.
//
// Flow: fetch response → Blob → object URL → img.src. The image element
// fires 'load' which resolves OL's internal decode()/load() path the
// same as a direct src assignment.
function createAbortableImageLoader(source) {
  return (imageWrapper, src) => {
    if (source._currentAbortController) {
      source._currentAbortController.abort();
    }
    const controller = new AbortController();
    source._currentAbortController = controller;

    const htmlImage = imageWrapper.getImage();

    fetch(src, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (controller.signal.aborted) return;
        if (source._currentAbortController === controller) {
          source._currentAbortController = null;
        }
        const blobUrl = URL.createObjectURL(blob);
        const revoke = () => URL.revokeObjectURL(blobUrl);
        htmlImage.addEventListener('load', revoke, { once: true });
        htmlImage.addEventListener('error', revoke, { once: true });
        htmlImage.src = blobUrl;
      })
      .catch(() => {
        // On abort or network error, dispatch an error event on the
        // image so OL's internal load promise rejects and the wrapper
        // transitions to ERROR state. Superseded request events are
        // filtered by event.image !== source.image in FramePool.
        //
        // Note: OL's ImageWrapper logs an `Image load error` to the
        // console for every rejected load, including aborts. That's
        // accepted noise; the alternative (leaving the wrapper in
        // LOADING state forever) leaks state and is worse.
        htmlImage.dispatchEvent(new Event('error'));
      });
  };
}

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
    this._currentAbortController = null;
    this.setImageLoadFunction(createAbortableImageLoader(this));
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

  // Promote an image to sticky. Used from imageloadend when the slot
  // is not currently primary (so OL never calls getImage through the
  // sticky override, which is the other place sticky gets updated).
  setSticky(image) {
    if (image && image.getState() === ImageState.LOADED) {
      this._sticky = image;
    }
  }
}
