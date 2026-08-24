// Aerodromes (Lentokentät) from bundled snapshots — Finland, France and
// Switzerland today, one file per country because each follows its own AIRAC
// cycle (or, for openAIP, none at all) and carries its own attribution.
// scripts/fetch-airfields.mjs writes all three.
//
// This exists because the layer outgrew a URL. It was a per-pane VectorSource
// pointed at one file, which was exactly right while there was one file: adding
// a second country meant either two sources per pane or a loader, and a loader
// belongs somewhere both consumers can share it. The other consumer is the METAR
// layer, which needs the same list for a different reason — where to draw the
// station plots — and used to fetch and parse the same file a second time.
//
// So: one fetch per snapshot per page load, parsed once, handed to whoever asks.
// Panes share the resulting VectorSource, as they do for place names and
// airspace; the METAR layer takes the plain records.
//
// EVERYTHING, NOT JUST THE VIEWPORT. Unlike the airspace snapshots — 1.5 MB
// between them, and gated on the map reaching the country — these are 12, 23 and
// 9 kB. Gating them would cost more in complexity than it could ever save, and
// an aerodrome label is the kind of thing that should already be there when you
// pan onto it.
//
// WALL-CLOCK, or rather no clock at all: an aerodrome does not move and the
// snapshot has no time dimension, so setTime does not route here.

import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';

import finlandUrl from './data/airfields-finland.geojson';
import franceUrl from './data/airfields-france.geojson';
import switzerlandUrl from './data/airfields-switzerland.geojson';

// Two of these come from a national eAIP and one from openAIP, and that is a
// licence difference as much as a data one: openAIP is CC BY-NC, so its credit
// is a condition rather than a courtesy — the same constraint the airspace layer
// already carries (src/airspace.js).
const SNAPSHOTS = [
  { url: finlandUrl, attribution: 'Lentopaikat © <a href="https://www.ais.fi/">Fintraffic ANS</a>' },
  { url: franceUrl, attribution: 'Lentopaikat © <a href="https://www.sia.aviation-civile.gouv.fr/">SIA</a>' },
  { url: switzerlandUrl, attribution: 'Lentopaikat © <a href="https://www.openaip.net/">openAIP</a> (CC BY-NC)' },
];

export default function initAirfields() {
  const format = new GeoJSON({ featureProjection: 'EPSG:3857' });
  const source = new VectorSource({
    attributions: SNAPSHOTS.map((s) => s.attribution),
  });

  // The raw records, for consumers that want the data rather than the features:
  // { icao, name, elevationFt?, metar?, coordinates: [lon, lat] }.
  let loading = null;

  function load() {
    if (!loading) {
      loading = Promise.all(SNAPSHOTS.map(({ url }) => fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`airfields ${res.status}`);
          return res.json();
        })
        // A missing snapshot leaves that country out. Nothing else depends on
        // it, and the other country still draws — which is the whole reason
        // these are separate files.
        .catch(() => null)))
        .then((jsons) => {
          const records = [];
          jsons.forEach((json) => {
            if (!json) return;
            source.addFeatures(format.readFeatures(json));
            (json.features || []).forEach((f) => {
              if (!f.properties || !f.geometry) return;
              records.push({ ...f.properties, coordinates: f.geometry.coordinates });
            });
          });
          return records;
        });
    }
    return loading;
  }

  return {
    // Pane factory for paneDeps. Every pane draws the same shared source, so a
    // split screen costs no extra fetch. Starts hidden; the POI toggle decides.
    createPaneLayer(style) {
      load();
      return new VectorLayer({
        source,
        visible: false,
        // France's VFR fields took this layer from 221 aerodromes to 572, and
        // in the Alps their codes started printing over each other. Decluttered
        // now, in its own group so aerodrome codes never knock out place names —
        // layers sharing a group are decluttered together, topmost first. The
        // marks are exempt (declutterMode: 'none' on the style's image), so what
        // gives way is a label, never an aerodrome.
        declutter: 'airfields',
        style,
      });
    },

    // The aerodrome records, once loaded. Resolves to the same array for every
    // caller — the METAR layer asks for this to know where its stations are.
    stations: load,
  };
}
