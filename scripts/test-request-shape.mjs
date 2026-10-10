// Contract test for src/wms/requestShape.js — the per-side GetMap cap.
//
//   node scripts/test-request-shape.mjs        (or: npm test)
//
// Frame-pool GetMaps over the server's 8000 px per-side limit are 400s
// nobody sees: the frame just stays on its sticky predecessor. Production
// logged ~200 a day — normal aspects, far over the pixel ceiling, one anchor
// bbox requested at z8 and later at z10: the anchor extent of an earlier,
// coarser view requested at the current resolution. The steady-state shape
// can also overrun one side for a pane far wider than tall (a layout
// transient). This pins both guards — computeRequestShape's side cap and the
// StickyImageWMS backstop, fitRequestResolution — against OpenLayers' own
// request math (the real getRequestExtent, as ImageSource and the WMS loader
// apply it), so a change in OL's rounding or in either formula fails here,
// not in the server's error log.
//
// Plain node (24, for module.registerHooks), no runner. Exit code 0 = pass.

import { registerHooks } from 'node:module';
/* eslint-disable import/extensions */
import { getRequestExtent } from 'ol/source/Image.js';
import { getWidth, getHeight } from 'ol/extent.js';
import { get as getProjection } from 'ol/proj.js';
import computeRequestShape, {
  MAX_GETMAP_DIM, CEILING_PIXELS, getMapMaxSize, setGetMapLimits, createGetMapSizeGuard,
  fitRequestResolution,
} from '../src/wms/requestShape.js';
/* eslint-enable import/extensions */

// StickyImageWMS imports extensionless specifiers (webpack supplies them).
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if ((specifier.startsWith('.') || specifier.startsWith('ol/')) && !specifier.endsWith('.js')) {
      return next(`${specifier}.js`, context);
    }
    return next(specifier, context);
  },
});
// eslint-disable-next-line import/extensions
const { default: StickyImageWMS } = await import('../src/animation/stickyImageWMS.js');
hooks.deregister();

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// WIDTH/HEIGHT and the request bbox exactly as a FramePool slot produces
// them: StickyImageWMS hands OL the anchor extent (CSS size × view
// resolution) at resolution / dpr; ImageSource.getImageInternal snaps it with
// ratio 1, the WMS loader buffers it by `ratio`, getImageSrc divides by the
// resolution.
function getMapFor([cssW, cssH], shape, viewRes = 152.874) {
  const res = viewRes / shape.dpr;
  const anchor = [1e6, 8e6, 1e6 + cssW * viewRes, 8e6 + cssH * viewRes];
  const wrapperExtent = getRequestExtent(anchor, res, 1, 1);
  const bbox = getRequestExtent(wrapperExtent, res, 1, shape.ratio);
  return {
    width: Math.round(getWidth(bbox) / res),
    height: Math.round(getHeight(bbox) / res),
    bboxW: getWidth(bbox),
    bboxH: getHeight(bbox),
    res,
  };
}

const sane = [
  [390, 844], [844, 390], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160],
  [5120, 1440], [7680, 2160], [195, 422], [960, 1080], [1720, 720],
];
const pathological = [
  [124000, 800], [800, 124000], [20000, 100], [9000, 9], [186035, 1], [30000, 3000],
];

// Real screens never reach the cap: the shape is the plain budget one.
for (const size of sane) {
  const [w, h] = size;
  const capped = computeRequestShape({ width: w, height: h });
  const uncapped = computeRequestShape({ width: w, height: h }, { maxWidth: 1e9, maxHeight: 1e9 });
  check(
    `${w}x${h}: side cap does not bind a real viewport`,
    capped.dpr === uncapped.dpr && capped.ratio === uncapped.ratio,
    JSON.stringify({ capped, uncapped }),
  );
}

// Every size, default limit and advertised limits: no side over the limit.
const limits = [
  { maxWidth: MAX_GETMAP_DIM, maxHeight: MAX_GETMAP_DIM },
  { maxWidth: 4096, maxHeight: 4096 },
  { maxWidth: 8000, maxHeight: 2000 },
];
for (const lim of limits) {
  for (const size of [...sane, ...pathological]) {
    const shape = computeRequestShape({ width: size[0], height: size[1] }, lim);
    const g = getMapFor(size, shape);
    check(
      `${size[0]}x${size[1]} @ ${lim.maxWidth}x${lim.maxHeight}: GetMap ${g.width}x${g.height} within limit`,
      g.width <= lim.maxWidth && g.height <= lim.maxHeight && g.width >= 1 && g.height >= 1,
    );
  }
}

