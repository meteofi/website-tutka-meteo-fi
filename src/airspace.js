// Finnish airspace (Ilmatilat) from a bundled openAIP snapshot — control zones
// and terminal areas, the restricted/danger/prohibited areas, and the military
// reservation areas, as three separately switchable parts of one POI topic.
//
// NOT NAVIGATION DATA. This is situational context on a weather map: where the
// rain is relative to airspace a pilot would care about. The snapshot is a
// point in time and carries no NOTAMs, no activation state and no hours — a
// reserved area drawn here may well be cold, and a cold one may be active. The
// file's own metadata says so, and the layer is deliberately quiet about
// anything it cannot actually know.
//
// LICENCE. openAIP is CC BY-NC 4.0 — attribution required, non-commercial use
// only. Every other dataset in this app is plain CC BY, so this is the one that
// constrains what the app may become; see scripts/fetch-airspace.mjs.
//
// Cross-pane pattern (placeNames / gliders / trainLocations): the file is
// fetched ONCE into three shared VectorSources, one per part, and each pane
// gets a thin VectorLayer over each. Split screen costs no extra fetch, and
// because the parts are separate sources the POI switches are plain layer
// visibility rather than a style function that has to reject most of what it is
// handed.
//
// WALL-CLOCK — or rather, no clock at all. Airspace does not move and the
// snapshot has no time dimension, so setTime does not route here.
//
// NO ZOOM FLOOR, deliberately, and this is the lesson the OGN layer taught:
// hiding a layer when zoomed out means that zooming out to find it is exactly
// what makes it disappear, which reads as broken. Airspace polygons are large
// and static, so the honest control over clutter is WHICH parts are on — the
// 378 military reservation areas are off by default — and labels, which do have
// a zoom floor because a label nobody can read is only ink.

import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import {
  Fill, Stroke, Style, Text,
} from 'ol/style';

import airspaceUrl from './data/airspace-finland.geojson';

export const AIRSPACE_GROUPS = ['controlled', 'restricted', 'reserved'];

// Names appear at or below this resolution (map units per pixel in EPSG:3857) —
// about z9 and closer. Wider than that the polygons still draw; it is only the
// text that would be unreadable and would bury the radar underneath it.
const LABEL_MAX_RESOLUTION = 400;
// The vertical limits are the second line, and they only earn their space once
// there is room to read both — about z11.
const LIMITS_MAX_RESOLUTION = 90;

// Chart conventions, which pilots already read without a legend: controlled
// airspace blue, the restrictions red, military reservations magenta. Each
// theme gets its own set for the same reason as every other vector layer here —
// the dark basemap needs brighter strokes, the light one darker and more
// saturated ones.
//
// OUTLINE ONLY, no fills. Fills were tried first at 4-7% alpha and they do not
// survive contact with real data: airspace overlaps itself constantly — around
// Helsinki a TMA LOWER, a TMA UPPER and a CTA stack on the same ground — so the
// alpha compounds and the basemap picks up a visible tint. With the reservation
// areas on it washed the whole of southern Finland and discoloured the radar
// echo, which is the one thing this app exists to show. A boundary is a line;
// drawing it as one costs nothing and compounds with nothing.
const PALETTES = {
  light: {
    controlled: 'rgba(21, 82, 168, 0.8)',
    restricted: 'rgba(178, 34, 34, 0.8)',
    // Dimmest of the three: they are the most numerous by far, so they are the
    // ones that decide whether the map is readable.
    reserved: 'rgba(140, 40, 140, 0.55)',
    textFill: '#1a1a1a',
    textHalo: 'rgba(255, 255, 255, 0.95)',
  },
  dark: {
    controlled: 'rgba(122, 175, 255, 0.8)',
    restricted: 'rgba(255, 122, 122, 0.8)',
    reserved: 'rgba(214, 138, 226, 0.5)',
    textFill: '#f0f0f0',
    textHalo: 'rgba(0, 0, 0, 0.85)',
  },
};

