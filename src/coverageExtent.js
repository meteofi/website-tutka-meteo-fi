// Where a product's advertised coverage (GetCapabilities
// EX_GeographicBoundingBox, parsed into layerInfo[...].bbox) lies on the map,
// for the radar and satellite menus' recentre-on-pick (radar.js
// fitToLayerExtent).
//
// A geostationary full disk that straddles the antimeridian (GOES-West at
// 137°W, Himawari-9 at 140.7°E) advertises west > east, which transformExtent
// turns into an inverted box: nothing ever intersects it and View.fit lands
// nowhere sensible. The east edge is unwrapped past 180° so the box is
// contiguous, then the whole box is shifted by one world if its centre fell
// past 180° — the fitted view centre (what metPosition and the URL hash
// persist) stays on the primary world. The shared View leaves x unconstrained
// and MeteoCore wraps a GetMap bbox past ±180°, so the part of the box over
// the edge still draws.

import { transformExtent } from 'ol/proj';
import { getWidth, intersects } from 'ol/extent';

// bbox: [west, south, east, north] in degrees. Returns the extent in
// `projection`, or null when the transform degenerates.
export function coverageExtent(bbox, projection) {
  const [west, south, east, north] = bbox;
  const unwrappedEast = east < west ? east + 360 : east;
  const shift = (west + unwrappedEast) / 2 > 180 ? -360 : 0;
  const extent = transformExtent(
    [west + shift, south, unwrappedEast + shift, north],
    'EPSG:4326',
    projection,
  );
  return extent.every(Number.isFinite) ? extent : null;
}

// Whether any world copy of `extent` overlaps `viewExtent`. Near the
// antimeridian the view and a coverage box can describe the same place on
// neighbouring world copies (view at 170°W, Himawari's box ending at 222°E).
export function coverageOnScreen(viewExtent, extent, projection) {
  const world = getWidth(projection.getExtent());
  return [-world, 0, world].some((dx) => intersects(
    viewExtent,
    [extent[0] + dx, extent[1], extent[2] + dx, extent[3]],
  ));
}
