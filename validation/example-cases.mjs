// The examples as demonstrations (validation suite `examples`): what was added so that, together,
// the examples show every analysis CytoWeave does, each checked against the simulator's truth or
// the program whose file an example carries.
//   - the PBMC example's FMO tube, rainbow beads with their datasheet and second day;
//   - the absolute-count example's counting beads;
//   - the files other programs would have written (FACSDiva, FlowJo 11, SpectroFlo, CSV events and
//     annotations), read by CytoWeave's importers, with each program's counts;
//   - the spectral day-2 example's faults, named by the unmixing doctor and the library;
//   - the index sort's presort file, written with a DATA offset one byte off.

import { generateExample, COUNTING, COUNT_PATIENTS } from '../web/lib/examples.js';
import { parseFCS, readSpillover } from '../web/lib/fcs.js';
import { compensate } from '../web/lib/compensation.js';
import { SampleView, countOf, population } from '../web/lib/engine.js';
import { addGates, addSamples, createWorkspace, sampleFromDataset } from '../web/lib/workspace.js';
import { buildFlowJoMigration, matchFlowJoSamples, migrationCountRows, migrationGates } from '../web/lib/flowjo-match.js';
import { importDiva } from '../web/lib/diva.js';
import { importFlowJo11 } from '../web/lib/flowjo11.js';
import { importSpectroFlo, planSpectroFloControls } from '../web/lib/spectroflo.js';
import { analyzeCSV, csvDatasets, looksLikeEvents } from '../web/lib/csv-events.js';
import { calibrateBeads, channelBounds, standardCurve } from '../web/lib/calibration.js';
import { createZip } from '../web/lib/zip.js';
import { diagnoseUnmixing } from '../web/lib/spectral-doctor.js';
import { autoGateControl, extractAutofluorescence, referenceSpectrum } from '../web/lib/spectral.js';
import { compareWithLibrary, libraryEntry } from '../web/lib/spectral-library.js';

const columnsOf = (d) => Object.fromEntries(d.parameters.map((p) => [p.name, d.data[p.index]]));

// A workspace of the files, with each one's dataset (by sample id).
function workspaceOf(files) {
  let ws = createWorkspace('examples');
  const datasets = new Map();
  for (const f of files) {
    const d = parseFCS(f.bytes).datasets[0];
    const record = sampleFromDataset(d, { name: f.name });
    datasets.set(record.id, d);
    ws = addSamples(ws, [record]);
  }
  return { ws, datasets };
}

// A view of a sample, compensated with its file's matrix.
function viewOf(record, dataset) {
  const view = new SampleView(record, dataset);
  const spill = readSpillover(dataset.keywords, dataset.parameters);
  if (spill) view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
  return view;
}

// An import (importFlowJo's shape) migrated onto the files, every population counted as the
// window counts it: the migration's count rows ({ path, flowjo (the program's count), cytoweave,
// agree }) and the samples matched.
export function migrated(result, files) {
  const { ws, datasets } = workspaceOf(files);
  const plan = buildFlowJoMigration(ws, result, matchFlowJoSamples(result.samples, ws.samples), { scales: true, compensation: true });
  const counts = {};
  for (const target of plan.migration.samples) {
    if (!target.sampleId) continue;
    const record = plan.ws.samples.find((s) => s.id === target.sampleId);
    const dataset = datasets.get(record.id);
    const view = new SampleView(record, dataset);
    const spill = readSpillover(dataset.keywords, dataset.parameters);
    const id = record.compensationId ?? 'none';
    const c = id === 'none' ? null : id === 'file' ? { id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) } : plan.ws.compensations.find((x) => x.id === id);
    if (c) view.setCompensation({ id: c.id, channels: c.channels, matrix: c.matrix });
    const out = {};
    for (const [path, gateId] of Object.entries(migrationGates(plan.migration, target.flowJoSampleId))) {
      const members = population(view, plan.ws, gateId);
      out[path] = members === undefined ? null : countOf(members, view);
    }
    counts[target.sampleId] = out;
  }
  return { rows: migrationCountRows(plan.migration, counts), matched: plan.migration.samples.filter((s) => s.sampleId).length, total: result.samples.length };
}

