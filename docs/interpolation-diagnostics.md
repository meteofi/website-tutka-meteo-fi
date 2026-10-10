# Interpolation diagnostics — phase 1

This phase establishes a repeatable baseline before changing optical flow.
The page imports `RadarInterpolator` and its production shaders directly;
it does not contain a copied solver or a corrected rendering variant.
No application rendering, caching, playback, or interpolation code changes.

## Try the Firebase preview

Open **`/diagnostics/interpolation/` on the PR's Firebase preview URL**.
The Firebase and CI workflows build this page after the app on pull requests.
It is absent from ordinary `npm run build` and production deployments. The
diagnostic bundle has a content hash and is not added to the app's service-worker
precache. The normal radar application remains at `/`.

On both desktop and phone:

1. Select the Finnish default or FMI radar sequence and press **Toista**.
   Compare **Optinen virtaus** with **Häivytys ilman liikettä**. The third image
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

The phone layout keeps flow and crossfade side by side, with the reference below.
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

The recorded [software baseline](../scripts/interpolation/baseline.json) has
zero correctness failures, nine unmet quality targets, and no unavailable
measurements. For a known horizontal shift of 4 analysis pixels, the median
estimate is about 3.85 for the smooth synthetic cell, 0.70 for the stepped cell,
0.37 for the default radar style, and 0.20 for the FMI style. The halfway
transparency case has about 64 levels of visible red error. Results can vary
slightly across GPUs; use the report's environment and hashes when comparing.

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
when later phases modify the application. No flow filtering, alpha, solver,
or clock fix is included in phase 1.
