# Interpolation diagnostics

The page imports `RadarInterpolator` and its production shaders directly. It
compares optical flow with a zero-motion crossfade and a reference image. Radar
uses a filtered image pyramid, confidence-weighted refinement, shared boundary
velocities, inverse trajectory sampling, and deformation safeguards. Satellite retains its single-level solver. Both use linear flow
filtering and premultiplied RGBA for transparent edges.

## Try the Firebase preview

Open **`/diagnostics/interpolation/` on the PR's Firebase preview URL**.
Firebase and CI build this page after the app on pull requests. It is absent
from ordinary `npm run build` and production deployments. Its bundle has a
content hash and is not in the app's service-worker precache. The normal app
remains at `/`; `/?interp=flow` enables optical flow in the actual map.

On both desktop and phone:

1. Select the Finnish default or FMI radar sequence (including the **työpöytä
   2400 × 1350** captures) and press **Toista**.
   Compare **Optinen virtaus (korjattu)** with **Häivytys ilman liikettä**.
   The third image is the nearest real observation, **not** ground truth between
   observations. This page no longer reproduces the old solver.
2. Change **Suurennus** between the whole image and 2×/4× crops. Inspect uneven
   rain/clear boundaries at the enlarged scale; the initial view is a 2× crop.
3. Try **Porrastettu solu — 4 px**, a radar **tunnettu 4 px siirto** case, and
   the **1920 × 1080** case. Here the third panel *is* known ground truth: a
   specified translation without meteorological growth or decay. The **Tarkka
   liike** cases also cover expansion, shear, contraction, and changing direction;
   they provide exact fields to isolate the warp from estimation errors.
4. Try **Tutka — paikallaan** and **Läpinäkyvyys — häviäminen ja ilmestyminen**.
   Change **Tausta** between dark, light, and black. The transparency reference
   stays red as coverage changes; the renderer should match that visible colour.
5. Switch to GOES infrared to check satellite behavior. Natural sequences
   exercise A→B / B→C. The timeline can stop at endpoints or fractional times.
   The last observation is held before restarting; no flow connects end to start.
6. Press **Mittaa kaikki tapaukset**, then **Lataa tulokset (JSON)**. Reports
   include browser/GPU information, source/fixture hashes, measurements, limits,
   and unmet targets. They stay local unless you share them.

On phones, both renderers stay side by side with the reference below. Display
canvases follow their CSS width, capped at 960 pixels. Measurements independently
use native fixture size plus 800-pixel-wide crops. Also test playback, zoom/pan,
opacity, and 1/2/4 panes in the **actual map**.

## Local runs

Requires the project's Node 24 and `npm ci`. No new dependencies.

```sh
npm run diagnose:interpolation                    # localhost:9011
npm run diagnose:interpolation -- --port 9020
npm run diagnose:interpolation -- --headless --output /tmp/interpolation.json
npm run diagnose:interpolation -- --headless --software --output /tmp/interpolation-software.json
npm run diagnose:interpolation -- --headless --software --strict
```

`CHROME_BIN` selects Chrome/Chromium. Headless runs use a fresh temporary profile,
a loopback server, and a two-minute timeout (five minutes for the explicit
software-rendering suite), then close the browser and remove
its profile. `--software` selects SwiftShader. These runs are **not mobile
performance benchmarks**. `pairMilliseconds` reports average upload/flow command
submission with `gl.finish()`, excluding fixture loading/decoding; browsers may
return before the GPU process completes. `renderCost` forces completion with a
one-pixel readback and therefore includes that overhead. It measures phone-size,
1080p and approximately 4-Mpx canvases on the reported GPU, not on three devices.
Shader compilation, warmup, and other GPU work affect timing. Readbacks and
`gl.finish()` are diagnostic-only.

Without `--headless`, the server stays running until interrupted. For static
files:

```sh
npm run build
npm run build:interpolation-diagnostics
```

Order matters: the app build cleans `dist/`; diagnostics clean only their own
subdirectory.

