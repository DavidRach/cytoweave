// A scripted agent session (no model): every agent tool driven through remote control, as an AI
// agent drives them through "cytoweave mcp", in the real program and a headless browser. Each
// result is checked against the same analysis run the way the app runs it, against the truth of
// the simulated examples, or against the files the exports write read back.
//
//   node validation/agent-session.mjs [--verbose]
//
// Needs Go (to build CytoWeave from source) and Chrome, Chromium, Edge or Brave (CHROME=path).
// Exits with status 1 when a check fails.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../docs/capture/cdp.mjs';
import { generateExample } from '../web/lib/examples.js';
import { parseFCS } from '../web/lib/fcs.js';
import { readZip } from '../web/lib/zip.js';
import { readFigureProvenance } from '../web/lib/figure-provenance.js';
import { adjustedRandIndex } from '../web/lib/cluster-summary.js';
import { encodeFCS } from '../web/lib/simulate.js';
import { BEAD_MEF, BEAD_TRUTH, simulatedBeads } from './calibration-cases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8795;
const verbose = process.argv.includes('--verbose');
const results = [];
function check(name, value, ok, required) {
  results.push({ name, ok });
  if (verbose || !ok) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} — ${value} (required ${required})`);
}

// --- CytoWeave and the page -----------------------------------------------------------------------

let URL = `http://127.0.0.1:${PORT}/`;
let token = '';
const temp = mkdtempSync(join(tmpdir(), 'cytoweave-agent-'));

