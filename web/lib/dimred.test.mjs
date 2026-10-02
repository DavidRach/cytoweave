import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import { exactKnn, kdTreeKnn } from './knn.js';
import { graphFromEdges } from './graph-cluster.js';
import { symmetricEigen } from './linalg.js';
import {
  findAbParams, pca, pcaTransform, spectralEmbedding, transformUmap, tsne, tsneAffinities, umap,
} from './dimred.js';

// Well-separated Gaussian clusters in `dim` dimensions; centres are shared between calls with the
// same centreSeed so new samples can be drawn from the same populations.
function clusters(n, dim, count, seed, centreSeed = 100, spread = 1, separation = 5) {
  const rc = createRandom(centreSeed);
  const centres = Array.from({ length: count }, () => Float64Array.from({ length: dim }, () => rc.gaussian() * separation));
  const random = createRandom(seed);
  const data = new Float32Array(n * dim);
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const c = i % count;
    labels[i] = c;
    for (let t = 0; t < dim; t += 1) data[i * dim + t] = centres[c][t] + spread * random.gaussian();
  }
  return { data, labels };
}

// Leave-one-out kNN classification accuracy in an embedding (majority of k neighbours).
function knnAccuracy(embedding, n, labels, k = 10) {
  const { indices } = kdTreeKnn(embedding, n, 2, k);
  let correct = 0;
  for (let i = 0; i < n; i += 1) {
    const votes = new Map();
    for (let t = 0; t < k; t += 1) {
      const l = labels[indices[i * k + t]];
      votes.set(l, (votes.get(l) ?? 0) + 1);
    }
    let best = -1;
    let bestVotes = -1;
    for (const [l, v] of votes) if (v > bestVotes) [best, bestVotes] = [l, v];
    if (best === labels[i]) correct += 1;
  }
  return correct / n;
}

test('PCA of a hand-computed example', () => {
  // Points (±1, 0) and (0, ±2): variances 2/3 and 8/3 (n − 1 = 3), no covariance.
  const result = pca(Float32Array.of(1, 0, -1, 0, 0, 2, 0, -2), 4, 2, { components: 2 });
  assert.ok(Math.abs(result.explainedVariance[0] - 8 / 3) < 1e-12);
  assert.ok(Math.abs(result.explainedVariance[1] - 2 / 3) < 1e-12);
  assert.ok(Math.abs(result.explainedVarianceRatio[0] - 0.8) < 1e-12);
  assert.deepEqual(Array.from(result.loadings, (v) => Math.round(v * 1e9) / 1e9), [0, 1, 1, 0]);
  assert.deepEqual(Array.from(result.scores), [0, 1, 0, -1, 2, 0, -2, 0]);
});

test('PCA recovers the eigenvalues and axes of a known covariance', () => {
  const dim = 4;
  const random = createRandom(7);
  // A random orthogonal basis Q (Gram–Schmidt) and variances 9, 4, 1, 0.25.
  const Q = [];
  while (Q.length < dim) {
    const v = Array.from({ length: dim }, () => random.gaussian());
    for (const q of Q) {
      const dot = v.reduce((s, x, t) => s + x * q[t], 0);
      for (let t = 0; t < dim; t += 1) v[t] -= dot * q[t];
    }
    const norm = Math.hypot(...v);
    Q.push(v.map((x) => x / norm));
  }
  const variances = [9, 4, 1, 0.25];
  const n = 40000;
  const data = new Float32Array(n * dim);
  for (let i = 0; i < n; i += 1) {
    const z = variances.map((v) => Math.sqrt(v) * random.gaussian());
    for (let t = 0; t < dim; t += 1) data[i * dim + t] = 3 + z.reduce((s, zc, c) => s + zc * Q[c][t], 0);
  }
  const result = pca(data, n, dim, { components: 4 });
  for (let c = 0; c < dim; c += 1) {
    // Sampling SD of a variance estimate is v·√(2/n) ≈ 0.7 %; allow 4 %.
    assert.ok(Math.abs(result.explainedVariance[c] / variances[c] - 1) < 0.04, `λ${c + 1} = ${result.explainedVariance[c]}`);
    const dot = Q[c].reduce((s, x, t) => s + x * result.loadings[c * dim + t], 0);
    assert.ok(Math.abs(Math.abs(dot) - 1) < 0.01, `axis ${c + 1}: |cos| = ${Math.abs(dot)}`);
  }
  for (let t = 0; t < dim; t += 1) assert.ok(Math.abs(result.mean[t] - 3) < 0.05);
  // Scores have the eigenvalues as variances and are uncorrelated.
  let v0 = 0;
  let c01 = 0;
  for (let i = 0; i < n; i += 1) {
    v0 += result.scores[i * 4] ** 2;
    c01 += result.scores[i * 4] * result.scores[i * 4 + 1];
  }
  assert.ok(Math.abs(v0 / (n - 1) / result.explainedVariance[0] - 1) < 1e-4);
  assert.ok(Math.abs(c01 / (n - 1)) < 1e-3);
  // Projecting the same data reproduces the scores.
  const again = pcaTransform(result, data.subarray(0, 40), 10);
  for (let e = 0; e < 40; e += 1) assert.ok(Math.abs(again[e] - result.scores[e]) < 1e-4);
});

