// Satellite Lucas-Kanade flow, refined from coarse to fine. The pyramid is
// analysis-only: the renderer still samples the original full-colour images.
// Output is RG16F, resolution², with displacements in normalized image UV.
import {
  createProgram, createRg16fTexture, createFullscreenTriangle, drawFullscreen,
} from './glUtils';

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const REDUCE = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform bool uSource;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;
vec2 pair(vec2 p) {
  if (!uSource) return texture(uA, p).rg;
  vec3 weights = vec3(0.2126, 0.7152, 0.0722);
  return vec2(dot(texture(uA, p).rgb, weights), dot(texture(uB, p).rgb, weights));
}
void main() {
  // At most 2x reduction on each axis. Four bilinear taps cover the output
  // footprint instead of selecting isolated source pixels. Store both images'
  // luminance together, retaining faint cloud gradients in half-float storage.
  vec2 value = (pair(vUv + uStep * vec2(-0.25, -0.25))
              + pair(vUv + uStep * vec2( 0.25, -0.25))
              + pair(vUv + uStep * vec2(-0.25,  0.25))
              + pair(vUv + uStep * vec2( 0.25,  0.25))) * 0.25;
  fragColor = vec4(value, 0.0, 1.0);
}`;

const REFINE = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uFlow;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 prior = texture(uFlow, vUv).rg;
  float xx = 0.0, yy = 0.0, xy = 0.0, xt = 0.0, yt = 0.0;
  float weightSum = 0.0;
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      vec2 p = vUv + vec2(float(x), float(y)) * uStep;
      vec2 q = p + prior;
      // A clamped image border is not a feature to track.
      if (any(lessThan(p, uStep)) || any(greaterThan(p, 1.0-uStep))
          || any(lessThan(q, uStep)) || any(greaterThan(q, 1.0-uStep))) continue;
      vec2 grad = 0.5 * vec2(
        texture(uA, p+vec2(uStep.x,0)).r-texture(uA, p-vec2(uStep.x,0)).r,
        texture(uA, p+vec2(0,uStep.y)).r-texture(uA, p-vec2(0,uStep.y)).r);
      float dt = texture(uA, q).g-texture(uA, p).r;
      float weight = exp(-float(x*x+y*y)/8.0);
      xx += weight * grad.x * grad.x;
      yy += weight * grad.y * grad.y;
      xy += weight * grad.x * grad.y;
      xt += weight * grad.x * dt;
      yt += weight * grad.y * dt;
      weightSum += weight;
    }
  }
  float trace = xx+yy;
  float eigen = 0.5 * (trace-sqrt(max(0.0,(xx-yy)*(xx-yy)+4.0*xy*xy)));
  float confidence = smoothstep(0.000001, 0.00001, eigen/max(weightSum,1.0));
  // Preserve coarse motion where there is too little texture to refine it.
  float ridge = max(0.01 * trace, 0.00000001);
  float det = (xx+ridge)*(yy+ridge)-xy*xy;
  vec2 delta = vec2(-(yy+ridge)*xt+xy*yt, xy*xt-(xx+ridge)*yt)/det;
  // Each linearization may move at most one pixel at its own pyramid level.
  // UV displacements survive upsampling unchanged.
  delta *= min(1.0, 1.0/max(length(delta),0.00001));
  fragColor = vec4(prior + confidence * delta * uStep, 0.0, 1.0);
}`;

const REGULARIZE = `#version 300 es
precision highp float;
uniform sampler2D uFlow;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;
void main() {
  // Reject isolated vectors before averaging: a failed local match must not
  // drag the neighbouring cloud patches with it.
  vec2 values[9];
  vec2 sorted[9];
  int i = 0;
  for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++) {
    values[i] = texture(uFlow,vUv+vec2(float(x),float(y))*uStep).rg/uStep;
    sorted[i] = values[i];
    i++;
  }
  for (int j=1; j<9; j++) for (int k=j; k>0; k--) {
    vec2 lo=min(sorted[k-1],sorted[k]);
    sorted[k]=max(sorted[k-1],sorted[k]);
    sorted[k-1]=lo;
  }
  vec2 sum=vec2(0.0);
  float total=0.0;
  for (int j=0; j<9; j++) {
    vec2 distance=values[j]-sorted[4];
    float weight=1.0/(1.0+4.0*dot(distance,distance));
    sum+=weight*values[j]; total+=weight;
  }
  fragColor=vec4(sum/total*uStep,0.0,1.0);
}`;

