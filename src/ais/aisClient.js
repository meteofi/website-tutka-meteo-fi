// Digitraffic marine AIS transport: MQTT over WebSocket plus the REST
// bootstrap endpoints. mqtt.js is loaded lazily inside connect() — users who
// never pick the AIS source never download it. The pre-bundled
// mqtt/dist/mqtt.esm.js is imported on purpose: it is self-contained, so the
// whole client lands in one async "mqtt" chunk instead of leaking transitive
// dependencies into the eager vendors bundle.
//
// Live-verified against the service (node harness, 2026-07-12):
//   - per-vessel topic tail is 'location' (SINGULAR) although the docs page
//     says 'locations'; we subscribe 'vessels-v2/<mmsi>/+' so either works
//   - location payload {time(epoch s), sog(kn), cog, navStat, rot, heading,
//     lon, lat}; metadata payload {timestamp(epoch ms), type(shipType), name}
//   - REST preflight allows the Digitraffic-User header (allow-origin *)
//
// Digitraffic usage rules (digitraffic.fi/en/support/instructions):
//   - identify the app (Digitraffic-User header, app-prefixed MQTT clientId),
//     never personal info
//   - ≤5 MQTT connects/min per IP → reconnectPeriod 15 s stays inside it
//   - subscribe vessels-v2/status so an otherwise-quiet connection (silent
//     vessel) is not dropped as idle.
//
// Future seam (rescue-vessel layer, shipType 51): setSubscriptions() already
// takes a list and onMessage carries the mmsi. The follow-up should add a
// shared-client accessor so own-ship and the vessel layer ride one socket,
// with client-side shipType filtering fed from GET /vessels (the API has no
// server-side shipType filter).

const MQTT_URL = 'wss://meri.digitraffic.fi:443/mqtt';
const REST_BASE = 'https://meri.digitraffic.fi/api/ais/v1';
const APP_ID = 'tutka.meteo.fi';

export default function createAisClient({
  onMessage, // ({ mmsi, kind: 'location'|'metadata', data })
  onStateChange = () => {}, // 'idle'|'connecting'|'connected'|'reconnecting'|'error'
  debug = () => {},
}) {
  let client = null;
  let wantConnected = false;
  let subscriptions = new Set();

  async function fetchJson(path) {
    const resp = await fetch(`${REST_BASE}${path}`, { headers: { 'Digitraffic-User': APP_ID } });
    if (!resp.ok) throw new Error(`AIS REST ${resp.status} for ${path}`);
    return resp.json();
  }

  // Latest known position, or null when Digitraffic has none (vessel silent
  // or outside Baltic reception). Normalized to the MQTT payload shape.
  async function fetchLocation(mmsi) {
    const geojson = await fetchJson(`/locations?mmsi=${mmsi}`);
    const feature = geojson && Array.isArray(geojson.features) ? geojson.features[0] : null;
    if (!feature) return null;
    const [lon, lat] = feature.geometry.coordinates;
    const props = feature.properties || {};
    const timeMs = props.timestampExternal != null ? props.timestampExternal : Date.now();
    return {
      ...props, lon, lat, time: Math.round(timeMs / 1000),
    };
  }

  // Vessel metadata ({ name, shipType, … }); throws on 404 (unknown MMSI).
  async function fetchMetadata(mmsi) {
    const meta = await fetchJson(`/vessels/${mmsi}`);
    return { mmsi: String(mmsi), name: meta.name, shipType: meta.shipType };
  }

  function topicsFor(mmsis) {
    return mmsis.map((m) => `vessels-v2/${m}/+`);
  }

  function subscribeAll() {
    if (!client || !client.connected) return;
    client.subscribe(['vessels-v2/status', ...topicsFor([...subscriptions])], { qos: 0 });
  }

  function setSubscriptions(mmsis) {
    const next = new Set(mmsis.map(String));
    if (client && client.connected) {
      const removed = [...subscriptions].filter((m) => !next.has(m));
      const added = [...next].filter((m) => !subscriptions.has(m));
      if (removed.length) client.unsubscribe(topicsFor(removed));
      if (added.length) client.subscribe(topicsFor(added), { qos: 0 });
    }
    subscriptions = next;
  }

  async function connect() {
    wantConnected = true;
    if (client) return;
    let mqtt;
    try {
      const mod = await import(/* webpackChunkName: "mqtt" */ 'mqtt/dist/mqtt.esm');
      mqtt = mod.default || mod;
    } catch (err) {
      // Chunk load failure (offline, or a stale-hash chunk right after a
      // deploy — sw-register.js self-heals the latter with a reload).
      debug(`mqtt chunk load failed: ${err && err.message}`);
      onStateChange('error');
      return;
    }
    if (!wantConnected || client) return; // torn down while the chunk loaded
    onStateChange('connecting');
    client = mqtt.connect(MQTT_URL, {
      clientId: `${APP_ID}-${Math.random().toString(16).slice(2, 10)}`,
      protocolVersion: 4,
      keepalive: 60,
      reconnectPeriod: 15000,
      clean: true,
    });
    client.on('connect', () => {
      onStateChange('connected');
      subscribeAll();
    });
    client.on('reconnect', () => onStateChange('reconnecting'));
    client.on('close', () => {
      if (wantConnected) onStateChange('reconnecting');
    });
    client.on('error', (err) => debug(`AIS MQTT error: ${err && err.message}`));
    client.on('message', (topic, payload) => {
      const parts = topic.split('/');
      if (parts.length !== 3 || !subscriptions.has(parts[1])) return; // status topic etc.
      let data;
      try {
        data = JSON.parse(payload.toString());
      } catch (err) {
        return;
      }
      onMessage({ mmsi: parts[1], kind: parts[2] === 'metadata' ? 'metadata' : 'location', data });
    });
  }

  function disconnect() {
    wantConnected = false;
    if (client) {
      client.end(true);
      client = null;
    }
    onStateChange('idle');
  }

  return {
    connect, disconnect, setSubscriptions, fetchLocation, fetchMetadata,
  };
}
