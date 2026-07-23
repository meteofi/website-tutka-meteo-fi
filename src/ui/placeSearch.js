// "Etsi paikka" — full-screen place-search overlay opened from its own
// glass-FAB. Searches the bundled MML place-name snapshot entirely client
// side (src/search/placeIndex.js) and flies the shared View to the picked
// place. The overlay is app-level chrome (one instance above any pane grid);
// the highlight pulse fans out to every pane via the onHighlight callback.
import { fromLonLat } from 'ol/proj';
import {
  buildIndex, searchPlaces, targetZoomForBand, mergeRecent,
} from '../search/placeIndex';
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

// Recent selections persist locally so the empty-query state can offer
// one-tap reuse of the handful of places people re-search (home, mökki).
// Local-only: the list (names/coords) is never sent to analytics.
const RECENT_KEY = 'PLACE_SEARCH_RECENT';
const MAX_RECENT = 5;

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
  let indexFailed = false;
  let results = [];
  let resultsAreRecent = false;
  let activeIndex = -1;
  let hideTimer = 0;
  let recents = [];

  const isOpen = () => overlay.classList.contains('open');

  function loadRecents() {
    try {
      const stored = JSON.parse(localStorage.getItem(RECENT_KEY));
      if (!Array.isArray(stored)) return [];
      return stored
        .filter((r) => r && typeof r.name === 'string'
          && typeof r.lon === 'number' && typeof r.lat === 'number')
        .slice(0, MAX_RECENT);
    } catch (e) {
      return [];
    }
  }

  function saveRecents() {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
    } catch (e) {
      // Private mode / quota — recents are best-effort, never block a search.
    }
  }

  function rememberRecent(rec) {
    const entry = {
      name: rec.name, lon: rec.lon, lat: rec.lat, band: rec.band, cls: rec.cls,
    };
    recents = mergeRecent(recents, entry, MAX_RECENT);
    saveRecents();
  }

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
    // Never the query text, name or coordinates (analytics privacy rule);
    // `recent` is a privacy-safe boolean measuring empty-state reuse.
    track('place-search-select', {
      class: rec.cls, band: rec.band, rank, recent: resultsAreRecent,
    });
    rememberRecent(rec);
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

  // Build the listbox from a set of records (search hits or recents). The
  // recent flag swaps each row's class icon for a history icon and adds a
  // section header; option IDs and the `results` index count only place
  // rows, so the presentation header leaves keyboard nav untouched.
  function renderRows(recs, recent) {
    results = recs;
    resultsAreRecent = recent;
    activeIndex = -1;
    listEl.textContent = '';
    if (!recs.length) {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      return;
    }
    if (recent) {
      const header = document.createElement('li');
      header.className = 'ps-section';
      header.setAttribute('role', 'presentation');
      header.textContent = 'Viimeksi haetut';
      listEl.appendChild(header);
    }
    recs.forEach((rec, i) => {
      const li = document.createElement('li');
      li.id = `ps-opt-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const icon = document.createElement('i');
      icon.className = 'material-icons';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = recent ? 'history' : (CLASS_ICON[rec.cls] || 'place');
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

  function renderResults() {
    if (!isOpen()) return;
    const query = input.value.trim();
    // Empty query → recents, rendered straight from localStorage with no
    // index fetch. An empty recents list clears the box, preserving the
    // original blank empty-state for first-time users.
    if (!query) {
      renderRows(recents, true);
      return;
    }
    if (!index) {
      // A query was typed but the index isn't ready. Clear any recents still
      // on screen so the "Viimeksi haetut" header doesn't linger over typed
      // text; ensureIndex().then re-renders on success.
      results = [];
      resultsAreRecent = false;
      activeIndex = -1;
      if (indexFailed) {
        messageRow('Haku ei ole käytettävissä');
      } else {
        listEl.textContent = '';
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
      }
      return;
    }
    const hits = searchPlaces(index, query);
    if (!hits.length) {
      results = [];
      resultsAreRecent = false;
      activeIndex = -1;
      messageRow('Ei tuloksia');
      return;
    }
    renderRows(hits, false);
  }

  function ensureIndex() {
    if (index || indexPromise) return;
    indexFailed = false;
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
        indexFailed = true;
        track('place-search-error');
        if (isOpen()) renderResults();
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
    // Reload from storage each open so a selection made in another tab is
    // reflected, then show recents right away (no index fetch needed).
    recents = loadRecents();
    renderResults();
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
