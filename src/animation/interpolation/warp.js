// Motion-compensated warp renderer. The fragment shader takes two
// RGBA frame textures A and B plus an RG16F flow texture in
// normalized-UV displacement units, and produces a mixed output at
// fractional time `t ∈ [0, 1]`.
//
// Phase 2: flow is always zero, so the shader degenerates to a plain
// crossfade (A at t=0, B at t=1, linear in between). This exists to
// prove GL context plumbing, texture upload, FBO/canvas output, and
// OpenLayers integration before Phase 3 introduces real Lucas-Kanade
// flow.
//
// Shader sources are inline strings — no webpack/raw-loader config
// change needed.

import {
  createProgram, createFullscreenTriangle, drawFullscreen,
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

uniform sampler2D uFrameA;
uniform sampler2D uFrameB;
uniform sampler2D uFlow;
uniform float uT;
// Affine transform from output-canvas UV to stored-frame UV.
// When canvas extent equals stored extent: uScale=(1,1), uOffset=(0,0).
// When canvas has shifted (small pan within the loaded buffer):
// uOffset moves the sampling so the content lands at the correct
// world position in the output.
uniform vec2 uScale;
uniform vec2 uOffset;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 src = vUv * uScale + uOffset;
  vec2 flow = texture(uFlow, src).rg;
  // Forward-warp A by t*flow, backward-warp B by (1-t)*flow, blend.
  // All UVs here are in the stored frames' space so the flow texture
  // (also computed in that space) is applied consistently.
  vec4 a = texture(uFrameA, src - uT * flow);
  vec4 b = texture(uFrameB, src + (1.0 - uT) * flow);
  // Nodata fallback: at coastlines and radar-range edges one sample
  // is full-alpha and the other is zero. mix() would fade the
  // boundary towards alpha 0.5 at t=0.5 — visible as brightness
  // pumping during playback. Prefer whichever side has data so the
  // edge stays stable.
  if (a.a < 0.001 && b.a < 0.001) {
    fragColor = vec4(0.0);
  } else if (a.a < 0.001) {
    fragColor = b;
  } else if (b.a < 0.001) {
    fragColor = a;
  } else {
    fragColor = mix(a, b, uT);
  }
}
`;

export default class WarpRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl, VERT, FRAG);
    this.vbo = createFullscreenTriangle(gl);
    this.aPos = gl.getAttribLocation(this.program, 'aPos');
    this.uFrameA = gl.getUniformLocation(this.program, 'uFrameA');
    this.uFrameB = gl.getUniformLocation(this.program, 'uFrameB');
    this.uFlow = gl.getUniformLocation(this.program, 'uFlow');
    this.uT = gl.getUniformLocation(this.program, 'uT');
    this.uScale = gl.getUniformLocation(this.program, 'uScale');
    this.uOffset = gl.getUniformLocation(this.program, 'uOffset');
  }

  // Draw to whatever FBO is currently bound (null = default FBO =
  // this.gl.canvas). Caller is responsible for binding the right
  // FBO and clearing it before calling. scaleX/Y and offsetX/Y
  // define an affine mapping from output UV to stored-frame UV —
  // identity (1,1,0,0) when the canvas extent equals the stored
  // extent.
  render(
    frameATex,
    frameBTex,
    flowTex,
    t,
    viewportW,
    viewportH,
    scaleX = 1,
    scaleY = 1,
    offsetX = 0,
    offsetY = 0,
  ) {
    const { gl } = this;
    // Ensure the draw fully overwrites the cleared buffer rather
    // than blending with any leftover content — defensive against
    // GL state getting nudged into BLEND by another code path.
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, viewportW, viewportH);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, frameATex);
    gl.uniform1i(this.uFrameA, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, frameBTex);
    gl.uniform1i(this.uFrameB, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, flowTex);
    gl.uniform1i(this.uFlow, 2);

    gl.uniform1f(this.uT, t);
    gl.uniform2f(this.uScale, scaleX, scaleY);
    gl.uniform2f(this.uOffset, offsetX, offsetY);

    drawFullscreen(gl, this.vbo, this.aPos);
  }

  dispose() {
    this.gl.deleteProgram(this.program);
    this.gl.deleteBuffer(this.vbo);
  }
}
