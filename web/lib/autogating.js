// Autogating across samples: a gate's exemplars in a workspace, and its adaptation (adapt.js) to
// every other sample, as the review dialog, the agent tool and the validation suite run it.
//
// Exemplars, in order of authority:
//   - 'adjusted': samples the user adjusted the gate on (its overrides);
//   - 'confirmed': samples where the user confirmed the gate as it is (gate.meta.confirmed);
//   - 'drawn': the sample the shared gate was drawn or last moved on (gate.meta.drawnOn);
//   - 'chosen': without any of these, the sample on which the shared boundary sits deepest in
//     density valleys (the least boundary-sensitive), so there is always a reference.
// Linked quadrants and splits move as one: their shared center or threshold is adapted once.
//
// options.groupBy names a sample metadata field (a subject, a donor, a batch) whose samples keep
// one gate, as when stimulated and unstimulated wells of a donor are gated alike so that the
// stimulation's effect is measured rather than gated away: a group is adapted once, on its
// samples' pooled events, and a group holding an exemplar takes the exemplar's gate as it is.

import { indexList, adaptGate, decide, members, jaccard, boundarySensitivity, ADAPTABLE, ADAPT_DEFAULTS } from './adapt.js';
import { populationSet } from './engine.js';
import { effectiveGeometry, gateAncestors, gateById } from './workspace.js';

export const AUTOGATING_METHOD = 'landmark registration of the parent population\'s density along each gate axis (after flowStats\' gaussNorm), from the most similar exemplar samples, with an ensemble over exemplars, smoothing bandwidths, halves of the events and left-out landmarks';

function sampleData(ws, gate, view) {
  const parent = gate.parentId ? populationSet(view, ws, gate.parentId) : null;
  if (parent === undefined) return null;
  if (gate.dims.some((d) => !view.hasChannel(d.channel, d.compensation))) return null;
  return {
    columns: gate.dims.map((d) => view.scaled(d.channel, d.transform, d.compensation)),
    list: indexList(parent, view.eventCount),
  };
}

// Can this gate be adapted? Returns null, or the reason it cannot.
export function cannotAdapt(gate) {
  if (!gate) return 'no gate';
  if (!ADAPTABLE.has(gate.type)) return `${gate.type} gates cannot be adapted`;
  if (gate.dims.length > 2) return 'gates of three or more dimensions cannot be adapted';
  return null;
}

// The gate's exemplars among the samples with views: [{ sampleId, geometry, kind, columns, list }].
export function exemplarsOf(ws, gate, views) {
  const out = [];
  const add = (sampleId, geometry, kind) => {
    if (out.some((e) => e.sampleId === sampleId)) return;
    const view = views.get(sampleId);
    if (!view) return;
    const data = sampleData(ws, gate, view);
    if (data && data.list.length) out.push({ sampleId, geometry, kind, ...data });
  };
  for (const [sampleId, geometry] of Object.entries(gate.overrides ?? {})) add(sampleId, geometry, 'adjusted');
  for (const sampleId of Object.keys(gate.meta?.confirmed ?? {})) add(sampleId, effectiveGeometry(gate, sampleId), 'confirmed');
  if (gate.meta?.drawnOn && !gate.overrides?.[gate.meta.drawnOn]) add(gate.meta.drawnOn, gate.geometry, 'drawn');
  if (!out.length) {
    let best = null;
    for (const [sampleId, view] of views) {
      const data = sampleData(ws, gate, view);
      if (!data || !data.list.length) continue;
      const s = boundarySensitivity(gate.type, gate.geometry, data.columns, data.list);
      if (!best || s < best.s) best = { sampleId, s };
    }
    if (best) add(best.sampleId, gate.geometry, 'chosen');
  }
  return out;
}

// Samples where an ancestor of the gate is still under review: { sampleId → ancestor's name },
// from the latest autogating record of each ancestor (a sample the user has since adjusted or
// confirmed the ancestor on no longer counts).
export function ancestorsUnderReview(ws, gate) {
  const out = new Map();
  for (const ancestor of gateAncestors(ws, gate.id)) {
    const record = [...(ws.derived ?? [])].reverse().find((d) => d.kind === 'autogating' && d.gateId === ancestor.id);
    for (const [sampleId, r] of Object.entries(record?.results ?? {})) {
      if (r.status !== 'review') continue;
      if (ancestor.overrides?.[sampleId] || ancestor.meta?.confirmed?.[sampleId]) continue;
      if (!out.has(sampleId)) out.set(sampleId, ancestor.name);
    }
  }
  return out;
}

