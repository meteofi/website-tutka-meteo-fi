// Full-resolution images remain owned by FramePool. Keep only a few GPU copies;
// evicting one must not invalidate its smaller, already computed motion field.
import { createRgbaTexture } from './glUtils';

export const FRAME_TEXTURE_LIMIT = 4;

// Share the upload queue across pools: a split-screen pair transition must not
// make every pane upload at once. Warm at most one image per animation frame.
const pendingCaches = new Set();
let uploadRequest = null;
function scheduleUpload() {
  if (uploadRequest !== null || !pendingCaches.size) return;
  uploadRequest = requestAnimationFrame(() => {
    uploadRequest = null;
    const cache = pendingCaches.values().next().value;
    pendingCaches.delete(cache);
    cache.uploadNext();
    scheduleUpload();
  });
}

export default class FrameTextures {
  constructor(gl) {
    this.gl = gl;
    this.entries = new Map();
    this.pending = [];
  }

  prefetch(frames) {
    // An already warm upcoming image is still in use. Otherwise the next
    // upload could evict it before it becomes B, causing needless re-uploads.
    for (const frame of frames) {
      if (this.entries.has(frame)) this.get(frame);
    }
    this.pending = frames.filter((frame) => !this.entries.has(frame));
    pendingCaches.delete(this);
    if (this.pending.length) pendingCaches.add(this);
    if (!pendingCaches.size && uploadRequest !== null) {
      cancelAnimationFrame(uploadRequest);
      uploadRequest = null;
    }
    scheduleUpload();
  }

  uploadNext() {
    if (this.gl.isContextLost()) { this.prefetch([]); return; }
    const frame = this.pending.shift();
    if (frame) this.get(frame);
    this.prefetch(this.pending);
  }

  get(frame) {
    let texture = this.entries.get(frame);
    if (texture) {
      this.entries.delete(frame);
    } else {
      // Evict before allocating, so a miss cannot temporarily exceed the cap.
      if (this.entries.size >= FRAME_TEXTURE_LIMIT) {
        this.delete(this.entries.keys().next().value);
      }
      texture = createRgbaTexture(this.gl, frame.width, frame.height, frame.image);
    }
    this.entries.set(frame, texture);
    return texture;
  }

  delete(frame) {
    const texture = this.entries.get(frame);
    if (texture && !this.gl.isContextLost()) this.gl.deleteTexture(texture);
    this.entries.delete(frame);
    this.prefetch(this.pending.filter((item) => item !== frame));
  }

  dispose() {
    this.prefetch([]);
    for (const frame of this.entries.keys()) this.delete(frame);
  }
}
