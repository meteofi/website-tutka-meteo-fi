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
// The chevron is a separate button precisely because expanding and switching
// off must not be reachable by the same press — a stray tap should never
// silently hide a layer the user thought they were expanding.
//
// THE SWITCH ON A TOPIC WITH PARTS IS A REAL THREE-POSITION CONTROL. Pressing
// its left end turns the whole topic off, its right end turns every part on,
// and the knob genuinely sits at the position it reports. Pressing anywhere
// ELSE on the row is the ordinary toggle, which remembers: a topic hidden and
// shown again comes back with the parts you had chosen, not with all of them.
// That split is the whole point — the switch is for saying "none" or "all"
// outright, the row is for putting a topic away without losing your selection.
//
// Only topics with parts get this. A plain row has nothing to be partial about,
// and making its switch positional would turn a press on the end it already
// sits at into a confusing no-op.
//
// SECTIONS are the same idea one level up: a run of related topics (Ilmailu =
// aerodromes, turnpoints, aircraft, airspace) behind one disclosure, so four
// rows cost one when nobody is looking at them. A section has NO STATE OF ITS
// OWN — it reads on, off or half-on from its members and its gestures just
// operate them — which is what lets a topic inside a section keep its own parts
// and behave exactly as it does outside one. That matters because Ilmatilat has
// parts of its own, so a section that owned state would have needed a third
// level of it.

const EXPAND_ICON = 'expand_more';

