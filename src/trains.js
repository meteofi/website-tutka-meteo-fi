// Departure board for a tapped railway station, from Digitraffic's rail GraphQL
// API (`rata.digitraffic.fi/api/v2/graphql/graphql`).
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
// WHY GRAPHQL AND NOT THE REST live-trains API. The board needs three rows per
// train — the stop here, and the two ends of the run — but REST answers with
// each train's ENTIRE timetable (a Tampere-Helsinki commuter run is 96 rows) and
// there is no way to ask it for less. GraphQL's `timeTableRows` takes
// `where`/`orderBy`/`take`, so each of those three is one row fetched by name.
// Measured over six stations on 2026-08-12: 3151 kB of JSON against 58 kB, a
// 54x reduction — 92x at Oulu, 138x at Rovaniemi, where long runs make REST
// worst. This board polls every 30 s while open, so that is per refresh.
//
// Server contract notes (measured against the live APIs, 2026-08-04/2026-08-12):
//   * gzip is MANDATORY, as everywhere on Digitraffic — a request without
//     `Accept-Encoding: gzip` is answered HTTP 406. `fetch` always sends it;
//   * `trainsByStationAndQuantity` takes the same next-N arguments as the REST
//     endpoint, PLUS `trainCategories`, which filters server-side. That is not
//     only smaller: the next-15 slots stop being spent on freight the board
//     would throw away, so the same request reaches further into the timetable.
//     At Tampere it returned every passenger train REST did and two more;
//   * every stop appears TWICE, as an ARRIVAL row and a DEPARTURE row, with the
//     same scheduledTime at a through station. One fetch still serves both
//     boards — only the row filter changes;
//   * `commercialStop: true` marks the stops a passenger can use — it is absent
//     on the technical rows (passing loops, timing points), 168 of 292 rows in
//     an earlier sample. Origin and destination are therefore the first and last
//     COMMERCIAL rows, which is what the `orig`/`dest` slices ask for;
//   * `trainCategory` is `Commuter`, `Long-distance`, `Cargo`, `Shunting`,
//     `Locomotive` or `On-track machines`. Shunting runs are empty stock moves
//     to the depot — a live sample offered two Helsinki->Ilmala W-trains that
//     would have appeared on the board as departures to a place no passenger can
//     go. Everything but the two passenger categories is dropped;
//   * the estimate lives in `liveEstimateTime` on stops still ahead and
//     `actualTime` on stops already made, so the board reads whichever exists;
//   * introspection is rate-limited by shape: more than one `__type` in a single
//     query is rejected as `BadFaithIntrospection`. Ask for one at a time.

const GRAPHQL_URL = 'https://rata.digitraffic.fi/api/v2/graphql/graphql';
const APP_ID = 'tutka.meteo.fi';

// The categories a passenger can actually board, sent to the server so the
// next-N slots are spent on trains that can appear on the board. Kept in the
// client filter too (PASSENGER_CATEGORIES below): the server argument is an
// optimisation, not the rule, and the board must not depend on it holding.
const BOARD_CATEGORIES = ['Commuter', 'Long-distance'];

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
// the trains terminating here are dropped. Freight and shunting no longer eat
// into this count — `trainCategories` keeps them out server-side — so the same
// 15 now reach further into the timetable than they did over REST.
const REQUEST_TRAINS = 15;

// How far back a train may be and still belong on the board — long enough that
// one which has just pulled out, or is late and still boarding, stays visible.
const PAST_TOLERANCE_MS = 15 * 60 * 1000;

// The categories a passenger can actually board. Everything else the network
// runs — freight, light engines, track machines, empty stock moves — can hold a
// commercial stop on a platform and would otherwise appear as a departure.
const PASSENGER_CATEGORIES = new Set(['Commuter', 'Long-distance']);

// …and the category alone is not enough. Within `Commuter` the network runs two
// train types: `HL`, every real line, and `HV`, which is only ever "line V" —
// empty stock moving between Ilmala depot and the ends of the lines. Measured
// over ten stations: 780 HL against 23 HV, every V train an HV and no HV
// anything but V. They give themselves away by shape, too — 2 commercial stops
// where the thinnest genuine line has 6 and most have 20 to 36, running 22:09
// to 02:38 around the end of service, terminating at stabling points, four of
// them calling at ILR. They carry no passengers and no public timetable lists
// them, so a board must not either.
const NON_PUBLIC_TRAIN_TYPES = new Set(['HV']);

