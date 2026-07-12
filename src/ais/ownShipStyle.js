// Own-position marker symbology.
//
// GPS keeps the classic blue dot (hoisted here from pane.js so the
// own-location controller can swap styles); AIS renders the ECDIS S-52
// own-ship symbol: double circle + true-heading line + dashed COG/SOG vector.
//
// The AIS style is a style FUNCTION reading the feature's 'aisState' property
// ({ heading, cog, sogKn, name, mmsi, lat, stale }), so per-report updates only
// need feature.set('aisState', …) + setGeometry — no restyling across panes.
// Heading/COG sentinel filtering happens in ownLocation.js; here null simply
// means "don't draw that part".
import {
  Circle as CircleStyle, Fill, Stroke, Style, Text,
} from 'ol/style';
import LineString from 'ol/geom/LineString';

// The blue GPS dot + white ring. One shared Style across panes is safe.
export const gpsPositionStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: '#3399CC' }),
    stroke: new Stroke({ color: '#fff', width: 2 }),
  }),
});

const OUTER_RADIUS = 9; // px
const INNER_RADIUS = 4.5; // px
const HEADING_LINE_PX = 26; // px from center; the circle covers the first 9
const VECTOR_MINUTES = 6; // ECDIS-style 6-minute run for the COG/SOG vector
const MIN_VECTOR_SOG_KN = 0.5; // below this the vector is noise, not motion

// Black symbol over a white casing reads on both the dark and light basemaps.
const ink = (alpha) => `rgba(20, 20, 20, ${alpha})`;
const casing = (alpha) => `rgba(255, 255, 255, ${0.9 * alpha})`;

function lineStyles(geometry, alpha, dashed) {
  const lineDash = dashed ? [6, 6] : undefined;
  return [
    new Style({ geometry, stroke: new Stroke({ color: casing(alpha), width: 4, lineDash }) }),
    new Style({ geometry, stroke: new Stroke({ color: ink(alpha), width: 1.75, lineDash }) }),
  ];
}

export function createOwnShipStyleFn() {
  return (feature, resolution) => {
    const geometry = feature.getGeometry();
    if (!geometry) return [];
    const state = feature.get('aisState') || {};
    const center = geometry.getCoordinates();
    const alpha = state.stale ? 0.5 : 1;

    const styles = [
      new Style({ image: new CircleStyle({ radius: OUTER_RADIUS, stroke: new Stroke({ color: casing(alpha), width: 4 }) }) }),
      new Style({ image: new CircleStyle({ radius: OUTER_RADIUS, stroke: new Stroke({ color: ink(alpha), width: 1.75 }) }) }),
      new Style({ image: new CircleStyle({ radius: INNER_RADIUS, stroke: new Stroke({ color: ink(alpha), width: 1.75 }) }) }),
    ];

    // True-heading line, falling back to COG. Screen-fixed length: px → map
    // units via resolution. sin/cos is enough because the view never rotates.
    const headingDeg = state.heading != null ? state.heading : state.cog;
    if (headingDeg != null) {
      const rad = (headingDeg * Math.PI) / 180;
      const len = HEADING_LINE_PX * resolution;
      const end = [center[0] + Math.sin(rad) * len, center[1] + Math.cos(rad) * len];
      styles.push(...lineStyles(new LineString([center, end]), alpha, false));
    }

    // Dashed COG/SOG vector: where the vessel will be in VECTOR_MINUTES at
    // current speed — ground meters scaled to Web-Mercator units by 1/cos(lat).
    if (state.cog != null && state.sogKn != null && state.sogKn >= MIN_VECTOR_SOG_KN && state.lat != null) {
      const rad = (state.cog * Math.PI) / 180;
      const groundMeters = state.sogKn * 1852 * (VECTOR_MINUTES / 60);
      const len = groundMeters / Math.cos((state.lat * Math.PI) / 180);
      const end = [center[0] + Math.sin(rad) * len, center[1] + Math.cos(rad) * len];
      styles.push(...lineStyles(new LineString([center, end]), alpha, true));
    }

    const label = state.name || state.mmsi || '';
    if (label) {
      const sogText = state.sogKn != null ? ` · ${state.sogKn.toFixed(1).replace('.', ',')} kn` : '';
      styles.push(new Style({
        text: new Text({
          text: `${label}${sogText}`,
          font: '12px Roboto, sans-serif',
          offsetY: 24,
          fill: new Fill({ color: `rgba(255, 255, 255, ${alpha})` }),
          stroke: new Stroke({ color: `rgba(0, 0, 0, ${0.8 * alpha})`, width: 3 }),
        }),
      }));
    }

    return styles;
  };
}
