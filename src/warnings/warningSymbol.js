import { LEVELS } from './warningData';

// Shared vector artwork keeps the map and warning headings recognizable at
// phone sizes, without depending on a platform's weather/Unicode font glyphs.
const PATHS = {
  1: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h5a3 3 0 1 1-3 3"/>',
  3: '<path d="m13 2-9 12h7l-1 8L20 9h-8z" fill="#191b22" stroke-width="1"/>',
  10: '<path d="M6 14a4 4 0 1 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 1 9H6M7 17l-2 4m8-4-2 4m8-4-2 4"/>',
};
const cache = new Map();

export default function warningSymbol(type, level) {
  const key = `${type}:${level}`;
  if (!cache.has(key)) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">'
      + '<rect x="1" y="1" width="38" height="38" rx="5" fill="#fff"/>'
      + `<rect x="3" y="3" width="34" height="34" rx="3" fill="${LEVELS[level].color}" stroke="#191b22" stroke-width="2"/>`
      + `<g transform="translate(8 8)" fill="none" stroke="#191b22" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${PATHS[type]}</g></svg>`;
    cache.set(key, `data:image/svg+xml,${encodeURIComponent(svg)}`);
  }
  return cache.get(key);
}
