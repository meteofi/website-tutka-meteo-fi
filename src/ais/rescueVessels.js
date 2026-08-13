// Pelastusalukset — search-and-rescue vessels from Digitraffic's marine AIS,
// the same feed and the same client the own-vessel marker uses.
//
// Cross-pane pattern (placeNames / gliders / trainLocations): ONE shared
// VectorSource, one VectorLayer per pane through the paneDeps factory, so split
// screen costs no extra connection.
//
// WALL-CLOCK, like every live layer here. AIS reports where a vessel is now;
// there is no history to scrub and no radar frame can un-sail a boat, so setTime
// does not route here.
//
// FINDING THEM COSTS A FULL VESSEL LIST. AIS ship type 51 is "search and
// rescue", but Digitraffic has no server-side filter for it, so the whole
// registry is fetched once (1129 vessels, 56 kB) and filtered here. Measured
// 2026-08-13: 54 of them, all reporting — 18 Finnish (MMSI 230…), 30 Swedish
// (265…), a handful Estonian and Icelandic, and three MMSIs beginning 111,
// which are SAR AIRCRAFT rather than vessels. They are kept: an airborne rescue
// unit is exactly as interesting as a floating one, and the AIS symbology says
// where it is going either way.
//
// A SEPARATE MQTT CLIENT from the own-vessel one, deliberately. Sharing a socket
// was the earlier plan and it buys almost nothing: the two have different
// subscription lists and different lifetimes — own ship exists only when the
// user picks AIS as their location source, this layer only while the POI is on —
// so sharing would mean merging lists and routing by MMSI to keep one socket
// that is usually serving one consumer anyway. Digitraffic's rule is on connect
// RATE (5/min), not on concurrent connections, and each of these connects once.

import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { fromLonLat } from 'ol/proj';

import createAisClient from './aisClient';
import { createOwnShipStyleFn } from './ownShipStyle';

// AIS ship type for search and rescue.
const SAR_SHIP_TYPE = 51;

// Rescue red, against the own vessel's orange. The two share the IMO symbology
// on purpose — same triangle, same heading line, same speed vector — because
// they are the same kind of object; only whose it is differs.
const RESCUE_RGB = '229, 57, 53';

// A report older than this draws dimmed rather than disappearing. Rescue craft
// sit alongside for days between callouts, and a vessel that vanishes reads as
// one that has sunk rather than one that is moored.
const STALE_MS = 30 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

// The registry changes when a vessel is commissioned or renamed, which is not
// something that needs watching within a session.
const VESSEL_LIST_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// AIS sentinels: these are not readings, they mean "not available". The same
// four ownLocation.js filters for the own vessel.
const clean = {
  heading: (v) => (v === 511 ? null : v),
  cog: (v) => (v === 360 ? null : v),
  sog: (v) => (v === 102.3 ? null : v),
  // ±127 is "turning fast, no indicator"; −128 is no data at all. Neither is a
  // rate, and the symbology only needs the SIGN to flag which way.
  rot: (v) => (v === -128 || Math.abs(v) === 127 ? null : v),
};

