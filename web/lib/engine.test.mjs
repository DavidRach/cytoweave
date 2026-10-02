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

test('workspaces serialize and parse', () => {
  let ws = createWorkspace('Round trip');
  ({ ws } = addGates(ws, [rectGate('High', null, [0.5, 0.5], [1, 1])]));
  const text = serializeWorkspace(ws);
  const back = parseWorkspace(text);
  assert.equal(back.name, 'Round trip');
  assert.equal(back.gates.length, 1);
  assert.throws(() => parseWorkspace('{"format":"other"}'), /not a CytoWeave workspace/);
});
