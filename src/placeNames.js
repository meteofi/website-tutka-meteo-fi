// Place-name labels (Nimistö © Maanmittauslaitos, CC BY 4.0) — the client-
// rendered replacement for the ArcGIS reference (label) tile layers. The data
// is a bundled snapshot of the MML geographic names service, regenerated with
// scripts/fetch-placenames.mjs and emitted as a hashed immutable asset (see
// the .geojson rule in webpack.config.js).
//
// One shared VectorSource feeds a per-pane VectorLayer (OL layers can't be
// shared across maps), so split-screen costs no extra fetches or parsing.
// Each feature carries minimal properties: n = name, s = scaleRelevance band
// (500k/1M/2M/8M), c = style class (c city, a settlement, w water, t terrain).
// The layer is wall-clock static: no FramePool, no setTime coupling.

import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import GeoJSON from 'ol/format/GeoJSON';
import {
  Fill, Stroke, Style, Text,
} from 'ol/style';
import placeNamesUrl from './data/placenames-fi.geojson';

// View resolution (m/px) above which only names of at least this
// scaleRelevance render. Boundaries sit at Web-Mercator z ≈ 6.75 / 7.75 /
// 9.75: whole country -> the 19 big cities, each step adds detail. The
// full 500k band (7.4k village-level names, ~4x the 1M band) deliberately
// enters two steps after 1M — at z8.75 it buried the radar picture.
function minBandForResolution(resolution) {
  if (resolution > 1450) return 8000000;
  if (resolution > 725) return 2000000;
  if (resolution > 181) return 1000000;
  return 500000;
}

const FONT_SIZE_BY_BAND = {
  8000000: 14,
  2000000: 13,
  1000000: 12,
  500000: 11,
};

// Same halo-inversion rationale as icaoTextColors in radar.js: the halo must
// sink into the basemap, not ring the text. Water names get the classic
// cartographic blue (lifted for the dark basemap), terrain a muted olive so
// nature names read as background against settlements. Dark fills stay dim
// (icaoTextColors territory, ~#ccc and below) with a thin low-alpha halo —
// brighter fills read as white-outlined text glaring over the dark radar.
const PALETTES = {
  light: {
    halo: 'rgba(255,255,255,0.85)',
    haloWidth: 2.5,
    c: '#1a1a1a',
    a: '#3d3d3d',
    w: '#2a5d8f',
    t: '#5f5f4d',
  },
  dark: {
    halo: 'rgba(0,0,0,0.55)',
    haloWidth: 2,
    c: '#cfcfcf',
    a: '#a8a8a8',
    w: '#7fa3c4',
    t: '#93937c',
  },
};

// One cached Style per (theme, class, band); the style function stamps the
// per-feature text into the shared instance (the radarStyle/icaoStyle
// pattern). `styleCache` is a plain JS Map — no OL Map import in this file.
function makeStyleFunction(theme) {
  const palette = PALETTES[theme];
  const styleCache = new Map();
  return (feature, resolution) => {
    const band = feature.get('s');
    if (band < minBandForResolution(resolution)) return null;
    const cls = feature.get('c');
    const key = `${cls}/${band}`;
    let style = styleCache.get(key);
    if (!style) {
      const size = FONT_SIZE_BY_BAND[band] || 11;
      const slant = cls === 'w' ? 'italic ' : '';
      const weight = cls === 'c' ? '500 ' : '';
      style = new Style({
        text: new Text({
          font: `${slant}${weight}${size}px Roboto, sans-serif`,
          fill: new Fill({ color: palette[cls] || palette.a }),
          stroke: new Stroke({ color: palette.halo, width: palette.haloWidth }),
        }),
      });
      styleCache.set(key, style);
    }
    style.getText().setText(feature.get('n'));
    return style;
  };
}

export const placeNamesStyleLight = makeStyleFunction('light');
export const placeNamesStyleDark = makeStyleFunction('dark');

let sharedSource = null;
function getSharedSource() {
  if (!sharedSource) {
    sharedSource = new VectorSource({
      url: placeNamesUrl,
      format: new GeoJSON(),
      attributions: 'Nimistö © Maanmittauslaitos',
    });
  }
  return sharedSource;
}

// Pane factory (passed to createPane via paneDeps). Starts on the light
// style like municipalityLayer; setMapLayer in radar.js swaps the style on
// theme changes and on every new-pane init.
export function createPlaceNamesLayer() {
  return new VectorLayer({
    source: getSharedSource(),
    // Private declutter group: layers sharing a declutter value are
    // decluttered TOGETHER, topmost layer first — with plain `true` the
    // observation layer's symbols (obsLayer.js, also declutter: true,
    // higher in the stack) knocked out place names, major cities included.
    // Names must only declutter against other names.
    declutter: 'place-names',
    // Within a layer, first-rendered wins declutter collisions, so render
    // coarser (more important) bands first; ties break alphabetically for a
    // stable label set frame-to-frame.
    renderOrder: (a, b) => (b.get('s') - a.get('s')) || (a.get('n') < b.get('n') ? -1 : 1),
    style: placeNamesStyleLight,
  });
}
