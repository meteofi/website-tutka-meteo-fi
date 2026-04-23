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

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 flow = texture(uFlow, vUv).rg;
  // Forward-warp A by t*flow, backward-warp B by (1-t)*flow, blend.
  vec4 a = texture(uFrameA, vUv - uT * flow);
  vec4 b = texture(uFrameB, vUv + (1.0 - uT) * flow);
  fragColor = mix(a, b, uT);
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
  }

  // Draw to whatever FBO is currently bound (null = default FBO =
  // this.gl.canvas). Caller is responsible for binding the right
  // FBO and clearing it before calling.
  render(frameATex, frameBTex, flowTex, t, viewportW, viewportH) {
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

    drawFullscreen(gl, this.vbo, this.aPos);
  }

  dispose() {
    this.gl.deleteProgram(this.program);
    this.gl.deleteBuffer(this.vbo);
  }
}