test('find_ab_params matches umap-learn (min_dist 0.1, spread 1 → a ≈ 1.577, b ≈ 0.8951)', () => {
  const { a, b } = findAbParams(1, 0.1);
  assert.ok(Math.abs(a - 1.5769434603113077) < 1e-3, `a = ${a}`);
  assert.ok(Math.abs(b - 0.8950608779109733) < 1e-4, `b = ${b}`);
  // Any setting: the fitted curve stays close to the target membership.
  const fit = findAbParams(2, 0.5);
  let worst = 0;
  for (let x = 0; x <= 6; x += 0.05) {
    const target = x < 0.5 ? 1 : Math.exp(-(x - 0.5) / 2);
    worst = Math.max(worst, Math.abs(1 / (1 + fit.a * x ** (2 * fit.b)) - target));
  }
  assert.ok(worst < 0.12, `worst deviation ${worst}`);
});

test('t-SNE affinities are symmetric, sum to 1 and reach the perplexity', () => {
  const { data } = clusters(300, 5, 3, 1);
  const k = 30;
  const neighbours = exactKnn(data, 300, 5, k);
  const P = tsneAffinities(neighbours, 300, k, 10);
  let total = 0;
  const lookup = new Map();
  for (let i = 0; i < 300; i += 1) {
    for (let e = P.offsets[i]; e < P.offsets[i + 1]; e += 1) {
      total += P.weights[e];
      lookup.set(i * 300 + P.targets[e], P.weights[e]);
    }
  }
  assert.ok(Math.abs(total - 1) < 1e-5);
  for (const [key, value] of lookup) {
    const i = Math.floor(key / 300);
    const j = key % 300;
    assert.ok(Math.abs(lookup.get(j * 300 + i) - value) < 1e-9);
  }
  // Equidistant neighbours give uniform conditional probabilities: P_ij = 2/(k·2n) when mutual.
  const ring = { indices: new Int32Array(4 * 3), distances: new Float32Array(4 * 3).fill(1) };
  for (let i = 0; i < 4; i += 1) for (let t = 0; t < 3; t += 1) ring.indices[i * 3 + t] = (i + t + 1) % 4;
  const uniform = tsneAffinities(ring, 4, 3, 2);
  for (let e = 0; e < uniform.weights.length; e += 1) assert.ok(Math.abs(uniform.weights[e] - 1 / 12) < 1e-6);
});

