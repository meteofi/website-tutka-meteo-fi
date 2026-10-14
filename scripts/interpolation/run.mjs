/* eslint-disable no-console */
// Build and serve the diagnostic page; optionally run it in a real browser.
// No browser dependency is installed or silently substituted by npm test.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import {
  mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import {
  dirname, extname, join, resolve, sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
// Build tooling only; never part of the app bundle.
// eslint-disable-next-line import/no-extraneous-dependencies
import webpack from 'webpack';
import config from './webpack.config.cjs';

const args = process.argv.slice(2);
const known = new Set(['--headless', '--software', '--strict', '--output', '--port', '--help']);
for (let i = 0; i < args.length; i++) {
  if (!known.has(args[i])) throw new Error(`Unknown option: ${args[i]}`);
  if (args[i] === '--output' || args[i] === '--port') {
    if (!args[++i] || args[i].startsWith('--')) throw new Error('Missing option value');
  }
}
if (args.includes('--help')) {
  console.log('npm run diagnose:interpolation -- [--headless] [--software] [--strict] [--output results.json] [--port 9011]');
  console.log('CHROME_BIN selects Chrome/Chromium. --software requests SwiftShader; use real devices for performance assessment.');
  process.exit(0);
}
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const headless = args.includes('--headless');
// The full fixture suite is much slower without a GPU. Keep the normal device
// timeout, but allow the explicit CPU-rendering correctness run to finish.
const timeoutMs = args.includes('--software') ? 300000 : 120000;
const port = Number(value('--port', headless ? '0' : '9011'));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
const output = resolve(value('--output', join(tmpdir(), 'tutka-interpolation-results.json')));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

await new Promise((done, reject) => {
  const compiler = webpack({ ...config, mode: 'production' });
  compiler.run((error, stats) => compiler.close(() => {
    if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })));
    else done();
  }));
});

let deliver;
const received = new Promise((resolveReport) => { deliver = resolveReport; });
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
};
const publicRoot = join(root, 'dist/diagnostics/interpolation');
const server = createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url, 'http://localhost');
    if (headless && request.method === 'POST' && pathname === '/report') {
      let body = '';
      for await (const part of request) {
        body += part;
        if (body.length > 2e6) throw new Error('Report too large');
      }
      const report = JSON.parse(body);
      response.writeHead(200).end('ok');
      deliver(report);
      return;
    }
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    const file = resolve(publicRoot, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
    if (!file.startsWith(`${publicRoot}${sep}`)) { response.writeHead(403).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
await new Promise((done, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', done);
});
const url = `http://127.0.0.1:${server.address().port}/`;
console.log(`Interpolation diagnostics: ${url}`);

if (headless) {
  let browser;
  let profile;
  let timeout;
  let log = '';
  try {
    const candidates = process.env.CHROME_BIN ? [process.env.CHROME_BIN] : [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ...['google-chrome', 'chromium', 'chromium-browser'].flatMap((name) => (process.env.PATH || '').split(sep === '/' ? ':' : ';').map((p) => join(p, name))),
    ];
    const binary = candidates.find((candidate) => existsSync(candidate));
    if (!binary) throw new Error('Chrome/Chromium not found. Set CHROME_BIN to its executable.');
    profile = await mkdtemp(join(tmpdir(), 'tutka-interpolation-chrome-'));
    const browserArgs = [
      '--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', `--user-data-dir=${profile}`,
      ...(args.includes('--software') ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
      `${url}?autorun=1&report=1`,
    ];
    browser = spawn(binary, browserArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', (data) => { log = (log + data).slice(-8000); });
    const failed = new Promise((_, reject) => {
      browser.once('error', reject);
      browser.once('exit', (code) => reject(new Error(`Browser exited before reporting (${code})\n${log}`)));
      timeout = setTimeout(() => reject(new Error(`Browser timed out after ${timeoutMs / 1000} seconds\n${log}`)), timeoutMs);
    });
    const report = await Promise.race([received, failed]);
    if (report.error) throw new Error(report.error);
    if (!report.summary || !report.results?.length) throw new Error('Incomplete diagnostic report');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report.summary));
    console.log(`Report: ${output}`);
    if (report.summary.correctnessFailures || report.summary.unavailableMeasurements
      || (args.includes('--strict') && report.summary.qualityFailures)) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    if (browser && browser.exitCode === null) {
      const exited = new Promise((done) => { browser.once('exit', done); });
      browser.kill('SIGTERM');
      const force = setTimeout(() => browser.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(force);
    }
    await new Promise((done) => { server.close(done); });
    if (profile) {
      await rm(profile, {
        recursive: true, force: true, maxRetries: 3, retryDelay: 200,
      });
    }
  }
}
