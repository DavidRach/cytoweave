// Counterfactual preprocessing: does a comparison's conclusion survive other reasonable analysis
// choices? The declared analysis (the workspace as it is) is repeated under alternatives, each
// one at a time and then in random combinations, and the effect and its test are recomputed for
// every specification. This is a multiverse or specification-curve analysis (Steegen, Tuerlinckx,
// Gelman & Vanpaemel 2016, doi:10.1177/1745691616658637; Simonsohn, Simmons & Nelson 2020,
// doi:10.1038/s41562-020-0912-z) applied to cytometry preprocessing:
// - gate boundaries: each gate on the population's path moved 1% and 2% of the axis outward or
//   inward, as another analyst might draw it (gateRobustness does this for one gate);
// - gates per sample: the shared gate without per-sample adjustments, or adapted to each sample
//   by landmark registration (autogating.js), which follows instrument and staining shifts;
// - acquisition QC: the "QC pass" gate removed, or QC re-run with other settings;
// - compensation: another matrix (the file's, or one computed from the controls);
// - the test: parametric or rank-based.
// Scales are not varied: a gate drawn by hand follows the population on whatever scale it was
// drawn on, so changing the scale under it would only redraw the same region; the boundary
// variants cover where it was drawn.
//
// The declared analysis stays the result. This reports how much it depends on choices that
// could reasonably have been made otherwise, and which ones; it is not a search for the best one.

import { computeStatistic } from './engine.js';
import { ROOT, gateAncestors, gateById, gateChildren } from './workspace.js';
import { offsetGeometry } from './gates.js';
import { mannWhitneyU, pairedTTest, welchTTest, wilcoxonSignedRank } from './hypothesis.js';
import { createRandom } from './random.js';
import { adaptAcrossSamples, cannotAdapt } from './autogating.js';

export const BOUNDARY_STEPS = [-0.02, -0.01, 0.01, 0.02];
const OFFSETTABLE = new Set(['rectangle', 'range', 'ellipse', 'polygon', 'split', 'quadrant']);

// --- Specifications -----------------------------------------------------------------------------

// The specifications to run: the declared one, every alternative alone, then random combinations
// (seeded) up to `max` in all. choices: [{ id, options: [declared, ...alternatives] }]. Returns
// [{ picks: [option index per choice], kind: 'declared' | 'single' | 'combined', changed }].
export function specifications(choices, options = {}) {
  const max = options.max ?? 64;
  const out = [{ picks: choices.map(() => 0), kind: 'declared', changed: 0 }];
  const seen = new Set([out[0].picks.join(',')]);
  choices.forEach((choice, c) => {
    for (let o = 1; o < choice.options.length; o += 1) {
      const picks = choices.map((_, k) => (k === c ? o : 0));
      seen.add(picks.join(','));
      out.push({ picks, kind: 'single', changed: 1 });
    }
  });
  const random = createRandom(options.seed ?? 1);
  const variable = choices.map((choice, c) => (choice.options.length > 1 ? c : -1)).filter((c) => c >= 0);
  let space = 1;
  for (const choice of choices) space *= choice.options.length;
  let attempts = 0;
  while (out.length < max && out.length < space && attempts < 50 * max) {
    attempts += 1;
    // Each choice keeps its declared option or takes a random alternative, so combinations of a
    // few changes are as likely as combinations of many.
    const picks = choices.map((choice) => (choice.options.length > 1 && random() < 0.5 ? 1 + Math.floor(random() * (choice.options.length - 1)) : 0));
    const changed = picks.filter((p) => p > 0).length;
    if (changed < 2 && variable.length >= 2) continue;
    const key = picks.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ picks, kind: 'combined', changed });
  }
  return out;
}

// --- Tests --------------------------------------------------------------------------------------

