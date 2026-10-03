// Cohorts for validating autogating (web/lib/adapt.js, autogating.js): the PBMC example with
// instrument-like shifts applied to each sample (per-detector gains, as a voltage change gives,
// with the spillover matrix following them, and a scatter gain), so the template gates no longer
// fit, while the true cell type of every event stays known; and real workspaces whose expert
// adjusted the gates per donor (below).

import { generateExample } from '../web/lib/examples.js';
import { parseFCS, readSpillover } from '../web/lib/fcs.js';
import { SampleView, population } from '../web/lib/engine.js';
import { createWorkspace, addGates, addSamples, sampleFromDataset, setGateGeometry, effectiveGeometry, updateGate } from '../web/lib/workspace.js';
import { adaptAcrossSamples } from '../web/lib/autogating.js';
import { indexList } from '../web/lib/adapt.js';
import { translateGeometry } from '../web/lib/gates.js';
import { createRandom } from '../web/lib/random.js';
import { importWithFiles } from './flowjo-export-cases.mjs';

export const TRUTH = {
  Cells: (n) => n !== 'Debris',
  'Single cells': (n) => n !== 'Debris' && n !== 'Doublets',
  Live: (n) => !['Debris', 'Doublets', 'Dead cells'].includes(n),
  Lymphocytes: (n) => /( T|T$|NK| B|^B|Plasmablast|Other lymphoid|Gamma-delta)/.test(n) && !/monocyte|DC|Basophil|Neutrophil/i.test(n),
  Monocytes: (n) => /monocyte/i.test(n),
  'T cells': (n) => / T$|T cells?$|Regulatory T|Gamma-delta T|TEMRA/.test(n),
};
export const ORDER = ['Cells', 'Single cells', 'Live', 'Lymphocytes', 'Monocytes', 'T cells'];

// shift(name, parameter) → gain, or null for none; modify(name, dataset), when given, may change
// a sample's events before its view is made (an injected clog). Returns { ws, views, truth }.
export function buildCohort({ scale = 0.25, gainOf, modify = null, staleSpill = false, example = {} }) {
  const { files, workspaceHints } = generateExample('pbmc-immunophenotyping', { scale, ...example });
  let ws = createWorkspace('autogating validation');
  const views = new Map();
  const truth = new Map();
  for (const file of files.filter((f) => /^D0/.test(f.name))) {
    const d = parseFCS(file.bytes).datasets[0];
    const record = sampleFromDataset(d, { name: file.name });
    ws = addSamples(ws, [record]);
    const spill = readSpillover(d.keywords, d.parameters);
    const gains = new Map(d.parameters.map((p) => [p.name, gainOf(record.name, p) ?? 1]));
    for (const p of d.parameters) {
      const g = gains.get(p.name);
      if (g !== 1) { const col = d.data[p.index]; for (let e = 0; e < col.length; e += 1) col[e] *= g; }
    }
    modify?.(record.name, d);
    const n = spill.channels.length;
    const matrix = Array.from(spill.matrix);
    // The matrix follows the gains, as one recomputed from controls at the new voltages would;
    // with staleSpill, the samples keep the matrix of the original voltages.
    if (!staleSpill) for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) matrix[i * n + j] *= gains.get(spill.channels[j]) / gains.get(spill.channels[i]);
    const view = new SampleView(record, d);
    view.setCompensation({ id: 'file', channels: spill.channels, matrix });
    views.set(record.id, view);
    truth.set(record.id, file.meta.truth);
  }
  ws = addGates(ws, workspaceHints.suggestedGates).ws;
  return { ws, views, truth };
}

// Random gains per sample and detector (the reference sample is left as it is).
export function randomGains(strength, seed, reference = 'D01_Unstim') {
  const random = createRandom(seed);
  const cache = new Map();
  return (sample, p) => {
    if (sample === reference) return null;
    const key = `${sample}|${p.type === 'scatter' ? 'scatter' : p.name}`;
    if (!cache.has(key)) {
      if (p.type === 'fluorescence') cache.set(key, Math.exp((random() * 2 - 1) * strength));
      else if (p.type === 'scatter') cache.set(key, Math.exp((random() * 2 - 1) * strength * 0.25));
      else cache.set(key, null);
    }
    return cache.get(key);
  };
}

