import { test } from 'node:test';
import assert from 'node:assert/strict';
import { c1FromRuns, crossValidate, detectorLaser, fitNoise, predictedSpreading, predictedVariance, spreadModel, spreadTerms } from './spread.js';
import { spectralSpreading, unmixOLS } from './spectral.js';
import { createRandom } from './random.js';

test('detectors are assigned to their lasers from spectral and BD conventional names', () => {
  assert.equal(detectorLaser('B3-A'), 'B');
  assert.equal(detectorLaser('YG1 (575)-A'), 'YG');
  assert.equal(detectorLaser('B 530/30-A'), 'B');
  assert.equal(detectorLaser('Y 586/15-A'), 'YG');
  assert.equal(detectorLaser('U 450/50-A'), 'UV');
  assert.equal(detectorLaser('FITC-A'), null);
  assert.equal(detectorLaser('FSC-A'), null);
});

// Three lasers × 8 detectors; each dye a Gaussian emission on one or two lasers.
const LASERS = ['V', 'B', 'R'];
const DETECTORS = LASERS.flatMap((l) => Array.from({ length: 8 }, (_, k) => `${l}${k + 1}-A`));
const DYES = [
  { name: 'A', laser: { V: 1 }, center: 1 },
  { name: 'B', laser: { V: 1 }, center: 4 },
  { name: 'C', laser: { V: 1, B: 0.3 }, center: 6 },
  { name: 'D', laser: { V: 0.4, B: 1 }, center: 2 },
  { name: 'E', laser: { B: 1 }, center: 0 },
  { name: 'F', laser: { B: 1 }, center: 4 },
  { name: 'G', laser: { B: 1, R: 0.5 }, center: 6.5 },
  { name: 'H', laser: { B: 0.2, R: 1 }, center: 3 },
  { name: 'I', laser: { R: 1 }, center: 0.5 },
  { name: 'J', laser: { R: 1 }, center: 5.5 },
  { name: 'K', laser: { V: 1 }, center: 7 },
  { name: 'L', laser: { R: 1 }, center: 7.5 },
];
function spectrum(dye) {
  const values = DETECTORS.map((name) => {
    const laser = name.match(/^[A-Z]+/)[0];
    const k = Number(name.match(/\d+/)[0]) - 1;
    return (dye.laser[laser] ?? 0) * Math.exp(-0.5 * ((k - dye.center) / 1.4) ** 2);
  });
  const peak = Math.max(...values);
  return values.map((v) => v / peak);
}
const SPECTRA = DYES.map((dye) => ({ name: dye.name, spectrum: spectrum(dye) }));
const TRUE_C1 = DETECTORS.map((_, d) => 2 + (d % 5));
const TRUE_CV = { V: 0.03, B: 0.01, R: 0.04 };
const C0 = 400;

// Single-stain bead controls: 4000 positives at brightness deltaF, 4000 negatives.
function controls(seed, deltaF = 20000) {
  const random = createRandom(seed);
  return SPECTRA.map((dye, i) => {
    const n = 8000;
    const columns = DETECTORS.map(() => new Float32Array(n));
    for (let e = 0; e < n; e += 1) {
      const level = e < n / 2 ? deltaF * Math.exp(0.05 * random.gaussian()) : 0;
      const factor = Object.fromEntries(LASERS.map((l) => [l, Math.exp(TRUE_CV[l] * random.gaussian() - 0.5 * TRUE_CV[l] ** 2)]));
      DETECTORS.forEach((name, d) => {
        const signal = level * dye.spectrum[d] * factor[name.match(/^[A-Z]+/)[0]];
        columns[d][e] = signal + Math.sqrt(C0 + TRUE_C1[d] * signal) * random.gaussian();
      });
    }
    const positive = Uint32Array.from({ length: n / 2 }, (_, k) => k);
    const negative = Uint32Array.from({ length: n / 2 }, (_, k) => n / 2 + k);
    return { fluorochrome: i, abundances: unmixOLS(columns, SPECTRA, { residuals: false }), positive, negative };
  });
}

