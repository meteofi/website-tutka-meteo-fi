// Radar colour-scale legend: a hairline gradient strip in the time column
// showing pane 0's active radar palette, expanding on tap into a labelled
// legend panel (gradient bar + value ticks + Finnish title).
//
// Data comes from MeteoCore's machine-readable legend document:
//   GET {wms}?…REQUEST=GetLegendGraphic&LAYER={layers}&FORMAT=application/json
// so the legend always describes the exact palette the map pixels were
// rendered with — the LAYER/STYLE key is read live from pane 0's radar source
// on every refresh (this module only ever READS WMS params, never writes them).
// Only meteocore serves the JSON form; any other radar server (EUMETSAT H60B,
// wms.meteo.fi) simply hides the legend.
//
// Server contract caveats (live-verified 2026-08-17):
// - An unknown LAYER returns HTTP 200 with an XML ServiceExceptionReport, so
//   "not JSON / wrong shape" is a definitive no-legend answer: the key is
//   poisoned and never blind-retried (the edrLightning.js convention). This
//   also absorbs the startup race where the seed refresh asks meteocore about
//   a persisted EUMETSAT/wms.meteo.fi product before capabilities-driven
//   restore has rewritten the source URL — those keys can never yield a
//   legend, so poisoning them is correct, not a bug to "fix" with a retry.
// - An unknown parameter under a known collection silently returns the
//   collection default legend instead of an error; harmless here because the
//   key is always the verbatim LAYERS string the map itself renders with.
// - Transient failures (network, 5xx) hide the legend but do NOT poison;
//   refresh is purely event-driven (layer/style/visibility changes), so there
//   is no retry loop to guard against.
//
// Bottom-panel mechanics are the crossSection.js / telemetryPanel.js pattern:
// `hidden` is removed from the panel once at build time and the height-0 /
// `.open` CSS transition does the show/hide, with `--timecontrol-height` in
// radar.css making room so the floating buttons ride above it.

const MC_HOST = 'meteocore.app.meteo.fi';

// '#RRGGBB' → 255, '#RRGGBBAA' → AA.
function alphaOf(color) {
  return color.length === 9 ? parseInt(color.slice(7, 9), 16) : 255;
}

// The displayed scale trims the palette's undrawn head: leading fully
// transparent stops mark "no echo", and spending a third of the strip on them
// would just look broken. One transparent anchor is kept when the palette
// fades in (e.g. radar_fmi is transparent up to 5 dBZ, then blends to cyan by
// 8 dBZ — that 5–8 fade is really rendered on the map, so it stays visible).
function displayScale(legend) {
  const { stops } = legend;
  let first = stops.findIndex((s) => alphaOf(s.color) > 0);
  if (first < 0) return null; // fully transparent palette = nothing to show
  if (first > 0) first -= 1;
  const visible = stops.slice(first);
  const v0 = visible[0].value;
  const vMax = Math.max(legend.max, visible[visible.length - 1].value);
  if (!(vMax > v0)) return null;
  const pos = (v) => (Math.min(100, Math.max(0, ((v - v0) / (vMax - v0)) * 100))).toFixed(2);
  let colorStops;
  if (legend.interpolation === 'step') {
    // Flat classes: each stop's colour runs to the next stop (the last one to
    // max, where the server clamps).
    colorStops = visible.map((s, i) => {
      const end = i + 1 < visible.length ? visible[i + 1].value : vMax;
      return `${s.color} ${pos(s.value)}% ${pos(end)}%`;
    });
  } else {
    colorStops = visible.map((s) => `${s.color} ${pos(s.value)}%`);
  }
  return { css: `linear-gradient(90deg, ${colorStops.join(', ')})`, v0, vMax };
}

// ~5 ticks on round values: the {1, 2, 2.5, 5}×10^k step whose interval count
// lands closest to five. Ticks inside 4% of either edge are dropped so the
// end labels don't clip against the bar's rounded corners.
function niceTicks(v0, vMax) {
  const span = vMax - v0;
  const best = [-2, -1, 0, 1, 2, 3]
    .flatMap((k) => [1, 2, 2.5, 5].map((m) => m * 10 ** k))
    .reduce((a, step) => (Math.abs(span / step - 5) < Math.abs(span / a - 5) ? step : a));
  const ticks = [];
  for (let t = Math.ceil(v0 / best) * best; t <= vMax; t += best) {
    const p = ((t - v0) / span) * 100;
    if (p >= 4 && p <= 96) ticks.push({ label: String(+t.toFixed(1)), pos: p.toFixed(2) });
  }
  return ticks;
}

// Small on purpose: the silent-collection-default caveat means unknown
// parameters still return some legend, and the server-title fallback covers
// them without a growing translation table.
function finnishTitle(legend) {
  const p = (legend.parameter || '').toLowerCase();
  let name = null;
  if (/reflect/.test(p) || p === 'dbz' || p === 'dbzh' || p === 'th') name = 'Tutkaheijastuvuus';
  else if (/velocity|vrad/.test(p)) name = 'Säteisnopeus';
  else if (/differential|zdr/.test(p)) name = 'Differentiaaliheijastuvuus';
  else if (/precip|rain/.test(p)) name = 'Sateen intensiteetti';
  else name = legend.title || '';
  if (name && legend.unit) return `${name} (${legend.unit})`;
  return name || legend.unit || '';
}

