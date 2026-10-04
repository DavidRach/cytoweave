import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateExample } from './examples.js';
import { parseFCS, readSpillover } from './fcs.js';
import { SampleView, countOf, population } from './engine.js';
import { importFlowJo } from './flowjo.js';
import { buildFlowJoMigration, matchFlowJoSamples, migrationCountRows } from './flowjo-match.js';
import { createWorkspace, addGates, addGroup, addSamples, sampleFromDataset, updateGate } from './workspace.js';
import { exportFlowJo, flowJoScale, flowJoTransformXML } from './flowjo-export.js';
import { createTransform } from './transforms.js';
import { parseXMLDocument, find } from './xml.js';

const LOGICLE = { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 };
const ARCSINH = { type: 'arcsinh', cofactor: 150, max: 262144 };

// A workspace built in CytoWeave with every gate type FlowJo can hold, and some it cannot.
function buildWorkspace() {
  const { files, workspaceHints } = generateExample('pbmc-immunophenotyping', { samples: ['D01_Unstim.fcs', 'D01_Stim.fcs', 'D02_Stim.fcs'], scale: 0.08 });
  const fcs = files.filter((f) => /^D0/.test(f.name));
  let ws = createWorkspace('export test');
  const datasets = new Map();
  for (const file of fcs) {
    const data = parseFCS(file.bytes).datasets[0];
    const record = sampleFromDataset(data, { name: file.name });
    datasets.set(record.id, data);
    ws = addSamples(ws, [record]);
  }
  ws = addGates(ws, workspaceHints.suggestedGates).ws;
  const id = (name) => ws.gates.find((g) => g.name === name).id;
  const dim = (channel, transform = LOGICLE) => ({ channel, transform });
  const quad = 'q-test';
  const gates = [
    // A split and a quadrant family on mixed scales.
    { id: 'split-lo', name: 'CD25 low', parentId: id('T cells'), type: 'split', dims: [dim('PE-A')], geometry: { threshold: 0.45, side: 'lo' }, linkId: 'split-test' },
    { id: 'split-hi', name: 'CD25 high', parentId: id('T cells'), type: 'split', dims: [dim('PE-A')], geometry: { threshold: 0.45, side: 'hi' }, linkId: 'split-test' },
    ...['UL', 'UR', 'LR', 'LL'].map((q) => ({ id: `quad-${q}`, name: `Q ${q}`, parentId: id('T cells'), type: 'quadrant', dims: [dim('Alexa Fluor 700-A', ARCSINH), dim('APC-A')], geometry: { center: [0.5, 0.42], quadrant: q }, linkId: quad })),
    // A polygon and an ellipse drawn on a scale other than the channel's usual one.
    { id: 'poly-asinh', name: 'Odd polygon', parentId: id('T cells'), type: 'polygon', dims: [dim('Alexa Fluor 700-A', ARCSINH), dim('APC-A', ARCSINH)], geometry: { vertices: [[0.2, 0.2], [0.8, 0.25], [0.7, 0.8], [0.25, 0.7]] } },
    { id: 'ellipse', name: 'Blob', parentId: id('Lymphocytes'), type: 'ellipse', dims: [dim('FSC-A', { type: 'linear', min: 0, max: 262144 }), dim('SSC-A', { type: 'linear', min: 0, max: 262144 })], geometry: { center: [0.25, 0.1], radii: [0.12, 0.05], angle: 0.4 } },
    // Booleans.
    { id: 'or', name: 'CD4 or CD8', parentId: id('T cells'), type: 'boolean', dims: [], geometry: { op: 'or', operands: ['quad-UL', 'quad-LR'] } },
    { id: 'not', name: 'Not CD25 high', parentId: id('T cells'), type: 'boolean', dims: [], geometry: { op: 'not', operands: ['split-hi'] } },
    // A gate on a channel the files do not have, and its child.
    { id: 'qc', name: 'QC pass', parentId: null, type: 'category', dims: [{ channel: 'QC pass', transform: { type: 'linear', min: 0, max: 1 } }], geometry: { values: [1] } },
    { id: 'qc-child', name: 'Under QC', parentId: 'qc', type: 'range', dims: [dim('FSC-A', { type: 'linear', min: 0, max: 262144 })], geometry: { min: 0.1, max: null } },
  ];
  ws = addGates(ws, gates).ws;
  // A per-sample override and a group scope.
  const stim = ws.samples.filter((s) => /_Stim/.test(s.name)).map((s) => s.id);
  const grouped = addGroup(ws, 'Stimulated', stim);
  ws = grouped.ws;
  const lymph = ws.gates.find((g) => g.name === 'Lymphocytes');
  const moved = { vertices: lymph.geometry.vertices.map(([x, y]) => [x + 0.01, y]) };
  ws = updateGate(ws, lymph.id, { overrides: { [stim[0]]: moved } });
  ws = updateGate(ws, 'ellipse', { scope: { groupId: grouped.group.id } });
  return { ws, files: fcs, datasets };
}

