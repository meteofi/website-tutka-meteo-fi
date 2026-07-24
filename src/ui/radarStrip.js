// Single-radar strip: a flat segmented bar — site · elevation sweep · quantity ·
// close — shown as the topmost element of the bottom bar while pane 0 is drilled
// into one radar site. It mirrors the active site (fed by radarSite's
// onSingleSiteChange) and drives it back through the callbacks below; the marker
// card remains the tap-to-enter point, and switching sites stays on the map.
//
//   update(state)  state = { name, nod, quantity, elevation, moments, angles }
//                  or null → hide the strip
export default function initRadarStrip({
  element, // the #radarStrip container (in #timecontrol)
  onSelectElevation, // (number) — chosen sweep in degrees
  onSelectQuantity, // (string) — chosen moment code (DBZH / VRADH / …)
  onExit, // () — back to the composite
}) {
  element.innerHTML = `
    <span class="rs-site">
      <i class="material-icons" aria-hidden="true">cell_tower</i>
      <span class="rs-site-name"></span>
    </span>
    <span class="rs-seg rs-angle" hidden>
      <span class="rs-label">Kulma</span>
      <select class="rs-select rs-angle-select" aria-label="Korkeuskulma"></select>
    </span>
    <span class="rs-seg rs-quantity" hidden>
      <span class="rs-label">Suure</span>
      <select class="rs-select rs-quantity-select" aria-label="Tutkasuure"></select>
    </span>
    <button type="button" class="rs-exit" aria-label="Näytä koostekuva">
      <i class="material-icons" aria-hidden="true">close</i>
    </button>
  `;

  const siteName = element.querySelector('.rs-site-name');
  const angleSeg = element.querySelector('.rs-angle');
  const angleSelect = element.querySelector('.rs-angle-select');
  const quantitySeg = element.querySelector('.rs-quantity');
  const quantitySelect = element.querySelector('.rs-quantity-select');
  const exitBtn = element.querySelector('.rs-exit');

  function fillSelect(select, options, current) {
    select.textContent = '';
    options.forEach((opt) => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.text;
      if (opt.value === current) o.selected = true;
      select.appendChild(o);
    });
  }

  function update(state) {
    if (!state) { element.hidden = true; return; }
    element.hidden = false;
    siteName.textContent = state.nod ? `${state.name} (${state.nod})` : state.name;

    // A selector only earns its place when there's a real choice (≥2 options);
    // a single-sweep / single-moment site just shows the site name.
    const angles = state.angles || [];
    if (angles.length >= 2) {
      angleSeg.hidden = false;
      fillSelect(angleSelect, angles.map((a) => ({ value: String(a), text: `${a}°` })), String(state.elevation));
    } else {
      angleSeg.hidden = true;
    }

    const moments = state.moments || [];
    if (moments.length >= 2) {
      quantitySeg.hidden = false;
      fillSelect(quantitySelect, moments.map((q) => ({ value: q, text: q })), state.quantity);
    } else {
      quantitySeg.hidden = true;
    }
  }

  angleSelect.addEventListener('change', () => onSelectElevation(Number(angleSelect.value)));
  quantitySelect.addEventListener('change', () => onSelectQuantity(quantitySelect.value));
  exitBtn.addEventListener('click', () => onExit());

  return { update, element };
}
