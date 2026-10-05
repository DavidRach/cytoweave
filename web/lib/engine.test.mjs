import assert from 'node:assert/strict';
import test from 'node:test';
import { SampleView, computeStatistic, gateRobustness, gateSignature, population, populationSummary } from './engine.js';
import { quadrantGates } from './gates.js';
import { createRandom } from './random.js';
import {
  addGates,
  addGroup,
  clearOverride,
  copyGateSubtree,
  createWorkspace,
  gatePath,
  parseWorkspace,
  removeGate,
  serializeWorkspace,
  setGateGeometry,
} from './workspace.js';

const linear = { type: 'linear', min: 0, max: 1000 };

// Two populations in (A, B): a dense blob around (200, 200) and one around (700, 700); C is a
// third channel that only the second population expresses.
function makeView(id = 's1', n = 4000, seed = 5) {
  const random = createRandom(seed);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  const c = new Float32Array(n);
  for (let e = 0; e < n; e += 1) {
    const second = e % 4 === 0;
    a[e] = (second ? 700 : 200) + 30 * random.gaussian();
    b[e] = (second ? 700 : 200) + 30 * random.gaussian();
    c[e] = second ? 500 + 20 * random.gaussian() : 10 * random.gaussian();
  }
  const dataset = {
    eventCount: n,
    parameters: [
      { index: 0, name: 'A', type: 'scatter', range: 1000 },
      { index: 1, name: 'B', type: 'scatter', range: 1000 },
      { index: 2, name: 'C', type: 'fluorescence', range: 1000 },
    ],
    data: [a, b, c],
  };
  return new SampleView({ id, name: id, keywords: {}, technology: 'conventional' }, dataset);
}

function rectGate(name, parentId, min, max, extra = {}) {
  return { name, parentId, type: 'rectangle', dims: [{ channel: 'A', transform: linear }, { channel: 'B', transform: linear }], geometry: { min, max }, ...extra };
}

test('hierarchical populations and frequencies', () => {
  const view = makeView();
  let ws = createWorkspace('t');
  ({ ws } = addGates(ws, [rectGate('High', null, [0.5, 0.5], [1, 1])]));
  const high = ws.gates[0];
  ({ ws } = addGates(ws, [{ name: 'C+', parentId: high.id, type: 'range', dims: [{ channel: 'C', transform: linear }], geometry: { min: 0.3, max: null } }]));
  const cPos = ws.gates[1];
  const highPop = population(view, ws, high.id);
  assert.equal(highPop.length, 1000);
  assert.equal(population(view, ws, cPos.id).length, 1000);
  assert.equal(computeStatistic(view, ws, { stat: 'freqParent', gateId: high.id }), 25);
  assert.equal(computeStatistic(view, ws, { stat: 'freqParent', gateId: cPos.id }), 100);
  const median = computeStatistic(view, ws, { stat: 'median', gateId: cPos.id, channel: 'C' });
  assert.ok(Math.abs(median - 500) < 5);
  assert.equal(gatePath(ws, cPos.id), 'High / C+');
  const summary = populationSummary(view, ws);
  assert.equal(summary[high.id].count, 1000);
});

test('signatures change when a gate or its parent changes, and caches follow', () => {
  const view = makeView();
  let ws = createWorkspace('t');
  ({ ws } = addGates(ws, [rectGate('High', null, [0.5, 0.5], [1, 1])]));
  const high = ws.gates[0];
  ({ ws } = addGates(ws, [rectGate('Corner', high.id, [0.6, 0.6], [1, 1])]));
  const corner = ws.gates[1];
  const before = gateSignature(ws, corner, view.id);
  const countBefore = population(view, ws, corner.id).length;
  const moved = setGateGeometry(ws, high.id, { min: [0.69, 0.69], max: [1, 1] });
  assert.notEqual(gateSignature(moved, moved.gates[1], view.id), before);
  assert.ok(population(view, moved, corner.id).length < countBefore);
  // The original workspace still gives the original answer (values are immutable).
  assert.equal(population(view, ws, corner.id).length, countBefore);
});