// Kehärata, the ring rail, is Finland's only circular passenger service: lines I
// and P run Helsinki -> airport -> Helsinki in opposite directions, I round by
// Tikkurila and P round by Myyrmäki. Both START AND END at Helsinki, so at
// Helsinki the ends of the run say nothing — the board dropped them, because a
// destination equal to the station you are standing at is normally a train
// terminating here. Measured at Helsinki: 7 of 30 trains in the payload are
// these loops, and 6 of them vanished off the board.
//
// What every Finnish board shows instead — destination Lentoasema, via Tikkurila
// or via Myyrmäki — is HSL's editorial convention and is NOT derivable from the
// API. Checked against the live routes on 2026-08-13, no geometric rule
// reproduces it: the stop farthest from Helsinki is Leinelä, the midpoint by
// both time and index is Aviapolis, and the midpoint of the outbound leg is
// Louhela for P and Malmi for I. None of those is what a passenger is told, and
// the bundled station snapshot carries no notion of which stop matters. So this
// is a table on purpose, not a heuristic that looks principled and is wrong.
//
// Keyed on the commuter line, and applied ONLY to a train whose run begins and
// ends at the station being displayed. Any other loop the network invents later
// keeps the old behaviour of being left off rather than being mislabelled.
const RING_ROUTES = {
  I: { destination: 'LEN', via: 'TKL' },
  P: { destination: 'LEN', via: 'MYR' },
};

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

// The board's query. Pure and deterministic, so it can be diffed against the
// REST payload it replaced without a browser.
//
// Three row slices per train, each one row (or two) rather than the whole
// timetable: `here` is this station's stop — both the ARRIVAL and the DEPARTURE
// row, since one payload serves both boards — and `orig`/`dest` are the ends of
// the COMMERCIAL run, so a train that starts or terminates in a depot still
// shows the station a passenger cares about.
export function stationBoardQuery(stationCode, count = REQUEST_TRAINS) {
  // JSON.stringify rather than bare quotes: station codes come from a bundled
  // snapshot, but a query built by concatenation should not be the thing that
  // trusts it.
  const station = JSON.stringify(String(stationCode));
  const categories = BOARD_CATEGORIES.map((c) => JSON.stringify(c)).join(', ');
  return `{
  trainsByStationAndQuantity(
    station: ${station}
    departingTrains: ${count}
    arrivingTrains: ${count}
    departedTrains: 0
    arrivedTrains: 0
    includeNonStopping: false
    trainCategories: [${categories}]
  ) {
    trainNumber
    commuterLineid
    cancelled
    trainType { name trainCategory { name } }
    here: timeTableRows(
      where: {commercialStop: {equals: true}, station: {shortCode: {equals: ${station}}}}
      orderBy: {scheduledTime: ASCENDING}
    ) {
      type
      scheduledTime
      liveEstimateTime
      actualTime
      differenceInMinutes
      commercialTrack
      cancelled
    }
    orig: timeTableRows(where: {commercialStop: {equals: true}}, orderBy: {scheduledTime: ASCENDING}, take: 1) {
      station { shortCode }
    }
    dest: timeTableRows(where: {commercialStop: {equals: true}}, orderBy: {scheduledTime: DESCENDING}, take: 1) {
      station { shortCode }
    }
  }
}`;
}

// GraphQL response -> the flat shape boardRows reads. Origin and destination
// become plain fields here because the server has already picked them; the
// board no longer walks a timetable looking for its ends.
export function normalizeBoard(json) {
  const trains = json && json.data && json.data.trainsByStationAndQuantity;
  if (!Array.isArray(trains)) return [];
  return trains.map((t) => ({
    trainNumber: t.trainNumber,
    trainType: (t.trainType && t.trainType.name) || '',
    trainCategory: (t.trainType && t.trainType.trainCategory
      && t.trainType.trainCategory.name) || '',
    commuterLineID: t.commuterLineid || '',
    cancelled: !!t.cancelled,
    originCode: (t.orig && t.orig[0] && t.orig[0].station
      && t.orig[0].station.shortCode) || null,
    destinationCode: (t.dest && t.dest[0] && t.dest[0].station
      && t.dest[0].station.shortCode) || null,
    rows: Array.isArray(t.here) ? t.here : [],
  }));
}