## Fixtures and cases

Fifteen original PNG responses, about 3.7 MB total, live under
`scripts/interpolation/fixtures/`. Diagnostics make no live weather requests.
`manifest.json` records explicit WMS URLs, timestamps, styles, CRS, extents,
dimensions, SHA-256, and attribution.

- Finnish composite: 2026-10-10 06:20, 06:25, 06:30 UTC, default and FMI styles,
  640×768, southern/central Finland. FMI, CC BY 4.0; served by MeteoCore.
- Desktop Finnish composite: 2026-10-11 05:20, 05:25, 05:30 UTC, both palettes,
  2400×1350, southern Finland. Original WMS images, not resized copies.
- GOES-19 10.3 μm infrared: 2026-10-10 06:00, 06:10, 06:20 UTC, grayscale style,
  640×640, eastern North America / western Atlantic. NOAA; served by MeteoCore.
- Smooth and stepped cells: 1, 4, and 8 analysis-pixel translations, plus a
  diagonal translation checking the vertical sign convention.
- Known 4-pixel translations of each real source, stationary radar, and a
  red→transparent→red sequence with a known opacity ramp.
- A resized 1920×1080 radar source with known translation, exercising large
  uploads, antialiasing, and rectangular flow grids. Resizing adds no weather
  detail; this is a controlled case, not a new observation.

Four additional analytic cases supply exact fields for expanding, shearing,
contracting, and turning shapes. Two desktop-detail cases translate the original
2400×1350 captures by 16 / −8 source pixels per interval without resizing or
weather evolution. These are 24 cases of three images each, not the app's 13-frame window. Keep
fixtures immutable. New snapshots need new filenames and manifest entries so
comparisons and Firebase's immutable PNG cache stay meaningful. Upstream
retention may prevent fetching the historical request later.

## Measurements and interpretation

**Correctness checks** require endpoint reproduction at native size and in
centered/offset half-image crops, agreement at shared frame B, and stationary
image stability. Visible colour/alpha tolerance is 3 on a 0–255 scale for canvas
rounding. Stationary mean vector error must be ≤0.5 analysis pixels.

Two rendered regressions exercise the production warp independently of solver
accuracy:

- Four flow quadrants meet at the center of a red/green step. Their bilinear
  mean is 0.25 analysis pixels in each axis. Halfway to opaque black, the center
  must be `[51, 51, 0, 255]` within two levels at both 3×3 and 513×513 output.
  Inverse sampling solves `f = 0.25 - 0.25*f`, so the source displacement is
  0.2 and the bright-texel weight is 0.4. The previous output-coordinate warp
  produced 48; nearest-neighbor sampling fails both expectations.
- An intentionally corrupted field has a displacement gradient far above 1.
  Its center must match the unwarped fade at quarter, half, and three-quarter
  times in whole-image, 2×, and 4× views. This checks deformation protection
  in source coordinates as the map magnifies the image.

Reports store these under `flowFiltering` and `deformationGuard`. GL errors fail
the run.

**Quality targets** require mean vector error ≤0.5 analysis pixels for known
translations, visible colour/alpha error ≤3 for transparency, and mean image
error ≤1 for known radar motion in enlarged crops. Radar fields also target
zero folded cells. Unmet targets stay visible. The default command fails on
correctness failures, unavailable measurements, or browser/GL errors;
`--strict` additionally fails on unmet quality targets.

Motion comes from the actual half-float texture. Radar preserves source aspect
ratio with a longest grid side of 384; satellite keeps a 256×256 grid. To compare
with the baseline, UV components are converted to a **normalized 256×256 analysis
grid**, +x right and +y down. Samples exclude an eight-cell border and source
alpha below 20/255; synthetic cells use radius 19 around their initial center.
Reports include median components, mean vector error, zero-flow fraction, and
sample count. Failed float readback is unavailable, never zero motion or a pass.