test('sample-specific overrides and resets', () => {
  const v1 = makeView('s1');
  const v2 = makeView('s2', 4000, 9);
  let ws = createWorkspace('t');
  ({ ws } = addGates(ws, [rectGate('High', null, [0.5, 0.5], [1, 1])]));
  const id = ws.gates[0].id;
  const adjusted = setGateGeometry(ws, id, { min: [0.7, 0.7], max: [1, 1] }, { sampleId: 's2' });
  assert.equal(population(v1, adjusted, id).length, 1000);
  assert.ok(population(v2, adjusted, id).length < 600);
  const reset = clearOverride(adjusted, id, 's2');
  assert.equal(population(v2, reset, id).length, 1000);
});

test('boolean gates combine populations', () => {
  const view = makeView();
  let ws = createWorkspace('t');
  ({ ws } = addGates(ws, [rectGate('Left', null, [0, 0], [0.5, 1]), rectGate('Bottom', null, [0, 0], [1, 0.5])]));
  const [left, bottom] = ws.gates;
  ({ ws } = addGates(ws, [
    { name: 'L and B', parentId: null, type: 'boolean', dims: [], geometry: { op: 'and', operands: [left.id, bottom.id] } },
    { name: 'not L', parentId: null, type: 'boolean', dims: [], geometry: { op: 'not', operands: [left.id] } },
    { name: 'L or B', parentId: null, type: 'boolean', dims: [], geometry: { op: 'or', operands: [left.id, bottom.id] } },
  ]));
  const [and, not, or] = ws.gates.slice(2);
  assert.equal(population(view, ws, and.id).length, 3000);
  assert.equal(population(view, ws, not.id).length, 1000);
  assert.equal(population(view, ws, or.id).length, 3000);
  // Removing an operand removes the booleans that use it.
  const pruned = removeGate(ws, left.id);
  assert.deepEqual(pruned.gates.map((g) => g.name), ['Bottom']);
});

test('quadrants move together and group scopes restrict gates', () => {
  const view = makeView();
  let ws = createWorkspace('t');
  const dims = [{ channel: 'A', transform: linear }, { channel: 'B', transform: linear }];
  ({ ws } = addGates(ws, quadrantGates({ parentId: null, dims, center: [0.45, 0.45] })));
  const total = ws.gates.reduce((sum, g) => sum + population(view, ws, g.id).length, 0);
  assert.equal(total, 4000);
  const moved = setGateGeometry(ws, ws.gates[0].id, { center: [0.9, 0.9] });
  assert.ok(moved.gates.every((g) => g.geometry.center[0] === 0.9));
  let scoped;
  ({ ws: scoped } = addGroup(ws, 'Other', ['s9']));
  const group = scoped.groups[0];
  scoped = { ...scoped, gates: scoped.gates.map((g, i) => (i === 0 ? { ...g, scope: { groupId: group.id } } : g)) };
  assert.equal(population(view, scoped, scoped.gates[0].id), undefined);
  assert.ok(population(view, scoped, scoped.gates[1].id) !== undefined);
});

test('copying a subtree renumbers ids and keeps structure', () => {
  let ws = createWorkspace('t');
  ({ ws } = addGates(ws, [rectGate('High', null, [0.5, 0.5], [1, 1])]));
  ({ ws } = addGates(ws, [rectGate('Corner', ws.gates[0].id, [0.6, 0.6], [1, 1])]));
  ({ ws } = addGates(ws, [rectGate('Other', null, [0, 0], [0.5, 0.5])]));
  const { ws: copied, gates } = copyGateSubtree(ws, ws.gates[0].id, ws.gates[2].id);
  assert.equal(gates.length, 2);
  assert.equal(gates[0].parentId, ws.gates[2].id);
  assert.equal(gates[1].parentId, gates[0].id);
  assert.equal(gatePath(copied, gates[1].id), 'Other / High / Corner');
});

