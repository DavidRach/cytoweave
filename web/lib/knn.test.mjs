import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import {
  approximateKnn, createKnnIndex, exactKnn, kdTreeKnn, knn, knnRecall, prepareMatrix, queryKnn,
} from './knn.js';

// Clustered data resembling transformed cytometry: Gaussian blobs with unequal spreads.
function blobs(n, dim, clusters, seed, separation = 6) {
  const random = createRandom(seed);
  const centres = Array.from({ length: clusters }, () => Float64Array.from({ length: dim }, () => random.gaussian() * separation));
  const spreads = Array.from({ length: clusters }, () => Float64Array.from({ length: dim }, () => 0.3 + random()));
  const data = new Float32Array(n * dim);
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const c = random.int(clusters);
    labels[i] = c;
    for (let t = 0; t < dim; t += 1) data[i * dim + t] = centres[c][t] + spreads[c][t] * random.gaussian();
  }
  return { data, labels };
}

// Reference: sort all distances (independent of the heap code).
function naiveKnn(data, n, dim, k, metric = 'euclidean') {
  const indices = new Int32Array(n * k);
  const distances = new Float64Array(n * k);
  for (let i = 0; i < n; i += 1) {
    const row = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      let d;
      if (metric === 'cosine') {
        let dot = 0; let na = 0; let nb = 0;
        for (let t = 0; t < dim; t += 1) {
          dot += data[i * dim + t] * data[j * dim + t];
          na += data[i * dim + t] ** 2;
          nb += data[j * dim + t] ** 2;
        }
        d = 1 - dot / Math.sqrt(na * nb);
      } else {
        d = 0;
        for (let t = 0; t < dim; t += 1) d += (data[i * dim + t] - data[j * dim + t]) ** 2;
        d = Math.sqrt(d);
      }
      row.push([d, j]);
    }
    row.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let t = 0; t < k; t += 1) {
      distances[i * k + t] = row[t][0];
      indices[i * k + t] = row[t][1];
    }
  }
  return { indices, distances };
}

test('exact kNN matches a full sort, excludes the point itself and sorts by distance', () => {
  const n = 150;
  const dim = 5;
  const k = 7;
  const random = createRandom(3);
  const data = Float32Array.from({ length: n * dim }, () => random.gaussian());
  const result = exactKnn(data, n, dim, k);
  const reference = naiveKnn(data, n, dim, k);
  assert.deepEqual(Array.from(result.indices), Array.from(reference.indices));
  for (let e = 0; e < n * k; e += 1) assert.ok(Math.abs(result.distances[e] - reference.distances[e]) < 1e-5);
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) assert.notEqual(result.indices[i * k + t], i);
    for (let t = 1; t < k; t += 1) assert.ok(result.distances[i * k + t] >= result.distances[i * k + t - 1]);
  }
});

test('cosine distance is 1 − cos θ', () => {
  const n = 80;
  const dim = 4;
  const k = 5;
  const random = createRandom(9);
  const data = Float32Array.from({ length: n * dim }, () => random.gaussian() + 0.5);
  const result = exactKnn(data, n, dim, k, { metric: 'cosine' });
  const reference = naiveKnn(data, n, dim, k, 'cosine');
  assert.deepEqual(Array.from(result.indices), Array.from(reference.indices));
  for (let e = 0; e < n * k; e += 1) assert.ok(Math.abs(result.distances[e] - reference.distances[e]) < 1e-5);
  // Hand check: (1, 0) and (1, 1) are 45° apart.
  const pair = exactKnn(Float32Array.of(1, 0, 1, 1, -1, 0), 3, 2, 1, { metric: 'cosine' });
  assert.equal(pair.indices[0], 1);
  assert.ok(Math.abs(pair.distances[0] - (1 - Math.SQRT1_2)) < 1e-6);
});

test('k-d tree search is exact in 2-D, including duplicate points', () => {
  const n = 2000;
  const random = createRandom(5);
  const data = new Float32Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    // Dense clumps, a grid of exact duplicates and scattered points.
    if (i % 10 === 0) {
      data[2 * i] = Math.floor(i / 100);
      data[2 * i + 1] = 3;
    } else {
      data[2 * i] = (i % 3) * 20 + random.gaussian() * (i % 7 === 0 ? 5 : 0.3);
      data[2 * i + 1] = random.gaussian();
    }
  }
  const k = 12;
  const tree = kdTreeKnn(data, n, 2, k);
  const brute = exactKnn(data, n, 2, k);
  for (let e = 0; e < n * k; e += 1) assert.ok(Math.abs(tree.distances[e] - brute.distances[e]) < 1e-6, `row ${Math.floor(e / k)}`);
  // Equal distances may be listed in either order, so check each reported neighbour's distance.
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) {
      const j = tree.indices[i * k + t];
      assert.notEqual(j, i);
      const d = Math.hypot(data[2 * i] - data[2 * j], data[2 * i + 1] - data[2 * j + 1]);
      assert.ok(Math.abs(d - tree.distances[i * k + t]) < 1e-6);
    }
  }
});

