// Proposals: changes an AI agent (or another program) makes arrive for the user to review, and are
// accepted or rejected as a group. The workspace keeps the open proposals (ws.proposals); its
// change log records who proposed each one and who accepted or rejected it.
//
// How each kind of change waits for review:
//   - New gates are added to the workspace at once, marked as proposed (gate.meta.proposal), so
//     they show on plots with real counts and the agent can gate on them. Rejecting removes them.
//   - Computed results (QC masks, unmixed channels, clusters, maps) and figures are also added at
//     once, marked as proposed (record.proposal), so their channels can be gated and plotted.
//     Rejecting removes them.
//   - Edits and deletions of existing gates, compensation matrices, sample annotations and a gate
//     inserted at the top of the tree are held in the proposal and only applied when it is
//     accepted. (Editing or deleting a gate that is itself still proposed applies at once: it is
//     part of the same proposal.)
//
// A proposal: { id, author, opened, changes: [...] }, a change being one of
//   { kind: 'add-gates', gateIds }
//   { kind: 'edit-gate', gateId, patch, name }        (name: the gate's name when proposed)
//   { kind: 'remove-gate', gateId, name }
//   { kind: 'add-compensation', compensation, sampleIds }
//   { kind: 'adjust-gate', gateId, name, overrides: { sampleId: geometry }, confidence: { sampleId },
//     record }                                         (per-sample adjustments, as from autogating,
//                                                      with the autogating record kept on accepting)
//   { kind: 'add-derived', derivedIds }               (computed results, added at once)
//   { kind: 'add-figure', figureIds }                 (figure pages, added at once)
//   { kind: 'annotate-samples', samples: { sampleId: { meta: { field: value }, role, stain } } }
//   { kind: 'insert-root-gate', gate }                (a gate above the whole tree, as "QC pass")

import { newId } from './gates.js';
import { addCompensation, addDerived, addGates, gateById, gateDescendants, insertRootGate, removeDerived, removeGate, setCollection, setGateGeometry, setSampleCompensation, updateGate } from './workspace.js';

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

// Per-sample adjustments of a gate ({ sampleId: geometry }, with a confidence per sample), held for
// review. Adjusting a gate that is itself still proposed applies at once.
export function proposeGateAdjustments(ws, author, gateId, overrides, confidence = {}, record = null) {
  const gate = gateById(ws, gateId);
  if (!gate) throw new Error(`No gate ${gateId}.`);
  if (proposalOfGate(ws, gate)) {
    let next = ws;
    for (const [sampleId, geometry] of Object.entries(overrides)) next = setGateGeometry(next, gateId, geometry, { sampleId });
    if (record) next = addDerived(next, record).ws;
    return { ws: next, held: false };
  }
  const { ws: opened, proposal } = openProposal(ws, author);
  const earlier = proposal.changes.find((c) => c.kind === 'adjust-gate' && c.gateId === gateId);
  const kept = record ?? earlier?.record;
  const change = { kind: 'adjust-gate', gateId, name: gate.name, overrides: { ...(earlier?.overrides ?? {}), ...overrides }, confidence: { ...(earlier?.confidence ?? {}), ...confidence }, ...(kept ? { record: kept } : {}) };
  return { ws: log(withChange(opened, proposal.id, change, (c) => c.kind === 'adjust-gate' && c.gateId === gateId), 'propose-adjustments', `${gate.name} (${Object.keys(overrides).length} samples)`), held: true };
}

// A computed result (a derived record: QC masks, unmixed channels, clusters, a map), added at once
// and marked as proposed. Returns { ws, derived }.
export function proposeDerived(ws, author, record) {
  const { ws: opened, proposal } = openProposal(ws, author);
  const added = addDerived(opened, { ...record, proposal: proposal.id, proposedBy: author });
  const previous = proposal.changes.find((c) => c.kind === 'add-derived');
  const ids = [...(previous?.derivedIds ?? []).filter((id) => id !== added.derived.id), added.derived.id];
  return { ws: withChange(added.ws, proposal.id, { kind: 'add-derived', derivedIds: ids }, (c) => c.kind === 'add-derived'), derived: added.derived };
}

// A figure page ({ id, name, width, height, background, items }), added at once and marked as
// proposed. Returns { ws, figure }.
export function proposeFigure(ws, author, figure) {
  const { ws: opened, proposal } = openProposal(ws, author);
  const marked = { ...figure, id: figure.id ?? newId('f'), proposal: proposal.id, proposedBy: author };
  const added = log(setCollection(opened, 'figures', [...(opened.figures ?? []), marked], 'propose-figure'), 'propose-figure', marked.name);
  const previous = proposal.changes.find((c) => c.kind === 'add-figure');
  return { ws: withChange(added, proposal.id, { kind: 'add-figure', figureIds: [...(previous?.figureIds ?? []), marked.id] }, (c) => c.kind === 'add-figure'), figure: marked };
}