// A two-group comparison: { estimate (B − A; the mean paired difference when paired), ci, p,
// n: [nA, nB] }. design: 'two' | 'paired-two'; test: 'parametric' | 'rank'. For a paired design
// a and b are aligned by subject.
export function compareTwo(design, test, a, b) {
  if (design === 'paired-two') {
    const t = pairedTTest(b, a);
    const p = test === 'rank' ? wilcoxonSignedRank(b, a).p : t.p;
    return { estimate: t.estimate, ci: t.ci, p, n: [a.length, b.length] };
  }
  const t = welchTTest(b, a);
  const p = test === 'rank' ? mannWhitneyU(b, a).p : t.p;
  return { estimate: t.estimate, ci: t.ci, p, n: [a.length, b.length] };
}

// 'higher' | 'lower' (B against A, significant at alpha) | 'none'.
export function conclusionOf(result, alpha = 0.05) {
  if (!result || !(result.p < alpha)) return 'none';
  return result.estimate > 0 ? 'higher' : result.estimate < 0 ? 'lower' : 'none';
}

// --- Workspace variants -------------------------------------------------------------------------

// The gates a statistic depends on: its population's ancestors and itself, from the root, and
// those of the population it is a frequency of (they are on the same path or another one).
export function pathGates(ws, gateId, ancestorId = null) {
  const ids = [];
  const add = (id) => {
    if (!id || id === ROOT) return;
    for (const g of [...gateAncestors(ws, id), gateById(ws, id)]) if (g && !ids.includes(g.id)) ids.push(g.id);
  };
  add(ancestorId);
  add(gateId);
  return ids.map((id) => gateById(ws, id)).filter(Boolean);
}

// A workspace with one gate's boundary moved by `distance` (in scale units, 0.01 = 1% of the
// axis), shared geometry and per-sample adjustments alike.
export function offsetGate(ws, gateId, distance) {
  return {
    ...ws,
    gates: ws.gates.map((g) => {
      if (g.id !== gateId) return g;
      const overrides = g.overrides ? Object.fromEntries(Object.entries(g.overrides).map(([id, geom]) => [id, offsetGeometry(g.type, geom, distance)])) : g.overrides;
      return { ...g, geometry: offsetGeometry(g.type, g.geometry, distance), overrides };
    }),
  };
}

// A workspace with some gates' per-sample adjustments replaced: by `overrides` (gateId → { sampleId
// → geometry }), or removed when it is null.
export function withOverrides(ws, gateIds, overrides = null) {
  const set = new Set(gateIds);
  return { ...ws, gates: ws.gates.map((g) => (set.has(g.id) ? { ...g, overrides: overrides ? { ...(overrides[g.id] ?? {}) } : {} } : g)) };
}

// A workspace without one gate, its children moved to its parent (the "QC pass" gate removed).
export function withoutGate(ws, gateId) {
  const gate = gateById(ws, gateId);
  if (!gate) return ws;
  const children = new Set(gateChildren(ws, gateId).map((g) => g.id));
  return { ...ws, gates: ws.gates.filter((g) => g.id !== gateId).map((g) => (children.has(g.id) ? { ...g, parentId: gate.parentId ?? null } : g)) };
}

// A workspace whose category gate reads another channel (QC re-run with other settings, kept as
// a temporary derived channel).
export function withGateChannel(ws, gateId, channel) {
  return { ...ws, gates: ws.gates.map((g) => (g.id === gateId ? { ...g, dims: g.dims.map((d, i) => (i === 0 ? { ...d, channel } : d)) } : g)) };
}

// The "QC pass" gate on a path: a category gate on a channel named QC pass.
export function qcGateOf(gates, channel = 'QC pass') {
  return gates.find((g) => g.type === 'category' && g.dims?.[0]?.channel === channel) ?? null;
}

