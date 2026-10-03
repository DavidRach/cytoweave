import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compensate,
  compensationResiduals,
  computeSpillover,
  controlResiduals,
  conditionNumber,
  formatSpillover,
  identityMatrix,
  invertMatrix,
  leanCheck,
  multiplyMatrices,
  robustSlope,
  spilloverSpreading,
} from './compensation.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  let u = 0;
  while (u === 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

const S = Float64Array.from([
  1, 0.15, 0.02,
  0.05, 1, 0.20,
  0.00, 0.08, 1,
]);
const DETECTORS = ['FITC-A', 'PE-A', 'PerCP-A'];

// Simulates true fluorochrome amounts, then observes them through S with noise.
function observe(truth, random, noise = 30) {
  const n = truth[0].length;
  const columns = {};
  DETECTORS.forEach((d) => { columns[d] = new Float32Array(n); });
  for (let e = 0; e < n; e += 1) {
    for (let j = 0; j < 3; j += 1) {
      let sum = 0;
      for (let i = 0; i < 3; i += 1) sum += truth[i][e] * S[i * 3 + j];
      columns[DETECTORS[j]][e] = sum + noise * gaussian(random);
    }
  }
  return columns;
}

function singleStain(index, n, random) {
  const truth = [0, 1, 2].map(() => new Float64Array(n));
  for (let e = 0; e < n; e += 1) truth[index][e] = e < n / 2 ? 50 * random() : 20000 + 2000 * gaussian(random);
  return observe(truth, random);
}

test('matrix inversion and condition number', () => {
  const inv = invertMatrix(S, 3);
  const product = multiplyMatrices(S, inv, 3);
  const identity = identityMatrix(3);
  for (let i = 0; i < 9; i += 1) assert.ok(Math.abs(product[i] - identity[i]) < 1e-12);
  assert.ok(conditionNumber(identity, 3) === 1);
  assert.ok(conditionNumber(S, 3) > 1);
  assert.throws(() => invertMatrix(Float64Array.from([1, 2, 2, 4]), 2), /singular/);
});

test('compensation recovers true amounts', () => {
  const random = rng(1);
  const n = 2000;
  const truth = [0, 1, 2].map(() => Float64Array.from({ length: n }, () => 1000 * random()));
  const observed = observe(truth, random, 0);
  const compensated = compensate(observed, { channels: DETECTORS, matrix: S });
  for (let i = 0; i < 3; i += 1) {
    for (let e = 0; e < n; e += 100) assert.ok(Math.abs(compensated[DETECTORS[i]][e] - truth[i][e]) < 1e-2);
  }
});

test('spillover is recovered from single-stain controls by both methods', () => {
  const random = rng(7);
  const controls = [0, 1, 2].map((i) => ({ channel: DETECTORS[i], columns: singleStain(i, 6000, random) }));
  for (const method of ['median', 'regression']) {
    const { matrix, report } = computeSpillover(controls, DETECTORS, { method, positiveFraction: 0.4, negativeFraction: 0.4 });
    for (let k = 0; k < 9; k += 1) assert.ok(Math.abs(matrix[k] - S[k]) < 0.01, `${method} entry ${k}: ${matrix[k]} vs ${S[k]}`);
    assert.equal(report.length, 3);
  }
});

test('residuals of compensated controls are near zero; a wrong matrix leaves a residual', () => {
  const random = rng(3);
  const raw = singleStain(0, 6000, random);
  const good = compensate(raw, { channels: DETECTORS, matrix: S });
  const control = { channel: 'FITC-A', columns: good };
  for (const { residual } of compensationResiduals(control, DETECTORS)) assert.ok(Math.abs(residual) < 0.01);
  const wrong = Float64Array.from(S);
  wrong[1] = 0.05; // FITC → PE undercompensated by 0.10
  const under = compensate(raw, { channels: DETECTORS, matrix: wrong });
  const residuals = compensationResiduals({ channel: 'FITC-A', columns: under }, DETECTORS);
  const pe = residuals.find((r) => r.detector === 'PE-A');
  assert.ok(Math.abs(pe.residual - 0.1) < 0.01, `residual ${pe.residual}`);
  const suggestions = leanCheck(under, DETECTORS, { positiveFraction: 0.3 });
  assert.equal(suggestions[0].from, 'FITC-A');
  assert.equal(suggestions[0].to, 'PE-A');
});

test('spillover spreading grows with spillover', () => {
  const random = rng(11);
  const controls = [0, 1, 2].map((i) => {
    const raw = singleStain(i, 8000, random);
    // Photon-counting noise: spread proportional to the square root of the signal.
    for (const d of DETECTORS) {
      const column = raw[d];
      for (let e = 0; e < column.length; e += 1) column[e] += Math.sqrt(Math.max(0, column[e])) * 3 * gaussian(random);
    }
    return { channel: DETECTORS[i], columns: compensate(raw, { channels: DETECTORS, matrix: S }) };
  });
  const { matrix } = spilloverSpreading(controls, DETECTORS);
  // FITC spills 0.15 into PE but nothing into PerCP: more spreading into PE.
  assert.ok(matrix[0 * 3 + 1] > matrix[0 * 3 + 2], `${matrix[1]} vs ${matrix[2]}`);
  assert.equal(matrix[0], 0);
});

test('off-scale events are left out of spillover from controls', () => {
  // A control whose brightest fifth is clipped at the top of the scale in both detectors: with
  // them, spillover A → B would read ~1; without, 0.2.
  const n = 5000;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let e = 0; e < n; e += 1) {
    const bright = e % 2 === 0;
    const value = bright ? 50000 + (e % 97) * 100 : 50 + (e % 13);
    a[e] = e % 10 === 0 ? 262143 : value;
    b[e] = e % 10 === 0 ? 262143 : 0.2 * value + (e % 7);
  }
  const controls = [{ channel: 'A', columns: { A: a, B: b } }];
  const clipped = computeSpillover(controls, ['A', 'B']);
  const kept = computeSpillover(controls, ['A', 'B'], { range: 262144 });
  assert.ok(clipped.matrix[1] > 0.9);
  assert.ok(Math.abs(kept.matrix[1] - 0.2) < 0.01, `${kept.matrix[1]}`);
  assert.equal(kept.report[0].saturated, 500);
  assert.match(kept.report[0].warnings.join(' '), /500 events \(10\.0%\) are off scale in A/);
});

