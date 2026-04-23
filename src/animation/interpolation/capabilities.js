// Capability probe for optical-flow interpolation. Returns a Promise
// resolving to true iff the device can run the interpolator.
//
// Order of checks (fail fast): URL override → WebGL2 → RG16F render
// extension → 1x1 FBO completeness → low-memory bail-out. Extension
// presence alone does not guarantee FBO-completeness on every mobile
// driver, so the completeness probe stays.
//
// iOS 15.4+ stopped exposing EXT_color_buffer_float (it had falsely
// advertised FP32 renderability before) and switched to
// EXT_color_buffer_half_float. Either extension enables RG16F render
// targets, which is all the LK flow pass needs.
//
// Phase 1 stops here. Phase 4 adds the LK micro-benchmark and a
// localStorage-cached verdict with a 7-day TTL.

function readOverride() {
  const params = new URLSearchParams(window.location.search);
  const v = params.get('interp');
  if (v === 'on') return true;
  if (v === 'off') return false;
  return null;
}

function probeRg16fFboComplete(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, 1, 1, 0, gl.RG, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(tex);
  return status === gl.FRAMEBUFFER_COMPLETE;
}

export default async function canInterpolate() {
  const override = readOverride();
  if (override !== null) return override;

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return false;

  const hasHalf = !!gl.getExtension('EXT_color_buffer_half_float');
  const hasFull = !!gl.getExtension('EXT_color_buffer_float');
  if (!hasHalf && !hasFull) return false;

  if (!probeRg16fFboComplete(gl)) return false;

  // navigator.deviceMemory is undefined on Safari; only fail when we
  // have a concrete low-memory reading.
  if (navigator.deviceMemory !== undefined && navigator.deviceMemory < 3) {
    return false;
  }

  return true;
}
