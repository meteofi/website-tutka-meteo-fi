// The station model: the classic synoptic plot, drawn per METAR.
//
//        15          1021        temperature upper-left, QNH upper-right
//          \       /
//           \  ___
//            \(   )-----\\\     circle filled by cloud cover in oktas,
//             (___)             wind barb pointing FROM the wind's direction
//           /
//        11                     dew point lower-left
//
// Nothing in this repo drew any of this: obsStyles.js has a rotated arrow and a
// number, and no barb, okta or multi-slot layout existed. So the geometry is new,
// but the technique is borrowed from stormCells.js — build the glyph as vector
// geometry scaled by `resolution`, which holds a constant SCREEN size at every
// zoom. An Icon would need one bitmap per wind speed; a Text glyph cannot be
// rotated to a wind direction and still read.
//
// The barb geometry is split out and pure so it can be unit-tested: a barb that
// is wrong by one feather is wrong by 5 knots, and nobody would catch that by
// eye on a map.

import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import Point from 'ol/geom/Point';
import Polygon from 'ol/geom/Polygon';
import {
  Circle as CircleStyle, Fill, Stroke, Style, Text,
} from 'ol/style';

// Screen pixels. The plot is sized so the four text slots clear the circle and
// the barb at the label font size, and so two adjacent aerodromes do not touch
// at the zoom where the layer appears.
const CIRCLE_R = 6;
const BARB_LEN = 26;
const FEATHER_LEN = 9;
const FEATHER_STEP = 4.5;
const PENNANT_W = 5;
const TEXT_DX = 13;
const TEXT_DY = 9;

// Flight category is the first thing a pilot reads, so it colours the circle.
// The standard aviation colours, which pilots already know from every briefing
// tool, and which survive both basemaps.
export const CATEGORY_COLORS = {
  VFR: 'rgb(0, 168, 62)',
  MVFR: 'rgb(37, 128, 235)',
  IFR: 'rgb(224, 36, 36)',
  LIFR: 'rgb(191, 63, 191)',
};

// How many pennants (50 kt), full feathers (10) and half feathers (5) a speed
// makes. Rounded to the nearest 5 kt, which is how barbs are always drawn.
//
// Pure and exported for the tests: this is the function whose off-by-one would
// be a silent 5-knot lie.
export function barbParts(speedKt) {
  const rounded = Math.round((Number.isFinite(speedKt) ? speedKt : 0) / 5) * 5;
  return {
    rounded,
    pennants: Math.floor(rounded / 50),
    full: Math.floor((rounded % 50) / 10),
    half: Math.floor((rounded % 10) / 5),
  };
}

