/**
 * Layer-control panel — the style / opacity / info section folded into each
 * category's long-press menu. radar.js wires this to createLongPressHandler's
 * `onBeforeShow`, so populate() runs *before* the menu is measured and
 * positioned (the flip-up / scroll math needs the final height). Replaces the
 * retired `#playList` bottom sheet + its bottom-bar button.
 *
 * The controls act on whichever layer opened the menu — pane 0's layer from the
 * global toolbar button, that pane's layer from a split pill (the menu DOM is
 * shared; only one is open at a time, so the last opener's populate() wins,
 * mirroring longpress.js's onSelect handoff).
 *
 * Opacity writes the persistent `_baseOpacity` that routeLayer respects, so a
 * value chosen here survives playback (radar.js Hard rule 7 + the PR #182 fix).
 * Only radar advertises >1 style, so the style row hides itself for every other
 * category. Each open rebuilds the controls from scratch, so chip/slider
 * listeners never accumulate.
 */

// Build the horizontal style-chip row. Hidden unless the active sublayer
// advertises more than one style (today: radar only).
function buildStyles(container, layer, info) {
  container.textContent = '';
  const styles = info && info.style;
  if (!styles || styles.length <= 1) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const activeStyleParam = layer.getSource().getParams().STYLES || '';
  // No explicit STYLES set → the first advertised style is the WMS default.
  const activeStyleName = activeStyleParam || (styles[0] && styles[0].Name) || '';
  styles.forEach((layerStyle) => {
    const chip = document.createElement('div');
    chip.textContent = layerStyle.Title;
    if (layerStyle.Name === activeStyleName) chip.classList.add('activeStyle');
    chip.addEventListener('click', (e) => {
      layer.setLayerStyle(layerStyle.Name, 'panel');
      container.querySelectorAll('.activeStyle').forEach((el) => el.classList.remove('activeStyle'));
      chip.classList.add('activeStyle');
      e.stopPropagation();
    });
    container.appendChild(chip);
  });
}

// Build the opacity slider. `_baseOpacity` is the source of truth (falls back to
// the interpolator's `_userOpacity`, then the live opacity) so the slider shows
// the user's value even when the interpolator has parked the layer transparent.
function buildOpacity(container, layer) {
  container.textContent = '';
  const baseOp = layer.get('_baseOpacity');
  const userOp = baseOp !== undefined ? baseOp : layer.get('_userOpacity');
  const effective = userOp !== undefined ? userOp : layer.getOpacity();
  const pct = Math.round(effective * 100);

  const labelRow = document.createElement('div');
  labelRow.className = 'opacity-label-row';
  const label = document.createElement('span');
  label.className = 'opacity-label';
  label.textContent = 'Läpikuultavuus';
  const value = document.createElement('span');
  value.className = 'opacity-value';
  value.textContent = `${pct}%`;
  labelRow.append(label, value);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '1';
  slider.max = '100';
  slider.value = pct;
  slider.className = 'slider';
  const paint = (v) => {
    slider.style.background = `linear-gradient(to right, var(--dark-primary-color) ${v}%, var(--dark-theme-overlay-06dp) ${v}%)`;
  };
  paint(pct);
  slider.addEventListener('input', (e) => {
    const val = e.target.value;
    // Silent set (no rebuild), then setOpacity applies it now and notifies the
    // interpolator's own opacity listener.
    layer.set('_baseOpacity', val / 100, true);
    layer.setOpacity(val / 100);
    value.textContent = `${Math.round(val)}%`;
    paint(val);
    e.stopPropagation();
  });

  container.append(labelRow, slider);
}

// Fill the title / abstract / attribution block from the active sublayer's info.
function buildInfo(container, info) {
  if (!info) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.querySelector('.lp-info-title').textContent = info.title || '';
  container.querySelector('.lp-info-text').textContent = info.abstract || '';
  let attribution = (info.attribution && info.attribution.Title) || '';
  // Some products carry the licence string as the attribution Title too (radar:
  // both are "CC-BY-4.0"); don't render it twice.
  if (info.license && info.license !== attribution) {
    attribution += (attribution ? ` (${info.license})` : info.license);
  }
  container.querySelector('.lp-info-attr').textContent = attribution;
}

export default function createLayerPanel() {
  // Populate a long-press menu's control section for the given layer. Called
  // from onBeforeShow so the menu is measured at its final height.
  function populate(menuEl, layer) {
    if (!menuEl || !layer) return;
    const info = layer.get('info');
    const styles = menuEl.querySelector('.lp-styles');
    const opacity = menuEl.querySelector('.lp-opacity');
    const infoBlock = menuEl.querySelector('.lp-info');
    if (styles) buildStyles(styles, layer, info);
    if (opacity) buildOpacity(opacity, layer);
    if (infoBlock) buildInfo(infoBlock, info);
  }

  return { populate };
}
