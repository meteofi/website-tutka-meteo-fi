import ImageWMS from 'ol/source/ImageWMS';
import ImageState from 'ol/ImageState';

// Match the meteocore WMS server's explicit limits exactly: each
// GetMap request must be ≤ 8000 px on either axis AND ≤ 64 megapixels
// total area. The server rejects requests that exceed either bound.
// Clamping client-side guarantees no rejection trip, and on typical
// 16:9 viewports the per-axis cap binds first (8000 × 4500 = 36 MP,
// well under 64 MP); the area cap only kicks in for square-ish
// requests. Both checks together preserve the server's contract.
const MAX_REQUEST_DIM = 8000;
const MAX_REQUEST_PIXELS = 64 * 1000 * 1000;

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
    // Optional clamp — when set, requests never go out finer than this
    // many metres per pixel. The data behind a radar composite (typically
    // 500 m – 2 km native) gains no information from a finer request;
    // we'd just waste server time encoding upsampled pixels and shovel
    // a larger payload over the wire. See `clampResolution` below.
    this._nativeResolutionMeters = null;
    this.setImageLoadFunction(createAbortableImageLoader(this));
  }

  // Coerce the requested resolution to whichever cap binds:
  //   * native cap: never request finer than the data's own pixel size
  //     (scaled by devicePixelRatio so the cap is in device-pixel terms,
  //     not logical-pixel terms — `hidpi: false` on our sources means
  //     each request pixel already covers DPR² device pixels);
  //   * dimension cap: never ask for an image larger than
  //     MAX_REQUEST_DIM on either axis AND total area ≤
  //     MAX_REQUEST_PIXELS. The loader inflates the view extent by
  //     `this.ratio_` before computing WIDTH = inflated_extent_w /
  //     resolution (same for HEIGHT). So:
  //       per-axis: resolution ≥ extent_max × ratio / MAX_DIM
  //       area:     resolution ≥ ratio × sqrt(extent_w × extent_h / MAX_PIXELS)
  //     Whichever produces the larger resolution wins; on typical 16:9
  //     viewports the per-axis cap binds first (the area cap only
  //     matters when the request is close to square).
  //
  // Whichever cap is stricter (= larger resolution number) wins overall.
  clampResolution(extent, resolution) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    let effective = resolution;
    const nativeCap = this._nativeResolutionMeters;
    if (nativeCap) {
      const native = nativeCap * dpr;
      if (effective < native) effective = native;
    }
    if (extent && this.ratio_) {
      const extW = (extent[2] - extent[0]) * this.ratio_;
      const extH = (extent[3] - extent[1]) * this.ratio_;
      const dimCap = Math.max(extW, extH) / MAX_REQUEST_DIM;
      if (effective < dimCap) effective = dimCap;
      const areaCap = Math.sqrt((extW * extH) / MAX_REQUEST_PIXELS);
      if (effective < areaCap) effective = areaCap;
    }
    return effective;
  }

  setNativeResolution(meters) {
    const next = typeof meters === 'number' && meters > 0 ? meters : null;
    if (next === this._nativeResolutionMeters) return;
    this._nativeResolutionMeters = next;
    // Drop the cached wrapper so a stale higher-res image isn't reused
    // when the clamp tightens.
    this.resetImageCache();
  }

  getImage(extent, resolution, pixelRatio, projection) {
    const effective = this.clampResolution(extent, resolution);
    const image = super.getImage(extent, effective, pixelRatio, projection);
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
    const effective = this.clampResolution(extent, resolution);
    const image = super.getImage(extent, effective, pixelRatio, projection);
    if (image && image.getState() === ImageState.IDLE) image.load();
  }

  // Drop the cached "last good" image. Call when the slot's semantic
  // identity changes (product/style/URL switch, TIME reassignment) —
  // otherwise the next pan would render the previous product's pixels
  // under the stale-while-loading path.
  invalidateSticky() {
    this._sticky = null;
  }

  // Clear the parent ImageSource's cached image wrapper so the next
  // super.getImage call creates a fresh one at the current view
  // extent. Needed because OL's own render pipeline keeps calling
  // getImage on the primary layer's source during a pan or zoom,
  // and the cache can lock in an intermediate wrapper whose extent
  // doesn't match the final view. A load completing on that wrapper
  // stores the mid-interaction extent on the interpolator frame,
  // which then fails the extent-equality check against neighbouring
  // slots loaded at the final view and the LK compute is skipped.
  //
  // OL 10 stores the wrapper on `this.image` (no trailing
  // underscore). Also null the `wantedExtent_/Resolution_/Projection_`
  // so the cache-check short-circuit at ImageSource.getImageInternal
  // can't match either via the wanted hint or the cached wrapper.
  //
  // Sticky is preserved so the layer keeps drawing the old-extent
  // image while the new wrapper loads.
  resetImageCache() {
    if (this._currentAbortController) {
      this._currentAbortController.abort();
      this._currentAbortController = null;
    }
    this.image = null;
    this.wantedExtent_ = null;
    this.wantedResolution_ = null;
    this.wantedProjection_ = null;
  }

  // Promote an image to sticky. Used from imageloadend when the slot
  // is not currently primary (so OL never calls getImage through the
  // sticky override, which is the other place sticky gets updated).
  setSticky(image) {
    if (image && image.getState() === ImageState.LOADED) {
      this._sticky = image;
    }
  }

  // Does this source have a LOADED image covering the requested view?
  // Used by the pool to decide whether a slot's `loaded` state is still
  // valid after a view change. Side effect: creates a new IDLE wrapper
  // on cache miss (that's OL's normal getImage behavior; fan-out will
  // load it later).
  hasLoadedImageForView(extent, resolution, pixelRatio, projection) {
    const effective = this.clampResolution(extent, resolution);
    const image = super.getImage(extent, effective, pixelRatio, projection);
    return !!(image && image.getState() === ImageState.LOADED);
  }
}
