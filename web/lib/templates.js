// Analysis templates: a saved analysis (gates, scales, plots, tables, figure layouts and the
// compensation used) applied to another experiment. Channels are referred to by what they measure,
// not by their detector names: a fluorescence channel by its marker, scatter and time by name.
// Applying a template matches each of its channels to the experiment's and reports what matched,
// how, and what could not be applied.
//
// A template: { format, version, name, created, software, notes,
//   channels: { key: { name, marker, type } },
//   gates: [{ id, parentId, name, type, dims: [{ channel: key, transform, compensation? }],
//             geometry, color, linkId, meta, ontology? }],
//   plots: [{ populationId, x: key, y: key|null, type, options }],
//   tables: [{ name, heatmap, columns: [{ gateId, stat, channel: key|undefined, ... }] }],
//   figures: [{ name, width, height, background, items }] (plot items without a sample),
//   scales: { key: { transform, label } },
//   compensation: { source: 'file' | 'none' | 'computed', method } }
// Gates keep their geometry in the coordinates of their own transform, so a gate applies to the
// same data values on another experiment's matched channel.

import { newId } from './gates.js';
import { ROOT, addGates, channelCatalog, gateById, gateDescendants, setCollection, uniqueGateName } from './workspace.js';

export const TEMPLATE_FORMAT = 'cytoweave-template';
export const TEMPLATE_VERSION = 1;

// A marker name in a form that compares across panels: "HLA-DR", "HLA DR" and "hla-dr" agree.
// Spellings of the same marker ("TCRyd" for TCRγδ, "NK1/1" for NK1.1), after the rest of the
// normalization.
const ALIASES = { TCRYD: 'TCRGD', TCRGAMMADELTA: 'TCRGD', TCRB: 'TCRAB', TCRBETA: 'TCRAB', TCRALPHABETA: 'TCRAB', IFNY: 'IFNG', IFNGAMMA: 'IFNG', TNFALPHA: 'TNFA', TNF: 'TNFA' };

export function normalizeMarker(marker) {
  const plain = String(marker ?? '').toUpperCase().replace(/[\s_.\-–—/]+/g, '').replace(/Α/g, 'A').replace(/Β/g, 'B').replace(/Γ/g, 'G').replace(/Δ/g, 'D');
  return ALIASES[plain] ?? plain;
}

// Does a channel label ("CD3 FITC", "HLA DR APC") name the marker? Words and runs of up to three
// adjacent words are compared whole, so CD4 does not match "CD45 PE".
function labelHasMarker(label, marker) {
  const words = String(label ?? '').split(/[\s,;:()/]+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    for (let j = i; j < Math.min(words.length, i + 3); j += 1) if (normalizeMarker(words.slice(i, j + 1).join('')) === marker) return true;
  }
  return false;
}

const suffixOf = (name) => /-([AHW])$/i.exec(String(name))?.[1]?.toUpperCase() ?? '';

// --- Saving -----------------------------------------------------------------------------------

