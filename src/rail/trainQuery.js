// Pure helpers for the live train layer — the trajectoryQuery.js / areaQuery.js
// shape: no OpenLayers, no DOM, no fetch, so the server contract below can be
// checked against the live APIs from a node harness.
//
// Three Digitraffic surfaces feed one layer, because no single one carries
// enough (all measured live on 2026-08-12):
//
//   1. MQTT `wss://rata.digitraffic.fi:443/mqtt`, topic `train-locations/+/+`.
//      The positions, and nothing else: `{trainNumber, departureDate, timestamp,
//      location: GeoJSON Point, speed, accuracy}`. No identity, no type, no
//      destination — a train number and a dot. Measured 607 messages in 20 s
//      across 123 trains (~one fix per train per 4 s), 5 KB/s, connect in
//      440 ms, no credentials.
//   2. GraphQL `currentlyRunningTrains` for everything the topic omits. Asking
//      for whole timetables costs 52 KB on the wire; asking for only the FIRST
//      and LAST commercial stop — `timeTableRows` takes `orderBy`/`take`, so
//      each end is one row — costs 3.5 KB for ~120 trains, delay included.
//   3. REST `/api/v1/train-locations/latest/` (3.1 KB, 153 trains) as a
//      bootstrap, so the layer draws immediately instead of filling in over the
//      first few seconds as each train happens to report.
//
// gzip is mandatory Digitraffic-wide (a request without it is answered HTTP
// 406); `fetch` always sends it. CORS is `*` and `Digitraffic-User` is on the
// allowed-headers list, verified by preflight against both endpoints.

export const MQTT_URL = 'wss://rata.digitraffic.fi:443/mqtt';
export const TOPIC = 'train-locations/+/+';
export const GRAPHQL_URL = 'https://rata.digitraffic.fi/api/v2/graphql/graphql';
export const LATEST_URL = 'https://rata.digitraffic.fi/api/v1/train-locations/latest/';
export const APP_ID = 'tutka.meteo.fi';

// What the layer draws. Deliberately WIDER than the departure board next door,
// which is passenger-only: a board answers "can I board this", so freight has no
// business on it, while a map answers "what is moving out there" and a freight
// train crossing the country under a rain band is exactly as real as an
// InterCity. Measured at midday: 36 Cargo against 36 Long-distance and 34
// Commuter, so excluding it would hide a third of the network.
//
// The three that stay out are not journeys at all: `Shunting` is empty stock
// being moved around a yard, `Locomotive` a light engine running on its own, and
// `On-track machines` maintenance plant. All three cluster at depots, none goes
// anywhere a reader could follow, and together they were 18 of 124 running
// trains.
export const DRAWN_CATEGORIES = new Set(['Commuter', 'Long-distance', 'Cargo']);

// Within `Commuter`, type HV is "line V" — empty stock between Ilmala depot and
// the ends of the lines, carrying no passengers and listed in no public
// timetable. The departure board excludes it for the same reason; see the long
// note in trains.js.
export const NON_PUBLIC_TRAIN_TYPES = new Set(['HV']);

// A train is identified by (first departure date, number), not by number alone —
// overnight services mean two dates are live at once. Measured at 07:00 UTC the
// feed carried both 2026-08-11 and 2026-08-12 trains, so keying on the number
// would have collided them.
export const trainKey = (departureDate, trainNumber) => `${departureDate}/${trainNumber}`;

// Only the first and last COMMERCIAL stop, plus the most recent station actually
// passed. `commercialStop` marks the stops a passenger can use, so the ends of
// that filtered list are the origin and destination a reader recognises rather
// than the depot a service technically starts from.
//
// `last` is the delay source: the newest row with an `actualTime` is the most
// recent station the train really passed, and its `differenceInMinutes` is that
// train's delay right now. Present for 120 of 120 running trains when measured,
// spanning −35 to +48 minutes.
export const METADATA_QUERY = `{
  currentlyRunningTrains {
    trainNumber
    departureDate
    commuterLineid
    trainType { name trainCategory { name } }
    orig: timeTableRows(where: {commercialStop: {equals: true}}, orderBy: {scheduledTime: ASCENDING}, take: 1) {
      station { shortCode }
    }
    dest: timeTableRows(where: {commercialStop: {equals: true}}, orderBy: {scheduledTime: DESCENDING}, take: 1) {
      station { shortCode }
      scheduledTime
    }
    last: timeTableRows(where: {actualTime: {unequals: null}}, orderBy: {actualTime: DESCENDING}, take: 1) {
      station { shortCode }
      differenceInMinutes
    }
  }
}`;