// The PBMC example: its FMO tube (every dye but CD25), its rainbow beads (calibrated with their
// datasheet, against each detector's true response) and its second day (gains changed for the
// whole batch).
export function pbmcAdditions(scale = 0.3) {
  const g = generateExample('pbmc-immunophenotyping', { scale });
  const file = (name) => g.files.find((f) => f.name === name);
  const fmo = file('FMO_CD25.fcs');
  const stained = file('D01_Unstim.fcs');
  // The FMO's CD25 detector after compensation: the 99th percentile of live lymphocytes' signal,
  // against the stained sample's (where activated and regulatory T cells are CD25+).
  const p99 = (f) => {
    const d = parseFCS(f.bytes).datasets[0];
    const raw = columnsOf(d);
    const comp = compensate(raw, readSpillover(d.keywords, d.parameters));
    const { labels, names } = f.meta.truth;
    const values = [];
    for (let e = 0; e < d.eventCount; e += 1) if (labels[e] >= 0 && / T$|NK$| B$|lymphoid/.test(names[labels[e]])) values.push(comp['PE-A'][e]);
    values.sort((a, b) => a - b);
    return values[Math.floor(0.99 * (values.length - 1))];
  };
  const beads = file('Beads_8peak.fcs');
  const sheet = g.workspaceHints.beadDatasheets['Beads_8peak.fcs'];
  const d = parseFCS(beads.bytes).datasets[0];
  const columns = columnsOf(d);
  const channels = Object.keys(sheet.values);
  const bounds = Object.fromEntries(channels.map((c) => {
    const p = d.parameters.find((x) => x.name === c);
    return [c, channelBounds(d.keywords, p.index, p.range)];
  }));
  const result = calibrateBeads(columns, { channels, values: sheet.values, clustering: channels, scatter: ['FSC-A', 'SSC-A'], bounds, unit: sheet.units });
  // The truth: a signal s in a channel is s / response brightness units, each worth the datasheet's
  // MEF per unit.
  const response = beads.meta.truth.response;
  const calibration = channels.map((c) => {
    const fit = result.channels[c].fit;
    const curve = standardCurve(fit);
    const perUnit = sheet.values[c][sheet.values[c].length - 1] / 7.5;
    const signal = 20000;
    return { channel: c, slope: fit.m, error: curve(signal) / ((signal / response[c]) * perUnit) - 1 };
  });
  const batches = Object.fromEntries(['D01_Unstim.fcs', 'D04_Unstim.fcs', 'D06_Stim.fcs'].map((name) => [name, { batch: file(name).meta.batch, gains: file(name).meta.truth.gains ?? null }]));
  return { files: g.files.length, fmo: { role: fmo.meta.role, p99: p99(fmo), stainedP99: p99(stained) }, beads: { role: beads.meta.role, lot: sheet.lot }, calibration, batches, annotations: g.attachments.find((a) => a.kind === 'annotations')?.text ?? '' };
}

// The absolute-count example: each patient's CD4 T cells per µL from the example's own gates,
// against the truth.
export function absoluteCounts() {
  const g = generateExample('absolute-counts', {});
  const { ws: base, datasets } = workspaceOf(g.files);
  const ws = addGates(base, g.workspaceHints.suggestedGates.map((x) => ({ ...x, overrides: {} })), 'examples').ws;
  return ws.samples.map((record) => {
    const view = viewOf(record, datasets.get(record.id));
    const count = (name) => countOf(population(view, ws, ws.gates.find((x) => x.name === name).id), view);
    const patient = record.name.split('_')[0];
    const perUL = (count('CD4 T cells') / count('Counting beads')) * (COUNTING.beadsPerTube / COUNTING.volume);
    return { patient, perUL, truth: COUNT_PATIENTS[patient]['CD4 T'], beads: count('Counting beads') };
  });
}

