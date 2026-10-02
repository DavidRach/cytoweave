import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import { assignToCenters, kmeans, kmeansPlusPlus } from './kmeans.js';
import { adjustedRandIndex } from './cluster-summary.js';

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected} (tolerance ${tolerance})`);
}

function blobs({ k, dim, perCluster, sd = 0.5, seed = 1 }) {
  const random = createRandom(seed);
  const n = k * perCluster;
  const data = new Float32Array(n * dim);
  const truth = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const c = random.int(k);
    truth[i] = c;
    for (let j = 0; j < dim; j += 1) data[i * dim + j] = (j === c % dim ? 5 : 0) + (c >= dim && j === (c + 1) % dim ? 5 : 0) + random.gaussian() * sd;
  }
  return { data, truth, n, dim };
}

test('k-means on tiny sets matches hand-computed centres and inertia', () => {
  // 1, 2, 3 | 10, 11, 12: centres 2 and 11, inertia 2 + 2.
  const line = kmeans(Float32Array.of(1, 2, 3, 10, 11, 12), 6, 1, 2);
  assert.equal(line.inertia, 4);
  assert.deepEqual(Array.from(line.centers).sort((a, b) => a - b), [2, 11]);
  assert.equal(line.labels[0], line.labels[2]);
  assert.notEqual(line.labels[0], line.labels[3]);
  assert.deepEqual(Array.from(line.counts), [3, 3]);
  // A 10 × 1 rectangle's corners: centres (0, 0.5) and (10, 0.5), inertia 4 × 0.25.
  const square = kmeans(Float32Array.of(0, 0, 0, 1, 10, 0, 10, 1), 4, 2, 2);
  assert.equal(square.inertia, 1);
  assert.ok(square.converged);
});

test('k-means recovers blobs', () => {
  const { data, truth, n, dim } = blobs({ k: 6, dim: 8, perCluster: 400, seed: 2 });
  const result = kmeans(data, n, dim, 6, { seed: 5 });
  assert.equal(adjustedRandIndex(result.labels, truth), 1);
  // Inertia is the sum of squared distances to the reported centres.
  let inertia = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < dim; j += 1) inertia += (data[i * dim + j] - result.centers[result.labels[i] * dim + j]) ** 2;
  }
  close(result.inertia, inertia, 1e-6 * inertia);
  // ≈ n × dim × σ² for well-separated clusters.
  close(result.inertia / (n * dim), 0.25, 0.02);
  assert.deepEqual(assignToCenters(data, n, dim, result.centers, 6), result.labels);
});

test('Hamerly acceleration gives exactly the Lloyd iterations', () => {
  // Overlapping clusters need many iterations, which exercises the bounds.
  const random = createRandom(11);
  const n = 3000; const dim = 4;
  const data = Float32Array.from({ length: n * dim }, () => random.gaussian() + (random() < 0.5 ? 1 : 0));
  for (const seed of [1, 2, 3]) {
    const fast = kmeans(data, n, dim, 7, { seed, nInit: 2 });
    const plain = kmeans(data, n, dim, 7, { seed, nInit: 2, algorithm: 'lloyd' });
    assert.deepEqual(fast.labels, plain.labels);
    assert.deepEqual(fast.centers, plain.centers);
    assert.equal(fast.iterations, plain.iterations);
    close(fast.inertia, plain.inertia, 1e-9 * plain.inertia);
    assert.ok(fast.iterations > 3, `iterations ${fast.iterations}`);
  }
});

test('k-means is deterministic for a seed and keeps the best restart', () => {
  const random = createRandom(3);
  const n = 1000; const dim = 3;
  const data = Float32Array.from({ length: n * dim }, () => random() * 10);
  const a = kmeans(data, n, dim, 5, { seed: 4 });
  const b = kmeans(data, n, dim, 5, { seed: 4 });
  assert.deepEqual(a.labels, b.labels);
  assert.equal(a.inertia, b.inertia);
  // The first of five restarts is the single run with the same seed; the best is kept.
  const single = kmeans(data, n, dim, 5, { seed: 1, nInit: 1 });
  const many = kmeans(data, n, dim, 5, { seed: 1, nInit: 5 });
  assert.ok(many.inertia <= single.inertia);
});

test('mini-batch k-means recovers blobs', () => {
  const { data, truth, n, dim } = blobs({ k: 5, dim: 6, perCluster: 4000, seed: 4 });
  const result = kmeans(data, n, dim, 5, { algorithm: 'minibatch', batchSize: 256, seed: 2 });
  assert.ok(adjustedRandIndex(result.labels, truth) >= 0.99);
  assert.ok(result.iterations < (100 * n) / 256, 'stopped early');
});

test('k-means++ spreads the seeds over distinct points', () => {
  const data = Float32Array.of(0, 0, 10, 0, 0, 10, 10, 10);
  const centers = kmeansPlusPlus(data, 4, 2, 4, createRandom(1));
  const seen = new Set();
  for (let c = 0; c < 4; c += 1) seen.add(`${centers[2 * c]},${centers[2 * c + 1]}`);
  assert.equal(seen.size, 4);
  assert.equal(kmeans(data, 4, 2, 4).inertia, 0);
});

test('k-means copes with fewer distinct events than clusters', () => {
  const data = new Float32Array(30);
  for (let i = 0; i < 30; i += 1) data[i] = i % 3;
  const result = kmeans(data, 30, 1, 4, { seed: 2 });
  assert.equal(result.inertia, 0);
  assert.ok(result.labels.every((c) => c >= 0 && c < 4));
});

test('k-means explains unusable input', () => {
  assert.throws(() => kmeans(new Float32Array(4), 2, 2, 3), /Cannot make 3 clusters from 2 events/);
  assert.throws(() => kmeans(Float32Array.of(1, Infinity), 2, 1, 1), /missing or infinite/);
  assert.throws(() => kmeans(new Float32Array(4), 4, 1, 2, { algorithm: 'elkan' }), /Unknown k-means algorithm/);
});
