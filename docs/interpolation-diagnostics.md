# Interpolation diagnostics

The page imports `RadarInterpolator` and its production shaders directly. It
compares optical flow with a zero-motion crossfade and a reference image. Radar
uses a filtered image pyramid, confidence-weighted refinement, and a deformation
safeguard. Satellite retains its single-level solver. Both use linear flow
filtering and premultiplied RGBA for transparent edges.

## Try the Firebase preview

Open **`/diagnostics/interpolation/` on the PR's Firebase preview URL**.
Firebase and CI build this page after the app on pull requests. It is absent
from ordinary `npm run build` and production deployments. Its bundle has a
content hash and is not in the app's service-worker precache. The normal app
remains at `/`; `/?interp=flow` enables optical flow in the actual map.

On both desktop and phone:

1. Select the Finnish default or FMI radar sequence and press **Toista**.
   Compare **Optinen virtaus (korjattu)** with **Häivytys ilman liikettä**.
   The third image is the nearest real observation, **not** ground truth between
   observations. This page no longer reproduces the old solver.
2. Change **Suurennus** between the whole image and 2×/4× crops. Inspect uneven
   rain/clear boundaries at the enlarged scale; the initial view is a 2× crop.
3. Try **Porrastettu solu — 4 px**, a radar **tunnettu 4 px siirto** case, and
   the **1920 × 1080** case. Here the third panel *is* known ground truth: a
   specified translation without meteorological growth or decay.
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
a loopback server, and a two-minute timeout, then close the browser and remove
its profile. `--software` selects SwiftShader. These runs are **not mobile
performance benchmarks**. `pairMilliseconds` reports average texture upload and
completed GPU flow computation per pair, excluding fixture loading/decoding.
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

Nine original PNG responses, about 1 MB total, live under
`scripts/interpolation/fixtures/`. Diagnostics make no live weather requests.
`manifest.json` records explicit WMS URLs, timestamps, styles, CRS, extents,
dimensions, SHA-256, and attribution.

- Finnish composite: 2026-10-10 06:20, 06:25, 06:30 UTC, default and FMI styles,
  640×768, southern/central Finland. FMI, CC BY 4.0; served by MeteoCore.
- GOES-19 10.3 μm infrared: 2026-10-10 06:00, 06:10, 06:20 UTC, grayscale style,
  640×640, eastern North America / western Atlantic. NOAA; served by MeteoCore.
- Smooth and stepped cells: 1, 4, and 8 analysis-pixel translations, plus a
  diagonal translation checking the vertical sign convention.
- Known 4-pixel translations of each real source, stationary radar, and a
  red→transparent→red sequence with a known opacity ramp.
- A resized 1920×1080 radar source with known translation, exercising large
  uploads, antialiasing, and rectangular flow grids. Resizing adds no weather
  detail; this is a controlled case, not a new observation.

These are 16 cases of three images each, not the app's 13-frame window. Keep
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
  must be `[48, 48, 0, 255]` within two levels at both 3×3 and 513×513 output.
  Nearest-neighbor flow sampling instead gives 32 or 64 in red/green.
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
ratio with a longest grid side of 256; satellite keeps a 256×256 grid. To compare
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
three speed settings, pause/step/resume, zoom/pan, and pane changes. Motion fields
and shaders are unchanged, so this corrects timing hesitations rather than
removing genuine rain growth/decay or changes in estimated velocity between pairs.

## Scope

The harness covers production upload, flow computation, warping, enlarged crops,
and adjacent pairs. Its small controller does not reproduce the app's RAF clock
or FramePool. Loading races, pan/zoom integration, full-window wrap, layer opacity,
2/4 panes, and Safari performance require the actual app. Desktop Chrome and a
narrow viewport do not substitute for a physical iPhone test; use Firebase on
the target devices before merging.
