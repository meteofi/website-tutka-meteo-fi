// Departure board for a tapped railway station, from Digitraffic's live-trains
// API (`rata.digitraffic.fi/api/v1/live-trains/station/<code>`).
//
// Bottom panel, the crossSection.js / weatherCameras.js pattern: `hidden` is
// removed once at build time and the height-0 / `.open` CSS transition does the
// show/hide. One global instance — a tap in any pane opens the same board.
//
// WALL-CLOCK, NOT CLOCK-COUPLED. Every other data layer here follows the
// animation cursor; this one deliberately does not. A departure board is about
// what is *about to* happen, and the API has no per-frame equivalent to snap to
// — scrubbing the radar back an hour cannot un-depart a train. It polls instead,
// so estimates stay current while the panel is open.
//
// Server contract notes (measured against the live API on 2026-08-04):
//   * gzip is MANDATORY, as everywhere on Digitraffic — a request without
//     `Accept-Encoding: gzip` is answered HTTP 406. `fetch` always sends it;
//   * each train carries its ENTIRE timetable, not just this station: a
//     Tampere-Helsinki commuter run came back with 96 rows. The station's own
//     rows have to be picked out, and the origin/destination read off the ends;
//   * every stop appears TWICE, as an ARRIVAL row and a DEPARTURE row, with the
//     same scheduledTime at a through station. Filtering by `type` is what
//     separates the two boards;
//   * `commercialStop: true` marks the stops a passenger can use — it is absent
//     on the technical rows (passing loops, timing points), 168 of 292 rows in
//     the sample. Origin and destination therefore come from the first and last
//     COMMERCIAL rows, not the first and last rows;
//   * `trainCategory` is `Commuter`, `Long-distance` or `Shunting`. Shunting
//     runs are empty stock moves to the depot — a live sample offered two
//     Helsinki->Ilmala W-trains that would have appeared on the board as
//     departures to a place no passenger can go. They are dropped;
//   * the estimate lives in `liveEstimateTime` on stops still ahead and
//     `actualTime` on stops already made, so the board reads whichever exists;
//   * a 120-minute window costs ~33 kB at Helsinki, the busiest station in the
//     country, and 12 kB at 60 minutes. Quiet stations return a handful of
//     trains over the same window, which is simply the service they have.

const API = 'https://rata.digitraffic.fi/api/v1/live-trains/station';

// How far the board looks: two hours forward, so a rural station with an hourly
// service still fills it, and a few minutes back so a train that has just left
// is still shown.
//
// The API's parameter names are relative to the EVENT, not to now, and read
// backwards from the obvious: `minutes_before_departure` means "minutes before
// the departure happens", i.e. how far AHEAD to look, while
// `minutes_after_departure` means "minutes after it departed", i.e. how far
// BACK. Measured at 01:18 local: `minutes_before_departure=60` returned a
// departure +33 min in the future, `minutes_after_departure=60` returned six
// between -49 and -21 min in the past. Getting this the wrong way round fills
// the board with trains that left hours ago, so the constants are named for
// what they do rather than for the parameters they feed.
// The board asks for a COUNT of trains, not a time window. The API's
// `minutes_before_departure` family is the wrong tool here: a window wide enough
// for the night is wasteful by day and a narrow one empties out after the last
// evening train. Measured at 01:35 at Helsinki, two hours held exactly ONE
// departure, and widening to twelve hours cost 118 kB because every train
// arrives with its whole timetable attached. `departing_trains=N` simply returns
// the next N whenever they run — 12 of them at 21.5 kB on the same night,
// reaching 3.5 hours ahead into the morning service without being asked to.
//
// Asked slightly above what the panel can show, so the board still fills after
// shunting runs and trains terminating here are dropped.
const REQUEST_TRAINS = 15;

// How far back a train may be and still belong on the board — long enough that
// one which has just pulled out, or is late and still boarding, stays visible.
const PAST_TOLERANCE_MS = 15 * 60 * 1000;

// Estimates move while the panel sits open; the schedule itself does not.
const REFRESH_MS = 30000;

// A bound on how much DOM one board can build. What is actually shown is
// decided by the panel: rows are trimmed until the table fits, so the board
// never scrolls and never leaves a half-row clipped at the bottom. This only
// keeps a twelve-hour window at a busy station from constructing hundreds of
// rows to throw most of them away.
const MAX_ROWS = 40;

const timeText = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleTimeString('fi', { hour: '2-digit', minute: '2-digit' })
    : '';
};

// The "Juna" column. Commuter services are known by their line letter (R, K, P)
// and nothing else; everything else by type and number, the way a timetable
// prints it ("IC 45").
export function trainLabel(train) {
  if (train.commuterLineID) return train.commuterLineID;
  return `${train.trainType || ''} ${train.trainNumber || ''}`.trim();
}