// Sample annotations, held for review: { sampleId: { meta: { field: value }, role, stain } }
// (each part optional; a meta value of null removes the field).
export function proposeAnnotations(ws, author, samples) {
  const { ws: opened, proposal } = openProposal(ws, author);
  const earlier = proposal.changes.find((c) => c.kind === 'annotate-samples');
  const merged = { ...(earlier?.samples ?? {}) };
  for (const [id, change] of Object.entries(samples)) {
    const before = merged[id] ?? {};
    merged[id] = { ...before, ...change, meta: { ...(before.meta ?? {}), ...(change.meta ?? {}) } };
  }
  const n = Object.keys(samples).length;
  return { ws: log(withChange(opened, proposal.id, { kind: 'annotate-samples', samples: merged }, (c) => c.kind === 'annotate-samples'), 'propose-annotations', `${n} sample${n === 1 ? '' : 's'}`), held: true };
}

// A gate at the top of the gating tree, held for review: accepting adds it and moves every other
// top-level gate beneath it.
export function proposeRootGate(ws, author, gate) {
  const { ws: opened, proposal } = openProposal(ws, author);
  const change = { kind: 'insert-root-gate', gate: { ...gate, id: gate.id ?? newId('g') } };
  return { ws: log(withChange(opened, proposal.id, change, (c) => c.kind === 'insert-root-gate' && c.gate.name === gate.name), 'propose-root-gate', gate.name), held: true };
}

const KEEP_ALWAYS = new Set(['add-compensation', 'add-derived', 'add-figure', 'annotate-samples', 'insert-root-gate']);

