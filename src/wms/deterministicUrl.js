// MeteoCore server contract (see CLAUDE.md "MeteoCore request-shape rules"),
// "Deterministic URLs": round bbox coordinates to a fixed precision so equal
// views produce byte-identical GetMap URLs. OpenLayers serializes the raw
// doubles (…513499999-style tails) — sub-centimeter float noise that only
// fragments the exact-URL, browser and blob caches. Two decimals = 1 cm; at
// the deepest zoom (z16, ~2.4 m/px) the worst-case misregistration is
// ~0.004 px, far below anything visible.
//
// String surgery on the BBOX value only — no URL re-serialization, so the
// encoding and ordering of every other param (TIME's %3A, LAYERS, …) pass
// through byte-for-byte untouched. OL's appendParams encodes the separating
// commas as %2C; the raw form is handled too for robustness.

const BBOX_RE = /([?&]BBOX=)([^&#]*)/i;

export default function roundUrlBbox(src) {
  return src.replace(BBOX_RE, (match, prefix, value) => {
    const sep = value.includes('%2C') ? '%2C' : ',';
    const parts = value.split(sep);
    if (parts.length !== 4) return match;
    const rounded = parts.map((part) => {
      const n = Number(part);
      return Number.isFinite(n) ? n.toFixed(2) : part;
    });
    return prefix + rounded.join(sep);
  });
}
