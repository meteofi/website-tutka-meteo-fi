# Radar Animation: Optical Flow Frame Interpolation

Handoff plan for Claude Code. Target repo: `website-tutka-meteo-fi`.

## Problem

Radar animation at 5-minute cadence feels jumpy. Crossfade between consecutive frames is rejected because it produces a "pumping" visual — reflectivity appears to grow/shrink rather than move. We need true motion-compensated interpolation.

## Constraints

- **No backend changes.** Only existing WMS endpoints may be used.
- **Full-size images, not tiles.** App already fetches single WMS images per timestep.
- **Mobile must work or degrade gracefully.** iPhones and mid-range Androids.
- **Caching stays.** `src/animation/framePool.js` + `src/animation/stickyImageWMS.js` already implement a 13-slot pool with sliding windows and stale-while-loading. Interpolation layers on top, doesn't replace.
- **Vanilla JS + OpenLayers**, airbnb-base ESLint, no framework churn.

## Existing cache — verified read of the codebase

Before writing any new code, understand what's already there. The `FramePool` is well-designed and dictates the integration shape.

**Topology.** Pool of N=13 invisible `ImageLayer`s, each with its own `StickyImageWMS` source pinned to one `TIME`. The primary (visible) layer doesn't hold frames itself — on each tick `showTime(t)` calls `primary.setSource(slot.source)` to point the primary at whichever slot matches. Instant swap, no refetch. This is exactly the right shape for interpolation too.

**Cache identity per slot.** Slots are keyed by TIME, but the pool tracks these WMS params as the "slot identity" via `SYNC_PARAM_KEYS`:

```js
const SYNC_PARAM_KEYS = ['LAYERS', 'STYLES', 'FORMAT', 'ELEVATION'];
```

When the primary's source changes any of these, `_watchPrimarySource` → `_resyncAllParams` updates every slot's params and calls `invalidateSticky()` on each. Consequence: **every STYLES switch triggers a full 13-frame refetch.**

**View coverage.** Extent/resolution are not in the slot key explicitly — instead, each slot holds one image at one world extent, and `StickyImageWMS.hasLoadedImageForView(extent, resolution, pixelRatio, projection)` checks at `moveend` whether the cached image still covers the view. If not, `slot.loaded` flips false and the slot re-fetches for the new view on next prefetch. So pan/zoom invalidates per-slot, not by rebuilding keys.

**Window sliding.** `setWindow(newTimes)` preserves slots whose TIME is still in the new window and reassigns only the slots whose TIME dropped out. Typical window slide keeps 12 of 13 slots.

**Prefetch strategy.** `_prefetchAroundCurrent()` kicks off current + next + next+1. `_advanceFrontier()` fires on each `imageloadend` to trigger the next couple of upcoming frames — forward-biased because playback is almost always forward. Cap of 2 new requests per completion.

**No BBOX cache key needed.** The combination of per-slot sticky-with-view-check + slot reassignment on window slide gives us an implicit cache that survives view changes cleanly. Our flow cache should follow the same per-slot pattern rather than inventing a hash key.

**Pool instances.** Four separate pools, one per category: `satelliteLayer`, `radarLayer`, `lightningLayer`, `observationLayer` (see `radar.js` around L1572–1585). Interpolation applies to `satelliteLayer` and `radarLayer` only.

## STYLES independence — the important insight

The user correctly observed: **flow fields represent physical motion and should be invariant under STYLES change.** A DBZ vs rain-rate colormap swap shouldn't invalidate motion estimates.

What this means for the design:

- **Frame bitmap cache** is STYLES-dependent (already is — rendered RGB pixels). Existing FramePool behavior unchanged.
- **Flow cache** is STYLES-independent. Key by `{LAYERS, ELEVATION, URL, slotTime_A, slotTime_B, viewEpoch}` — explicitly exclude STYLES and FORMAT.
- Flow computed from style-A pixels gets reused when displaying style-B pixels. Not mathematically identical (different RGB → slightly different gradients → slightly different flow) but physically correct: motion is a property of the atmosphere, not the colormap. The reuse is a pragmatic win; the alternative — recomputing flow on every style switch — wastes real CPU/GPU time for negligible visual gain.
- On style switch: frame bitmaps invalidate (existing behavior kicks in, pool refetches). Flow cache is **preserved**. When new bitmaps land, warp with existing flow — no interpolation gap.
- ELEVATION must stay in the flow key because it selects a different physical field (different altitude slice), not a different rendering of the same field.

