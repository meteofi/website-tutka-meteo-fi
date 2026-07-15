import { transform } from 'ol/proj';
import { getDistance } from 'ol/sphere';
import {
  quantizeEndpoint, buildTrajectoryUrl, collectionMetadataUrl,
  parseTemporalValues, snapToAdvertised, parseSection, singleVariantOf,
} from './edr/trajectoryQuery';
import { paramSpec } from './probe';

// Poikkileikkaus controller + bottom panel: renders a vertical radar
// cross-section (distance along the drawn line × height above the antenna)
// from the MeteoCore EDR trajectory endpoint, following the animation clock.
//
// There is no 3D composite, so every section comes from a single radar: the
// best site for the line is picked automatically (smallest worse-endpoint
// distance within coverage) and can be overridden from the header dropdown.
//
// The section follows the current animation frame; after the current frame
// renders, the other window frames prefetch in the background (≤2 in flight)
// so playback animates from cache. The requested datetime must verbatim
// match a value the collection advertises — off-grid datetimes 404 — so
// frame times snap against the collection metadata, misses are poisoned
// (never blind-retried; unpoisoned when the metadata refreshes), and the
// last good section stays on screen while the current frame is loading or
// missing (the StickyImageWMS philosophy applied to a canvas).
//
// NOTE (CLAUDE.md hard rule 3): every `Map` in this file is the built-in
// JavaScript Map — never import OL's Map here.

const PARAMETER = 'DBZH';
const FRAME_COUNT = 13; // the animation window (12 five-minute steps)
const HEIGHT_CAP_M = 15000; // Finnish echo tops stay below this; crop for pixel density
const CACHE_MAX = 32; // 13 frames + a site switch's worth of sections
const META_TTL_MS = 60000; // rides the app's 60 s capabilities cadence
const MAX_PREFETCH = 2; // deliberately below the WMS path's 4 — pvol colds stream from S3
const TIE_BREAK_M = 1000; // sites this close compete on single-variant preference

// dBZ color ramp for the heatmap, roughly matching the radar WMS palette so
// map and section read the same. Values below the parameter's "no signal"
// floor render transparent.
const RAMP_MAX_DBZ = 60;
const RAMP_STOPS = [
  [0, 0x7F, 0xD3, 0xF2],
  [10, 0x3B, 0xA8, 0xE5],
  [20, 0x4C, 0xC9, 0x4C],
  [30, 0xFF, 0xE3, 0x4D],
  [40, 0xFF, 0x9A, 0x2E],
  [50, 0xF0, 0x3B, 0x24],
  [60, 0xC3, 0x28, 0xC3],
];

// 256-entry RGB lookup over [floor, RAMP_MAX_DBZ].
function buildLut(floorDbz) {
  const lut = new Uint8ClampedArray(256 * 3);
  const span = RAMP_MAX_DBZ - floorDbz;
  for (let i = 0; i < 256; i++) {
    const v = floorDbz + (i / 255) * span;
    let lo = RAMP_STOPS[0];
    let hi = RAMP_STOPS[RAMP_STOPS.length - 1];
    for (let s = 0; s < RAMP_STOPS.length - 1; s++) {
      if (v >= RAMP_STOPS[s][0] && v <= RAMP_STOPS[s + 1][0]) {
        lo = RAMP_STOPS[s];
        hi = RAMP_STOPS[s + 1];
        break;
      }
    }
    const t = hi[0] === lo[0] ? 0 : Math.min(1, Math.max(0, (v - lo[0]) / (hi[0] - lo[0])));
    lut[i * 3] = lo[1] + (hi[1] - lo[1]) * t;
    lut[i * 3 + 1] = lo[2] + (hi[2] - lo[2]) * t;
    lut[i * 3 + 2] = lo[3] + (hi[3] - lo[3]) * t;
  }
  return lut;
}