test('gate robustness separates valley gates from gates through dense regions', () => {
  const view = makeView('s1', 8000, 3);
  let ws = createWorkspace('t');
  // A gate in the empty valley between the populations, and one cutting through the blob.
  ({ ws } = addGates(ws, [rectGate('Valley', null, [0.45, 0.45], [1, 1]), rectGate('Cut', null, [0.2, 0], [1, 1])]));
  const valley = gateRobustness(view, ws, ws.gates[0].id);
  const cut = gateRobustness(view, ws, ws.gates[1].id);
  assert.equal(valley.rating, 'robust');
  assert.equal(cut.rating, 'sensitive');
  assert.ok(Math.abs(cut.sensitivity) > Math.abs(valley.sensitivity) * 5);
});

test('compensation feeds gating', () => {
  const view = makeView();
  view.setCompensation({ id: 'c1', channels: ['B', 'C'], matrix: [1, 0, 0.5, 1] });
  // C spilled into B by 0.5: compensated B = B − 0.5·C.
  const raw = view.raw.get('B')[0];
  const c = view.raw.get('C')[0];
  assert.ok(Math.abs(view.column('B')[0] - (raw - 0.5 * c)) < 1e-3);
  assert.ok(view.isCompensated('B'));
  assert.equal(view.isCompensated('A'), false);
});

// Gate coordinates in data units (the identity scale).
const identity = { type: 'linear', min: 0, max: 1 };

test('gate dimensions may name their own compensation', () => {
  const view = makeView();
  let ws = createWorkspace('T');
  ws = { ...ws, compensations: [{ id: 'c2', name: 'Other', channels: ['B', 'C'], matrix: [1, 0, 0.2, 1] }] };
  view.setCompensation({ id: 'c1', channels: ['B', 'C'], matrix: [1, 0, 0.5, 1] });
  const range = (name, compensation) => ({ name, parentId: null, type: 'range', dims: [{ channel: 'B', transform: identity, ...(compensation ? { compensation } : {}) }], geometry: { min: 400, max: null } });
  ws = addGates(ws, [range('Sample'), range('None', 'uncompensated'), range('Other', 'c2'), range('Missing', 'c9')]).ws;
  const count = (name) => population(view, ws, ws.gates.find((g) => g.name === name).id)?.length;
  const expected = (k) => {
    const b = view.raw.get('B');
    const c = view.raw.get('C');
    let n = 0;
    for (let e = 0; e < view.eventCount; e += 1) if (b[e] - k * c[e] >= 400) n += 1;
    return n;
  };
  assert.equal(count('Sample'), expected(0.5));
  assert.equal(count('None'), expected(0));
  assert.equal(count('Other'), expected(0.2));
  assert.notEqual(expected(0.5), expected(0));
  // A compensation the workspace lacks cannot be evaluated.
  assert.equal(population(view, ws, ws.gates.find((g) => g.name === 'Missing').id), undefined);
  // Changing the sample's compensation moves only the gates that follow it.
  view.setCompensation(null);
  assert.equal(count('Sample'), expected(0));
  assert.equal(count('Other'), expected(0.2));
});

