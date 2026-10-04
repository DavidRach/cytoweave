import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import {
  buildMST,
  consensusClustering,
  cutTree,
  defaultRadius,
  dendrogramLayout,
  distanceMatrix,
  findElbow,
  flowsom,
  gridDistances,
  hclust,
  mapToSOM,
  metacluster,
  primMST,
  suggestK,
  trainSOM,
} from './flowsom.js';
import { adjustedRandIndex } from './cluster-summary.js';

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected} (tolerance ${tolerance})`);
}

// Gaussian blobs (sd 0.5), population c bright (5) in marker c only, as cytometry populations
// that each carry one marker: every pair of centers is 5√2 apart.
function blobs({ k, dim, perCluster, seed = 1 }) {
  const random = createRandom(seed);
  const n = k * perCluster;
  const data = new Float32Array(n * dim);
  const truth = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const c = random.int(k);
    truth[i] = c;
    for (let j = 0; j < dim; j += 1) data[i * dim + j] = (j === c ? 5 : 0) + random.gaussian() * 0.5;
  }
  return { data, truth, n, dim };
}

test('grid distances are Chebyshev and the default radius is the 0.67 quantile', () => {
  const d = gridDistances(3, 2);
  // Node 0 at (0,0), node 5 at (2,1): max(2, 1) = 2.
  assert.equal(d[0 * 6 + 5], 2);
  assert.equal(d[1 * 6 + 3], 1);
  // Hand count over all 10⁴ ordered node pairs of a 10 × 10 grid: 6400 have distance ≤ 5 and
  // 7744 ≤ 6, so the type-7 quantile at 0.67 (position 6699.33) is 6. For 5 × 5: 361 ≤ 2, 529 ≤ 3
  // of 625, position 418.08 → 3.
  assert.equal(defaultRadius(10, 10), 6);
  assert.equal(defaultRadius(5, 5), 3);
});

test('SOM updates follow C_SOM: winner-only learning with a linear rate', () => {
  // One event drawn every step; radius < 1 means only the winner moves.
  const som = trainSOM(Float32Array.of(1), 1, 1, {
    xdim: 2, ydim: 1, rlen: 3, alpha: [0.5, 0.1], radius: [0, 0], codes: Float32Array.of(0, 10),
  });
  // alpha_k = 0.5 − 0.4·k/3: 0 → 0.5 → 0.5 + 0.36667·0.5 → … (hand computed)
  const a1 = 0.5 - 0.4 / 3;
  const a2 = 0.5 - 0.8 / 3;
  let c = 0;
  c += 0.5 * (1 - c);
  c += a1 * (1 - c);
  c += a2 * (1 - c);
  close(som.codes[0], c, 1e-6);
  close(som.codes[0], 0.757222, 1e-5);
  assert.equal(som.codes[1], 10);
});

test('SOM neighborhood shrinks linearly and is floored at the winner', () => {
  // Three nodes in a row, radius 2 → 0 over 4 steps: windows 2, 1, 1, then 0.5 (winner only).
  const som = trainSOM(Float32Array.of(-1), 1, 1, {
    xdim: 3, ydim: 1, rlen: 4, alpha: [0.5, 0.5], radius: [2, 0], codes: Float32Array.of(0, 5, 10),
  });
  assert.deepEqual(Array.from(som.codes), [-0.9375, -0.25, 4.5]);
});

test('SOM training is deterministic for a seed', () => {
  const { data, n, dim } = blobs({ k: 4, dim: 5, perCluster: 100, seed: 2 });
  const a = trainSOM(data, n, dim, { xdim: 5, ydim: 5, seed: 9 });
  const b = trainSOM(data, n, dim, { xdim: 5, ydim: 5, seed: 9 });
  const c = trainSOM(data, n, dim, { xdim: 5, ydim: 5, seed: 10 });
  assert.deepEqual(a.codes, b.codes);
  assert.notDeepEqual(a.codes, c.codes);
  assert.equal(a.codes.length, 25 * 5);
});

test('mapping finds the nearest code, as a brute-force search', () => {
  const random = createRandom(4);
  const dim = 6; const nodes = 16; const n = 500;
  const codes = Float32Array.from({ length: nodes * dim }, () => random() * 4);
  const data = Float32Array.from({ length: n * dim }, () => random() * 4);
  const som = { codes, nodes, dim, xdim: 4, ydim: 4 };
  const { mapping, distances } = mapToSOM(som, data, n);
  for (let i = 0; i < n; i += 1) {
    let best = -1; let bestD = Infinity;
    for (let c = 0; c < nodes; c += 1) {
      let s = 0;
      for (let j = 0; j < dim; j += 1) s += (data[i * dim + j] - codes[c * dim + j]) ** 2;
      if (s < bestD) { bestD = s; best = c; }
    }
    assert.equal(mapping[i], best);
    close(distances[i], Math.sqrt(bestD), 1e-5);
  }
});

function kruskalWeight(dist, n) {
  const edges = [];
  for (let a = 0; a < n; a += 1) for (let b = a + 1; b < n; b += 1) edges.push([dist[a * n + b], a, b]);
  edges.sort((x, y) => x[0] - y[0]);
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  let total = 0;
  for (const [w, a, b] of edges) {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) { parent[ra] = rb; total += w; }
  }
  return total;
}

test('the MST spans every node with minimal total weight (vs Kruskal)', () => {
  for (const seed of [1, 2, 3]) {
    const random = createRandom(seed);
    const nodes = 12; const dim = 3;
    const codes = Float32Array.from({ length: nodes * dim }, () => random() * 5);
    const { edges, weights, layout } = buildMST({ codes, nodes, dim });
    assert.equal(edges.length, nodes - 1);
    const parent = Array.from({ length: nodes }, (_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (const [a, b] of edges) parent[find(a)] = find(b);
    assert.equal(new Set(parent.map((_, i) => find(i))).size, 1, 'connected');
    const total = weights.reduce((s, w) => s + w, 0);
    close(total, kruskalWeight(distanceMatrix(codes, nodes, dim), nodes), 1e-9);
    assert.equal(layout.length, nodes * 2);
    assert.ok(layout.every(Number.isFinite));
  }
});

test('the tree layout reproduces path lengths (a chain lies on a line)', () => {
  const nodes = 10;
  const codes = Float32Array.from({ length: nodes }, (_, i) => i);
  const { edges, layout } = buildMST({ codes, nodes, dim: 1 });
  assert.deepEqual(primMST(distanceMatrix(codes, nodes, 1), nodes).edges, edges);
  for (let i = 0; i < nodes; i += 1) {
    for (let j = i + 1; j < nodes; j += 1) {
      close(Math.hypot(layout[2 * i] - layout[2 * j], layout[2 * i + 1] - layout[2 * j + 1]), j - i, 1e-2, `${i}-${j}`);
    }
  }
});

// Five points on a line: 0, 1, 3, 7, 15.
const LINE = Float64Array.of(0, 1, 3, 7, 15);
const lineDist = distanceMatrix(LINE, 5, 1);

test('hierarchical clustering matches hand-computed dendrograms', () => {
  const average = hclust(lineDist, 5, 'average');
  // (0,1) at 1; {0,1}–3 at (3+2)/2; {0,1,3}–7 at (7+6+4)/3; all–15 at (15+14+12+8)/4.
  assert.deepEqual(Array.from(average.heights), [1, 2.5, 17 / 3, 12.25]);
  assert.deepEqual(Array.from(average.merges), [0, 1, 2, 5, 3, 6, 4, 7]);
  assert.deepEqual(Array.from(average.order), [4, 3, 2, 0, 1]);
  assert.deepEqual(Array.from(average.sizes), [2, 3, 4, 5]);
  assert.deepEqual(Array.from(hclust(lineDist, 5, 'complete').heights), [1, 3, 7, 15]);
  assert.deepEqual(Array.from(hclust(lineDist, 5, 'single').heights), [1, 2, 4, 8]);
  // ward.D2 height = √(2·ΔSSE), ΔSSE = nₐn_b/(nₐ+n_b)·‖cₐ − c_b‖².
  const ward = hclust(lineDist, 5, 'ward.D2').heights;
  const expected = [1, Math.sqrt(2 * (2 / 3) * 2.5 ** 2), Math.sqrt(2 * (3 / 4) * (7 - 4 / 3) ** 2), Math.sqrt(2 * (4 / 5) * (15 - 2.75) ** 2)];
  expected.forEach((h, s) => close(ward[s], h, 1e-12, `step ${s}`));
});

test('cutTree numbers groups by first item, as R', () => {
  const tree = hclust(lineDist, 5, 'average');
  assert.deepEqual(Array.from(cutTree(tree, 1)), [0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(cutTree(tree, 2)), [0, 0, 0, 0, 1]);
  assert.deepEqual(Array.from(cutTree(tree, 3)), [0, 0, 0, 1, 2]);
  assert.deepEqual(Array.from(cutTree(tree, 5)), [0, 1, 2, 3, 4]);
  const { x, y } = dendrogramLayout(tree);
  assert.equal(x[4], 0); // leaf 4 is first in the order
  assert.equal(y[5 + 3], 12.25);
  assert.equal(x[5], 3.5); // merge of leaves 0 and 1, at positions 3 and 4
});

// Naive agglomeration from the linkage definitions, recomputing every cluster distance.
function naiveHeights(points, n, dim, linkage) {
  let clusters = Array.from({ length: n }, (_, i) => [i]);
  const d = (a, b) => Math.sqrt(Array.from({ length: dim }, (_, j) => (points[a * dim + j] - points[b * dim + j]) ** 2).reduce((s, v) => s + v, 0));
  const centroid = (c) => Array.from({ length: dim }, (_, j) => c.reduce((s, i) => s + points[i * dim + j], 0) / c.length);
  const linkageDistance = (A, B) => {
    if (linkage === 'ward.D2') {
      const ca = centroid(A); const cb = centroid(B);
      const sq = ca.reduce((s, v, j) => s + (v - cb[j]) ** 2, 0);
      return Math.sqrt((2 * A.length * B.length * sq) / (A.length + B.length));
    }
    const all = A.flatMap((a) => B.map((b) => d(a, b)));
    if (linkage === 'single') return Math.min(...all);
    if (linkage === 'complete') return Math.max(...all);
    return all.reduce((s, v) => s + v, 0) / all.length;
  };
  const heights = [];
  const partitions = [];
  while (clusters.length > 1) {
    let best = [0, 1, Infinity];
    for (let a = 0; a < clusters.length; a += 1) {
      for (let b = a + 1; b < clusters.length; b += 1) {
        const v = linkageDistance(clusters[a], clusters[b]);
        if (v < best[2]) best = [a, b, v];
      }
    }
    heights.push(best[2]);
    const merged = [...clusters[best[0]], ...clusters[best[1]]];
    clusters = clusters.filter((_, i) => i !== best[0] && i !== best[1]).concat([merged]);
    const labels = new Int32Array(n);
    clusters.forEach((c, ci) => c.forEach((i) => { labels[i] = ci; }));
    partitions.push(labels);
  }
  return { heights, partitions };
}

test('hierarchical clustering agrees with a naive agglomeration for every linkage', () => {
  const random = createRandom(5);
  const n = 30; const dim = 3;
  const points = Float64Array.from({ length: n * dim }, () => random() * 10);
  const dist = distanceMatrix(points, n, dim);
  for (const linkage of ['single', 'complete', 'average', 'ward.D2']) {
    const tree = hclust(dist, n, linkage);
    const naive = naiveHeights(points, n, dim, linkage);
    naive.heights.forEach((h, s) => close(tree.heights[s], h, 1e-9, `${linkage} step ${s}`));
    for (const k of [2, 3, 5, 8]) {
      assert.equal(adjustedRandIndex(cutTree(tree, k), naive.partitions[n - k - 1]), 1, `${linkage} k=${k}`);
    }
    assert.deepEqual(Array.from(tree.order).sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i));
  }
});

test('consensus CDF area and PAC on perfectly separated groups match hand values', () => {
  // 30 nodes in 3 coincident groups of 10: consensus is exactly 0 or 1 at k = 3, so the CDF is
  // 300/435 (between-group pairs) up to the last bin and 1 there: area = 0.99·300/435 + 0.01.
  const nodes = 30; const dim = 2;
  const codes = new Float32Array(nodes * dim);
  for (let i = 0; i < nodes; i += 1) codes[i * dim] = Math.floor(i / 10) * 100;
  const cc = consensusClustering(codes, nodes, dim, 3, { ks: [3], reps: 20 });
  assert.deepEqual(Array.from(cc.classes[3]), Array.from({ length: nodes }, (_, i) => Math.floor(i / 10)));
  close(cc.area[0], 0.99 * (300 / 435) + 0.01, 1e-12);
  assert.equal(cc.pac[0], 0);
  assert.equal(cc.delta[0], cc.area[0]);
});

test('FlowSOM findElbow splits a curve into two straight lines', () => {
  assert.equal(findElbow([10, 5, 1, 0.9, 0.8, 0.7]), 3);
  assert.equal(findElbow([100, 60, 20, 10, 9, 8, 7, 6]), 4);
});

test('FlowSOM recovers well-separated blobs (ARI ≥ 0.95 against the truth)', () => {
  for (const [k, seed] of [[5, 1], [6, 2], [8, 3]]) {
    const { data, truth, n, dim } = blobs({ k, dim: 8, perCluster: 600, seed });
    const result = flowsom(data, n, dim, { k, seed: 1 });
    assert.equal(result.labels.length, n);
    assert.equal(result.metaclusters.length, 100);
    assert.equal(result.nodeCounts.reduce((s, c) => s + c, 0), n);
    assert.equal(result.mst.edges.length, 99);
    const ari = adjustedRandIndex(result.labels, truth);
    assert.ok(ari >= 0.95, `k=${k}: ARI ${ari}`);
  }
});

test('FlowSOM is deterministic for a seed', () => {
  const { data, n, dim } = blobs({ k: 4, dim: 6, perCluster: 300, seed: 7 });
  const a = flowsom(data, n, dim, { k: 4, seed: 3, xdim: 6, ydim: 6 });
  const b = flowsom(data, n, dim, { k: 4, seed: 3, xdim: 6, ydim: 6 });
  assert.deepEqual(a.labels, b.labels);
  assert.deepEqual(a.som.codes, b.som.codes);
  assert.deepEqual(a.mst.layout, b.mst.layout);
});

test('suggestK finds the number of blobs from the weighted consensus delta', () => {
  const { data, truth, n, dim } = blobs({ k: 5, dim: 8, perCluster: 600, seed: 1 });
  const result = flowsom(data, n, dim, { k: 'auto', maxK: 12, seed: 1 });
  assert.equal(result.k, 5);
  assert.ok(adjustedRandIndex(result.labels, truth) >= 0.95);
  const s = result.suggestion;
  assert.equal(s.ks.length, 11);
  assert.ok(s.area.every((a) => a >= 0 && a <= 1));
  assert.ok(s.sse.every((v, i) => i === 0 || v <= s.sse[i - 1]));
  // The same diagnostics are available without running FlowSOM again.
  const again = suggestK(result.som.codes, 100, dim, { maxK: 12, seed: 1, weights: result.nodeCounts, method: 'sse' });
  assert.equal(again.k, 5);
});

test('metacluster validates k and supports plain hierarchical metaclustering', () => {
  const codes = Float32Array.of(0, 0.1, 5, 5.1, 10);
  assert.deepEqual(Array.from(metacluster(codes, 5, 1, 3, { method: 'hierarchical' })), [0, 0, 1, 1, 2]);
  assert.deepEqual(Array.from(metacluster(codes, 5, 1, 1)), [0, 0, 0, 0, 0]);
  assert.throws(() => metacluster(codes, 5, 1, 6), /at most 5/);
});

test('clustering explains unusable input', () => {
  assert.throws(() => trainSOM(Float32Array.of(1, Number.NaN), 2, 1, { xdim: 1, ydim: 1 }), /Event 2 has a missing or infinite value/);
  assert.throws(() => trainSOM(new Float32Array(20), 10, 2), /needs at least 100 events/);
  assert.throws(() => hclust(new Float64Array(4), 2, 'centroid'), /Unknown linkage/);
});
