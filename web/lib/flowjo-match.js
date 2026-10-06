// Moving a FlowJo workspace into a CytoWeave workspace: matching FlowJo's samples to the
// workspace's FCS files, planning what to add (groups, compensation, axis scales, the merged gate
// tree) as one workspace edit, and comparing FlowJo's saved population counts with CytoWeave's
// recomputed ones (the migration report).
//
// The migration is recorded in `ws.migrations` ([{ id, source, imported, samples, gates,
// fidelity, comparison }]) so the report can be reopened later.

import { readSpillover } from './fcs.js';
import { newId } from './gates.js';
import { compareFlowJoCounts, mergeFlowJoGates } from './flowjo.js';
import { createTransform } from './transforms.js';
import { addCompensation, addGates, addGroup, setChannelTransform, setSampleCompensation, updateGroup } from './workspace.js';

const RANK = { imported: 0, approximated: 1, unsupported: 2 };

// A file or sample name reduced for matching: base name, URI-decoded, lower case, without the
// .fcs extension and with runs of spaces collapsed.
export function normalizeSampleName(name) {
  if (name === null || name === undefined) return '';
  let text = String(name).replace(/\\/g, '/').split('/').pop();
  try {
    text = decodeURIComponent(text);
  } catch {
    // keep as written
  }
  return text.trim().toLowerCase().replace(/\.(fcs|lmd)$/i, '').replace(/\s+/g, ' ');
}

