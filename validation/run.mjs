// CytoWeave's validation suite. Unit tests (web/lib/*.test.mjs) check functions in isolation; this
// suite runs the real pipelines on realistic simulated experiments whose answers are known (the
// simulator keeps the true population of every event, the true spillover, phase fractions,
// generation frequencies and abundances) and on published reference values, and reports how
// closely CytoWeave agrees, against stated tolerances.
//
//   node validation/run.mjs [suite …] [--verbose]
//
// Suites: fcs, fuzz, templates, strategies, compensation, gating, qc, spectral, spread, cellcycle, proliferation, clustering,
// normalization, debarcode, transforms, flowjo, figures, autogating, instrument, reference,
// multiverse, accessibility, experts, multiverse-ics, flowqb, gatingml, flowkit, fcsparser, instruments, ontology, fuzz-corpus, diva,
// fortessa, bioconductor
// (all by default). Exits with status 1 when a check fails.
//
// Suites marked "external data" need files that node validation/fetch.mjs downloads into
// validation/cache/; without them the suite is skipped (and fails with --require-data, as in CI).

import { generateExample } from '../web/lib/examples.js';
import { FCSError, parseFCS, readSpillover, writeFCS } from '../web/lib/fcs.js';
import { compensate, computeSpillover, controlResiduals, leanCheck, spilloverSpreading } from '../web/lib/compensation.js';
import { SampleView, countOf, population } from '../web/lib/engine.js';
import { importFlowJo } from '../web/lib/flowjo.js';
import { builtCase, bundledCase, flowKitCases, importWithFiles } from './flowjo-export-cases.mjs';
import { deidentifyFCS } from '../web/lib/deidentify.js';
import { CORPUS, corpusFiles, fuzz, seedFiles } from './fuzz-cases.mjs';
import { asOtherInstrument, countsOf, loadSamples, pbmcFiles, sourceAnalysis } from './template-cases.mjs';
import { applyTemplate, buildTemplate, parseTemplate } from '../web/lib/templates.js';
import { evaluate as evaluateOntology } from './ontology-cases.mjs';
import { suggestForPopulation, termById } from '../web/lib/ontology.js';
import { applyStrategy, pbmcCohort, placeOn } from './strategy-cases.mjs';
import { STRATEGIES, strategyById } from '../web/lib/strategies.js';
import { buildProvenance, compareProvenance, embedPNG, embedSVG, pdfAttachment, readFigureProvenance, rebuildWorkspace } from '../web/lib/figure-provenance.js';
import { writePDF } from '../web/lib/pdf.js';
import { characterize, findBeadPeaks, REJECT_RULES } from '../web/lib/qb.js';
import { beadRun, runFlags, seriesRun } from '../web/lib/instrument-record.js';
import { compareWithLibrary, latestEntries, libraryEntry, spectrumOn, withEntries as withSpectra } from '../web/lib/spectral-library.js';
import { textPairs, themeTokens } from './accessibility-cases.mjs';
import { VISIONS, lab as labOf, paletteReport, simulate } from '../web/lib/colorvision.js';
import { CATEGORICAL, CATEGORICAL_CVD, colormapColor } from '../web/lib/colormaps.js';
import { byDonor, multiverseOf, qcMasks, setChannel, withCD25, withDoublePositive, withQCGate } from './multiverse-cases.mjs';
import { adaptPath, choicesFor, pathGates as pathOf, runMultiverse, specifications, summarize as summarizeMultiverse } from '../web/lib/multiverse.js';
import { EXPERT_GATES, ORDER, TRUTH, adaptTopDown, againstExperts, buildCohort, expertCorrection, expertWorkspace, f1 as truthF1, randomGains } from './autogating-cases.mjs';
import { adaptAcrossSamples } from '../web/lib/autogating.js';
import { buildFlowJoMigration, matchFlowJoSamples, migrationCountRows } from '../web/lib/flowjo-match.js';
import { createWorkspace, addGates, addCompensation, addDerived, addSamples, sampleFromDataset, setGateGeometry } from '../web/lib/workspace.js';
import { importGatingML } from '../web/lib/gatingml.js';
import { peacoQC, peacoQCChannel, peacoQCLayout, flowRateCheck } from '../web/lib/qc.js';
import { autoGateControl, referenceSpectrum, extractAutofluorescence, spectralSpreading, unmixOLS, unmixWithAutofluorescence } from '../web/lib/spectral.js';
import { agreement, crossValidate, fitNoise, predictedSpreading, spreadModel } from '../web/lib/spread.js';
import { INSTRUMENTS } from '../web/lib/simulate.js';
import { dnaHistogram, fitDeanJettFox, fitWatsonPragmatic } from '../web/lib/cellcycle.js';
import { fitProliferation } from '../web/lib/proliferation.js';
import { flowsom, mapToSOM, hclust, cutTree, distanceMatrix } from '../web/lib/flowsom.js';
import { adjustedRandIndex } from '../web/lib/cluster-summary.js';
import { trainCytoNorm, applyCytoNorm, batchDiagnostics } from '../web/lib/normalize.js';
import { combinationKey, debarcode } from '../web/lib/debarcode.js';
import { welchTTest, studentTTest, pairedTTest, mannWhitneyU, adjustPValues, studentTQuantile } from '../web/lib/hypothesis.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
// PeacoQC as the app runs a large sample: each channel's work done apart (in parallel workers, here
// one after another, each with fresh scratch space and through a structured clone, as postMessage
// passes it), then combined. Must equal the serial run event for event.
function splitPeacoQC(sample, options) {
  const layout = peacoQCLayout(sample, options);
  const channelResults = layout.channels.map((name) => structuredClone(peacoQCChannel(sample, name, layout.bins, options)));
  return peacoQC(sample, { ...options, eventsPerBin: layout.eventsPerBin, channelResults });
}

