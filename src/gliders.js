// Live aircraft from the Open Glider Network, via the meteo.fi OGN bridge
// (`wss://ogn.app.meteo.fi/ogn/v1`). Mostly gliders — OGN is the gliding
// community's own receiver network — but the feed also carries tow planes,
// paragliders and any other FLARM/OGN-equipped traffic in range.
//
// The bridge exists because OGN publishes over APRS-IS, raw TCP on port 14580,
// which no browser can open. It connects upstream once, decodes the beacons,
// honours the opt-outs (see PRIVACY below) and re-publishes JSON over WebSocket.
//
// Cross-pane pattern (placeNames / stormCells / trafficMessages): ONE shared
// VectorSource, one VectorLayer per pane through the paneDeps factory, so split
// screen costs no extra connection.
//
// WALL-CLOCK, NOT CLOCK-COUPLED, like the AIS own-vessel marker and unlike every
// data layer in this app. There is no history to scrub: the bridge holds current
// positions only, and no radar frame can un-fly an aircraft. setTime therefore
// does not route here.
//
// Bridge contract (verified live 2026-08-06):
//   * `{"type":"subscribe","bbox":[minLon,minLat,maxLon,maxLat]}` on connect —
//     LON FIRST. Verified by membership: the full region returned 22 aircraft all
//     inside it, Finland 2, Norway/Sweden 19, a box over Helsinki 0;
//   * server replies `snapshot` (full state for the bbox), then `update` about
//     once a second carrying changed `aircraft` and departed ids in `gone`, plus
//     `heartbeat` when otherwise idle;
//   * SI units throughout — metres, m/s, degrees true — already converted from
//     the knots/feet/fpm that APRS carries;
//   * `reg`/`cn`/`model` are null unless the OGN device database says the pilot
//     accepts being identified; aircraft whose owners opted out of tracking never
//     reach us at all. Nothing here tries to re-identify an anonymous id, and the
//     id itself is salted server-side for randomly-addressed devices;
//   * the bridge is bounded to its own `OGN_REGION_BBOX`, which has grown
//     westward and south since this was written and now reaches the
//     Mediterranean — the client box below is kept level with it, and the
//     bridge clamps anything wider. The whole region is a couple of dozen
//     aircraft at night and a few hundred on a good soaring day (586 at
//     midday on 2026-08-21).
//
// This layer subscribes to that whole region once rather than to the map view:
// the payload is small enough that re-subscribing on every pan would cost more
// than it saves, and aircraft outside the viewport simply do not draw.

import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { fromLonLat } from 'ol/proj';
import {
  Circle as CircleStyle, Fill, RegularShape, Stroke, Style, Text,
} from 'ol/style';

// Whether the aircraft could have flown a leg. Eastern Finland sees sustained
// GPS jamming, and a jammed receiver does not go quiet — it reports confidently
// from somewhere else entirely, which drawn without question rules a line
// across the country and back. Thresholds and the reasoning are in the module.
import { isPlausibleLeg, trailBandIndex } from './gliderTrail';

const WS_URL = 'wss://ogn.app.meteo.fi/ogn/v1';

// The bridge's own region, subscribed to wholesale rather than tracking the map
// view — re-subscribing on every pan would cost a full snapshot each time.
// Drawn on the map as a boundary (see BOUNDS below) so the edge of coverage is
// visible rather than being mistaken for empty sky.
//
// The southern edge follows the bridge's: asking for 40 N returns nothing below
// 43.19 N, so 43.0 is where its own region ends and there is nothing further to
// ask for. Measured 2026-08-21: the box below carries 586 aircraft against 576
// for the previous 45 N floor — the Mediterranean coast and the southern Alps,
// which is soaring country and worth the twelve.
const REGION_BBOX = [3.0, 43.0, 32.0, 71.5];

// Reconnect backoff. The bridge holds one upstream APRS connection for all its
// clients, but a reconnect storm from a browser tab is still rude and pointless.
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60000;

// Drop an aircraft the bridge has stopped mentioning. It sends `gone`, so this
// is only a backstop for a message missed across a reconnect. Generous, because
// a glider circling in a thermal can go a minute between usable fixes.
const STALE_MS = 5 * 60 * 1000;
const SWEEP_MS = 15000;

