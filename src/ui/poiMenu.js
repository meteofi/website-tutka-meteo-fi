// The POI section of the overflow menu: one switch row per registry entry.
//
// Moved out of radar.js unchanged (see the radar.js decomposition rules in
// CLAUDE.md). This module owns the DOM only — which rows exist, what they look
// like and how they are operated. The state behind them stays in radar.js,
// which passes it in through `isOn` and is told about presses through
// `onToggle`, so nothing here has to know what a layer is.

export default function initPoiMenu({
  container,
  registry,
  // (id) -> boolean. Read on every refresh rather than cached, so the caller
  // stays the single source of truth for what is switched on.
  isOn,
  // (id) -> void. The caller mutates its own state, applies it and persists.
  onToggle,
} = {}) {
  if (!container) return { refresh() {} };

  function refresh() {
    container.querySelectorAll('.menu-row[data-poi]').forEach((row) => {
      row.setAttribute('aria-checked', String(!!isOn(row.getAttribute('data-poi'))));
    });
  }

  function buildRow(entry) {
    const row = document.createElement('div');
    row.className = 'menu-row';
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', String(!!isOn(entry.id)));
    row.setAttribute('data-poi', entry.id);
    row.setAttribute('tabindex', '0');

    const iconEl = document.createElement('i');
    iconEl.className = 'material-icons';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = entry.icon;

    const labelEl = document.createElement('span');
    labelEl.className = 'menu-label';
    labelEl.textContent = entry.label;

    const switchEl = document.createElement('span');
    switchEl.className = 'switch';
    switchEl.setAttribute('aria-hidden', 'true');

    row.appendChild(iconEl);
    row.appendChild(labelEl);
    row.appendChild(switchEl);

    row.addEventListener('mouseup', () => onToggle(entry.id));
    row.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        onToggle(entry.id);
      }
    });
    return row;
  }

  container.textContent = '';
  registry.forEach((entry) => container.appendChild(buildRow(entry)));

  return { refresh };
}