// The files that come with the examples, read by CytoWeave's importers.
export async function attachments(scale = 0.3) {
  const sort = generateExample('index-sort', { scale });
  const diva = sort.attachments.find((a) => a.kind === 'diva');
  const divaResult = importDiva(diva.text);
  const presort = parseFCS(sort.files.find((f) => f.name === 'Presort.fcs').bytes).datasets[0];

  const flowjo = generateExample('flowjo-workspace', { scale });
  const fj11 = flowjo.attachments.find((a) => a.kind === 'flowjo11');
  const workbench = await createZip(fj11.zip.map((e) => ({ name: e.name, data: e.text })));
  const fj11Result = await importFlowJo11(workbench);

  const spectral = generateExample('spectral-25color', { scale: 0.05 });
  const expt = spectral.attachments.find((a) => a.kind === 'spectroflo');
  const exptResult = importSpectroFlo(expt.text, { detectors: spectral.workspaceHints.spectral.detectors });
  const { ws: spectralWs } = workspaceOf(spectral.files);
  const plan = planSpectroFloControls(exptResult, spectralWs.samples);

  const cycle = generateExample('cell-cycle', { scale });
  const csv = cycle.attachments.find((a) => a.kind === 'events');
  const analysis = analyzeCSV(csv.text, csv.name);
  const { datasets } = csvDatasets(analysis);

  const pbmc = generateExample('pbmc-immunophenotyping', { scale: 0.02 });
  const table = pbmc.attachments.find((a) => a.kind === 'annotations').text.trim().split('\n').map((line) => line.split(','));
  const stained = pbmc.files.filter((f) => f.meta.role === 'sample' || f.meta.role === 'fmo').map((f) => f.name.replace(/\.fcs$/, ''));
  return {
    diva: { ...migrated(divaResult, sort.files), warnings: divaResult.warnings },
    repair: presort.diagnostics.map((x) => x.code),
    flowjo11: { ...migrated(fj11Result, flowjo.files), warnings: fj11Result.warnings },
    spectroflo: { references: exptResult.references.length, matched: plan.filter((r) => r.sample).length, rows: plan.length, gatedOnPeak: exptResult.references.filter((r) => r.gatedDetector === spectral.workspaceHints.spectral.fluorochromes.find((x) => x.name === r.fluorochrome)?.peakDetector).length },
    csv: { events: looksLikeEvents(csv.text), datasets: datasets.length, eventCount: datasets[0]?.rows ?? 0, expected: csv.text.trim().split('\n').length - 1, channels: datasets[0]?.parameters.map((p) => p.name) ?? [] },
    annotations: { header: table[0], rows: table.length - 1, covers: stained.every((name) => table.some((row) => row[0] === name)) },
  };
}

// The spectral day-2 example: the doctor's findings on each donor, with day 1's references as the
// library, and today's controls compared with that library.
export function spectralDayTwo(scale = 0.5) {
  const experiment = (id) => {
    const { files, workspaceHints } = generateExample(id, { scale });
    const detectors = workspaceHints.spectral.detectors;
    const read = (file) => {
      const cols = columnsOf(parseFCS(file.bytes).datasets[0]);
      return { cols: detectors.map((n) => cols[n]), fsc: cols['FSC-A'], ssc: cols['SSC-A'] };
    };
    const refs = files.filter((f) => f.meta.role === 'single-stain').map((f) => {
      const { cols } = read(f);
      const gate = autoGateControl(cols, detectors, {});
      return { name: f.meta.stain, spectrum: referenceSpectrum(cols, detectors, gate.positive, gate.negative, {}).spectrum, carrier: /bead/.test(f.meta.carrier) ? 'beads' : 'cells' };
    });
    const unstained = read(files.find((f) => f.meta.role === 'unstained'));
    return { files, detectors, refs, unstained, af: extractAutofluorescence(unstained.cols, detectors, {}).signatures, read };
  };
  const day1 = experiment('spectral-25color');
  const day2 = experiment('spectral-troubleshooting');
  const library = day1.refs.map((r) => libraryEntry({ fluorochrome: r.name, spectrum: r.spectrum, detectors: day1.detectors, date: '2026-05-04', file: `Ref_${r.name}.fcs`, sha256: `day1-${r.name}`, carrier: r.carrier }));
  const donors = day2.files.filter((f) => f.meta.role === 'sample').map((file) => {
    const sample = day2.read(file);
    const r = diagnoseUnmixing(sample.cols, { detectors: day2.detectors, spectra: day2.refs, afSignatures: day2.af }, { references: day2.refs, library, unstainedAF: day2.af, unstained: { columns: day2.unstained.cols }, scatter: { sample: { fsc: sample.fsc, ssc: sample.ssc }, unstained: { fsc: day2.unstained.fsc, ssc: day2.unstained.ssc } } });
    return { donor: file.name, findings: r.findings.filter((f) => f.severity !== 'low').map((f) => `${f.kind}:${f.subject}`) };
  });
  const changed = compareWithLibrary(day2.refs, { entries: library }, day2.detectors).filter((c) => c.status === 'changed').map((c) => c.name);
  return { donors, changed };
}