Only one caveat: if a style has a stepped colormap with large flat regions (classical radar palettes do this at low dBZ), the flow computed from it will be noisy in those regions. Compute flow from the highest-contrast style available when a choice exists. For the v1 implementation: compute from whatever style is active when the frame pair first becomes loadable. Good enough.

**View change invalidation.** Flow is computed from pixels in a specific world extent. When a pan/zoom causes slot-level sticky invalidation, any flow pair involving that slot must also invalidate. Hook into the same `moveend` path `FramePool` already uses — when a slot transitions `loaded: true → false` due to view change, drop flow fields referencing that slot.

## Decision

**Client-side pyramidal Lucas–Kanade optical flow in WebGL2**, pre-computed per pair on prefetch, with a motion-compensated warp shader during playback.

Rejected alternatives:
- Crossfade — pumping, user rejected.
- OpenCV.js Farnebäck — 8 MB WASM, inconsistent mobile SIMD, slower on phones than GPU.
- Server-side pysteps — violates "no backend changes" constraint.

## Architecture

Two decoupled stages:

1. **Flow computation** — expensive, runs once per consecutive frame pair during prefetch. Produces a flow field texture (RG16F, ~256×256) stored in memory keyed by `(timeA, timeB)`.
2. **Warp rendering** — cheap, runs every animation frame. Fragment shader samples frame A and frame B with displaced UVs and blends.

This split is what makes it smooth — no flow recomputation during playback.

## New module layout

Co-located with the existing animation code — they're tightly coupled:

```
src/
  animation/
    framePool.js            (existing, ~3 small edits)
    stickyImageWMS.js       (existing, unchanged)
    interpolation/
      index.js              public API: RadarInterpolator, canInterpolate
      capabilities.js       runtime feature probe, benchmark, gating
      flowCache.js          keyed flow storage, STYLES-invariant
      flowLK.js             pyramidal Lucas–Kanade in WebGL2
      warp.js               motion-compensated warp shader + renderer
      canvasSource.js       ol/source wrapper that exposes the warp canvas
      shaders/
        lkGradient.frag     Sobel gradients
        lkSolve.frag        2x2 system solve per pixel
        warp.frag           final display warp
        common.vert         fullscreen triangle
      glUtils.js            FBO, texture, program helpers
```

## Public API

```js
import { RadarInterpolator, canInterpolate } from './interpolation/index.js';

const interp = new RadarInterpolator({
  gl: offscreenGL,              // shared WebGL2 context
  flowResolution: 256,          // compute flow at this size
  pyramidLevels: 3,
  iterations: 5,                // LK iterations per level
  // No `subframes` param: playback `t` is driven continuously by the RAF
  // loop (see §Playback loop refactor), so perceived smoothness is bounded
  // by display refresh rate, not a configured count.
});

// Called by the existing cache as frames arrive
interp.registerFrame(timeISO, imageBitmap);

// Called when a new pair becomes available (frame N and N+1 both cached)
await interp.computeFlow(timeA, timeB);   // ~30-80ms @ 256²

// Called by the existing animation loop at any t
const canvas = interp.renderAt(timeA, timeB, t);  // t ∈ [0,1]
// Blit canvas into the existing OpenLayers ImageLayer source
```

The interpolator does **not** know about OpenLayers, WMS, or the cache. It takes ImageBitmaps and timestamps, returns a canvas. This keeps it testable and replaceable.

## Integration points — concrete, based on actual code

Three places, and only three. Keep the diff to `radar.js` minimal by doing the work inside `src/animation/`.

**1. `src/animation/framePool.js` — frame registration hook.**
After each successful load in the `imageloadend` handler (around L74–96), the slot's source has a LOADED `HTMLImageElement` (`event.image.getImage()`). That's our bitmap. Pass it to the interpolator:

```js
source.on('imageloadend', (event) => {
  if (event.image !== slot.source.image) return;
  slot.loaded = true;
  slot.source.setSticky(event.image);
  this._notifyLoadChange(slot);
  if (this.primary.getSource() === slot.source) this.primary.changed();
  this.map.render();
  this._advanceFrontier();
  // NEW: feed the interpolator
  if (this.interpolator) {
    this.interpolator.onSlotLoaded(slot, event.image);
  }
});
```

Inject the interpolator via constructor option, default null. Pools that don't interpolate (lightning, observation) pass nothing.

**2. `src/animation/framePool.js` — showTime becomes interpolatable.**
Today `showTime(time)` does a discrete source swap. For interpolation, introduce a second method:

