import assert from 'node:assert/strict';
import test from 'node:test';
import { addGates, createWorkspace } from './workspace.js';
import { gatingStrategyFigure, samplesGridFigure } from './figures.js';

const dims2 = [{ channel: 'FSC-A', transform: { type: 'linear', min: 0, max: 1 } }, { channel: 'SSC-A', transform: { type: 'linear', min: 0, max: 1 } }];

function workspace() {
  let ws = { ...createWorkspace('t'), samples: [{ id: 's1', name: 'S1', acquisition: { cytometer: 'Fortessa' } }, { id: 's2', name: 'S2' }] };
  const cells = addGates(ws, [{ name: 'Cells', parentId: null, type: 'rectangle', dims: dims2, geometry: { min: [0, 0], max: [1, 1] } }]);
  ws = cells.ws;
  ws = addGates(ws, [{ name: 'CD3+', parentId: cells.gates[0].id, type: 'range', dims: [{ channel: 'CD3', transform: { type: 'linear', min: 0, max: 1 } }], geometry: { min: 0.5, max: null } }]).ws;
  return ws;
}

test('the gating strategy shows each gate on its parent, with arrows between', () => {
  const ws = workspace();
  const cd3 = ws.gates.find((g) => g.name === 'CD3+');
  const fig = gatingStrategyFigure(ws, cd3.id, 's1');
  const plots = fig.items.filter((i) => i.kind === 'plot');
  assert.equal(fig.name, 'Gating strategy – CD3+');
  assert.deepEqual(plots.map((p) => [p.title, p.spec.x, p.spec.y, p.spec.type]), [['All events', 'FSC-A', 'SSC-A', 'pseudocolor'], ['Cells', 'CD3', null, 'histogram']]);
  assert.equal(fig.items.filter((i) => i.kind === 'arrow').length, 1);
  assert.match(fig.items[1].text, /S1 · Fortessa/);
});

test('a grid of plots across samples has a row per sample', () => {
  const ws = workspace();
  const fig = samplesGridFigure(ws, null, [{ x: 'FSC-A', y: 'SSC-A', type: 'dot' }, { x: 'CD3' }], ws.samples, 'Stimulated');
  assert.equal(fig.items.filter((i) => i.kind === 'plot').length, 4);
  assert.equal(fig.items[0].text, 'All events across Stimulated');
  assert.equal(fig.items.find((i) => i.kind === 'plot' && i.spec.x === 'CD3').spec.type, 'histogram');
  assert.throws(() => samplesGridFigure(ws, null, [], ws.samples), /No plots/);
});
