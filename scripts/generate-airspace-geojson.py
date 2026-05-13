#!/usr/bin/env python3
"""
Generate a GeoJSON FeatureCollection of Finnish airspace blocks from the
Finnish eAIP ENR 2.1 page.

Usage:
    python3 scripts/generate-airspace-geojson.py [SOURCE_URL] > assets/airspace-finland.json

Default SOURCE_URL points at the current AIRAC cycle; bump it when a new
cycle is published (see ais.fi). Each `<table>` on that page describes
one airspace block. The boundary is a sequence of dotted-decimal-minute
DMS coordinates joined by " - ", optionally with one or more "along
Finland_<country> border up to <coord>" segments.

Border-segment approximation: the script renders an "along border"
segment as a straight geodesic line between the previous coordinate and
the next named coordinate. At the scale of a weather-radar overlay
(zoom 5-10, ~1 km/pixel) this is visually indistinguishable from the
true border for the airspace blocks that touch Russia, Sweden, or
Norway. If a future use case demands border-following polylines, swap
the substitution for a clip against an actual border dataset.
"""
import json
import re
import sys
import urllib.request

DEFAULT_URL = (
    'https://www.ais.fi/eaip/002-2026_2026_04_16/eAIP/'
    'EF-ENR%202.1-fi-FI.html'
)

DMS_PATTERN = re.compile(r'(\d{2})(\d{2})(\d{2})N\s*(\d{3})(\d{2})(\d{2})E')
BORDER_CONNECTIVE = re.compile(
    r'(?:then\s+)?along\s+Finland_(?:Russia|Sweden|Norway)\s+border\s+up\s+to\s+',
    re.IGNORECASE,
)


def dms_to_decimal(text):
    """Parse '604913N 0244656E' (NBSP-separated) to [lon, lat] in degrees."""
    m = DMS_PATTERN.match(text.replace('\xa0', ' '))
    if not m:
        return None
    latd, latm, lats, lond, lonm, lons = map(int, m.groups())
    lat = latd + latm / 60 + lats / 3600
    lon = lond + lonm / 60 + lons / 3600
    return [round(lon, 6), round(lat, 6)]


def parse_boundary(text):
    """
    Convert a "Lateral limits" description into a closed list of [lon, lat]
    vertices.

    Strategy: strip the "(then )?along Finland_X border up to" connective
    so border segments collapse to straight geodesic lines between the
    eAIP-named endpoints, then tokenize on " - " and " then ". This is a
    deliberate approximation — sufficient for radar-overlay scales, not
    authoritative for navigation. The 'point of origin' sentinel closes
    the ring.
    """
    text = ' '.join(text.split())
    m = re.search(r'Area bounded by lines joining points\s+(.+)', text, re.IGNORECASE)
    if not m:
        return None
    body = m.group(1).split('.', 1)[0]
    body = BORDER_CONNECTIVE.sub(' - ', body)

    points = []
    for tok in re.split(r'\s*-\s*|\s+then\s+|\s+to\s+', body):
        tok = tok.strip()
        if not tok or 'point of origin' in tok.lower():
            continue
        coord = dms_to_decimal(tok)
        if coord:
            points.append(coord)
    if len(points) < 3:
        return None
    if points[0] != points[-1]:
        points.append(points[0])
    return points


def classify(name):
    """Pick a coarse type tag from the airspace name."""
    upper = name.upper()
    for key in ('ACC SECT', 'FIR', 'UIR', 'UTA', 'CTA', 'TMA', 'CTR', 'FIZ', 'RMZ', 'TMZ'):
        if key in upper:
            return key.replace(' ', '_')
    return 'OTHER'


def parse_tables(html):
    """Yield (name, lateral_text, vertical_text) for each airspace table."""
    tables = re.findall(r'<table[^>]*>(.*?)</table>', html, re.DOTALL)
    for table in tables:
        cells = []
        for row in re.findall(r'<tr[^>]*>(.*?)</tr>', table, re.DOTALL):
            for cell in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', row, re.DOTALL):
                stripped = re.sub(r'<[^>]+>', ' ', cell)
                stripped = re.sub(r'\s+', ' ', stripped).strip()
                if stripped:
                    cells.append(stripped)
        # Find the lateral-limits cell; the name is whatever non-empty cell
        # precedes it, vertical limits the one immediately after.
        for i, cell in enumerate(cells):
            if cell.startswith('Area bounded by lines joining points'):
                name = cells[i - 1] if i > 0 else ''
                vertical = cells[i + 1] if i + 1 < len(cells) else ''
                yield name, cell, vertical
                break


def parse_vertical(text):
    """
    Split a vertical-limits string into (upper, lower). The eAIP encodes it
    as 'UPPER/LOWER' (e.g. 'FL 660/SFC', '2500 FT MSL/1300 FT MSL').
    Some cells also list the airspace class after the limits — preserved
    as `class_text` in the output.
    """
    parts = text.split(' AIRSPACE CLASS ', 1)
    limits = parts[0].strip()
    class_text = parts[1].strip() if len(parts) > 1 else None
    if '/' in limits:
        upper, lower = (s.strip() for s in limits.split('/', 1))
    else:
        upper, lower = limits, None
    return upper, lower, class_text


def main(url):
    sys.stderr.write(f'Fetching {url}\n')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as resp:
        html = resp.read().decode('utf-8')

    features = []
    skipped = []
    for name, lateral, vertical in parse_tables(html):
        coords = parse_boundary(lateral)
        if coords is None:
            skipped.append(name)
            continue
        upper, lower, class_text = parse_vertical(vertical)
        features.append({
            'type': 'Feature',
            'geometry': {
                'type': 'Polygon',
                'coordinates': [coords],
            },
            'properties': {
                'name': name,
                'type': classify(name),
                'upper': upper,
                'lower': lower,
                'class': class_text,
            },
        })

    sys.stderr.write(f'Parsed {len(features)} airspace blocks, skipped {len(skipped)}\n')
    if skipped:
        sys.stderr.write(f'  skipped: {skipped[:5]}{"..." if len(skipped) > 5 else ""}\n')

    collection = {
        'type': 'FeatureCollection',
        'metadata': {
            'source': url,
            'note': (
                "Border segments ('along Finland_X border up to Y') "
                "are approximated as straight geodesic lines between "
                "the named eAIP waypoints. Sufficient for radar-overlay "
                "scales; not authoritative for navigation."
            ),
        },
        'features': features,
    }
    print(json.dumps(collection, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL)