test('the Barnes-Hut gradient equals the exact t-SNE gradient at θ = 0 and is close at θ = 0.5', () => {
  const n = 200;
  const dim = 4;
  const { data } = clusters(n, dim, 3, 8);
  const k = 30;
  const neighbours = exactKnn(data, n, dim, k);
  const P = tsneAffinities(neighbours, n, k, 10);
  const random = createRandom(1);
  const Y0 = Float64Array.from({ length: 2 * n }, () => random.gaussian());
  // Centre the start: t-SNE re-centres after each step, and the exact gradient sums to zero.
  for (let d = 0; d < 2; d += 1) {
    let mean = 0;
    for (let i = 0; i < n; i += 1) mean += Y0[2 * i + d] / n;
    for (let i = 0; i < n; i += 1) Y0[2 * i + d] -= mean;
  }
  // Exact gradient (bhtsne convention, no factor 4): Σ_j (p_ij − q_ij) q̃_ij (y_i − y_j)·Z/Z.
  const pij = new Map();
  for (let i = 0; i < n; i += 1) for (let e = P.offsets[i]; e < P.offsets[i + 1]; e += 1) pij.set(i * n + P.targets[e], P.weights[e]);
  let Z = 0;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) if (i !== j) Z += 1 / (1 + (Y0[2 * i] - Y0[2 * j]) ** 2 + (Y0[2 * i + 1] - Y0[2 * j + 1]) ** 2);
  const exact = new Float64Array(2 * n);
  let kl = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const dx = Y0[2 * i] - Y0[2 * j];
      const dy = Y0[2 * i + 1] - Y0[2 * j + 1];
      const q = 1 / (1 + dx * dx + dy * dy);
      const p = pij.get(i * n + j) ?? 0;
      exact[2 * i] += (p - q / Z) * q * dx;
      exact[2 * i + 1] += (p - q / Z) * q * dy;
      if (p > 0) kl += p * Math.log(p / (q / Z));
    }
  }
  // One iteration without exaggeration or momentum moves Y by −η·1.2·gradient (gains 1 → 1.2).
  const step = (theta) => {
    const result = tsne(data, n, dim, {
      knn: neighbours, perplexity: 10, init: Float32Array.from(Y0), maxIterations: 1, earlyExaggerationIterations: 0,
      learningRate: 1, finalMomentum: 0, theta,
    });
    return Float64Array.from({ length: 2 * n }, (_, c) => (Y0[c] - result.embedding[c]) / 1.2);
  };
  const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  const diff = (a, b) => norm(a.map((x, c) => x - b[c]));
  // Float32 output limits the agreement to about 1e-7 of the coordinates.
  assert.ok(diff(step(0), exact) / norm(exact) < 1e-4, `θ = 0: ${diff(step(0), exact) / norm(exact)}`);
  assert.ok(diff(step(0.5), exact) / norm(exact) < 0.05, `θ = 0.5: ${diff(step(0.5), exact) / norm(exact)}`);
  assert.ok(kl > 0);
});

test('t-SNE separates well-separated Gaussian clusters in 10-D', () => {
  const n = 800;
  const { data, labels } = clusters(n, 10, 4, 3);
  const result = tsne(data, n, 10, { seed: 1, perplexity: 30 });
  assert.equal(result.embedding.length, 2 * n);
  assert.ok(knnAccuracy(result.embedding, n, labels) >= 0.95);
  assert.ok(result.klHistory[0][1] > result.kl, 'KL decreases');
  assert.ok(result.kl > 0 && result.kl < 3);
  assert.equal(result.learningRate, Math.max(n / 12, 50));
  const again = tsne(data, n, 10, { seed: 1, maxIterations: 50 });
  const third = tsne(data, n, 10, { seed: 1, maxIterations: 50 });
  assert.deepEqual(again.embedding, third.embedding);
});

test('opt-SNE stopping ends exaggeration and the run early', () => {
  const n = 600;
  const { data, labels } = clusters(n, 10, 3, 5);
  const result = tsne(data, n, 10, { seed: 2, optSNE: true, maxIterations: 1000 });
  assert.ok(result.earlyExaggerationIterations < 500);
  assert.ok(result.iterations < 1000);
  assert.ok(knnAccuracy(result.embedding, n, labels) >= 0.95);
});

test('spectral embedding of a cycle finds the Laplacian eigenvectors (a circle)', () => {
  const n = 64;
  const edges = Array.from({ length: n }, (_, i) => [i, (i + 1) % n]);
  const result = spectralEmbedding(graphFromEdges(edges), 2, { seed: 3, maxIterations: 200 });
  assert.ok(result.converged);
  const expected = 1 - Math.cos((2 * Math.PI) / n);
  for (const value of result.eigenvalues) assert.ok(Math.abs(value - expected) < 1e-6, `${value} vs ${expected}`);
  // cos/sin pair: every node at the same radius.
  const radii = Array.from({ length: n }, (_, i) => Math.hypot(result.embedding[2 * i], result.embedding[2 * i + 1]));
  const mean = radii.reduce((s, r) => s + r, 0) / n;
  for (const r of radii) assert.ok(Math.abs(r / mean - 1) < 1e-3);
  // Disconnected graphs are left to the caller (UMAP falls back to PCA).
  assert.equal(spectralEmbedding(graphFromEdges([[0, 1], [1, 2], [3, 4], [4, 5]]), 2), null);
});

