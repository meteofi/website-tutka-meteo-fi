// WebGL2 particle renderer behind the wind / precipitation-motion layer — the
// standard "windy" design: particle positions live in a texture, an update
// pass moves every particle by the field sampled at its position (with a
// random respawn so the field stays evenly seeded), a draw pass stamps the
// particles onto a ping-pong trail texture that is faded a little every frame,
// and a final pass puts the trail on the canvas.
//
// ONE GL CONTEXT FOR EVERY PANE. The interpolator already wants a context per
// (pane, pool) — up to 8 in 4-up — and browsers evict contexts past roughly
// 8–16, so this module owns a single offscreen context and keeps one
// `ParticleState` (positions + trails) per pane inside it. A pane draws by
// rendering its state into the shared canvas and copying that onto its own 2D
// canvas, which is what its ol/source/ImageCanvas hands to OpenLayers. The copy
// also does the upscale: the simulation runs at a capped pixel ratio (see
// windParticles.js) while the 2D canvas is the size OpenLayers asked for.
//
// COORDINATES. A particle's position is a fraction of the pane's canvas,
// (0, 0) at the south-west corner — so it survives pans and zooms unchanged
// (the trail is cleared instead, see clearTrails). The shaders turn that into
// an EPSG:3857 map coordinate through the view extent, then into lon/lat by
// the inverse Web-Mercator formula, then into a texel of the field texture
// whose origin is the centre of the south-west cell (windField.js). Mercator
// is conformal, so a field vector's direction is the same on screen as on the
// ground; its length is scaled to screen pixels by one constant, without the
// latitude factor — a 10 m/s wind flows at the same pace in Lapland as in
// Helsinki, which is what a reader expects of a symbol.
//
// TEXTURES ARE ALL RGBA8. Positions are 16-bit fixed point (two bytes per
// axis, the mapbox encoding), the field is bytes over a symmetric range, the
// trails are plain colour. Nothing needs a float render target or half-float
// filtering — the two things the interpolator has to probe and work around.
// Colour is kept PREMULTIPLIED in the trail texture so the per-frame fade is
// a plain multiply of all four channels and the canvas (default
// premultipliedAlpha) shows it without a second multiply.

import { createProgram, createFullscreenTriangle, drawFullscreen } from '../animation/interpolation/glUtils';

// The trail fade multiplies every channel and is floored to whole bytes: with
// plain rounding a 1/255 channel times 0.96 rounds straight back to 1/255 and
// the faintest trails never disappear (the classic windy artifact).
const FULLSCREEN_VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Shared by the update and draw shaders: canvas fraction → m/s at that point.
// Returns (u, v, quality, valid). valid = 0 outside the fetched field or on a
// cell without data; the callers let such a particle die. quality is the
// field's B channel (1 measured … 0 filled), alpha in the draw pass.
const FIELD_GLSL = `
uniform sampler2D u_field;
uniform vec4 u_extent;      // EPSG:3857 minx, miny, maxx, maxy of the canvas
uniform vec2 u_fieldOrigin; // lon, lat of the centre of cell (0, 0)
uniform vec2 u_fieldStep;   // degrees per cell
uniform vec2 u_fieldSize;   // cells
uniform float u_speedRange; // m/s encoded as byte 255 (byte 0 = -range)
const float R = 6378137.0;
const float PI = 3.141592653589793;
vec4 sampleField(vec2 pos) {
  vec2 m = u_extent.xy + pos * (u_extent.zw - u_extent.xy);
  float lon = degrees(m.x / R);
  lon = mod(lon + 180.0, 360.0) - 180.0;
  float lat = degrees(2.0 * atan(exp(m.y / R)) - PI * 0.5);
  vec2 idx = (vec2(lon, lat) - u_fieldOrigin) / u_fieldStep;
  if (any(lessThan(idx, vec2(-0.5))) || any(greaterThan(idx, u_fieldSize - 0.5))) return vec4(0.0);
  vec4 f = texture(u_field, (idx + 0.5) / u_fieldSize);
  if (f.a < 0.5) return vec4(0.0);
  return vec4((f.rg * 2.0 - 1.0) * u_speedRange, f.b, 1.0);
}
vec2 decodePos(vec4 c) { return c.ba + c.rg / 255.0; }
`;

