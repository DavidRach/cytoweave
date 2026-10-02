// CytoWeave's validation suite. Unit tests (web/lib/*.test.mjs) check functions in isolation; this
// suite runs the real pipelines on realistic simulated experiments whose answers are known (the
// simulator keeps the true population of every event, the true spillover, phase fractions,
// generation frequencies and abundances) and on published reference values, and reports how
// closely CytoWeave agrees, against stated tolerances.
//
//   node validation/run.mjs [suite …] [--verbose]
//
// Suites: fcs, compensation, gating, qc, spectral, cellcycle, proliferation, clustering,
// normalization, debarcode, transforms, reference (all by default). Exits with status 1 when a check fails.

import { generateExample } from '../web/lib/examples.js';
import { parseFCS, readSpillover, writeFCS } from '../web/lib/fcs.js';
import { compensate, computeSpillover, controlResiduals, leanCheck } from '../web/lib/compensation.js';
import { SampleView, population } from '../web/lib/engine.js';
import { createWorkspace, addGates } from '../web/lib/workspace.js';
import { peacoQC, flowRateCheck } from '../web/lib/qc.js';
import { autoGateControl, referenceSpectrum, extractAutofluorescence, unmixWithAutofluorescence } from '../web/lib/spectral.js';
import { dnaHistogram, fitDeanJettFox, fitWatsonPragmatic } from '../web/lib/cellcycle.js';
import { fitProliferation } from '../web/lib/proliferation.js';
import { flowsom } from '../web/lib/flowsom.js';
import { adjustedRandIndex } from '../web/lib/cluster-summary.js';
import { trainCytoNorm, applyCytoNorm, batchDiagnostics } from '../web/lib/normalize.js';
import { combinationKey, debarcode } from '../web/lib/debarcode.js';
import { welchTTest, studentTTest, pairedTTest, mannWhitneyU, adjustPValues, studentTQuantile } from '../web/lib/hypothesis.js';
import { readFileSync } from 'node:fs';
import { createTransform, applyTransform, biexTable } from '../web/lib/transforms.js';
import { createRandom, sampleIndices } from '../web/lib/random.js';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
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

// --- Suites ---------------------------------------------------------------------------------------

const suites = {
  fcs() {
    for (const id of ['pbmc-immunophenotyping', 'flowjo-workspace', 'spectral-25color', 'cell-cycle', 'proliferation', 'cytof-cohort', 'cytof-barcoded', 'index-sort', 'qc-showcase']) {
      const { files } = generateExample(id, { scale: 0.05 });
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
    check(name, 'suite ran', error.stack?.split('\n').slice(0, 3).join(' | ') ?? error.message, false, 'no error');
  }
  const mine = results.filter((r) => r.suite === name);
  console.log(`${mine.every((r) => r.ok) ? '✓' : '✗'} ${name}: ${mine.filter((r) => r.ok).length}/${mine.length} checks (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
if (failed.length) process.exit(1);
