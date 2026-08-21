// Peak-per-frame aggregation for EDR point series.
//
// The probe chart (src/probe.js) and the centre crosshair readout
// (src/crosshair.js) must answer the same question — "what value does this
// point show for this animation frame?" — and must never disagree, or the
// number under the reticle contradicts the bar in the chart for the same
// pixel and the same instant. They used to answer it with two hand-copied
// implementations kept in step by a comment reading "Mirror probe.js exactly"
// (issue #126); this is the one implementation both now call.
//
// Pure and dependency-free, like the rest of src/edr/ — no OpenLayers, no DOM
// — so it can be exercised from a plain node harness.

// Which animation frame an absolute timestamp lands in, relative to the start
// of the current window. Nearest-cell rounding: EDR reports arrive on their own
// cadence, which can be finer OR coarser than the 5-minute animation step, so a
// sample is attributed to the cell it is closest to rather than the one it
// falls inside. Returns null when the step is unusable (no window yet).
export function frameIndexAt(tMs, windowStartMs, stepMs) {
  if (!stepMs || stepMs <= 0) return null;
  return Math.round((tMs - windowStartMs) / stepMs);
}

// Reduce a series of { t, v } samples to one value per animation frame.
//
// Two rules, and both matter:
//
//   - `floor` drops "no signal" samples entirely rather than clamping them,
//     so an empty cell stays empty (no bar, no readout). For reflectivity the
//     floor is 0 dBZ; signed moments such as radial velocity have none, since
//     a negative value there is real data, not absence of data.
//   - When several samples share a cell, keep the one with the largest
//     MAGNITUDE, not the largest value. For reflectivity that is the peak dBZ;
//     for a signed moment it is the strongest motion in either direction.
//     Taking a plain max would quietly report the weakest outbound velocity in
//     a cell full of strong inbound ones.
//
// Returns an array of length `frameCount` holding `number | null`. Note that
// null means "no sample", and 0 is a legitimate value that must survive — never
// test the result for truthiness, only for `== null`.
export function peaksByFrame(series, windowStartMs, stepMs, frameCount, floor = null) {
  const peaks = new Array(frameCount).fill(null);
  if (!Array.isArray(series) || !stepMs || stepMs <= 0) return peaks;
  for (const p of series) {
    if (!p || p.v == null) continue; // eslint-disable-line no-continue
    if (floor != null && p.v < floor) continue; // eslint-disable-line no-continue
    const idx = frameIndexAt(p.t, windowStartMs, stepMs);
    if (idx == null || idx < 0 || idx >= frameCount) continue; // eslint-disable-line no-continue
    const prev = peaks[idx];
    if (prev == null || Math.abs(p.v) > Math.abs(prev)) peaks[idx] = p.v;
  }
  return peaks;
}
