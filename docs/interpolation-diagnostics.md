# Interpolation diagnostics

Phase 1 established a repeatable baseline before changing optical flow.
The page imports `RadarInterpolator` and its production shaders directly;
it does not contain a copied solver. Phase 2 enables linear filtering of the
production RG16F flow textures. The comparison panel can reproduce the previous
nearest-neighbor filtering, using the same solver and warp.

## Try the Firebase preview

Open **`/diagnostics/interpolation/` on the PR's Firebase preview URL**.
The Firebase and CI workflows build this page after the app on pull requests.
It is absent from ordinary `npm run build` and production deployments. The
diagnostic bundle has a content hash and is not added to the app's service-worker
precache. The normal radar application remains at `/`.

On both desktop and phone:

1. Select the Finnish default or FMI radar sequence and press **Toista**.
   Compare **Optinen virtaus (korjattu)** with **Aiempi optinen virtaus**.
   **Vertailukuva** also offers **Häivytys ilman liikettä**. The third image
   is the nearest real observation; it is **not** ground truth between frames.
2. Switch to the GOES infrared sequence. All three sequences contain consecutive
   observations and exercise the A→B / B→C boundary. The timeline can stop at
   endpoints or fractional times. The last observation is held before restarting;
   there is no flow estimate connecting the end back to the beginning.
3. Try **Porrastettu solu — 4 px** and a radar **tunnettu 4 px siirto** case.
   Here the third panel *is* known ground truth: the same source is translated
   by a specified amount, without meteorological growth or decay.
4. Try **Tutka — paikallaan** and **Läpinäkyvyys — häviäminen ja ilmestyminen**.
   Change **Tausta** between dark, light, and black. In the transparency case,
   the reference remains red as its opacity changes; the current renderer dims it.
5. Press **Mittaa kaikki tapaukset**, then **Lataa tulokset (JSON)** to preserve
   the device's results. The report includes browser/GPU information, source and
   fixture hashes, measurements, limits, and all failed targets. It stays local
   unless you choose to share the downloaded file.

The phone layout keeps the two renderers side by side, with the reference below.
The preview scales display canvases to at most 480 pixels on the longest side;
measurements render at each fixture's native size. This keeps viewing inexpensive
without silently changing the measurement resolution.

## Local runs

Requires the project's Node 24 and `npm ci`. No new dependencies.

```sh
npm run diagnose:interpolation                    # localhost:9011
npm run diagnose:interpolation -- --port 9020
npm run diagnose:interpolation -- --headless --output /tmp/interpolation.json
npm run diagnose:interpolation -- --headless --software --output /tmp/interpolation-software.json
npm run diagnose:interpolation -- --headless --software --strict
```

`CHROME_BIN` can select a Chrome/Chromium executable. Headless runs use a fresh
temporary profile, a loopback server, and a two-minute timeout; they close the
browser and remove the profile after reporting. `--software` selects SwiftShader
for repeatable software rendering. Those runs are **not mobile performance
benchmarks**. GPU readback and pixel comparisons deliberately synchronize work.

Without `--headless`, the command remains running until interrupted. To produce
static files without starting a server:

```sh
npm run build
npm run build:interpolation-diagnostics
```

The order matters: the app build cleans `dist/`; the diagnostic build cleans
only `dist/diagnostics/interpolation/`.

## Fixtures and cases

Nine original PNG responses, about 1 MB total, are checked in under
`scripts/interpolation/fixtures/`. No requests to live weather services are made
while running the diagnostics. `manifest.json` records each explicit WMS URL,
timestamp, style, CRS, extent, size, SHA-256, and attribution.

- Finnish composite: 2026-10-10 06:20, 06:25, 06:30 UTC, default and FMI styles,
  640×768, southern/central Finland. FMI, CC BY 4.0; served by MeteoCore.
- GOES-19 10.3 μm infrared: 2026-10-10 06:00, 06:10, 06:20 UTC, grayscale style,
  640×640, eastern North America / western Atlantic. NOAA; served by MeteoCore.
- Synthetic smooth and stepped cells: 1, 4, and 8 analysis-pixel translations;
  a diagonal translation checks the vertical sign convention.
- Known 4-pixel translations of each real source, stationary radar, and a
  red→transparent→red sequence with a known opacity ramp.

These are 15 small cases, each with three images, not the application's 13-frame
window. Keep existing fixture files immutable. A new snapshot should get new
filenames and manifest entries so both comparisons and Firebase's immutable PNG
cache remain meaningful. The original request URL documents provenance; upstream
retention may make it impossible to fetch the same historical time later.

## Measurements and interpretation

**Correctness checks** require native-size endpoint reproduction, agreement
between the two ways of rendering shared frame B, and stationary-image stability.
The visible colour/alpha tolerance is 3 on a 0–255 scale to allow canvas/half-float
rounding. Stationary motion must have mean vector error ≤0.5 analysis pixels.
An additional rendered check writes a known four-quadrant displacement field into
the production flow texture and warps a red/green ramp toward opaque black. The
center pixel must be `[48, 48, 0, 255]` within two levels for both a 3×3 output
(minification) and 513×513 output (magnification). This checks actual bilinear
sampling in both axes, not just the configured filter enum. The report includes
these pixels under `flowFiltering`; a GL error fails the run.

