import ImageLayer from 'ol/layer/Image';
import ImageCanvasSource from 'ol/source/ImageCanvas';
import StickyImageWMS from './stickyImageWMS';

const SYNC_PARAM_KEYS = ['LAYERS', 'STYLES', 'FORMAT', 'ELEVATION'];

function pickSyncParams(params) {
  const out = {};
  for (const k of SYNC_PARAM_KEYS) {
    if (k in params) out[k] = params[k];
  }
  return out;
}

// Pool of N invisible ImageLayers, each with its own ImageWMS source
// pinned to a specific TIME. All 13 sources preload in parallel (the
// layers are hidden, so we drive loads manually via source.getImage +
// image.load() on window change and moveend).
//
// On each animation tick, tryShowTime(t) finds the slot whose source has
// a LOADED image covering the current view; if found, the primary layer's
// source is re-pointed at that slot's source and the primary instantly
// displays the preloaded frame with no refetch. If no slot is ready, the
// primary stays on whichever slot it last displayed — the tick produces
// no visible change rather than a blank.
//
// Window slides (IS_FOLLOWING pulling in new data) preserve 12 of 13
// slots: we match existing slot.time values to the new window and only
// refetch the one slot whose TIME left the window.
export default class FramePool {
  constructor({
    primaryLayer, map, size = 13, ratio = 1.5, interpolator = null,
  }) {
    this.primary = primaryLayer;
    this.map = map;
    this.size = size;
    this.slots = [];
    this.ratio = ratio;
    // Optional RadarInterpolator instance. When present, showInterpolated
    // drives the interpolator's warp shader and a separate warp layer
    // displays the interpolated canvas.
    this.interpolator = interpolator;
    this.warpLayer = null;
    this.interpActive = false;
    // Updated each RAF so the warp source's canvasFunction can read
    // the current (A, B, t) it should render. Kept as an object
    // reference so closures in setInterpolator can read through it.
    this._warpState = { timeA: null, timeB: null, t: 0 };

    this.onLoadStateChange = null;
    this.windowTimes = null;
    this.currentTime = null;

    const baseSource = primaryLayer.getSource();
    for (let i = 0; i < size; i++) {
      const source = new StickyImageWMS({
        url: baseSource.getUrl(),
        params: { ...baseSource.getParams() },
        attributions: baseSource.getAttributions(),
        ratio,
        hidpi: false,
        serverType: 'geoserver',
      });
      const slot = {
        layer: null, source, time: null, loaded: false,
      };
      const layer = new ImageLayer({
        name: `${primaryLayer.get('name')}__slot${i}`,
        visible: false,
        opacity: 0,
        source,
      });
      slot.layer = layer;
      // Only act on events for the source's CURRENT image. When the
      // user pans/zooms rapidly, old requests get superseded by newer
      // ones (source.image points at the newer one); the old requests
      // keep loading in the background and eventually fire completion
      // events for the OLD extent. Acting on those would mark the slot
      // "loaded" and promote a stale image to sticky prematurely.
      source.on('imageloadstart', (event) => {
        if (event.image !== slot.source.image) return;
        slot.loaded = false;
        this._notifyLoadChange(slot);
      });
      source.on('imageloadend', (event) => {
        if (event.image !== slot.source.image) return;
        slot.loaded = true;
        // Update sticky here so slots that are never primary (OL never
        // calls getImage on invisible layers) still advance their
        // sticky when their current image finishes loading.
        slot.source.setSticky(event.image);
        this._notifyLoadChange(slot);
        // Sticky override masks OL's IDLE tracking — the renderer
        // never attached a CHANGE listener to the new image, so it
        // doesn't know the new image landed. If this slot is the one
        // primary is currently using, force the layer to re-render by
        // marking it changed; otherwise a plain map.render() suffices.
        if (this.primary.getSource() === slot.source) {
          this.primary.changed();
        }
        this.map.render();
        // Hand the fresh bitmap to the interpolator so it can upload
        // a GL texture keyed by the slot's TIME. Safe for interp=null
        // pools (lightning, observation) — the method is only called
        // when an interpolator has been attached.
        if (this.interpolator) {
          this.interpolator.onSlotLoaded(slot, event.image.getImage());
        }
        // Fan out: as the current ring of frames finishes loading,
        // trigger the next ring outward. Throttles total wire traffic
        // (never more than 2 new requests per ring) while eventually
        // loading all 13 frames.
        this._advanceFrontier();
      });
      source.on('imageloaderror', (event) => {
        if (event.image !== slot.source.image) return;
        slot.loaded = false;
        this._notifyLoadChange(slot);
      });
      this.slots.push(slot);
      map.addLayer(layer);
    }

    map.on('moveend', () => {
      // Probe each slot: if its cached image doesn't cover the new
      // view, its `loaded` flag is stale. Reset so the timeline reflects
      // which cells need to be re-fetched for the current view.
      const ctx = this._getViewContext();
      if (ctx) {
        for (const slot of this.slots) {
          if (!slot.time) {
            continue; // eslint-disable-line no-continue
          }
          const fresh = slot.source.hasLoadedImageForView(
            ctx.extent,
            ctx.resolution,
            1,
            ctx.projection,
          );
          if (slot.loaded !== fresh) {
            slot.loaded = fresh;
            this._notifyLoadChange(slot);
            // Slot's sticky no longer covers the view — any flow pair
            // built from the now-stale bitmap is suspect. Drop the
            // frame texture and pair entries; onSlotLoaded will repopulate
            // when the slot refetches.
            if (!fresh && this.interpolator && slot.time) {
              this.interpolator.invalidateSlot(slot.time);
            }
          }
        }
      }
      this._prefetchAroundCurrent();
    });

    // When the layer becomes visible after being hidden, catch up on
    // any view changes that happened while hidden.
    this.primary.on('change:visible', () => {
      if (this.primary.getVisible()) this._prefetchAroundCurrent();
    });

    this._primaryParamsSnap = this._snapPrimary();
    this._watchPrimarySource();
    this.primary.on('change:source', () => this._watchPrimarySource());
  }