async function startCytoWeave() {
  const binary = join(temp, process.platform === 'win32' ? 'cytoweave.exe' : 'cytoweave');
  await new Promise((done, fail) => spawn('go', ['build', '-o', binary, '.'], { cwd: ROOT, stdio: 'inherit' }).on('exit', (code) => (code ? fail(new Error('go build failed (is Go installed?)')) : done())));
  const server = spawn(binary, ['--remote-control', '--window', 'none', '--port', String(PORT), '--data-dir', join(temp, 'library')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 300; i += 1) {
    const address = /running at (http:\/\/[\d.]+:\d+)/.exec(output)?.[1];
    token = /X-CytoWeave-Token: (\S+)/.exec(output)?.[1] ?? token;
    if (address && token) {
      URL = `${address}/`;
      try {
        if ((await fetch(`${URL}api/info`)).ok) return () => server.kill();
      } catch { /* starting */ }
    }
    await sleep(200);
  }
  server.kill();
  throw new Error('CytoWeave did not start.');
}

// A tool call, as an agent sends it (exports carry the token, as scripts must).
async function tool(name, args = {}, client = 'Claude Code') {
  const response = await fetch(`${URL}api/remote/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CytoWeave-Token': token }, body: JSON.stringify({ action: name, args, client }) });
  const result = await response.json();
  if (!result.ok) throw new Error(`${name}: ${result.message ?? result.error}`);
  return result;
}
// A tool call expected to fail; returns its message.
async function refused(name, args = {}) {
  const response = await fetch(`${URL}api/remote/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CytoWeave-Token': token }, body: JSON.stringify({ action: name, args, client: 'Claude Code' }) });
  const result = await response.json();
  return result.ok ? null : (result.message ?? result.error);
}

let b;
const page = (code) => b.eval(`(async () => { const app = window.cytoweave; ${code} })()`);
async function waitFor(expression, timeout = 240000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await b.eval(expression)) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
// The user's decision on an agent's open proposal, from the review strip.
const decide = (author, accept) => page(`
  const { acceptProposal, openProposals, proposedChannels, rejectProposal } = await import('/lib/proposals.js');
  const p = openProposals(app.store.ws).find((x) => x.author === ${JSON.stringify(author)});
  if (!p) return false;
  const channels = proposedChannels(app.store.ws, p.id);
  app.store.commit((${accept} ? acceptProposal : rejectProposal)(app.store.ws, p.id), 'Decide');
  if (!${accept}) { const kept = new Set(app.store.ws.derived.flatMap((d) => d.outputs ?? [])); for (const c of channels) if (!kept.has(c)) app.data.removeDerived(c); }
  return true;`);

// --- The session ----------------------------------------------------------------------------------

const stopServer = await startCytoWeave();
try {
  b = await launch({ width: 1400, height: 900 });
  await b.goto(URL);
  await waitFor('Boolean(window.cytoweave)', 30000);

  // 1. The PBMC example, opened by the agent; the user adds the suggested gates.
  await tool('open_example', { id: 'pbmc-immunophenotyping' });
  await waitFor(`window.cytoweave.store.ws.samples.length > 0 && !document.querySelector('.progress-toast')`);
  await b.eval(`[...document.querySelectorAll('button')].find((e) => e.offsetParent && /Add suggested gates/.test(e.textContent))?.click()`);
  await waitFor(`window.cytoweave.store.ws.gates.length > 5`, 30000);
  const summary = (await tool('workspace_summary')).data;
  const samples = summary.samples.filter((s) => s.role === 'sample').map((s) => s.name);

  // Annotations wait for review, then apply.
  await tool('annotate_samples', { samples: [{ sample: samples[0], meta: { cohort: 'A' } }, { sample: samples[1], meta: { cohort: 'B', batch: null } }] });
  const before = await page(`return app.store.ws.samples.find((s) => s.name === ${JSON.stringify(samples[0])}).meta.cohort ?? null;`);
  await decide('Claude Code', true);
  const after = await page(`const ss = app.store.ws.samples; return [ss.find((s) => s.name === ${JSON.stringify(samples[0])}).meta.cohort, ss.find((s) => s.name === ${JSON.stringify(samples[1])}).meta.cohort, 'batch' in ss.find((s) => s.name === ${JSON.stringify(samples[1])}).meta];`);
  check('annotate_samples: held until accepted, then applied (a null value removes the field)', `before ${before}; after ${after.join(', ')}`, before === null && after[0] === 'A' && after[1] === 'B' && after[2] === false, 'null, then A, B, field removed');

  // The FlowJo workspace carries every population of every sample with CytoWeave's own count.
  const outDir = join(temp, 'out');
  mkdirSync(outDir);
  const wspPath = join(outDir, 'pbmc.wsp');
  const flowjo = await tool('export_flowjo', { path: wspPath });
  const xml = readFileSync(wspPath, 'utf8');
  let compared = 0;
  let countDiffer = 0;
  for (const name of samples.slice(0, 3)) {
    const node = new RegExp(`<SampleNode name="${name}[^"]*"[\\s\\S]*?</SampleNode>`).exec(xml)?.[0] ?? '';
    const written = new Map([...node.matchAll(/<Population name="([^"]*)"[^>]*? count="(\d+)"/g)].map((m) => [m[1], Number(m[2])]));
    for (const row of (await tool('list_populations', { sample: name })).data.populations) {
      const leaf = row.path.split('/').pop().trim();
      if (!written.has(leaf)) continue;
      compared += 1;
      if (written.get(leaf) !== row.count) countDiffer += 1;
    }
  }
  check('export_flowjo: every population written with CytoWeave\'s count (3 samples)', `${compared} counts compared, ${countDiffer} differ; ${flowjo.message.replace(/^Wrote \S+ \(\d+ bytes\)\. /, '').slice(0, 90)}`, compared >= 18 && countDiffer === 0, '0 differ');

  // QC: the agent's result equals the QC view's on the same samples, and the gate waits.
  const qcSamples = samples.slice(0, 3);
  const qc = (await tool('run_qc', { samples: qcSamples, addGate: true })).data;
  const qcState = await page(`
    const { runQC, DEFAULT_SETTINGS } = await import('/ui/qc-run.js');
    const record = app.store.ws.derived.find((d) => d.kind === 'qc' && d.proposal);
    let differ = 0;
    for (const name of ${JSON.stringify(qcSamples)}) {
      const sample = app.store.ws.samples.find((s) => s.name === name);
      const direct = await runQC(app, sample, structuredClone(DEFAULT_SETTINGS));
      const values = app.data.view(sample.id).derived.get('QC pass');
      for (let e = 0; e < direct.mask.length; e += 1) if ((values[e] ? 1 : 0) !== (direct.mask[e] ? 1 : 0)) differ += 1;
    }
    return { proposed: Boolean(record), samples: Object.keys(record?.files ?? {}).length, differ, rootHeld: !app.store.ws.gates.some((g) => g.name === 'QC pass'), gates: app.store.ws.gates.length };`);
  check(`run_qc: ${qcSamples.length} samples proposed, each event's QC pass equal to the QC view's own run; the QC pass gate held`, `${qc.rows.map((r) => `${r.sample} ${r.score}`).join(', ')}; ${qcState.samples} samples; ${qcState.differ} events differ; gate ${qcState.rootHeld ? 'held' : 'added'}`, qcState.proposed && qcState.samples === qcSamples.length && qcState.differ === 0 && qcState.rootHeld, 'proposed, 0 differ, held');
  await decide('Claude Code', true);
  const tree = await page(`const qc = app.store.ws.gates.find((g) => g.name === 'QC pass'); return { qc: Boolean(qc), top: app.store.ws.gates.filter((g) => !g.parentId).map((g) => g.name), qcRecord: app.store.ws.derived.filter((d) => d.kind === 'qc').map((d) => [Boolean(d.proposal), Object.keys(d.files ?? {}).length]) };`);
  check('accepting puts QC pass at the top with every population beneath it, and keeps the result', `top level: ${tree.top.join(', ')}; QC records ${JSON.stringify(tree.qcRecord)}`, tree.qc && tree.top.length === 1 && tree.top[0] === 'QC pass' && tree.qcRecord.length === 1 && tree.qcRecord[0][0] === false, 'only QC pass at the top');
  const again = (await tool('run_qc', { samples: qcSamples })).data;
  check('run_qc leaves samples the user has a result for alone', `already checked: ${again.alreadyChecked.join(', ')}`, again.alreadyChecked.length === qcSamples.length && again.rows.length === 0, 'all three');

  // Clustering and a map of T cells: the agent's clusters equal a direct run with the same
  // settings, agree with the true cell types, and the proposal can be rejected cleanly.
  const exploreArgs = { population: 'T cells', samples: samples.slice(0, 4), clustering: 'flowsom', embedding: 'umap', k: 6, eventsPerSample: 1500, populations: true };
  const explored = (await tool('explore', exploreArgs, 'Explorer')).data;
  const exploreState = await page(`
    const run = await import('/ui/explore-run.js');
    const ws = app.store.ws;
    const popId = ws.gates.find((g) => g.name === 'T cells').id;
    const samples = ${JSON.stringify(samples.slice(0, 4))}.map((n) => ws.samples.find((s) => s.name === n));
    const record = ws.derived.find((d) => d.proposal && d.proposedBy === 'Explorer');
    const settings = { ...run.DEFAULT_SETTINGS, markers: record.params.markers, clustering: 'flowsom', embedding: 'none', k: 6, perSample: 1500 };
    const direct = await run.runExplore(app, { settings, samples, popId });
    let differ = 0;
    let total = 0;
    const truthLabels = [];
    const clusterLabels = [];
    for (const [id, columns] of direct.result.perSample) {
      const view = app.data.view(id);
      const a = view.derived.get('FlowSOM cluster');
      const d = columns['FlowSOM cluster'];
      const truth = view.column('Truth (simulated)');
      for (let e = 0; e < d.length; e += 1) {
        if (d[e] < 0) continue;
        total += 1;
        if (a[e] !== d[e]) differ += 1;
        if (truth && truthLabels.length < 40000) { truthLabels.push(truth[e]); clusterLabels.push(d[e]); }
      }
    }
    return { differ, total, gates: ws.gates.filter((g) => g.meta?.proposedBy === 'Explorer' || (g.meta?.proposal && g.dims[0]?.channel === 'FlowSOM cluster')).length, truthLabels, clusterLabels };`);
  const ari = exploreState.truthLabels.length ? adjustedRandIndex(Int32Array.from(exploreState.truthLabels), Int32Array.from(exploreState.clusterLabels)) : Number.NaN;
  check('explore: every T cell\'s FlowSOM cluster equals a direct run with the same settings; the clusters proposed as populations', `${exploreState.differ} of ${exploreState.total} differ; ${explored.clusters.length} clusters (${explored.clusters.slice(0, 3).map((c) => c.name).join(', ')}…); ${exploreState.gates} populations; map trustworthiness ${explored.quality?.trustworthiness}`, exploreState.differ === 0 && exploreState.total > 1000 && exploreState.gates === explored.clusters.length && explored.quality?.trustworthiness > 0.8, '0 differ; a population per cluster; trustworthiness > 0.8');
  check('explore: the clusters follow the true T-cell types (adjusted Rand index)', ari.toFixed(3), ari > 0.3, '> 0.3');
  await decide('Explorer', false);
  const rejected = await page(`const s = app.store.ws.samples.find((x) => x.name === ${JSON.stringify(samples[0])}); return { derived: app.store.ws.derived.filter((d) => d.outputs?.includes('FlowSOM cluster')).length, gates: app.store.ws.gates.filter((g) => g.dims[0]?.channel === 'FlowSOM cluster').length, attached: app.data.view(s.id).derived.has('FlowSOM cluster'), qcKept: app.store.ws.derived.filter((d) => d.kind === 'qc').length };`);
  check('rejecting removes the clusters, their populations and their channels, and nothing else (the accepted QC result stays)', JSON.stringify(rejected), rejected.derived === 0 && rejected.gates === 0 && !rejected.attached && rejected.qcKept === 1, 'none left; QC kept');

  // A gating-strategy figure, exported as SVG with its analysis.
  const figureDir = outDir;
  const fig = (await tool('build_figure', { kind: 'gating-strategy', population: 'T cells', sample: samples[0] })).data;
  const svgPath = join(figureDir, 'strategy.svg');
  await tool('export_figure', { path: svgPath });
  const record = readFigureProvenance(readFileSync(svgPath, 'utf8'));
  const figureRecord = record?.record ?? record;
  check('build_figure + export_figure: the SVG carries the analysis of every plot', `${fig.plots.length} plots; record of ${figureRecord?.plots?.length ?? figureRecord?.figure?.items?.length ?? 'no'} plots`, fig.plots.length >= 4 && Boolean(figureRecord) && (figureRecord.plots?.length ?? figureRecord.figure?.items?.filter((i) => i.kind === 'plot').length) === fig.plots.length, 'one per plot');
  const exists = await refused('export_figure', { path: svgPath });
  check('an export never replaces a file unless told to', exists ?? 'replaced', /exists/.test(exists ?? ''), 'refused');

  // A statistics table written as CSV equals statistics_table.
  const csvPath = join(figureDir, 'table.csv');
  await tool('export_table', { path: csvPath, statistic: 'freqParent' });
  const table = (await tool('statistics_table', { statistic: 'freqParent' })).data;
  const lines = readFileSync(csvPath, 'utf8').trim().split('\n').map((l) => l.split(','));
  const header = lines[0];
  let tableDiffer = 0;
  for (const row of table.rows) {
    const line = lines.find((l) => l[0] === row.sample);
    for (const [population, value] of Object.entries(row.values)) {
      const cell = line?.[header.indexOf(population)];
      if (Number(cell) !== value && !(cell === '' && value === null)) tableDiffer += 1;
    }
  }
  check('export_table: the CSV holds statistics_table\'s values', `${table.rows.length} rows; ${tableDiffer} cells differ`, table.rows.length > 5 && tableDiffer === 0, '0 differ');

  // After the QC gate, the FlowJo export says the gates on QC pass (a computed channel) are left out.
  const wspAfter = join(figureDir, 'pbmc-qc.wsp');
  const flowjoAfter = await tool('export_flowjo', { path: wspAfter, counts: false });
  check('export_flowjo after the QC gate: the populations under QC pass (a computed channel) reported as not exported', flowjoAfter.data.notExact.slice(0, 2).map((p) => `${p.population}: ${p.status}`).join('; '), flowjoAfter.data.notExact.some((p) => p.population === 'QC pass' && p.status === 'not exported'), 'QC pass not exported')
  const populations = (await tool('list_populations', { sample: samples[0] })).data.populations;
  const zipPath = join(figureDir, 'files.zip');
  await tool('export_fcs', { path: zipPath, samples: samples.slice(0, 2) });
  const files = await readZip(new Uint8Array(readFileSync(zipPath)));
  const originals = generateExample('pbmc-immunophenotyping', {}).files;
  let identical = 0;
  for (const [name, bytes] of files) {
    const mine = parseFCS(bytes).datasets[0];
    const original = parseFCS(originals.find((f) => f.name.replace(/\.fcs$/i, '') === name.replace(/\.fcs$/i, ''))?.bytes ?? new Uint8Array(0)).datasets[0];
    if (original && mine.eventCount === original.eventCount && mine.data.every((column, p) => column.every((v, e) => Object.is(v, original.data[p][e])))) identical += 1;
  }
  check('export_fcs: the de-identified files hold the same events as the originals', `${identical} of ${files.size} identical`, files.size === 2 && identical === 2, 'both');

  // Templates: the PBMC analysis saved, then applied to another experiment with the same panel.
  await decide('Claude Code', true);
  const saved = await tool('save_template', { name: 'PBMC analysis' });
  const listed = (await tool('list_templates')).data.templates;
  await tool('open_example', { id: 'flowjo-workspace' }, 'Template agent');
  await waitFor(`window.cytoweave.store.ws.samples.length > 0 && !document.querySelector('.progress-toast')`);
  await b.eval(`document.querySelectorAll('.dialog .icon-button').forEach((x) => x.click())`);
  const appliedTemplate = (await tool('apply_template', { template: 'PBMC analysis' }, 'Template agent')).data;
  const templateState = await page(`const ws = app.store.ws; return { proposed: ws.gates.filter((g) => g.meta?.proposal && g.meta?.origin === 'template').length, names: ws.gates.map((g) => g.name) };`);
  const unmatched = appliedTemplate.channels.filter((c) => !c.channel);
  check('save_template + apply_template: the analysis applied to another experiment of the same panel, every channel matched, its gates proposed', `${saved.message.slice(0, 70)}…; listed ${listed.length}; ${templateState.proposed} gates proposed (${templateState.names.slice(0, 4).join(', ')}…); ${unmatched.length} channels unmatched`, listed.some((t) => t.name === 'PBMC analysis') && templateState.proposed >= 6 && unmatched.length === 0 && appliedTemplate.skipped.length === 0, 'listed; >= 6 gates; all matched');

  // A published strategy: OMIP-101 placed on one sample of the PBMC example, the same gates as
  // placing it directly, each population with a suggested Cell Ontology term.
  await decide('Template agent', true);
  await tool('open_example', { id: 'pbmc-immunophenotyping' }, 'Strategy agent');
  await waitFor(`window.cytoweave.store.ws.samples.length > 0 && !document.querySelector('.progress-toast')`);
  await b.eval(`document.querySelectorAll('.dialog .icon-button').forEach((x) => x.click())`);
  const strategies = (await tool('list_templates')).data.strategies;
  const reference = (await tool('workspace_summary')).data.samples.find((s) => s.role === 'sample').name;
  const appliedStrategy = (await tool('apply_template', { template: 'omip-101', sample: reference }, 'Strategy agent')).data;
  const strategyState = await page(`
    const { applyTemplate } = await import('/lib/templates.js');
    const { placeOnSample } = await import('/lib/recipes.js');
    const { strategyById } = await import('/lib/strategies.js');
    const strategy = strategyById('omip-101');
    const ws = app.store.ws;
    const s = ws.samples.find((x) => x.name === ${JSON.stringify(reference)});
    const proposed = ws.gates.filter((g) => g.meta?.template === strategy.name);
    const base = { ...ws, gates: ws.gates.filter((g) => g.meta?.template !== strategy.name) };
    const direct = applyTemplate(base, strategy, { place: placeOnSample(app.data.view(s.id) ?? await app.data.ensure(s.id), s.name) });
    const same = direct.gates.filter((g, i) => proposed[i] && JSON.stringify(proposed[i].geometry) === JSON.stringify(g.geometry)).length;
    return { proposed: proposed.length, pending: proposed.filter((g) => g.meta?.proposal).length, same, direct: direct.gates.length, terms: proposed.filter((g) => g.ontology?.status === 'suggested').length };`);
  check('apply_template with a published strategy: OMIP-101 placed on one sample, every gate proposed, the same as placing it directly, with suggested Cell Ontology terms', `${strategies.length} strategies listed; ${strategyState.proposed} gates proposed (${strategyState.pending} pending review), ${strategyState.same} of ${strategyState.direct} as placed directly; ${strategyState.terms} with a suggested term; placed on ${appliedStrategy.placedOn}`, strategies.length === 2 && strategyState.proposed === 25 && strategyState.pending === 25 && strategyState.same === 25 && strategyState.terms === 19 && appliedStrategy.skipped.length === 0, '2 listed; 25 gates, all identical; 19 terms');

  // Titration and a voltage walk on their example: the agent's results equal the analysis run
  // directly in the page, and the saved result is proposed.
  await decide('Strategy agent', true);
  await tool('open_example', { id: 'titration-voltage' }, 'Setup agent');
  await waitFor(`window.cytoweave.store.ws.samples.length > 0 && !document.querySelector('.progress-toast')`);
  await b.eval(`document.querySelectorAll('.dialog .icon-button').forEach((x) => x.click())`);
  const titrated = (await tool('titration', { mode: 'titration' }, 'Setup agent')).data;
  const walked = (await tool('titration', { mode: 'voltage', save: true }, 'Setup agent')).data;
  const setupState = await page(`
    const lib = await import('/lib/titration.js');
    const { detectWalk } = await import('/ui/qc-titration.js');
    const ws = app.store.ws;
    const views = new Map();
    const series = lib.titrationSeries(ws.samples).steps;
    for (const x of series) views.set(x.sample.id, await app.data.ensure(x.sample.id));
    const t = lib.analyzeTitration(lib.stepsFrom(ws, series.map(({ sample, amount }) => ({ sample, view: views.get(sample.id), label: amount.label, amount })), { channel: 'PE-A', populationId: 'root' }));
    const walk = detectWalk(ws.samples);
    for (const x of walk) views.set(x.sample.id, await app.data.ensure(x.sample.id));
    const v = lib.analyzeVoltageWalk(lib.stepsFrom(ws, lib.voltageSeries(walk.map((x) => x.sample), views, 'PE-A').map(({ sample, voltage }) => ({ sample, view: views.get(sample.id), label: voltage + ' V', voltage })), { channel: 'PE-A', populationId: 'root' }));
    return { recommended: t.recommended?.row.amount.label, si: t.rows.map((r) => +r.stainIndex.toPrecision(4)), minimum: v.minimum?.voltage, maximum: v.maximum?.voltage, proposed: ws.derived.filter((d) => d.kind === 'titration' && d.proposal).length };`);
  const sameSI = titrated.rows.every((r, i) => r.stainIndex === setupState.si[i]);
  check('titration: a CD4-PE titration and a PE voltage walk on the example, the same as the analysis run directly, the saved walk proposed', `${titrated.channel}: recommended ${titrated.recommended} (direct ${setupState.recommended}), stain index of ${titrated.rows.length} steps ${sameSI ? 'equal' : 'differ'}; walk ${walked.minimumVoltage}–${walked.maximumVoltage} V (direct ${setupState.minimum?.toFixed(1)}–${setupState.maximum?.toFixed(1)}), recommended ${walked.recommendedVoltage} V; ${setupState.proposed} proposed`, titrated.channel === 'PE-A' && titrated.recommended === '125 ng' && setupState.recommended === '125 ng' && sameSI && Math.abs(walked.minimumVoltage - setupState.minimum) < 0.5 && Math.abs(walked.maximumVoltage - setupState.maximum) < 0.5 && setupState.proposed === 1, 'equal; 125 ng; proposed');

  // Comparisons with the unstained tube and rare-event statistics on the same example: the tools'
  // values equal the statistics computed directly in the page.
  const tubes = ['CD4-PE 125 ng', 'CD4-PE 1.953 ng'];
  const distributions = (await tool('compare_distributions', { control: 'Unstained', channel: 'PE-A', samples: tubes }, 'Setup agent')).data;
  const tabled = (await tool('statistics_table', { statistic: 'sed', channel: 'PE-A', control: 'Unstained', populations: ['All events'] }, 'Setup agent')).data;
  await tool('create_gate', { parent: 'All events', name: 'PE bright', type: 'range', x: 'PE-A', coordinates: { min: 30000 } }, 'Setup agent');
  const rare = (await tool('rare_events', { population: 'PE bright', samples: tubes, cv: 5 }, 'Setup agent')).data;
  const compareState = await page(`
    const { computeStatistic, countOf, populationSet } = await import('/lib/engine.js');
    const { poissonInterval } = await import('/lib/rare-events.js');
    const ws = app.store.ws;
    const control = ws.samples.find((s) => s.name === 'Unstained');
    const controlView = app.data.view(control.id) ?? await app.data.ensure(control.id);
    const bright = ws.gates.find((g) => g.name === 'PE bright').id;
    const out = [];
    for (const name of ${JSON.stringify(tubes)}) {
      const s = ws.samples.find((x) => x.name === name);
      const view = app.data.view(s.id) ?? await app.data.ensure(s.id);
      const spec = (stat) => ({ stat, gateId: 'root', channel: 'PE-A', control: { sampleId: control.id } });
      const context = { viewOf: (id) => (id === control.id ? controlView : null) };
      const column = view.column('PE-A');
      let above = 0;
      for (let e = 0; e < column.length; e += 1) if (column[e] >= 1000) above += 1;
      const count = countOf(populationSet(view, ws, bright), view);
      out.push({ name, sed: computeStatistic(view, ws, spec('sed'), context), T: computeStatistic(view, ws, spec('pbT'), context), above: 100 * above / column.length, count, interval: poissonInterval(count) });
    }
    return out;`);
  const close5 = (a, b) => Math.abs(a - b) <= 5e-5 * Math.max(1, Math.abs(b));
  const agree = compareState.every((d, i) => close5(distributions.rows[i].sed, d.sed) && close5(distributions.rows[i].probabilityBinning.T, d.T) && close5(tabled.rows.find((r) => r.sample === d.name).values['All events'], d.sed));
  const rareAgree = compareState.every((d, i) => rare.rows[i].count === d.count && close5(rare.rows[i].countInterval[0], d.interval[0]) && close5(rare.rows[i].countInterval[1], d.interval[1]));
  check('compare_distributions, statistics_table with a control and rare_events: each tube against the unstained one, and the counts of the brightest PE events, the same as computed directly; SED near the CD4+ share (the same cells in every tube: the share above the split at the saturating 125 ng), also at 1.953 ng, where dim CD4+ cells fall below the split', `${compareState.map((d, i) => `${d.name}: SED ${distributions.rows[i].sed}% (${d.above.toFixed(1)}% above 1,000), T(χ) ${distributions.rows[i].probabilityBinning.T}`).join('; ')}; ${agree ? 'equal' : 'differ'}; PE bright ${rare.rows.map((r) => `${r.count} [${r.countInterval.join('–')}], ${r.parentEventsForTargetCV} parent events for a 5% CV`).join('; ')}; ${rareAgree ? 'equal' : 'differ'}`, agree && rareAgree && compareState.every((d, i) => Math.abs(distributions.rows[i].sed - compareState[0].above) < 3), 'equal; SED within 3 points');

  // A formula channel and a bead calibration proposed by an agent, used at once.
  await tool('add_formula_channel', { name: 'PE per FSC', expression: '[PE-A] / [FSC-A] * 1000' }, 'Setup agent');
  const formulaTable = (await tool('statistics_table', { statistic: 'median', channel: 'PE per FSC', populations: ['All events'] }, 'Setup agent')).data;
  const formulaState = await page(`
    // The first three samples of the table.
    const ws = app.store.ws;
    const out = {};
    for (const s of ws.samples.filter((x) => ${JSON.stringify(formulaTable.rows.slice(0, 3).map((r) => r.sample))}.includes(x.name))) {
      const view = app.data.view(s.id) ?? await app.data.ensure(s.id);
      const pe = view.column('PE-A');
      const fsc = view.column('FSC-A');
      const values = Float64Array.from(pe, (v, i) => Math.fround((v / fsc[i]) * 1000)).filter(Number.isFinite).sort();
      const n = values.length;
      out[s.name] = n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
    }
    return { direct: out, proposed: Boolean(ws.derived.find((d) => d.kind === 'formula' && d.outputs[0] === 'PE per FSC')?.proposal) };`);
  const formulaAgree = Object.entries(formulaState.direct).every(([name, v]) => Math.abs(formulaTable.rows.find((r) => r.sample === name).values['All events'] - v) <= 1e-5 * Math.abs(v));
  check('add_formula_channel: a formula channel proposed and usable at once; its medians in statistics_table equal to the formula computed directly', `${Object.keys(formulaState.direct).length} samples ${formulaAgree ? 'equal' : 'differ'}; proposed: ${formulaState.proposed}`, formulaAgree && formulaState.proposed, 'equal; proposed');

  const beadDir = join(temp, 'beads');
  mkdirSync(beadDir);
  const sim = simulatedBeads();
  const beadParams = ['FSC-A', 'SSC-A', 'FL1-A', 'FL2-A'].map((name) => ({ name, label: '', range: name.startsWith('FL') ? 16384 : 262144 }));
  writeFileSync(join(beadDir, 'Beads.fcs'), encodeFCS(beadParams, beadParams.map((p) => sim.beads[p.name]), { $CYT: 'Simulated cytometer' }));
  const cell = sim.cells[1];
  const n = cell.values.length;
  writeFileSync(join(beadDir, 'Cells.fcs'), encodeFCS(beadParams, [Float32Array.from({ length: n }, () => 50000), Float32Array.from({ length: n }, () => 10000), cell.values, Float32Array.from(cell.values, (v) => v * 2)], { $CYT: 'Simulated cytometer' }));
  await tool('open_files', { paths: [join(beadDir, 'Beads.fcs'), join(beadDir, 'Cells.fcs')] }, 'Setup agent');
  await waitFor(`window.cytoweave.store.ws.samples.some((s) => s.name === 'Cells') && !document.querySelector('.progress-toast')`, 60000);
  const calibrated = (await tool('calibrate_beads', { sample: 'Beads', values: { 'FL1-A': BEAD_MEF }, clustering: ['FL1-A', 'FL2-A'], unit: 'MEFL', applyTo: ['Beads', 'Cells'] }, 'Setup agent')).data;
  const mefState = await page(`
    const ws = app.store.ws;
    const s = ws.samples.find((x) => x.name === 'Cells');
    const view = app.data.view(s.id) ?? await app.data.ensure(s.id);
    view.syncWorkspace(ws);
    const values = Float64Array.from(view.column('FL1-A MEFL')).sort();
    const record = ws.derived.find((d) => d.kind === 'calibration');
    return { median: values[values.length >> 1], proposed: Boolean(record?.proposal), samples: record?.samples?.length };`);
  const truthMedian = Float64Array.from(cell.truth).sort()[cell.truth.length >> 1];
  check('calibrate_beads: simulated 8-level beads of known response calibrated by an agent and applied to a cell sample; the cells\' median in MEFL against the truth', `slope ${calibrated.channels['FL1-A'].slope} (true ${BEAD_TRUTH.m}), ${calibrated.channels['FL1-A'].levels.filter((l) => l.used).length} of 8 levels; cells ${mefState.median?.toFixed(0)} MEFL (true ${truthMedian.toFixed(0)}); proposed for ${mefState.samples} samples`, Math.abs(calibrated.channels['FL1-A'].slope - BEAD_TRUTH.m) < 0.01 && Math.abs(mefState.median / truthMedian - 1) < 0.02 && mefState.proposed && mefState.samples === 2, 'slope within 0.01; within 2%; proposed');

  // 2. The spectral example: unmix builds and proposes a reference library, then unmixes; it equals
  // the same steps run directly.
  await tool('open_example', { id: 'spectral-25color' }, 'Spectral agent');
  await waitFor(`window.cytoweave.store.ws.samples.length > 0 && !document.querySelector('.progress-toast')`);
  const sample = (await tool('workspace_summary')).data.samples.find((s) => s.role === 'sample').name;
  const unmixed = (await tool('unmix', { samples: [sample] }, 'Spectral agent')).data;
  const spectral = await page(`
    const run = await import('/ui/spectral-run.js');
    const ws = app.store.ws;
    const s = ws.samples.find((x) => x.name === ${JSON.stringify(sample)});
    const direct = await run.unmixSamples(app, [s], {});
    const view = app.data.view(s.id);
    let worst = 0;
    let channels = 0;
    for (const [name, column] of Object.entries(direct.result.perSample.get(s.id))) {
      const a = view.derived.get(name);
      if (!a) continue;
      channels += 1;
      for (let e = 0; e < column.length; e += 1) worst = Math.max(worst, Math.abs(a[e] - column[e]));
    }
    const setup = ws.derived.find((d) => d.kind === 'spectral-setup');
    return { worst, channels, setupProposed: Boolean(setup?.proposal), afSignatures: setup?.autofluorescence?.signatures?.length ?? 0 };`);
  check('unmix: the reference library proposed (spectra and autofluorescence), and every unmixed channel equal to the same unmixing run directly', `${unmixed.references.length} references, ${spectral.afSignatures} autofluorescence signatures, complexity ${unmixed.complexityIndex}; ${spectral.channels} channels within ${spectral.worst}`, unmixed.references.length === 25 && spectral.setupProposed && spectral.afSignatures >= 1 && spectral.channels === unmixed.channels.length && spectral.worst === 0, '25 references, identical');

  // 3. QC as files are acquired: a watched folder's files are added and checked.
  const watched = join(temp, 'exports');
  mkdirSync(watched);
  await tool('watch_folder', { action: 'start', path: watched });
  const plate = generateExample('qc-showcase', {}).files.slice(0, 2);
  for (const file of plate) writeFileSync(join(watched, file.name), file.bytes);
  let status;
  for (let i = 0; i < 120; i += 1) {
    status = (await tool('watch_folder', { action: 'status' })).data;
    if (status.files.length === plate.length && status.files.every((f) => f.state === 'checked')) break;
    await sleep(1000);
  }
  await tool('watch_folder', { action: 'stop' });
  check('watch_folder: each file the instrument writes is added and checked', status.files.map((f) => `${f.file} ${f.state} ${f.score ?? ''}`).join('; '), status.files.length === plate.length && status.files.every((f) => f.state === 'checked' && Number.isFinite(f.score)), 'both checked with a score');
} catch (error) {
  check('session ran', error.stack?.split('\n').slice(0, 3).join(' | ') ?? error.message, false, 'no error');
} finally {
  await b?.close();
  stopServer();
  rmSync(temp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} agent-session checks passed.`);
if (failed.length) process.exit(1);
