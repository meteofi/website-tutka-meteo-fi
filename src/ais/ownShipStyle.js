// Own-position marker symbology.
//
// GPS keeps the classic blue dot (hoisted here from pane.js so the
// own-location controller can swap styles); AIS renders the IMO "active AIS
// target" symbol: an isosceles acute-angled triangle oriented by heading (COG
// fallback) with the reported position at the triangle's centre at half its
// height; a solid heading line (thinner than the vector) of twice the symbol
// length starting at the apex, with a fixed-length turn flag when the vessel
// is turning; and a short-dashed COG/SOG vector (spaces ≈ twice the line
// width). The label is two lines — direction ("232°") and speed ("7,7 kn") —
// placed below the symbol when the heading points up-screen and above when it
// points down, so it never collides with the heading line.
//
// The AIS style is a style FUNCTION reading the feature's 'aisState' property
// ({ heading, cog, sogKn, rot, lat, stale }), so per-report updates only need
// feature.set('aisState', …) + setGeometry — no restyling across panes.
// Sentinel filtering happens in ownLocation.js; here null simply means
// "don't draw that part".
import {
  Circle as CircleStyle, Fill, Stroke, Style, Text,
} from 'ol/style';
import LineString from 'ol/geom/LineString';
import Polygon from 'ol/geom/Polygon';

// The blue GPS dot + white ring. One shared Style across panes is safe.
export const gpsPositionStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: '#3399CC' }),
    stroke: new Stroke({ color: '#fff', width: 2 }),
  }),
});

const TRI_H = 20; // triangle height (px)
const TRI_W = 12; // triangle base width (px) — isosceles, acute apex
const HEADING_LEN = 2 * TRI_H; // IMO: heading line twice the symbol length, from the apex
const TURN_FLAG = 5; // px, fixed-length flag at the end of the heading line
const VECTOR_MINUTES = 3; // COG/SOG vector shows a 3-minute run
// Below this a reading is receiver noise rather than motion. One threshold,
// used both to decide whether to draw the speed vector and whether the label
// should say a course at all — they are the same judgement.
const MIN_VECTOR_SOG_KN = 0.5;

// Thin coloured lines over a faint light-gray casing; both basemap themes. The
// casing is what makes one thin line legible on either, so it does not vary.
const OWN_SHIP_RGB = '255, 140, 0';
const casing = (alpha) => `rgba(210, 210, 210, ${0.55 * alpha})`;

function cased(rgb, geometry, alpha, width, lineDash) {
  return [
    new Style({ geometry, stroke: new Stroke({ color: casing(alpha), width: width + 1, lineDash }) }),
    new Style({ geometry, stroke: new Stroke({ color: `rgba(${rgb}, ${alpha})`, width, lineDash }) }),
  ];
}

