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
assert.equal(normalizeWarnings([change({ awareness_type: '10; Rain' })])[0].type, 10);
assert.equal(normalizeWarnings([change({ awareness_type: '10; rain' })])[0].type, 10);
assert.equal(warning.area, 'Uusimaa');
assert.equal(warning.description, '<script>never executable</script>');
assert.equal(normalizeWarnings([change({ instruction: '  First|Second\n' })])[0].instruction, '  First|Second\n');
assert.deepEqual(warning.impacts, [], 'missing impacts must not be inferred from the description');
assert.deepEqual(normalizeWarnings([change({ impacts: 'Flooded roads' })])[0].impacts, ['Flooded roads']);
assert.deepEqual(normalizeWarnings([change({ impacts: ['  Flooded roads|Power outages\n', 'Falling trees', '', null, 42] })])[0].impacts,
  ['  Flooded roads', 'Power outages\n', 'Falling trees'], 'preserve every supplied impact and its wording in source order');
assert.deepEqual(normalizeWarnings([change({ impacts: ' |\n' })])[0].impacts, []);
assert.deepEqual(normalizeWarnings([change({ impacts: { text: 'unsupported shape' } })])[0].impacts, []);
assert.equal(normalizeWarnings([change({ awareness_type: '13; something' })]).length, 0);
for (const props of [
  { awareness_type: '4; fog', event: 'Thunderstorm' },
  { awareness_type: '12; flooding', event: 'Rain' },
  { awareness_type: '13; rain-flood', event: 'Rain' },
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
const filteredUrl = (type = '3; thunderstorm') => {
  const url = new URL(WARNING_URL);
  url.search = new URLSearchParams({ limit: '1000', status: 'Actual', scope: 'Public', awareness_type: type });
  return url;
};
const thunder = (fetcher, extra = {}) => fetchWarningSnapshot({ types: [3], fetcher, ...extra });
const lowerOnly = (fetcher) => async (url, options) => new URL(url).searchParams.get('awareness_type') === '3; thunderstorm'
  ? fetcher(url, options) : response([]);
let urls = [];
let pages = [response([base], { numberMatched: 2, links: [{ rel: 'next', href: '?offset=1&limit=1' }] }), response([{ ...base, id: 'second' }])];
let result = await thunder(lowerOnly(async (url) => { urls.push(url); return pages.shift(); }));
assert.equal(result.length, 2);
assert.equal(new URL(urls[1]).searchParams.get('offset'), '1');
for (const url of urls) {
  const params = new URL(url).searchParams;
  assert.equal(params.get('awareness_type'), '3; thunderstorm', 'next links retain type filter');
  assert.equal(params.get('status'), 'Actual');
  assert.equal(params.get('scope'), 'Public');
}
urls = [];
pages = [response([base], { numberMatched: 2 }), response([{ ...base, id: 'second' }], { numberMatched: 2 })];
result = await thunder(lowerOnly(async (url) => { urls.push(url); return pages.shift(); }));
assert.equal(result.length, 2);
const fallback = filteredUrl(); fallback.searchParams.set('offset', '1');
assert.equal(urls[1], fallback.href, 'fallback paging retains the complete filter');

// Server equality is case sensitive: all selected spellings must be fetched,
// then merged. Repeated query parameters would AND values and return nothing.
urls = [];
result = await fetchWarningSnapshot({ types: [3, 1, 3, 99], fetcher: async (url) => {
  urls.push(url);
  const params = new URL(url).searchParams;
  assert.equal(params.get('status'), 'Actual');
  assert.equal(params.get('scope'), 'Public');
  const type = params.get('awareness_type');
  if (!type) { assert.equal(params.get('msgType'), 'Cancel'); return response([]); }
  assert.equal(params.getAll('awareness_type').length, 1);
  return response([{ ...change({ awareness_type: type }), id: type }]);
} });
assert.deepEqual(result.map(w => w.type).sort(), [1, 1, 3, 3]);
assert.deepEqual(urls.map(url => new URL(url).searchParams.get('awareness_type')), ['1; wind', '1; Wind', '3; thunderstorm', '3; Thunderstorm', null]);
assert.deepEqual(await fetchWarningSnapshot({ types: [], fetcher: () => assert.fail('disabled warnings never fetch') }), []);
assert.deepEqual(await fetchWarningSnapshot({ types: [99], fetcher: () => assert.fail('unsupported types never fetch') }), []);
const rainQueries = [];
await fetchWarningSnapshot({ types: [10], fetcher: async url => { rainQueries.push(new URL(url).searchParams.get('awareness_type')); return response([]); } });
assert.deepEqual(rainQueries, ['10; rain', '10; Rain', null]);

// Cancellations need not contain the hazard property or geometry. Apply their
// references across the entire merged snapshot before discarding other types.
result = await thunder(async (url) => {
  if (new URL(url).searchParams.get('msgType') === 'Cancel') return response([{
    type: 'Feature', id: 'cancel', geometry: null,
    properties: { status: 'Actual', scope: 'Public', msgType: 'Cancel', references: 'issuer@example.org,alert,2026-09-13T10:00:00Z' },
  }]);
  return response([base]);
});
assert.deepEqual(result, []);
assert.equal((await thunder(async () => response([base]))).length, 1, 'merge duplicate features once');

await assert.rejects(thunder(lowerOnly(async () => response([base], { numberMatched: 50 }))), /Repeated/);
await assert.rejects(thunder(lowerOnly(async () => response([], { numberMatched: 5 }))), /Incomplete/);
await assert.rejects(thunder(lowerOnly(async () => response([base], { links: [{ rel: 'next', href: 'https://other.example/items' }] }))), /Unexpected/);
await assert.rejects(thunder(lowerOnly(async () => response([base], { links: [{ rel: 'next', href: '?limit=1000' }] }))), /loop/);
await assert.rejects(thunder(lowerOnly(async () => response([base], { links: [{ rel: 'next', href: '?awareness_type=1%3B+wind' }] }))), /Changed/);
await assert.rejects(thunder(lowerOnly(async () => response([base], { links: [{ rel: 'next', href: '?status=Test' }] }))), /Changed/);
await assert.rejects(thunder(async () => ({ ok: false, status: 503 })), /503/);
await assert.rejects(thunder(async () => ({ ok: true, json: async () => ({}) })), /Invalid/);
pages = [response([base], { numberMatched: 2 }), { ok: false, status: 503 }];
await assert.rejects(thunder(lowerOnly(async () => pages.shift())), /503/, 'failed later page must not return partial data');
let siblingAborted = false;
await assert.rejects(thunder(async (url, { signal }) => {
  if (new URL(url).searchParams.get('awareness_type') === '3; thunderstorm') return { ok: false, status: 503 };
  return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
    siblingAborted = true; reject(new DOMException('Aborted', 'AbortError'));
  }, { once: true }));
}), /503/, 'a failed spelling must fail the whole snapshot');
assert(siblingAborted, 'failed snapshots abort remaining filtered requests');
const controller = new AbortController();
controller.abort();
await assert.rejects(thunder(async (_, { signal }) => { signal.throwIfAborted(); }, { signal: controller.signal }), { name: 'AbortError' });
console.log('ok   CAP warning filtering, selected-type requests, case variants, cancellation, filtered pagination, partial failure and abort');
