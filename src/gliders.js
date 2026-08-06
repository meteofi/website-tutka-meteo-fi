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
//   * the bridge is bounded to `OGN_REGION_BBOX` (currently 10,55..42,73 —
//     Fennoscandia and the Baltic), so the whole region is a couple of dozen
//     aircraft at night and a few hundred on a good soaring day.
//
// This layer subscribes to that whole region once rather than to the map view:
// the payload is small enough that re-subscribing on every pan would cost more
// than it saves, and aircraft outside the viewport simply do not draw.

import Feature from 'ol/Feature';
import Overlay from 'ol/Overlay';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { fromLonLat } from 'ol/proj';
import {
  Fill, RegularShape, Stroke, Style, Text,
} from 'ol/style';

const WS_URL = 'wss://ogn.app.meteo.fi/ogn/v1';

// The bridge's own region. Subscribing to it wholesale keeps the client free of
// view-tracking and re-subscribe churn.
const REGION_BBOX = [10, 55, 42, 73];

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
    halo: 'rgba(255,255,255,0.9)',
    textFill: '#241537',
    textHalo: '#ffffff',
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
    halo: 'rgba(0,0,0,0.6)',
    textFill: '#f0e6ff',
    textHalo: '#000000',
  },
};

const toRadians = (deg) => (deg * Math.PI) / 180;

