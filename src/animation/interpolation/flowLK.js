// Single-level Lucas-Kanade optical flow in a single fragment-shader
// pass. Output is an RG16F texture of flowResolution² holding
// normalized UV displacements (flow.x in [-1,1] = fraction of texture
// width, flow.y ditto for height).
//
// For each output pixel we evaluate a (2*radius+1)² window centered
// on the pixel, compute Sobel gradients of A and the temporal
// difference (B - A) at each window sample, accumulate the 5 moments
// ΣIx², ΣIy², ΣIxIy, ΣIxIt, ΣIyIt, and solve the 2×2 normal
// equations. Luminance (Rec.709) is computed inline from the RGBA
// source textures — no separate grayscale upload needed.
//
// No pyramidal coarse-to-fine pass yet. For typical radar motion
// viewed at Finland-scale zoom the displacement at 256² analysis
// resolution is under a pixel, so a single level with a 7×7 window
// recovers it. Very large displacements (extreme zoom-out or fast
// synoptic systems) will fail silently — the solve clamps to zero
// and the interpolation degrades to the Phase 2 crossfade. Pyramid
// support is a Phase 3b enhancement if we see this in practice.

import {
  createProgram, createRg16fTexture, createFullscreenTriangle, drawFullscreen,
} from './glUtils';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG = `#version 300 es
precision highp float;

uniform sampler2D uA;
uniform sampler2D uB;
uniform vec2 uStep;   // 1 / resolution, in UV

in vec2 vUv;
out vec4 fragColor;

void main() {
  // 11×11 window. Bigger windows are more robust for our inputs
  // (stepped palettes, bilinear-resampled radar) and the extra
  // smoothing across motion boundaries is acceptable at this
  // analysis resolution.
  const int RADIUS = 5;

  // Accumulate the 5 LK moments across all three RGB channels.
  // Stepped radar palettes (e.g. FMI classical green/yellow/red
  // bands) have near-zero luminance gradient inside each band — LK
  // on luminance alone produces a singular 2×2 and clamps flow to
  // zero. Hue changes between bands though, so summing per-channel
  // gradients recovers the motion signal. With a continuous
  // colormap (e.g. Bookbinder viridis-like), all three channels
  // produce similar signal and the sum is roughly 3× luminance —
  // no harm.
  float sumIx2  = 0.0;
  float sumIy2  = 0.0;
  float sumIxIy = 0.0;
  float sumIxIt = 0.0;
  float sumIyIt = 0.0;

  for (int dy = -RADIUS; dy <= RADIUS; dy++) {
    for (int dx = -RADIUS; dx <= RADIUS; dx++) {
      vec2 pt = vUv + vec2(float(dx), float(dy)) * uStep;

      vec3 aL = texture(uA, pt + vec2(-uStep.x, 0.0)).rgb;
      vec3 aR = texture(uA, pt + vec2( uStep.x, 0.0)).rgb;
      vec3 aT = texture(uA, pt + vec2(0.0, -uStep.y)).rgb;
      vec3 aB = texture(uA, pt + vec2(0.0,  uStep.y)).rgb;

      vec3 Ix = (aR - aL) * 0.5;
      vec3 Iy = (aB - aT) * 0.5;

      vec3 It = texture(uB, pt).rgb - texture(uA, pt).rgb;

      sumIx2  += dot(Ix, Ix);
      sumIy2  += dot(Iy, Iy);
      sumIxIy += dot(Ix, Iy);
      sumIxIt += dot(Ix, It);
      sumIyIt += dot(Iy, It);
    }
  }

  // Solve [ΣIx²  ΣIxIy] [u]   [-ΣIxIt]
  //       [ΣIxIy ΣIy² ] [v] = [-ΣIyIt]
  float det = sumIx2 * sumIy2 - sumIxIy * sumIxIy;
  vec2 flow = vec2(0.0);
  // Threshold guards pixels with no structure (flat regions) — the
  // matrix is singular there and the "flow" is noise. The RGB-summed
  // moments span roughly [0, 100] for cell edges, so a floor well
  // above floating-point noise keeps the output clean.
  if (det > 1e-3) {
    float invDet = 1.0 / det;
    // Note the signs: the RHS is (-ΣIxIt, -ΣIyIt) so we multiply
    // through with negatives here.
    flow.x = (-sumIy2  * sumIxIt + sumIxIy * sumIyIt) * invDet;
    flow.y = ( sumIxIy * sumIxIt - sumIx2  * sumIyIt) * invDet;
  }

  // flow is in pixel units at this analysis resolution; convert to
  // UV displacement so the warp shader can use it directly.
  flow *= uStep;

  fragColor = vec4(flow, 0.0, 1.0);
}
`;

export default class FlowLK {
  constructor(gl, resolution = 256) {
    this.gl = gl;
    this.resolution = resolution;
    this.program = createProgram(gl, VERT, FRAG);
    this.vbo = createFullscreenTriangle(gl);
    this.fbo = gl.createFramebuffer();

    this.aPos = gl.getAttribLocation(this.program, 'aPos');
    this.uA = gl.getUniformLocation(this.program, 'uA');
    this.uB = gl.getUniformLocation(this.program, 'uB');
    this.uStep = gl.getUniformLocation(this.program, 'uStep');
  }

  // Compute flow from A to B. Returns a fresh RG16F texture of
  // resolution² holding UV displacements. The caller owns the
  // returned texture and must gl.deleteTexture it when done.
  compute(texA, texB) {
    const { gl } = this;
    const flowTex = createRg16fTexture(gl, this.resolution, this.resolution, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, flowTex, 0);

    gl.viewport(0, 0, this.resolution, this.resolution);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texA);
    gl.uniform1i(this.uA, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texB);
    gl.uniform1i(this.uB, 1);

    const step = 1 / this.resolution;
    gl.uniform2f(this.uStep, step, step);

    drawFullscreen(gl, this.vbo, this.aPos);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return flowTex;
  }

  dispose() {
    this.gl.deleteProgram(this.program);
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteFramebuffer(this.fbo);
  }
}
