import assert from 'node:assert/strict';
import test from 'node:test';
import { LOG_LIMIT, addGates, appendLog, canonicalJSON, createWorkspace, guessRole, parseWorkspace, rename, serializeWorkspace, suggestFieldsFromNames, verifyLog } from './workspace.js';

test('roles are guessed from file names, with underscores as separators', () => {
  assert.equal(guessRole('Beads_2026-03-27.fcs'), 'bead');
  assert.equal(guessRole('CS&T beads.fcs'), 'bead');
  assert.equal(guessRole('Comp_FITC.fcs'), 'single-stain');
  assert.equal(guessRole('Unstained_01.fcs'), 'unstained');
  assert.equal(guessRole('FMO_CD25.fcs'), 'fmo');
  assert.equal(guessRole('D01_Stim.fcs'), 'sample');
  assert.equal(guessRole('Compound_A_well3.fcs'), 'sample', 'a word that merely starts with comp');
});

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

test('several samples annotated at once: values set, an empty value removing the field', async () => {
  const { annotateSamples, createWorkspace } = await import('./workspace.js');
  let ws = createWorkspace('Plate');
  ws = { ...ws, samples: [{ id: 'a', name: 'A01', meta: { compound: 'X', dose: '1 nM' } }, { id: 'b', name: 'A02', meta: {} }, { id: 'c', name: 'A03', meta: { compound: 'Y' } }] };
  const next = annotateSamples(ws, { a: { compound: 'CW-1', dose: '' }, b: { compound: 'CW-1', dose: 10 } }, 'layout');
  assert.deepEqual(next.samples.map((s) => s.meta), [{ compound: 'CW-1' }, { compound: 'CW-1', dose: '10' }, { compound: 'Y' }]);
  assert.equal(next.samples[2], ws.samples[2]);
  assert.equal(next.provenance.at(-1).action, 'annotate');
});

test('the change log is hash-chained: an entry changed, removed or reordered breaks the chain', () => {
  let ws = createWorkspace('Chain');
  for (let i = 0; i < 5; i += 1) ws = rename(ws, `Chain ${i}`);
  ws = rename(ws, 'Chained');
  const ok = verifyLog(ws);
  assert.equal(ok.ok, true);
  assert.equal(ok.entries, 7);
  assert.equal(ok.head, ws.provenance[6].hash);
  // Through JSON, as saved and opened.
  assert.equal(verifyLog(parseWorkspace(serializeWorkspace(ws))).ok, true);
  const changed = { ...ws, provenance: ws.provenance.map((e, i) => (i === 2 ? { ...e, detail: 'something else' } : e)) };
  assert.deepEqual(verifyLog(changed).broken.map((b) => b.index), [2], "only the changed entry");
  const removed = { ...ws, provenance: ws.provenance.filter((_, i) => i !== 3) };
  assert.equal(verifyLog(removed).broken[0].index, 3);
  const swapped = { ...ws, provenance: [ws.provenance[0], ws.provenance[2], ws.provenance[1], ...ws.provenance.slice(3)] };
  assert.equal(verifyLog(swapped).broken[0].index, 1);
  const retimed = { ...ws, provenance: ws.provenance.map((e, i) => (i === 6 ? { ...e, time: '2020-01-01T00:00:00.000Z' } : e)) };
  assert.equal(verifyLog(retimed).ok, false);
});

test('beyond its limit the log keeps the last hash dropped as its anchor', () => {
  let ws = createWorkspace('Long');
  let log = { provenance: ws.provenance };
  for (let i = 0; i < LOG_LIMIT + 3; i += 1) log = { ...log, ...appendLog(log, 'edit', `step ${i}`, '2026-10-07T00:00:00.000Z') };
  ws = { ...ws, ...log };
  assert.equal(ws.provenance.length, LOG_LIMIT);
  assert.equal(typeof ws.provenanceAnchor, 'string');
  const result = verifyLog(ws);
  assert.equal(result.ok, true);
  assert.equal(result.anchor, ws.provenanceAnchor);
  assert.equal(verifyLog({ ...ws, provenanceAnchor: '0'.repeat(64) }).broken[0].index, 0);
});

test('a log written before chaining is chained at the next change, and says how many entries were sealed', () => {
  const old = { ...createWorkspace('Old'), provenance: [{ time: '2026-01-01T00:00:00.000Z', action: 'create', detail: 'Old' }, { time: '2026-01-02T00:00:00.000Z', action: 'add-gate', detail: 'Lymphocytes' }] };
  assert.equal(verifyLog(old).ok, false);
  const next = rename(old, 'Now chained');
  const result = verifyLog(next);
  assert.equal(result.ok, true);
  assert.equal(result.entries, 3);
  assert.equal(next.provenanceSealed.entries, 2);
  assert.equal(next.provenance[0].detail, 'Old');
});

test('canonical JSON sorts keys at every level and drops undefined', () => {
  assert.equal(canonicalJSON({ b: 1, a: { d: [1, { z: 1, y: undefined }], c: 'x' } }), '{"a":{"c":"x","d":[1,{"z":1}]},"b":1}');
  assert.equal(canonicalJSON([undefined, 2.5, null]), '[null,2.5,null]');
});
