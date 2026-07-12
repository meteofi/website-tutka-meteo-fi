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
const VECTOR_MINUTES = 6; // COG/SOG vector shows a 6-minute run
const MIN_VECTOR_SOG_KN = 0.5; // below this the vector is noise, not motion

// Thin dark lines over a subtle white casing read on both basemap themes.
const ink = (alpha) => `rgba(20, 20, 20, ${alpha})`;
const casing = (alpha) => `rgba(255, 255, 255, ${0.9 * alpha})`;

function cased(geometry, alpha, width, lineDash) {
  return [
    new Style({ geometry, stroke: new Stroke({ color: casing(alpha), width: width + 2, lineDash }) }),
    new Style({ geometry, stroke: new Stroke({ color: ink(alpha), width, lineDash }) }),
  ];
}

export function createOwnShipStyleFn() {
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

    // Triangle: reported position at centre, half the height.
    const apex = pt(0, TRI_H / 2);
    const triangle = new Polygon([[apex, pt(-TRI_W / 2, -TRI_H / 2), pt(TRI_W / 2, -TRI_H / 2), apex]]);
    styles.push(...cased(triangle, alpha, 1.25));

    // Heading line: solid, thinner than the speed vector, origin at the apex.
    // Only drawn when true heading exists — with COG-only data the triangle
    // orientation and the vector already show the direction.
    if (state.heading != null) {
      const headingEnd = pt(0, TRI_H / 2 + HEADING_LEN);
      styles.push(...cased(new LineString([apex, headingEnd]), alpha, 1));
      // Turn flag: fixed length, to the side the vessel is turning.
      if (state.rot != null && state.rot !== 0) {
        const side = state.rot > 0 ? 1 : -1;
        styles.push(...cased(new LineString([headingEnd, pt(side * TURN_FLAG, TRI_H / 2 + HEADING_LEN)]), alpha, 1));
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
      styles.push(...cased(new LineString([center, end]), alpha, 1.5, [3, 3]));
    }

    // Two-line label: direction, then speed. Below the symbol when the
    // heading points up-screen (the heading line occupies the space above),
    // above it when pointing down.
    const lines = [];
    if (orientDeg != null) lines.push(`${Math.round(((orientDeg % 360) + 360) % 360)}°`);
    if (state.sogKn != null) lines.push(`${state.sogKn.toFixed(1).replace('.', ',')} kn`);
    if (lines.length) {
      const offsetY = cos >= 0 ? 36 : -36;
      styles.push(new Style({
        text: new Text({
          text: lines.join('\n'),
          font: '11px Roboto, sans-serif',
          textAlign: 'center',
          offsetY,
          fill: new Fill({ color: `rgba(255, 255, 255, ${alpha})` }),
          stroke: new Stroke({ color: `rgba(0, 0, 0, ${0.8 * alpha})`, width: 3 }),
        }),
      }));
    }

    return styles;
  };
}
