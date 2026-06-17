// Center-crosshair reflectivity reticle ("Tähtäin").
//
// A RadarScope-style reticle pinned to the *center* of the map viewport. Unlike
// the Mittaa / Pistemittaus map-tap tools, this one never moves — the user pans
// the map underneath it to change the measured point. It shows, at screen
// center:
//   - full-viewport vertical + horizontal crosshair lines,
//   - a small center ring filled with the *actual rendered radar pixel colour*
//     at that point (so the user sees exactly which value the readout samples —
//     the ring spans several pixels, but the fill is the single centre pixel),
//   - two outer aiming rings (fixed pixel radii, zoom-independent),
//   - a line from the centre toward the selected (or nearest) radar site,
//   - the dBZ value at the centre, below the crosshair.
//
// The dBZ value reuses the exact EDR position query Pistemittaus uses (shared
// helpers in probe.js) so the two readouts agree at the same coordinate. The
// pixel colour is read straight off the radar layer's canvas via getData() —
// which requires the radar ImageWMS source to be crossOrigin-enabled.

import { transform } from 'ol/proj';
import { getDistance } from 'ol/sphere';
import LatLon from 'geodesy/latlon-spherical';
import { resolveEdrTarget, fetchSeries, normalizeLonLat } from './probe';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Reticle geometry (SVG user units == CSS px). Center ring is the colour
// swatch; the two outer rings are fixed-size aiming circles. The radar line
// runs from just outside the centre ring out toward the viewport edge.
const SVG_SIZE = 320;
const C = SVG_SIZE / 2;
const R_CENTER = 16;
const R_MID = 46;
const R_OUTER = 88;
const LINE_INNER = R_CENTER + 4;
const LINE_OUTER = 150;

// The strip window holds 13 frames (0..12), mirroring probe.js.
const WINDOW_FRAMES = 12;
// Don't draw the radar line when the centre is essentially on the radar.
const MIN_TARGET_M = 200;

function el(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs).forEach((k) => node.setAttribute(k, attrs[k]));
  return node;
}