  _snapPrimary() {
    const p = this.primary.getSource();
    const pp = p.getParams();
    return {
      url: p.getUrl(),
      layers: pp.LAYERS,
      styles: pp.STYLES,
      format: pp.FORMAT,
      elevation: pp.ELEVATION,
    };
  }

  _watchPrimarySource() {
    const p = this.primary.getSource();
    if (this._psListener) this._psListener.target.un('change', this._psListener.fn);
    const fn = () => {
      const snap = this._snapPrimary();
      const prev = this._primaryParamsSnap;
      if (
        snap.url !== prev.url
        || snap.layers !== prev.layers
        || snap.styles !== prev.styles
        || snap.format !== prev.format
        || snap.elevation !== prev.elevation
      ) {
        this._primaryParamsSnap = snap;
        this._resyncAllParams(prev, snap);
      }
    };
    p.on('change', fn);
    this._psListener = { target: p, fn };
  }

  _resyncAllParams(prev, now) {
    const p = this.primary.getSource();
    const pParams = pickSyncParams(p.getParams());
    for (const slot of this.slots) {
      // primary's current source is already up-to-date; skip
      if (slot.source !== p) {
        if (slot.source.getUrl() !== p.getUrl()) slot.source.setUrl(p.getUrl());
        const merged = { ...pParams };
        if (slot.time) merged.TIME = slot.time;
        slot.source.updateParams(merged);
      }
      // Product/style/URL changed — any stale sticky is now for a
      // different layer and would bleed through on the next pan/zoom.
      slot.source.invalidateSticky();
    }
    // Flow is STYLES- and FORMAT-invariant: a colormap swap doesn't
    // change the underlying motion field, so the interpolator can
    // keep its flow cache and reuse it with the re-styled bitmaps
    // once they land. URL / LAYERS / ELEVATION changes cross physical
    // fields and must drop the cache.
    if (this.interpolator && prev && now) {
      const flowInvariant = (
        prev.url === now.url
        && prev.layers === now.layers
        && prev.elevation === now.elevation
      );
      this.interpolator.onParamsChanged({ flowInvariant });
    }
    this._prefetchAroundCurrent();
  }

