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
import FlowLK from './flowLK';
import { createRgbaTexture, createRg16fTexture } from './glUtils';

export { canInterpolate };

// Approximate equality for two extents that are supposed to be bit-
// identical (A and B fetched at the same view+resolution). The only
// reason for a tolerance at all is floating-point rounding in the
// OL extent math. 1e-6 of the extent size is well below any view
// displacement we could see and still well above float noise.
// Previously this was 0.5%, which at Finland scale is ~10 km — that
// let systematically-mismatched pairs through and LK's flow came
// out with a constant bias riding on top of real motion.
function extentApproxEqual(a, b) {
  if (!a || !b) return false;
  const w = Math.abs(a[2] - a[0]);
  const h = Math.abs(a[3] - a[1]);
  const tolW = Math.max(w * 1e-6, 1e-3);
  const tolH = Math.max(h * 1e-6, 1e-3);
  return Math.abs(a[0] - b[0]) <= tolW
    && Math.abs(a[2] - b[2]) <= tolW
    && Math.abs(a[1] - b[1]) <= tolH
    && Math.abs(a[3] - b[3]) <= tolH;
}

// Does `stored` fully contain `other`? StickyImageWMS fetches each
// frame with a 1.5× buffer around the view, so small pans stay
// inside the buffer and the stored extent still covers the new view.
// When it does, we can keep using the frames with a UV offset in the
// warp shader to line content up at the correct world position.
function extentContains(stored, other) {
  if (!stored || !other) return false;
  const w = Math.abs(stored[2] - stored[0]);
  const h = Math.abs(stored[3] - stored[1]);
  const tol = Math.max(w, h) * 1e-4;
  return stored[0] <= other[0] + tol
    && stored[1] <= other[1] + tol
    && stored[2] >= other[2] - tol
    && stored[3] >= other[3] - tol;
}

export class RadarInterpolator {
  constructor({ flowResolution = 256, useFlow = false } = {}) {
    this.flowResolution = flowResolution;
    // When true, flows are computed via Lucas-Kanade; when false,
    // flows are zero-filled (interpolation degenerates to crossfade).
    // Swapped at runtime via setUseFlow.
    this.useFlow = useFlow;

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
    // Linear filtering of half-float textures needs a separate
    // extension. Without it, sampling RG16F with LINEAR returns
    // either NEAREST (blocky) or black/NaN on various drivers
    // (Android Mali, some iOS Safari versions). If the extension is
    // unavailable, fall back to NEAREST sampling on flow textures —
    // warp gets a blockier motion field but stays correct.
    this.flowFilter = this.gl.getExtension('OES_texture_half_float_linear')
      ? this.gl.LINEAR
      : this.gl.NEAREST;

    this.warp = new WarpRenderer(this.gl);
    this.flowLK = new FlowLK(this.gl, flowResolution);

    // Keyed by time ISO string. Values: { texture, width, height, extent }.
    this.frames = new Map();
    // Keyed by `${timeA}|${timeB}`. Values: { texture }. Populated
    // lazily by computeFlow; hasFlow returns false for pairs not yet
    // populated, so the caller sees "not ready" until the flow (zero
    // or LK, depending on useFlow) has actually been created.
    this.flows = new Map();

    // iOS Safari can evict WebGL2 contexts when the tab goes
    // background or under memory pressure. When it happens all GPU
    // handles we're holding are invalid — we can't even dispose
    // them cleanly — and any subsequent draw silently fails. Mark
    // ourselves unusable on loss; hasFlow returns false afterwards
    // so the pool keeps the primary layer visible and the warp
    // stays blank. preventDefault allows the restore event, but we
    // don't attempt a live rebuild — the cheapest path back is for
    // the user to toggle interp off and on via the menu, which
    // constructs a fresh interpolator.
    this.contextLost = false;
    this._onContextLost = (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.frames.clear();
      this.flows.clear();
    };
    this.canvas.addEventListener('webglcontextlost', this._onContextLost);
  }

  // Flip between zero-flow (crossfade) and LK flow. Clears any
  // computed flows; callers should refresh them for currently-loaded
  // pairs so the next render has the new flow type ready.
  setUseFlow(useFlow) {
    if (this.useFlow === useFlow) return;
    this.useFlow = useFlow;
    for (const f of this.flows.values()) this.gl.deleteTexture(f.texture);
    this.flows.clear();
  }