// The barb, as line segments and pennant triangles in map coordinates.
//
// Points FROM the direction the wind blows from — the meteorological convention,
// and the opposite of an arrow showing where air is going. `stormCells.js` draws
// motion vectors the other way round for exactly that reason.
//
// The feathers sit on the LEFT of the shaft looking outward in the northern
// hemisphere. Since this app is Finland-only that is unconditional here.
function barbGeometry(center, directionDeg, speedKt, resolution) {
  const parts = barbParts(speedKt);
  const px = (n) => n * resolution;
  // Direction the wind comes FROM, as a unit vector pointing outward from the
  // station. Screen y is up in map coordinates, so cos/sin land as usual.
  const rad = (directionDeg * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = Math.cos(rad);
  // Perpendicular, for the feathers.
  const vx = -uy;
  const vy = ux;
  const at = (along, across) => [
    center[0] + ux * px(along) + vx * px(across),
    center[1] + uy * px(along) + vy * px(across),
  ];

  const lines = [];
  const polygons = [];
  const shaftStart = at(CIRCLE_R + 1, 0);
  const shaftEnd = at(CIRCLE_R + 1 + BARB_LEN, 0);
  lines.push(new LineString([shaftStart, shaftEnd]));

  // Feathers are laid from the OUTER end inward, which is the convention and
  // also what keeps a 5 kt half-feather off the circle.
  let along = CIRCLE_R + 1 + BARB_LEN;
  for (let i = 0; i < parts.pennants; i += 1) {
    polygons.push(new Polygon([[
      at(along, 0), at(along, FEATHER_LEN), at(along - PENNANT_W, 0), at(along, 0),
    ]]));
    along -= PENNANT_W + FEATHER_STEP * 0.5;
  }
  for (let i = 0; i < parts.full; i += 1) {
    lines.push(new LineString([at(along, 0), at(along - FEATHER_STEP, FEATHER_LEN)]));
    along -= FEATHER_STEP;
  }
  if (parts.half) {
    // A lone half feather is set in from the end, or it reads as a full one.
    if (parts.pennants === 0 && parts.full === 0) along -= FEATHER_STEP;
    lines.push(new LineString([at(along, 0), at(along - FEATHER_STEP / 2, FEATHER_LEN / 2)]));
  }
  return { lines, polygons };
}

// The okta circle: a disc whose fill shows total sky cover. Drawn as a filled
// wedge over an outlined circle, which is the classic rendering and reads at
// 12 px where separate okta glyphs would not.
function coverStyles(center, oktas, color, resolution, haloColor) {
  const styles = [];
  const outline = new Style({
    geometry: new Point(center),
    image: new CircleStyle({
      radius: CIRCLE_R,
      fill: new Fill({ color: haloColor }),
      stroke: new Stroke({ color, width: 1.6 }),
      declutterMode: 'none',
    }),
  });
  const filled = Math.max(0, Math.min(8, Number.isFinite(oktas) ? oktas : 0));
  if (filled >= 8) {
    styles.push(new Style({
      geometry: new Point(center),
      image: new CircleStyle({
        radius: CIRCLE_R,
        fill: new Fill({ color }),
        stroke: new Stroke({ color, width: 1.6 }),
        declutterMode: 'none',
      }),
    }));
    return styles;
  }
  styles.push(outline);
  if (filled > 0) {
    // A wedge from north, clockwise, covering filled/8 of the disc.
    const r = CIRCLE_R * resolution;
    const ring = [center];
    const steps = 24;
    const sweep = (filled / 8) * Math.PI * 2;
    for (let i = 0; i <= steps; i += 1) {
      const a = (i / steps) * sweep;
      ring.push([center[0] + Math.sin(a) * r, center[1] + Math.cos(a) * r]);
    }
    ring.push(center);
    styles.push(new Style({
      geometry: new Polygon([ring]),
      fill: new Fill({ color }),
    }));
  }
  return styles;
}

// One text slot of the model.
function slot(center, text, dx, dy, align, color, haloColor, resolution) {
  return new Style({
    geometry: new Point([center[0] + dx * resolution, center[1] + dy * resolution]),
    text: new Text({
      text,
      font: '600 11px Roboto, sans-serif',
      textAlign: align,
      textBaseline: 'middle',
      fill: new Fill({ color }),
      stroke: new Stroke({ color: haloColor, width: 3 }),
      // Never thinned away: the lesson from the glider readouts, where
      // decluttering removed almost every label exactly where the user had
      // zoomed in to read them.
      declutterMode: 'none',
    }),
  });
}

// The full plot for one station. `theme` picks the text and halo colours; the
// category colour is the same on both, being a standard.
export function createStationPlotStyle({ theme = 'light' } = {}) {
  const textColor = theme === 'dark' ? '#f0f0f0' : '#1a1a1a';
  const haloColor = theme === 'dark' ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.95)';

  return (feature, resolution) => {
    const report = feature.get('report');
    if (!report) return [];
    const center = feature.getGeometry().getCoordinates();
    const color = CATEGORY_COLORS[report.fltCat] || CATEGORY_COLORS.VFR;
    const styles = [];

    // Selection first, so the plot itself draws over it.
    if (feature.get('selected')) {
      styles.push(new Style({
        geometry: new Point(center),
        image: new CircleStyle({
          radius: 17,
          fill: null,
          stroke: new Stroke({ color: haloColor, width: 4.5 }),
          declutterMode: 'none',
        }),
      }), new Style({
        geometry: new Point(center),
        image: new CircleStyle({
          radius: 17,
          fill: null,
          stroke: new Stroke({ color, width: 2 }),
          declutterMode: 'none',
        }),
      }));
    }

    const { wind } = report;
    if (wind && !wind.calm && !wind.variable && Number.isFinite(wind.direction)) {
      const { lines, polygons } = barbGeometry(center, wind.direction, wind.speedKt, resolution);
      // A casing under the barb, so it stays legible over radar echo — the same
      // trick ownShipStyle.js uses for the AIS target.
      lines.forEach((geometry) => {
        styles.push(new Style({
          geometry,
          stroke: new Stroke({ color: haloColor, width: 3.4 }),
        }));
      });
      lines.forEach((geometry) => {
        styles.push(new Style({ geometry, stroke: new Stroke({ color, width: 1.6 }) }));
      });
      polygons.forEach((geometry) => {
        styles.push(new Style({
          geometry,
          fill: new Fill({ color }),
          stroke: new Stroke({ color, width: 1 }),
        }));
      });
    }

    styles.push(...coverStyles(center, report.oktas, color, resolution, haloColor));

    // Calm and variable winds have no barb to draw, so they say so instead —
    // an absent barb would otherwise be indistinguishable from missing data.
    if (wind && (wind.calm || wind.variable)) {
      const label = wind.calm ? 'CALM' : `VRB ${Math.round(wind.speedKt)}`;
      styles.push(slot(center, label, 0, -TEXT_DY - 8, 'center', textColor, haloColor, resolution));
    }

    const num = (v) => (Number.isFinite(v) ? String(Math.round(v)) : '');
    if (Number.isFinite(report.tempC)) {
      styles.push(slot(center, num(report.tempC), -TEXT_DX, TEXT_DY, 'right', textColor, haloColor, resolution));
    }
    if (Number.isFinite(report.dewpC)) {
      styles.push(slot(center, num(report.dewpC), -TEXT_DX, -TEXT_DY, 'right', textColor, haloColor, resolution));
    }
    if (Number.isFinite(report.qnhHpa)) {
      styles.push(slot(center, num(report.qnhHpa), TEXT_DX, TEXT_DY, 'left', textColor, haloColor, resolution));
    }
    // The ICAO code identifies the plot; without it a reader has numbers but no
    // idea which field they belong to.
    styles.push(slot(center, report.icao, TEXT_DX, -TEXT_DY, 'left', color, haloColor, resolution));
    return styles;
  };
}

// Exported for the layer: a plot needs its own Feature so it is culled by its own
// extent (the trap recorded in reference-openlayers-render-gotchas — a style
// geometry that extends past its feature disappears with it).
export function createPlotFeature(icao, coordinates) {
  const feature = new Feature({ geometry: new Point(coordinates) });
  feature.set('icao', icao, true);
  return feature;
}
