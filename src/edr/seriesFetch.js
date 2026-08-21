// Orchestration plumbing shared by the two EDR point-series consumers: the
// probe chart (src/probe.js) and the crosshair readout (src/crosshair.js).
//
// Companion to peaks.js. That one shares the *answer* (one value per frame);
// this one shares the *bookkeeping* around getting it — which window is being
// shown, whether the displayed product actually changed, and the
// abort-the-previous-request dance. Both files used to carry their own copy,
// marked "Mirror probe.setActiveLayer" / "Mirror probe.setCursor" (issue #126).
//
// What is deliberately NOT here: each consumer keeps its own `series` and its
// own state machine. The probe has loading/empty/error states and an SVG to
// render; the crosshair has a reticle that is either showing a number or not.
// Forcing those into a common shape would cost more than the duplication did.
//
// Pure except for AbortController, and dependency-free — no OpenLayers, no DOM,
// and no import of probe.js (which would be a cycle, since probe.js imports
// this). The EDR target is resolved by the caller and handed in.

// Explicit .js extension, unlike the rest of src/: webpack resolves either
// form, but bare node does not guess, and this module is meant to be runnable
// from a node harness (scripts/test-peaks.mjs style). Do not "tidy" it away.
// eslint-disable-next-line import/extensions
import { FRAME_STEPS } from '../constants.js';

// The [start, end] instants a cursor window covers. The window spans the whole
// animation window, so the end is FRAME_STEPS (not FRAME_COUNT) steps out — the
// classic off-by-one here, which is why it lives in one place.
export function frameWindow(windowStartMs, stepMs) {
  return [windowStartMs, windowStartMs + FRAME_STEPS * stepMs];
}

// Whether two windows denote the same span. Used to decide refetch-vs-repick:
// a cursor move inside the same window only needs the cached series.
export function sameWindow(a, b) {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}

// Whether two resolved EDR targets denote the same query. Guards against
// re-fetching when a layer change does not actually change the data source —
// several WMS layers map onto one collection/parameter/elevation.
export function sameTarget(a, b) {
  return !!a && !!b && a.collection === b.collection
    && a.parameter === b.parameter && a.z === b.z;
}

// A single-slot abortable request.
//
// Starting a request cancels the one before it, so a fast pan or a scrubbed
// timeline leaves exactly one live query. `run` resolves to:
//
//   undefined              this request was superseded or cancelled — the
//                          caller must do nothing, because a newer request
//                          now owns the UI
//   { ok: true,  data }    completed
//   { ok: false, error }   failed for a real reason (not an abort)
//
// Returning undefined rather than throwing for the superseded case is the
// point: "someone else is handling it now" is not an error, and callers that
// treat it as one flash an error state during ordinary panning.
export function createFetchSlot() {
  let inFlight = null;
  return {
    abort() {
      if (inFlight) {
        inFlight.abort();
        inFlight = null;
      }
    },
    isBusy: () => inFlight != null,
    // `task` receives the AbortSignal to pass down to fetch.
    async run(task) {
      if (inFlight) inFlight.abort();
      const mine = new AbortController();
      inFlight = mine;
      try {
        const data = await task(mine.signal);
        // Aborted after the await resolved but before we got here: a newer
        // request is already in charge, so drop this result on the floor.
        if (mine.signal.aborted) return undefined;
        return { ok: true, data };
      } catch (err) {
        if (err && err.name === 'AbortError') return undefined;
        return { ok: false, error: err };
      } finally {
        // Only clear the slot if it is still ours — a request that superseded
        // us has already installed its own controller.
        if (inFlight === mine) inFlight = null;
      }
    },
  };
}