const UPDATE_FS = `#version 300 es
precision highp float;
${FIELD_GLSL}
uniform sampler2D u_particles;
uniform vec2 u_canvasSize;   // simulation pixels
uniform float u_speedFactor; // pixels per step per m/s
uniform float u_dropRate;
uniform float u_dropRateBump;
uniform float u_seed;
in vec2 v_uv;
out vec4 fragColor;
float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec2 pos = decodePos(texture(u_particles, v_uv));
  vec4 s = sampleField(pos);
  vec2 next = pos + s.xy * u_speedFactor / u_canvasSize;
  vec2 seed = (pos + v_uv) * u_seed;
  float speedT = min(length(s.xy) / u_speedRange, 1.0);
  float drop = s.w < 0.5 ? 1.0 : u_dropRate + speedT * u_dropRateBump;
  bool gone = any(lessThan(next, vec2(0.0))) || any(greaterThan(next, vec2(1.0)));
  if (gone || rand(seed) < drop) {
    next = vec2(rand(seed + 1.3), rand(seed + 2.1));
  }
  fragColor = vec4(fract(next * 255.0), floor(next * 255.0) / 255.0);
}`;

// gl_VertexID indexes the position texture, so the draw needs no vertex
// buffer at all (WebGL2 permits a draw with no enabled attributes). The speed
// normaliser is a fixed 15 m/s rather than the field's range so calm regions
// look calm on every field, not relative to the day's strongest gust. Quality
// scales alpha too: a radar block filled from its neighbours (no echo to
// match) draws at a third, so particles concentrate where it is raining and
// go faint over clear sky — the issue's "masked for radar" styling — while a
// model field (quality 1 everywhere) is untouched.
const DRAW_VS = `#version 300 es
precision highp float;
${FIELD_GLSL}
uniform sampler2D u_particles;
uniform float u_particlesRes;
uniform float u_pointSize;
out float v_alpha;
void main() {
  float i = float(gl_VertexID);
  vec2 uv = (vec2(mod(i, u_particlesRes), floor(i / u_particlesRes)) + 0.5) / u_particlesRes;
  vec2 pos = decodePos(texture(u_particles, uv));
  vec4 s = sampleField(pos);
  float t = min(length(s.xy) / 15.0, 1.0);
  v_alpha = mix(0.35, 1.0, t) * mix(0.33, 1.0, s.z) * s.w;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = u_pointSize;
}`;

const DRAW_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
in float v_alpha;
out vec4 fragColor;
void main() {
  float a = u_color.a * v_alpha;
  fragColor = vec4(u_color.rgb * a, a);
}`;

const FADE_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_opacity;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  fragColor = floor(255.0 * c * u_opacity) / 255.0;
}`;

function createRgba8Texture(gl, width, height, data, filter) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function uniforms(gl, program, names) {
  const out = {};
  for (const n of names) out[n] = gl.getUniformLocation(program, n);
  return out;
}

const FIELD_UNIFORMS = ['u_field', 'u_extent', 'u_fieldOrigin', 'u_fieldStep', 'u_fieldSize', 'u_speedRange'];

// Per-pane simulation state: `count` particles in a res × res position
// texture (rounded up to a square), trails at the pane's simulation size.
// A plain object rather than a second class — the renderer is the only thing
// that touches it.
function createState(gl, width, height, count) {
  const res = Math.ceil(Math.sqrt(count));
  const seed = new Uint8Array(res * res * 4);
  for (let i = 0; i < seed.length; i++) seed[i] = Math.floor(Math.random() * 256);
  const state = {
    width,
    height,
    res,
    count: res * res,
    positions: [
      createRgba8Texture(gl, res, res, seed, gl.NEAREST),
      createRgba8Texture(gl, res, res, seed, gl.NEAREST),
    ],
    trails: [
      createRgba8Texture(gl, width, height, null, gl.NEAREST),
      createRgba8Texture(gl, width, height, null, gl.NEAREST),
    ],
    fbo: gl.createFramebuffer(),
    lastStepMs: 0,
    dispose() {
      for (const t of state.positions) gl.deleteTexture(t);
      for (const t of state.trails) gl.deleteTexture(t);
      gl.deleteFramebuffer(state.fbo);
    },
  };
  return state;
}

