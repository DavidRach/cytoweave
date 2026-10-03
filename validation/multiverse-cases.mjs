// Cohorts for validating counterfactual preprocessing (web/lib/multiverse.js): the PBMC example
// (six donors, unstimulated and stimulated) with added gates and with artefacts whose effect on a
// comparison is known — a detector gain in one batch, clogs in one group, one batch compensated
// with the wrong matrix — and helpers to run a comparison under every specification.

import { channelTransform, population } from '../web/lib/engine.js';
import { addGates, updateGate } from '../web/lib/workspace.js';
import { createTransform } from '../web/lib/transforms.js';
import { flowRateCheck, peacoQC } from '../web/lib/qc.js';
import { adaptPath, choicesFor, pathGates, runMultiverse, specifications, summarize } from '../web/lib/multiverse.js';

const drawnOn = (ws, sampleId) => {
  let next = ws;
  for (const g of next.gates) next = updateGate(next, g.id, { meta: { ...(g.meta ?? {}), drawnOn: sampleId } });
  return next;
};

// A CD25+ gate under T cells, above quantile q of CD25 on a reference sample's T cells (0.9 cuts
// into the CD25-dim tail, as a gate drawn close to the negative cells does).
export function withCD25(ws, views, reference, q = 0.97) {
  const t = ws.gates.find((g) => g.name === 'T cells');
  const ref = ws.samples.find((s) => s.name === reference);
  const view = views.get(ref.id);
  const transform = channelTransform(ws, view, 'PE-A');
  const f = createTransform(transform).forward;
  const col = view.column('PE-A');
  const values = Float64Array.from(population(view, ws, t.id), (e) => f(col[e])).sort();
  const cut = values[Math.floor(q * values.length)];
  return drawnOn(addGates(ws, [{ name: 'CD25+', type: 'range', dims: [{ channel: 'PE-A', transform }], geometry: { min: cut, max: 1.2 }, parentId: t.id }]).ws, ref.id);
}

// A CD4+CD8+ gate under T cells: above the CD8 of most T cells and the CD4 of CD8+ cells, on a
// reference sample.
export function withDoublePositive(ws, views, reference) {
  const t = ws.gates.find((g) => g.name === 'T cells');
  const ref = ws.samples.find((s) => s.name === reference);
  const view = views.get(ref.id);
  const tf = (channel) => channelTransform(ws, view, channel);
  const f4 = createTransform(tf('Alexa Fluor 700-A')).forward;
  const f8 = createTransform(tf('APC-A')).forward;
  const c4 = view.column('Alexa Fluor 700-A');
  const c8 = view.column('APC-A');
  const events = Array.from(population(view, ws, t.id));
  const y = events.map((e) => f8(c8[e])).sort((a, b) => a - b);
  const y8 = y[Math.floor(0.75 * y.length)];
  const x = events.filter((e) => f8(c8[e]) > y8).map((e) => f4(c4[e])).sort((a, b) => a - b);
  const x4 = x[Math.floor(0.98 * x.length)];
  return drawnOn(addGates(ws, [{ name: 'CD4+CD8+', type: 'rectangle', dims: [{ channel: 'Alexa Fluor 700-A', transform: tf('Alexa Fluor 700-A') }, { channel: 'APC-A', transform: tf('APC-A') }], geometry: { min: [x4, y8], max: [1.2, 1.2] }, parentId: t.id }]).ws, ref.id);
}

// Acquisition QC of every sample (refined PeacoQC and the flow-rate check), as the QC view runs
// it: Map sample id → 0/1 mask.
export function qcMasks(ws, views, peacoOptions = {}) {
  const masks = new Map();
  for (const s of ws.samples) {
    const view = views.get(s.id);
    const signal = view.parameters.filter((p) => p.type === 'scatter' || p.type === 'fluorescence').map((p) => p.name);
    const time = view.parameters.find((p) => p.type === 'time');
    const columns = Object.fromEntries([...signal, time.name].map((n) => [n, view.column(n)]));
    const sample = { eventCount: view.eventCount, channels: view.parameters.filter((p) => columns[p.name]).map((p) => ({ name: p.name, type: p.type, range: p.range })), columns, keywords: view.dataset.keywords };
    const transforms = Object.fromEntries(signal.map((n) => [n, channelTransform(ws, view, n)]));
    const pq = peacoQC(sample, { channels: signal, transforms, ...peacoOptions });
    const fr = flowRateCheck(sample, { timestep: Number(view.dataset.keywords.$TIMESTEP) });
    const mask = new Float32Array(view.eventCount);
    for (let e = 0; e < mask.length; e += 1) mask[e] = pq.mask[e] && fr.mask[e] ? 1 : 0;
    masks.set(s.id, mask);
  }
  return masks;
}

// Masks as a derived channel of every view.
export function setChannel(views, masks, channel) {
  for (const [id, mask] of masks) views.get(id).setDerived(channel, mask);
}

// The "QC pass" gate at the top of the tree, every other top gate beneath it.
export function withQCGate(ws) {
  const tops = new Set(ws.gates.filter((g) => !g.parentId).map((g) => g.id));
  const next = addGates(ws, [{ id: 'qc-pass', name: 'QC pass', type: 'category', dims: [{ channel: 'QC pass' }], geometry: { values: [1] }, parentId: null }]).ws;
  return { ...next, gates: next.gates.map((g) => (tops.has(g.id) ? { ...g, parentId: 'qc-pass' } : g)) };
}

// A comparison under every specification: { summary, results, choices, adapted }. options:
// { compensations, setCompensation, qcVariants, max }.
export function multiverseOf({ ws, views }, samples, design, gateName, options = {}) {
  const gate = ws.gates.find((g) => g.name === gateName);
  const statistic = { stat: 'freqParent', gateId: gate.id };
  const adapted = adaptPath(ws, pathGates(ws, gate.id, gate.parentId), views);
  const counts = design === 'paired-two' ? [new Set(samples.map((s) => s.pair)).size] : [samples.filter((s) => s.group === 0).length, samples.filter((s) => s.group === 1).length];
  const choices = choicesFor({ ws, gateId: gate.id, ancestorId: gate.parentId, design, adapted, counts, compensations: options.compensations, qcVariants: options.qcVariants });
  const specs = specifications(choices, { max: options.max ?? 64 });
  const results = runMultiverse({ ws, views, samples, design, statistic, choices, specs, gateId: gate.id, ancestorId: gate.parentId, adapted, setCompensation: options.setCompensation });
  return { summary: summarize(results, choices), results, choices, adapted };
}

export const byDonor = (ws, filter = () => true) => ws.samples.filter((s) => filter(s.name)).map((s) => ({ id: s.id, group: /_Stim/.test(s.name) ? 1 : 0, pair: s.name.slice(0, 3) }));
