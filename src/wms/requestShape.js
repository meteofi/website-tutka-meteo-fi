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
//   - neither WIDTH nor HEIGHT exceeds the server's per-side limit (8000 px,
//     or its advertised <MaxWidth>/<MaxHeight>) — reached the same way, by
//     lowering effective DPR (see MAX_GETMAP_DIM)
//
// Why DPR 1 everywhere (client deviation, deliberate — keep it):
//
//   1. No current product out-resolves a CSS pixel at the zooms where the
//      contract wanted full DPR. The Finnish composite is ~250 m ground
//      resolution ≈ 515 m Web-Mercator at 61°N; at z9 one CSS pixel already
//      covers 306 m, so a DPR-1 request captures the data completely and a
//      DPR-3 iPhone request fetched 9× the pixels of the same information.
//   2. Symbol layers — today the EUMETSAT lightning imager (li_afa) and RDT
//      overlays — render glyphs and outlines at fixed pixel sizes
//      server-side; at DPR > 1 they display scaled down and become
//      unreadably small. These must stay at DPR 1 even if a future high-res
//      data product reintroduces DPR 2 for radar. (FMI observations and
//      lightning, the original motivation for this rule, are client-rendered
//      EDR vector layers now and out of WMS entirely.)
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

// The server rejects GetMap WIDTH/HEIGHT above 8000 px (MeteoCore answers
// 400). The pixel budget bounds WIDTH × HEIGHT, not either side, so three
// guards keep each side under the limit:
//
//   - computeRequestShape caps the longer side (see sideCappedDpr below),
//     so a pane far wider than tall still gets a valid steady-state shape;
//   - fitRequestResolution is the backstop where every frame-pool GetMap is
//     built (StickyImageWMS): whatever extent and resolution reach it, the
//     request stays within the side limit and the pixel ceiling;
//   - the panes' BASE ImageWMS sources are unshaped (flat ratio, no pixel
//     budget) — and production logs show rare runaway renders from them
//     (e.g. WIDTH=186035: OL rendering while a layout transient made the
//     map container look ~124k CSS px wide; sane z9 resolution, insane
//     size). createGetMapSizeGuard swaps such a request for a 1×1
//     transparent image: no network, no 400, and the blank stretches
//     invisibly over the bogus extent until the next (sane) render
//     replaces it.
export const MAX_GETMAP_DIM = 8000;

// Per-server limits advertised in GetCapabilities (WMS 1.3.0 Service
// <MaxWidth>/<MaxHeight>, read by ol/format/WMSCapabilities), keyed by the
// endpoint URL the sources request — radar.js records them on every
// capabilities refresh. A server that advertises none, or one whose
// capabilities have not arrived yet, gets MAX_GETMAP_DIM.
const advertisedLimits = new Map();

export function setGetMapLimits(url, service) {
  advertisedLimits.set(url, {
    maxWidth: service && service.MaxWidth,
    maxHeight: service && service.MaxHeight,
  });
}

// Room OL's own rounding needs on top of cssSide × dpr × ratio: its
// getRequestExtent ceil()s the view size and each margin, which adds at
// most ratio + 2 ≤ 4 px to a requested side.
const SIDE_SLACK = 4;

const usableLimit = (v) => (Number.isFinite(v) && v > SIDE_SLACK ? v : MAX_GETMAP_DIM);

// → { maxWidth, maxHeight } for the WMS endpoint `url`.
export function getMapMaxSize(url) {
  const advertised = advertisedLimits.get(url) || {};
  return {
    maxWidth: usableLimit(advertised.maxWidth),
    maxHeight: usableLimit(advertised.maxHeight),
  };
}

// → the resolution at which a frame-pool GetMap for `extent` (buffered by
// `ratio`, as the WMS loader does) stays within `limits` per side and within
// CEILING_PIXELS: `resolution` itself, or the coarser one that just fits.
// Coarsening keeps the bbox — OL draws the smaller image over the same
// extent, as it does for the ceiling's DPR < 1.
//
// A consistent request (anchor extent and resolution from the same view)
// is already inside both bounds via computeRequestShape, so this never
// binds for one. It binds when they come from different views. Production
// logged ~200 slot GetMaps a day over 8000 px, none of them an extreme
// aspect (15360×8640, 33408×66816, …: 7.5× to thousands of times the
// ceiling), and one anchor BBOX requested at z8 and, hours later, at z10.
// That is an anchor extent from an earlier, coarser view requested at the
// current resolution: 960×540 CSS anchored at z5 and requested at z8 is
// 15360×8640 over the logged bbox to the metre.
export function fitRequestResolution(extent, resolution, ratio, { maxWidth, maxHeight }) {
  const w = (extent[2] - extent[0]) * ratio;
  const h = (extent[3] - extent[1]) * ratio;
  const fit = Math.max(
    w / (maxWidth - SIDE_SLACK),
    h / (maxHeight - SIDE_SLACK),
    Math.sqrt((w * h) / CEILING_PIXELS),
  );
  // A consistent request can sit exactly ON a bound (the ceiling for large
  // panes, the side cap for extreme ones); float noise there must not move
  // the resolution and with it the byte-identical URLs.
  return fit > resolution * (1 + 1e-9) ? fit : resolution;
}

const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// ol/source/ImageWMS `imageLoadFunction` that drops oversize GetMaps.
// `onOversize(width, height)` fires on each dropped request — wire it to
// telemetry so the layout transient that produces these can be identified.
export function createGetMapSizeGuard(onOversize) {
  return (image, src) => {
    const query = new URLSearchParams(src.slice(src.indexOf('?') + 1));
    const width = Number(query.get('WIDTH'));
    const height = Number(query.get('HEIGHT'));
    const { maxWidth, maxHeight } = getMapMaxSize(src.slice(0, src.indexOf('?')));
    if (width > maxWidth || height > maxHeight) {
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

// Pure function of the CSS viewport size (and the server's per-side limit,
// see getMapMaxSize) → { dpr, ratio }. Deterministic so identical viewports
// produce identical request shapes (and therefore identical, cacheable
// GetMap URLs).
export default function computeRequestShape(
  { width, height },
  { maxWidth = MAX_GETMAP_DIM, maxHeight = MAX_GETMAP_DIM } = {},
) {
  const cssArea = width * height;
  if (!(cssArea > 0)) return { dpr: 1, ratio: MIN_RATIO };
  // DPR 1, squeezed below 1 only when the ceiling demands it (see above).
  const budgetDpr = Math.min(1, Math.sqrt(CEILING_PIXELS / (cssArea * MIN_RATIO * MIN_RATIO)));
  const ratio = Math.min(
    MAX_RATIO,
    Math.max(MIN_RATIO, Math.sqrt(TARGET_PIXELS / (cssArea * budgetDpr * budgetDpr))),
  );
  // Per-side cap: the ceiling bounds the area, so only a pane with an
  // extreme aspect (> ~10:1 — a layout transient, never a real screen) can
  // ask for a side over the server's limit. Squeeze DPR further, exactly as
  // the ceiling does: both sides shrink together, the bbox (CSS size ×
  // ratio in world units) is unchanged, and OL draws the coarser image over
  // the same extent. The buffer ratio stays — the cap costs sharpness only.
  const sideCappedDpr = Math.min(
    (maxWidth - SIDE_SLACK) / (width * ratio),
    (maxHeight - SIDE_SLACK) / (height * ratio),
  );
  return { dpr: Math.min(budgetDpr, sideCappedDpr), ratio };
}
