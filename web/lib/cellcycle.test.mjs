import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoPeaks,
  dnaHistogram,
  doubletDiscrimination,
  fitDeanJettFox,
  fitWatsonPragmatic,
} from './cellcycle.js';
import { createRandom } from './random.js';

// Even–odd point-in-polygon test (kept local so this test does not depend on gates.js).
function polygonTest(vertices) {
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
      const [xi, yi] = vertices[i];
      const [xj, yj] = vertices[j];
      if ((yi > y) !== (yj > y) && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
    return inside;
  };
}

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected} (tolerance ${tolerance})`);
}

// Simulated DNA content: G1 at mu1, G2 at ratio·mu1, S uniform in between; each cell's measured
// value has a constant CV. Debris is exponential near zero; aggregates are G1+G2 and G2+G2
// doublets whose noise adds in quadrature.
function simulate({ n = 100000, g1 = 0.55, s = 0.3, cv = 0.04, mu1 = 50000, ratio = 2, seed = 1, debris = 0, aggregates = 0 } = {}) {
  const random = createRandom(seed);
  const values = new Float32Array(n);
  const cell = (dna) => dna * (1 + cv * random.gaussian());
  for (let i = 0; i < n; i += 1) {
    if (random() < debris) {
      values[i] = -Math.log(1 - random()) * 0.25 * mu1;
      continue;
    }
    if (random() < aggregates) {
      values[i] = random() < 0.6 ? cell(mu1) + cell(ratio * mu1) : cell(ratio * mu1) + cell(ratio * mu1);
      continue;
    }
    const u = random();
    const dna = u < g1 ? mu1 : u < g1 + s ? mu1 * (1 + (ratio - 1) * random()) : ratio * mu1;
    values[i] = cell(dna);
  }
  return values;
}

function checkPercents(result, expected, tolerance, label) {
  close(result.percentG1, expected[0], tolerance, `${label} %G1`);
  close(result.percentS, expected[1], tolerance, `${label} %S`);
  close(result.percentG2, expected[2], tolerance, `${label} %G2`);
  close(result.percentG1 + result.percentS + result.percentG2, 100, 1e-9, `${label} sum`);
}

test('dnaHistogram bins linear values with a data-driven upper limit', () => {
  const values = Float32Array.from([-5, 0, 10, 20, 30, 40, 50, 60, 70, 1000]);
  const h = dnaHistogram(values, { bins: 10, range: [0, 100] });
  assert.equal(h.underflow, 1);
  assert.equal(h.overflow, 1);
  assert.equal(h.total, 8);
  assert.equal(h.binWidth, 10);
  assert.deepEqual(Array.from(h.counts), [1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
  close(h.centers[0], 5, 0);
  const auto = dnaHistogram(simulate({ n: 20000 }));
  assert.equal(auto.bins, 256);
  assert.ok(auto.max > 100000 && auto.max < 125000, `auto max ${auto.max}`);
  const sub = dnaHistogram(values, { bins: 10, range: [0, 100], indices: Uint32Array.from([2, 3]) });
  assert.equal(sub.total, 2);
});

test('autoPeaks finds G1 and G2, also when G2 is the tallest peak', () => {
  const h = dnaHistogram(simulate());
  const peaks = autoPeaks(h);
  close(peaks.g1.position, 50000, 500, 'G1 position');
  close(peaks.g2.position, 100000, 1500, 'G2 position');
  close(peaks.g1.sd, 2000, 300, 'G1 SD');
  // G2/M arrest: 25% G1, 15% S, 60% G2 — the tallest peak is G2, G1 sits at half its position.
  const arrested = autoPeaks(dnaHistogram(simulate({ g1: 0.25, s: 0.15, seed: 2 })));
  close(arrested.g1.position, 50000, 500, 'G1 under arrest');
  close(arrested.g2.position, 100000, 1500, 'G2 under arrest');
});

test('Dean–Jett–Fox recovers 55/30/15 at 4% CV', () => {
  const h = dnaHistogram(simulate());
  const fit = fitDeanJettFox(h);
  checkPercents(fit, [55, 30, 15], 2, 'DJF');
  close(fit.g1.mean, 50000, 150, 'G1 mean');
  close(fit.g1.cv, 0.04, 0.002, 'G1 CV');
  close(fit.g2g1Ratio, 2, 0.02, 'ratio');
  assert.ok(fit.converged);
  assert.ok(fit.reducedChiSquare < 1.6, `reduced χ² ${fit.reducedChiSquare}`);
  assert.deepEqual(fit.warnings, []);
  // Curves add up and each Gaussian component integrates to its area.
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  close(sum(fit.curves.g1), fit.g1.area, 1e-3 * fit.g1.area);
  close(sum(fit.curves.s), fit.s.area, 5e-3 * fit.s.area);
  for (let b = 0; b < h.bins; b += 17) close(fit.curves.total[b], fit.curves.g1[b] + fit.curves.s[b] + fit.curves.g2[b], 1e-9);
  // Standard errors are small but positive for 10⁵ events.
  assert.ok(fit.percentSE.g1 > 0.05 && fit.percentSE.g1 < 1, `SE %G1 ${fit.percentSE.g1}`);
});

test('Watson pragmatic recovers 55/30/15 at 4% CV', () => {
  const h = dnaHistogram(simulate());
  const fit = fitWatsonPragmatic(h);
  checkPercents(fit, [55, 30, 15], 2, 'Watson');
  close(fit.g1.cv, 0.04, 0.002, 'G1 CV');
  close(fit.g2g1Ratio, 2, 0.02, 'ratio');
  assert.deepEqual(fit.warnings, []);
  // Several noise realisations stay within 2 points.
  for (const seed of [5, 6, 7]) checkPercents(fitWatsonPragmatic(dnaHistogram(simulate({ seed }))), [55, 30, 15], 2, `Watson seed ${seed}`);
});

test('both models recover other compositions, constraints and nuisance components', () => {
  const h = dnaHistogram(simulate({ g1: 0.4, s: 0.4, seed: 3 }));
  checkPercents(fitDeanJettFox(h), [40, 40, 20], 2, 'DJF 40/40/20');
  checkPercents(fitWatsonPragmatic(h), [40, 40, 20], 2, 'Watson 40/40/20');
  const fixed = fitDeanJettFox(dnaHistogram(simulate({ seed: 4 })), { ratio: 2, cv: 0.04, equalCV: false });
  assert.equal(fixed.g2g1Ratio, 2);
  assert.equal(fixed.g1.cv, 0.04);
  assert.equal(fixed.g2.cv, 0.04);
  checkPercents(fixed, [55, 30, 15], 2, 'DJF fixed');
  const messy = dnaHistogram(simulate({ seed: 8, debris: 0.1, aggregates: 0.04 }));
  const full = fitDeanJettFox(messy, { debris: true, aggregates: true });
  checkPercents(full, [55, 30, 15], 2, 'DJF debris + aggregates');
  close(full.debris.percent, 10, 3, 'debris %');
  assert.ok(full.aggregates.area > 0);
  assert.ok(full.reducedChiSquare < 2, `reduced χ² ${full.reducedChiSquare}`);
});

test('warnings flag wide CVs and odd ratios', () => {
  const wide = fitDeanJettFox(dnaHistogram(simulate({ cv: 0.1, seed: 9 })));
  assert.ok(wide.warnings.some((w) => /CV/.test(w)), wide.warnings.join(' | '));
  const odd = fitDeanJettFox(dnaHistogram(simulate({ ratio: 1.8, seed: 10 })));
  close(odd.g2g1Ratio, 1.8, 0.02);
  assert.ok(odd.warnings.some((w) => /ratio/.test(w)), odd.warnings.join(' | '));
});

test('doubletDiscrimination suggests a width gate that keeps singlets', () => {
  const random = createRandom(12);
  const n = 20000;
  const area = new Float32Array(n);
  const width = new Float32Array(n);
  const doublet = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const dna = random() < 0.7 ? 50000 : 100000;
    if (random() < 0.08) {
      doublet[i] = 1;
      area[i] = 2 * dna * (1 + 0.04 * random.gaussian());
      width[i] = 170 + 8 * random.gaussian();
    } else {
      area[i] = dna * (1 + 0.04 * random.gaussian());
      width[i] = 100 + 0.0002 * area[i] + 5 * random.gaussian();
    }
  }
  const gate = doubletDiscrimination(area, width);
  close(gate.slope, 0.0002, 0.0001, 'slope');
  close(gate.halfWidth, 15, 2, 'half-width = 3 SD');
  const inside = polygonTest(gate.vertices);
  let keptSinglets = 0;
  let keptDoublets = 0;
  let singlets = 0;
  for (let i = 0; i < n; i += 1) {
    if (!doublet[i]) singlets += 1;
    if (inside(area[i], width[i])) {
      if (doublet[i]) keptDoublets += 1;
      else keptSinglets += 1;
    }
  }
  assert.ok(keptSinglets / singlets > 0.98, `singlets kept ${keptSinglets / singlets}`);
  assert.ok(keptDoublets < 0.01 * (n - singlets), `doublets kept ${keptDoublets}`);
});