export function f1(ws, views, truth, gateId, sampleId, isMember) {
  const view = views.get(sampleId);
  const { labels, names } = truth.get(sampleId);
  const inGate = new Uint8Array(view.eventCount);
  for (const e of indexList(population(view, ws, gateId), view.eventCount)) inGate[e] = 1;
  let tp = 0; let fp = 0; let fn = 0;
  for (let e = 0; e < view.eventCount; e += 1) {
    const t = labels[e] >= 0 && isMember(names[labels[e]]);
    if (inGate[e] && t) tp += 1; else if (inGate[e]) fp += 1; else if (t) fn += 1;
  }
  return (2 * tp) / (2 * tp + fp + fn);
}

// Adapts the gates top-down (each with its parents adapted first), applying confident
// adjustments as the user would accept them. Returns { adapted, rows: [{ gate, sampleId, status,
// confidence, before, after, result }] }.
// With `reviewer`, each sample sent to review is corrected as an expert would (expertCorrection)
// before the gates below it are adapted, as in the review queue's workflow.
export function adaptTopDown(ws, views, truth, { reference, names = ORDER, reviewer = false } = {}) {
  let adapted = ws;
  const runs = [];
  const reviewed = new Map(); // gateId → Set of samples sent to review
  for (const name of names) {
    let gate = adapted.gates.find((g) => g.name === name);
    if (reference && !gate.meta?.drawnOn) {
      adapted = updateGate(adapted, gate.id, { meta: { ...(gate.meta ?? {}), drawnOn: reference } });
      gate = adapted.gates.find((g) => g.id === gate.id);
    }
    // Samples where an ancestor went to review stay in review here too.
    const underReview = new Map();
    let ancestor = adapted.gates.find((g) => g.id === gate.parentId);
    while (ancestor) {
      for (const id of reviewed.get(ancestor.id) ?? []) if (!underReview.has(id)) underReview.set(id, ancestor.name);
      ancestor = adapted.gates.find((g) => g.id === ancestor.parentId);
    }
    const run = adaptAcrossSamples(adapted, gate.id, views, { underReview });
    runs.push({ name, gateId: gate.id, run });
    for (const r of run.results) if (r.status === 'adjust') adapted = setGateGeometry(adapted, gate.id, r.geometry, { sampleId: r.sampleId });
    const flagged = run.results.filter((r) => r.status === 'review').map((r) => r.sampleId);
    if (reviewer) {
      for (const sampleId of flagged) adapted = setGateGeometry(adapted, gate.id, expertCorrection(adapted, views, truth, name, sampleId).geometry, { sampleId });
      reviewed.set(gate.id, new Set());
    } else {
      reviewed.set(gate.id, new Set(flagged));
    }
  }
  const rows = [];
  for (const { name, gateId, run } of runs) {
    for (const r of run.results) {
      rows.push({ gate: name, sampleId: r.sampleId, status: r.status, confidence: r.confidence, result: r, before: f1(ws, views, truth, gateId, r.sampleId, TRUTH[name]), after: f1(adapted, views, truth, gateId, r.sampleId, TRUTH[name]) });
    }
  }
  return { adapted, rows, runs };
}

// The adjustment an expert would make: the translation of the gate that best matches the truth
// (a grid search over drags of up to 0.14 of each axis, in steps of 0.02), for the sample.
export function expertCorrection(ws, views, truth, gateName, sampleId) {
  const gate = ws.gates.find((g) => g.name === gateName);
  const base = effectiveGeometry(gate, sampleId);
  let best = { score: -1, geometry: base };
  for (let dx = -0.14; dx <= 0.1401; dx += 0.02) {
    for (let dy = -0.14; dy <= 0.1401; dy += 0.02) {
      const geometry = translateGeometry(gate.type, base, dx, gate.dims.length > 1 ? dy : 0);
      const trial = setGateGeometry(ws, gate.id, geometry, { sampleId });
      const score = f1(trial, views, truth, gate.id, sampleId, TRUTH[gateName]);
      if (score > best.score) best = { score, geometry };
      if (gate.dims.length === 1) break;
    }
  }
  return best;
}