// Gates adapted to each sample, top-down along the path (each with its ancestors adapted first).
// Returns { overrides: gateId → { sampleId → geometry }, adjusted (confident), review (moved
// though uncertain), moved } or null when no gate can be adapted.
export function adaptPath(ws, gates, views, options = {}) {
  let adapted = ws;
  const overrides = {};
  let adjusted = 0;
  let review = 0;
  let any = false;
  for (const gate of gates) {
    if (cannotAdapt(gate)) continue;
    let run;
    try {
      run = adaptAcrossSamples(adapted, gate.id, views, { groupBy: options.groupBy });
    } catch {
      continue;
    }
    any = true;
    // Every sample takes the adapted gate, confident or not: as an alternative analysis, where the
    // adaptation would put the gate is reasonable even when it is not sure enough to apply it.
    overrides[gate.id] = { ...(gate.overrides ?? {}) };
    for (const r of run.results) {
      if (r.status === 'keep') continue;
      overrides[gate.id][r.sampleId] = r.geometry;
      if (r.status === 'adjust') adjusted += 1;
      else review += 1;
    }
    adapted = withOverrides(adapted, [gate.id], overrides);
  }
  return any ? { overrides, adjusted, review, moved: adjusted + review } : null;
}

// The smallest two-sided p-value a rank test can give: counts = [nA, nB] (or [pairs] when paired).
export function minimumRankP(design, counts) {
  if (!counts?.length) return 0;
  if (design === 'paired-two') return 2 / 2 ** counts[0];
  const [a, b] = counts;
  let combinations = 1;
  for (let i = 1; i <= a; i += 1) combinations = (combinations * (b + i)) / i;
  return Math.min(1, 2 / combinations);
}

// --- Running -----------------------------------------------------------------------------------

// The choices for a comparison. context: { ws, gateId, ancestorId, design, counts ([nA, nB], or
// [pairs]), alpha, compensations: [{ id, label }] (alternatives to the declared assignment),
// qcVariants: [{ id, label, channel }] (QC re-runs, as temporary channels), adapted (adaptPath
// result or null), qcChannel }. Returns [{ id, kind, label, options:
// [{ id, label, ... }] }], the first option of each being the declared analysis.
export function choicesFor(context) {
  const { ws } = context;
  const gates = pathGates(ws, context.gateId, context.ancestorId);
  const choices = [];
  const qcGate = qcGateOf(gates, context.qcChannel);
  for (const gate of gates.slice(-6)) {
    if (!OFFSETTABLE.has(gate.type)) continue;
    choices.push({
      id: `gate:${gate.id}`,
      kind: 'boundary',
      gateId: gate.id,
      label: `${gate.name} boundary`,
      options: [{ id: 'declared', label: 'as drawn', distance: 0 }, ...BOUNDARY_STEPS.map((d) => ({ id: `${d}`, label: `${Math.abs(d * 100)}% ${d < 0 ? 'inward' : 'outward'}`, distance: d }))],
    });
  }
  const adjustable = gates.filter((g) => Object.keys(g.overrides ?? {}).length);
  const perSample = [{ id: 'declared', label: adjustable.length ? 'as adjusted' : 'one gate for all' }];
  if (adjustable.length) perSample.push({ id: 'shared', label: 'without per-sample adjustments' });
  if (context.adapted?.moved > 0) perSample.push({ id: 'adapted', label: `adapted to each sample (${context.adapted.moved} moved)` });
  if (perSample.length > 1) choices.push({ id: 'per-sample', kind: 'per-sample', label: 'Gates per sample', options: perSample });
  if (qcGate) {
    choices.push({
      id: 'qc',
      kind: 'qc',
      gateId: qcGate.id,
      label: 'Acquisition QC',
      options: [{ id: 'declared', label: 'as run' }, { id: 'none', label: 'not applied' }, ...(context.qcVariants ?? []).map((v) => ({ id: v.id, label: v.label, channel: v.channel }))],
    });
  }
  if (context.compensations?.length) {
    choices.push({ id: 'compensation', kind: 'compensation', label: 'Compensation', options: [{ id: 'declared', label: 'as assigned' }, ...context.compensations.map((c) => ({ id: c.id, label: c.label }))] });
  }
  // A rank test that cannot reach the significance level with so few samples is left out (its
  // smallest p-value: 2 / C(nA + nB, nA) for Mann–Whitney, 2 / 2ⁿ for signed ranks).
  const tests = [{ id: 'parametric', label: context.design === 'paired-two' ? 'paired t-test' : "Welch's t-test" }];
  const rank = { id: 'rank', label: context.design === 'paired-two' ? 'Wilcoxon signed-rank' : 'Mann–Whitney U' };
  if (!(minimumRankP(context.design, context.counts) > (context.alpha ?? 0.05))) tests.push(rank);
  choices.push({ id: 'test', kind: 'test', label: 'Test', options: tests, omitted: tests.length === 1 ? `${rank.label} cannot reach p < ${context.alpha ?? 0.05} with ${context.design === 'paired-two' ? `${context.counts?.[0]} pairs` : `${context.counts?.[0]} and ${context.counts?.[1]} samples`}` : null });
  return choices;
}

