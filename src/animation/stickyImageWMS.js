import ImageWMS from 'ol/source/ImageWMS';
import ImageState from 'ol/ImageState';

// Shared frame-blob cache across ALL sources — and therefore all split panes.
// The GetMap URL (`src`) is deterministic from the layer params plus the
// requested WIDTH/HEIGHT/BBOX, so two panes showing the same layer over the
// same area build byte-identical URLs. Keying by `src` means that frame is
// fetched ONCE and every pane reuses the blob: no duplicate network traffic,
// and same-layer panes' slots load in lockstep (so they stay time-synced
// without any playback barrier).
//
// IMPORTANT — dedup only engages when the panes are PIXEL-IDENTICAL. Each pane
// requests WIDTH/HEIGHT/BBOX derived from its own viewport size; a CSS grid
// `1fr 1fr` on an odd-width screen yields e.g. 360 vs 361 px, so the two panes
// ask for different-sized images of different extents → different `src` →
// separate fetches. That's correct: the images genuinely differ, so we must
// NOT normalize the key (rounding BBOX / sizes to force a hit would hand a pane
// a wrong-sized image for its extent). Off-by-one panes simply fall back to
// independent (correct) fetches — the optimization is best-effort.
//
// Entry: { blob: Blob|null, promise: Promise<Blob>|null }. Map insertion order
// gives us a cheap LRU.
const frameBlobCache = new Map();
const FRAME_BLOB_CACHE_MAX = 400;

function evictFrameCache() {
  // Drop oldest COMPLETED entries until under the cap; never evict an in-flight
  // fetch (a consumer is still awaiting it).
  for (const [key, entry] of frameBlobCache) {
    if (frameBlobCache.size <= FRAME_BLOB_CACHE_MAX) break;
    if (entry.promise) continue; // eslint-disable-line no-continue
    frameBlobCache.delete(key);
  }
}

// Fetch a frame blob, deduping completed AND in-flight requests by `src`. The
// shared fetch is not tied to any one consumer's lifecycle, so a pane that pans
// away doesn't cancel a fetch another pane still needs. (We trade the old
// per-source abort-on-supersession for cross-pane dedup; FramePool already
// suppresses fetches during active pan/zoom gestures, so superseded in-flight
// requests are rare.)
function sharedFetchBlob(src) {
  let entry = frameBlobCache.get(src);
  if (entry) {
    frameBlobCache.delete(src); // LRU bump
    frameBlobCache.set(src, entry);
    if (entry.blob) return Promise.resolve(entry.blob);
    if (entry.promise) return entry.promise;
  } else {
    entry = {};
    frameBlobCache.set(src, entry);
  }
  entry.promise = fetch(src)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then((blob) => {
      entry.blob = blob;
      entry.promise = null;
      evictFrameCache();
      return blob;
    })
    .catch((err) => {
      frameBlobCache.delete(src);
      throw err;
    });
  return entry.promise;
}

// Image loader: pull the blob from the shared cache, then point the image
// element at a per-image object URL. `source._wantedSrc` guards against a
// superseded request (the source moved to a new extent before the old fetch
// resolved) so a stale completion is ignored instead of clobbering the wrapper.
function createSharedImageLoader(source) {
  return (imageWrapper, src) => {
    source._wantedSrc = src;
    const htmlImage = imageWrapper.getImage();
    const assign = (blob) => {
      if (source._wantedSrc !== src) return; // superseded by a newer extent
      const blobUrl = URL.createObjectURL(blob);
      const revoke = () => URL.revokeObjectURL(blobUrl);
      htmlImage.addEventListener('load', revoke, { once: true });
      htmlImage.addEventListener('error', revoke, { once: true });
      htmlImage.src = blobUrl;
    };
    sharedFetchBlob(src)
      .then(assign)
      .catch(() => {
        // Dispatch an error so OL's load promise rejects and the wrapper hits
        // ERROR state. Superseded events are filtered in FramePool by
        // event.image !== source.image.
        if (source._wantedSrc === src) htmlImage.dispatchEvent(new Event('error'));
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
    this._wantedSrc = null;
    this.setImageLoadFunction(createSharedImageLoader(this));
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
  // image while the new wrapper loads. A still-in-flight shared fetch is
  // left running (other panes may need it); its result is ignored here
  // because the next loader call updates `_wantedSrc`.
  resetImageCache() {
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
    const image = super.getImage(extent, resolution, pixelRatio, projection);
    return !!(image && image.getState() === ImageState.LOADED);
  }
}
