// Backend-outage banner: says so out loud when a server feeding a layer the
// user is actually looking at stops answering, so a frozen map reads as an
// outage instead of "nothing is happening today".
//
// The failure this exists for: on 2026-08-17 meteocore answered `404 page not
// found` on every path for ~30 minutes. StickyImageWMS did its job and kept the
// last good frame on screen, the clock kept ticking, and nothing anywhere told
// the user the image had stopped advancing.
//
// Detection rides the GetCapabilities poll radar.js already runs (60 s for
// meteocore, 300 s for EUMETSAT, exponential backoff up to 5 min on failure) —
// this module issues no requests of its own. radar.js reports every poll
// outcome; `getWMSCapabilities` already routes 4xx/5xx into its .catch via the
// `!response.ok` throw, so a 404-ing host counts as down exactly like an
// unreachable one.
//
// Two deliberate rules:
//
// - **Only hosts serving a VISIBLE layer raise the banner.** A EUMETSAT outage
//   while the satellite layer is off is not the user's problem, and naming
//   "tutkakuva" for it would be actively misleading. radar.js answers this from
//   layer source URLs rather than layerInfo, so it is still correct before
//   GetCapabilities has ever succeeded — the boot-during-outage case.
// - **Two consecutive failures before speaking up**, so one dropped request on a
//   phone switching cells stays silent. The exception is a host that has never
//   answered this session: nothing is on screen to misread, so one failure is
//   enough and the user finds out at once instead of ~3 minutes in.
//
// Wall-clock only — no FramePool or `setTime` coupling.

// Subject + verb per category, because Finnish agreement differs: "Tutkakuva
// ei päivity" but "Salamahavainnot eivät päivity". Joining several always takes
// the plural.
const CATEGORY_TEXT = {
  radarLayer: { subject: 'Tutkakuva', verb: 'ei päivity' },
  satelliteLayer: { subject: 'Satelliittikuva', verb: 'ei päivity' },
  lightningLayer: { subject: 'Salamahavainnot', verb: 'eivät päivity' },
  observationLayer: { subject: 'Havainnot', verb: 'eivät päivity' },
};
const CATEGORY_ORDER = ['radarLayer', 'satelliteLayer', 'lightningLayer', 'observationLayer'];

const FAIL_THRESHOLD = 2;
const RETRY_COOLDOWN_MS = 10000;

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return null; }
}

