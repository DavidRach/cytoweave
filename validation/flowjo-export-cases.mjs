// The FlowJo export cases of the validation suite, shared by validation/run.mjs and
// validation/reference/write_flowjo_exports.mjs (which writes the exported workspaces for FlowKit
// to evaluate). Each case: a CytoWeave workspace, exported as a FlowJo workspace with CytoWeave's
// own counts in it, and imported back with every population recomputed.
//   - "flowjo": a FlowJo workspace (the bundled example, FlowKit's test workspaces) imported into
//     CytoWeave, then exported;
//   - "cytoweave": a workspace built in CytoWeave with gates FlowJo has no direct equivalent for
//     (splits, quadrants on mixed scales, Booleans, per-sample overrides, group scopes, gates
//     drawn on another scale, a category gate).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateExample } from '../web/lib/examples.js';
import { parseFCS, readSpillover } from '../web/lib/fcs.js';
import { SampleView, countOf, population } from '../web/lib/engine.js';
import { importFlowJo } from '../web/lib/flowjo.js';
import { buildFlowJoMigration, matchFlowJoSamples, migrationCountRows, migrationGates } from '../web/lib/flowjo-match.js';
import { createWorkspace, addGates, addGroup, addSamples, sampleFromDataset, updateGate } from '../web/lib/workspace.js';
import { exportFlowJo } from '../web/lib/flowjo-export.js';

const CACHE = new URL('./cache/', import.meta.url).pathname;

// The FlowKit test workspaces, by their path in the "flowkit" data set, and their FCS folders.
export const FLOWKIT_WORKSPACES = [
  ['8_color_data_set/8_color_ICS.wsp', '8_color_data_set/fcs_files'],
  ['8_color_data_set/8_color_ICS_simple.wsp', '8_color_data_set/fcs_files'],
  ['8_color_data_set/8_color_ICS_with_ellipse.wsp', '8_color_data_set/fcs_files'],
  ['8_color_data_set/8_color_ICS_boolean_gate_testing.wsp', '8_color_data_set/fcs_files'],
  ['8_color_data_set/reused_quad_gate_with_child.wsp', '8_color_data_set/fcs_files'],
  ['simple_diamond_example/simple_diamond_example_quad_gate.wsp', 'simple_diamond_example'],
  ['simple_diamond_example/test_data_diamond_biex_rect.wsp', 'simple_diamond_example'],
  ['simple_diamond_example/test_data_diamond_asinh_rect.wsp', 'simple_diamond_example'],
  ['simple_line_example/simple_poly_and_rect.wsp', 'simple_line_example'],
  ['simple_line_example/single_ellipse_51_events.wsp', 'simple_line_example'],
];

function viewOf(record, data, ws) {
  const view = new SampleView(record, data);
  const id = record.compensationId ?? 'none';
  if (id === 'file') {
    const spill = readSpillover(data.keywords, data.parameters);
    if (spill && !spill.identity) view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
  } else if (id !== 'none') {
    const comp = ws.compensations.find((c) => c.id === id);
    view.setCompensation({ id: comp.id, channels: comp.channels, matrix: comp.matrix });
  }
  return view;
}

function newWorkspace(files) {
  let ws = createWorkspace('validation');
  const datasets = new Map();
  for (const file of files) {
    const data = parseFCS(file.bytes).datasets[0];
    const record = sampleFromDataset(data, { name: file.name });
    datasets.set(record.id, data);
    ws = addSamples(ws, [record]);
  }
  return { ws, datasets };
}

// Imports FlowJo XML with the files: the CytoWeave workspace, and rows comparing the counts in the
// XML with CytoWeave's recomputed ones.
export function importWithFiles(xml, files) {
  const result = importFlowJo(xml);
  const start = newWorkspace(files);
  const plan = buildFlowJoMigration(start.ws, result, matchFlowJoSamples(result.samples, start.ws.samples), { scales: true, compensation: true });
  const { ws } = plan;
  const views = new Map(ws.samples.map((s) => [s.id, viewOf(s, start.datasets.get(s.id), ws)]));
  const counts = {};
  for (const target of plan.migration.samples) {
    if (!target.sampleId) continue;
    const view = views.get(target.sampleId);
    counts[target.sampleId] = Object.fromEntries(Object.entries(migrationGates(plan.migration, target.flowJoSampleId)).map(([path, gateId]) => {
      const members = population(view, ws, gateId);
      return [path, members === undefined ? null : countOf(members, view)];
    }));
  }
  return { ws, views, result, rows: migrationCountRows(plan.migration, counts) };
}

const countsFor = (ws, views) => (sample) => {
  const view = views.get(sample.id);
  const out = new Map();
  for (const gate of ws.gates) {
    const members = population(view, ws, gate.id);
    if (members !== undefined) out.set(gate.id, countOf(members, view));
  }
  return out;
};

// Exports a workspace with its counts and imports the export back.
function exportAndBack(name, kind, ws, views, files, extra = {}) {
  const { xml, report } = exportFlowJo(ws, { counts: countsFor(ws, views), version: 'validation' });
  const back = importWithFiles(xml, files);
  const ellipses = ws.gates.filter((g) => g.type === 'ellipse').map((g) => g.name);
  return { name, kind, xml, report, files, rows: back.rows, fidelity: back.result.fidelity, ellipses, ...extra };
}

