// The workspace document: samples, groups, compensation, channel scales, gates and results.
//
// Workspaces are immutable values: every edit returns a new workspace that shares unchanged parts
// with the old one, so undo/redo is a list of workspaces and a change is detectable by identity.

import { describeAcquisition, detectTechnology, readSpillover } from './fcs.js';
import { newId } from './gates.js';
import { chorusGates } from './chorus.js';
import { categoricalColor } from './colormaps.js';
import { sha256 } from './sha256.js';

export const FORMAT = 'cytoweave-workspace';
export const FORMAT_VERSION = 1;
export const ROOT = 'root';

export const SAMPLE_ROLES = ['sample', 'unstained', 'single-stain', 'fmo', 'isotype', 'bead', 'reference'];
export const META_FIELDS = ['condition', 'subject', 'batch', 'timepoint', 'tissue', 'treatment', 'replicate', 'plate', 'well'];

const now = () => new Date().toISOString();

export function createWorkspace(name = 'Untitled workspace') {
  const time = now();
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    id: newId('w'),
    name,
    created: time,
    modified: time,
    samples: [],
    groups: [],
    compensations: [],
    channelSettings: {},
    gates: [],
    plots: [],
    derived: [],
    figures: [],
    tables: [],
    comparisons: [],
    checkpoints: [],
    // Changes from agents waiting for the user's review (proposals.js).
    proposals: [],
    notes: '',
    provenance: [chainEntry('', { time, action: 'create', detail: name })],
  };
}

// --- The change log ------------------------------------------------------------------------------
//
// ws.provenance lists every change ({ time, action, detail }), oldest first. The log is
// hash-chained: each entry's hash is the SHA-256 of the hash before it and the entry itself, so
// an entry changed, removed, inserted or reordered afterward breaks the chain (verifyLog). Beyond
// LOG_LIMIT entries the oldest are dropped, and the hash of the last dropped one is kept as the
// log's anchor (ws.provenanceAnchor). Entries written before the log was chained (CytoWeave 0.7
// and earlier) are chained when the workspace is next changed, and ws.provenanceSealed says how
// many and when: the chain vouches for them only from then on.

export const LOG_LIMIT = 5000;
const encoder = new TextEncoder();

