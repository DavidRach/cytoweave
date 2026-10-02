import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import { quantileSorted } from './stats.js';
import {
  adjustedRandIndex,
  annotateClusters,
  clusterAbundance,
  clusterMedians,
  clusterStability,
  contingencyTable,
  heatmapMatrix,
  markerEnrichment,
  normalizedMutualInformation,
  otsuSplit,
} from './cluster-summary.js';

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected} (tolerance ${tolerance})`);
}

// Two clusters and one unlabeled event.
const A = Float32Array.of(1, 2, 3, 4, 10, 20, 30, 99);
const B = Float32Array.of(5, 5, 5, 5, 0, 0, 1, 1);
const LABELS = Int32Array.of(0, 0, 0, 0, 1, 1, 1, -1);

test('cluster medians, means and quartiles match hand values (R type 7)', () => {
  const s = clusterMedians([A, B], LABELS, 2, { markers: ['A', 'B'] });
  assert.deepEqual(Array.from(s.counts), [4, 3]);
  close(s.frequencies[0], 4 / 7, 1e-15);
  // A: cluster 0 = 1,2,3,4 → median 2.5, quartiles 1.75 and 3.25; cluster 1 = 10,20,30.
  assert.deepEqual(Array.from(s.medians), [2.5, 5, 20, 0]);
  assert.deepEqual(Array.from(s.q1), [1.75, 5, 15, 0]);
  assert.deepEqual(Array.from(s.q3), [3.25, 5, 25, 0.5]);
  close(s.means[3], 1 / 3, 1e-15);
  // "Rest" of each cluster is the other cluster here; the unlabeled 99 never counts.
  assert.deepEqual(Array.from(s.rest.medians), [20, 0, 2.5, 5]);
  assert.equal(s.overall.median[0], 4);
  assert.equal(s.overall.upper[0], quantileSorted(Float64Array.of(1, 2, 3, 4, 10, 20, 30), 0.99));
  assert.deepEqual(s.markers, ['A', 'B']);
});

test('cluster statistics skip non-finite values and accept row-major input', () => {
  const withNaN = Float32Array.from(A);
  withNaN[6] = Number.NaN;
  const s = clusterMedians([withNaN], LABELS, 2);
  assert.equal(s.medians[1], 15);
  assert.equal(s.counts[1], 3);
  const rows = new Float32Array(16);
  for (let i = 0; i < 8; i += 1) { rows[2 * i] = A[i]; rows[2 * i + 1] = B[i]; }
  const fromRows = clusterMedians({ data: rows, n: 8, dim: 2 }, LABELS, 2);
  const fromColumns = clusterMedians([A, B], LABELS, 2);
  assert.deepEqual(fromRows.medians, fromColumns.medians);
  assert.deepEqual(fromRows.rest.q3, fromColumns.rest.q3);
});

test('cluster and rest quantiles agree with sorting each group', () => {
  const random = createRandom(8);
  const n = 3000; const k = 6;
  const columns = [0, 1, 2].map(() => Float32Array.from({ length: n }, () => random.gaussian() * 3));
  const labels = Int32Array.from({ length: n }, () => random.int(k + 1) - 1);
  const s = clusterMedians(columns, labels, k, { columns: [2, 0] });
  [2, 0].forEach((col, m) => {
    for (let c = 0; c < k; c += 1) {
      const inside = []; const outside = [];
      for (let i = 0; i < n; i += 1) {
        if (labels[i] === c) inside.push(columns[col][i]);
        else if (labels[i] >= 0) outside.push(columns[col][i]);
      }
      const sin = Float64Array.from(inside).sort();
      const sout = Float64Array.from(outside).sort();
      for (const [q, key] of [[0.25, 'q1'], [0.5, 'medians'], [0.75, 'q3']]) {
        assert.equal(s[key][c * 2 + m], quantileSorted(sin, q), `cluster ${c} ${key}`);
        assert.equal(s.rest[key][c * 2 + m], quantileSorted(sout, q), `rest ${c} ${key}`);
      }
    }
  });
});

test('heatmap scaling and ordering', () => {
  const s = clusterMedians([A, B], LABELS, 2, { percentiles: [0, 1] });
  const h = heatmapMatrix(s);
  // Quantile scaling with p0/p100: (median − min) / (max − min), clipped to 0…1.
  close(h.values[0], (2.5 - 1) / 29, 1e-12);
  close(h.values[2], (20 - 1) / 29, 1e-12);
  assert.equal(h.values[1], 1);
  assert.equal(h.values[3], 0);
  const z = heatmapMatrix(s, { scale: 'zscore' });
  close(z.values[0] + z.values[2], 0, 1e-12);
  close(Math.abs(z.values[0]), Math.SQRT1_2, 1e-12); // two values: ±1/√2 with R's n − 1
  // Rows ordered by average linkage: 0 and 10 merge after 0 and 1.
  const three = { k: 3, dim: 1, medians: Float64Array.of(0, 10, 1), means: new Float64Array(3) };
  const t = heatmapMatrix(three, { scale: 'none' });
  assert.deepEqual(Array.from(t.rowTree.heights), [1, 9.5]);
  assert.deepEqual(Array.from(t.rowOrder), [1, 0, 2]);
  assert.deepEqual(Array.from(t.ordered), [10, 0, 1]);
  assert.deepEqual(t.range, [0, 10]);
  assert.deepEqual(Array.from(heatmapMatrix(three, { scale: 'none', clusterRows: false }).rowOrder), [0, 1, 2]);
});

test('cluster abundance per sample', () => {
  const labels = Int32Array.of(0, 1, 1, 2, 0, -1);
  const sampleOf = Int32Array.of(0, 0, 1, 1, 1, 1);
  const a = clusterAbundance(labels, sampleOf, 2, 3);
  assert.deepEqual(Array.from(a.counts), [1, 1, 0, 1, 1, 1]);
  assert.deepEqual(Array.from(a.totals), [2, 3]);
  assert.deepEqual(Array.from(a.clusterTotals), [2, 2, 1]);
  assert.deepEqual(Array.from(a.frequencies), [0.5, 0.5, 0, 1 / 3, 1 / 3, 1 / 3]);
});

test('adjusted Rand index: identical, relabelled, hand-computed and chance', () => {
  const a = Int32Array.of(0, 0, 0, 1, 1, 1);
  assert.equal(adjustedRandIndex(a, a), 1);
  assert.equal(adjustedRandIndex(a, Int32Array.of(7, 7, 7, 3, 3, 3)), 1);
  // Pairs together in both: 2; Σ C(rows) = 6, Σ C(cols) = 3, C(6, 2) = 15:
  // (2 − 6·3/15) / ((6 + 3)/2 − 6·3/15) = 0.8 / 3.3.
  close(adjustedRandIndex(a, Int32Array.of(0, 0, 1, 1, 2, 2)), 0.8 / 3.3, 1e-15);
  close(adjustedRandIndex(Int32Array.of(0, 0, 1, 1, 2, 2), a), 0.8 / 3.3, 1e-15);
  // scikit-learn's documented example: [0, 0, 1, 1] vs [0, 0, 1, 2] → 4/7.
  close(adjustedRandIndex(Int32Array.of(0, 0, 1, 1), Int32Array.of(0, 0, 1, 2)), 4 / 7, 1e-15);
  const random = createRandom(2);
  const x = Int32Array.from({ length: 20000 }, () => random.int(5));
  const y = Int32Array.from({ length: 20000 }, () => random.int(5));
  assert.ok(Math.abs(adjustedRandIndex(x, y)) < 0.005);
  assert.equal(contingencyTable(Int32Array.of(5, 9, 5), Int32Array.of(1, 1, 2)).ka, 2);
});

test('normalized mutual information matches the entropy formula', () => {
  const a = Int32Array.of(0, 0, 0, 1, 1, 1);
  const b = Int32Array.of(0, 0, 1, 1, 2, 2);
  // MI = (2/3) ln 2, H(a) = ln 2, H(b) = ln 3: NMI = (4/3) ln 2 / ln 6.
  close(normalizedMutualInformation(a, b), ((4 / 3) * Math.log(2)) / Math.log(6), 1e-15);
  close(normalizedMutualInformation(a, b, { average: 'max' }), ((2 / 3) * Math.log(2)) / Math.log(3), 1e-15);
  assert.equal(normalizedMutualInformation(a, a), 1);
  assert.equal(normalizedMutualInformation(Int32Array.of(1, 1, 1), Int32Array.of(4, 4, 4)), 1);
});

test('cluster stability: Jaccard best match per reference cluster (clusterboot)', () => {
  const reference = Int32Array.of(0, 0, 0, 0, 1, 1, 1, 1);
  const same = clusterStability([reference, Int32Array.of(1, 1, 1, 1, 0, 0, 0, 0)]);
  assert.deepEqual(Array.from(same.jaccard), [1, 1]);
  assert.equal(same.ari, 1);
  // Cluster 0 split in two: best Jaccard 2 / (4 + 2 − 2) = 0.5, which counts as dissolved.
  const split = clusterStability([reference, Int32Array.of(0, 0, 2, 2, 1, 1, 1, 1)]);
  assert.deepEqual(Array.from(split.jaccard), [0.5, 1]);
  assert.deepEqual(Array.from(split.dissolved), [1, 0]);
  assert.deepEqual(Array.from(split.recovered), [0, 1]);
  // A subsample (−1 = left out) is compared on the events it kept.
  const sub = clusterStability([reference, Int32Array.of(-1, -1, 0, 0, 1, 1, 1, -1)]);
  assert.deepEqual(Array.from(sub.jaccard), [1, 1]);
  // Runs can be produced by a function of (run, seed); the reference is the first run.
  const runs = clusterStability((run) => (run === 2 ? Int32Array.of(0, 0, 2, 2, 1, 1, 1, 1) : reference), { runs: 3 });
  assert.deepEqual(Array.from(runs.jaccardPerRun), [1, 1, 0.5, 1]);
  close(runs.jaccard[0], 0.75, 1e-15);
  assert.throws(() => clusterStability([reference]), /at least two/);
});

test('Otsu split of cluster medians', () => {
  const s = otsuSplit([5.1, 0, 0.2, 5, 0.1]);
  close(s.low, 0.1, 1e-12);
  close(s.high, 5.05, 1e-12);
  close(s.threshold, 2.575, 1e-12);
  // between / total variance = 0.24 · 4.95² / 5.8856
  close(s.separation, (0.24 * 4.95 ** 2) / 5.8856, 1e-12);
  assert.equal(otsuSplit([2, 2, 2]).separation, 0);
});

const MARKERS = ['CD3', 'CD4', 'CD8', 'CD19'];
const PROFILES = [
  [3, 3, 0, 0], // CD4 T
  [3, 0, 3, 0], // CD8 T
  [0, 0, 0, 3], // B
  [3, 0, 0, 0], // double-negative T
  [0, 0, 0.2, 0], // none of the rules
];
const SUMMARY = { k: 5, dim: 4, medians: Float64Array.from(PROFILES.flat()), means: new Float64Array(20) };
const RULES = [
  { name: 'T cell', require: { CD3: '+' } },
  { name: 'CD4 T', require: { CD3: '+', CD4: '+', CD8: '-' } },
  { name: 'CD8 T', require: { CD3: '+', CD8: '+', CD4: '−' } },
  { name: 'B cell', require: { cd19: 'pos', CD3: 'neg' } },
  { name: 'Monocyte', require: { CD14: '+' } },
];

test('annotation picks the most specific matching rule and explains itself', () => {
  const result = annotateClusters(SUMMARY, MARKERS, RULES);
  assert.deepEqual(result.clusters.map((c) => c.name), ['CD4 T', 'CD8 T', 'B cell', 'T cell', null]);
  const cd4 = result.clusters[0];
  assert.deepEqual(cd4.alternatives.map((a) => a.name), ['T cell']);
  assert.equal(cd4.confidence, 1);
  // CD8 medians 0, 3, 0, 0, 0.2 split into {0, 0, 0, 0.2} and {3}: threshold 1.525, half gap
  // 1.475, so a CD8 median of 0 is 1.525 / 1.475 below the threshold.
  close(cd4.margins.CD8, 1.525 / 1.475, 1e-12);
  close(result.thresholds.find((t) => t.marker === 'CD8').threshold, 1.525, 1e-12);
  assert.equal(result.clusters[4].nearest.name, 'T cell');
  assert.deepEqual(result.clusters[4].nearest.failing.map((f) => f.marker), ['CD3']);
  assert.ok(result.warnings.some((w) => /Monocyte/.test(w) && /CD14/.test(w)));
  assert.throws(() => annotateClusters(SUMMARY, MARKERS, [{ name: 'x', require: { CD3: 'dim' } }]), /should be \+ or −/);
});

test('annotation honours user thresholds', () => {
  const result = annotateClusters(SUMMARY, MARKERS, RULES, { thresholds: { CD8: 0.1 } });
  const cd8 = result.thresholds.find((t) => t.marker === 'CD8');
  assert.equal(cd8.source, 'user');
  assert.equal(cd8.threshold, 0.1);
  assert.equal(result.clusters[4].name, null);
  assert.ok(result.clusters[4].nearest.failing.some((f) => f.marker === 'CD3'));
});

test('marker enrichment (MEM) follows the published formula', () => {
  const a = Float32Array.of(5, 6, 7, 8, 9, 0, 1, 2, 3, 4);
  const b = Float32Array.of(1, 1.5, 2, 2.5, 3, 0, 1, 2, 3, 4);
  const labels = Int32Array.of(0, 0, 0, 0, 0, 1, 1, 1, 1, 1);
  const s = clusterMedians([a, b], labels, 2);
  // A: |7 − 2| + 2/2 − 1 = 5 and its negative; B: 0 + 2/1 − 1 = 1 and 0 + 1/2 − 1 = −0.5 (MAG
  // equal, so the sign is not flipped). Largest |MEM| = 5 → ×2 to reach 10.
  const mem = markerEnrichment(s, ['A', 'B'], { iqrFloor: 0.5 });
  assert.deepEqual(Array.from(mem.raw), [5, 1, -5, -0.5]);
  assert.deepEqual(Array.from(mem.scores), [10, 2, -10, -1]);
  assert.deepEqual(mem.labels, ['A+10 B+2', 'A−10 B−1']);
  // Against all events: median 4.5, IQR 6.75 − 2.25 = 4.5 → |7 − 4.5| + 4.5/2 − 1 = 3.75.
  const all = markerEnrichment(s, ['A', 'B'], { iqrFloor: 0.5, reference: 'all' });
  close(all.raw[0], 3.75, 1e-12);
  // Default floor: median p1–p99 range of the markers (8.82 and 3.82) / 16.
  close(markerEnrichment(s, ['A', 'B']).iqrFloor, (8.82 + 3.82) / 2 / 16, 1e-6);
  // A floor above the IQRs makes the spread term vanish.
  assert.deepEqual(Array.from(markerEnrichment(s, ['A', 'B'], { iqrFloor: 10 }).raw), [5, 0, -5, 0]);
});
