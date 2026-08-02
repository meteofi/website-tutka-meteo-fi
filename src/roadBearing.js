// Road-direction geometry: turns a road-register direction ("increasing road
// address") into a real compass bearing, using Väylä's road-address network
// (`tiestotiedot:tieosoiteverkko` on the vaylapilvi OGC API — the same host the
// Vesiväylät layers already use, so it is in the CSP already).
//
// WHY THIS EXISTS. The Digitraffic weathercam preset says which way a camera
// looks only as a road-register enum — `INCREASING_DIRECTION` means "toward
// higher road addresses on this road", not an azimuth. There is no bearing
// anywhere in that API, and Väylä publishes no camera dataset. But the camera
// carries its own road address (road number, section, distance from section
// start), and the road-address network publishes each section's centreline with
// the address distance as the geometry's M ordinate — so the road's tangent at
// exactly that address IS the direction, and the enum only picks the sign.
//
// Measured against the live APIs on 2026-08-02:
//   * CQL2 filtering is supported and worth using: `filter=tie=51 AND osa=14`
//     with `filter-lang=cql2-text` returns the one section in ~7 kB, where a
//     bbox query around the same camera returns 64-80 kB of neighbouring roads.
//     There is no bbox to guess either — the road address identifies it exactly;
//   * a section resolves to 1-3 links: `ajorata` 0 for a single carriageway, or
//     1 and 2 for the two sides of a dual carriageway. The sides are parallel,
//     so picking the one nearest the camera is safe — the tangent is the same
//     either way, and the M ordinate (not vertex order) carries the direction;
//   * M is the distance from the section start, but does NOT always begin at 0
//     (a sampled section ran 420..3688), so the camera must be located by
//     matching its own `distanceFromRoadSectionStart` against M rather than by
//     assuming the section starts at zero;
//   * cameras sit close to their centreline — median 17 m, max 81 m over a
//     30-station sample — so the match is unambiguous in practice.
//
// SIGN CONVENTION, validated rather than assumed. Taking 32 presets whose name
// gives a destination town, computing the tangent here and comparing against the
// true bearing to that town, 30 of 32 agreed that `INCREASING_DIRECTION` runs
// along increasing road address (median angular error 27°, and near-zero on the
// cleanest cases). The residual error is mostly the validator's fault, not this
// module's: the named town is a median 40 km away, so the straight line to it is
// itself only a rough proxy for where the road points.
//
// Web Mercator is conformal and its meridians are vertical, so a true bearing
// maps to a grid bearing unchanged — no convergence correction is needed when
// drawing these in EPSG:3857.

const COLLECTION = 'https://avoinapi.vaylapilvi.fi/vaylatiedot/ogc/features/v1/collections/tiestotiedot:tieosoiteverkko/items';

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

