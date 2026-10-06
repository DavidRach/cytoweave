import assert from 'node:assert/strict';
import test from 'node:test';
import { createZip } from './zip.js';
import { flowJo11Transform, importFlowJo11, importFlowJo11Analysis } from './flowjo11.js';

const LIN = (max) => ({ transformType: 'Linear', minRange: 0, maxRange: max });
const BIEX = { transformType: 'Biex', T: 262144, A: 0, M: 4.5, W: -10, vectorLength: 256 };
const axis = (name, transform) => ({ parameterSpec: { name }, transform });

// A small analysis in FlowJo 11's layout: one sample, a polygon (1024 grid), an ellipse, a
// quadrant gate (offset in the sample's own copy), a Boolean and a compensation matrix.
function analysis() {
  const ds = 'ds-1';
  const node = (definition, parents = {}, children = {}, results = {}) => ({ definition, parents, children, results });
  const defs = {
    root: node({ name: ['Ungated'], type: 'root' }),
    poly: node({ name: ['Cells'], type: 'gate', gateDefinition: { type: 'polygon', xAxis: axis('FSC-A', LIN(262144)), yAxis: axis('SSC-A', LIN(262144)), xVertices: [0, 512, 512], yVertices: [0, 0, 512], gateResolution: 1024 } }),
    ell: node({ name: ['Round'], type: 'gate', gateDefinition: { type: 'ellipse', xAxis: axis('FSC-A', LIN(262144)), yAxis: axis('SSC-A', LIN(262144)), xVertices: [33.28, 94.72], yVertices: [12.8, 38.4], rotationAngle: 22.918311805232928 } }),
    quad: node({
      name: ['Q4:LL', 'Q3:LR', 'Q1:UL', 'Q2:UR'],
      type: 'quad',
      gateDefinition: { type: 'quad', xAxis: axis('Comp-PE-A', BIEX), yAxis: axis('Comp-APC-A', BIEX), xVertices: [128, 128, 293, 128, 0], yVertices: [100, -37, 100, 256, 100] },
      desyncTable: { [ds]: { type: 'quad', xAxis: axis('Comp-PE-A', BIEX), yAxis: axis('Comp-APC-A', BIEX), xVertices: [128, 160, 293, 128, 0], yVertices: [100, -37, 100, 256, 100] } },
    }),
    not: node({ name: ['Not Round'], type: 'not' }),
  };
  for (const [id, d] of Object.entries(defs)) d.uuid = id;
  const pop = (id, def, parent, extra = {}) => node({ populationNumber: extra.number ?? 0 }, { _dataSource: [ds], populationDefinitions: [def], populations: parent ? [parent] : [], ...(extra.parents ?? {}) }, { populations: extra.children ?? [] }, { count: extra.count, status: 'valid' });
  const populations = {
    p0: pop('p0', 'root', null, { count: 1000, children: ['p1'] }),
    p1: pop('p1', 'poly', 'p0', { count: 900, children: ['p2', 'q0', 'q1', 'q2', 'q3'] }),
    p2: pop('p2', 'ell', 'p1', { count: 300, children: ['n1'] }),
    q0: pop('q0', 'quad', 'p1', { count: 400, number: 0 }),
    q1: pop('q1', 'quad', 'p1', { count: 200, number: 1 }),
    q2: pop('q2', 'quad', 'p1', { count: 250, number: 2 }),
    q3: pop('q3', 'quad', 'p1', { count: 50, number: 3 }),
    // FlowJo shows the Boolean under its operand; its parents name the operand.
    n1: pop('n1', 'not', 'p2', { count: 600 }),
  };
  populations.n1.parents.populations = ['p2'];
  return {
    schemaVersion: '3.0.0',
    populationDefinitions: defs,
    populations,
    dataSources: {
      [ds]: {
        definition: { uri: '/data/case/Sample A.fcs' },
        parents: { platforms: ['m1'] },
        results: { keywords: { $TOT: '1000', $P1N: 'FSC-A', $P1R: '262144' } },
      },
    },
    platforms: {
      spilloverMatrix: {
        m1: { uuid: 'm1', definition: { platformType: 'spilloverMatrix', name: 'Acquisition-defined', fluorToPrimaryDetector: { 'Comp-PE-A': 'PE-A', 'Comp-APC-A': 'APC-A' }, spillover: { rows: ['Comp-PE-A', 'Comp-APC-A'], columns: ['PE-A', 'APC-A'], values: [[1, 0.1], [0.02, 1]] } } },
      },
    },
    groups: { g1: { definition: { name: 'Stimulated' }, parents: { dataSources: [ds] } } },
  };
}

