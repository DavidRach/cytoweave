import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import {
  connectedComponents, fuzzySimplicialSet, graphFromEdges, jaccardWeights, knnGraph, leiden, louvain,
  modularity, phenograph, smoothKnnDist, symmetrize,
} from './graph-cluster.js';

// Zachary's karate club (Zachary 1977), 34 members, 78 ties, 0-indexed as in networkx.
const KARATE = [
  [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 10], [0, 11], [0, 12], [0, 13],
  [0, 17], [0, 19], [0, 21], [0, 31], [1, 2], [1, 3], [1, 7], [1, 13], [1, 17], [1, 19], [1, 21], [1, 30],
  [2, 3], [2, 7], [2, 8], [2, 9], [2, 13], [2, 27], [2, 28], [2, 32], [3, 7], [3, 12], [3, 13], [4, 6],
  [4, 10], [5, 6], [5, 10], [5, 16], [6, 16], [8, 30], [8, 32], [8, 33], [9, 33], [13, 33], [14, 32],
  [14, 33], [15, 32], [15, 33], [18, 32], [18, 33], [19, 33], [20, 32], [20, 33], [22, 32], [22, 33],
  [23, 25], [23, 27], [23, 29], [23, 32], [23, 33], [24, 25], [24, 27], [24, 31], [25, 31], [26, 29],
  [26, 33], [27, 33], [28, 31], [28, 33], [29, 32], [29, 33], [30, 32], [30, 33], [31, 32], [31, 33],
  [32, 33],
];

// The modularity-optimal partition (Brandes et al. 2008, Q = 0.4198).
const KARATE_OPTIMUM = [
  [0, 1, 2, 3, 7, 11, 12, 13, 17, 19, 21],
  [4, 5, 6, 10, 16],
  [8, 9, 14, 15, 18, 20, 22, 26, 29, 30, 32, 33],
  [23, 24, 25, 27, 28, 31],
];

function labelsFromGroups(groups, n) {
  const labels = new Int32Array(n);
  groups.forEach((group, c) => group.forEach((v) => { labels[v] = c; }));
  return labels;
}

// Adjusted Rand index (Hubert & Arabie 1985).
function adjustedRand(a, b) {
  const n = a.length;
  const table = new Map();
  const rowSum = new Map();
  const colSum = new Map();
  for (let i = 0; i < n; i += 1) {
    const key = `${a[i]},${b[i]}`;
    table.set(key, (table.get(key) ?? 0) + 1);
    rowSum.set(a[i], (rowSum.get(a[i]) ?? 0) + 1);
    colSum.set(b[i], (colSum.get(b[i]) ?? 0) + 1);
  }
  const c2 = (x) => (x * (x - 1)) / 2;
  let index = 0;
  for (const v of table.values()) index += c2(v);
  let sa = 0;
  let sb = 0;
  for (const v of rowSum.values()) sa += c2(v);
  for (const v of colSum.values()) sb += c2(v);
  const expected = (sa * sb) / c2(n);
  return (index - expected) / ((sa + sb) / 2 - expected);
}

function plantedPartition(blocks, size, pIn, pOut, seed) {
  const random = createRandom(seed);
  const n = blocks * size;
  const edges = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const same = Math.floor(i / size) === Math.floor(j / size);
      if (random() < (same ? pIn : pOut)) edges.push([i, j]);
    }
  }
  return { graph: graphFromEdges(edges, n), truth: Int32Array.from({ length: n }, (_, i) => Math.floor(i / size)) };
}

test('modularity matches hand-computed values', () => {
  // Two triangles joined by one edge: Q = 2 × (6/14 − (7/14)²) = 5/14.
  const graph = graphFromEdges([[0, 1], [1, 2], [0, 2], [3, 4], [4, 5], [3, 5], [2, 3]]);
  assert.ok(Math.abs(modularity(graph, Int32Array.of(0, 0, 0, 1, 1, 1)) - 5 / 14) < 1e-12);
  assert.ok(Math.abs(modularity(graph, new Int32Array(6))) < 1e-12); // one community: Q = 0
  // Resolution γ scales the null-model term: Q_γ = Σ in/2m − γ Σ (tot/2m)².
  assert.ok(Math.abs(modularity(graph, Int32Array.of(0, 0, 0, 1, 1, 1), 2) - (12 / 14 - 2 * 0.5)) < 1e-12);
  // The published optimum of the karate club.
  const karate = graphFromEdges(KARATE);
  assert.equal(karate.n, 34);
  assert.ok(Math.abs(modularity(karate, labelsFromGroups(KARATE_OPTIMUM, 34)) - 0.4198) < 1e-4);
});

