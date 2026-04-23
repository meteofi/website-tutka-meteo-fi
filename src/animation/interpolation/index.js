// Client-side pyramidal Lucas-Kanade optical flow + motion-compensated
// warp for radar animation interpolation.
//
// Phase 2 state: frame upload, canvas output, OpenLayers integration,
// and the warp shader all work. Flow fields are zeroed RG16F textures
// (no LK yet), so the visual effect is a straight crossfade — but the
// whole GPU pipeline is exercised so Phase 3 only needs to swap in
// real flow compute.
//
// Instance ownership: one RadarInterpolator per interpolating pool
// (radar, satellite). Each owns its own WebGL2 context on an offscreen
// canvas; that canvas is what the pool's warp layer displays via an
// ol/source/ImageCanvas. Sharing a single GL context across pools is a
// Phase 4 optimization — per-pool GL is simpler and, with only two
// interpolating pools, the memory cost is tolerable.

import canInterpolate from './capabilities';
import WarpRenderer from './warp';
import { createRgbaTexture, createRg16fTexture } from './glUtils';

export { canInterpolate };

export class RadarInterpolator {
  constructor({ flowResolution = 256 } = {}) {
    this.flowResolution = flowResolution;

    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    // premultipliedAlpha:false — our warp shader outputs straight
    // (non-premultiplied) RGBA by taking mix() of two non-premultiplied
    // texture samples. With premultipliedAlpha:true the browser would
    // re-multiply during compositing, darkening semi-transparent pixels
    // (coastlines, radar-range edges, nodata). preserveDrawingBuffer:true
    // keeps the buffer between our gl.clear calls — OL may read the
    // canvas slightly out of phase with our draws, and without this the
    // browser can wipe the buffer between draw and composite.
    this.gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!this.gl) {
      throw new Error('RadarInterpolator: WebGL2 unavailable');
    }
    // Enable either extension — canInterpolate already verified one
    // of them is available; we just need to activate it for the
    // RG16F flow texture to be renderable later.
    this.gl.getExtension('EXT_color_buffer_half_float');
    this.gl.getExtension('EXT_color_buffer_float');

    this.warp = new WarpRenderer(this.gl);

    // Keyed by time ISO string. Values: { texture, width, height }.
    this.frames = new Map();
    // Keyed by `${timeA}|${timeB}`. Values: { texture }.
    this.flows = new Map();
  }

  // Called from FramePool on imageloadend once a slot's bitmap is
  // usable. Uploads the image to a GL texture keyed by the slot's
  // TIME. If a previous texture existed for that TIME (e.g., after a
  // STYLES change invalidated it), it's replaced.
  onSlotLoaded(slot, image) {
    if (!slot || !slot.time || !image) return;
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (!w || !h) return;
    const existing = this.frames.get(slot.time);
    if (existing) this.gl.deleteTexture(existing.texture);
    const texture = createRgbaTexture(this.gl, w, h, image);
    this.frames.set(slot.time, { texture, width: w, height: h });
  }

  // Called from FramePool._resyncAllParams. If the change wasn't
  // flow-invariant (LAYERS / ELEVATION / URL moved), throw out the
  // flow cache — the underlying physical field has changed. Frame
  // textures are separately invalidated when the pool's slots
  // refetch; onSlotLoaded overwrites them when the new bitmaps land.
  onParamsChanged({ flowInvariant } = {}) {
    if (!flowInvariant) {
      for (const f of this.flows.values()) this.gl.deleteTexture(f.texture);
      this.flows.clear();
    }
    // Frame textures are always replaced on new bitmaps, so we don't
    // pre-emptively delete them here — doing so would leave a window
    // where hasFlow returned false but showTime was already showing
    // the new frame.
  }

  // Called from FramePool when a slot goes stale (pan/zoom invalidated
  // view coverage, or window slide dropped this TIME). Drop the frame
  // texture and any flow pairs referencing this time.
  invalidateSlot(time) {
    if (!time) return;
    const f = this.frames.get(time);
    if (f) {
      this.gl.deleteTexture(f.texture);
      this.frames.delete(time);
    }
    for (const [key, flow] of this.flows) {
      if (key.startsWith(`${time}|`) || key.endsWith(`|${time}`)) {
        this.gl.deleteTexture(flow.texture);
        this.flows.delete(key);
      }
    }
  }

  // Is there enough data to render (A, B, t)? In Phase 2, "flow
  // ready" really just means "both bitmaps uploaded" — the zero flow
  // texture is created on demand.
  hasFlow(timeA, timeB) {
    return this.frames.has(timeA) && this.frames.has(timeB);
  }

  // Draw the warped image for (A, B, t) into this.canvas. Returns
  // the canvas, or null if we don't have both frames yet. If the
  // caller passes targetW/H, the canvas is sized and the viewport
  // rendered at that resolution; otherwise A's native bitmap size
  // is used. Callers that go through ol/source/ImageCanvas pass
  // the pixelRatio-adjusted size OL requested, which matters on
  // retina (source images are fetched with hidpi:false, so A's
  // native size is half of what OL wants on 2× displays).
  renderAt(timeA, timeB, t, targetW = 0, targetH = 0) {
    const a = this.frames.get(timeA);
    const b = this.frames.get(timeB);
    if (!a || !b) return null;

    // A and B can disagree on pixel dimensions if the user panned
    // between their loads. The shader samples both via UV so
    // dimensions only matter for output. Phase 3 will resample A
    // and B onto a shared analysis grid before LK runs.
    const w = targetW || a.width;
    const h = targetH || a.height;

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    const flowTex = this._getOrCreateFlow(timeA, timeB);

    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.warp.render(a.texture, b.texture, flowTex, t, w, h);

    return this.canvas;
  }

  _getOrCreateFlow(timeA, timeB) {
    const key = `${timeA}|${timeB}`;
    let flow = this.flows.get(key);
    if (!flow) {
      // Phase 2: zero-filled flow. Phase 3 will populate this via
      // pyramidal LK before any render call that needs it.
      const r = this.flowResolution;
      const texture = createRg16fTexture(this.gl, r, r, null);
      flow = { texture };
      this.flows.set(key, flow);
    }
    return flow.texture;
  }

  dispose() {
    for (const f of this.frames.values()) this.gl.deleteTexture(f.texture);
    for (const f of this.flows.values()) this.gl.deleteTexture(f.texture);
    this.frames.clear();
    this.flows.clear();
    this.warp.dispose();
  }
}
