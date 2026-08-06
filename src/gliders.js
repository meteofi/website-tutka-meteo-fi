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

// OGN aircraft type codes. Only the distinction that changes the symbol is kept:
// everything unpowered-and-soaring reads as a glider, the rest as an aeroplane.
const GLIDER_TYPES = new Set([1, 6, 7]); // glider/motor glider, hang glider, paraglider

const PALETTES = {
  light: {
    glider: '#7b1fd6',
    other: '#55606b',
    halo: 'rgba(255,255,255,0.9)',
    textFill: '#241537',
    textHalo: '#ffffff',
  },
  dark: {
    glider: '#c77dff',
    other: '#9fb3c8',
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
      isGlider: GLIDER_TYPES.has(a.type),
      // The FIX time, not arrival time — what the staleness fade reads.
      fixMs: Number.isFinite(a.t) ? a.t : Date.now(),
      seenMs: Date.now(),
    }, true);
    feature.changed();
  }

  function remove(id) {
    const feature = features.get(id);
    if (!feature) return;
    source.removeFeature(feature);
    features.delete(id);
  }

  function clearAll() {
    source.clear(true);
    features.clear();
  }

  function handle(msg) {
    // ANY frame counts as liveness, heartbeats included — that is what they are
    // for.
    lastFrameMs = Date.now();
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'snapshot') {
      // A FULL RESET, not a diff. The bridge sends one after every subscribe and
      // unprompted when it has had to drop queued updates, and ids are
      // regenerated when it restarts — so reconciling against the old set would
      // strand markers under ids that no longer mean anything.
      clearAll();
      (msg.aircraft || []).forEach(upsert);
      return;
    }
    if (msg.type === 'update') {
      (msg.aircraft || []).forEach(upsert);
      (msg.gone || []).forEach(remove);
    }
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

    const styles = (isGlider) => {
      const key = String(isGlider);
      let entry = cache.get(key);
      if (!entry) {
        const color = isGlider ? palette.glider : palette.other;
        entry = {
          // An acute triangle reads as a heading even at marker size, the same
          // reasoning as the AIS target symbol.
          mark: new Style({
            image: new RegularShape({
              points: 3,
              radius: 7,
              radius2: 2.5,
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
      const entry = styles(feature.get('isGlider'));
      const track = feature.get('track');
      // OL rotates clockwise from north, which is exactly what a track is.
      entry.mark.getImage().setRotation(Number.isFinite(track) ? toRadians(track) : 0);
      // Fade an ageing fix rather than dropping it: a glider thermalling can go
      // over a minute between beacons, and a mark that vanishes and returns
      // reads worse than one that dims.
      const stale = Date.now() - (feature.get('fixMs') || 0) > FADE_AFTER_MS;
      entry.mark.getImage().setOpacity(stale ? 0.45 : 1);
      const out = [entry.mark];
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

  return {
    styleLight,
    styleDark,

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