```js
showInterpolated(timeA, timeB, t) {
  // If t === 0 → same as showTime(timeA)
  // If t === 1 → same as showTime(timeB)
  // Otherwise: swap primary to a canvas-backed source that the
  // interpolator paints each frame.
}
```

The interpolated path uses a custom `ol.source.ImageCanvas` (or a thin subclass of `ImageWMS` that hijacks `getImage` to return our warped canvas). The canvas lives in the interpolator; the source just hands OL a reference. On each playback RAF, interpolator draws frame(A, B, t), canvas updates, `source.changed()`, OL redraws.

The existing `showTime` stays for discrete stepping (`j`/`l`/space keys) and for scrubber drags.

**3. `src/animation/framePool.js` — STYLES switch preserves flow.**
In `_resyncAllParams` (L175–191), after `invalidateSticky()`, notify the interpolator which param actually changed. If only STYLES or FORMAT changed, the interpolator keeps its flow cache; if LAYERS/ELEVATION/URL changed, drop it.

```js
_resyncAllParams() {
  // ... existing resync ...
  if (this.interpolator) {
    const prev = this._primaryParamsSnap;   // old snap
    const now = this._snapPrimary();         // new snap (or take before update)
    const flowInvariant = (prev.layers === now.layers
                        && prev.elevation === now.elevation
                        && prev.url === now.url);
    this.interpolator.onParamsChanged({ flowInvariant });
  }
}
```

(Small refactor needed: capture the previous snap before overwriting, currently `this._primaryParamsSnap = snap` runs inside `_watchPrimarySource` before `_resyncAllParams` is called. Reorder or pass prev in as an arg.)

**4. `src/radar.js` — wire it up and refactor the playback loop.**

Two parts. The wire-up is small; the playback refactor is a prerequisite that
has to land first.

**4a. Pool wire-up** (L1757–1770 today, where the four pools are constructed).
`main` is currently `const main = () => {…}` (not async) and invokes a chain
of sync setup that depends on pool existence (`setTime('last')` at L1826
calls `pool.setWindow`/`pool.showTime`). Either make `main` async
explicitly, or run the capability probe at module load and expose it as a
Promise so pool construction can proceed without blocking boot:

```js
import { RadarInterpolator, canInterpolate } from './animation/interpolation';

// module-scope; resolves before the user can press play
let interpEnabled = false;
const interpReady = canInterpolate().then((ok) => { interpEnabled = ok; });

// inside main():
for (const [name, layer] of pairs) {
  const opts = { primaryLayer: layer, map };
  if (interpEnabled && (name === 'radarLayer' || name === 'satelliteLayer')) {
    opts.interpolator = new RadarInterpolator({ gl: sharedGL, /* ... */ });
  }
  const pool = new FramePool(opts);
  // ...
}
```

Create `sharedGL` once outside the loop — both radar and satellite
interpolators share a single offscreen WebGL2 context so that GPU memory
and state are coherent. Nothing else in the app needs GL.

**4b. Playback loop refactor** (touches `play` / `stop` / `setTime` around
L556–715). Today `play()` is `setInterval(setTime, 1000 / frameRate)` and
each tick advances the timestep by a full 5-minute frame. That is the only
animation loop; it fires at 2 Hz. Interpolation needs a continuous
`t ∈ [0, 1]` between consecutive timesteps, which today does not exist —
without this refactor, `renderAt(A, B, t)` has no caller and Phase 2+ is
dead on arrival.

Split playback into two cadences:

- **Advance cadence** (slow): when `performance.now() - lastAdvance ≥
  stepDuration`, run the existing `setTime` advance logic to pick the next
  (A, B) pair, reset `lastAdvance`. `stepDuration = 1000 / frameRate`
  (today 500 ms at frameRate=2). Existing speed control still works.
- **Render cadence** (fast): a single `requestAnimationFrame` loop computes
  `t = Math.min(1, (performance.now() - lastAdvance) / stepDuration)` and
  asks each visible pool to render at `(A, B, t)`. If the pool has no
  interpolator — or the interpolator has no flow for (A, B) yet — it falls
  back to `showTime(A)`, visually identical to today. Non-interpolating
  pools (lightning, observation) always ignore `t`.

Keyboard shortcuts (`j`/`k`/`l`/space) and scrubber drags stay discrete:
they set `startDate` directly, call `showTime`, and reset `lastAdvance` so
the next continuous-play tick picks up from a clean state. Only continuous
playback via `play()` goes through the RAF-interpolated path.

