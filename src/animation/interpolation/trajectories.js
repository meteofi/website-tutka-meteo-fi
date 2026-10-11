// Endpoint-preserving radar paths. Adjacent pairs meet with the same velocity
// in their shared observation's coordinates. Only the small analysis grid is
// processed here; the original precipitation colours are never smoothed.
import { createProgram, createFullscreenTriangle, drawFullscreen } from './glUtils';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv=aPos*0.5+0.5;
  gl_Position=vec4(aPos,0,1);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uPrevious;
uniform sampler2D uFlow;
uniform sampler2D uNext;
uniform bool uHasPrevious;
uniform bool uHasNext;
in vec2 vUv;
out vec4 fragColor;

// Weighted harmonic slopes preserve constant translation, limit overshoot,
// and join conflicting directions at zero velocity rather than reversing
// instantly. Both adjoining pairs use the same rule at the shared frame.
float slope(float a, float b, float wa, float wb) {
  if (a*b <= 0.0) return 0.0;
  float mean=(wa+wb)*a*b/(wa*b+wb*a);
  return sign(a)*min(abs(mean),2.0*min(abs(a),abs(b)));
}
vec2 velocity(vec4 incoming, vec4 outgoing) {
  float wa=max(incoming.b,0.05), wb=max(outgoing.b,0.05);
  return vec2(slope(incoming.r,outgoing.r,wa,wb),
              slope(incoming.g,outgoing.g,wa,wb));
}
bool inside(vec2 p) { return all(greaterThanEqual(p,vec2(0))) && all(lessThanEqual(p,vec2(1))); }

void main() {
  vec4 flow=texture(uFlow,vUv);
  vec2 start=flow.rg, end=flow.rg;
  if (uHasPrevious) {
    // The incoming field belongs to the previous image, not this image.
    vec2 p=vUv;
    for (int i=0;i<8;i++) p=vUv-texture(uPrevious,p).rg;
    vec4 incoming=texture(uPrevious,p);
    vec2 residual=(p+incoming.rg-vUv)*vec2(textureSize(uPrevious,0));
    if (inside(p) && length(residual)<0.05) start=velocity(incoming,flow);
  }
  vec2 destination=vUv+flow.rg;
  if (uHasNext && inside(destination)) end=velocity(flow,texture(uNext,destination));
  // Cubic Hermite displacement = t*F + t*(1-t)*((1-t)*RG+t*BA).
  fragColor=vec4(start-flow.rg,flow.rg-end);
}`;

export default class RadarTrajectories {
  constructor(gl) {
    this.gl = gl;
    this.program = createProgram(gl, VERT, FRAG);
    this.vbo = createFullscreenTriangle(gl);
    this.fbo = gl.createFramebuffer();
    this.aPos = gl.getAttribLocation(this.program, 'aPos');
    this.inputs = ['uPrevious', 'uFlow', 'uNext'].map((name) => gl.getUniformLocation(this.program, name));
    this.uHasPrevious = gl.getUniformLocation(this.program, 'uHasPrevious');
    this.uHasNext = gl.getUniformLocation(this.program, 'uHasNext');
    this.cache = new Map();
    this.activeKey = null;
    this.lastT = 0;
  }

  get(key, flows, t) {
    const { gl } = this;
    // Replaced observations may never reuse a path for their old flow.
    for (const [id, entry] of this.cache) {
      if (entry.flow !== flows.get(id)) {
        gl.deleteTexture(entry.texture);
        this.cache.delete(id);
      }
    }
    const flow = flows.get(key);
    const [timeA, timeB] = key.split('|');
    let previous;
    let next;
    for (const [id, value] of flows) {
      if (id.endsWith(`|${timeA}`)) previous = value;
      if (id.startsWith(`${timeB}|`)) next = value;
    }
    const cached = this.cache.get(key);
    // Loading a neighbour halfway through playback must not change the path
    // under the moving image. Pick up new neighbours on the next visit.
    const continuing = this.activeKey === key && t >= this.lastT;
    this.activeKey = key;
    this.lastT = t;
    if (cached && (continuing || (cached.previous === previous && cached.next === next))) {
      return cached.texture;
    }
    if (cached) {
      gl.deleteTexture(cached.texture);
      this.cache.delete(key);
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, flow.width, flow.height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteTexture(texture);
      throw new Error('Radar trajectory framebuffer incomplete');
    }
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, flow.width, flow.height);
    gl.useProgram(this.program);
    [previous || flow, flow, next || flow].forEach((input, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, input.texture);
      gl.uniform1i(this.inputs[i], i);
    });
    gl.uniform1i(this.uHasPrevious, previous ? 1 : 0);
    gl.uniform1i(this.uHasNext, next ? 1 : 0);
    drawFullscreen(gl, this.vbo, this.aPos);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cache.set(key, {
      texture, flow, previous, next,
    });
    return texture;
  }

  clear() {
    for (const entry of this.cache.values()) this.gl.deleteTexture(entry.texture);
    this.cache.clear();
    this.activeKey = null;
  }

  dispose() {
    this.clear();
    this.gl.deleteProgram(this.program);
    this.gl.deleteBuffer(this.vbo);
    this.gl.deleteFramebuffer(this.fbo);
  }
}