// Pull one station's board out of the API's full-timetable payload. Pure, so the
// contract above can be checked against live data without a browser.
export function boardRows(trains, stationCode, mode, nowMs = Date.now()) {
  const wantType = mode === 'arrivals' ? 'ARRIVAL' : 'DEPARTURE';
  // `departed_trains`/`arrived_trains` return the last N to have left, however
  // long ago that was — at Rovaniemi, measured, 415 minutes. Unfiltered they
  // sort to the top of the board and push the trains someone is actually
  // waiting for off the bottom.
  const floor = nowMs - PAST_TOLERANCE_MS;
  const rows = [];
  (trains || []).forEach((train) => {
    // Empty stock moves to and from the depot are not services.
    if (train.trainCategory === 'Shunting') return;
    const all = train.timeTableRows || [];
    const commercial = all.filter((r) => r.commercialStop === true);
    if (!commercial.length) return;
    const here = commercial.find(
      (r) => r.stationShortCode === stationCode && r.type === wantType,
    );
    if (!here) return;
    // Origin and destination are the ends of the commercial run, so a train that
    // starts or terminates in a depot still shows the station a passenger cares
    // about.
    const endpoint = mode === 'arrivals'
      ? commercial[0].stationShortCode
      : commercial[commercial.length - 1].stationShortCode;
    // A train terminating here has no onward destination to show, and one
    // starting here has no origin — the endpoint would just repeat the station.
    if (endpoint === stationCode) return;
    const scheduledMs = Date.parse(here.scheduledTime);
    if (!Number.isFinite(scheduledMs)) return;
    const estimateMs = Date.parse(here.liveEstimateTime || here.actualTime) || null;
    // A train 20 minutes down but estimated for now is still standing at the
    // platform, so the later of the two decides whether it is past.
    if (Math.max(scheduledMs, estimateMs || 0) < floor) return;
    rows.push({
      label: trainLabel(train),
      // Commuter services are shown as their line letter in a disc, the way the
      // network's own signage and maps present them; everything else stays
      // plain text ("IC 45", "PYO 273").
      commuter: !!train.commuterLineID,
      scheduledMs,
      // liveEstimateTime for stops still ahead, actualTime once made.
      estimateMs,
      lateMinutes: Number.isFinite(here.differenceInMinutes) ? here.differenceInMinutes : 0,
      track: here.commercialTrack || '',
      endpoint,
      cancelled: !!(train.cancelled || here.cancelled),
    });
  });
  rows.sort((a, b) => a.scheduledMs - b.scheduledMs);
  return rows.slice(0, MAX_ROWS);
}

