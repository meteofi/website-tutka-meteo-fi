// Public API for optical-flow interpolation. Phase 1 skeleton: the
// class compiles, plugs into the call sites FramePool will use in
// later phases, and never actually warps a pixel. Every method is a
// no-op or returns a sentinel that makes the caller fall back to
// discrete frame display.
//
// Phase 2 will add the warp renderer (with zero flow, visually a
// crossfade) to validate GL context plumbing and OL integration.
// Phase 3 adds pyramidal Lucas–Kanade flow computation. Phase 4
// handles nodata masking, webglcontextlost recovery, and memory
// budget enforcement.

import canInterpolate from './capabilities';

export { canInterpolate };

// Phase 1 skeleton methods don't read `this`. Later phases will hold GPU
// state (textures, programs, flow cache) and access it through `this`.
/* eslint-disable class-methods-use-this */
export class RadarInterpolator {
  constructor(opts = {}) {
    this.gl = opts.gl || null;
    this.flowResolution = opts.flowResolution || 256;
    this.pyramidLevels = opts.pyramidLevels || 3;
    this.iterations = opts.iterations || 5;
  }

  // Called from FramePool.imageloadend once a slot's bitmap finishes
  // loading. Phase 3 will upload to GPU and kick off flow computation
  // for any newly-completable pair.
  onSlotLoaded(/* slot, image */) {}

  // Called from FramePool._resyncAllParams after a WMS-param change.
  // `flowInvariant` is true when only STYLES / FORMAT changed — flow
  // can be kept and reused with the re-styled bitmaps once they land.
  // Phase 3 will conditionally clear the flow cache.
  onParamsChanged(/* { flowInvariant } */) {}

  // Called when a slot's view-cached image is no longer valid (pan /
  // zoom pushed the sticky out of the requested extent) OR when the
  // slot's TIME is reassigned during a window slide. Phase 3 will
  // drop any flow pair that references the invalidated time.
  invalidateSlot(/* time */) {}

  // Is there a usable flow field for (A, B)? Phase 1 always returns
  // false so FramePool.showInterpolated falls back to the discrete
  // display path.
  hasFlow(/* timeA, timeB */) { return false; }

  // Render the warped frame for (A, B, t). Phase 1 returns null.
  renderAt(/* timeA, timeB, t */) { return null; }
}
