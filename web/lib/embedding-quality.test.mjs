import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import {
  assessEmbedding, knnPreservation, lisi, mixingEntropy, procrustes, regionReliability, seedStability, trustworthiness,
} from './embedding-quality.js';

function gaussianMatrix(n, dim, seed, scale = 1) {
  const random = createRandom(seed);
  return Float32Array.from({ length: n * dim }, () => random.gaussian() * scale);
}

// Blobs in `dim` dimensions with labels; centres far apart.
function blobs(n, dim, count, seed, separation = 8) {
  const random = createRandom(seed);
  const centres = Array.from({ length: count }, () => Float64Array.from({ length: dim }, () => random.gaussian() * separation));
  const data = new Float32Array(n * dim);
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    labels[i] = i % count;
    for (let t = 0; t < dim; t += 1) data[i * dim + t] = centres[labels[i]][t] + random.gaussian();
  }
  return { data, labels };
}

// sklearn.manifold.trustworthiness, written independently with full sorts.
function referenceTrustworthiness(high, low, n, dh, dl, k) {
  const ranksOf = (X, dim, i) => {
    const order = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      let d = 0;
      for (let t = 0; t < dim; t += 1) d += (X[i * dim + t] - X[j * dim + t]) ** 2;
      order.push([d, j]);
    }
    order.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return order.map(([, j]) => j);
  };
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const orderHigh = ranksOf(high, dh, i);
    const rank = new Map(orderHigh.map((j, r) => [j, r + 1]));
    const lowNeighbours = ranksOf(low, dl, i).slice(0, k);
    for (const j of lowNeighbours) if (rank.get(j) > k) sum += rank.get(j) - k;
  }
  return 1 - (2 / (n * k * (2 * n - 3 * k - 1))) * sum;
}

test('trustworthiness equals the sklearn definition when every event is a query', () => {
  const n = 150;
  const high = gaussianMatrix(n, 6, 1);
  // A lossy embedding: the first two coordinates plus noise.
  const random = createRandom(2);
  const low = new Float32Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    low[2 * i] = high[i * 6] + 0.3 * random.gaussian();
    low[2 * i + 1] = high[i * 6 + 1] + 0.3 * random.gaussian();
  }
  for (const k of [1, 5, 12]) {
    const ours = trustworthiness(high, low, n, 6, 2, k, { sampleSize: n });
    const reference = referenceTrustworthiness(high, low, n, 6, 2, k);
    assert.ok(Math.abs(ours.value - reference) < 1e-12, `k=${k}: ${ours.value} vs ${reference}`);
    // Continuity is trustworthiness with the roles of the spaces swapped.
    assert.ok(Math.abs(ours.continuity - referenceTrustworthiness(low, high, n, 2, 6, k)) < 1e-12);
  }
});

test('an identity embedding is perfectly trustworthy; a random one is not', () => {
  const n = 400;
  const high = gaussianMatrix(n, 3, 5);
  const same = trustworthiness(high, high, n, 3, 3, 10, { sampleSize: 200 });
  assert.equal(same.value, 1);
  assert.equal(same.continuity, 1);
  assert.equal(same.knnPreservation, 1);
  const random = gaussianMatrix(n, 2, 6);
  const shuffled = trustworthiness(high, random, n, 3, 2, 10, { sampleSize: 200 });
  // Random neighbours have expected rank ≈ n/2, so T ≈ 1 − (n − 2k)/(2n − 3k) ≈ 0.5.
  assert.ok(shuffled.value < 0.6 && shuffled.value > 0.4, `T = ${shuffled.value}`);
  const preserved = knnPreservation(high, random, n, 3, 2, 10);
  assert.ok(preserved.value < 0.1);
  assert.ok(Math.abs(preserved.chance - 10 / 399) < 1e-12);
});

