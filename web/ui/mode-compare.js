// Compare: sample-level statistics that respect the experimental design. Each sample contributes
// one value (a population frequency, count or channel statistic, a table column, or a cluster's
// share of a parent population); samples are grouped by a metadata field or by workspace groups,
// optionally paired by subject, and compared with a test chosen from the design. Screens repeat
// the comparison for every population, or test every cluster of a derived cluster channel for
// differential abundance, with multiple-testing correction and a volcano plot.

import { h, icon, clear } from './dom.js';
import { toast, progressToast } from './overlays.js';
import { mountChart, leftAxis, bottomAxis, valueScale, withAlpha, downloadCSV, formatP, formatValue } from './charts.js';
import { columnLabel } from './mode-tables.js';
import { computeStatistic, countOf, population } from '../lib/engine.js';
import { STATISTICS } from '../lib/stats.js';
import { ROOT, META_FIELDS, channelCatalog, channelLabel, gateById, gatePath, setCollection } from '../lib/workspace.js';
import { newId } from '../lib/gates.js';
import { categoricalColor } from '../lib/colormaps.js';
import { quantileSorted } from '../lib/stats.js';
import { denominatorOf, methodsSentence, pathGates, qcGateOf } from '../lib/multiverse.js';
import { QC_CHANNEL } from './qc-run.js';
import { checkRobustness } from './robustness.js';
import {
  adjustPValues,
  blockAnova,
  bootstrap,
  cohensD,
  designMatrix,
  differentialAbundance,
  foldChange,
  friedmanTest,
  hodgesLehmann,
  kruskalWallis,
  mannWhitneyU,
  oneSampleTTest,
  oneWayAnova,
  pairedTTest,
  studentTQuantile,
  studentTTest,
  welchAnova,
  welchTTest,
  wilcoxonSignedRank,
} from '../lib/hypothesis.js';

// --- Tests ---------------------------------------------------------------------------------------

// Each test runs on groups (arrays of values, reference first) or on matched pairs/blocks.
const TESTS = {
  welch: { label: "Welch's t-test", short: 'Welch t', cite: 'Welch 1947, Biometrika 34:28', describe: "Welch's two-sample t-test (unequal variances)", run: ({ groups }) => welchTTest(groups[1], groups[0]) },
  student: { label: "Student's t-test (equal variances)", short: 'Student t', cite: 'Student 1908', describe: "Student's two-sample t-test (pooled variance)", run: ({ groups }) => studentTTest(groups[1], groups[0]) },
  mannwhitney: { label: 'Mann–Whitney U', short: 'Mann–Whitney', cite: 'Mann & Whitney 1947, Ann Math Stat 18:50', describe: 'the Mann–Whitney U (Wilcoxon rank-sum) test', run: ({ groups }) => mannWhitneyU(groups[1], groups[0]) },
  pairedt: { label: 'Paired t-test', short: 'paired t', cite: 'Student 1908', describe: 'the paired t-test', run: ({ pairs }) => pairedTTest(pairs.b, pairs.a) },
  wilcoxon: { label: 'Wilcoxon signed-rank', short: 'Wilcoxon', cite: 'Wilcoxon 1945, Biometrics 1:80', describe: 'the Wilcoxon signed-rank test', run: ({ pairs }) => wilcoxonSignedRank(pairs.b, pairs.a) },
  welchanova: { label: "Welch's ANOVA", short: 'Welch ANOVA', cite: 'Welch 1951, Biometrika 38:330', describe: "Welch's one-way ANOVA (unequal variances)", run: ({ groups }) => welchAnova(groups) },
  anova: { label: 'One-way ANOVA', short: 'ANOVA', cite: 'Fisher 1925', describe: 'one-way ANOVA', run: ({ groups }) => oneWayAnova(groups) },
  kruskal: { label: 'Kruskal–Wallis', short: 'Kruskal–Wallis', cite: 'Kruskal & Wallis 1952, JASA 47:583', describe: 'the Kruskal–Wallis rank-sum test', run: ({ groups }) => kruskalWallis(groups) },
  rmanova: { label: 'Repeated-measures ANOVA', short: 'RM ANOVA', cite: 'Fisher 1935 (randomized blocks)', describe: 'a repeated-measures ANOVA with subjects as blocks', run: ({ pairs }) => blockAnova(pairs.blocks) },
  friedman: { label: 'Friedman', short: 'Friedman', cite: 'Friedman 1937, JASA 32:675', describe: 'the Friedman rank-sum test', run: ({ pairs }) => friedmanTest(pairs.blocks) },
};
const AUTO = { two: ['welch', 'mannwhitney'], 'paired-two': ['pairedt', 'wilcoxon'], multi: ['welchanova', 'kruskal'], 'paired-multi': ['rmanova', 'friedman'] };
const AVAILABLE = {
  two: ['welch', 'student', 'mannwhitney'],
  'paired-two': ['pairedt', 'wilcoxon', 'welch', 'mannwhitney'],
  multi: ['welchanova', 'anova', 'kruskal'],
  'paired-multi': ['rmanova', 'friedman', 'welchanova', 'kruskal'],
};
const DESIGN_LABEL = { two: 'two independent groups', 'paired-two': 'two paired groups', multi: 'more than two independent groups', 'paired-multi': 'more than two groups, repeated in each subject' };
const ADJUST = [
  { id: 'BH', label: 'Benjamini–Hochberg (FDR)', cite: 'Benjamini & Hochberg 1995, JRSS B 57:289' },
  { id: 'BY', label: 'Benjamini–Yekutieli (FDR, any dependence)', cite: 'Benjamini & Yekutieli 2001, Ann Stat 29:1165' },
  { id: 'holm', label: 'Holm (family-wise)', cite: 'Holm 1979, Scand J Stat 6:65' },
  { id: 'bonferroni', label: 'Bonferroni (family-wise)', cite: 'Bonferroni 1936' },
];

