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

  return { setTracking, adoptPane };
}