// The template of a workspace (or of the subtrees of gateIds). Gates on computed channels (QC
// pass, clusters, unmixed channels), per-sample adjustments and group scopes are left out and
// listed in notes.
export function buildTemplate(ws, options = {}) {
  const { name = `${ws.name} template`, gateIds = null, version = '' } = options;
  const catalog = new Map(channelCatalog(ws).map((c) => [c.name, c]));
  const notes = [];
  const keys = new Map();
  const channels = {};
  const keyOf = (channel) => {
    if (channel === null || channel === undefined) return null;
    if (keys.has(channel)) return keys.get(channel);
    const info = catalog.get(channel);
    const key = `c${keys.size + 1}`;
    keys.set(channel, key);
    channels[key] = { name: channel, marker: info?.marker || '', type: info?.type ?? 'fluorescence' };
    return key;
  };
  const computed = (channel) => catalog.get(channel)?.type === 'derived';

  // The gates to keep: the chosen subtrees (or all), without those on computed channels.
  let chosen = gateIds ? [...new Set(gateIds.flatMap((id) => [id, ...gateDescendants(ws, id).map((g) => g.id)]))].map((id) => gateById(ws, id)).filter(Boolean) : ws.gates.slice();
  chosen = chosen.filter((g) => !g.meta?.proposal);
  // A "QC pass" gate only filters events: it is left out, and the populations under it are kept
  // under its parent (the template's user runs QC and adds the gate again).
  const filters = new Map(chosen.filter((g) => g.dims.length === 1 && g.dims[0].channel === 'QC pass').map((g) => [g.id, g]));
  for (const gate of filters.values()) notes.push(`${gate.name} (acquisition QC) is left out and the populations under it are kept; run QC on the new samples and add the "QC pass" gate again.`);
  const liftedParent = (id) => {
    let parent = id;
    while (parent && filters.has(parent)) parent = filters.get(parent).parentId ?? null;
    return parent;
  };
  chosen = chosen.filter((g) => !filters.has(g.id)).map((g) => (filters.has(g.parentId) ? { ...g, parentId: liftedParent(g.parentId) } : g));
  const dropped = new Set();
  for (const gate of chosen) {
    if (gate.dims.some((d) => computed(d.channel))) {
      dropped.add(gate.id);
      for (const below of gateDescendants(ws, gate.id)) dropped.add(below.id);
      notes.push(`${gate.name} is on a computed channel (${gate.dims.map((d) => d.channel).filter(computed).join(', ')}) and is left out with the populations under it.`);
    }
  }
  const kept = chosen.filter((g) => !dropped.has(g.id));
  const keptIds = new Set(kept.map((g) => g.id));
  // A Boolean population needs its operands.
  for (const gate of kept.slice()) {
    if (gate.type === 'boolean' && !gate.geometry.operands.every((id) => keptIds.has(id))) {
      keptIds.delete(gate.id);
      notes.push(`${gate.name} combines populations that are not in the template and is left out.`);
    }
  }
  const gates = kept.filter((g) => keptIds.has(g.id)).map((g) => {
    if (g.overrides && Object.keys(g.overrides).length) notes.push(`${g.name}: its per-sample adjustments are not part of the template.`);
    if (g.scope?.groupId) notes.push(`${g.name} applied to one group only; in the template it applies to every sample.`);
    const meta = { ...(g.meta ?? {}) };
    for (const field of ['proposal', 'proposedBy', 'acceptedBy', 'accepted', 'drawnOn', 'copiedFrom', 'created']) delete meta[field];
    return {
      id: g.id,
      parentId: g.parentId && keptIds.has(g.parentId) ? g.parentId : null,
      name: g.name,
      type: g.type,
      dims: g.dims.map((d) => ({ channel: keyOf(d.channel), transform: d.transform ? { ...d.transform } : undefined, ...(d.compensation === 'uncompensated' ? { compensation: 'uncompensated' } : {}) })),
      geometry: structuredClone(g.geometry),
      color: g.color,
      linkId: g.linkId,
      meta,
      ...(g.ontology ? { ontology: { ...g.ontology } } : {}),
    };
  });
  const gateRef = (id) => {
    const lifted = filters.has(id) ? liftedParent(id) : id;
    return lifted === ROOT || lifted === null || lifted === undefined ? ROOT : keptIds.has(lifted) ? lifted : undefined;
  };
  const plots = (ws.plots ?? []).filter((p) => gateRef(p.populationId) !== undefined && ![p.x, p.y].some((c) => c && computed(c)))
    .map((p) => ({ populationId: gateRef(p.populationId), x: keyOf(p.x), y: keyOf(p.y), type: p.type, options: { ...(p.options ?? {}) } }));
  const tables = (ws.tables ?? []).map((t) => ({
    name: t.name,
    heatmap: t.heatmap,
    columns: t.columns.filter((c) => gateRef(c.gateId) !== undefined && !(c.channel && computed(c.channel))).map((c) => {
      const { id, ...rest } = c;
      return { ...rest, gateId: gateRef(c.gateId), ...(c.channel ? { channel: keyOf(c.channel) } : {}) };
    }),
  })).filter((t) => t.columns.length);
  const figures = (ws.figures ?? []).filter((f) => !f.proposal).map((f) => ({
    name: f.name,
    width: f.width,
    height: f.height,
    background: f.background,
    items: f.items.filter((item) => item.kind !== 'plot' || (gateRef(item.spec.populationId) !== undefined && ![item.spec.x, item.spec.y].some((c) => c && computed(c)))).map((item) => {
      if (item.kind !== 'plot') return { ...item };
      const { sampleId, ...rest } = item;
      return { ...rest, spec: { ...item.spec, populationId: gateRef(item.spec.populationId), x: keyOf(item.spec.x), y: keyOf(item.spec.y) }, ...(item.highlight ? { highlight: keptIds.has(item.highlight) ? item.highlight : undefined } : {}) };
    }),
  }));
  const scales = {};
  for (const [channel, key] of keys) {
    const settings = ws.channelSettings?.[channel];
    if (settings?.transform || settings?.label) scales[key] = { ...(settings.transform ? { transform: { ...settings.transform } } : {}), ...(settings.label ? { label: settings.label } : {}) };
  }
  // The compensation most samples use.
  const sources = ws.samples.filter((s) => s.role === 'sample' || s.role === 'reference').map((s) => (s.compensationId === 'file' ? 'file' : s.compensationId && s.compensationId !== 'none' ? 'computed' : 'none'));
  const counts = sources.reduce((m, s) => m.set(s, (m.get(s) ?? 0) + 1), new Map());
  const source = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
  const usedMatrix = source === 'computed' ? ws.compensations.find((c) => ws.samples.some((s) => s.compensationId === c.id)) : null;
  return {
    format: TEMPLATE_FORMAT,
    version: TEMPLATE_VERSION,
    name,
    created: new Date().toISOString(),
    software: `CytoWeave ${version}`.trim(),
    notes,
    channels,
    gates,
    plots,
    tables,
    figures,
    scales,
    compensation: { source, ...(usedMatrix ? { method: usedMatrix.method ?? usedMatrix.source ?? null, name: usedMatrix.name } : {}) },
  };
}