  // Called from FramePool on imageloadend once a slot's bitmap is
  // usable. Uploads the image to a GL texture keyed by the slot's
  // TIME. The caller-provided `extent` is stored so hasFlow can
  // later detect a stale pair whose content is for a different view
  // (happens during zoom/pan before the new bitmaps land — without
  // this the warp draws old-extent pixels at the new extent).
  onSlotLoaded(slot, image, extent) {
    if (this.contextLost) return;
    if (!slot || !slot.time || !image) return;
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (!w || !h) return;
    const existing = this.frames.get(slot.time);
    if (existing) this.gl.deleteTexture(existing.texture);
    const texture = createRgbaTexture(this.gl, w, h, image);
    this.frames.set(slot.time, {
      texture, width: w, height: h, extent: extent ? extent.slice() : null,
    });
    // The new bitmap invalidates any flow pairs that referenced the
    // previous bitmap for this time — drop them so the next
    // computeFlow call produces fresh flow from the new texture.
    for (const [key, flow] of this.flows) {
      if (key.startsWith(`${slot.time}|`) || key.endsWith(`|${slot.time}`)) {
        this.gl.deleteTexture(flow.texture);
        this.flows.delete(key);
      }
    }
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

  // Is there enough data to render (A, B, t) covering the given
  // view extent? Requires:
  //   - both frame textures uploaded,
  //   - a flow texture computed for the pair (via computeFlow),
  //   - A and B fetched at approximately the same stored extent so
  //     they share a UV coordinate system for the flow,
  //   - the stored extent fully contains the current view so the
  //     warp shader's UV-transformed sampling has data to fetch.
  // When the view has only shifted within the stored buffer, this
  // returns true and renderAt builds a UV offset to place content
  // at the correct world position in the output canvas.
  hasFlow(timeA, timeB, extent = null) {
    if (this.contextLost) return false;
    const a = this.frames.get(timeA);
    const b = this.frames.get(timeB);
    if (!a || !b) return false;
    if (!this.flows.has(`${timeA}|${timeB}`)) return false;
    if (!extent) return true;
    if (!extentApproxEqual(a.extent, b.extent)) return false;
    return extentContains(a.extent, extent);
  }

  // Produce the flow texture for (A, B) — LK-computed if useFlow is
  // true, zero-filled otherwise. Framepool calls this from
  // imageloadend when both frames of a pair become available. No-op
  // if the pair already has a flow (the frames themselves are
  // replaced in onSlotLoaded; a new compute is triggered then by
  // having that call invalidate the flow first).
  computeFlow(timeA, timeB) {
    if (this.contextLost) return;
    const key = `${timeA}|${timeB}`;
    if (this.flows.has(key)) return;
    const a = this.frames.get(timeA);
    const b = this.frames.get(timeB);
    if (!a || !b) return;
    // A and B must share a stored extent for LK's result to be
    // meaningful — sampling at a common UV would otherwise hit
    // different world coordinates. Skipping here avoids burning GPU
    // cycles on garbage flow during rapid pan/zoom when slots load
    // at different extents; hasFlow's extent check would reject
    // this pair at display time anyway.
    if (this.useFlow && !extentApproxEqual(a.extent, b.extent)) return;
    let texture;
    if (this.useFlow) {
      texture = this.flowLK.compute(a.texture, b.texture, this.flowFilter);
    } else {
      texture = createRg16fTexture(this.gl, this.flowResolution, this.flowResolution, null, this.flowFilter);
    }
    this.flows.set(key, { texture });
  }

  // Draw the warped image for (A, B, t) into this.canvas. Returns
  // the canvas, or null if we don't have both frames yet. If the
  // caller passes targetW/H, the canvas is sized and the viewport
  // rendered at that resolution; otherwise A's native bitmap size
  // is used. Callers that go through ol/source/ImageCanvas pass
  // the pixelRatio-adjusted size OL requested, which matters on
  // retina (source images are fetched with hidpi:false, so A's
  // native size is half of what OL wants on 2× displays).
  renderAt(timeA, timeB, t, targetW = 0, targetH = 0, canvasExtent = null) {
    if (this.contextLost) return null;
    const a = this.frames.get(timeA);
    const b = this.frames.get(timeB);
    const flow = this.flows.get(`${timeA}|${timeB}`);
    if (!a || !b || !flow) return null;

    // A and B can disagree on pixel dimensions if the user panned
    // between their loads. The shader samples both via UV so
    // dimensions only matter for output.
    const w = targetW || a.width;
    const h = targetH || a.height;

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }

    // Compute the UV transform from output canvas → stored frame UV
    // so the shader draws content at the correct world position when
    // the canvas extent differs from the stored extent (small pan
    // within the 1.5× fetch buffer). Identity when extents match.
    let scaleX = 1;
    let scaleY = 1;
    let offsetX = 0;
    let offsetY = 0;
    if (canvasExtent && a.extent) {
      const se = a.extent;
      const seW = se[2] - se[0];
      const seH = se[3] - se[1];
      if (seW && seH) {
        const ceW = canvasExtent[2] - canvasExtent[0];
        const ceH = canvasExtent[3] - canvasExtent[1];
        scaleX = ceW / seW;
        scaleY = ceH / seH;
        offsetX = (canvasExtent[0] - se[0]) / seW;
        offsetY = (canvasExtent[1] - se[1]) / seH;
      }
    }

    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.warp.render(
      a.texture,
      b.texture,
      flow.texture,
      t,
      w,
      h,
      scaleX,
      scaleY,
      offsetX,
      offsetY,
    );
    // Flush pending draw commands so the compositor reads fully-
    // drawn pixels when it pulls the canvas — iOS Safari otherwise
    // occasionally presents a half-drawn buffer during fast playback.
    gl.flush();

    return this.canvas;
  }

  dispose() {
    if (this._onContextLost) {
      this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
      this._onContextLost = null;
    }
    // If the context is already lost, deleteTexture calls are no-ops
    // — safe to run either way.
    for (const f of this.frames.values()) this.gl.deleteTexture(f.texture);
    for (const f of this.flows.values()) this.gl.deleteTexture(f.texture);
    this.frames.clear();
    this.flows.clear();
    this.warp.dispose();
    this.flowLK.dispose();
  }
}