function sameMask(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function dataset(name) {
  const set = sources.datasets[name];
  // Paths, not URLs: file names may hold "%" or "#".
  const root = join(fileURLToPath(new URL('./cache/', import.meta.url)), name);
  const missing = set.files.filter((f) => {
    const path = join(root, f.path);
    return !existsSync(path) || statSync(path).size !== f.size;
  });
  if (missing.length) throw new MissingData(`${missing.length} of ${set.files.length} files of "${name}" are missing; run node validation/fetch.mjs ${name}`);
  return { read: (path) => readFileSync(join(root, path)), text: (path) => readFileSync(join(root, path), 'utf8'), files: set.files.map((f) => f.path) };
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

function setGateGeometryAt(ws, gateId, geometry, sampleId) {
  return setGateGeometry(ws, gateId, geometry, { sampleId });
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

// FlowJo 11 itself on the exports (reference/flowjo11.json, read from FlowJo 11.2 during a trial):
// each population's percentage of its parent against CytoWeave's, for the cases in `cases`.
function flowJo11Checks(suite, cases) {
  const fj11 = JSON.parse(readFileSync(new URL('./reference/flowjo11.json', import.meta.url), 'utf8'));
  for (const ref of fj11.cases) {
    const c = cases.find((x) => x.name === ref.case);
    if (!c) continue;
    const ours = new Map(c.rows.filter((r) => r.sampleName === ref.sample).map((r) => [r.path, r.cytoweave]));
    const file = c.files.find((f) => f.name === ref.sample);
    const total = file ? parseFCS(file.bytes).datasets[0].eventCount : null;
    const gaps = Object.entries(ref.percentOfParent).map(([path, pct]) => {
      const parent = path.includes('/') ? ours.get(path.slice(0, path.lastIndexOf('/'))) : total;
      return { path, gap: parent ? Math.abs((100 * ours.get(path)) / parent - pct) : Number.NaN };
    });
    const worst = gaps.reduce((a, b) => (b.gap > a.gap || Number.isNaN(b.gap) ? b : a));
    check(suite, `FlowJo ${fj11.flowjoVersion} (${fj11.flowjoBuild}) opens the export of ${ref.case}: populations of ${ref.sample} within ${ref.tolerance} percentage points of FlowJo's (FlowJo evaluates gates at its display resolution)`, `${gaps.filter((g) => g.gap <= ref.tolerance).length} of ${gaps.length}; largest ${worst.gap.toFixed(3)} (${worst.path.split('/').pop()})`, gaps.every((g) => g.gap <= ref.tolerance), 'all');
  }
}

// CytoML's counts on the FlowJo exports (reference/cytoml.json, written by generate_cytoml.R):
// Bioconductor's FlowJo reader against CytoWeave. CytoML reads FlowJo's ellipses differently from
// FlowJo (on the built case FlowJo 11 shows 87.2% for the ellipse, CytoWeave 87.1%, CytoML 80.4%),
// so ellipses are reported, not required.
function cytomlChecks(cases) {
  let ref;
  try {
    ref = JSON.parse(readFileSync(new URL('./reference/cytoml.json', import.meta.url), 'utf8'));
  } catch {
    check('flowkit', 'CytoML reads CytoWeave\'s FlowJo exports', 'not generated (run write_flowjo_exports.mjs and generate_cytoml.R)', false, 'read');
    return;
  }
  const sample = (name) => name.replace(/_\d+$/, '').replace(/\.fcs$/i, '');
  const failed = cases.filter((c) => !ref.exports[c.name] || ref.exports[c.name].error);
  check('flowkit', `CytoML ${ref.versions.CytoML} (flowWorkspace ${ref.versions.flowWorkspace}) reads every CytoWeave FlowJo export`, failed.length ? failed.map((c) => `${c.name}: ${ref.exports[c.name]?.error ?? 'missing'}`).slice(0, 2).join('; ') : `${cases.length} of ${cases.length}`, !failed.length, 'all');
  let same = 0;
  let total = 0;
  const ellipses = [];
  const differ = [];
  for (const c of cases) {
    const counts = new Map((ref.exports[c.name]?.populations ?? []).map((p) => [`${sample(p.sample)}|${p.path}`, p.count]));
    for (const r of c.rows) {
      const n = counts.get(`${sample(r.sampleName)}|${r.path}`);
      total += 1;
      if (n === r.cytoweave) same += 1;
      else if (n !== undefined && isEllipseGate(c, r.path)) ellipses.push(`${r.path.split('/').pop()} ${n} vs ${r.cytoweave}`);
      else differ.push(`${c.name} ${r.sampleName} ${r.path}: CytoML ${n} vs CytoWeave ${r.cytoweave}`);
    }
  }
  check('flowkit', `CytoML on CytoWeave's FlowJo exports: populations whose count equals CytoWeave's (${cases.length} workspaces)`, `${same} of ${total}${ellipses.length ? `; ${ellipses.length} ellipses differ (CytoML reads FlowJo ellipses differently; FlowJo 11 agrees with CytoWeave)` : ''}${differ.length ? `; ${differ.slice(0, 2).join('; ')}` : ''}`, !differ.length && same > 0, 'all (ellipses reported)');
}

// Whether a population of an export case is an ellipse in CytoWeave's workspace.
function isEllipseGate(c, path) {
  return (c.ellipses ?? []).includes(path.split('/').pop());
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
    for (const id of ['pbmc-immunophenotyping', 'flowjo-workspace', 'spectral-25color', 'cell-cycle', 'proliferation', 'cytof-cohort', 'cytof-barcoded', 'index-sort', 'qc-showcase', 'bead-qc']) {
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

  // The reader against mutated files (fuzz-cases.mjs): every file opens with data that agree with
  // its description, or is refused with a message; nothing crashes, hangs or allocates what the
  // file cannot hold. Seeded, so a failure replays (node validation/fuzz.mjs --replay).
  async fuzz() {
    const seeds = seedFiles();
    let exact = 0;
    const wrong = [];
    for (const file of seeds) {
      const { datasets } = parseFCS(file.bytes);
      const ok = datasets.length === file.expected.length && datasets.every((d, k) => d.diagnostics.every((x) => x.level === 'info') && file.expected[k].every((column, p) => column.length === d.eventCount && column.every((v, e) => Object.is(d.data[p][e], v))));
      if (ok) exact += 1;
      else wrong.push(file.name);
    }
    check('fuzz', `${seeds.length} seed files in every layout read (float, double, 8–64-bit integers in every byte order, packed, ASCII, mixed types, supplemental TEXT, $NEXTDATA chains) hold exactly the values written`, `${exact} exact${wrong.length ? `; wrong: ${wrong.join(', ')}` : ''}`, exact === seeds.length, 'all');
    const summary = await fuzz({ seed: 1, count: 20000 });
    check('fuzz', `20,000 mutated files (HEADER offsets, keyword values, deleted and duplicated keywords, delimiters, flipped bytes, version, truncation): read consistently or refused with an FCSError, by both readers alike`, `${summary.read} read, ${summary.refused} refused, ${summary.failures.length} failed${summary.failures.length ? `: ${summary.failures.slice(0, 2).map((f) => `${f.file} #${f.seed} ${f.problem}`).join('; ')}` : ''}`, summary.failures.length === 0, 'no crash, hang, outsized allocation or disagreement');
    check('fuzz', 'no mutated file takes long to read or refuse', `slowest ${summary.slowest.toFixed(0)} ms (${summary.slowestCase})`, summary.slowest < 1000, '< 1 s');
  },
  // Analysis templates (template-cases.mjs): an analysis saved as a template and applied to the
  // same events written as another instrument writes them (other detector names, another order,
  // the markers kept), through the template's JSON.
  templates() {
    const input = pbmcFiles(0.1);
    const source = sourceAnalysis(input);
    const template = parseTemplate(JSON.stringify(buildTemplate(source.ws, { name: 'PBMC analysis' })));
    const before = countsOf(source.ws, source.views);
    const compare = (after) => {
      let same = 0;
      const differ = [];
      for (const [path, counts] of before) {
        const other = after.get(path);
        if (!other) continue;
        if ([...counts].every(([sample, n]) => other.get(sample) === n)) same += 1;
        else differ.push(path.split(' / ').pop());
      }
      return { same, differ };
    };
    const other = loadSamples(asOtherInstrument(input.files), 'other instrument');
    const applied = applyTemplate(other.ws, template);
    const byMarker = applied.report.channels.filter((c) => c.how === 'marker').length;
    const result = compare(countsOf(applied.ws, other.views));
    check('templates', `an analysis of ${before.size} populations (polygons, quadrants, ranges, a rectangle, a Boolean) applied to the same events with every detector renamed and reordered: each population holds the same events in all ${source.ws.samples.length} samples`, `${result.same} of ${before.size} identical${result.differ.length ? `; differ: ${result.differ.join(', ')}` : ''}; ${byMarker} channels matched by marker, ${applied.report.channels.length - byMarker} by name`, result.same === before.size && applied.report.unmatched === 0, 'all identical, every channel matched');
    check('templates', 'its plots, table (with a channel column) and gating-strategy figure follow onto the matched channels', `${applied.report.plots} plots, ${applied.report.tables} table (${applied.ws.tables[0]?.columns.length} columns), ${applied.report.figures} figure (${applied.ws.figures[0]?.items.filter((i) => i.kind === 'plot').length} plots)`, applied.report.plots === 2 && applied.report.tables === 1 && applied.ws.tables[0].columns.length === source.ws.tables[0].columns.length && applied.report.figures === 1 && applied.ws.figures[0].items.filter((i) => i.kind === 'plot').every((i) => applied.ws.samples[0].channels.some((c) => c.name === i.spec.x)), 'all, on the new detectors');
    const partial = loadSamples(asOtherInstrument(input.files, { unlabel: ['CD25', 'CD127'] }), 'without CD25 and CD127');
    const appliedPartial = applyTemplate(partial.ws, template);
    const resultPartial = compare(countsOf(appliedPartial.ws, partial.views));
    check('templates', 'with CD25 and CD127 not named in the panel: only the gate on them is skipped, with the reason, and every other population holds the same events', `skipped: ${appliedPartial.report.gates.skipped.map((x) => `${x.gate} (${x.reason})`).join('; ')}; ${resultPartial.same} of ${before.size - 1} identical`, appliedPartial.report.gates.skipped.length === 1 && appliedPartial.report.gates.skipped[0].gate === 'Tregs' && resultPartial.same === before.size - 1 && !resultPartial.differ.length, 'Tregs only; the rest identical');
  },
  // Published strategies (strategy-cases.mjs): OMIP-101 and OMIP-090 as recipe gates placed on
  // one sample of the PBMC example and shared by all twelve, each population against the
  // simulator's true cell types (F1).
  strategies() {
    const cohort = pbmcCohort(0.25);
    const bars = {
      'omip-101': [[0.95, ['Single cells', 'Live', 'Leukocytes', 'Lymphocytes', 'T cells', 'CD4 T cells', 'CD8 T cells', 'CD4 naive', 'CD8 naive', 'B cells']], [0.85, ['CD4 central memory', 'CD4 effector memory', 'CD4 TEMRA', 'CD8 central memory', 'CD8 effector memory', 'CD8 TEMRA', 'NK cells', 'Classical monocytes', 'Non-classical monocytes']], [0.65, ['Intermediate monocytes']]],
      'omip-090': [[0.95, ['Lymphocytes', 'Single cells', 'Live', 'CD3+ CD4+ T cells']], [0.85, ['Tregs']]],
    };
    const applied = new Map();
    for (const strategy of STRATEGIES) {
      const result = applyStrategy(cohort, strategy);
      applied.set(strategy.id, result);
      const median = new Map(result.rows.map((r) => [r.population, r.median]));
      for (const [bar, names] of bars[strategy.id]) {
        const low = names.filter((n) => !(median.get(n) >= bar));
        check('strategies', `${strategy.name}, placed on one sample and shared by ${cohort.ws.samples.length}: median F1 against the true cell types of ${names.join(', ')}${names.length === 1 && names[0] === 'Intermediate monocytes' ? ' (between the classical and non-classical monocytes on CD16)' : ''}${names.includes('Tregs') ? ' (lower in the stimulated samples, where conventional T cells raise CD25)' : ''}`, `${names.map((n) => `${n} ${median.get(n)?.toFixed(3) ?? 'not placed'}`).join('; ')}; ${result.report.gates.applied} of ${strategy.gates.length} gates placed`, !low.length && result.report.gates.applied === strategy.gates.length, `each ≥ ${bar}, every gate placed`);
      }
    }
    // A panel that lacks markers a step needs: that step and its children are left out, with the reason.
    const input = pbmcFiles(0.1);
    const partial = loadSamples(asOtherInstrument(input.files, { unlabel: ['CD25', 'CD127'] }), 'without CD25 and CD127');
    const reference = partial.ws.samples[0];
    const omip090 = strategyById('omip-090');
    const placed = applyTemplate(partial.ws, omip090, { place: placeOn(partial.views.get(reference.id), reference.name) });
    const skipped = placed.report.gates.skipped;
    check('strategies', 'OMIP-090 on a panel whose CD25 and CD127 are not named: only the Treg gate is left out, with the reason, and the rest are placed', `skipped: ${skipped.map((x) => `${x.gate} (${x.reason})`).join('; ') || 'none'}; ${placed.report.gates.applied} placed`, skipped.length === 1 && skipped[0].gate === 'Tregs' && placed.report.gates.applied === omip090.gates.length - 1, 'Tregs only');
    // The terms the strategies give their populations against those suggested from the placed
    // gates' own data: the same term, or one of its ancestors or descendants.
    let same = 0;
    let related = 0;
    const differ = [];
    let total = 0;
    for (const strategy of STRATEGIES) {
      const { ws } = applied.get(strategy.id);
      const view = cohort.views.get(ws.samples.find((x) => x.name === 'D01_Unstim').id);
      for (const g of ws.gates.filter((x) => x.ontology)) {
        total += 1;
        const top = suggestForPopulation(view, ws, g.id).suggestions[0];
        if (top?.id === g.ontology.id) same += 1;
        else if (top && (termById(top.id)?.ancestors?.includes(g.ontology.id) || termById(g.ontology.id)?.ancestors?.includes(top.id))) {
          related += 1;
          differ.push(`${g.name}: ${top.label}`);
        } else differ.push(`${g.name}: ${top?.label ?? 'none'} (unrelated)`);
      }
    }
    check('strategies', `the Cell Ontology terms of the ${total} strategy populations against the terms suggested from the placed gates' data`, `${same} the same, ${related} an ancestor or descendant${differ.length ? ` (${differ.join('; ')})` : ''}`, same + related === total && same >= total - 2, 'all the same or related, at most 2 related');
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
    const splitRuns = [];
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
      for (const mode of ['refined', 'classic']) {
        const serial = mode === 'refined' ? pq : peacoQC(sample, { channels, transforms, mode });
        splitRuns.push({ same: sameMask(serial.mask, splitPeacoQC(sample, { channels, transforms, mode }).mask), events: d.eventCount });
      }
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
    const differ = splitRuns.filter((r) => !r.same).length;
    check('qc', `PeacoQC with each channel computed apart (as on parallel workers) vs the serial run: ${splitRuns.length} runs (${cases.length} files, refined and classic)`, differ ? `${differ} runs differ` : 'identical masks', differ === 0, 'identical');
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

    // The spectral library: this experiment's spectra kept, and compared with later experiments
    // on the same instrument (independent controls, other seeds).
    let library = withSpectra({ name: 'Aurora (simulated)', entries: [] }, spectra.map((sp) => libraryEntry({ fluorochrome: sp.name, spectrum: sp.spectrum, detectors, date: '2026-05-20', file: `Ref_${sp.name}.fcs`, sha256: `a-${sp.name}` })));
    const experiment = (options) => {
      const { files: more } = generateExample('spectral-25color', options);
      const refs = more.filter((f) => f.meta.role === 'single-stain').map((f) => {
        const cols = columnsOf(load(f));
        const gate = autoGateControl(cols, detectors, {});
        return { name: f.meta.stain, spectrum: referenceSpectrum(cols, detectors, gate.positive, gate.negative, {}).spectrum, detectors };
      });
      return { files: more, refs };
    };
    const repeat = experiment({ seed: 2, samples: files.filter((f) => f.meta.role === 'single-stain').map((f) => f.name) });
    const same = compareWithLibrary(repeat.refs, library, detectors);
    const worstSame = same.slice().sort((a, b) => b.maxDiff - a.maxDiff)[0];
    check('spectral', `spectral library: another experiment's ${same.length} controls on the same instrument against the library — flagged as changed, and the largest difference (peak = 1)`, `${same.filter((r) => r.status === 'changed').length} flagged; ${worstSame.name} ${fmt(worstSame.maxDiff, 4)} at ${worstSame.detector}`, same.every((r) => r.status === 'match'), 'none');
    const degraded = experiment({ seed: 3, tandemDegradation: { 'PE-Cy7': 0.05 }, samples: [...files.filter((f) => f.meta.role !== 'sample').map((f) => f.name), donor.name] });
    const flagged = compareWithLibrary(degraded.refs, library, detectors).filter((r) => r.status === 'changed');
    check('spectral', 'spectral library: a PE-Cy7 that lost 5% of its emission to PE is flagged, and nothing else', flagged.map((r) => `${r.name} ${fmt(r.maxDiff, 3)} at ${r.detector}`).join('; ') || 'nothing flagged', flagged.length === 1 && flagged[0].name === 'PE-Cy7' && /^YG/.test(flagged[0].detector), 'PE-Cy7 only, at a YG detector');
    // A fluorochrome without a control, unmixed with its library spectrum (from the repeat
    // experiment) instead: as accurate as with its own control.
    const viaLibrary = spectra.map((sp) => (sp.name === 'PE-Cy7' ? { ...sp, spectrum: Array.from(spectrumOn(latestEntries(withSpectra(library, [libraryEntry({ fluorochrome: 'PE-Cy7', spectrum: repeat.refs.find((r) => r.name === 'PE-Cy7').spectrum, detectors, date: '2026-06-01', file: 'Ref_PE-Cy7.fcs', sha256: 'b-PE-Cy7' })]), detectors).get('pe cy7'), detectors)) } : sp));
    const withLib = unmixWithAutofluorescence(columnsOf(d), viaLibrary, af.signatures, { detectors });
    const own = rows.find((row) => row.name === 'PE-Cy7').r;
    const lib = pearson(withLib.abundances[withLib.names.indexOf('PE-Cy7')], donor.meta.truth.abundances[truthNames.indexOf('PE-Cy7')]);
    check('spectral', 'PE-Cy7 unmixed with its spectrum from the library (another experiment\'s control) instead of this experiment\'s control: Pearson r with the truth', `${fmt(lib, 4)} vs ${fmt(own, 4)}`, lib > own - 0.005, 'within 0.005');
    // Why changes matter: the degraded experiment unmixed with the stale library spectrum.
    const dDonor = degraded.files.find((f) => f.name === donor.name);
    const dCols = columnsOf(load(dDonor));
    const dAF = extractAutofluorescence(columnsOf(load(degraded.files.find((f) => f.meta.role === 'unstained'))), detectors, {});
    const stale = degraded.refs.map((sp) => (sp.name === 'PE-Cy7' ? spectra.find((x) => x.name === 'PE-Cy7') : sp));
    const truthOf = (name) => dDonor.meta.truth.abundances[dDonor.meta.truth.abundanceNames.indexOf(name)];
    const rOf = (result, name) => pearson(result.abundances[result.names.indexOf(name)], truthOf(name));
    const fresh = unmixWithAutofluorescence(dCols, degraded.refs, dAF.signatures, { detectors });
    const staleResult = unmixWithAutofluorescence(dCols, stale, dAF.signatures, { detectors });
    check('spectral', 'degraded PE-Cy7 unmixed with its stale library spectrum vs its own control: Pearson r of PE (whose detectors the donor emission reaches) and PE-Cy7', `PE ${fmt(rOf(staleResult, 'PE'), 3)} vs ${fmt(rOf(fresh, 'PE'), 3)}; PE-Cy7 ${fmt(rOf(staleResult, 'PE-Cy7'), 3)} vs ${fmt(rOf(fresh, 'PE-Cy7'), 3)}`, rOf(staleResult, 'PE') < rOf(fresh, 'PE'), 'the stale spectrum is worse for PE');
  },
  // Predicted spread (S6) on the spectral example with known noise: every detector's photon noise
  // (c1 = k) and each laser's intensity CV. The noise is fitted to the controls, each control's
  // spread is predicted from the others, and a panel that was never fitted (15 of the 25 dyes) is
  // predicted and compared with its controls unmixed with its own spectra.
  spread() {
    const laserCV = { UV: 0.03, V: 0.02, B: 0.015, YG: 0.025, R: 0.02 };
    const fluorochromes = ['BUV395', 'BUV496', 'BUV563', 'BUV615', 'BUV661', 'BUV737', 'BUV805', 'BV421', 'BV480', 'Aqua', 'BV570', 'BV605', 'BV650', 'BV711', 'BV750', 'BV786', 'FITC', 'PerCP-Cy5.5', 'PE', 'PE-CF594', 'PE-Cy5', 'PE-Cy7', 'APC', 'Alexa Fluor 700', 'APC-Cy7'];
    const generated = generateExample('spectral-25color', { laserCV, samples: fluorochromes.map((f) => `Ref_${f}.fcs`) });
    const detectors = generated.workspaceHints.spectral.detectors;
    const controls = generated.files.filter((f) => f.meta.role === 'single-stain').map((file) => {
      const cols = columnsOf(load(file));
      const gate = autoGateControl(cols, detectors, {});
      const ref = referenceSpectrum(cols, detectors, gate.positive, gate.negative, {});
      return { name: file.meta.stain, cols, gate, spectrum: ref.spectrum };
    });
    const observe = (list) => {
      const spectra = list.map((c) => ({ name: c.name, spectrum: c.spectrum, detectors }));
      const unmixed = list.map((c, i) => ({ fluorochrome: i, abundances: unmixOLS(c.cols, spectra, { residuals: false }), positive: c.gate.positive, negative: c.gate.negative }));
      return spectralSpreading(unmixed, list.map((c) => c.name));
    };
    const modelOf = (list) => spreadModel({ names: list.map((c) => c.name), detectors, spectra: list.map((c) => c.spectrum) });
    const compare = (predicted, observed, F) => {
      const rows = [];
      for (let i = 0; i < F; i += 1) {
        const o = observed.observations.find((x) => x.i === i);
        for (const r of o?.rows ?? []) if (r.variance > 4 * r.se) rows.push({ observed: Math.sqrt(r.variance / o.deltaF), predicted: predicted.matrix[i * F + r.j] });
      }
      const a = agreement(rows);
      return { n: rows.length, median: a.medianRatio, within2x: a.within2x, r: a.correlation };
    };
    const full = observe(controls);
    const model = modelOf(controls);
    const brightness = (obs, F) => Array.from({ length: F }, (_, i) => obs.observations.find((o) => o.i === i)?.deltaF ?? Number.NaN);

    // The model itself: the true noise predicts the observed spread.
    const truth = { c1: Float64Array.from(detectors, (d) => INSTRUMENTS.aurora.detectors.find((x) => x.name === d).k), laserCV: Float64Array.from(model.lasers, (l) => laserCV[l]) };
    const exact = compare(predictedSpreading(model, truth, brightness(full, model.F)), full, model.F);
    check('spread', `spread predicted from the true noise vs the 25 unmixed controls (${exact.n} entries measured to 4 SE, median factor)`, `×${fmt(exact.median, 3)}, ${fmt(100 * exact.within2x, 0)}% within 2×, r = ${fmt(exact.r, 3)}`, exact.median < 1.15 && exact.within2x > 0.95, '< ×1.15, > 95% within 2×');

    const noise = fitNoise(model, full.observations);
    const ratios = Array.from(noise.c1).filter((_, d) => noise.identified[d]).map((v) => v / truth.c1[0]).sort((a, b) => a - b);
    check('spread', `photon noise fitted to the controls vs the truth (${ratios.length} of ${detectors.length} detectors identified, median ratio)`, `${fmt(ratios[Math.floor(ratios.length / 2)], 3)} (IQR ${fmt(ratios[Math.floor(ratios.length / 4)], 2)}–${fmt(ratios[Math.floor((3 * ratios.length) / 4)], 2)})`, Math.abs(ratios[Math.floor(ratios.length / 2)] - 1) < 0.15, 'within 15%');

    const loo = crossValidate(model, full.observations);
    check('spread', `each control's spread predicted from the other 24 (${loo.measurable} entries measured to 4 SE)`, `×${fmt(loo.medianRatio, 3)}, ${fmt(100 * loo.within2x, 0)}% within 2×, r = ${fmt(loo.correlation, 3)}`, loo.within2x > 0.9 && loo.correlation > 0.9, '> 90% within 2×, r > 0.9');

    // A panel never fitted: 15 of the 25 dyes, unmixed with only their spectra.
    const keep = ['BUV395', 'BUV496', 'BUV661', 'BUV805', 'BV421', 'BV480', 'BV605', 'BV711', 'BV786', 'FITC', 'PE', 'PE-Cy5', 'PE-Cy7', 'APC', 'APC-Cy7'];
    const sub = controls.filter((c) => keep.includes(c.name));
    const subObserved = observe(sub);
    const subModel = modelOf(sub);
    const whatIf = compare(predictedSpreading(subModel, noise, brightness(subObserved, subModel.F)), subObserved, subModel.F);
    check('spread', `a ${sub.length}-dye panel predicted with the noise of the 25-dye controls vs its own unmixed controls (${whatIf.n} entries)`, `×${fmt(whatIf.median, 3)}, ${fmt(100 * whatIf.within2x, 0)}% within 2×, r = ${fmt(whatIf.r, 3)}`, whatIf.within2x > 0.9, '> 90% within 2×');
    const photonOnly = compare(predictedSpreading(subModel, { c1: noise.c1, laserCV: new Float64Array(model.lasers.length) }, brightness(subObserved, subModel.F)), subObserved, subModel.F);
    check('spread', 'the same without laser fluctuations (photon noise only)', `×${fmt(photonOnly.median, 3)}, ${fmt(100 * photonOnly.within2x, 0)}% within 2×, r = ${fmt(photonOnly.r, 3)}`, true, 'reported');
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
    const bundled = bundledCase();
    const built = builtCase();
    for (const c of [bundled, built]) exportChecks('flowjo', c);

    flowJo11Checks('flowjo', [bundled, built]);
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

  // Autogating: the PBMC example with instrument-like shifts (per-detector gains, the spillover
  // following them, and a scatter gain) applied to every sample but the one the gates were drawn
  // on; every event's true cell type is known (autogating-cases.mjs).
  autogating() {
    const cohort = buildCohort({ scale: 0.25, gainOf: randomGains(1.6, 7) });
    const reference = cohort.ws.samples.find((s) => s.name === 'D01_Unstim').id;
    const { rows } = adaptTopDown(cohort.ws, cohort.views, cohort.truth, { reference });
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const lines = [];
    let noWorse = true;
    for (const name of ORDER) {
      const r = rows.filter((x) => x.gate === name);
      const before = mean(r.map((x) => x.before));
      const after = mean(r.map((x) => x.after));
      if (after < before - 0.002) noWorse = false;
      lines.push(`${name} ${before.toFixed(3)} → ${after.toFixed(3)}`);
    }
    check('autogating', `shifted cohort (${rows.length / ORDER.length} samples): mean F1 against the true cell types, template → adapted`, lines.join('; '), noWorse, 'no gate worse');
    // Safety: a population left inaccurate is never reported as fitting: it is sent to review, or
    // shown as an adjustment that raised it.
    const poor = rows.filter((x) => x.after < 0.85);
    const passed = poor.filter((x) => x.status === 'keep' || (x.status === 'adjust' && x.after <= x.before));
    const raised = poor.filter((x) => x.status === 'adjust' && x.after > x.before);
    check('autogating', 'shifted cohort: no population left with F1 below 0.85 is reported as fitting', `${poor.length} below 0.85 (${[...new Set(poor.map((x) => x.gate))].join(', ') || 'none'}): ${poor.filter((x) => x.status === 'review').length} sent to review, ${raised.length} raised by an adjustment${raised.length ? ` (${raised.map((x) => `${x.before.toFixed(2)} → ${x.after.toFixed(2)}`).join(', ')})` : ''}; ${passed.length} reported as fitting`, passed.length === 0, 'none');
    const adjusted = rows.filter((x) => x.status === 'adjust');
    const worsened = adjusted.filter((x) => x.after < x.before - 0.01);
    check('autogating', 'proposed adjustments (confidence ≥ 0.8): none makes a population less accurate', `${adjusted.length} proposed; ${worsened.length} lowered F1 by more than 0.01${worsened.length ? ` (${worsened.map((x) => x.gate).join(', ')})` : ''}`, worsened.length === 0 && adjusted.length > 0, 'none');
    const reviewed = rows.filter((x) => x.status === 'review');
    const accepted = rows.filter((x) => x.status !== 'review');
    check('autogating', 'samples sent to review are the ones left least accurate', `${reviewed.length} sent to review, mean F1 ${mean(reviewed.map((x) => x.after)).toFixed(3)}; the other ${accepted.length} ${mean(accepted.map((x) => x.after)).toFixed(3)}`, reviewed.length > 0 && mean(reviewed.map((x) => x.after)) < mean(accepted.map((x) => x.after)), 'lower');

    // The workflow: an expert corrects each sample sent to review, gate by gate from the top; the
    // gates below are adapted after their parents are right.
    const loop = adaptTopDown(cohort.ws, cohort.views, cohort.truth, { reference, reviewer: true });
    const looked = loop.rows.filter((x) => x.status === 'review').length;
    // The ceiling: each template gate's F1 on the sample it was drawn on (the shape of the gate,
    // not its placement, limits it there).
    const ceiling = (name) => truthF1(cohort.ws, cohort.views, cohort.truth, cohort.ws.gates.find((g) => g.name === name).id, reference, TRUTH[name]);
    const finals = ORDER.map((name) => [name, mean(loop.rows.filter((x) => x.gate === name).map((x) => x.after)), ceiling(name)]);
    // Boundaries that are robust on a sample are kept by design (moving them harms agreement with
    // experts on real data), so a gap to the reference remains where a large shift left a robust
    // boundary off-center.
    const templates = ORDER.map((name) => mean(loop.rows.filter((x) => x.gate === name).map((x) => x.before)));
    const overall = mean(finals.map(([, v]) => v));
    const ceilingMean = mean(finals.map(([, , c]) => c));
    check('autogating', `review workflow: after an expert corrects the ${looked} of ${loop.rows.length} gate-sample pairs sent to review, mean F1 (and on the reference sample)`, `${finals.map(([n, v, c]) => `${n} ${v.toFixed(3)} (${c.toFixed(3)})`).join('; ')}; all gates ${overall.toFixed(3)} (${ceilingMean.toFixed(3)})`, finals.every(([, v], i) => v >= templates[i] - 0.002) && overall >= ceilingMean - 0.02, 'every gate no worse than the template; all gates within 0.02 of the reference');

    // Probabilities: events the ensemble agrees on are true members more often than uncertain ones.
    let sure = [0, 0];
    let unsure = [0, 0];
    const mono = cohort.ws.gates.find((g) => g.name === 'Monocytes');
    for (const x of rows.filter((r) => r.gate === 'Monocytes')) {
      const { labels, names } = cohort.truth.get(x.sampleId);
      x.result.list.forEach((e, k) => {
        const p = x.result.probabilities[k];
        const member = labels[e] >= 0 && TRUTH.Monocytes(names[labels[e]]);
        if (p >= 0.9) sure = [sure[0] + (member ? 1 : 0), sure[1] + 1];
        else if (p > 0.1) unsure = [unsure[0] + (member ? 1 : 0), unsure[1] + 1];
      });
    }
    void mono;
    check('autogating', 'membership probabilities: true monocytes among events with p ≥ 0.9 vs 0.1 < p < 0.9', `${(100 * sure[0] / sure[1]).toFixed(1)}% of ${sure[1]} vs ${(100 * unsure[0] / Math.max(1, unsure[1])).toFixed(1)}% of ${unsure[1]}`, sure[0] / sure[1] > unsure[0] / Math.max(1, unsure[1]) && sure[0] / sure[1] > 0.85, 'higher, and > 85%');

    // No shift (the same instrument throughout): nothing to review, and nothing made worse.
    const steady = buildCohort({ scale: 0.25, gainOf: () => null });
    const calm = adaptTopDown(steady.ws, steady.views, steady.truth, {}).rows;
    const calmReview = calm.filter((x) => x.status === 'review').length;
    const delta = mean(calm.map((x) => x.after)) - mean(calm.map((x) => x.before));
    check('autogating', 'unshifted cohort (no record of where the gates were drawn): false alarms, and the change in mean F1', `${calmReview} of ${calm.length} sent to review; ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`, calmReview <= 0.05 * calm.length && delta > -0.002, '≤ 5% and no loss');

    // Learning from a correction: two batches, the second with a 20% lower scatter gain. An expert
    // corrects the monocyte gate on one sample of the second batch; the rest of that batch follows.
    const batch = buildCohort({ scale: 0.25, gainOf: (sample, p) => (/^D0[456]/.test(sample) && p.type === 'scatter' ? 0.8 : null) });
    const ref = batch.ws.samples.find((s) => s.name === 'D01_Unstim').id;
    const corrected = batch.ws.samples.find((s) => s.name === 'D04_Unstim').id;
    const targets = batch.ws.samples.filter((s) => /^D0[456]/.test(s.name) && s.id !== corrected).map((s) => s.id);
    const monocytes = batch.ws.gates.find((g) => g.name === 'Monocytes');
    const withDrawn = { ...batch.ws, gates: batch.ws.gates.map((g) => (g.id === monocytes.id ? { ...g, meta: { ...(g.meta ?? {}), drawnOn: ref } } : g)) };
    const applyRun = (w) => {
      let next = w;
      for (const r of adaptAcrossSamples(w, monocytes.id, batch.views).results) if (r.status === 'adjust') next = setGateGeometryAt(next, monocytes.id, r.geometry, r.sampleId);
      return mean(targets.map((id) => truthF1(next, batch.views, batch.truth, monocytes.id, id, TRUTH.Monocytes)));
    };
    const template = mean(targets.map((id) => truthF1(withDrawn, batch.views, batch.truth, monocytes.id, id, TRUTH.Monocytes)));
    const alone = applyRun(withDrawn);
    const expert = expertCorrection(withDrawn, batch.views, batch.truth, 'Monocytes', corrected);
    const learned = applyRun(setGateGeometryAt(withDrawn, monocytes.id, expert.geometry, corrected));
    check('autogating', 'learning from a correction: the second batch\'s monocyte F1, template / adapted / adapted after one expert correction', `${template.toFixed(3)} / ${alone.toFixed(3)} / ${learned.toFixed(3)}`, learned >= alone && learned > template, 'the correction helps');
  },

  // External data: the ISAC Gating-ML 2.0 compliance suite. Each gate file is imported as the app
  // imports it (compensations, ratio and unmixed channels, gates) into a workspace whose sample
  // uses the file's own spillover, and every gate is evaluated by the engine on every event.
  // External data: four FlowJo workspaces of an intracellular cytokine study (als-ics), whose
  // expert adjusted the gates per donor. Each version of a gate the expert drew is the template in
  // turn and is adapted to the other wells; the measure is agreement (F1) with the expert's own
  // gate for each well. Stimulated wells shift populations for biological reasons (CD3 and CD4
  // down-regulation), which an adaptation must not gate away.
  experts() {
    const data = dataset('als-ics');
    const grouped = [];
    const alone = [];
    const counts = [];
    for (const screen of ['screen3', 'screen4']) {
      for (const set of ['ALS', 'HC']) {
        const { ws, views, rows } = expertWorkspace((name) => data.read(`${screen}/${set}/${name === 'workspace' ? `${set}.wsp` : name}`), 'workspace');
        counts.push(...rows);
        grouped.push(...againstExperts(ws, views, { groupBy: 'donor' }));
        alone.push(...againstExperts(ws, views));
      }
    }
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    // The populations adapted here. FlowJo evaluates gates at its display resolution (256 channels
    // per axis), so edges through dense events differ by a few: up to about 1% for the scatter
    // polygons, and more for the cytokine gates, whose edges sit in the dense negative events.
    const adapted = counts.filter((r) => EXPERT_GATES.includes(r.path.split('/').pop()));
    const missing = counts.filter((r) => r.status === 'missing').length;
    const worstCount = Math.max(...adapted.map((r) => Math.abs(r.cytoweave - r.flowjo) / r.flowjo));
    check('experts', `FlowJo's counts of the ${adapted.length} populations adapted here, in 4 workspaces (FlowJo writes "LIVE/DEAD Aqua-A" as "LIVE_DEAD Aqua-A")`, `${missing} of ${counts.length} populations missing; largest difference ${(100 * worstCount).toFixed(2)}%`, missing === 0 && worstCount <= 0.015, 'none missing, ≤ 1.5%');

    const summary = (rows) => {
      const adjusted = rows.filter((r) => r.status === 'adjust');
      const harmful = adjusted.filter((r) => r.after < r.before - 0.02);
      const worst = adjusted.length ? Math.min(...adjusted.map((r) => r.after - r.before)) : 0;
      return { adjusted, harmful, worst, before: mean(rows.map((r) => r.before)), after: mean(rows.map((r) => r.after)), review: rows.filter((r) => r.status === 'review').length };
    };
    const g = summary(grouped);
    check('experts', `one gate per donor (the assay's design), ${grouped.length} well-gate results: mean F1 with the expert's gates, template → adapted`, `${g.before.toFixed(4)} → ${g.after.toFixed(4)}; ${g.adjusted.length} adjusted, ${g.review} sent to review`, g.after >= g.before - 0.001, 'no worse');
    check('experts', 'one gate per donor: adjustments that lower agreement with the expert by more than 0.02', `${g.harmful.length} of ${g.adjusted.length}${g.harmful.length ? ` (${g.harmful.map((r) => `${r.gate} on ${r.sample}`).join('; ')})` : ''}`, g.harmful.length === 0, 'none');
    const agrees = grouped.filter((r) => r.before >= 0.99);
    const differs = grouped.filter((r) => r.before < 0.99);
    const rate = (rows) => rows.filter((r) => r.status === 'review').length / Math.max(1, rows.length);
    check('experts', 'one gate per donor: share sent to review where the template differs from the expert (F1 < 0.99) vs where it agrees', `${(100 * rate(differs)).toFixed(0)}% of ${differs.length} vs ${(100 * rate(agrees)).toFixed(0)}% of ${agrees.length}`, rate(differs) > rate(agrees), 'higher');
    const a = summary(alone);
    check('experts', `each well adapted alone (ignoring the design): mean F1, template → adapted, and the worst adjustment`, `${a.before.toFixed(4)} → ${a.after.toFixed(4)}; ${a.adjusted.length} adjusted, ${a.harmful.length} lowering F1 by more than 0.02, worst ${a.worst.toFixed(3)}; ${a.review} sent to review`, a.worst >= -0.15 && a.after >= a.before - 0.002, 'worst ≥ −0.15, mean no worse than −0.002');
  },

  // Instrument characterization: 30 daily runs of 8-peak beads whose detectors' true Q, B and
  // CV0 are known, with three planted problems (a PMT aging from run 21, a dirty flow cell on
  // run 25, a weaker violet laser from run 27) against a baseline of the first 20 runs.
  // Counterfactual preprocessing (web/lib/multiverse.js) on the PBMC example, six donors
  // unstimulated and stimulated, with known answers: a real effect that must hold, a null, and
  // artifacts that one choice removes (a detector gain in one batch, clogs in one group, one batch
  // compensated with the wrong matrix), which must be named; then how often a chance difference
  // passes as robust.
  multiverse() {
    const describe = (s) => `${s.declared.conclusion}, ${s.agree}/${s.total} specifications agree (${s.verdict})`;
    const depends = (s) => s.dependsOn.map((d) => `${d.choice}: ${d.option} → ${d.conclusion}`).join('; ') || 'nothing alone';
    const plain = buildCohort({ scale: 0.25, gainOf: () => null });
    plain.ws = withCD25(plain.ws, plain.views, 'D01_Unstim');
    // 1. Stimulation activates 20–50% of each T subset (CD25 ×8): a real, large effect.
    const real = multiverseOf(plain, byDonor(plain.ws), 'paired-two', 'CD25+').summary;
    check('multiverse', 'real effect: CD25+ of T cells, stimulated vs unstimulated (paired, 6 donors)', describe(real), real.declared.conclusion === 'higher' && real.verdict === 'holds', 'higher, holds (≥ 90%)');
    // 2. Monocytes do not change with stimulation; activated T cells (larger, blasts) enter a
    // monocyte gate drawn wider.
    const none = multiverseOf(plain, byDonor(plain.ws), 'paired-two', 'Monocytes').summary;
    check('multiverse', 'null: monocytes, stimulated vs unstimulated', `${describe(none)}; depends on ${depends(none)}`, none.declared.conclusion === 'none' && none.share >= 0.7, 'none, ≥ 70% agree');

    // 3. Batch B (D04–D06) acquired with PE ×1.6, no true difference; the CD25+ gate cuts into the
    // CD25-dim tail. Adapting the gates to each sample removes the spurious difference.
    const batchB = (name) => ['D04', 'D05', 'D06'].includes(name.slice(0, 3));
    const shifted = buildCohort({ scale: 0.25, gainOf: (name, p) => (p.name === 'PE-A' && batchB(name) ? 1.6 : null) });
    shifted.ws = withCD25(shifted.ws, shifted.views, 'D01_Unstim', 0.9);
    const batches = shifted.ws.samples.filter((s) => /Unstim/.test(s.name)).map((s) => ({ id: s.id, group: batchB(s.name) ? 1 : 0, pair: null }));
    const gain = multiverseOf(shifted, batches, 'two', 'CD25+').summary;
    const adaptedRow = gain.dependsOn.find((d) => d.choice === 'Gates per sample' && /adapted/.test(d.option));
    check('multiverse', 'detector gain in one batch (PE ×1.6, unstimulated, 3 vs 3): spurious CD25+ difference, named', `${describe(gain)}; ${adaptedRow ? `adapted gates → ${adaptedRow.conclusion} (${fmt(adaptedRow.estimate, 2)} points, p = ${fmt(adaptedRow.p, 2)})` : 'adaptation not named'}`, gain.declared.conclusion === 'higher' && gain.verdict !== 'holds' && adaptedRow?.conclusion === 'none', 'flagged; adapted gates remove it');

    // 4. Clogs in every stimulated sample, QC applied (refined PeacoQC and flow rate; re-run with
    // MAD 4 and 8 as alternatives). Without QC, clog events (debris-like) make fewer cells.
    const clogged = buildCohort({ scale: 0.25, gainOf: () => null, example: { clogs: ['D01', 'D02', 'D03', 'D04', 'D05', 'D06'].map((d) => `${d}_Stim.fcs`) } });
    setChannel(clogged.views, qcMasks(clogged.ws, clogged.views), 'QC pass');
    setChannel(clogged.views, qcMasks(clogged.ws, clogged.views, { mad: 4 }), 'QC pass · MAD 4');
    setChannel(clogged.views, qcMasks(clogged.ws, clogged.views, { mad: 8 }), 'QC pass · MAD 8');
    clogged.ws = withQCGate(clogged.ws);
    const qcVariants = [{ id: 'mad4', label: 'stricter (MAD 4)', channel: 'QC pass · MAD 4' }, { id: 'mad8', label: 'looser (MAD 8)', channel: 'QC pass · MAD 8' }];
    const clog = multiverseOf(clogged, byDonor(clogged.ws), 'paired-two', 'Cells', { qcVariants }).summary;
    const qcRow = clog.dependsOn.find((d) => d.choice === 'Acquisition QC' && d.option === 'not applied');
    check('multiverse', 'clogs in the stimulated samples, QC applied: cells', `${describe(clog)}; ${qcRow ? `without QC → ${qcRow.conclusion} (p = ${qcRow.p < 0.001 ? qcRow.p.toExponential(1) : fmt(qcRow.p, 2)})` : 'QC not named'}; stricter and looser QC agree: ${clog.dependsOn.some((d) => /MAD/.test(d.option)) ? 'no' : 'yes'}`, clog.declared.conclusion === 'none' && qcRow?.conclusion === 'lower' && !clog.dependsOn.some((d) => /MAD/.test(d.option)), 'none; without QC lower; QC settings agree');

    // 5. Batch B compensated with the files' matrix (APC → Alexa Fluor 700 under-compensated),
    // batch A with the true one: CD8 T cells look CD4+. With the true matrix for every sample the
    // difference shrinks to what the donors really differ by.
    const comp = buildCohort({ scale: 0.25, gainOf: () => null });
    const matrices = (view) => {
      const spill = readSpillover(view.dataset.keywords, view.parameters);
      const n = spill.channels.length;
      const truth = Array.from(spill.matrix);
      truth[spill.channels.indexOf('APC-A') * n + spill.channels.indexOf('Alexa Fluor 700-A')] /= 0.7;
      return { channels: spill.channels, file: Array.from(spill.matrix), truth };
    };
    const nameOf = (id) => comp.ws.samples.find((s) => s.id === id).name;
    const setCompensation = (views, id) => {
      for (const [sampleId, view] of views) {
        const m = matrices(view);
        const file = id === 'declared' && batchB(nameOf(sampleId));
        view.setCompensation({ id: file ? 'file' : 'controls', channels: m.channels, matrix: file ? m.file : m.truth });
      }
    };
    setCompensation(comp.views, 'declared');
    comp.ws = withDoublePositive(comp.ws, comp.views, 'D01_Unstim');
    const compGroups = comp.ws.samples.map((s) => ({ id: s.id, group: batchB(s.name) ? 1 : 0, pair: null }));
    const wrong = multiverseOf(comp, compGroups, 'two', 'CD4+CD8+', { compensations: [{ id: 'controls', label: 'the controls\' matrix for every sample' }], setCompensation }).summary;
    const compRow = [...wrong.sizeDependsOn, ...wrong.dependsOn].find((d) => d.choice === 'Compensation');
    check('multiverse', 'one batch compensated with the files\' matrix: CD4+CD8+ T cells (12 samples, 6 vs 6)', `${describe(wrong)}; ${compRow ? `with the controls' matrix ${fmt(wrong.declared.result.estimate, 3)} → ${fmt(compRow.estimate, 2)} points` : 'compensation not named'}`, Boolean(compRow) && Math.abs(compRow.estimate) < 0.1 * Math.abs(wrong.declared.result.estimate), 'named; difference shrinks > 10×');

    // 6. No effect: the labels swapped within donors in every distinct way (32), T cells and
    // lymphocytes; how often the declared test is significant, and how often that passes as robust.
    let significant = 0;
    let robust = 0;
    let runs = 0;
    for (const name of ['T cells', 'Lymphocytes']) {
      const gate = plain.ws.gates.find((g) => g.name === name);
      const adapted = adaptPath(plain.ws, pathOf(plain.ws, gate.id, gate.parentId), plain.views);
      const choices = choicesFor({ ws: plain.ws, gateId: gate.id, ancestorId: gate.parentId, design: 'paired-two', adapted, counts: [6] });
      const specs = specifications(choices, { max: 32 });
      for (let mask = 0; mask < 32; mask += 1) {
        const flipped = (name6) => Boolean(mask & (1 << ['D01', 'D02', 'D03', 'D04', 'D05'].indexOf(name6.slice(0, 3)))) && name6.slice(0, 3) !== 'D06';
        const samples = plain.ws.samples.filter((s) => /^D0/.test(s.name)).map((s) => ({ id: s.id, group: (/_Stim/.test(s.name) !== flipped(s.name)) ? 1 : 0, pair: s.name.slice(0, 3) }));
        const sum = summarizeMultiverse(runMultiverse({ ws: plain.ws, views: plain.views, samples, design: 'paired-two', statistic: { stat: 'freqParent', gateId: gate.id }, choices, specs, gateId: gate.id, ancestorId: gate.parentId, adapted }), choices);
        runs += 1;
        if (sum.declared.conclusion !== 'none') {
          significant += 1;
          if (sum.verdict === 'holds') robust += 1;
        }
      }
    }
    check('multiverse', `no effect, labels swapped within donors (${runs} analyses): significant by chance, and of those holding in ≥ 90% of specifications`, `${significant} (${pct(significant / runs)}); ${robust} hold`, significant / runs <= 0.1 && robust <= significant, '≤ 10%; no more than significant');
  },
  // External data: the intracellular cytokine study (als-ics), four donors × negative, peptide
  // and PMA/ionomycin wells, the expert's gates adjusted per donor. Each comparison is checked
  // against boundaries, the per-donor adjustments (removed, or adapted) and the test.
  'multiverse-ics'() {
    const data = dataset('als-ics');
    const rows = [];
    for (const screen of ['screen3', 'screen4']) {
      for (const set of ['ALS', 'HC']) {
        const c = expertWorkspace((name) => data.read(`${screen}/${set}/${name === 'workspace' ? `${set}.wsp` : name}`), 'workspace');
        const cd4 = c.ws.gates.find((g) => g.name === 'CD4 Single Positive');
        for (const [cytokine, well] of [['IFNy FITC +', 'PMA'], ['IFNy FITC +', 'peptide'], ['IL-4 BV421 +', 'peptide']]) {
          const gate = c.ws.gates.find((g) => g.name === cytokine && g.parentId === cd4.id);
          const samples = c.ws.samples.filter((s) => s.meta.well === 'negative' || s.meta.well === well).map((s) => ({ id: s.id, group: s.meta.well === well ? 1 : 0, pair: s.meta.donor }));
          const ws = { ...c.ws, gates: [gate, ...c.ws.gates.filter((g) => g !== gate)] };
          const { summary } = multiverseOf({ ws, views: c.views }, samples, 'paired-two', cytokine);
          rows.push({ label: `${screen} ${set} CD4 ${cytokine.split(' ')[0]} ${well}`, well, summary });
        }
      }
    }
    const pma = rows.filter((r) => r.well === 'PMA');
    check('multiverse-ics', `IFNγ+ CD4 T cells, PMA vs negative (4 workspaces): every specification agrees`, pma.map((r) => `${r.label.split(' CD4')[0]}: ${r.summary.declared.conclusion} ${r.summary.agree}/${r.summary.total}`).join('; '), pma.every((r) => r.summary.share === 1), 'all agree');
    const fragile = rows.filter((r) => r.summary.verdict !== 'holds');
    check('multiverse-ics', `peptide vs negative (8 comparisons): fragile conclusions and what they depend on`, fragile.length ? fragile.map((r) => `${r.label}: ${r.summary.declared.conclusion} in ${r.summary.agree}/${r.summary.total}, depends on ${r.summary.dependsOn.slice(0, 2).map((d) => `${d.choice.toLowerCase()} ${d.option}`).join(', ')}`).join('; ') : 'none', true, 'reported');
  },
  instrument() {
    const { files } = generateExample('bead-qc');
    const runs = files.map((file) => {
      const d = parseFCS(file.bytes).datasets[0];
      const sample = sampleFromDataset(d, { name: file.name, sha256: file.name });
      return beadRun(new SampleView(sample, d), sample, { peaks: 8 });
    });
    const err = { Q: [], B: [], CV0: [] };
    let within = 0;
    let total = 0;
    files.forEach((file, i) => {
      for (const [ch, truth] of Object.entries(file.meta.truth.detectors)) {
        const got = runs[i].channels[ch];
        for (const k of ['Q', 'B', 'CV0']) err[k].push(Math.abs(got[k] - truth[k]) / truth[k]);
        for (const k of ['Q', 'B']) { total += 1; if (Math.abs(got[k] - truth[k]) <= 2 * got.se[k]) within += 1; }
      }
    });
    const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const pct = (v) => `${(100 * v).toFixed(1)}%`;
    check('instrument', `Q, B and bead CV of 18 detectors on ${runs.length} runs (15,000 events each) against the truth: median (95th percentile) relative error`, `Q ${pct(q(err.Q, 0.5))} (${pct(q(err.Q, 0.95))}); B ${pct(q(err.B, 0.5))} (${pct(q(err.B, 0.95))}); CV ${pct(q(err.CV0, 0.5))} (${pct(q(err.CV0, 0.95))})`, q(err.Q, 0.5) < 0.03 && q(err.Q, 0.95) < 0.1 && q(err.B, 0.5) < 0.1 && q(err.B, 0.95) < 0.3 && q(err.CV0, 0.5) < 0.08, 'Q < 3% (95th < 10%), B < 10% (95th < 30%), CV < 8%');
    check('instrument', 'Q and B: the truth within 2 standard errors of the fit (as flowQB reports them)', `${within} of ${total} (${pct(within / total)})`, within / total >= 0.8, '≥ 80%');

    // Levey–Jennings against the first 20 runs.
    const planted = (ch, metric, run) => (ch === 'BV421-A' && (metric === 'Q' || metric === 'B') && run >= 21)
      || (ch === 'FITC-A' && metric === 'B' && run >= 25)
      || (/^BV/.test(ch) && metric === 'level' && run >= 27);
    const flags = runs.map((_, i) => runFlags(runs, i, { baseline: 20 }).filter((f) => f.rules.some((r) => REJECT_RULES.has(r))));
    const baselineAlarms = flags.slice(0, 20).flat().length;
    const firstFlag = (pred) => flags.findIndex((list) => list.some(pred)) + 1;
    const pmt = firstFlag((f) => f.channel === 'BV421-A' && f.metric === 'Q');
    const flowCell = firstFlag((f) => f.channel === 'FITC-A' && f.metric === 'B');
    const laser = flags.findIndex((list) => ['BV421-A', 'BV510-A', 'BV605-A', 'BV650-A', 'BV711-A', 'BV786-A'].every((ch) => list.some((f) => f.channel === ch && f.metric === 'level'))) + 1;
    check('instrument', 'Levey–Jennings: first run flagged for each planted problem (PMT aging from run 21, dirty flow cell from 25, weaker violet laser from 27, all six violet detectors)', `PMT run ${pmt}; flow cell run ${flowCell}; laser run ${laser}`, pmt >= 21 && pmt <= 23 && flowCell === 25 && laser === 27, 'within 2 runs, at once, at once');
    let falseFlags = 0;
    let series = 0;
    for (let i = 20; i < runs.length; i += 1) {
      for (const ch of Object.keys(runs[i].channels)) for (const metric of ['Q', 'B', 'level']) {
        if (planted(ch, metric, i + 1)) continue;
        series += 1;
        if (flags[i].some((f) => f.channel === ch && f.metric === metric)) falseFlags += 1;
      }
    }
    check('instrument', 'Levey–Jennings: runs flagged out of control in the 20 baseline runs, and false flags on unaffected detectors and metrics in runs 21–30', `${baselineAlarms} in the baseline; ${falseFlags} of ${series} (${pct(falseFlags / series)})`, baselineAlarms === 0 && falseFlags / series <= 0.02, 'none; ≤ 2%');
  },

  // External data: flowQB (Parks et al. 2017's weighted quadratic fit) on its own LSR II data —
  // an LED pulser series and Spherotech 8-peak and Thermo Fisher 6-peak beads — with its results
  // (reference/flowqb.json, written by generate_flowqb.R) beside CytoWeave's.
  flowqb() {
    const data = dataset('flowqbdata');
    const ref = JSON.parse(readFileSync(new URL('./reference/flowqb.json', import.meta.url), 'utf8'));
    // flowQB writes undefined standard errors (three peaks, no degrees of freedom) as "NaN".
    const num = (v) => (typeof v === 'number' ? v : Number.NaN);
    const rel = (a, b) => (Number.isNaN(a) && Number.isNaN(num(b)) ? 0 : a === num(b) ? 0 : Math.abs(a - num(b)) / Math.max(Math.abs(num(b)), 1e-300));
    const sci = (v) => (v === 0 ? '0' : v.toExponential(1));
    const compare = (ours, theirs) => {
      let worst = 0;
      let fitted = 0;
      let peaksAgree = true;
      for (const [ch, r] of Object.entries(theirs)) {
        const mine = ours[ch];
        if (!mine) { worst = Infinity; continue; }
        if (mine.peaks.length !== r.peaks.length || mine.peaks.some((p, i) => p.n !== r.peaks[i].n || p.omit !== r.peaks[i].omit)) peaksAgree = false;
        mine.peaks.forEach((p, i) => { if (!p.omit) worst = Math.max(worst, rel(p.mean, r.peaks[i].mean), rel(p.sd, r.peaks[i].sd)); });
        const c = r.iterated.c;
        if (c.some((v) => typeof v !== 'number')) continue;
        fitted += 1;
        worst = Math.max(worst, ...c.map((v, k) => rel(mine.fit.c[k], v)), ...r.iterated.se.map((v, k) => rel(mine.fit.se[k], v)));
      }
      return { worst, fitted, peaksAgree };
    };
    // LED: one level per file, every event of a file.
    const ledFiles = ref.led.files.map((name) => parseFCS(data.read(`LED_Series/${name}`)).datasets[0]);
    const ledPeaks = {};
    for (const ch of Object.keys(ref.led.channels)) ledPeaks[ch] = ledFiles.map((d) => d.data[d.parameters.find((p) => p.name === ch).index]);
    const led = compare(characterize(ledPeaks), ref.led.channels);
    check('flowqb', `LED pulser (${ref.led.files.length} files, ${Object.keys(ref.led.channels).length} channels): peak statistics and iterated fit coefficients with standard errors vs flowQB ${ref.versions.flowQB}`, `${led.fitted} channels fitted; peaks ${led.peaksAgree ? 'identical' : 'differ'}; largest relative difference ${sci(led.worst)}`, led.peaksAgree && led.worst < 1e-6, 'identical peaks, < 1e-6');
    // Beads: scatter gate, k-means peaks, fit.
    for (const b of ref.beads) {
      const d = parseFCS(data.read(`Other_Tests/${b.file}`)).datasets[0];
      const columns = Object.fromEntries(d.parameters.map((p) => [p.name, d.data[p.index]]));
      const channels = Object.keys(b.channels);
      const { events, labels } = findBeadPeaks(columns, { channels, scatter: ['FSC-A', 'SSC-A'], peaks: b.peaks });
      const peaks = {};
      for (const ch of channels) {
        peaks[ch] = Array.from({ length: b.peaks }, () => []);
        events.forEach((e, k) => peaks[ch][labels[k]].push(columns[ch][e]));
      }
      const got = compare(characterize(peaks), b.channels);
      const name = b.peaks === 8 ? 'Spherotech 8-peak' : 'Thermo Fisher 6-peak';
      check('flowqb', `${name} beads (${b.file}, ${channels.length} channels): scatter gate, peaks found by k-means, and the fit vs flowQB`, `${got.fitted} channels fitted; peak memberships ${got.peaksAgree ? 'identical' : 'differ'}; largest relative difference ${sci(got.worst)}`, got.peaksAgree && got.worst < 1e-6, 'identical peaks, < 1e-6');
    }
  },

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
    const kitCases = flowKitCases();
    for (const c of kitCases) {
      exportChecks('flowkit', c);
      flowKitExportChecks(c, ref, c.original);
    }
    const ownCases = [bundledCase(), builtCase()];
    for (const c of ownCases) flowKitExportChecks(c, ref, c.original ?? { rows: [] });
    cytomlChecks([...ownCases, ...kitCases]);
    flowJo11Checks('flowkit', kitCases);
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
  // External data: one or two files from each of 40 more instruments (cytoflow's, FlowIO's and
  // FlowCal's test files, Zenodo records, RosettaX), against FlowIO and fcsparser
  // (reference/instruments.json, written by reference/generate_instruments.py) and FlowIO's own
  // published values. Where CytoWeave departs from a reference reader, the reason is checked too.
  instruments() {
    const ids = ['cytoflow-instruments', 'flowio', 'flowcal', 'zenodo-instruments', 'zenodo-nanofcm', 'rosettax'];
    const sets = ids.map((id) => [id, dataset(id)]);
    const reference = JSON.parse(readFileSync(new URL('./reference/instruments.json', import.meta.url), 'utf8')).files;
    const relative = (a, b) => Math.abs(a - b) / Math.max(1, Math.abs(b));
    // Where a reference reader is wrong, and why (each reason is checked below).
    const departures = {
      'cytoflow-instruments/Accuri - C6.fcs': { flowio: 'stale $BEGINDATA inside the TEXT' },
      'cytoflow-instruments/Beckman Coulter - Cyan.fcs': { flowio: 'stale keyword offsets; the HEADER places DATA after the TEXT' },
      'cytoflow-instruments/Millipore - Guava.fcs': { flowioScaled: 'float log channels stored as decades' },
      'zenodo-instruments/Guava easyCyte/2023-04-06_at_08-30-02am_026.FCS': { flowioScaled: '$PnG applied to log channels' },
    };
    const files = [];
    const failures = [];
    let datasets = 0;
    let exactTrip = true;
    for (const [id, data] of sets) {
      for (const path of data.files) {
        const key = `${id}/${path}`;
        const bytes = data.read(path);
        try {
          const raw = parseFCS(bytes, { linearize: false });
          const scaled = parseFCS(bytes);
          files.push({ key, bytes, raw, scaled });
          datasets += raw.datasets.length;
          for (const d of scaled.datasets) {
            const again = load({ bytes: writeFCS({ parameters: d.parameters.map((q) => ({ name: q.name, label: q.label, range: q.range })), data: d.data, keywords: d.keywords }) });
            for (let q = 0; q < d.parameters.length && exactTrip; q += 1) for (let e = 0; e < d.eventCount; e += 1) if (!Object.is(d.data[q][e], again.data[q][e])) { exactTrip = false; break; }
          }
        } catch (error) {
          failures.push(`${key}: ${error.constructor.name}: ${error.message}`);
        }
      }
    }
    const total = sets.reduce((n, [, data]) => n + data.files.length, 0);
    const instruments = new Set(files.map((f) => String(f.raw.datasets[0].keywords.$CYT ?? '').split(/[:(,]/)[0].trim()));
    check('instruments', `${total} files from ${instruments.size} instrument models (CytoFLEX, NovoCyte, Aurora, Sony, FACSDiscover S8, FACSymphony, ZE5, Attune, Accuri, Helios and more) read`, `${files.length} files, ${datasets} data sets${failures.length ? `; ${failures.slice(0, 2).join('; ')}` : ''}`, files.length === total, 'all');

    // Stored values against each reference reader that reads the file.
    const compare = (f, sets, kind, skip) => {
      let worst = 0;
      let where = '';
      sets.forEach((set, k) => {
        const expected = set[kind];
        const d = (kind === 'raw' ? f.raw : f.scaled).datasets[k];
        if (!d || d.eventCount !== expected.events) { worst = Infinity; where = `data set ${k}: ${d?.eventCount} events vs ${expected.events}`; return; }
        const timestep = Number.parseFloat(d.keywords.$TIMESTEP) || 1;
        expected.channels.forEach((channel, i) => {
          const parameter = d.parameters[i];
          if (skip?.(parameter)) return;
          const unit = kind === 'scaled' && parameter.type === 'time' ? timestep : 1;
          expected.picks.forEach((e, j) => {
            const diff = relative(d.data[i][e] * unit, channel.values[j]);
            if (diff > worst) { worst = diff; where = `${parameter.name}: ${d.data[i][e] * unit} vs ${channel.values[j]}`; }
          });
        });
      });
      return { worst, where };
    };
    // FCS 3.2 integer channels in a float file: FlowIO and fcsparser predate FCS 3.2 and read
    // every channel with $DATATYPE.
    const fcs32Integer = (d) => (q) => q.datatype && q.datatype !== String(d.keywords.$DATATYPE ?? '').trim().toUpperCase();
    let worst = 0;
    let worstWhere = '';
    const compared = { flowio: 0, fcsparser: 0 };
    const unread = [];
    const departed = [];
    for (const f of files) {
      const r = reference[f.key];
      const skip = fcs32Integer(f.raw.datasets[0]);
      const readers = [['flowio', r?.flowio], ['fcsparser', r?.fcsparser && !r.fcsparser.error ? [{ raw: r.fcsparser }] : r?.fcsparser]];
      if (readers.every(([, v]) => !v || v.error)) unread.push(f.key.split('/').pop());
      for (const [name, value] of readers) {
        if (!value || value.error) continue;
        const { worst: w, where } = compare(f, value, 'raw', skip);
        if (departures[f.key]?.[name]) { departed.push(`${f.key.split('/').pop()} (${name}: ${departures[f.key][name]}; differs by ${w.toExponential(1)})`); continue; }
        compared[name] += 1;
        if (w > worst) { worst = w; worstWhere = `${f.key}, ${name}, ${where}`; }
      }
      if (r?.flowio && !r.flowio.error && !departures[f.key]?.flowioScaled && !departures[f.key]?.flowio) {
        const { worst: w, where } = compare(f, r.flowio, 'scaled', skip);
        if (w > worst) { worst = w; worstWhere = `${f.key}, flowio scaled, ${where}`; }
      }
    }
    check('instruments', `stored and scaled values agree with FlowIO (${compared.flowio} files) and fcsparser (${compared.fcsparser}); neither reads ${unread.join(', ')}`, `within ${worst.toExponential(1)}${worst > 1e-6 ? ` (${worstWhere})` : ''}`, worst < 1e-6 && compared.flowio >= 38 && compared.fcsparser >= 40, '< 1e-6 relative');
    check('instruments', 'where CytoWeave departs from a reference reader, the reason is documented and checked below', departed.join('; ') || 'none', departed.length === 2, 'Accuri C6 and CyAn offsets');

    const file = (key) => files.find((f) => f.key === key);
    // Stale keyword offsets: the HEADER's DATA gives an event counter and a time that count up.
    const cyan = file('cytoflow-instruments/Beckman Coulter - Cyan.fcs')?.raw.datasets[0];
    const accuri = file('cytoflow-instruments/Accuri - C6.fcs')?.raw.datasets[0];
    const column = (d, name) => d.data[d.parameters.findIndex((q) => q.name === name)];
    const counter = cyan ? [...column(cyan, 'Event Count').slice(0, 3)] : [];
    const time = accuri ? column(accuri, 'Time') : [];
    let rising = true;
    for (let e = 1; e < time.length; e += 1) if (time[e] < time[e - 1]) { rising = false; break; }
    check('instruments', 'stale keyword offsets (Accuri C6: $BEGINDATA inside the TEXT; CyAn: 46 bytes past it): the HEADER\'s offsets give a counter and time that count up', `CyAn event counter ${counter.join(', ')}; Accuri time ${rising ? `rises ${time[0]} → ${time[time.length - 1]}` : 'not monotone'}`, counter.join() === '2,3,4' && rising && time.length > 0, 'counter 2, 3, 4; time never falls');

    // Float log channels stored as decades (Millipore Guava PCA, as Guava Muse): each equals its
    // linear twin. $PnG not applied to log channels (FCS 3.1; Guava easyCyte).
    const guava = file('cytoflow-instruments/Millipore - Guava.fcs')?.scaled;
    let pairWorst = 0;
    let pairs = 0;
    if (guava) {
      const d = guava.datasets[0];
      for (const [a, b] of [['GRN-HLog', 'GRN-HLin'], ['FSC-HLog', 'FSC-HLin'], ['SSC-HLog', 'SSC-HLin'], ['GRN-ALog', 'GRN-A']]) {
        const x = column(d, a);
        const y = column(d, b);
        pairs += 1;
        for (let e = 0; e < d.eventCount; e += 1) if (y[e] > 1) pairWorst = Math.max(pairWorst, relative(x[e], y[e]));
      }
    }
    const easy = file('zenodo-instruments/Guava easyCyte/2023-04-06_at_08-30-02am_026.FCS')?.scaled.datasets[0];
    const easyLog = easy?.parameters.find((q) => q.amp[0] > 0 && q.gain !== 1);
    check('instruments', `float log channels stored as decades (Millipore Guava, ${guava?.datasets.length} data sets): each equals its linear twin (${pairs} pairs); $PnG left off log channels (Guava easyCyte)`, `within ${pairWorst.toExponential(1)}; ${easyLog ? `${easyLog.name} gain ${easyLog.gain} not applied: ${!easyLog.gainApplied}` : 'no log channel with a gain'}`, pairs === 4 && pairWorst < 1e-5 && guava?.datasets.length === 15 && easyLog && !easyLog.gainApplied, '< 1e-5; 15 data sets; gain not applied');

    // FlowIO's own test of variable integer widths (16 and 32 bits, the 32-bit values masked to
    // $PnR's bits): tests/test_flowdata.py, test_parse_var_int_data.
    const published = [49135, 61373, 48575, 49135, 61373, 48575, 7523, 598, 49135, 61373, 48575, 49135, 61373, 48575, 28182, 61200, 48575, 49135, 32445, 30797, 19057, 49135, 61373, 48575, 5969, 8265081, 61266, 48575, 49135, 20925, 61265, 48575, 27961, 25200, 61287, 48575, 9795, 49135, 29117, 49135, 61373, 48575, 61228, 48575, 22, 21760, 49135, 20413, 49135, 23997, 19807, 15691602];
    const variable = file('flowio/Stratedigm S1400EXi/variable_int_example.fcs')?.raw.datasets[0];
    const decoded = variable ? Array.from({ length: variable.eventCount * variable.parameters.length }, (_, k) => variable.data[k % variable.parameters.length][Math.floor(k / variable.parameters.length)]) : [];
    check('instruments', 'mixed 16- and 32-bit integers with masked high bits (Stratedigm) equal FlowIO\'s published test values (FlowIO 1.4 itself no longer reads the file)', `${decoded.filter((v, k) => v === published[k]).length} of ${published.length} equal`, decoded.length === published.length && decoded.every((v, k) => v === published[k]), 'all 52');

    // TEXT oddities: supplemental TEXT without its leading delimiter (Bio-Rad S3) or holding
    // something else (Apogee); empty values with a form-feed delimiter (NanoFCM); FCS 3.2 (S8).
    const s3 = file('flowio/Bio-Rad S3/M0_WM278_S1.fcs')?.raw.datasets[0];
    const apogee = file('rosettax/Apogee A60-Micro/apogee_rainbow_beads.fcs')?.raw.datasets[0];
    const nano = file('zenodo-nanofcm/SP2 Uninfected with 1% Triton X-100.fcs')?.raw.datasets[0];
    const s8 = file('zenodo-instruments/BD FACSDiscover S8/Zam36 YFP.fcs')?.raw.datasets[0];
    const junk = (d) => Object.keys(d?.keywords ?? {}).filter((k) => /[\r\n\f]/.test(k) || k.length > 64).length;
    const textOk = s3 && 'SORTSTATS' in s3.keywords && 'PROTOCOL' in s3.keywords && junk(s3) === 0
      && apogee?.diagnostics.some((x) => x.code === 'stext-ignored') && junk(apogee) === 0
      && nano?.keywords.$FIL && nano.keywords.$SYS && junk(nano) === 0
      && s8?.parameters.length === 440 && s8.parameters.some((q) => q.datatype === 'I');
    check('instruments', 'TEXT segments: Bio-Rad S3\'s supplemental keywords read, Apogee\'s settings block ignored, NanoFCM\'s empty values kept apart, the S8\'s 440 parameters with integer channels (FCS 3.2)', `S3 SORTSTATS ${s3 && 'SORTSTATS' in s3.keywords ? 'read' : 'missing'}; Apogee ${apogee?.diagnostics.some((x) => x.code === 'stext-ignored') ? 'ignored' : 'read'}; NanoFCM $FIL ${nano?.keywords.$FIL ? 'present' : 'missing'}; S8 ${s8?.parameters.length} parameters; junk keywords ${junk(s3) + junk(apogee) + junk(nano)}`, Boolean(textOk), 'all, no junk keywords');

    const truncated = file('zenodo-instruments/DxFLEX/20210211_iDC_Gain3.fcs')?.raw.datasets[0];
    check('instruments', 'a file cut short (DxFLEX, 10,000 events declared) opens with the events it holds and says so', `${truncated?.eventCount} events; ${truncated?.diagnostics.filter((x) => x.level !== 'info').map((x) => x.code).join(', ')}`, truncated?.eventCount === 466 && truncated.diagnostics.some((x) => x.code === 'truncated' && x.level === 'error'), '466 events, with an error-level diagnostic');
    check('instruments', 'every data set is written and read back', exactTrip ? 'bit-exact' : 'differs', exactTrip, 'bit-exact');
    deidentifyChecks('instruments', `${files.length} instrument files`, files.map((f) => ({ name: f.key, bytes: f.bytes })));
  },
  // External data: Cell Ontology terms suggested for populations experts named (ontology-cases.mjs),
  // from the populations' marker phenotype and gates, never their names.
  ontology() {
    const rows = [];
    const bundled = bundledCase().original;
    rows.push(...evaluateOntology('bundled FlowJo example', bundled.ws, bundled.views));
    const ics = flowKitCases().find((c) => /8_color_ICS\.wsp$/.test(c.source));
    if (!ics) throw new MissingData('the flowkit data set is missing; run node validation/fetch.mjs flowkit');
    rows.push(...evaluateOntology('FlowKit 8-color ICS', ics.original.ws, ics.original.views));
    const som = dataset('rpackages');
    const mouse = importWithFiles(som.text('FlowSOM/gating.wsp'), [{ name: '68983.fcs', bytes: new Uint8Array(som.read('FlowSOM/68983.fcs')) }]);
    rows.push(...evaluateOntology("FlowSOM's mouse workspace", mouse.ws, mouse.views));
    const by = new Map();
    for (const r of rows) by.set(r.workspace, [...(by.get(r.workspace) ?? []), r]);
    const ok = rows.filter((r) => r.ok).length;
    const misses = rows.filter((r) => !r.ok).map((r) => `${r.workspace}: ${r.population} → ${r.suggested}`);
    check('ontology', `the suggested term of ${rows.length} expert-named populations in 3 workspaces (${[...by].map(([w, list]) => `${w} ${list.length}`).join(', ')}; T, B, NK, NK T, αβ and γδ T, CD4 and CD8 T, Tregs, lymphocytes, monocytes, cytokine-positive subsets) is a term the name denotes, and quality gates get none or their parent's`, `${ok} of ${rows.length}; exact ${rows.filter((r) => r.ok && r.confidence === 'exact').length}, likely ${rows.filter((r) => r.ok && r.confidence === 'likely').length}, none ${rows.filter((r) => r.ok && !r.confidence).length}${misses.length ? `; misses: ${misses.slice(0, 4).join('; ')}` : ''}`, ok === rows.length, 'all');
    // The suggestions do not read the names: renamed gates give the same suggestions.
    const renamed = { ...bundled.ws, gates: bundled.ws.gates.map((g, i) => ({ ...g, name: `population ${i + 1}` })) };
    const view = bundled.views.get(bundled.ws.samples[0].id);
    let same = 0;
    for (const gate of bundled.ws.gates) {
      const a = suggestForPopulation(view, bundled.ws, gate.id).suggestions[0]?.id ?? null;
      const b = suggestForPopulation(view, renamed, gate.id).suggestions[0]?.id ?? null;
      if (a === b) same += 1;
    }
    check('ontology', 'the suggestions come from the data and gates, not the names: with every gate renamed, each suggestion stays the same', `${same} of ${bundled.ws.gates.length} the same`, same === bundled.ws.gates.length, 'all');
  },
  // External data: the same, with real instruments' files as the seeds.
  async 'fuzz-corpus'() {
    for (const id of CORPUS) dataset(id);
    const corpus = corpusFiles();
    const summary = await fuzz({ seed: 2, count: 10000, corpus });
    check('fuzz-corpus', `10,000 mutations of ${corpus.length} instrument files (every FCS data set above, files up to 4 MB) and the seeds`, `${summary.read} read, ${summary.refused} refused, ${summary.failures.length} failed${summary.failures.length ? `: ${summary.failures.slice(0, 2).map((f) => `${f.file} #${f.seed} ${f.problem}`).join('; ')}` : ''}; slowest ${summary.slowest.toFixed(0)} ms`, summary.failures.length === 0, 'no crash, hang, outsized allocation, disagreement or case over 1 s');
  },
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
  // External data: the 15 single-stain bead controls of a BD LSRFortessa (Zenodo 22808501), each
  // gated on bead singlets and compensated with FACSDiva's matrix. Each control's spreading is
  // predicted from a noise model fitted to the other 14, and off-scale events are left out.
  fortessa() {
    const data = dataset('zenodo-skull');
    const sample = parseFCS(data.read('Skull BM Broad_Tube_017.fcs')).datasets[0];
    const spill = readSpillover(sample.keywords, sample.parameters);
    const detectors = spill.channels;
    const controls = data.files.filter((f) => f.startsWith('Compensation Controls_')).map((f) => {
      const d = parseFCS(data.read(f)).datasets[0];
      const [laser, filter] = f.replace('Compensation Controls_', '').split(' ');
      const [wavelength, , width] = filter.split(',');
      const columns = columnsOf(d);
      // Bead singlets: within 4 robust SDs of the median FSC-A and SSC-A.
      const center = (values) => {
        const sorted = Float64Array.from(values).sort();
        return [sorted[Math.floor(sorted.length / 2)], (sorted[Math.floor(sorted.length * 0.75)] - sorted[Math.floor(sorted.length * 0.25)]) / 1.349];
      };
      const [fm, fs] = center(columns['FSC-A']);
      const [sm, ss] = center(columns['SSC-A']);
      const keep = [];
      for (let e = 0; e < d.eventCount; e += 1) if (Math.abs(columns['FSC-A'][e] - fm) < 4 * fs && Math.abs(columns['SSC-A'][e] - sm) < 4 * ss) keep.push(e);
      const use = keep.length >= 500 ? keep : null;
      const raw = Object.fromEntries(detectors.map((name) => [name, use ? Float32Array.from(use, (e) => columns[name][e]) : columns[name]]));
      return { channel: detectors.find((c) => c.startsWith(`${laser} ${wavelength}/${width}`)), raw, columns: compensate(raw, spill) };
    });
    const clipped = spilloverSpreading(controls.map(({ channel, columns }) => ({ channel, columns })), detectors);
    const observed = spilloverSpreading(controls, detectors, { range: 262144 });
    const at = (m, a, b) => m.matrix[detectors.indexOf(a) * detectors.length + detectors.indexOf(b)];
    check('fortessa', 'off-scale events left out of the spreading matrix (B 710/50 → V 710/50, a sixth of its positives clipped)', `${fmt(at(observed, 'B 710/50-A', 'V 710/50-A'), 2)} (with them ${fmt(at(clipped, 'B 710/50-A', 'V 710/50-A'), 1)})`, at(observed, 'B 710/50-A', 'V 710/50-A') < 5, '< 5');
    const model = spreadModel({ names: detectors, detectors, spectra: spill.matrix });
    const noise = fitNoise(model, observed.observations);
    check('fortessa', `photon noise fitted to the controls is physical in every detector (c1, units per photoelectron)`, `${fmt(Math.min(...noise.c1), 2)}–${fmt(Math.max(...noise.c1), 2)}`, noise.c1.every((v) => v > 0), '> 0');
    const loo = crossValidate(model, observed.observations);
    check('fortessa', `each control's spread predicted from the other 14 (${loo.measurable} entries measured to 4 SE)`, `×${fmt(loo.medianRatio, 3)}, ${fmt(100 * loo.within2x, 0)}% within 2×, r = ${fmt(loo.correlation, 3)}`, loo.within2x > 0.7 && loo.correlation > 0.8, '> 70% within 2×, r > 0.8');
    const photon = crossValidate(model, observed.observations, { laser: false });
    check('fortessa', 'the same without laser fluctuations (photon noise only)', `×${fmt(photon.medianRatio, 3)}, ${fmt(100 * photon.within2x, 0)}% within 2×, r = ${fmt(photon.correlation, 3)}`, true, 'reported');
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
      const split = splitPeacoQC(sample, { channels: p.channels, transforms, mode: 'classic', method: 'all' });
      const removedByR = new Uint8Array(d.eventCount);
      for (const [a, b] of p.removed) removedByR.fill(1, a, b + 1);
      let differing = 0;
      let removed = 0;
      for (let e = 0; e < d.eventCount; e += 1) {
        const out = result.mask[e] ? 0 : 1;
        removed += out;
        if (out !== removedByR[e]) differing += 1;
      }
      peaco.push({ file: p.file.split('/').pop(), differing, ours: (100 * removed) / d.eventCount, theirs: p.percentageRemoved, binsAgree: result.eventsPerBin === p.eventsPerBin, split: sameMask(split.mask, result.mask) });
    }
    const differing = peaco.reduce((s, p) => s + p.differing, 0);
    check('bioconductor', `PeacoQC ${versions.PeacoQC} (all checks, isolation tree and MAD) and CytoWeave's classic mode remove the same events (${peaco.length} files: 3 real and 4 simulated wells with clogs, bubbles and drift)`, `${differing} events differ; removed ${peaco.map((p) => `${p.file} ${p.ours.toFixed(2)}% vs ${p.theirs.toFixed(2)}%`).join(', ')}`, differing === 0 && peaco.every((p) => p.binsAgree) && peaco.length === 7, '0 events differ, same bins');
    check('bioconductor', `the same with each channel computed apart, as on parallel workers (${peaco.length} files)`, peaco.every((p) => p.split) ? 'identical masks' : `${peaco.filter((p) => !p.split).length} files differ`, peaco.every((p) => p.split), 'identical');

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
  // Colors anyone can read and tell apart: every text color on every surface it is used on
  // (WCAG AA, 4.5:1), in both themes with color-vision-friendly colors off and on; and how far
  // apart the palettes' colors look with protanopia, deuteranopia and tritanopia (Machado et al.
  // 2009; CIEDE2000). The interface itself is audited in the browser (docs/capture/capture.mjs
  // --audit, axe-core).
  accessibility() {
    const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
    for (const [name, tokens] of Object.entries(themeTokens(css))) {
      const pairs = textPairs(tokens);
      const failing = pairs.filter((p) => p.ratio < 4.5);
      const worst = pairs.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      check('accessibility', `text contrast, ${name} theme${name.includes('cvd') ? ' (color-vision-friendly colors)' : ''}: ${pairs.length} text-on-surface pairs`, failing.length ? failing.map((p) => `${p.use} ${fmt(p.ratio, 3)}`).join('; ') : `lowest ${fmt(worst.ratio, 3)} (${worst.use})`, !failing.length, '≥ 4.5:1');
    }
    const describe = (report) => VISIONS.map((v) => `${v} ${fmt(report[v].min, 3)}`).join(', ');
    const friendly8 = paletteReport(CATEGORICAL_CVD, 8);
    const friendly20 = paletteReport(CATEGORICAL_CVD);
    check('accessibility', 'color-vision-friendly palette: smallest CIEDE2000 between any two of the first 8 colors', describe(friendly8), VISIONS.every((v) => friendly8[v].min >= 10), '≥ 10 in every vision');
    check('accessibility', 'color-vision-friendly palette: the same for all 20 colors', describe(friendly20), VISIONS.every((v) => friendly20[v].min >= 7), '≥ 7 in every vision');
    const default8 = paletteReport(CATEGORICAL, 8);
    check('accessibility', 'default palette, first 8 colors (why the setting exists)', describe(default8), true, 'reported');
    // Status colors: ok, warning and danger apart from each other.
    for (const name of ['light', 'dark', 'light+cvd', 'dark+cvd']) {
      const t = themeTokens(css)[name];
      const report = paletteReport([t.ok, t.warn, t.danger]);
      const required = name.includes('cvd');
      check('accessibility', `status colors (ok, warning, danger), ${name}: smallest CIEDE2000`, describe(report), !required || VISIONS.every((v) => report[v].min >= 9), required ? '≥ 9 in every vision' : 'reported');
    }
    // Heat maps: a map read as "more" must get lighter steadily in every vision. Viridis (drawn
    // instead of the rainbow maps with the setting on) does; the classic rainbow does not.
    const monotone = (name) => VISIONS.map((v) => {
      const L = Array.from({ length: 33 }, (_, i) => labOf(simulate(colormapColor(name, i / 32), v))[0]);
      let reversals = 0;
      for (let i = 1; i < L.length; i += 1) if (L[i] < L[i - 1] - 0.5) reversals += 1;
      return reversals;
    });
    const viridis = monotone('viridis');
    const classic = monotone('classic');
    check('accessibility', 'viridis: lightness never falls along the map, in every vision', `${viridis.reduce((a, b) => a + b, 0)} reversals (classic rainbow: ${classic.join(', ')} in ${VISIONS.join(', ')})`, viridis.every((r) => r === 0), '0');
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
