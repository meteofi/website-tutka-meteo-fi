// Coverage outline for the active radar layer: a dashed rectangle drawn from
// the product's GetCapabilities `EX_GeographicBoundingBox` (parsed into
// `layerInfo[wmslayer].bbox` in radar.js's getLayerInfo), so a per-site or
// per-country product's edge reads as an edge instead of the map just running
// out of data. Same idea as the OGN subscription boundary in gliders.js.
//
// Per-pane, NOT shared like placeNames/gliders: split-screen panes can show
// different radar products (radarSite.js drills in independently per pane),
// so each pane needs its own feature/geometry rather than one mirrored across
// all of them.

import Feature from 'ol/Feature';
import LineString from 'ol/geom/LineString';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import { fromLonLat } from 'ol/proj';
import { Stroke, Style } from 'ol/style';

const PALETTES = {
  light: 'rgba(20,20,20,0.55)',
  dark: 'rgba(220,220,220,0.55)',
};

function makeStyle(theme) {
  return new Style({
    stroke: new Stroke({ color: PALETTES[theme], width: 1.5, lineDash: [7, 6] }),
  });
}

export const layerBboxStyleLight = makeStyle('light');
export const layerBboxStyleDark = makeStyle('dark');

// A lon/lat box maps to an exact rectangle in Web Mercator — meridians are
// vertical and parallels horizontal — so the four corners need no densifying
// (same reasoning as gliders.js's REGION_BBOX rectangle).
function rectangleFromBbox(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return new LineString([
    [minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat],
  ].map((c) => fromLonLat(c)));
}

// Pane factory (passed to createPane via paneDeps). Returns the layer to add
// to the pane's stack plus a setter the caller uses to update/clear the
// outline as the active radar product or its visibility changes.
export function createLayerBboxLayer() {
  const feature = new Feature();
  const source = new VectorSource({ features: [feature] });
  const layer = new VectorLayer({
    source,
    style: layerBboxStyleLight,
  });

  // bbox: [minLon, minLat, maxLon, maxLat] in EPSG:4326, or null/undefined to
  // clear the outline (no product selected, product hidden, or its
  // GetCapabilities bbox hasn't loaded yet).
  function setBbox(bbox) {
    feature.setGeometry(Array.isArray(bbox) ? rectangleFromBbox(bbox) : null);
  }

  return { layer, setBbox };
}