// The workspace of one specification (compensation is applied to the views separately).
export function workspaceFor(ws, choices, picks, context = {}) {
  let out = ws;
  choices.forEach((choice, c) => {
    const option = choice.options[picks[c]];
    if (picks[c] === 0) return;
    if (choice.kind === 'per-sample') {
      const gates = pathGates(ws, context.gateId, context.ancestorId).map((g) => g.id);
      out = option.id === 'shared' ? withOverrides(out, gates, null) : withOverrides(out, Object.keys(context.adapted?.overrides ?? {}), context.adapted?.overrides);
    }
  });
  // Boundaries after the per-sample choice, so adapted gates move too.
  choices.forEach((choice, c) => {
    if (choice.kind === 'boundary' && picks[c] > 0) out = offsetGate(out, choice.gateId, choice.options[picks[c]].distance);
  });
  choices.forEach((choice, c) => {
    if (choice.kind !== 'qc' || picks[c] === 0) return;
    const option = choice.options[picks[c]];
    out = option.id === 'none' ? withoutGate(out, choice.gateId) : withGateChannel(out, choice.gateId, option.channel);
  });
  return out;
}

// Runs every specification of a comparison. input: { ws, views (Map sampleId → SampleView),
// samples: [{ id, group: 0 | 1, pair? }], design, statistic ({ stat, gateId, channel?,
// ancestorId?, value? }), choices, specs, alpha, setCompensation (views, option id | 'declared')
// for the compensation choice, onProgress }. Returns [{ ...spec, result, conclusion, values }].
export function runMultiverse(input) {
  const steps = runSteps(input);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

// The same, yielding to the page every ~30 ms; input.signal ({ aborted }) stops it (the views are
// put back on their declared compensation either way).
export async function runMultiverseAsync(input) {
  const steps = runSteps(input);
  let last = Date.now();
  let step = steps.next();
  while (!step.done) {
    if (input.signal?.aborted) {
      steps.return();
      throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
    }
    if (Date.now() - last > 30) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      last = Date.now();
    }
    step = steps.next();
  }
  return step.value;
}

