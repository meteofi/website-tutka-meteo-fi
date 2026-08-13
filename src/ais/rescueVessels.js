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
import { ageText, cell, rotCell } from './aisFormat';

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

// Names and numbers appear only once the map is close enough to have room —
// the same band the aircraft readouts and the station names use. A fleet of
// fifty is a different problem from one own vessel, which is always labelled.
const LABEL_MAX_RESOLUTION = 320;

export default function initRescueVessels({ telemetry } = {}) {
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
    syncSelection();
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
    syncSelection();
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

  const style = createOwnShipStyleFn({
    rgb: RESCUE_RGB,
    labelMaxResolution: LABEL_MAX_RESOLUTION,
    // Most of these are alongside most of the time; a harbour full of "0,0 kn"
    // says nothing, and the name is what identifies the target.
    courseWhenUnderWay: true,
    // Never thinned away, for the reason the aircraft readouts are not: a label
    // that appears only sometimes is worse than one that always does.
    labelAlwaysDrawn: true,
  });

  //
  // SELECTION -> TELEMETRY STRIP
  //
  // The same panel the own vessel, the aircraft and the trains use — and for a
  // rescue vessel the readings are exactly the own vessel's, because it is the
  // same kind of object seen from outside.
  const OWNER = 'rescueVessels';
  let selectedMmsi = null;

  function payloadFor(feature) {
    const st = feature.get('aisState') || {};
    return {
      icon: 'support',
      title: st.name || `MMSI ${feature.get('mmsi')}`,
      // The MMSI is the only identifier that is certainly unique, and it is what
      // a listener would use to look the vessel up anywhere else.
      subtitle: st.name ? `MMSI ${feature.get('mmsi')}` : '',
      status: ageText(st.atMs),
      metrics: [
        cell('Nopeus', st.sogKn, 'kn', 1),
        cell('Kurssi', st.cog, '°'),
        cell('Suunta', st.heading, '°'),
        rotCell(st.rot),
      ],
    };
  }

  function markSelected(mmsi) {
    if (selectedMmsi === mmsi) return;
    const previous = selectedMmsi !== null && features.get(selectedMmsi);
    if (previous) previous.set('aisState', { ...previous.get('aisState'), selected: false });
    selectedMmsi = mmsi;
    const next = mmsi !== null && features.get(mmsi);
    if (next) next.set('aisState', { ...next.get('aisState'), selected: true });
  }

  const clearSelection = () => markSelected(null);

  function selectFeature(feature) {
    markSelected(feature.get('mmsi'));
    telemetry.open(OWNER, payloadFor(feature), clearSelection);
  }

  // The subject moves and reports intermittently, so the readings go stale
  // between messages, and a vessel that drops out must take the strip with it.
  function syncSelection() {
    if (selectedMmsi === null || !telemetry) return;
    // The panel is shared: if another source has taken it, the ring goes too.
    if (!telemetry.ownerIs(OWNER)) { clearSelection(); return; }
    const feature = features.get(selectedMmsi);
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
        if (l === layer) { hit = f; return true; }
        return false;
      }, { hitTolerance: 8 });
      return hit;
    }
    return { findAtPixel, open: selectFeature };
  }

  return {
    attachPane,

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
        // Switching the layer off has to take the strip with it: the vessel it
        // was reporting no longer exists on the map.
        syncSelection();
        return;
      }
      sweepTimer = setInterval(sweep, SWEEP_MS);
      start();
    },
  };
}
