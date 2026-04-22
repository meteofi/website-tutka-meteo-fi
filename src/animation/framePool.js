import ImageLayer from 'ol/layer/Image';
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
    primaryLayer, map, size = 13, ratio = 1.5,
  }) {
    this.primary = primaryLayer;
    this.map = map;
    this.size = size;
    this.slots = [];
    this.ratio = ratio;

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
        // Sticky override masks OL's IDLE tracking so the renderer
        // never learns the new image landed — schedule a render pass.
        this.map.render();
      });
      source.on('imageloaderror', (event) => {
        if (event.image !== slot.source.image) return;
        slot.loaded = false;
        this._notifyLoadChange(slot);
      });
      this.slots.push(slot);
      map.addLayer(layer);
    }

    map.on('moveend', () => this._triggerLoadAll());

    // When the layer becomes visible after being hidden, catch up on
    // any view changes that happened while hidden.
    this.primary.on('change:visible', () => {
      if (this.primary.getVisible()) this._triggerLoadAll();
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
        this._resyncAllParams();
      }
    };
    p.on('change', fn);
    this._psListener = { target: p, fn };
  }

  _resyncAllParams() {
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
    this._triggerLoadAll();
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

  // Slots ordered by fetch priority: current time first, then forward
  // (future) frames, then backward (past) frames. Browsers cap HTTP/1.1
  // concurrency at 6/host, so the firing order determines which frames
  // end up in the first batch on the wire.
  _slotsByPriority() {
    if (!this.currentTime || !this.windowTimes) return this.slots.slice();
    const curIdx = this.windowTimes.indexOf(this.currentTime);
    if (curIdx < 0) return this.slots.slice();
    const byTime = new Map();
    for (const slot of this.slots) {
      if (slot.time) byTime.set(slot.time, slot);
    }
    const ordered = [];
    const add = (pos) => {
      const t = this.windowTimes[pos];
      const s = t ? byTime.get(t) : null;
      if (s) ordered.push(s);
    };
    add(curIdx);
    for (let i = curIdx + 1; i < this.size; i++) add(i);
    for (let i = curIdx - 1; i >= 0; i--) add(i);
    return ordered;
  }

  _triggerLoadAll() {
    if (!this.primary.getVisible()) return;
    const ctx = this._getViewContext();
    if (!ctx) return;
    for (const slot of this._slotsByPriority()) {
      if (slot.time) {
        slot.source.triggerLoad(ctx.extent, ctx.resolution, 1, ctx.projection);
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
    const reassigned = new Set();
    for (let j = 0; j < needAssign.length; j++) {
      const slot = needAssign[j];
      const newTime = unassigned[j];
      if (!newTime) break;
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
      reassigned.add(slot);
    }

    // Fire loads for reassigned slots in priority order (current-TIME
    // first, then forward, then backward). Unchanged slots already have
    // their image cached — no load needed — and triggering on them
    // during an animation tick mid-drag would request the mid-drag
    // extent.
    const ctx = this._getViewContext();
    if (ctx && reassigned.size > 0) {
      for (const slot of this._slotsByPriority()) {
        if (reassigned.has(slot)) {
          slot.source.triggerLoad(ctx.extent, ctx.resolution, 1, ctx.projection);
        }
      }
    }

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
    return true;
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
