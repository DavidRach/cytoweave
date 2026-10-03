// Proposals: changes an AI agent (or another program) makes arrive for the user to review, and are
// accepted or rejected as a group. The workspace keeps the open proposals (ws.proposals); its
// change log records who proposed each one and who accepted or rejected it.
//
// How each kind of change waits for review:
//   - New gates are added to the workspace at once, marked as proposed (gate.meta.proposal), so
//     they show on plots with real counts and the agent can gate on them. Rejecting removes them.
//   - Edits and deletions of existing gates, and compensation matrices, are held in the proposal
//     and only applied when it is accepted. (Editing or deleting a gate that is itself still
//     proposed applies at once: it is part of the same proposal.)
//
// A proposal: { id, author, opened, changes: [...] }, a change being one of
//   { kind: 'add-gates', gateIds }
//   { kind: 'edit-gate', gateId, patch, name }        (name: the gate's name when proposed)
//   { kind: 'remove-gate', gateId, name }
//   { kind: 'add-compensation', compensation, sampleIds }

import { newId } from './gates.js';
import { addCompensation, addGates, gateById, gateDescendants, removeGate, setSampleCompensation, updateGate } from './workspace.js';

const now = () => new Date().toISOString();

function log(ws, action, detail) {
  return { ...ws, modified: now(), provenance: [...(ws.provenance ?? []), { time: now(), action, detail }].slice(-5000) };
}

export function openProposals(ws) {
  return ws.proposals ?? [];
}

export function proposalById(ws, id) {
  return openProposals(ws).find((p) => p.id === id) ?? null;
}

// The id of the proposal a gate was added by, while it is open; null otherwise.
export function proposalOfGate(ws, gate) {
  const id = gate?.meta?.proposal;
  return id && proposalById(ws, id) ? id : null;
}

// Changes held for a gate (an edit or a deletion), for the population tree to show.
export function heldChanges(ws, gateId) {
  const out = [];
  for (const proposal of openProposals(ws)) {
    for (const change of proposal.changes) {
      if ((change.kind === 'edit-gate' || change.kind === 'remove-gate') && change.gateId === gateId) out.push({ proposal, change });
    }
  }
  return out;
}

// The open proposal of an author, or a new one. Returns { ws, proposal }.
export function openProposal(ws, author) {
  const existing = openProposals(ws).find((p) => p.author === author);
  if (existing) return { ws, proposal: existing };
  const proposal = { id: newId('p'), author, opened: now(), changes: [] };
  return { ws: log({ ...ws, proposals: [...openProposals(ws), proposal] }, 'open-proposal', author), proposal };
}

function withChange(ws, proposalId, change, merge) {
  const proposals = openProposals(ws).map((p) => {
    if (p.id !== proposalId) return p;
    const changes = p.changes.slice();
    const at = merge ? changes.findIndex(merge) : -1;
    if (at >= 0) changes[at] = change;
    else changes.push(change);
    return { ...p, changes };
  });
  return { ...ws, proposals };
}

// Adds gates as part of a proposal (by its author). gates as for addGates. Returns { ws, gates }.
export function proposeGates(ws, author, gates) {
  const opened = openProposal(ws, author);
  const { proposal } = opened;
  const marked = gates.map((g) => ({ ...g, meta: { origin: 'agent', ...(g.meta ?? {}), proposal: proposal.id, proposedBy: author, created: now() } }));
  const added = addGates(opened.ws, marked, 'propose-gates');
  const ids = added.gates.map((g) => g.id);
  const previous = proposal.changes.find((c) => c.kind === 'add-gates');
  const next = withChange(added.ws, proposal.id, { kind: 'add-gates', gateIds: [...(previous?.gateIds ?? []), ...ids] }, (c) => c.kind === 'add-gates');
  return { ws: next, gates: added.gates, proposal: proposalById(next, proposal.id) };
}

// An edit ({ name, color, ... }) of a gate, held for review unless the gate is itself proposed.
export function proposeGateEdit(ws, author, gateId, patch) {
  const gate = gateById(ws, gateId);
  if (!gate) throw new Error(`No gate ${gateId}.`);
  if (proposalOfGate(ws, gate)) return { ws: updateGate(ws, gateId, patch, 'edit-proposed-gate'), held: false };
  const { ws: opened, proposal } = openProposal(ws, author);
  const earlier = proposal.changes.find((c) => c.kind === 'edit-gate' && c.gateId === gateId);
  const change = { kind: 'edit-gate', gateId, name: gate.name, patch: { ...(earlier?.patch ?? {}), ...patch } };
  return { ws: log(withChange(opened, proposal.id, change, (c) => c.kind === 'edit-gate' && c.gateId === gateId), 'propose-edit', gate.name), held: true };
}

// A deletion of a gate (with its descendants), held for review unless the gate is itself proposed.
export function proposeGateRemoval(ws, author, gateId) {
  const gate = gateById(ws, gateId);
  if (!gate) throw new Error(`No gate ${gateId}.`);
  if (proposalOfGate(ws, gate)) return { ws: forgetGates(removeGate(ws, gateId), ws), held: false };
  const { ws: opened, proposal } = openProposal(ws, author);
  const change = { kind: 'remove-gate', gateId, name: gate.name };
  return { ws: log(withChange(opened, proposal.id, change, (c) => c.kind === 'remove-gate' && c.gateId === gateId), 'propose-removal', gate.name), held: true };
}

// A compensation matrix ({ name, channels, matrix, source, report }) for the given samples.
export function proposeCompensation(ws, author, compensation, sampleIds) {
  const { ws: opened, proposal } = openProposal(ws, author);
  const change = { kind: 'add-compensation', compensation: { ...compensation, id: compensation.id ?? newId('c'), matrix: Array.from(compensation.matrix) }, sampleIds: sampleIds.slice() };
  return { ws: log(withChange(opened, proposal.id, change, null), 'propose-compensation', compensation.name ?? 'Compensation'), proposal: proposalById(opened, proposal.id) };
}

