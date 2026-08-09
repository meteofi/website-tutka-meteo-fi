// Telemetry strip — a bottom panel showing one row of live readings about a
// single selected thing, whatever that thing happens to be.
//
// Deliberately generic. It knows nothing about aircraft: a caller hands it a
// title and a list of metrics, and it draws them. The first use is the selected
// OGN aircraft (speed, heading, altitude, vertical speed), and the own-vessel
// AIS target and the device's own position are meant to follow — each of those
// is the same shape of problem, a moving subject with a handful of numbers that
// change continuously.
//
// Bottom-panel mechanics are the crossSection.js / weatherCameras.js pattern:
// `hidden` is removed once at build time and the height-0 / `.open` CSS
// transition does the show/hide, with `--timecontrol-height` in radar.css making
// room so the floating buttons ride above it.
//
// WHY A STRIP RATHER THAN A CARD ANCHORED TO THE SUBJECT. The subject moves. An
// overlay pinned to it drifts across the map, needs repositioning on every
// update, and slides off screen exactly when the numbers matter. A fixed strip
// stays where the eye last found it while the map pans underneath.
//
// ONE PANEL, MANY POSSIBLE SOURCES. Only one subject can be displayed at a time,
// so every call carries an `owner` token. A source may only update or close what
// it currently owns — otherwise a background source (say a geolocation tick)
// would quietly wipe out the aircraft the user just selected. Opening always
// takes over, because opening is an explicit user action.

export default function initTelemetryPanel({ container, onClose } = {}) {
  if (!container) {
    // Same degraded-but-harmless contract as crossSection.js: with no container
    // the API exists and does nothing, so callers need no guards.
    return {
      open() {}, update() {}, close() {}, isOpen: () => false, ownerIs: () => false,
    };
  }

  container.removeAttribute('hidden');
  container.removeAttribute('aria-hidden');
  container.innerHTML = `
    <div class="telemetry-head">
      <i class="material-icons telemetry-icon" aria-hidden="true"></i>
      <span class="telemetry-title"></span>
      <span class="telemetry-sub"></span>
      <span class="telemetry-status"></span>
      <button type="button" class="telemetry-close" aria-label="Sulje">
        <i class="material-icons" aria-hidden="true">close</i>
      </button>
    </div>
    <div class="telemetry-row"></div>
  `;

  const iconEl = container.querySelector('.telemetry-icon');
  const titleEl = container.querySelector('.telemetry-title');
  const subEl = container.querySelector('.telemetry-sub');
  const statusEl = container.querySelector('.telemetry-status');
  const rowEl = container.querySelector('.telemetry-row');

  let owner = null;

  function close(from) {
    // A source that no longer owns the panel must not be able to shut it.
    if (from !== undefined && from !== owner) return;
    owner = null;
    container.classList.remove('open');
    if (typeof onClose === 'function') onClose();
  }

  container.querySelector('.telemetry-close').addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });

  // `metrics` is [{ label, value, tone }] — `value` already formatted, because
  // only the caller knows whether a number is knots or metres or degrees, and
  // whether an absent reading should read '–' or be dropped. `tone` optionally
  // colours the value ('up', 'down', 'warn') for readings whose sign carries
  // meaning, a glider's vertical speed being the motivating case.
  function paint({
    icon, title, subtitle, status, metrics,
  }) {
    if (icon !== undefined) iconEl.textContent = icon;
    if (title !== undefined) titleEl.textContent = title;
    // Never hidden: this element is also the flexible spacer that holds the
    // status and the close button against the right edge, so removing it from
    // the layout when empty would let them drift inward.
    if (subtitle !== undefined) subEl.textContent = subtitle || '';
    // How current the readings are. Every subject this panel is meant to serve
    // reports intermittently — a glider circling in a thermal can go 60-90 s
    // between fixes, and an AIS vessel or a phone's GPS is no different — so the
    // age of the reading belongs beside it, or the numbers read as live when
    // they are not.
    if (status !== undefined) {
      statusEl.textContent = status || '';
      statusEl.hidden = !status;
    }
    if (!metrics) return;
    // Rebuilt wholesale rather than diffed: a strip holds a handful of cells and
    // updates about once a second, so the simple thing is also the fast thing.
    rowEl.innerHTML = metrics.map((m) => `
      <div class="telemetry-cell">
        <span class="telemetry-value${m.tone ? ` is-${m.tone}` : ''}">${m.value}</span>
        <span class="telemetry-label">${m.label}</span>
      </div>`).join('');
  }

  return {
    // Opening always takes over — it is an explicit user action.
    open(from, payload) {
      owner = from;
      paint(payload);
      container.classList.add('open');
    },
    // Silently ignored when another source has taken the panel over, which is
    // what keeps a background feed from redrawing someone else's subject.
    update(from, payload) {
      if (from !== owner) return;
      paint(payload);
    },
    close,
    isOpen: () => container.classList.contains('open'),
    ownerIs: (from) => owner === from,
  };
}