  _getViewContext() {
    const view = this.map.getView();
    const size = this.map.getSize();
    if (!size) return null;
    return {
      extent: view.calculateExtent(size),
      resolution: view.getResolution(),
      projection: view.getProjection(),
    };
  }

  _slotAtIndex(idx) {
    if (!this.windowTimes) return null;
    const time = this.windowTimes[idx];
    if (!time) return null;
    return this.slots.find((s) => s.time === time) || null;
  }

  // Prefetch the initial ring: current, +1, +2 (wrapping). Animation
  // plays forward the vast majority of the time, so we bias the
  // initial fetch toward upcoming frames instead of the symmetric
  // previous+next ring.
  _prefetchAroundCurrent() {
    if (!this.primary.getVisible()) return;
    if (!this.currentTime || !this.windowTimes) return;
    const curIdx = this.windowTimes.indexOf(this.currentTime);
    if (curIdx < 0) return;
    const ctx = this._getViewContext();
    if (!ctx) return;
    for (let offset = 0; offset < 3; offset++) {
      const idx = (curIdx + offset) % this.size;
      const slot = this._slotAtIndex(idx);
      if (slot && slot.time) {
        slot.source.triggerLoad(ctx.extent, ctx.resolution, 1, ctx.projection);
      }
    }
  }

  // Extend the prefetch frontier forward. Called from imageloadend so
  // that each completion pulls in the next couple of upcoming frames —
  // scanning forward from current, wrapping at the end of the window.
  // Backward frames are only re-fetched once the forward sweep wraps
  // around, which matches typical playback behavior (rarely reverse).
  _advanceFrontier() {
    if (!this.primary.getVisible()) return;
    if (!this.currentTime || !this.windowTimes) return;
    const curIdx = this.windowTimes.indexOf(this.currentTime);
    if (curIdx < 0) return;
    const ctx = this._getViewContext();
    if (!ctx) return;
    let triggered = 0;
    for (let offset = 0; offset < this.size && triggered < 2; offset++) {
      const idx = (curIdx + offset) % this.size;
      const slot = this._slotAtIndex(idx);
      if (slot && slot.time && !slot.loaded) {
        slot.source.triggerLoad(ctx.extent, ctx.resolution, 1, ctx.projection);
        triggered++;
      }
    }
  }

  _notifyLoadChange(slot) {
    if (!this.onLoadStateChange || !this.windowTimes) return;
    const idx = this.windowTimes.indexOf(slot.time);
    if (idx >= 0) this.onLoadStateChange(idx, slot.loaded);
  }

  // Accept a list of `size` ISO timestamps. Preserve slots whose TIME is
  // still in the new window; reassign slots whose TIME dropped out to
  // the new TIMEs that aren't already covered. Only changed slots refetch.
  setWindow(times) {
    if (times.length !== this.size) {
      throw new Error(`FramePool.setWindow: expected ${this.size} times, got ${times.length}`);
    }
    this.windowTimes = times.slice();
    const desired = new Set(times);
    const assigned = new Set();
    const needAssign = [];

    for (const slot of this.slots) {
      if (slot.time && desired.has(slot.time) && !assigned.has(slot.time)) {
        assigned.add(slot.time);
      } else {
        needAssign.push(slot);
      }
    }

    const unassigned = times.filter((t) => !assigned.has(t));
    for (let j = 0; j < needAssign.length; j++) {
      const slot = needAssign[j];
      const newTime = unassigned[j];
      if (!newTime) break;
      // Capture old time BEFORE overwriting so the interpolator can
      // drop flow pairs referencing the dropped TIME. Doing this
      // after `slot.time = newTime` would lose the identity we need.
      const oldTime = slot.time;
      slot.time = newTime;
      slot.loaded = false;
      slot.source.updateParams({
        ...pickSyncParams(this.primary.getSource().getParams()),
        TIME: newTime,
      });
      // Slot now represents a different TIME; the previous sticky is
      // for the old TIME and would render the wrong frame until the
      // new TIME's image lands.
      slot.source.invalidateSticky();
      if (this.interpolator && oldTime) {
        this.interpolator.invalidateSlot(oldTime);
      }
    }
    // Prefetch is driven by showTime / moveend (current ± neighbors),
    // not from setWindow. Reassigned slots outside the current ± 1
    // window will load lazily when the cursor reaches them.

    // Resync load state per position. After a window slide the
    // positions in windowTimes shift, so per-slot notifications alone
    // can leave poolLoadStates positions carrying stale values from
    // the previous window.
    if (this.onLoadStateChange) {
      for (let i = 0; i < this.size; i++) {
        this.onLoadStateChange(i, this.isPositionLoaded(i));
      }
    }
  }

