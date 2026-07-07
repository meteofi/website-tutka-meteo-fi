// Single-pin time-series probe for radar layers.
// Backed by meteocore EDR (CoverageJSON).
//
// Activates only when a pin is dropped AND the active radar layer maps to an
// EDR collection. Two cases:
//   - Composite mosaics (fmi-radar-composite-dbz, …) → identity-mapped EDR
//     collection, `reflectivity` parameter, no vertical axis.
//   - Single radar sites, WMS layer "<collection>/<quantity>" (e.g.
//     fi-radar-pvol-fianj/DBZH) → EDR collection is the prefix, parameter is
//     the quantity, queried at the displayed elevation angle (z).
// Otherwise the chart row stays collapsed (height 0).

const ENDPOINT = 'https://meteocore.app.meteo.fi/edr/collections';
const PARAMETER_NAME = 'reflectivity';

// Radar mosaic WMS layer names that are identity-mapped to EDR collections.
// Other layers (lightning, satellite, observations, KNMI/NOAA radars) have
// no EDR equivalent — chart row stays hidden for them.
const EDR_COLLECTIONS = new Set([
  'fmi-radar-composite-dbz',
  'opera-reflectivity',
  'met-radar-composite-dbz',
  'smhi-radar-composite-dbz',
  'dmi-radar-composite-dbz',
  'dwd-radar-composite-dbz',
  'chmi-radar-composite-dbz',
]);

// Per-EDR-parameter readout spec — the single source of truth for units, the
// "no-signal" floor, the chart Y range and the pistemittaus sub-line, shared by
// the chart below, the center-crosshair readout and the pistemittaus marker
// card so the three can't drift. Fields:
//   - floor: value below which a sample is "no signal" (no bar / no readout);
//     null means every value is meaningful (signed moments like radial velocity).
//   - min/max: frame the chart Y axis. Bars are drawn from the value-0 line
//     within [min,max], so min:0 gives today's bottom-anchored dBZ bars and a
//     negative min gives a diverging baseline.
//   - rainRate: gates the Marshall-Palmer sub-line (reflectivity only).
//   - label: names the moment on the pistemittaus marker card (Finnish UI).
// Composite mosaics report parameter 'reflectivity'; single sites report their
// WMS quantity (DBZH/VRADH/ZDR). Any unmapped quantity falls back to dBZ, which
// is the pre-existing behavior.
const PARAM_SPECS = {
  reflectivity: {
    label: 'Heijastavuus', unit: 'dBZ', floor: 0, min: 0, max: 50, decimals: 0, rainRate: true,
  },
  DBZH: {
    label: 'Heijastavuus', unit: 'dBZ', floor: 0, min: 0, max: 50, decimals: 0, rainRate: true,
  },
  VRADH: {
    label: 'Nopeus', unit: 'm/s', floor: null, min: -48, max: 48, decimals: 0, rainRate: false,
  },
  ZDR: {
    label: 'ZDR', unit: 'dB', floor: null, min: -2, max: 8, decimals: 1, rainRate: false,
  },
};

export function paramSpec(parameter) {
  return (parameter && PARAM_SPECS[parameter]) || PARAM_SPECS.reflectivity;
}

// Format a numeric readout per its spec, or '' when there is no value.
export function formatReadout(value, spec) {
  if (value == null || Number.isNaN(value)) return '';
  return `${value.toFixed(spec.decimals)} ${spec.unit}`;
}

// Bar geometry for one value: fractions in [0,1] (measured from the bottom of
// the plot) for both the value and the zero baseline. min:0 → baseline 0 →
// bottom-anchored bars; a negative min lifts the baseline for signed moments.
function barFractions(value, spec) {
  const range = spec.max - spec.min;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  return {
    value: clamp01((value - spec.min) / range),
    baseline: clamp01((0 - spec.min) / range),
  };
}

// OpenLayers hands back longitudes outside [-180, 180] when the map is panned
// across world copies (e.g. lon 360.0017 for a point that is really near 0°).
// The EDR server rejects those with HTTP 400, so wrap longitude into [-180, 180)
// and clamp latitude into [-90, 90] before any coordinate reaches a query.
export function normalizeLonLat(lon, lat) {
  const wrappedLon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const clampedLat = Math.max(-90, Math.min(90, lat));
  return [wrappedLon, clampedLat];
}

