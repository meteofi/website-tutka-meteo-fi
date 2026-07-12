// "Oma sijainti" section of the overflow menu: source chips (GPS / AIS /
// NMEA placeholder) plus the MMSI input row.
//
// Pending-selection flow: tapping the AIS chip without a valid MMSI only reveals
// and focuses the MMSI input (the chip highlights as a preview); the effective
// source stays GPS until a valid 9-digit MMSI is committed via the input
// (9th digit / Enter / blur). Reopening the menu reverts a dangling pending
// selection because openOverflowMenu calls refresh().
const MMSI_RE = /^[0-9]{9}$/;

export default function initOwnLocationMenu({
  getSource, // () => 'gps' | 'ais'
  getMmsi, // () => persisted MMSI string ('' if unset)
  onSelectSource, // (source) => bool — controller validates + persists
  onMmsiCommit, // (mmsi) => bool — controller validates + persists
}) {
  const chips = document.querySelectorAll('#overflowMenu .chip[data-own-loc]');
  const row = document.getElementById('mmsiRow');
  const input = document.getElementById('mmsiInput');
  const hint = document.getElementById('mmsiHint');
  const vesselName = document.getElementById('mmsiVesselName');
  let pendingAis = false;

  function setChecked(source) {
    chips.forEach((chip) => {
      chip.setAttribute('aria-checked', String(chip.dataset.ownLoc === source));
    });
  }

  function refresh() {
    pendingAis = false;
    const source = getSource();
    setChecked(source);
    input.value = getMmsi();
    row.hidden = source !== 'ais';
    hint.hidden = true;
  }

  function showPending() {
    pendingAis = true;
    setChecked('ais');
    row.hidden = false;
    hint.hidden = false;
    input.focus();
  }

  function commit() {
    const value = input.value.trim();
    if (!MMSI_RE.test(value)) {
      if (pendingAis) hint.hidden = false;
      return;
    }
    onMmsiCommit(value);
    if (pendingAis || getSource() === 'ais') onSelectSource('ais');
    refresh();
  }

  chips.forEach((chip) => {
    if (chip.dataset.ownLoc === 'nmea') {
      // Reserved for Web Serial NMEA input — surfaced (disabled) only where
      // the browser could support it at all; hidden everywhere else.
      if ('serial' in navigator) {
        chip.hidden = false;
        chip.setAttribute('aria-disabled', 'true');
        chip.textContent = 'NMEA — tulossa';
      }
      return;
    }
    chip.addEventListener('mouseup', () => {
      if (chip.dataset.ownLoc === 'ais' && !MMSI_RE.test(getMmsi())) {
        showPending();
        return;
      }
      onSelectSource(chip.dataset.ownLoc);
      refresh();
    });
  });

  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 9);
    if (vesselName) vesselName.textContent = '';
    if (input.value.length === 9) commit();
  });
  input.addEventListener('blur', () => commit());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      commit();
      input.blur();
    } else if (event.key === 'Escape') {
      // Cancel: restore the persisted value instead of committing the draft.
      refresh();
      input.blur();
    }
  });

  // Vessel name resolved from AIS metadata — shown next to the input as
  // confirmation that the MMSI matches the intended vessel.
  function setVesselInfo(info) {
    vesselName.textContent = info && info.name ? info.name : '';
  }

  refresh();
  return { refresh, setVesselInfo };
}