test('the subsample estimate is close to the full value and deterministic', () => {
  const n = 1500;
  const { data } = blobs(n, 8, 5, 3);
  const low = new Float32Array(n * 2);
  for (let i = 0; i < n; i += 1) {
    low[2 * i] = data[i * 8] + data[i * 8 + 2];
    low[2 * i + 1] = data[i * 8 + 1] - data[i * 8 + 3];
  }
  const full = trustworthiness(data, low, n, 8, 2, 15, { sampleSize: n });
  const a = trustworthiness(data, low, n, 8, 2, 15, { sampleSize: 400, seed: 9 });
  const b = trustworthiness(data, low, n, 8, 2, 15, { sampleSize: 400, seed: 9 });
  assert.equal(a.value, b.value);
  assert.ok(Math.abs(a.value - full.value) < 0.02);
  const fullPreservation = knnPreservation(data, low, n, 8, 2, 15, { full: true });
  assert.ok(Math.abs(fullPreservation.value - full.knnPreservation) < 1e-9, 'exact kNN below 5000 events');
});

test('Procrustes and seed stability ignore rotation, reflection, scale and shift', () => {
  const n = 300;
  const A = gaussianMatrix(n, 2, 11);
  const B = new Float32Array(2 * n);
  const angle = 0.7;
  for (let i = 0; i < n; i += 1) {
    const x = A[2 * i];
    const y = -A[2 * i + 1]; // reflection
    B[2 * i] = 3 * (Math.cos(angle) * x - Math.sin(angle) * y) + 10;
    B[2 * i + 1] = 3 * (Math.sin(angle) * x + Math.cos(angle) * y) - 4;
  }
  const fit = procrustes(A, B, n, 2);
  assert.ok(fit.disparity < 1e-10);
  assert.ok(Math.abs(fit.scale - 1 / 3) < 1e-5);
  const stable = seedStability(A, B, n, 10);
  assert.ok(stable.neighbourOverlap > 0.999);
  assert.ok(stable.disparity < 1e-10);
  for (let i = 0; i < n; i += 1) assert.ok(stable.displacement[i] < 1e-4);
  const unrelated = seedStability(A, gaussianMatrix(n, 2, 12), n, 10);
  assert.ok(unrelated.disparity > 0.9);
  assert.ok(unrelated.neighbourOverlap < 0.15);
});

test('mixing entropy and LISI: segregated labels score 1 category, interleaved ones mix', () => {
  const n = 600;
  const random = createRandom(4);
  const low = new Float32Array(2 * n);
  const segregated = new Int32Array(n);
  const interleaved = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    segregated[i] = i < n / 2 ? 0 : 1;
    interleaved[i] = random() < 0.5 ? 0 : 1;
    low[2 * i] = random() * 10 + (segregated[i] ? 100 : 0);
    low[2 * i + 1] = random() * 10;
  }
  const entropySeg = mixingEntropy(low, n, segregated, 30);
  const entropyMix = mixingEntropy(low, n, interleaved, 30);
  assert.equal(entropySeg.mean, 0);
  assert.ok(Math.abs(entropySeg.expected - 1) < 1e-12);
  assert.ok(entropyMix.mean > 0.9, `${entropyMix.mean}`);
  const lisiSeg = lisi(low, n, segregated);
  const lisiMix = lisi(low, n, interleaved);
  assert.ok(Math.abs(lisiSeg.mean - 1) < 1e-9);
  assert.ok(lisiMix.mean > 1.8 && lisiMix.mean <= 2, `${lisiMix.mean}`);
  assert.ok(Math.abs(lisiSeg.ideal - 2) < 1e-12);
  // String labels work too; a single category is trivially mixed.
  const names = Array.from(segregated, (c) => (c ? 'donor B' : 'donor A'));
  assert.equal(lisi(low, n, names).mean, lisiSeg.mean);
  assert.equal(mixingEntropy(low, n, new Int32Array(n), 30).mean, 1);
});