export function isTemplate(value) {
  return value?.format === TEMPLATE_FORMAT && Array.isArray(value.gates) && typeof value.channels === 'object';
}

export function parseTemplate(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The file is not a CytoWeave template (it is not JSON).');
  }
  if (!isTemplate(value)) throw new Error('The file is not a CytoWeave template.');
  if (value.version > TEMPLATE_VERSION) throw new Error(`The template is of a newer format (version ${value.version}); update CytoWeave to open it.`);
  return value;
}

// --- Matching ---------------------------------------------------------------------------------

// The experiment's channel for each of the template's: { key: { channel, how, note } }, how being
// 'name' (same detector), 'marker', 'marker in the label', or null when nothing matched (with the
// reason). A fluorescence channel with a marker matches by marker, preferring the same area,
// height or width suffix; scatter, time and channels without a marker match by name.
export function matchChannels(template, catalog, overrides = {}) {
  const channels = catalog.filter((c) => c.type !== 'derived');
  const byName = new Map(channels.map((c) => [c.name, c]));
  const byLowerName = new Map(channels.map((c) => [c.name.toLowerCase(), c]));
  const used = new Map();
  const out = {};
  for (const [key, wanted] of Object.entries(template.channels)) {
    if (overrides[key]) {
      out[key] = byName.has(overrides[key]) ? { channel: overrides[key], how: 'chosen' } : { channel: null, how: null, note: `${overrides[key]} is not a channel of these samples` };
      continue;
    }
    const marker = normalizeMarker(wanted.marker);
    let found = null;
    if (marker && wanted.type === 'fluorescence') {
      const suffix = suffixOf(wanted.name);
      const exact = channels.filter((c) => normalizeMarker(c.marker) === marker);
      const inLabel = exact.length ? [] : channels.filter((c) => labelHasMarker(c.label, marker));
      const candidates = exact.length ? exact : inLabel;
      const sameSuffix = candidates.filter((c) => suffixOf(c.name) === suffix);
      const pool = sameSuffix.length ? sameSuffix : candidates;
      const preferred = pool.find((c) => c.name === wanted.name) ?? pool[0];
      if (preferred) {
        found = { channel: preferred.name, how: exact.length ? 'marker' : 'marker in the label' };
        if (pool.length > 1) found.note = `${pool.length} channels measure ${wanted.marker}${suffix ? `-${suffix}` : ''} (${pool.map((c) => c.name).join(', ')}); ${preferred.name} was used`;
        else if (!sameSuffix.length && suffix) found.note = `no ${suffix === 'A' ? 'area' : suffix === 'H' ? 'height' : 'width'} channel measures ${wanted.marker}; ${preferred.name} was used`;
      }
    }
    if (!found) {
      const same = byName.get(wanted.name) ?? byLowerName.get(wanted.name.toLowerCase());
      if (same && (!marker || !normalizeMarker(same.marker) || normalizeMarker(same.marker) === marker || wanted.type !== 'fluorescence')) {
        found = { channel: same.name, how: 'name' };
      } else if (same && marker) {
        found = { channel: null, how: null, note: `${wanted.name} measures ${same.marker} here, not ${wanted.marker}, and no channel measures ${wanted.marker}` };
      }
    }
    out[key] = found ?? { channel: null, how: null, note: marker && wanted.type === 'fluorescence' ? `no channel measures ${wanted.marker}` : `no channel ${wanted.name}` };
    if (out[key].channel) used.set(out[key].channel, [...(used.get(out[key].channel) ?? []), key]);
  }
  // Two template channels on one channel of the experiment (e.g. CD3 and CD3-FITC): report it.
  for (const [channel, list] of used) {
    if (list.length < 2) continue;
    for (const key of list) out[key].note = [out[key].note, `${list.map((k) => template.channels[k].marker || template.channels[k].name).join(' and ')} both matched ${channel}`].filter(Boolean).join('; ');
  }
  return out;
}