function isLegendShape(legend) {
  return Boolean(legend) && Array.isArray(legend.stops) && legend.stops.length >= 2
    && legend.stops.every((s) => typeof s.color === 'string' && Number.isFinite(s.value))
    && Number.isFinite(legend.max);
}

function legendUrl(base, layers, style) {
  // Fixed param order → byte-identical URLs → browser-cache hits (the server
  // sends max-age 86400).
  const params = [
    'SERVICE=WMS', 'VERSION=1.3.0', 'REQUEST=GetLegendGraphic',
    `LAYER=${encodeURIComponent(layers)}`, 'FORMAT=application%2Fjson',
  ];
  if (style) params.push(`STYLE=${encodeURIComponent(style)}`);
  return `${base}?${params.join('&')}`;
}

export default function initRadarLegend({
  strip, // the #legendStrip container (in .time-column)
  panel, // the #legendPanel container (in #timecontrol)
  getActiveRadar, // () => ({ url, layers, style, visible }) — pane-0 truth
}) {
  if (!strip || !panel) {
    // Same degraded-but-harmless contract as telemetryPanel.js.
    return { refresh() {}, isExpanded: () => false };
  }

  panel.removeAttribute('hidden');
  panel.removeAttribute('aria-hidden');
  strip.innerHTML = `
    <button type="button" class="legend-toggle" aria-controls="legendPanel"
      aria-expanded="false" aria-label="Väriasteikko"></button>
  `;
  panel.innerHTML = `
    <div class="legend-head"></div>
    <div class="legend-bar"></div>
    <div class="legend-ticks" aria-hidden="true"></div>
  `;

  const toggle = strip.querySelector('.legend-toggle');
  const headEl = panel.querySelector('.legend-head');
  const barEl = panel.querySelector('.legend-bar');
  const ticksEl = panel.querySelector('.legend-ticks');

  const cache = new Map(); // `${layers}|${style}` → parsed legend document
  const poisoned = new Set(); // keys that definitively have no legend
  let inFlight = null;
  // Remembered across layer/style changes and no-legend interludes: switching
  // to MSG sade and back should not silently fold an open panel.
  let expanded = false;

  function applyExpanded() {
    panel.classList.toggle('open', expanded && !strip.hidden);
    toggle.setAttribute('aria-expanded', String(expanded && !strip.hidden));
  }

  function hide() {
    strip.hidden = true;
    applyExpanded();
  }

  function render(legend) {
    const scale = displayScale(legend);
    if (!scale) { hide(); return; }
    strip.hidden = false;
    // backgroundImage, not the background shorthand: the shorthand would reset
    // background-repeat/-clip on the element and the stylesheet's no-repeat /
    // padding-box could never win — the repeat tile then wraps the gradient's
    // right end into the border area as a coloured sliver on the left edge.
    toggle.style.backgroundImage = scale.css;
    barEl.style.backgroundImage = scale.css;
    headEl.textContent = finnishTitle(legend);
    ticksEl.innerHTML = niceTicks(scale.v0, scale.vMax)
      .map((t) => `<span style="left:${t.pos}%">${t.label}</span>`)
      .join('');
    applyExpanded();
  }

  toggle.addEventListener('click', () => {
    expanded = !expanded;
    applyExpanded();
  });
  // The panel is non-interactive content; tapping anywhere on it collapses
  // (the hairline stays visible as the reopen affordance — no close button).
  panel.addEventListener('click', () => {
    expanded = false;
    applyExpanded();
  });

  async function refresh() {
    // A refresh supersedes whatever was still loading, even when this one
    // resolves from cache or hides — a stale response must never win.
    if (inFlight) { inFlight.abort(); inFlight = null; }
    const {
      url, layers, style, visible,
    } = getActiveRadar();
    let host = null;
    try { host = new URL(url).hostname; } catch { /* unset source url */ }
    if (!visible || !layers || host !== MC_HOST) { hide(); return; }
    const key = `${layers}|${style}`;
    if (poisoned.has(key)) { hide(); return; }
    const cached = cache.get(key);
    if (cached) { render(cached); return; }
    const controller = new AbortController();
    inFlight = controller;
    let legend = null;
    try {
      const r = await fetch(legendUrl(url, layers, style), { signal: controller.signal });
      if (!r.ok) {
        if (r.status >= 400 && r.status < 500) poisoned.add(key);
        hide();
        return;
      }
      legend = await r.json();
      if (!isLegendShape(legend)) { poisoned.add(key); hide(); return; }
    } catch (err) {
      if (err.name === 'AbortError') return;
      // 200 + XML ServiceExceptionReport lands here as a SyntaxError.
      if (err instanceof SyntaxError) poisoned.add(key);
      hide();
      return;
    } finally {
      if (inFlight === controller) inFlight = null;
    }
    cache.set(key, legend);
    render(legend);
  }

  return { refresh, isExpanded: () => expanded };
}
