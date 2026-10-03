// CytoWeave's validation suite. Unit tests (web/lib/*.test.mjs) check functions in isolation; this
// suite runs the real pipelines on realistic simulated experiments whose answers are known (the
// simulator keeps the true population of every event, the true spillover, phase fractions,
// generation frequencies and abundances) and on published reference values, and reports how
// closely CytoWeave agrees, against stated tolerances.
//
//   node validation/run.mjs [suite …] [--verbose]
//
// Suites: fcs, compensation, gating, qc, spectral, cellcycle, proliferation, clustering,
// normalization, debarcode, transforms, flowjo, figures, reference, gatingml, flowkit, fcsparser,
// diva, bioconductor
// (all by default). Exits with status 1 when a check fails.
//
// Suites marked "external data" need files that node validation/fetch.mjs downloads into
// validation/cache/; without them the suite is skipped (and fails with --require-data, as in CI).

import { generateExample } from '../web/lib/examples.js';
import { FCSError, parseFCS, readSpillover, writeFCS } from '../web/lib/fcs.js';
import { compensate, computeSpillover, controlResiduals, leanCheck } from '../web/lib/compensation.js';
import { SampleView, countOf, population } from '../web/lib/engine.js';
import { importFlowJo } from '../web/lib/flowjo.js';
import { builtCase, bundledCase, flowKitCases } from './flowjo-export-cases.mjs';
import { deidentifyFCS } from '../web/lib/deidentify.js';
import { buildProvenance, compareProvenance, embedPNG, embedSVG, pdfAttachment, readFigureProvenance, rebuildWorkspace } from '../web/lib/figure-provenance.js';
import { writePDF } from '../web/lib/pdf.js';
import { buildFlowJoMigration, matchFlowJoSamples, migrationCountRows } from '../web/lib/flowjo-match.js';
import { createWorkspace, addGates, addCompensation, addDerived, addSamples, sampleFromDataset } from '../web/lib/workspace.js';
import { importGatingML } from '../web/lib/gatingml.js';
import { peacoQC, flowRateCheck } from '../web/lib/qc.js';
import { autoGateControl, referenceSpectrum, extractAutofluorescence, unmixOLS, unmixWithAutofluorescence } from '../web/lib/spectral.js';
import { dnaHistogram, fitDeanJettFox, fitWatsonPragmatic } from '../web/lib/cellcycle.js';
import { fitProliferation } from '../web/lib/proliferation.js';
import { flowsom, mapToSOM, hclust, cutTree, distanceMatrix } from '../web/lib/flowsom.js';
import { adjustedRandIndex } from '../web/lib/cluster-summary.js';
import { trainCytoNorm, applyCytoNorm, batchDiagnostics } from '../web/lib/normalize.js';
import { combinationKey, debarcode } from '../web/lib/debarcode.js';
import { welchTTest, studentTTest, pairedTTest, mannWhitneyU, adjustPValues, studentTQuantile } from '../web/lib/hypothesis.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createTransform, applyTransform, biexTable, estimateLogicleW } from '../web/lib/transforms.js';
import { createRandom, sampleIndices } from '../web/lib/random.js';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const requireData = args.includes('--require-data');
const requested = args.filter((a) => !a.startsWith('--'));

const results = [];
function check(suite, name, value, ok, required) {
  results.push({ suite, name, value, ok, required });
  if (verbose || !ok) console.log(`${ok ? 'ok  ' : 'FAIL'} ${suite}: ${name} — ${value} (required ${required})`);
}

const fmt = (v, d = 3) => (Number.isFinite(v) ? Number(v.toFixed(d)).toString() : String(v));
const pct = (v) => `${(100 * v).toFixed(2)}%`;

function load(file) {
  const dataset = parseFCS(file.bytes).datasets[0];
  return dataset;
}

function columnsOf(dataset) {
  return Object.fromEntries(dataset.parameters.map((p) => [p.name, dataset.data[p.index]]));
}

function qcSample(dataset) {
  return { eventCount: dataset.eventCount, channels: dataset.parameters.map((p) => ({ name: p.name, type: p.type, range: p.range })), columns: columnsOf(dataset) };
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0; let mb = 0;
  for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma; const y = b[i] - mb;
    sab += x * y; saa += x * x; sbb += y * y;
  }
  return sab / Math.sqrt(saa * sbb);
}

function median(values) {
  const s = Float64Array.from(values).sort();
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : Number.NaN;
}

// External data (validation/sources.json, fetched into validation/cache/ by fetch.mjs).
const sources = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
class MissingData extends Error {}
function dataset(name) {
  const set = sources.datasets[name];
  const root = new URL(`./cache/${name}/`, import.meta.url);
  const missing = set.files.filter((f) => {
    const path = new URL(f.path, root);
    return !existsSync(path) || statSync(path).size !== f.size;
  });
  if (missing.length) throw new MissingData(`${missing.length} of ${set.files.length} files of "${name}" are missing; run node validation/fetch.mjs ${name}`);
  return { read: (path) => readFileSync(new URL(path, root)), text: (path) => readFileSync(new URL(path, root), 'utf8'), files: set.files.map((f) => f.path) };
}

// A NumPy .npy array (little-endian float64 or int64, C order): { shape, values }.
function readNpy(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.toString('latin1', 1, 6) !== 'NUMPY') throw new Error('not a .npy file');
  const start = b[6] === 1 ? 10 : 12;
  const length = b[6] === 1 ? b.readUInt16LE(8) : b.readUInt32LE(8);
  const header = b.toString('latin1', start, start + length);
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  if (/'fortran_order':\s*True/.test(header)) throw new Error('Fortran-ordered .npy files are not read');
  const shape = /'shape':\s*\(([^)]*)\)/.exec(header)[1].split(',').map((v) => v.trim()).filter(Boolean).map(Number);
  const data = b.subarray(start + length);
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (descr === '<f8') return { shape, values: new Float64Array(buffer) };
  if (descr === '<i8') return { shape, values: Float64Array.from(new BigInt64Array(buffer), Number) };
  throw new Error(`.npy data type ${descr} is not read`);
}

// A FlowJo workspace imported as the app imports it (match samples, build the migration with
// FlowJo's compensation and scales) and every population recomputed by the engine, as the
// migration report does. files: [{ name, bytes }]. Returns the report rows (FlowJo's count beside
// CytoWeave's) and the import's fidelity entries.
function flowJoMigration(xml, files) {
  const result = importFlowJo(xml);
  let ws = createWorkspace('FlowJo import');
  const datasets = new Map();
  for (const file of files) {
    const data = parseFCS(file.bytes).datasets[0];
    const record = sampleFromDataset(data, { name: file.name });
    datasets.set(record.id, data);
    ws = addSamples(ws, [record]);
  }
  const plan = buildFlowJoMigration(ws, result, matchFlowJoSamples(result.samples, ws.samples), { scales: true, compensation: true });
  ws = plan.ws;
  const counts = {};
  for (const target of plan.migration.samples) {
    if (!target.sampleId) continue;
    const record = ws.samples.find((s) => s.id === target.sampleId);
    const data = datasets.get(record.id);
    const view = new SampleView(record, data);
    const id = record.compensationId ?? 'none';
    if (id === 'file') {
      const spill = readSpillover(data.keywords, data.parameters);
      if (spill && !spill.identity) view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
    } else if (id !== 'none') {
      const comp = ws.compensations.find((c) => c.id === id);
      view.setCompensation({ id: comp.id, channels: comp.channels, matrix: comp.matrix });
    }
    const out = {};
    for (const [path, gateId] of Object.entries(plan.migration.gates)) {
      const members = population(view, ws, gateId);
      out[path] = members === undefined ? null : countOf(members, view);
    }
    counts[target.sampleId] = out;
  }
  return { rows: migrationCountRows(plan.migration, counts), fidelity: result.fidelity };
}

// A FlowJo export case (flowjo-export-cases.mjs): the round trip, and what was not exported.
function exportChecks(suite, c) {
  const traced = (r) => c.report.populations.some((p) => p.status === 'approximated' && r.path.endsWith(p.path.split('/').pop()));
  const exact = c.rows.filter((r) => r.flowjo === r.cytoweave);
  const close = c.rows.filter((r) => r.flowjo !== r.cytoweave && traced(r) && Math.abs(r.cytoweave - r.flowjo) <= Math.max(2, 0.005 * r.flowjo));
  const { exact: e, approximated: a, omitted: o } = c.report.summary;
  check(suite, `${c.name}: exported to FlowJo and imported back, counts unchanged (${e} population${e === 1 ? '' : 's'} exact, ${a} traced on another scale, ${o} not exported)`, `${exact.length} of ${c.rows.length} identical${close.length ? `, ${close.length} traced within 0.5%` : ''}`, exact.length + close.length === c.rows.length && c.rows.length > 0, 'all (traced outlines within 0.5%)');
  const lost = c.fidelity.filter((f) => f.status === 'unsupported');
  check(suite, `${c.name}: the export imports without unsupported populations`, lost.length ? lost.slice(0, 2).map((f) => `${f.path}: ${f.detail}`).join('; ') : 'none', !lost.length, 'none');
  if (c.kind === 'cytoweave') {
    const omitted = c.report.populations.filter((p) => p.status === 'omitted').map((p) => p.path);
    check(suite, `${c.name}: populations FlowJo cannot evaluate are reported, not written`, `${[...new Set(omitted)].join(', ')}`, omitted.length > 0 && omitted.every((p) => /QC pass/.test(p)), 'the category gate only');
  }
}

