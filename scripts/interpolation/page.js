/* global DIAGNOSTIC_BUILD */
import { loadCases } from './cases';
import {
  createEngine, cropReference, loadEngine, measure, render,
} from './engine';

const $ = (id) => document.getElementById(id);
let cases;
let flow;
let comparison;
let current;
let playing = false;
let position = 0;
let previousTime = 0;
let lastPaint = 0;
let report;

function paint(target, image) {
  const { width, height } = image;
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  const ctx = target.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
}

function draw() {
  const last = current.frames.length - 1;
  const at = Math.min(position, last);
  const { width, height } = current.frames[0];
  const w = Math.max(1, Math.min(960, Math.round($('flow').clientWidth)));
  const h = Math.round((w * height) / width);
  const half = 0.5 / Number($('zoom').value);
  const extent = [(0.5 - half) * width, (0.5 - half) * height, (0.5 + half) * width, (0.5 + half) * height];
  paint($('flow'), render(flow, at, w, h, extent));
  paint($('comparison'), render(comparison, at, w, h, extent));
  paint($('reference'), cropReference(current.expected ? current.expected(at) : current.frames[Math.round(at)], w, h, extent));
  $('position').value = at;
  $('position-value').textContent = `Kuva ${(at + 1).toFixed(2)} / ${current.frames.length}`;
}

function stop() {
  playing = false;
  $('play').textContent = 'Toista';
}

function selectCase() {
  stop();
  current = cases.find((c) => c.id === $('case').value);
  const profile = current.motionProfile || 'radar';
  if (!flow || flow.motionProfile !== profile) {
    if (flow) {
      flow.dispose();
      flow.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    flow = createEngine(true, profile);
  }
  loadEngine(flow, current);
  loadEngine(comparison, current);
  position = 0;
  $('position').max = current.frames.length - 1;
  $('description').textContent = current.description;
  $('times').textContent = current.times ? current.times.map((t) => t.replace('+00:00', ' UTC')).join(' → ') : '';
  $('reference-title').textContent = current.expected ? 'Tunnettu välikuva' : 'Lähin havainto';
  draw();
}

function tick(now) {
  requestAnimationFrame(tick);
  if (!playing || document.hidden) { previousTime = now; return; }
  position += Math.min(now - previousTime, 100) / (1000 * Number($('duration').value));
  previousTime = now;
  // Hold the last observation; never calculate flow from the end back to start.
  if (position > current.frames.length - 0.5) position = 0;
  if (now - lastPaint >= 33) {
    lastPaint = now;
    try { draw(); } catch (error) { stop(); $('status').textContent = error.message; }
  }
}

function showReport(result) {
  report = result;
  const { summary } = result;
  $('status').textContent = `Tarkistusten virheitä: ${summary.correctnessFailures}. `
    + `Laatutavoitteita avoinna: ${summary.qualityFailures}. Mittauksia puuttuu: ${summary.unavailableMeasurements}.`;
  $('environment').textContent = `${result.environment.flowFilter} · ${result.environment.renderer}`;
  const filtering = result.checks.find((c) => c.id === 'flow-filtering:bilinear-warp');
  $('filtering').textContent = `Virtauksen suodatus: ${filtering.passed ? 'OK' : 'VIRHE'} (kuvaero ${filtering.value.toFixed(2)} / ${filtering.limit}).`;
  $('results').replaceChildren();
  for (const r of result.results) {
    const row = document.createElement('tr');
    const checks = result.checks.filter((c) => c.id.startsWith(`${r.id}:`));
    const failed = checks.filter((c) => !c.passed);
    const errors = failed.filter((c) => c.kind === 'correctness');
    let status = 'OK';
    if (failed.length) status = failed.length === 1 ? '1 tavoite avoinna' : `${failed.length} tavoitetta avoinna`;
    if (r.flowUnavailable) status = 'Mittaus ei onnistu';
    if (errors.length) status = `${errors.length} tarkistusvirhettä`;
    const fields = [
      cases.find((c) => c.id === r.id).label,
      r.flow ? `${r.flow.medianX.toFixed(2)}, ${r.flow.medianY.toFixed(2)}` : '—',
      r.flow ? r.flow.meanVectorError.toFixed(2) : '—',
      Math.max(...r.endpoints.map((e) => e.max)).toFixed(2),
      r.boundary.max.toFixed(2),
      r.cropped ? Math.max(...r.cropped.flatMap((crop) => crop.endpoints.map((e) => e.max))).toFixed(2) : '—',
      r.geometry ? r.geometry.foldedCells : '—',
      r.intermediate ? Math.max(...r.intermediate.map((e) => e.mean)).toFixed(2) : '—',
      r.edgeVelocities ? `${r.edgeVelocities.raw.p95.toFixed(3)} → ${r.edgeVelocities.curved.p95.toFixed(3)}` : '—',
      status,
    ];
    for (const value of fields) {
      const td = document.createElement('td');
      td.textContent = value;
      row.append(td);
    }
    $('results').append(row);
  }
  $('download').disabled = false;
}

async function run() {
  stop();
  $('run').disabled = true;
  $('play').disabled = true;
  $('case').disabled = true;
  try {
    const result = await measure(cases, (label) => { $('status').textContent = `Mitataan: ${label}`; });
    showReport(result);
    // Only the local headless runner requests a POST; preview users download JSON.
    if (new URLSearchParams(window.location.search).get('report') === '1') {
      await fetch('./report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
    }
  } catch (error) {
    $('status').textContent = `Mittaus epäonnistui: ${error.message}`;
    if (new URLSearchParams(window.location.search).get('report') === '1') {
      await fetch('./report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: error.stack }) });
    }
  } finally {
    $('run').disabled = false;
    $('play').disabled = false;
    $('case').disabled = false;
  }
}

async function main() {
  cases = await loadCases();
  comparison = createEngine(false);
  for (const c of cases) {
    const option = document.createElement('option');
    option.value = c.id;
    option.textContent = c.label;
    $('case').append(option);
  }
  $('case').addEventListener('change', selectCase);
  $('zoom').addEventListener('change', draw);
  window.addEventListener('resize', () => { if (current) draw(); });
  $('play').addEventListener('click', () => {
    playing = !playing;
    previousTime = performance.now();
    $('play').textContent = playing ? 'Pysäytä' : 'Toista';
  });
  $('position').addEventListener('input', () => { stop(); position = Number($('position').value); draw(); });
  $('background').addEventListener('change', () => {
    document.querySelectorAll('.image').forEach((el) => { el.style.background = $('background').value; });
  });
  $('run').addEventListener('click', run);
  $('download').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `interpolation-${DIAGNOSTIC_BUILD.commit.slice(0, 8)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
  selectCase();
  $('controls').disabled = false;
  $('run').disabled = false;
  $('build').textContent = `Versio ${DIAGNOSTIC_BUILD.commit.slice(0, 8)}`;
  $('status').textContent = 'Valitse tapaus ja toista tai siirrä aikajanaa. Mittaus käyttää samoja tuotannon varjostimia.';
  requestAnimationFrame(tick);
  if (new URLSearchParams(window.location.search).has('autorun')) await run();
}

main().catch(async (error) => {
  $('status').textContent = `Vertailu ei käynnisty: ${error.message}`;
  if (new URLSearchParams(window.location.search).get('report') === '1') {
    await fetch('./report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: error.stack }) });
  }
});