function viewOf(ws, record, data) {
  const view = new SampleView(record, data);
  if (record.compensationId === 'file') {
    const spill = readSpillover(data.keywords, data.parameters);
    view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
  }
  return view;
}

function countsOf(ws, views) {
  return (sample) => {
    const view = views.get(sample.id);
    const out = new Map();
    for (const gate of ws.gates) {
      const members = population(view, ws, gate.id);
      if (members !== undefined) out.set(gate.id, countOf(members, view));
    }
    return out;
  };
}

// Imports FlowJo XML into a fresh workspace with the same files and recomputes every population.
function reimport(xml, files) {
  const result = importFlowJo(xml);
  let ws = createWorkspace('reimport');
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
    const view = viewOf(ws, record, datasets.get(record.id));
    counts[target.sampleId] = Object.fromEntries(Object.entries(plan.migration.gates).map(([path, gateId]) => {
      const members = population(view, ws, gateId);
      return [path, members === undefined ? null : countOf(members, view)];
    }));
  }
  return { result, rows: migrationCountRows(plan.migration, counts) };
}

test('a CytoWeave workspace survives export to FlowJo and import back, count for count', () => {
  const { ws, files, datasets } = buildWorkspace();
  const views = new Map(ws.samples.map((s) => [s.id, viewOf(ws, s, datasets.get(s.id))]));
  const { xml, report } = exportFlowJo(ws, { counts: countsOf(ws, views), version: 'test' });
  const byPath = (path) => report.populations.filter((p) => p.path.endsWith(path));
  // What FlowJo cannot evaluate is left out and said so.
  assert.ok(byPath('QC pass').every((p) => p.status === 'omitted' && /category/.test(p.detail)));
  assert.ok(byPath('Under QC').every((p) => p.status === 'omitted' && /parent/.test(p.detail)));
  // Gates on another scale are traced, and reported as approximated; the rest are exact.
  assert.ok(byPath('Odd polygon').every((p) => p.status === 'approximated'));
  assert.ok(byPath('CD25 high').every((p) => p.status === 'exact'));
  assert.ok(byPath('Q UR').every((p) => p.status === 'exact'));
  // The group scope: the ellipse is only in the stimulated samples' trees.
  assert.equal(byPath('Blob').length, 2);

  const { result, rows } = reimport(xml, files);
  assert.deepEqual(result.fidelity.filter((f) => f.status === 'unsupported'), []);
  // Counts recomputed from the re-imported gates equal the counts CytoWeave exported, except the
  // traced polygon, whose outline FlowJo draws with straight edges between the traced points.
  const differ = rows.filter((r) => r.flowjo !== r.cytoweave && !/Odd polygon/.test(r.path));
  assert.deepEqual(differ, []);
  const traced = rows.filter((r) => /Odd polygon/.test(r.path));
  assert.ok(traced.length === 3 && traced.every((r) => Math.abs(r.cytoweave - r.flowjo) <= Math.max(2, 0.01 * r.flowjo)), JSON.stringify(traced));
  // The override reached its sample only.
  const lymph = rows.filter((r) => r.path.endsWith('Live/Lymphocytes'));
  assert.equal(new Set(lymph.map((r) => r.flowjo)).size, 3);
});

