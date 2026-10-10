// Motion-compensated warp renderer. The fragment shader takes two
// RGBA frame textures A and B plus a half-float flow texture (RG = motion) in
// normalized-UV displacement units, and produces a mixed output at
// fractional time `t ∈ [0, 1]`.
//
// Frame textures and output use premultiplied RGBA throughout. Zero flow
// gives a crossfade, including a linear visible-colour fade at clear edges.
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
uniform bool uGuardFlow;
// Affine transform from output-canvas UV to stored-frame UV.
// When canvas extent equals stored extent: uScale=(1,1), uOffset=(0,0).
// When canvas has shifted (small pan within the loaded buffer):
// uOffset moves the sampling so the content lands at the correct
// world position in the output.
uniform vec2 uScale;
uniform vec2 uOffset;

in vec2 vUv;
out vec4 fragColor;

// Sample the texture only when the UV is inside [0,1]; outside,
// return transparent. CLAMP_TO_EDGE wrap would otherwise smear a
// stretched row of edge pixels along the viewport boundary when the
// canvas extent sits near the stored frame's edge (small pan right
// to the limit of the 1.5× fetch buffer).
vec4 sampleBounded(sampler2D tex, vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4(0.0);
  }
  return texture(tex, uv);
}

void main() {
  vec2 src = vUv * uScale + uOffset;
  vec2 flow = texture(uFlow, src).rg;
  float confidence = 1.0;
  if (uGuardFlow) {
    // The Frobenius norm bounds the displacement gradient's largest singular
    // value. Below 1 neither x-t*flow nor x+(1-t)*flow can fold for t in [0,1].
    // Fade to the observations as that bound is approached. Blending images
    // (not scaling vectors) avoids a new discontinuity in the displacement.
    vec2 dx = dFdx(flow) / max(abs(dFdx(src).x), 1e-8);
    vec2 dy = dFdy(flow) / max(abs(dFdy(src).y), 1e-8);
    float deformation = sqrt(dot(dx,dx)+dot(dy,dy));
    confidence = 1.0-smoothstep(0.75,1.0,deformation);
  }
  // Forward-warp A by t*flow, backward-warp B by (1-t)*flow, blend.
  // All UVs here are in the stored frames' space so the flow texture
  // (also computed in that space) is applied consistently.
  vec2 srcA = src - uT * flow;
  vec2 srcB = src + (1.0 - uT) * flow;
  vec4 a = sampleBounded(uFrameA, srcA);
  vec4 b = sampleBounded(uFrameB, srcB);
  // RGB already contains coverage. Mix it with alpha; never multiply again
  // or replace transparent samples with full-strength rain from the other frame.
  vec4 warped = mix(a, b, uT);
  if (confidence < 1.0) {
    vec4 fallback = mix(sampleBounded(uFrameA,src), sampleBounded(uFrameB,src),uT);
    warped = mix(fallback,warped,confidence);
  }
  fragColor = warped;
}
`;

export default class WarpRenderer {
  constructor(gl, guardFlow = false) {
    this.gl = gl;
    this.guardFlow = guardFlow;
    this.program = createProgram(gl, VERT, FRAG);
    this.vbo = createFullscreenTriangle(gl);
    this.aPos = gl.getAttribLocation(this.program, 'aPos');
    this.uFrameA = gl.getUniformLocation(this.program, 'uFrameA');
    this.uFrameB = gl.getUniformLocation(this.program, 'uFrameB');
    this.uFlow = gl.getUniformLocation(this.program, 'uFlow');
    this.uT = gl.getUniformLocation(this.program, 'uT');
    this.uGuardFlow = gl.getUniformLocation(this.program, 'uGuardFlow');
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
    gl.uniform1i(this.uGuardFlow, this.guardFlow ? 1 : 0);
    gl.uniform2f(this.uScale, scaleX, scaleY);
    gl.uniform2f(this.uOffset, offsetX, offsetY);

    drawFullscreen(gl, this.vbo, this.aPos);
  }

  dispose() {
    this.gl.deleteProgram(this.program);
    this.gl.deleteBuffer(this.vbo);
  }
}