test('ratio and unmixed channels are computed from their inputs, exactly at gate boundaries', () => {
  const view = makeView();
  let ws = createWorkspace('T');
  ws = {
    ...ws,
    derived: [
      { id: 'd1', kind: 'ratio', inputs: ['A', 'B'], outputs: ['A/B'], params: { A: 2, B: 0, C: 0 } },
      { id: 'd2', kind: 'unmix', inputs: ['A', 'B', 'C'], outputs: ['U1', 'U2'], params: { matrix: [1, 0, 0, 1, 0.5, 0.5] } },
    ],
  };
  const ratioGate = { name: 'R', parentId: null, type: 'range', dims: [{ channel: 'A/B', transform: identity }], geometry: { min: 2, max: null } };
  const unmixGate = { name: 'U', parentId: null, type: 'rectangle', dims: [{ channel: 'U1', transform: identity }, { channel: 'U2', transform: identity }], geometry: { min: [400, null], max: [null, null] } };
  ws = addGates(ws, [ratioGate, unmixGate]).ws;
  const a = view.raw.get('A');
  const b = view.raw.get('B');
  const c = view.raw.get('C');
  const r = population(view, ws, ws.gates[0].id);
  let n = 0;
  for (let e = 0; e < view.eventCount; e += 1) if ((2 * a[e]) / b[e] >= 2) n += 1;
  assert.equal(r.length, n);
  assert.ok(view.hasChannel('U1') && view.channelInfo('U2').type === 'derived');
  // U1 = A + 0.5·C; U2 = B + 0.5·C.
  assert.ok(Math.abs(view.column('U1')[3] - (a[3] + 0.5 * c[3])) < 1e-3);
  assert.ok(Math.abs(view.exactValue('U2', 3) - (b[3] + 0.5 * c[3])) < 1e-9);
  const u = population(view, ws, ws.gates[1].id);
  let m = 0;
  for (let e = 0; e < view.eventCount; e += 1) if (a[e] + 0.5 * c[e] >= 400) m += 1;
  assert.equal(u.length, m);
  // Boundary decisions use double precision: compensated B = B − 0.5·C is 400 − 1e-6 for event 0
  // (outside [400, ∞)) and 400 + 1e-6 for event 1, but both round to 400 in the float32 column.
  b[0] = 400;
  c[0] = Math.fround(2e-6);
  b[1] = 400;
  c[1] = -Math.fround(2e-6);
  view.setCompensation({ id: 'c1', channels: ['B', 'C'], matrix: [1, 0, 0.5, 1] });
  assert.equal(view.column('B')[0], 400);
  assert.equal(view.column('B')[1], 400);
  ws = addGates(ws, [{ name: 'B400', parentId: null, type: 'range', dims: [{ channel: 'B', transform: identity }], geometry: { min: 400, max: null } }]).ws;
  const edge = population(view, ws, ws.gates[2].id);
  assert.equal(edge.includes(0), false);
  assert.ok(edge.includes(1));
});

test('three-dimensional rectangles and ellipsoids gate in every dimension', () => {
  const view = makeView();
  let ws = createWorkspace('T');
  const dims = ['A', 'B', 'C'].map((channel) => ({ channel, transform: identity }));
  ws = addGates(ws, [
    { name: 'Box', parentId: null, type: 'rectangle', dims, geometry: { min: [500, 500, 300], max: [null, null, null] } },
    { name: 'Ball', parentId: null, type: 'ellipsoid', dims, geometry: { mean: [700, 700, 500], covariance: [[900, 0, 0], [0, 900, 0], [0, 0, 400]], distanceSquare: 4 } },
  ]).ws;
  const a = view.raw.get('A');
  const b = view.raw.get('B');
  const c = view.raw.get('C');
  let box = 0;
  let ball = 0;
  for (let e = 0; e < view.eventCount; e += 1) {
    if (a[e] >= 500 && b[e] >= 500 && c[e] >= 300) box += 1;
    if (((a[e] - 700) ** 2) / 900 + ((b[e] - 700) ** 2) / 900 + ((c[e] - 500) ** 2) / 400 <= 4) ball += 1;
  }
  assert.equal(population(view, ws, ws.gates[0].id).length, box);
  assert.equal(population(view, ws, ws.gates[1].id).length, ball);
  assert.ok(box > 800 && ball > 600);
  assert.equal(gateRobustness(view, ws, ws.gates[0].id), null);
});

test('workspaces serialize and parse', () => {
  let ws = createWorkspace('Round trip');
  ({ ws } = addGates(ws, [rectGate('High', null, [0.5, 0.5], [1, 1])]));
  const text = serializeWorkspace(ws);
  const back = parseWorkspace(text);
  assert.equal(back.name, 'Round trip');
  assert.equal(back.gates.length, 1);
  assert.throws(() => parseWorkspace('{"format":"other"}'), /not a CytoWeave workspace/);
});

