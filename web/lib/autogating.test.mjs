import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateExample } from './examples.js';
import { parseFCS, readSpillover } from './fcs.js';
import { SampleView } from './engine.js';
import { createWorkspace, addGates, addSamples, sampleFromDataset, setGateGeometry, updateGate } from './workspace.js';
import { adaptAcrossSamples, autogatingRecord, cannotAdapt, exemplarsOf } from './autogating.js';
import { acceptProposal, describeProposal, openProposals, proposeGateAdjustments } from './proposals.js';

function setup() {
  const { files, workspaceHints } = generateExample('pbmc-immunophenotyping', { samples: ['D01_Unstim.fcs', 'D01_Stim.fcs', 'D02_Unstim.fcs', 'D02_Stim.fcs'], scale: 0.08 });
  let ws = createWorkspace('autogating');
  const views = new Map();
  for (const file of files.filter((f) => /^D0/.test(f.name))) {
    const data = parseFCS(file.bytes).datasets[0];
    const record = sampleFromDataset(data, { name: file.name });
    ws = addSamples(ws, [record]);
    const view = new SampleView(record, data);
    const spill = readSpillover(data.keywords, data.parameters);
    view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
    views.set(record.id, view);
  }
  ws = addGates(ws, workspaceHints.suggestedGates).ws;
  return { ws, views };
}

test('exemplars: adjusted, confirmed and drawn samples, or a chosen one', () => {
  let { ws, views } = setup();
  const [a, b, c] = ws.samples;
  const lymph = ws.gates.find((g) => g.name === 'Lymphocytes');
  // No record of where it was drawn: one sample is chosen.
  let ex = exemplarsOf(ws, lymph, views);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].kind, 'chosen');
  ws = updateGate(ws, lymph.id, { meta: { ...lymph.meta, drawnOn: a.id, confirmed: { [c.id]: true } } });
  ws = setGateGeometry(ws, lymph.id, { vertices: lymph.geometry.vertices.map(([x, y]) => [x + 0.01, y]) }, { sampleId: b.id });
  ex = exemplarsOf(ws, ws.gates.find((g) => g.id === lymph.id), views);
  assert.deepEqual(ex.map((e) => `${e.kind}:${e.sampleId}`).sort(), [`adjusted:${b.id}`, `confirmed:${c.id}`, `drawn:${a.id}`].sort());
  assert.equal(cannotAdapt({ type: 'boolean', dims: [] }), 'boolean gates cannot be adapted');
});

test('a gate is adapted to every other sample, with a confidence and a status each', () => {
  let { ws, views } = setup();
  const t = ws.gates.find((g) => g.name === 'T cells');
  ws = updateGate(ws, t.id, { meta: { ...t.meta, drawnOn: ws.samples[0].id } });
  const run = adaptAcrossSamples(ws, t.id, views);
  assert.equal(run.exemplars.length, 1);
  assert.equal(run.results.length, 3);
  for (const r of run.results) {
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
    assert.ok(['keep', 'adjust', 'review'].includes(r.status));
    assert.equal(r.probabilities.length > 0, true);
  }
  // Same instrument, same gate: nothing to change.
  assert.ok(run.results.every((r) => r.status === 'keep'), JSON.stringify(run.results.map((r) => [r.status, r.confidence])));
  const record = autogatingRecord(ws, t, run, [], 'test');
  assert.equal(record.kind, 'autogating');
  assert.equal(Object.keys(record.results).length, 3);
});

test('an agent\'s adjustments are held until accepted', () => {
  let { ws } = setup();
  const t = ws.gates.find((g) => g.name === 'T cells');
  const sample = ws.samples[1].id;
  const record = { kind: 'autogating', name: 'Autogating of T cells', gateId: t.id, results: { [sample]: { status: 'adjust', confidence: 0.93, applied: true } } };
  const proposed = proposeGateAdjustments(ws, 'Claude Code', t.id, { [sample]: { min: 0.62, max: null } }, { [sample]: 0.93 }, record);
  assert.equal(proposed.held, true);
  ws = proposed.ws;
  assert.equal(ws.gates.find((g) => g.id === t.id).overrides?.[sample], undefined, 'not applied yet');
  assert.equal(ws.derived.length, 0, 'not recorded yet');
  const proposal = openProposals(ws)[0];
  assert.match(describeProposal(ws, proposal)[0].text, /Adjust T cells for 1 sample/);
  ws = acceptProposal(ws, proposal.id);
  assert.deepEqual(ws.gates.find((g) => g.id === t.id).overrides[sample], { min: 0.62, max: null });
  assert.equal(ws.derived.find((d) => d.kind === 'autogating')?.gateId, t.id, 'the autogating record is kept on accepting');
});

test('one gate per group: a group with an exemplar shares its gate, and a group is decided as one', () => {
  let { ws, views } = setup();
  const [a, b, c, d] = ws.samples;
  ws = { ...ws, samples: ws.samples.map((s, i) => ({ ...s, meta: { ...s.meta, donor: i < 2 ? 'D1' : 'D2' } })) };
  const lymph = ws.gates.find((g) => g.name === 'Lymphocytes');
  // The gate was adjusted on a (donor D1): b, of the same donor, takes that gate as it is.
  const moved = { vertices: lymph.geometry.vertices.map(([x, y]) => [x + 0.06, y]) };
  ws = setGateGeometry(ws, lymph.id, moved, { sampleId: a.id });
  const run = adaptAcrossSamples(ws, lymph.id, views, { groupBy: 'donor' });
  assert.equal(run.groupBy, 'donor');
  const byId = new Map(run.results.map((r) => [r.sampleId, r]));
  assert.deepEqual(byId.get(b.id).geometry, moved);
  assert.equal(byId.get(b.id).status, 'adjust');
  assert.match(byId.get(b.id).reason, /same donor/);
  // c and d (donor D2) are adapted together: one gate, one decision.
  assert.deepEqual(byId.get(c.id).geometry, byId.get(d.id).geometry);
  assert.equal(byId.get(c.id).confidence, byId.get(d.id).confidence);
  assert.equal(byId.get(c.id).probabilities.length, byId.get(c.id).list.length);
});
