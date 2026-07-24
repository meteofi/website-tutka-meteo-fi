// Convert a SeeYou/Naviter CUP waypoint file into the bundled turnpoints
// GeoJSON snapshot (src/data/turnpoints-finland.geojson), the same way the
// airfields/radars snapshots are consumed by pane.js.
//
//   node scripts/convert-turnpoints.mjs [in.cup] [out.geojson]
//
// CUP format: https://github.com/naviter/seeyou_file_formats/blob/main/CUP_file_format.md
// Header: name,code,country,lat,lon,elev,style,rwdir,rwlen,rwwidth,freq,desc,userdata,pics
// Coordinates are degrees+decimal-minutes: lat DDMM.MMM{N|S}, lon DDDMM.MMM{E|W}.
// A "-----Related Tasks-----" line ends the waypoint section (ignored here).
import fs from 'fs';

const inPath = process.argv[2] || 'scripts/turnpoints-finland.cup';
const outPath = process.argv[3] || 'src/data/turnpoints-finland.geojson';

// CSV line split honouring double-quoted fields (which may contain commas).
function splitCsv(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') { inQuotes = false; } else { cur += c; }
    } else if (c === '"') { inQuotes = true; } else if (c === ',') { out.push(cur); cur = ''; } else { cur += c; }
  }
  out.push(cur);
  return out;
}

// "DDMM.MMM{N|S}" / "DDDMM.MMM{E|W}" → signed decimal degrees. Minutes are the
// last 6 chars (MM.MMM); everything before is degrees (2 for lat, 3 for lon).
function parseCoord(raw) {
  const dir = raw.slice(-1);
  const num = raw.slice(0, -1);
  const val = parseInt(num.slice(0, -6), 10) + parseFloat(num.slice(-6)) / 60;
  return (dir === 'S' || dir === 'W') ? -val : val;
}

function parseElev(raw) {
  if (!raw) return null;
  const v = parseFloat(raw);
  if (Number.isNaN(v)) return null;
  return Math.round(/ft/i.test(raw) ? v * 0.3048 : v); // metres
}

const lines = fs.readFileSync(inPath, 'utf8').split(/\r?\n/);
const features = [];
for (let i = 1; i < lines.length; i += 1) {
  const line = lines[i];
  if (line.startsWith('-----')) break; // Related Tasks section
  if (!line.trim()) continue; // eslint-disable-line no-continue
  const [name, code, , lat, lon, elev, style] = splitCsv(line);
  if (!name || !lat || !lon) continue; // eslint-disable-line no-continue
  const props = { name };
  if (code) props.code = code;
  const e = parseElev(elev);
  if (e != null) props.elev = e;
  props.style = Number.parseInt(style, 10) || 0;
  features.push({
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [Number(parseCoord(lon).toFixed(6)), Number(parseCoord(lat).toFixed(6))],
    },
    properties: props,
  });
}

fs.writeFileSync(outPath, JSON.stringify({ type: 'FeatureCollection', features }, null, 1));
console.log(`Wrote ${features.length} turnpoints → ${outPath}`);