// A fix older than this is drawn faded. Gliders circling in a thermal
// legitimately go 60-90 s between usable fixes, so this says "position is
// ageing", not "something is wrong".
const FADE_AFTER_MS = 60000;

// Trails are built ONLY from what this browser tab has watched arrive — the
// bridge serves no history and is asked for none. They live in memory, are never
// written anywhere, and die with the layer: switching the POI off or reloading
// starts every aircraft from nothing. That is the point of the bridge's "not an
// archive" rule, and this stays inside it.
//
// Bounded twice over, because an aircraft crossing the region for hours would
// otherwise grow an unbounded line: by age, so a trail describes recent
// behaviour rather than the whole evening, and by point count, so a fast beacon
// rate cannot outrun the age limit.
const TRAIL_MAX_AGE_MS = 20 * 60 * 1000;
const TRAIL_MAX_POINTS = 150;

// Dead-link watchdog. The bridge sends a heartbeat every 20 s when nothing else
// is flowing, so silence this long means the socket is gone without having
// fired `close` — which a sleeping laptop or a dropped mobile connection will
// do. Without this the layer freezes on stale positions and never recovers.
const SILENCE_TIMEOUT_MS = 50000;

// NO zoom floor, deliberately — unlike the weather cameras, which hide below ~z7
// because 812 fixed markers become a wall at synoptic zoom. Aircraft are the
// opposite problem: a couple of dozen scattered across Fennoscandia, and they
// are somewhere different every day. A floor meant that zooming out to find them
// was exactly what made them disappear, which is how this layer first looked
// broken — Finland was empty for the evening and everything airborne was over
// Sweden, two zoom steps out.

// OGN aircraft types → what to draw and what to call it.
//
// Shape carries the broad family and colour the specific type, so the two are
// readable together at marker size and separately when one of them is hard to
// judge: `tri` soaring, `star` powered, `square` rotor/unmanned, `dot`
// lighter-than-air or unknown. A shape alone cannot carry ten types, and colour
// alone fails for a colour-blind reader.
const TYPES = {
  0: { label: 'Tuntematon', shape: 'dot', color: 'unknown' },
  1: { label: 'Purjekone', shape: 'tri', color: 'glider' },
  2: { label: 'Hinauskone', shape: 'star', color: 'tow' },
  3: { label: 'Helikopteri', shape: 'square', color: 'rotor' },
  4: { label: 'Laskuvarjo', shape: 'dot', color: 'chute' },
  5: { label: 'Pudotuskone', shape: 'star', color: 'tow' },
  6: { label: 'Riippuliidin', shape: 'tri', color: 'soft' },
  7: { label: 'Varjoliidin', shape: 'tri', color: 'soft' },
  8: { label: 'Moottorikone', shape: 'star', color: 'powered' },
  9: { label: 'Suihkukone', shape: 'star', color: 'jet' },
  10: { label: 'Tuntematon', shape: 'dot', color: 'unknown' },
  11: { label: 'Kuumailmapallo', shape: 'dot', color: 'balloon' },
  12: { label: 'Ilmalaiva', shape: 'dot', color: 'balloon' },
  13: { label: 'Miehittämätön', shape: 'square', color: 'uav' },
};
const UNKNOWN_TYPE = TYPES[0];
const typeOf = (code) => TYPES[code] || UNKNOWN_TYPE;

// Same inversion rationale as icaoTextColors in radar.js: the dark basemap needs
// bright marks, the light one darkened and saturated ones, or a purple glider
// over pale ground disappears.
const PALETTES = {
  light: {
    glider: '#7b1fd6',
    soft: '#0f7a4a',
    tow: '#b85c00',
    powered: '#1c4f7c',
    jet: '#00707f',
    rotor: '#8a5a00',
    chute: '#b0246b',
    balloon: '#9a6b00',
    uav: '#b3001b',
    unknown: '#55606b',
    accent: '#0089c4',
    bounds: 'rgba(60,80,100,0.55)',
    boundsText: 'rgba(60,80,100,0.75)',
    halo: 'rgba(255,255,255,0.9)',
    textFill: '#241537',
    textHalo: '#ffffff',
    dataText: 'rgba(36,21,55,0.72)',
  },
  dark: {
    glider: '#c77dff',
    soft: '#4ade80',
    tow: '#ffa033',
    powered: '#7fc4f5',
    jet: '#3fd8e0',
    rotor: '#ffd166',
    chute: '#ff6bb0',
    balloon: '#ffcf70',
    uav: '#ff5a5a',
    unknown: '#9fb3c8',
    accent: '#12bcfa',
    bounds: 'rgba(150,170,190,0.4)',
    boundsText: 'rgba(150,170,190,0.6)',
    halo: 'rgba(0,0,0,0.6)',
    textFill: '#f0e6ff',
    textHalo: '#000000',
    dataText: 'rgba(240,230,255,0.75)',
  },
};