test('unmixing cancels a dye exactly, so its photon terms are non-negative and a single laser adds nothing', () => {
  const model = spreadModel({ names: SPECTRA.map((s) => s.name), detectors: DETECTORS, spectra: SPECTRA.map((s) => s.spectrum) });
  assert.deepEqual(model.lasers, LASERS);
  const { F, D, P, S } = model;
  for (let i = 0; i < F; i += 1) {
    for (let j = 0; j < F; j += 1) {
      let sum = 0;
      for (let d = 0; d < D; d += 1) sum += P[d * F + j] * S[i * D + d];
      assert.ok(Math.abs(sum - (i === j ? 1 : 0)) < 1e-9);
    }
  }
  const single = spreadTerms(model, 0, 1); // dye A is excited by the violet laser only
  assert.ok(single.photon.every((v) => v >= 0));
  assert.ok(single.laser.every((v) => v < 1e-20));
  const dual = spreadTerms(model, 2, 0); // dye C, violet and blue
  assert.ok(Math.max(...dual.laser) > 1e-6);
});

test('the noise fitted to controls recovers each detector\'s photon noise and each laser\'s CV', () => {
  const list = controls(5);
  const names = SPECTRA.map((s) => s.name);
  const observed = spectralSpreading(list, names);
  const model = spreadModel({ names, detectors: DETECTORS, spectra: SPECTRA.map((s) => s.spectrum) });
  const noise = fitNoise(model, observed.observations);
  // A dye on two lasers informs only the sum of their variances (its two laser terms are equal):
  // dyes C and D give V + B, G and H give B + R.
  const v = (l) => noise.laserCV[model.lasers.indexOf(l)] ** 2;
  for (const [a, b] of [['V', 'B'], ['B', 'R']]) {
    const truth = TRUE_CV[a] ** 2 + TRUE_CV[b] ** 2;
    assert.ok(Math.abs(v(a) + v(b) - truth) / truth < 0.25, `${a}+${b}: ${Math.sqrt(v(a) + v(b))} vs ${Math.sqrt(truth)}`);
  }
  // Per-detector values are only loosely determined (several combinations of detectors explain
  // the same spread); the predictions below are what matters.
  const errors = [];
  DETECTORS.forEach((_, d) => { if (noise.identified[d]) errors.push(Math.abs(noise.c1[d] / TRUE_C1[d] - 1)); });
  errors.sort((a, b) => a - b);
  assert.ok(errors.length >= 20, `${errors.length} identified`);
  assert.ok(errors[Math.floor(errors.length / 2)] < 0.3, `median error ${errors[Math.floor(errors.length / 2)]}`);

  // The predicted matrix at the controls' brightness matches the observed one.
  const brightness = observed.observations.map((o) => o.deltaF);
  const predicted = predictedSpreading(model, noise, brightness);
  const ratios = [];
  for (let k = 0; k < predicted.matrix.length; k += 1) if (observed.matrix[k] > 1) ratios.push(predicted.matrix[k] / observed.matrix[k]);
  ratios.sort((a, b) => a - b);
  assert.ok(Math.abs(ratios[Math.floor(ratios.length / 2)] - 1) < 0.1, `median ratio ${ratios[Math.floor(ratios.length / 2)]}`);

  // Each control predicted from the others.
  const check = crossValidate(model, observed.observations);
  assert.ok(check.measurable > 10);
  assert.ok(check.within2x > 0.9, `within 2×: ${check.within2x}`);
  assert.ok(check.correlation > 0.9, `r ${check.correlation}`);
});

test('laser noise grows with brightness, photon noise does not', () => {
  const names = SPECTRA.map((s) => s.name);
  const model = spreadModel({ names, detectors: DETECTORS, spectra: SPECTRA.map((s) => s.spectrum) });
  const noise = { c1: Float64Array.from(TRUE_C1), laserCV: Float64Array.from(model.lasers, (l) => TRUE_CV[l]) };
  const dim = predictedSpreading(model, noise, 1000);
  const bright = predictedSpreading(model, noise, 100000);
  const F = names.length;
  // Dye G (blue and red) into J (red): more spread per √ΔF when brighter.
  assert.ok(bright.matrix[6 * F + 9] > 1.2 * dim.matrix[6 * F + 9]);
  // Dye A (violet only) into B: the same at any brightness.
  assert.ok(Math.abs(bright.matrix[0 * F + 1] - dim.matrix[0 * F + 1]) < 1e-9);
  const photonOnly = predictedVariance(model, { c1: noise.c1, laserCV: new Float64Array(3) }, 0, 1, 1000);
  assert.ok(Math.abs(photonOnly - 1000 * dim.photon[1] ** 2) < 1e-9 * photonOnly);
});