export function bundledCase() {
  const { files, attachments } = generateExample('flowjo-workspace', { scale: 0.25 });
  const first = importWithFiles(attachments.find((a) => /\.wsp$/.test(a.name)).text, files);
  return exportAndBack('bundled FlowJo example', 'flowjo', first.ws, first.views, files, { original: first });
}

export function flowKitCases() {
  const root = join(CACHE, 'flowkit');
  if (!existsSync(root)) return [];
  const read = (dir) => readdirSync(join(root, dir)).filter((n) => /\.fcs$/.test(n)).map((n) => ({ name: n, bytes: new Uint8Array(readFileSync(join(root, dir, n))) }));
  const cache = new Map();
  return FLOWKIT_WORKSPACES.filter(([wsp]) => existsSync(join(root, wsp))).map(([wsp, dir]) => {
    if (!cache.has(dir)) cache.set(dir, read(dir));
    const files = cache.get(dir);
    const first = importWithFiles(readFileSync(join(root, wsp), 'utf8'), files);
    return exportAndBack(wsp.split('/').pop(), 'flowjo', first.ws, first.views, files, { source: wsp, fcsDir: dir, original: first });
  });
}

const LOGICLE = { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 };
const ARCSINH = { type: 'arcsinh', cofactor: 150, max: 262144 };
const LINEAR = { type: 'linear', min: 0, max: 262144 };

export function builtCase() {
  const { files, workspaceHints } = generateExample('pbmc-immunophenotyping', { samples: ['D01_Unstim.fcs', 'D01_Stim.fcs', 'D02_Stim.fcs'], scale: 0.2 });
  const fcs = files.filter((f) => /^D0/.test(f.name));
  let { ws, datasets } = newWorkspace(fcs);
  ws = addGates(ws, workspaceHints.suggestedGates).ws;
  const id = (name) => ws.gates.find((g) => g.name === name).id;
  const dim = (channel, transform = LOGICLE) => ({ channel, transform });
  ws = addGates(ws, [
    { id: 'split-lo', name: 'CD25 low', parentId: id('T cells'), type: 'split', dims: [dim('PE-A')], geometry: { threshold: 0.45, side: 'lo' }, linkId: 'split' },
    { id: 'split-hi', name: 'CD25 high', parentId: id('T cells'), type: 'split', dims: [dim('PE-A')], geometry: { threshold: 0.45, side: 'hi' }, linkId: 'split' },
    ...['UL', 'UR', 'LR', 'LL'].map((q) => ({ id: `quad-${q}`, name: `Q ${q}`, parentId: id('T cells'), type: 'quadrant', dims: [dim('Alexa Fluor 700-A', ARCSINH), dim('APC-A')], geometry: { center: [0.5, 0.42], quadrant: q }, linkId: 'quad' })),
    { id: 'poly-asinh', name: 'Polygon on arcsinh', parentId: id('T cells'), type: 'polygon', dims: [dim('Alexa Fluor 700-A', ARCSINH), dim('APC-A', ARCSINH)], geometry: { vertices: [[0.2, 0.2], [0.8, 0.25], [0.7, 0.8], [0.25, 0.7]] } },
    { id: 'ellipse', name: 'Ellipse', parentId: id('Lymphocytes'), type: 'ellipse', dims: [dim('FSC-A', LINEAR), dim('SSC-A', LINEAR)], geometry: { center: [0.25, 0.1], radii: [0.12, 0.05], angle: 0.4 } },
    { id: 'or', name: 'CD4 or CD8', parentId: id('T cells'), type: 'boolean', dims: [], geometry: { op: 'or', operands: ['quad-UL', 'quad-LR'] } },
    { id: 'and', name: 'CD25 high and CD4', parentId: id('T cells'), type: 'boolean', dims: [], geometry: { op: 'and', operands: ['split-hi', 'quad-LR'] } },
    { id: 'not', name: 'Not CD25 high', parentId: id('T cells'), type: 'boolean', dims: [], geometry: { op: 'not', operands: ['split-hi'] } },
    { id: 'qc', name: 'QC pass', parentId: null, type: 'category', dims: [{ channel: 'QC pass', transform: { type: 'linear', min: 0, max: 1 } }], geometry: { values: [1] } },
  ]).ws;
  const stim = ws.samples.filter((s) => /_Stim/.test(s.name)).map((s) => s.id);
  const grouped = addGroup(ws, 'Stimulated', stim);
  ws = grouped.ws;
  const lymph = ws.gates.find((g) => g.name === 'Lymphocytes');
  ws = updateGate(ws, lymph.id, { overrides: { [stim[0]]: { vertices: lymph.geometry.vertices.map(([x, y]) => [x + 0.01, y]) } } });
  ws = updateGate(ws, 'ellipse', { scope: { groupId: grouped.group.id } });
  const views = new Map(ws.samples.map((s) => [s.id, viewOf(s, datasets.get(s.id), ws)]));
  return exportAndBack('workspace built in CytoWeave', 'cytoweave', ws, views, fcs);
}