const median = (values) => quantileSorted(Float64Array.from(values).sort(), 0.5);
const meanOf = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const sdOf = (values) => {
  if (values.length < 2) return Number.NaN;
  const m = meanOf(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
};
const natural = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

function hashUnit(text) {
  let x = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) x = Math.imul(x ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return (x % 10007) / 10007 - 0.5;
}

// --- Cluster counts ------------------------------------------------------------------------------

const clusterCache = new WeakMap();

// Counts of each cluster label among a parent population's events: { counts: Map, total }.
function clusterCounts(view, ws, channel, parentId) {
  if (!view.hasChannel(channel)) return null;
  const parent = population(view, ws, parentId ?? ROOT);
  if (parent === undefined) return null;
  const key = parent ?? view;
  let byChannel = clusterCache.get(key);
  if (!byChannel) {
    byChannel = new Map();
    clusterCache.set(key, byChannel);
  }
  const cacheKey = `${channel}|${view.version}`;
  if (byChannel.has(cacheKey)) return byChannel.get(cacheKey);
  const labels = view.column(channel);
  const counts = new Map();
  const n = parent ? parent.length : view.eventCount;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const v = labels[parent ? parent[i] : i];
    total += 1;
    if (!Number.isFinite(v) || v < 0) continue;
    const k = Math.round(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const result = { counts, total };
  byChannel.set(cacheKey, result);
  return result;
}

// Derived channels that hold cluster labels (integer categories).
function clusterChannels(ws, data) {
  const out = [];
  for (const record of ws.derived ?? []) {
    for (const output of record.outputs ?? []) {
      const byName = /cluster|metacluster|leiden|louvain|phenograph|kmeans|som|label|population/i.test(`${record.kind} ${output}`);
      if (byName && !/umap|tsne|t-sne|pca|pc\d|embedding|mask|score|abundance/i.test(output)) out.push({ name: output, record });
    }
  }
  if (!out.length) {
    // Fall back to any loaded derived channel with few integer values.
    for (const view of data.views.values()) {
      for (const [name, column] of view.derived) {
        if (out.some((c) => c.name === name)) continue;
        const seen = new Set();
        let integer = true;
        for (let i = 0; i < Math.min(column.length, 4000) && integer; i += 1) {
          const v = column[i];
          if (Number.isFinite(v) && v !== Math.round(v)) integer = false;
          seen.add(v);
        }
        if (integer && seen.size >= 2 && seen.size <= 300) out.push({ name, record: null });
      }
    }
  }
  return out;
}

function clusterName(record, k) {
  const names = record?.summary?.names ?? record?.summary?.labels ?? record?.names;
  return (Array.isArray(names) ? names[k] : names?.[k]) ?? `Cluster ${k}`;
}

// --- Mode ----------------------------------------------------------------------------------------

export function mountCompareMode(app, container) {
  const { store, data } = app;
  let screenResult = null; // { kind, rows, stale, ... }
  // The robustness check of the single comparison (lib/multiverse.js), kept while the view is open:
  // { key, status: 'running' | 'done' | 'error', progress, message, summary, results, choices,
  // error, cancel }.
  let robust = null;
  const robustOptions = { qcReruns: false };
  let loading = null;
  const attempted = new Set();

  const left = h('div');
  const right = h('div', { style: { minWidth: 0 } });
  const tabsHost = h('div.segmented');
  const headActions = h('div.btn-row');
  const root = h('div.view',
    h('div.workbench-head', h('h1', icon('compare'), 'Compare'), tabsHost, h('span.spacer'), headActions),
    h('div.view-body', h('div.split', left, right)));
  container.append(root);

  // --- Configuration (kept in the UI state so it survives switching views) ----------------------

  function defaults() {
    const ws = store.ws;
    const samples = ws.samples.filter((s) => s.role === 'sample' || s.role === 'reference');
    const fields = metaFields(samples);
    const varying = fields.filter((f) => new Set(samples.map((s) => s.meta?.[f]).filter((v) => v !== undefined && v !== '')).size >= 2);
    const groupField = varying.includes('condition') ? 'condition' : varying.find((f) => !/subject|donor|patient|replicate|well/i.test(f)) ?? varying[0];
    const groupBy = groupField ? `meta:${groupField}` : ws.groups.length >= 2 ? 'groups' : '';
    // Pair automatically when a subject-like field links samples across the groups.
    let pairBy = '';
    const pairField = varying.find((f) => /subject|donor|patient|mouse|animal|individual/i.test(f) && f !== groupField);
    if (pairField && groupField) {
      const byPair = new Map();
      for (const s of samples) {
        const p = s.meta?.[pairField];
        const g = s.meta?.[groupField];
        if (p === undefined || g === undefined) continue;
        if (!byPair.has(p)) byPair.set(p, new Set());
        byPair.get(p).add(g);
      }
      if ([...byPair.values()].filter((set) => set.size >= 2).length >= 2) pairBy = `meta:${pairField}`;
    }
    const gateId = store.ui.gateId ?? ws.gates.find((g) => g.type !== 'boolean')?.id ?? ROOT;
    return {
      tab: 'one',
      source: 'population',
      gateId,
      stat: gateId === ROOT ? 'count' : 'freqParent',
      channel: null,
      ancestorId: ROOT,
      value: 50,
      tableId: ws.tables[0]?.id ?? null,
      columnId: null,
      clusterChannel: null,
      clusterParent: ROOT,
      cluster: null,
      groupBy,
      levels: null,
      reference: null,
      pairBy,
      covariates: [],
      contrast: null,
      test: 'auto',
      center: 'mean',
      log: false,
      adjust: 'BH',
      alpha: 0.05,
      fcThreshold: 0,
      includeControls: false,
    };
  }

  // Fill in missing settings (compareColumn may have set a few before this view was ever opened).
  if (!store.ui.compare?.initialized) store.ui.compare = { ...defaults(), ...(store.ui.compare ?? {}), initialized: true };
  const cfg = () => store.ui.compare;
  const setCfg = (patch, options = {}) => {
    store.ui.compare = { ...cfg(), ...patch };
    if (options.invalidate !== false) screenResult = screenResult ? { ...screenResult, stale: true } : null;
    render();
  };

  // Tables' column menu → compare that column.
  app.compareColumn = (table, column) => {
    store.ui.compare = { ...defaults(), ...(store.ui.compare ?? {}), initialized: true, tab: 'one', source: 'table', tableId: table.id, columnId: column.id };
    if (store.ui.mode !== 'compare') app.setMode('compare');
    else render();
  };

  // --- Samples, groups and values -----------------------------------------------------------------

  function metaFields(samples) {
    const found = new Set(samples.flatMap((s) => Object.keys(s.meta ?? {})));
    return [...META_FIELDS.filter((f) => found.has(f)), ...[...found].filter((f) => !META_FIELDS.includes(f)).sort(natural)];
  }

  function candidateSamples() {
    const ws = store.ws;
    const c = cfg();
    let samples = ws.samples.filter((s) => c.includeControls || s.role === 'sample' || s.role === 'reference');
    if (c.source === 'table') {
      const table = ws.tables.find((t) => t.id === c.tableId);
      const group = table?.groupId ? ws.groups.find((g) => g.id === table.groupId) : null;
      if (group) samples = samples.filter((s) => group.sampleIds.includes(s.id));
    }
    return samples;
  }

  function allLevels(samples) {
    const ws = store.ws;
    const c = cfg();
    if (c.groupBy === 'groups') return ws.groups.map((g, i) => ({ key: g.id, label: g.name, color: g.color ?? categoricalColor(i) }));
    if (!c.groupBy) return [];
    const field = c.groupBy.slice(5);
    const values = [...new Set(samples.map((s) => s.meta?.[field]).filter((v) => v !== undefined && v !== null && String(v).trim() !== '').map(String))].sort(natural);
    return values.map((v, i) => ({ key: v, label: v, color: ws.groups.find((g) => g.name === v)?.color ?? categoricalColor(i) }));
  }

  function selectedLevels(samples) {
    const c = cfg();
    const levels = allLevels(samples);
    let chosen = c.levels ? levels.filter((l) => c.levels.includes(l.key)) : levels;
    if (chosen.length < 2) chosen = levels;
    const reference = chosen.find((l) => l.key === c.reference) ?? chosen[0];
    return reference ? [reference, ...chosen.filter((l) => l !== reference)] : chosen;
  }

  function levelOf(sample, levels) {
    const c = cfg();
    if (c.groupBy === 'groups') {
      const ws = store.ws;
      return levels.find((l) => ws.groups.find((g) => g.id === l.key)?.sampleIds.includes(sample.id)) ?? null;
    }
    const value = sample.meta?.[c.groupBy.slice(5)];
    return value === undefined ? null : levels.find((l) => l.key === String(value)) ?? null;
  }

  function pairOf(sample) {
    const c = cfg();
    if (!c.pairBy) return null;
    const v = sample.meta?.[c.pairBy.slice(5)];
    return v === undefined || v === null || String(v).trim() === '' ? null : String(v);
  }

  // The measure as a statistic spec, or a cluster spec.
  function measureSpec() {
    const ws = store.ws;
    const c = cfg();
    if (c.source === 'table') {
      const table = ws.tables.find((t) => t.id === c.tableId);
      const column = table?.columns.find((col) => col.id === c.columnId) ?? table?.columns[0];
      if (!column) return null;
      return { kind: 'statistic', gateId: column.gateId ?? ROOT, stat: column.stat, channel: column.channel, ancestorId: column.ancestorId, value: column.value, label: columnLabel(ws, column) };
    }
    if (c.source === 'cluster') {
      if (!c.clusterChannel || c.cluster === null || c.cluster === undefined) return null;
      const parentName = c.clusterParent && c.clusterParent !== ROOT ? gateById(ws, c.clusterParent)?.name : 'all events';
      const record = clusterChannels(ws, data).find((x) => x.name === c.clusterChannel)?.record;
      return { kind: 'cluster', channel: c.clusterChannel, cluster: c.cluster, parentId: c.clusterParent ?? ROOT, label: `${clusterName(record, c.cluster)} (${c.clusterChannel}): % of ${parentName}` };
    }
    const stat = STATISTICS.find((s) => s.id === c.stat) ?? STATISTICS[1];
    const spec = { kind: 'statistic', gateId: c.gateId ?? ROOT, stat: stat.id, channel: stat.needsChannel ? c.channel ?? defaultChannel() : undefined, ancestorId: stat.needsAncestor ? c.ancestorId : undefined, value: stat.needsValue ? c.value : undefined };
    spec.label = columnLabel(ws, spec);
    return spec;
  }

  function defaultChannel() {
    return channelCatalog(store.ws).find((ch) => ch.type === 'fluorescence')?.name ?? channelCatalog(store.ws)[0]?.name ?? null;
  }

  function valueOf(view, spec) {
    const ws = store.ws;
    try {
      if (spec.kind === 'cluster') {
        const result = clusterCounts(view, ws, spec.channel, spec.parentId);
        if (!result || !result.total) return Number.NaN;
        return (100 * (result.counts.get(spec.cluster) ?? 0)) / result.total;
      }
      return computeStatistic(view, ws, { stat: spec.stat, gateId: spec.gateId, channel: spec.channel, ancestorId: spec.ancestorId, value: spec.value });
    } catch {
      return Number.NaN;
    }
  }

  // Samples arranged by level, with values: { levels: [{ ...level, points }], excluded, unloaded }.
  function collect(spec) {
    const samples = candidateSamples();
    const levels = selectedLevels(samples).map((l) => ({ ...l, points: [] }));
    const excluded = [];
    const unloaded = [];
    for (const sample of samples) {
      const level = levelOf(sample, levels);
      if (!level) continue;
      const view = data.view(sample.id);
      if (!view) {
        unloaded.push(sample);
        continue;
      }
      const value = spec ? valueOf(view, spec) : Number.NaN;
      if (!Number.isFinite(value)) {
        excluded.push({ sample, reason: 'no value (the population does not apply or is empty)' });
        continue;
      }
      level.points.push({ sample, value, pair: pairOf(sample), level: level.key });
    }
    return { levels, excluded, unloaded };
  }

  // Matched pairs (two levels) or complete blocks (all levels) by the pairing field.
  function matchPairs(levels) {
    const byKey = new Map();
    const duplicates = new Set();
    levels.forEach((level, j) => {
      for (const point of level.points) {
        if (point.pair === null) continue;
        if (!byKey.has(point.pair)) byKey.set(point.pair, levels.map(() => []));
        const slot = byKey.get(point.pair)[j];
        if (slot.length) duplicates.add(point.pair);
        slot.push(point.value);
      }
    });
    const blocks = [];
    const keys = [];
    for (const [key, slots] of byKey) {
      if (slots.every((s) => s.length)) {
        blocks.push(slots.map((s) => meanOf(s)));
        keys.push(key);
      }
    }
    const unmatched = levels.reduce((n, level) => n + level.points.filter((p) => p.pair === null || !keys.includes(p.pair)).length, 0);
    return { blocks, keys, a: blocks.map((b) => b[0]), b: blocks.map((b) => b[1]), duplicates: [...duplicates], unmatched };
  }

  function designOf(levels, pairs) {
    const k = levels.filter((l) => l.points.length).length;
    const paired = Boolean(cfg().pairBy) && pairs.blocks.length >= 2;
    if (k < 2) return null;
    if (k === 2) return paired ? 'paired-two' : 'two';
    return paired ? 'paired-multi' : 'multi';
  }

  function testsFor(design) {
    const c = cfg();
    const auto = AUTO[design];
    if (c.test === 'auto' || !AVAILABLE[design].includes(c.test)) return { primary: auto[0], secondary: auto[1], overridden: false };
    const counterpart = { welch: 'mannwhitney', student: 'mannwhitney', mannwhitney: 'welch', pairedt: 'wilcoxon', wilcoxon: 'pairedt', welchanova: 'kruskal', anova: 'kruskal', kruskal: 'welchanova', rmanova: 'friedman', friedman: 'rmanova' }[c.test];
    return { primary: c.test, secondary: AVAILABLE[design].includes(counterpart) ? counterpart : null, overridden: true };
  }

  function runTest(id, groups, pairs) {
    try {
      return { id, ...TESTS[id], result: TESTS[id].run({ groups, pairs }) };
    } catch (error) {
      return { id, ...TESTS[id], error: error.message };
    }
  }

  // The full analysis of one measure.
  function analyze(spec) {
    const collected = collect(spec);
    const levels = collected.levels.filter((l) => l.points.length);
    const pairs = matchPairs(levels);
    const design = designOf(levels, pairs);
    const analysis = { spec, ...collected, levels, allLevels: collected.levels, pairs, design };
    if (!design) return analysis;
    const groups = levels.map((l) => l.points.map((p) => p.value));
    const choice = testsFor(design);
    analysis.choice = choice;
    analysis.primary = runTest(choice.primary, groups, pairs);
    analysis.secondary = choice.secondary ? runTest(choice.secondary, groups, pairs) : null;
    analysis.summaries = levels.map((level) => summarize(level.points.map((p) => p.value)));
    if (design === 'two') analysis.effects = independentEffects(groups[0], groups[1]);
    else if (design === 'paired-two') analysis.effects = pairedEffects(pairs.a, pairs.b);
    else analysis.posthoc = posthoc(levels, groups, pairs, design, choice.primary);
    analysis.notes = assumptionNotes(analysis);
    return analysis;
  }

  function summarize(values) {
    const n = values.length;
    const m = meanOf(values);
    const sd = sdOf(values);
    const sorted = Float64Array.from(values).sort();
    const out = { n, mean: m, sd, median: quantileSorted(sorted, 0.5), q1: quantileSorted(sorted, 0.25), q3: quantileSorted(sorted, 0.75) };
    if (n >= 2) {
      const half = studentTQuantile(0.975, n - 1) * (sd / Math.sqrt(n));
      out.ciMean = [m - half, m + half];
      out.ciMedian = n >= 3 ? bootstrap([values], (v) => quantileSorted(Float64Array.from(v).sort(), 0.5), { iterations: 1000, seed: 1 }).ci : [sorted[0], sorted[n - 1]];
    }
    return out;
  }

  const attempt = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  function independentEffects(a, b) {
    const effects = [];
    const welch = attempt(() => welchTTest(b, a));
    if (welch) effects.push({ label: 'Difference of means (B − A)', estimate: welch.estimate, ci: welch.ci, note: 'Welch t interval' });
    if (meanOf(a) > 0 && meanOf(b) > 0) {
      const fc = attempt(() => foldChange(b, a));
      if (fc) effects.push({ label: 'Ratio of means (B / A)', estimate: fc.foldChange, ci: fc.ci, log2: fc.log2FoldChange, note: 'delta method on log means' });
    }
    const d = attempt(() => cohensD(b, a));
    if (d) effects.push({ label: "Hedges' g", estimate: d.g, ci: d.ciG, note: 'standardized; |g| ≈ 0.2 small, 0.5 medium, 0.8 large' });
    const hl = attempt(() => hodgesLehmann(b, a));
    if (hl) effects.push({ label: 'Hodges–Lehmann shift', estimate: hl.estimate, ci: hl.ci, note: 'median of all B − A differences; distribution-free interval' });
    return effects;
  }

  function pairedEffects(a, b) {
    const effects = [];
    const d = b.map((v, i) => v - a[i]);
    const t = attempt(() => pairedTTest(b, a));
    if (t) effects.push({ label: 'Mean paired difference (B − A)', estimate: t.estimate, ci: t.ci, note: 'paired t interval' });
    if (a.every((v) => v > 0) && b.every((v) => v > 0)) {
      const r = attempt(() => oneSampleTTest(b.map((v, i) => Math.log2(v / a[i]))));
      if (r) effects.push({ label: 'Geometric mean ratio (B / A)', estimate: 2 ** r.estimate, ci: r.ci.map((x) => 2 ** x), log2: r.estimate, note: 't interval on log2 ratios' });
    }
    if (d.length >= 2 && sdOf(d) > 0) {
      const n = d.length;
      const dz = meanOf(d) / sdOf(d);
      const se = Math.sqrt(1 / n + (dz * dz) / (2 * n));
      effects.push({ label: "Cohen's d_z (paired)", estimate: dz, ci: [dz - 1.96 * se, dz + 1.96 * se], note: 'mean difference / SD of differences' });
    }
    effects.push({ label: 'Median paired difference', estimate: median(d), ci: null, note: `${d.filter((x) => x > 0).length} of ${d.length} pairs increase` });
    return effects;
  }

  // Each level against the reference, Holm-adjusted.
  function posthoc(levels, groups, pairs, design, primary) {
    const rank = ['kruskal', 'friedman'].includes(primary);
    const paired = design === 'paired-multi';
    const rows = [];
    for (let j = 1; j < levels.length; j += 1) {
      let test;
      if (paired) {
        const a = pairs.blocks.map((b) => b[0]);
        const b = pairs.blocks.map((row) => row[j]);
        test = attempt(() => (rank ? wilcoxonSignedRank(b, a) : pairedTTest(b, a)));
      } else test = attempt(() => (rank ? mannWhitneyU(groups[j], groups[0]) : welchTTest(groups[j], groups[0])));
      const ma = meanOf(groups[0]);
      const mb = meanOf(groups[j]);
      rows.push({ level: levels[j], difference: mb - ma, ratio: ma > 0 && mb > 0 ? mb / ma : Number.NaN, p: test?.p ?? Number.NaN });
    }
    const adjusted = adjustPValues(rows.map((r) => r.p), 'holm');
    rows.forEach((r, i) => { r.q = adjusted[i]; });
    return { rows, test: paired ? (rank ? 'Wilcoxon signed-rank' : 'paired t') : (rank ? 'Mann–Whitney' : 'Welch t'), adjust: 'Holm' };
  }

  function assumptionNotes(analysis) {
    const notes = [];
    const ns = analysis.levels.map((l) => l.points.length);
    const minN = Math.min(...ns);
    notes.push({ kind: 'accent', text: `Unit of analysis: each dot is one sample (n = ${ns.join(' vs ')}). Events within a sample are not independent replicates and are never pooled across samples.` });
    if (minN < 3) notes.push({ kind: 'danger', text: 'A group has fewer than 3 samples: tests have almost no power and their p-values are unreliable. Treat this as description, not inference.' });
    if (analysis.design === 'two' && minN < 6) {
      const [n1, n2] = ns;
      let c = 1;
      for (let i = 1; i <= n1; i += 1) c = (c * (n2 + i)) / i;
      notes.push({ kind: 'warn', text: `With ${n1} vs ${n2} samples the smallest two-sided Mann–Whitney p-value possible is ${formatP(Math.min(1, 2 / c))}; rank tests cannot reach small p with few samples.` });
    }
    if (analysis.design === 'paired-two' && analysis.pairs.blocks.length < 6) notes.push({ kind: 'warn', text: `With ${analysis.pairs.blocks.length} pairs the smallest two-sided Wilcoxon p-value possible is ${formatP(Math.min(1, 2 / 2 ** analysis.pairs.blocks.length))}.` });
    if (analysis.design?.startsWith('paired')) {
      const field = cfg().pairBy.slice(5);
      notes.push({ kind: '', text: `Paired by ${field}: ${analysis.pairs.blocks.length} complete ${analysis.design === 'paired-two' ? 'pairs' : 'subjects'} used.${analysis.pairs.unmatched ? ` ${analysis.pairs.unmatched} sample(s) without a partner in every group are shown but not used by the paired test.` : ''}${analysis.pairs.duplicates.length ? ` Repeated samples of the same ${field} in a group were averaged (${analysis.pairs.duplicates.slice(0, 3).join(', ')}).` : ''}` });
    } else if (cfg().pairBy) {
      notes.push({ kind: 'warn', text: 'Pairing was requested but fewer than two subjects have samples in the groups compared, so the groups are treated as independent.' });
    }
    const parametric = ['welch', 'student', 'pairedt', 'welchanova', 'anova', 'rmanova'].includes(analysis.choice?.primary);
    if (parametric && minN < 10) notes.push({ kind: '', text: 'The t and F tests assume roughly normal values per group. Frequencies near 0% or 100% and fluorescence intensities are often skewed: check the dots, consider the log scale, and see the rank-based test below.' });
    notes.push({ kind: '', text: 'This is a single comparison. When many measures are compared, adjust for multiplicity: the population and cluster screens report adjusted q-values.' });
    if (analysis.excluded.length) notes.push({ kind: 'warn', text: `${analysis.excluded.length} sample(s) left out: ${analysis.excluded.slice(0, 4).map((e) => e.sample.name).join(', ')}${analysis.excluded.length > 4 ? '…' : ''} (no value for this measure).` });
    return notes;
  }

  // --- Loading samples ------------------------------------------------------------------------------

  async function loadSamples(samples) {
    if (loading || !samples.length) return;
    let cancelled = false;
    loading = { cancel: () => { cancelled = true; } };
    const progress = progressToast(`Loading ${samples.length} samples…`, () => { cancelled = true; });
    let done = 0;
    for (const sample of samples) {
      if (cancelled) break;
      await data.ensure(sample.id).catch(() => {});
      done += 1;
      progress.update(done / samples.length, `Loading ${sample.name} (${done}/${samples.length})`);
    }
    loading = null;
    if (cancelled) progress.done('Loading cancelled; results use the samples loaded so far.', 'info');
    else progress.done(`Loaded ${samples.length} samples.`);
    render();
  }

  // --- Rendering ------------------------------------------------------------------------------------

  let chart = null;
  let volcano = null;

  function render() {
    renderTabs();
    renderLeft();
    renderRight();
  }

  function renderTabs() {
    clear(tabsHost);
    const c = cfg();
    for (const [id, label] of [['one', 'One measure'], ['populations', 'Screen populations'], ['clusters', 'Screen clusters']]) {
      tabsHost.append(h(`button${c.tab === id ? '.active' : ''}`, { type: 'button', onclick: () => setCfg({ tab: id }, { invalidate: false }) }, label));
    }
  }

  // Left column: measure, design, test.
  function renderLeft() {
    clear(left);
    const c = cfg();
    if (c.tab === 'clusters') left.append(clusterPane());
    else left.append(measurePane());
    left.append(designPane(), testPane());
  }

  function select(options, value, onChange, extra = {}) {
    return h('select.input.small', { onchange: (event) => onChange(event.target.value), ...extra },
      ...options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value), disabled: o.disabled }, o.label)));
  }

  function populationOptions(ws) {
    return [{ value: ROOT, label: 'All events' }, ...ws.gates.map((g) => ({ value: g.id, label: gatePath(ws, g.id) }))];
  }

  function measurePane() {
    const ws = store.ws;
    const c = cfg();
    const pane = h('div.pane', h('h3', icon('target'), c.tab === 'populations' ? 'Statistic for every population' : 'What to compare'));
    if (c.tab === 'one') {
      const sources = [['population', 'Population'], ['table', 'Table column'], ['cluster', 'Cluster']];
      pane.append(h('div.segmented', { style: { marginBottom: '10px' } }, ...sources.map(([id, label]) => h(`button${c.source === id ? '.active' : ''}`, { type: 'button', onclick: () => setCfg({ source: id }) }, label))));
    }
    if (c.tab === 'one' && c.source === 'table') {
      if (!ws.tables.length) {
        pane.append(h('p.muted', 'No tables yet. Build one in the Tables view, or compare a population directly.'));
        return pane;
      }
      const table = ws.tables.find((t) => t.id === c.tableId) ?? ws.tables[0];
      pane.append(
        h('label.field', h('span', 'Table'), select(ws.tables.map((t) => ({ value: t.id, label: t.name })), table.id, (v) => setCfg({ tableId: v, columnId: null }))),
        h('label.field', h('span', 'Column'), select(table.columns.map((col) => ({ value: col.id, label: columnLabel(ws, col) })), c.columnId ?? table.columns[0]?.id, (v) => setCfg({ columnId: v }))),
        table.groupId ? h('p.muted', { style: { fontSize: '11.5px' } }, `Rows limited to the table's group "${ws.groups.find((g) => g.id === table.groupId)?.name ?? ''}".`) : null);
      if (c.tableId !== table.id) store.ui.compare = { ...c, tableId: table.id };
      return pane;
    }
    if (c.tab === 'one' && c.source === 'cluster') {
      pane.append(...clusterFields(true));
      return pane;
    }
    const stat = STATISTICS.find((s) => s.id === c.stat) ?? STATISTICS[1];
    if (c.tab === 'one') pane.append(h('label.field', h('span', 'Population'), select(populationOptions(ws), c.gateId ?? ROOT, (v) => setCfg({ gateId: v }))));
    pane.append(h('label.field', h('span', 'Statistic'), select(STATISTICS.map((s) => ({ value: s.id, label: s.label })), stat.id, (v) => setCfg({ stat: v }))));
    if (stat.needsChannel) {
      const channels = channelCatalog(ws).filter((ch) => ch.type !== 'time');
      pane.append(h('label.field', h('span', 'Channel'), select(channels.map((ch) => ({ value: ch.name, label: ch.marker ? `${ch.marker} (${ch.name})` : ch.name })), c.channel ?? defaultChannel(), (v) => setCfg({ channel: v }))));
    }
    if (stat.needsAncestor) pane.append(h('label.field', h('span', 'Relative to'), select(populationOptions(ws), c.ancestorId ?? ROOT, (v) => setCfg({ ancestorId: v }))));
    if (stat.needsValue) {
      const input = h('input.input.small', { type: 'number', step: 'any', value: c.value ?? 50 });
      input.addEventListener('change', () => setCfg({ value: Number.parseFloat(input.value) }));
      pane.append(h('label.field', h('span', stat.id === 'percentile' ? 'Percentile' : 'Threshold'), input));
    }
    if (c.tab === 'populations') pane.append(h('p.muted', { style: { fontSize: '11.5px', margin: 0 } }, `The statistic is computed for each of the ${ws.gates.length} populations in every sample and compared with the same test.`));
    return pane;
  }

  function clusterFields(withCluster) {
    const ws = store.ws;
    const c = cfg();
    const channels = clusterChannels(ws, data);
    if (!channels.length) {
      return [h('p.muted', 'No cluster channel yet. Cluster the data in the Explore view (FlowSOM or Leiden); the cluster labels become a derived channel that can be screened here.')];
    }
    const channel = channels.find((x) => x.name === c.clusterChannel) ?? channels[0];
    if (c.clusterChannel !== channel.name) store.ui.compare = { ...cfg(), clusterChannel: channel.name };
    const fields = [
      h('label.field', h('span', 'Cluster channel'), select(channels.map((x) => ({ value: x.name, label: x.name })), channel.name, (v) => setCfg({ clusterChannel: v, cluster: null }))),
      h('label.field', h('span', 'Parent population (the denominator)'), select(populationOptions(ws), c.clusterParent ?? ROOT, (v) => setCfg({ clusterParent: v }))),
    ];
    if (withCluster) {
      const labels = new Set();
      for (const view of data.views.values()) {
        const counts = clusterCounts(view, ws, channel.name, c.clusterParent ?? ROOT);
        if (counts) for (const k of counts.counts.keys()) labels.add(k);
      }
      const sorted = [...labels].sort((a, b) => a - b);
      if (!sorted.length) fields.push(h('p.muted', 'Load samples that carry this channel to list its clusters.'));
      else {
        const current = sorted.includes(c.cluster) ? c.cluster : sorted[0];
        if (c.cluster !== current) store.ui.compare = { ...cfg(), cluster: current };
        fields.push(h('label.field', h('span', 'Cluster'), select(sorted.map((k) => ({ value: k, label: clusterName(channel.record, k) })), current, (v) => setCfg({ cluster: Number(v) }))));
      }
    }
    fields.push(h('p.muted', { style: { fontSize: '11.5px', margin: 0 } }, 'Cluster frequency = cells of the cluster ÷ cells of the parent population, per sample.'));
    return fields;
  }

  function clusterPane() {
    return h('div.pane', h('h3', icon('explore'), 'Clusters to screen'), ...clusterFields(false));
  }

  function designPane() {
    const ws = store.ws;
    const c = cfg();
    const samples = candidateSamples();
    const fields = metaFields(samples);
    const pane = h('div.pane', h('h3', icon('layers'), 'Design'));
    const groupOptions = [{ value: '', label: '— choose —' }, ...fields.map((f) => ({ value: `meta:${f}`, label: `Metadata: ${f}` })), ...(ws.groups.length ? [{ value: 'groups', label: 'Workspace groups' }] : [])];
    pane.append(h('label.field', h('span', 'Group samples by'), select(groupOptions, c.groupBy, (v) => setCfg({ groupBy: v, levels: null, reference: null, contrast: null }))));
    if (!fields.length && !ws.groups.length) {
      pane.append(h('div.callout.warn', 'Samples have no metadata yet. Annotate them (sample menu → Annotate…) with a condition and, for paired designs, the subject or donor.'),
        h('button.btn.small', { type: 'button', onclick: () => app.annotateSamples?.(samples.map((s) => s.id)) }, icon('tag'), 'Annotate samples…'));
      return pane;
    }
    if (c.groupBy) {
      const levels = allLevels(samples);
      const chosen = selectedLevels(samples);
      const counts = new Map(levels.map((l) => [l.key, samples.filter((s) => levelOf(s, levels) === l).length]));
      const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '10px' } });
      for (const level of levels) {
        const on = chosen.some((l) => l.key === level.key);
        list.append(h('label.check', { style: { justifyContent: 'space-between' } },
          h('span', { style: { display: 'flex', gap: '7px', alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: on, onchange: (event) => {
              const keys = new Set(chosen.map((l) => l.key));
              if (event.target.checked) keys.add(level.key);
              else keys.delete(level.key);
              setCfg({ levels: levels.filter((l) => keys.has(l.key)).map((l) => l.key) });
            } }),
            h('span.swatch', { style: { background: level.color } }), level.label),
          h('span.muted', `${counts.get(level.key)} sample${counts.get(level.key) === 1 ? '' : 's'}`)));
      }
      pane.append(h('div.field-label', { style: { marginBottom: '6px' } }, 'Groups'), list);
      if (chosen.length >= 2) pane.append(h('label.field', h('span', 'Reference (A)'), select(chosen.map((l) => ({ value: l.key, label: l.label })), chosen[0].key, (v) => setCfg({ reference: v }))));
    }
    const pairFields = fields.filter((f) => `meta:${f}` !== c.groupBy);
    pane.append(h('label.field', h('span', 'Pair samples by (same subject in each group)'), select([{ value: '', label: 'No pairing (independent samples)' }, ...pairFields.map((f) => ({ value: `meta:${f}`, label: f }))], c.pairBy, (v) => setCfg({ pairBy: v }))));
    if (c.tab === 'clusters') {
      const covariateFields = pairFields.filter((f) => `meta:${f}` !== c.pairBy);
      if (covariateFields.length) {
        pane.append(h('div.field-label', { style: { marginBottom: '6px' } }, 'Covariates (fixed effects)'),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginBottom: '8px' } }, ...covariateFields.map((f) => h('label.check', h('input', { type: 'checkbox', checked: c.covariates.includes(f), onchange: (event) => setCfg({ covariates: event.target.checked ? [...c.covariates, f] : c.covariates.filter((x) => x !== f) }) }), f))));
      }
      if (c.pairBy) pane.append(h('p.muted', { style: { fontSize: '11.5px' } }, `${c.pairBy.slice(5)} enters the model as a fixed effect (a paired design).`));
    }
    pane.append(h('label.check', h('input', { type: 'checkbox', checked: c.includeControls, onchange: (event) => setCfg({ includeControls: event.target.checked }) }), 'Include control samples'));
    return pane;
  }

  function testPane() {
    const c = cfg();
    const pane = h('div.pane', h('h3', icon('flask'), c.tab === 'clusters' ? 'Model' : 'Test'));
    if (c.tab === 'clusters') {
      const samples = candidateSamples();
      const levels = selectedLevels(samples);
      if (levels.length > 2) pane.append(h('label.field', h('span', 'Contrast'), select(levels.slice(1).map((l) => ({ value: l.key, label: `${l.label} vs ${levels[0].label}` })), c.contrast ?? levels[1].key, (v) => setCfg({ contrast: v }))));
      pane.append(h('p.muted', { style: { fontSize: '11.5px' } }, 'Per cluster: cells of the cluster out of the parent population in each sample, modelled by a quasi-binomial generalized linear model (logit link) with the design above, and tested by a likelihood-ratio F test. This approximates diffcyt’s edgeR/GLMM approach.'));
    } else {
      const options = [{ value: 'auto', label: 'Automatic (from the design)' }, ...Object.entries(TESTS).map(([id, t]) => ({ value: id, label: t.label }))];
      pane.append(h('label.field', h('span', 'Test'), select(options, c.test, (v) => setCfg({ test: v }))));
    }
    if (c.tab === 'one') {
      pane.append(
        h('div.row', { style: { marginBottom: '8px' } },
          h('span.field-label', 'Summary'),
          h('div.segmented', ...[['mean', 'Mean ± 95% CI'], ['median', 'Median ± 95% CI']].map(([id, label]) => h(`button${c.center === id ? '.active' : ''}`, { type: 'button', onclick: () => setCfg({ center: id }, { invalidate: false }) }, label)))),
        h('label.check', h('input', { type: 'checkbox', checked: c.log, onchange: (event) => setCfg({ log: event.target.checked }, { invalidate: false }) }), 'Logarithmic value axis'));
    } else {
      pane.append(h('label.field', h('span', 'Multiple-testing correction'), select(ADJUST.map((a) => ({ value: a.id, label: a.label })), c.adjust, (v) => setCfg({ adjust: v }, { invalidate: false }))));
      const alpha = h('input.input.small', { type: 'number', step: 0.01, min: 0.001, max: 0.5, value: c.alpha });
      alpha.addEventListener('change', () => setCfg({ alpha: Math.min(0.5, Math.max(0.0001, Number.parseFloat(alpha.value) || 0.05)) }, { invalidate: false }));
      const fc = h('input.input.small', { type: 'number', step: 0.25, min: 0, value: c.fcThreshold });
      fc.addEventListener('change', () => setCfg({ fcThreshold: Math.max(0, Number.parseFloat(fc.value) || 0) }, { invalidate: false }));
      pane.append(h('div.row', h('label.field', { style: { flex: 1 } }, h('span', 'q threshold'), alpha), h('label.field', { style: { flex: 1 } }, h('span', '|log₂ FC| threshold'), fc)));
    }
    return pane;
  }

  // --- Right column ----------------------------------------------------------------------------------

  function renderRight() {
    chart?.destroy();
    chart = null;
    volcano?.destroy();
    volcano = null;
    clear(right);
    clear(headActions);
    const ws = store.ws;
    if (!ws.samples.length) {
      right.append(h('div.pane', h('div.empty', icon('compare'), h('h3', 'Compare groups of samples'), h('p', 'Add samples and annotate them with a condition (and a subject for paired designs). Then pick a population statistic to compare: each sample becomes one dot, and the test is chosen from the design.'))));
      return;
    }
    const c = cfg();
    if (!c.groupBy) {
      right.append(h('div.pane', h('div.empty', icon('layers'), h('h3', 'Choose how to group the samples'), h('p', 'Pick a metadata field (for example "condition") or workspace groups in the Design panel. Annotate samples first if they have no metadata.'),
        h('button.btn', { type: 'button', onclick: () => app.annotateSamples?.(candidateSamples().map((s) => s.id)) }, icon('tag'), 'Annotate samples…'))));
      return;
    }
    if (c.tab === 'one') renderOne();
    else renderScreen();
  }

  function loadPrompt(unloaded) {
    if (!unloaded.length) return null;
    return h('div.callout.accent', { style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' } },
      icon('info'), h('span', { style: { flex: 1 } }, `${unloaded.length} sample(s) in these groups are not loaded yet; their values appear once loaded.`),
      h('button.btn.small.primary', { type: 'button', disabled: Boolean(loading), onclick: () => loadSamples(unloaded) }, icon('play'), `Load ${unloaded.length}`));
  }

  function renderOne() {
    const spec = measureSpec();
    if (!spec) {
      right.append(h('div.pane', h('div.empty', icon('target'), h('h3', 'Choose a measure'), h('p', 'Pick a population and statistic, a table column or a cluster in the left panel.'))));
      return;
    }
    const analysis = analyze(spec);
    // Small designs load automatically (once per sample); larger ones wait for a click.
    const autoLoad = analysis.unloaded.filter((s) => !attempted.has(s.id) && !['missing', 'error'].includes(data.statusOf(s.id)));
    if (autoLoad.length && analysis.unloaded.length <= 12 && !loading) {
      for (const s of autoLoad) attempted.add(s.id);
      setTimeout(() => loadSamples(autoLoad), 0);
    }
    const prompt = loadPrompt(analysis.unloaded);
    if (prompt) right.append(prompt);

    const chartPane = h('div.pane');
    const title = h('h3', h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, spec.label), h('span.spacer'));
    chartPane.append(title);
    right.append(chartPane);
    if (!analysis.design) {
      chartPane.append(h('div.empty', icon('compare'), h('h3', 'At least two groups with values are needed'), h('p', analysis.allLevels.length < 2 ? 'The grouping has fewer than two levels among these samples.' : 'Load the samples, or check that the population applies to them.')));
      return;
    }
    chart = mountChart({
      height: 360,
      build: (width, height, colors) => buildDotPlot(width, height, colors, analysis),
      tooltip: (point) => [h('b', point.sample.name), h('div', `${point.levelLabel}: ${formatValue(point.value)}`), point.pair ? h('div.muted', `${cfg().pairBy.slice(5)}: ${point.pair}`) : null, h('div.muted', 'Click to open in the Gate view')].filter(Boolean),
      onClick: (point) => traceToEvidence(point.sample.id, spec),
      name: () => `compare-${spec.label}`,
    });
    title.append(
      h('button.btn.small', { type: 'button', title: 'Download as SVG', onclick: () => chart.exportSVG() }, icon('download'), 'SVG'),
      h('button.btn.small', { type: 'button', title: 'Download as PNG', onclick: () => chart.exportPNG() }, icon('download'), 'PNG'));
    chartPane.append(chart.el, h('p.muted', { style: { fontSize: '11px', margin: '6px 0 0' } }, `Each dot is a sample; bars show the ${cfg().center === 'mean' ? 'mean with its 95% t confidence interval' : 'median with a 95% bootstrap confidence interval'}.${analysis.design.startsWith('paired') ? ' Lines join samples of the same subject.' : ''} Click a dot to see the sample's gating.`));
    requestAnimationFrame(() => chart?.redraw());

    right.append(resultsPane(analysis), notesPane(analysis), robustnessPane(analysis));
    headActions.append(
      h('button.btn.small', { type: 'button', onclick: () => exportOne(analysis) }, icon('download'), 'CSV'),
      h('button.btn.small', { type: 'button', onclick: () => copyMethods(methodsOne(analysis)) }, icon('copy'), 'Methods text'),
      h('button.btn.small.primary', { type: 'button', onclick: () => saveComparison(recordOne(analysis)) }, icon('save'), 'Save for report'));
  }

  // --- Robustness to analysis choices (lib/multiverse.js) -------------------------------------------

  function robustKey(analysis) {
    const c = cfg();
    return JSON.stringify({ spec: analysis.spec, levels: analysis.levels.map((l) => [l.key, l.points.map((p) => p.sample.id)]), pairBy: c.pairBy, modified: store.ws.modified });
  }

  // Why a comparison cannot be checked, or null.
  function robustBlocker(analysis) {
    if (analysis.spec.kind !== 'statistic') return 'The check varies how populations are gated, so it applies to population statistics, not to cluster shares.';
    if (!analysis.spec.gateId || analysis.spec.gateId === ROOT) return 'Choose a gated population: the check varies its gates.';
    if (analysis.design !== 'two' && analysis.design !== 'paired-two') return 'The check compares two groups: choose two levels in the Design panel.';
    if (analysis.unloaded.length) return 'Load every sample first.';
    return null;
  }

  async function runRobustness(analysis) {
    const key = robustKey(analysis);
    const c = cfg();
    const spec = analysis.spec;
    const signal = { aborted: false };
    robust = { key, status: 'running', progress: 0, message: 'Preparing', cancel: () => { signal.aborted = true; } };
    render();
    try {
      const done = await checkRobustness(app, {
        statistic: { stat: spec.stat, gateId: spec.gateId, channel: spec.channel, ancestorId: spec.ancestorId, value: spec.value },
        samples: analysis.levels.flatMap((level, g) => level.points.map((p) => ({ id: p.sample.id, group: g, pair: p.pair }))),
        design: analysis.design,
        pairField: c.pairBy ? c.pairBy.slice(5) : undefined,
        labels: analysis.levels.map((l) => l.label),
        qcReruns: robustOptions.qcReruns,
        signal,
        onProgress: (message, progress) => {
          if (robust?.key !== key) return;
          robust.message = message;
          robust.progress = progress;
          const note = right.querySelector('[data-robust-progress]');
          if (note) note.textContent = `${message} (${Math.round(100 * progress)}%)`;
        },
      });
      if (robust?.key === key) robust = { key, status: 'done', ...done };
    } catch (error) {
      if (robust?.key === key) robust = error.name === 'AbortError' ? null : { key, status: 'error', error: error.message };
    } finally {
      render();
    }
  }

  function robustnessPane(analysis) {
    const pane = h('div.pane', h('h3', icon('layers'), 'Robustness to analysis choices'));
    const blocker = robustBlocker(analysis);
    if (blocker) {
      pane.append(h('p.muted', { style: { margin: 0 } }, blocker));
      return pane;
    }
    const key = robustKey(analysis);
    const current = robust && (robust.key === key || robust.status === 'running') ? robust : null;
    const stale = robust && robust.status === 'done' && robust.key !== key;
    const qcGate = qcGateOf(pathGates(store.ws, analysis.spec.gateId, denominatorOf(store.ws, analysis.spec)), QC_CHANNEL);
    const runButton = h('button.btn.small.primary', { type: 'button', disabled: current?.status === 'running', onclick: () => runRobustness(analysis) }, icon('play'), current?.status === 'done' ? 'Check again' : 'Check');
    pane.querySelector('h3').append(h('span.spacer'), current?.status === 'running' ? h('button.btn.small', { type: 'button', onclick: () => current.cancel() }, icon('stop'), 'Stop') : runButton);
    if (!current || current.status === 'error') {
      pane.append(h('p.muted', { style: { margin: 0 } }, 'Would the conclusion change had the data been processed differently, in ways another analyst might reasonably have chosen? The comparison is repeated with each gate on the population\'s path moved 1% and 2% of the axis, with the gates adapted to each sample (or without per-sample adjustments), without acquisition QC, with other compensation matrices and with a rank test, each alone and in random combinations (64 analyses).'));
      if (qcGate) pane.append(h('label.check', { style: { marginTop: '8px' } }, h('input', { type: 'checkbox', checked: robustOptions.qcReruns, onchange: (e) => { robustOptions.qcReruns = e.target.checked; } }), 'Also re-run QC with stricter and looser settings (MAD 4 and 8), which takes longer'));
      if (stale) pane.append(h('div.callout.warn', { style: { marginTop: '8px' } }, icon('warning'), h('span', 'The comparison or the workspace changed since the last check; check again.')));
      if (current?.status === 'error') pane.append(h('div.callout.danger', { style: { marginTop: '8px' } }, icon('warning'), h('span', current.error)));
      return pane;
    }
    if (current.status === 'running') {
      pane.append(h('p.muted', { 'data-robust-progress': '', style: { margin: 0 } }, `${current.message} (${Math.round(100 * current.progress)}%)`));
      return pane;
    }
    const { summary, results, choices } = current;
    const kind = { holds: 'ok', mostly: 'warn', fragile: 'danger' }[summary.verdict] ?? 'warn';
    const verdict = { holds: 'The conclusion holds', mostly: 'The conclusion mostly holds', fragile: 'The conclusion is fragile', undetermined: 'Undetermined' }[summary.verdict];
    pane.append(h(`div.callout.${kind}`, icon(kind === 'ok' ? 'check' : 'warning'), h('span', h('b', `${verdict}. `), summary.text)));
    const curve = mountChart({
      height: 150 + 18 * choices.filter((c) => c.options.length > 1).length,
      build: (width, height, colors) => buildCurve(width, height, colors, current, analysis),
      tooltip: (hit) => [h('b', hit.kind === 'declared' ? 'The declared analysis' : `Specification ${hit.rank}`), h('div', `Difference ${formatValue(hit.result.estimate)} (95% CI ${formatValue(hit.result.ci[0])} to ${formatValue(hit.result.ci[1])}), p ${formatP(hit.result.p)}`),
        ...hit.changes.map((text) => h('div.muted', text))],
      name: () => `robustness-${analysis.spec.label}`,
    });
    pane.append(curve.el);
    requestAnimationFrame(() => curve.redraw());
    const singles = results.filter((r) => r.kind === 'single' && r.result);
    const declared = summary.declared;
    const badge = (r) => (r.conclusion === declared.conclusion ? h('span.badge.ok', 'same') : h('span.badge.danger', r.conclusion === 'none' ? 'not significant' : `significantly ${r.conclusion}`));
    pane.append(h('div', { style: { overflow: 'auto', maxHeight: '320px', marginTop: '8px' } }, h('table.data',
      h('thead', h('tr', h('th', 'Choice'), h('th', 'Alternative'), h('th.r', 'Difference'), h('th.r', '95% CI'), h('th.r', 'p'), h('th', 'Conclusion'))),
      h('tbody',
        h('tr', h('td', h('b', 'Declared analysis')), h('td.muted', 'as in the workspace'), h('td.r', formatValue(declared.result.estimate)), h('td.r.muted', `${formatValue(declared.result.ci[0])} to ${formatValue(declared.result.ci[1])}`), h('td.r', formatP(declared.result.p)), h('td', h('span.badge.accent', declared.conclusion === 'none' ? 'not significant' : `significantly ${declared.conclusion}`))),
        singles.map((r) => {
          const c = r.picks.findIndex((x) => x > 0);
          return h('tr', h('td', choices[c].label), h('td', choices[c].options[r.picks[c]].label), h('td.r', formatValue(r.result.estimate)), h('td.r.muted', `${formatValue(r.result.ci[0])} to ${formatValue(r.result.ci[1])}`), h('td.r', formatP(r.result.p)), h('td', badge(r)));
        })))));
    const omitted = choices.find((c) => c.omitted)?.omitted;
    pane.append(h('p.muted.small-print', `${summary.total} analyses, sorted by the difference they find (95% CI): the declared one (purple), each alternative alone, and random combinations; red ones reach a different conclusion. The marks below show which choices each analysis changed, coloured by the alternative (point at an analysis for details). The declared analysis stays the result; this shows how much it depends on choices that could reasonably have been made otherwise (a specification-curve analysis, Simonsohn et al. 2020). Gates adapted to each sample include those the adaptation was unsure of.${omitted ? ` ${omitted}, so it is not among the alternatives.` : ''} Scales are not varied: a gate drawn by hand follows its population on any scale, and the boundary moves cover where it was drawn.`),
      h('div.btn-row', h('button.btn.small', { type: 'button', onclick: () => copyMethods(methodsSentence(summary, choices)) }, icon('copy'), 'Copy the methods sentence')));
    return pane;
  }

  // The specification curve: every analysis's difference and 95% CI, sorted, the declared one
  // marked, and below it which choices each analysis changed.
  function buildCurve(width, height, colors, run, analysis) {
    const { results, choices, summary } = run;
    const varied = choices.map((c, i) => ({ c, i })).filter(({ c }) => c.options.length > 1);
    const rows = varied.length;
    const rowH = 18;
    // A column wide enough for the choices' names under the curve.
    const left = 128;
    const rect = { x: left, y: 18, w: width - left - 16, h: height - 18 - 16 - rows * rowH - 8 };
    const valid = results.filter((r) => r.result).sort((a, b) => a.result.estimate - b.result.estimate);
    const items = [];
    const hits = [];
    let lo = Math.min(0, ...valid.map((r) => r.result.ci[0]));
    let hi = Math.max(0, ...valid.map((r) => r.result.ci[1]));
    const pad = (hi - lo) * 0.06 || 1;
    lo -= pad;
    hi += pad;
    const y = valueScale(lo, hi, rect.y + rect.h, rect.y, { target: 4 });
    leftAxis(items, y, rect, colors, 'Difference');
    items.push({ t: 'text', x: rect.x + 4, y: rect.y + 2, text: `${analysis.levels[1].label} − ${analysis.levels[0].label}`, fill: colors.text3, size: 10, baseline: 'top' });
    items.push({ t: 'line', x1: rect.x, y1: y.map(0), x2: rect.x + rect.w, y2: y.map(0), stroke: colors.line, width: 1, dash: [4, 3] });
    const step = rect.w / Math.max(1, valid.length);
    const declared = summary.declared;
    valid.forEach((r, k) => {
      const x = rect.x + step * (k + 0.5);
      const same = r.conclusion === declared.conclusion;
      const color = r.kind === 'declared' ? colors.accent : same ? colors.text2 : colors.danger;
      items.push({ t: 'line', x1: x, y1: y.map(r.result.ci[0]), x2: x, y2: y.map(r.result.ci[1]), stroke: withAlpha(color, 0.45), width: 1.2 });
      items.push({ t: 'circle', x, y: y.map(r.result.estimate), r: r.kind === 'declared' ? 4.5 : 2.8, fill: color });
      const changes = choices.map((c, i) => (r.picks[i] > 0 ? `${c.label}: ${c.options[r.picks[i]].label}` : null)).filter(Boolean);
      hits.push({ x, y: y.map(r.result.estimate), r: Math.max(4, step / 2), data: { ...r, rank: k + 1, changes } });
      varied.forEach(({ c, i }, row) => {
        if (r.picks[i] === 0) return;
        const cy = rect.y + rect.h + 22 + row * rowH;
        items.push({ t: 'rect', x: x - Math.min(3, step / 2.5), y: cy - 4, w: Math.min(6, step / 1.25), h: 8, fill: withAlpha(categoricalColor(r.picks[i] - 1), 0.85), radius: 1 });
      });
    });
    varied.forEach(({ c }, row) => {
      const cy = rect.y + rect.h + 22 + row * rowH;
      items.push({ t: 'line', x1: rect.x, y1: cy, x2: rect.x + rect.w, y2: cy, stroke: colors.grid, width: 1 });
      items.push({ t: 'text', x: rect.x - 6, y: cy, text: c.label.length > 22 ? `${c.label.slice(0, 21)}…` : c.label, fill: colors.text3, size: 9.5, align: 'end', baseline: 'middle' });
    });
    return { items, hits };
  }

  function traceToEvidence(sampleId, spec) {
    app.selectSample(sampleId);
    const gateId = spec.kind === 'cluster' ? spec.parentId : spec.gateId;
    app.selectGate(gateId && gateId !== ROOT ? gateId : null, { keepMode: true });
    app.setMode('gate');
  }

  function buildDotPlot(width, height, colors, analysis) {
    const c = cfg();
    const items = [];
    const hits = [];
    const levels = analysis.levels;
    const rect = { x: 66, y: 40, w: width - 66 - 16, h: height - 40 - 52 };
    const all = levels.flatMap((l) => l.points.map((p) => p.value));
    const log = c.log && all.every((v) => v > 0);
    const summaries = analysis.summaries;
    const extents = [...all];
    summaries.forEach((s) => {
      const ci = c.center === 'mean' ? s.ciMean : s.ciMedian;
      if (ci) extents.push(...ci.filter(Number.isFinite));
    });
    let lo = Math.min(...extents);
    let hi = Math.max(...extents);
    if (!log) {
      const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.1 || 1;
      lo = lo >= 0 && lo - pad < 0 ? 0 : lo - pad;
      hi += pad;
    } else {
      lo /= 1.25;
      hi *= 1.25;
    }
    const y = valueScale(lo, hi, rect.y + rect.h, rect.y, { log, target: 6 });
    leftAxis(items, y, rect, colors, shortLabel(analysis.spec.label));
    const band = rect.w / levels.length;
    const cx = (j) => rect.x + band * (j + 0.5);
    const spread = Math.min(band * 0.32, 46);
    const paired = analysis.design.startsWith('paired');
    const positions = new Map();
    levels.forEach((level, j) => {
      for (const point of level.points) {
        const jitter = paired && point.pair ? hashUnit(`pair:${point.pair}`) * spread * 0.5 : hashUnit(point.sample.id) * spread;
        positions.set(point, [cx(j) + jitter, y.map(point.value)]);
      }
    });
    // Paired lines under the dots.
    if (paired) {
      const byPair = new Map();
      levels.forEach((level, j) => level.points.forEach((p) => {
        if (!p.pair || !analysis.pairs.keys.includes(p.pair)) return;
        if (!byPair.has(p.pair)) byPair.set(p.pair, []);
        byPair.get(p.pair).push([j, positions.get(p)]);
      }));
      for (const list of byPair.values()) {
        list.sort((a, b) => a[0] - b[0]);
        items.push({ t: 'path', points: list.map(([, pos]) => pos), stroke: withAlpha(colors.text3.startsWith('#') ? colors.text3 : '#7b8496', 0.45), width: 1.2 });
      }
    }
    // Summary bars.
    levels.forEach((level, j) => {
      const s = summaries[j];
      const center = c.center === 'mean' ? s.mean : s.median;
      const ci = c.center === 'mean' ? s.ciMean : s.ciMedian;
      const half = Math.min(band * 0.3, 40);
      if (ci && ci.every(Number.isFinite)) {
        const x = cx(j) + half + 6;
        items.push({ t: 'line', x1: x, y1: y.map(ci[0]), x2: x, y2: y.map(ci[1]), stroke: colors.text2, width: 1.5 });
        items.push({ t: 'line', x1: x - 4, y1: y.map(ci[0]), x2: x + 4, y2: y.map(ci[0]), stroke: colors.text2, width: 1.5 });
        items.push({ t: 'line', x1: x - 4, y1: y.map(ci[1]), x2: x + 4, y2: y.map(ci[1]), stroke: colors.text2, width: 1.5 });
      }
      if (Number.isFinite(center)) items.push({ t: 'line', x1: cx(j) - half, y1: y.map(center), x2: cx(j) + half, y2: y.map(center), stroke: colors.text, width: 2.5 });
    });
    // Dots.
    levels.forEach((level) => {
      for (const point of level.points) {
        const [px, py] = positions.get(point);
        items.push({ t: 'circle', x: px, y: py, r: 4.6, fill: withAlpha(level.color, 0.88), stroke: colors.bg, width: 1.2 });
        hits.push({ x: px, y: py, r: 6, data: { ...point, levelLabel: level.label } });
      }
    });
    // Group labels.
    levels.forEach((level, j) => {
      items.push({ t: 'text', x: cx(j), y: rect.y + rect.h + 18, text: level.label, fill: colors.text, size: 12, weight: 650, align: 'center' });
      items.push({ t: 'text', x: cx(j), y: rect.y + rect.h + 34, text: `n = ${level.points.length}${j === 0 && levels.length > 1 ? ' · reference' : ''}`, fill: colors.text3, size: 10.5, align: 'center' });
    });
    items.push({ t: 'line', x1: rect.x, y1: rect.y + rect.h, x2: rect.x + rect.w, y2: rect.y + rect.h, stroke: colors.line, width: 1 });
    // Test annotation.
    const primary = analysis.primary;
    if (primary?.result) {
      const text = `${primary.short} p = ${formatP(primary.result.p)}`;
      if (levels.length === 2) {
        const yb = rect.y - 14;
        items.push({ t: 'path', points: [[cx(0), yb + 6], [cx(0), yb], [cx(1), yb], [cx(1), yb + 6]], stroke: colors.text2, width: 1.2 });
        items.push({ t: 'text', x: (cx(0) + cx(1)) / 2, y: yb - 5, text, fill: colors.text, size: 11.5, weight: 600, align: 'center' });
      } else items.push({ t: 'text', x: rect.x + rect.w, y: rect.y - 16, text, fill: colors.text, size: 11.5, weight: 600, align: 'end' });
    }
    return { items, hits };
  }

  function shortLabel(label) {
    return label.length > 46 ? `${label.slice(0, 44)}…` : label;
  }

  function resultsPane(analysis) {
    const pane = h('div.pane', h('h3', icon('flask'), 'Result'));
    const { primary, secondary, choice } = analysis;
    const levels = analysis.levels;
    const descr = h('p', { style: { margin: '0 0 10px', color: 'var(--text-2)' } },
      `Design: ${DESIGN_LABEL[analysis.design]}${levels.length === 2 ? ` — ${levels[1].label} (B) vs ${levels[0].label} (A)` : ''}. `,
      choice.overridden ? 'Test chosen by you.' : 'Test chosen automatically from the design.');
    pane.append(descr);
    const tiles = h('div.stat-grid', { style: { gridTemplateColumns: 'repeat(4, 1fr)' } });
    if (primary.result) {
      const r = primary.result;
      tiles.append(
        tile(primary.label, `p = ${formatP(r.p)}`, r.p < 0.05 ? 'ok' : ''),
        tile('Statistic', `${statName(primary.id)} = ${formatValue(r.statistic)}`),
        tile('Degrees of freedom', r.df !== undefined ? formatValue(r.df) : r.df1 !== undefined ? `${formatValue(r.df1)}, ${formatValue(r.df2)}` : '—'),
        tile('Samples', analysis.design.startsWith('paired') ? `${analysis.pairs.blocks.length} ${analysis.design === 'paired-two' ? 'pairs' : 'subjects'}` : levels.map((l) => l.points.length).join(' vs ')));
    } else tiles.append(h('div.callout.warn', { style: { gridColumn: '1 / -1' } }, `${primary.label}: ${primary.error}`));
    pane.append(tiles);
    if (secondary) {
      pane.append(h('p.muted', { style: { fontSize: '12px', margin: '8px 0 0' } },
        `${secondary.label} (${['mannwhitney', 'wilcoxon', 'kruskal', 'friedman'].includes(secondary.id) ? 'rank-based check' : 'parametric check'}): `,
        secondary.result ? `p = ${formatP(secondary.result.p)}${secondary.result.exact ? ' (exact)' : ''}` : secondary.error,
        '. Decide on the test before looking at results; the second test is shown as a robustness check.'));
    }
    // Per-group summaries.
    const summaryRows = levels.map((level, j) => {
      const s = analysis.summaries[j];
      return h('tr', h('td', h('span.swatch', { style: { background: level.color, marginRight: '6px' } }), level.label), h('td.r', s.n), h('td.r', formatValue(s.mean)), h('td.r', formatValue(s.sd)), h('td.r', formatValue(s.median)), h('td.r', `${formatValue(s.q1)} – ${formatValue(s.q3)}`));
    });
    pane.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Groups'),
      h('table.data', h('thead', h('tr', h('th', 'Group'), h('th.r', 'n'), h('th.r', 'Mean'), h('th.r', 'SD'), h('th.r', 'Median'), h('th.r', 'IQR'))), h('tbody', ...summaryRows)));
    if (analysis.effects?.length) {
      pane.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Effect sizes (B vs A, 95% CI)'),
        h('table.data', h('tbody', ...analysis.effects.map((e) => h('tr',
          h('td', e.label, h('div.muted', { style: { fontSize: '10.5px' } }, e.note)),
          h('td.r', h('b', formatValue(e.estimate)), e.log2 !== undefined ? h('div.muted', { style: { fontSize: '10.5px' } }, `log₂ ${formatValue(e.log2)}`) : null),
          h('td.r', e.ci ? `${formatValue(e.ci[0])} to ${formatValue(e.ci[1])}` : '—'))))));
    }
    if (analysis.posthoc) {
      pane.append(h('div.section-title', { style: { marginTop: '14px' } }, `Each group vs ${levels[0].label} (${analysis.posthoc.test}, ${analysis.posthoc.adjust}-adjusted)`),
        h('table.data', h('thead', h('tr', h('th', 'Group'), h('th.r', 'Difference'), h('th.r', 'Ratio'), h('th.r', 'p'), h('th.r', 'p (Holm)'))),
          h('tbody', ...analysis.posthoc.rows.map((r) => h('tr', h('td', r.level.label), h('td.r', formatValue(r.difference)), h('td.r', formatValue(r.ratio)), h('td.r', formatP(r.p)), h('td.r', h(r.q < 0.05 ? 'b' : 'span', formatP(r.q))))))));
    }
    pane.append(h('p.muted.fine-print', `Methods: ${methodsOne(analysis)}`), h('p.muted.fine-print', citations([primary.id, secondary?.id].filter(Boolean), analysis)));
    return pane;
  }

  function tile(k, v, kind = '') {
    return h('div.stat-tile', h('div.k', k), h(`div.v${kind ? `.${kind}` : ''}`, v));
  }

  function statName(id) {
    return { welch: 't', student: 't', pairedt: 't', mannwhitney: 'W', wilcoxon: 'V', welchanova: 'F', anova: 'F', rmanova: 'F', kruskal: 'H', friedman: 'χ²' }[id] ?? 'stat';
  }

  function citations(ids, analysis) {
    const parts = ids.map((id) => `${TESTS[id].label}: ${TESTS[id].cite}`);
    if (analysis?.effects?.some((e) => e.label.startsWith('Hedges'))) parts.push("Hedges' g: Hedges 1981, J Educ Stat 6:107");
    if (analysis?.effects?.some((e) => e.label.startsWith('Hodges'))) parts.push('Hodges & Lehmann 1963, Ann Math Stat 34:598');
    if (analysis?.posthoc) parts.push(ADJUST.find((a) => a.id === 'holm').cite);
    return `References — ${parts.join('; ')}.`;
  }

  function notesPane(analysis) {
    const pane = h('div.pane', h('h3', icon('info'), 'Assumptions and caveats'));
    for (const note of analysis.notes) pane.append(h(`div.callout${note.kind ? `.${note.kind}` : ''}`, { style: { marginBottom: '6px', fontSize: '12px' } }, note.text));
    return pane;
  }

  function groupingLabel() {
    const c = cfg();
    return c.groupBy === 'groups' ? 'workspace groups' : c.groupBy.slice(5);
  }

  function methodsOne(analysis) {
    const levels = analysis.levels;
    const primary = analysis.primary;
    const unit = analysis.design.startsWith('paired') ? `${analysis.pairs.blocks.length} ${cfg().pairBy.slice(5)}s, paired` : `n = ${levels.map((l) => `${l.points.length} ${l.label}`).join(', ')} samples`;
    const effects = analysis.design === 'two' ? "; effect sizes are the difference and ratio of means, Hedges' g and the Hodges–Lehmann shift with 95% confidence intervals"
      : analysis.design === 'paired-two' ? '; effect sizes are the mean paired difference and the geometric mean ratio with 95% confidence intervals'
        : '; groups were then compared with the reference with Holm-adjusted pairwise tests';
    const checked = robust?.status === 'done' && robust.key === robustKey(analysis) ? ` ${methodsSentence(robust.summary, robust.choices)}` : '';
    return `${analysis.spec.label} was computed per sample (the sample is the unit of analysis; ${unit}) and compared between ${levels.map((l) => l.label).join(', ')} (grouped by ${groupingLabel()}) with ${TESTS[primary.id].describe} (two-sided)${effects}, in CytoWeave ${app.version ?? ''}.${checked}`.replace(/ ,/g, ',');
  }

  function recordOne(analysis) {
    const c = cfg();
    const levels = analysis.levels;
    const r = analysis.primary.result ?? {};
    return {
      id: newId('cmp'),
      name: `${analysis.spec.label} by ${groupingLabel()}`,
      kind: 'single',
      measure: { ...analysis.spec },
      grouping: { by: c.groupBy, levels: levels.map((l) => l.label), reference: levels[0].label },
      pairing: c.pairBy ? c.pairBy.slice(5) : null,
      test: { id: analysis.primary.id, name: analysis.primary.label, statistic: r.statistic ?? null, df: r.df ?? (r.df1 !== undefined ? [r.df1, r.df2] : null), p: r.p ?? null },
      results: {
        groups: levels.map((l, j) => ({ label: l.label, ...analysis.summaries[j], ciMean: analysis.summaries[j].ciMean ?? null, ciMedian: analysis.summaries[j].ciMedian ?? null })),
        effects: (analysis.effects ?? []).map((e) => ({ label: e.label, estimate: e.estimate, ci: e.ci })),
        posthoc: analysis.posthoc ? analysis.posthoc.rows.map((row) => ({ group: row.level.label, difference: row.difference, ratio: row.ratio, p: row.p, q: row.q })) : null,
        secondary: analysis.secondary?.result ? { name: analysis.secondary.label, p: analysis.secondary.result.p } : null,
        values: levels.flatMap((l) => l.points.map((p) => ({ sampleId: p.sample.id, sample: p.sample.name, group: l.label, pair: p.pair, value: p.value }))),
      },
      methods: methodsOne(analysis),
      robustness: robust?.status === 'done' && robust.key === robustKey(analysis) ? { verdict: robust.summary.verdict, analyses: robust.summary.total, agree: robust.summary.agree, text: robust.summary.text, dependsOn: robust.summary.dependsOn, sizeDependsOn: robust.summary.sizeDependsOn } : null,
      created: new Date().toISOString(),
    };
  }

  function exportOne(analysis) {
    const rows = [['Sample', 'File', 'Group', cfg().pairBy ? cfg().pairBy.slice(5) : 'Pair', analysis.spec.label]];
    for (const level of analysis.levels) for (const p of level.points) rows.push([p.sample.name, p.sample.fileName ?? '', level.label, p.pair ?? '', p.value]);
    rows.push([], ['Test', 'Statistic', 'df', 'p']);
    for (const t of [analysis.primary, analysis.secondary].filter(Boolean)) rows.push([t.label, t.result?.statistic, t.result?.df ?? (t.result?.df1 !== undefined ? `${t.result.df1}; ${t.result.df2}` : ''), t.result?.p]);
    if (analysis.effects?.length) {
      rows.push([], ['Effect (B vs A)', 'Estimate', 'CI low', 'CI high']);
      for (const e of analysis.effects) rows.push([e.label, e.estimate, e.ci?.[0], e.ci?.[1]]);
    }
    if (analysis.posthoc) {
      rows.push([], ['Group vs reference', 'Difference', 'Ratio', 'p', 'p (Holm)']);
      for (const r of analysis.posthoc.rows) rows.push([r.level.label, r.difference, r.ratio, r.p, r.q]);
    }
    rows.push([], ['Methods', methodsOne(analysis)]);
    downloadCSV(rows, `compare-${analysis.spec.label}`);
    saveComparison(recordOne(analysis), { quiet: true });
  }

  async function copyMethods(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Methods text copied.', { kind: 'ok' });
    } catch {
      toast('The browser did not allow copying.', { kind: 'error' });
    }
  }

  function saveComparison(record, options = {}) {
    const ws = store.ws;
    const existing = ws.comparisons ?? [];
    const list = [...existing.filter((c) => c.name !== record.name), record].slice(-100);
    store.commit(setCollection(ws, 'comparisons', list, 'save-comparison'), 'Save comparison', ['comparisons']);
    if (!options.quiet) toast('Comparison saved; the Report view can cite it.', { kind: 'ok' });
  }

  // --- Screens ------------------------------------------------------------------------------------

  function renderScreen() {
    const c = cfg();
    const samples = candidateSamples();
    const levels = selectedLevels(samples);
    const inDesign = samples.filter((s) => levelOf(s, levels));
    const unloaded = inDesign.filter((s) => !data.view(s.id));
    const pane = h('div.pane');
    const head = h('h3', icon(c.tab === 'clusters' ? 'explore' : 'gate'), c.tab === 'clusters' ? 'Differential abundance of clusters' : 'Every population', h('span.spacer'));
    pane.append(head);
    right.append(pane);
    const kind = c.tab === 'clusters' ? 'clusters' : 'populations';
    const current = screenResult?.kind === kind ? screenResult : null;
    head.append(h('button.btn.small.primary', { type: 'button', disabled: Boolean(loading), onclick: () => runScreen(kind) }, icon('play'), current ? 'Run again' : 'Run screen'));
    if (!current) {
      pane.append(h('div.empty', icon(kind === 'clusters' ? 'explore' : 'gate'), h('h3', kind === 'clusters' ? 'Test every cluster' : 'Test every population'),
        h('p', kind === 'clusters'
          ? `Counts each cluster in the parent population of every sample (${inDesign.length} samples in ${levels.length} groups) and fits a quasi-binomial model per cluster. Results are adjusted for the number of clusters.`
          : `Computes the chosen statistic for each population in every sample (${inDesign.length} samples in ${levels.length} groups), runs the test chosen from the design, and adjusts the p-values for the number of populations.`),
        unloaded.length ? h('p.muted', `${unloaded.length} sample(s) will be loaded first.`) : null));
      return;
    }
    if (current.stale) pane.append(h('div.callout.warn', { style: { marginBottom: '10px' } }, 'The settings, gates or samples changed since this screen ran. Run it again to update.'));
    if (current.error) {
      pane.append(h('div.callout.danger', current.error));
      return;
    }
    const q = adjustPValues(current.rows.map((r) => r.p), c.adjust);
    current.rows.forEach((r, i) => { r.q = q[i]; });
    const significant = current.rows.filter((r) => r.q < c.alpha && (!(c.fcThreshold > 0) || Math.abs(r.log2fc) >= c.fcThreshold));
    pane.append(h('p', { style: { margin: '0 0 10px', color: 'var(--text-2)' } },
      `${significant.length} of ${current.rows.filter((r) => Number.isFinite(r.p)).length} ${kind} with q < ${c.alpha}${c.fcThreshold > 0 ? ` and |log₂ FC| ≥ ${c.fcThreshold}` : ''} (${ADJUST.find((a) => a.id === c.adjust).label}). ${current.description}`));
    volcano = mountChart({
      height: 340,
      build: (width, height, colors) => buildVolcano(width, height, colors, current, c),
      tooltip: (row) => [h('b', row.label), h('div', `log₂ FC ${formatValue(row.log2fc)} · p ${formatP(row.p)} · q ${formatP(row.q)}`), h('div.muted', 'Click to compare this one')],
      onClick: (row) => openRow(row, current),
      name: () => `volcano-${kind}`,
    });
    head.append(
      h('button.btn.small', { type: 'button', onclick: () => volcano.exportSVG() }, icon('download'), 'SVG'),
      h('button.btn.small', { type: 'button', onclick: () => volcano.exportPNG() }, icon('download'), 'PNG'));
    pane.append(volcano.el, h('p.muted', { style: { fontSize: '11px', margin: '6px 0 0' } }, `${current.xLabel} against −log₁₀ q. Dashed lines mark the thresholds; click a point to open its per-sample comparison.`));
    requestAnimationFrame(() => volcano?.redraw());

    const sorted = [...current.rows].sort((a, b) => (Number.isFinite(a.p) ? a.p : 2) - (Number.isFinite(b.p) ? b.p : 2));
    const body = h('tbody');
    for (const row of sorted) {
      const sig = significant.includes(row);
      body.append(h(`tr${sig ? '.selected' : ''}`, { style: { cursor: 'pointer' }, onclick: () => openRow(row, current) },
        h('td', { title: row.path ?? row.label, style: { maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.label),
        ...current.levels.map((l, j) => h('td.r', formatValue(row.means?.[j]))),
        h('td.r', formatValue(row.log2fc)),
        current.kind === 'populations' ? h('td.r', formatValue(row.g)) : null,
        h('td.r', formatP(row.p)),
        h('td.r', h(sig ? 'b' : 'span', formatP(row.q))),
        h('td.muted', row.note ?? '')));
    }
    const tablePane = h('div.pane', h('h3', icon('table'), 'Results', h('span.spacer'),
      h('button.btn.small', { type: 'button', onclick: () => exportScreen(current) }, icon('download'), 'CSV')),
    h('div', { style: { maxHeight: '420px', overflow: 'auto' } }, h('table.data', h('thead', h('tr',
      h('th', current.kind === 'clusters' ? 'Cluster' : 'Population'),
      ...current.levels.map((l) => h('th.r', `${current.kind === 'clusters' ? '%' : 'Mean'} ${l.label}`)),
      h('th.r', current.kind === 'clusters' ? 'log₂ OR' : 'log₂ FC'),
      current.kind === 'populations' ? h('th.r', "Hedges' g") : null,
      h('th.r', 'p'), h('th.r', 'q'), h('th', ''))), body)),
    h('p.muted.fine-print', `Methods: ${current.methods}`),
    h('p.muted.fine-print', `References — ${current.citations.join('; ')}; ${ADJUST.find((a) => a.id === c.adjust).cite}.`));
    right.append(tablePane);
    headActions.append(
      h('button.btn.small', { type: 'button', onclick: () => exportScreen(current) }, icon('download'), 'CSV'),
      h('button.btn.small', { type: 'button', onclick: () => copyMethods(current.methods) }, icon('copy'), 'Methods text'),
      h('button.btn.small.primary', { type: 'button', onclick: () => saveComparison(recordScreen(current)) }, icon('save'), 'Save for report'));
  }

  async function runScreen(kind) {
    const samples = candidateSamples();
    const levels = selectedLevels(samples);
    const inDesign = samples.filter((s) => levelOf(s, levels));
    const unloaded = inDesign.filter((s) => !data.view(s.id));
    if (unloaded.length) await loadSamples(unloaded);
    const progress = progressToast(`Screening ${kind}…`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      screenResult = kind === 'clusters' ? await screenClusters(levels, progress) : await screenPopulations(levels, progress);
      progress.done(`Screened ${screenResult.rows.length} ${kind}.`);
    } catch (error) {
      screenResult = { kind, error: error.message, rows: [] };
      progress.fail(error.message);
    }
    render();
  }

  async function screenPopulations(levels, progress) {
    const ws = store.ws;
    const c = cfg();
    const stat = STATISTICS.find((s) => s.id === c.stat) ?? STATISTICS[1];
    const gates = ws.gates.filter((g) => g.type !== 'category');
    const rows = [];
    let designUsed = null;
    let testUsed = null;
    for (let i = 0; i < gates.length; i += 1) {
      const gate = gates[i];
      const spec = { kind: 'statistic', gateId: gate.id, stat: stat.id, channel: stat.needsChannel ? c.channel ?? defaultChannel() : undefined, ancestorId: stat.needsAncestor ? c.ancestorId : undefined, value: stat.needsValue ? c.value : undefined };
      const analysis = analyzeLight(spec);
      const row = { id: gate.id, label: gate.name, path: gatePath(ws, gate.id), spec: { ...spec, label: columnLabel(ws, spec) }, p: Number.NaN, log2fc: Number.NaN, g: Number.NaN, means: [] };
      if (analysis.design) {
        designUsed ??= analysis.design;
        testUsed ??= analysis.choice.primary;
        const groups = analysis.levels.map((l) => l.points.map((p) => p.value));
        row.means = levels.map((l) => {
          const found = analysis.levels.find((x) => x.key === l.key);
          return found ? meanOf(found.points.map((p) => p.value)) : Number.NaN;
        });
        row.p = analysis.primary.result?.p ?? Number.NaN;
        const ma = row.means[0];
        if (levels.length === 2) {
          row.log2fc = ma > 0 && row.means[1] > 0 ? Math.log2(row.means[1] / ma) : Number.NaN;
          if (analysis.design === 'two') row.g = attempt(() => cohensD(groups[1], groups[0]).g) ?? Number.NaN;
        } else {
          const finite = row.means.filter((m) => m > 0);
          row.log2fc = finite.length >= 2 ? Math.log2(Math.max(...finite) / Math.min(...finite)) : Number.NaN;
        }
        if (analysis.primary.error) row.note = analysis.primary.error;
      } else row.note = 'fewer than two groups with values';
      rows.push(row);
      if (i % 4 === 3) {
        progress.update((i + 1) / gates.length, `Screening ${gate.name} (${i + 1}/${gates.length})`);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    const testName = testUsed ? TESTS[testUsed].describe : 'the design’s test';
    const n = levels.map((l) => l.label).join(', ');
    return {
      kind: 'populations',
      rows,
      levels,
      design: designUsed,
      test: testUsed,
      xLabel: levels.length === 2 ? `log₂ fold change of means (${levels[1].label} / ${levels[0].label})` : 'log₂ (largest / smallest group mean)',
      description: `Test: ${testUsed ? TESTS[testUsed].label : '—'} per population.`,
      methods: `For each of ${rows.length} populations, the ${stat.label.toLowerCase()} per sample (the sample is the unit of analysis) was compared between ${n} (grouped by ${groupingLabel()}${c.pairBy ? `, paired by ${c.pairBy.slice(5)}` : ''}) with ${testName}, and p-values were adjusted across populations with the ${ADJUST.find((a) => a.id === c.adjust).label.replace(/ \(.*\)/, '')} procedure, in CytoWeave ${app.version ?? ''}.`,
      citations: testUsed ? [`${TESTS[testUsed].label}: ${TESTS[testUsed].cite}`] : [],
    };
  }

  // analyze() without effect sizes and notes (for screens).
  function analyzeLight(spec) {
    const collected = collect(spec);
    const levels = collected.levels.filter((l) => l.points.length);
    const pairs = matchPairs(levels);
    const design = designOf(levels, pairs);
    const out = { levels, pairs, design };
    if (!design) return out;
    const groups = levels.map((l) => l.points.map((p) => p.value));
    out.choice = testsFor(design);
    out.primary = runTest(out.choice.primary, groups, pairs);
    return out;
  }

  async function screenClusters(levels, progress) {
    const ws = store.ws;
    const c = cfg();
    const channels = clusterChannels(ws, data);
    const channel = channels.find((x) => x.name === c.clusterChannel) ?? channels[0];
    if (!channel) throw new Error('There is no cluster channel to screen. Cluster the data in the Explore view first.');
    if (levels.length < 2) throw new Error('Choose at least two groups.');
    const samples = candidateSamples().filter((s) => levelOf(s, levels) && data.view(s.id));
    const usable = [];
    for (const sample of samples) {
      const counts = clusterCounts(data.view(sample.id), ws, channel.name, c.clusterParent ?? ROOT);
      if (counts && counts.total > 0) usable.push({ sample, counts, level: levelOf(sample, levels) });
    }
    progress.update(0.3, 'Counting cells per cluster…');
    if (usable.length < 3) throw new Error(`Only ${usable.length} loaded sample(s) carry the channel "${channel.name}" with events in the parent population.`);
    const labels = [...new Set(usable.flatMap((u) => [...u.counts.counts.keys()]))].sort((a, b) => a - b);
    const counts = usable.map((u) => labels.map((k) => u.counts.counts.get(k) ?? 0));
    const totals = usable.map((u) => u.counts.total);
    const contrastLevel = levels.find((l) => l.key === c.contrast) ?? levels[1];
    const variables = [{ name: 'group', values: usable.map((u) => u.level.key), type: 'factor', reference: levels[0].key }];
    const pairField = c.pairBy ? c.pairBy.slice(5) : null;
    if (pairField) variables.push({ name: pairField, values: usable.map((u) => String(u.sample.meta?.[pairField] ?? 'NA')), type: 'factor' });
    for (const field of c.covariates.filter((f) => f !== pairField && `meta:${f}` !== c.groupBy)) variables.push({ name: field, values: usable.map((u) => String(u.sample.meta?.[field] ?? 'NA')), type: 'factor' });
    // Drop factors with a single level among the samples (they would be constant columns).
    const kept = variables.filter((v, i) => i === 0 || new Set(v.values).size >= 2);
    const design = designMatrix(kept);
    const coefficient = `group[${contrastLevel.key}]`;
    if (!design.names.includes(coefficient)) throw new Error(`No samples in group "${contrastLevel.label}".`);
    if (usable.length <= design.p) throw new Error(`The model has ${design.p} coefficients but only ${usable.length} samples; remove covariates or add samples.`);
    progress.update(0.5, `Fitting ${labels.length} cluster models…`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const da = differentialAbundance(counts, totals, design, { coefficient, clusterNames: labels.map((k) => clusterName(channel.record, k)) });
    if (da.results.every((r) => !Number.isFinite(r.p))) throw new Error(`No cluster could be tested: ${da.results.find((r) => r.note)?.note ?? 'check the design'}. A covariate that coincides with the groups makes the design singular.`);
    const levelIndex = usable.map((u) => levels.indexOf(u.level));
    const rows = da.results.map((r, i) => {
      const means = levels.map((_, j) => {
        const vals = usable.map((u, s) => (levelIndex[s] === j ? (100 * counts[s][i]) / totals[s] : null)).filter((v) => v !== null);
        return vals.length ? meanOf(vals) : Number.NaN;
      });
      return { id: labels[i], cluster: labels[i], label: r.cluster, p: r.p, log2fc: r.log2OddsRatio, estimate: r.estimate, se: r.se, statistic: r.statistic, dispersion: r.dispersion, means, note: r.note ?? '' };
    });
    const parentName = c.clusterParent && c.clusterParent !== ROOT ? gateById(ws, c.clusterParent)?.name : 'all events';
    const covariates = kept.slice(1).map((v) => v.name);
    return {
      kind: 'clusters',
      rows,
      levels,
      channel: channel.name,
      parentId: c.clusterParent ?? ROOT,
      coefficient,
      xLabel: `log₂ odds ratio (${contrastLevel.label} vs ${levels[0].label}) ≈ log₂ fold change of frequency`,
      description: `Model: cluster cells out of ${parentName} ~ group${covariates.length ? ` + ${covariates.join(' + ')}` : ''}; ${usable.length} samples.`,
      methods: `Differential abundance of ${rows.length} clusters (${channel.name}) between ${contrastLevel.label} and ${levels[0].label} was tested per cluster with a quasi-binomial generalized linear model (logit link; cluster cells out of ${parentName} cells per sample; design ~ group${covariates.length ? ` + ${covariates.join(' + ')}` : ''}) by likelihood-ratio F test, approximating diffcyt (Weber et al. 2019), with p-values adjusted across clusters by the ${ADJUST.find((a) => a.id === c.adjust).label.replace(/ \(.*\)/, '')} procedure, in CytoWeave ${app.version ?? ''}.`,
      citations: ['Quasi-likelihood GLM: McCullagh & Nelder 1989', 'diffcyt: Weber et al. 2019, Commun Biol 2:183, doi:10.1038/s42003-019-0415-5'],
    };
  }

  function buildVolcano(width, height, colors, result, c) {
    const items = [];
    const hits = [];
    const rect = { x: 60, y: 14, w: width - 60 - 16, h: height - 14 - 46 };
    const rows = result.rows.filter((r) => Number.isFinite(r.log2fc) && Number.isFinite(r.q));
    const ys = rows.map((r) => -Math.log10(Math.max(r.q, 1e-300)));
    const maxAbs = Math.max(1, c.fcThreshold * 1.3, ...rows.map((r) => Math.abs(r.log2fc))) * 1.08;
    const twoSided = !(result.kind === 'populations' && result.levels.length > 2);
    const x = valueScale(twoSided ? -maxAbs : 0, maxAbs, rect.x, rect.x + rect.w, { target: 8 });
    const y = valueScale(0, Math.max(2, -Math.log10(c.alpha) * 1.3, ...ys) * 1.06, rect.y + rect.h, rect.y, { target: 6 });
    leftAxis(items, y, rect, colors, '−log₁₀ q');
    bottomAxis(items, x, rect, colors, result.xLabel);
    const yAlpha = y.map(-Math.log10(c.alpha));
    items.push({ t: 'line', x1: rect.x, y1: yAlpha, x2: rect.x + rect.w, y2: yAlpha, stroke: colors.text3, width: 1, dash: [4, 4] });
    items.push({ t: 'text', x: rect.x + rect.w - 4, y: yAlpha - 4, text: `q = ${c.alpha}`, fill: colors.text3, size: 10, align: 'end' });
    if (c.fcThreshold > 0) {
      for (const v of twoSided ? [-c.fcThreshold, c.fcThreshold] : [c.fcThreshold]) {
        items.push({ t: 'line', x1: x.map(v), y1: rect.y, x2: x.map(v), y2: rect.y + rect.h, stroke: colors.text3, width: 1, dash: [4, 4] });
      }
    }
    if (twoSided) items.push({ t: 'line', x1: x.map(0), y1: rect.y, x2: x.map(0), y2: rect.y + rect.h, stroke: colors.line, width: 1 });
    const up = '#e45563';
    const down = '#4c78e0';
    const ranked = rows.map((r, i) => ({ r, yv: ys[i] })).sort((a, b) => a.yv - b.yv);
    const labelled = new Set([...ranked].reverse().filter(({ r }) => r.q < c.alpha).slice(0, 10).map(({ r }) => r));
    for (const { r, yv } of ranked) {
      const sig = r.q < c.alpha && (!(c.fcThreshold > 0) || Math.abs(r.log2fc) >= c.fcThreshold);
      const px = x.map(r.log2fc);
      const py = y.map(yv);
      const color = sig ? (r.log2fc >= 0 || !twoSided ? up : down) : colors.muted;
      items.push({ t: 'circle', x: px, y: py, r: sig ? 5 : 3.8, fill: withAlpha(color.startsWith('#') ? color : '#9aa3b4', sig ? 0.85 : 0.45), stroke: sig ? colors.bg : null, width: 1 });
      hits.push({ x: px, y: py, r: 6, data: r });
      if (labelled.has(r)) items.push({ t: 'text', x: px + 7, y: py - 6, text: r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label, fill: colors.text2, size: 10.5 });
    }
    return { items, hits };
  }

  function openRow(row, result) {
    if (result.kind === 'clusters') {
      setCfg({ tab: 'one', source: 'cluster', clusterChannel: result.channel, clusterParent: result.parentId, cluster: row.cluster }, { invalidate: false });
    } else {
      const spec = row.spec;
      setCfg({ tab: 'one', source: 'population', gateId: spec.gateId, stat: spec.stat, channel: spec.channel ?? cfg().channel, ancestorId: spec.ancestorId ?? cfg().ancestorId }, { invalidate: false });
    }
  }

  function exportScreen(result) {
    const header = [result.kind === 'clusters' ? 'Cluster' : 'Population', ...(result.kind === 'populations' ? ['Path'] : []), ...result.levels.map((l) => `${result.kind === 'clusters' ? '% of parent' : 'Mean'} ${l.label}`), result.kind === 'clusters' ? 'log2 odds ratio' : 'log2 fold change', ...(result.kind === 'populations' ? ["Hedges' g"] : ['SE (logit)', 'Dispersion']), 'p', `q (${cfg().adjust})`, 'Note'];
    const rows = [header];
    for (const r of result.rows) {
      rows.push([r.label, ...(result.kind === 'populations' ? [r.path] : []), ...r.means, r.log2fc, ...(result.kind === 'populations' ? [r.g] : [r.se, r.dispersion]), r.p, r.q, r.note ?? '']);
    }
    rows.push([], ['Methods', result.methods]);
    downloadCSV(rows, `screen-${result.kind}`);
    saveComparison(recordScreen(result), { quiet: true });
  }

  function recordScreen(result) {
    const c = cfg();
    return {
      id: newId('cmp'),
      name: result.kind === 'clusters' ? `Differential abundance: ${result.channel} by ${groupingLabel()}` : `Population screen: ${STATISTICS.find((s) => s.id === c.stat)?.label ?? c.stat} by ${groupingLabel()}`,
      kind: `screen-${result.kind}`,
      measure: result.kind === 'clusters' ? { kind: 'cluster', channel: result.channel, parentId: result.parentId } : { kind: 'statistic', stat: c.stat, channel: c.channel ?? null },
      grouping: { by: c.groupBy, levels: result.levels.map((l) => l.label), reference: result.levels[0]?.label },
      pairing: c.pairBy ? c.pairBy.slice(5) : null,
      test: { id: result.kind === 'clusters' ? 'quasibinomial-glm-lr' : result.test, name: result.kind === 'clusters' ? 'Quasi-binomial GLM, likelihood-ratio F test' : TESTS[result.test]?.label ?? '', adjust: c.adjust, alpha: c.alpha },
      results: result.rows.map((r) => ({ id: r.id, label: r.label, means: r.means, log2fc: r.log2fc, p: r.p, q: r.q })),
      methods: result.methods,
      created: new Date().toISOString(),
    };
  }

  render();
  return {
    update(topics) {
      if (topics.has('theme')) {
        chart?.redraw();
        volcano?.redraw();
      }
      if (topics.has('ws') || topics.has('data') || topics.has('derived') || topics.has('tables') || topics.has('mode')) {
        if (screenResult && (topics.has('ws') || topics.has('derived')) && !topics.has('comparisons')) screenResult = { ...screenResult, stale: true };
        render();
      }
    },
    destroy() {
      loading?.cancel();
      chart?.destroy();
      volcano?.destroy();
      root.remove();
    },
  };
}

// Registered at import time as well, so the Tables view can call it before Compare is opened
// (app.js lazily imports this module only when the mode is shown).
export function installCompareHook(app) {
  app.compareColumn ??= (table, column) => {
    app.store.ui.compare = { ...(app.store.ui.compare ?? {}), tab: 'one', source: 'table', tableId: table.id, columnId: column.id };
    app.setMode('compare');
  };
}