// Clamping scales the image, not the area: the bbox stays CSS size × ratio
// (to OL's one-pixel ceil), and both sides shrink by the same factor.
{
  const size = [124000, 800];
  const capped = computeRequestShape({ width: size[0], height: size[1] });
  const uncapped = computeRequestShape({ width: size[0], height: size[1] }, { maxWidth: 1e9, maxHeight: 1e9 });
  const a = getMapFor(size, capped);
  const b = getMapFor(size, uncapped);
  check('pathological pane: uncapped shape would exceed the limit', b.width > MAX_GETMAP_DIM, `${b.width}`);
  check('pathological pane: capped keeps the buffer ratio', capped.ratio === uncapped.ratio);
  check(
    'pathological pane: capped bbox covers the same width',
    Math.abs(a.bboxW - b.bboxW) <= 4 * a.res,
    `${a.bboxW} vs ${b.bboxW}`,
  );
  check(
    'pathological pane: capped bbox covers the same height',
    Math.abs(a.bboxH - b.bboxH) <= 4 * a.res,
    `${a.bboxH} vs ${b.bboxH}`,
  );
  check(
    'pathological pane: aspect kept',
    Math.abs(a.width / a.height - b.width / b.height) / (b.width / b.height) < 0.1,
    `${a.width}x${a.height} vs ${b.width}x${b.height}`,
  );
}

// Advertised limits: used when present, MAX_GETMAP_DIM otherwise.
{
  const url = 'https://wms.example/wms';
  let lim = getMapMaxSize(url);
  check(
    'no capabilities yet → MAX_GETMAP_DIM',
    lim.maxWidth === MAX_GETMAP_DIM && lim.maxHeight === MAX_GETMAP_DIM,
  );
  setGetMapLimits(url, { Title: 'x' });
  lim = getMapMaxSize(url);
  check(
    'capabilities without MaxWidth/MaxHeight → MAX_GETMAP_DIM',
    lim.maxWidth === MAX_GETMAP_DIM && lim.maxHeight === MAX_GETMAP_DIM,
  );
  setGetMapLimits(url, { MaxWidth: 4096, MaxHeight: 3000 });
  lim = getMapMaxSize(url);
  check('advertised MaxWidth/MaxHeight are used', lim.maxWidth === 4096 && lim.maxHeight === 3000);
  setGetMapLimits(url, undefined);
  lim = getMapMaxSize(url);
  check('missing Service block → MAX_GETMAP_DIM', lim.maxWidth === MAX_GETMAP_DIM);
  check('other endpoints unaffected', getMapMaxSize('https://other/wms').maxWidth === MAX_GETMAP_DIM);

  // The base-source guard honours the advertised limit too.
  setGetMapLimits(url, { MaxWidth: 4096, MaxHeight: 4096 });
  const dropped = [];
  const guard = createGetMapSizeGuard((w, h) => dropped.push(`${w}x${h}`));
  const img = { src: '' };
  const wrapper = { getImage: () => img };
  guard(wrapper, `${url}?SERVICE=WMS&WIDTH=5000&HEIGHT=100`);
  check('guard drops a request over the advertised limit', dropped.length === 1 && img.src.startsWith('data:'));
  guard(wrapper, `${url}?SERVICE=WMS&WIDTH=4000&HEIGHT=100`);
  check('guard passes a request within it', dropped.length === 1 && img.src.startsWith(url));
}

// The backstop is inert for every consistent request: anchor and
// resolution from the same view, shaped by computeRequestShape — the URLs
// pan-away-and-back relies on stay byte-identical.
for (const lim of limits) {
  for (const size of [...sane, ...pathological]) {
    const shape = computeRequestShape({ width: size[0], height: size[1] }, lim);
    for (const viewRes of [9783.94, 611.496, 152.874, 0.597]) {
      const anchor = [1e6, 8e6, 1e6 + size[0] * viewRes, 8e6 + size[1] * viewRes];
      const res = viewRes / shape.dpr;
      const fitted = fitRequestResolution(anchor, res, shape.ratio, lim);
      if (fitted !== res) {
        check(
          `${size[0]}x${size[1]} @ ${lim.maxWidth}x${lim.maxHeight} res ${viewRes}: backstop inert`,
          false,
          `${res} → ${fitted}`,
        );
      }
    }
  }
}
check('backstop inert for every consistent request', true);

// WIDTH/HEIGHT/bbox for `extent` requested at `res` with buffer `ratio`.
function getMapAt(extent, res, ratio) {
  const wrapperExtent = getRequestExtent(extent, res, 1, 1);
  const bbox = getRequestExtent(wrapperExtent, res, 1, ratio);
  return {
    width: Math.round(getWidth(bbox) / res),
    height: Math.round(getHeight(bbox) / res),
    bboxW: getWidth(bbox),
    bboxH: getHeight(bbox),
  };
}

