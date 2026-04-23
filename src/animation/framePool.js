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

// Given a padded canvas extent and the padding ratio (e.g., 1.5),
// return the inner 1× view extent (canvas minus buffer) with the
// same center.
function deriveViewExtent(paddedExtent, ratio) {
  if (!paddedExtent || !ratio) return paddedExtent;
  const cx = (paddedExtent[0] + paddedExtent[2]) / 2;
  const cy = (paddedExtent[1] + paddedExtent[3]) / 2;
  const hw = ((paddedExtent[2] - paddedExtent[0]) * 0.5) / ratio;
  const hh = ((paddedExtent[3] - paddedExtent[1]) * 0.5) / ratio;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
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
    // Per-index callback fired when the pair starting at that index
    // may have changed flow-ready status — both endpoints loaded
    // AND the interpolator has a flow pair for (windowTimes[i],
    // windowTimes[i+1]). Radar.js uses it to paint a "loaded but
    // no-flow" indicator on the timeline.
    this.onFlowStateChange = null;
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
        // a GL texture keyed by the slot's TIME. Pass the extent the
        // image was loaded at too, so hasFlow can detect when the
        // view has since moved to a different extent (zoom/pan
        // pending refetch).
        if (this.interpolator) {
          this.interpolator.onSlotLoaded(slot, event.image.getImage(), event.image.getExtent());
          // Compute flow for pairs neighbouring this time that now
          // have both endpoints loaded. The interpolator decides
          // whether to run LK or zero-fill based on its useFlow flag.
          this._checkFlowCompute(slot.time);
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
        // First, drop each source's cached ImageWMS wrapper. OL's own
        // render pipeline calls getImage on the primary layer's source
        // during a pan, and the cache locks in a wrapper whose extent
        // reflects the intermediate view. Without this reset, loads
        // completing on those wrappers would store mid-pan extents
        // that fail extentApproxEqual against neighbouring slots
        // (which didn't get render-hit during the pan), and the
        // interpolator would skip computeFlow for any pair involving
        // the current slot — visible as two permanently-green cells
        // on the timeline.
        for (const slot of this.slots) {
          slot.source.resetImageCache();
        }
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
      this._notifyAllFlowState();
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
      this._notifyAllFlowState();
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
    this._notifyAllFlowState();
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
    // Release the old interpolator's GPU resources before dropping
    // the reference, otherwise textures / programs / FBOs leak.
    if (this.interpolator && this.interpolator !== interpolator) {
      this.interpolator.dispose();
    }
    this.interpolator = interpolator;
    if (!interpolator) return;

    this._userOpacity = this.primary.getOpacity();
    this._settingOpacityInternally = false;
    // Publish _userOpacity as a custom property on the primary layer
    // so the playlist UI can show the user's chosen opacity even
    // when our transparent swap has the actual layer.opacity at 0.
    // Silent set — no propertychange event fires.
    this.primary.set('_userOpacity', this._userOpacity, true);

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
      // Derive the 1× view extent from OL's requested 1.5× canvas
      // extent. hasFlow checks whether the stored frames cover the
      // 1× view (not the 1.5× buffer area) so small pans within the
      // buffer keep flow active.
      const viewExtent = deriveViewExtent(extent, this.ratio);
      if (!interpolator.hasFlow(timeA, timeB, viewExtent)) return this._emptyCanvas;
      // Pass the canvas extent so renderAt can compute the UV
      // transform that places content at the correct world position.
      return interpolator.renderAt(timeA, timeB, t, size[0], size[1], extent);
    };

    this.warpLayer = new ImageLayer({
      name: `${this.primary.get('name')}__warp`,
      // Hidden until interp becomes active — OL skips the layer
      // entirely (no canvasFunction calls, no compositor work) while
      // playback is paused, which lets the GPU process actually idle.
      visible: false,
      opacity: this._userOpacity,
      // Match the primary's WMS ratio (1.5 by default in radar.js)
      // so OL asks canvasFunction for the same extent-and-size the
      // primary's slot images were fetched at.
      source: new ImageCanvasSource({ canvasFunction, ratio: this.ratio }),
    });

    this._primaryVisListener = () => {
      this.warpLayer.setVisible(this.interpActive && this.primary.getVisible());
    };
    // Opacity listener is guarded so our own transparent/restore
    // writes don't get captured as "the user's chosen opacity".
    this._primaryOpacityListener = () => {
      if (this._settingOpacityInternally) return;
      this._userOpacity = this.primary.getOpacity();
      this.primary.set('_userOpacity', this._userOpacity, true);
      this.warpLayer.setOpacity(this._userOpacity);
    };
    this.primary.on('change:visible', this._primaryVisListener);
    this.primary.on('change:opacity', this._primaryOpacityListener);
    // Insert the warp layer right after the primary so it takes
    // over the primary's z-slot. addLayer would append to the end,
    // which puts the warp above POIs, range rings and the
    // observation layer — wrong z-order. If the primary isn't in
    // the collection for some reason, fall back to appending.
    const mapLayers = this.map.getLayers();
    const primaryIdx = mapLayers.getArray().indexOf(this.primary);
    if (primaryIdx >= 0) {
      mapLayers.insertAt(primaryIdx + 1, this.warpLayer);
    } else {
      mapLayers.push(this.warpLayer);
    }

    // Retroactively upload already-loaded slot bitmaps so hasFlow
    // returns true on the first showInterpolated call after a delayed
    // attach (canInterpolate is async; some slots may already be
    // loaded by the time we get here). Pass extent along so hasFlow's
    // extent check isn't permanently stuck on a null stored extent.
    for (const slot of this.slots) {
      if (!slot.loaded || !slot.time) continue; // eslint-disable-line no-continue
      const wrapper = slot.source._sticky;
      if (!wrapper) continue; // eslint-disable-line no-continue
      const img = wrapper.getImage();
      if (img && img.complete && img.naturalWidth) {
        interpolator.onSlotLoaded(slot, img, wrapper.getExtent());
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
    // Clear the custom properties so the playlist falls back to
    // layer.opacity again (which is now the user's value), and so
    // any later _interpHiding check from a stale path sees a clean
    // state.
    this.primary.set('_userOpacity', undefined, true);
    this.primary.set('_interpHiding', undefined, true);
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
    this._emptyCanvas = null;
    this._userOpacity = undefined;
    // Interp is gone → no pair can be flow-ready. Refresh the
    // timeline so the indicator drops any pending highlights.
    this._notifyAllFlowState();
  }

  // Toggle interpolated display on/off. radar.js calls this from
  // play() / stop(). Show/hide the warp layer accordingly — while
  // hidden, OL skips it during render so the GPU process can idle.
  // On stop, also restore primary's opacity so the user sees the
  // discrete frame at their chosen opacity again.
  setInterpActive(active) {
    if (this.interpActive === active) return;
    this.interpActive = active;
    if (!active) this._setPrimaryTransparent(false);
    if (this.warpLayer) {
      this.warpLayer.setVisible(active && this.primary.getVisible());
      this.warpLayer.getSource().changed();
    }
  }

  // Render the warp at fractional t between current frame (A) and
  // the next in windowTimes (B). Toggles primary's opacity: zeroed
  // while warp has real content (so the user sees only the
  // interpolated frame), restored to _userOpacity otherwise.
  //
  // Loop end: the last window frame has no meaningful next frame
  // (wrapping back to the first would be a 60-minute temporal
  // discontinuity). Instead of falling through to primary on that
  // one tick — which caused a visible brightness pop because primary
  // renders sharper than warp — hold at t=1 on the previous pair.
  // Warp at t=1 equals B = current time, so the content matches the
  // adjacent warp frames and the whole loop stays on a consistent
  // rendering path.
  showInterpolated(t) {
    if (!this.interpolator || !this.interpActive) return;
    if (!this.windowTimes || !this.currentTime) return;
    if (!this.warpLayer) return;
    const curIdx = this.windowTimes.indexOf(this.currentTime);
    if (curIdx < 0) return;

    let timeA;
    let timeB;
    let effectiveT;
    if (curIdx < this.size - 1) {
      timeA = this.currentTime;
      timeB = this.windowTimes[curIdx + 1];
      effectiveT = t;
    } else if (curIdx > 0) {
      // Last frame: reuse the previous pair held at its end.
      timeA = this.windowTimes[curIdx - 1];
      timeB = this.currentTime;
      effectiveT = 1;
    } else {
      return;
    }
    if (!timeA || !timeB) return;

    // Pass the 1× view extent — hasFlow checks whether the stored
    // frames cover the visible area, not the 1.5× fetch buffer, so
    // a small pan still within the buffer keeps flow engaged. When
    // the view moves out of the buffer, hasFlow falls back to false
    // and primary's stale-while-loading sticky covers the gap.
    const viewExtent = this._viewExtent();
    const hasFlow = this.interpolator.hasFlow(timeA, timeB, viewExtent);
    this._setPrimaryTransparent(hasFlow);

    if (!hasFlow) {
      // Clear _warpState so canvasFunction's own hasFlow check sees
      // a null pair and returns _emptyCanvas. Without this the
      // closure in canvasFunction reads the PREVIOUS pair's
      // (timeA, timeB) — and if that pair still has valid flow +
      // extent for the current view, renderAt runs and the warp
      // keeps showing the previous pair's interpolation on top of
      // the primary layer. That's the "stuck frame plus next
      // frames visible" ghost: previous pair warp over current pair
      // primary, both at user opacity.
      this._warpState.timeA = null;
      this._warpState.timeB = null;
      this.warpLayer.getSource().changed();
      return;
    }

    this._warpState.timeA = timeA;
    this._warpState.timeB = timeB;
    this._warpState.t = effectiveT;

    this.warpLayer.getSource().changed();
  }

  // Called from imageloadend after a slot's bitmap is uploaded to
  // the interpolator. Triggers computeFlow for the (prev, this) and
  // (this, next) pairs when both endpoints are loaded. No-op if the
  // interpolator isn't attached or the time isn't in the current
  // window. Non-wrapping: the last window slot doesn't pair with
  // the first.
  _checkFlowCompute(time) {
    if (!this.interpolator || !this.windowTimes) return;
    const idx = this.windowTimes.indexOf(time);
    if (idx < 0) return;
    if (idx > 0) {
      const prevTime = this.windowTimes[idx - 1];
      if (this.isTimeLoaded(prevTime)) {
        this.interpolator.computeFlow(prevTime, time);
      }
    }
    if (idx < this.windowTimes.length - 1) {
      const nextTime = this.windowTimes[idx + 1];
      if (this.isTimeLoaded(nextTime)) {
        this.interpolator.computeFlow(time, nextTime);
      }
    }
    this._notifyAllFlowState();
  }

  // Re-compute flow for every pair in the current window whose
  // both endpoints are loaded. Called from radar.js after a mode
  // switch (crossfade ↔ flow) — the interpolator cleared its flow
  // cache, so without this the warp layer would stay blank until
  // the next frame arrived via prefetch.
  refreshFlows() {
    if (!this.interpolator || !this.windowTimes) return;
    for (let i = 0; i < this.windowTimes.length - 1; i++) {
      const tA = this.windowTimes[i];
      const tB = this.windowTimes[i + 1];
      if (this.isTimeLoaded(tA) && this.isTimeLoaded(tB)) {
        this.interpolator.computeFlow(tA, tB);
      }
    }
    this._notifyAllFlowState();
  }

  // Current map view extent in world coords (EPSG:3857 meters).
  // Returned as the 1× viewport area, not padded by this.ratio —
  // hasFlow checks whether the stored frame's extent (which does
  // include the 1.5× fetch buffer) contains this 1× view.
  _viewExtent() {
    const size = this.map.getSize();
    if (!size) return null;
    return this.map.getView().calculateExtent(size);
  }

  // Flip primary's opacity between 0 (warp is rendering content) and
  // the user's chosen opacity. Guarded on two fronts:
  //   - our change:opacity listener filters on _settingOpacityInternally
  //     so it doesn't capture our writes as a new "user opacity".
  //   - we mark the layer with `_interpHiding` before the opacity write
  //     so radar.js's layerInfoPlaylist can skip the slider-UI update —
  //     otherwise the slider would jump to 0 (and the user's drag
  //     would get overridden back to 0 on the next RAF).
  _setPrimaryTransparent(transparent) {
    if (!this.warpLayer) return;
    // Write _interpHiding BEFORE the opacity-equal early return.
    // If opacity already matches the desired value but _interpHiding
    // still holds a stale truthy value from an earlier transparent
    // swap, the playlist's change:opacity filter will keep rejecting
    // the user's slider drags.
    this.primary.set('_interpHiding', transparent, true);
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

  // Does the pair starting at `index` in the current window have a
  // flow computed? Used by the timeline UI to mark cells that are
  // loaded but will still "jump" during playback because the warp
  // has no interpolation to render.
  isPairFlowReady(index) {
    if (!this.interpolator || !this.windowTimes) return false;
    if (index < 0 || index >= this.windowTimes.length - 1) return false;
    const tA = this.windowTimes[index];
    const tB = this.windowTimes[index + 1];
    if (!tA || !tB) return false;
    return this.interpolator.hasFlow(tA, tB);
  }

  _notifyAllFlowState() {
    if (!this.onFlowStateChange || !this.windowTimes) return;
    for (let i = 0; i < this.size; i++) {
      this.onFlowStateChange(i, this.isPairFlowReady(i));
    }
  }

  // Load state at timeline position (0..size-1).
  isPositionLoaded(index) {
    if (!this.windowTimes) return false;
    return this.isTimeLoaded(this.windowTimes[index]);
  }
}