// Pairs each FlowJo sample with at most one workspace sample. Evidence, strongest first: the FCS
// file name, the $FIL keyword, the sample name; equal event counts break ties. Returns
// [{ flowJo, sample (workspace record) | null, how, note }] in FlowJo's order.
export function matchFlowJoSamples(flowJoSamples, workspaceSamples) {
  const keys = (names) => [...new Set(names.map(normalizeSampleName).filter(Boolean))];
  const fj = flowJoSamples.map((s) => ({ file: keys([s.fileName, s.uri]), fil: keys([s.keywords?.$FIL]), name: keys([s.name]) }));
  const wk = workspaceSamples.map((s) => ({ file: keys([s.fileName]), fil: keys([s.keywords?.$FIL]), name: keys([s.name]) }));
  const overlap = (a, b) => a.some((x) => b.includes(x));
  const pairs = [];
  flowJoSamples.forEach((f, i) => {
    workspaceSamples.forEach((w, j) => {
      let score = 0;
      let how = null;
      if (overlap(fj[i].file, wk[j].file)) [score, how] = [4, 'file name'];
      else if (overlap(fj[i].fil, wk[j].fil) || overlap(fj[i].file, wk[j].fil) || overlap(fj[i].fil, wk[j].file)) [score, how] = [3, '$FIL keyword'];
      else if (overlap(fj[i].name, [...wk[j].name, ...wk[j].file])) [score, how] = [2, 'sample name'];
      if (!score) return;
      const sameCount = Number.isFinite(f.eventCount) && f.eventCount === w.eventCount;
      pairs.push({ i, j, how, score: score + (sameCount ? 0.5 : 0) });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
  const out = flowJoSamples.map((flowJo) => ({ flowJo, sample: null, how: null, note: '' }));
  const usedSamples = new Set();
  for (const pair of pairs) {
    if (out[pair.i].sample || usedSamples.has(pair.j)) continue;
    usedSamples.add(pair.j);
    out[pair.i].sample = workspaceSamples[pair.j];
    out[pair.i].how = pair.how;
  }
  for (const [i, match] of out.entries()) {
    if (match.sample) {
      const expected = match.flowJo.eventCount;
      if (Number.isFinite(expected) && Number.isFinite(match.sample.eventCount) && expected !== match.sample.eventCount) {
        match.note = `FlowJo recorded ${expected} events; the file has ${match.sample.eventCount}`;
      }
    } else if (pairs.some((p) => p.i === i)) {
      match.note = 'its file is already matched to another FlowJo sample';
    }
  }
  return out;
}

// FCS file names that FlowJo samples need and the workspace lacks.
export function missingFiles(matches) {
  return matches.filter((m) => !m.sample).map((m) => m.flowJo.fileName || m.flowJo.name);
}

// One row per population path with its worst status across samples:
// { counts: { imported, approximated, unsupported }, paths: [{ path, status, entries }],
//   transforms: [...] (entries about axis transforms), byPath: Map }.
export function summarizeFidelity(fidelity) {
  const byPath = new Map();
  for (const entry of fidelity) {
    if (!byPath.has(entry.path)) byPath.set(entry.path, { path: entry.path, status: 'imported', entries: [] });
    const row = byPath.get(entry.path);
    if (RANK[entry.status] > RANK[row.status]) row.status = entry.status;
    if (entry.detail && entry.detail !== 'exact') row.entries.push(entry);
  }
  const all = [...byPath.values()].sort((a, b) => RANK[b.status] - RANK[a.status] || a.path.localeCompare(b.path));
  const paths = all.filter((r) => !r.path.startsWith('transform:'));
  const counts = { imported: 0, approximated: 0, unsupported: 0 };
  for (const row of paths) counts[row.status] += 1;
  return { counts, paths, transforms: all.filter((r) => r.path.startsWith('transform:')), byPath };
}

// A short plain-language statement of why a path is not exact (distinct details, joined).
export function fidelityNote(row, limit = 3) {
  if (!row) return '';
  const details = [...new Set(row.entries.flatMap((e) => String(e.detail).split('; ')))].filter(Boolean);
  const text = details.slice(0, limit).join('; ');
  return details.length > limit ? `${text}; …` : text;
}

const specKey = (spec) => createTransform(spec).key;

// The axis scale FlowJo used for each channel: the most common spec across the samples.
export function consensusTransforms(flowJoSamples) {
  const votes = new Map();
  for (const sample of flowJoSamples) {
    for (const [channel, spec] of Object.entries(sample.transforms ?? {})) {
      if (!votes.has(channel)) votes.set(channel, new Map());
      const key = specKey(spec);
      const tally = votes.get(channel);
      tally.set(key, { spec, n: (tally.get(key)?.n ?? 0) + 1 });
    }
  }
  const out = {};
  for (const [channel, tally] of votes) out[channel] = [...tally.values()].sort((a, b) => b.n - a.n)[0].spec;
  return out;
}

// Channels whose workspace scale would change: { differ: [channels], unset: [channels] }.
export function scaleChanges(ws, consensus) {
  const differ = [];
  const unset = [];
  for (const [channel, spec] of Object.entries(consensus)) {
    const current = ws.channelSettings?.[channel]?.transform;
    if (!current) unset.push(channel);
    else if (specKey(current) !== specKey(spec)) differ.push(channel);
  }
  return { differ, unset };
}

// Do two spillover matrices ({ channels, matrix }) agree, whatever their channel order?
export function sameSpillover(a, b, tolerance = 1e-6) {
  if (!a || !b || a.channels.length !== b.channels.length) return false;
  const n = a.channels.length;
  const index = a.channels.map((c) => b.channels.indexOf(c));
  if (index.some((k) => k < 0)) return false;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (Math.abs(Number(a.matrix[i * n + j]) - Number(b.matrix[index[i] * n + index[j]])) > tolerance) return false;
    }
  }
  return true;
}

// How to give matched samples FlowJo's compensation: samples whose file spillover is FlowJo's
// matrix keep the file's ('file'); others share one workspace matrix per distinct FlowJo matrix.
// Returns [{ kind: 'file' | 'matrix', compensation, sampleIds, names }].
export function planCompensations(matches) {
  const plans = [];
  const fileIds = [];
  const fileNames = [];
  for (const { flowJo, sample } of matches) {
    const comp = flowJo.compensation;
    if (!sample || !comp) continue;
    const fileSpill = readSpillover(sample.keywords ?? {}, sample.channels ?? []);
    if (fileSpill && !fileSpill.identity && sameSpillover(fileSpill, comp)) {
      fileIds.push(sample.id);
      fileNames.push(sample.name);
      continue;
    }
    const existing = plans.find((p) => sameSpillover(p.compensation, comp, 1e-9));
    if (existing) {
      existing.sampleIds.push(sample.id);
      existing.names.push(sample.name);
    } else {
      plans.push({ kind: 'matrix', compensation: comp, sampleIds: [sample.id], names: [sample.name] });
    }
  }
  if (fileIds.length) plans.unshift({ kind: 'file', compensation: null, sampleIds: fileIds, names: fileNames });
  return plans;
}

// FlowJo writes some characters of parameter names as "_" ("LIVE/DEAD Aqua-A" becomes
// "LIVE_DEAD Aqua-A"). A FlowJo sample's channel names (its compensation, scales and gate
// dimensions) are mapped back to those of its matched file where that is unambiguous.
export function alignChannelNames(flowJo, sample) {
  const names = (sample?.channels ?? []).map((c) => c.name);
  const plain = (text) => text.replace(/[^A-Za-z0-9]/g, '_');
  let renamed = false;
  const nameOf = (channel) => {
    if (!channel || !names.length || names.includes(channel)) return channel;
    const found = names.filter((n) => plain(n) === plain(channel));
    if (found.length !== 1) return channel;
    renamed = true;
    return found[0];
  };
  const compensation = flowJo.compensation && { ...flowJo.compensation, channels: flowJo.compensation.channels.map(nameOf) };
  const transforms = Object.fromEntries(Object.entries(flowJo.transforms ?? {}).map(([channel, spec]) => [nameOf(channel), spec]));
  const gates = (flowJo.gates ?? []).map((g) => (g.dims?.length ? { ...g, dims: g.dims.map((d) => ({ ...d, channel: nameOf(d.channel) })) } : g));
  return renamed ? { ...flowJo, compensation, transforms, gates } : flowJo;
}

// Builds the whole import as one new workspace. options: { fileName, scales: 'all' | 'missing' |
// 'none', compensation (default true), now }. Returns { ws, migration, gates, fidelity, scales,
// compensations, groups, warnings }.
export function buildFlowJoMigration(ws, result, matches, options = {}) {
  const aligned = new Map(matches.map((m) => [m.flowJo, alignChannelNames(m.flowJo, m.sample)]));
  result = { ...result, samples: result.samples.map((s) => aligned.get(s) ?? s) };
  matches = matches.map((m) => ({ ...m, flowJo: aligned.get(m.flowJo) }));
  const fileName = options.fileName ?? 'FlowJo workspace';
  const time = options.now ?? new Date().toISOString();
  const warnings = [];
  let next = ws;
  const workspaceIdOf = new Map(matches.filter((m) => m.sample).map((m) => [m.flowJo, m.sample.id]));

  // Groups (FlowJo's built-in "All Samples" is every sample already).
  const groupIds = new Map();
  const groupsAdded = [];
  for (const group of result.groups ?? []) {
    if (group.builtIn || /^all samples$/i.test(group.name)) continue;
    const ids = result.samples.filter((s) => group.sampleIds.includes(s.sampleId)).map((s) => workspaceIdOf.get(s)).filter(Boolean);
    if (!ids.length) continue;
    const existing = next.groups.find((g) => g.name === group.name);
    if (existing) {
      next = updateGroup(next, existing.id, { sampleIds: [...new Set([...existing.sampleIds, ...ids])] });
      groupIds.set(group.name, existing.id);
    } else {
      const added = addGroup(next, group.name, ids);
      next = added.ws;
      groupIds.set(group.name, added.group.id);
      groupsAdded.push(group.name);
    }
  }

  // Compensation.
  const compensations = [];
  if (options.compensation !== false) {
    for (const plan of planCompensations(matches)) {
      if (plan.kind === 'file') {
        next = setSampleCompensation(next, plan.sampleIds, 'file');
        compensations.push({ kind: 'file', samples: plan.sampleIds.length });
        continue;
      }
      const { name, channels, matrix } = plan.compensation;
      const added = addCompensation(next, { name: `${name} (FlowJo)`, channels, matrix, source: 'imported', method: `FlowJo workspace ${fileName}` });
      next = setSampleCompensation(added.ws, plan.sampleIds, added.compensation.id);
      compensations.push({ kind: 'matrix', id: added.compensation.id, name: added.compensation.name, samples: plan.sampleIds.length });
    }
  }

  // Axis scales.
  const matched = result.samples.filter((s) => workspaceIdOf.has(s));
  const consensus = consensusTransforms(matched.length ? matched : result.samples);
  const scales = [];
  const mode = options.scales ?? 'all';
  if (mode !== 'none') {
    for (const [channel, spec] of Object.entries(consensus)) {
      const current = next.channelSettings?.[channel]?.transform;
      if (current && (mode === 'missing' || specKey(current) === specKey(spec))) continue;
      next = setChannelTransform(next, channel, spec);
      scales.push(channel);
    }
  }

  // The merged gate tree: overrides keyed by CytoWeave sample ids, group-only populations scoped.
  // FACSDiva gates belong to their tubes, so a gate some tubes have and no group matches gets a
  // group of exactly those tubes (FlowJo gates without a group apply to every sample, as in FlowJo).
  const ownGroups = new Map();
  const scopeFor = (present) => {
    const ids = new Set(present.map((s) => s.sampleId));
    for (const group of result.groups ?? []) {
      const groupId = groupIds.get(group.name);
      if (!groupId) continue;
      const members = new Set(group.sampleIds.filter((id) => result.samples.some((s) => s.sampleId === id)));
      if (members.size === ids.size && [...ids].every((id) => members.has(id))) return { scope: { groupId }, name: group.name };
    }
    if (result.format !== 'diva') return null;
    const workspaceIds = present.map((s) => workspaceIdOf.get(s)).filter(Boolean);
    if (!workspaceIds.length) return null;
    const key = [...ids].sort().join('|');
    if (!ownGroups.has(key)) {
      const name = present.length === 1 ? present[0].name : `${present[0].name} and ${present.length - 1} other tube${present.length > 2 ? 's' : ''}`;
      const added = addGroup(next, name, workspaceIds);
      next = added.ws;
      groupsAdded.push(name);
      ownGroups.set(key, { scope: { groupId: added.group.id }, name });
    }
    return ownGroups.get(key);
  };
  // FACSDiva gates belong to their tubes: with some tubes matched, the others' gates are left out
  // (they would apply to no sample); with none matched, every gate is imported as a template.
  let gateSamples = result.samples;
  if (result.format === 'diva' && result.samples.some((s) => workspaceIdOf.has(s))) {
    gateSamples = result.samples.filter((s) => workspaceIdOf.has(s));
    const left = result.samples.length - gateSamples.length;
    if (left) warnings.push(`The gates of ${left} FACSDiva tube${left === 1 ? '' : 's'} without an FCS file in this workspace were not imported; add the files and import the experiment again to include them.`);
  }
  const merged = mergeFlowJoGates(gateSamples, { keyOf: (s) => workspaceIdOf.get(s) ?? null, scopeFor });
  // Each sample's populations and the merged gate that computes them (FACSDiva tubes can give the
  // same path to different gates).
  const mergedIdOfKey = new Map(merged.gates.map((g) => [g.meta.flowJoKey, g.id]));
  const sampleGates = Object.fromEntries(result.samples.map((s) => [s.sampleId, Object.fromEntries(s.gates
    .filter((g) => !g.meta?.helper && g.meta?.flowJo?.path)
    .map((g) => [g.meta.flowJo.path, mergedIdOfKey.get(g.meta.flowJo.key ?? g.meta.flowJo.path)])
    .filter(([, id]) => id))]));
  warnings.push(...merged.warnings);
  const fidelity = summarizeFidelity([...(result.fidelity ?? []), ...merged.fidelity]);
  const gates = merged.gates.map((gate) => {
    const row = fidelity.byPath.get(gate.meta.flowJoPath);
    const meta = { ...gate.meta, origin: 'imported', flowJoFile: fileName, created: time };
    if (row && row.status !== 'imported') meta.note = `Approximated in the FlowJo import: ${fidelityNote(row)}`;
    return { ...gate, meta };
  });
  if (gates.length) next = addGates(next, gates, 'import-flowjo').ws;

  // The migration record, for the report.
  const migration = {
    id: newId('m'),
    source: fileName,
    flowJoVersion: result.flowJoVersion ?? null,
    sourceVersion: result.version ?? null,
    imported: time,
    samples: matches.map((m) => ({
      flowJoSampleId: m.flowJo.sampleId,
      flowJoName: m.flowJo.name,
      fileName: m.flowJo.fileName || null,
      sampleId: m.sample?.id ?? null,
      how: m.how,
      note: m.note || null,
      eventCount: m.flowJo.eventCount ?? null,
      counts: m.flowJo.populationCounts ?? {},
    })),
    gates: Object.fromEntries(gates.filter((g) => !g.meta.helper).map((g) => [g.meta.flowJoPath, g.id])),
    sampleGates,
    format: result.format ?? 'flowjo',
    fidelity: {
      counts: fidelity.counts,
      paths: fidelity.paths.filter((r) => r.status !== 'imported').map((r) => ({ path: r.path, status: r.status, note: fidelityNote(r, 6) })),
    },
    scales,
    groups: groupsAdded,
    compensations,
    comparison: null,
  };
  next = { ...next, migrations: [...(next.migrations ?? []), migration] };
  return { ws: next, migration, gates, fidelity, scales, compensations, groups: groupsAdded, warnings };
}

// --- The migration report --------------------------------------------------------------------

// How the import's source is named in the dialog and report: FlowJo 10 workspaces (.wsp),
// FlowJo 11 workbenches (.flowjo) and FACSDiva experiments (XML).
export function sourceOf(format, version = null) {
  if (format === 'diva') return { name: 'FACSDiva', what: 'experiment', sample: 'tube', label: version ? `FACSDiva ${String(version).replace(/^Version\s*/i, '')}` : 'FACSDiva' };
  if (format === 'flowjo11') return { name: 'FlowJo', what: 'workbench', sample: 'sample', label: 'FlowJo 11' };
  if (format === 'chorus') return { name: 'FACSChorus', what: 'gates', sample: 'file', label: version ? `FACSChorus ${version}` : 'FACSChorus' };
  return { name: 'FlowJo', what: 'workspace', sample: 'sample', label: version ? `FlowJo ${version}` : 'FlowJo' };
}

// The populations of one migrated sample (by its id in the imported file) and the gates that
// compute them: { path: gateId }.
export function migrationGates(migration, flowJoSampleId) {
  return migration.sampleGates?.[flowJoSampleId] ?? migration.gates;
}

// Rows comparing FlowJo's counts with CytoWeave's. counts: { [sampleId]: { [path]: count | null } }
// (from migration.comparison.counts). Status: 'exact', 'close' (within 1% or one event),
// 'differs', or 'missing' (no CytoWeave count: the population was not imported or not computed).
export function migrationCountRows(migration, counts = migration.comparison?.counts ?? {}) {
  const rows = [];
  for (const s of migration.samples) {
    if (!s.sampleId || !counts[s.sampleId]) continue;
    const ours = counts[s.sampleId];
    const compared = compareFlowJoCounts(s.counts, Object.fromEntries(Object.entries(ours).filter(([, v]) => v !== null)), { absolute: 1, relative: 0.01 });
    for (const row of compared) {
      const status = row.cytoweave === null ? 'missing' : row.difference === 0 ? 'exact' : row.agree ? 'close' : 'differs';
      rows.push({ ...row, sampleId: s.sampleId, sampleName: s.flowJoName, gateId: migrationGates(migration, s.flowJoSampleId)[row.path] ?? null, status });
    }
  }
  return sortCountRows(rows);
}

const ORDER = { differs: 0, missing: 1, close: 2, exact: 3 };

// Worst first: differing counts by relative difference, then missing, close and exact rows.
export function sortCountRows(rows) {
  return rows.sort((a, b) => ORDER[a.status] - ORDER[b.status]
    || Math.abs(b.relative ?? 0) - Math.abs(a.relative ?? 0)
    || a.path.localeCompare(b.path)
    || a.sampleName.localeCompare(b.sampleName));
}

export function summarizeCountRows(rows) {
  const summary = { exact: 0, close: 0, differs: 0, missing: 0 };
  for (const row of rows) summary[row.status] += 1;
  return summary;
}

// Likely causes for rows that are not exact, in plain language (row.causes).
export function explainCountRows(rows, migration) {
  const byKey = new Map(rows.map((r) => [`${r.sampleId}|${r.path}`, r]));
  const notes = new Map((migration.fidelity?.paths ?? []).map((p) => [p.path, p]));
  const samples = new Map(migration.samples.map((s) => [s.sampleId, s]));
  for (const row of rows) {
    const causes = [];
    if (row.status === 'exact') {
      row.causes = causes;
      continue;
    }
    const parentPath = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : null;
    const parent = parentPath ? byKey.get(`${row.sampleId}|${parentPath}`) : null;
    if (parent && (parent.status === 'differs' || parent.status === 'missing')) causes.push('its parent population already differs');
    const note = notes.get(row.path);
    if (note) {
      if (note.status === 'unsupported') causes.push(`not imported: ${note.note}`);
      else {
        if (/ellipse/i.test(note.note)) causes.push('the ellipse was refitted on the transformed axes');
        if (/uncompensated|compensat/i.test(note.note)) causes.push('the gate was drawn on differently compensated data');
        if (!causes.length || /curly|gain|not supported|absent/i.test(note.note)) causes.push(note.note);
      }
    }
    const sample = samples.get(row.sampleId);
    if (sample?.note) causes.push(`the FCS file may not be the one FlowJo analyzed (${sample.note})`);
    if (row.status === 'missing' && !note) causes.push('the population was not recomputed on this sample (its data could not be loaded or the gate does not apply)');
    const { name } = sourceOf(migration.format);
    if (row.status === 'close' && !causes.length) causes.push(`events on the gate boundary: ${name} evaluates gates at its display resolution`);
    // A small population differs by many percent when only a few boundary events move.
    if (row.status === 'differs' && !causes.length && Math.abs(row.difference) <= 20) causes.push(`only ${Math.abs(row.difference)} event${Math.abs(row.difference) === 1 ? '' : 's'} differ: events on the gate boundary, which ${name} evaluates at its display resolution`);
    // A small gate on a dense population: its outline holds many events, so display resolution
    // moves a few percent of them.
    if (row.status === 'differs' && !causes.length && Math.abs(row.relative) <= 0.05) causes.push(`${Math.abs(row.difference)} events near the gate's edge: ${name} evaluates gates at its display resolution, which matters most for a small gate drawn on a dense population`);
    if (row.status === 'differs' && !causes.length) causes.push("check this sample's compensation and the gate's position on its data");
    row.causes = [...new Set(causes)];
  }
  return rows;
}

function csvField(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// The report as CSV, one row per population and sample.
export function migrationCSV(rows) {
  const header = ['population', 'sample', 'flowjo_count', 'cytoweave_count', 'difference', 'difference_percent', 'status', 'likely_causes'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.path,
      r.sampleName,
      r.flowjo,
      r.cytoweave ?? '',
      r.difference ?? '',
      Number.isFinite(r.relative) ? (100 * r.relative).toFixed(3) : '',
      r.status,
      (r.causes ?? []).join('; '),
    ].map(csvField).join(','));
  }
  return `${lines.join('\n')}\n`;
}
