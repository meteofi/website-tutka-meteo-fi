// Live train positions from Digitraffic's GPS feed, drawn on the Rautatiet POI
// alongside the stations and the track network. Tapping one opens the shared
// telemetry strip.
//
// The transport and the server contract live in rail/trainQuery.js; this module
// owns the map-shaped decisions. The short version: MQTT carries a train number
// and a dot, so identity, category, destination and delay come from a separate
// GraphQL query, and the two are joined on (departureDate, trainNumber).
//
// Cross-pane pattern (placeNames / gliders / trafficMessages): ONE shared
// VectorSource, one VectorLayer per pane through the paneDeps factory, so split
// screen costs no extra connection.
//
// WALL-CLOCK, NOT CLOCK-COUPLED, like the OGN aircraft and the AIS own-vessel
// marker. The feed holds current positions only — there is no history to scrub
// and no radar frame can un-run a train — so setTime does not route here. The
// departure board in trains.js is wall-clock for the same reason.
//
// mqtt.js is imported lazily into the SAME async "mqtt" chunk the AIS client
// uses, so a user who enables neither never downloads it, and one who enables
// both downloads it once.

import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { fromLonLat } from 'ol/proj';
import {
  Circle as CircleStyle, Fill, Stroke, Style, Text,
} from 'ol/style';

import {
  APP_ID, GRAPHQL_URL, LATEST_URL, METADATA_QUERY, MQTT_URL, TOPIC,
  bearingBetween, formatDelay, parseLocation, parseMetadata,
} from './rail/trainQuery';

// Identity, destination and delay all change slowly; positions do not come from
// here. A minute matches the GetCapabilities cadence used everywhere else.
const METADATA_MS = 60000;

// A train that has just departed publishes positions before the next scheduled
// metadata refresh would notice it exists. Rather than leave it undrawn for up
// to a minute, an unknown key triggers an early refresh — but no more often than
// this, so a persistently unknown train (one filtered out, which stays unknown
// forever by design) cannot turn into a polling loop.
const UNKNOWN_REFRESH_MS = 20000;

// Drop a train that has stopped reporting. Measured cadence is a fix every ~4 s,
// so this is generous — it is for a service that ends mid-journey-looking, e.g.
// one that terminates between metadata refreshes. The refresh itself is the
// primary cleanup: a train that finishes leaves `currentlyRunningTrains`.
const STALE_MS = 5 * 60 * 1000;
const SWEEP_MS = 15000;

// A fix older than this draws faded. Well above the 4 s cadence, so this means
// "this train has gone quiet", not "the last packet was a moment ago".
const FADE_AFTER_MS = 90000;

// Freight numbers ("T 1234") identify a train nobody is waiting for, so they
// only earn a label once the map is detailed enough to have room. Matches the
// band at which railway stations swap their code for their full name.
const CARGO_LABEL_MAX_RESOLUTION = 320;

// How far a train must move before its heading is believed. A train standing at
// a platform still reports, and its GPS wanders; without this the direction tick
// would spin while the train sat still.
const HEADING_MIN_METRES = 20;

// Length of the direction tick, in screen pixels. Drawn in map coordinates
// rather than as a rotated icon so it stays correct when the view is rotated.
const TICK_PX = 15;

const PALETTES = {
  light: {
    longdistance: '#0b4f9e',
    cargo: '#6b4a2f',
    // The commuter disc is white with the line letter inside on BOTH themes:
    // that is how the network's own signage and the departure board in
    // trains.js present a commuter line, and the user asked for it there.
    commuter: '#ffffff',
    commuterText: '#111111',
    halo: 'rgba(255,255,255,0.9)',
    accent: '#0089c4',
    textFill: '#1a1a1a',
    textHalo: '#ffffff',
  },
  dark: {
    longdistance: '#5aa9ff',
    cargo: '#c99a6b',
    commuter: '#ffffff',
    commuterText: '#111111',
    halo: 'rgba(0,0,0,0.55)',
    accent: '#12bcfa',
    textFill: '#f0f0f0',
    textHalo: '#000000',
  },
};