// Drops from the open proposals the ids of gates that no longer exist (removed by the user, or
// with their parents).
function forgetGates(ws) {
  const ids = new Set(ws.gates.map((g) => g.id));
  const proposals = openProposals(ws).map((p) => ({
    ...p,
    changes: p.changes
      .map((c) => (c.kind === 'add-gates' ? { ...c, gateIds: c.gateIds.filter((id) => ids.has(id)) } : c))
      .filter((c) => (c.kind === 'add-gates' ? c.gateIds.length > 0 : KEEP_ALWAYS.has(c.kind) || ids.has(c.gateId))),
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
      if (change.patch.ontology !== undefined) parts.push(change.patch.ontology ? `annotate it as ${change.patch.ontology.label} (${change.patch.ontology.id})` : 'clear its cell type');
      items.push({ kind: 'edit', gateId: change.gateId, text: `${gate?.name ?? change.name}: ${parts.join(', ') || 'no change'}` });
    } else if (change.kind === 'remove-gate') {
      const below = gateById(ws, change.gateId) ? gateDescendants(ws, change.gateId).length : 0;
      items.push({ kind: 'remove', gateId: change.gateId, text: `Delete ${change.name}${below ? ` and the ${below} population${below === 1 ? '' : 's'} under it` : ''}` });
    } else if (change.kind === 'adjust-gate') {
      const n = Object.keys(change.overrides).length;
      items.push({ kind: 'adjust', gateId: change.gateId, text: `Adjust ${gateById(ws, change.gateId)?.name ?? change.name} for ${n} sample${n === 1 ? '' : 's'}` });
    } else if (change.kind === 'add-compensation') {
      const samples = change.sampleIds.filter((id) => (ws.samples ?? []).some((s) => s.id === id)).length;
      items.push({ kind: 'compensation', text: `Add the compensation matrix "${change.compensation.name}" (${change.compensation.channels.length} channels) and apply it to ${samples} sample${samples === 1 ? '' : 's'}` });
    } else if (change.kind === 'add-derived') {
      for (const id of change.derivedIds) {
        const record = (ws.derived ?? []).find((d) => d.id === id);
        if (record) items.push({ kind: 'derived', derivedId: id, text: `Add ${record.name ?? record.kind}${record.outputs?.length ? ` (${record.outputs.length === 1 ? `channel ${record.outputs[0]}` : `${record.outputs.length} channels`})` : ''}` });
      }
    } else if (change.kind === 'add-figure') {
      for (const id of change.figureIds) {
        const figure = (ws.figures ?? []).find((f) => f.id === id);
        if (figure) items.push({ kind: 'figure', figureId: id, text: `Add the figure "${figure.name}" (${figure.items.filter((i) => i.kind === 'plot').length} plots)` });
      }
    } else if (change.kind === 'annotate-samples') {
      const ids = Object.keys(change.samples).filter((id) => (ws.samples ?? []).some((s) => s.id === id));
      const fields = [...new Set(ids.flatMap((id) => [...Object.keys(change.samples[id].meta ?? {}), ...(change.samples[id].role ? ['role'] : []), ...(change.samples[id].stain !== undefined ? ['stained channel'] : [])]))];
      items.push({ kind: 'annotate', text: `Annotate ${ids.length} sample${ids.length === 1 ? '' : 's'} (${fields.join(', ') || 'no fields'})` });
    } else if (change.kind === 'insert-root-gate') {
      items.push({ kind: 'root-gate', text: `Add ${change.gate.name} at the top of the gating tree, with every population beneath it` });
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
    } else if (change.kind === 'adjust-gate' && gateById(next, change.gateId)) {
      for (const [sampleId, geometry] of Object.entries(change.overrides)) {
        if (next.samples.some((x) => x.id === sampleId)) next = setGateGeometry(next, change.gateId, geometry, { sampleId });
      }
      if (change.record) next = addDerived(next, change.record).ws;
    } else if (change.kind === 'add-compensation') {
      const added = addCompensation(next, { ...change.compensation, source: change.compensation.source ?? 'agent' });
      next = setSampleCompensation(added.ws, change.sampleIds.filter((id) => next.samples.some((s) => s.id === id)), added.compensation.id);
    } else if (change.kind === 'add-derived') {
      for (const id of change.derivedIds) {
        const record = next.derived.find((d) => d.id === id);
        if (!record) continue;
        const kept = { ...withoutProposal(record), proposedBy: proposal.author, acceptedBy, accepted: time };
        // Results of more samples for an accepted result of the same kind and channels (QC of
        // other samples) join it; otherwise the result is kept as it is.
        const into = record.outputs?.length ? next.derived.find((d) => d.id !== id && !d.proposal && d.kind === record.kind && sameOutputs(d.outputs, record.outputs)) : null;
        if (into) {
          const merged = { ...into, files: { ...(into.files ?? {}), ...(record.files ?? {}) }, summary: { ...(into.summary ?? {}), ...(record.summary ?? {}), perSample: { ...(into.summary?.perSample ?? {}), ...(record.summary?.perSample ?? {}) } } };
          next = { ...next, derived: next.derived.filter((d) => d.id !== id).map((d) => (d.id === into.id ? merged : d)) };
        } else {
          next = { ...next, derived: next.derived.map((d) => (d.id === id ? kept : d)) };
        }
      }
    } else if (change.kind === 'add-figure') {
      const ids = new Set(change.figureIds);
      next = { ...next, figures: next.figures.map((f) => (ids.has(f.id) ? { ...withoutProposal(f), proposedBy: proposal.author, acceptedBy, accepted: time } : f)) };
    } else if (change.kind === 'annotate-samples') {
      next = { ...next, samples: next.samples.map((s) => {
        const c = change.samples[s.id];
        if (!c) return s;
        const meta = { ...s.meta };
        for (const [field, value] of Object.entries(c.meta ?? {})) {
          if (value === null || value === '') delete meta[field];
          else meta[field] = value;
        }
        return { ...s, meta, ...(c.role ? { role: c.role } : {}), ...(c.stain !== undefined ? { stain: c.stain } : {}) };
      }) };
    } else if (change.kind === 'insert-root-gate') {
      next = insertRootGate(next, { ...change.gate, meta: { ...(change.gate.meta ?? {}), proposedBy: proposal.author, acceptedBy, accepted: time } }, 'add-root-gate').ws;
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
    if (change.kind === 'add-gates') for (const id of change.gateIds) if (gateById(next, id)) next = removeGate(next, id);
    if (change.kind === 'add-derived') for (const id of change.derivedIds) next = removeDerived(next, id);
    if (change.kind === 'add-figure') next = { ...next, figures: next.figures.filter((f) => !change.figureIds.includes(f.id)) };
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
  // Gates on the channels of proposed results, which would lose their channel.
  const channels = new Set(proposal.changes.flatMap((c) => (c.kind === 'add-derived' ? c.derivedIds : [])).flatMap((id) => (ws.derived ?? []).find((d) => d.id === id)?.outputs ?? []));
  for (const g of ws.gates) if (!proposed.has(g.id) && !out.includes(g) && g.dims.some((d) => channels.has(d.channel))) out.push(g);
  return out;
}

// The channels of a proposal's computed results (to detach from the samples when it is rejected).
export function proposedChannels(ws, proposalId) {
  const proposal = proposalById(ws, proposalId);
  if (!proposal) return [];
  const ids = new Set(proposal.changes.flatMap((c) => (c.kind === 'add-derived' ? c.derivedIds : [])));
  return [...new Set((ws.derived ?? []).filter((d) => ids.has(d.id)).flatMap((d) => d.outputs ?? []))];
}

function sameOutputs(a = [], b = []) {
  return a.length === b.length && a.every((x) => b.includes(x));
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
