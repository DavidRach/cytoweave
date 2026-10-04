import assert from 'node:assert/strict';
import test from 'node:test';
import { addGates, createWorkspace, gateById, parseWorkspace, serializeWorkspace } from './workspace.js';
import { acceptProposal, dependentsOfProposal, describeProposal, heldChanges, openProposals, proposalHistory, proposalOfGate, proposeAnnotations, proposeCompensation, proposeDerived, proposedChannels, proposeFigure, proposeGateEdit, proposeGateRemoval, proposeGates, proposeRootGate, rejectProposal } from './proposals.js';

const rect = (name, parentId = null) => ({ name, parentId, type: 'rectangle', dims: [{ channel: 'A', transform: { type: 'linear', min: 0, max: 1 } }, { channel: 'B', transform: { type: 'linear', min: 0, max: 1 } }], geometry: { min: [0, 0], max: [0.5, 0.5] } });

function base() {
  let ws = createWorkspace('t');
  ws = { ...ws, samples: [{ id: 's1', name: 'S1' }, { id: 's2', name: 'S2' }] };
  const added = addGates(ws, [rect('Mine')]);
  return { ws: added.ws, mine: added.gates[0] };
}

test("an agent's gates are added at once, marked, and gathered in one proposal", () => {
  const { ws: start } = base();
  let { ws, gates } = proposeGates(start, 'Claude Code', [rect('Cells')]);
  const cells = gates[0];
  assert.equal(proposalOfGate(ws, gateById(ws, cells.id)), openProposals(ws)[0].id);
  ({ ws, gates } = proposeGates(ws, 'Claude Code', [rect('Singlets', cells.id)]));
  assert.equal(openProposals(ws).length, 1, 'one open proposal per author');
  assert.deepEqual(describeProposal(ws, openProposals(ws)[0]).map((i) => i.text), ['Add Cells', 'Add Singlets']);
  const other = proposeGates(ws, 'a script', [rect('Other')]).ws;
  assert.equal(openProposals(other).length, 2, 'another author has its own');
});

test('edits and deletions of existing gates wait for review; of proposed gates they apply at once', () => {
  const { ws: start, mine } = base();
  let ws = proposeGates(start, 'agent', [rect('Cells')]).ws;
  const cells = ws.gates.find((g) => g.name === 'Cells');
  let r = proposeGateEdit(ws, 'agent', mine.id, { name: 'Renamed' });
  assert.equal(r.held, true);
  assert.equal(gateById(r.ws, mine.id).name, 'Mine', 'not applied yet');
  assert.equal(heldChanges(r.ws, mine.id).length, 1);
  r = proposeGateEdit(r.ws, 'agent', cells.id, { name: 'Cells (FSC)' });
  assert.equal(r.held, false);
  assert.equal(gateById(r.ws, cells.id).name, 'Cells (FSC)');
  r = proposeGateRemoval(r.ws, 'agent', mine.id);
  assert.equal(r.held, true);
  assert.ok(gateById(r.ws, mine.id), 'still there until accepted');
  ws = r.ws;
  const texts = describeProposal(ws, openProposals(ws)[0]).map((i) => i.text);
  assert.deepEqual(texts, ['Add Cells (FSC)', 'Mine: rename to Renamed', 'Delete Mine']);
});

test('accepting applies everything and the change log says who proposed and who accepted', () => {
  const { ws: start, mine } = base();
  let ws = proposeGates(start, 'Claude Code', [rect('Cells')]).ws;
  ws = proposeGateEdit(ws, 'Claude Code', mine.id, { name: 'Renamed', color: '#123456' }).ws;
  ws = proposeCompensation(ws, 'Claude Code', { name: 'From controls', channels: ['A', 'B'], matrix: [1, 0.1, 0, 1] }, ['s1', 'missing']).ws;
  const id = openProposals(ws)[0].id;
  const accepted = acceptProposal(ws, id);
  assert.equal(openProposals(accepted).length, 0);
  const cells = accepted.gates.find((g) => g.name === 'Cells');
  assert.equal(cells.meta.proposal, undefined);
  assert.equal(cells.meta.proposedBy, 'Claude Code');
  assert.equal(cells.meta.acceptedBy, 'the user');
  assert.equal(gateById(accepted, mine.id).name, 'Renamed');
  assert.equal(accepted.compensations.length, 1);
  assert.equal(accepted.samples.find((s) => s.id === 's1').compensationId, accepted.compensations[0].id);
  assert.equal(accepted.samples.find((s) => s.id === 's2').compensationId, undefined);
  const [entry] = proposalHistory(accepted);
  assert.equal(entry.action, 'accept-proposal');
  assert.match(entry.detail, /Add Cells; Mine: rename to Renamed, change its color; Add the compensation matrix "From controls" \(2 channels\) and apply it to 1 sample — proposed by Claude Code, accepted by the user/);
});

test('rejecting removes the proposed gates (and what was drawn under them) and discards held changes', () => {
  const { ws: start, mine } = base();
  let ws = proposeGates(start, 'agent', [rect('Cells')]).ws;
  const cells = ws.gates.find((g) => g.name === 'Cells');
  ws = addGates(ws, [rect('Drawn by the user', cells.id)]).ws;
  ws = proposeGateRemoval(ws, 'agent', mine.id).ws;
  const id = openProposals(ws)[0].id;
  assert.deepEqual(dependentsOfProposal(ws, id).map((g) => g.name), ['Drawn by the user']);
  const rejected = rejectProposal(ws, id);
  assert.deepEqual(rejected.gates.map((g) => g.name), ['Mine']);
  assert.equal(openProposals(rejected).length, 0);
  assert.match(proposalHistory(rejected)[0].detail, /rejected by the user/);
});