test('Leiden reaches the karate-club optimum (Q = 0.4198); Louvain gets close', () => {
  const karate = graphFromEdges(KARATE);
  let bestLouvain = 0;
  let louvainGood = 0;
  for (let seed = 1; seed <= 20; seed += 1) {
    const lv = louvain(karate, { seed });
    const ld = leiden(karate, { seed });
    assert.ok(ld.quality > 0.41978, `Leiden seed ${seed}: ${ld.quality}`);
    assert.equal(ld.communities, 4);
    assert.ok(Math.abs(ld.quality - modularity(karate, ld.labels)) < 1e-12);
    // Louvain is greedy and order-dependent: most visiting orders reach ≥ 0.41.
    if (lv.quality >= 0.41) louvainGood += 1;
    assert.ok(lv.quality > 0.38, `Louvain seed ${seed}: ${lv.quality}`);
    bestLouvain = Math.max(bestLouvain, lv.quality);
  }
  assert.ok(louvainGood >= 16, `${louvainGood} of 20 Louvain runs reached 0.41`);
  assert.ok(bestLouvain > 0.41978, `best Louvain ${bestLouvain}`);
});

test('a planted partition (4 dense blocks, sparse cross links) is recovered exactly', () => {
  const { graph, truth } = plantedPartition(4, 50, 0.3, 0.01, 7);
  for (const method of [louvain, leiden]) {
    const result = method(graph, { seed: 3 });
    assert.equal(result.communities, 4);
    assert.equal(adjustedRand(result.labels, truth), 1);
    // Labels are renumbered by decreasing size.
    for (let c = 1; c < result.sizes.length; c += 1) assert.ok(result.sizes[c] <= result.sizes[c - 1]);
  }
});

test('Leiden communities are connected and results are deterministic for a seed', () => {
  const random = createRandom(12);
  const edges = [];
  const n = 400;
  for (let i = 0; i < n; i += 1) for (let t = 0; t < 3; t += 1) edges.push([i, random.int(n), 0.5 + random()]);
  const graph = graphFromEdges(edges.filter(([i, j]) => i !== j), n);
  const a = leiden(graph, { seed: 5 });
  const b = leiden(graph, { seed: 5 });
  assert.deepEqual(a.labels, b.labels);
  for (let c = 0; c < a.communities; c += 1) {
    const members = [];
    for (let v = 0; v < n; v += 1) if (a.labels[v] === c) members.push(v);
    // BFS inside the community.
    const inside = new Set(members);
    const seen = new Set([members[0]]);
    const queue = [members[0]];
    while (queue.length) {
      const v = queue.pop();
      for (let e = graph.offsets[v]; e < graph.offsets[v + 1]; e += 1) {
        const u = graph.targets[e];
        if (inside.has(u) && !seen.has(u)) {
          seen.add(u);
          queue.push(u);
        }
      }
    }
    assert.equal(seen.size, members.length, `community ${c} is disconnected`);
  }
  // Leiden is at least as good as Louvain here.
  assert.ok(a.quality >= louvain(graph, { seed: 5 }).quality - 0.01);
});

test('a higher resolution gives more, smaller communities', () => {
  const { graph } = plantedPartition(4, 50, 0.3, 0.01, 9);
  const coarse = leiden(graph, { seed: 1, resolution: 0.2 });
  const fine = leiden(graph, { seed: 1, resolution: 4 });
  assert.ok(fine.communities > 4);
  assert.ok(coarse.communities <= 4);
});

