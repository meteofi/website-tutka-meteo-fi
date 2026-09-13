// Safety-critical CAP contract: wrong type/time filtering can draw plausible
// warnings, or claim an empty map after a partial download. No browser needed.
import assert from 'node:assert/strict';
import { normalizeWarnings, inWarningWindow, fetchWarningSnapshot, safeWebUrl, warningLanguageRank, LEVELS, WARNING_URL, DAY_MS } from '../src/warnings/warningData.js';
const now = Date.parse('2026-09-13T12:00:00Z');
const polygon = { type: 'Polygon', coordinates: [[[24, 60], [25, 60], [25, 61], [24, 60]]] };
const base = {
  type: 'Feature', id: 'alert.0.0', geometry: polygon,
  properties: {
    identifier: 'alert', sender: 'issuer@example.org', awareness_type: '3; thunderstorm', awareness_level: '2; yellow; Moderate',
    status: 'Actual', scope: 'Public', msgType: 'Alert', language: 'fi-FI',
    onset: '2026-09-13T11:00:00Z', expires: '2026-09-13T13:00:00Z', sent: '2026-09-13T10:00:00Z',
    areaDesc: 'Uusimaa', description: '<script>never executable</script>', web: 'https://example.org/warning',
  },
};
const change = (properties) => ({ ...base, properties: { ...base.properties, ...properties } });
const [warning] = normalizeWarnings([base]);
assert.equal(warning.level, 2);
assert.equal(warning.type, 3);
assert.equal(LEVELS[2].color, '#ffda22');
assert.equal(LEVELS[3].color, '#ff9300');
assert.equal(LEVELS[4].color, '#ff0000');
assert(warningLanguageRank('fi-FI') < warningLanguageRank('en-GB'));
assert(warningLanguageRank('en-GB') < warningLanguageRank('sv-SE'));
assert.equal(normalizeWarnings([change({ awareness_type: '1; wind' })])[0].type, 1);
assert.equal(warning.area, 'Uusimaa');
assert.equal(warning.description, '<script>never executable</script>');
assert.equal(normalizeWarnings([change({ instruction: '  First|Second\n' })])[0].instruction, '  First|Second\n');
assert.equal(normalizeWarnings([change({ awareness_type: '13; something' })]).length, 0);
for (const props of [
  { awareness_type: '10; rain', event: 'Thunderstorm' },
  { awareness_level: '1; green; Minor' }, { awareness_level: '5; unknown' },
  { status: 'Test' }, { status: 'Exercise' }, { scope: 'Private' }, { msgType: 'Cancel' },
  { responseType: ['AllClear'] }, { expires: 'invalid' }, { onset: '2026-09-13T13:00:00Z' },
]) assert.equal(normalizeWarnings([change(props)]).length, 0, JSON.stringify(props));
assert.equal(normalizeWarnings([{ ...base, geometry: null }]).length, 0);
assert.equal(normalizeWarnings([{ ...base, geometry: { type: 'MultiPolygon', coordinates: [polygon.coordinates] } }]).length, 1);
assert.equal(normalizeWarnings([base, base]).length, 1);
assert.equal(normalizeWarnings([base, change({ msgType: 'Cancel', identifier: 'cancel', references: 'issuer@example.org,alert,2026-09-13T10:00:00Z' })]).length, 0);
assert.equal(normalizeWarnings([base, change({ msgType: 'Cancel', status: 'Test', references: 'issuer@example.org,alert,2026-09-13T10:00:00Z' })]).length, 1);
assert.equal(normalizeWarnings([base, { ...base, id: 'alert.0.1' }]).length, 2, 'preserve each CAP area');
assert.equal(normalizeWarnings([change({ active_until: '2026-09-13T12:30:00Z' })])[0].end, now + 30 * 60000);
assert(inWarningWindow(warning, warning.start, false), 'onset inclusive');
assert(!inWarningWindow(warning, warning.end, false), 'expiry exclusive');
assert(!inWarningWindow({ ...warning, start: now + 1000 }, now, false));
assert(inWarningWindow({ ...warning, start: now + 1000 }, now, true));
assert(!inWarningWindow({ ...warning, start: now + DAY_MS }, now, true));
assert(!inWarningWindow({ ...warning, end: now }, now, true));
assert.equal(safeWebUrl('javascript:alert(1)'), '');
assert.equal(safeWebUrl('data:text/html,hello'), '');
assert.equal(safeWebUrl('/relative'), '');
assert.equal(safeWebUrl('https://example.org'), 'https://example.org/');
const response = (features, extra = {}) => ({ ok: true, json: async () => ({ type: 'FeatureCollection', features, ...extra }) });
let urls = [];
let pages = [response([base], { numberMatched: 2, links: [{ rel: 'next', href: '?offset=1&limit=1' }] }), response([{ ...base, id: 'second' }])];
let result = await fetchWarningSnapshot({ fetcher: async (url) => { urls.push(url); return pages.shift(); } });
assert.equal(result.length, 2);
assert.equal(urls[1], `${WARNING_URL}?offset=1&limit=1`);
urls = [];
pages = [response([base], { numberMatched: 2 }), response([{ ...base, id: 'second' }], { numberMatched: 2 })];
result = await fetchWarningSnapshot({ fetcher: async (url) => { urls.push(url); return pages.shift(); } });
assert.equal(result.length, 2);
assert.equal(urls[1], `${WARNING_URL}?limit=1000&offset=1`);
await assert.rejects(fetchWarningSnapshot({ fetcher: async () => response([base], { numberMatched: 50 }) }), /Repeated/);
await assert.rejects(fetchWarningSnapshot({ fetcher: async () => response([], { numberMatched: 5 }) }), /Incomplete/);
await assert.rejects(fetchWarningSnapshot({ fetcher: async () => response([base], { links: [{ rel: 'next', href: 'https://other.example/items' }] }) }), /Unexpected/);
await assert.rejects(fetchWarningSnapshot({ fetcher: async () => response([base], { links: [{ rel: 'next', href: '?limit=1000' }] }) }), /loop/);
await assert.rejects(fetchWarningSnapshot({ fetcher: async () => ({ ok: false, status: 503 }) }), /503/);
await assert.rejects(fetchWarningSnapshot({ fetcher: async () => ({ ok: true, json: async () => ({}) }) }), /Invalid/);
pages = [response([base], { numberMatched: 2 }), { ok: false, status: 503 }];
await assert.rejects(fetchWarningSnapshot({ fetcher: async () => pages.shift() }), /503/, 'failed later page must not return partial data');
const controller = new AbortController();
controller.abort();
await assert.rejects(fetchWarningSnapshot({ signal: controller.signal, fetcher: async (_, { signal }) => { signal.throwIfAborted(); } }), { name: 'AbortError' });
console.log('ok   CAP warning filtering, validity, links, pagination, partial failures and abort');