// The IMO target symbology, in whatever colour the caller needs it. Own ship
// keeps the orange it has always had; the rescue-vessel layer passes its own,
// so the two are one shape family telling you the same things — where it is
// pointing, how fast, which way it is turning — and differ only in hue.
//
// `rgb` is a bare "r, g, b" so the alpha can vary per element.
//
// The label options exist because one target and fifty are different problems.
// Own ship is always labelled: there is one of it and the user put it there.
// A fleet needs the same discipline the aircraft readouts needed —
//   labelMaxResolution  text only once zoomed in enough to have room for it
//   courseWhenUnderWay  course and speed only while actually moving, since a
//                       harbour full of "0,0 kn" says nothing
//   labelAlwaysDrawn    never thinned away, so a target that is labelled at all
//                       is labelled every frame rather than winking in and out
export function createOwnShipStyleFn({
  rgb = OWN_SHIP_RGB,
  labelMaxResolution = Infinity,
  courseWhenUnderWay = false,
  labelAlwaysDrawn = false,
} = {}) {
  return (feature, resolution) => {
    const geometry = feature.getGeometry();
    if (!geometry) return [];
    const state = feature.get('aisState') || {};
    const center = geometry.getCoordinates();
    const alpha = state.stale ? 0.5 : 1;

    // Orient by heading, or COG if heading is missing; north-up otherwise.
    const orientDeg = state.heading != null ? state.heading : state.cog;
    const theta = (((orientDeg != null ? orientDeg : 0) % 360) * Math.PI) / 180;
    const sin = Math.sin(theta);
    const cos = Math.cos(theta);
    // Local px frame (x to starboard, y towards the bow) → map coordinates.
    // sin/cos is enough because the view never rotates.
    const pt = (x, y) => [
      center[0] + (x * cos + y * sin) * resolution,
      center[1] + (-x * sin + y * cos) * resolution,
    ];

    const styles = [];

    // Selection: a ring under the symbol, so the target's own shape and colour
    // still read through it. Drawn first for that reason.
    if (state.selected) {
      styles.push(new Style({
        image: new CircleStyle({
          radius: 15,
          fill: null,
          stroke: new Stroke({ color: 'rgba(255,255,255,0.9)', width: 4.5 }),
          declutterMode: 'none',
        }),
      }), new Style({
        image: new CircleStyle({
          radius: 15,
          fill: null,
          stroke: new Stroke({ color: `rgba(${rgb}, 1)`, width: 2 }),
          declutterMode: 'none',
        }),
      }));
    }

    // Triangle: reported position at centre, half the height.
    const apex = pt(0, TRI_H / 2);
    const triangle = new Polygon([[apex, pt(-TRI_W / 2, -TRI_H / 2), pt(TRI_W / 2, -TRI_H / 2), apex]]);
    styles.push(...cased(rgb, triangle, alpha, 1.25));

    // Heading line: solid, thinner than the speed vector, origin at the apex.
    // Only drawn when true heading exists — with COG-only data the triangle
    // orientation and the vector already show the direction.
    if (state.heading != null) {
      const headingEnd = pt(0, TRI_H / 2 + HEADING_LEN);
      styles.push(...cased(rgb, new LineString([apex, headingEnd]), alpha, 1));
      // Turn flag: fixed length, to the side the vessel is turning.
      if (state.rot != null && state.rot !== 0) {
        const side = state.rot > 0 ? 1 : -1;
        styles.push(...cased(rgb, new LineString([headingEnd, pt(side * TURN_FLAG, TRI_H / 2 + HEADING_LEN)]), alpha, 1));
      }
    }

    // COG/SOG vector from the reported position: short dashes, spaces about
    // twice the line width; length = the vessel's VECTOR_MINUTES run over
    // ground, scaled to Web-Mercator units by 1/cos(lat).
    if (state.cog != null && state.sogKn != null && state.sogKn >= MIN_VECTOR_SOG_KN && state.lat != null) {
      const rad = (state.cog * Math.PI) / 180;
      const groundMeters = state.sogKn * 1852 * (VECTOR_MINUTES / 60);
      const len = groundMeters / Math.cos((state.lat * Math.PI) / 180);
      const end = [center[0] + Math.sin(rad) * len, center[1] + Math.cos(rad) * len];
      styles.push(...cased(rgb, new LineString([center, end]), alpha, 1.5, [3, 3]));
    }

    // Two-line label: direction, then speed. Below the symbol when the
    // heading points up-screen (the heading line occupies the space above),
    // above it when pointing down.
    const lines = [];
    if (resolution <= labelMaxResolution) {
      // A named target says its name first — for own ship there is nothing to
      // say, but a rescue vessel is worth identifying before its heading.
      if (state.name) lines.push(state.name);
      const underWay = state.sogKn != null && state.sogKn >= MIN_VECTOR_SOG_KN;
      if (!courseWhenUnderWay || underWay) {
        if (orientDeg != null) lines.push(`${Math.round(((orientDeg % 360) + 360) % 360)}°`);
        if (state.sogKn != null) lines.push(`${state.sogKn.toFixed(1).replace('.', ',')} kn`);
      }
    }
    if (lines.length) {
      const offsetY = cos >= 0 ? 36 : -36;
      styles.push(new Style({
        text: new Text({
          text: lines.join('\n'),
          font: '11px Roboto, sans-serif',
          textAlign: 'center',
          offsetY,
          ...(labelAlwaysDrawn ? { declutterMode: 'none' } : {}),
          fill: new Fill({ color: `rgba(255, 255, 255, ${alpha})` }),
          stroke: new Stroke({ color: `rgba(0, 0, 0, ${0.8 * alpha})`, width: 3 }),
        }),
      }));
    }

    return styles;
  };
}