The existing `isInteracting` gate (L667, L678) stays — skip both advance
and render while the user is panning/zooming, same as today.

## View-change invalidation wiring

The existing `moveend` handler (L106–129) is already the right place. Extend it:

```js
map.on('moveend', () => {
  const ctx = this._getViewContext();
  if (ctx) {
    for (const slot of this.slots) {
      if (!slot.time) continue;
      const fresh = slot.source.hasLoadedImageForView(/*...*/);
      if (slot.loaded !== fresh) {
        slot.loaded = fresh;
        this._notifyLoadChange(slot);
        // NEW: if slot became stale, invalidate flow pairs referencing it
        if (!fresh && this.interpolator) {
          this.interpolator.invalidateSlot(slot.time);
        }
      }
    }
  }
  this._prefetchAroundCurrent();
});
```

**Window-slide invalidation** (distinct from moveend). When
`setWindow(newTimes)` reassigns a slot (framePool.js:281–295), the slot's
`time` attribute is overwritten in place. Capture the *old* time BEFORE
reassignment so `interpolator.invalidateSlot(oldTime)` has something to
work with — any flow pair referencing the dropped time is dropped.
Symmetrically, as new TIMEs arrive and their `imageloadend` fires,
`onSlotLoaded` should check both neighboring pairs (prev, this) and
(this, next) for eligibility and trigger flow computation when both
endpoints are loaded. Typical window slide drops 1 slot and invalidates
at most 2 pairs.

## Feature gating

In `capabilities.js`:

```js
export async function canInterpolate() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return false;
  // iOS 15.4+ stopped exposing EXT_color_buffer_float and switched to
  // EXT_color_buffer_half_float. Either enables RG16F render targets,
  // which is all we need for flow fields. Accept either, then probe a
  // 1×1 RG16F FBO for completeness before trusting the extension —
  // presence of the extension does not guarantee FBO-completeness in
  // every mobile driver.
  const hasHalf = !!gl.getExtension('EXT_color_buffer_half_float');
  const hasFull = !!gl.getExtension('EXT_color_buffer_float');
  if (!hasHalf && !hasFull) return false;
  if (!probeRg16fFboComplete(gl)) return false;

  // Memory hint (undefined on Safari — don't fail there, let benchmark decide)
  if (navigator.deviceMemory !== undefined && navigator.deviceMemory < 3) {
    return false;
  }

  // Micro-benchmark: run one flow computation on a 256² synthetic pair.
  // If it takes >150ms, device is too slow — fall back.
  const ms = await benchmarkFlowOnce(gl, 256);
  return ms < 150;
}
```

Cache the result in localStorage with a 7-day TTL so we don't re-benchmark every page load.

Also expose a manual override via query string (`?interp=off` / `?interp=on`)
for debugging and for users who want to force a behavior. Do **not** use the
URL hash — `ol-hashed` (imported at `radar.js:12`, called at L1843) owns the
hash and will strip anything it doesn't recognize on the next map update.

## Mobile specifics

- **Flow at 256×256, warp at display resolution.** Flow fields are smooth; downsampling costs almost nothing visually and drops compute 16×.
- **Memory budget (redone with real numbers).** WMS images are
  viewport-size × `imageRatio` (1.5 per `radar.js:47,295,309,322,335`). On a
  1920×1080 desktop window each frame is ~2880×1620 × RGBA ≈ 18 MB; 13 slots
  × 2 interpolating pools ≈ 486 MB of frame texture memory if we duplicate
  them onto the GPU. On a typical phone (~390×844) it's ~3 MB × 26 ≈ 78 MB.
  Desktop, not mobile, is the pressure case.
  - Mitigations: do **not** keep a second GPU copy of every slot bitmap —
    upload to GL only when a pair is about to be warped, and release when
    the pair leaves the current ± 1 window. Two live pairs per pool (A→B
    current, B→C next) × 2 pools × 2 textures ≈ 8 frame textures resident.
  - Flow at 256² × RG16F is cheap (~0.5 MB per pair × 12 pairs × 2 pools
    ≈ 12 MB). Warp upsamples bilinearly to display resolution; that's
    acceptable for meteorological data and keeps the flow cache trivial.
  - Evict oldest flow fields first on pressure; they recompute in 30–80 ms.
