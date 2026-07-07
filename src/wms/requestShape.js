// MeteoCore server contract (see CLAUDE.md "MeteoCore request-shape rules"):
// requested pixels are the dominant GetMap cost — render, encode and transfer
// all scale with WIDTH × HEIGHT — so every request gets one pixel budget,
// split zoom-adaptively between device-native sharpness and pan buffer:
//
//   - hard ceiling 6 Mpx per GetMap, target ≤ 4 Mpx
//   - zoomed in (z ≥ 8): render at full devicePixelRatio — browser upscaling
//     blurs the radar cell edges the user is inspecting — and compute the
//     buffer ratio from whatever budget is left
//   - zoomed out (z ≤ 7): the slight upscale is imperceptible at synoptic
//     scale, so cap effective DPR at 1.5 and spend the freed budget on a
//     bigger pan buffer (ratio up to 2)
//   - if even ratio 1.0 at the allowed DPR would exceed the ceiling (large
//     retina desktop fullscreen), reduce effective DPR just enough to fit —
//     never exceed the ceiling
//
// The shape maps onto a WMS request as WIDTH × HEIGHT = cssSize × dpr ×
// ratio: FramePool pushes the shape into each StickyImageWMS, which divides
// the view resolution by `dpr` (more pixels over the same extent) and uses
// `ratio` as the ImageWMS buffer ratio.

export const TARGET_PIXELS = 4e6;
export const CEILING_PIXELS = 6e6;

const FULL_DPR_MIN_ZOOM = 8;
const SYNOPTIC_DPR_CAP = 1.5;
// A pan buffer is not optional. The contract's letter allows the ratio to
// fall to 1.0 when full DPR exhausts the ceiling (any retina Mac) and to
// ~1.16 on phones zoomed in — in practice both showed blank strips on
// every casual pan AND re-anchored/refetched the whole 13-frame window,
// because a thumb pan easily exceeds a sub-10% margin. Guarantee a 20%
// margin per side (close to the pre-budget ratio 1.5 feel) by reserving
// room for it within the hard ceiling BEFORE computing effective DPR — a
// deliberate deviation from the contract's sharpness-first letter in
// favor of its pan-buffer intent. Standard phones still fit full DPR
// (390×844×3² × 1.4² = 5.8 Mpx ≤ 6); large retina viewports trade some
// sharpness (MBP 14": 1.39× upscale) for a usable buffer.
const MIN_RATIO = 1.4;
const MAX_RATIO = 2;

// Pure function of (CSS viewport size, device pixel ratio, integer zoom) →
// { dpr, ratio }. Deterministic so identical viewports produce identical
// request shapes (and therefore identical, cacheable GetMap URLs).
export default function computeRequestShape({
  width, height, devicePixelRatio, zoom,
}) {
  const cssArea = width * height;
  if (!(cssArea > 0)) return { dpr: 1, ratio: MIN_RATIO };
  const deviceDpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  // The view snaps to integer Web-Mercator levels (constrainResolution);
  // round anyway so float noise can't flip the branch at the boundary.
  const zoomedIn = Math.round(zoom) >= FULL_DPR_MIN_ZOOM;
  let dpr = zoomedIn ? deviceDpr : Math.min(deviceDpr, SYNOPTIC_DPR_CAP);
  // Reserve room for the minimum buffer within the hard ceiling.
  dpr = Math.min(dpr, Math.sqrt(CEILING_PIXELS / (cssArea * MIN_RATIO * MIN_RATIO)));
  const ratio = Math.min(
    MAX_RATIO,
    Math.max(MIN_RATIO, Math.sqrt(TARGET_PIXELS / (cssArea * dpr * dpr))),
  );
  return { dpr, ratio };
}