test('LISI reaches the perplexity calibration: equal weights over a uniform neighbourhood', () => {
  // 3 categories cycled along a line: every neighbourhood holds them in equal shares, so the
  // inverse Simpson index is 3 up to edge effects.
  const n = 900;
  const low = new Float32Array(2 * n);
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    low[2 * i] = i;
    labels[i] = i % 3;
  }
  const result = lisi(low, n, labels, { perplexity: 10 });
  assert.ok(result.median > 2.95, `${result.median}`);
});

test('region reliability marks torn-apart populations', () => {
  const n = 900;
  const { data, labels } = blobs(n, 5, 3, 21);
  // Embedding: blobs 0 and 1 kept faithfully (first two coordinates), blob 2 scattered at random.
  const random = createRandom(3);
  const low = new Float32Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    if (labels[i] === 2) {
      low[2 * i] = random() * 60 - 30;
      low[2 * i + 1] = random() * 60 - 30;
    } else {
      low[2 * i] = data[i * 5];
      low[2 * i + 1] = data[i * 5 + 1];
    }
  }
  const result = regionReliability(data, low, n, 5, 2, { k: 10 });
  let good = 0;
  let bad = 0;
  for (let i = 0; i < n; i += 1) {
    if (labels[i] === 2) bad += result.raw[i];
    else good += result.raw[i];
  }
  assert.ok(good / (2 * n / 3) > 3 * (bad / (n / 3)));
  const identity = regionReliability(data, data, n, 5, 5, { k: 10 });
  for (let i = 0; i < n; i += 1) assert.equal(identity.score[i], 1);
  // Large maps are scored on a subsample; every event still gets a score, and the scattered blob
  // still stands out.
  const sampled = regionReliability(data, low, n, 5, 2, { k: 5, maxEvents: 600 });
  assert.equal(sampled.sampled, 600);
  assert.equal(sampled.score.length, n);
  let goodS = 0;
  let badS = 0;
  for (let i = 0; i < n; i += 1) {
    if (labels[i] === 2) badS += sampled.score[i];
    else goodS += sampled.score[i];
  }
  assert.ok(goodS / (2 * n / 3) > 3 * (badS / (n / 3)), `${goodS} ${badS}`);
});

test('assessEmbedding summarises and warns in plain language', () => {
  const n = 800;
  const { data, labels } = blobs(n, 6, 4, 13);
  // A faithful map: the blobs are far apart, so two coordinates keep most structure.
  const good = new Float32Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    good[2 * i] = data[i * 6];
    good[2 * i + 1] = data[i * 6 + 1];
  }
  const fine = assessEmbedding(data, good, n, 6, 2, { sampleSize: 300 });
  assert.ok(fine.trustworthiness > 0.85);
  assert.equal(fine.warnings.filter((w) => w.level === 'warning').length, 0);
  assert.equal(fine.reliability.score.length, n);

  const noise = gaussianMatrix(n, 2, 99);
  const bad = assessEmbedding(data, noise, n, 6, 2, { sampleSize: 300, other: good, labels, reliability: false });
  const codes = bad.warnings.map((w) => w.code);
  assert.ok(codes.includes('neighbourhoods'));
  assert.ok(codes.includes('trustworthiness'));
  assert.ok(codes.includes('seed-global'));
  assert.equal(bad.warnings.find((w) => w.code === 'neighbourhoods').level, 'warning');
  assert.match(bad.warnings.find((w) => w.code === 'neighbourhoods').message, /Neighbourhoods are lost \(\d+%/);
  // The labels are the blobs: segregated in both spaces in the good map → a batch warning that
  // says the separation is in the data.
  const batch = assessEmbedding(data, good, n, 6, 2, { sampleSize: 300, labels, reliability: false });
  const warning = batch.warnings.find((w) => w.code === 'batch');
  assert.ok(warning, 'batch warning');
  assert.match(warning.message, /Batch dominates the layout/);
  assert.match(warning.message, /already separated in the original data/);
  assert.ok(batch.batch.mixingOriginal < 0.1);
});