const SMOOTH = `#version 300 es
precision highp float;
uniform sampler2D uFlow;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 sum=vec2(0.0);
  for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++) {
    float weight=(x==0 ? 2.0 : 1.0)*(y==0 ? 2.0 : 1.0);
    sum+=weight*texture(uFlow,vUv+vec2(float(x),float(y))*uStep).rg;
  }
  fragColor=vec4(sum/16.0,0.0,1.0);
}`;

export default class FlowLK {
  constructor(gl, resolution = 256) {
    this.gl = gl;
    this.resolution = resolution;
    this.vbo = createFullscreenTriangle(gl);
    this.fbo = gl.createFramebuffer();
    this.passes = [REDUCE, REFINE, REGULARIZE, SMOOTH].map((fragment) => {
      const program = createProgram(gl, VERT, fragment);
      return {
        program,
        aPos: gl.getAttribLocation(program, 'aPos'),
        step: gl.getUniformLocation(program, 'uStep'),
        source: gl.getUniformLocation(program, 'uSource'),
        images: ['uA', 'uB', 'uFlow'].map((name) => gl.getUniformLocation(program, name)),
      };
    });
  }

  draw(pass, output, inputs, source = false) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output.texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Satellite flow framebuffer incomplete');
    }
    gl.viewport(0, 0, output.width, output.height);
    gl.disable(gl.BLEND);
    gl.useProgram(pass.program);
    inputs.forEach((input, i) => {
      if (!input) return;
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, input.texture);
      gl.uniform1i(pass.images[i], i);
    });
    gl.uniform2f(pass.step, 1 / output.width, 1 / output.height);
    gl.uniform1i(pass.source, source);
    drawFullscreen(gl, this.vbo, pass.aPos);
  }

  // Frames include their uploaded texture and source dimensions. The caller
  // owns the returned RG16F texture; intermediate storage is pair-local.
  compute(a, b, filter) {
    const { gl, resolution } = this;
    const allocated = [];
    let result;
    const allocate = (width, height) => {
      const value = { texture: createRg16fTexture(gl, width, height, null, filter), width, height };
      allocated.push(value);
      return value;
    };
    try {
      let width = Math.max(a.width, b.width);
      let height = Math.max(a.height, b.height);
      let image;
      do {
        width = Math.max(resolution, Math.ceil(width / 2));
        height = Math.max(resolution, Math.ceil(height / 2));
        const next = allocate(width, height);
        // Bind both active samplers even when uSource is false; leaving uB
        // bound to a newly allocated output would create a feedback loop.
        this.draw(this.passes[0], next, image ? [image, image] : [a, b], !image);
        image = next;
      } while (width > resolution || height > resolution);
      const levels = [image];
      while (levels.length < 4 && image.width >= 32) {
        const next = allocate(Math.ceil(image.width / 2), Math.ceil(image.height / 2));
        this.draw(this.passes[0], next, [image, image]);
        image = next;
        levels.push(image);
      }
      let flow = allocate(1, 1); // zero initial motion
      for (let level = levels.length - 1; level >= 0; level--) {
        image = levels[level];
        const candidate = allocate(image.width, image.height);
        const regularized = allocate(image.width, image.height);
        for (let iteration = 0; iteration < 4; iteration++) {
          this.draw(this.passes[1], candidate, [image, null, flow]);
          this.draw(this.passes[2], regularized, [null, null, candidate]);
          flow = regularized;
        }
      }
      // Cloud growth and brightness changes can give adjacent windows different
      // answers. Smooth velocity, never the displayed source colours. Keep the
      // footprint constant if the analysis resolution changes.
      const density = Math.max(1, resolution / 256);
      const count = Math.ceil(12 * density * density);
      const smooth = [allocate(resolution, resolution), allocate(resolution, resolution)];
      for (let i = 0; i < count; i++) {
        const next = smooth[i % 2];
        this.draw(this.passes[3], next, [null, null, flow]);
        flow = next;
      }
      result = flow;
      return result.texture;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const value of allocated) if (value !== result) gl.deleteTexture(value.texture);
    }
  }

  dispose() {
    const { gl } = this;
    this.passes.forEach((pass) => gl.deleteProgram(pass.program));
    gl.deleteBuffer(this.vbo);
    gl.deleteFramebuffer(this.fbo);
  }
}
