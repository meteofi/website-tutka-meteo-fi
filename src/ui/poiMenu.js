// The POI section of the overflow menu: one switch row per registry entry, and
// for a topic made of parts (Rautatiet = Raiteet + Asemat + Junat) a disclosure
// that reveals a switch for each.
//
// This module owns the DOM only — which rows exist, what they look like and how
// they are operated. The state behind them stays in radar.js, which passes it in
// through `isOn`/`isChildOn` and is told about presses through
// `onToggle`/`onToggleChild`, so nothing here has to know what a layer is.
//
// WHY A DISCLOSURE AND NOT MORE ROWS. The menu is already long enough to
// scroll on a phone, and most of the time nobody wants the parts — they want
// the topic. Collapsed, this costs exactly the chevron: the menu is the same
// length as before. It only grows while someone is actually using that topic,
// and it collapses again on its own the next time the menu is opened.
//
// The group switch stays the primary control and keeps its whole-row hit
// target. The chevron is a separate button precisely because those two actions
// must not be reachable by the same press — a stray tap should never silently
// hide a layer the user thought they were expanding.

const EXPAND_ICON = 'expand_more';

export default function initPoiMenu({
  container,
  registry,
  // (id) -> boolean, and (id, childId) -> boolean. Read on every refresh rather
  // than cached, so the caller stays the single source of truth.
  isOn,
  isChildOn = () => false,
  // The caller mutates its own state, applies it and persists.
  onToggle,
  onToggleChild = () => {},
} = {}) {
  if (!container) return { refresh() {}, collapseAll() {} };

  // A topic is on, off, or showing some of its parts. The third state has to be
  // visible on the collapsed row, or a topic quietly missing a part looks
  // identical to one that is fully on and the user has no reason to look.
  function groupState(entry) {
    if (!isOn(entry.id)) return 'off';
    if (!entry.children) return 'on';
    const shown = entry.children.filter((c) => isChildOn(entry.id, c.id)).length;
    if (shown === entry.children.length) return 'on';
    return shown === 0 ? 'off' : 'partial';
  }

  function refresh() {
    registry.forEach((entry) => {
      const row = container.querySelector(`.menu-row[data-poi="${entry.id}"]`);
      if (!row) return;
      const state = groupState(entry);
      // `mixed` is the ARIA value for a checkbox whose children disagree, so a
      // screen reader says "partially checked" rather than one of the lies.
      row.setAttribute('aria-checked', state === 'partial' ? 'mixed' : String(state === 'on'));
      (entry.children || []).forEach((child) => {
        const childRow = container.querySelector(
          `.menu-row[data-poi-child="${entry.id}.${child.id}"]`,
        );
        if (childRow) childRow.setAttribute('aria-checked', String(isChildOn(entry.id, child.id)));
      });
    });
  }

  function setExpanded(entry, expanded) {
    const row = container.querySelector(`.menu-row[data-poi="${entry.id}"]`);
    const toggleEl = row && row.querySelector('.poi-expand');
    if (!toggleEl) return;
    toggleEl.setAttribute('aria-expanded', String(expanded));
    row.classList.toggle('is-expanded', expanded);
    (entry.children || []).forEach((child) => {
      const childRow = container.querySelector(
        `.menu-row[data-poi-child="${entry.id}.${child.id}"]`,
      );
      if (childRow) childRow.hidden = !expanded;
    });
  }

  function collapseAll() {
    registry.forEach((entry) => {
      if (entry.children) setExpanded(entry, false);
    });
  }

  function makeSwitch() {
    const el = document.createElement('span');
    el.className = 'switch';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  // Space and Enter operate a row; the arrow keys open and close a topic, which
  // is what a tree item does elsewhere and costs nothing to support.
  function wireKeys(row, activate, entry) {
    row.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        activate();
        return;
      }
      if (!entry || !entry.children) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setExpanded(entry, e.key === 'ArrowRight');
      }
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

    row.appendChild(iconEl);
    row.appendChild(labelEl);

    if (entry.children) {
      const toggleEl = document.createElement('button');
      toggleEl.type = 'button';
      toggleEl.className = 'poi-expand';
      toggleEl.setAttribute('aria-expanded', 'false');
      // Named for what it reveals, since the row's own label is read separately.
      toggleEl.setAttribute('aria-label', `${entry.label}: näytä osat`);
      const chevron = document.createElement('i');
      chevron.className = 'material-icons';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = EXPAND_ICON;
      toggleEl.appendChild(chevron);
      // The chevron sits inside the row, so without stopping the press here the
      // group would toggle as well as expand.
      const flip = (e) => {
        e.stopPropagation();
        setExpanded(entry, toggleEl.getAttribute('aria-expanded') !== 'true');
      };
      toggleEl.addEventListener('mouseup', flip);
      toggleEl.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          flip(e);
        }
      });
      row.appendChild(toggleEl);
    }

    row.appendChild(makeSwitch());
    row.addEventListener('mouseup', () => onToggle(entry.id));
    wireKeys(row, () => onToggle(entry.id), entry);
    return row;
  }

  function buildChildRow(entry, child) {
    const row = document.createElement('div');
    row.className = 'menu-row is-child';
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', String(isChildOn(entry.id, child.id)));
    row.setAttribute('data-poi-child', `${entry.id}.${child.id}`);
    row.setAttribute('tabindex', '0');
    row.hidden = true;

    const labelEl = document.createElement('span');
    labelEl.className = 'menu-label';
    labelEl.textContent = child.label;

    row.appendChild(labelEl);
    row.appendChild(makeSwitch());
    const activate = () => onToggleChild(entry.id, child.id);
    row.addEventListener('mouseup', activate);
    wireKeys(row, activate);
    return row;
  }

  container.textContent = '';
  registry.forEach((entry) => {
    container.appendChild(buildRow(entry));
    (entry.children || []).forEach((child) => {
      container.appendChild(buildChildRow(entry, child));
    });
  });

  return { refresh, collapseAll };
}
