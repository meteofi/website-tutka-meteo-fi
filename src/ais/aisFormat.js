// Formatting shared by everything that reads AIS: the own vessel and the
// rescue-vessel layer. Pure and dependency-free, which is what keeps the rate-of-
// turn decoding below in ONE place — it was written with that promise in its own
// comment, and a second copy would quietly make that false.

export const cell = (label, v, unit, digits = 0) => ({
  label,
  value: Number.isFinite(v) ? `${v.toFixed(digits)}\u2009${unit}` : '–',
});

// Decoded here and ONLY here. The vessel symbol reads the same `rot` but takes
// just its sign, to pick the side its turn flag points (ownShipStyle.js) — it
// never needs the rate, so nothing is decoded twice and the two cannot drift.
//
// Rate of turn arrives as the RAW AIS field, not degrees per minute: the
// standard encodes it as ROT_AIS = 4.733 * sqrt(rate), so it has to be squared
// back out. Labelling the raw number "°/min" was simply wrong — a reported -29
// is -37 °/min, not -29.
//
// ±127 is reserved for "turning faster than 5°/30s, no turn indicator fitted"
// and must not be decoded; squaring it would claim about 720 °/min. -128 is
// "not available" and is already mapped to null upstream.
//
// Direction follows the navigation lights, which is what a mariner reads
// without thinking: port red, starboard green. Positive AIS rate is a turn to
// starboard — the same sign the vessel symbol uses for its turn flag.
export function rotCell(raw) {
  const label = 'Kääntyminen';
  if (!Number.isFinite(raw)) return { label, value: '–' };
  const side = raw > 0 ? 'stbd' : 'port';
  // No sign on the reserved value: "->10" reads as minus-greater-than, and the
  // colour already says which way.
  if (Math.abs(raw) === 127) return { label, value: '>10\u2009°/min', tone: side };
  const rate = Math.round((Math.abs(raw) / 4.733) ** 2) * Math.sign(raw);
  // The encoding is quadratic, so the smallest raw steps round to nothing. A
  // red or green zero would claim a turn the number denies.
  if (rate === 0) return { label, value: '0\u2009°/min' };
  return { label, value: `${rate > 0 ? '+' : ''}${rate}\u2009°/min`, tone: side };
}

export function ageText(sinceMs) {
  if (!sinceMs) return '';
  const s = Math.max(0, Math.round((Date.now() - sinceMs) / 1000));
  return s < 60 ? `${s} s sitten` : `${Math.round(s / 60)} min sitten`;
}