// --- Applying ---------------------------------------------------------------------------------

// Applies a template to a workspace. options: parentId (where its top gates go; default the top
// of the tree), overrides ({ key: channel } chosen by the user), scales ('keep': leave the
// workspace's own scales (default), 'replace'), sampleId (the sample of figure plots; default
// the first sample), tables, plots, figures (default true). Returns { ws, report, idMap }.
export function applyTemplate(ws, template, options = {}) {
  const { parentId = null, overrides = {}, scales = 'keep', tables = true, plots = true, figures = true } = options;
  const match = matchChannels(template, channelCatalog(ws), overrides);
  const channelOf = (key) => (key === null || key === undefined ? null : match[key]?.channel ?? undefined);
  const skipped = [];
  const idMap = new Map();
  const linkMap = new Map();
  const unusable = new Set();
  // Gates are placed once their parent and, for Boolean populations, their operands are.
  const records = [];
  let working = ws;
  const pending = template.gates.slice();
  const decided = new Set();
  const ready = (g) => (!g.parentId || decided.has(g.parentId)) && (g.type !== 'boolean' || g.geometry.operands.every((op) => decided.has(op)));
  while (pending.length) {
    const at = pending.findIndex(ready);
    if (at < 0) {
      for (const g of pending) skipped.push({ gate: g.name, reason: 'its parent or a population it combines is not in the template' });
      break;
    }
    const [g] = pending.splice(at, 1);
    decided.add(g.id);
    if (g.parentId && unusable.has(g.parentId)) {
      unusable.add(g.id);
      skipped.push({ gate: g.name, reason: 'its parent was not applied' });
      continue;
    }
    const missing = g.dims.filter((d) => !channelOf(d.channel)).map((d) => template.channels[d.channel]);
    if (missing.length) {
      unusable.add(g.id);
      skipped.push({ gate: g.name, reason: `no channel for ${missing.map((c) => c.marker || c.name).join(', ')}` });
      continue;
    }
    if (g.type === 'boolean' && g.geometry.operands.some((id) => unusable.has(id))) {
      unusable.add(g.id);
      skipped.push({ gate: g.name, reason: 'a population it combines was not applied' });
      continue;
    }
    const id = newId('g');
    idMap.set(g.id, id);
    let linkId;
    if (g.linkId) {
      if (!linkMap.has(g.linkId)) linkMap.set(g.linkId, newId('l'));
      linkId = linkMap.get(g.linkId);
    }
    const parent = g.parentId ? idMap.get(g.parentId) : (parentId === ROOT ? null : parentId);
    const record = {
      id,
      parentId: parent,
      name: uniqueGateName({ ...working, gates: [...working.gates, ...records] }, parent, g.name),
      type: g.type,
      dims: g.dims.map((d) => ({ channel: channelOf(d.channel), ...(d.transform ? { transform: { ...d.transform } } : {}), ...(d.compensation ? { compensation: d.compensation } : {}) })),
      geometry: g.type === 'boolean' ? { ...g.geometry, operands: g.geometry.operands.map((op) => idMap.get(op)) } : structuredClone(g.geometry),
      color: g.color,
      ...(linkId ? { linkId } : {}),
      meta: { ...(g.meta ?? {}), origin: 'template', template: template.name, created: new Date().toISOString() },
      // A cell type comes as a suggestion, for the user to confirm on this experiment's data.
      ...(g.ontology ? { ontology: { id: g.ontology.id, label: g.ontology.label, status: 'suggested', source: g.ontology.status === 'confirmed' ? `the template ${template.name} (confirmed there)` : g.ontology.source ?? `the template ${template.name}` } } : {}),
    };
    // A recipe gate is placed on the data of its parent population (recipes.js).
    if (g.type === 'recipe') {
      const placed = options.place ? options.place(record, g.recipe, working) : { error: 'placing it needs the samples\' events' };
      if (!placed || placed.error) {
        idMap.delete(g.id);
        unusable.add(g.id);
        skipped.push({ gate: g.name, reason: placed?.error ?? 'it could not be placed' });
        continue;
      }
      record.type = placed.type;
      record.geometry = placed.geometry;
      if (placed.dims) record.dims = placed.dims;
      record.meta = { ...record.meta, origin: 'auto', method: g.recipe.method, note: placed.explanation, placedOn: placed.sampleName };
    }
    records.push(record);
    // Added at once, so that a recipe below it is placed on its population.
    working = addGates(working, [record], 'apply-template').ws;
  }

  // Scales and labels of matched channels.
  const scaleChanges = [];
  if (template.scales) {
    const channelSettings = { ...(working.channelSettings ?? {}) };
    for (const [key, setting] of Object.entries(template.scales)) {
      const channel = channelOf(key);
      if (!channel) continue;
      const current = channelSettings[channel] ?? {};
      if (scales === 'keep' && current.transform) continue;
      channelSettings[channel] = { ...current, ...(setting.transform ? { transform: { ...setting.transform } } : {}), ...(setting.label && !current.label ? { label: setting.label } : {}) };
      scaleChanges.push(channel);
    }
    if (scaleChanges.length) working = setCollection(working, 'channelSettings', channelSettings, 'apply-template-scales');
  }

  const gateRef = (id) => (id === ROOT ? ROOT : idMap.get(id));
  let plotCount = 0;
  if (plots && template.plots?.length) {
    const added = template.plots.filter((p) => gateRef(p.populationId) && channelOf(p.x) && (p.y === null || channelOf(p.y)))
      .map((p) => ({ id: newId('p'), populationId: gateRef(p.populationId), x: channelOf(p.x), y: p.y === null ? null : channelOf(p.y), type: p.type, options: { ...(p.options ?? {}) } }));
    plotCount = added.length;
    if (added.length) working = setCollection(working, 'plots', [...(working.plots ?? []), ...added], 'apply-template-plots');
  }
  let tableCount = 0;
  if (tables && template.tables?.length) {
    const added = template.tables.map((t) => ({
      id: newId('t'),
      name: t.name,
      groupId: null,
      heatmap: t.heatmap,
      columns: t.columns.filter((c) => gateRef(c.gateId) && (!c.channel || channelOf(c.channel))).map((c) => ({ ...c, id: newId('col'), gateId: gateRef(c.gateId), ...(c.channel ? { channel: channelOf(c.channel) } : {}) })),
    })).filter((t) => t.columns.length);
    tableCount = added.length;
    if (added.length) working = setCollection(working, 'tables', [...(working.tables ?? []), ...added], 'apply-template-tables');
  }
  let figureCount = 0;
  const sampleId = options.sampleId ?? working.samples.find((s) => s.role === 'sample')?.id ?? working.samples[0]?.id ?? null;
  if (figures && template.figures?.length && sampleId) {
    const added = template.figures.map((f) => ({
      id: newId('f'),
      name: f.name,
      width: f.width,
      height: f.height,
      background: f.background,
      items: f.items.filter((item) => item.kind !== 'plot' || (gateRef(item.spec.populationId) && channelOf(item.spec.x) && (item.spec.y === null || channelOf(item.spec.y)))).map((item) => (item.kind !== 'plot' ? { ...item, id: newId('i') } : {
        ...item,
        id: newId('i'),
        sampleId,
        spec: { ...item.spec, populationId: gateRef(item.spec.populationId), x: channelOf(item.spec.x), y: item.spec.y === null ? null : channelOf(item.spec.y) },
        ...(item.highlight ? { highlight: idMap.get(item.highlight) } : {}),
      })),
    }));
    figureCount = added.length;
    working = setCollection(working, 'figures', [...(working.figures ?? []), ...added], 'apply-template-figures');
  }

  const channels = Object.entries(template.channels).map(([key, c]) => ({ key, template: c.marker ? `${c.marker} (${c.name})` : c.name, channel: match[key].channel, how: match[key].how, note: match[key].note }));
  const report = {
    template: template.name,
    channels,
    matched: channels.filter((c) => c.channel).length,
    unmatched: channels.filter((c) => !c.channel).length,
    gates: { applied: records.length, skipped },
    plots: plotCount,
    tables: tableCount,
    figures: figureCount,
    scales: scaleChanges,
    compensation: template.compensation ?? null,
    notes: template.notes ?? [],
  };
  return { ws: working, report, idMap, gates: records };
}