test('NN-Descent reaches recall ≥ 0.9 on 5000 clustered points in 25 dimensions', () => {
  const n = 5000;
  const dim = 25;
  const k = 15;
  const { data } = blobs(n, dim, 10, 21);
  const truth = exactKnn(data, n, dim, k);
  const approx = approximateKnn(data, n, dim, k, { seed: 1 });
  const recall = knnRecall(approx.indices, truth.indices, n, k);
  assert.ok(recall >= 0.9, `recall ${recall}`);
  // Reported distances are true distances of the reported neighbours, sorted.
  for (let i = 0; i < n; i += 97) {
    for (let t = 0; t < k; t += 1) {
      const j = approx.indices[i * k + t];
      let d = 0;
      for (let u = 0; u < dim; u += 1) d += (data[i * dim + u] - data[j * dim + u]) ** 2;
      assert.ok(Math.abs(Math.sqrt(d) - approx.distances[i * k + t]) < 1e-4);
      assert.notEqual(j, i);
      if (t) assert.ok(approx.distances[i * k + t] >= approx.distances[i * k + t - 1]);
    }
  }
});

test('NN-Descent also handles unstructured (single Gaussian) data and cosine distance', () => {
  const n = 3000;
  const dim = 20;
  const k = 10;
  const { data } = blobs(n, dim, 1, 4);
  const truth = exactKnn(data, n, dim, k);
  const approx = approximateKnn(data, n, dim, k, { seed: 2 });
  assert.ok(knnRecall(approx.indices, truth.indices, n, k) >= 0.9);
  const truthCos = exactKnn(data, n, dim, k, { metric: 'cosine' });
  const approxCos = approximateKnn(data, n, dim, k, { seed: 2, metric: 'cosine' });
  assert.ok(knnRecall(approxCos.indices, truthCos.indices, n, k) >= 0.9);
});

test('approximate kNN is deterministic for a seed', () => {
  const { data } = blobs(1500, 12, 4, 8);
  const a = approximateKnn(data, 1500, 12, 10, { seed: 11 });
  const b = approximateKnn(data, 1500, 12, 10, { seed: 11 });
  assert.deepEqual(a.indices, b.indices);
  assert.deepEqual(a.distances, b.distances);
});

test('knn chooses a method by size and dimension', () => {
  const { data } = blobs(300, 2, 3, 2);
  const auto = knn(data, 300, 2, 5);
  const exact = exactKnn(data, 300, 2, 5);
  for (let e = 0; e < 300 * 5; e += 1) assert.ok(Math.abs(auto.distances[e] - exact.distances[e]) < 1e-6);
  assert.throws(() => knn(data, 300, 2, 300), /neighbours/);
});

test('queryKnn places new points against the reference with recall ≥ 0.9', () => {
  const n = 4000;
  const dim = 15;
  const k = 15;
  const { data } = blobs(n + 500, dim, 8, 31);
  const reference = data.subarray(0, n * dim);
  const queries = data.slice(n * dim);
  const index = createKnnIndex(reference, n, dim, 15, { seed: 3, method: 'approximate' });
  const found = queryKnn(index, queries, 500, k, { method: 'graph' });
  // Truth by brute force against the reference.
  const truth = queryKnn(index, queries, 500, k, { method: 'exact' });
  const recall = knnRecall(found.indices, truth.indices, 500, k);
  assert.ok(recall >= 0.9, `recall ${recall}`);
  // The t-th distance of any k points is at least the t-th smallest distance.
  for (let e = 0; e < 500 * k; e += 1) assert.ok(found.distances[e] >= truth.distances[e] - 1e-5);
  // A reference point queried against its own set finds itself at distance 0.
  const self = queryKnn(index, reference.subarray(0, dim * 3), 3, 1, { method: 'graph' });
  assert.deepEqual(Array.from(self.indices), [0, 1, 2]);
  assert.equal(self.distances[0], 0);
});

test('non-finite values and bad shapes are rejected with readable errors', () => {
  assert.throws(() => prepareMatrix(Float32Array.of(1, Number.NaN, 2, 3), 2, 2), /Event 1 has a missing/);
  assert.throws(() => exactKnn(new Float32Array(5), 3, 2, 1), /Expected 3 events/);
  assert.throws(() => exactKnn(new Float32Array(6), 3, 2, 1, { metric: 'manhattan' }), /Unknown distance/);
});
