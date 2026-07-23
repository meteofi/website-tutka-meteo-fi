// Own-location controller. Owns the position sources — device GPS (OL
// Geolocation) and the user's own vessel via Digitraffic AIS — and fans the
// resulting position/accuracy geometries out to every pane's marker features
// (pane.positionFeature / pane.accuracyFeature / pane.ownPositionLayer).
// radar.js wires it up, keeps ownership of IS_TRACKING and the pane-0 position
// globals, and receives results through the callbacks below.
//
// The own-position marker is wall-clock "now" — it has zero coupling to the
// 13-frame animation window (FramePool / setTime). Do not route it there.
import Geolocation from 'ol/Geolocation';
import Point from 'ol/geom/Point';
import { transform } from 'ol/proj';
import { track } from './analytics';
import createAisClient from './ais/aisClient';
import { gpsPositionStyle, createOwnShipStyleFn } from './ais/ownShipStyle';

// Persisted own-location settings. The MMSI survives source flips on purpose:
// a user who runs on GPS for a while must not have to retype it.
const SOURCE_KEY = 'ownLocationSource';
const MMSI_KEY = 'ownMmsi';
const VALID_SOURCES = new Set(['gps', 'ais']); // 'nmea' reserved for Web Serial input
const MMSI_RE = /^[0-9]{9}$/;

// A vessel report older than this is shown dimmed with a "no fix" icon —
// moored class-B transmitters can be silent for many minutes.
const AIS_STALE_MS = 10 * 60 * 1000;
const AIS_STALE_CHECK_MS = 60 * 1000;