// Initial great-circle bearing from [lon, lat] a to b, degrees clockwise from
// north.
export function bearingBetween(a, b) {
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLon = toRad(b[0] - a[0]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Rough metres between two [lon, lat] — only ever used to compare candidates a
// few tens of metres apart, so the cosine approximation is ample.
function metresBetween(a, b) {
  const x = (b[0] - a[0]) * Math.cos(toRad(a[1])) * 111320;
  const y = (b[1] - a[1]) * 110540;
  return Math.hypot(x, y);
}

// A section link is a LineString, or a MultiLineString whose first part carries
// the geometry.
function vertices(geometry) {
  if (!geometry) return null;
  const c = geometry.coordinates;
  if (!c || !c.length) return null;
  const line = Array.isArray(c[0][0]) ? c[0] : c;
  return line && line.length >= 2 ? line : null;
}

// Dual carriageways return one link per side; they run parallel, so the nearest
// is both the right one and the one whose tangent we would have got anyway.
export function pickLink(features, lonLat) {
  let best = null;
  let bestDist = Infinity;
  (features || []).forEach((f) => {
    const line = vertices(f.geometry);
    if (!line) return;
    let d = Infinity;
    for (const v of line) d = Math.min(d, metresBetween(lonLat, v));
    if (d < bestDist) { bestDist = d; best = f; }
  });
  return best ? { link: best, distanceM: bestDist } : null;
}

// Bearing of the road at the given road-address distance, in the direction of
// INCREASING address. `distanceM` may be null, in which case the camera's own
// position locates it instead.
export function tangentAt(link, distanceM, lonLat) {
  const line = vertices(link && link.geometry);
  if (!line) return null;
  const hasM = line[0].length >= 4;
  let i;
  if (hasM && Number.isFinite(distanceM)) {
    // Locate by road address, not by proximity: a section can pass near a
    // camera twice (a loop or a hairpin), and the address is unambiguous.
    let bestDelta = Infinity;
    line.forEach((v, k) => {
      const delta = Math.abs(v[3] - distanceM);
      if (delta < bestDelta) { bestDelta = delta; i = k; }
    });
  } else if (lonLat) {
    let bestDist = Infinity;
    line.forEach((v, k) => {
      const d = metresBetween(lonLat, v);
      if (d < bestDist) { bestDist = d; i = k; }
    });
  } else {
    return null;
  }

  // A window of a few vertices smooths out the metre-scale jitter of the
  // centreline without flattening a genuine curve.
  const lo = Math.max(0, i - 2);
  const hi = Math.min(line.length - 1, i + 2);
  if (lo === hi) return null;
  const bearing = bearingBetween(line[lo], line[hi]);
  // Vertex order is not guaranteed to follow increasing address — the M
  // ordinate is what says which way the road counts up.
  const ascending = !hasM || line[line.length - 1][3] >= line[0][3];
  return ascending ? bearing : (bearing + 180) % 360;
}

// Apply the preset's road-register direction to the road tangent. Anything that
// is not plainly along this road returns null and draws no cone: SPECIAL_DIRECTION
// is a road-surface or scenery view, CROSSING_ROAD_* looks along a road we have
// not resolved, and UNKNOWN means the operator never recorded it.
export function bearingForDirection(tangentDeg, direction) {
  if (!Number.isFinite(tangentDeg)) return null;
  if (direction === 'INCREASING_DIRECTION') return tangentDeg;
  if (direction === 'DECREASING_DIRECTION') return (tangentDeg + 180) % 360;
  return null;
}

// Deterministic URL for one road section. Parameter order is fixed so repeated
// opens of the same camera hit the browser cache (the requestShape.js rule
// applied to an OGC API).
export function roadSectionUrl(roadNumber, roadSection) {
  const filter = encodeURIComponent(`tie=${roadNumber} AND osa=${roadSection}`);
  return `${COLLECTION}?f=application%2Fgeo%2Bjson&limit=20&filter-lang=cql2-text&filter=${filter}`;
}

// The road tangent at a camera, or null when the road address cannot be
// resolved. Network failures resolve to null rather than rejecting — a missing
// direction cone must never break opening a camera.
export function fetchRoadTangent(roadAddress, lonLat) {
  const roadNumber = roadAddress && roadAddress.roadNumber;
  const roadSection = roadAddress && roadAddress.roadSection;
  if (!Number.isFinite(roadNumber) || !Number.isFinite(roadSection)) return Promise.resolve(null);
  return fetch(roadSectionUrl(roadNumber, roadSection))
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((json) => {
      const picked = pickLink(json.features, lonLat);
      if (!picked) return null;
      return tangentAt(
        picked.link,
        Number.isFinite(roadAddress.distanceFromRoadSectionStart)
          ? roadAddress.distanceFromRoadSectionStart
          : null,
        lonLat,
      );
    })
    .catch((err) => {
      console.warn(`Road direction unavailable: ${err}`); // eslint-disable-line no-console
      return null;
    });
}
