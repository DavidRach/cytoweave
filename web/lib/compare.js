// One measure compared across groups of samples: the design (independent or paired, two or more
// groups), the test it calls for, group summaries, effect sizes and post-hoc tests. The Compare
// view collects each sample's value; these functions do the statistics, so that a saved
// comparison can be recomputed from its values (reproducibility certificates, certificate.js).

import {
  adjustPValues,
  blockAnova,
  bootstrap,
  cohensD,
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
} from './hypothesis.js';
import { quantileSorted } from './stats.js';
import { computeStatistic } from './engine.js';
import { clusterCounts } from './differential.js';

// Each test runs on groups (arrays of values, reference first) or on matched pairs/blocks.
export const TESTS = {
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
export const AUTO = { two: ['welch', 'mannwhitney'], 'paired-two': ['pairedt', 'wilcoxon'], multi: ['welchanova', 'kruskal'], 'paired-multi': ['rmanova', 'friedman'] };
export const AVAILABLE = {
  two: ['welch', 'student', 'mannwhitney'],
  'paired-two': ['pairedt', 'wilcoxon', 'welch', 'mannwhitney'],
  multi: ['welchanova', 'anova', 'kruskal'],
  'paired-multi': ['rmanova', 'friedman', 'welchanova', 'kruskal'],
};
export const DESIGN_LABEL = { two: 'two independent groups', 'paired-two': 'two paired groups', multi: 'more than two independent groups', 'paired-multi': 'more than two groups, repeated in each subject' };

export const median = (values) => quantileSorted(Float64Array.from(values).sort(), 0.5);
export const meanOf = (values) => values.reduce((a, b) => a + b, 0) / values.length;
export const sdOf = (values) => {
  if (values.length < 2) return Number.NaN;
  const m = meanOf(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
};

// Matched pairs (two levels) or complete blocks (all levels) by the pairing field.
export function matchPairs(levels) {
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

export function designOf(levels, pairs, pairBy = false) {
  const k = levels.filter((l) => l.points.length).length;
  const paired = Boolean(pairBy) && pairs.blocks.length >= 2;
  if (k < 2) return null;
  if (k === 2) return paired ? 'paired-two' : 'two';
  return paired ? 'paired-multi' : 'multi';
}

export function testsFor(design, test = 'auto') {
  const auto = AUTO[design];
  if (test === 'auto' || !AVAILABLE[design].includes(test)) return { primary: auto[0], secondary: auto[1], overridden: false };
  const counterpart = { welch: 'mannwhitney', student: 'mannwhitney', mannwhitney: 'welch', pairedt: 'wilcoxon', wilcoxon: 'pairedt', welchanova: 'kruskal', anova: 'kruskal', kruskal: 'welchanova', rmanova: 'friedman', friedman: 'rmanova' }[test];
  return { primary: test, secondary: AVAILABLE[design].includes(counterpart) ? counterpart : null, overridden: true };
}

export function runTest(id, groups, pairs) {
  try {
    return { id, ...TESTS[id], result: TESTS[id].run({ groups, pairs }) };
  } catch (error) {
    return { id, ...TESTS[id], error: error.message };
  }
}

export function summarize(values) {
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

export const attempt = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

export function independentEffects(a, b) {
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

export function pairedEffects(a, b) {
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
export function posthoc(levels, groups, pairs, design, primary) {
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

// A sample's value of a measure: a statistic of a population ({ stat, gateId, channel, ... }) or a
// cluster's share of its parent population in percent ({ kind: 'cluster', channel, parentId,
// cluster }); NaN where it cannot be computed. counts may be a cached clusterCounts.
export function measureValue(view, ws, spec, context = {}, counts = clusterCounts) {
  try {
    if (spec.kind === 'cluster') {
      const result = counts(view, ws, spec.channel, spec.parentId);
      if (!result || !result.total) return Number.NaN;
      return (100 * (result.counts.get(spec.cluster) ?? 0)) / result.total;
    }
    return computeStatistic(view, ws, { stat: spec.stat, gateId: spec.gateId, channel: spec.channel, ancestorId: spec.ancestorId, value: spec.value, control: spec.control, counting: spec.counting, dilution: spec.dilution }, context);
  } catch {
    return Number.NaN;
  }
}

// The analysis of levels ([{ key, label, points: [{ value, pair }] }], the reference first):
// options { pairBy (pair by a field when set), test ('auto' or a test id) }. Levels without
// points are left out.
export function analyzeLevels(allLevels, options = {}) {
  const levels = allLevels.filter((l) => l.points.length);
  const pairs = matchPairs(levels);
  const design = designOf(levels, pairs, options.pairBy);
  const analysis = { levels, pairs, design };
  if (!design) return analysis;
  const groups = levels.map((l) => l.points.map((p) => p.value));
  const choice = testsFor(design, options.test);
  analysis.choice = choice;
  analysis.primary = runTest(choice.primary, groups, pairs);
  analysis.secondary = choice.secondary ? runTest(choice.secondary, groups, pairs) : null;
  analysis.summaries = levels.map((level) => summarize(level.points.map((p) => p.value)));
  if (design === 'two') analysis.effects = independentEffects(groups[0], groups[1]);
  else if (design === 'paired-two') analysis.effects = pairedEffects(pairs.a, pairs.b);
  else analysis.posthoc = posthoc(levels, groups, pairs, design, choice.primary);
  return analysis;
}