// Adapts a gate to every sample with a view (other than its exemplars). options.underReview
// (Map sampleId → ancestor name) overrides ancestorsUnderReview: such samples are sent to review
// too, since the gate's parent population there is not yet right. options.groupBy: see above.
// Returns { gateId, exemplars: [{ sampleId, kind }], results: [{ sampleId, ...adaptGate result,
// group }], skipped: [{ sampleId, reason }] }.
export function adaptAcrossSamples(ws, gateId, views, options = {}) {
  const gate = gateById(ws, gateId);
  const reason = cannotAdapt(gate);
  if (reason) throw new Error(reason);
  const o = { ...ADAPT_DEFAULTS, ...options };
  const exemplars = exemplarsOf(ws, gate, views);
  if (!exemplars.length) throw new Error('No sample holds the gate\'s population, so there is nothing to learn from.');
  const ids = new Set(exemplars.map((e) => e.sampleId));
  const underReview = options.underReview ?? ancestorsUnderReview(ws, gate);
  const sampleOf = (id) => ws.samples.find((s) => s.id === id);
  const groupOf = (id) => {
    const value = options.groupBy ? sampleOf(id)?.meta?.[options.groupBy] : undefined;
    return value === undefined || value === null || value === '' ? null : String(value);
  };
  const groups = new Map();
  const skipped = [];
  for (const [sampleId, view] of views) {
    if (ids.has(sampleId)) continue;
    if (options.sampleIds && !options.sampleIds.includes(sampleId)) continue;
    const target = sampleData(ws, gate, view);
    if (!target) {
      skipped.push({ sampleId, reason: 'the gate does not apply to this sample' });
      continue;
    }
    if (target.list.length < 50) {
      skipped.push({ sampleId, reason: `only ${target.list.length} events in the parent population` });
      continue;
    }
    const key = groupOf(sampleId) ?? `sample ${sampleId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ sampleId, target });
  }
  // A sample's own values for a gate adapted elsewhere (on its group, or an exemplar's).
  const own = (result, { sampleId, target }, extra = {}) => {
    const current = effectiveGeometry(gate, sampleId);
    const adaptedMask = members(gate.type, result.geometry, target.columns, target.list);
    const currentMask = members(gate.type, current, target.columns, target.list);
    const n = target.list.length || 1;
    const count = (mask) => mask.reduce((sum, v) => sum + v, 0);
    return {
      ...result,
      change: jaccard(currentMask, adaptedMask),
      sensitivity: { exemplar: result.sensitivity?.exemplar ?? 0, adapted: boundarySensitivity(gate.type, result.geometry, target.columns, target.list), current: boundarySensitivity(gate.type, current, target.columns, target.list) },
      list: target.list,
      frequencies: { current: count(currentMask) / n, adapted: count(adaptedMask) / n },
      ...extra,
    };
  };
  const results = [];
  const shared = new Set();
  const unlike = new Set();
  for (const [key, targets] of groups) {
    const group = groupOf(targets[0].sampleId);
    const exemplar = group === null ? null : exemplars.find((e) => groupOf(e.sampleId) === group);
    if (exemplar) {
      // The group's own exemplar: its gate, as it is.
      const name = sampleOf(exemplar.sampleId)?.name ?? exemplar.sampleId;
      for (const t of targets) {
        const r = own({ geometry: exemplar.geometry, confidence: 1, agreement: 1, alignment: 1, boundary: 1, exemplars: [{ sampleId: exemplar.sampleId, similarity: 1 }], members: 1 }, t);
        r.probabilities = members(gate.type, exemplar.geometry, t.target.columns, t.target.list).map(Number);
        r.status = r.change >= o.unchanged ? 'keep' : 'adjust';
        r.reason = r.status === 'keep' ? 'the gate already fits' : `shares the gate of ${name}, of the same ${options.groupBy}`;
        results.push({ sampleId: t.sampleId, ...r, group });
        shared.add(t.sampleId);
      }
      continue;
    }
    if (targets.length === 1) {
      const [t] = targets;
      results.push({ sampleId: t.sampleId, ...adaptGate({ type: gate.type, current: effectiveGeometry(gate, t.sampleId), exemplars, target: t.target, options: o }), group });
      continue;
    }
    // The group's samples, pooled, adapted once.
    const total = targets.reduce((sum, t) => sum + t.target.list.length, 0);
    const columns = gate.dims.map(() => new Float32Array(total));
    const offsets = [];
    let at = 0;
    for (const t of targets) {
      offsets.push(at);
      for (const e of t.target.list) {
        t.target.columns.forEach((column, axis) => { columns[axis][at] = column[e]; });
        at += 1;
      }
    }
    const pooled = adaptGate({ type: gate.type, current: effectiveGeometry(gate, targets[0].sampleId), exemplars, target: { columns, list: indexList(null, total) }, options: { ...o, fullProbabilities: true } });
    // One decision for the group, from its pooled events, so that its samples keep one gate; a
    // sample whose own events would put the gate elsewhere is unlike the rest of its group, and
    // goes to review.
    targets.forEach((t, i) => {
      const r = own(pooled, t, { probabilities: pooled.probabilities.slice(offsets[i], offsets[i] + t.target.list.length), group });
      const alone = adaptGate({ type: gate.type, current: effectiveGeometry(gate, t.sampleId), exemplars, target: t.target, options: o });
      const agreement = jaccard(members(gate.type, alone.geometry, t.target.columns, t.target.list), members(gate.type, pooled.geometry, t.target.columns, t.target.list));
      if (agreement < o.groupAgreement) unlike.add(t.sampleId);
      results.push({ sampleId: t.sampleId, ...r, change: pooled.change, sensitivity: pooled.sensitivity });
    });
  }
  // Each adapted boundary is judged against the cohort's: the median boundary density of the
  // adapted gates (and the exemplars'), so the choice of exemplar does not bias it.
  const adapted = results.filter((r) => !shared.has(r.sampleId));
  const densities = [...adapted.map((r) => r.sensitivity.adapted), ...adapted.map((r) => r.sensitivity.exemplar).slice(0, 1)].sort((a, b) => a - b);
  const typical = densities.length ? densities[Math.floor((densities.length - 1) / 2)] : 0;
  for (let i = 0; i < results.length; i += 1) {
    let r = results[i];
    if (adapted.length > 2 && !shared.has(r.sampleId)) r = { sampleId: r.sampleId, ...decide(r, typical, { ...options, cohort: true }) };
    if (unlike.has(r.sampleId) && r.status !== 'review') {
      r.status = 'review';
      r.reason = `its own events would put the gate elsewhere than the other samples of its ${options.groupBy} do`;
    }
    const parent = underReview.get(r.sampleId);
    if (parent && r.status !== 'review') {
      r.status = 'review';
      r.reason = `its ancestor "${parent}" is under review for this sample`;
    }
    results[i] = r;
  }
  return { gateId, groupBy: options.groupBy ?? null, exemplars: exemplars.map((e) => ({ sampleId: e.sampleId, kind: e.kind })), results, skipped };
}

// A record of an adaptation for the workspace (and the methods paragraph).
export function autogatingRecord(ws, gate, run, applied, version) {
  return {
    kind: 'autogating',
    name: `Autogating of ${gate.name}`,
    gateId: gate.id,
    method: AUTOGATING_METHOD,
    params: { confident: run.options?.confident ?? ADAPT_DEFAULTS.confident, bandwidths: ADAPT_DEFAULTS.bandwidths, maxShift: ADAPT_DEFAULTS.maxShift, exemplars: run.exemplars, ...(run.groupBy ? { groupBy: run.groupBy } : {}) },
    seed: ADAPT_DEFAULTS.seed,
    software: `CytoWeave ${version ?? ''}`.trim(),
    results: Object.fromEntries(run.results.map((r) => [r.sampleId, { status: r.status, reason: r.reason, confidence: +r.confidence.toFixed(3), applied: applied.includes(r.sampleId) }])),
  };
}