// Tunables. Rates are per 60 Hz step; the renderer scales them by the actual
// frame interval so a 120 Hz display and a struggling 30 Hz phone flow alike.
//
// Tuned toward calm: this layer sits OVER the radar and the reader must still
// see the echoes through it, and the first cut (twice the speed, three times
// the respawn rate, fuller colour) read as restless next to Windy. Long-lived
// particles with a slow fade give smooth continuous streamlines; a high drop
// rate gives popping.
const FADE = 0.97;
const DROP_RATE = 0.001;
const DROP_RATE_BUMP = 0.004;
// Screen pixels per step per m/s at pixel ratio 1: a 10 m/s wind moves a
// particle 0.6 px per 60 Hz step, 36 px/s.
const SPEED_FACTOR = 0.06;
const POINT_SIZE = 1.1;

export default class ParticleRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      // The 2D copy happens synchronously right after the draw, inside the
      // same canvasFunction call, so the buffer is never read out of phase.
      preserveDrawingBuffer: false,
    });
    if (!this.gl) throw new Error('ParticleRenderer: WebGL2 unavailable');
    const { gl } = this;
    this.contextLost = false;
    this._onContextLost = (e) => {
      e.preventDefault();
      this.contextLost = true;
    };
    this.canvas.addEventListener('webglcontextlost', this._onContextLost);

    this.triangle = createFullscreenTriangle(gl);
    this.updateProgram = createProgram(gl, FULLSCREEN_VS, UPDATE_FS);
    this.updateU = uniforms(gl, this.updateProgram, [
      ...FIELD_UNIFORMS, 'u_particles', 'u_canvasSize', 'u_speedFactor', 'u_dropRate', 'u_dropRateBump', 'u_seed',
    ]);
    this.updateAttrib = gl.getAttribLocation(this.updateProgram, 'a_pos');
    this.drawProgram = createProgram(gl, DRAW_VS, DRAW_FS);
    this.drawU = uniforms(gl, this.drawProgram, [...FIELD_UNIFORMS, 'u_particles', 'u_particlesRes', 'u_pointSize', 'u_color']);
    this.fadeProgram = createProgram(gl, FULLSCREEN_VS, FADE_FS);
    this.fadeU = uniforms(gl, this.fadeProgram, ['u_tex', 'u_opacity']);
    this.fadeAttrib = gl.getAttribLocation(this.fadeProgram, 'a_pos');

    this.field = null;
    this.fieldTexture = null;
    this.color = [1, 1, 1, 0.85];
    this.states = new Map();
  }

  hasField() {
    return !!this.field && !this.contextLost;
  }

  // Upload an encoded field (windField.js encodeField + grid geometry).
  // Every pane samples this one texture — the panes share a view, so they
  // share a field.
  setField(field) {
    if (this.contextLost) return;
    const { gl } = this;
    if (this.fieldTexture) gl.deleteTexture(this.fieldTexture);
    this.fieldTexture = createRgba8Texture(gl, field.nx, field.ny, field.data, gl.LINEAR);
    this.field = field;
  }

  clearField() {
    if (this.fieldTexture && !this.contextLost) this.gl.deleteTexture(this.fieldTexture);
    this.fieldTexture = null;
    this.field = null;
  }

  // [r, g, b, a] in 0..1 — the theme's particle colour.
  setColor(color) {
    this.color = color;
  }

  // The pane's simulation state, rebuilt when its size changes.
  stateFor(key, width, height, count) {
    let state = this.states.get(key);
    if (state && (state.width !== width || state.height !== height)) {
      state.dispose();
      state = null;
    }
    if (!state) {
      state = createState(this.gl, width, height, count);
      this.states.set(key, state);
    }
    return state;
  }

  releaseState(key) {
    const state = this.states.get(key);
    if (state) {
      if (!this.contextLost) state.dispose();
      this.states.delete(key);
    }
  }

  hasState(key) {
    return this.states.has(key);
  }

  // The view moved: the positions (canvas fractions) stay valid, the trails
  // would smear across the jump, so blank them.
  clearTrails(key) {
    const state = this.states.get(key);
    if (!state || this.contextLost) return;
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.fbo);
    gl.clearColor(0, 0, 0, 0);
    for (const t of state.trails) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _bindFieldUniforms(u, extent, pixelRatio) {
    const { gl, field } = this;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTexture);
    gl.uniform1i(u.u_field, 1);
    gl.uniform4f(u.u_extent, extent[0], extent[1], extent[2], extent[3]);
    gl.uniform2f(u.u_fieldOrigin, field.lon0, field.lat0);
    gl.uniform2f(u.u_fieldStep, field.dLon, field.dLat);
    gl.uniform2f(u.u_fieldSize, field.nx, field.ny);
    gl.uniform1f(u.u_speedRange, field.range);
    return pixelRatio;
  }

  // Advance one pane's particles by the elapsed wall-clock time and draw its
  // trail into this.canvas (resized to the state's simulation size). Returns
  // false when there is nothing to draw (no field / lost context).
  //   extent     — EPSG:3857 extent the canvas covers
  //   pixelRatio — simulation pixels per CSS pixel (scales speed and size)
  //   nowMs      — performance.now()
  //   look       — { pointScale, alphaScale }: the caller's per-device
  //                emphasis (phones draw bigger and brighter)
  render(key, extent, pixelRatio, nowMs, { pointScale = 1, alphaScale = 1 } = {}) {
    if (!this.hasField()) return false;
    const state = this.states.get(key);
    if (!state) return false;
    const { gl } = this;
    // Steps per 60 Hz frame, clamped: a long gap (tab hidden, GC pause) must
    // not fling every particle across the map, and a 120 Hz display must not
    // double the fade.
    const dtScale = state.lastStepMs
      ? Math.min(Math.max((nowMs - state.lastStepMs) / (1000 / 60), 0.25), 3)
      : 1;
    state.lastStepMs = nowMs;

    if (this.canvas.width !== state.width || this.canvas.height !== state.height) {
      this.canvas.width = state.width;
      this.canvas.height = state.height;
    }

    // 1. Fade the previous trail into the other trail texture, blending off.
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.trails[1], 0);
    gl.viewport(0, 0, state.width, state.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.fadeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.trails[0]);
    gl.uniform1i(this.fadeU.u_tex, 0);
    gl.uniform1f(this.fadeU.u_opacity, FADE ** dtScale);
    drawFullscreen(gl, this.triangle, this.fadeAttrib);

    // 2. Stamp the particles on top, premultiplied over.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.drawProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.positions[0]);
    gl.uniform1i(this.drawU.u_particles, 0);
    this._bindFieldUniforms(this.drawU, extent, pixelRatio);
    gl.uniform1f(this.drawU.u_particlesRes, state.res);
    gl.uniform1f(this.drawU.u_pointSize, POINT_SIZE * pixelRatio * pointScale);
    gl.uniform4f(this.drawU.u_color, this.color[0], this.color[1], this.color[2], Math.min(1, this.color[3] * alphaScale));
    gl.disableVertexAttribArray(this.updateAttrib);
    gl.drawArrays(gl.POINTS, 0, state.count);
    gl.disable(gl.BLEND);

    // 3. Move the particles into the other position texture.
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.positions[1], 0);
    gl.viewport(0, 0, state.res, state.res);
    gl.useProgram(this.updateProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.positions[0]);
    gl.uniform1i(this.updateU.u_particles, 0);
    this._bindFieldUniforms(this.updateU, extent, pixelRatio);
    gl.uniform2f(this.updateU.u_canvasSize, state.width, state.height);
    gl.uniform1f(this.updateU.u_speedFactor, SPEED_FACTOR * pixelRatio * dtScale);
    gl.uniform1f(this.updateU.u_dropRate, DROP_RATE * dtScale);
    gl.uniform1f(this.updateU.u_dropRateBump, DROP_RATE_BUMP * dtScale);
    gl.uniform1f(this.updateU.u_seed, Math.random());
    drawFullscreen(gl, this.triangle, this.updateAttrib);

    // 4. Present the new trail on the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, state.width, state.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.fadeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.trails[1]);
    gl.uniform1i(this.fadeU.u_tex, 0);
    gl.uniform1f(this.fadeU.u_opacity, 1);
    drawFullscreen(gl, this.triangle, this.fadeAttrib);

    state.trails.reverse();
    state.positions.reverse();
    return true;
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    const { gl } = this;
    if (!this.contextLost) {
      for (const s of this.states.values()) s.dispose();
      if (this.fieldTexture) gl.deleteTexture(this.fieldTexture);
      gl.deleteBuffer(this.triangle);
      gl.deleteProgram(this.updateProgram);
      gl.deleteProgram(this.drawProgram);
      gl.deleteProgram(this.fadeProgram);
    }
    this.states.clear();
    this.fieldTexture = null;
    this.field = null;
    // Give the context back now rather than when the GC gets to the canvas:
    // it is the whole reason the renderer is built and torn down with the
    // layer toggle.
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose && !this.contextLost) lose.loseContext();
  }
}
