// Floating compass speed dial (top-right of the map). Shows the user's own
// speed — device GPS in km/h, or the AIS own-vessel SOG in knots — as a big
// number, wrapped in a heading-up compass ring: the current course/heading
// sits at the top, printed in the pill. The ring is deliberately sparse to stay
// legible at 64 px — the four cardinals are letters (N red as the north marker,
// E/S/W white) and the intermediate 30° points are plain white dots. When no
// heading is available (a stationary GPS fix, or a vessel not reporting
// COG/heading) it degrades to a plain speedo — the ring and heading pill hide.
//
// Like the own-position marker, this is wall-clock "now": zero coupling to the
// 13-frame animation window (FramePool / setTime). radar.js wires it to the
// ownLocation speed events; the module owns only its own DOM.
//
//   update({ value, unit, headingDeg })  show; headingDeg null → speedo only
//   update(null)                         hide
const SVG_NS = 'http://www.w3.org/2000/svg';

// viewBox is 0..100; the dial element scales it down to ~64 px.
const CENTER = 50;
const R_CARD = 36; // cardinal letters
const R_DOT = 43; // intermediate dots
// Intermediate compass points (every 30° that isn't a cardinal), shown as dots.
const DOT_BEARINGS = [30, 60, 120, 150, 210, 240, 300, 330];
const CARDINALS = [
  { bearing: 0, label: 'N', cls: 'sd-card sd-card--n' },
  { bearing: 90, label: 'E', cls: 'sd-card' },
  { bearing: 180, label: 'S', cls: 'sd-card' },
  { bearing: 270, label: 'W', cls: 'sd-card' },
];
// Hide the cardinal nearest the top so it never sits behind the heading pill.
const TOP_CLEAR_DEG = 22;

// Bearing (deg from north, clockwise) → [x, y] on the viewBox, top = north.
function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [CENTER + r * Math.sin(a), CENTER - r * Math.cos(a)];
}

export default function initSpeedDial({ mount = document.body } = {}) {
  const el = document.createElement('div');
  el.className = 'speed-dial';
  el.hidden = true;
  el.setAttribute('role', 'img');

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'speed-dial__ring');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');

  // Intermediate dots live in a group rotated by -heading (heading-up). They're
  // rotationally symmetric, so no per-mark upright correction is needed.
  const ring = document.createElementNS(SVG_NS, 'g');
  for (const b of DOT_BEARINGS) {
    const [x, y] = polar(R_DOT, b);
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', x.toFixed(2));
    dot.setAttribute('cy', y.toFixed(2));
    dot.setAttribute('r', '1.8');
    dot.setAttribute('class', 'sd-dot');
    ring.appendChild(dot);
  }
  svg.appendChild(ring);

  // Cardinal letters are kept upright and repositioned per heading rather than
  // rotated with the ring, so N/E/S/W never turn upside down.
  const cardEls = [];
  for (const c of CARDINALS) {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    t.setAttribute('class', c.cls);
    t.textContent = c.label;
    svg.appendChild(t);
    cardEls.push({ bearing: c.bearing, node: t });
  }
  el.appendChild(svg);

  const hdg = document.createElement('div');
  hdg.className = 'speed-dial__hdg';
  el.appendChild(hdg);

  const valBox = document.createElement('div');
  valBox.className = 'speed-dial__val';
  const num = document.createElement('b');
  const unit = document.createElement('span');
  valBox.appendChild(num);
  valBox.appendChild(unit);
  el.appendChild(valBox);

  mount.appendChild(el);

  function renderHeading(h) {
    ring.setAttribute('transform', `rotate(${(-h).toFixed(1)} ${CENTER} ${CENTER})`);
    for (const c of cardEls) {
      let screen = (c.bearing - h) % 360;
      if (screen > 180) screen -= 360;
      if (screen < -180) screen += 360;
      if (Math.abs(screen) < TOP_CLEAR_DEG) {
        c.node.setAttribute('display', 'none');
      } else {
        const [x, y] = polar(R_CARD, c.bearing - h);
        c.node.setAttribute('x', x.toFixed(2));
        c.node.setAttribute('y', y.toFixed(2));
        c.node.removeAttribute('display');
      }
    }
    hdg.textContent = `${Math.round(h) % 360}`;
  }

  function update(payload) {
    if (!payload || payload.value == null || !Number.isFinite(payload.value)) {
      el.hidden = true;
      return;
    }
    const rounded = Math.round(payload.value);
    num.textContent = String(rounded);
    unit.textContent = payload.unit || '';
    el.classList.toggle('speed-dial--wide', rounded >= 100);
    const hasHeading = payload.headingDeg != null && Number.isFinite(payload.headingDeg);
    el.classList.toggle('speed-dial--nohdg', !hasHeading);
    let ariaHeading = '';
    if (hasHeading) {
      const norm = ((payload.headingDeg % 360) + 360) % 360;
      renderHeading(norm);
      ariaHeading = `, suunta ${Math.round(norm)} astetta`;
    }
    el.setAttribute('aria-label', `Nopeus ${rounded} ${payload.unit || ''}${ariaHeading}`);
    el.hidden = false;
  }

  return { update, element: el };
}