// Keys sorted at every level, so a value has one text however it was built.
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJSON(v === undefined ? null : v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function logEntryHash(previous, entry) {
  const { hash, ...content } = entry;
  return sha256(encoder.encode(`${previous}\n${canonicalJSON(content)}`));
}

function chainEntry(previous, entry) {
  return { ...entry, hash: logEntryHash(previous, entry) };
}

// The log with its unchained entries chained: { provenance, provenanceSealed? }.
function sealLog(ws, time) {
  const log = ws.provenance ?? [];
  if (log.every((e) => e.hash)) return { provenance: log };
  let previous = ws.provenanceAnchor ?? '';
  let sealed = 0;
  const provenance = log.map((e) => {
    const entry = e.hash ? e : chainEntry(previous, e);
    if (!e.hash) sealed += 1;
    previous = entry.hash;
    return entry;
  });
  return { provenance, provenanceSealed: { time, entries: (ws.provenanceSealed?.entries ?? 0) + sealed } };
}

// The log fields of ws with an entry appended: { provenance, provenanceAnchor?, provenanceSealed? }.
export function appendLog(ws, action, detail, time = now()) {
  const sealed = sealLog(ws, time);
  const log = sealed.provenance;
  const entry = chainEntry(log.length ? log[log.length - 1].hash : ws.provenanceAnchor ?? '', { time, action, detail });
  const all = [...log, entry];
  const patch = { ...sealed, provenance: all.length > LOG_LIMIT ? all.slice(-LOG_LIMIT) : all };
  if (all.length > LOG_LIMIT) patch.provenanceAnchor = all[all.length - LOG_LIMIT - 1].hash;
  return patch;
}

// Checks the chain: { ok, entries, head (the last hash), anchor, sealed, broken: [{ index,
// entry, reason }] }. A broken chain names the first entry whose hash does not follow.
export function verifyLog(ws) {
  const log = ws.provenance ?? [];
  let previous = ws.provenanceAnchor ?? '';
  const broken = [];
  log.forEach((entry, index) => {
    if (!entry.hash) broken.push({ index, entry, reason: 'not chained' });
    else if (entry.hash !== logEntryHash(previous, entry)) broken.push({ index, entry, reason: 'its hash does not follow from the entries before it' });
    previous = entry.hash ?? previous;
  });
  return { ok: broken.length === 0, entries: log.length, head: log.length ? log[log.length - 1].hash ?? null : ws.provenanceAnchor ?? null, anchor: ws.provenanceAnchor ?? null, sealed: ws.provenanceSealed ?? null, broken };
}

function touch(ws, patch, action, detail) {
  const time = now();
  return { ...ws, ...patch, modified: time, ...(action ? appendLog(ws, action, detail, time) : {}) };
}

// Keywords worth keeping in the workspace: everything except per-parameter keywords (kept in
// channels) and very long values (other than spillover).
function keepKeywords(keywords) {
  const kept = {};
  for (const [key, value] of Object.entries(keywords)) {
    if (/^\$P\d+[A-Z]+$/.test(key)) continue;
    const text = String(value);
    if (text.length > 4000 && !/SPILL/.test(key)) continue;
    kept[key] = text;
  }
  return kept;
}

// Guesses a sample's role from its name and keywords (controls are named consistently by most
// instruments and labs): "Unstained", "FITC Stained Control", "Comp …", "FMO CD25".
export function guessRole(name, keywords = {}) {
  // Underscores separate words in file names ("Beads_2026-03-27", "Comp_FITC").
  const text = `${name} ${keywords['TUBE NAME'] ?? ''}`.toLowerCase().replace(/_/g, ' ');
  if (/\bunstained\b|\bunstain\b|\bblank\b|\bno stain\b|\bus\b/.test(text)) return 'unstained';
  if (/\bfmo\b/.test(text)) return 'fmo';
  if (/\bisotype\b/.test(text)) return 'isotype';
  if (/stained control|single[ -]?stain|\bcomp(ensation)?\b|\bss\b|control.*\b(bv|fitc|pe|apc|percp|af|pacific)/.test(text)) return 'single-stain';
  if (/\bbeads?\b/.test(text)) return 'bead';
  return 'sample';
}

// The fluorochrome channel a single-stain control stains, from its name ("FITC-A Stained Control").
export function guessStain(name, channels) {
  const lower = name.toLowerCase();
  let best = null;
  for (const channel of channels) {
    if (channel.type !== 'fluorescence') continue;
    const base = channel.name.replace(/-[AHW]$/i, '').toLowerCase();
    const label = (channel.label || '').toLowerCase();
    if (base && lower.includes(base) && (!best || base.length > best.length)) best = { name: channel.name, length: base.length };
    else if (label && lower.includes(label) && (!best || label.length > best.length)) best = { name: channel.name, length: label.length };
  }
  return best?.name ?? null;
}

// A sample record from a parsed FCS data set.
export function sampleFromDataset(dataset, file) {
  const channels = dataset.parameters.map((p) => ({ name: p.name, label: p.label, marker: p.marker, type: p.type, range: p.range, ...(p.voltage ? { voltage: p.voltage } : {}) }));
  const name = (file.name ?? 'sample').replace(/\.(fcs|lmd)$/i, '');
  const spill = readSpillover(dataset.keywords, dataset.parameters);
  const role = guessRole(name, dataset.keywords);
  const acquisition = describeAcquisition(dataset.keywords);
  return {
    id: newId('s'),
    name,
    fileName: file.name,
    sha256: file.sha256 ?? null,
    size: file.size ?? null,
    datasetIndex: file.datasetIndex ?? 0,
    fcsVersion: dataset.version,
    eventCount: dataset.eventCount,
    channels,
    technology: detectTechnology(dataset.keywords, dataset.parameters),
    keywords: keepKeywords(dataset.keywords),
    acquisition,
    meta: {},
    role,
    stain: role === 'single-stain' ? guessStain(name, channels) : null,
    compensationId: spill && !spill.identity ? 'file' : 'none',
    hasFileSpillover: Boolean(spill && !spill.identity),
    diagnostics: dataset.diagnostics.filter((d) => d.level !== 'info').map((d) => d.message),
    // Gates the acquisition software recorded in the file (FACSChorus), for import on request.
    ...(acquisitionGatesOf(dataset.keywords) ?? {}),
    added: now(),
  };
}

function acquisitionGatesOf(keywords) {
  const gates = chorusGates(keywords);
  return gates?.gates.length ? { acquisitionGates: gates } : null;
}

export function addSamples(ws, records) {
  const known = new Set(ws.samples.map((s) => s.sha256 && `${s.sha256}:${s.datasetIndex}`).filter(Boolean));
  const fresh = records.filter((r) => !r.sha256 || !known.has(`${r.sha256}:${r.datasetIndex}`));
  if (!fresh.length) return ws;
  return touch(ws, { samples: [...ws.samples, ...fresh] }, 'add-samples', fresh.map((s) => s.name).join(', '));
}

export function removeSamples(ws, ids) {
  const drop = new Set(ids);
  const samples = ws.samples.filter((s) => !drop.has(s.id));
  const groups = ws.groups.map((g) => ({ ...g, sampleIds: g.sampleIds.filter((id) => !drop.has(id)) }));
  const gates = ws.gates.map((g) => {
    if (!g.overrides) return g;
    const overrides = { ...g.overrides };
    let changed = false;
    for (const id of ids) if (id in overrides) { delete overrides[id]; changed = true; }
    return changed ? { ...g, overrides } : g;
  });
  return touch(ws, { samples, groups, gates }, 'remove-samples', `${ids.length} sample(s)`);
}

export function updateSample(ws, id, patch) {
  return touch(ws, { samples: ws.samples.map((s) => (s.id === id ? { ...s, ...patch } : s)) }, 'update-sample', id);
}

export function setSampleMeta(ws, ids, key, value) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  return touch(ws, {
    samples: ws.samples.map((s) => (set.has(s.id) ? { ...s, meta: { ...s.meta, [key]: value } } : s)),
  }, 'annotate', `${key} = ${value}`);
}

