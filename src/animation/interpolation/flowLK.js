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

float lum(vec4 c) {
  return dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
  // 7×7 window centered on vUv. radius can be tuned — bigger window
  // is more robust to noise but smooths out motion boundaries.
  const int RADIUS = 3;

  float sumIx2  = 0.0;
  float sumIy2  = 0.0;
  float sumIxIy = 0.0;
  float sumIxIt = 0.0;
  float sumIyIt = 0.0;

  for (int dy = -RADIUS; dy <= RADIUS; dy++) {
    for (int dx = -RADIUS; dx <= RADIUS; dx++) {
      vec2 pt = vUv + vec2(float(dx), float(dy)) * uStep;

      // Central difference on A: Sobel-lite (3-tap).
      float aL = lum(texture(uA, pt + vec2(-uStep.x, 0.0)));
      float aR = lum(texture(uA, pt + vec2( uStep.x, 0.0)));
      float aT = lum(texture(uA, pt + vec2(0.0, -uStep.y)));
      float aB = lum(texture(uA, pt + vec2(0.0,  uStep.y)));

      float Ix = (aR - aL) * 0.5;
      float Iy = (aB - aT) * 0.5;

      float It = lum(texture(uB, pt)) - lum(texture(uA, pt));

      sumIx2  += Ix * Ix;
      sumIy2  += Iy * Iy;
      sumIxIy += Ix * Iy;
      sumIxIt += Ix * It;
      sumIyIt += Iy * It;
    }
  }

  // Solve [ΣIx²  ΣIxIy] [u]   [-ΣIxIt]
  //       [ΣIxIy ΣIy² ] [v] = [-ΣIyIt]
  float det = sumIx2 * sumIy2 - sumIxIy * sumIxIy;
  vec2 flow = vec2(0.0);
  // Threshold guards pixels with no structure (flat regions) — the
  // matrix is singular there and the "flow" is noise.
  if (det > 1e-6) {
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
