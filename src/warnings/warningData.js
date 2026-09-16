// CAP transport/normalization is independent of OpenLayers so a future vector
// tile source can reuse the warning model and sheet without changing radar.js.
export const WARNING_URL = 'https://meteocore.app.meteo.fi/features/collections/cap-meteoalarm-wis2/items';
export const WARNING_TYPES = {
  1: { label: 'Tuulivaroitukset', singular: 'tuulivaroitus', symbol: '≋' },
  3: { label: 'Ukkosvaroitukset', singular: 'ukkosvaroitus', symbol: 'ϟ' },
  10: { label: 'Sadevaroitukset', singular: 'sadevaroitus', symbol: '☂︎' },
};
// Property filters use full, case-sensitive equality, not the numeric CAP
// prefix. Both spellings occur in the feed; repeated query names mean AND.
const TYPE_FILTERS = {
  1: ['1; wind', '1; Wind'],
  3: ['3; thunderstorm', '3; Thunderstorm'],
  10: ['10; rain', '10; Rain'],
};
export const DAY_MS = 24 * 60 * 60 * 1000;
export const LEVELS = {
  2: {
    colorLabel: 'Keltainen', legendLabel: 'Mahdollisesti vaarallinen', color: '#ffda22', ink: '#705600', marks: '!',
  },
  3: {
    colorLabel: 'Oranssi', legendLabel: 'Vaarallinen', color: '#ff9300', ink: '#ad4800', marks: '!!',
  },
  4: {
    colorLabel: 'Punainen', legendLabel: 'Hyvin vaarallinen', color: '#ff0000', ink: '#bd1638', marks: '!!!',
  },
};
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const date = (value) => Date.parse(value) || 0;
const code = (value) => Number(text(value).split(';')[0]);

export function warningLanguageRank(language) {
  const tag = text(language).toLowerCase().split('-')[0];
  return tag === 'fi' ? 0 : tag === 'en' ? 1 : 2;
}

export function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch (e) { return ''; }
}

