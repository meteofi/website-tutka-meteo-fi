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

import LineString from 'ol/geom/LineString';
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
// The vertical limits are appended once there is room to read them — about z11.
const LIMITS_MAX_RESOLUTION = 90;

// Labels ride the BOUNDARY, not the middle of the area, which is how an
// aeronautical chart does it and for the same two reasons. An airspace is
// defined by its edge, so that is where the reader is looking; and these areas
// are large — at the zooms where the text is readable the centre is usually off
// screen, so a single label at the centroid would be missing exactly when it
// was wanted. Repeating along the edge means whichever stretch of boundary is
// on screen carries its own name.
const LABEL_REPEAT_PX = 340;

// …and INSIDE the area, which the boundary itself cannot give us. With
// `placement: 'line'` OpenLayers flips text that would otherwise read upside
// down, and the perpendicular `offsetY` flips with it — so the offset picks a
// side of the SCREEN, not a side of the polygon. A single value therefore lands
// inside along the southern edge of an area and outside along its northern one.
//
// So the label gets its own path: the ring stepped inward by a fixed number of
// pixels, with the text centred on that path. Then "inside" is a property of
// the geometry rather than of which way the text happened to be facing.
const LABEL_INSET_PX = 10;

// Which way round a ring is wound, so the inward direction can be derived
// rather than assumed. Every ring in the current export is counter-clockwise,
// but that is the export's habit and not a guarantee.
function ringIsCounterClockwise(ring) {
  let twiceArea = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    twiceArea += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return twiceArea > 0;
}

// The ring moved `distance` map units toward its own interior: each vertex
// slides along the bisector of the two edges meeting there. Deliberately the
// simple form — the bisector is used as a unit vector, so a sharp corner is
// under-offset rather than shooting off to infinity the way a true miter join
// would. This is a path for text to sit on, not a geometric buffer.
//
// Returns null when the area is too small to step into, which is the honest
// answer for the many airspaces here only a few kilometres across: at that size
// an inset ring would fold through itself and the label would wander outside
// the very boundary this exists to keep it within.
function insetRing(ring, distance) {
  const n = ring.length - 1; // rings are closed; the last point repeats the first
  if (n < 3 || !(distance > 0)) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    minX = Math.min(minX, ring[i][0]); maxX = Math.max(maxX, ring[i][0]);
    minY = Math.min(minY, ring[i][1]); maxY = Math.max(maxY, ring[i][1]);
  }
  if (Math.min(maxX - minX, maxY - minY) < distance * 4) return null;
  // For a counter-clockwise ring the interior lies to the left of travel, and
  // EPSG:3857 is y-up, so the left normal of an edge points inward.
  const inward = ringIsCounterClockwise(ring) ? 1 : -1;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const prev = ring[(i - 1 + n) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    const n1 = normalLeft(prev, cur, inward);
    const n2 = normalLeft(cur, next, inward);
    let bx = n1[0] + n2[0];
    let by = n1[1] + n2[1];
    const len = Math.hypot(bx, by);
    if (len < 1e-6) {
      // The edges double back on each other; the previous edge's normal is as
      // good a direction as any and keeps the path continuous.
      [bx, by] = n1;
    } else {
      bx /= len; by /= len;
    }
    out.push([cur[0] + bx * distance, cur[1] + by * distance]);
  }
  out.push(out[0]);
  return out;
}

// Unit normal pointing to the left of a->b, times `sign`.
function normalLeft(a, b, sign) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [0, 0];
  return [(-dy / len) * sign, (dx / len) * sign];
}

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
    // One shared path, rewritten per feature. The renderer consumes a feature's
    // styles before moving to the next, which is the same reason the train
    // layer can mutate one LineString for its heading tick.
    const labelPath = new LineString([[0, 0], [0, 0]]);
    // Its own Style so it can be decluttered away while the boundary stays —
    // the polygon is the data, the label is a convenience.
    const label = new Style({
      text: new Text({
        font: '600 11px Roboto, sans-serif',
        // `line` follows the polygon's ring; `repeat` re-draws it every so many
        // pixels along it. Sitting just off the line rather than on it keeps the
        // boundary itself unbroken, since OpenLayers will not gap a stroke for
        // text the way a chart's engraver would.
        placement: 'line',
        repeat: LABEL_REPEAT_PX,
        // Centred ON the inset path, so the whole text block sits inside the
        // boundary rather than straddling it.
        textBaseline: 'middle',
        fill: new Fill({ color: palette.textFill }),
        stroke: new Stroke({ color: palette.textHalo, width: 3 }),
      }),
    });

    return (feature, resolution) => {
      if (resolution > LABEL_MAX_RESOLUTION) return area;
      const name = feature.get('n');
      if (!name) return area;
      const lower = feature.get('l');
      const upper = feature.get('u');
      // Limits are what turn "there is an airspace here" into something a
      // reader can act on, so they join the name once there is room. One line,
      // not two: text following a curve cannot stack, and a boundary label that
      // needs two rows would only fit on the straightest stretches. An en dash,
      // not a hyphen — it is a range.
      const text = resolution <= LIMITS_MAX_RESOLUTION && (lower || upper)
        ? `${name}  ${lower}–${upper}`
        : name;
      label.getText().setText(text);
      // Inside the area, not on it. Falls back to the boundary itself when the
      // airspace is too small to step into — the label geometry always stays
      // within the feature's own extent either way, so nothing here can be
      // culled while its polygon is still on screen.
      const ring = feature.getGeometry().getCoordinates()[0];
      const inset = insetRing(ring, LABEL_INSET_PX * resolution);
      labelPath.setCoordinates(inset || ring);
      label.setGeometry(labelPath);
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