test('transforms: linear, log, FlowJo biex and an unknown type', () => {
  assert.deepEqual(flowJo11Transform(LIN(1000)).spec, { type: 'linear', min: 0, max: 1000 });
  const log = flowJo11Transform({ transformType: 'Log', decadesOffset: 1, numberDecades: 5 });
  assert.deepEqual(log.spec, { type: 'log', min: 1, max: 100000 });
  assert.deepEqual(flowJo11Transform(BIEX).spec, { type: 'biex', maxValue: 262144, widthBasis: -10, positiveDecades: 4.5, extraNegativeDecades: 0 });
  assert.equal(flowJo11Transform({ transformType: 'Linear', minRange: 0, maxRange: 0 }, 4096).status, 'approximated');
  const unknown = flowJo11Transform({ transformType: 'Hyperspace' });
  assert.equal(unknown.status, 'unsupported');
  assert.equal(unknown.spec.type, 'linear');
});

test('gates, per-sample quadrants, Booleans, counts, compensation and groups', () => {
  const result = importFlowJo11Analysis(analysis());
  assert.equal(result.format, 'flowjo11');
  const [sample] = result.samples;
  assert.equal(sample.name, 'Sample A.fcs');
  assert.equal(sample.eventCount, 1000);
  assert.deepEqual(sample.groupNames, ['Stimulated']);
  assert.deepEqual(sample.compensation.channels, ['PE-A', 'APC-A']);
  assert.deepEqual(sample.compensation.matrix, [1, 0.1, 0.02, 1]);
  assert.equal(sample.populationCounts.Cells, 900);
  assert.equal(sample.populationCounts['Cells/Round/Not Round'], 600);
  const gate = (name) => sample.gates.find((g) => g.name === name && !g.meta.helper);
  // Coordinates over the grid: the polygon's 1024, the ellipse's axis length 256.
  assert.deepEqual(gate('Cells').geometry.vertices, [[0, 0], [0.5, 0], [0.5, 0.5]]);
  assert.deepEqual(gate('Cells').meta.flowJo.grid, [1024, 1024]);
  const round = gate('Round').geometry;
  assert.ok(Math.abs(round.center[0] - 0.25) < 1e-12 && Math.abs(round.center[1] - 0.1) < 1e-12);
  assert.ok(Math.abs(round.radii[0] - 0.12) < 1e-12 && Math.abs(round.radii[1] - 0.05) < 1e-12);
  assert.ok(Math.abs(round.angle - 0.4) < 1e-12);
  // The sample's own quadrant has its lower arm moved right: rectangles, by populationNumber.
  const ll = gate('Q4:LL');
  const lr = gate('Q3:LR');
  assert.equal(ll.type, 'rectangle');
  assert.deepEqual(ll.geometry, { min: [null, null], max: [160 / 256, 100 / 256] });
  assert.deepEqual(lr.geometry, { min: [160 / 256, null], max: [null, 100 / 256] });
  assert.deepEqual(gate('Q2:UR').geometry, { min: [128 / 256, 100 / 256], max: [null, null] });
  assert.deepEqual(ll.dims.map((d) => d.channel), ['PE-A', 'APC-A']);
  assert.deepEqual(ll.meta.compensated, [true, true]);
  // The Boolean is counted within its operand's parent.
  const not = gate('Not Round');
  assert.deepEqual(not.geometry, { op: 'not', operands: [gate('Round').id] });
  assert.equal(not.parentId, gate('Cells').id);
  assert.ok(result.fidelity.every((f) => f.status === 'imported'), JSON.stringify(result.fidelity.filter((f) => f.status !== 'imported')));
});

test('a quadrant without offsets is a linked set of quadrants, single-precision arm ends included', () => {
  const a = analysis();
  delete a.populationDefinitions.quad.definition.desyncTable;
  a.populationDefinitions.quad.definition.gateDefinition.xVertices = [128.00000001, 128.0000002, 293, 128.0000002, 0];
  const [sample] = importFlowJo11Analysis(a).samples;
  const quads = sample.gates.filter((g) => g.type === 'quadrant');
  assert.deepEqual(quads.map((g) => g.geometry.quadrant), ['LL', 'LR', 'UL', 'UR']);
  assert.equal(new Set(quads.map((g) => g.linkId)).size, 1);
});

test('reads the ZIP, with backslashes in entry names as FlowJo for Windows writes them', async () => {
  const json = JSON.stringify(analysis());
  const zip = await createZip([
    { name: 'workbench.json', data: JSON.stringify({ name: 'demo', analyses: ['a1'] }) },
    { name: 'analyses\\analysis-a1\\analysis-a1.json', data: json },
    { name: 'analyses\\analysis-a1\\analysis-a1_manifest.txt', data: '[]' },
  ]);
  const result = await importFlowJo11(zip);
  assert.equal(result.samples[0].populationCounts.Cells, 900);
  await assert.rejects(() => importFlowJo11(new TextEncoder().encode('<Workspace/>')), /not a FlowJo 11 workbench/);
});
