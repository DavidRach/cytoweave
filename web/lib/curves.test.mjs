import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import { effectiveDose, fitLogLogistic, inverseLogLogistic, inverseWithError, logLogistic, percentOfControls } from './curves.js';

const close = (a, b, tol, what = '') => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} vs ${b} (±${tol})`);

test('the model, its inverse and effective doses', () => {
  const p = { b: 1.5, c: 10, d: 90, e: 100, f: 1 };
  close(logLogistic(100, p), 50, 1e-12, 'LL.4 at e');
  close(logLogistic(0, p), 90, 0, 'zero dose (b > 0): d');
  close(logLogistic(0, { ...p, b: -1.5 }), 10, 0, 'zero dose (b < 0): c');
  close(inverseLogLogistic(logLogistic(37, p), p), 37, 1e-9, 'inverse');
  assert.ok(Number.isNaN(inverseLogLogistic(95, p)), 'beyond an asymptote');
  const five = { b: -1.1, c: 40, d: 50000, e: 6000, f: 0.7 };
  // EC50: halfway between the asymptotes.
  close(logLogistic(effectiveDose(five, 50), five), (five.c + five.d) / 2, 1e-6, 'LL.5 EC50');
  close(logLogistic(effectiveDose(p, 90), p), 90 - 0.9 * 80, 1e-9, 'EC90 of a falling curve');
});

test('a noise-free four-parameter curve is recovered exactly, rising or falling', () => {
  const x = [0, 1, 3, 10, 30, 100, 300, 1000, 3000];
  for (const truth of [{ b: 1.2, c: 5, d: 60, e: 100, f: 1 }, { b: -0.8, c: 2, d: 95, e: 40, f: 1 }]) {
    const fit = fitLogLogistic(x, x.map((v) => logLogistic(v, truth)), { model: 'LL.4' });
    close(fit.ec50, truth.e, 1e-6 * truth.e, 'EC50');
    close(fit.bottom, Math.min(truth.c, truth.d), 1e-6, 'bottom');
    close(fit.top, Math.max(truth.c, truth.d), 1e-6, 'top');
    assert.equal(fit.rising, truth.b < 0);
    close(fit.hill, -truth.b, 1e-6, 'Hill slope (negative for a falling curve)');
  }
});

test('standard errors and the EC50 interval match the textbook delta method on noisy data', () => {
  const random = createRandom(4);
  const x = [];
  const y = [];
  for (const dose of [0.5, 1.5, 4.6, 13.7, 41, 123, 370, 1111, 3333, 10000]) {
    for (let r = 0; r < 3; r += 1) {
      x.push(dose);
      y.push(logLogistic(dose, { b: 1.2, c: 5, d: 60, e: 100 }) + 2 * (random() - 0.5));
    }
  }
  const fit = fitLogLogistic(x, y, { model: 'LL.4' });
  // The EC50's 95% interval is symmetric on the log scale around the estimate.
  close(Math.log(fit.ec50CI[1] / fit.ec50) + Math.log(fit.ec50CI[0] / fit.ec50), 0, 1e-12, 'log-symmetric');
  assert.ok(fit.ec50CI[0] < 100 && fit.ec50CI[1] > 100, 'covers the truth');
  // For LL.4 the EC50 is e: same standard error.
  close(fit.ec50SE, fit.standardErrors.e, 1e-9 * fit.standardErrors.e, 'EC50 SE');
  assert.equal(fit.df, x.length - 4);
  assert.ok(fit.noEffect.p < 1e-6);
  assert.deepEqual(fit.flags, []);
});

test('fixed asymptotes, weights, flat data and doses beyond the range are handled', () => {
  const x = [1, 3, 10, 30, 100, 300, 1000];
  const fixed = fitLogLogistic(x, x.map((v) => logLogistic(v, { b: 1, c: 0, d: 100, e: 30 })), { model: 'LL.4', fixed: { c: 0, d: 100 } });
  assert.equal(fixed.parameters.c, 0);
  assert.equal(fixed.standardErrors.c, null);
  assert.equal(fixed.df, x.length - 2);
  const flat = fitLogLogistic(x, [10, 11, 9.5, 10.4, 9.8, 10.1, 10.2], { model: 'LL.4' });
  assert.ok(flat.flags.includes('no-effect'), flat.flags.join());
  const shifted = fitLogLogistic(x, x.map((v) => logLogistic(v, { b: 1, c: 0, d: 100, e: 5000 }) + (v % 7) * 0.3), { model: 'LL.4' });
  assert.ok(shifted.flags.includes('extrapolated'), shifted.flags.join());
  // 1/Y² weights: relative errors of a curve spanning decades.
  const random = createRandom(9);
  const xs = [0, 2.4, 9.8, 39, 156, 625, 2500, 10000];
  const truth = { b: -1.1, c: 40, d: 50000, e: 6000, f: 0.8 };
  const ys = xs.map((v) => logLogistic(v, truth) * (1 + 0.03 * (random() - 0.5)));
  const weighted = fitLogLogistic(xs, ys, { model: 'LL.5', weighting: '1/y2' });
  close(inverseLogLogistic(logLogistic(9.8, truth), weighted.parameters) / 9.8, 1, 0.1, 'low standard back-calculated');
  const { dose, se } = inverseWithError(weighted, logLogistic(156, truth));
  assert.ok(Math.abs(dose - 156) < 3 * se + 5, `${dose} ± ${se}`);
});

test('percent of controls', () => {
  assert.deepEqual(percentOfControls([4, 33, 62], 4, 62), [0, 50, 100]);
});