- **Handle `webglcontextlost`** on the shared GL context. On restore, invalidate all cached flow textures and recompute lazily. Do **not** crash playback — fall back to discrete-switch until context is back.
- **Background tab**: iOS Safari evicts WebGL contexts aggressively. Pause playback on `visibilitychange` to `hidden`, flag everything as dirty on return.

## Pyramidal Lucas–Kanade implementation notes

Standard coarse-to-fine LK. Pseudocode for `flow-lk.js`:

```
build_pyramid(frameA) -> [A0, A1, A2]   // downsample 2x each level
build_pyramid(frameB) -> [B0, B1, B2]
flow = zeros(coarsest_size)
for level in reversed(range(levels)):
  flow = upsample(flow) * 2              // carry estimate from coarser level
  for iter in range(iterations):
    warped_B = warp(B[level], flow)
    Ix, Iy = sobel(A[level])
    It = warped_B - A[level]
    # Solve 2x2 normal equations per pixel in a fragment shader:
    # [ΣIx²  ΣIxIy] [u]   [-ΣIxIt]
    # [ΣIxIy ΣIy² ] [v] = [-ΣIyIt]
    # Use a 5x5 or 7x7 window (separable box blur on the products).
    du, dv = solve_per_pixel()
    flow += (du, dv)
return flow
```

All of this runs in fragment shaders with ping-pong FBOs. No CPU readbacks during computation — that would kill mobile performance. The only readback is optionally for debugging.

Use `RG16F` texture format for flow (supported by `EXT_color_buffer_float`). Half precision is plenty for pixel displacements of up to ~50 px.

## Warp shader (the cheap part)

```glsl
#version 300 es
precision highp float;

uniform sampler2D uFrameA;
uniform sampler2D uFrameB;
uniform sampler2D uFlow;     // RG = displacement in normalized uv
uniform float uT;            // 0..1

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec2 flow = texture(uFlow, vUv).rg;

  // Forward warp A by t*flow, backward warp B by (1-t)*flow, blend.
  vec4 a = texture(uFrameA, vUv - uT * flow);
  vec4 b = texture(uFrameB, vUv + (1.0 - uT) * flow);
  fragColor = mix(a, b, uT);
}
```

Nodata handling: if either sampled pixel has alpha 0, fall back to the other sample. Prevents smearing across coastlines / radar range edges.

## Gotchas specific to this codebase

- **Cache identity is already correct.** Confirmed: `FramePool` syncs on `LAYERS`/`STYLES`/`FORMAT`/`ELEVATION` and handles view changes via sticky + `hasLoadedImageForView`. No refactor of the existing cache needed before starting.
- **WMS frames are styled RGB, not raw dBZ.** Flow on styled images is fine for visual interpolation, but low-reflectivity areas with flat color ramps produce weak gradients → noisy flow. A continuous viridis-like ramp is much better than a stepped classical radar palette here. If the active style uses a stepped palette, consider computing flow on the luminance channel only and boosting contrast.
- **Lightning and observation layers must NOT be interpolated.** They are point/vector data, not fields. The four pools are separate; only pass an interpolator to `satelliteLayer` and `radarLayer` pool constructors. Lightning and observation pools are constructed without one.
- **Keyboard shortcuts** (`j`, `k`, `l`, space — per README): these already work on discrete timesteps via `showTime`. Keep them on discrete steps. Interpolation is only for continuous playback via `k`.
- **Timeline UI** (`src/timeline.js`, ~40 lines): the scrubber currently snaps to discrete frames. Decide whether scrubbing shows interpolated frames (nicer) or snaps (cheaper). Recommend: snaps while dragging, interpolates during play.
- **Canvas output: use a custom `ol/layer/Layer` with `options.render`, not
  `ImageCanvas`.** `ol/source/ImageCanvas` caches the returned canvas by
  extent/resolution/revision and only re-invokes `canvasFunction` when
  someone calls `source.changed()`. Workable, but it reallocates the canvas
  on every pan (`scaleFromCenter(extent, ratio)`), which is wasteful for
  per-RAF updates. Cleaner: `new Layer({ render: (frameState) => warpCanvas })`
  hands OL the interpolator's canvas directly. Drive repaints with
  `layer.changed()` or `map.render()` each RAF. The interpolator owns the
  canvas; OL just blits it.
  - Keep the existing `ImageLayer` + `StickyImageWMS` path for
    non-interpolating pools (lightning, observation) and for
    interpolating pools whenever interpolation is paused/disabled.
  - When starting interpolated playback, swap the primary pool's visible
    layer in the map from the `ImageLayer` to the custom `Layer`; swap
    back on pause/disable. A layer swap is cleaner than a source swap and
    avoids the `StickyImageWMS` invalidation semantics question entirely.