// The "Juna" label, matching the departure board exactly (trains.js
// `trainLabel`): commuter services are known by their line letter and nothing
// else, everything else by type and number the way a timetable prints it.
export function labelFor(train) {
  if (train.commuterLineid) return train.commuterLineid;
  const type = train.trainType && train.trainType.name;
  return `${type || ''} ${train.trainNumber || ''}`.trim();
}

export function isDrawable(train) {
  const category = train.trainType
    && train.trainType.trainCategory
    && train.trainType.trainCategory.name;
  if (!DRAWN_CATEGORIES.has(category)) return false;
  return !NON_PUBLIC_TRAIN_TYPES.has(train.trainType.name);
}

// Which of the three marker treatments a train gets. Category rather than type,
// because type is a long tail (15 distinct types among 124 running trains) and
// nothing on a map needs to tell PYO from IC.
export function kindOf(train) {
  const category = train.trainType.trainCategory.name;
  if (category === 'Commuter') return 'commuter';
  if (category === 'Cargo') return 'cargo';
  return 'longdistance';
}

// GraphQL response -> Map(key -> what the layer needs). Trains that should not
// be drawn are dropped HERE rather than at render time, which makes the map the
// single answer to "is this train ours": a position whose key is absent is
// either filtered out or not yet known, and both mean "do not draw".
export function parseMetadata(json) {
  const out = new Map();
  const trains = json && json.data && json.data.currentlyRunningTrains;
  if (!Array.isArray(trains)) return out;
  const usable = trains.filter(
    (t) => t && t.trainType && t.trainType.trainCategory && isDrawable(t),
  );
  for (const train of usable) {
    const orig = train.orig && train.orig[0];
    const dest = train.dest && train.dest[0];
    const last = train.last && train.last[0];
    out.set(trainKey(train.departureDate, train.trainNumber), {
      label: labelFor(train),
      kind: kindOf(train),
      originCode: (orig && orig.station && orig.station.shortCode) || null,
      destinationCode: (dest && dest.station && dest.station.shortCode) || null,
      // Null rather than 0 when unknown: 0 means "on time", which is a claim.
      delayMinutes: last && Number.isFinite(last.differenceInMinutes)
        ? last.differenceInMinutes : null,
    });
  }
  return out;
}

// One MQTT payload (or one entry of the REST bootstrap, which is the same
// shape) -> a normalised fix, or null if it is unusable. Both sources are
// validated the same way because both are parsed the same way.
export function parseLocation(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const coords = payload.location && payload.location.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lon, lat] = coords;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  if (payload.trainNumber == null || !payload.departureDate) return null;
  const atMs = Date.parse(payload.timestamp);
  return {
    key: trainKey(payload.departureDate, payload.trainNumber),
    trainNumber: payload.trainNumber,
    lon,
    lat,
    speed: Number.isFinite(payload.speed) ? payload.speed : null,
    accuracy: Number.isFinite(payload.accuracy) ? payload.accuracy : null,
    atMs: Number.isFinite(atMs) ? atMs : Date.now(),
  };
}

// Direction of travel, which the feed does not carry — a train's heading has to
// come from where it has been. Computed from PROJECTED (Web Mercator)
// coordinates on purpose: Mercator is conformal and its meridians are vertical,
// so the angle from north measured on the projected plane IS the true bearing.
// That is the projection's whole reason for existing.
//
// Returns null below `minMetres` of travel. A train standing at a platform still
// reports, and its GPS wanders a few metres between fixes; without a floor the
// arrow would spin while the train sat still.
export function bearingBetween(from, to, minMetres = 20) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  // Web Mercator metres are inflated by 1/cos(latitude); at 60°N a "metre" is
  // about half a real one, so the floor is corrected rather than applied to raw
  // projected units, which would make it twice as strict in Lapland as at sea.
  const scale = Math.cos(2 * Math.atan(Math.exp(to[1] / 6378137)) - Math.PI / 2);
  if (Math.hypot(dx, dy) * scale < minMetres) return null;
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// Delay for the telemetry strip. Late is the case worth colouring — early is
// common on freight and interesting to nobody — so only lateness gets a tone.
export function formatDelay(minutes) {
  if (!Number.isFinite(minutes)) return { value: '–' };
  if (minutes === 0) return { value: 'ajallaan' };
  if (minutes > 0) {
    return { value: `+${minutes}\u2009min`, tone: minutes >= 5 ? 'down' : 'warn' };
  }
  return { value: `−${Math.abs(minutes)}\u2009min` };
}