// Several annotations at once: changes { sampleId: { field: value } }, a null or empty value
// removing the field (a plate layout, say).
export function annotateSamples(ws, changes, detail = '') {
  return touch(ws, {
    samples: ws.samples.map((s) => {
      const c = changes[s.id];
      if (!c) return s;
      const meta = { ...s.meta };
      for (const [field, value] of Object.entries(c)) {
        if (value === null || value === undefined || value === '') delete meta[field];
        else meta[field] = String(value);
      }
      return { ...s, meta };
    }),
  }, 'annotate', detail || `${Object.keys(changes).length} sample(s)`);
}

export function reorderSamples(ws, orderedIds) {
  const byId = new Map(ws.samples.map((s) => [s.id, s]));
  const samples = orderedIds.map((id) => byId.get(id)).filter(Boolean);
  for (const s of ws.samples) if (!orderedIds.includes(s.id)) samples.push(s);
  return touch(ws, { samples });
}

// --- Groups -------------------------------------------------------------------------------

export function addGroup(ws, name, sampleIds = [], options = {}) {
  const group = { id: newId('grp'), name, color: options.color ?? categoricalColor(ws.groups.length + 1), sampleIds: [...new Set(sampleIds)], rule: options.rule ?? null };
  return { ws: touch(ws, { groups: [...ws.groups, group] }, 'add-group', name), group };
}

export function updateGroup(ws, id, patch) {
  return touch(ws, { groups: ws.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) }, 'update-group', id);
}

export function removeGroup(ws, id) {
  const gates = ws.gates.map((g) => (g.scope?.groupId === id ? { ...g, scope: null } : g));
  return touch(ws, { groups: ws.groups.filter((g) => g.id !== id), gates }, 'remove-group', id);
}

export function groupsOfSample(ws, sampleId) {
  return ws.groups.filter((g) => g.sampleIds.includes(sampleId));
}

// Groups made automatically from a keyword or metadata field: one group per distinct value.
export function groupsByField(ws, field, sampleIds = ws.samples.map((s) => s.id)) {
  const buckets = new Map();
  for (const sample of ws.samples) {
    if (!sampleIds.includes(sample.id)) continue;
    const value = field.startsWith('meta.') ? sample.meta[field.slice(5)] : sample.keywords[field];
    if (value === undefined || value === '') continue;
    if (!buckets.has(value)) buckets.set(value, []);
    buckets.get(value).push(sample.id);
  }
  let next = ws;
  for (const [value, ids] of buckets) next = addGroup(next, String(value), ids, { rule: { field, value } }).ws;
  return next;
}

// --- Compensation ------------------------------------------------------------------------