// Pull one station's board out of the normalised payload. Pure, so the contract
// above can be checked against live data without a browser.
export function boardRows(trains, stationCode, mode, nowMs = Date.now()) {
  const wantType = mode === 'arrivals' ? 'ARRIVAL' : 'DEPARTURE';
  // Kept as a guard even though the request now asks for no past trains. It is
  // unproven which time the API classifies "departed" by: if it is the SCHEDULED
  // time rather than the actual one, a train sitting late at the platform counts
  // as departed and would arrive here with a past timestamp. A night check found
  // no delayed train anywhere in the country to settle it, so the ordering
  // guarantee is enforced here instead of resting on an assumption.
  //
  // Note this keeps exactly the train that case is about: a service twenty
  // minutes down but estimated for now stays, because the later of scheduled and
  // estimate decides.
  const floor = nowMs - PAST_TOLERANCE_MS;
  const rows = [];
  (trains || []).forEach((train) => {
    // Only what a passenger can board. A whitelist, not a blacklist: an earlier
    // version excluded `Shunting` alone and a daytime scan of six stations found
    // 34 `Cargo` rows on the board — freight with a commercial stop and a
    // platform, advertising departures to places like Patokangas — plus
    // `Locomotive` and `On-track machines`. Any category the network adds later
    // stays off the board until it is deliberately let on.
    if (!PASSENGER_CATEGORIES.has(train.trainCategory)) return;
    if (NON_PUBLIC_TRAIN_TYPES.has(train.trainType)) return;
    // Every row in `rows` is already this station's, and already commercial —
    // the query filtered on both — so the only choice left is which board it
    // belongs to. A train calling here twice yields its earliest matching stop,
    // the row order being ascending by scheduled time.
    const here = (train.rows || []).find((r) => r.type === wantType);
    if (!here) return;
    let endpoint = mode === 'arrivals' ? train.originCode : train.destinationCode;
    let via = '';
    if (!endpoint) return;
    if (endpoint === stationCode) {
      // Either a train terminating here — the endpoint would just repeat the
      // station — or a ring service, which needs the far side of the loop named
      // instead. Only the second is worth showing.
      const ring = train.originCode === train.destinationCode
        && RING_ROUTES[train.commuterLineID];
      if (!ring) return;
      endpoint = ring.destination;
      // The two ring lines are otherwise indistinguishable on a board: both are
      // a train to the airport leaving Helsinki. The via IS the direction.
      via = ring.via;
    }
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
      via,
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
      // Empty when there is nothing to say: a placeholder in every on-time row
      // draws the eye down a column of dashes instead of to the few rows that
      // actually carry a revised time. The tilde marks it as an estimate rather
      // than a second scheduled time.
      let estimate = '';
      if (r.cancelled) {
        estimate = '<span class="train-cancelled">Peruttu</span>';
      } else if (estimated && estimated !== scheduled) {
        const text = `~${estimated}`;
        // Amber means late. A train running ahead of its schedule still shows
        // its estimate, just without the warning colour.
        estimate = r.lateMinutes >= 1 ? `<span class="train-late">${text}</span>` : text;
      }
      const ident = r.commuter
        ? `<span class="train-line">${r.label}</span>`
        : r.label;
      return `<tr${r.cancelled ? ' class="is-cancelled"' : ''}>
        <td class="train-id">${ident}</td>
        <td class="train-time">${scheduled}</td>
        <td class="train-time">${estimate}</td>
        <td class="train-track">${r.track}</td>
        <td class="train-endpoint">${stationName(r.endpoint)}${
  r.via ? `<span class="train-via">via ${stationName(r.via)}</span>` : ''
}</td>
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
    fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Digitraffic asks that clients identify themselves. The preflight this
        // needs is answered with a 24 h max-age, so the 30 s poll pays for it
        // once — and a JSON POST would be preflighted anyway.
        'Digitraffic-User': APP_ID,
      },
      body: JSON.stringify({ query: stationBoardQuery(station.code) }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (gen !== generation) return;
        // GraphQL reports failures in the body with HTTP 200, so a bad query
        // would otherwise silently empty the board rather than say anything.
        if (json && json.errors && json.errors.length) {
          throw new Error(json.errors[0].message || 'GraphQL error');
        }
        trains = normalizeBoard(json);
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

  // `stationName` is shared with the live-train layer (src/trainLocations.js),
  // which needs the same shortCode -> name expansion for the run it shows in the
  // telemetry strip. Exposed rather than duplicated so both read one snapshot.
  return { attachPane, close, stationName };
}