// The production case: a 960×540 pane (dpr 1, ratio 2) anchored at z5,
// requested at z8 and z10. Uncapped that is 15360×8640 over a
// 9392582 × 5283327 m bbox — the logged request; capped it fits the side
// limit and the ceiling, over the same bbox (to OL's pixel ceil) and aspect.
{
  const R0 = 156543.03392804097;
  const size = [960, 540];
  const shape = computeRequestShape({ width: size[0], height: size[1] });
  const anchorRes = R0 / 2 ** 5;
  // Centred on the logged BBOX=-2348145.51,7264575.17,7044436.53,12547902.56.
  const cx = (-2348145.51 + 7044436.53) / 2;
  const cy = (7264575.17 + 12547902.56) / 2;
  const halfW = (size[0] * anchorRes) / 2;
  const halfH = (size[1] * anchorRes) / 2;
  const ext = [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
  const raw = getMapAt(ext, R0 / 2 ** 8, shape.ratio);
  check(
    'stale anchor reproduces the logged 15360x8640',
    raw.width === 15360 && raw.height === 8640 && Math.abs(raw.bboxW - 9392582.04) < 1,
    `${raw.width}x${raw.height} ${raw.bboxW}`,
  );
  for (const lim of [...limits, { maxWidth: 2048, maxHeight: 2048 }]) {
    for (const z of [8, 10, 12]) {
      const viewRes = R0 / 2 ** z;
      const res = fitRequestResolution(ext, viewRes / shape.dpr, shape.ratio, lim);
      const g = getMapAt(ext, res, shape.ratio);
      const u = getMapAt(ext, viewRes / shape.dpr, shape.ratio);
      // The ceiling bounds the unrounded size; OL's ceil adds ≤ 4 px a side.
      check(
        `stale anchor z5→z${z} @ ${lim.maxWidth}x${lim.maxHeight}: GetMap ${g.width}x${g.height} within limit and ceiling`,
        g.width <= lim.maxWidth && g.height <= lim.maxHeight
          && (g.width - 4) * (g.height - 4) <= CEILING_PIXELS,
      );
      check(
        `stale anchor z5→z${z} @ ${lim.maxWidth}x${lim.maxHeight}: same bbox, same aspect`,
        Math.abs(g.bboxW - u.bboxW) <= 4 * res && Math.abs(g.bboxH - u.bboxH) <= 4 * res
          && Math.abs(g.width / g.height - u.width / u.height) / (u.width / u.height) < 0.01,
        `${g.width}x${g.height} vs ${u.width}x${u.height}`,
      );
    }
  }
}

// Wiring: StickyImageWMS applies the backstop on every getImage-family
// call, with the advertised limit of its own endpoint.
{
  const url = 'https://sticky.example/wms';
  const R0 = 156543.03392804097;
  const projection = getProjection('EPSG:3857');
  const source = new StickyImageWMS({
    url, params: { LAYERS: 'x' }, ratio: 1.5, hidpi: false, serverType: 'geoserver',
  });
  const size = [960, 540];
  const shape = computeRequestShape({ width: size[0], height: size[1] });
  source.setRequestShape(shape);
  const anchorRes = R0 / 2 ** 5;
  const anchor = [0, 8e6, size[0] * anchorRes, 8e6 + size[1] * anchorRes];
  source.setAnchorExtent(anchor);
  const sizeOf = (image) => getMapAt(image.getExtent(), image.getResolution(), shape.ratio);

  let g = sizeOf(source.getImage(anchor, anchorRes, 1, projection));
  check('sticky: consistent request untouched', g.width === 1920 && g.height === 1080, `${g.width}x${g.height}`);
  source.resetImageCache();
  g = sizeOf(source.getImage(anchor, R0 / 2 ** 8, 1, projection));
  check(
    `sticky: stale anchor capped to ${g.width}x${g.height}`,
    g.width <= MAX_GETMAP_DIM && g.height <= MAX_GETMAP_DIM && g.width * g.height < 1.01 * CEILING_PIXELS,
  );
  setGetMapLimits(url, { MaxWidth: 2048, MaxHeight: 2048 });
  source.resetImageCache();
  g = sizeOf(source.getImage(anchor, R0 / 2 ** 8, 1, projection));
  check(`sticky: advertised limit honoured (${g.width}x${g.height})`, g.width <= 2048 && g.height <= 2048);
}

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall request-shape checks passed');