test('the exported XML has the structure FlowJo writes', () => {
  const { ws } = buildWorkspace();
  const { xml } = exportFlowJo(ws, {});
  const { root } = parseXMLDocument(xml);
  assert.equal(root.local, 'Workspace');
  assert.ok(find(root, 'SampleList'));
  assert.ok(find(root, 'spilloverMatrix'), 'the file matrices are written');
  assert.match(xml, /<NotNode name="Not CD25 high"[^>]*>.*?<Dependent name="Cells\/Single cells\/Live\/Lymphocytes\/T cells\/CD25 high"\/>/s);
  assert.match(xml, /quadId="QUAD1"/);
  assert.match(xml, /<GroupNode name="Stimulated"/);
  // FlowJo 11 crashes importing a node whose Graph lacks GraphSettings and GraphEnvironment.
  const graphs = xml.match(/<Graph\b.*?<\/Graph>/gs);
  const nodes = xml.match(/<(SampleNode|GroupNode|Population|AndNode|OrNode|NotNode)\b/g);
  assert.equal(graphs.length, nodes.length, 'every node has a full Graph element');
  for (const g of graphs) assert.match(g, /<GraphSettings [^>]*\/><GraphEnvironment [^>]*>.*<\/GraphEnvironment><\/Graph>$/s);
  assert.doesNotMatch(xml, /<Graph [^>]*\/>/, 'no empty Graph elements');
  // FlowJo 11 does not import a two-dimensional rectangle open on a side, unless it is a quadrant.
  for (const [, wrapper, body] of xml.matchAll(/<Gate ([^>]*)><gating:RectangleGate [^>]*>(.*?)<\/gating:RectangleGate>/gs)) {
    const dimensions = body.match(/<gating:dimension[^>]*>/g);
    if (dimensions.length === 2 && !/quadId/.test(wrapper)) for (const d of dimensions) assert.match(d, /gating:min="[^"]+" gating:max="[^"]+"/);
  }
  // FlowJo 11 misreads logicle and arcsinh scales: they are written as FlowJo biex.
  assert.doesNotMatch(xml, /<transforms:(logicle|fasinh)\b/);
  assert.equal(flowJoScale({ type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 }).type, 'biex');
  assert.equal(flowJoScale({ type: 'arcsinh', cofactor: 150, max: 262144 }).type, 'biex');
  assert.deepEqual(flowJoScale({ type: 'linear', min: 0, max: 262144 }), { type: 'linear', min: 0, max: 262144 });
  // A sample opens on its first gate's axes, as FlowJo writes it.
  assert.match(xml, /<SampleNode [^>]*><Graph [^>]*><Axis dimension="x" name="FSC-A"[^>]*\/><Axis dimension="y" name="SSC-A"/);
});

test('FlowJo transforms are the same functions as CytoWeave scales', () => {
  // arcsinh is written as fasinh; check the function, not just the element.
  const t = flowJoTransformXML(ARCSINH);
  const fasinh = createTransform({ type: 'fasinh', T: t.attrs.T, M: t.attrs.M, A: t.attrs.A });
  const own = createTransform(ARCSINH);
  for (const x of [-500, 0, 10, 1000, 100000]) assert.ok(Math.abs(fasinh.forward(x) - own.forward(x)) < 1e-12);
  assert.deepEqual(flowJoTransformXML({ type: 'linear', min: 0, max: 1000 }, 0.01).attrs, { minRange: 0, maxRange: 10 });
  assert.ok(flowJoTransformXML({ type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0, boundMin: 0 }).error);
});

test('a confirmed Cell Ontology term is written as the population annotation', () => {
  const t = { type: 'linear', min: 0, max: 262144 };
  let ws = { ...createWorkspace('t'), samples: [{ id: 's1', name: 'S1', fileName: 'S1.fcs', eventCount: 10, channels: [{ name: 'CD3', type: 'fluorescence', range: 262144 }], keywords: {}, meta: {} }] };
  ws = addGates(ws, [{ id: 'g1', name: 'T cells', parentId: null, type: 'range', dims: [{ channel: 'CD3', transform: t }], geometry: { min: 0.5, max: null }, ontology: { id: 'CL:0000084', label: 'T cell', status: 'confirmed' } }]).ws;
  const { xml } = exportFlowJo(ws, {});
  assert.match(xml, /<Population name="T cells" annotation="CL:0000084 T cell"/);
});