// "25 min" / "1 h 5 min". Under a minute reads as "alle minuutin" rather than
// "0 min", which would look like a bug.
function formatAge(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'alle minuutin';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// "Tutkakuva ei päivity" / "Tutkakuva ja satelliittikuva eivät päivity".
function headlineFor(categories) {
  const known = CATEGORY_ORDER.filter((c) => categories.includes(c));
  if (!known.length) return 'Aineisto ei päivity';
  const subjects = known.map((c, i) => (i === 0
    ? CATEGORY_TEXT[c].subject
    : CATEGORY_TEXT[c].subject.toLowerCase()));
  const verb = known.length === 1 ? CATEGORY_TEXT[known[0]].verb : 'eivät päivity';
  if (subjects.length === 1) return `${subjects[0]} ${verb}`;
  const last = subjects.pop();
  return `${subjects.join(', ')} ja ${last} ${verb}`;
}

function initServerStatus({
  container,
  getAffectedCategories,
  getNewestFrameAgeMs,
  onRetry,
}) {
  if (!container) return null;

  // host -> { fails, everSucceeded }
  const hosts = new Map();
  // Which affected-category set the user dismissed. Kept in memory only: a
  // reload during an ongoing outage should say so again, and an outage that
  // spreads to another layer is new information.
  let dismissedKey = null;
  let retryBlockedUntil = 0;

  container.innerHTML = '';
  const icon = document.createElement('span');
  icon.className = 'material-icons ss-icon';
  icon.textContent = 'cloud_off';
  icon.setAttribute('aria-hidden', 'true');
  const textWrap = document.createElement('div');
  textWrap.className = 'ss-text';
  const titleEl = document.createElement('div');
  titleEl.className = 'ss-title';
  const detailEl = document.createElement('div');
  detailEl.className = 'ss-detail';
  textWrap.append(titleEl, detailEl);
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'ss-retry';
  retryBtn.textContent = 'Yritä uudelleen';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ss-close material-icons';
  closeBtn.textContent = 'close';
  closeBtn.setAttribute('aria-label', 'Piilota ilmoitus');
  container.append(icon, textWrap, retryBtn, closeBtn);

  function downHosts() {
    const out = [];
    hosts.forEach((state, host) => {
      // A host that has never answered needs only one failure: there is no
      // stale frame on screen for the user to misread as current.
      const threshold = state.everSucceeded ? FAIL_THRESHOLD : 1;
      if (state.fails >= threshold) out.push(host);
    });
    return out;
  }

  function hide() {
    container.hidden = true;
    document.body.classList.remove('has-server-banner');
  }

  function render() {
    const down = downHosts();
    const categories = new Set();
    down.forEach((host) => {
      (getAffectedCategories(host) || []).forEach((c) => categories.add(c));
    });

    // Nothing down, or nothing down that the user can see.
    if (!categories.size) {
      dismissedKey = null;
      hide();
      return;
    }

    const key = [...categories].sort().join('|');
    if (dismissedKey === key) { hide(); return; }
    dismissedKey = null;

    // Offline is the user's own connection, not the backend — saying "palvelin
    // ei vastaa" would send them chasing the wrong problem.
    const offline = navigator.onLine === false;
    titleEl.textContent = offline ? 'Ei verkkoyhteyttä' : headlineFor([...categories]);

    const parts = [];
    if (offline) {
      parts.push('Kuva päivittyy kun yhteys palaa');
    } else {
      parts.push('Palvelin ei vastaa');
      const age = getNewestFrameAgeMs([...categories]);
      if (Number.isFinite(age) && age > 0) parts.push(`uusin kuva ${formatAge(age)} vanha`);
    }
    detailEl.textContent = parts.join(' · ');
    // Retrying is pointless with the radio off, and the `online` event
    // re-renders the moment it comes back.
    retryBtn.hidden = offline || !onRetry;

    container.hidden = false;
    document.body.classList.add('has-server-banner');
  }

  closeBtn.addEventListener('click', () => {
    const categories = new Set();
    downHosts().forEach((h) => (getAffectedCategories(h) || []).forEach((c) => categories.add(c)));
    dismissedKey = [...categories].sort().join('|');
    hide();
  });

  retryBtn.addEventListener('click', () => {
    if (!onRetry || Date.now() < retryBlockedUntil) return;
    retryBlockedUntil = Date.now() + RETRY_COOLDOWN_MS;
    retryBtn.disabled = true;
    detailEl.textContent = 'Yhdistetään uudelleen…';
    setTimeout(() => { retryBtn.disabled = false; }, RETRY_COOLDOWN_MS);
    onRetry(downHosts());
  });

  // A connection coming back does not itself prove the backend is up, but it
  // does invalidate the "Ei verkkoyhteyttä" wording immediately — and it is
  // the one moment we know a retry is worth spending. Without this the backoff
  // (up to 5 min) keeps the banner up long after the network returned, which
  // reads as "still broken" when it is really "not asked again yet".
  window.addEventListener('online', () => {
    const down = downHosts();
    if (down.length && onRetry) onRetry(down);
    render();
  });
  window.addEventListener('offline', render);

  return {
    // Called from getWMSCapabilities for every poll outcome.
    report(url, ok) {
      const host = hostOf(url);
      if (!host) return;
      let state = hosts.get(host);
      if (!state) { state = { fails: 0, everSucceeded: false }; hosts.set(host, state); }
      if (ok) {
        state.fails = 0;
        state.everSucceeded = true;
      } else {
        state.fails += 1;
      }
      render();
    },
    // Visibility changed (layer toggled, pane added): what the banner may
    // legitimately complain about changed with it.
    refresh: render,
  };
}

export default initServerStatus;