export default function initOwnLocation({
  projection, // map view projection (shared View; never changes)
  getPanes, // () => current panes array (panes are created lazily)
  onPositionChange, // (coordinates, lonLat) — map projection + EPSG:4326
  onSpeedChange, // ({ value, unit, headingDeg } | null) — null hides the dial
  onStatusChange, // ('fixed' | 'searching' | 'stale' | 'denied' | 'error')
  onVesselInfo = () => {}, // ({ mmsi, name, shipType } | null) — AIS metadata
  debug = () => {},
}) {
  let tracking = false;
  let lastCoordinates = null;

  // MMSI is a string end to end — leading zeros are significant.
  let mmsi = String(localStorage.getItem(MMSI_KEY) || '');
  if (!MMSI_RE.test(mmsi)) mmsi = '';
  let source = localStorage.getItem(SOURCE_KEY);
  if (!VALID_SOURCES.has(source) || (source === 'ais' && !mmsi)) {
    // Self-heal: an unknown value, or AIS without a usable MMSI, can only
    // produce a marker that never gets a fix — fall back to GPS and re-persist.
    source = 'gps';
    localStorage.setItem(SOURCE_KEY, source);
  }

  const ownShipStyleFn = createOwnShipStyleFn();

  // AIS session state. aisSession guards async REST results against a source
  // switch / re-key that happened while the fetch was in flight.
  let aisClient = null;
  let aisSession = 0;
  let aisState = null; // { heading, cog, sogKn, lat, name, mmsi, stale } → feature 'aisState'
  let lastAisFixMs = 0;
  let staleTimer = null;
  let vesselInfo = null;

  const geolocation = new Geolocation({
    trackingOptions: {
      enableHighAccuracy: true,
    },
    projection,
  });

  function setMarkersVisible(visible) {
    for (const pane of getPanes()) pane.ownPositionLayer.setVisible(visible);
  }

  function applyMarkerStyles() {
    const style = source === 'ais' ? ownShipStyleFn : gpsPositionStyle;
    for (const pane of getPanes()) pane.positionFeature.setStyle(style);
  }

  // Never show the previous source's fix under the new source's symbol.
  function clearMarkers() {
    lastCoordinates = null;
    for (const pane of getPanes()) {
      pane.positionFeature.setGeometry(null);
      pane.accuracyFeature.setGeometry(null);
    }
  }

  // ---------------------------------------------------------------- GPS ----

  geolocation.on('error', (error) => {
    debug(error.message);
    // PERMISSION_DENIED (code 1): tracking can never succeed, so turn it off
    // fully — otherwise the location button and the (empty) own-position
    // layer keep advertising a fix that will never come, and a persisted
    // IS_TRACKING re-arms the dead state on every boot. Transient errors
    // (POSITION_UNAVAILABLE / TIMEOUT) keep tracking armed and may recover.
    if (error.code === 1 && tracking) {
      setTracking(false);
      onStatusChange('denied');
    }
  });

  geolocation.on('change:accuracyGeometry', () => {
    if (source !== 'gps') return;
    debug('Accuracy geometry changed.');
    // One device position, shown in every pane (each pane owns its own feature).
    const geom = geolocation.getAccuracyGeometry();
    for (const pane of getPanes()) {
      pane.accuracyFeature.setGeometry(geom ? geom.clone() : null);
    }
  });

  geolocation.on('change:position', () => {
    if (source !== 'gps') return;
    debug('Position changed.');
    const coordinates = geolocation.getPosition();
    lastCoordinates = coordinates;
    for (const pane of getPanes()) {
      pane.positionFeature.setGeometry(coordinates ? new Point(coordinates) : null);
    }
    onStatusChange('fixed');
    onPositionChange(coordinates, transform(coordinates, projection, 'EPSG:4326'));
  });

  // The compass dial needs speed AND heading together. Course-over-ground is
  // often only defined while the device is actually moving, so read it
  // opportunistically; a null heading degrades the dial to a plain speedo.
  function emitGpsSpeed() {
    if (source !== 'gps') return;
    const speed = geolocation.getSpeed();
    if (!Number.isFinite(speed)) {
      onSpeedChange(null);
      return;
    }
    let headingDeg = null;
    const rad = geolocation.getHeading();
    if (Number.isFinite(rad)) {
      headingDeg = ((rad * 180) / Math.PI) % 360;
      if (headingDeg < 0) headingDeg += 360;
    }
    onSpeedChange({ value: (speed * 3600) / 1000, unit: 'km/h', headingDeg });
  }

  geolocation.on('change:speed', () => {
    if (source !== 'gps') return;
    debug('Speed changed.');
    emitGpsSpeed();
  });
  geolocation.on('change:heading', () => {
    emitGpsSpeed();
  });

  // ---------------------------------------------------------------- AIS ----

  function setAisState(next) {
    aisState = next;
    for (const pane of getPanes()) {
      pane.positionFeature.set('aisState', aisState, true);
      pane.positionFeature.changed();
    }
  }

  function applyAisLocation(data) {
    // AIS sentinel values mean "not available": heading 511, cog 360,
    // sog 102.3; lat 91 / lon 181 mean no position at all — drop the fix.
    if (data.lat == null || data.lon == null || Math.abs(data.lat) > 90 || Math.abs(data.lon) > 180) return;
    const heading = data.heading === 511 ? null : data.heading;
    const cog = data.cog === 360 ? null : data.cog;
    const sogKn = data.sog === 102.3 ? null : data.sog;
    const rot = data.rot === -128 ? null : data.rot; // -128 = turn rate not available
    lastAisFixMs = data.time ? data.time * 1000 : Date.now();
    const stale = Date.now() - lastAisFixMs > AIS_STALE_MS;
    setAisState({
      heading, cog, sogKn, rot, lat: data.lat, name: vesselInfo && vesselInfo.name, mmsi, stale,
    });
    const coordinates = transform([data.lon, data.lat], 'EPSG:4326', projection);
    lastCoordinates = coordinates;
    for (const pane of getPanes()) {
      pane.positionFeature.setGeometry(new Point(coordinates));
    }
    onStatusChange(stale ? 'stale' : 'fixed');
    onPositionChange(coordinates, [data.lon, data.lat]);
    // Marine mode reads in knots; true heading preferred over course-over-ground.
    onSpeedChange(sogKn != null
      ? { value: sogKn, unit: 'kn', headingDeg: heading != null ? heading : cog }
      : null);
  }

  function handleAisMessage({ mmsi: msgMmsi, kind, data }) {
    if (source !== 'ais' || !tracking || msgMmsi !== mmsi) return;
    if (kind === 'location') {
      applyAisLocation(data);
    } else {
      vesselInfo = { mmsi: msgMmsi, name: data.name, shipType: data.type };
      onVesselInfo(vesselInfo);
      if (aisState) setAisState({ ...aisState, name: data.name });
    }
  }

  function ensureAisClient() {
    if (!aisClient) {
      aisClient = createAisClient({
        onMessage: handleAisMessage,
        onStateChange: (state) => {
          if (source !== 'ais' || !tracking) return;
          if (state === 'error') onStatusChange('error');
        },
        debug,
      });
    }
    return aisClient;
  }

  function checkAisStale() {
    if (source !== 'ais' || !tracking || !aisState) return;
    const stale = Date.now() - lastAisFixMs > AIS_STALE_MS;
    if (stale !== aisState.stale) {
      setAisState({ ...aisState, stale });
      onStatusChange(stale ? 'stale' : 'fixed');
    }
  }

  async function bootstrapAisFromRest() {
    // MQTT only pushes on the vessel's NEXT report — the REST bootstrap makes
    // the marker (and vessel name) appear immediately on activation.
    const session = aisSession;
    const client = ensureAisClient();
    try {
      const meta = await client.fetchMetadata(mmsi);
      if (session !== aisSession) return;
      vesselInfo = meta;
      onVesselInfo(meta);
    } catch (err) {
      debug(`AIS metadata fetch failed: ${err && err.message}`);
    }
    try {
      const location = await client.fetchLocation(mmsi);
      if (session !== aisSession) return;
      if (location) applyAisLocation(location);
    } catch (err) {
      debug(`AIS location fetch failed: ${err && err.message}`);
    }
  }

  function startAisFeed() {
    aisSession += 1;
    onStatusChange('searching');
    const client = ensureAisClient();
    client.setSubscriptions([mmsi]);
    client.connect();
    bootstrapAisFromRest();
    if (!staleTimer) staleTimer = setInterval(checkAisStale, AIS_STALE_CHECK_MS);
  }

  function stopAisFeed() {
    aisSession += 1;
    if (aisClient) aisClient.disconnect();
    if (staleTimer) {
      clearInterval(staleTimer);
      staleTimer = null;
    }
  }

  // iOS Safari leaves the WebSocket half-dead after backgrounding: drop it
  // deliberately on hide and rebuild (with a REST refresh) on return.
  document.addEventListener('visibilitychange', () => {
    if (source !== 'ais' || !tracking) return;
    if (document.visibilityState === 'hidden') {
      if (aisClient) aisClient.disconnect();
    } else {
      startAisFeed();
    }
  });
  window.addEventListener('online', () => {
    if (source === 'ais' && tracking) startAisFeed();
  });

  // ------------------------------------------------------------- surface ----

  // Start/stop the active source and show/hide the marker layer in every pane.
  function setTracking(enabled) {
    tracking = enabled;
    if (source === 'gps') {
      geolocation.setTracking(enabled);
    } else if (enabled) {
      startAisFeed();
    } else {
      stopAisFeed();
    }
    if (enabled) {
      applyMarkerStyles(); // covers panes created while tracking was off
    } else {
      onSpeedChange(null); // stopping tracking emits no speed event — hide the dial explicitly
    }
    setMarkersVisible(enabled);
  }

  // Mirror the marker into a pane created while tracking is on.
  function adoptPane(pane) {
    pane.ownPositionLayer.setVisible(true);
    pane.positionFeature.setStyle(source === 'ais' ? ownShipStyleFn : gpsPositionStyle);
    if (source === 'ais' && aisState) pane.positionFeature.set('aisState', aisState, true);
    if (lastCoordinates && lastCoordinates.length > 1) {
      pane.positionFeature.setGeometry(new Point(lastCoordinates));
    }
  }

  function getSource() { return source; }
  function getMmsi() { return mmsi; }
  function getVesselInfo() { return vesselInfo; }

  function isSourceAvailable(candidate) {
    return candidate === 'gps' || (candidate === 'ais' && MMSI_RE.test(mmsi));
  }

  function setMmsi(value) {
    const next = String(value || '').trim();
    if (!MMSI_RE.test(next)) return false;
    if (next === mmsi) return true;
    mmsi = next;
    localStorage.setItem(MMSI_KEY, mmsi);
    if (source === 'ais' && tracking) {
      // Re-key the live session: the old vessel's fix, name and heading must
      // not linger under the new MMSI.
      aisSession += 1;
      vesselInfo = null;
      onVesselInfo(null);
      setAisState(null);
      clearMarkers();
      onSpeedChange(null);
      onStatusChange('searching');
      const client = ensureAisClient();
      client.setSubscriptions([mmsi]);
      client.connect();
      bootstrapAisFromRest();
    }
    return true;
  }

  function setSource(next) {
    if (!VALID_SOURCES.has(next) || !isSourceAvailable(next)) return false;
    if (next === source) return true;
    if (tracking) {
      if (source === 'gps') geolocation.setTracking(false);
      else stopAisFeed();
    }
    source = next;
    localStorage.setItem(SOURCE_KEY, source);
    // Only the source enum — never the MMSI, vessel name, or coordinates.
    track('own-location-source', { source });
    setAisState(null);
    clearMarkers();
    onSpeedChange(null);
    if (source !== 'ais') {
      vesselInfo = null;
      onVesselInfo(null);
    }
    applyMarkerStyles();
    if (tracking) {
      if (source === 'gps') {
        geolocation.setTracking(true);
        onStatusChange('searching');
      } else {
        startAisFeed();
      }
    }
    return true;
  }

  applyMarkerStyles(); // a persisted 'ais' source must restyle pane 0 at boot

  return {
    setTracking,
    adoptPane,
    getSource,
    setSource,
    getMmsi,
    setMmsi,
    isSourceAvailable,
    getVesselInfo,
  };
}