**Quality targets** require mean vector error ≤0.5 analysis pixels for known
translations and visible colour/alpha error ≤3 for the transparency ramp. These
are initial improvement targets, not assertions that the current algorithm meets
them. The default command fails on correctness failures, missing measurements,
or browser/GL errors. `--strict` also fails on unmet quality targets. Never tighten
tests around the current incorrect flow numbers to make a future fix fail.

Flow comes from the actual RG16F texture. Components are converted from UV to
256×256 analysis pixels, with +x right and +y **down**. For real textures, sampling
excludes an eight-analysis-pixel border and source alpha below 20/255. Synthetic
cells are sampled within radius 19 of their initial centre. The report records
median components, mean Euclidean vector error, zero-flow fraction, and sample
count. A driver that cannot read the float target reports the measurement as
unavailable, never as zero motion or a successful test.

Image errors compare **premultiplied visible RGB and alpha**, ignoring hidden
RGB in fully transparent pixels. Both the mean over channels/pixels and maximum
channel error are recorded. Known intermediate images are sampled at quarters of
both frame pairs. These full-image differences include the translated image's
outer boundary; use the interior vector metric to assess motion independently
of that boundary. Real consecutive images have no known intermediate truth and
receive no motion-accuracy score.

The recorded [phase-one software baseline](../scripts/interpolation/baseline.json) has
zero correctness failures, nine unmet quality targets, and no unavailable
measurements. For a known horizontal shift of 4 analysis pixels, the median
estimate is about 3.85 for the smooth synthetic cell, 0.70 for the stepped cell,
0.37 for the default radar style, and 0.20 for the FMI style. The halfway
transparency case has about 64 levels of visible red error. Results can vary
slightly across GPUs; use the report's environment and hashes when comparing.

## Phase 2: flow filtering

`OES_texture_half_float_linear` functionality is
[core in WebGL2](https://registry.khronos.org/webgl/specs/latest/2.0/#EXTENSIONS),
and the WebGL1 extension is no longer exposed there. The former extension probe
therefore selected NEAREST even though RG16F supports LINEAR. Production now uses
LINEAR; color-buffer extension activation and renderability probes remain intact.
This blends motion between neighboring analysis cells. It does not blur the
source images or change the computed vectors.

On Chrome 154 / SwiftShader, the new rendered regression failed before the fix:
both output sizes produced `[32, 32, 0, 255]` (16 levels of error). After the fix,
both produce the exact expected pixel. All 44 checks run: zero correctness
failures, nine unmet quality targets, and no unavailable measurements. Raw motion
measurements are identical before and after; the historical baseline is retained.

Mean visible image error, averaged across the six intermediate positions:

| Known 4-pixel translation | Before (NEAREST) | After (LINEAR) |
| --- | ---: | ---: |
| Default radar | 4.92836 | 4.92709 |
| FMI radar | 4.46431 | 4.45954 |
| GOES infrared | 4.08977 | 4.08081 |

The improvement is small. The synthetic cases render at the analysis resolution,
where texel centers already align, so their image metrics do not change. The
dominant radar motion underestimation and transparency fade remain for later
phases; this correction alone does not resolve the reported blur or pulsation.

Validation also passed on Chrome's Apple M2 Max / Metal renderer (zero correctness
failures, nine unmet targets, filtering pixel error zero). App playback was
checked with flow enabled in one, two, and four panes without browser errors.
The comparison controls were checked at a 390×844 viewport; this is a layout
check, not a physical iPhone/Safari test.

Window-edge trace: index 0 uses the first pair; t=0 samples its first source
unchanged. The last index uses the previous pair at t=1, reproducing its second
source without estimating flow back to the beginning. Non-default WMS styles
still invalidate sticky images, and the resulting bitmap upload invalidates
referencing flow textures; layer/URL/elevation changes also clear the flow cache.
Both newly computed and zero-flow textures receive the selected filter.

`npm test` verifies the measurement helpers against known errors and checks
fixture hashes, PNG dimensions, URL identity, and consecutive timestamps. It
does not pretend to run WebGL in Node. The real browser suite is the separate
`diagnose:interpolation` command. CI runs the Node tests and builds the preview;
GPU measurements remain explicit.

## Scope of this baseline

The harness exercises production texture upload, flow computation, warping,
and adjacent-pair rendering. Its small playback controller is for inspection,
not a reproduction of the application's RAF clock or FramePool. It does not
validate loading races, pan/zoom, the full window's wrap, user layer opacity,
2/4-pane integration, or Safari GPU performance. Those checks remain necessary
when phases modify the application. Phase 2 changes flow filtering only; alpha,
solver, and clock changes remain separate work.