const toRadians = (deg) => (deg * Math.PI) / 180;

// The readout beside a moving aircraft: how fast, how high, and whether it is
// going up or down. Only while it is actually moving — a glider parked on the
// field would otherwise carry two lines of nothing useful, and at any zoom wide
// enough to be interesting most of what is on screen is parked.
//
// Deliberately quiet: unbold, a size below the identity label, and dimmer than
// it. The identity is what you are looking for; this is what you read once you
// have found it.
// The trail fades as it ages, so the eye reads which way the aircraft has been
// going without any arrow to say so — the bright end is where it is now.
//
// Four bands rather than a per-segment gradient. OpenLayers strokes a whole
// geometry in one colour, so a true gradient would mean one Style per segment,
// and a trail runs to 150 points. Four is enough for the direction to be
// obvious and costs four styles however long the trail is.
//
// Split by AGE rather than by position along the line: an aircraft that sat in
// a thermal and then ran downwind lays points at wildly different spacings, and
// fading by index would make the fast leg look old.
const TRAIL_FADE_ALPHAS = [0.15, 0.3, 0.52, 0.85];

// #rrggbb -> rgba(). The trail colours are the palette's per-type hexes.
function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  /* eslint-disable no-bitwise */
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  /* eslint-enable no-bitwise */
}

const READOUT_MIN_KMH = 1;
// Drawn only from about z9 in — the band at which this app shows detail
// elsewhere too (railway and aerodrome names appear at the same resolution).
//
// Below that it is not drawn AT ALL, and above it it is never thinned away.
// Decluttering was the obvious way to keep a crowded sky readable and it was
// the wrong one: with several aircraft near each other almost every readout
// lost, so the numbers were mostly absent exactly where someone had zoomed in
// to read them. Better to answer the question "is there room for this on screen"
// with the zoom, once, than per label and unpredictably.
const READOUT_MAX_RESOLUTION = 320;
// The same threshold the telemetry strip uses to call a climb meaningful. Below
// it an arrow would be claiming a trend out of noise.
const READOUT_CLIMB_MS = 0.5;

// Two lines, or one if the altitude is missing. Returns '' when there is
// nothing worth drawing, which is also the signal not to draw it.
export function readoutFor({ speed, alt, climb }) {
  const kmh = Number.isFinite(speed) ? speed * 3.6 : null;
  if (kmh === null || kmh < READOUT_MIN_KMH) return '';
  const lines = [`${Math.round(kmh)} km/h`];
  if (Number.isFinite(alt)) {
    // Filled triangles, not arrows: at 10px an arrowhead is a few pixels of
    // diagonal stroke and reads as a smudge that could be pointing either way.
    // A solid triangle is unambiguous at any size that renders it at all.
    const trend = Number.isFinite(climb) && Math.abs(climb) >= READOUT_CLIMB_MS
      ? ` ${climb > 0 ? '\u25B2' : '\u25BC'}` : '';
    lines.push(`${Math.round(alt)} m${trend}`);
  }
  return lines.join('\n');
}

const RANKS = { bounds: 0, trail: 1 };
const rank = (feature) => (RANKS[feature.get('kind')] ?? 2);

