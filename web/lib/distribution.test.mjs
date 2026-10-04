import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bandwidthScott,
  bandwidthSilverman,
  emd2D,
  jensenShannon,
  kde,
  kolmogorovSurvival,
  ksTest,
  overtonSubtraction,
  probabilityBinning,
  wasserstein1D,
} from './distribution.js';
import { createRandom } from './random.js';

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected} (tolerance ${tolerance})`);
}

function normalSample(n, mean, sd, seed) {
  const random = createRandom(seed);
  return Float32Array.from({ length: n }, () => mean + sd * random.gaussian());
}

test('probability binning: hand-computed χ², T(χ) and % positive', () => {
  // Control 1…8 in 4 bins: cuts at the type-7 quartiles 2.75, 4.5, 6.25 → 2 events per bin.
  // Test (1, 2, 3, 7, 8, 8, 8, 8) → fractions (.25, .125, 0, .625).
  const result = probabilityBinning([1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 7, 8, 8, 8, 8], { bins: 4 });
  const chi = 0.125 ** 2 / 0.375 + 0.25 ** 2 / 0.25 + 0.375 ** 2 / 0.875;
  close(result.chiSquare, chi, 1e-15);
  close(result.expectedChiSquare, 4 / 8, 1e-15);
  assert.equal(result.T, 0); // (0.452 − 0.5)/0.25 < 0
  close(result.percentPositive, 37.5, 1e-12);
  const same = probabilityBinning([1, 2, 3, 4, 5, 6, 7, 8], [8, 7, 6, 5, 4, 3, 2, 1], { bins: 4 });
  assert.equal(same.chiSquare, 0);
});

test('probability binning separates shifted from identical distributions (1-D and 2-D)', () => {
  const control = normalSample(20000, 0, 1, 1);
  const null1 = probabilityBinning(control, normalSample(20000, 0, 1, 2));
  assert.ok(null1.T < 4, `T for identical distributions ${null1.T}`);
  const shifted = probabilityBinning(control, normalSample(20000, 0.3, 1, 3));
  assert.ok(shifted.T > 20, `T for a 0.3 SD shift ${shifted.T}`);
  // 30% of the test events far above the control: % positive ≈ 30.
  const mix = Float32Array.from(normalSample(20000, 0, 1, 4), (v, i) => (i % 10 < 3 ? v + 8 : v));
  close(probabilityBinning(control, mix).percentPositive, 30, 2);

  const cx = normalSample(4096, 0, 1, 5);
  const cy = normalSample(4096, 0, 2, 6);
  const tree = probabilityBinning([cx, cy], [normalSample(4096, 0, 1, 7), normalSample(4096, 0, 2, 8)], { bins: 64 });
  assert.equal(tree.bins, 64);
  for (const f of tree.controlFractions) close(f, 1 / 64, 1e-12, 'equal control counts per bin');
  assert.ok(tree.T < 4, `2-D null T ${tree.T}`);
  const moved = probabilityBinning([cx, cy], [normalSample(4096, 0, 1, 9), normalSample(4096, 1, 2, 10)], { bins: 64 });
  assert.ok(moved.T > 10, `2-D shifted T ${moved.T}`);
});

test('Overton cumulative subtraction', () => {
  // F_control − F_test peaks at x = 4: 1 − 0.5.
  const hand = overtonSubtraction([1, 2, 3, 4], [1, 2, 10, 11]);
  close(hand.percentPositive, 50, 1e-12);
  assert.equal(hand.threshold, 4);
  const control = normalSample(20000, 0, 1, 11);
  const test30 = Float32Array.from(normalSample(20000, 0, 1, 12), (v, i) => (i % 10 < 3 ? v + 6 : v));
  const result = overtonSubtraction(control, test30, { bins: 128 });
  close(result.percentPositive, 30, 2);
  assert.equal(result.curves.x.length, 128);
  close(result.curves.controlCdf[127], 1, 1e-12);
  assert.ok(overtonSubtraction(control, control).percentPositive === 0);
});

test('Kolmogorov–Smirnov two-sample test', () => {
  const same = ksTest([3, 1, 2, 5], [5, 2, 3, 1]);
  assert.equal(same.D, 0);
  assert.equal(same.p, 1);
  // Fully separated 3 vs 3: D = 1, λ = √(9/6); Q(λ) = 2(e^{−2λ²} − e^{−8λ²} + e^{−18λ²} − …).
  const sep = ksTest([1, 2, 3], [4, 5, 6]);
  assert.equal(sep.D, 1);
  const l2 = 1.5;
  close(sep.p, 2 * (Math.exp(-2 * l2) - Math.exp(-8 * l2) + Math.exp(-18 * l2) - Math.exp(-32 * l2)), 1e-15);
  // Classical critical value: Q(1.3581) = 0.05; Q(1.6276) = 0.01.
  close(kolmogorovSurvival(1.3581), 0.05, 1e-4);
  close(kolmogorovSurvival(1.6276), 0.01, 1e-4);
  // Both series agree where they switch.
  const series = (l) => {
    let s = 0;
    for (let k = 1; k < 100; k += 1) s += (k % 2 ? 1 : -1) * Math.exp(-2 * k * k * l * l);
    return 2 * s;
  };
  close(kolmogorovSurvival(1.1799), series(1.1799), 1e-14);
  close(kolmogorovSurvival(0.7), series(0.7), 1e-14);
  const shifted = ksTest(normalSample(5000, 0, 1, 13), normalSample(5000, 0.2, 1, 14));
  assert.ok(shifted.p < 1e-6 && shifted.D > 0.05);
});

test('1-D Earth Mover\'s distance is exact', () => {
  close(wasserstein1D([0, 1, 2], [1, 2, 3]), 1, 1e-15);
  close(wasserstein1D([0, 0], [1]), 1, 1e-15);
  close(wasserstein1D([0, 2], [1]), 1, 1e-15);
  close(wasserstein1D([0, 4], [1, 2]), 1.5, 1e-15); // sorted matching: |0−1| + |4−2|, averaged
  close(wasserstein1D([5, 5, 5], [5]), 0, 0);
  const emd = wasserstein1D(normalSample(20000, 0, 1, 15), normalSample(20000, 1, 1, 16));
  close(emd, 1, 0.03, 'N(0,1) vs N(1,1)');
});

test('2-D EMD approximation recovers a shift', () => {
  const ax = normalSample(20000, 0, 1, 17);
  const ay = normalSample(20000, 0, 0.5, 18);
  const bx = normalSample(20000, 1, 1, 19);
  const by = normalSample(20000, 0, 0.5, 20);
  const result = emd2D([ax, ay], [bx, by]);
  close(result.distance, 1, 0.08, 'scaled sliced distance');
  close(result.maxSliced, 1, 0.08, 'max-sliced');
  assert.ok(result.sliced < result.distance);
  const self = emd2D([ax, ay], [ax, ay]);
  assert.equal(self.distance, 0);
});

test('Jensen–Shannon divergence', () => {
  assert.equal(jensenShannon([1, 2, 3], [2, 4, 6]).divergence, 0);
  close(jensenShannon([1, 0], [0, 1]).divergence, 1, 1e-15);
  // P = (1, 0), Q = (½, ½): ½·log2(4/3) + ½·(½ log2(2/3) + ½ log2 2) = 0.3112781244591328.
  const js = jensenShannon([1, 0], [1, 1]);
  close(js.divergence, 0.5 * Math.log2(4 / 3) + 0.5 * (0.5 * Math.log2(2 / 3) + 0.5), 1e-15);
  close(js.distance, Math.sqrt(js.divergence), 1e-15);
  close(jensenShannon([1, 0], [0, 1], { base: Math.E }).divergence, Math.LN2, 1e-15);
});

test('kernel density estimate: bandwidth rules and normalization', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // SD = √(55/6), IQR (type 7) = 7.75 − 3.25 = 4.5, so min(SD, IQR/1.34) = SD.
  const sd = Math.sqrt(55 / 6);
  close(bandwidthSilverman(values), 0.9 * sd * 10 ** -0.2, 1e-14);
  close(bandwidthScott(values), 1.06 * sd * 10 ** -0.2, 1e-14);
  const sample = normalSample(50000, 0, 1, 21);
  const density = kde(sample);
  let integral = 0;
  for (let i = 1; i < density.x.length; i += 1) integral += 0.5 * (density.y[i] + density.y[i - 1]) * (density.x[i] - density.x[i - 1]);
  close(integral, 1, 2e-3);
  let peak = 0;
  for (let i = 0; i < density.x.length; i += 1) if (Math.abs(density.x[i]) < Math.abs(density.x[peak])) peak = i;
  close(density.y[peak], 1 / Math.sqrt(2 * Math.PI), 0.012, 'density at 0');
  const scott = kde(sample, { bandwidth: 'scott', points: 256 });
  assert.equal(scott.x.length, 256);
  assert.ok(scott.bandwidth > density.bandwidth);
  // A single-point-like sample with a fixed bandwidth is the kernel itself.
  const one = kde([0, 0], { bandwidth: 1, range: [-4, 4], points: 801 });
  close(one.y[400], 1 / Math.sqrt(2 * Math.PI), 1e-12);
  close(one.y[500], Math.exp(-0.5) / Math.sqrt(2 * Math.PI), 1e-12);
});