Geometry uses the field's own dimensions. At each bilinear cell's corners it
checks the determinant of the warped coordinate gradient at eight fractions
spanning both sampling directions, including interval limits. `foldedCells`
counts raw cells with non-positive determinants; `maxNeighborJump` is in that
field's pixels. This is **before the rendering safeguard**, exposing unstable
estimates even when the renderer suppresses their warp. The safeguard uses a
conservative gradient bound, blending toward a crossfade between 0.75 and 1,
fully selecting it above 1. It blends images rather than scaling vectors,
avoiding a new displacement discontinuity at the transition.

Image errors compare **premultiplied visible RGB and alpha**, ignoring hidden
colour in transparent pixels. Both mean and maximum error are recorded. Known
intermediates are sampled at quarters of both pairs. Full-image errors include
outer boundaries; interior vector metrics isolate motion from them. Real
observations have no known intermediate truth and no motion-accuracy score.

## Changes and recorded results

The immutable [phase-one baseline](../scripts/interpolation/baseline.json) has
zero correctness failures and nine unmet quality targets. For a known four-pixel
shift, medians were about 3.85 (smooth cell), 0.70 (stepped cell), 0.37 (default
radar), and 0.20 (FMI radar). Halfway transparency lost about 64 visible-red levels.

The original filtering fix remains: `OES_texture_half_float_linear` is
[core functionality in WebGL2](https://registry.khronos.org/webgl/specs/latest/2.0/#EXTENSIONS),
so the obsolete WebGL1 extension probe incorrectly selected NEAREST. Half-float
flow now uses LINEAR; color-buffer extension activation and renderability checks
remain. Filtering alone barely improved radar image error because motion
estimation and alpha handling still dominated.

Radar now uses prefiltered, aspect-preserving images, up to four pyramid levels,
four refinements per level, conditioned local solves, confidence-weighted outlier
handling, and final velocity smoothing. That smoothing does not blur source
colours. Premultiplied upload, sampling, blending, and canvas output avoid
multiply-darkened transparent boundaries. Excessive deformation falls back to a
fade. Satellite keeps its existing solver; common alpha corrections also apply
to its transparent boundaries.

Chrome 154 on Apple M2 Max / Metal and SwiftShader both report zero correctness
failures and no unavailable measurements across 78 checks. All known radar
motion and transparency targets pass. Four-pixel radar translations have mean
vector error about 0.03–0.04; the wide case is about 0.02. Cropped endpoints stay
within two visible colour/alpha levels. Two quality targets remain open:

- Natural default radar has 14–15 raw folded cells out of 12,354 measured cells,
  before the rendering safeguard. FMI has zero.
- The unchanged satellite solver still misses the known large translation
  (mean vector error about 3.56).

Values vary by GPU; compare environments and hashes. The raw-field target stays
open rather than being relaxed around today's result; the rendered safeguard is
checked separately. Rain growth/decay and pair-to-pair velocity changes can still
produce fading. These tests do not establish meteorological truth between frames.

Window-edge trace: index 0 uses the first pair at t=0; the last index uses the
previous pair at t=1. Both warped and fallback paths reproduce those endpoints,
without estimating flow back to the start. Non-default WMS styles still
invalidate sticky images; replacement uploads invalidate referencing flows.
Layer/URL/elevation changes also clear flow caches. FramePool, opacity ownership,
and playback clock behavior are unchanged.

`npm test` validates measurement helpers (including horizontal, vertical, and
corner-only folds), fixture hashes, PNG dimensions, URL identity, and consecutive
timestamps. It does not run WebGL in Node. CI runs these tests and builds the
preview; GPU measurements remain explicit.

## Playback boundary timing

The app's RAF loop previously advanced the observation and returned before
updating the warp. The timeline could move to B while the screen still held the
end of A→B until a later RAF. Resetting the clock to that callback's timestamp
also discarded short overruns, so repeated late callbacks slowed playback.

`playbackPhase` now preserves that remainder, and the RAF paints the new pair
in the same tick as `setTime`, bypassing the normal 33 ms throttle at boundaries.
The shared clock stays in radar.js. If at least two observation-step durations
have elapsed (for example after tab suspension), it advances only once and
restarts at that observation rather than catching up through many frame changes.

`scripts/test-playback.mjs` evaluates the actual app clock/control functions and
FramePool's pair selection with mocked scheduling and output. The boundary test
fails on the former early-return path: its last draw remains at 480 ms instead
of updating at 500 ms. Simulated 60/120/144 Hz displays at every playback speed
now stay within their normal 33–35 ms drawing interval, including boundaries;
the former loop could stretch an interval to 50 ms. Non-aligned start times also
check that fractional position follows elapsed time without accumulating drift.
These are deterministic scheduling checks, not measurements of GPU frame rate.

The regression covers 1/2/4 panes, interaction gates, a long suspension, missing
flow, opacity restoration, discrete stepping, and first/last frames. The last
observation still holds the previous pair at t=1; wrapping paints the first pair
without estimating motion from the last observation to the first. Non-default
style/elevation parameters remain attached to their sources.

Test this change in the **actual radar app**: the recorded comparison page has
its own playback controller and does not exercise the app's RAF loop. Check all
three speed settings, pause/step/resume, zoom/pan, and pane changes. That timing
change left the motion fields and shaders unchanged; the following correction
addresses the separate spatial and velocity discontinuities.

## Desktop edge trajectories

The former warp sampled a source-defined forward field at the output pixel.
This is exact for translation but misaligns the two observations during spatially
varying motion, producing double contours even with a perfect field. Radar now
inverts its forward path with eight bounded fixed-point iterations. The exact
observation is returned at either endpoint. Residuals above a quarter display
pixel begin fading to the unwarped observations; a full pixel selects that fade.
The actual sampling Jacobians also guard against folds. Satellite keeps its
previous warp and estimator, and zero-flow crossfades retain linear coverage.

`RadarTrajectories` builds one small RGBA16F coefficient texture per radar pair.
Incoming motion is transported into the shared observation's coordinates before
combining it with outgoing motion. Confidence-weighted, limited harmonic slopes
join compatible motion and reduce opposing components to zero at the turn,
preventing cubic overshoot. Cubic Hermite paths preserve both observations;
constant translation stays constant. Source colours are not filtered again.
If a neighbouring field is absent, the available one-sided velocity is used.
Paths stay fixed while their pair plays, so a late neighbour is picked up on the
next visit instead of changing the image's position halfway through an interval.
Replacing a pair's own flow invalidates its path immediately. Identity/mode
changes, disposal and context loss release the coefficient cache.

New GPU contracts measure the **rendered** arrival/departure velocity of a cell
whose direction and speed change, compare exact deformations to an independent
analytic image, and check missing/late neighbours and cache invalidation. The
revised field-filtering expected value follows the inverse lookup above; its
tolerance was not widened. Default/FMI desktop sequences report arrival versus
departure differences at the same advected precipitation-edge locations, before
and after the trajectory correction. These path statistics exclude the final
fallback blend and are continuity checks, not physical motion accuracy.

On the initial M2 Max / Metal run, the desktop 95th-percentile difference fell
from 1.406 to 0.020 native analysis pixels per interval (default) and from 1.062
to 0.016 (FMI). The analytic deformation mean image errors stayed below 0.25 on
the 0–255 scale. Hardware and SwiftShader runs cover 124 checks with zero correctness failures
and no unavailable measurements; the two pre-existing raw-field/satellite quality targets remain open. Locally
ambiguous edges can still fade as precipitation grows or disappears. The
readback-synchronized 1080p render median was 0.7 ms and the 4-Mpx median was
1.0 ms on this desktop GPU (20 samples each, including readback overhead).
Software render timing is explicitly skipped; neither result predicts iPhone
performance. Substituting the former warp makes the new rendered-velocity and
affine-expansion correctness regressions fail.

Window/identity trace: the first pair has no incoming neighbour; the last has
no outgoing neighbour, and the last observation remains the same t=1 hold.
No trajectory connects the end back to the start. Non-default styles replace
frame textures and referencing flows through the existing sticky invalidation;
layer, elevation and URL changes also clear trajectories. No WMS request or
FramePool opacity/timing behavior changes.

## High-DPI display sharpness

The CSS-sized warp canvas introduced an extra bilinear resampling step on
high-DPI displays: original WMS pixels were first sampled onto that canvas,
then enlarged by OpenLayers. Pausing displays the original WMS image directly,
so even an exact observation looked softer during playback. The motion shader
alone did not reveal this, because the earlier checks omitted the enlargement.

Radar now renders at up to 2x CSS size within the existing 4-million-pixel
canvas budget. The viewport-only extent, WMS request density, motion estimator,
trajectories, and satellite canvas density remain unchanged. Large displays
still reduce the canvas density to fit the budget, and DPR-3 devices stop at 2x.
This reduces display blur; it does not eliminate blending of changing rain.

The GPU report includes `displaySampling`: a recorded radar image translated
by an exact field, passed through the production `BudgetedCanvasSource` and
enlarged with OpenLayers' device/image pixel-ratio relationship. At DPR 2 the
revised output matches the direct display reference at observations and
midpoints; the previous canvas gives mean visible-channel errors of 0.98–1.10
and fails all five checks. The 129-check suite passes all correctness checks
on Metal and SwiftShader, retaining the two existing quality flags above.
`test-warp-display.mjs` covers phone/desktop/split-screen sizes, DPR 1–3,
world placement, canvas invalidation, and the hard allocation budget.

## Finer radar correspondence

Radar now estimates motion on a grid with a longest side of 384, while satellite
retains 256. This improves the alignment of fine precipitation details before
the observations are blended. Merely increasing density also made the accepted
velocity smoothing cover less of the source image, bringing back unstable local
deformations in experiments. The number of binomial coherence passes therefore
scales with the square of the grid density: 27 passes at 384, versus 12 at 256.
Their spatial variance in source-image coordinates stays approximately constant.
Images at 256 pixels or smaller retain the previous estimator settings.

The two new native desktop-detail translations check intermediate alignment in
centered and offset crops. Their maximum mean visible-channel error must be
at most 0.2 on the 0–255 scale. On Metal, the default palette improves from 0.139
to 0.082 and FMI from 0.207 to 0.130. Substituting the merged 256-grid renderer
fails the FMI detail target. These controlled translations do not establish
accuracy when real rain grows or disappears. The four recorded radar sequences
now have zero raw folded cells; the old default-palette case previously had 14.
Vector-error units remain normalized to a 256×256 reference for comparisons;
geometry and boundary-velocity statistics use the reported native grid size.

The 24-case suite completes 145 checks on both Metal and SwiftShader, with no
correctness failures or unavailable measurements. All radar quality targets
pass; the existing GOES-19 translation target remains the sole quality warning.

A separate M2 Max measurement forced completion by reading a pixel of the final
flow texture. Median pair computation increased from 12.7 to 16.7 ms across ten
warmed samples, excluding image upload and shader compilation but including
readback overhead. Flow is computed once per loaded pair, not per animation
frame. This is a desktop measurement; phone loading and playback still need the
Firebase preview check. Trajectory interpolation, colour sampling, high-DPI
display budgets, window endpoints, and WMS identity handling are unchanged.

## Scope

The harness covers production upload, flow computation, warping, enlarged crops,
display sampling, and adjacent pairs. Its small controller does not reproduce the app's RAF clock
or FramePool. Loading races, pan/zoom integration, full-window wrap, layer opacity,
2/4 panes, and Safari performance require the actual app. Desktop Chrome and a
narrow viewport do not substitute for a physical iPhone test; use Firebase on
the target devices before merging.