- **A and B may have different pixel dimensions.** Each slot's sticky
  bitmap was fetched at whatever extent/resolution was current when its
  `triggerLoad` ran, so after any pan between slot-A's load and slot-B's
  load the two `HTMLImageElement`s can have different WIDTH/HEIGHT.
  `StickyImageWMS.hasLoadedImageForView` is a "good enough" check (L117–120)
  and accepts both. Before flow computation, resample A and B onto a
  fixed analysis grid (e.g., 512² in the pool's current view extent) — the
  LK shader then has a shared UV space. Warp reads from the same resampled
  textures and upsamples to display resolution for final display.
- **Source swap vs canvas swap.** When starting interpolated playback, we swap primary to the canvas-backed source; when pausing or stepping discretely, swap back to the slot's `StickyImageWMS`. Make sure `invalidateSticky` semantics still hold on these transitions.
- **umami telemetry** is present (`track()` at L121–123). Add a `track('interp-fallback', { reason })` when `canInterpolate()` returns false, so we can see real-world gating distributions across devices.

## Implementation phases

Do this incrementally. Each phase is independently shippable behind a flag.

**Phase 1 — Skeleton + capability gating + playback loop refactor.** This
phase is larger than it looks because the playback refactor is a
prerequisite for everything after it.

- (a) Empty `RadarInterpolator` class (no-op `renderAt`), `canInterpolate()`
  probe with the iOS-aware extension check and FBO completeness probe,
  feature flag wired through `radar.js` via `interpReady` Promise.
- (b) Refactor `play()` / `setTime()` into the two-cadence structure
  described in §Integration point 4b. While interpolation is disabled,
  the RAF loop just calls `showTime(A)` and ignores `t` — behavior is
  identical to today's `setInterval`. Keyboard shortcuts, scrubber drags,
  speed control, and `IS_FOLLOWING` all keep working.
- (c) Add a `showInterpolated(A, B, t)` stub on `FramePool` that today
  delegates to `showTime(A)`; later phases fill it in.

Ship, verify no visual or timing regressions against the current app.

**Phase 2 — Warp renderer only, with zero flow.** Implement the warp shader with a flow field of all zeros. Visually equivalent to crossfade. Purpose: shake out the GL context plumbing, OL integration, timing, mobile perf of just the display path. Ship behind flag, test on phones.

**Phase 3 — Pyramidal LK flow computation.** Implement `flow-lk.js`. Validate on synthetic pairs (translation-only cases should recover exact flow). Wire into prefetch. Now interpolation is real.

**Phase 4 — Polish.** Nodata masking, `webglcontextlost` recovery, memory budget enforcement, localStorage benchmark caching, URL hash override, telemetry for flow computation times per device.

**Phase 5 — Enable by default** after a week of dogfooding.

## Validation checklist

- [ ] Identical visual output to current app when interpolation is disabled
- [ ] No new WMS requests — verify in DevTools Network tab
- [ ] Flow computation <80 ms on M1 MacBook, <150 ms on iPhone 12, at 256²
- [ ] RAF render loop sustains device refresh rate during playback (60 fps
      on standard displays, 120 fps on ProMotion). Flow computation is
      off the RAF path — it runs during prefetch — so it doesn't affect
      per-frame latency as long as it completes before the pair is needed.
- [ ] No memory growth over 1-hour animation loop (check with perf profiler)
- [ ] Graceful fallback on WebGL1-only devices, old Androids, iOS < 15
- [ ] Lightning/observation layers unaffected
- [ ] Keyboard shortcuts still hit discrete timesteps
- [ ] Timeline scrubber UX decided and implemented

## Out of scope for this PR

- Nowcasting / extrapolation past the last observed frame (can extend later using the same flow fields, semi-Lagrangian scheme).
- Replacing pysteps for forecasting — that's a server-side concern.
- Changing the WMS layer list or data sources.

## References

- Bouguet, J-Y. (2001). *Pyramidal Implementation of the Lucas Kanade Feature Tracker.* Intel Corporation. The canonical reference for pyramidal LK.
- pysteps documentation — `pysteps.motion.lucaskanade` and `pysteps.extrapolation.semilagrangian` are the semantic model, even though we're reimplementing in WebGL2.
- WebGL2 `EXT_color_buffer_float` — required for RG16F render targets.