export function addCompensation(ws, compensation) {
  const record = {
    id: compensation.id ?? newId('c'),
    name: compensation.name ?? 'Compensation',
    channels: compensation.channels.slice(),
    matrix: Array.from(compensation.matrix),
    source: compensation.source ?? 'manual',
    created: now(),
    report: compensation.report ?? null,
    method: compensation.method ?? null,
  };
  return { ws: touch(ws, { compensations: [...ws.compensations, record] }, 'add-compensation', record.name), compensation: record };
}

export function updateCompensation(ws, id, patch) {
  const compensations = ws.compensations.map((c) => (c.id === id ? { ...c, ...patch, matrix: patch.matrix ? Array.from(patch.matrix) : c.matrix } : c));
  return touch(ws, { compensations }, 'edit-compensation', id);
}

export function setSampleCompensation(ws, sampleIds, compensationId) {
  const set = new Set(sampleIds);
  return touch(ws, { samples: ws.samples.map((s) => (set.has(s.id) ? { ...s, compensationId } : s)) }, 'apply-compensation', compensationId);
}

// --- Channel scales -----------------------------------------------------------------------

export function setChannelTransform(ws, channel, transform) {
  return touch(ws, { channelSettings: { ...ws.channelSettings, [channel]: { ...(ws.channelSettings[channel] ?? {}), transform } } }, 'scale', `${channel}: ${transform.type}`);
}

// Display name of a channel: marker and detector ("CD3 · FITC-A") when a marker is known. The
// short form is the marker alone, unless several channels share it (PI-A, PI-H and PI-W).
export function channelLabel(ws, channel, options = {}) {
  const custom = ws?.channelSettings?.[channel]?.label;
  if (custom) return custom;
  for (const sample of ws?.samples ?? []) {
    const found = sample.channels.find((c) => c.name === channel);
    if (found) {
      if (!found.marker) return channel;
      if (!options.short) return `${found.marker} · ${channel}`;
      const shared = sample.channels.filter((c) => c.marker === found.marker).length > 1;
      return shared ? `${found.marker} · ${channel}` : found.marker;
    }
  }
  // A calibrated channel: the marker of the channel it calibrates, with the unit.
  const calibration = ws?.derived?.find((d) => d.kind === 'calibration' && d.outputs?.[0] === channel);
  if (calibration) {
    const marker = ws.samples.flatMap((s) => s.channels).find((c) => c.name === calibration.inputs[0])?.marker;
    if (marker) return options.short ? `${marker} (${calibration.params.unit})` : `${marker} · ${channel}`;
  }
  return channel;
}

// --- Gates --------------------------------------------------------------------------------

export function gateById(ws, id) {
  return ws.gates.find((g) => g.id === id) ?? null;
}

export function gateChildren(ws, parentId) {
  const key = parentId ?? null;
  return ws.gates.filter((g) => (g.parentId ?? null) === (key === ROOT ? null : key));
}

export function gateAncestors(ws, id) {
  const chain = [];
  let gate = gateById(ws, id);
  const seen = new Set();
  while (gate && gate.parentId && !seen.has(gate.parentId)) {
    seen.add(gate.parentId);
    gate = gateById(ws, gate.parentId);
    if (gate) chain.unshift(gate);
  }
  return chain;
}

export function gateDescendants(ws, id) {
  const out = [];
  const stack = [id];
  while (stack.length) {
    const current = stack.pop();
    for (const child of ws.gates) {
      if (child.parentId === current) {
        out.push(child);
        stack.push(child.id);
      }
    }
  }
  return out;
}

export function gatePath(ws, id) {
  const gate = gateById(ws, id);
  if (!gate) return '';
  return [...gateAncestors(ws, id), gate].map((g) => g.name).join(' / ');
}

// Does the gate apply to this sample (its scope and its ancestors' scopes)?
export function gateApplies(ws, gate, sampleId) {
  let current = gate;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.scope?.groupId) {
      const group = ws.groups.find((g) => g.id === current.scope.groupId);
      if (group && !group.sampleIds.includes(sampleId)) return false;
    }
    current = current.parentId ? gateById(ws, current.parentId) : null;
  }
  return true;
}

export function gatesForSample(ws, sampleId) {
  return ws.gates.filter((g) => gateApplies(ws, g, sampleId));
}

export function effectiveGeometry(gate, sampleId) {
  return (sampleId && gate.overrides?.[sampleId]) || gate.geometry;
}