// --- Experts' own per-sample gates ----------------------------------------------------------------
// External data (als-ics): FlowJo workspaces of an intracellular cytokine study, 12 wells each —
// four donors, each in a negative, a peptide and a PMA/ionomycin well — whose expert adjusted the
// gates per donor.

export const EXPERT_GATES = ['Lymphocytes', 'Single Cells 1', 'Single Cells 2', 'Comp-LIVE_DEAD Aqua-A, SSC-A subset', 'CD3', 'CD4 Single Positive', 'CD8 Single Positive'];
const WELLS = ['negative', 'peptide', 'PMA'];

// Imports one workspace (read(name) → bytes or text of its files) with its 12 wells; each
// sample's metadata records its donor and well. Returns { ws, views, rows } (rows: FlowJo's counts
// beside CytoWeave's).
export function expertWorkspace(read, workspace) {
  const names = Array.from({ length: 12 }, (_, i) => `Specimen_001_C${i + 1}_C${String(i + 1).padStart(2, '0')}.fcs`);
  const files = names.map((name) => ({ name, bytes: new Uint8Array(read(name)) }));
  const imported = importWithFiles(new TextDecoder().decode(read(workspace)), files);
  const samples = imported.ws.samples.map((s) => {
    const well = Number(/_C(\d+)_/.exec(s.name)[1]) - 1;
    return { ...s, meta: { ...s.meta, donor: `donor ${Math.floor(well / 3) + 1}`, well: WELLS[well % 3] } };
  });
  return { ws: { ...imported.ws, samples }, views: imported.views, rows: imported.rows };
}

function agreement(ws, other, views, gateId, sampleId) {
  const view = views.get(sampleId);
  const a = new Uint8Array(view.eventCount);
  for (const e of indexList(population(view, ws, gateId), view.eventCount)) a[e] = 1;
  let tp = 0; let fp = 0; let fn = 0;
  for (const e of indexList(population(view, other, gateId), view.eventCount)) {
    if (a[e]) { tp += 1; a[e] = 2; } else fp += 1;
  }
  for (let e = 0; e < a.length; e += 1) if (a[e] === 1) fn += 1;
  return tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : 1;
}

// Each version of each gate the expert drew is used in turn as the shared gate (drawn on the
// first sample it was used on, the other samples' adjustments removed) and adapted to the other
// wells, the ancestors staying as the expert drew them. Returns rows: { gate, template (sample
// name), sample, status, confidence, before, after } with F1 of the well's population against the
// expert's own, for the template and for the adaptation as applied (confident adjustments only).
export function againstExperts(ws, views, { groupBy, gates = EXPERT_GATES } = {}) {
  const rows = [];
  const name = (id) => ws.samples.find((s) => s.id === id).name;
  for (const gateName of gates) {
    const gate = ws.gates.find((g) => g.name === gateName);
    const versions = new Map();
    for (const s of ws.samples) {
      const key = JSON.stringify(effectiveGeometry(gate, s.id));
      if (!versions.has(key)) versions.set(key, s.id);
    }
    for (const reference of versions.values()) {
      let template = setGateGeometry(ws, gate.id, effectiveGeometry(gate, reference));
      template = updateGate(template, gate.id, { overrides: {}, meta: { ...gate.meta, drawnOn: reference } });
      const run = adaptAcrossSamples(template, gate.id, views, { groupBy });
      let adapted = template;
      for (const r of run.results) if (r.status === 'adjust') adapted = setGateGeometry(adapted, gate.id, r.geometry, { sampleId: r.sampleId });
      for (const r of run.results) {
        rows.push({ gate: gateName, template: name(reference), sample: name(r.sampleId), status: r.status, confidence: r.confidence, before: agreement(ws, template, views, gate.id, r.sampleId), after: agreement(ws, adapted, views, gate.id, r.sampleId) });
      }
    }
  }
  return rows;
}