export default function initRescueVessels() {
  const source = new VectorSource({
    attributions: 'Pelastusalukset © <a href="https://www.digitraffic.fi/">Fintraffic</a> (CC BY 4.0)',
  });
  const features = new Map(); // mmsi -> Feature
  const names = new Map(); // mmsi -> vessel name
  let client = null;
  let enabled = false;
  let listFetchedMs = 0;
  let sweepTimer = 0;

  function upsert(mmsi, data) {
    if (!data || !Number.isFinite(data.lat) || !Number.isFinite(data.lon)) return;
    // 91/181 mean "no position", not a position off the coast of Africa.
    if (Math.abs(data.lat) > 90 || Math.abs(data.lon) > 180) return;
    const at = fromLonLat([data.lon, data.lat]);
    let feature = features.get(mmsi);
    if (!feature) {
      feature = new Feature({ geometry: new Point(at) });
      feature.set('mmsi', mmsi, true);
      features.set(mmsi, feature);
      source.addFeature(feature);
    } else {
      feature.getGeometry().setCoordinates(at);
    }
    // AIS timestamps are epoch SECONDS on the MQTT payload.
    const atMs = Number.isFinite(data.time) ? data.time * 1000 : Date.now();
    feature.set('aisState', {
      name: names.get(mmsi) || null,
      heading: clean.heading(data.heading),
      cog: clean.cog(data.cog),
      sogKn: clean.sog(data.sog),
      rot: clean.rot(data.rot),
      lat: data.lat,
      atMs,
      stale: Date.now() - atMs > STALE_MS,
    }, true);
    feature.changed();
  }

  function clearAll() {
    source.clear(true);
    features.clear();
  }

  // The staleness dim is a function of elapsed time, not of arriving data, so
  // ageing targets need a repaint even when the feed is quiet — which, for
  // vessels that are alongside, it usually is.
  function sweep() {
    const now = Date.now();
    features.forEach((feature) => {
      const state = feature.get('aisState');
      if (!state) return;
      const stale = now - state.atMs > STALE_MS;
      if (stale !== state.stale) feature.set('aisState', { ...state, stale }, true);
    });
    source.changed();
  }

  async function start() {
    if (!client) client = createAisClient({ onMessage: handleMessage });
    try {
      if (Date.now() - listFetchedMs > VESSEL_LIST_MAX_AGE_MS) {
        const vessels = await client.fetchVessels();
        names.clear();
        (Array.isArray(vessels) ? vessels : []).forEach((v) => {
          if (v && v.shipType === SAR_SHIP_TYPE) names.set(String(v.mmsi), v.name || null);
        });
        listFetchedMs = Date.now();
      }
    } catch (err) {
      // Without the registry there is no way to know which MMSIs are rescue
      // vessels, so there is nothing to draw and nothing to subscribe to.
      return;
    }
    if (!enabled || !names.size) return;

    // Positions before the socket: MQTT only speaks when a vessel reports, and
    // one alongside may not do so for many minutes.
    try {
      const geojson = await client.fetchAllLocations();
      if (!enabled) return;
      (geojson && geojson.features ? geojson.features : []).forEach((f) => {
        const mmsi = String(f.mmsi != null ? f.mmsi : (f.properties && f.properties.mmsi));
        if (!names.has(mmsi) || !f.geometry) return;
        const [lon, lat] = f.geometry.coordinates;
        const p = f.properties || {};
        upsert(mmsi, {
          lon,
          lat,
          heading: p.heading,
          cog: p.cog,
          sog: p.sog,
          rot: p.rot,
          time: Number.isFinite(p.timestampExternal) ? p.timestampExternal / 1000 : undefined,
        });
      });
    } catch (err) { /* the socket will fill the map in, just less promptly */ }
    if (!enabled) return;
    client.setSubscriptions([...names.keys()]);
    client.connect();
  }

  function handleMessage({ mmsi, kind, data }) {
    if (!enabled || kind !== 'location') return;
    if (!names.has(mmsi)) return;
    upsert(mmsi, data);
  }

  const style = createOwnShipStyleFn({ rgb: RESCUE_RGB });

  return {
    createPaneLayer() {
      return new VectorLayer({
        source,
        visible: false,
        // Own group so vessel names never knock out place names.
        declutter: 'rescue-vessels',
        // Targets move continuously; repaint during pan/zoom so they do not lag
        // the map under the finger.
        updateWhileAnimating: true,
        updateWhileInteracting: true,
        style,
      });
    },

    // Called from the POI toggle: nothing is connected while the layer is off.
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (!on) {
        if (sweepTimer) clearInterval(sweepTimer);
        sweepTimer = 0;
        if (client) client.disconnect();
        clearAll();
        return;
      }
      sweepTimer = setInterval(sweep, SWEEP_MS);
      start();
    },
  };
}