export function addGates(ws, gates, action = 'add-gate') {
  const records = gates.map((gate, i) => ({
    meta: { origin: 'manual', created: now() },
    ...gate,
    id: gate.id ?? newId('g'),
    parentId: gate.parentId === ROOT ? null : gate.parentId ?? null,
    color: gate.color ?? categoricalColor(ws.gates.length + i),
  }));
  return { ws: touch(ws, { gates: [...ws.gates, ...records] }, action, records.map((g) => g.name).join(', ')), gates: records };
}

export function updateGate(ws, id, patch, action = 'edit-gate') {
  return touch(ws, { gates: ws.gates.map((g) => (g.id === id ? { ...g, ...patch } : g)) }, action, id);
}

// Sets a gate's geometry, for every sample or (with sampleId) as that sample's override. Linked
// quadrant and split gates move together.
export function setGateGeometry(ws, id, geometry, options = {}) {
  const gate = gateById(ws, id);
  if (!gate) return ws;
  const linked = gate.linkId ? ws.gates.filter((g) => g.linkId === gate.linkId) : [gate];
  const ids = new Set(linked.map((g) => g.id));
  const shared = (g) => {
    if (g.type === 'quadrant') return { ...effectiveGeometry(g, options.sampleId), center: geometry.center.slice() };
    if (g.type === 'split') return { ...effectiveGeometry(g, options.sampleId), threshold: geometry.threshold };
    return geometry;
  };
  const gates = ws.gates.map((g) => {
    if (!ids.has(g.id)) return g;
    const next = shared(g);
    if (options.sampleId) return { ...g, overrides: { ...(g.overrides ?? {}), [options.sampleId]: next } };
    // The shared geometry was last set while looking at this sample (autogating's reference).
    return { ...g, geometry: next, ...(options.editedOn ? { meta: { ...(g.meta ?? {}), drawnOn: options.editedOn } } : {}) };
  });
  return touch(ws, { gates }, options.sampleId ? 'adjust-gate-for-sample' : 'move-gate', `${gate.name}${options.sampleId ? ` (${options.sampleId})` : ''}`);
}

export function clearOverride(ws, id, sampleId) {
  const gate = gateById(ws, id);
  if (!gate) return ws;
  const linked = gate.linkId ? ws.gates.filter((g) => g.linkId === gate.linkId) : [gate];
  const ids = new Set(linked.map((g) => g.id));
  const gates = ws.gates.map((g) => {
    if (!ids.has(g.id) || !g.overrides?.[sampleId]) return g;
    const overrides = { ...g.overrides };
    delete overrides[sampleId];
    return { ...g, overrides };
  });
  return touch(ws, { gates }, 'reset-gate-for-sample', `${gate.name} (${sampleId})`);
}

// Removes a gate with its descendants and any boolean gates that reference them.
// Adds a gate at the top of the gating tree and moves every other top-level gate, and every plot
// of all events, beneath it (as for the "QC pass" gate). Returns { ws, gate }.
export function insertRootGate(ws, gate, action = 'add-root-gate') {
  const added = addGates(ws, [{ ...gate, parentId: null }], action);
  const root = added.gates[0];
  const gates = added.ws.gates.map((g) => (g.id !== root.id && !g.parentId ? { ...g, parentId: root.id } : g));
  const next = { ...setCollection(added.ws, 'gates', gates, 'reparent-under-root'), plots: (added.ws.plots ?? []).map((p) => (p.populationId === ROOT ? { ...p, populationId: root.id } : p)) };
  return { ws: next, gate: root };
}

export function removeGate(ws, id) {
  const doomed = new Set([id, ...gateDescendants(ws, id).map((g) => g.id)]);
  const gate = gateById(ws, id);
  // Linked quadrant or split siblings stay: a quadrant missing one quarter still works.
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of ws.gates) {
      if (doomed.has(g.id)) continue;
      if (g.type === 'boolean' && g.geometry.operands.some((op) => doomed.has(op))) {
        doomed.add(g.id);
        for (const d of gateDescendants(ws, g.id)) doomed.add(d.id);
        changed = true;
      }
    }
  }
  return touch(ws, { gates: ws.gates.filter((g) => !doomed.has(g.id)), plots: (ws.plots ?? []).filter((p) => !doomed.has(p.populationId)) }, 'remove-gate', gate?.name ?? id);
}