const CACHE_TTL_MS = 60000;
const CACHE_MAX = 20;
const cache = new Map(); // insertion-ordered: oldest entry is first

function cacheKey(collection, param, z, lon, lat) {
  return `${collection}|${param}|${z == null ? '' : z}|${lon.toFixed(4)}|${lat.toFixed(4)}`;
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh LRU order
  cache.delete(key);
  cache.set(key, entry);
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

function parseCoverage(cov, param) {
  const ts = cov && cov.domain && cov.domain.axes && cov.domain.axes.t
    ? cov.domain.axes.t.values : null;
  const vs = cov && cov.ranges && cov.ranges[param]
    ? cov.ranges[param].values : null;
  if (!Array.isArray(ts) || !Array.isArray(vs) || ts.length !== vs.length) {
    return [];
  }
  return ts.map((t, i) => {
    const raw = vs[i];
    // Preserve real numbers as-is. Only JSON null marks missing data
    // (off-coverage points). The parameter's "no-signal" floor (spec.floor) is
    // applied at render time.
    const v = (raw == null) ? null : raw;
    return { t: new Date(t).getTime(), v };
  });
}

// Resolve a radar WMS layer name to its EDR query target. Shared with the
// center-crosshair tool so the two readouts can't drift apart.
//   - "<collection>/<quantity>"  → single radar site (e.g. fi-radar-pvol-fianj/DBZH)
//   - a known composite mosaic   → identity-mapped collection, `reflectivity`
//   - anything else              → collection:null (no EDR equivalent)
export function resolveEdrTarget(wmslayer, { z } = {}) {
  let collection = null;
  let parameter = PARAMETER_NAME;
  if (wmslayer) {
    const slash = wmslayer.indexOf('/');
    if (slash > 0) {
      collection = wmslayer.slice(0, slash);
      parameter = wmslayer.slice(slash + 1);
    } else if (EDR_COLLECTIONS.has(wmslayer)) {
      collection = wmslayer;
    }
  }
  const nz = (z === undefined || z === null || z === '') ? null : z;
  return { collection, parameter, z: nz };
}

export async function fetchSeries(collection, param, lon, lat, startISO, endISO, z, signal) {
  const key = cacheKey(collection, param, z, lon, lat);
  const cached = cacheGet(key);
  if (cached) return cached;
  let url = `${ENDPOINT}/${encodeURIComponent(collection)}/position`
    + `?f=CoverageJSON&parameter-name=${encodeURIComponent(param)}`
    + `&coords=POINT(${lon.toFixed(4)} ${lat.toFixed(4)})`
    + `&datetime=${encodeURIComponent(`${startISO}/${endISO}`)}`;
  // Single-site polar volumes have a vertical (elevation-angle) axis; pin it
  // to the displayed sweep so the position query collapses to one time series.
  if (z != null) url += `&z=${encodeURIComponent(z)}`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`EDR ${r.status}`);
  const series = parseCoverage(await r.json(), param);
  cacheSet(key, series);
  return series;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export default function initProbe({ container, onValueChange }) {
  if (!container) {
    return {
      setPin() {}, setActiveLayer() {}, setCursor() {},
    };
  }

  const emitValue = typeof onValueChange === 'function'
    ? (v) => { try { onValueChange(v); } catch (_) { /* ignore */ } }
    : () => {};

  // Remove the initial `hidden` attribute so the element is always in the
  // layout — the height: 0 / .open transition handles the show/hide.
  container.removeAttribute('hidden');
  container.removeAttribute('aria-hidden');

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'probe-svg');
  container.appendChild(svg);

  const readout = document.createElementNS(SVG_NS, 'text');
  readout.setAttribute('class', 'probe-readout');
  readout.setAttribute('text-anchor', 'end');
  readout.setAttribute('y', '14');

  const message = document.createElement('div');
  message.className = 'probe-message';
  container.appendChild(message);

  let pin = null; // [lon, lat] in EPSG:4326, or null
  let collection = null; // EDR collection name, or null when unsupported
  let parameter = PARAMETER_NAME; // EDR parameter-name for the active collection
  let z = null; // elevation angle (deg) for single-site volumes, or null
  let series = null; // [{t, v}] from last fetch
  let windowMs = null; // [startMs, endMs] currently displayed
  let resolutionMs = null; // animation step in ms (one strip cell)
  let cursorMs = null; // current animation frame ms
  let inFlight = null; // AbortController for active fetch
  let state = 'idle'; // 'idle' | 'loading' | 'ready' | 'empty' | 'error'

  // Per-cell peak sample, set in render(). Each slot is { val } — the most
  // extreme raw value in the cell (peak dBZ, or strongest signed velocity);
  // barFractions maps it to bar geometry per the active parameter's spec.
  let peakByCell = [];
  // Sentinel value distinct from null/number so the very first transition
  // (idle → null) doesn't get short-circuited by the de-dupe check.
  const NO_EMIT = Symbol('no-emit');
  let lastEmittedValue = NO_EMIT;

  // The load-state strip below has 13 equal-flex cells. To keep the chart's
  // bends and the vertical cursor visually centered on each cell, we anchor
  // every frame point at its cell midpoint: x = (frameIdx + 0.5) / 13 * W.
  const STRIP_CELLS = 13;

  function showMessage(text) {
    message.textContent = text || '';
    message.hidden = !text;
  }

  function setOpen(open) {
    container.classList.toggle('open', !!open);
  }

  function setState(next) {
    state = next;
    svg.style.visibility = (state === 'ready') ? 'visible' : 'hidden';
    if (state === 'loading') showMessage('Ladataan…');
    else if (state === 'empty') showMessage('Ei dataa tällä alueella');
    else if (state === 'error') showMessage('Tietojen haku epäonnistui');
    else showMessage('');
    if (state !== 'ready') {
      peakByCell = [];
      readout.textContent = '';
      if (lastEmittedValue !== null) {
        lastEmittedValue = null;
        emitValue(null);
      }
    }
  }

  function clearSvg() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
  }

  // Frame index for an absolute timestamp, given the current window.
  function frameIndex(t, startMs) {
    if (!resolutionMs || resolutionMs <= 0) return null;
    return Math.round((t - startMs) / resolutionMs);
  }

  function render() {
    if (!series || !windowMs || !resolutionMs) return;
    const spec = paramSpec(parameter);
    const [startMs, endMs] = windowMs;

    const W = svg.clientWidth || container.clientWidth || 800;
    const H = svg.clientHeight || 60;
    if (W <= 0 || H <= 0) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const padY = 4;
    const innerH = H - padY * 2;
    const cellW = W / STRIP_CELLS;
    const barW = Math.max(2, cellW * 0.7);

    const visible = series.filter((p) => p.t >= startMs - 1 && p.t <= endMs + 1);
    if (visible.length === 0 || visible.every((p) => p.v == null)) {
      setState('empty');
      return;
    }

    clearSvg();

    // Gridlines (3 evenly spaced)
    for (let i = 0; i < 4; i += 1) {
      const y = padY + (innerH * i) / 3;
      const ln = document.createElementNS(SVG_NS, 'line');
      ln.setAttribute('x1', 0);
      ln.setAttribute('x2', W);
      ln.setAttribute('y1', y);
      ln.setAttribute('y2', y);
      ln.setAttribute('class', 'probe-grid');
      svg.appendChild(ln);
    }

    // Aggregate per cell: when the strip resolution is coarser than EDR
    // cadence, multiple samples land in one cell. Keep the most extreme sample
    // (largest magnitude) — for reflectivity that's the peak dBZ, and for a
    // signed moment (radial velocity) it's the strongest motion; either way
    // exactly one bar per cell. `floor` drops "no signal" samples entirely.
    peakByCell = new Array(STRIP_CELLS).fill(null);
    for (const p of visible) {
      if (p.v == null) continue; // eslint-disable-line no-continue
      if (spec.floor != null && p.v < spec.floor) continue; // eslint-disable-line no-continue
      const idx = frameIndex(p.t, startMs);
      if (idx == null || idx < 0 || idx >= STRIP_CELLS) continue; // eslint-disable-line no-continue
      const prev = peakByCell[idx];
      if (prev == null || Math.abs(p.v) > Math.abs(prev.val)) {
        peakByCell[idx] = { val: p.v };
      }
    }

    for (let idx = 0; idx < STRIP_CELLS; idx += 1) {
      const cell = peakByCell[idx];
      if (cell == null) continue; // eslint-disable-line no-continue
      const cx = (idx + 0.5) * cellW;
      // Bars grow from the value-0 baseline (bottom for dBZ, mid-axis for a
      // signed moment) to the sample's value.
      const f = barFractions(cell.val, spec);
      const yVal = padY + innerH * (1 - f.value);
      const yBase = padY + innerH * (1 - f.baseline);
      const h = Math.max(1.5, Math.abs(yVal - yBase));
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', 'probe-bar');
      rect.setAttribute('data-frame', String(idx));
      rect.setAttribute('x', (cx - barW / 2).toFixed(1));
      rect.setAttribute('y', Math.min(yVal, yBase).toFixed(1));
      rect.setAttribute('width', barW.toFixed(1));
      rect.setAttribute('height', h.toFixed(1));
      svg.appendChild(rect);
    }

    readout.setAttribute('x', (W - 6).toFixed(1));
    svg.appendChild(readout);

    setState('ready');
    updateCurrentFrame();
  }

  // Highlight the bar matching the current animation frame and update the
  // top-right readout + onValueChange callback to reflect that cell.
  function updateCurrentFrame() {
    if (state !== 'ready' || cursorMs == null || !windowMs || !resolutionMs) return;
    const idx = frameIndex(cursorMs, windowMs[0]);
    const bars = svg.querySelectorAll('.probe-bar');
    bars.forEach((b) => {
      const isCurrent = Number(b.getAttribute('data-frame')) === idx;
      b.classList.toggle('current', isCurrent);
    });
    const spec = paramSpec(parameter);
    const cell = (idx >= 0 && idx < peakByCell.length) ? peakByCell[idx] : null;
    const val = cell ? cell.val : null;
    readout.textContent = formatReadout(val, spec);
    if (val !== lastEmittedValue) {
      lastEmittedValue = val;
      emitValue(val == null ? null : {
        value: val,
        text: formatReadout(val, spec),
        label: spec.label,
        rainRate: spec.rainRate,
      });
    }
  }

  async function refetch() {
    if (!pin || !collection || !windowMs) return;
    if (inFlight) inFlight.abort();
    inFlight = new AbortController();
    const myAbort = inFlight;
    setState('loading');
    try {
      const startISO = new Date(windowMs[0]).toISOString();
      const endISO = new Date(windowMs[1]).toISOString();
      const data = await fetchSeries(collection, parameter, pin[0], pin[1], startISO, endISO, z, myAbort.signal);
      if (myAbort.signal.aborted) return;
      series = data;
      if (!series || series.length === 0 || series.every((p) => p.v == null)) {
        setState('empty');
        return;
      }
      render();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      setState('error');
    } finally {
      if (inFlight === myAbort) inFlight = null;
    }
  }

  function recompute() {
    if (!pin) {
      if (inFlight) inFlight.abort();
      series = null;
      setOpen(false);
      setState('idle');
      return;
    }
    if (!collection) {
      // Pin set, but active layer has no EDR collection — collapse silently.
      if (inFlight) inFlight.abort();
      series = null;
      setOpen(false);
      setState('idle');
      return;
    }
    setOpen(true);
    refetch();
  }

  // Re-render on resize (orientation change, viewport resize) so the SVG
  // x-axis stays aligned with the timeline strip below it.
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (state === 'ready') render();
    });
  });

  return {
    setPin(lonLat) {
      pin = (lonLat && lonLat.length === 2)
        ? normalizeLonLat(lonLat[0], lonLat[1]) : null;
      recompute();
    },
    setActiveLayer(wmslayer, opts = {}) {
      const t = resolveEdrTarget(wmslayer, { z: opts.z });
      if (t.collection === collection && t.parameter === parameter && t.z === z) return;
      collection = t.collection;
      parameter = t.parameter;
      z = t.z;
      recompute();
    },
    setCursor(cursorTimeMs, windowStartMs, stepMs) {
      cursorMs = cursorTimeMs;
      resolutionMs = stepMs;
      const w = [windowStartMs, windowStartMs + 12 * stepMs];
      const changed = !windowMs || windowMs[0] !== w[0] || windowMs[1] !== w[1];
      windowMs = w;
      if (changed && pin && collection) {
        refetch();
      } else if (state === 'ready') {
        updateCurrentFrame();
      }
    },
  };
}