export default function initGliders() {
  const source = new VectorSource({
    attributions: 'Lentokoneet © <a href="https://www.glidernet.org/">Open Glider Network</a>',
  });

  const features = new Map(); // id -> Feature
  const cards = []; // one per pane; each follows whichever aircraft it has open
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
    const trail = extendTrail(a.id, at, fixMs);
    feature.setProperties({
      id: a.id,
      // The line is held on the feature so the style function never rebuilds it.
      trail: trail.geom.getCoordinates().length > 1 ? trail.geom : null,
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
    trails.delete(id);
  }

  function clearAll() {
    source.clear(true);
    features.clear();
    trails.clear();
  }

  // Append to the observed path, dropping whatever has aged out. Called once per
  // beacon, so the trail grows at the rate the aircraft actually reports.
  function extendTrail(id, at, fixMs) {
    let trail = trails.get(id);
    if (!trail) {
      trail = { geom: new LineString([at]), times: [fixMs] };
      trails.set(id, trail);
      return trail;
    }
    const coords = trail.geom.getCoordinates();
    const last = coords[coords.length - 1];
    // A stationary aircraft still beacons; repeating a point would inflate the
    // trail without drawing anything.
    if (last && last[0] === at[0] && last[1] === at[1]) return trail;
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
    cards.forEach((c) => c.sync());
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
          // feature competing with the radar underneath it.
          trail: new Style({
            stroke: new Stroke({ color, width: 1.5, lineCap: 'round' }),
          }),
          mark: new Style({
            image: new RegularShape({
              points: shape.points,
              radius: shape.radius,
              radius2: shape.radius2,
              angle: shape.angle || 0,
              fill: new Fill({ color }),
              stroke: new Stroke({ color: palette.halo, width: 1.5 }),
              rotateWithView: true,
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

    return (feature) => {
      const entry = styles(feature.get('typeCode'));
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
      // Drawn first so the mark sits on top of its own path.
      const trail = feature.get('trail');
      if (trail) {
        entry.trail.setGeometry(trail);
        out.push(entry.trail);
      }
      out.push(entry.mark);
      const label = feature.get('label');
      if (label) {
        entry.label.getText().setText(label);
        out.push(entry.label);
      }
      return out;
    };
  }

  const styleLight = makeStyleFunction('light');
  const styleDark = makeStyleFunction('dark');

  //
  // CARD
  //
  function buildCard() {
    const el = document.createElement('div');
    el.className = 'marker-card aircraft-card';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Lentokone');
    el.innerHTML = `
      <div class="marker-card-head">
        <i class="material-icons marker-card-icon" aria-hidden="true">airplanemode_active</i>
        <span class="marker-card-title"></span>
        <button type="button" class="marker-card-close" aria-label="Sulje">
          <i class="material-icons" aria-hidden="true">close</i>
        </button>
      </div>
      <div class="aircraft-body">
        <div class="aircraft-name"></div>
        <div class="aircraft-model"></div>
        <dl class="aircraft-grid"></dl>
      </div>
    `;
    return el;
  }

  const fmt = (v, unit, digits = 0) => (Number.isFinite(v)
    ? `${v.toFixed(digits)} ${unit}` : '–');

  // One card per pane (the radarSite/trafficMessages pattern): an Overlay
  // belongs to a single map, so a shared card would jump between panes in split
  // screen.
  function attachPane(map, layer) {
    const el = buildCard();
    document.body.appendChild(el);
    const overlay = new Overlay({
      element: el,
      positioning: 'bottom-center',
      offset: [0, -16],
      stopEvent: true,
      autoPan: false, // the subject moves; auto-panning after it would fight the user
    });
    map.addOverlay(overlay);

    const titleEl = el.querySelector('.marker-card-title');
    const nameEl = el.querySelector('.aircraft-name');
    const modelEl = el.querySelector('.aircraft-model');
    const gridEl = el.querySelector('.aircraft-grid');
    let openId = null;

    function hide() {
      openId = null;
      overlay.setPosition(undefined);
    }

    el.querySelector('.marker-card-close').addEventListener('click', (e) => {
      e.stopPropagation();
      hide();
    });

    function paint(feature) {
      const label = feature.get('label');
      const reg = feature.get('reg');
      titleEl.textContent = feature.get('typeLabel') || 'Lentokone';
      // An aircraft with no registration is anonymous by the pilot's explicit
      // choice — it is named by its type, never by its id.
      nameEl.textContent = label || feature.get('typeLabel') || '';
      // The competition number is what a glider is called on the radio; show the
      // registration too when both are known, since they identify differently.
      const model = feature.get('model');
      const sub = [reg && reg !== label ? reg : '', model].filter(Boolean).join(' · ');
      modelEl.textContent = sub;
      modelEl.hidden = !sub;
      const climb = feature.get('climb');
      const speed = feature.get('speed');
      const ageS = Math.max(0, Math.round((Date.now() - (feature.get('fixMs') || 0)) / 1000));
      const rows = [
        ['Korkeus', fmt(feature.get('alt'), 'm')],
        // Vario is the number a glider pilot reads first, and its sign matters,
        // so it keeps an explicit +.
        ['Nousu', Number.isFinite(climb) ? `${climb > 0 ? '+' : ''}${climb.toFixed(1)} m/s` : '–'],
        ['Nopeus', fmt(Number.isFinite(speed) ? speed * 3.6 : null, 'km/h')],
        ['Suunta', fmt(feature.get('track'), '°')],
        // Fixes legitimately arrive over a minute apart, so the age is shown
        // rather than implied.
        ['Havaittu', ageS < 60 ? `${ageS} s sitten` : `${Math.round(ageS / 60)} min sitten`],
      ];
      gridEl.innerHTML = rows
        .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
        .join('');
      overlay.setPosition(feature.getGeometry().getCoordinates());
    }

    function openFor(feature) {
      openId = feature.get('id');
      paint(feature);
    }

    // The subject is moving: every update repositions the card and refreshes the
    // numbers, and an aircraft that goes away takes its card with it.
    function sync() {
      if (openId === null) return;
      const feature = features.get(openId);
      if (!feature) { hide(); return; }
      paint(feature);
    }

    function findAtPixel(pixel) {
      if (!layer.getVisible()) return null;
      let hit = null;
      map.forEachFeatureAtPixel(pixel, (f, l) => {
        if (l === layer) { hit = f; return true; }
        return false;
      }, { hitTolerance: 10 });
      return hit;
    }

    const card = {
      findAtPixel, open: openFor, hide, sync,
    };
    cards.push(card);
    return card;
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
      connect();
      sweepTimer = setInterval(sweep, SWEEP_MS);
    },
  };
}
