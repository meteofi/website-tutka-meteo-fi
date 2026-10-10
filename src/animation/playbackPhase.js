// Sample the clock without owning its state: radar.js keeps the RAF and cursor.
// Carry a short overrun into the next observation pair so late callbacks do
// not slow playback. After a suspension, advance only once and restart at the
// observation; catching up multiple frames would burst through setTime/fetches.
export default function playbackPhase(now, lastAdvance, stepDuration) {
  const elapsed = Math.max(0, now - lastAdvance);
  const advance = elapsed >= stepDuration;
  let startedAt = lastAdvance;
  if (advance) {
    startedAt = elapsed < 2 * stepDuration ? lastAdvance + stepDuration : now;
  }
  return {
    advance,
    startedAt,
    // A RAF timestamp can slightly precede performance.now() used by play().
    t: Math.max(0, (now - startedAt) / stepDuration),
  };
}