export default function initPoiMenu({
  container,
  registry,
  // (id) -> boolean, and (id, childId) -> boolean. Read on every refresh rather
  // than cached, so the caller stays the single source of truth.
  isOn,
  isChildOn = () => false,
  // { id: { label, icon } } for the runs of topics that share a `section`.
  sections = {},
  // The caller mutates its own state, applies it and persists.
  onToggle,
  // (id, on) -> void. The switch pressed at one of its ends, which is absolute
  // rather than a toggle: left means none of the topic, right means all of it.
  onSetGroup = () => {},
  onToggleChild = () => {},
  // (sectionId, 'toggle' | 'all' | 'none') — the same three gestures a topic
  // with parts answers to, applied to every member at once.
  onSection = () => {},
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

  const sectionMembers = (sectionId) => registry.filter((e) => e.section === sectionId);

  // Read from the members, never stored. All of them fully on reads on, none of
  // them reads off, anything else is the half-on that tells you to look inside.
  function sectionState(sectionId) {
    const states = sectionMembers(sectionId).map(groupState);
    if (states.every((st) => st === 'on')) return 'on';
    if (states.every((st) => st === 'off')) return 'off';
    return 'partial';
  }

  const ariaFor = (state) => (state === 'partial' ? 'mixed' : String(state === 'on'));

  function refresh() {
    Object.keys(sections).forEach((sectionId) => {
      const row = container.querySelector(`.menu-row[data-poi-section="${sectionId}"]`);
      if (row) row.setAttribute('aria-checked', ariaFor(sectionState(sectionId)));
    });
    registry.forEach((entry) => {
      const row = container.querySelector(`.menu-row[data-poi="${entry.id}"]`);
      if (!row) return;
      const state = groupState(entry);
      // `mixed` is the ARIA value for a checkbox whose children disagree, so a
      // screen reader says "partially checked" rather than one of the lies.
      row.setAttribute('aria-checked', ariaFor(state));
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

  // A section hides its members, and their parts with them; showing it again
  // leaves each topic's own disclosure as it was.
  function setSectionExpanded(sectionId, expanded) {
    const row = container.querySelector(`.menu-row[data-poi-section="${sectionId}"]`);
    const toggleEl = row && row.querySelector('.poi-expand');
    if (!toggleEl) return;
    toggleEl.setAttribute('aria-expanded', String(expanded));
    row.classList.toggle('is-expanded', expanded);
    sectionMembers(sectionId).forEach((entry) => {
      const memberRow = container.querySelector(`.menu-row[data-poi="${entry.id}"]`);
      if (memberRow) memberRow.hidden = !expanded;
      const topicOpen = !!memberRow && memberRow.classList.contains('is-expanded');
      (entry.children || []).forEach((child) => {
        const childRow = container.querySelector(
          `.menu-row[data-poi-child="${entry.id}.${child.id}"]`,
        );
        if (childRow) childRow.hidden = !expanded || !topicOpen;
      });
    });
  }

  function collapseAll() {
    registry.forEach((entry) => {
      if (entry.children) setExpanded(entry, false);
    });
    Object.keys(sections).forEach((sectionId) => setSectionExpanded(sectionId, false));
  }

  function makeSwitch() {
    const el = document.createElement('span');
    el.className = 'switch';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  // Which end of the switch was pressed. Measured against the element rather
  // than trusting offsetX, which is relative to whatever the event happened to
  // land on — the knob is a pseudo-element, but padding and hit slop are not.
  function pressedRightEnd(switchEl, event) {
    const rect = switchEl.getBoundingClientRect();
    if (!rect.width) return false;
    return (event.clientX - rect.left) >= rect.width / 2;
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

  // The disclosure button, shared by topics and sections. Its own button, so
  // that expanding and switching off are never the same press.
  function buildChevron(label, onFlip) {
    const toggleEl = document.createElement('button');
    toggleEl.type = 'button';
    toggleEl.className = 'poi-expand';
    toggleEl.setAttribute('aria-expanded', 'false');
    toggleEl.setAttribute('aria-label', `${label}: näytä osat`);
    const chevron = document.createElement('i');
    chevron.className = 'material-icons';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = EXPAND_ICON;
    toggleEl.appendChild(chevron);
    const flip = (e) => {
      e.stopPropagation();
      onFlip(toggleEl.getAttribute('aria-expanded') !== 'true');
    };
    toggleEl.addEventListener('mouseup', flip);
    toggleEl.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        flip(e);
      }
    });
    return toggleEl;
  }

  function buildSectionRow(sectionId) {
    const spec = sections[sectionId];
    const row = document.createElement('div');
    row.className = 'menu-row';
    row.setAttribute('role', 'menuitemcheckbox');
    row.setAttribute('aria-checked', ariaFor(sectionState(sectionId)));
    row.setAttribute('data-poi-section', sectionId);
    row.setAttribute('tabindex', '0');

    const iconEl = document.createElement('i');
    iconEl.className = 'material-icons';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = spec.icon;

    const labelEl = document.createElement('span');
    labelEl.className = 'menu-label';
    labelEl.textContent = spec.label;

    row.appendChild(iconEl);
    row.appendChild(labelEl);
    row.appendChild(buildChevron(spec.label, (open) => setSectionExpanded(sectionId, open)));

    // Same three gestures as a topic with parts: the switch ends are absolute,
    // the rest of the row is the remembering toggle.
    const switchEl = makeSwitch();
    switchEl.addEventListener('mouseup', (e) => {
      e.stopPropagation();
      onSection(sectionId, pressedRightEnd(switchEl, e) ? 'all' : 'none');
    });
    row.appendChild(switchEl);
    row.addEventListener('mouseup', () => onSection(sectionId, 'toggle'));
    row.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        onSection(sectionId, 'toggle');
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setSectionExpanded(sectionId, e.key === 'ArrowRight');
      }
    });
    return row;
  }

  function buildRow(entry) {
    const row = document.createElement('div');
    row.className = entry.section ? 'menu-row is-in-section' : 'menu-row';
    if (entry.section) row.hidden = true;
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
      row.appendChild(buildChevron(entry.label, (open) => setExpanded(entry, open)));
    }

    const switchEl = makeSwitch();
    if (entry.children) {
      // Stops the press so the row's own toggle does not also run: on this row
      // the switch and the rest of the row mean different things.
      switchEl.addEventListener('mouseup', (e) => {
        e.stopPropagation();
        onSetGroup(entry.id, pressedRightEnd(switchEl, e));
      });
    }
    row.appendChild(switchEl);
    row.addEventListener('mouseup', () => onToggle(entry.id));
    // Keyboard keeps the remembering toggle on the row and reaches "all on" by
    // the parts themselves, which are focusable rows of their own. The ends of
    // the switch are a pointer affordance; nothing is only reachable through
    // them.
    wireKeys(row, () => onToggle(entry.id), entry);
    return row;
  }

  function buildChildRow(entry, child) {
    const row = document.createElement('div');
    row.className = entry.section ? 'menu-row is-child is-in-section' : 'menu-row is-child';
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
  const emitted = new Set();
  registry.forEach((entry) => {
    // Members of a section are contiguous in the registry, so the section's own
    // row goes in when the first of them is reached.
    if (entry.section && sections[entry.section] && !emitted.has(entry.section)) {
      emitted.add(entry.section);
      container.appendChild(buildSectionRow(entry.section));
    }
    container.appendChild(buildRow(entry));
    (entry.children || []).forEach((child) => {
      container.appendChild(buildChildRow(entry, child));
    });
  });

  return { refresh, collapseAll };
}