test('spectral embedding agrees with a dense eigen-decomposition', () => {
  const random = createRandom(9);
  const n = 120;
  const pts = Array.from({ length: n }, () => [random(), random()]);
  const edges = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      if (d < 0.25) edges.push([i, j, Math.exp(-d * 10)]);
    }
  }
  const graph = graphFromEdges(edges, n);
  const result = spectralEmbedding(graph, 2, { seed: 1, maxIterations: 300, tolerance: 1e-7 });
  assert.ok(result);
  // Dense normalised Laplacian.
  const deg = new Float64Array(n);
  for (let i = 0; i < n; i += 1) for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e += 1) deg[i] += graph.weights[e];
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    L[i * n + i] = 1;
    for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e += 1) {
      const j = graph.targets[e];
      L[i * n + j] -= graph.weights[e] / Math.sqrt(deg[i] * deg[j]);
    }
  }
  const { values } = symmetricEigen(L, n);
  const smallest = Array.from(values).sort((a, b) => a - b);
  assert.ok(Math.abs(smallest[0]) < 1e-9);
  assert.ok(Math.abs(result.eigenvalues[0] - smallest[1]) < 1e-6);
  assert.ok(Math.abs(result.eigenvalues[1] - smallest[2]) < 1e-6);
});

test('UMAP separates well-separated Gaussian clusters in 10-D and is deterministic', () => {
  const n = 800;
  const { data, labels } = clusters(n, 10, 4, 3);
  const result = umap(data, n, 10, { seed: 4 });
  assert.equal(result.embedding.length, 2 * n);
  assert.equal(result.nEpochs, 500);
  assert.ok(Math.abs(result.a - 1.577) < 1e-3 && Math.abs(result.b - 0.8951) < 1e-3);
  assert.ok(knnAccuracy(result.embedding, n, labels) >= 0.95);
  const again = umap(data, n, 10, { seed: 4, nEpochs: 30 });
  const third = umap(data, n, 10, { seed: 4, nEpochs: 30 });
  assert.deepEqual(again.embedding, third.embedding);
});

test('UMAP uses the spectral layout on a connected graph', () => {
  const n = 600;
  // One elongated cloud: the neighbour graph is connected.
  const random = createRandom(2);
  const data = new Float32Array(n * 5);
  for (let i = 0; i < n; i += 1) {
    data[i * 5] = (i / n) * 20;
    for (let t = 1; t < 5; t += 1) data[i * 5 + t] = random.gaussian() * 0.5;
  }
  const result = umap(data, n, 5, { seed: 1, nEpochs: 50 });
  assert.equal(result.init, 'spectral');
  // The layout keeps the order along the cloud: first and last tenths stay far apart.
  let maxSpan = 0;
  for (let i = 0; i < n; i += 1) maxSpan = Math.max(maxSpan, Math.hypot(result.embedding[2 * i] - result.embedding[0], result.embedding[2 * i + 1] - result.embedding[1]));
  const endGap = Math.hypot(result.embedding[2 * (n - 1)] - result.embedding[0], result.embedding[2 * (n - 1) + 1] - result.embedding[1]);
  assert.ok(endGap > 0.5 * maxSpan);
});

test('transformUmap places new events of known populations in their islands', () => {
  const n = 900;
  const { data, labels } = clusters(n, 8, 3, 6, 200);
  const fitted = umap(data, n, 8, { seed: 5, nEpochs: 200 });
  const before = fitted.model.embedding.slice();
  const m = 150;
  const fresh = clusters(m, 8, 3, 77, 200);
  const placed = transformUmap(fitted.model, fresh.data, m);
  assert.equal(placed.embedding.length, 2 * m);
  assert.deepEqual(fitted.model.embedding, before, 'reference embedding unchanged');
  // Nearest reference event in the embedding should carry the new event's population.
  let correct = 0;
  for (let i = 0; i < m; i += 1) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < n; j += 1) {
      const d = (placed.embedding[2 * i] - before[2 * j]) ** 2 + (placed.embedding[2 * i + 1] - before[2 * j + 1]) ** 2;
      if (d < bestD) [best, bestD] = [j, d];
    }
    if (labels[best] === fresh.labels[i]) correct += 1;
  }
  assert.ok(correct / m >= 0.95, `placed correctly: ${correct / m}`);
});

test('long runs report progress and stop when cancelled', () => {
  const { data } = clusters(400, 6, 2, 1);
  const seen = [];
  umap(data, 400, 6, { nEpochs: 20, onProgress: (f) => seen.push(f) });
  assert.ok(seen.length > 3 && seen.every((f) => f >= 0 && f <= 1));
  assert.ok(Math.abs(seen[seen.length - 1] - 1) < 1e-9);
  const signal = { aborted: false };
  let calls = 0;
  assert.throws(() => tsne(data, 400, 6, {
    signal,
    onProgress: () => {
      calls += 1;
      if (calls > 2) signal.aborted = true;
    },
  }), (error) => error.name === 'AbortError');
});
