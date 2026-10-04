import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addGaussianBins,
  curveFit,
  erfcFast,
  fitLeastSquares,
  invertSymmetric,
  levenbergMarquardt,
  nelderMead,
  normalCdfFast,
  smoothCounts,
} from './fit.js';
import { createRandom } from './random.js';

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected} (tolerance ${tolerance})`);
}

test('LM on a straight line reproduces the OLS estimates and standard errors exactly', () => {
  // y = 2.2 + 0.6 x: hand-computed OLS gives SSE = 2.4, σ² = 0.8, Sxx = 10,
  // SE(slope) = √(0.8/10), SE(intercept) = √(0.8 (1/5 + 9/10)).
  const x = [1, 2, 3, 4, 5];
  const y = [2, 4, 5, 4, 5];
  const line = (xi, p) => p[0] + p[1] * xi;
  // Default tolerances stop once χ² cannot fall by more than 1e-14 of itself (≈1e-7 SE).
  const fit = curveFit(line, x, y, [0, 0]);
  assert.ok(fit.converged);
  close(fit.params[0], 2.2, 1e-7 * fit.standardErrors[0], 'intercept');
  close(fit.params[1], 0.6, 1e-7 * fit.standardErrors[1], 'slope');
  const exact = curveFit(line, x, y, [0, 0], { ftol: 1e-28, gradient: (xi, p, out) => { out[0] = 1; out[1] = xi; } });
  close(exact.params[0], 2.2, 1e-10, 'intercept (analytic, tight)');
  close(exact.params[1], 0.6, 1e-10, 'slope (analytic, tight)');
  close(fit.chiSquare, 2.4, 1e-9, 'SSE');
  close(fit.reducedChiSquare, 0.8, 1e-9, 'σ²');
  close(fit.standardErrors[1], Math.sqrt(0.08), 1e-7, 'SE slope');
  close(fit.standardErrors[0], Math.sqrt(0.8 * 1.1), 1e-7, 'SE intercept');
  close(fit.covariance[1], -0.8 * 3 / 10, 1e-7, 'covariance');
});

test('LM recovers an exponential decay and its standard errors match Monte Carlo spread', () => {
  const truth = [100, 0.35, 5];
  const x = Float64Array.from({ length: 40 }, (_, i) => i * 0.25);
  const model = (xi, p) => p[0] * Math.exp(-p[1] * xi) + p[2];
  const noise = 1.5;
  const random = createRandom(7);
  const estimates = [[], [], []];
  const reported = [[], [], []];
  for (let rep = 0; rep < 200; rep += 1) {
    const y = Float64Array.from(x, (xi) => model(xi, truth) + noise * random.gaussian());
    const fit = curveFit(model, x, y, [50, 1, 0]);
    assert.ok(fit.converged, fit.reason);
    for (let j = 0; j < 3; j += 1) {
      estimates[j].push(fit.params[j]);
      reported[j].push(fit.standardErrors[j]);
    }
  }
  for (let j = 0; j < 3; j += 1) {
    const mean = estimates[j].reduce((a, b) => a + b, 0) / estimates[j].length;
    const sd = Math.sqrt(estimates[j].reduce((a, b) => a + (b - mean) ** 2, 0) / (estimates[j].length - 1));
    const se = reported[j].reduce((a, b) => a + b, 0) / reported[j].length;
    close(mean, truth[j], 4 * sd / Math.sqrt(200) + 1e-3 * Math.abs(truth[j]), `mean of p${j}`);
    assert.ok(se / sd > 0.8 && se / sd < 1.25, `SE ${se} vs empirical SD ${sd} for p${j}`);
  }
});

test('LM fits a Gaussian peak with weights and absolute sigma', () => {
  const x = Float64Array.from({ length: 61 }, (_, i) => i);
  const truth = [500, 30, 4.5];
  const gaussian = (xi, p) => p[0] * Math.exp(-0.5 * ((xi - p[1]) / p[2]) ** 2);
  const random = createRandom(3);
  const y = Float64Array.from(x, (xi) => {
    const m = gaussian(xi, truth);
    return m + Math.sqrt(m + 1) * random.gaussian();
  });
  const sigma = Float64Array.from(y, (v) => Math.sqrt(Math.max(v, 1)));
  const fit = curveFit(gaussian, x, y, [300, 25, 8], { sigma, absoluteSigma: true });
  assert.ok(fit.converged);
  for (let j = 0; j < 3; j += 1) {
    assert.ok(Math.abs(fit.params[j] - truth[j]) < 4 * fit.standardErrors[j], `p${j} ${fit.params[j]} ± ${fit.standardErrors[j]}`);
  }
  // Poisson weights with a correct model give a reduced χ² near 1.
  assert.ok(fit.reducedChiSquare > 0.6 && fit.reducedChiSquare < 1.6, `reduced χ² ${fit.reducedChiSquare}`);
});

test('analytic and numerical Jacobians agree', () => {
  const x = Float64Array.from({ length: 30 }, (_, i) => i / 3);
  const y = Float64Array.from(x, (xi) => 3 * Math.sin(1.3 * xi) + 0.01 * Math.cos(17 * xi));
  const fn = (xi, p) => p[0] * Math.sin(p[1] * xi);
  const numeric = curveFit(fn, x, y, [2.5, 1.25]);
  const analytic = curveFit(fn, x, y, [2.5, 1.25], {
    gradient: (xi, p, out) => {
      out[0] = Math.sin(p[1] * xi);
      out[1] = p[0] * xi * Math.cos(p[1] * xi);
    },
  });
  close(numeric.params[0], analytic.params[0], 1e-7);
  close(numeric.params[1], analytic.params[1], 1e-8);
  close(numeric.standardErrors[1], analytic.standardErrors[1], 1e-6 * analytic.standardErrors[1] + 1e-12);
});

test('bounds are respected and active bounds are flagged; fixed parameters stay put', () => {
  const x = [0, 1, 2, 3, 4, 5];
  const y = x.map((xi) => 1 + 2 * xi);
  const bounded = curveFit((xi, p) => p[0] + p[1] * xi, x, y, [0, 0], { upper: [null, 1.5] });
  close(bounded.params[1], 1.5, 0, 'slope on its bound');
  assert.deepEqual(bounded.atBound, [false, true]);
  // With the slope held at 1.5 the best intercept is mean(y − 1.5x) = 1 + 0.5·2.5 = 2.25.
  close(bounded.params[0], 2.25, 1e-7);
  const fixed = curveFit((xi, p) => p[0] + p[1] * xi, x, y, [0, 1.8], { fixed: [false, true] });
  close(fixed.params[1], 1.8, 0);
  close(fixed.params[0], 1 + 0.2 * 2.5, 1e-7);
  assert.equal(fixed.standardErrors[1], 0);
});

test('vector-form models and central differences', () => {
  const n = 50;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) y[i] = 4 / (1 + Math.exp(-(i - 20) / 3));
  const model = (p, out) => {
    for (let i = 0; i < n; i += 1) out[i] = p[0] / (1 + Math.exp(-(i - p[1]) / p[2]));
  };
  const fit = levenbergMarquardt(model, [3, 25, 5], y, { centralDifferences: true });
  close(fit.params[0], 4, 1e-7);
  close(fit.params[1], 20, 1e-6);
  close(fit.params[2], 3, 1e-6);
  assert.ok(fit.chiSquare < 1e-12);
});

test('Nelder–Mead minimizes the Rosenbrock function', () => {
  const rosen = (p) => 100 * (p[1] - p[0] * p[0]) ** 2 + (1 - p[0]) ** 2;
  const result = nelderMead(rosen, [-1.2, 1], { xtol: 1e-10, ftol: 1e-14, maxIterations: 5000, maxEvaluations: 10000 });
  assert.ok(result.converged);
  close(result.params[0], 1, 1e-5);
  close(result.params[1], 1, 1e-5);
  // Bounded: the minimum of (x−3)² on [0, 2] is at 2.
  const bounded = nelderMead((p) => (p[0] - 3) ** 2 + (p[1] + 1) ** 2, [0.5, 0.5], { lower: [0, -5], upper: [2, 5] });
  close(bounded.params[0], 2, 1e-6);
  close(bounded.params[1], -1, 1e-4);
});

test('fitLeastSquares falls back to Nelder–Mead and ends no worse', () => {
  const x = Float64Array.from({ length: 30 }, (_, i) => i / 2);
  const y = Float64Array.from(x, (xi) => 10 * Math.exp(-0.4 * xi) + 1);
  const model = (p, out) => {
    for (let i = 0; i < x.length; i += 1) out[i] = p[0] * Math.exp(-p[1] * x[i]) + p[2];
  };
  const limited = levenbergMarquardt(model, [1, 2, 0], y, { maxIterations: 2 });
  assert.equal(limited.converged, false);
  const result = fitLeastSquares(model, [1, 2, 0], y, { maxIterations: 2 });
  assert.ok(result.chiSquare < limited.chiSquare);
  assert.equal(result.method, 'nelder-mead+levenberg-marquardt');
  const full = fitLeastSquares(model, [1, 2, 0], y);
  assert.equal(full.method, 'levenberg-marquardt');
  close(full.params[1], 0.4, 1e-7);
});

test('erfcFast matches known values to its stated accuracy', () => {
  // erfc(1) = 0.157299207050285130659, erfc(2) = 0.004677734981047265838,
  // erfc(0.5) = 0.479500122186953462318 (Abramowitz & Stegun table 7.1).
  for (const [x, v] of [[0, 1], [0.5, 0.4795001221869535], [1, 0.15729920705028513], [2, 0.004677734981047266], [-1, 1.8427007929497148]]) {
    assert.ok(Math.abs(erfcFast(x) - v) <= 1.2e-7 * v, `erfc(${x})`);
  }
  close(normalCdfFast(1.959963984540054), 0.975, 1e-7);
});

test('addGaussianBins conserves area and centers the peak', () => {
  const out = new Float64Array(100);
  addGaussianBins(out, 0, 1, 1000, 50.5, 3);
  close(out.reduce((a, b) => a + b, 0), 1000, 1e-4);
  // The bin [50, 51) holds erf(0.5/(3√2)) of the area.
  close(out[50], 1000 * (1 - erfcFast(0.5 / (3 * Math.SQRT2))), 1e-6);
  const narrow = new Float64Array(10);
  addGaussianBins(narrow, 0, 10, 1, 45, 0.1);
  close(narrow[4], 1, 1e-6, 'all mass in one wide bin');
  const smooth = smoothCounts(out, 2);
  close(smooth.reduce((a, b) => a + b, 0), 1000, 1e-6, 'smoothing conserves counts');
});

test('invertSymmetric inverts a badly scaled SPD matrix and rejects a singular one', () => {
  const a = Float64Array.from([4e10, 2e4, 2e4, 3e-2]);
  const inv = invertSymmetric(a, 2);
  const det = 4e10 * 3e-2 - 4e8;
  close(inv[0], 3e-2 / det, 1e-12 * Math.abs(3e-2 / det));
  close(inv[3], 4e10 / det, 1e-6 * Math.abs(4e10 / det));
  close(inv[1], -2e4 / det, 1e-9 * Math.abs(2e4 / det));
  assert.equal(invertSymmetric(Float64Array.from([1, 2, 2, 4]), 2), null);
});