export default function initGliders({ telemetry } = {}) {
  const source = new VectorSource({
    attributions: 'Lentokoneet © <a href="https://www.glidernet.org/">Open Glider Network</a>',
  });

  // The subscription boundary, drawn so the edge of coverage reads as an edge.
  // A lon/lat box maps to an exact rectangle in Web Mercator — meridians are
  // vertical and parallels horizontal — so four corners need no densifying.
  const boundsFeature = new Feature({
    geometry: new LineString([
      [REGION_BBOX[0], REGION_BBOX[1]], [REGION_BBOX[2], REGION_BBOX[1]],
      [REGION_BBOX[2], REGION_BBOX[3]], [REGION_BBOX[0], REGION_BBOX[3]],
      [REGION_BBOX[0], REGION_BBOX[1]],
    ].map((c) => fromLonLat(c))),
  });
  boundsFeature.set('kind', 'bounds', true);

  const features = new Map(); // id -> Feature
  // id -> { geom: LineString, times: number[] } — the observed path, in map
  // coordinates so no reprojection happens per frame.
  const trails = new Map();
  let socket = null;
  let enabled = false;
  let reconnectMs = RECONNECT_MIN_MS;
  let reconnectTimer = 0;
  let sweepTimer = 0;
  let lastFrameMs = 0;

  //
  // DATA
  //
  function upsert(a) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) return;
    // Type 15 is a static object — a ground beacon, not traffic.
    if (a.type === 15) return;
    let feature = features.get(a.id);
    const at = fromLonLat([a.lon, a.lat]);
    if (!feature) {
      feature = new Feature({ geometry: new Point(at) });
      features.set(a.id, feature);
      source.addFeature(feature);
    } else {
      feature.getGeometry().setCoordinates(at);
    }
    const fixMs = Number.isFinite(a.t) ? a.t : Date.now();
    extendTrail(a.id, at, fixMs, a.type);
    feature.setProperties({
      id: a.id,
      // Competition number first: it is what a glider is called on the radio and
      // is shorter than the registration. Registration otherwise, and nothing at
      // all when the pilot has not accepted being identified.
      label: a.cn || a.reg || '',
      reg: a.reg || null,
      model: a.model || null,
      alt: Number.isFinite(a.alt) ? a.alt : null,
      climb: Number.isFinite(a.climb) ? a.climb : null,
      speed: Number.isFinite(a.speed) ? a.speed : null,
      track: Number.isFinite(a.track) ? a.track : null,
      typeCode: a.type,
      typeLabel: typeOf(a.type).label,
      // The FIX time, not arrival time — what the staleness fade reads.
      fixMs,
      seenMs: Date.now(),
    }, true);
    feature.changed();
  }

  function remove(id) {
    const feature = features.get(id);
    if (!feature) return;
    source.removeFeature(feature);
    features.delete(id);
    const trail = trails.get(id);
    if (trail && trail.inSource) source.removeFeature(trail.feature);
    trails.delete(id);
  }

  function clearAll() {
    source.clear(true);
    features.clear();
    trails.clear();
    // source.clear() takes the boundary with everything else, but it belongs to
    // the layer rather than to the data — a snapshot must not blink it out.
    if (enabled) source.addFeature(boundsFeature);
  }

  // Append to the observed path, dropping whatever has aged out. Called once per
  // beacon, so the trail grows at the rate the aircraft actually reports.
  // The path lives on its OWN feature, whose geometry IS the line. Hanging it
  // off the aircraft's style with setGeometry looked equivalent but was not:
  // OpenLayers culls by the FEATURE's geometry, so an aircraft that left the
  // viewport took its still-visible trail with it.
  function extendTrail(id, at, fixMs, typeCode) {
    let trail = trails.get(id);
    if (!trail) {
      const geom = new LineString([at]);
      const feature = new Feature({ geometry: geom });
      feature.set('kind', 'trail', true);
      feature.set('typeCode', typeCode, true);
      trail = { geom, times: [fixMs], feature };
      // The same array the trail keeps, not a copy: it is mutated in place by
      // push and splice, so the style function always sees current times.
      feature.set('times', trail.times, true);
      trails.set(id, trail);
      // Not added to the source until there are two points — a one-point line
      // draws nothing and would only cost a hit-test candidate.
      return trail;
    }
    const coords = trail.geom.getCoordinates();
    const last = coords[coords.length - 1];
    // A stationary aircraft still beacons; repeating a point would inflate the
    // trail without drawing anything.
    if (last && last[0] === at[0] && last[1] === at[1]) return trail;
    // A leg the aircraft could not have flown is not drawn. The mark still moves
    // to the reported position — that is what the feed says, and this layer does
    // not get to decide an aircraft is somewhere else — but the path it leaves
    // behind stays a path rather than a scribble.
    if (last && !isPlausibleLeg(last, trail.times[trail.times.length - 1], at, fixMs)) {
      return trail;
    }
    coords.push(at);
    trail.times.push(fixMs);
    const floor = Date.now() - TRAIL_MAX_AGE_MS;
    let cut = 0;
    while (cut < trail.times.length - 1 && trail.times[cut] < floor) cut += 1;
    const over = Math.max(0, (coords.length - cut) - TRAIL_MAX_POINTS);
    cut += over;
    if (cut > 0) {
      coords.splice(0, cut);
      trail.times.splice(0, cut);
    }
    trail.geom.setCoordinates(coords);
    if (coords.length > 1 && !trail.inSource) {
      source.addFeature(trail.feature);
      trail.inSource = true;
    }
    return trail;
  }

  function handle(msg) {
    // ANY frame counts as liveness, heartbeats included — that is what they are
    // for.
    lastFrameMs = Date.now();
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'snapshot') {
      // A full reset in effect: nothing survives that the snapshot does not
      // mention. Ids are regenerated when the bridge restarts, so after one of
      // those nothing matches and every trail starts fresh — which is correct.
      // But a snapshot also arrives after mere congestion, where the ids are
      // unchanged, and blanket-clearing there would throw away minutes of
      // observed path for no reason. So drop by absence rather than wholesale.
      const keep = new Set((msg.aircraft || []).map((a) => a.id));
      for (const id of [...features.keys()]) if (!keep.has(id)) remove(id);
      (msg.aircraft || []).forEach(upsert);
      return;
    }
    if (msg.type === 'update') {
      (msg.aircraft || []).forEach(upsert);
      (msg.gone || []).forEach(remove);
    }
    syncSelection();
    // `heartbeat` needs no handling — its arrival is the point.
  }

  function sweep() {
    const now = Date.now();
    const floor = now - STALE_MS;
    for (const [id, feature] of [...features.entries()]) {
      if ((feature.get('seenMs') || 0) < floor) remove(id);
    }
    // The fade is a function of elapsed time, not of incoming data, so ageing
    // marks need a repaint even when nothing arrives.
    source.changed();
    // Watchdog: a socket can die without firing `close`, and then nothing would
    // ever reconnect. Silence past the heartbeat interval means force it.
    if (socket && lastFrameMs && now - lastFrameMs > SILENCE_TIMEOUT_MS) {
      const ws = socket;
      socket = null;
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      try { ws.close(); } catch (err) { /* already gone */ }
      scheduleReconnect();
    }
  }

  function connect() {
    if (!enabled || socket) return;
    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      reconnectMs = RECONNECT_MIN_MS;
      ws.send(JSON.stringify({ type: 'subscribe', bbox: REGION_BBOX }));
    };
    ws.onmessage = (event) => {
      try {
        handle(JSON.parse(event.data));
      } catch (err) { /* a malformed frame must not kill the socket */ }
    };
    ws.onerror = () => { /* onclose always follows; handle it there */ };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      if (enabled) scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (!enabled || reconnectTimer) return;
    // Jitter so several tabs coming back from sleep do not retry in lockstep.
    const wait = reconnectMs * (0.8 + Math.random() * 0.4);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = 0;
      connect();
    }, wait);
    reconnectMs = Math.min(reconnectMs * 2, RECONNECT_MAX_MS);
  }

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    if (socket) {
      const ws = socket;
      socket = null;
      // Drop the handlers first: closing fires onclose, which would otherwise
      // schedule a reconnect for a layer the user has just switched off.
      ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null;
      try { ws.close(); } catch (err) { /* already gone */ }
    }
    clearAll();
  }

  // A backgrounded tab keeps the socket but stops mattering; on return the
  // snapshot after a reconnect resynchronises everything anyway.
  document.addEventListener('visibilitychange', () => {
    if (!enabled || document.visibilityState !== 'visible') return;
    if (!socket) { reconnectMs = RECONNECT_MIN_MS; connect(); }
  });

  //
  // STYLE
  //
  function makeStyleFunction(theme) {
    const palette = PALETTES[theme];
    const cache = new Map();

    // Shape per family, colour per type. `tri` is an acute arrow that reads as a
    // heading even at marker size (the AIS target reasoning); `star` is a
    // four-point mark that suggests wings and tail; `square` and `dot` carry no
    // heading, which is honest for a hovering helicopter or a drifting balloon.
    const SHAPES = {
      tri: {
        points: 3, radius: 7, radius2: 2.5, rotates: true,
      },
      star: {
        points: 4, radius: 7, radius2: 2.2, rotates: true,
      },
      square: {
        points: 4, radius: 5, angle: Math.PI / 4, rotates: false,
      },
      dot: {
        points: 12, radius: 4.5, rotates: false,
      },
    };

    const styles = (typeCode) => {
      const key = String(typeCode);
      let entry = cache.get(key);
      if (!entry) {
        const spec = typeOf(typeCode);
        const color = palette[spec.color] || palette.unknown;
        const shape = SHAPES[spec.shape] || SHAPES.dot;
        entry = {
          rotates: shape.rotates,
          // Thin and translucent: the trail is context for the mark, not a
          // feature competing with the radar underneath it. One style per age
          // band, oldest first — see TRAIL_FADE_ALPHAS.
          trailBands: TRAIL_FADE_ALPHAS.map((alpha) => new Style({
            stroke: new Stroke({ color: withAlpha(color, alpha), width: 1.5, lineCap: 'round' }),
          })),
          // `declutterMode: 'none'` on the mark, for two separate reasons.
          //
          // An aircraft must never be thinned away — it is the data, and a
          // marker that disappears because a neighbour got there first is a
          // plane that looks like it is not flying.
          //
          // And it is why almost no labels were appearing. The mark and the
          // label are separate Style objects, so decluttering treated them as
          // rivals: a label sits 16 px above a 7 px mark, the boxes overlap, and
          // every label lost to its OWN marker before any crowding was even
          // involved. Excluded from decluttering the mark is not an obstacle
          // either, so labels now contend only with other labels.
          mark: new Style({
            image: new RegularShape({
              points: shape.points,
              radius: shape.radius,
              radius2: shape.radius2,
              angle: shape.angle || 0,
              fill: new Fill({ color }),
              stroke: new Stroke({ color: palette.halo, width: 1.5 }),
              rotateWithView: true,
              declutterMode: 'none',
            }),
          }),
          label: new Style({
            text: new Text({
              font: '600 11px Roboto, sans-serif',
              fill: new Fill({ color: palette.textFill }),
              stroke: new Stroke({ color: palette.textHalo, width: 2.5 }),
              offsetY: -16,
            }),
          }),
        };
        cache.set(key, entry);
      }
      return entry;
    };

    // One line per band, rewritten per feature. Times increase along a trail, so
    // a band is always one contiguous run and each can be reused — the renderer
    // consumes a feature's styles before moving to the next.
    const bandLines = TRAIL_FADE_ALPHAS.map(() => new LineString([[0, 0], [0, 0]]));

    const bandOf = (ageMs) => trailBandIndex(ageMs, TRAIL_MAX_AGE_MS, TRAIL_FADE_ALPHAS.length);

    function trailStyles(feature, entry) {
      const coords = feature.getGeometry().getCoordinates();
      const times = feature.get('times');
      const bands = entry.trailBands;
      // Without timestamps there is nothing to fade by; draw it as it was.
      if (!times || times.length !== coords.length || coords.length < 2) {
        return bands[bands.length - 1];
      }
      const newest = times[times.length - 1];
      const out = [];
      let start = 0;
      let band = bandOf(newest - times[0]);
      for (let i = 1; i < coords.length; i += 1) {
        const next = bandOf(newest - times[i]);
        if (next !== band) {
          // The run includes the first point of the following one, so the bands
          // meet rather than leaving a gap at every boundary.
          bandLines[band].setCoordinates(coords.slice(start, i + 1));
          bands[band].setGeometry(bandLines[band]);
          out.push(bands[band]);
          start = i;
          band = next;
        }
      }
      // Reusing the cached styles rather than cloning is safe because times
      // increase along a trail, so a band is one contiguous run and no band is
      // pushed twice for the same feature.
      bandLines[band].setCoordinates(coords.slice(start));
      bands[band].setGeometry(bandLines[band]);
      out.push(bands[band]);
      return out;
    }

    // The selection ring is type-independent: it says "this is the one you
    // picked", which is not a property of the aircraft. declutterMode 'none' for
    // the same reason as the marks — the one aircraft the user deliberately
    // chose must never be the one thinned away.
    const ringHalo = new Style({
      image: new CircleStyle({
        radius: 13,
        fill: null,
        stroke: new Stroke({ color: palette.halo, width: 4.5 }),
        declutterMode: 'none',
      }),
    });
    const ring = new Style({
      image: new CircleStyle({
        radius: 13,
        fill: null,
        stroke: new Stroke({ color: palette.accent, width: 2 }),
        declutterMode: 'none',
      }),
    });

    // Beside the mark rather than above it, where the identity label already
    // sits. Left-aligned off the right shoulder so the numbers line up down the
    // screen when several aircraft are near each other.
    //
    // Zoom decides whether there is room for these, not decluttering — see
    // READOUT_MAX_RESOLUTION.
    const readout = new Style({
      text: new Text({
        font: '10px Roboto, sans-serif',
        textAlign: 'left',
        textBaseline: 'middle',
        offsetX: 11,
        // Never thinned away, like the mark it belongs to: at these zooms the
        // aircraft are far enough apart that overlap is rare, and a readout
        // that appears only sometimes is worse than one that always does.
        declutterMode: 'none',
        fill: new Fill({ color: palette.dataText }),
        stroke: new Stroke({ color: palette.textHalo, width: 2.5 }),
      }),
    });

    // Dim and dashed, repeating its name along the edge: at most zooms only a
    // stretch of one side is on screen, so a single label placed once would
    // usually be somewhere else entirely.
    const bounds = new Style({
      stroke: new Stroke({ color: palette.bounds, width: 1.5, lineDash: [7, 6] }),
      text: new Text({
        text: 'OGN',
        font: '600 10px Roboto, sans-serif',
        placement: 'line',
        repeat: 260,
        textBaseline: 'bottom',
        offsetY: -3,
        fill: new Fill({ color: palette.boundsText }),
        declutterMode: 'none',
      }),
    });

    return (feature, resolution) => {
      if (feature.get('kind') === 'bounds') return bounds;
      const entry = styles(feature.get('typeCode'));
      // The path is a separate feature so it survives its aircraft leaving the
      // viewport; its geometry is the line itself, so nothing is set here.
      if (feature.get('kind') === 'trail') return trailStyles(feature, entry);
      const track = feature.get('track');
      // OL rotates clockwise from north, which is exactly what a track is. Marks
      // that carry no heading are never rotated — spinning a balloon by its
      // drift direction would imply a facing it does not have.
      entry.mark.getImage().setRotation(
        entry.rotates && Number.isFinite(track) ? toRadians(track) : 0,
      );
      // Fade an ageing fix rather than dropping it: a glider thermalling can go
      // over a minute between beacons, and a mark that vanishes and returns
      // reads worse than one that dims.
      const stale = Date.now() - (feature.get('fixMs') || 0) > FADE_AFTER_MS;
      entry.mark.getImage().setOpacity(stale ? 0.45 : 1);
      const out = [];
      // Drawn under the mark, so the aircraft's own shape and colour still read
      // through — the ring adds selection, it does not replace identity.
      if (feature.get('selected')) out.push(ringHalo, ring);
      out.push(entry.mark);
      const label = feature.get('label');
      if (label) {
        entry.label.getText().setText(label);
        out.push(entry.label);
      }
      const numbers = resolution > READOUT_MAX_RESOLUTION ? '' : readoutFor({
        speed: feature.get('speed'),
        alt: feature.get('alt'),
        climb: feature.get('climb'),
      });
      if (numbers) {
        readout.getText().setText(numbers);
        out.push(readout);
      }
      return out;
    };
  }

  const styleLight = makeStyleFunction('light');
  const styleDark = makeStyleFunction('dark');

  //
  //
  // SELECTION → TELEMETRY STRIP
  //
  // The strip replaced an overlay card pinned to the aircraft. The subject moves:
  // a pinned card drifted across the map, needed repositioning on every update,
  // and slid off screen exactly when its numbers mattered. A fixed strip stays
  // where the eye last found it. It is also shared — the AIS vessel and the
  // device's own position are meant to drive the same panel — so this module
  // owns only the aircraft-shaped decisions: which readings, in which units,
  // and what an absent one should say.
  const OWNER = 'gliders';
  let selectedId = null;

  const one = (v, unit, digits = 0) => (Number.isFinite(v) ? `${v.toFixed(digits)}\u2009${unit}` : '–');

  function payloadFor(feature) {
    const label = feature.get('label');
    const typeLabel = feature.get('typeLabel');
    const reg = feature.get('reg');
    const model = feature.get('model');
    const climb = feature.get('climb');
    const speed = feature.get('speed');
    // Beacons legitimately arrive over a minute apart, so how old the fix is has
    // to be stated rather than implied — the same reading the retired card
    // carried as "Havaittu", in the same words.
    const ageS = Math.max(0, Math.round((Date.now() - (feature.get('fixMs') || 0)) / 1000));
    return {
      icon: 'airplanemode_active',
      // Anonymous aircraft are named by type, never by id — the pilot opted out
      // of being identified and the strip must not undo that.
      title: label || typeLabel || 'Lentokone',
      subtitle: [label ? typeLabel : '', reg && reg !== label ? reg : '', model]
        .filter(Boolean).join(' · '),
      status: ageS < 60 ? `${ageS} s sitten` : `${Math.round(ageS / 60)} min sitten`,
      metrics: [
        { label: 'Nopeus', value: one(Number.isFinite(speed) ? speed * 3.6 : null, 'km/h') },
        { label: 'Suunta', value: one(feature.get('track'), '°') },
        { label: 'Korkeus', value: one(feature.get('alt'), 'm') },
        {
          label: 'Pysty',
          // The sign is the reading for a glider — whether it is climbing in a
          // thermal or sinking between them — so it is kept explicit and
          // coloured rather than left to be inferred from a minus sign.
          value: Number.isFinite(climb)
            ? `${climb > 0 ? '+' : ''}${climb.toFixed(1)}\u2009m/s` : '–',
          tone: Number.isFinite(climb) && Math.abs(climb) >= 0.5
            ? (climb > 0 ? 'up' : 'down') : undefined,
        },
      ],
    };
  }

  function markSelected(id) {
    if (selectedId === id) return;
    const previous = selectedId !== null && features.get(selectedId);
    if (previous) previous.set('selected', false);
    selectedId = id;
    const next = id !== null && features.get(id);
    if (next) next.set('selected', true);
  }

  function clearSelection() {
    markSelected(null);
  }

  function selectFeature(feature) {
    markSelected(feature.get('id'));
    telemetry.open(OWNER, payloadFor(feature), clearSelection);
  }

  // Called on every message: the subject is moving, so its numbers go stale
  // between updates, and an aircraft that goes away must take the strip with it.
  function syncSelection() {
    if (selectedId === null) return;
    // The panel is shared. If it has been closed, or another source has taken it
    // over, the ring has to go with it — otherwise the map keeps claiming a
    // selection the user can no longer see the readings for.
    if (!telemetry.ownerIs(OWNER)) { clearSelection(); return; }
    const feature = features.get(selectedId);
    if (!feature) {
      clearSelection();
      telemetry.close(OWNER);
      return;
    }
    telemetry.update(OWNER, payloadFor(feature));
  }

  function attachPane(map, layer) {
    function findAtPixel(pixel) {
      if (!layer.getVisible()) return null;
      let hit = null;
      map.forEachFeatureAtPixel(pixel, (f, l) => {
        // Only aircraft are tappable. Trails and the boundary share the layer
        // but carry no readings, and both are big line targets that would
        // otherwise swallow taps meant for the marks.
        if (l === layer && !f.get('kind')) { hit = f; return true; }
        return false;
      }, { hitTolerance: 10 });
      return hit;
    }
    return { findAtPixel, open: selectFeature };
  }

  return {
    styleLight,
    styleDark,
    attachPane,

    // Pane factory for paneDeps. Starts hidden and on the light style; POI
    // visibility and setMapLayer take over immediately after pane creation.
    createPaneLayer() {
      return new VectorLayer({
        source,
        visible: false,
        // Own group so aircraft labels never knock out place names.
        declutter: 'gliders',
        // Boundary, then trails, then aircraft — each on top of the last.
        renderOrder: (a, b) => rank(a) - rank(b),
        // Positions move continuously; repaint during pan/zoom so the marks do
        // not lag the map under the finger.
        updateWhileAnimating: true,
        updateWhileInteracting: true,
        style: styleLight,
      });
    },

    // Called from the POI toggle: the socket only exists while the layer is on.
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (!on) {
        if (sweepTimer) clearInterval(sweepTimer);
        sweepTimer = 0;
        disconnect();
        return;
      }
      reconnectMs = RECONNECT_MIN_MS;
      source.addFeature(boundsFeature);
      connect();
      sweepTimer = setInterval(sweep, SWEEP_MS);
    },
  };
}
