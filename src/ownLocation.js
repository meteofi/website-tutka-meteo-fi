// Own-location controller. Owns the device-GPS source (OL Geolocation) and
// fans the resulting position/accuracy geometries out to every pane's marker
// features (pane.positionFeature / pane.accuracyFeature / pane.ownPositionLayer).
// radar.js wires it up, keeps ownership of IS_TRACKING and the pane-0 position
// globals, and receives results through the callbacks below.
//
// The own-position marker is wall-clock "now" — it has zero coupling to the
// 13-frame animation window (FramePool / setTime). Do not route it there.
import Geolocation from 'ol/Geolocation';
import Point from 'ol/geom/Point';
import { transform } from 'ol/proj';
import { track } from './analytics';

// Persisted own-location settings. The MMSI survives source flips on purpose:
// a user who runs on GPS for a while must not have to retype it.
const SOURCE_KEY = 'ownLocationSource';
const MMSI_KEY = 'ownMmsi';
const VALID_SOURCES = new Set(['gps', 'ais']); // 'nmea' reserved for Web Serial input
const MMSI_RE = /^[0-9]{9}$/;

export default function initOwnLocation({
  projection, // map view projection (shared View; never changes)
  getPanes, // () => current panes array (panes are created lazily)
  onPositionChange, // (coordinates, lonLat) — map projection + EPSG:4326
  onSpeedChange, // (kmh | null) — null hides the speed chip
  onStatusChange, // ('fixed' | 'denied') — 'denied': permission denied, tracking already stopped
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

  const geolocation = new Geolocation({
    trackingOptions: {
      enableHighAccuracy: true,
    },
    projection,
  });

  function setMarkersVisible(visible) {
    for (const pane of getPanes()) pane.ownPositionLayer.setVisible(visible);
  }

  // Start/stop the active source and show/hide the marker layer in every pane.
  function setTracking(enabled) {
    tracking = enabled;
    geolocation.setTracking(enabled);
    setMarkersVisible(enabled);
  }

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
    debug('Accuracy geometry changed.');
    // One device position, shown in every pane (each pane owns its own feature).
    const geom = geolocation.getAccuracyGeometry();
    for (const pane of getPanes()) {
      pane.accuracyFeature.setGeometry(geom ? geom.clone() : null);
    }
  });

  geolocation.on('change:position', () => {
    debug('Position changed.');
    const coordinates = geolocation.getPosition();
    lastCoordinates = coordinates;
    for (const pane of getPanes()) {
      pane.positionFeature.setGeometry(coordinates ? new Point(coordinates) : null);
    }
    onStatusChange('fixed');
    onPositionChange(coordinates, transform(coordinates, projection, 'EPSG:4326'));
  });

  geolocation.on('change:speed', () => {
    debug('Speed changed.');
    const speed = geolocation.getSpeed();
    onSpeedChange(Number.isFinite(speed) ? (speed * 3600) / 1000 : null);
  });

  // Mirror the marker into a pane created while tracking is on.
  function adoptPane(pane) {
    pane.ownPositionLayer.setVisible(true);
    if (lastCoordinates && lastCoordinates.length > 1) {
      pane.positionFeature.setGeometry(new Point(lastCoordinates));
    }
  }

  function getSource() { return source; }
  function getMmsi() { return mmsi; }

  function isSourceAvailable(candidate) {
    return candidate === 'gps' || (candidate === 'ais' && MMSI_RE.test(mmsi));
  }

  function setMmsi(value) {
    const next = String(value || '').trim();
    if (!MMSI_RE.test(next)) return false;
    if (next === mmsi) return true;
    mmsi = next;
    localStorage.setItem(MMSI_KEY, mmsi);
    return true;
  }

  function setSource(next) {
    if (!VALID_SOURCES.has(next) || !isSourceAvailable(next)) return false;
    if (next === source) return true;
    source = next;
    localStorage.setItem(SOURCE_KEY, source);
    // Only the source enum — never the MMSI, vessel name, or coordinates.
    track('own-location-source', { source });
    return true;
  }

  return {
    setTracking, adoptPane, getSource, setSource, getMmsi, setMmsi, isSourceAvailable,
  };
}
