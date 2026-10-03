import assert from 'node:assert/strict';
import test from 'node:test';
import { addGates, createWorkspace, gateById, parseWorkspace, serializeWorkspace } from './workspace.js';
import { acceptProposal, dependentsOfProposal, describeProposal, heldChanges, openProposals, proposalHistory, proposalOfGate, proposeCompensation, proposeGateEdit, proposeGateRemoval, proposeGates, rejectProposal } from './proposals.js';

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
