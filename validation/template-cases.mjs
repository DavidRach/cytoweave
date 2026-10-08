// Template validation cases (the `templates` suite of run.mjs). An analysis built on the PBMC
// example (the suggested gates, then CD4/CD8, memory and Treg quadrants and polygons, B and NK
// cells, a Boolean population, plots, a table and a gating-strategy figure) is saved as a
// template and applied to the same events written as another instrument would write them: other
// detector names, the parameters in another order, the markers kept in $PnS. Every population
// must then hold the same events.

import { generateExample } from '../web/lib/examples.js';
import { parseFCS, readSpillover, writeFCS } from '../web/lib/fcs.js';
import { SampleView, countOf, population } from '../web/lib/engine.js';
import { createTransform } from '../web/lib/transforms.js';
import { quadrantGates, quadrantNames, newId } from '../web/lib/gates.js';
import { ROOT, addGates, addSamples, createWorkspace, gatePath, sampleFromDataset, setBooleanGate } from '../web/lib/workspace.js';
import { gatingStrategyFigure } from '../web/lib/figures.js';

const LOGICLE = { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 };
const fwd = (v) => createTransform(LOGICLE).forward(v);

// A workspace of PBMC samples (D0…), each with its file's compensation. files: [{ name, bytes }].
export function loadSamples(files, name) {
  let ws = createWorkspace(name);
  const views = new Map();
  for (const file of files) {
    const d = parseFCS(file.bytes).datasets[0];
    const record = { ...sampleFromDataset(d, { name: file.name }), compensationId: 'file' };
    ws = addSamples(ws, [record]);
    const spill = readSpillover(d.keywords, d.parameters);
    const view = new SampleView(record, d);
    view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
    views.set(record.id, view);
  }
  return { ws, views };
}

// The PBMC example's stained samples, all acquired on one day (as these cases were built on, before
// the example's donors D04–D06 moved to a second day with other detector settings).
export function pbmcFiles(scale = 0.1) {
  const { files, workspaceHints } = generateExample('pbmc-immunophenotyping', { scale, secondBatch: null });
  return { files: files.filter((f) => /^D0/.test(f.name)), suggested: workspaceHints.suggestedGates };
}

// The hand-built analysis on the original panel.
export function sourceAnalysis({ files, suggested }) {
  let { ws, views } = loadSamples(files, 'PBMC analysis');
  ws = addGates(ws, suggested).ws;
  const id = (name) => ws.gates.find((g) => g.name === name).id;
  const dim = (channel) => ({ channel, transform: { ...LOGICLE } });
  const t = id('T cells');
  ws = addGates(ws, quadrantGates({ parentId: t, dims: [dim('Alexa Fluor 700-A'), dim('APC-A')], center: [fwd(1500), fwd(1500)], names: quadrantNames('CD4', 'CD8') })).ws;
  const cd4 = ws.gates.find((g) => g.name === 'CD4+ CD8−').id;
  ws = addGates(ws, quadrantGates({ parentId: cd4, dims: [dim('BUV395-A'), dim('BV421-A')], center: [fwd(800), fwd(600)], names: quadrantNames('CD45RA', 'CCR7') })).ws;
  ws = addGates(ws, [{ id: newId('g'), name: 'Tregs', parentId: cd4, type: 'polygon', dims: [dim('PE-A'), dim('PE-Cy7-A')], geometry: { vertices: [[fwd(1200), fwd(-200)], [fwd(60000), fwd(-200)], [fwd(60000), fwd(900)], [fwd(1200), fwd(900)]] } }]).ws;
  const lymph = id('Lymphocytes');
  ws = addGates(ws, [
    { id: newId('g'), name: 'B cells', parentId: lymph, type: 'range', dims: [dim('BV711-A')], geometry: { min: fwd(1500), max: null } },
    { id: newId('g'), name: 'NK cells', parentId: lymph, type: 'rectangle', dims: [dim('BV605-A'), dim('BUV737-A')], geometry: { min: [null, fwd(1500)], max: [fwd(2000), null] } },
    { id: newId('g'), name: 'CD14+ monocytes', parentId: id('Monocytes'), type: 'range', dims: [dim('PerCP-Cy5-5-A')], geometry: { min: fwd(1000), max: null } },
  ]).ws;
  ws = setBooleanGate(ws, { op: 'or', operands: [ws.gates.find((g) => g.name === 'B cells').id, ws.gates.find((g) => g.name === 'NK cells').id], parentId: lymph, name: 'B or NK' }).ws;
  ws = { ...ws, plots: [
    { id: newId('p'), populationId: t, x: 'Alexa Fluor 700-A', y: 'APC-A', type: 'pseudocolor', options: {} },
    { id: newId('p'), populationId: cd4, x: 'BUV395-A', y: 'BV421-A', type: 'contour', options: {} },
  ], tables: [{ id: newId('t'), name: 'Frequencies', heatmap: true, columns: ws.gates.filter((g) => g.type !== 'boolean').map((g) => ({ id: newId('col'), gateId: g.id, stat: 'freqParent' })).concat([{ id: newId('col'), gateId: t, stat: 'median', channel: 'PE-A' }]) }] };
  ws = { ...ws, figures: [gatingStrategyFigure(ws, ws.gates.find((g) => g.name === 'Tregs').id, ws.samples[0].id)] };
  return { ws, views };
}

// The same events as another instrument writes them: fluorescence detectors renamed FL1-A, FL2-A, …
// in a shuffled order (the markers kept in $PnS), the spillover keyword renamed to match, and
// optionally some markers' names left out of $PnS (the channels stay, so compensation does not
// change).
export function asOtherInstrument(files, { unlabel = [] } = {}) {
  return files.map((file) => {
    const d = parseFCS(file.bytes).datasets[0];
    const fluor = d.parameters.filter((p) => p.type === 'fluorescence');
    const order = [...fluor].sort((a, b) => (a.marker < b.marker ? 1 : -1));
    const rename = new Map(order.map((p, i) => [p.name, `FL${i + 1}-A`]));
    const kept = [...d.parameters.filter((p) => p.type !== 'fluorescence').reverse(), ...order];
    const spill = readSpillover(d.keywords, d.parameters);
    const keepSpill = spill.channels.map((c, i) => [c, i]).filter(([c]) => kept.some((p) => p.name === c));
    const n = keepSpill.length;
    const values = [];
    for (const [, i] of keepSpill) for (const [, j] of keepSpill) values.push(spill.matrix[i * spill.n + j]);
    const keywords = Object.fromEntries(Object.entries(d.keywords).filter(([k]) => !/^\$P\d+|^\$?SPILL|^\$SPILLOVER$|^\$COMP$/i.test(k)));
    keywords.$SPILLOVER = [n, ...keepSpill.map(([c]) => rename.get(c) ?? c), ...values].join(',');
    const bytes = writeFCS({ parameters: kept.map((p) => ({ name: rename.get(p.name) ?? p.name, label: unlabel.includes(p.marker) ? '' : p.label, range: p.range })), data: kept.map((p) => d.data[p.index]), keywords });
    return { name: file.name, bytes };
  });
}

// Each population's events per sample: Map(path → Map(sample name → count)).
export function countsOf(ws, views) {
  const out = new Map();
  for (const gate of ws.gates) {
    const counts = new Map();
    for (const sample of ws.samples) {
      const members = population(views.get(sample.id), ws, gate.id);
      counts.set(sample.name, members === undefined ? null : countOf(members, views.get(sample.id)));
    }
    out.set(gatePath(ws, gate.id), counts);
  }
  return out;
}

export { ROOT };