// Passenger trains draw over freight where they overlap — at a junction the
// service a reader is more likely to be looking for should be the one on top.
const RANKS = { cargo: 0, longdistance: 1, commuter: 2 };

const toRadians = (deg) => (deg * Math.PI) / 180;

export default function initTrainLocations({ telemetry, stationName = (c) => c } = {}) {
  const source = new VectorSource({
    attributions: 'Junat © Fintraffic (CC BY 4.0)',
  });

  const features = new Map(); // key -> Feature
  let metadata = new Map(); // key -> { label, kind, originCode, destinationCode, delayMinutes }
  // Keys the feed reports but metadata does not cover, remembered so each one
  // asks for an early refresh at most once. Measured live: 13 of 123 trains in
  // the feed had not departed yet — powered up at their origin, transmitting
  // GPS, absent from `currentlyRunningTrains` until they actually leave. Train 3
  // was still an hour from its run. Without this gate their fixes would arrive
  // every 4 s forever and turn the early refresh into a permanent 20 s poll.
  const unknownKeys = new Set();
  let client = null;
  let enabled = false;
  let metadataTimer = 0;
  let sweepTimer = 0;
  let lastMetadataAttemptMs = 0;
  let unknownRefreshQueued = false;

  //
  // DATA
  //
  function applyMetadata(feature, meta) {
    feature.setProperties({
      label: meta.label,
      kind: meta.kind,
      delayMinutes: meta.delayMinutes,
      originCode: meta.originCode,
      destinationCode: meta.destinationCode,
    }, true);
  }

  function upsert(fix) {
    const meta = metadata.get(fix.key);
    // No metadata means one of three things, and none of them should draw: the
    // train is filtered out (yard shunting, a light engine); it has not departed
    // yet, so the API does not consider it running; or it started so recently
    // that no refresh has seen it. Only the last self-corrects, and it is
    // indistinguishable from the others here — so ask for one early refresh per
    // key and let the answer settle it.
    if (!meta) {
      if (!unknownKeys.has(fix.key)) {
        unknownKeys.add(fix.key);
        requestUnknownRefresh();
      }
      return;
    }
    const at = fromLonLat([fix.lon, fix.lat]);
    let feature = features.get(fix.key);
    if (!feature) {
      feature = new Feature({ geometry: new Point(at) });
      feature.set('key', fix.key, true);
      features.set(fix.key, feature);
      source.addFeature(feature);
    } else {
      const previous = feature.getGeometry().getCoordinates();
      // Heading has to be derived — the feed carries speed but no direction.
      // Keep the last believed heading when the train has barely moved, so a
      // train waiting at a signal keeps pointing the way it was going.
      const heading = bearingBetween(previous, at, HEADING_MIN_METRES);
      if (heading !== null) feature.set('heading', heading, true);
      feature.getGeometry().setCoordinates(at);
    }
    applyMetadata(feature, meta);
    feature.setProperties({
      speed: fix.speed,
      accuracy: fix.accuracy,
      atMs: fix.atMs,
      seenMs: Date.now(),
    }, true);
    feature.changed();
  }

  function remove(key) {
    const feature = features.get(key);
    if (!feature) return;
    source.removeFeature(feature);
    features.delete(key);
  }

  function clearAll() {
    source.clear(true);
    features.clear();
    unknownKeys.clear();
  }

  async function fetchJson(url, init) {
    const resp = await fetch(url, {
      ...init,
      headers: { 'Digitraffic-User': APP_ID, ...(init && init.headers) },
    });
    if (!resp.ok) throw new Error(`rail ${resp.status} for ${url}`);
    return resp.json();
  }

  // The authoritative set of trains worth drawing. Refreshing it does three
  // things: adds trains that have started, updates delays, and — because a train
  // that has finished its run leaves `currentlyRunningTrains` — retires the ones
  // that are over. That last part is why this is the primary cleanup and the
  // staleness sweep is only a backstop.
  async function refreshMetadata() {
    lastMetadataAttemptMs = Date.now();
    let json;
    try {
      json = await fetchJson(GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: METADATA_QUERY }),
      });
    } catch (err) {
      // Keep drawing what we have. A failed refresh ages the delays, which is
      // better than blanking the layer on one bad response.
      return;
    }
    if (!enabled) return;
    const next = parseMetadata(json);
    // An empty result means the query broke (a schema change, an error
    // response); a genuine empty network would be extraordinary. Treating it as
    // truth would clear every train, so keep the previous set instead.
    if (!next.size) return;
    metadata = next;
    // A train that has since departed is no longer unknown; forgetting it here
    // keeps the set to the trains genuinely outside the layer, and lets a train
    // that stops and restarts ask again.
    for (const key of [...unknownKeys]) {
      if (metadata.has(key)) unknownKeys.delete(key);
    }
    for (const [key, feature] of [...features.entries()]) {
      const meta = metadata.get(key);
      if (!meta) remove(key);
      else applyMetadata(feature, meta);
    }
    syncSelection();
    source.changed();
  }

  function requestUnknownRefresh() {
    if (unknownRefreshQueued || !enabled) return;
    const due = lastMetadataAttemptMs + UNKNOWN_REFRESH_MS - Date.now();
    if (due <= 0) {
      refreshMetadata();
      return;
    }
    unknownRefreshQueued = true;
    setTimeout(() => {
      unknownRefreshQueued = false;
      if (enabled) refreshMetadata();
    }, due);
  }

  // Bootstrap. Without it the map fills in over the first few seconds as each
  // train happens to report; 3 KB buys an immediate picture.
  async function loadSnapshot() {
    let list;
    try {
      list = await fetchJson(LATEST_URL);
    } catch (err) {
      return; // MQTT will populate the layer anyway, just less promptly.
    }
    if (!enabled || !Array.isArray(list)) return;
    list.forEach((entry) => {
      const fix = parseLocation(entry);
      if (fix) upsert(fix);
    });
  }

  async function connect() {
    let mqtt;
    try {
      const mod = await import(/* webpackChunkName: "mqtt" */ 'mqtt/dist/mqtt.esm');
      mqtt = mod.default || mod;
    } catch (err) {
      // Chunk load failure (offline, or a stale-hash chunk right after a deploy
      // — sw-register.js self-heals that with a reload). The snapshot already
      // drew a picture; it will simply not move.
      return;
    }
    if (!enabled || client) return;
    client = mqtt.connect(MQTT_URL, {
      // Digitraffic asks that clients identify themselves and never put personal
      // information in the id.
      clientId: `${APP_ID}-${Math.random().toString(16).slice(2, 10)}`,
      protocolVersion: 4,
      keepalive: 60,
      // Digitraffic caps connection attempts per IP; 15 s stays well inside it.
      reconnectPeriod: 15000,
      clean: true,
    });
    client.on('connect', () => client.subscribe(TOPIC, { qos: 0 }));
    client.on('error', () => { /* mqtt.js reconnects on its own */ });
    client.on('message', (topic, payload) => {
      let data;
      try {
        data = JSON.parse(payload.toString());
      } catch (err) {
        return; // a malformed frame must not kill the subscription
      }
      const fix = parseLocation(data);
      if (fix) upsert(fix);
      syncSelection();
    });
  }

  function sweep() {
    const floor = Date.now() - STALE_MS;
    for (const [key, feature] of [...features.entries()]) {
      if ((feature.get('seenMs') || 0) < floor) remove(key);
    }
    // The staleness fade is a function of elapsed time, not of incoming data, so
    // ageing marks need a repaint even when nothing arrives.
    source.changed();
    syncSelection();
  }

  function disconnect() {
    if (client) {
      client.end(true);
      client = null;
    }
    clearAll();
  }

  //
  // STYLE
  //
  function makeStyleFunction(theme) {
    const palette = PALETTES[theme];
    const cache = new Map();
    // One shared geometry, mutated per feature. The renderer consumes each
    // feature's styles before moving on, which is the same reason railwayStyle
    // can setText per feature.
    const tickLine = new LineString([[0, 0], [0, 0]]);

    const styles = (kind) => {
      let entry = cache.get(kind);
      if (entry) return entry;
      const color = palette[kind] || palette.longdistance;
      const commuter = kind === 'commuter';
      // `declutterMode: 'none'` on every mark, the lesson from the aircraft
      // layer: a train thinned away by a neighbour reads as a train that is not
      // running. It also stops the mark being an obstacle to its own label,
      // which is what silently unlabelled most of the OGN fleet.
      entry = {
        mark: new Style({
          image: new CircleStyle({
            // The commuter disc is larger because it carries the line letter
            // inside it; freight is smallest because it is the least likely to
            // be what a reader is looking for.
            radius: commuter ? 8.5 : (kind === 'cargo' ? 5 : 6.5),
            fill: new Fill({ color }),
            stroke: new Stroke({
              color: commuter ? palette.commuterText : palette.halo,
              width: 1.5,
            }),
            declutterMode: 'none',
          }),
          // The line letter, drawn INSIDE the disc and in the same Style object
          // as it — a white disc with no letter in it says nothing, so the two
          // must never be decluttered apart.
          text: commuter ? new Text({
            font: '700 11px Roboto, sans-serif',
            fill: new Fill({ color: palette.commuterText }),
            declutterMode: 'none',
          }) : undefined,
        }),
        // Everything else is labelled beside the mark, in its own Style so it
        // can be dropped when the map gets crowded while the mark stays.
        label: new Style({
          text: new Text({
            font: '600 11px Roboto, sans-serif',
            fill: new Fill({ color: palette.textFill }),
            stroke: new Stroke({ color: palette.textHalo, width: 2.5 }),
            offsetY: -15,
          }),
        }),
        // Direction of travel. Drawn under the mark so the disc stays clean, and
        // in map coordinates so it stays true if the view is rotated.
        tick: new Style({
          stroke: new Stroke({ color, width: 2.5, lineCap: 'round' }),
        }),
      };
      cache.set(kind, entry);
      return entry;
    };

    const ringHalo = new Style({
      image: new CircleStyle({
        radius: 14,
        fill: null,
        stroke: new Stroke({ color: palette.halo, width: 4.5 }),
        declutterMode: 'none',
      }),
    });
    const ring = new Style({
      image: new CircleStyle({
        radius: 14,
        fill: null,
        stroke: new Stroke({ color: palette.accent, width: 2 }),
        declutterMode: 'none',
      }),
    });

    return (feature, resolution) => {
      const kind = feature.get('kind') || 'longdistance';
      const entry = styles(kind);
      const out = [];
      if (feature.get('selected')) out.push(ringHalo, ring);

      const heading = feature.get('heading');
      if (Number.isFinite(heading)) {
        const [x, y] = feature.getGeometry().getCoordinates();
        const len = TICK_PX * resolution;
        const rad = toRadians(heading);
        tickLine.setCoordinates([
          [x, y], [x + Math.sin(rad) * len, y + Math.cos(rad) * len],
        ]);
        entry.tick.setGeometry(tickLine);
        out.push(entry.tick);
      }

      // Fade a fix that has gone quiet rather than dropping it: a train that
      // vanishes and returns reads worse than one that dims.
      const stale = Date.now() - (feature.get('atMs') || 0) > FADE_AFTER_MS;
      entry.mark.getImage().setOpacity(stale ? 0.45 : 1);
      const label = feature.get('label') || '';
      if (kind === 'commuter') {
        entry.mark.getText().setText(label);
        out.push(entry.mark);
        return out;
      }
      out.push(entry.mark);
      if (label && (kind !== 'cargo' || resolution < CARGO_LABEL_MAX_RESOLUTION)) {
        entry.label.getText().setText(label);
        out.push(entry.label);
      }
      return out;
    };
  }

  const styleLight = makeStyleFunction('light');
  const styleDark = makeStyleFunction('dark');

  //
  // SELECTION → TELEMETRY STRIP
  //
  const OWNER = 'trainLocations';
  let selectedKey = null;

  function payloadFor(feature) {
    const speed = feature.get('speed');
    const heading = feature.get('heading');
    const accuracy = feature.get('accuracy');
    const origin = feature.get('originCode');
    const destination = feature.get('destinationCode');
    const ageS = Math.max(0, Math.round((Date.now() - (feature.get('atMs') || 0)) / 1000));
    const delay = formatDelay(feature.get('delayMinutes'));
    return {
      icon: 'train',
      title: feature.get('label') || `Juna ${feature.get('key')}`,
      // The run, end to end. Station codes are expanded through the same
      // bundled snapshot the station markers draw, so this reads "Helsinki →
      // Rovaniemi" rather than "HKI → ROI".
      subtitle: origin && destination
        ? `${stationName(origin)} → ${stationName(destination)}` : '',
      status: ageS < 60 ? `${ageS} s sitten` : `${Math.round(ageS / 60)} min sitten`,
      metrics: [
        {
          label: 'Nopeus',
          value: Number.isFinite(speed) ? `${Math.round(speed)}\u2009km/h` : '–',
        },
        {
          label: 'Suunta',
          value: Number.isFinite(heading) ? `${Math.round(heading)}°` : '–',
        },
        { label: 'Aikataulu', value: delay.value, tone: delay.tone },
        {
          label: 'Tarkkuus',
          value: Number.isFinite(accuracy) ? `${Math.round(accuracy)}\u2009m` : '–',
        },
      ],
    };
  }

  function markSelected(key) {
    if (selectedKey === key) return;
    const previous = selectedKey !== null && features.get(selectedKey);
    if (previous) previous.set('selected', false);
    selectedKey = key;
    const next = key !== null && features.get(key);
    if (next) next.set('selected', true);
  }

  function clearSelection() {
    markSelected(null);
  }

  function selectFeature(feature) {
    markSelected(feature.get('key'));
    telemetry.open(OWNER, payloadFor(feature), clearSelection);
  }

  // The subject moves, so its readings go stale between updates, and a train
  // that finishes its run must take the strip with it.
  function syncSelection() {
    if (selectedKey === null) return;
    // The panel is shared. If it has been closed, or another source has taken it
    // over, the selection ring has to go too — otherwise the map keeps claiming
    // a selection whose readings are no longer on screen.
    if (!telemetry.ownerIs(OWNER)) { clearSelection(); return; }
    const feature = features.get(selectedKey);
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
    styleLight,
    styleDark,
    attachPane,

    createPaneLayer() {
      return new VectorLayer({
        source,
        visible: false,
        // Own group so train labels never knock out place names or station
        // names — layers sharing a declutter value are decluttered together,
        // topmost wins, and joining a group erases the lower layers' labels.
        declutter: 'train-locations',
        renderOrder: (a, b) => (RANKS[a.get('kind')] ?? 0) - (RANKS[b.get('kind')] ?? 0),
        // Positions move continuously; repaint during pan/zoom so the marks do
        // not lag the map under the finger.
        updateWhileAnimating: true,
        updateWhileInteracting: true,
        style: styleLight,
      });
    },

    // Called from the POI toggle: nothing is connected while the layer is off.
    setEnabled(on) {
      if (on === enabled) return;
      enabled = on;
      if (!on) {
        if (metadataTimer) clearInterval(metadataTimer);
        if (sweepTimer) clearInterval(sweepTimer);
        metadataTimer = 0;
        sweepTimer = 0;
        disconnect();
        // Switching the layer off has to take the strip with it. disconnect()
        // clears the features, so the selected train no longer exists; without
        // this the panel would sit there showing readings for something that is
        // not on the map any more, with no way to refresh or dismiss it from
        // the map side.
        syncSelection();
        return;
      }
      // Metadata first, deliberately: the snapshot cannot be classified or
      // filtered without it, so drawing before it lands would show freight yard
      // moves for a moment and then remove them.
      refreshMetadata()
        .then(() => {
          if (!enabled) return null;
          return Promise.all([loadSnapshot(), connect()]);
        })
        .catch(() => { /* both paths already degrade on their own */ });
      metadataTimer = setInterval(refreshMetadata, METADATA_MS);
      sweepTimer = setInterval(sweep, SWEEP_MS);
    },
  };
}
