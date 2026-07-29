// Nowcast mode ("Suomi + ennuste"): one 13-frame window mixing the observed
// Finnish composite (cells 0..NOW_INDEX, the boundary cell included) with the
// fmi-radar-nowcast forecast product (cells NOW_INDEX+1..12). The boundary
// ("now") is the newest observed composite frame; the forecast product is a
// motion extrapolation published as ~5-min model runs of which the server
// retains only the two newest.
//
// Server contract (live-verified 2026-07-29):
// - The honored GetMap run-pin parameter is DIM_REFERENCE_TIME (the WMS 1.3.0
//   custom-dimension spelling). A bare REFERENCE_TIME= is SILENTLY IGNORED —
//   the response is byte-identical to omitting it. Never use the bare form.
// - Responses are Cache-Control: immutable for 24 h, so an un-pinned forecast
//   URL would keep serving whatever run it was first rendered from. Every
//   forecast GetMap must carry an explicit DIM_REFERENCE_TIME.
// - Pinning an expired run returns HTTP 400 (InvalidDimensionValue); a TIME
//   outside a run's range does NOT error, it snaps (nearestValue) — so
//   correctness comes from pinning the newest advertised run, never from
//   server-side defaults.
// - The run can lag the newest observed frame by one 5-min step; its +2 h
//   range still covers the 30-min forecast half either way.
//
// Pure module, dependency-free (node-harness testable like src/edr/*).

export const NOWCAST_LAYER = 'fmi-radar-nowcast';
export const OBSERVED_LAYER = 'fmi-radar-composite-dbz';

// Boundary cell index of the 13-cell window: cells 0..NOW_INDEX are observed,
// NOW_INDEX+1..12 forecast. The window stays 13 frames (hard rule 4) — only
// its anchoring changes: end = newest observed + FUTURE_STEPS * step.
export const NOW_INDEX = 6;
export const FUTURE_STEPS = 6;

// Frame times arrive either as plain ISO instants (windowInstant) or as
// accumulation intervals "PT5M/<iso>" (windowInterval, used by the lightning
// WMS companion pool). Compare on the instant part.
function frameMs(timeValue) {
  const s = String(timeValue);
  const iso = s.includes('/') ? s.slice(s.indexOf('/') + 1) : s;
  return Date.parse(iso);
}

// OL-parsed capabilities Dimension array -> { values: [ms...] ascending,
// default: ms } for the reference_time dimension, or null when absent.
// `values` is the raw comma-joined string from the XML.
export function parseReferenceTimes(dimensions) {
  if (!Array.isArray(dimensions)) return null;
  const dim = dimensions.find((d) => d && d.name === 'reference_time');
  if (!dim || !dim.values) return null;
  const values = String(dim.values)
    .split(',')
    .map((v) => Date.parse(v.trim()))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  if (!values.length) return null;
  const def = dim.default ? Date.parse(dim.default) : NaN;
  return { values, default: Number.isFinite(def) ? def : values[values.length - 1] };
}

// Newest advertised model run for a layerInfo entry (null when the layer or
// its reference_time dimension isn't advertised). The default is documented
// as the newest run; max() over the list is belt and braces.
export function newestReferenceMs(info) {
  const rt = info && info.referenceTime;
  if (!rt || !Array.isArray(rt.values) || !rt.values.length) return null;
  return Math.max(rt.default || 0, rt.values[rt.values.length - 1]);
}

// The layer whose TIME dimension anchors the shared window / new-frame ETA
// when `wmslayer` is selected: the nowcast entry anchors on the observed
// composite (its own time.end is +2 h out and must never inflate "now").
export function timeLayerFor(wmslayer) {
  return wmslayer === NOWCAST_LAYER ? OBSERVED_LAYER : wmslayer;
}

// The product the EDR probe/crosshair should query when `wmslayer` is
// selected: the EDR API has no forecast collection, so the nowcast entry
// probes the observed composite (future frames simply have no EDR values).
export function edrLayerFor(wmslayer) {
  return wmslayer === NOWCAST_LAYER ? OBSERVED_LAYER : wmslayer;
}

// Slot-params provider for a pane's radar FramePool (see
// FramePool.setSlotParamsProvider). All inputs are live getters — the pinned
// run is re-read from the latest capabilities at every evaluation, never
// latched (the storm-cells "re-read, never latch" precedent).
export function makeRadarSlotProvider({ isNowcastPane, getBoundaryMs, getNowcastRefMs }) {
  return (timeValue) => {
    const t = frameMs(timeValue);
    if (!Number.isFinite(t)) return null;
    const boundary = getBoundaryMs();
    if (!isNowcastPane()) {
      // A plain radar product in a split whose OTHER pane runs nowcast
      // mode: the shared window extends into the future, where this
      // product would snap to its newest frame — never fetch there.
      return boundary != null && t > boundary ? { skip: true } : null;
    }
    // Mode selected but the window not yet routed (boot, mode just
    // entered): don't fetch anything transient.
    if (boundary == null) return { skip: true };
    if (t <= boundary) return { params: { LAYERS: OBSERVED_LAYER } };
    const refMs = getNowcastRefMs();
    // Forecast product not (yet) advertised — leave future cells empty.
    if (!refMs) return { skip: true };
    return {
      params: {
        LAYERS: NOWCAST_LAYER,
        DIM_REFERENCE_TIME: new Date(refMs).toISOString(),
      },
    };
  };
}

// Provider for the other raster pools (satellite, lightning WMS companion):
// their products end at or before "now", so frames past the boundary would
// snap server-side — skip them. Inert (returns null) while no pane is in
// nowcast mode, keeping today's behavior byte-identical.
export function makeCoverageSlotProvider({ getBoundaryMs }) {
  return (timeValue) => {
    const boundary = getBoundaryMs();
    if (boundary == null) return null;
    const t = frameMs(timeValue);
    return Number.isFinite(t) && t > boundary ? { skip: true } : null;
  };
}