// Reservation areas are dashed: they are the ones whose boundary is a schedule
// rather than a wall, and this layer cannot say whether one is active. A dashed
// edge reads as "provisional" without claiming anything specific.
const DASHES = { reserved: [6, 4] };

export default function initAirspace() {
  const format = new GeoJSON({ featureProjection: 'EPSG:3857' });
  // One source per part, so switching a part off is a layer going invisible
  // rather than a style function filtering 684 features it was handed anyway.
  const sources = new Map(
    AIRSPACE_GROUPS.map((group) => [group, new VectorSource({
      attributions: 'Ilmatilat © <a href="https://www.openaip.net/">openAIP</a> (CC BY-NC)',
    })]),
  );

  let loaded = false;
  let loading = null;

  // Fetched on first use rather than at startup: most visitors never switch
  // this on, and 254 kB is not worth spending on them.
  function load() {
    if (loaded || loading) return loading;
    loading = fetch(airspaceUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`airspace ${res.status}`);
        return res.json();
      })
      .then((json) => {
        const features = format.readFeatures(json);
        const byGroup = new Map(AIRSPACE_GROUPS.map((g) => [g, []]));
        features.forEach((feature) => {
          const bucket = byGroup.get(feature.get('g'));
          if (bucket) bucket.push(feature);
        });
        byGroup.forEach((list, group) => {
          if (list.length) sources.get(group).addFeatures(list);
        });
        loaded = true;
      })
      .catch(() => {
        // A missing snapshot leaves empty layers. Nothing else depends on it,
        // and retrying is one more switch of the POI.
        loading = null;
      });
    return loading;
  }

  function makeStyleFunction(theme, group) {
    const palette = PALETTES[theme];
    const area = new Style({
      stroke: new Stroke({
        color: palette[group],
        width: group === 'controlled' ? 1.2 : 1.4,
        lineDash: DASHES[group],
      }),
    });
    // Its own Style so it can be decluttered away while the boundary stays —
    // the polygon is the data, the label is a convenience.
    const label = new Style({
      text: new Text({
        font: '600 11px Roboto, sans-serif',
        fill: new Fill({ color: palette.textFill }),
        stroke: new Stroke({ color: palette.textHalo, width: 2.5 }),
        overflow: false,
      }),
    });

    return (feature, resolution) => {
      if (resolution > LABEL_MAX_RESOLUTION) return area;
      const name = feature.get('n');
      if (!name) return area;
      const lower = feature.get('l');
      const upper = feature.get('u');
      // Limits are what turns "there is an airspace here" into something a
      // reader can act on, but they double the label's height, so they wait
      // until there is room. An en dash, not a hyphen: it is a range.
      const text = resolution <= LIMITS_MAX_RESOLUTION && (lower || upper)
        ? `${name}\n${lower}–${upper}`
        : name;
      label.getText().setText(text);
      return [area, label];
    };
  }

  const styles = new Map();
  AIRSPACE_GROUPS.forEach((group) => {
    styles.set(group, {
      light: makeStyleFunction('light', group),
      dark: makeStyleFunction('dark', group),
    });
  });

  return {
    styleFor: (group, theme) => styles.get(group)[theme],

    // Pane factory for paneDeps, one call per part. Starts hidden and on the
    // light style; POI visibility and setMapLayer take over immediately after
    // pane creation.
    createPaneLayer(group) {
      return new VectorLayer({
        source: sources.get(group),
        visible: false,
        // Own declutter group so airspace names never knock out place names or
        // station names — layers sharing a value are decluttered together, and
        // the topmost wins.
        declutter: 'airspace',
        style: styles.get(group).light,
      });
    },

    // Called from the POI toggle. The fetch is what is being gated here, not
    // the paint: switching the topic on is the first thing that needs the file.
    setEnabled(on) {
      if (on) load();
    },
  };
}