// FlowKit's counts on an exported workspace (reference/flowkit.json "exports"): against
// CytoWeave's, and against FlowKit's on the original workspace and FlowJo's saved counts.
function flowKitExportChecks(c, ref, originals) {
  const fk = ref.exports?.[c.name];
  if (!fk || fk.error) {
    check('flowkit', `${c.name}: FlowKit reads CytoWeave's FlowJo export`, fk?.error ?? 'not generated (run write_flowjo_exports.mjs and generate_flowkit.py)', false, 'read');
    return;
  }
  const key = (sample, path) => `${sample}|${path}`;
  const exported = new Map(fk.populations.map((p) => [key(p.sample, p.path.join('/')), p.count]));
  const isEllipse = (path) => c.report.populations.some((p) => /ellipse/i.test(p.path.split('/').pop()) && path.endsWith(p.path.split('/').pop())) || /ellipse/i.test(path.split('/').pop());
  let same = 0;
  const ellipses = [];
  const differ = [];
  for (const r of c.rows) {
    const n = exported.get(key(r.sampleName, r.path));
    if (n === r.flowjo) same += 1;
    else if (n !== undefined && isEllipse(r.path) && Math.abs(n - r.flowjo) <= Math.max(5, 0.001 * r.flowjo)) ellipses.push(r.path);
    else differ.push(`${r.sampleName} ${r.path}: FlowKit ${n}, CytoWeave ${r.flowjo}`);
  }
  check('flowkit', `${c.name}: FlowKit reads CytoWeave's FlowJo export; populations whose count equals CytoWeave's`, `${same} of ${c.rows.length}${ellipses.length ? ` (${ellipses.length} ellipse${ellipses.length === 1 ? '' : 's'} within 0.1%: FlowKit and CytoWeave decide ellipse boundary events differently${c.source ? ', as on the original workspace' : ''})` : ''}${differ.length ? `; ${differ.slice(0, 2).join('; ')}` : ''}`, !differ.length && c.rows.length > 0, 'all (ellipses within 0.1%)');
  if (!c.source) return;
  const original = new Map((ref.workspaces[c.source]?.populations ?? []).map((p) => [key(p.sample, p.path.join('/')), p.count]));
  const flowJoSaved = new Map(originals.rows.map((r) => [key(r.sampleName, r.path), r.flowjo]));
  let unchanged = 0;
  let closer = 0;
  const worse = [];
  for (const [k, n] of exported) {
    if (!original.has(k)) continue;
    const before = original.get(k);
    const saved = flowJoSaved.get(k);
    if (before === n) unchanged += 1;
    else if (saved >= 0 && Math.abs(n - saved) <= Math.abs(before - saved)) closer += 1;
    else worse.push(`${k}: ${before} → ${n} (FlowJo ${saved})`);
  }
  check('flowkit', `${c.name}: FlowKit's counts on the export vs on the original workspace`, `${unchanged} unchanged${closer ? `, ${closer} closer to FlowJo's saved counts (time gates, which the export writes in $TIMESTEP units)` : ''}${worse.length ? `; ${worse.slice(0, 2).join('; ')}` : ''}`, !worse.length && unchanged + closer === original.size, 'each unchanged or closer to FlowJo');
}

// De-identified files: the same events as the original, and only allowlisted keywords.
function deidentifyChecks(suite, label, files) {
  let readable = 0;
  let identical = 0;
  const problems = [];
  for (const file of files) {
    let before;
    try {
      before = parseFCS(file.bytes);
    } catch {
      continue;
    }
    readable += 1;
    try {
      const after = parseFCS(deidentifyFCS(file.bytes).bytes);
      let same = after.datasets.length === before.datasets.length;
      for (let d = 0; same && d < before.datasets.length; d += 1) {
        const x = before.datasets[d];
        const y = after.datasets[d];
        same = x.eventCount === y.eventCount && x.data.length === y.data.length;
        for (let p = 0; same && p < x.data.length; p += 1) for (let e = 0; e < x.eventCount; e += 1) if (!Object.is(x.data[p][e], y.data[p][e])) { same = false; break; }
      }
      if (same) identical += 1;
      else problems.push(file.name);
    } catch (error) {
      problems.push(`${file.name}: ${error.message}`);
    }
  }
  check(suite, `${label}: de-identified files hold the same events (bit-exact)`, `${identical} of ${readable}${problems.length ? `; ${problems.slice(0, 2).join('; ')}` : ''}`, identical === readable && readable > 0, 'all');
}

// --- Suites ---------------------------------------------------------------------------------------

const suites = {
  fcs() {
    const all = [];
    for (const id of ['pbmc-immunophenotyping', 'flowjo-workspace', 'spectral-25color', 'cell-cycle', 'proliferation', 'cytof-cohort', 'cytof-barcoded', 'index-sort', 'qc-showcase']) {
      const { files } = generateExample(id, { scale: 0.05 });
      all.push(...files);
      let problems = 0;
      let exact = true;
      for (const file of files) {
        const d = load(file);
        problems += d.diagnostics.filter((x) => x.level !== 'info').length;
        const again = load({ bytes: writeFCS({ parameters: d.parameters.map((p) => ({ name: p.name, label: p.label, range: p.range })), data: d.data, keywords: d.keywords }) });
        for (let p = 0; p < d.parameters.length && exact; p += 1) {
          const a = d.data[p]; const b = again.data[p];
          for (let e = 0; e < a.length; e += 1) if (!Object.is(a[e], b[e])) { exact = false; break; }
        }
      }
      check('fcs', `${id}: ${files.length} files parse without warnings`, `${problems} warning(s)`, problems === 0, '0');
      check('fcs', `${id}: write and read back`, exact ? 'bit-exact' : 'differs', exact, 'bit-exact');
    }
    deidentifyChecks('fcs', `${all.length} example files`, all);
  },

  compensation() {
    const { files, workspaceHints } = generateExample('pbmc-immunophenotyping', {});
    const controls = files.filter((f) => f.meta.role === 'single-stain' && f.meta.stain);
    const unstained = files.find((f) => f.meta.role === 'unstained');
    const sample = files.find((f) => f.name === 'D01_Unstim.fcs');
    const sampleData = load(sample);
    const written = readSpillover(sampleData.keywords, sampleData.parameters);
    const key = generateExample.answerKey ?? null;
    void key;
    const error = { from: 'APC-A', to: 'Alexa Fluor 700-A', true: 0.1569 };
    const detectors = written.channels;
    const truth = Float64Array.from(written.matrix);
    truth[detectors.indexOf(error.from) * detectors.length + detectors.indexOf(error.to)] = error.true;
    const inputs = controls.filter((f) => detectors.includes(f.meta.stain)).map((f) => ({ channel: f.meta.stain, columns: columnsOf(load(f)) }));
    const unstainedCols = { columns: columnsOf(load(unstained)) };
    for (const method of ['median', 'regression']) {
      const result = computeSpillover(inputs, detectors, { method, positiveFraction: 0.3, negativeFraction: 0.3 });
      let worst = 0;
      let where = '';
      for (let i = 0; i < truth.length; i += 1) {
        const d = Math.abs(result.matrix[i] - truth[i]);
        if (d > worst) { worst = d; where = `${detectors[Math.floor(i / detectors.length)]} → ${detectors[i % detectors.length]}`; }
      }
      check('compensation', `spillover from ${inputs.length} single-stain controls (${method}): largest error`, `${fmt(worst, 4)} at ${where}`, worst < 0.02, '< 0.02');
    }
    void unstainedCols;
    // The planted error in $SPILLOVER: checking the file's matrix against the single-stain
    // controls finds it first and suggests a value near the truth.
    const residuals = controlResiduals(inputs, written);
    const top = residuals[0];
    const found = top && top.from === error.from && top.to === error.to;
    check('compensation', 'control check finds the planted APC → Alexa Fluor 700 error first', top ? `${top.from} → ${top.to} (${fmt(top.residual, 4)})` : 'none', found, error.from + ' → ' + error.to);
    if (found) check('compensation', 'suggested correction vs true spillover', `${fmt(top.suggested, 4)} vs ${error.true}`, Math.abs(top.suggested - error.true) < 0.01, '±0.01');
    const others = residuals.filter((r) => !(r.from === error.from && r.to === error.to));
    check('compensation', 'largest residual of the correct entries', `${fmt(Math.abs(others[0]?.residual ?? 0), 4)}`, Math.abs(others[0]?.residual ?? 0) < 0.02, '< 0.02');
    // The viability control's positives are dead cells, more autofluorescent than its negatives:
    // their residuals spread over several detectors and are flagged as such, the planted error is not.
    const broad = [...new Set(residuals.filter((r) => r.broad).map((r) => r.from))];
    check('compensation', 'autofluorescent positives (dead cells, viability control) are told apart from spillover errors', `flagged: ${broad.join(', ') || 'none'}`, broad.length === 1 && broad[0] === 'BV510-A' && !top.broad, 'BV510-A only');
    void leanCheck; void compensate;
    void workspaceHints;
  },

  gating() {
    const { files, workspaceHints } = generateExample('pbmc-immunophenotyping', { samples: ['D01_Unstim.fcs', 'D03_Stim.fcs'] });
    let ws = createWorkspace('validation');
    ws = addGates(ws, workspaceHints.suggestedGates).ws;
    const byName = (name) => ws.gates.find((g) => g.name === name);
    const groups = {
      Lymphocytes: (n) => /( T|T$|NK| B|^B|Plasmablast|Other lymphoid|Gamma-delta)/.test(n) && !/monocyte|DC|Basophil|Neutrophil/i.test(n),
      Monocytes: (n) => /monocyte/i.test(n),
      'T cells': (n) => / T$|T cells?$|Regulatory T|Gamma-delta T|TEMRA/.test(n),
    };
    for (const file of files.filter((f) => /^D0/.test(f.name))) {
      const d = load(file);
      const view = new SampleView({ id: file.name, name: file.name, keywords: d.keywords, technology: 'conventional' }, d);
      const spill = readSpillover(d.keywords, d.parameters);
      view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
      const names = file.meta.truth.names;
      const labels = file.meta.truth.labels;
      for (const [gateName, isMember] of Object.entries(groups)) {
        const gate = byName(gateName);
        if (!gate) continue;
        const members = population(view, ws, gate.id);
        const inGate = new Uint8Array(d.eventCount);
        for (const e of members) inGate[e] = 1;
        let tp = 0; let fp = 0; let fn = 0;
        for (let e = 0; e < d.eventCount; e += 1) {
          const label = labels[e];
          const truth = label >= 0 && isMember(names[label]);
          if (inGate[e] && truth) tp += 1; else if (inGate[e]) fp += 1; else if (truth) fn += 1;
        }
        const precision = tp / (tp + fp);
        const recall = tp / (tp + fn);
        check('gating', `${file.name} ${gateName}: precision / recall against true cell types`, `${pct(precision)} / ${pct(recall)}`, precision > 0.9 && recall > 0.85, '> 90% / > 85%');
      }
    }
  },

  qc() {
    // Each file with its example's display scales, which the QC view passes to PeacoQC.
    const withScales = ({ files, workspaceHints }) => files.map((file) => ({ file, transforms: Object.fromEntries(Object.entries(workspaceHints?.channelSettings ?? {}).map(([name, setting]) => [name, setting.transform])) }));
    const cases = [...withScales(generateExample('qc-showcase', {})), ...withScales(generateExample('pbmc-immunophenotyping', { samples: ['D05_Unstim.fcs', 'D02_Unstim.fcs'] })).filter(({ file }) => /^D0/.test(file.name))];
    for (const { file, transforms } of cases) {
      const d = load(file);
      const time = d.data[d.parameters.findIndex((p) => p.type === 'time')];
      const inWindow = new Uint8Array(d.eventCount);
      for (const w of file.meta.truth?.anomalies ?? []) for (let i = 0; i < d.eventCount; i += 1) if (time[i] >= w.startTime && time[i] <= w.endTime) inWindow[i] = 1;
      // As the QC view runs it: on compensated values (the file's $SPILLOVER), every scatter and
      // fluorescence channel, on the workspace's scales.
      const sample = qcSample(d);
      const spill = readSpillover(d.keywords, d.parameters);
      if (spill) sample.columns = { ...sample.columns, ...compensate(sample.columns, spill) };
      const channels = d.parameters.filter((p) => p.type === 'scatter' || p.type === 'fluorescence').map((p) => p.name);
      const pq = peacoQC(sample, { channels, transforms });
      const fr = flowRateCheck(sample, { timestep: Number(d.keywords.$TIMESTEP) });
      let anomalous = 0; let caught = 0; let falseRemoved = 0;
      for (let i = 0; i < d.eventCount; i += 1) {
        const removed = !pq.mask[i] || !fr.mask[i];
        if (inWindow[i]) { anomalous += 1; if (removed) caught += 1; } else if (removed) falseRemoved += 1;
      }
      const falseRate = falseRemoved / (d.eventCount - anomalous);
      const label = `${file.name}${anomalous ? ` (${pct(anomalous / d.eventCount)} anomalous)` : ' (clean)'}`;
      if (anomalous) check('qc', `${label}: anomalous events removed`, pct(caught / anomalous), caught / anomalous > 0.95, '> 95%');
      check('qc', `${label}: clean events removed`, pct(falseRate), falseRate < (anomalous ? 0.06 : 0.01), anomalous ? '< 6%' : '< 1%');
    }
  },

  spectral() {
    const { files, workspaceHints } = generateExample('spectral-25color', {});
    const detectors = workspaceHints.spectral.detectors;
    const unstained = load(files.find((f) => f.meta.role === 'unstained'));
    const uCols = columnsOf(unstained);
    const spectra = [];
    let worstCosine = 1;
    for (const file of files.filter((f) => f.meta.role === 'single-stain')) {
      const d = load(file);
      const cols = columnsOf(d);
      // As the Spectral view does by default: each control's own negative events (bead controls
      // must not borrow the unstained cells' autofluorescence).
      const gate = autoGateControl(cols, detectors, {});
      const ref = referenceSpectrum(cols, detectors, gate.positive, gate.negative, {});
      const truth = workspaceHints.spectral.signatures?.[file.meta.stain];
      if (truth) {
        let dot = 0; let na = 0; let nb = 0;
        for (let i = 0; i < detectors.length; i += 1) { dot += ref.spectrum[i] * truth[i]; na += ref.spectrum[i] ** 2; nb += truth[i] ** 2; }
        worstCosine = Math.min(worstCosine, dot / Math.sqrt(na * nb));
      }
      spectra.push({ name: file.meta.stain, spectrum: ref.spectrum, detectors });
    }
    check('spectral', `${spectra.length} reference spectra from single-stain controls vs generating spectra (worst cosine)`, fmt(worstCosine, 4), worstCosine > 0.99, '> 0.99');
    const af = extractAutofluorescence(uCols, detectors, {});
    check('spectral', 'autofluorescence signatures found in the unstained control', String(af.k), af.k === 2, '2 (lymphoid and myeloid)');
    const donor = files.find((f) => /Donor/.test(f.name));
    const d = load(donor);
    const result = unmixWithAutofluorescence(columnsOf(d), spectra, af.signatures, { detectors });
    // The oracle unmixes with the generating spectra: what any software could reach, given the
    // spreading error of the panel itself (a dim marker beside a bright, similar dye stays noisy).
    const oracleSpectra = spectra.map((sp) => ({ name: sp.name, spectrum: workspaceHints.spectral.signatures[sp.name], detectors }));
    const oracle = unmixWithAutofluorescence(columnsOf(d), oracleSpectra, af.signatures, { detectors });
    const truthNames = donor.meta.truth.abundanceNames;
    const rows = [];
    for (const [f, name] of result.names.entries()) {
      const t = truthNames.indexOf(name);
      if (t < 0) continue;
      const truth = donor.meta.truth.abundances[t];
      rows.push({ name, r: pearson(result.abundances[f], truth), oracle: pearson(oracle.abundances[oracle.names.indexOf(name)], truth) });
    }
    const mid = median(rows.map((row) => row.r));
    check('spectral', `unmixed abundances vs truth, ${rows.length} fluorochromes (median Pearson r)`, fmt(mid, 4), mid > 0.97, '> 0.97');
    rows.sort((x, y) => (x.r - x.oracle) - (y.r - y.oracle));
    const worst = rows[0];
    check('spectral', 'largest shortfall against unmixing with the true spectra', `${worst.name}: r = ${fmt(worst.r, 3)} vs ${fmt(worst.oracle, 3)}`, worst.r > worst.oracle - 0.02, 'within 0.02');
    const hardest = rows.slice().sort((x, y) => x.oracle - y.oracle)[0];
    check('spectral', 'hardest fluorochrome (limited by spreading, not by software)', `${hardest.name}: r = ${fmt(hardest.r, 3)}, true spectra give ${fmt(hardest.oracle, 3)}`, true, 'reported');
  },

  cellcycle() {
    const { files } = generateExample('cell-cycle', {});
    for (const file of files) {
      const d = load(file);
      const names = file.meta.truth.names;
      const labels = file.meta.truth.labels;
      const pi = d.data[d.parameters.findIndex((p) => p.name === 'PI-A')];
      const keep = [];
      for (let e = 0; e < d.eventCount; e += 1) if (['G1', 'S', 'G2/M'].includes(names[labels[e]])) keep.push(e);
      const truth = { G1: 0, S: 0, G2: 0 };
      for (const e of keep) { const n = names[labels[e]]; truth[n === 'G2/M' ? 'G2' : n] += 1; }
      for (const k of Object.keys(truth)) truth[k] /= keep.length;
      const histogram = dnaHistogram(pi, { indices: Uint32Array.from(keep) });
      for (const [model, fit] of [['Dean–Jett–Fox', fitDeanJettFox], ['Watson', fitWatsonPragmatic]]) {
        const r = fit(histogram, {});
        const got = { G1: r.percentG1 / 100, S: r.percentS / 100, G2: r.percentG2 / 100 };
        const worst = Math.max(...Object.keys(truth).map((k) => Math.abs(got[k] - truth[k])));
        // Watson's model estimates S phase as the remainder between flank fits, so it is
        // expected to be less exact than Dean–Jett–Fox (Watson et al. 1987).
        const limit = model === 'Watson' ? 0.03 : 0.02;
        check('cellcycle', `${file.name} ${model}: largest phase error`, `${(100 * worst).toFixed(2)} points`, worst < limit, `< ${100 * limit} points`);
      }
    }
  },

  proliferation() {
    const { files } = generateExample('proliferation', {});
    const stim = files.find((f) => f.name === 'Day4_aCD3CD28.fcs');
    const d = load(stim);
    const names = stim.meta.truth.names;
    const labels = stim.meta.truth.labels;
    const ctv = d.parameters.find((p) => /CellTrace|CTV/i.test(`${p.marker} ${p.label}`)) ?? d.parameters.find((p) => p.name === 'BV421-A');
    const spill = readSpillover(d.keywords, d.parameters);
    const comp = spill ? { ...columnsOf(d), ...compensate(columnsOf(d), spill) } : columnsOf(d);
    // Generation 0 is placed from the unstimulated culture of the same day, as FlowJo and Roederer
    // (2011) advise: undivided cells lose dye over the culture (here 90 000 on day 0, 70 000 on
    // day 4), and in a strongly stimulated culture the undivided peak is too small to find alone.
    const day0File = files.find((f) => f.name === 'Day4_Unstim.fcs');
    const day0 = load(day0File);
    const day0Spill = readSpillover(day0.keywords, day0.parameters);
    const day0Cols = day0Spill ? { ...columnsOf(day0), ...compensate(columnsOf(day0), day0Spill) } : columnsOf(day0);
    for (const lineage of ['CD4', 'CD8']) {
      const indices = [];
      for (let e = 0; e < d.eventCount; e += 1) if (names[labels[e]]?.startsWith(`${lineage} T gen`)) indices.push(e);
      const zero = [];
      for (let e = 0; e < day0.eventCount; e += 1) if (day0File.meta.truth.names[day0File.meta.truth.labels[e]]?.startsWith(`${lineage} T gen`)) zero.push(day0Cols[ctv.name][e]);
      const fit = fitProliferation(comp[ctv.name], { indices: Uint32Array.from(indices), undividedPeak: median(zero) });
      const truth = stim.meta.truth.proliferation[lineage];
      const di = fit.indices?.divisionIndex ?? fit.divisionIndex;
      const divided = fit.indices?.percentDivided ?? fit.percentDivided;
      check('proliferation', `${lineage} T division index`, `${fmt(di, 3)} vs ${fmt(truth.divisionIndex, 3)}`, Math.abs(di - truth.divisionIndex) / truth.divisionIndex < 0.08, '±8%');
      check('proliferation', `${lineage} T % divided`, `${fmt(divided, 1)} vs ${fmt(truth.percentDivided, 1)}`, Math.abs(divided - truth.percentDivided) < 4, '±4 points');
    }
  },

  clustering() {
    const { files } = generateExample('cytof-cohort', { scale: 0.4 });
    const file = files.find((f) => f.meta.role === 'sample');
    const d = load(file);
    const markers = d.parameters.filter((p) => p.type === 'fluorescence' && p.marker && !/(dna|bead|ce140|eu15|ho165|lu175|cisplatin|barcode|^1\d\d[a-z]{1,2}$)/i.test(`${p.marker} ${p.name}`)).map((p) => p.index);
    const names = file.meta.truth.names;
    const labels = file.meta.truth.labels;
    const cells = [];
    for (let e = 0; e < d.eventCount; e += 1) if (labels[e] >= 0 && !/bead|debris|doublet|dead/i.test(names[labels[e]])) cells.push(e);
    const picked = sampleIndices(cells.length, Math.min(20000, cells.length), createRandom(3), Uint32Array.from(cells));
    const transform = createTransform({ type: 'arcsinh', cofactor: 5, max: 20000 });
    const scaled = markers.map((p) => applyTransform(d.data[p], transform));
    const dim = markers.length;
    const matrix = new Float32Array(picked.length * dim);
    picked.forEach((e, r) => { for (let c = 0; c < dim; c += 1) matrix[r * dim + c] = scaled[c][e]; });
    const truth = Int32Array.from(picked, (e) => labels[e]);
    const k = new Set(truth).size;
    const result = flowsom(matrix, picked.length, dim, { k, seed: 1 });
    const ari = adjustedRandIndex(result.labels, truth);
    check('clustering', `FlowSOM (${dim} markers, k = ${k}) vs ${k} true populations: adjusted Rand index`, fmt(ari, 3), ari > 0.7, '> 0.7');
  },

  normalization() {
    const { files, workspaceHints } = generateExample('cytof-cohort', { scale: 0.3 });
    const anchors = workspaceHints.normalization.anchors;
    const channels = load(files[0]).parameters.filter((p) => p.type === 'fluorescence' && p.marker && /^CD/i.test(p.marker)).map((p) => p.name);
    const samples = files.map((f) => ({ file: f, data: load(f) }));
    const toSample = (s) => qcSample(s.data);
    const batchOf = (f) => f.meta.batch;
    const references = Object.entries(anchors).map(([batch, name]) => ({ batch, sample: toSample(samples.find((s) => s.file.name === name)) }));
    const model = trainCytoNorm(references, { channels, technology: 'mass' });
    const anchorSamples = samples.filter((s) => Object.values(anchors).includes(s.file.name));
    const before = anchorSamples.map(toSample);
    const after = anchorSamples.map((s) => {
      const out = applyCytoNorm(model, toSample(s), batchOf(s.file));
      return { ...toSample(s), columns: { ...toSample(s).columns, ...(out.columns ?? out) } };
    });
    const diag = batchDiagnostics(before, anchorSamples.map((s) => batchOf(s.file)), channels, { after });
    const mean = (rows, key) => rows.reduce((sum, r) => sum + (r[key] ?? 0), 0) / rows.length;
    void mean;
    const emdBefore = diag.summary.meanEmdBefore;
    const emdAfter = diag.summary.meanEmdAfter;
    check('normalization', `CytoNorm on ${channels.length} markers: anchor batch distance (mean EMD, fraction of the arcsinh axis) before → after`, `${emdBefore.toExponential(2)} → ${emdAfter.toExponential(2)}`, emdAfter < emdBefore * 0.5, 'halved or better');
  },

  debarcode() {
    // A pooled plate of 20 palladium-barcoded wells; the truth knows each event's well, and that
    // doublets may join cells from two wells.
    const file = generateExample('cytof-barcoded', {}).files[0];
    const d = load(file);
    const key = combinationKey(['Pd102Di', 'Pd104Di', 'Pd105Di', 'Pd106Di', 'Pd108Di', 'Pd110Di'], 3);
    const { assignments } = debarcode(qcSample(d), key, {});
    const { wells, labels, names } = file.meta.truth;
    const debris = names.indexOf('Debris');
    let cells = 0; let assigned = 0; let correct = 0; let doublets = 0; let doubletsAssigned = 0;
    for (let e = 0; e < d.eventCount; e += 1) {
      if (wells[e] >= 0 && labels[e] !== debris) {
        cells += 1;
        if (assignments[e] >= 0) { assigned += 1; if (assignments[e] === wells[e]) correct += 1; }
      } else if (wells[e] === -2) {
        doublets += 1;
        if (assignments[e] >= 0) doubletsAssigned += 1;
      }
    }
    check('debarcode', '6-choose-3 palladium plate: cells assigned to their true well (accuracy)', pct(correct / assigned), correct / assigned > 0.99, '> 99%');
    check('debarcode', 'cells assigned (yield)', pct(assigned / cells), assigned / cells > 0.85, '> 85%');
    // A doublet joins two cells of the same well 1 time in 20; those are rightly assigned.
    check('debarcode', 'doublets assigned (1 in 20 pair cells of one well)', pct(doubletsAssigned / doublets), doubletsAssigned / doublets < 0.08, '< 8%');
  },

  transforms() {
    // BD's published FlowJo lookup tables (MIT): data value at each channel of 4096.
    const { tables } = JSON.parse(readFileSync(new URL('./data/flowjo-biex-luts.json', import.meta.url), 'utf8'));
    let worstRelative = 0;
    let worstChannel = 0;
    let worstTable = '';
    for (const table of tables) {
      const spec = { type: 'biex', maxValue: table.maxValue, widthBasis: table.widthBasis, positiveDecades: table.positiveDecades, extraNegativeDecades: table.extraNegativeDecades };
      const ours = biexTable(spec);
      const transform = createTransform(spec);
      const column = Float32Array.from(table.values);
      const display = applyTransform(column, transform);
      table.channels.forEach((channel, k) => {
        const expected = table.values[k];
        const relative = Math.abs(ours[channel] - expected) / Math.max(1, Math.abs(expected));
        // Channel error of the event-level path (float32 data, as in FCS files).
        const channelError = Math.abs(display[k] * 4096 - channel);
        if (relative > worstRelative) { worstRelative = relative; worstTable = `width ${table.widthBasis}, neg ${table.extraNegativeDecades}`; }
        worstChannel = Math.max(worstChannel, channelError);
      });
    }
    check('transforms', `FlowJo biex reproduces BD's lookup tables (${tables.length} tables, width basis −1 to −1000; worst: ${worstTable})`, `max relative difference ${worstRelative.toExponential(1)}`, worstRelative < 2e-5, '< 2e-5 (tables print 6 digits)');
    check('transforms', 'FlowJo biex: event positions', `max ${fmt(worstChannel, 3)} of 4096 channels`, worstChannel < 0.05, '< 0.05 channel');
  },
  flowjo() {
    // The bundled FlowJo example: its workspace's counts are computed independently of the import
    // (examples.js), the way FlowJo evaluates each gate.
    const { files, attachments } = generateExample('flowjo-workspace', { scale: 0.25 });
    const { rows, fidelity } = flowJoMigration(attachments.find((a) => /\.wsp$/.test(a.name)).text, files);
    const exact = rows.filter((r) => r.status === 'exact').length;
    check('flowjo', `bundled FlowJo workspace: populations whose count equals FlowJo's (${new Set(rows.map((r) => r.sampleName)).size} samples)`, `${exact} of ${rows.length}`, exact === rows.length && rows.length > 40, 'all');
    const approximated = fidelity.filter((f) => f.status !== 'imported');
    check('flowjo', 'bundled FlowJo workspace: populations converted exactly', approximated.length ? approximated.map((f) => `${f.path}: ${f.detail}`).slice(0, 2).join('; ') : 'all', !approximated.length, 'all');

    // FlowJo export: each workspace is exported with CytoWeave's counts and imported back, with
    // every population recomputed from the re-imported gates.
    for (const c of [bundledCase(), builtCase()]) exportChecks('flowjo', c);
  },
  // Figure provenance: a gating-strategy figure of every PBMC sample, exported, read back from
  // SVG, PNG and PDF, and rebuilt in a new workspace from the same files.
  async figures() {
    const { files, workspaceHints } = generateExample('pbmc-immunophenotyping', { scale: 0.1 });
    let ws = createWorkspace('figures');
    const datasets = new Map();
    for (const file of files.filter((f) => /^D0/.test(f.name))) {
      const data = parseFCS(file.bytes).datasets[0];
      const record = sampleFromDataset(data, { name: file.name, sha256: file.name.padEnd(64, '0').slice(0, 64) });
      datasets.set(record.id, data);
      ws = addSamples(ws, [record]);
    }
    ws = addGates(ws, workspaceHints.suggestedGates).ws;
    const viewsOf = (w) => new Map(w.samples.map((s) => {
      const data = datasets.get(s.id);
      const view = new SampleView(s, data);
      const spill = readSpillover(data.keywords, data.parameters);
      if (s.compensationId === 'file' && spill && !spill.identity) view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
      return [s.id, view];
    }));
    // One row per sample: each step of the gating path, as the Figures view's builder lays it out.
    const steps = ['Cells', 'Single cells', 'Live', 'Lymphocytes', 'T cells'].map((name) => ws.gates.find((g) => g.name === name));
    const items = [];
    ws.samples.forEach((sample, r) => steps.forEach((gate, c) => items.push({ id: `p${r}-${c}`, kind: 'plot', x: c * 250, y: r * 250, w: 240, h: 240, sampleId: sample.id, spec: { populationId: gate.parentId ?? 'root', x: gate.dims[0].channel, y: gate.dims[1]?.channel ?? null, type: gate.dims.length === 1 ? 'histogram' : 'pseudocolor' } })));
    const figure = { id: 'f', name: 'Gating strategy', width: 1250, height: ws.samples.length * 250, items };
    const record = buildProvenance(ws, figure, { views: viewsOf(ws), version: 'validation' });
    const json = JSON.stringify(record);
    const svg = embedSVG('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>', record);
    const png = embedPNG(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]), record);
    const pdf = await writePDF([{ width: 10, height: 10, image: { width: 1, height: 1, rgb: new Uint8Array(3) } }], { attachments: [pdfAttachment(record)] });
    const back = [svg, png, pdf].map((f) => JSON.stringify(readFigureProvenance(typeof f === 'string' ? new TextEncoder().encode(f) : f)) === json);
    check('figures', `the analysis of a ${items.length}-plot figure (${record.gates.length} gates, ${record.samples.length} files, ${(json.length / 1024).toFixed(0)} KB) is read back intact from SVG, PNG and PDF`, back.map((ok, i) => `${['SVG', 'PNG', 'PDF'][i]} ${ok ? 'intact' : 'differs'}`).join(', '), back.every(Boolean), 'all three intact');
    const rebuilt = rebuildWorkspace(record);
    const views = viewsOf(rebuilt);
    const same = record.plots.filter((p) => {
      const members = population(views.get(p.sample), rebuilt, p.population);
      return countOf(members, views.get(p.sample)) === p.events;
    }).length;
    check('figures', 'rebuilt from the figure alone: plots drawn from the same events', `${same} of ${record.plots.length}`, same === record.plots.length, 'all');
    const report = compareProvenance(record, rebuilt, { views });
    const unchanged = report.plots.filter((p) => p.status === 'unchanged').length;
    check('figures', 'the rebuilt workspace checks as unchanged against the figure', `${unchanged} of ${report.plots.length}`, unchanged === report.plots.length, 'all');
    const live = ws.gates.find((g) => g.name === 'Live');
    const moved = { ...ws, gates: ws.gates.map((g) => (g.id === live.id ? { ...g, geometry: { vertices: g.geometry.vertices.map(([x, y]) => [x + 0.03, y]) } } : g)) };
    const flagged = compareProvenance(record, moved, { views: viewsOf(moved) }).plots.filter((p) => p.status === 'changed');
    const expected = record.plots.filter((p) => ['Single cells', 'Live', 'Lymphocytes'].some((n) => p.path.endsWith(n))).length;
    check('figures', 'moving one gate flags exactly the plots that show it or depend on it', `${flagged.length} of ${record.plots.length} flagged (expected ${expected})`, flagged.length === expected, `${expected}`);
  },

  // External data: the ISAC Gating-ML 2.0 compliance suite. Each gate file is imported as the app
  // imports it (compensations, ratio and unmixed channels, gates) into a workspace whose sample
  // uses the file's own spillover, and every gate is evaluated by the engine on every event.
  gatingml() {
    const data = dataset('gatingml');
    const sets = { 1: 'data1.fcs', 2: 'data2.fcs', 3: '9399_1_3_NKR.fcs', 4: '9399_1_3_NKR.fcs', 5: '9399_1_3_NKR.fcs' };
    // Result files named differently from their gates (as in flowUtils' runner of the suite).
    const abbreviated = {
      myPolygonWithCustInvAlrSpil: 'myPolygonGateWithCustomInvertedAlreadySpillover',
      myPolygonWithCustNonSqSpecMat: 'myPolygonGateWithCustomNonSquareSpectrumMatrix',
      myPolygonWCustNonSqSpecInvAlrd: 'myPolygonGateWithCustomNonSquareSpectrumMatrixInvertedAlready',
      myPolygonWCustNonSqSpecArcSinH: 'myPolygonGateWithCustomNonSquareSpectrumMatrixOnArcSinH',
      myPolygonWCustSpillAndArcSinH: 'myPolygonGateWithCustomSpilloverAndArcSinH',
      myPolygonWFCSSpillAndArcSinH: 'myPolygonGateWithFCSSpilloverAndArcSinH',
      myRect4bHyperlogArcSinHFCSComp: 'myRectangleGate4bHyperlogArcSinHFCSCompensated',
      myRect4LogicleArcSinHFCSComp: 'myRectangleGate4LogicleArcSinHFCSCompensated',
    };
    let gatesTotal = 0;
    let eventsTotal = 0;
    for (const [set, fcsName] of Object.entries(sets)) {
      const fcs = parseFCS(data.read(`FCSFiles/${fcsName}`)).datasets[0];
      const imported = importGatingML(data.text(`Gating-MLFiles/gates${set}.xml`));
      let ws = createWorkspace(`Gating-ML compliance set ${set}`);
      ws = addSamples(ws, [sampleFromDataset(fcs, { name: fcsName })]);
      for (const comp of imported.compensations) ws = addCompensation(ws, { ...comp, source: 'imported' }).ws;
      for (const record of imported.derived) ws = addDerived(ws, record).ws;
      ws = addGates(ws, imported.gates).ws;
      const record = ws.samples[0];
      const view = new SampleView(record, fcs);
      const spill = readSpillover(fcs.keywords, fcs.parameters);
      if (record.compensationId === 'file' && spill) view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
      const byId = new Map();
      for (const gate of ws.gates) {
        if (gate.meta?.gatingMLId) byId.set(gate.meta.gatingMLId, gate);
        if (gate.meta?.complementOf) byId.set(`Not_${gate.meta.complementOf}`, gate);
      }
      const expected = data.files.filter((f) => f.startsWith(`ExpectedResults/set_${set}/Results_`));
      const failures = [];
      for (const file of expected) {
        const name = file.slice(file.lastIndexOf('Results_') + 8, -4);
        const gate = byId.get(abbreviated[name] ?? name);
        if (!gate) {
          failures.push(`${name} not imported`);
          continue;
        }
        const truth = data.text(file).split(/\r?\n/).filter((line) => /^[01]$/.test(line.trim()));
        const members = population(view, ws, gate.id);
        if (members === undefined) {
          failures.push(`${name} could not be evaluated`);
          continue;
        }
        const inside = new Uint8Array(fcs.eventCount);
        if (members === null) inside.fill(1);
        else for (const e of members) inside[e] = 1;
        let wrong = truth.length === fcs.eventCount ? 0 : Math.abs(truth.length - fcs.eventCount);
        for (let e = 0; e < Math.min(truth.length, fcs.eventCount); e += 1) if (inside[e] !== Number(truth[e])) wrong += 1;
        if (wrong) failures.push(`${name}: ${wrong} events differ`);
      }
      gatesTotal += expected.length;
      eventsTotal += expected.length * fcs.eventCount;
      const ok = failures.length === 0;
      check('gatingml', `set ${set} (gates${set}.xml on ${fcsName}, ${fcs.eventCount.toLocaleString('en')} events): gates whose every event matches`, ok ? `${expected.length} of ${expected.length}` : `${expected.length - failures.length} of ${expected.length}; ${failures.slice(0, 4).join('; ')}`, ok, 'all');
      if (imported.warnings.length) check('gatingml', `set ${set}: imports without warnings`, imported.warnings.slice(0, 2).join(' | '), false, 'none');
    }
    if (verbose) console.log(`     gatingml: ${gatesTotal} gates, ${eventsTotal.toLocaleString('en')} event decisions`);
  },
  // External data: FlowKit 1.3.2's test data, compared with FlowKit's own results
  // (validation/reference/flowkit.json, written by generate_flowkit.py) and with FlowJo's counts.
  flowkit() {
    const data = dataset('flowkit');
    const ref = JSON.parse(readFileSync(new URL('./reference/flowkit.json', import.meta.url), 'utf8'));
    const relative = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));

    // FCS decoding: events, per-channel sums, extremes and sampled events (FlowKit reports time in
    // seconds, $TIMESTEP × the stored value).
    let worst = 0;
    let where = '';
    let files = 0;
    let countsMatch = true;
    for (const [path, entries] of Object.entries(ref.fcs)) {
      const parsed = parseFCS(data.read(path));
      (Array.isArray(entries) ? entries : [entries]).forEach((expected, k) => {
        files += 1;
        const set = parsed.datasets[k];
        if (set?.eventCount !== expected.events) countsMatch = false;
        const timestep = Number.parseFloat(set.keywords.$TIMESTEP) || 1;
        for (const channel of expected.channels) {
          const parameter = set.parameters.find((p) => p.name === channel.name);
          if (!parameter) {
            worst = Infinity;
            where = `${path}: no ${channel.name}`;
            continue;
          }
          const column = set.data[parameter.index];
          const unit = parameter.type === 'time' ? timestep : 1;
          let sum = 0;
          let min = Infinity;
          let max = -Infinity;
          for (const v of column) {
            sum += v * unit;
            if (v * unit < min) min = v * unit;
            if (v * unit > max) max = v * unit;
          }
          const differences = [Math.abs(sum - channel.sum) / Math.max(1, Math.abs(channel.sum), column.length), relative(min, channel.min), relative(max, channel.max), ...expected.picks.map((e, i) => relative(column[e] * unit, channel.values[i]))];
          const d = Math.max(...differences);
          if (d > worst) {
            worst = d;
            where = `${path}, ${channel.name}`;
          }
        }
      });
    }
    check('flowkit', `FCS decoding agrees with FlowKit/FlowIO (${files} data sets from ${Object.keys(ref.fcs).length} files, incl. a two-data-set LMD file and offset errors)`, `events ${countsMatch ? 'equal' : 'DIFFER'}; values within ${worst.toExponential(1)} (worst ${where})`, countsMatch && worst < 1e-6, 'equal; < 1e-6 relative');

    // Compensation with the file's spillover.
    const compSet = parseFCS(data.read(ref.compensation.file)).datasets[0];
    const spill = readSpillover(compSet.keywords, compSet.parameters);
    const raw = Object.fromEntries(compSet.parameters.map((p) => [p.name, compSet.data[p.index]]));
    const compensated = { ...raw, ...compensate(raw, { channels: spill.channels, matrix: spill.matrix }) };
    let compWorst = 0;
    for (const channel of ref.compensation.channels) {
      if (!spill.channels.includes(channel.name)) continue;
      ref.compensation.picks.forEach((e, i) => { compWorst = Math.max(compWorst, relative(compensated[channel.name][e], channel.values[i])); });
      let sum = 0;
      for (const v of compensated[channel.name]) sum += v;
      compWorst = Math.max(compWorst, Math.abs(sum - channel.sum) / Math.max(1, Math.abs(channel.sum), compSet.eventCount));
    }
    check('flowkit', `compensation with the file's $SPILL agrees with FlowKit (${spill.channels.length} channels)`, `within ${compWorst.toExponential(1)}`, compWorst < 1e-5, '< 1e-5 relative (float32 storage)');

    // Spectral unmixing (OLS) against FlowKit's stored result.
    const events = readNpy(data.read('spectral_data/spectral_raw_events.npy'));
    const truth = readNpy(data.read('spectral_data/truth/spectral_comp_events.npy'));
    const matrix = readNpy(data.read('spectral_data/spectral_comp_matrix.npy'));
    const [n, width] = events.shape;
    const { detectorColumns, unmixed } = ref.spectral;
    const columns = detectorColumns.map((j) => Float64Array.from({ length: n }, (_, e) => events.values[e * width + j]));
    const { abundances } = unmixOLS(columns, { names: detectorColumns.slice(0, unmixed).map(String), matrix: matrix.values });
    let spectralWorst = 0;
    let spectralScale = 0;
    for (let f = 0; f < unmixed; f += 1) {
      const j = detectorColumns[f];
      for (let e = 0; e < n; e += 1) {
        const t = truth.values[e * width + j];
        spectralWorst = Math.max(spectralWorst, Math.abs(abundances[f][e] - t));
        spectralScale = Math.max(spectralScale, Math.abs(t));
      }
    }
    check('flowkit', `spectral unmixing (OLS, ${matrix.shape[1]} detectors → ${unmixed}) agrees with FlowKit on ${n.toLocaleString('en')} events`, `max difference ${(spectralWorst / spectralScale).toExponential(1)} of the largest value`, spectralWorst / spectralScale < 1e-7, '< 1e-7 (abundances are stored as float32)');

    // Transforms.
    let forwardWorst = 0;
    let inverseWorst = 0;
    let forwardWhere = '';
    let inverseWhere = '';
    for (const t of ref.transforms) {
      const transform = createTransform(t.cytoweave);
      t.values.forEach((x, i) => {
        if (t.forward[i] === null) return;
        const d = Math.abs(transform.forward(x) - t.forward[i]);
        if (d > forwardWorst) { forwardWorst = d; forwardWhere = `${t.name} at ${x}`; }
      });
      t.scales.forEach((y, i) => {
        if (t.inverse[i] === null) return;
        const d = relative(transform.inverse(y), t.inverse[i]);
        if (d > inverseWorst) { inverseWorst = d; inverseWhere = `${t.name} at ${y}`; }
      });
    }
    check('flowkit', `transforms agree with FlowKit (${ref.transforms.length}: logicle, hyperlog, asinh, FlowJo biex): forward, in scale units`, `within ${forwardWorst.toExponential(1)} (worst ${forwardWhere})`, forwardWorst < 1e-6, '< 1e-6');
    check('flowkit', 'transforms agree with FlowKit: inverse, relative to the data value', `within ${inverseWorst.toExponential(1)} (worst ${inverseWhere})`, inverseWorst < 1e-6, '< 1e-6');

    // FlowJo workspaces: CytoWeave's counts beside FlowJo's (saved in the workspace) and FlowKit's.
    const fcsFiles = new Map();
    const filesIn = (dir) => data.files.filter((f) => f.startsWith(dir) && /\.fcs$/.test(f) && !f.slice(dir.length).includes('/')).map((f) => {
      if (!fcsFiles.has(f)) fcsFiles.set(f, { name: f.slice(dir.length), bytes: data.read(f) });
      return fcsFiles.get(f);
    });
    let reproduced = 0;
    let reproducedTotal = 0;
    const missed = [];
    for (const [path, expected] of Object.entries(ref.workspaces)) {
      const dir = path.startsWith('8_color') ? '8_color_data_set/fcs_files/' : `${path.split('/')[0]}/`;
      const { rows } = flowJoMigration(data.text(path), filesIn(dir));
      const flowKit = new Map((expected.populations ?? []).map((p) => [`${p.sample}|${p.path.join('/')}`, p.count]));
      const valid = rows.filter((r) => r.flowjo >= 0);
      let ours = 0;
      let theirs = 0;
      let oursError = 0;
      let theirsError = 0;
      let compared = 0;
      for (const row of valid) {
        const fk = flowKit.get(`${row.sampleName}|${row.path}`);
        if (row.cytoweave === row.flowjo) ours += 1;
        if (fk === undefined) continue;
        compared += 1;
        if (fk === row.flowjo) {
          theirs += 1;
          reproducedTotal += 1;
          if (row.cytoweave === row.flowjo) reproduced += 1;
          else missed.push(`${path}: ${row.sampleName} ${row.path} (FlowJo ${row.flowjo}, CytoWeave ${row.cytoweave})`);
        }
        if (row.flowjo > 0) {
          oursError += Math.abs((row.cytoweave ?? 0) - row.flowjo) / row.flowjo;
          theirsError += Math.abs(fk - row.flowjo) / row.flowjo;
        }
      }
      const name = path.split('/').pop();
      if (!expected.error && !valid.length) {
        // FlowJo saved no counts (-1): CytoWeave against FlowKit alone.
        const same = rows.filter((r) => r.cytoweave === flowKit.get(`${r.sampleName}|${r.path}`)).length;
        check('flowkit', `${name}: FlowJo saved no counts; populations whose count equals FlowKit's`, `${same} of ${rows.length}`, same === rows.length && rows.length > 0, 'all');
        continue;
      }
      if (expected.error || !compared) {
        check('flowkit', `${name}: populations whose count equals FlowJo's (FlowKit cannot read it: ${(expected.error ?? 'no populations').split(':')[0]})`, `${ours} of ${valid.length}`, valid.length > 0, 'imported and evaluated');
        continue;
      }
      const meanOurs = (100 * oursError) / compared;
      const meanTheirs = (100 * theirsError) / compared;
      check('flowkit', `${name}: populations whose count equals FlowJo's, CytoWeave vs FlowKit (${valid.length} populations); mean difference from FlowJo`, `${ours} vs ${theirs}; ${meanOurs.toFixed(3)}% vs ${meanTheirs.toFixed(3)}%`, ours >= theirs && meanOurs <= meanTheirs + 0.01, 'at least as many; mean no larger');
    }
    check('flowkit', 'FlowJo counts that FlowKit reproduces exactly, CytoWeave reproduces too', `${reproduced} of ${reproducedTotal}${missed.length ? `; missed ${missed.slice(0, 3).join('; ')}` : ''}`, reproduced === reproducedTotal, 'all');

    // FlowJo export of FlowKit's workspaces and of the bundled and built cases: the round trip in
    // CytoWeave, and FlowKit's reading of each export.
    for (const c of flowKitCases()) {
      exportChecks('flowkit', c);
      flowKitExportChecks(c, ref, c.original);
    }
    for (const c of [bundledCase(), builtCase()]) flowKitExportChecks(c, ref, c.original ?? { rows: [] });
    deidentifyChecks('flowkit', `${fcsFiles.size} FlowKit FCS files`, [...fcsFiles.values()]);
  },
  // External data: FCS files from several instruments and deliberately malformed files
  // (fcsparser's tests), against FlowIO's decoding and fcsparser's published values.
  fcsparser() {
    const data = dataset('fcsparser');
    const flowio = JSON.parse(readFileSync(new URL('./reference/flowkit.json', import.meta.url), 'utf8')).corpus;
    const published = JSON.parse(readFileSync(new URL('./reference/fcsparser.json', import.meta.url), 'utf8')).files;
    const relative = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
    let read = 0;
    let sets = 0;
    let exactTrip = true;
    const failures = [];
    let worst = 0;
    let worstWhere = '';
    let compared = 0;
    const flowIOFailed = [];
    const clear = [];
    for (const path of data.files) {
      let parsed;
      try {
        parsed = parseFCS(data.read(path));
      } catch (error) {
        if (error instanceof FCSError) clear.push(`${path}: ${error.message}`);
        else failures.push(`${path}: ${error.constructor.name}: ${error.message}`);
        continue;
      }
      read += 1;
      for (const d of parsed.datasets) {
        sets += 1;
        const again = load({ bytes: writeFCS({ parameters: d.parameters.map((p) => ({ name: p.name, label: p.label, range: p.range })), data: d.data, keywords: d.keywords }) });
        for (let p = 0; p < d.parameters.length && exactTrip; p += 1) {
          for (let e = 0; e < d.eventCount; e += 1) if (!Object.is(d.data[p][e], again.data[p][e])) { exactTrip = false; break; }
        }
      }
      const reference = flowio[path];
      if (!reference || reference.error) {
        flowIOFailed.push(path.split('/').pop());
        continue;
      }
      reference.forEach((expected, k) => {
        const d = parsed.datasets[k];
        compared += 1;
        if (d?.eventCount !== expected.events) {
          failures.push(`${path} #${k}: ${d?.eventCount} events, FlowIO ${expected.events}`);
          return;
        }
        const timestep = Number.parseFloat(d.keywords.$TIMESTEP) || 1;
        const decades = new Set(d.diagnostics.filter((x) => x.code === 'log-decades').map((x) => x.message.split(':')[0]));
        expected.channels.forEach((channel, i) => {
          const parameter = d.parameters[i];
          // Float values stored as decades: FlowIO applies the channel formula to them (below).
          if (decades.has(parameter.name)) return;
          const unit = parameter.type === 'time' ? timestep : 1;
          expected.picks.forEach((e, j) => {
            const diff = relative(d.data[i][e] * unit, channel.values[j]);
            if (diff > worst) { worst = diff; worstWhere = `${path} #${k}, ${parameter.name}`; }
          });
        });
      });
    }
    check('fcsparser', `files from ${data.files.length} instruments and tests read (data sets)`, `${read} files, ${sets} data sets${failures.length ? `; ${failures.slice(0, 2).join('; ')}` : ''}`, read === data.files.length - clear.length && !failures.length, 'all readable files');
    check('fcsparser', 'malformed files are refused with a clear message', clear.map((c) => c.split(': ').slice(1).join(': ')).join(' | ') || 'none', clear.length === 2, 'the truncated and keywords-only files');
    check('fcsparser', `decoded values agree with FlowIO (${compared} data sets; FlowIO cannot read ${flowIOFailed.join(', ')})`, `within ${worst.toExponential(1)} (worst ${worstWhere})`, worst < 1e-6 && compared >= 15, '< 1e-6 relative');
    // Guava Muse stores each log channel as log10 of its linear channel (as floats, against FCS
    // 3.1): decoded as decades, every log channel equals its linear channel.
    let pairWorst = 0;
    let pairs = 0;
    for (const d of parseFCS(data.read('GuavaMuse/Guava Muse.fcs')).datasets) {
      for (const parameter of d.parameters.filter((p) => /-HLog$/.test(p.name))) {
        const linear = d.parameters.find((p) => p.name === parameter.name.replace(/Log$/, 'Lin'));
        if (!linear) continue;
        pairs += 1;
        const a = d.data[parameter.index];
        const b = d.data[linear.index];
        for (let e = 0; e < a.length; e += 1) pairWorst = Math.max(pairWorst, Math.abs(a[e] - b[e]) / Math.max(1e-3, Math.abs(b[e])));
      }
    }
    check('fcsparser', `floating-point log channels stored as decades (Guava Muse): each equals its linear channel (${pairs} pairs)`, `within ${pairWorst.toExponential(1)}`, pairs === 12 && pairWorst < 1e-5, '< 1e-5 relative');
    let rawWorst = 0;
    for (const [path, { rows }] of Object.entries(published)) {
      const d = parseFCS(data.read(path), { linearize: false }).datasets[0];
      rows.forEach((row, e) => row.forEach((v, p) => { rawWorst = Math.max(rawWorst, relative(d.data[p][e], v)); }));
    }
    check('fcsparser', `stored values equal fcsparser's published rows (${Object.keys(published).length} files, incl. 3-byte integers, large-file offsets and masked bits)`, `within ${rawWorst.toExponential(1)}`, rawWorst < 1e-6, '< 1e-6 relative');
    check('fcsparser', 'every data set is written and read back', exactTrip ? 'bit-exact' : 'differs', exactTrip, 'bit-exact');
    deidentifyChecks('fcsparser', `${data.files.filter((p) => /\.(fcs|lmd)$/i.test(p)).length} instrument and malformed files`, data.files.filter((p) => /\.(fcs|lmd)$/i.test(p)).map((p) => ({ name: p, bytes: data.read(p) })));
  },
  // External data: a BD LSRFortessa panel's 15 single-stain controls (Zenodo 22808501, CC BY 4.0)
  // and FACSDiva's own spillover matrix, computed from them and stored in the samples.
  diva() {
    const data = dataset('zenodo-skull');
    const sample = parseFCS(data.read('Skull BM Broad_Tube_017.fcs')).datasets[0];
    const diva = readSpillover(sample.keywords, sample.parameters);
    const detectors = diva.channels;
    const inputs = data.files.filter((f) => f.startsWith('Compensation Controls_')).map((f) => {
      const d = parseFCS(data.read(f)).datasets[0];
      // "B 530,2f,30 Stained Control" → the B 530/30 detector.
      const [laser, filter] = f.replace('Compensation Controls_', '').split(' ');
      const [wavelength, , width] = filter.split(',');
      return { channel: detectors.find((c) => c.startsWith(`${laser} ${wavelength}/${width}`)), columns: columnsOf(d) };
    });
    const n = detectors.length;
    for (const [method, tolerance] of [['median', 0.02], ['regression', 0.03]]) {
      const result = computeSpillover(inputs, detectors, { method, range: 262144 });
      let worst = 0;
      let where = '';
      for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
          const d = Math.abs(result.matrix[i * n + j] - diva.matrix[i * n + j]);
          if (d > worst) { worst = d; where = `${detectors[i]} → ${detectors[j]}: ${fmt(result.matrix[i * n + j], 4)} vs ${fmt(diva.matrix[i * n + j], 4)}`; }
        }
      }
      check('diva', `spillover from ${inputs.length} real single-stain controls (${method}, no manual gating) vs BD FACSDiva's matrix (${n * (n - 1)} entries)`, `largest difference ${fmt(worst, 4)} (${where})`, inputs.length === 15 && worst < tolerance, `< ${tolerance}`);
    }
  },
  // External data: the Bioconductor packages flowCore, PeacoQC, FlowSOM and CytoNorm, run by
  // reference/generate_r.R on their own example files, a FACSDiva file, a FlowKit file and the
  // simulated QC wells; their results (reference/r.json) beside CytoWeave's on the same input.
  bioconductor() {
    const ref = JSON.parse(readFileSync(new URL('./reference/r.json', import.meta.url), 'utf8'));
    const sets = { rpackages: dataset('rpackages'), 'zenodo-skull': dataset('zenodo-skull'), flowkit: dataset('flowkit') };
    const simulated = new Map(generateExample('qc-showcase', {}).files.map((f) => [`simulated/${f.name}`, f.bytes]));
    const inSet = {
      'rpackages/111.fcs': 'PeacoQC/111.fcs',
      'rpackages/68983.fcs': 'FlowSOM/68983.fcs',
      'rpackages/Gates_PTLG021_Unstim_Control_1.fcs': 'CytoNorm/Gates_PTLG021_Unstim_Control_1.fcs',
      'flowkit/101_DEN084Y5_15_E01_008_clean.fcs': '8_color_data_set/fcs_files/101_DEN084Y5_15_E01_008_clean.fcs',
    };
    const bytesOf = (key) => {
      if (simulated.has(key)) return simulated.get(key);
      const [set, ...rest] = key.split('/');
      return sets[set].read(inSet[key] ?? rest.join('/'));
    };
    // A file as R reads it (linear values), and compensated by the spillover matrix it carries.
    const read = (key) => {
      const d = load({ bytes: bytesOf(key) });
      const columns = columnsOf(d);
      const spill = readSpillover(d.keywords, d.parameters);
      const compensated = spill && !spill.identity ? { ...columns, ...compensate(columns, { channels: spill.channels, matrix: spill.matrix }) } : columns;
      return { d, columns, compensated };
    };
    const relative = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
    const logicleOf = (p) => ({ type: 'logicle', T: p.T, W: p.W, M: p.M, A: p.A });
    // The largest relative difference over a summary's picked events and channel sums.
    const against = (summary, columns, label) => {
      let worst = 0;
      let where = '';
      for (const channel of summary.channels) {
        const column = columns[channel.name];
        if (!column) return { worst: Infinity, where: `${label}: no ${channel.name}` };
        summary.picks.forEach((e, j) => {
          const d = relative(column[e], channel.values[j]);
          if (d > worst) { worst = d; where = `${label} ${channel.name} event ${e}`; }
        });
        let sum = 0;
        for (let e = 0; e < column.length; e += 1) sum += column[e];
        const d = relative(sum, channel.sum);
        if (d > worst) { worst = d; where = `${label} ${channel.name} sum`; }
      }
      return { worst, where };
    };
    const versions = ref.versions;

    // flowCore: reading, compensation, estimateLogicle and the logicle transform.
    let readWorst = { worst: 0, where: '' };
    let compWorst = { worst: 0, where: '' };
    let widthWorst = 0;
    let widthWhere = '';
    let widths = 0;
    for (const f of ref.flowCore.files) {
      const { d, columns, compensated } = read(f.file);
      // flowCore divides Time by its $PnG (CytoWeave keeps Time in its stored units): not compared.
      const fluor = { ...f.read, channels: f.read.channels.filter((c) => d.parameters.find((p) => p.name === c.name)?.type !== 'time') };
      if (d.eventCount !== f.read.events) readWorst = { worst: Infinity, where: `${f.file}: ${d.eventCount} events, flowCore ${f.read.events}` };
      for (const [into, result] of [[readWorst, against(fluor, columns, f.file)], ...(f.compensated ? [[compWorst, against(f.compensated, compensated, f.file)]] : [])]) {
        if (result.worst > into.worst) Object.assign(into, result);
      }
      for (const [channel, p] of Object.entries(f.logicle ?? {})) {
        widths += 1;
        const W = estimateLogicleW(compensated[channel], p.T, p.M);
        const diff = Math.abs(W - p.W);
        if (diff > widthWorst) { widthWorst = diff; widthWhere = `${f.file} ${channel}: ${fmt(W, 5)} vs ${fmt(p.W, 5)}`; }
      }
    }
    check('bioconductor', `values read agree with flowCore ${versions.flowCore} read.FCS (${ref.flowCore.files.length} files: PeacoQC's, FlowSOM's, CytoNorm's, a FACSDiva file and a FlowKit file; Time excluded)`, `within ${readWorst.worst.toExponential(1)}${readWorst.where ? ` (worst ${readWorst.where})` : ''}`, readWorst.worst < 1e-6, '< 1e-6 relative');
    check('bioconductor', "compensation by each file's own spillover matrix agrees with flowCore compensate", `within ${compWorst.worst.toExponential(1)} (worst ${compWorst.where})`, compWorst.worst < 1e-6, '< 1e-6 relative');
    check('bioconductor', `logicle widths estimated from the data agree with flowCore estimateLogicle (${widths} channels)`, `within ${widthWorst.toExponential(1)} (worst ${widthWhere})`, widths > 0 && widthWorst < 1e-6, '< 1e-6');
    let forwardWorst = 0;
    let inverseWorst = 0;
    for (const t of ref.flowCore.logicle) {
      const transform = createTransform(logicleOf(t));
      t.values.forEach((x, i) => { forwardWorst = Math.max(forwardWorst, Math.abs(transform.forward(x) - t.forward[i])); });
      t.scales.forEach((y, i) => { inverseWorst = Math.max(inverseWorst, relative(transform.inverse(y), t.inverse[i])); });
    }
    check('bioconductor', `logicle transform agrees with flowCore logicleTransform and its inverse (${ref.flowCore.logicle.length} parameter sets)`, `forward within ${forwardWorst.toExponential(1)}, inverse within ${inverseWorst.toExponential(1)}`, forwardWorst < 1e-9 && inverseWorst < 1e-9, '< 1e-9');

    // PeacoQC: CytoWeave's classic mode is a port of PeacoQC; every event's verdict must agree.
    const peaco = [];
    for (const p of ref.PeacoQC) {
      const { d, compensated } = read(p.file);
      const transforms = Object.fromEntries(Object.entries(p.logicle).map(([channel, q]) => [channel, logicleOf(q)]));
      for (const channel of p.channels) transforms[channel] ??= { type: 'linear', min: 0, max: 1 };
      const sample = { eventCount: d.eventCount, channels: d.parameters.map((q) => ({ name: q.name, type: q.type, range: q.range })), columns: compensated, keywords: d.keywords };
      const result = peacoQC(sample, { channels: p.channels, transforms, mode: 'classic', method: 'all' });
      const removedByR = new Uint8Array(d.eventCount);
      for (const [a, b] of p.removed) removedByR.fill(1, a, b + 1);
      let differing = 0;
      let removed = 0;
      for (let e = 0; e < d.eventCount; e += 1) {
        const out = result.mask[e] ? 0 : 1;
        removed += out;
        if (out !== removedByR[e]) differing += 1;
      }
      peaco.push({ file: p.file.split('/').pop(), differing, ours: (100 * removed) / d.eventCount, theirs: p.percentageRemoved, binsAgree: result.eventsPerBin === p.eventsPerBin });
    }
    const differing = peaco.reduce((s, p) => s + p.differing, 0);
    check('bioconductor', `PeacoQC ${versions.PeacoQC} (all checks, isolation tree and MAD) and CytoWeave's classic mode remove the same events (${peaco.length} files: 3 real and 4 simulated wells with clogs, bubbles and drift)`, `${differing} events differ; removed ${peaco.map((p) => `${p.file} ${p.ours.toFixed(2)}% vs ${p.theirs.toFixed(2)}%`).join(', ')}`, differing === 0 && peaco.every((p) => p.binsAgree) && peaco.length === 7, '0 events differ, same bins');

    // FlowSOM: mapping to R's own map and R's metaclustering of it are deterministic and must agree;
    // whole runs depend on each implementation's random numbers, so they are compared as R compares
    // with itself across seeds.
    const fs = ref.FlowSOM;
    const { d, compensated } = read(fs.file);
    const n = d.eventCount;
    const dim = fs.channels.length;
    const data = new Float32Array(n * dim);
    fs.channels.forEach((channel, j) => {
      const q = fs.logicle[channel];
      const transform = createTransform(logicleOf(q));
      const column = compensated[channel];
      // flowCore's logicle runs from 0 to M.
      for (let e = 0; e < n; e += 1) data[e * dim + j] = transform.forward(column[e]) * q.M;
    });
    const som = { codes: Float64Array.from(fs.codes), nodes: fs.nodes, dim, xdim: 10, ydim: 10 };
    const { mapping } = mapToSOM(som, data, n);
    let mapped = 0;
    for (let e = 0; e < n; e += 1) if (mapping[e] === fs.mapping[e]) mapped += 1;
    check('bioconductor', `events mapped to the nearest node of FlowSOM ${versions.FlowSOM}'s own map (${fs.nodes} nodes, ${dim} channels)`, `${mapped} of ${n} agree`, mapped === n && n === fs.events, 'all');
    const cut = cutTree(hclust(distanceMatrix(som.codes, som.nodes, dim, 'euclidean'), som.nodes, 'average'), 10);
    const treeAri = adjustedRandIndex(Int32Array.from(cut), Int32Array.from(fs.hclustAverage10));
    check('bioconductor', "R's metaclustering of the map (hclust, average linkage, 10 metaclusters) reproduced", `ARI ${fmt(treeAri, 6)}`, treeAri > 1 - 1e-9, '1');
    const rLabels = fs.labels.map((s) => Int32Array.from(s, Number));
    const ours = [];
    for (const seed of [1, 2, 3]) {
      const { labels } = flowsom(data, n, dim, { seed, k: 10 });
      for (const theirs of rLabels) ours.push(adjustedRandIndex(labels, theirs));
    }
    const mean = (values) => values.reduce((s, v) => s + v, 0) / values.length;
    check('bioconductor', `whole FlowSOM runs (3 seeds each, 10 metaclusters): CytoWeave vs R, beside R vs R across seeds`, `mean ARI ${fmt(mean(ours))} (${fmt(Math.min(...ours))}–${fmt(Math.max(...ours))}) vs ${fmt(mean(fs.ariBetweenSeeds))} (${fmt(Math.min(...fs.ariBetweenSeeds))}–${fmt(Math.max(...fs.ariBetweenSeeds))})`, mean(ours) >= mean(fs.ariBetweenSeeds) - 0.02, 'mean no lower than R vs R − 0.02');
    // FlowSOM's FlowJo workspace for the same file. The file was rewritten by flowCore after FlowJo
    // gated it (it carries flowCore's keywords): every event lies inside the Lymphocytes polygon,
    // yet FlowJo saved 13 fewer, so FlowKit's counts are the reference and FlowJo's are shown.
    const flowKit = new Map(JSON.parse(readFileSync(new URL('./reference/flowkit.json', import.meta.url), 'utf8'))
      .otherWorkspaces['rpackages/FlowSOM/gating.wsp'].populations.map((p) => [p.path.join('/'), p.count]));
    const { rows } = flowJoMigration(sets.rpackages.text('FlowSOM/gating.wsp'), [{ name: '68983.fcs', bytes: sets.rpackages.read('FlowSOM/68983.fcs') }]);
    const sameAsFlowKit = rows.filter((r) => r.cytoweave === flowKit.get(r.path)).length;
    const fromFlowJo = Math.max(...rows.map((r) => Math.abs(r.cytoweave - r.flowjo)));
    const top = rows.find((r) => r.path === 'Lymphocytes');
    check('bioconductor', `FlowSOM's FlowJo workspace (gating.wsp): populations whose count equals FlowKit's; largest difference from FlowJo's saved counts`, `${sameAsFlowKit} of ${rows.length}; ${fromFlowJo} events (Lymphocytes: ${top.cytoweave} vs FlowJo's ${top.flowjo})`, sameAsFlowKit === rows.length && rows.length === flowKit.size && fromFlowJo <= top.cytoweave - top.flowjo, "all; no more than FlowJo's difference at the top gate");

    // CytoNorm: trained on volunteer 1 of each of 3 batches, applied to all 6 files.
    const cn = ref.CytoNorm;
    const spec = { type: 'arcsinh', cofactor: cn.cofactor, max: 10000 };
    const transforms = Object.fromEntries(cn.channels.map((c) => [c, spec]));
    const sampleOf = (file) => qcSample(load({ bytes: sets.rpackages.read(`CytoNorm/${file}`) }));
    for (const [run, tolerance, required] of [[cn.quantileNorm, 1e-9, '< 1e-9 relative'], [cn.cytoNorm, 1e-5, '< 1e-5 relative (R writes the normalized files as 32-bit floats)']]) {
      const labelsOf = (f) => (f.clusters ? Int32Array.from(f.clusters, Number) : null);
      const training = run.files.filter((f) => f.training).map((f) => ({ sample: sampleOf(f.file), batch: f.batch, ...(f.clusters ? { labels: labelsOf(f) } : {}) }));
      const model = trainCytoNorm(training, { channels: cn.channels, transforms, nQ: run.nQ, goal: cn.goal });
      let worst = { worst: 0, where: '' };
      for (const f of run.files) {
        const result = against(f, applyCytoNorm(model, sampleOf(f.file), f.batch, labelsOf(f)).columns, f.file);
        if (result.worst > worst.worst) worst = result;
      }
      const clusters = run.files[0].clusters ? `, given R's metacluster of each event` : '';
      check('bioconductor', `${run.method} of CytoNorm ${versions.CytoNorm}: normalized values agree (${run.files.length} files, ${cn.channels.length} channels, ${run.nQ} quantiles${clusters})`, `within ${worst.worst.toExponential(1)} (worst ${worst.where})`, worst.worst < tolerance, required);
    }
  },
  reference() {
    // R: t.test / wilcox.test on the sleep data set (extra sleep, group 1 vs group 2).
    const g1 = [0.7, -1.6, -0.2, -1.2, -0.1, 3.4, 3.7, 0.8, 0.0, 2.0];
    const g2 = [1.9, 0.8, 1.1, 0.1, -0.1, 4.4, 5.5, 1.6, 4.6, 3.4];
    const close = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
    const welch = welchTTest(g1, g2);
    check('reference', 'Welch t-test, sleep data: t and p (R 4.x: t = −1.8608, p = 0.07939)', `${fmt(welch.statistic, 4)}, ${fmt(welch.p, 5)}`, close(welch.statistic, -1.860813, 1e-5) && close(welch.p, 0.07939414, 1e-5), '1e-5');
    const student = studentTTest(g1, g2);
    check('reference', "Student's t-test (R: p = 0.07919)", fmt(student.p, 5), close(student.p, 0.07918671, 1e-5), '1e-5');
    const paired = pairedTTest(g1, g2);
    check('reference', 'paired t-test (R: t = −4.0621, p = 0.002833)', `${fmt(paired.statistic, 4)}, ${fmt(paired.p, 6)}`, close(paired.statistic, -4.062128, 1e-5) && close(paired.p, 0.002832890, 1e-4), '1e-5');
    const mw = mannWhitneyU(g1, g2);
    check('reference', 'Wilcoxon rank-sum, ties, continuity correction (R: W = 25.5, p = 0.06933)', `${fmt(mw.statistic, 2)}, ${fmt(mw.p, 5)}`, close(mw.statistic, 25.5, 1e-9) && close(mw.p, 0.06932758, 1e-4), '1e-4');
    const q = adjustPValues([0.01, 0.04, 0.03, 0.005], 'BH');
    check('reference', 'Benjamini–Hochberg (R p.adjust: 0.02 0.04 0.04 0.02)', q.map((v) => fmt(v, 4)).join(' '), [0.02, 0.04, 0.04, 0.02].every((v, i) => close(q[i], v, 1e-12)), 'exact');
    check('reference', 'qt(0.975, 10) = 2.228139', fmt(studentTQuantile(0.975, 10), 6), close(studentTQuantile(0.975, 10), 2.228138851986274, 1e-9), '1e-9');
    const logicle = createTransform({ type: 'logicle', T: 262144, W: 0, M: 4.5, A: 0 });
    const fasinh = createTransform({ type: 'fasinh', T: 262144, M: 4.5, A: 0 });
    let worst = 0;
    for (const x of [-1000, 0, 10, 1000, 100000]) worst = Math.max(worst, Math.abs(logicle.forward(x) - fasinh.forward(x)));
    check('reference', 'logicle with W = 0 equals Gating-ML fasinh (Moore & Parks 2012)', `max difference ${worst.toExponential(1)}`, worst < 1e-12, '< 1e-12');
  },
};

// --- Run ------------------------------------------------------------------------------------------

const names = requested.length ? requested : Object.keys(suites);
const skipped = [];
const started = performance.now();
for (const name of names) {
  if (!suites[name]) {
    console.error(`Unknown suite ${name}. Suites: ${Object.keys(suites).join(', ')}`);
    process.exit(2);
  }
  const t0 = performance.now();
  try {
    await suites[name]();
  } catch (error) {
    if (error instanceof MissingData) {
      skipped.push(name);
      console.log(`- ${name}: skipped (external data: ${error.message})`);
      if (requireData) check(name, 'external data present', error.message, false, 'present (--require-data)');
      continue;
    }
    check(name, 'suite ran', error.stack?.split('\n').slice(0, 3).join(' | ') ?? error.message, false, 'no error');
  }
  const mine = results.filter((r) => r.suite === name);
  console.log(`${mine.every((r) => r.ok) ? '✓' : '✗'} ${name}: ${mine.filter((r) => r.ok).length}/${mine.length} checks (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
if (skipped.length) console.log(`Skipped for want of external data: ${skipped.join(', ')} (node validation/fetch.mjs downloads it).`);
if (failed.length) process.exit(1);