export default function initCrosshair({
  map, radarLayer, radarSiteSource, getActiveSiteLonLat,
}) {
  // --- DOM -----------------------------------------------------------------
  const overlay = document.createElement('div');
  overlay.className = 'crosshair-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.display = 'none';

  // Full-viewport crosshair lines (kept out of the bounded SVG so they span the
  // whole map, not just the reticle).
  const hLine = document.createElement('div');
  hLine.className = 'crosshair-line crosshair-line-h';
  const vLine = document.createElement('div');
  vLine.className = 'crosshair-line crosshair-line-v';
  overlay.appendChild(hLine);
  overlay.appendChild(vLine);

  const svg = el('svg', {
    class: 'crosshair-svg',
    width: SVG_SIZE,
    height: SVG_SIZE,
    viewBox: `0 0 ${SVG_SIZE} ${SVG_SIZE}`,
  });

  // Radar-direction line + arrowhead, grouped so a single rotate() aims it.
  // It points "north" (straight up) at rotate(0); bearing is clockwise from
  // north, which matches SVG's clockwise-positive rotation (y grows downward).
  const dirGroup = el('g', { class: 'crosshair-dir' });
  dirGroup.appendChild(el('line', {
    x1: C, y1: C - LINE_INNER, x2: C, y2: C - LINE_OUTER, class: 'crosshair-dir-line',
  }));
  dirGroup.appendChild(el('polygon', {
    points: `${C - 5},${C - LINE_OUTER + 9} ${C + 5},${C - LINE_OUTER + 9} ${C},${C - LINE_OUTER}`,
    class: 'crosshair-dir-arrow',
  }));
  svg.appendChild(dirGroup);

  svg.appendChild(el('circle', {
    cx: C, cy: C, r: R_OUTER, class: 'crosshair-ring',
  }));
  svg.appendChild(el('circle', {
    cx: C, cy: C, r: R_MID, class: 'crosshair-ring',
  }));
  const centerCircle = el('circle', {
    cx: C, cy: C, r: R_CENTER, class: 'crosshair-center empty',
  });
  svg.appendChild(centerCircle);
  overlay.appendChild(svg);

  const readout = document.createElement('div');
  readout.className = 'crosshair-readout';
  readout.hidden = true;
  overlay.appendChild(readout);

  map.getViewport().appendChild(overlay);

  // --- state ---------------------------------------------------------------
  let visible = false;
  let collection = null;
  let parameter = null;
  let z = null;
  let center4326 = null; // normalized [lon, lat]
  let windowMs = null; // [startMs, endMs]
  let cursorMs = null;
  let stepMs = null;
  let series = null;
  let inFlight = null;
  let refetchTimer = 0;

  function setReadout(dbz) {
    if (dbz == null || Number.isNaN(dbz)) {
      readout.hidden = true;
      readout.textContent = '';
    } else {
      readout.textContent = `${Math.round(dbz)} dBZ`;
      readout.hidden = false;
    }
  }

  // --- centre pixel colour + radar-direction line (cheap, every render) -----
  function nearestSiteLonLat(center) {
    const feats = radarSiteSource.getFeatures();
    if (!feats.length) return null;
    const proj = map.getView().getProjection();
    let best = null;
    let bestD = Infinity;
    feats.forEach((f) => {
      const g = f.getGeometry();
      if (!g) return;
      const ll = transform(g.getCoordinates(), proj, 'EPSG:4326');
      const d = getDistance(center, ll);
      if (d < bestD) { bestD = d; best = ll; }
    });
    return best;
  }

  function sampleColor() {
    const view = map.getView();
    const center = view.getCenter();
    if (!center) return;
    const pixel = map.getPixelFromCoordinate(center);
    let data = null;
    if (pixel && radarLayer.getVisible()) {
      try { data = radarLayer.getData(pixel); } catch (_) { data = null; }
    }
    if (data && data.length >= 4 && data[3] > 0) {
      centerCircle.setAttribute('fill', `rgba(${data[0]},${data[1]},${data[2]},${(data[3] / 255).toFixed(3)})`);
      centerCircle.classList.remove('empty');
    } else {
      centerCircle.setAttribute('fill', 'none');
      centerCircle.classList.add('empty');
    }
  }

  function updateDirection() {
    if (!center4326) return;
    const target = getActiveSiteLonLat() || nearestSiteLonLat(center4326);
    const d = target ? getDistance(center4326, target) : Infinity;
    if (target && d > MIN_TARGET_M) {
      const brg = new LatLon(center4326[1], center4326[0])
        .initialBearingTo(new LatLon(target[1], target[0]));
      dirGroup.setAttribute('transform', `rotate(${brg.toFixed(1)} ${C} ${C})`);
      dirGroup.style.display = '';
    } else {
      dirGroup.style.display = 'none';
    }
  }

  function refreshCenter4326() {
    const center = map.getView().getCenter();
    if (!center) { center4326 = null; return false; }
    const ll = transform(center, map.getView().getProjection(), 'EPSG:4326');
    const norm = normalizeLonLat(ll[0], ll[1]);
    const moved = !center4326 || center4326[0] !== norm[0] || center4326[1] !== norm[1];
    center4326 = norm;
    return moved;
  }

  function render() {
    if (!visible) return;
    sampleColor();
    updateDirection();
  }

  // --- dBZ value via EDR (windowed, mirrors probe.js) -----------------------
  // Mirror probe.js exactly: floor at 0 dBZ (anything below is "no
  // precipitation" → no readout) and take the peak among samples landing in the
  // cursor's frame cell, so this readout matches what Pistemittaus shows at the
  // same point.
  function pickFrameValue() {
    if (!series || !windowMs || !stepMs || cursorMs == null) return null;
    const startMs = windowMs[0];
    const idx = Math.round((cursorMs - startMs) / stepMs);
    let peak = null;
    series.forEach((p) => {
      if (p.v == null || p.v < 0) return;
      if (Math.round((p.t - startMs) / stepMs) !== idx) return;
      if (peak == null || p.v > peak) peak = p.v;
    });
    return peak;
  }

  function updateValue() {
    setReadout(pickFrameValue());
  }

  async function refetch() {
    if (!visible || !collection || !center4326 || !windowMs) {
      setReadout(null);
      return;
    }
    if (inFlight) inFlight.abort();
    inFlight = new AbortController();
    const myAbort = inFlight;
    try {
      const startISO = new Date(windowMs[0]).toISOString();
      const endISO = new Date(windowMs[1]).toISOString();
      const data = await fetchSeries(collection, parameter, center4326[0], center4326[1], startISO, endISO, z, myAbort.signal);
      if (myAbort.signal.aborted) return;
      series = data;
      updateValue();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      series = null;
      setReadout(null);
    } finally {
      if (inFlight === myAbort) inFlight = null;
    }
  }

  function scheduleRefetch() {
    if (refetchTimer) clearTimeout(refetchTimer);
    refetchTimer = window.setTimeout(() => { refetchTimer = 0; refetch(); }, 200);
  }

  // --- map wiring (attached once; cheap no-op while hidden) ------------------
  map.on('postrender', () => {
    if (!visible) return;
    // Colour + direction line follow the centre live (cheap, local). When the
    // centre actually moves, also (re)arm the debounced dBZ refetch — a fast
    // continuous pan keeps resetting the 200 ms timer, so the network query
    // only fires once the user pauses/stops.
    const moved = refreshCenter4326();
    render();
    if (moved) scheduleRefetch();
  });

  map.on('moveend', () => {
    if (!visible) return;
    // Guaranteed final refetch after a move. Not gated on refreshCenter4326()'s
    // "moved" result: the postrender handler above already advanced center4326
    // during the pan, so by moveend the delta is gone and a gate would never
    // trip. fetchSeries is cached, so a no-op move is cheap.
    refreshCenter4326();
    scheduleRefetch();
  });

  return {
    show() {
      if (visible) return;
      visible = true;
      overlay.style.display = '';
      refreshCenter4326();
      render();
      refetch();
      // Force a fresh postrender so the centre colour samples a current frame
      // even if the map is otherwise idle at the moment of arming.
      map.render();
    },
    hide() {
      if (!visible) return;
      visible = false;
      overlay.style.display = 'none';
      if (inFlight) inFlight.abort();
      if (refetchTimer) { clearTimeout(refetchTimer); refetchTimer = 0; }
    },
    isVisible: () => visible,
    // Mirror probe.setActiveLayer: track the EDR collection/parameter/elevation
    // for whatever radar product is currently displayed.
    setActiveLayer(wmslayer, opts = {}) {
      const t = resolveEdrTarget(wmslayer, { z: opts.z });
      if (t.collection === collection && t.parameter === parameter && t.z === z) return;
      collection = t.collection;
      parameter = t.parameter;
      z = t.z;
      series = null;
      if (visible) refetch();
    },
    // Mirror probe.setCursor: refetch only when the window shifts; otherwise
    // just repick the frame from the cached series.
    setCursor(cursorTimeMs, windowStartMs, step) {
      cursorMs = cursorTimeMs;
      stepMs = step;
      const w = [windowStartMs, windowStartMs + WINDOW_FRAMES * step];
      const changed = !windowMs || windowMs[0] !== w[0] || windowMs[1] !== w[1];
      windowMs = w;
      if (!visible) return;
      if (changed) refetch();
      else updateValue();
    },
  };
}