  // Point the primary at the slot matching `time`. The swap is
  // unconditional — StickyImageWMS renders the slot's previous LOADED
  // image while a new one is in flight, so the animation keeps ticking
  // through frames during pan/zoom instead of stalling on whichever
  // slot last finished.
  showTime(time) {
    const slot = this.slots.find((s) => s.time === time);
    if (!slot) return false;
    this.currentTime = time;
    if (this.primary.getSource() !== slot.source) {
      this.primary.setSource(slot.source);
    }
    this._prefetchAroundCurrent();
    return true;
  }

  // Attach an interpolator and build the warp layer. Warp overlays
  // the primary. Visibility mirrors primary's so the user's
  // layer-toggle button keeps working against the primary. Opacity
  // is handled as a clean swap: while warp is rendering content,
  // primary's opacity drops to 0; when warp has nothing to show,
  // primary is restored to the user's chosen opacity. This avoids
  // both the button-revert bug from the earlier visibility-swap
  // attempt and the double-exposure artifact of naive overlay.
  setInterpolator(interpolator) {
    if (this.interpolator === interpolator) return;
    this._teardownWarpLayer();
    this.interpolator = interpolator;
    if (!interpolator) return;

    this._userOpacity = this.primary.getOpacity();
    this._settingOpacityInternally = false;

    // 1×1 transparent canvas we return from canvasFunction when the
    // warp has nothing to show. Returning null from canvasFunction
    // causes ol/source/ImageCanvas to keep its last cached canvas
    // visible — which means old warp content stays displayed after
    // stop + step. Returning a new empty canvas forces the layer to
    // display a transparent pixel instead, so primary shows through.
    this._emptyCanvas = document.createElement('canvas');
    this._emptyCanvas.width = 1;
    this._emptyCanvas.height = 1;

    // canvasFunction is given the size OL wants rendered, in device
    // pixels. That's usually viewSize × ratio × devicePixelRatio —
    // larger than A's native bitmap on retina because the slot's
    // StickyImageWMS uses hidpi:false. Render at that size so the
    // canvas covers the requested extent; the shader upscales from
    // A's bitmap with bilinear filtering.
    const canvasFunction = (extent, resolution, pixelRatio, size) => {
      if (!this.interpActive) return this._emptyCanvas;
      const { timeA, timeB, t } = this._warpState;
      if (!timeA || !timeB) return this._emptyCanvas;
      if (!interpolator.hasFlow(timeA, timeB)) return this._emptyCanvas;
      return interpolator.renderAt(timeA, timeB, t, size[0], size[1]);
    };

    this.warpLayer = new ImageLayer({
      name: `${this.primary.get('name')}__warp`,
      visible: this.primary.getVisible(),
      opacity: this._userOpacity,
      // Match the primary's WMS ratio (1.5 by default in radar.js)
      // so OL asks canvasFunction for the same extent-and-size the
      // primary's slot images were fetched at.
      source: new ImageCanvasSource({ canvasFunction, ratio: this.ratio }),
    });

    this._primaryVisListener = () => {
      this.warpLayer.setVisible(this.primary.getVisible());
    };
    // Opacity listener is guarded so our own transparent/restore
    // writes don't get captured as "the user's chosen opacity".
    this._primaryOpacityListener = () => {
      if (this._settingOpacityInternally) return;
      this._userOpacity = this.primary.getOpacity();
      this.warpLayer.setOpacity(this._userOpacity);
    };
    this.primary.on('change:visible', this._primaryVisListener);
    this.primary.on('change:opacity', this._primaryOpacityListener);
    this.map.addLayer(this.warpLayer);

    // Retroactively upload already-loaded slot bitmaps so hasFlow
    // returns true on the first showInterpolated call after a delayed
    // attach (canInterpolate is async; some slots may already be
    // loaded by the time we get here).
    for (const slot of this.slots) {
      if (!slot.loaded || !slot.time) continue; // eslint-disable-line no-continue
      const wrapper = slot.source._sticky;
      if (!wrapper) continue; // eslint-disable-line no-continue
      const img = wrapper.getImage();
      if (img && img.complete && img.naturalWidth) {
        interpolator.onSlotLoaded(slot, img);
      }
    }
  }

