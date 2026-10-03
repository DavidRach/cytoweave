import assert from 'node:assert/strict';
import test from 'node:test';
import { fitProliferation, proliferationIndices } from './proliferation.js';
import { createRandom } from './random.js';

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected} (tolerance ${tolerance})`);
}

const PRECURSORS = [0.3, 0.15, 0.15, 0.15, 0.1, 0.1, 0.05];

// Dye intensities: precursor fraction Pg gives Pg·2^g cells in generation g, centered at
// peak / dilution^g with log-normal spread sdLog (decades); optional additive noise (linear).
function simulate({ precursors = PRECURSORS, n = 60000, peak = 50000, sdLog = 0.05, dilution = 2, noise = 0, seed = 1 } = {}) {
  const random = createRandom(seed);
  const cells = precursors.map((p, g) => p * 2 ** g);
  const total = cells.reduce((a, b) => a + b, 0);
  const cumulative = [];
  let acc = 0;
  for (const c of cells) {
    acc += c / total;
    cumulative.push(acc);
  }
  const values = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const u = random();
    let g = 0;
    while (g < cumulative.length - 1 && u > cumulative[g]) g += 1;
    values[i] = 10 ** (Math.log10(peak) - g * Math.log10(dilution) + sdLog * random.gaussian()) + noise * random.gaussian();
  }
  return values;
}

// Indices of the simulated culture from its precursor frequencies directly (hand formulas):
// DI = Σ g·P = 2.1; PI = 2.1/0.7 = 3; EI = Σ P·2^g = 10.4; RI = (10.4 − 0.3)/0.7; %div = 70.
const TRUE_INDICES = {
  divisionIndex: 2.1,
  proliferationIndex: 3,
  expansionIndex: 10.4,
  replicationIndex: 10.1 / 0.7,
  percentDivided: 70,
};

function checkIndices(indices, tolerance, label) {
  for (const [key, value] of Object.entries(TRUE_INDICES)) {
    close(indices[key], value, tolerance * value, `${label} ${key}`);
  }
}

test('proliferation indices follow the FlowJo / Roederer definitions', () => {
  // 100, 200, 400, 800 cells in generations 0–3 → 100 precursors each.
  const idx = proliferationIndices([100, 200, 400, 800]);
  close(idx.divisionIndex, (0 + 1 + 2 + 3) / 4, 1e-15);
  close(idx.proliferationIndex, (1 + 2 + 3) / 3, 1e-15);
  close(idx.expansionIndex, 1500 / 400, 1e-15);
  close(idx.replicationIndex, 1400 / 300, 1e-15);
  close(idx.percentDivided, 75, 1e-13);
  assert.deepEqual(Array.from(idx.precursorFrequencies), [0.25, 0.25, 0.25, 0.25]);
  const resting = proliferationIndices([1000, 0, 0]);
  assert.equal(resting.divisionIndex, 0);
  assert.equal(resting.expansionIndex, 1);
  assert.equal(resting.percentDivided, 0);
  assert.ok(Number.isNaN(resting.proliferationIndex));
  checkIndices(proliferationIndices(PRECURSORS.map((p, g) => p * 2 ** g)), 1e-12, 'exact');
});

test('fit recovers generations and indices of a simulated CFSE culture', () => {
  const fit = fitProliferation(simulate());
  assert.equal(fit.generations.length, 7);
  checkIndices(fit.indices, 0.05, 'auto');
  fit.generations.forEach((g, i) => close(g.precursorFraction, PRECURSORS[i], 0.02, `precursor fraction g${i}`));
  close(fit.undividedPeak, 50000, 1000, 'undivided peak');
  close(fit.spacingFactor, 1, 0.01, 'spacing');
  close(fit.sd, 0.05, 0.003, 'width (decades)');
  close(fit.cv, Math.sqrt(Math.expm1((0.05 * Math.LN10) ** 2)), 0.01, 'linear CV');
  assert.ok(fit.reducedChiSquare < 1.5, `reduced χ² ${fit.reducedChiSquare}`);
  assert.deepEqual(fit.warnings, []);
  // Counts are posterior assignments of all events; components add up to the total curve.
  close(fit.generations.reduce((s, g) => s + g.count, 0), 60000, 1e-6);
  for (let b = 0; b < fit.x.length; b += 13) {
    close(fit.curves.total[b], fit.curves.components.reduce((s, c) => s + c[b], 0), 1e-9);
  }
  close(fit.xLinear[100], 10 ** fit.x[100], 1e-6 * 10 ** fit.x[100]);
});

test('a user-supplied undivided peak is held fixed; wider peaks still resolve', () => {
  const fixed = fitProliferation(simulate({ seed: 3 }), { undividedPeak: 50000 });
  assert.equal(fixed.undividedPeak, 50000);
  checkIndices(fixed.indices, 0.05, 'fixed peak');
  const wide = fitProliferation(simulate({ sdLog: 0.08, seed: 2 }));
  checkIndices(wide.indices, 0.05, 'wide');
});

test('a dilution other than 2 per division is absorbed by the spacing factor', () => {
  const fit = fitProliferation(simulate({ dilution: 1.85, seed: 4 }));
  close(fit.spacingFactor, Math.log(1.85) / Math.log(2), 0.01, 'spacing factor');
  close(fit.dilutionPerGeneration, 1.85, 0.02);
  checkIndices(fit.indices, 0.05, 'dilution 1.85');
});

test('logicle scale keeps non-positive events; log10 reports them', () => {
  const values = simulate({ seed: 5, noise: 150 });
  const logicle = fitProliferation(values, { transform: { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 } });
  assert.equal(logicle.excluded, 0);
  checkIndices(logicle.indices, 0.05, 'logicle');
  const withNegatives = Float32Array.from(values);
  withNegatives[0] = -50;
  withNegatives[1] = 0;
  const log = fitProliferation(withNegatives);
  assert.equal(log.excluded, 2);
  assert.ok(log.warnings.some((w) => /non-positive/.test(w)));
});

test('an unstimulated culture shows no division', () => {
  const fit = fitProliferation(simulate({ precursors: [1], seed: 6 }), { generations: 4 });
  assert.ok(fit.indices.percentDivided < 1, `% divided ${fit.indices.percentDivided}`);
  assert.ok(fit.indices.divisionIndex < 0.02);
  assert.ok(fit.warnings.some((w) => /Less than 1%/.test(w)));
});