// Canvas text/grid colors — the time-control chrome is always dark, so these
// mirror the --dark-* CSS variables (canvas can't read CSS custom properties
// cheaply).
const TEXT_DIM = 'rgba(255, 255, 255, 0.60)';
const GRID = 'rgba(255, 255, 255, 0.08)';
const COLOR_A = '#12BCFA'; // endpoint colors match sectionLine's map markers
const COLOR_B = '#E255C7';

const MSG = {
  loading: 'Ladataan poikkileikkausta…',
  empty: 'Ei kaikuja leikkauslinjalla',
  outOfRange: 'Tutkien kantaman ulkopuolella – piirrä viiva lähempänä tutkaa',
  error: 'Tietojen haku epäonnistui',
  noData: 'Ei tutkadataa tälle ajalle',
};

// Distance-axis tick step aiming for ≤6 ticks.
function niceStepKm(totalKm) {
  for (const step of [1, 2, 5, 10, 20, 50, 100, 200]) {
    if (totalKm / step <= 6) return step;
  }
  return 500;
}

export default function initCrossSection({
  container, radarSiteSource, projection, isLayerAdvertised, onRequestClose,
}) {
  if (!container) {
    return { setLine() {}, setCursor() {} };
  }
  const requestClose = typeof onRequestClose === 'function' ? onRequestClose : () => {};
  const spec = paramSpec(PARAMETER);
  const floorDbz = spec.floor != null ? spec.floor : 0;
  const LUT = buildLut(floorDbz);

  // ---------------------------------------------------------------
  // Panel DOM (probe.js pattern: `hidden` removed once, the height 0 /
  // .open CSS transition does the show/hide)
  // ---------------------------------------------------------------
  container.removeAttribute('hidden');
  container.removeAttribute('aria-hidden');

  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <i class="material-icons section-icon" aria-hidden="true">area_chart</i>
    <span class="section-title">Poikkileikkaus</span>
    <select class="section-site-select" aria-label="Tutka-asema" hidden></select>
    <span class="section-loading" hidden aria-hidden="true"></span>
    <button type="button" class="section-close" aria-label="Sulje poikkileikkaus">
      <i class="material-icons" aria-hidden="true">close</i>
    </button>
  `;
  container.appendChild(head);

  const canvas = document.createElement('canvas');
  canvas.className = 'section-canvas';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const message = document.createElement('div');
  message.className = 'section-message';
  message.hidden = true;
  container.appendChild(message);

  const siteSelect = head.querySelector('.section-site-select');
  const loadingDot = head.querySelector('.section-loading');
  head.querySelector('.section-close').addEventListener('click', requestClose);

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  let line = null; // quantized [[lonA, latA], [lonB, latB]] or null
  let candidates = []; // in-range sites, sorted by worse-endpoint distance
  let activeSite = null; // the candidates entry being queried
  let autoNod = null; // nod of the auto-picked site (for the dropdown label)
  let cursorMs = null;
  let windowStartMs = null;
  let stepMs = null;
  let generation = 0; // bumped on line/site change; stale completions discard
  let desiredKey = null; // cache key the display wants right now
  let lastGood = null; // last rendered cache entry (sticky display)
  let renderedKey = null; // skip redundant repaints of the same entry
  let state = 'idle';
  const metaCache = new Map(); // collection -> { atMs, timesMs, isoByMs }
  const pendingMeta = new Map(); // collection -> Promise (dedupes fetches)
  const metaFailAt = new Map(); // collection -> ms of last failed fetch (10 s backoff)
  const sectionCache = new Map(); // key -> entry; insertion-ordered LRU
  const inFlight = new Map(); // key -> AbortController (≤ MAX_PREFETCH)
  let queue = []; // frames awaiting a fetch slot, current frame first
  const poisoned = new Set(); // keys that 4xx'd after snapping — never blind-retried

  function cacheKey(collection, iso) {
    return `${collection}|${line[0]}|${line[1]}|${iso}`;
  }

  function cacheGet(key) {
    const entry = sectionCache.get(key);
    if (!entry) return null;
    sectionCache.delete(key); // refresh LRU order
    sectionCache.set(key, entry);
    return entry;
  }

  function cacheSet(key, entry) {
    sectionCache.delete(key);
    sectionCache.set(key, entry);
    while (sectionCache.size > CACHE_MAX) {
      sectionCache.delete(sectionCache.keys().next().value);
    }
  }

  function setLoadingDot(on) {
    loadingDot.hidden = !on;
  }

  function setOpen(open) {
    container.classList.toggle('open', !!open);
  }

  function setState(next) {
    state = next;
    const showCanvas = state === 'ready' || state === 'empty';
    canvas.style.visibility = showCanvas ? 'visible' : 'hidden';
    const text = MSG[state] || '';
    message.textContent = text;
    message.hidden = !text || state === 'ready';
  }

  function abortAll() {
    for (const ac of inFlight.values()) ac.abort();
    inFlight.clear();
    queue = [];
    setLoadingDot(false);
  }

  // ---------------------------------------------------------------
  // Site selection
  // ---------------------------------------------------------------

  // The disk-served single variant when the WMS advertises it (predictable
  // latency — S3-backed pvol colds can stall ~18 s), else the catalog
  // collection as-is. Same gate as radarSite.js resolveProduct.
  function resolveCollection(baseCollection) {
    const single = singleVariantOf(baseCollection);
    if (single && isLayerAdvertised(`${single}/${PARAMETER}`) === true) return single;
    return baseCollection;
  }

  // All sites whose coverage contains BOTH endpoints (the farthest point of
  // a segment from any fixed site is at an endpoint), sorted by that worse
  // distance.
  function computeCandidates() {
    candidates = [];
    for (const feature of radarSiteSource.getFeatures()) {
      const baseCollection = feature.get('collection');
      if (!baseCollection) continue; // eslint-disable-line no-continue
      const lonLat = transform(feature.getGeometry().getCoordinates(), projection, 'EPSG:4326');
      const worseM = Math.max(getDistance(lonLat, line[0]), getDistance(lonLat, line[1]));
      const radius = feature.get('coverage_radius_m') || 250000;
      if (worseM > radius) continue; // eslint-disable-line no-continue
      candidates.push({
        nod: feature.get('nod') || baseCollection,
        name: feature.get('name') || baseCollection,
        worseM,
        baseCollection,
        collection: null, // resolved when the site becomes active
      });
    }
    candidates.sort((a, b) => a.worseM - b.worseM || (a.nod < b.nod ? -1 : 1));
  }

  // Nearest wins; within the tie-break band a site with an advertised
  // single variant beats one without.
  function pickAuto() {
    let pick = candidates[0];
    for (const cand of candidates) {
      if (cand.worseM > candidates[0].worseM + TIE_BREAK_M) break;
      const candSingle = resolveCollection(cand.baseCollection) !== cand.baseCollection;
      const pickSingle = resolveCollection(pick.baseCollection) !== pick.baseCollection;
      if (candSingle && !pickSingle) pick = cand;
    }
    return pick;
  }

  function populateSelect() {
    siteSelect.textContent = '';
    for (const cand of candidates) {
      const opt = document.createElement('option');
      opt.value = cand.nod;
      opt.textContent = cand.nod === autoNod ? `${cand.name} (automaattinen)` : cand.name;
      siteSelect.appendChild(opt);
    }
    siteSelect.value = activeSite.nod;
    siteSelect.hidden = false;
  }

  function activateSite(cand) {
    activeSite = cand;
    activeSite.collection = resolveCollection(cand.baseCollection);
    generation++;
    abortAll();
    // A different radar sees the line differently — a sticky section from
    // the previous site would be misleading.
    lastGood = null;
    renderedKey = null;
    desiredKey = null;
    setState('loading');
    kick();
  }

  siteSelect.addEventListener('change', () => {
    const cand = candidates.find((c) => c.nod === siteSelect.value);
    if (!cand || cand === activeSite) return;
    activateSite(cand);
  });

  // ---------------------------------------------------------------
  // Fetch cycle
  // ---------------------------------------------------------------
  function ensureMetadata(collection) {
    const cached = metaCache.get(collection);
    if (cached && Date.now() - cached.atMs < META_TTL_MS) return Promise.resolve(cached);
    const pending = pendingMeta.get(collection);
    if (pending) return pending;
    // setCursor kicks on every clock tick — without a backoff a server
    // outage would turn into one failing metadata request per tick.
    const failedAt = metaFailAt.get(collection);
    if (failedAt && Date.now() - failedAt < 10000) {
      return cached ? Promise.resolve(cached) : Promise.reject(new Error('EDR metadata backoff'));
    }
    const promise = fetch(collectionMetadataUrl(collection))
      .then((r) => {
        if (!r.ok) throw new Error(`EDR ${r.status}`);
        return r.json();
      })
      .then((doc) => {
        const fresh = { atMs: Date.now(), ...parseTemporalValues(doc) };
        metaCache.set(collection, fresh);
        metaFailAt.delete(collection);
        // The archive rolled forward — a formerly-404ing time may exist now.
        for (const key of [...poisoned]) {
          if (key.startsWith(`${collection}|`)) poisoned.delete(key);
        }
        return fresh;
      })
      .catch((err) => {
        metaFailAt.set(collection, Date.now());
        throw err;
      })
      .finally(() => pendingMeta.delete(collection));
    pendingMeta.set(collection, promise);
    return promise;
  }

  async function requestSection(frame, signal) {
    const r = await fetch(frame.url, { signal });
    if (!r.ok) {
      // 4xx after snapping = a race with archive rolloff (or a server-side
      // gap); retrying the same URL can't succeed, so poison until the next
      // metadata refresh. 5xx/network stay unpoisoned.
      if (r.status >= 400 && r.status < 500) poisoned.add(frame.key);
      throw new Error(`EDR ${r.status}`);
    }
    const section = parseSection(await r.json(), PARAMETER);
    if (!section) throw new Error('EDR: unexpected section shape');
    const entry = {
      key: frame.key, iso: frame.iso, section, bitmap: buildBitmap(section),
    };
    cacheSet(frame.key, entry);
    return entry;
  }

  // The loading dot pulses while the *displayed* frame's data is still on
  // its way (in flight or queued); background prefetches stay silent.
  function updateLoadingDot() {
    setLoadingDot(desiredKey != null && !sectionCache.has(desiredKey)
      && (inFlight.has(desiredKey) || queue.some((f) => f.key === desiredKey)));
  }

  function startFetch(frame) {
    const ac = new AbortController();
    inFlight.set(frame.key, ac);
    const gen = generation;
    requestSection(frame, ac.signal)
      .then((entry) => {
        // The cursor may have moved onto (or off) this frame while it was
        // in flight — render only what the display is waiting for.
        if (gen === generation && desiredKey === frame.key) renderEntry(entry);
      })
      .catch((err) => {
        if (err && err.name === 'AbortError') return;
        if (gen === generation && desiredKey === frame.key && !lastGood) setState('error');
      })
      .finally(() => {
        inFlight.delete(frame.key);
        if (gen === generation) pump();
      });
  }

  // ≤ MAX_PREFETCH concurrent fetches, always taking the head of the queue —
  // plan() puts the displayed frame first, then the rest outward from it
  // (the server contract's re-anchor rule: displayed timestep first,
  // backfill outward, bounded in-flight count). Cursor moves never abort an
  // in-flight fetch: every fetch targets a window frame whose result stays
  // useful in cache, and aborting on each playback tick would starve a slow
  // (cold S3 pvol, ~18 s) site of ever completing anything. Aborts happen
  // only on line/site changes (abortAll via generation bump).
  function pump() {
    while (inFlight.size < MAX_PREFETCH && queue.length) {
      const frame = queue.shift();
      if (sectionCache.has(frame.key) || poisoned.has(frame.key) || inFlight.has(frame.key)) {
        continue; // eslint-disable-line no-continue
      }
      startFetch(frame);
    }
    updateLoadingDot();
  }

  // Plan the window against fresh-enough metadata: render the current frame
  // from cache or queue it first, then the remaining frames outward.
  function plan(meta) {
    const { collection } = activeSite;
    const frames = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      const snapped = snapToAdvertised(windowStartMs + i * stepMs, meta.timesMs);
      if (snapped == null) {
        frames.push(null); // missing on the server — no request to make
        continue; // eslint-disable-line no-continue
      }
      const iso = meta.isoByMs.get(snapped);
      const key = cacheKey(collection, iso);
      frames.push({ iso, key, url: buildTrajectoryUrl(collection, PARAMETER, iso, line) });
    }

    const cursorIdx = Math.max(0, Math.min(FRAME_COUNT - 1, Math.round((cursorMs - windowStartMs) / stepMs)));
    queue = [];
    const current = frames[cursorIdx];
    if (current) {
      desiredKey = current.key;
      const cached = cacheGet(current.key);
      if (cached) {
        renderEntry(cached);
      } else if (poisoned.has(current.key)) {
        if (!lastGood) setState('noData');
      } else {
        if (!lastGood) setState('loading');
        queue.push(current);
      }
    } else {
      desiredKey = null;
      if (!lastGood) setState('noData');
    }

    for (let d = 1; d < FRAME_COUNT; d++) {
      for (const idx of [cursorIdx + d, cursorIdx - d]) {
        if (idx < 0 || idx >= FRAME_COUNT) continue; // eslint-disable-line no-continue
        const frame = frames[idx];
        if (!frame || frame.key === desiredKey) continue; // eslint-disable-line no-continue
        if (sectionCache.has(frame.key) || poisoned.has(frame.key) || inFlight.has(frame.key)) {
          continue; // eslint-disable-line no-continue
        }
        queue.push(frame);
      }
    }
    pump();
  }

  function kick() {
    if (!line || !activeSite || cursorMs == null) return;
    const gen = generation;
    ensureMetadata(activeSite.collection)
      .then((meta) => {
        if (gen !== generation) return;
        plan(meta);
      })
      .catch(() => {
        if (gen !== generation) return;
        if (!lastGood) setState('error');
      });
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------

  // Colorize the section into an offscreen canvas at data resolution
  // (~nPts × nZ), cropped to HEIGHT_CAP_M. Row 0 = top; NaN/below-floor
  // pixels stay transparent.
  function buildBitmap(section) {
    const {
      nPts, nZ, heights, values,
    } = section;
    let nShow = 0;
    while (nShow < nZ && heights[nShow] <= HEIGHT_CAP_M) nShow++;
    nShow = Math.max(nShow, 1);
    const off = document.createElement('canvas');
    off.width = nPts;
    off.height = nShow;
    const octx = off.getContext('2d');
    const img = octx.createImageData(nPts, nShow);
    const { data } = img;
    const span = RAMP_MAX_DBZ - floorDbz;
    for (let i = 0; i < nPts; i++) {
      for (let j = 0; j < nShow; j++) {
        const v = values[i * nZ + j];
        if (Number.isNaN(v) || v < floorDbz) continue; // eslint-disable-line no-continue
        const li = Math.max(0, Math.min(255, Math.round(((v - floorDbz) / span) * 255)));
        const o = ((nShow - 1 - j) * nPts + i) * 4;
        data[o] = LUT[li * 3];
        data[o + 1] = LUT[li * 3 + 1];
        data[o + 2] = LUT[li * 3 + 2];
        data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return { canvas: off, capM: heights[nShow - 1] || HEIGHT_CAP_M };
  }

  function renderEntry(entry) {
    lastGood = entry;
    drawCanvas(entry);
    setState(entry.section.allNull ? 'empty' : 'ready');
  }

  function drawCanvas(entry) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    const pxW = Math.round(cssW * dpr);
    const pxH = Math.round(cssH * dpr);
    const sizeKey = `${entry.key}|${pxW}x${pxH}`;
    if (sizeKey === renderedKey) return;
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const padL = 30;
    const padR = 8;
    const padT = 6;
    const padB = 16;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;
    if (plotW <= 10 || plotH <= 10) return;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.fillRect(padL, padT, plotW, plotH);
    // Nearest-neighbor scale-up keeps radar cells crisp instead of mushy.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(entry.bitmap.canvas, padL, padT, plotW, plotH);

    ctx.font = '10px Roboto, sans-serif';
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;

    // Height axis: a tick every 5 km; the topmost carries the unit.
    const { capM } = entry.bitmap;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let km = 0; km * 1000 <= capM + 1; km += 5) {
      const y = padT + plotH - ((km * 1000) / capM) * plotH;
      if (km > 0) {
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
      }
      ctx.fillStyle = TEXT_DIM;
      const top = (km + 5) * 1000 > capM + 1;
      ctx.fillText(top ? `${km} km` : `${km}`, padL - 4 + (top ? 12 : 0), Math.max(y, padT + 5));
    }

    // Distance axis along the line, plus the A/B endpoint letters in the
    // same colors as the map markers.
    const { totalKm } = entry.section;
    const stepKm = niceStepKm(totalKm);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = TEXT_DIM;
    for (let km = stepKm; km < totalKm - stepKm * 0.25; km += stepKm) {
      const x = padL + (km / totalKm) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillText(`${km}`, x, padT + plotH + 3);
    }
    ctx.font = 'bold 11px Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLOR_A;
    ctx.fillText('A', padL, padT + plotH + 3);
    ctx.textAlign = 'right';
    ctx.fillStyle = COLOR_B;
    ctx.fillText('B', padL + plotW, padT + plotH + 3);

    renderedKey = sizeKey;
  }

  // Re-render on resize (orientation change, split-layout change) — the
  // probe.js rAF-debounce pattern.
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (lastGood) {
        renderedKey = null;
        drawCanvas(lastGood);
      }
    });
  });

  // A cache hit can render mid-open while the panel's height transition is
  // still running — the canvas buffer then matches the interim size and gets
  // CSS-stretched. Repaint at the final size once the transition settles.
  container.addEventListener('transitionend', (e) => {
    if (e.propertyName !== 'height' || !lastGood) return;
    renderedKey = null;
    drawCanvas(lastGood);
  });

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------
  return {
    // A new line (EPSG:4326 endpoints) from the draw tool, or null when the
    // line went away (disarm, replaced by a too-short drag).
    setLine(next) {
      generation++;
      abortAll();
      lastGood = null;
      renderedKey = null;
      desiredKey = null;
      // Poison keys embed the line coordinates, so a line change makes them
      // unreachable — drop them instead of letting the set grow.
      poisoned.clear();
      if (!next) {
        line = null;
        candidates = [];
        activeSite = null;
        autoNod = null;
        siteSelect.hidden = true;
        setOpen(false);
        setState('idle');
        return;
      }
      line = [quantizeEndpoint(next[0]), quantizeEndpoint(next[1])];
      computeCandidates();
      setOpen(true);
      if (!candidates.length) {
        activeSite = null;
        autoNod = null;
        siteSelect.hidden = true;
        setState('outOfRange');
        return;
      }
      const auto = pickAuto();
      autoNod = auto.nod;
      activeSite = auto;
      activeSite.collection = resolveCollection(auto.baseCollection);
      populateSelect();
      setState('loading');
      kick();
    },

    // Animation clock, routed once per setTime tick (the probe.setCursor
    // pattern). Window slides re-plan (fresh snaps + prefetch delta); cursor
    // moves flip to cached frames instantly.
    setCursor(nextCursorMs, nextWindowStartMs, nextStepMs) {
      cursorMs = nextCursorMs;
      windowStartMs = nextWindowStartMs;
      stepMs = nextStepMs;
      if (!line || !activeSite) return;
      kick();
    },
  };
}
