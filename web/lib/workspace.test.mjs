import assert from 'node:assert/strict';
import test from 'node:test';
import { addGates, createWorkspace, suggestFieldsFromNames } from './workspace.js';

test('fields suggested from file names follow what the parts look like', () => {
  const summary = (names) => suggestFieldsFromNames(names).map((f) => `${f.field}:${f.values.join('/')}`);
  // A zero-padded "D01" is a donor, not a day; the part with few words is the condition.
  assert.deepEqual(summary(['D01_Unstim.fcs', 'D01_Stim.fcs', 'D02_Unstim.fcs', 'D02_Stim.fcs']), ['subject:D01/D01/D02/D02', 'condition:Unstim/Stim/Unstim/Stim']);
  assert.deepEqual(summary(['B1_S01_Ctrl_d0.fcs', 'B1_S02_Case_d7.fcs', 'B2_S03_Ctrl_d0.fcs', 'B2_S04_Case_d7.fcs']), ['batch:B1/B1/B2/B2', 'subject:S01/S02/S03/S04', 'condition:Ctrl/Case/Ctrl/Case', 'timepoint:d0/d7/d0/d7']);
  assert.deepEqual(summary(['Patient3_24h_LPS', 'Patient3_0h_LPS', 'Patient4_24h_none']), ['subject:Patient3/Patient3/Patient4', 'timepoint:24h/0h/24h', 'condition:LPS/LPS/none']);
  assert.deepEqual(summary(['Ctrl_mouse1_spleen', 'KO_mouse2_spleen', 'Ctrl_mouse3_LN', 'KO_mouse4_LN']), ['condition:Ctrl/KO/Ctrl/KO', 'subject:mouse1/mouse2/mouse3/mouse4', 'tissue:spleen/spleen/LN/LN']);
  assert.deepEqual(summary(['A1 unstim rep1', 'A2 stim rep2']), ['subject:A1/A2', 'condition:unstim/stim', 'replicate:rep1/rep2']);
  assert.deepEqual(summary(['same.fcs', 'same.fcs']), []);
});

test('Boolean populations: combine gates, refuse cycles, and evaluate as all of / any of / none of', async () => {
  const { setBooleanGate, booleanCandidates, booleanName } = await import('./workspace.js');
  const { SampleView, populationSet, countOf } = await import('./engine.js');
  const lin = { type: 'linear', min: 0, max: 1 };
  const range = (name, lo, hi, parentId = null) => ({ name, parentId, type: 'range', dims: [{ channel: 'X', transform: lin }], geometry: { min: lo, max: hi } });
  let ws = createWorkspace('b');
  ws = addGates(ws, [range('Low', 0, 0.5), range('Middle', 0.25, 0.75)]).ws;
  const [low, middle] = ws.gates;
  const both = setBooleanGate(ws, { op: 'and', operands: [low.id, middle.id] });
  assert.equal(both.gate.name, 'Low and Middle');
  ws = both.ws;
  ws = setBooleanGate(ws, { op: 'or', operands: [low.id, middle.id] }).ws;
  ws = setBooleanGate(ws, { op: 'not', operands: [middle.id], name: 'Outside the middle' }).ws;
  assert.equal(booleanName(ws, 'not', [low.id, middle.id]), 'not Low or Middle');
  const X = Float32Array.from({ length: 100 }, (_, i) => i / 100);
  const view = new SampleView({ id: 's', name: 's' }, { eventCount: 100, parameters: [{ name: 'X', index: 0, type: 'fluorescence', range: 1 }], data: [X], keywords: {} });
  const count = (name) => countOf(populationSet(view, ws, ws.gates.find((g) => g.name === name).id), view);
  assert.equal(count('Low and Middle'), 25);
  assert.equal(count('Low or Middle'), 75);
  assert.equal(count('Outside the middle'), 50);
  // A gate under "Low and Middle" cannot become one of its operands; editing keeps the id.
  ws = addGates(ws, [range('Child', 0, 1, both.gate.id)]).ws;
  const child = ws.gates.find((g) => g.name === 'Child');
  assert.ok(!booleanCandidates(ws, both.gate.id).some((g) => g.id === child.id || g.id === both.gate.id));
  assert.throws(() => setBooleanGate(ws, { id: both.gate.id, op: 'and', operands: [child.id] }), /itself/);
  const edited = setBooleanGate(ws, { id: both.gate.id, op: 'or', operands: [low.id], name: 'Just low' });
  assert.equal(edited.gate.id, both.gate.id);
  assert.equal(countOf(populationSet(view, edited.ws, both.gate.id), view), 50);
  assert.throws(() => setBooleanGate(ws, { op: 'xor', operands: [low.id] }), /operator/);
});
