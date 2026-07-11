// Client-side observation symbology — ports of the GeoServer SLDs the WMS
// obs raster rendered, one style function per `observation:*` product.
//
// Porting notes (kept faithful on purpose — the flag flip must be a visual
// no-op except for sharpness):
//   - SLD Halo radius r ≈ canvas text stroke width 2r (the stroke straddles
//     the glyph edge, halo grows outward only).
//   - The SLDs say font-family Lato, but the app never loads Lato — GeoServer
//     substituted its own fallback. The app ships Roboto for all UI text, so
//     labels use Roboto and render at full devicePixelRatio (the obs raster
//     was the reason requestShape.js caps WMS DPR at 1).
//   - Label formats match SLD numberFormat: temperature/dew point `#0.0` +
//     '°' (dot decimal), RH and winds bare integers.
//   - Wind & gust had no SLD worth porting; their scale is the FMI 10-min
//     mean wind classification (tyyntä → hirmumyrskyä), colored to escalate
//     through hues the other products already use.
//
// A style function returning `undefined` skips the feature — that is how a
// station with no fresh-enough observation for the current frame disappears,
// matching the WMS raster's TIME=PT10M window semantics.

import {
  Fill, Icon, Stroke, Style, Text,
} from 'ol/style';

const FONT_LG = 'bold 16px Roboto, sans-serif';
const FONT_SM = 'bold 14px Roboto, sans-serif';

// SLD halos: warm temperature bins use a soft black halo (opacity 0.7,
// radius 1.5), cold bins a hard thin #232323 (radius 1); RH/wind use a hard
// #232323 at radius 1.5.
const HALO_SOFT = new Stroke({ color: 'rgba(0, 0, 0, 0.7)', width: 3 });
const HALO_HARD = new Stroke({ color: '#232323', width: 2 });
const HALO_HARD_WIDE = new Stroke({ color: '#232323', width: 3 });

const fillCache = new Map();
function fillFor(color) {
  if (!fillCache.has(color)) fillCache.set(color, new Fill({ color }));
  return fillCache.get(color);
}

// Temperature °C (also dew point — "same as temperature" per the style
// owner). Ten bins from the GeoServer SLD, warm→cold.
function tempBin(v) {
  if (v >= 35) return { color: '#ff82e7', halo: HALO_SOFT };
  if (v >= 30) return { color: '#e1a0d5', halo: HALO_SOFT };
  if (v >= 25) return { color: '#ff4554', halo: HALO_SOFT };
  if (v >= 20) return { color: '#ffc06f', halo: HALO_SOFT };
  if (v >= 15) return { color: '#FBF366', halo: HALO_SOFT };
  if (v >= 10) return { color: '#6BFB66', halo: HALO_SOFT };
  if (v >= 5) return { color: '#86EE95', halo: HALO_HARD };
  if (v >= 0) return { color: '#86EEE0', halo: HALO_HARD };
  if (v >= -5) return { color: '#86D1EE', halo: HALO_HARD };
  return { color: '#86A0EE', halo: HALO_HARD };
}

// Relative humidity % — four bins from the GeoServer SLD.
function rhColor(v) {
  if (v <= 30) return '#FF6B6B';
  if (v <= 60) return '#FFC75F';
  if (v <= 80) return '#6BCB77';
  return '#4D96FF';
}

// FMI 10-min mean wind classification, by rounded m/s. Colors escalate
// through hues already used by the other products (RH green/red, temperature
// yellow/orange, temperature-extreme violet/pink), so the palette reads as
// one family across products.
function windColor(rounded) {
  if (rounded <= 0) return '#B0BEC5'; // tyyntä
  if (rounded <= 3) return '#6BCB77'; // heikkoa tuulta
  if (rounded <= 7) return '#FBF366'; // kohtalaista tuulta
  if (rounded <= 13) return '#FFC06F'; // navakkaa tuulta
  if (rounded <= 20) return '#FF6B6B'; // kovaa tuulta
  if (rounded <= 32) return '#D16BFF'; // myrskyä
  return '#FF82E7'; // hirmumyrskyä
}

function labelStyle(label, font, color, halo) {
  return new Style({
    text: new Text({
      text: label, font, fill: fillFor(color), stroke: halo,
    }),
  });
}

