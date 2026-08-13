// Whether an aircraft could plausibly have flown from one fix to the next.
//
// Pure and dependency-free (the trainQuery.js / areaQuery.js shape) so the
// thresholds can be checked against real numbers from a node harness — a guard
// like this is exactly the kind of code where a unit slip or a missing
// projection correction passes review and then quietly discards good data.
//
// WHY IT EXISTS. Eastern Finland sees sustained GPS jamming, and a jammed
// receiver does not go quiet: it reports confidently from somewhere else
// entirely. Drawn without question, one aircraft rules a line across the
// country and back, which is both wrong and the messiest thing that can happen
// to the OGN layer.

// About 600 km/h — far above anything OGN carries in Finland, and far below
// what a jamming artefact implies. Those are routinely tens of thousands.
export const TRAIL_MAX_SPEED_MS = 170;

// Below this the elapsed time is too short to divide by safely — two fixes can
// share a timestamp, and a jammed one can arrive with time running backwards —
// so a small hop is allowed and anything larger is not.
export const TRAIL_MIN_DT_MS = 1000;
export const TRAIL_SAME_INSTANT_MAX_M = 200;

// Metres between two EPSG:3857 points. Web Mercator distances are inflated by
// 1/cos(latitude) — at 62°N a projected "metre" is barely half a real one — so
// the raw distance is corrected, or the guard would be twice as strict over
// Lapland as over the south coast.
export function metresBetween(from, to) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const lat = 2 * Math.atan(Math.exp(to[1] / 6378137)) - Math.PI / 2;
  return Math.hypot(dx, dy) * Math.cos(lat);
}

// `from`/`to` are EPSG:3857 coordinates, the times are epoch ms.
//
// Judged against the last ACCEPTED point rather than the last reported one,
// which is what lets a trail heal itself: while the jumps keep coming they keep
// being refused, but the elapsed time in the divisor keeps growing, so once real
// fixes resume the aircraft's genuine displacement is affordable again and the
// trail carries on. No counter, no reset, no state to get wrong.
export function isPlausibleLeg(from, fromMs, to, toMs) {
  const metres = metresBetween(from, to);
  const dt = toMs - fromMs;
  if (!(dt >= TRAIL_MIN_DT_MS)) return metres <= TRAIL_SAME_INSTANT_MAX_M;
  return metres / (dt / 1000) <= TRAIL_MAX_SPEED_MS;
}
