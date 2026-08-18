// Shared app-wide constants.
//
// Pure and dependency-free — no OpenLayers, no DOM, no imports at all — so the
// node-harness-testable modules (src/edr/*, src/nowcast.js, src/obs/*) can
// import it without dragging a browser environment along.
//
// Per CLAUDE.md decomposition rule 2: nothing here may import radar.js.

// The animation window is exactly 13 frames — 12 five-minute steps, one hour.
// This is the single source of truth for that number (CLAUDE.md hard rule 4);
// before this module it lived as bare 13s and 12s, plus four separate private
// `const FRAME_COUNT = 13` declarations, across ten modules.
//
// FramePool.setWindow throws on any other length, so a change here is a change
// to the whole animation contract — read hard rule 4 before touching it.
export const FRAME_COUNT = 13;

// The number of steps *between* the frames: the window spans
// FRAME_STEPS * resolution, and valid cell indices are 0..FRAME_STEPS.
// The 13-vs-12 split is this codebase's most common off-by-one trap (hard
// rule 10) — reach for FRAME_STEPS whenever the number is a span or a last
// index, and FRAME_COUNT whenever it is a count or an array length.
export const FRAME_STEPS = FRAME_COUNT - 1;