// Flow arrow for the combined wind product: drawn pointing up (head at top)
// with the dark outline baked into the SVG (Icon has no halo equivalent),
// then rotated to point downwind. One data URI per bin color.
const arrowSrcCache = new Map();
function arrowSrc(color) {
  if (!arrowSrcCache.has(color)) {
    const path = 'M13 3 L13 23 M13 3 L8 9.5 M13 3 L18 9.5';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 26 26">'
      + '<g fill="none" stroke-linecap="round" stroke-linejoin="round">'
      + `<path d="${path}" stroke="#232323" stroke-width="5"/>`
      + `<path d="${path}" stroke="${color}" stroke-width="2.5"/>`
      + '</g></svg>';
    arrowSrcCache.set(color, `data:image/svg+xml,${encodeURIComponent(svg)}`);
  }
  return arrowSrcCache.get(color);
}

const DEG_TO_RAD = Math.PI / 180;

// Wind + direction composite: colored flow arrow with the rounded speed to
// its right. Calm (0 m/s) or missing direction degrades to the number alone.
function windCompositeStyle(speed, direction) {
  const rounded = Math.round(speed);
  const color = windColor(rounded);
  const label = new Style({
    text: new Text({
      text: String(rounded),
      font: FONT_SM,
      fill: fillFor(color),
      stroke: HALO_HARD_WIDE,
      offsetX: 14,
      textAlign: 'left',
    }),
  });
  if (rounded <= 0 || !Number.isFinite(direction)) return label;
  const arrow = new Style({
    image: new Icon({
      src: arrowSrc(color),
      // wind_from_direction is where the wind comes FROM; the arrow points
      // the way the air moves. rotateWithView keeps it geographic.
      rotation: ((direction + 180) % 360) * DEG_TO_RAD,
      rotateWithView: true,
    }),
  });
  return [arrow, label];
}

// One entry per `observation:*` product: which EDR parameters it reads and
// how a frame value (or [speed, direction] pair) becomes a Style.
const RENDERERS = {
  'observation:airtemperature': {
    params: ['air_temperature'],
    style: (v) => labelStyle(`${v[0].toFixed(1)}°`, FONT_LG, tempBin(v[0]).color, tempBin(v[0]).halo),
  },
  'observation:dew_point_temperature': {
    params: ['dew_point_temperature'],
    style: (v) => labelStyle(`${v[0].toFixed(1)}°`, FONT_LG, tempBin(v[0]).color, tempBin(v[0]).halo),
  },
  'observation:relative_humidity': {
    params: ['relative_humidity'],
    style: (v) => labelStyle(String(Math.round(v[0])), FONT_SM, rhColor(v[0]), HALO_HARD_WIDE),
  },
  'observation:wind_speed': {
    params: ['wind_speed'],
    style: (v) => labelStyle(String(Math.round(v[0])), FONT_SM, windColor(Math.round(v[0])), HALO_HARD_WIDE),
  },
  'observation:wind_speed_of_gust': {
    params: ['wind_speed_of_gust'],
    style: (v) => labelStyle(String(Math.round(v[0])), FONT_SM, windColor(Math.round(v[0])), HALO_HARD_WIDE),
  },
  'observation:wind': {
    params: ['wind_speed', 'wind_from_direction'],
    // Direction may be NaN independently of speed; only speed gates drawing.
    requiredParams: 1,
    style: (v) => windCompositeStyle(v[0], v[1]),
  },
};

// Build the per-feature style function for one pane's observation layer.
// `getProduct` / `getFrameIndex` are read per call: the pane's product can
// change (pill long-press menu) and the frame index advances every playback
// tick — the layer just re-renders, the function stays attached.
export default function createObsStyle({ getProduct, getFrameIndex }) {
  return (feature) => {
    const renderer = RENDERERS[getProduct()];
    if (!renderer) return undefined;
    const obs = feature.get('obs');
    if (!obs) return undefined;
    const frame = getFrameIndex();
    const values = [];
    const required = renderer.requiredParams || renderer.params.length;
    for (let i = 0; i < renderer.params.length; i += 1) {
      const series = obs[renderer.params[i]];
      values.push(series ? series[frame] : NaN);
    }
    for (let i = 0; i < required; i += 1) {
      if (!Number.isFinite(values[i])) return undefined;
    }
    return renderer.style(values);
  };
}
