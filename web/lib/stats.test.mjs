import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import { describe, orderStatistics, quantileSorted, quantiles } from './stats.js';

// Inputs that stress a radix selection: ties, both zeros, piles of one value larger than the
// sorting threshold, negatives, and magnitudes from denormal to huge.
function cases() {
  const random = createRandom(11);
  const out = [];
  out.push(Float64Array.from({ length: 1 }, () => 3));
  out.push(Float64Array.from({ length: 500 }, () => random() * 100 - 50));
  out.push(Float64Array.from({ length: 200000 }, () => (random() - 0.3) * 262144));
  out.push(Float64Array.from({ length: 100000 }, () => Math.round(random() * 20) - 5));
  out.push(Float64Array.from({ length: 50000 }, (_, i) => (i % 3 === 0 ? -0 : i % 3 === 1 ? 0 : 1)));
  out.push(Float64Array.from({ length: 30000 }, () => 42.5));
  out.push(Float64Array.from({ length: 80000 }, (_, i) => (i < 60000 ? 262143 : random() * 1000)));
  out.push(Float64Array.from({ length: 40000 }, () => (random() < 0.5 ? -1 : 1) * 10 ** (random() * 600 - 300)));
  out.push(Float64Array.from({ length: 40000 }, () => Math.fround(random() * 1e-3)));
  out.push(Float64Array.from({ length: 30000 }, () => 5e-324 * Math.floor(random() * 4)));
  return out;
}

test('orderStatistics gives exactly the values a sort places at each rank', () => {
  for (const values of cases()) {
    const sorted = values.slice().sort();
    const n = values.length;
    const ranks = [0, n - 1, Math.floor(n / 2), Math.floor(n / 3), Math.floor(n / 3), Math.max(0, n - 2), Math.floor(0.999 * (n - 1))];
    const got = orderStatistics(values, ranks);
    ranks.forEach((r, i) => assert.ok(Object.is(got[i], sorted[r]), `n ${n} rank ${r}: ${got[i]} vs ${sorted[r]}`));
  }
  assert.throws(() => orderStatistics(Float64Array.of(1, 2), [2]), RangeError);
});

test('quantiles of unsorted values equal quantileSorted on the sorted values', () => {
  const probabilities = [0, 0.005, 0.1587, 0.25, 0.5, 0.75, 0.8413, 0.995, 1];
  for (const values of cases()) {
    const sorted = values.slice().sort();
    const got = quantiles(values, probabilities);
    probabilities.forEach((q, i) => {
      const expected = quantileSorted(sorted, q);
      assert.ok(Object.is(got[i], expected) || got[i] === expected, `q ${q}: ${got[i]} vs ${expected}`);
    });
  }
  assert.ok(Number.isNaN(quantiles(new Float64Array(0), [0.5])[0]));
});

test('describe: order statistics as from a sort, moments to rounding', () => {
  const random = createRandom(5);
  const column = Float32Array.from({ length: 300000 }, () => (random() < 0.02 ? Number.NaN : random() < 0.1 ? -random() * 500 : random() * 1e5));
  const indices = Uint32Array.from({ length: 120000 }, (_, i) => i * 2);
  for (const idx of [null, indices]) {
    const values = [];
    const n = idx ? idx.length : column.length;
    for (let k = 0; k < n; k += 1) {
      const v = column[idx ? idx[k] : k];
      if (Number.isFinite(v)) values.push(v);
    }
    const sorted = Float64Array.from(values).sort();
    const med = quantileSorted(sorted, 0.5);
    const d = describe(column, idx, { percentile: 90, threshold: 2000 });
    assert.equal(d.n, sorted.length);
    assert.equal(d.median, med);
    assert.equal(d.min, sorted[0]);
    assert.equal(d.max, sorted.at(-1));
    assert.equal(d.percentile, quantileSorted(sorted, 0.9));
    assert.equal(d.rsd, (quantileSorted(sorted, 0.8413) - quantileSorted(sorted, 0.1587)) / 2);
    assert.equal(d.mad, quantileSorted(Float64Array.from(sorted, (v) => Math.abs(v - med)).sort(), 0.5));
    assert.equal(d.p99, quantileSorted(sorted, 0.99));
    const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
    assert.ok(Math.abs(d.mean - mean) <= 1e-12 * Math.abs(mean), `mean ${d.mean} vs ${mean}`);
    assert.equal(d.positive, (100 * sorted.filter((v) => v >= 2000).length) / sorted.length);
  }
  assert.deepEqual(describe(Float32Array.of(Number.NaN)), { n: 0 });
});

test('order statistics of float32 values equal a sort of them; summarize matches describe', async () => {
  const { summarize } = await import('./stats.js');
  const random = createRandom(8);
  for (const length of [3000, 200000]) {
    const values = Float32Array.from({ length }, (_, i) => (i % 7 === 0 ? 0 : i % 11 === 0 ? -0 : (random() - 0.2) * 262144));
    const sorted = values.slice().sort();
    const ranks = [0, length - 1, Math.floor(length / 2), Math.floor(length / 7)];
    const got = orderStatistics(values, ranks);
    ranks.forEach((r, i) => assert.ok(Object.is(got[i], sorted[r]), `rank ${r}`));
    const s = summarize(values);
    const d = describe(values);
    assert.equal(s.median, d.median);
    assert.equal(s.rsd, d.rsd);
    assert.ok(Math.abs(s.mean - d.mean) <= 1e-12 * Math.abs(d.mean));
  }
});