test('comparison statistics use the control sample given by the context', () => {
  // The test sample: 25% of events express C; the control: none do.
  const view = makeView('test', 4000, 5);
  const random = createRandom(9);
  const n = 4000;
  const control = new SampleView({ id: 'fmo', name: 'fmo', keywords: {}, technology: 'conventional' }, {
    eventCount: n,
    parameters: [{ index: 0, name: 'A', type: 'scatter', range: 1000 }, { index: 1, name: 'B', type: 'scatter', range: 1000 }, { index: 2, name: 'C', type: 'fluorescence', range: 1000 }],
    data: [Float32Array.from({ length: n }, () => 200 + 30 * random.gaussian()), Float32Array.from({ length: n }, () => 200 + 30 * random.gaussian()), Float32Array.from({ length: n }, () => 10 * random.gaussian())],
  });
  const ws = createWorkspace('t');
  const context = { viewOf: (id) => (id === 'fmo' ? control : null) };
  const spec = (stat) => ({ stat, channel: 'C', control: { sampleId: 'fmo' } });
  assert.ok(Math.abs(computeStatistic(view, ws, spec('sed'), context) - 25) < 1);
  assert.ok(Math.abs(computeStatistic(view, ws, spec('overton'), context) - 25) < 1);
  assert.ok(computeStatistic(view, ws, spec('pbT'), context) > 4);
  assert.ok(Math.abs(computeStatistic(view, ws, spec('ksD'), context) - 0.25) < 0.02);
  // Without the control's events there is no value.
  assert.ok(Number.isNaN(computeStatistic(view, ws, spec('sed'), {})));
  // Rare-event statistics need no control: 4000 events, Poisson limits around them.
  const [lo, hi] = [computeStatistic(view, ws, { stat: 'countLow' }), computeStatistic(view, ws, { stat: 'countHigh' })];
  assert.ok(lo < 4000 && hi > 4000 && hi - lo < 300);
});

test('formula and calibrated channels are computed for the samples they apply to', () => {
  const view = makeView('s1');
  const other = makeView('s2');
  let ws = createWorkspace('t');
  ws = { ...ws, derived: [
    { id: 'f', kind: 'formula', inputs: ['A', 'B'], outputs: ['A over B'], params: { expression: '[A] / [B]' } },
    { id: 'c', kind: 'calibration', inputs: ['C'], outputs: ['C MEFL'], params: { m: 1, b: Math.log(40), unit: 'MEFL' }, samples: ['s1'] },
  ] };
  view.syncWorkspace(ws);
  other.syncWorkspace(ws);
  const ratio = view.column('A over B');
  const a = view.column('A');
  const b = view.column('B');
  for (const e of [0, 1, 777]) assert.ok(Math.abs(ratio[e] - a[e] / b[e]) < 1e-5 * Math.abs(ratio[e]));
  assert.equal(view.exactValue('A over B', 3), view.exactValue('A', 3) / view.exactValue('B', 3));
  assert.ok(Math.abs(view.column('C MEFL')[5] - 40 * view.column('C')[5]) < 1e-3);
  assert.equal(view.channelInfo('C MEFL').type, 'fluorescence');
  assert.equal(view.channelInfo('C MEFL').unit, 'MEFL');
  assert.ok(view.hasChannel('C MEFL'));
  assert.ok(!other.hasChannel('C MEFL'), 'the calibration applies to s1 only');
  assert.ok(other.hasChannel('A over B'));
});

test('absolute counts from counting beads, with a dilution from an annotation', () => {
  const view = makeView('s1');
  let ws = createWorkspace('t');
  ws = { ...ws, samples: [{ id: 's1', name: 's1', channels: [], meta: { dilution: '1:4' } }] };
  // "Beads": the second population (a quarter of the events); "cells": the rest.
  ({ ws } = addGates(ws, [rectGate('Beads', null, [0.5, 0.5], [1, 1]), rectGate('Cells', null, [0, 0], [0.5, 0.5])]));
  const [beads, cells] = ws.gates;
  const counting = { beadGateId: beads.id, beads: 50000, volume: 50 };
  // 3000 cells per 1000 beads × 1000 beads/µL = 3000 /µL, ×4 diluted.
  assert.equal(computeStatistic(view, ws, { stat: 'absoluteCount', gateId: cells.id, counting }), 3000);
  assert.equal(computeStatistic(view, ws, { stat: 'absoluteCount', gateId: cells.id, counting, dilution: { field: 'dilution' } }), 12000);
  assert.equal(computeStatistic(view, ws, { stat: 'absoluteCount', gateId: cells.id, counting, dilution: 2 }), 6000);
  assert.ok(Number.isNaN(computeStatistic(view, ws, { stat: 'absoluteCount', gateId: cells.id })));
});