export function normalizeWarnings(features) {
  const records = new Map();
  const superseded = new Set();
  features.forEach(({ properties: p = {} }) => {
    if (p.status !== 'Actual' || p.scope !== 'Public' || !['Cancel', 'Update'].includes(p.msgType)) return;
    // CAP references are space-separated sender,identifier,sent triples.
    text(p.references).split(/\s+/).forEach((reference) => {
      const [sender, identifier] = reference.split(',');
      if (sender && identifier) superseded.add(`${sender}:${identifier}`);
    });
  });
  features.forEach((feature) => {
    const p = feature.properties || {};
    if (superseded.has(`${p.sender}:${p.identifier}`)) return;
    const type = code(p.awareness_type);
    const level = code(p.awareness_level);
    const responses = Array.isArray(p.responseType) ? p.responseType : [p.responseType];
    if (!WARNING_TYPES[type] || !LEVELS[level]
      || p.status !== 'Actual' || p.scope !== 'Public'
      || !['Alert', 'Update'].includes(p.msgType) || responses.includes('AllClear')) return;
    if (!['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) return;
    const start = date(p.onset) || date(p.effective) || date(p.sent);
    const ends = [date(p.expires), date(p.active_until)].filter(Boolean);
    const end = ends.length ? Math.min(...ends) : 0;
    // Unknown validity must not silently become an everlasting warning.
    if (!start || !end || end <= start) return;
    const id = text(feature.id) || `${text(p.identifier)}:${text(p.areaDesc)}:${text(p.language)}`;
    const record = {
      id,
      type,
      level,
      start,
      end,
      expires: date(p.expires) || end,
      sent: date(p.sent),
      geometry: feature.geometry,
      area: text(p.areaDesc) || 'Varoitusalue',
      headline: text(p.headline) || text(p.event),
      description: typeof p.description === 'string' ? p.description : '',
      // MeteoCore exposes the CAP impacts parameter directly. Keep repeated
      // values and pipe-separated items in source order, without rewriting.
      impacts: (Array.isArray(p.impacts) ? p.impacts : [p.impacts])
        .filter((value) => typeof value === 'string')
        .flatMap((value) => value.split('|')).filter((value) => value.trim()),
      instruction: typeof p.instruction === 'string' ? p.instruction : '',
      sender: text(p.senderName) || text(p.sender),
      language: text(p.language),
      web: safeWebUrl(p.web),
    };
    if (!records.has(id) || record.sent >= records.get(id).sent) records.set(id, record);
  });
  return [...records.values()];
}

export function inWarningWindow(warning, now, upcoming) {
  return warning.end > now && (upcoming ? warning.start < now + DAY_MS : warning.start <= now);
}

async function fetchFilteredPages(filters, { signal, fetcher }) {
  const first = new URL(WARNING_URL);
  const predicates = { status: 'Actual', scope: 'Public', ...filters };
  first.search = new URLSearchParams({ limit: '1000', ...predicates });
  let url = first.href;
  const seen = new Set();
  const seenPages = new Set();
  const features = [];
  let matched = null;
  while (url) {
    if (seen.has(url) || seen.size >= 100) throw new Error('Warning pagination loop');
    seen.add(url);
    // Pages depend on the preceding response's next link.
    // eslint-disable-next-line no-await-in-loop
    const response = await fetcher(url, { signal, cache: 'no-cache' });
    if (!response.ok) throw new Error(`Warnings HTTP ${response.status}`);
    // eslint-disable-next-line no-await-in-loop
    const json = await response.json();
    if (json.type !== 'FeatureCollection' || !Array.isArray(json.features)) throw new Error('Invalid warning feed');
    const pageKey = JSON.stringify(json.features.map((f) => f.id || f));
    if (json.features.length && seenPages.has(pageKey)) throw new Error('Repeated warning page');
    seenPages.add(pageKey);
    features.push(...json.features);
    if (Number.isFinite(json.numberMatched)) matched = json.numberMatched;
    const next = (json.links || []).find((link) => link.rel === 'next');
    if (next) {
      const target = new URL(next.href, url);
      if (target.origin !== new URL(WARNING_URL).origin
        || target.pathname !== new URL(WARNING_URL).pathname) throw new Error('Unexpected warning page');
      // Preserve the query even if a next link contains only paging fields;
      // never silently broaden/change the filtered snapshot on later pages.
      Object.entries(predicates).forEach(([name, value]) => {
        if (target.searchParams.has(name)
          && target.searchParams.getAll(name).some((entry) => entry !== value)) {
          throw new Error('Changed warning page filter');
        }
        target.searchParams.set(name, value);
      });
      url = target.href;
    } else if (matched !== null && features.length < matched) {
      if (!json.features.length) throw new Error('Incomplete warning feed');
      const target = new URL(first);
      target.searchParams.set('offset', String(features.length));
      url = target.href;
    } else url = null;
  }
  return features;
}

// All selected types, spellings and cancellation pages must complete before
// replacing the shared snapshot. A failed branch aborts its siblings too.
export async function fetchWarningSnapshot({ types = Object.keys(WARNING_TYPES).map(Number), signal, fetcher = fetch } = {}) {
  const selected = [...new Set(types)].filter((type) => TYPE_FILTERS[type]).sort((a, b) => a - b);
  if (!selected.length) return [];
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const queries = selected.flatMap((type) => TYPE_FILTERS[type].map((value) => ({ awareness_type: value })));
  // CAP cancellations may omit awareness_type and geometry altogether.
  queries.push({ msgType: 'Cancel' });
  try {
    const pages = await Promise.all(queries.map((filters) => fetchFilteredPages(filters, { signal: controller.signal, fetcher })));
    return normalizeWarnings(pages.flat()).filter((warning) => selected.includes(warning.type));
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
