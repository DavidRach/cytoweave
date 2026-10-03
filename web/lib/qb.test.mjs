import { test } from 'node:test';
import assert from 'node:assert/strict';
import { characterize, findBeadPeaks, fitQB, leveyJennings, peakStatistics, robustNormal, scatterGate } from './qb.js';
import { createRandom } from './random.js';

// Peaks with variance c0 + c1·M + c2·M² (Gaussian, so the counting noise is approximated).
function peaks(levels, [c0, c1, c2], n, seed) {
  const random = createRandom(seed);
  return levels.map((m) => Float64Array.from({ length: n }, () => m + Math.sqrt(c0 + c1 * m + c2 * m * m) * random.gaussian()));
}

test('a normal fitted to the central 80% recovers mean and SD, ignoring stray events', () => {
  const random = createRandom(3);
  const values = Array.from({ length: 20000 }, () => 100 + 10 * random.gaussian());
  // 2% of events from a neighboring peak.
  for (let i = 0; i < 400; i += 1) values.push(400 + 20 * random.gaussian());
  const r = robustNormal(values);
  assert.ok(Math.abs(r.mean - 100) < 0.6, `mean ${r.mean}`);
  assert.ok(Math.abs(r.sd - 10) < 0.6, `sd ${r.sd}`);
});

test('the weighted quadratic fit recovers Q, B and CV0', () => {
  const truth = [400, 0.5, 0.02 ** 2]; // B = c0/c1² = 1600 Spe, Q = 2 Spe per unit, CV0 = 2%
  const rows = peakStatistics(peaks([5, 60, 200, 700, 2500, 8000, 25000, 70000], truth, 20000, 7));
  const fit = fitQB(rows);
  assert.ok(Math.abs(fit.Q - 2) / 2 < 0.03, `Q ${fit.Q}`);
  assert.ok(Math.abs(fit.B - 1600) / 1600 < 0.1, `B ${fit.B}`);
  assert.ok(Math.abs(fit.CV0 - 0.02) < 0.002, `CV0 ${fit.CV0}`);
  assert.ok(fit.iterations >= 1 && fit.used === 8);
  // Standard errors are reported, and the truth lies within a few of them.
  assert.ok(Math.abs(fit.c[1] - 0.5) < 4 * fit.se[1]);
  // The linear model ignores CV0 and is fitted too.
  assert.equal(fitQB(rows, { model: 'linear' }).model, 'linear');
});

test('peaks out of bounds, and dim height peaks, are left out of the fit', () => {
  const rows = peakStatistics(peaks([2, 50, 300, 2000, 150000], [100, 1, 0], 2000, 9), { height: true });
  const omitted = rows.filter((r) => r.omit).map((r) => r.why);
  assert.ok(omitted.some((w) => /above 100000/.test(w)));
  assert.ok(omitted.some((w) => /10×/.test(w)));
  assert.equal(fitQB(rows).used, 3);
  assert.equal(fitQB(rows, { minimumPeaks: 4 }), null, 'too few peaks left');
});

test('bead peaks are found on scatter-gated events and ordered by brightness', () => {
  const random = createRandom(11);
  const levels = [10, 200, 2000, 20000];
  const n = 8000;
  const fsc = new Float32Array(n);
  const ssc = new Float32Array(n);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  const truth = new Int32Array(n);
  for (let e = 0; e < n; e += 1) {
    const debris = e % 25 === 0;
    fsc[e] = debris ? 3000 * random() : 50000 * (1 + 0.03 * random.gaussian());
    ssc[e] = debris ? 2000 * random() : 20000 * (1 + 0.03 * random.gaussian());
    const level = e % levels.length;
    truth[e] = debris ? -1 : level;
    a[e] = levels[level] * (1 + 0.02 * random.gaussian()) + 5 * random.gaussian();
    b[e] = 0.5 * levels[level] * (1 + 0.02 * random.gaussian()) + 5 * random.gaussian();
  }
  const gated = scatterGate(fsc, ssc);
  assert.ok(gated.every((e) => truth[e] >= 0), 'debris gated out');
  const { events, labels } = findBeadPeaks({ FSC: fsc, SSC: ssc, A: a, B: b }, { channels: ['A', 'B'], scatter: ['FSC', 'SSC'], peaks: 4 });
  let agree = 0;
  events.forEach((e, k) => { if (labels[k] === truth[e]) agree += 1; });
  assert.ok(agree / events.length > 0.99, `${agree} of ${events.length}`);
  const byPeak = Array.from({ length: 4 }, () => []);
  events.forEach((e, k) => byPeak[labels[k]].push(a[e]));
  const result = characterize({ A: byPeak });
  assert.deepEqual(result.A.peaks.map((r) => r.peak), [0, 1, 2, 3]);
  assert.ok(result.A.bright.median > 19000);
});

test('Levey–Jennings flags runs by the Westgard rules', () => {
  const steady = [10, 10.5, 9.5, 10.2, 9.8, 10.1, 9.9, 10.3, 9.7, 10];
  const lj = leveyJennings([...steady, 10.1, 13, 9.9, 11.3, 11.4, 9.0], { baseline: 10 });
  assert.ok(Math.abs(lj.mean - 10) < 0.01);
  const rules = lj.flags.map((f) => f.rules);
  assert.deepEqual(rules[10], []);
  assert.ok(rules[11].includes('1-3s'), 'a run beyond 3 SD');
  assert.ok(rules[14].includes('2-2s'), 'two runs beyond 2 SD on the same side');
  assert.ok(rules[15].includes('R-4s') || rules[15].includes('1-3s'), 'a swing across the mean');
  const drift = leveyJennings([...steady, 10.4, 10.35, 10.45, 10.4], { baseline: 10 });
  assert.ok(drift.flags[13].rules.includes('4-1s'), 'four runs beyond 1 SD on one side');
});