test('Jaccard weights follow PhenoGraph (shared / (2k − shared), averaged with the transpose)', () => {
  // N(0) = {1, 2}, N(1) = {0, 2}, N(2) = {0, 1}, N(3) = {0, 1}.
  const indices = Int32Array.of(1, 2, 0, 2, 0, 1, 0, 1);
  const directed = jaccardWeights(indices, 4, 2);
  for (let e = 0; e < 8; e += 1) assert.ok(Math.abs(directed[e] - 1 / 3) < 1e-7);
  const graph = knnGraph({ indices, distances: new Float32Array(8) }, 4, 2);
  const weight = (i, j) => {
    for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e += 1) if (graph.targets[e] === j) return graph.weights[e];
    return 0;
  };
  assert.ok(Math.abs(weight(0, 1) - 1 / 3) < 1e-7);
  assert.ok(Math.abs(weight(1, 2) - 1 / 3) < 1e-7);
  assert.ok(Math.abs(weight(0, 3) - 1 / 6) < 1e-7);
  assert.ok(Math.abs(weight(3, 1) - 1 / 6) < 1e-7);
  assert.equal(weight(2, 3), 0);
  // Undirected: every edge appears in both rows with the same weight.
  for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) assert.equal(weight(i, j), weight(j, i));
});

test('symmetrize combines both directions', () => {
  const indices = Int32Array.of(1, 0, -1, -1);
  const values = Float32Array.of(0.5, 0.2, 0, 0);
  const fuzzy = symmetrize(indices, values, 3, 1, 'fuzzy');
  // w = a + b − ab = 0.5 + 0.2 − 0.1.
  assert.ok(Math.abs(fuzzy.weights[0] - 0.6) < 1e-6);
  assert.equal(fuzzy.offsets[3], 2);
  const sum = symmetrize(Int32Array.of(1, 2, -1), Float32Array.of(1, 2, 0), 3, 1, 'sum');
  assert.deepEqual(Array.from(sum.offsets), [0, 1, 3, 4]);
});

test('smooth kNN distances reach log2(k) and fuzzy weights are 1 at the nearest neighbor', () => {
  const random = createRandom(4);
  const n = 50;
  const k = 15;
  const distances = new Float32Array(n * k);
  for (let i = 0; i < n; i += 1) {
    const row = Array.from({ length: k - 1 }, () => 0.5 + random() * 3).sort((a, b) => a - b);
    distances.set([0, ...row], i * k);
  }
  const { sigmas, rhos } = smoothKnnDist(distances, n, k);
  for (let i = 0; i < n; i += 1) {
    assert.equal(rhos[i], distances[i * k + 1]);
    let psum = 0;
    for (let t = 1; t < k; t += 1) psum += Math.exp(-Math.max(0, distances[i * k + t] - rhos[i]) / sigmas[i]);
    assert.ok(Math.abs(psum - Math.log2(k)) < 1e-4);
  }
  const knnResult = { indices: new Int32Array(n * (k - 1)), distances: new Float32Array(n * (k - 1)) };
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k - 1; t += 1) {
      knnResult.indices[i * (k - 1) + t] = (i + t + 1) % n;
      knnResult.distances[i * (k - 1) + t] = distances[i * k + t + 1];
    }
  }
  const graph = fuzzySimplicialSet(knnResult, n);
  for (let e = 0; e < graph.weights.length; e += 1) assert.ok(graph.weights[e] > 0 && graph.weights[e] <= 1 + 1e-6);
  assert.equal(connectedComponents(graph).count, 1);
});

test('PhenoGraph recovers well-separated populations', () => {
  const random = createRandom(17);
  const n = 900;
  const dim = 10;
  const centers = Array.from({ length: 3 }, () => Array.from({ length: dim }, () => random.gaussian() * 5));
  const data = new Float32Array(n * dim);
  const truth = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    truth[i] = i % 3;
    for (let t = 0; t < dim; t += 1) data[i * dim + t] = centers[truth[i]][t] + random.gaussian() * 0.6;
  }
  const result = phenograph(data, n, dim, { k: 30, seed: 2, resolution: 0.5 });
  assert.equal(result.k, 30);
  assert.ok(adjustedRand(result.labels, truth) > 0.99, `ARI ${adjustedRand(result.labels, truth)}`);
});