test('robust slope ignores outliers', () => {
  const x = Float64Array.from({ length: 200 }, (_, i) => i * 10);
  const y = Float64Array.from(x, (v, i) => 0.2 * v + (i % 17 === 0 ? 5000 : 0));
  assert.ok(Math.abs(robustSlope(x, y) - 0.2) < 1e-3);
});

test('spillover strings', () => {
  assert.equal(formatSpillover({ channels: ['A', 'B'], matrix: Float64Array.from([1, 0.1, 0, 1]) }), '2,A,B,1,0.1,0,1');
});

test('checking a matrix against single-stain controls finds the wrong entry and its correction', () => {
  const random = rng(21);
  const controls = [0, 1, 2].map((i) => ({ channel: DETECTORS[i], columns: singleStain(i, 6000, random) }));
  const wrong = Float64Array.from(S);
  wrong[0 * 3 + 1] = 0.05; // FITC → PE written as 0.05, truly 0.15
  const rows = controlResiduals(controls, { channels: DETECTORS, matrix: wrong });
  assert.equal(rows[0].from, 'FITC-A');
  assert.equal(rows[0].to, 'PE-A');
  assert.ok(Math.abs(rows[0].suggested - 0.15) < 0.01, `suggested ${rows[0].suggested}`);
  // Knock-on effects through other entries (PE's own spillover into PerCP) are much smaller.
  assert.ok(Math.abs(rows[1].residual) < Math.abs(rows[0].residual) / 3);
});

test('positives brighter in several detectors are flagged as autofluorescence, not spillover', () => {
  const random = rng(5);
  const raw = singleStain(0, 6000, random);
  // The positive half (events n/2…) carries extra autofluorescence in every detector.
  for (const d of DETECTORS) for (let e = 3000; e < 6000; e += 1) raw[d][e] += 400;
  const extra = { channel: 'PE-A', columns: singleStain(1, 6000, random) };
  const rows = controlResiduals([{ channel: 'FITC-A', columns: raw }, extra], { channels: DETECTORS, matrix: S }, { broadCount: 2 });
  const fitc = rows.filter((r) => r.from === 'FITC-A');
  assert.ok(fitc.every((r) => r.broad === 2), JSON.stringify(fitc));
  assert.ok(rows.filter((r) => r.from === 'PE-A').every((r) => !r.broad));
});
