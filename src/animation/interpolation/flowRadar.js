// Radar has hard palette/coverage edges and larger displacements than the
// single-pass satellite estimator can follow. Solve coarse to fine on filtered
// images; carry coarse motion through weakly constrained edges instead of
// turning an ill-conditioned local solve into a large displacement.
import { createProgram, createFullscreenTriangle, drawFullscreen } from './glUtils';

export const RADAR_FLOW_RESOLUTION = 384;

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const DOWNSAMPLE = `#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;
void main() {
  // Four bilinear taps, with no reduction larger than 2x per pass. This
  // prefilters the source footprint, rather than picking isolated WMS pixels.
  vec4 c = (texture(uImage, vUv + uStep * vec2(-0.5, -0.5))
          + texture(uImage, vUv + uStep * vec2( 0.5, -0.5))
          + texture(uImage, vUv + uStep * vec2(-0.5,  0.5))
          + texture(uImage, vUv + uStep * vec2( 0.5,  0.5))) * 0.25;
  // Uploaded RGB is premultiplied: clear pixels contribute no hidden colour,
  // while the rain/clear boundary remains a feature the solver can follow.
  float intensity = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  fragColor = vec4(vec3(intensity), c.a);
}`;

const REFINE = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uFlow;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec2 prior = texture(uFlow, vUv).rg;
  float xx = 0.0, yy = 0.0, xy = 0.0, xt = 0.0, yt = 0.0;
  float residual = 0.0, weightSum = 0.0;
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      vec2 p = vUv + vec2(float(x), float(y)) * uStep;
      vec2 q = p + prior;
      // Do not learn motion from CLAMP_TO_EDGE's artificial image border.
      if (any(lessThan(p, uStep)) || any(greaterThan(p, 1.0-uStep))
          || any(lessThan(q, uStep)) || any(greaterThan(q, 1.0-uStep))) continue;
      float a = texture(uA, p).r;
      float b = texture(uB, q).r;
      vec2 grad = vec2(
        texture(uA, p+vec2(uStep.x,0)).r-texture(uA, p-vec2(uStep.x,0)).r,
        texture(uA, p+vec2(0,uStep.y)).r-texture(uA, p-vec2(0,uStep.y)).r) * 0.5;
      float dt = b-a;
      float weight = exp(-float(x*x+y*y)/8.0);
      xx += weight * grad.x * grad.x;
      yy += weight * grad.y * grad.y;
      xy += weight * grad.x * grad.y;
      xt += weight * grad.x * dt;
      yt += weight * grad.y * dt;
      residual += weight * abs(dt);
      weightSum += weight;
    }
  }
  float trace = xx+yy;
  float eigen = 0.5 * (trace-sqrt(max(0.0,(xx-yy)*(xx-yy)+4.0*xy*xy)));
  float confidence = smoothstep(0.00001, 0.0001, eigen/max(weightSum,1.0));
  // A ridge damps the weak direction (aperture problem). In textureless
  // areas the previous, coarser estimate survives unchanged.
  float ridge = max(0.01 * trace, 0.00001);
  float det = (xx+ridge)*(yy+ridge)-xy*xy;
  vec2 delta = vec2(-(yy+ridge)*xt+xy*yt, xy*xt-(xx+ridge)*yt)/det;
  // Each iteration is a local linearization; never trust a many-pixel step.
  delta *= min(1.0, 1.0/max(length(delta),0.00001));
  vec2 flow = prior + confidence * delta * uStep;
  float match = 1.0-smoothstep(0.05,0.2,residual/max(weightSum,1.0));
  fragColor = vec4(flow, confidence*match, 1.0);
}`;

const REGULARIZE = `#version 300 es
precision highp float;
uniform sampler2D uFlow;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 center = texture(uFlow,vUv);
  vec2 values[9];
  float weights[9];
  int i = 0;
  for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++) {
    vec4 v = texture(uFlow,vUv+vec2(float(x),float(y))*uStep);
    values[i] = v.rg/uStep;
    weights[i] = max(v.b,0.02) * (x==0 ? 2.0 : 1.0) * (y==0 ? 2.0 : 1.0);
    i++;
  }
  // Component medians reject isolated vectors before the confidence-weighted
  // average. A single large vector must not drag its neighbours with it.
  vec2 sorted[9];
  for (int j=0; j<9; j++) sorted[j]=values[j];
  for (int j=1; j<9; j++) for (int k=j; k>0; k--) {
    vec2 lo=min(sorted[k-1],sorted[k]);
    sorted[k]=max(sorted[k-1],sorted[k]);
    sorted[k-1]=lo;
  }
  vec2 median=sorted[4];
  vec2 sum=vec2(0.0);
  float total=0.0;
  for (int j=0; j<9; j++) {
    float distance=length(values[j]-median);
    float w=weights[j]/(1.0+4.0*distance*distance);
    sum+=w*values[j]; total+=w;
  }
  fragColor=vec4(sum/total*uStep,center.ba);
}`;

const COHERENCE = `#version 300 es
precision highp float;
uniform sampler2D uFlow;
uniform vec2 uStep;
in vec2 vUv;
out vec4 fragColor;
void main() {
  vec4 sum=vec4(0.0);
  for (int y=-1; y<=1; y++) for (int x=-1; x<=1; x++) {
    float w=(x==0 ? 2.0 : 1.0)*(y==0 ? 2.0 : 1.0);
    sum+=w*texture(uFlow,vUv+vec2(float(x),float(y))*uStep);
  }
  fragColor=sum/16.0;
}`;

export default class FlowRadar {
  constructor(gl, resolution = RADAR_FLOW_RESOLUTION) {
    this.gl = gl;
    this.resolution = resolution;
    this.fbo = gl.createFramebuffer();
    this.vbo = createFullscreenTriangle(gl);
    this.passes = [DOWNSAMPLE, REFINE, REGULARIZE, COHERENCE].map((fragment) => {
      const program = createProgram(gl, VERT, fragment);
      return {
        program,
        aPos: gl.getAttribLocation(program, 'aPos'),
        step: gl.getUniformLocation(program, 'uStep'),
        images: ['uImage', 'uA', 'uB', 'uFlow'].map((name) => gl.getUniformLocation(program, name)),
      };
    });
  }

  texture(width, height, flow = false) {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      flow ? gl.RGBA16F : gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      flow ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return { texture, width, height };
  }

  draw(pass, output, inputs, step) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output.texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('Radar flow framebuffer incomplete');
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
    gl.uniform2f(pass.step, step[0], step[1]);
    drawFullscreen(gl, this.vbo, pass.aPos);
  }

  compute(a, b) {
    const { gl } = this;
    const allocated = [];
    let result;
    const allocate = (w, h, flow = false) => {
      const value = this.texture(w, h, flow);
      allocated.push(value);
      return value;
    };
    const scale = Math.min(1, this.resolution / Math.max(a.width, a.height));
    const width = Math.max(1, Math.round(a.width * scale));
    const height = Math.max(1, Math.round(a.height * scale));
    const pyramid = (frame) => {
      let image = frame;
      do {
        const next = allocate(Math.max(width, Math.ceil(image.width / 2)), Math.max(height, Math.ceil(image.height / 2)));
        this.draw(this.passes[0], next, [image], [1 / image.width, 1 / image.height]);
        image = next;
      } while (image.width > width || image.height > height);
      const levels = [image];
      while (levels.length < 4 && Math.min(image.width, image.height) >= 24) {
        const next = allocate(Math.ceil(image.width / 2), Math.ceil(image.height / 2));
        this.draw(this.passes[0], next, [image], [1 / image.width, 1 / image.height]);
        image = next;
        levels.push(image);
      }
      return levels;
    };
    try {
      const aa = pyramid(a);
      const bb = pyramid(b);
      let flow = allocate(1, 1, true); // zero initial displacement
      for (let level = aa.length - 1; level >= 0; level--) {
        const current = aa[level];
        const step = [1 / current.width, 1 / current.height];
        const candidate = allocate(current.width, current.height, true);
        const regularized = allocate(current.width, current.height, true);
        for (let iteration = 0; iteration < 4; iteration++) {
          this.draw(this.passes[1], candidate, [null, current, bb[level], flow], step);
          this.draw(this.passes[2], regularized, [null, null, null, candidate], step);
          flow = regularized;
        }
      }
      // Local rain growth/decay can still give neighbouring patches different
      // answers. Smooth the velocity field before magnifying it onto the map;
      // constant translation is preserved and the source colours stay sharp.
      // Each binomial pass adds a fixed variance in grid pixels. Increasing
      // the analysis density must preserve its footprint in image coordinates,
      // otherwise finer estimates bring back the small edge distortions.
      const density = Math.max(1, Math.max(width, height) / 256);
      const coherencePasses = Math.ceil(12 * density * density);
      const smooth = [allocate(width, height, true), allocate(width, height, true)];
      for (let i = 0; i < coherencePasses; i++) {
        const next = smooth[i % 2];
        this.draw(this.passes[3], next, [null, null, null, flow], [1 / width, 1 / height]);
        flow = next;
      }
      result = flow;
      return result;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      for (const image of allocated) if (image !== result) gl.deleteTexture(image.texture);
    }
  }

  dispose() {
    const { gl } = this;
    this.passes.forEach((pass) => gl.deleteProgram(pass.program));
    gl.deleteFramebuffer(this.fbo);
    gl.deleteBuffer(this.vbo);
  }
}