test('photon noise from bead runs: only the laser CVs are fitted', () => {
  const names = SPECTRA.map((s) => s.name);
  const model = spreadModel({ names, detectors: DETECTORS, spectra: SPECTRA.map((s) => s.spectrum) });
  const runs = [{ channels: Object.fromEntries(DETECTORS.slice(0, 20).map((d, k) => [d, { c: [C0, TRUE_C1[k], 1e-4] }])) }];
  const beads = c1FromRuns(model, runs);
  assert.equal(beads.found.reduce((a, b) => a + b), 20);
  assert.equal(beads.c1[3], TRUE_C1[3]);
  assert.ok(Number.isFinite(beads.c1[22]), 'detectors without beads take the median');
  const observed = spectralSpreading(controls(9), names);
  const noise = fitNoise(model, observed.observations, { c1: beads.c1 });
  assert.equal(noise.source, 'beads');
  const v = (l) => noise.laserCV[model.lasers.indexOf(l)] ** 2;
  const truth = TRUE_CV.B ** 2 + TRUE_CV.R ** 2;
  assert.ok(Math.abs(v('B') + v('R') - truth) / truth < 0.25);
  assert.equal(c1FromRuns(model, []), null);
});

test('a noise model is kept by detector name and applied to another panel', async () => {
  const { noiseOn, noiseRecord, spreadReceived } = await import('./spread.js');
  const names = SPECTRA.map((s) => s.name);
  const model = spreadModel({ names, detectors: DETECTORS, spectra: SPECTRA.map((s) => s.spectrum) });
  const noise = { c1: Float64Array.from(TRUE_C1), laserCV: Float64Array.from(model.lasers, (l) => TRUE_CV[l]), source: 'controls' };
  const kept = JSON.parse(JSON.stringify(noiseRecord(model, noise, { workspace: 'W' })));
  assert.equal(kept.workspace, 'W');
  // A smaller panel on the same detectors.
  const sub = spreadModel({ names: names.slice(0, 6), detectors: DETECTORS, spectra: SPECTRA.slice(0, 6).map((s) => s.spectrum) });
  const applied = noiseOn(sub, kept);
  assert.deepEqual(Array.from(applied.c1), TRUE_C1);
  assert.ok(Math.abs(applied.laserCV[sub.lasers.indexOf('R')] - TRUE_CV.R) < 1e-6);
  assert.equal(noiseOn(spreadModel({ names: ['A'], detectors: ['X1-A'], spectra: [[1]] }), kept), null, 'other detectors');
  const received = spreadReceived(predictedSpreading(sub, applied, 20000));
  assert.equal(received.length, 6);
  assert.ok(received.every((v) => v >= 0));
});

test('a detector no dye reaches takes the common photon noise, not zero', () => {
  const model = spreadModel({ names: ['A', 'B'], detectors: ['V1-A', 'V2-A', 'V3-A', 'V4-A'], spectra: [[1, 0.5, 0.1, 0], [0.2, 1, 0.6, 0]] });
  const observations = [0, 1].map((i) => ({ i, deltaF: 1e5, rows: [{ j: 1 - i, variance: 3e5, se: 1e4 }] }));
  const noise = fitNoise(model, observations);
  assert.ok(Math.abs(noise.c1[3] - noise.common) < 1e-6 * noise.common, `${noise.c1[3]} vs ${noise.common}`);
  assert.equal(noise.identified[3], 0);
});

test('negative spectrum values in dark detectors add no photon noise', () => {
  const model = spreadModel({ names: ['A', 'B'], detectors: ['V1-A', 'V2-A', 'V3-A'], spectra: [[1, 0.3, -0.002], [-0.001, 1, 0.4]] });
  const predicted = predictedSpreading(model, { c1: Float64Array.from([2, 2, 2]), laserCV: new Float64Array(1) }, 1000);
  assert.ok(predicted.matrix.every(Number.isFinite));
  assert.ok(spreadTerms(model, 0, 1).photon.every((v) => v >= 0));
});