test('a gate the user deletes leaves its proposal; proposals survive saving', () => {
  const { ws: start } = base();
  let ws = proposeGates(start, 'agent', [rect('Cells'), rect('Debris')]).ws;
  const again = parseWorkspace(serializeWorkspace(ws));
  assert.equal(openProposals(again).length, 1);
  const debris = ws.gates.find((g) => g.name === 'Debris');
  ws = { ...ws, gates: ws.gates.filter((g) => g.id !== debris.id) };
  assert.deepEqual(describeProposal(ws, openProposals(ws)[0]).map((i) => i.text), ['Add Cells']);
  const accepted = acceptProposal(ws, openProposals(ws)[0].id);
  assert.match(proposalHistory(accepted)[0].detail, /^Add Cells —/);
});

test('computed results and figures are added at once, marked; rejecting removes them and names the gates on their channels', () => {
  const { ws: start } = base();
  let { ws, derived } = proposeDerived(start, 'agent', { kind: 'clustering', name: 'FlowSOM clusters', method: 'FlowSOM', outputs: ['FlowSOM'], files: {} });
  assert.equal(ws.derived.length, 1);
  assert.equal(ws.derived[0].proposal, openProposals(ws)[0].id);
  ({ ws } = proposeFigure(ws, 'agent', { name: 'Gating strategy', width: 1600, height: 900, background: '#fff', items: [{ id: 'i1', kind: 'plot' }] }));
  assert.equal(ws.figures.length, 1);
  assert.deepEqual(describeProposal(ws, openProposals(ws)[0]).map((i) => i.text), ['Add FlowSOM clusters (channel FlowSOM)', 'Add the figure "Gating strategy" (1 plots)']);
  // The user gates on the proposed clusters: rejecting would leave that gate without its channel.
  ws = addGates(ws, [{ name: 'Cluster 3', parentId: null, type: 'category', dims: [{ channel: 'FlowSOM' }], geometry: { values: [3] } }]).ws;
  const id = openProposals(ws)[0].id;
  assert.deepEqual(dependentsOfProposal(ws, id).map((g) => g.name), ['Cluster 3']);
  assert.deepEqual(proposedChannels(ws, id), ['FlowSOM']);
  const rejected = rejectProposal(ws, id);
  assert.equal(rejected.derived.length, 0);
  assert.equal(rejected.figures.length, 0);
  const accepted = acceptProposal(ws, id);
  assert.equal(accepted.derived[0].proposal, undefined);
  assert.equal(accepted.derived[0].proposedBy, 'agent');
  assert.equal(accepted.figures[0].proposal, undefined);
  assert.equal(derived.id, accepted.derived[0].id);
});

test('sample annotations wait for review and merge; null removes a field', () => {
  const { ws: start } = base();
  let ws = { ...start, samples: start.samples.map((x) => ({ ...x, role: 'sample', meta: { batch: '1' } })) };
  ws = proposeAnnotations(ws, 'agent', { s1: { meta: { condition: 'stim' } }, s2: { meta: { condition: 'unstim' }, role: 'single-stain', stain: 'FITC-A' } }).ws;
  ws = proposeAnnotations(ws, 'agent', { s1: { meta: { batch: null, donor: 'D1' } } }).ws;
  assert.equal(ws.samples[0].meta.condition, undefined, 'not applied yet');
  assert.deepEqual(describeProposal(ws, openProposals(ws)[0]).map((i) => i.text), ['Annotate 2 samples (condition, batch, donor, role, stained channel)']);
  const accepted = acceptProposal(ws, openProposals(ws)[0].id);
  assert.deepEqual(accepted.samples[0].meta, { condition: 'stim', donor: 'D1' });
  assert.equal(accepted.samples[1].role, 'single-stain');
  assert.equal(accepted.samples[1].stain, 'FITC-A');
  assert.deepEqual(accepted.samples[1].meta, { batch: '1', condition: 'unstim' });
});

test('a gate at the top of the tree waits for review; accepting moves every population beneath it', () => {
  const { ws: start, mine } = base();
  let ws = proposeRootGate(start, 'agent', { name: 'QC pass', type: 'category', dims: [{ channel: 'QC pass' }], geometry: { values: [1] } }).ws;
  assert.equal(ws.gates.length, 1, 'held');
  assert.match(describeProposal(ws, openProposals(ws)[0])[0].text, /QC pass at the top of the gating tree/);
  ws = acceptProposal(ws, openProposals(ws)[0].id);
  const qc = ws.gates.find((g) => g.name === 'QC pass');
  assert.equal(qc.parentId, null);
  assert.equal(gateById(ws, mine.id).parentId, qc.id);
  assert.equal(qc.meta.acceptedBy, 'the user');
});

test('an accepted result of more samples joins the result of the same kind and channels', () => {
  const { ws: start } = base();
  let ws = { ...start, derived: [{ id: 'd1', kind: 'qc', name: 'Acquisition QC', outputs: ['QC pass'], files: { s1: { 'QC pass': { sha256: 'a', length: 1 } } }, summary: { perSample: { s1: { score: 90 } } } }] };
  ws = proposeDerived(ws, 'agent', { kind: 'qc', name: 'Acquisition QC', outputs: ['QC pass'], files: { s2: { 'QC pass': { sha256: 'b', length: 1 } } }, summary: { perSample: { s2: { score: 70 } } } }).ws;
  ws = acceptProposal(ws, openProposals(ws)[0].id);
  assert.equal(ws.derived.length, 1);
  assert.deepEqual(Object.keys(ws.derived[0].files), ['s1', 's2']);
  assert.deepEqual(Object.keys(ws.derived[0].summary.perSample), ['s1', 's2']);
});