  _teardownWarpLayer() {
    if (!this.warpLayer) return;
    // If we'd zeroed primary's opacity for warp display, restore it
    // before dropping the warp layer so the user isn't left with an
    // invisible radar.
    if (this._userOpacity !== undefined
        && this.primary.getOpacity() === 0) {
      this._settingOpacityInternally = true;
      this.primary.setOpacity(this._userOpacity);
      this._settingOpacityInternally = false;
    }
    if (this._primaryVisListener) {
      this.primary.un('change:visible', this._primaryVisListener);
      this._primaryVisListener = null;
    }
    if (this._primaryOpacityListener) {
      this.primary.un('change:opacity', this._primaryOpacityListener);
      this._primaryOpacityListener = null;
    }
    this.map.removeLayer(this.warpLayer);
    this.warpLayer = null;
  }

  // Toggle interpolated display on/off. radar.js calls this from
  // play() / stop(). On stop, restore primary's opacity so the user
  // sees the discrete frame at their chosen opacity again.
  setInterpActive(active) {
    if (this.interpActive === active) return;
    this.interpActive = active;
    if (!active) this._setPrimaryTransparent(false);
    if (this.warpLayer) this.warpLayer.getSource().changed();
  }

  // Render the warp at fractional t between current frame (A) and
  // the next in windowTimes (B). Toggles primary's opacity: zeroed
  // while warp has real content (so the user sees only the
  // interpolated frame), restored to _userOpacity otherwise.
  showInterpolated(t) {
    if (!this.interpolator || !this.interpActive) return;
    if (!this.windowTimes || !this.currentTime) return;
    if (!this.warpLayer) return;
    const curIdx = this.windowTimes.indexOf(this.currentTime);
    if (curIdx < 0) return;
    const nextIdx = (curIdx + 1) % this.size;
    const timeB = this.windowTimes[nextIdx];
    if (!timeB) return;

    const hasFlow = this.interpolator.hasFlow(this.currentTime, timeB);
    this._setPrimaryTransparent(hasFlow);
    if (!hasFlow) return;

    this._warpState.timeA = this.currentTime;
    this._warpState.timeB = timeB;
    this._warpState.t = t;

    this.warpLayer.getSource().changed();
  }

  // Flip primary's opacity between 0 (warp is rendering content) and
  // the user's chosen opacity. Guarded so our own writes don't get
  // captured by the change:opacity listener as a new "user opacity".
  _setPrimaryTransparent(transparent) {
    if (!this.warpLayer) return;
    const desired = transparent ? 0 : this._userOpacity;
    if (this.primary.getOpacity() === desired) return;
    this._settingOpacityInternally = true;
    this.primary.setOpacity(desired);
    this._settingOpacityInternally = false;
  }

  // Is this time's slot's current-view image loaded?
  isTimeLoaded(time) {
    const slot = this.slots.find((s) => s.time === time);
    return !!(slot && slot.loaded);
  }

  // Load state at timeline position (0..size-1).
  isPositionLoaded(index) {
    if (!this.windowTimes) return false;
    return this.isTimeLoaded(this.windowTimes[index]);
  }
}
