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
// Returns (u, v, quality, coverage). coverage = 0 outside the fetched field,
// on a cell without data, or outside every coverage disc (below); the
// callers let such a particle die. quality is the field's B channel
// (1 measured … 0 filled), alpha in the draw pass.
//
// COVERAGE DISCS (u_sites): the radar motion field is served over the
// composite's whole raster rectangle, filled from neighbours wherever there
// was no echo to match — 96 % of it on a typical day, corners over the
// Norwegian Sea and Russia included. The composite itself only holds data
// within each radar's range, so the particles are confined to the union of
// the sites' coverage discs, feathered over the outer 8 %. Discs are in
// EPSG:3857 units with the radius scaled by 1/cos(lat) at the site (the
// Mercator stretch varies ~6 % across a 250 km disc at 60°N — fine for a
// soft edge). No sites (a model field) means no mask.
const MAX_SITES = 16;
const FIELD_GLSL = `
uniform sampler2D u_field;
uniform vec4 u_extent;      // EPSG:3857 minx, miny, maxx, maxy of the canvas
uniform vec2 u_fieldOrigin; // lon, lat of the centre of cell (0, 0)
uniform vec2 u_fieldStep;   // degrees per cell
uniform vec2 u_fieldSize;   // cells
uniform float u_speedRange; // m/s encoded as byte 255 (byte 0 = -range)
uniform vec3 u_sites[${MAX_SITES}]; // x, y, radius in map units
uniform int u_siteCount;
const float R = 6378137.0;
const float PI = 3.141592653589793;
float coverage(vec2 m) {
  if (u_siteCount == 0) return 1.0;
  float c = 0.0;
  for (int i = 0; i < ${MAX_SITES}; i++) {
    if (i >= u_siteCount) break;
    float r = u_sites[i].z;
    c = max(c, 1.0 - smoothstep(r * 0.92, r, distance(m, u_sites[i].xy)));
  }
  return c;
}
vec4 sampleField(vec2 pos) {
  vec2 m = u_extent.xy + pos * (u_extent.zw - u_extent.xy);
  float lon = degrees(m.x / R);
  lon = mod(lon + 180.0, 360.0) - 180.0;
  float lat = degrees(2.0 * atan(exp(m.y / R)) - PI * 0.5);
  vec2 idx = (vec2(lon, lat) - u_fieldOrigin) / u_fieldStep;
  if (any(lessThan(idx, vec2(-0.5))) || any(greaterThan(idx, u_fieldSize - 0.5))) return vec4(0.0);
  vec4 f = texture(u_field, (idx + 0.5) / u_fieldSize);
  if (f.a < 0.5) return vec4(0.0);
  float cov = coverage(m);
  if (cov <= 0.0) return vec4(0.0);
  return vec4((f.rg * 2.0 - 1.0) * u_speedRange, f.b, cov);
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
  // Gentle gamma on the speed: linear motion makes a 3 m/s breeze crawl at
  // a quarter of a 12 m/s wind and leave no tail, and a calm day over
  // Finland then looks like nothing is happening. Exponent 0.75 about
  // 10 m/s lifts 3 m/s to 40 % of it while keeping 20 m/s clearly faster.
  float ms = length(s.xy);
  float shaped = ms > 0.0 ? pow(ms / 10.0, 0.75) * 10.0 / ms : 0.0;
  vec2 next = pos + s.xy * shaped * u_speedFactor / u_canvasSize;
  vec2 seed = (pos + v_uv) * u_seed;
  float speedT = min(ms / u_speedRange, 1.0);
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
//
// Speed colouring (SPEED_COLORS below): the core takes its colour from a
// 1-D ramp texture over the speed instead of the theme's single tone. The
// ramp is the same in both themes; the halo still follows the theme, which
// is what keeps the mid-tone colours legible over both basemaps.
const DRAW_VS = `#version 300 es
precision highp float;
${FIELD_GLSL}
uniform sampler2D u_particles;
uniform sampler2D u_ramp;
uniform float u_rampMax;
uniform float u_particlesRes;
uniform float u_pointSize;
uniform float u_speedColor;
out float v_alpha;
out vec3 v_rgb;
void main() {
  float i = float(gl_VertexID);
  vec2 uv = (vec2(mod(i, u_particlesRes), floor(i / u_particlesRes)) + 0.5) / u_particlesRes;
  vec2 pos = decodePos(texture(u_particles, uv));
  vec4 s = sampleField(pos);
  float ms = length(s.xy);
  float t = min(ms / 15.0, 1.0);
  // With colour carrying the speed, calm particles are barely dimmed — the
  // grey-blue already says calm, and dimming it too made a calm day over
  // Finland vanish against the dark basemap. The mono look keeps a mild
  // speed cue in the alpha.
  float calm = u_speedColor > 0.5 ? mix(0.85, 1.0, t) : mix(0.5, 1.0, t);
  v_alpha = calm * mix(0.33, 1.0, s.z) * s.w;
  v_rgb = texture(u_ramp, vec2(clamp(ms / u_rampMax, 0.0, 1.0), 0.5)).rgb;
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = u_pointSize;
}`;

// A round two-tone sprite rather than a square: a bright core (the particle)
// inside a faint halo of the opposite tone. The halo is what keeps a white
// particle readable over a bright satellite cloud and an ink one over a
// light basemap's water, without making the core heavy over the radar.
// Radii are fractions of the point: the core fills the inner ~55 %, the halo
// feathers to the edge. Output is premultiplied.
// highp to match the vertex shader: a uniform declared in both stages must
// agree on precision or the program fails to link.
const DRAW_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
uniform vec4 u_halo;
uniform float u_speedColor;
in float v_alpha;
in vec3 v_rgb;
out vec4 fragColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float core = 1.0 - smoothstep(0.4, 0.7, r);
  float halo = (1.0 - smoothstep(0.7, 1.0, r)) * (1.0 - core);
  float aCore = u_color.a * core;
  float aHalo = u_halo.a * halo;
  float a = (aCore + aHalo) * v_alpha;
  vec3 coreRgb = u_speedColor > 0.5 ? v_rgb : u_color.rgb;
  vec3 rgb = (coreRgb * aCore + u_halo.rgb * aHalo) * v_alpha;
  fragColor = vec4(rgb, a);
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

const FIELD_UNIFORMS = ['u_field', 'u_extent', 'u_fieldOrigin', 'u_fieldStep', 'u_fieldSize', 'u_speedRange', 'u_sites', 'u_siteCount'];

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
// the respawn rate) read as restless next to Windy. Long-lived particles give
// smooth continuous streamlines; a high drop rate gives popping. The Windy
// look is a clearly visible HEAD with a short tail, not a long thin streak —
// hence a fast fade (a tail of ~20 frames, 10–25 px at 10 m/s) and a fat, bright sprite: the
// tail is what covers the radar, the head is what the eye follows.
const FADE = 0.95;
const DROP_RATE = 0.001;
const DROP_RATE_BUMP = 0.004;
// Screen pixels per step per m/s at pixel ratio 1 (before the gamma in the
// update shader): a 10 m/s wind moves a particle 0.8 px per 60 Hz step,
// 48 px/s; 3 m/s about 20 px/s.
const SPEED_FACTOR = 0.08;
// Sprite diameter in CSS px, halo included (the core is ~55 % of it).
const POINT_SIZE = 3.2;
// Colour the core by speed instead of the theme tone. A code switch, not a
// user setting — flip it here to compare the two looks.
const SPEED_COLORS = true;
// The ramp, in m/s → [r, g, b], taken verbatim from Mapbox GL's
// raster-particle-layer example (docs.mapbox.com/mapbox-gl-js/example/
// raster-particle-layer): grey-blue calm, teal, green at 9, ochre at 12,
// orange-red at 15, crimson at 18, magenta, violet, slate, then lime from
// 33 m/s — a stepped ramp, each colour held over a band, so a reader can name
// the band. Clamped at RAMP_MAX like the example's raster-particle-max-speed.
const SPEED_RAMP = [
  [1.5, [134, 163, 171]],
  [2.5, [126, 152, 188]],
  [4.12, [110, 143, 208]],
  [4.63, [110, 143, 208]],
  [6.17, [15, 147, 167]],
  [7.72, [15, 147, 167]],
  [9.26, [57, 163, 57]],
  [10.29, [57, 163, 57]],
  [11.83, [194, 134, 62]],
  [13.37, [194, 134, 63]],
  [14.92, [200, 66, 13]],
  [16.46, [200, 66, 13]],
  [18.0, [210, 0, 50]],
  [20.06, [215, 0, 50]],
  [21.6, [175, 80, 136]],
  [23.66, [175, 80, 136]],
  [25.21, [117, 74, 147]],
  [27.78, [117, 74, 147]],
  [29.32, [68, 105, 141]],
  [31.89, [68, 105, 141]],
  [33.44, [194, 251, 119]],
  [42.18, [194, 251, 119]],
];
const RAMP_MAX = 40;
const RAMP_WIDTH = 256;

// The ramp as RGBA8 texels: linear between stops, held flat past the ends.
function buildRamp() {
  const data = new Uint8Array(RAMP_WIDTH * 4);
  for (let i = 0; i < RAMP_WIDTH; i++) {
    const ms = (i / (RAMP_WIDTH - 1)) * RAMP_MAX;
    let k = 0;
    while (k < SPEED_RAMP.length - 1 && SPEED_RAMP[k + 1][0] <= ms) k++;
    const [s0, c0] = SPEED_RAMP[k];
    const [s1, c1] = SPEED_RAMP[Math.min(k + 1, SPEED_RAMP.length - 1)];
    const f = s1 > s0 ? Math.min(1, Math.max(0, (ms - s0) / (s1 - s0))) : 0;
    for (let ch = 0; ch < 3; ch++) data[i * 4 + ch] = Math.round(c0[ch] + (c1[ch] - c0[ch]) * f);
    data[i * 4 + 3] = 255;
  }
  return data;
}

// The drawing buffer is handed to a pane's overlay canvas with
// transferToImageBitmap → transferFromImageBitmap when the browser has
// OffscreenCanvas + bitmaprenderer (Chrome, Firefox ≥ 105, Safari ≥ 17): a
// GPU-side move of the buffer, no copy, no readback. Without them the GL
// canvas is a DOM canvas and the pane draws it with a 2D drawImage — which on
// some desktop Chrome configurations is a full-screen readback per frame, the
// thing that made a 4K display stutter with the radar on.
export const ZERO_COPY = typeof OffscreenCanvas === 'function'
  && typeof ImageBitmapRenderingContext === 'function';

export default class ParticleRenderer {
  constructor() {
    this.canvas = ZERO_COPY ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
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
    this.drawU = uniforms(gl, this.drawProgram, [
      ...FIELD_UNIFORMS, 'u_particles', 'u_particlesRes', 'u_pointSize', 'u_color', 'u_halo', 'u_speedColor', 'u_ramp', 'u_rampMax',
    ]);
    this.rampTexture = createRgba8Texture(gl, RAMP_WIDTH, 1, buildRamp(), gl.LINEAR);
    this.fadeProgram = createProgram(gl, FULLSCREEN_VS, FADE_FS);
    this.fadeU = uniforms(gl, this.fadeProgram, ['u_tex', 'u_opacity']);
    this.fadeAttrib = gl.getAttribLocation(this.fadeProgram, 'a_pos');

    this.field = null;
    this.fieldTexture = null;
    this.sites = new Float32Array(MAX_SITES * 3);
    this.siteCount = 0;
    this.color = [1, 1, 1, 0.85];
    this.halo = [0, 0, 0, 0.3];
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

  // Coverage discs, [{ x, y, radius }] in EPSG:3857 units; [] for no mask.
  // Beyond MAX_SITES the rest are dropped.
  setMask(sites) {
    this.siteCount = Math.min(MAX_SITES, sites.length);
    this.sites.fill(0);
    for (let i = 0; i < this.siteCount; i++) {
      this.sites[i * 3] = sites[i].x;
      this.sites[i * 3 + 1] = sites[i].y;
      this.sites[i * 3 + 2] = sites[i].radius;
    }
  }

  // [r, g, b, a] in 0..1 each — the theme's particle core and halo colours.
  setColor(color, halo) {
    this.color = color;
    this.halo = halo;
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
    gl.uniform3fv(u.u_sites, this.sites);
    gl.uniform1i(u.u_siteCount, this.siteCount);
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
    // double the fade. The upper clamp is deliberately tight: at 1.5 a frame
    // rate that halves under a heavy map slows the flow by a quarter, where
    // the earlier 3 kept the pace by tripling every step and turned each tail
    // into a smear — the "blurred when the radar is on" of 4K desktops.
    const dtScale = state.lastStepMs
      ? Math.min(Math.max((nowMs - state.lastStepMs) / (1000 / 60), 0.25), 1.5)
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
    gl.uniform4f(this.drawU.u_halo, this.halo[0], this.halo[1], this.halo[2], Math.min(1, this.halo[3] * alphaScale));
    gl.uniform1f(this.drawU.u_speedColor, SPEED_COLORS ? 1 : 0);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    gl.uniform1i(this.drawU.u_ramp, 2);
    gl.uniform1f(this.drawU.u_rampMax, RAMP_MAX);
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

  // Hand the frame just rendered to a pane's overlay canvas. `target` is the
  // pane's ImageBitmapRenderingContext on the zero-copy path or its 2D
  // context otherwise; either way the overlay ends up at the simulation size
  // (the bitmap sets it; the 2D path resizes) and CSS scales it to the pane.
  present(target) {
    if (this.contextLost) return;
    if (ZERO_COPY) {
      let bitmap;
      try {
        bitmap = this.canvas.transferToImageBitmap();
      } catch (e) {
        // Only a lost context throws here; the tick rebuilds the renderer.
        this.contextLost = true;
        return;
      }
      // transferFromImageBitmap sizes the drawn bitmap but leaves the
      // canvas's width/height attributes alone; share.js scales an exported
      // canvas by them, so keep them at the simulation size (only on change
      // — assigning width clears a bitmaprenderer canvas).
      if (target.canvas.width !== bitmap.width || target.canvas.height !== bitmap.height) {
        target.canvas.width = bitmap.width;
        target.canvas.height = bitmap.height;
      }
      target.transferFromImageBitmap(bitmap);
      return;
    }
    const { width, height } = this.canvas;
    if (target.canvas.width !== width || target.canvas.height !== height) {
      target.canvas.width = width;
      target.canvas.height = height;
    } else {
      target.clearRect(0, 0, width, height);
    }
    target.drawImage(this.canvas, 0, 0);
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    const { gl } = this;
    if (!this.contextLost) {
      for (const s of this.states.values()) s.dispose();
      if (this.fieldTexture) gl.deleteTexture(this.fieldTexture);
      gl.deleteTexture(this.rampTexture);
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
