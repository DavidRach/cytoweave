import assert from 'node:assert/strict';
import test from 'node:test';
import { bsplineRow, eBayes, leastSquares, lmFit, logmdigamma, naturalSplineBasis, optimize, trigammaInverse } from './limma.js';
import { trigamma } from './hypothesis.js';

const close = (actual, expected, tolerance, label = '') => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${label} ${actual} vs ${expected}`);

// Seven rows like cluster × marker medians in six samples (three per group), cell counts as
// weights, two values missing (count 0). R: eBayes(contrasts.fit(lmFit(y, d, weights = w), c(0, 1)),
// trend) with limma 3.68.5.
const y = [[1.0, 1.2, 0.9, 1.6, 1.8, 1.7], [3.1, 2.9, 3.3, 3.0, 3.4, 3.2], [0.2, 0.1, 0.4, 0.9, NaN, 1.1], [5.0, 5.2, 4.9, 5.1, 5.0, 5.3], [2.0, 2.4, NaN, 2.2, 2.9, 2.6], [4.1, 3.7, 4.0, 4.6, 4.4, 4.8], [0.5, 0.7, 0.6, 0.4, 0.8, 0.6]];
const w = [[10, 20, 15, 12, 30, 8], [50, 40, 60, 55, 45, 70], [3, 5, 4, 6, 0, 2], [100, 120, 90, 110, 95, 105], [7, 9, 0, 8, 6, 10], [25, 30, 20, 35, 28, 22], [12, 14, 11, 13, 15, 10]];
const design = [[1, 0], [1, 0], [1, 0], [1, 1], [1, 1], [1, 1]];
const coef = [0.68044444444444485, 0.06156862745098113, 0.72500000000000020, 0.08870967741935398, 0.31666666666666704, 0.67254901960784341, 0.00512091038406845];

test('weighted fits with missing values and unequal residual df, without and with a trend, as limma', () => {
  const fit = lmFit(y, design, { weights: w, coefficient: 1 });
  coef.forEach((c, g) => close(fit.coefficient[g], c, 1e-13, `coefficient ${g}`));
  assert.deepEqual(Array.from(fit.dfResidual), [4, 4, 3, 4, 3, 4, 4]);
  const plain = eBayes(fit, { trend: false });
  assert.equal(plain.legacy, false);
  close(plain.dfPrior, 9.07560465034297, 1e-9, 'df.prior');
  [4.1076535232779197, 0.5097319640784834, 2.0029560385575094, 0.9677636479342816, 1.0947256629828763, 4.4876103328852333, 0.0271719009649627].forEach((t, g) => close(plain.t[g], t, 1e-9, `t ${g}`));
  [0.001221034757246697, 0.618733459146043385, 0.068152166575464995, 0.350722870228071359, 0.294991961610407805, 0.000602477970228834, 0.978732958748196769].forEach((p, g) => close(plain.p[g], p, 1e-9, `p ${g}`));
  const trended = eBayes(fit, { trend: true });
  close(trended.dfPrior, 8134.84478038266, 1e-8, 'df.prior with trend');
  [4.8294233264080217, 0.4516187215563200, 3.1992528171406693, 0.6662042443686493, 0.9743799258892962, 2.8703164219226309, 0.0436054080085457].forEach((t, g) => close(trended.t[g], t, 1e-8, `t ${g}`));
  [5.27175624421401e-05, 6.55288515159614e-01, 3.60942619705166e-03, 5.11149002011698e-01, 3.38846883422830e-01, 8.04404331901511e-03, 9.65552109381005e-01].forEach((p, g) => close(trended.p[g] / p, 1, 1e-8, `p ${g}`));
});

test('equal residual df: the spline trend, an infinite prior df and the pooled df as the cap', () => {
  const filled = y.map((row) => row.map((v) => (Number.isNaN(v) ? 0 : v)));
  const weights = w.map((row) => row.map((v) => (v === 0 ? 1 : v)));
  const e = eBayes(lmFit(filled, design, { weights, coefficient: 1 }), { trend: true });
  assert.equal(e.legacy, true);
  assert.equal(e.dfPrior, Infinity);
  assert.ok(e.dfTotal.every((d) => d === 28));
  [3.7226771714835318, 0.3754812098209920, 2.4564674532628388, 0.7120792108814724, 1.2321065286632520, 2.7208035042225203, 0.0359627233531618].forEach((t, g) => close(e.t[g], t, 1e-9, `t ${g}`));
  [0.000879292076454801, 0.710132192944002316, 0.020492605220448525, 0.482307328131997282, 0.228156177072802224, 0.011067423474469977, 0.971567249070211414].forEach((p, g) => close(e.p[g], p, 1e-9, `p ${g}`));
});

test('least squares drops collinear and empty columns as LINPACK does, keeping the others in order', () => {
  // Column 2 is zero (a donor without observations), column 3 equals column 1. R's lm.fit: pivot
  // 1 2 3 4 (both moved to the end in turn), rank 2, coefficients 1, 1.9, NA, NA.
  const X = [[1, 0, 0, 0], [1, 1, 0, 1], [1, 0, 0, 0], [1, 1, 0, 1], [1, 0, 0, 0]];
  const fit = leastSquares(X, [1, 3, 1.2, 2.8, 0.8]);
  assert.equal(fit.rank, 2);
  assert.deepEqual(fit.pivot, [0, 1, 2, 3]);
  close(fit.coefficients[0], 1, 1e-12);
  close(fit.coefficients[1], 1.9, 1e-12);
  assert.ok(Number.isNaN(fit.coefficients[2]) && Number.isNaN(fit.coefficients[3]));
  close(fit.rss, 0.1, 1e-12);
});

test('helpers: logmdigamma, trigammaInverse, optimize, B-splines and natural splines', () => {
  // statmod::logmdigamma.
  close(logmdigamma(0.5), 1.2703628454613649, 1e-14);
  close(logmdigamma(80), 0.0062630206298979483, 1e-14);
  for (const v of [0.05, 1, 30]) close(trigamma(trigammaInverse(v)), v, 1e-7);
  close(optimize((x) => (x - 0.7) ** 2, 0.5, 0.9998), 0.7, 1e-4);
  // splines::splineDesign(c(0,0,0,0,2,7,7,7,7), 2.5, 4, derivs = 0:2).
  const knots = [0, 0, 0, 0, 2, 7, 7, 7, 7];
  [[0, 0.371939, 0.471122, 0.155939, 0.001], [0, -0.247959, 0.071633, 0.170327, 0.006], [0, 0.110204, -0.203265, 0.069061, 0.024]].forEach((row, d) => {
    Array.from(bsplineRow(knots, 2.5, d)).forEach((v, i) => close(v, row[i], 1e-6, `derivative ${d}`));
  });
  // A natural spline basis reproduces lines exactly, inside and beyond the boundary knots.
  const x = [0.1, 0.5, 0.9, 1.3, 2, 2.2, 3, 4.5, 5, 7];
  const ns = naturalSplineBasis(x, 4);
  const fit = leastSquares(ns.basis, x.map((v) => 2 * v - 1));
  close(fit.rss, 0, 1e-20);
  close(ns.at(9).reduce((s, b, j) => s + b * fit.coefficients[j], 0), 17, 1e-10);
});
