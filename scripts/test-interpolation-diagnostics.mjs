/* eslint-disable no-console */
// Test the diagnostic measurements and pinned fixture identity, not a copy of LK.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pixelError, flowError, flowGeometry } from './interpolation/metrics.mjs';

assert.deepEqual(pixelError([255, 0, 0, 0], [0, 255, 255, 0]), { mean: 0, max: 0 }, 'hidden RGB is irrelevant');
assert.equal(pixelError([128, 0, 0, 128], [255, 0, 0, 128]).max, (127 * 128) / 255, 'detect quadratic darkening');
assert.equal(pixelError([255, 0, 0, 128], [255, 0, 0, 255]).max, 127, 'alpha changes remain visible');
assert.throws(() => pixelError([], []));
assert.throws(() => pixelError([0, 0, 0, 0], [0]));
assert.equal(flowError([[4, -2], [4, -2]], [4, -2]).meanVectorError, 0, 'known diagonal motion');
assert.equal(flowError([[4, 2]], [4, -2]).meanVectorError, 4, 'wrong vertical sign must fail');
assert.equal(flowError([[0, 0]], [4, 0]).meanVectorError, 4, 'zero flow is not success');
assert.throws(() => flowError([[NaN, 0]], [0, 0]));
assert.throws(() => flowError([], [0, 0]));

const field = (vectors) => ({ width: 2, height: 2, data: vectors.flatMap(([x, y]) => [x / 2, y / 2, 0, 1]) });
assert.equal(flowGeometry(field([[4, 2], [4, 2], [4, 2], [4, 2]])).foldedCells, 0, 'translation never folds');
assert.equal(flowGeometry(field([[0, 0], [3, 0], [0, 0], [3, 0]])).foldedCells, 1, 'large horizontal expansion folds the opposite warp');
assert.equal(flowGeometry(field([[0, 0], [0, 0], [0, -3], [0, -3]])).foldedCells, 1, 'detect vertical collapse');
assert.equal(flowGeometry(field([[0, 0], [0, 0], [0, 0], [0, 3]])).foldedCells, 1, 'corner-only folding must not be missed by center sampling');
assert.throws(() => flowGeometry(field([[NaN, 0], [0, 0], [0, 0], [0, 0]])));

const root = new URL('./interpolation/fixtures/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
assert.equal(manifest.frames.length, 15);
const sequences = new Map();
for (const entry of manifest.frames) {
  const data = await readFile(new URL(entry.file, root)); // eslint-disable-line no-await-in-loop
  assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, entry.file);
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(data.readUInt32BE(16), entry.width);
  assert.equal(data.readUInt32BE(20), entry.height);
  const params = new URL(entry.url).searchParams;
  for (const [key, value] of Object.entries({
    TIME: entry.time, LAYERS: entry.layer, STYLES: entry.style, CRS: entry.crs,
  })) {
    assert.equal(params.get(key), value);
  }
  const key = `${entry.layer}:${entry.style}:${entry.width}x${entry.height}`;
  const sequence = sequences.get(key) || [];
  sequence.push(entry);
  sequences.set(key, sequence);
}
assert.equal(sequences.size, 5);
for (const sequence of sequences.values()) {
  sequence.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  assert.equal(sequence.length, 3);
  const dt = sequence[0].layer.startsWith('fmi') ? 300000 : 600000;
  for (let i = 1; i < sequence.length; i++) {
    assert.equal(Date.parse(sequence[i].time) - Date.parse(sequence[i - 1].time), dt);
    assert.deepEqual(sequence[i].bbox, sequence[0].bbox);
    assert.equal(sequence[i].width, sequence[0].width);
    assert.equal(sequence[i].height, sequence[0].height);
  }
}
console.log('Interpolation diagnostics: metric checks and 15 fixture identities passed. GPU suite: npm run diagnose:interpolation -- --headless');
