// Motion-compensated interpolation. Radar uses a filtered image pyramid;
// satellite retains the single-level Lucas-Kanade estimator.
//
// Instance ownership: one RadarInterpolator per interpolating pool
// (radar, satellite). Each owns its own WebGL2 context on an offscreen
// canvas; that canvas is what the pool's warp layer displays via an
// ol/source/ImageCanvas. Sharing a single GL context across pools is a
// separate optimization. Full-resolution GPU copies are bounded per pool.

import canInterpolate from './capabilities';
import WarpRenderer from './warp';
import FlowLK from './flowLK';
import FlowRadar, { RADAR_FLOW_RESOLUTION } from './flowRadar';
import RadarTrajectories from './trajectories';
import { createRg16fTexture, releaseContext } from './glUtils';
import FrameTextures from './frameTextures';

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
  constructor({
    useFlow = false,
    motionProfile = 'radar',
    flowResolution = motionProfile === 'radar' ? RADAR_FLOW_RESOLUTION : 256,
  } = {}) {
    this.flowResolution = flowResolution;
    this.motionProfile = motionProfile;
    // When true, flows are computed via Lucas-Kanade; when false,
    // flows are zero-filled (interpolation degenerates to crossfade).
    // Swapped at runtime via setUseFlow.
    this.useFlow = useFlow;

    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    // Upload, filtering, blending and canvas compositing all use premultiplied
    // RGBA. Interpolating straight RGB across clear pixels darkens rain edges
    // twice: once in texture filtering and again in browser compositing.
    // preserveDrawingBuffer:true
    // keeps the buffer between our gl.clear calls — OL may read the
    // canvas slightly out of phase with our draws, and without this the
    // browser can wipe the buffer between draw and composite.
    this.gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!this.gl) {
      throw new Error('RadarInterpolator: WebGL2 unavailable');
    }
    // ISO time → decoded frame metadata; adjacent time pair → computed flow texture.
    this.frames = new Map();
    this.flows = new Map();
    this.contextLost = false;
    this.disposed = false;
    // FramePool owns the decoded images and current WMS identities. It replays
    // its valid slots after restoration; the renderer keeps no extra bitmap copies.
    this.onContextChange = null;
    try {
      this._createResources();
    } catch (error) {
      this._releaseResources();
      releaseContext(this.gl);
      throw error;
    }

    this._onContextLost = (e) => {
      e.preventDefault();
      if (this.disposed) return;
      this.contextLost = true;
      this._releaseResources();
      if (this.onContextChange) this.onContextChange();
    };
    this._onContextRestored = () => {
      if (this.disposed || !this.contextLost) return;
      try {
        this._createResources();
        this.contextLost = false;
        if (this.onContextChange) this.onContextChange();
      } catch (error) {
        // A failed rebuild must leave the ordinary WMS image visible. Do not
        // retry in a loop while the browser may still be under memory pressure.
        this.contextLost = true;
        this._releaseResources();
        if (this.onContextChange) this.onContextChange();
        // eslint-disable-next-line no-console
        console.warn('Interpolation context recovery failed', error);
      }
    };
    this.canvas.addEventListener('webglcontextlost', this._onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this._onContextRestored);
  }

  _createResources() {
    // Extensions and every GPU handle must be reacquired after restoration.
    const halfFloat = this.gl.getExtension('EXT_color_buffer_half_float');
    const float = this.gl.getExtension('EXT_color_buffer_float');
    if (!halfFloat && !float) throw new Error('Interpolation float render targets unavailable');
    // RG16F linear filtering is core in WebGL2, independent of these extensions.
    this.flowFilter = this.gl.LINEAR;
    this.frameTextures = new FrameTextures(this.gl);
    this.warp = new WarpRenderer(this.gl, this.motionProfile === 'radar');
    this.trajectories = null;
    this.flowLK = null;
  }

  _releaseResources() {
    // Lost-context handles are already invalid. Never reuse them on restore.
    if (this.frameTextures) this.frameTextures.dispose();
    if (!this.gl.isContextLost()) {
      for (const f of this.flows.values()) this.gl.deleteTexture(f.texture);
      if (this.warp) this.warp.dispose();
      if (this.trajectories) this.trajectories.dispose();
      if (this.flowLK) this.flowLK.dispose();
    }
    this.frames.clear();
    this.flows.clear();
    this.frameTextures = null;
    this.warp = null;
    this.trajectories = null;
    this.flowLK = null;
  }

  // Flip between zero-flow (crossfade) and LK flow. Clears any
  // computed flows; callers should refresh them for currently-loaded
  // pairs so the next render has the new flow type ready.
  setUseFlow(useFlow) {
    if (this.useFlow === useFlow) return;
    this.useFlow = useFlow;
    for (const f of this.flows.values()) this.gl.deleteTexture(f.texture);
    this.flows.clear();
    if (this.trajectories) this.trajectories.clear();
  }

  // Called from FramePool on imageloadend once a slot's bitmap is
  // usable. Retains the existing decoded image under the slot's TIME; GPU
  // copies are uploaded on demand and bounded independently of the window.
  // The caller-provided `extent` is stored so hasFlow can
  // later detect a stale pair whose content is for a different view
  // (happens during zoom/pan before the new bitmaps land — without
  // this the warp draws old-extent pixels at the new extent).
  onSlotLoaded(slot, image, extent) {
    if (this.disposed || this.contextLost || this.gl.isContextLost()) return;
    if (!slot || !slot.time || !image) return;
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (!w || !h) return;
    const existing = this.frames.get(slot.time);
    if (existing) this.frameTextures.delete(existing);
    this.frames.set(slot.time, {
      image, width: w, height: h, extent: extent ? extent.slice() : null,
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
      if (this.trajectories) this.trajectories.clear();
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
      this.frameTextures.delete(f);
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
  //   - both decoded images available for upload,
  //   - a flow texture computed for the pair (via computeFlow),
  //   - A and B fetched at approximately the same stored extent so
  //     they share a UV coordinate system for the flow,
  //   - the stored extent fully contains the current view so the
  //     warp shader's UV-transformed sampling has data to fetch.
  // When the view has only shifted within the stored buffer, this
  // returns true and renderAt builds a UV offset to place content
  // at the correct world position in the output canvas.
  hasFlow(timeA, timeB, extent = null) {
    if (this.disposed || this.contextLost || this.gl.isContextLost()) return false;
    const a = this.frames.get(timeA);
    const b = this.frames.get(timeB);
    if (!a || !b) return false;
    if (!this.flows.has(`${timeA}|${timeB}`)) return false;
    if (!extent) return true;
    if (!extentApproxEqual(a.extent, b.extent)) return false;
    return extentContains(a.extent, extent);
  }

  // Produce the flow texture for (A, B) — LK-computed if useFlow is
  // true, zero-filled otherwise. FramePool queues this when both
  // frames of a pair become available. No-op
  // if the pair already has a flow (the frames themselves are
  // replaced in onSlotLoaded; a new compute is triggered then by
  // having that call invalidate the flow first).
  computeFlow(timeA, timeB) {
    if (this.disposed || this.contextLost || this.gl.isContextLost()) return;
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
    if (this.useFlow && !this.flowLK) {
      // Crossfade needs only the warp shader. Build motion resources in the
      // queued pair job, never in the mode-switch handler. Keep them for warm
      // mode changes; context restoration starts with only the warp again.
      try {
        this.trajectories = this.motionProfile === 'radar' ? new RadarTrajectories(this.gl) : null;
        this.flowLK = this.motionProfile === 'satellite'
          ? new FlowLK(this.gl, this.flowResolution) : new FlowRadar(this.gl, this.flowResolution);
      } catch (error) {
        if (this.gl.isContextLost()) return;
        // A constructor may have allocated handles before throwing. Release
        // the whole context; the owner must detach this terminal renderer.
        this.dispose();
        throw error;
      }
    }
    let flow;
    try {
      if (this.useFlow) {
        const textureA = this.frameTextures.get(a);
        const textureB = this.frameTextures.get(b);
        flow = this.motionProfile === 'satellite'
          ? { texture: this.flowLK.compute(textureA, textureB, this.flowFilter), width: this.flowResolution, height: this.flowResolution }
          : this.flowLK.compute({ ...a, texture: textureA }, { ...b, texture: textureB });
      } else {
        flow = { texture: createRg16fTexture(this.gl, 1, 1, null, this.flowFilter), width: 1, height: 1 };
      }
    } catch (error) {
      // Loss may precede the queued DOM event, including halfway through a
      // framebuffer pass. Let FramePool's imageloadend finish pumping loads.
      if (this.gl.isContextLost()) return;
      throw error;
    }
    if (this.gl.isContextLost()) return;
    this.flows.set(key, flow);
  }

  // Prepare upcoming images without changing any pair's flow readiness.
  prefetch(times) {
    if (this.disposed || this.contextLost || this.gl.isContextLost()) return;
    // Pause or ordinary-frame fallback releases the displayed pair too.
    if (!times.length) this.frameTextures.setActive();
    this.frameTextures.prefetch(times.map((time) => this.frames.get(time)).filter(Boolean));
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
    if (this.disposed || this.contextLost || this.gl.isContextLost()) return null;
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
    this.frameTextures.setActive(a, b);
    const textureA = this.frameTextures.get(a);
    const textureB = this.frameTextures.get(b);
    let trajectory = null;
    try {
      if (this.useFlow && this.trajectories) {
        trajectory = this.trajectories.get(`${timeA}|${timeB}`, this.flows, t);
      }
    } catch (error) {
      if (gl.isContextLost()) return null;
      throw error;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.warp.render(
      textureA,
      textureB,
      flow.texture,
      t,
      w,
      h,
      scaleX,
      scaleY,
      offsetX,
      offsetY,
      trajectory,
      this.useFlow,
    );
    // Flush pending draw commands so the compositor reads fully-
    // drawn pixels when it pulls the canvas — iOS Safari otherwise
    // occasionally presents a half-drawn buffer during fast playback.
    gl.flush();

    return this.canvas;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.onContextChange = null;
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    this._releaseResources();
    // A loss already acknowledged by the live renderer may still be restored
    // after detachment. Release that context too, without rebuilding resources.
    if (this.gl.isContextLost()) {
      this.canvas.addEventListener('webglcontextrestored', () => releaseContext(this.gl), { once: true });
    }
    releaseContext(this.gl);
  }
}
