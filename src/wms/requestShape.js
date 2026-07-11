// MeteoCore server contract (see CLAUDE.md "MeteoCore request-shape rules"):
// requested pixels are the dominant GetMap cost — render, encode and transfer
// all scale with WIDTH × HEIGHT — so every request gets one pixel budget:
//
//   - hard ceiling 6 Mpx per GetMap, target ≤ 4 Mpx
//   - requested DPR is capped at 1 (deliberate deviation from the contract's
//     "full devicePixelRatio when zoomed in" letter — see below); the whole
//     budget above the CSS viewport goes to the pan buffer (ratio up to 2)
//   - if even ratio MIN_RATIO at DPR 1 would exceed the ceiling (4K desktop
//     fullscreen), reduce effective DPR below 1 just enough to fit — the
//     browser upscales slightly, but the ceiling is never exceeded
//
// Why DPR 1 everywhere (client deviation, deliberate — keep it):
//
//   1. No current product out-resolves a CSS pixel at the zooms where the
//      contract wanted full DPR. The Finnish composite is ~250 m ground
//      resolution ≈ 515 m Web-Mercator at 61°N; at z9 one CSS pixel already
//      covers 306 m, so a DPR-1 request captures the data completely and a
//      DPR-3 iPhone request fetched 9× the pixels of the same information.
//   2. Symbol layers — observations and (mostly) lightning — render numbers
//      and glyphs at fixed pixel sizes server-side; at DPR > 1 they display
//      scaled down and become unreadably small. These must stay at DPR 1
//      even if a future high-res data product reintroduces DPR 2 for radar.
//   3. Fractional DPR (1.5, 3) puts the effective resolution between the
//      server's zoom-ladder steps — the "fractional zoom pays a fresh cold
//      render" case the contract warns about. Only DPR 1 and 2 land on
//      ladder steps.
//
// If a product whose native resolution genuinely exceeds CSS-pixel density
// at usable zooms appears, gate DPR 2 (never 1.5/3) on a per-layer
// nativeResolution hint — data layers only, symbol layers stay at 1.
//
// The shape maps onto a WMS request as WIDTH × HEIGHT = cssSize × dpr ×
// ratio: FramePool pushes the shape into each StickyImageWMS, which divides
// the view resolution by `dpr` and uses `ratio` as the ImageWMS buffer ratio.

export const TARGET_PIXELS = 4e6;
export const CEILING_PIXELS = 6e6;

// The server rejects GetMap WIDTH/HEIGHT above 8000 px. Requests shaped by
// computeRequestShape can never get near that, but the panes' BASE ImageWMS
// sources are unshaped (flat ratio, no pixel budget) — and production logs
// show rare runaway renders from them (e.g. WIDTH=186035: OL rendering while
// a layout transient made the map container look ~124k CSS px wide; sane z9
// resolution, insane size). The guard swaps such a request for a 1×1
// transparent image: no network, no 400, and the blank stretches invisibly
// over the bogus extent until the next (sane) render replaces it.
export const MAX_GETMAP_DIM = 8000;

const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// ol/source/ImageWMS `imageLoadFunction` that drops oversize GetMaps.
// `onOversize(width, height)` fires on each dropped request — wire it to
// telemetry so the layout transient that produces these can be identified.
export function createGetMapSizeGuard(onOversize) {
  return (image, src) => {
    const query = new URLSearchParams(src.slice(src.indexOf('?') + 1));
    const width = Number(query.get('WIDTH'));
    const height = Number(query.get('HEIGHT'));
    if (width > MAX_GETMAP_DIM || height > MAX_GETMAP_DIM) {
      if (onOversize) onOversize(width, height);
      image.getImage().src = BLANK_GIF;
      return;
    }
    image.getImage().src = src;
  };
}

// A pan buffer is not optional: sub-10% margins showed blank strips on every
// casual pan (Mac AND iPhone) and re-anchored/refetched the whole 13-frame
// window, because a thumb pan easily exceeds them. Guarantee a 20% margin
// per side by reserving room for it within the hard ceiling BEFORE computing
// effective DPR.
const MIN_RATIO = 1.4;
const MAX_RATIO = 2;

// Pure function of the CSS viewport size → { dpr, ratio }. Deterministic so
// identical viewports produce identical request shapes (and therefore
// identical, cacheable GetMap URLs).
export default function computeRequestShape({ width, height }) {
  const cssArea = width * height;
  if (!(cssArea > 0)) return { dpr: 1, ratio: MIN_RATIO };
  // DPR 1, squeezed below 1 only when the ceiling demands it (see above).
  const dpr = Math.min(1, Math.sqrt(CEILING_PIXELS / (cssArea * MIN_RATIO * MIN_RATIO)));
  const ratio = Math.min(
    MAX_RATIO,
    Math.max(MIN_RATIO, Math.sqrt(TARGET_PIXELS / (cssArea * dpr * dpr))),
  );
  return { dpr, ratio };
}