function* runSteps(input) {
  const { ws, views, samples, design, statistic, choices, specs } = input;
  const alpha = input.alpha ?? 0.05;
  const compIndex = choices.findIndex((c) => c.kind === 'compensation');
  const testIndex = choices.findIndex((c) => c.kind === 'test');
  // Specifications grouped by compensation, so each matrix is applied once.
  const order = specs.map((s, i) => i).sort((x, y) => (compIndex >= 0 ? specs[x].picks[compIndex] - specs[y].picks[compIndex] : 0) || x - y);
  const results = new Array(specs.length);
  let current = 0;
  try {
    for (let done = 0; done < order.length; done += 1) {
      const i = order[done];
      const spec = specs[i];
      if (compIndex >= 0 && spec.picks[compIndex] !== current) {
        current = spec.picks[compIndex];
        input.setCompensation(views, current === 0 ? 'declared' : choices[compIndex].options[current].id);
      }
      const variant = workspaceFor(ws, choices, spec.picks, input);
      const values = samples.map((s) => {
        const view = views.get(s.id);
        try {
          return view ? computeStatistic(view, variant, statistic) : Number.NaN;
        } catch {
          return Number.NaN;
        }
      });
      const test = choices[testIndex].options[spec.picks[testIndex]].id;
      let result = null;
      try {
        const { a, b } = arrange(samples, values, design);
        result = a.length >= 2 && b.length >= 2 ? compareTwo(design, test, a, b) : null;
      } catch {
        result = null;
      }
      results[i] = { ...spec, values, result, conclusion: conclusionOf(result, alpha) };
      input.onProgress?.((done + 1) / specs.length);
      yield;
    }
  } finally {
    if (compIndex >= 0 && current !== 0) input.setCompensation(views, 'declared');
  }
  return results;
}

// The two groups' values (aligned by pair for a paired design; incomplete pairs are left out).
export function arrange(samples, values, design) {
  if (design === 'paired-two') {
    const byPair = new Map();
    samples.forEach((s, i) => {
      if (s.pair === null || s.pair === undefined || !Number.isFinite(values[i])) return;
      if (!byPair.has(s.pair)) byPair.set(s.pair, [[], []]);
      byPair.get(s.pair)[s.group].push(values[i]);
    });
    const a = [];
    const b = [];
    for (const [ga, gb] of byPair.values()) {
      if (!ga.length || !gb.length) continue;
      a.push(ga.reduce((x, y) => x + y, 0) / ga.length);
      b.push(gb.reduce((x, y) => x + y, 0) / gb.length);
    }
    return { a, b };
  }
  const a = [];
  const b = [];
  samples.forEach((s, i) => {
    if (!Number.isFinite(values[i])) return;
    (s.group === 0 ? a : b).push(values[i]);
  });
  return { a, b };
}

// --- Summary -----------------------------------------------------------------------------------