// Drops from the open proposals the ids of gates that no longer exist (removed by the user, or
// with their parents).
function forgetGates(ws) {
  const ids = new Set(ws.gates.map((g) => g.id));
  const proposals = openProposals(ws).map((p) => ({
    ...p,
    changes: p.changes
      .map((c) => (c.kind === 'add-gates' ? { ...c, gateIds: c.gateIds.filter((id) => ids.has(id)) } : c))
      .filter((c) => (c.kind === 'add-gates' ? c.gateIds.length > 0 : c.kind === 'add-compensation' || ids.has(c.gateId))),
  }));
  return { ...ws, proposals };
}

// What a proposal does, item by item, in words, for the review queue and the agent.
export function describeProposal(ws, proposal) {
  const items = [];
  for (const change of proposal.changes) {
    if (change.kind === 'add-gates') {
      for (const id of change.gateIds) {
        const gate = gateById(ws, id);
        if (gate) items.push({ kind: 'add', gateId: id, text: `Add ${gate.name}` });
      }
    } else if (change.kind === 'edit-gate') {
      const gate = gateById(ws, change.gateId);
      const parts = [];
      if (change.patch.name !== undefined && change.patch.name !== gate?.name) parts.push(`rename to ${change.patch.name}`);
      if (change.patch.color !== undefined && change.patch.color !== gate?.color) parts.push('change its color');
      items.push({ kind: 'edit', gateId: change.gateId, text: `${gate?.name ?? change.name}: ${parts.join(', ') || 'no change'}` });
    } else if (change.kind === 'remove-gate') {
      const below = gateById(ws, change.gateId) ? gateDescendants(ws, change.gateId).length : 0;
      items.push({ kind: 'remove', gateId: change.gateId, text: `Delete ${change.name}${below ? ` and the ${below} population${below === 1 ? '' : 's'} under it` : ''}` });
    } else if (change.kind === 'add-compensation') {
      const samples = change.sampleIds.filter((id) => (ws.samples ?? []).some((s) => s.id === id)).length;
      items.push({ kind: 'compensation', text: `Add the compensation matrix "${change.compensation.name}" (${change.compensation.channels.length} channels) and apply it to ${samples} sample${samples === 1 ? '' : 's'}` });
    }
  }
  return items;
}

// Applies a proposal's held changes and keeps its gates, recording who accepted it.
export function acceptProposal(ws, proposalId, acceptedBy = 'the user') {
  const proposal = proposalById(ws, proposalId);
  if (!proposal) return ws;
  let next = ws;
  const time = now();
  for (const change of proposal.changes) {
    if (change.kind === 'add-gates') {
      const ids = new Set(change.gateIds);
      next = { ...next, gates: next.gates.map((g) => (ids.has(g.id) ? { ...g, meta: { ...withoutProposal(g.meta), proposedBy: proposal.author, acceptedBy, accepted: time } } : g)) };
    } else if (change.kind === 'edit-gate' && gateById(next, change.gateId)) {
      next = updateGate(next, change.gateId, change.patch, 'edit-gate');
    } else if (change.kind === 'remove-gate' && gateById(next, change.gateId)) {
      next = removeGate(next, change.gateId);
    } else if (change.kind === 'add-compensation') {
      const added = addCompensation(next, { ...change.compensation, source: change.compensation.source ?? 'agent' });
      next = setSampleCompensation(added.ws, change.sampleIds.filter((id) => next.samples.some((s) => s.id === id)), added.compensation.id);
    }
  }
  next = forgetGates({ ...next, proposals: openProposals(next).filter((p) => p.id !== proposalId) });
  return log(next, 'accept-proposal', `${summary(ws, proposal)} — proposed by ${proposal.author}, accepted by ${acceptedBy}`);
}

// Drops a proposal: its gates (and anything since drawn under them) are removed and its held
// changes discarded, recording who rejected it.
export function rejectProposal(ws, proposalId, rejectedBy = 'the user') {
  const proposal = proposalById(ws, proposalId);
  if (!proposal) return ws;
  let next = ws;
  for (const change of proposal.changes) {
    if (change.kind !== 'add-gates') continue;
    for (const id of change.gateIds) if (gateById(next, id)) next = removeGate(next, id);
  }
  next = forgetGates({ ...next, proposals: openProposals(next).filter((p) => p.id !== proposalId) });
  return log(next, 'reject-proposal', `${summary(ws, proposal)} — proposed by ${proposal.author}, rejected by ${rejectedBy}`);
}

// Gates the user drew under a proposed gate, which rejecting the proposal would also remove.
export function dependentsOfProposal(ws, proposalId) {
  const proposal = proposalById(ws, proposalId);
  if (!proposal) return [];
  const proposed = new Set(proposal.changes.flatMap((c) => (c.kind === 'add-gates' ? c.gateIds : [])));
  const out = [];
  for (const id of proposed) for (const g of gateDescendants(ws, id)) if (!proposed.has(g.id)) out.push(g);
  return out;
}

function withoutProposal(meta = {}) {
  const { proposal, ...rest } = meta;
  return rest;
}

function summary(ws, proposal) {
  const items = describeProposal(ws, proposal);
  return items.length ? items.map((i) => i.text).join('; ') : 'nothing';
}

// The record of proposals resolved so far (from the change log), newest first.
export function proposalHistory(ws, limit = 20) {
  return (ws.provenance ?? []).filter((e) => e.action === 'accept-proposal' || e.action === 'reject-proposal').slice(-limit).reverse();
}