// --- Boolean populations -------------------------------------------------------------------
//
// A Boolean gate combines other populations: 'and' (in all of them), 'or' (in any of them) or
// 'not' (in none of them), within its parent: the engine intersects the combination with the
// parent's events ('not' is the parent minus the operands).

export const BOOLEAN_OPS = { and: 'all of', or: 'any of', not: 'none of' };

// Gates a Boolean gate may combine or sit under: not itself or anything that depends on it (its
// descendants, and Boolean gates that use those), which would make it depend on itself.
export function booleanCandidates(ws, gateId = null) {
  if (!gateId) return ws.gates.slice();
  const dependent = new Set([gateId, ...gateDescendants(ws, gateId).map((g) => g.id)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of ws.gates) {
      if (dependent.has(g.id)) continue;
      if (g.type === 'boolean' && (g.geometry?.operands ?? []).some((id) => dependent.has(id))) {
        dependent.add(g.id);
        for (const d of gateDescendants(ws, g.id)) dependent.add(d.id);
        changed = true;
      }
    }
  }
  return ws.gates.filter((g) => !dependent.has(g.id));
}

// A default name: "CD4+ and CD25+", "B or NK", "not Debris".
export function booleanName(ws, op, operands) {
  const names = operands.map((id) => gateById(ws, id)?.name ?? '?');
  if (op === 'not') return `not ${names.join(' or ')}`;
  return names.join(op === 'and' ? ' and ' : ' or ');
}

// Adds a Boolean gate ({ op, operands, parentId, name }), or with `id` changes an existing one.
// Returns { ws, gate }.
export function setBooleanGate(ws, { id = null, op, operands, parentId = null, name }) {
  if (!BOOLEAN_OPS[op]) throw new Error(`Unknown Boolean operator ${op}.`);
  const allowed = new Set(booleanCandidates(ws, id).map((g) => g.id));
  if (!operands.length) throw new Error('Choose at least one population to combine.');
  for (const operand of operands) if (!allowed.has(operand)) throw new Error('A Boolean population cannot use itself or a population under it.');
  const parent = parentId === ROOT ? null : parentId;
  if (parent && !allowed.has(parent)) throw new Error('A Boolean population cannot sit under itself.');
  const geometry = { op, operands: [...new Set(operands)] };
  const gateName = (name ?? '').trim() || booleanName(ws, op, geometry.operands);
  if (id) {
    const next = touch(ws, { gates: ws.gates.map((g) => (g.id === id ? { ...g, geometry, parentId: parent, name: gateName } : g)) }, 'edit-boolean-gate', gateName);
    return { ws: next, gate: gateById(next, id) };
  }
  const added = addGates(ws, [{ name: uniqueGateName(ws, parent, gateName), parentId: parent, type: 'boolean', dims: [], geometry }], 'add-boolean-gate');
  return { ws: added.ws, gate: added.gates[0] };
}

// Copies a gate (and its subtree) under another parent, e.g. to repeat a strategy elsewhere.
export function copyGateSubtree(ws, id, newParentId) {
  const root = gateById(ws, id);
  if (!root) return { ws, gates: [] };
  const subtree = [root, ...gateDescendants(ws, id)];
  const idMap = new Map(subtree.map((g) => [g.id, newId('g')]));
  const linkMap = new Map();
  const copies = subtree.map((g) => {
    const copy = { ...g, id: idMap.get(g.id), parentId: g.id === id ? (newParentId === ROOT ? null : newParentId) : idMap.get(g.parentId), overrides: undefined, meta: { ...(g.meta ?? {}), copiedFrom: g.id } };
    if (g.linkId) {
      if (!linkMap.has(g.linkId)) linkMap.set(g.linkId, newId('l'));
      copy.linkId = linkMap.get(g.linkId);
    }
    if (g.type === 'boolean') copy.geometry = { ...g.geometry, operands: g.geometry.operands.map((op) => idMap.get(op) ?? op) };
    return copy;
  });
  return { ws: touch(ws, { gates: [...ws.gates, ...copies] }, 'copy-gates', root.name), gates: copies };
}

// Unique gate name among siblings ("CD4+", "CD4+ (2)").
export function uniqueGateName(ws, parentId, name) {
  const siblings = new Set(gateChildren(ws, parentId).map((g) => g.name));
  if (!siblings.has(name)) return name;
  for (let i = 2; ; i += 1) if (!siblings.has(`${name} (${i})`)) return `${name} (${i})`;
}