// How the specifications agree with the declared analysis: { declared, total, agree, share,
// verdict ('holds' | 'mostly' | 'fragile' | 'undetermined', from the conclusion), dependsOn:
// [{ choice, option, conclusion, estimate, p }] (single changes that alter the conclusion),
// sizeDependsOn (single changes that keep a significant difference but move its estimate outside
// the declared 95% CI), byChoice: [{ label, options: [{ label,
// n, agree, median }] }], range: [min, max] of the estimates, text }.
// options: labels ([A, B], the groups' names), holds (0.9), mostly (0.7).
export function summarize(results, choices, options = {}) {
  const declared = results.find((r) => r.kind === 'declared');
  const valid = results.filter((r) => r.result);
  if (!declared?.result) return { declared, total: valid.length, verdict: 'undetermined', text: 'The declared analysis could not be computed.' };
  const agrees = (r) => r.conclusion === declared.conclusion;
  const agree = valid.filter(agrees).length;
  const share = agree / valid.length;
  const verdict = share >= (options.holds ?? 0.9) ? 'holds' : share >= (options.mostly ?? 0.7) ? 'mostly' : 'fragile';
  // Single changes that alter the conclusion, and those that keep it but move the estimate
  // outside the declared analysis's 95% confidence interval (the size of the effect depends on
  // them even if its sign and significance do not).
  const dependsOn = [];
  const sizeDependsOn = [];
  const [lo, hi] = declared.result.ci ?? [Number.NaN, Number.NaN];
  for (const r of valid) {
    if (r.kind !== 'single') continue;
    const c = r.picks.findIndex((p) => p > 0);
    const entry = { choice: choices[c].label, option: choices[c].options[r.picks[c]].label, conclusion: r.conclusion, estimate: r.result.estimate, p: r.result.p };
    if (!agrees(r)) dependsOn.push(entry);
    // Only a difference that was found has a size worth following.
    else if (declared.conclusion !== 'none' && (r.result.estimate < lo || r.result.estimate > hi)) sizeDependsOn.push(entry);
  }
  const byChoice = choices.map((choice, c) => ({
    id: choice.id,
    label: choice.label,
    options: choice.options.map((option, o) => {
      const these = valid.filter((r) => r.picks[c] === o);
      const estimates = these.map((r) => r.result.estimate).sort((x, y) => x - y);
      return { label: option.label, n: these.length, agree: these.filter(agrees).length, median: estimates.length ? estimates[Math.floor(estimates.length / 2)] : Number.NaN };
    }),
  }));
  const estimates = valid.map((r) => r.result.estimate);
  const phrase = { higher: 'higher', lower: 'lower', none: 'no significant difference' }[declared.conclusion];
  const [A, B] = options.labels ?? ['A', 'B'];
  const holds = declared.conclusion === 'none' ? 'There is no significant difference' : `${B} is significantly ${phrase} than ${A}`;
  const fmt = (v) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toPrecision(2));
  const text = `${holds} in ${agree} of ${valid.length} specifications (${Math.round(100 * share)}%)${dependsOn.length ? `; on its own, the conclusion changes with ${dependsOn.map((d) => `${d.choice.toLowerCase()} ${d.option}`).join(', ')}` : ''}${sizeDependsOn.length ? `; the size of the difference changes beyond its confidence interval with ${sizeDependsOn.map((d) => `${d.choice.toLowerCase()} ${d.option} (${fmt(declared.result.estimate)} → ${fmt(d.estimate)})`).join(', ')}` : ''}.`;
  return { declared, total: valid.length, agree, share, verdict, dependsOn, sizeDependsOn, byChoice, range: [Math.min(...estimates), Math.max(...estimates)], text };
}

// A sentence for the methods paragraph.
export function methodsSentence(summary, choices) {
  const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]);
  const parts = [];
  const boundaries = choices.filter((c) => c.kind === 'boundary').length;
  if (boundaries) parts.push(`the boundaries of ${boundaries} gate${boundaries === 1 ? '' : 's'} moved 1–2% of the axis`);
  for (const c of choices) {
    const alternatives = c.options.slice(1);
    if (!alternatives.length || c.kind === 'boundary') continue;
    if (c.kind === 'per-sample') parts.push(list(alternatives.map((o) => (o.id === 'adapted' ? 'gates adapted to each sample' : 'gates without per-sample adjustments'))));
    else if (c.kind === 'qc') parts.push(`acquisition QC ${list(alternatives.map((o) => (o.id === 'none' ? 'left out' : `re-run ${o.label}`)))}`);
    else if (c.kind === 'compensation') parts.push(`compensation with ${list(alternatives.map((o) => o.label))}`);
    else if (c.kind === 'test') parts.push(`the ${alternatives[0].label} test`);
  }
  return `The conclusion was checked against ${summary.total - 1} alternative analyses, alone and combined (${parts.join('; ')}; a specification-curve analysis, Simonsohn et al. 2020): it held in ${summary.agree} of ${summary.total} (${Math.round(100 * summary.share)}%).`;
}

// --- Helpers for callers ------------------------------------------------------------------------

// The population a gate's frequency is computed among, for a statistic spec.
export function denominatorOf(ws, statistic) {
  const gate = statistic.gateId && statistic.gateId !== ROOT ? gateById(ws, statistic.gateId) : null;
  if (statistic.stat === 'freqParent') return gate?.parentId ?? null;
  if (statistic.stat === 'freqGrandparent') return gate?.parentId ? gateById(ws, gate.parentId)?.parentId ?? null : null;
  if (statistic.stat === 'freqOf') return statistic.ancestorId ?? null;
  return null;
}