export default function initTrains({ container, stationsUrl } = {}) {
  // shortCode -> station name, from the same bundled snapshot the marker layer
  // draws. Fetched once; the browser already has it cached from the layer.
  const names = new Map();
  if (stationsUrl) {
    fetch(stationsUrl)
      .then((res) => res.json())
      .then((json) => {
        (json.features || []).forEach((f) => {
          const p = f.properties || {};
          if (p.s) names.set(p.s, p.n || p.s);
        });
        render();
      })
      .catch(() => { /* codes are a fine fallback */ });
  }
  const stationName = (code) => names.get(code) || code;

  let panel = null;
  if (container) {
    container.removeAttribute('hidden');
    container.removeAttribute('aria-hidden');
    container.innerHTML = `
      <div class="train-head">
        <i class="material-icons train-icon" aria-hidden="true">train</i>
        <span class="train-title"></span>
        <select class="train-mode" aria-label="Lähtevät tai saapuvat">
          <option value="departures">Lähtevät</option>
          <option value="arrivals">Saapuvat</option>
        </select>
        <button type="button" class="train-close" aria-label="Sulje aikataulu">
          <i class="material-icons" aria-hidden="true">close</i>
        </button>
      </div>
      <div class="train-body"><table class="train-table"></table></div>
      <div class="train-message" hidden></div>
    `;
    panel = {
      el: container,
      title: container.querySelector('.train-title'),
      mode: container.querySelector('.train-mode'),
      body: container.querySelector('.train-body'),
      table: container.querySelector('.train-table'),
      message: container.querySelector('.train-message'),
    };
  }

  let station = null; // { code, name }
  let mode = 'departures';
  let trains = null;
  let timerId = 0;
  // Bumped on every station/mode change so a slow response for the previous
  // one can never paint over the current board.
  let generation = 0;

  function setMessage(text) {
    if (!panel) return;
    panel.message.textContent = text || '';
    panel.message.hidden = !text;
    panel.table.hidden = !!text;
  }

  function render() {
    if (!panel || !station) return;
    if (!trains) return;
    const rows = boardRows(trains, station.code, mode);
    if (!rows.length) {
      setMessage(mode === 'arrivals'
        ? 'Ei saapuvia junia lähitunteina'
        : 'Ei lähteviä junia lähitunteina');
      return;
    }
    setMessage('');
    const endpointHead = mode === 'arrivals' ? 'Lähtöasema' : 'Määräasema';
    const head = `<thead><tr>
        <th>Juna</th><th>Aika</th><th>Arvioitu aika</th><th>Raide</th><th>${endpointHead}</th>
      </tr></thead>`;
    const body = rows.map((r) => {
      const scheduled = timeText(new Date(r.scheduledMs).toISOString());
      const estimated = r.estimateMs ? timeText(new Date(r.estimateMs).toISOString()) : '';
      // An estimate is only worth a column entry when it says something the
      // scheduled time does not. `differenceInMinutes` rounds, so a train 30
      // seconds down reports as 1 minute late while both times still print the
      // same HH.MM — comparing what will actually be shown keeps the board from
      // flagging a delay it cannot display.
      const estimate = r.cancelled
        ? '<span class="train-cancelled">Peruttu</span>'
        : (estimated && estimated !== scheduled
          // Amber means late. A train running ahead of its schedule still shows
          // its estimate, just without the warning colour.
          ? (r.lateMinutes >= 1 ? `<span class="train-late">${estimated}</span>` : estimated)
          : '–');
      const ident = r.commuter
        ? `<span class="train-line">${r.label}</span>`
        : r.label;
      return `<tr${r.cancelled ? ' class="is-cancelled"' : ''}>
        <td class="train-id">${ident}</td>
        <td class="train-time">${scheduled}</td>
        <td class="train-time">${estimate}</td>
        <td class="train-track">${r.track}</td>
        <td class="train-endpoint">${stationName(r.endpoint)}</td>
      </tr>`;
    }).join('');
    panel.table.innerHTML = `${head}<tbody>${body}</tbody>`;
    trimToFit();
  }

  // Show whole rows only. The panel is a fixed height, so a busy station would
  // otherwise leave a row sliced through by the bottom edge — measuring the
  // rendered table and dropping from the end is exact, where a hard row count
  // would have to guess at line height and would be wrong on a phone, in the
  // other theme, or at a different text size.
  function trimToFit() {
    if (!panel) return;
    const tbody = panel.table.tBodies[0];
    if (!tbody) return;
    let guard = MAX_ROWS + 1;
    while (tbody.rows.length > 1
      && panel.table.offsetHeight > panel.body.clientHeight
      && guard > 0) {
      tbody.deleteRow(tbody.rows.length - 1);
      guard -= 1;
    }
  }

  function load() {
    if (!station) return;
    const gen = generation;
    const url = `${API}/${encodeURIComponent(station.code)}`
      + `?departing_trains=${REQUEST_TRAINS}&arriving_trains=${REQUEST_TRAINS}`
      // A couple of just-gone trains so the top of the board is not a train the
      // user watched leave a minute ago.
      + '&departed_trains=2&arrived_trains=2'
      // Drops trains that run through without stopping — they have no platform
      // and no passenger can board them.
      + '&include_nonstopping=false';
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (gen !== generation) return;
        trains = json;
        render();
      })
      .catch((err) => {
        if (gen !== generation) return;
        // Keep whatever is on screen if a refresh fails; only say so when there
        // was never anything to show.
        if (!trains) setMessage('Aikatauluja ei saatu haettua');
        console.warn(`Junatiedot unavailable: ${err}`); // eslint-disable-line no-console
      });
  }

  function stopPolling() {
    if (timerId) clearInterval(timerId);
    timerId = 0;
  }

  function startPolling() {
    stopPolling();
    timerId = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
  }

  function close() {
    if (!panel) return;
    generation += 1;
    stopPolling();
    station = null;
    trains = null;
    panel.el.classList.remove('open');
  }

  if (panel) {
    container.querySelector('.train-close').addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });
    panel.mode.addEventListener('change', () => {
      mode = panel.mode.value;
      // Same payload serves both boards — only the row filter changes.
      render();
    });
  }

  function open(feature) {
    if (!panel) return;
    const code = feature.get('s');
    if (!code) return;
    if (station && station.code === code) return;
    generation += 1;
    station = { code, name: feature.get('n') || code };
    trains = null;
    panel.el.classList.add('open');
    panel.title.textContent = station.name;
    panel.table.innerHTML = '';
    setMessage('Ladataan…');
    load();
    startPolling();
  }

  function attachPane(map, layer) {
    // Hit-test this pane's station layer only, so a tap does not open the board
    // for a camera or a traffic marker under the same pixel.
    function findAtPixel(pixel) {
      if (!layer.getVisible()) return null;
      let hit = null;
      map.forEachFeatureAtPixel(pixel, (f, l) => {
        if (l === layer) { hit = f; return true; }
        return false;
      }, { hitTolerance: 10 });
      return hit;
    }
    return { findAtPixel, open };
  }

  return { attachPane, close };
}