// --- Plots of the gating workbench -----------------------------------------------------------

// A plot: { id, populationId ('root' or a gate id), x, y (null for histograms), type, options }.
export function addPlot(ws, plot) {
  const record = { id: plot.id ?? newId('p'), populationId: plot.populationId ?? ROOT, x: plot.x, y: plot.y ?? null, type: plot.type ?? 'pseudocolor', options: plot.options ?? {} };
  return { ws: touch(ws, { plots: [...ws.plots, record] }), plot: record };
}

export function updatePlot(ws, id, patch) {
  return touch(ws, { plots: ws.plots.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
}

export function removePlot(ws, id) {
  return touch(ws, { plots: ws.plots.filter((p) => p.id !== id) });
}

export function plotsOf(ws, populationId) {
  const key = populationId ?? ROOT;
  return ws.plots.filter((p) => p.populationId === key);
}

// --- Derived results ------------------------------------------------------------------------

export function addDerived(ws, record) {
  const entry = { created: now(), ...record, id: record.id ?? newId('d') };
  return { ws: touch(ws, { derived: [...ws.derived.filter((d) => d.id !== entry.id), entry] }, `derive-${record.kind}`, record.name ?? record.kind), derived: entry };
}

// Adds per-sample files ({ sampleId: { channel: ref } }) and parameters to a derived record, as
// when more samples are placed on an existing map.
export function extendDerived(ws, id, files, params = {}, detail = '') {
  const derived = ws.derived.map((d) => (d.id === id ? { ...d, files: { ...(d.files ?? {}), ...files }, params: { ...(d.params ?? {}), ...params } } : d));
  return touch(ws, { derived }, 'extend-derived', detail || id);
}

export function removeDerived(ws, id) {
  return touch(ws, { derived: ws.derived.filter((d) => d.id !== id) }, 'remove-derived', id);
}

export function setCollection(ws, key, items, action) {
  return touch(ws, { [key]: items }, action ?? `edit-${key}`, '');
}

export function rename(ws, name) {
  return touch(ws, { name }, 'rename', name);
}

export function setNotes(ws, notes) {
  return touch(ws, { notes });
}

// Records an event in the change log without changing the analysis (a certificate made).
export function logEvent(ws, action, detail) {
  return touch(ws, {}, action, detail);
}

// --- Serialization --------------------------------------------------------------------------

export function serializeWorkspace(ws) {
  return JSON.stringify(ws);
}

export class WorkspaceError extends Error {}

export function parseWorkspace(text) {
  let doc;
  try {
    doc = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (error) {
    throw new WorkspaceError(`The workspace is not valid JSON: ${error.message}`);
  }
  if (doc?.format !== FORMAT) throw new WorkspaceError('This file is not a CytoWeave workspace.');
  if (!(doc.version >= 1)) throw new WorkspaceError('The workspace version is not recognized.');
  if (doc.version > FORMAT_VERSION) throw new WorkspaceError(`The workspace was written by a newer CytoWeave (format ${doc.version}); please update.`);
  const base = createWorkspace(doc.name);
  const ws = { ...base, ...doc };
  for (const key of ['samples', 'groups', 'compensations', 'gates', 'plots', 'derived', 'figures', 'tables', 'comparisons', 'checkpoints', 'migrations', 'proposals', 'provenance']) if (!Array.isArray(ws[key])) ws[key] = [];
  if (!ws.channelSettings || typeof ws.channelSettings !== 'object') ws.channelSettings = {};
  // Gates whose parents are missing are re-rooted rather than lost.
  const ids = new Set(ws.gates.map((g) => g.id));
  ws.gates = ws.gates.map((g) => (g.parentId && !ids.has(g.parentId) ? { ...g, parentId: null } : g));
  return ws;
}

// Every channel name across samples, with its type and how many samples have it.
export function channelCatalog(ws, sampleIds = null) {
  const map = new Map();
  for (const sample of ws.samples) {
    if (sampleIds && !sampleIds.includes(sample.id)) continue;
    for (const channel of sample.channels) {
      const entry = map.get(channel.name) ?? { name: channel.name, type: channel.type, marker: channel.marker, label: channel.label, range: channel.range, samples: 0 };
      entry.samples += 1;
      if (!entry.marker && channel.marker) entry.marker = channel.marker;
      map.set(channel.name, entry);
    }
  }
  // Derived channels; `computed` says how (a calibrated channel is a fluorescence channel in other
  // units, measuring its input's marker).
  for (const derived of ws.derived) {
    for (const output of derived.outputs ?? []) {
      if (map.has(output)) continue;
      if (derived.kind === 'calibration') {
        const input = map.get(derived.inputs[0]);
        map.set(output, { name: output, type: 'fluorescence', marker: input?.marker ?? '', label: input?.label ?? '', range: input?.range ?? 1, samples: 0, derived: derived.id, computed: 'calibration', unit: derived.params?.unit });
      } else map.set(output, { name: output, type: 'derived', marker: '', label: '', range: 1, samples: 0, derived: derived.id, computed: derived.kind });
    }
  }
  return [...map.values()];
}

// Fields suggested from file names: names are split on _ - . and spaces, and each position whose
// parts differ between samples becomes a field, named by what its values look like. Time-like
// parts (d4, 24h, T0, day7) are timepoints; batch-like parts (B1, batch2, plate3, run1) batches;
// replicate-like parts (rep2) replicates; of the rest, ID-like parts with many values (D01, S12,
// Patient3) are subjects, the word-like part with the fewest distinct values is the condition and
// another word-like part a treatment. Returns
// [{ field, values }] with one value per name, in field order.
export function suggestFieldsFromNames(names) {
  const tokens = names.map((name) => String(name).replace(/\.(fcs|lmd)$/i, '').split(/[_\-\s.]+/).filter(Boolean));
  const width = Math.max(0, ...tokens.map((t) => t.length));
  const columns = [];
  for (let i = 0; i < width; i += 1) {
    const values = tokens.map((t) => t[i] ?? '');
    const distinct = new Set(values);
    if (distinct.size > 1) columns.push({ position: i, values, distinct: distinct.size });
  }
  const every = (column, pattern) => column.values.every((v) => pattern.test(v));
  // Explicit time forms only: "D01" is far more often a donor than a day, "d7" a day.
  const TIME = /^((day|wk|week|tp|t|h)\d+|\d+(\.\d+)?(h|hr|hrs|min|d|w|wk)|d\d+)$/;
  const timeLike = (column) => column.values.every((v) => TIME.test(v) || /^(day|wk|week|tp)\d+$/i.test(v));
  const batchLike = (column) => every(column, /^(b|batch|plate|p|run|exp|day)\d+$/i) && column.values.some((v) => /^(b|batch|plate|run|exp)/i.test(v));
  const replicateLike = (column) => every(column, /^(rep|r|replicate|well)\d+$/i);
  const idLike = (column) => every(column, /^[a-z]{0,10}\d+[a-z]?$/i) && !replicateLike(column);
  const out = [];
  const take = (column, field) => {
    out.push({ field, position: column.position, values: column.values });
    columns.splice(columns.indexOf(column), 1);
  };
  for (const column of columns.filter(batchLike)) if (!out.some((o) => o.field === 'batch')) take(column, 'batch');
  for (const column of columns.filter(timeLike)) if (!out.some((o) => o.field === 'timepoint')) take(column, 'timepoint');
  for (const column of columns.filter(replicateLike)) if (!out.some((o) => o.field === 'replicate')) take(column, 'replicate');
  const TISSUE = /^(blood|pbmc|wb|spleen|spl|ln|lymphnode|bm|marrow|thymus|liver|lung|skin|gut|colon|tumou?r|til|csf|bal|kidney|brain|heart|peritoneum|pec)$/i;
  for (const column of columns.filter((c) => every(c, TISSUE))) if (!out.some((o) => o.field === 'tissue')) take(column, 'tissue');
  const subjects = columns.filter(idLike).sort((a, b) => b.distinct - a.distinct);
  if (subjects.length) take(subjects[0], 'subject');
  const conditions = columns.filter((c) => !idLike(c)).sort((a, b) => a.distinct - b.distinct);
  if (conditions.length) take(conditions[0], 'condition');
  // Further word-like parts are treatments; anything else a replicate.
  for (const column of columns.slice()) {
    if (!idLike(column) && !out.some((o) => o.field === 'treatment')) take(column, 'treatment');
    else if (!out.some((o) => o.field === 'replicate')) take(column, 'replicate');
  }
  return out.sort((a, b) => a.position - b.position).map(({ field, values }) => ({ field, values }));
}
