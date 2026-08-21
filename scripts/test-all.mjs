// Runs every scripts/test-*.mjs and reports them together.
//
//   npm test
//
// Discovers by filename rather than listing files, so adding a test is adding a
// file — no package.json edit. That is not just tidiness: two concurrent PRs
// each appending to a hardcoded `test` script conflict on the same line, which
// is exactly what happened while these tests were being written.
//
// Runs all of them even when one fails. A runner that stops at the first
// failure hides how much else broke, which is the wrong thing to do when you
// are deciding whether a change was a small mistake or a bad idea.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const self = 'test-all.mjs';

// .mjs for the app modules, .sh for the git hooks — those are bash, so their
// tests are too rather than pretending otherwise through a node wrapper.
const files = readdirSync(here)
  .filter((f) => f.startsWith('test-') && (f.endsWith('.mjs') || f.endsWith('.sh')) && f !== self)
  .sort();

if (files.length === 0) {
  console.error('no scripts/test-*.{mjs,sh} found');
  process.exit(1);
}

const failed = [];
for (const f of files) {
  // The node flag silences MODULE_TYPELESS_PACKAGE_JSON, raised because the
  // modules under test are ESM in .js files. Do NOT "fix" that by adding
  // "type": "module" to package.json — webpack.config.js is CommonJS and the
  // build would stop working.
  const [bin, args] = f.endsWith('.sh')
    ? ['bash', [join(here, f)]]
    : [process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(here, f)]];
  const r = spawnSync(bin, args, { stdio: 'inherit' });
  if (r.status !== 0) failed.push(f);
}

console.log('');
if (failed.length) {
  console.error(`FAILED: ${failed.join(', ')}  (${failed.length}/${files.length})`);
  process.exit(1);
}
console.log(`All ${files.length} test files passed.`);
