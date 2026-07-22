// "Etsi paikka" — full-screen place-search overlay opened from its own
// glass-FAB. Searches the bundled MML place-name snapshot entirely client
// side (src/search/placeIndex.js) and flies the shared View to the picked
// place. The overlay is app-level chrome (one instance above any pane grid);
// the highlight pulse fans out to every pane via the onHighlight callback.
import { fromLonLat } from 'ol/proj';
import { buildIndex, searchPlaces, targetZoomForBand } from '../search/placeIndex';
import { track } from '../analytics';
// Same hashed asset placeNames.js imports — webpack emits it once; by boot
// it is usually already in the HTTP cache (immutable) or the SW precache.
import placeNamesUrl from '../data/placenames-fi.geojson';

const CLASS_ICON = {
  c: 'location_city',
  a: 'home',
  w: 'waves',
  t: 'terrain',
};

const CLASS_LABEL = {
  c: 'Kaupunki',
  a: 'Asutus',
  w: 'Vesistö',
  t: 'Maasto',
};

const FLY_MS = 600;

export default function initPlaceSearch({
  button, // the #placeSearchButton FAB
  view, // shared OL View (all panes pan/zoom in lockstep)
  onHighlight, // (coord3857) => void — starts the cross-pane pulse
}) {
  const overlay = document.getElementById('placeSearchOverlay');
  const input = document.getElementById('placeSearchInput');
  const listEl = document.getElementById('placeSearchResults');
  const closeButton = document.getElementById('placeSearchClose');

  let index = null;
  let indexPromise = null;
  let results = [];
  let activeIndex = -1;
  let hideTimer = 0;

  const isOpen = () => overlay.classList.contains('open');

  function messageRow(text) {
    listEl.textContent = '';
    const li = document.createElement('li');
    li.className = 'ps-empty';
    li.textContent = text;
    listEl.appendChild(li);
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function setActive(i) {
    activeIndex = i;
    listEl.querySelectorAll('[role="option"]').forEach((row, r) => {
      row.setAttribute('aria-selected', String(r === i));
    });
    if (i === -1) {
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const row = document.getElementById(`ps-opt-${i}`);
    input.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  }

  function select(rec, rank) {
    const coord = fromLonLat([rec.lon, rec.lat]);
    // Never the query text, name or coordinates (analytics privacy rule).
    track('place-search-select', { class: rec.cls, band: rec.band, rank });
    close(); // blur first so the iOS keyboard starts dismissing
    // One frame of separation keeps the keyboard-dismissal repaint out of
    // the animation's first frame. The RAF playback clock is already gated
    // during the animation via getAnimating(); the completion moveend
    // persists metZoom and updates the URL hash like any user pan.
    requestAnimationFrame(() => {
      view.animate({
        center: coord,
        zoom: targetZoomForBand(rec.band),
        duration: FLY_MS,
      });
      // Started immediately, not in the animate callback: OL cancels the
      // animation on any user gesture and the 2.5 s pulse outlives the
      // 0.6 s flight anyway.
      onHighlight(coord);
    });
  }

  function renderResults() {
    if (!isOpen() || !index) return;
    const query = input.value;
    results = searchPlaces(index, query);
    if (!results.length) {
      if (query.trim()) messageRow('Ei tuloksia');
      else {
        listEl.textContent = '';
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
      }
      activeIndex = -1;
      return;
    }
    listEl.textContent = '';
    results.forEach((rec, i) => {
      const li = document.createElement('li');
      li.id = `ps-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const icon = document.createElement('i');
      icon.className = 'material-icons';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = CLASS_ICON[rec.cls] || 'place';
      const name = document.createElement('span');
      name.className = 'ps-name';
      name.textContent = rec.name;
      const hint = document.createElement('span');
      hint.className = 'ps-hint';
      hint.textContent = CLASS_LABEL[rec.cls] || '';
      li.append(icon, name, hint);
      // click, not the codebase's usual mouseup: the list scrolls, and a
      // scroll gesture released over a row must not select it.
      li.addEventListener('click', () => select(rec, i));
      listEl.appendChild(li);
    });
    input.setAttribute('aria-expanded', 'true');
    setActive(-1);
  }

  function ensureIndex() {
    if (index || indexPromise) return;
    indexPromise = fetch(placeNamesUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((geojson) => {
        index = buildIndex(geojson);
        renderResults(); // catch up with whatever was typed while loading
      })
      .catch(() => {
        indexPromise = null; // next open retries
        track('place-search-error');
        if (isOpen()) messageRow('Haku ei ole käytettävissä');
      });
  }

  function open() {
    if (isOpen()) return;
    clearTimeout(hideTimer);
    overlay.hidden = false;
    overlay.getBoundingClientRect(); // reflow so the opacity transition runs
    overlay.classList.add('open');
    // Synchronous focus inside the tap handler — iOS Safari only opens the
    // keyboard for focus() calls made within a user gesture.
    input.focus();
    ensureIndex();
    track('place-search-open');
  }

  function close() {
    if (!isOpen()) return;
    overlay.classList.remove('open');
    input.blur();
    input.value = '';
    results = [];
    activeIndex = -1;
    listEl.textContent = '';
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    hideTimer = setTimeout(() => { overlay.hidden = true; }, 200);
  }

  function moveActive(delta) {
    if (!results.length) return;
    const base = activeIndex === -1 ? (delta > 0 ? -1 : 0) : activeIndex;
    setActive((base + delta + results.length) % results.length);
  }

  button.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  // The dimmed map area doubles as the backdrop; taps inside the panel have
  // a child of the overlay as their target and fall through.
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  input.addEventListener('input', renderResults);
  // While the input has focus every keystroke is invisible to the global
  // shortcut listeners (isTextEntryTarget guard in radar.js).
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      moveActive(1);
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      moveActive(-1);
      event.preventDefault();
    } else if (event.key === 'Enter') {
      const i = Math.max(activeIndex, 0);
      if (results.length) select(results[i], i);
    } else if (event.key === 'Escape') {
      close();
    }
  });

  return { open, close, isOpen };
}
