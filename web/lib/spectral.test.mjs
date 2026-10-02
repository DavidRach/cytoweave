import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import { median, robustSD } from './compensation.js';
import {
  autoGateControl,
  compareUnmixing,
  complexityIndex,
  detectorOrder,
  extractAutofluorescence,
  isSpectralDetector,
  parseDetectorName,
  referenceMatrix,
  referenceSpectrum,
  similarityMatrix,
  spectralSpreading,
  unmixingResidualReport,
  unmixNNLS,
  unmixOLS,
  unmixWithAutofluorescence,
  unmixWLS,
} from './spectral.js';

// --- Synthetic spectra and events -------------------------------------------------------------

// A spectrum as a sum of Gaussians over D detectors: peaks = [[center, width, height], …],
// normalized to peak 1 (as emission spread over the detector arrays of several lasers).
function spectrum(D, peaks) {
  const out = new Float64Array(D);
  for (let d = 0; d < D; d += 1) {
    for (const [center, width, height] of peaks) out[d] += height * Math.exp(-((d - center) ** 2) / (2 * width * width));
  }
  const max = Math.max(...out);
  return out.map((v) => v / max);
}

const D = 48;
const DETECTORS = Array.from({ length: D }, (_, d) => (d < 16 ? `V${d + 1}-A` : d < 30 ? `B${d - 15}-A` : `R${d - 29}-A`));
const PANEL = [
  ['BV421', [[2, 1.5, 1], [20, 3, 0.05]]],
  ['BV510', [[6, 2, 1], [22, 3, 0.1]]],
  ['BV605', [[11, 2, 1], [33, 2, 0.15]]],
  ['FITC', [[18, 2, 1], [24, 3, 0.2]]],
  ['PE', [[23, 2, 1], [8, 2, 0.08]]],
  ['PerCP', [[28, 2.5, 1], [38, 3, 0.3]]],
  ['APC', [[33, 1.5, 1], [40, 2, 0.25]]],
  ['APC-R700', [[37, 2, 1], [33, 2, 0.45]]],
];
const SPECTRA = PANEL.map(([name, peaks]) => ({ name, spectrum: spectrum(D, peaks), detectors: DETECTORS }));
const AF_A = spectrum(D, [[5, 6, 1], [21, 5, 0.5], [35, 6, 0.15]]);
const AF_B = spectrum(D, [[12, 4, 0.7], [20, 4, 1], [31, 5, 0.3]]);

// Events r = a S (+ AF) + noise with variance background + gain × max(signal, 0) (photon noise).
function simulate({ spectra, abundance, n, background = 900, gain = 1, af = null, seed = 1 }) {
  const random = createRandom(seed);
  const F = spectra.length;
  const columns = Array.from({ length: D }, () => new Float32Array(n));
  const truth = Array.from({ length: F }, () => new Float64Array(n));
  const afType = new Int32Array(n);
  const afAmount = new Float64Array(n);
  for (let e = 0; e < n; e += 1) {
    const a = new Float64Array(F);
    for (let f = 0; f < F; f += 1) {
      a[f] = abundance(f, e, random);
      truth[f][e] = a[f];
    }
    let afSig = null;
    if (af) {
      const pick = af(e, random);
      afType[e] = pick.type;
      afAmount[e] = pick.amount;
      afSig = pick.signature;
    }
    for (let d = 0; d < D; d += 1) {
      let s = 0;
      for (let f = 0; f < F; f += 1) s += a[f] * spectra[f].spectrum[d];
      if (afSig) s += afAmount[e] * afSig[d];
      const sd = Math.sqrt(background + gain * Math.max(s, 0));
      columns[d][e] = s + (background || gain ? sd * random.gaussian() : 0);
    }
  }
  return { columns, truth, afType, afAmount };
}

function cosine(x, y) {
  let xy = 0; let xx = 0; let yy = 0;
  for (let i = 0; i < x.length; i += 1) {
    xy += x[i] * y[i];
    xx += x[i] * x[i];
    yy += y[i] * y[i];
  }
  return xy / Math.sqrt(xx * yy);
}

function gramOf(spectra) {
  const F = spectra.length;
  const g = new Float64Array(F * F);
  for (let i = 0; i < F; i += 1) for (let j = 0; j < F; j += 1) g[i * F + j] = cosineless(spectra[i].spectrum, spectra[j].spectrum);
  return g;
}

function cosineless(x, y) {
  let s = 0;
  for (let i = 0; i < x.length; i += 1) s += x[i] * y[i];
  return s;
}

// --- Panel diagnostics ---------------------------------------------------------------------------

test('similarity index: 1 on the diagonal, symmetric, 0 for disjoint spectra', () => {
  const sim = similarityMatrix(SPECTRA);
  const F = SPECTRA.length;
  for (let i = 0; i < F; i += 1) {
    assert.equal(sim.matrix[i * F + i], 1);
    for (let j = 0; j < F; j += 1) assert.equal(sim.matrix[i * F + j], sim.matrix[j * F + i]);
  }
  assert.ok(Math.abs(cosine(SPECTRA[0].spectrum, SPECTRA[0].spectrum) - 1) < 1e-15);
  // A spectrum compared with itself through a copy is exactly similar.
  const self = similarityMatrix([SPECTRA[3], { name: 'copy', spectrum: SPECTRA[3].spectrum.slice() }]);
  assert.ok(Math.abs(self.matrix[1] - 1) < 1e-12);
  const disjoint = similarityMatrix([[1, 0, 0], [0, 0.5, 1]]);
  assert.equal(disjoint.matrix[1], 0);
  for (let p = 1; p < sim.pairs.length; p += 1) assert.ok(sim.pairs[p].similarity <= sim.pairs[p - 1].similarity);
  // APC and APC-R700 share a red peak: the most similar pair.
  assert.deepEqual([sim.pairs[0].a, sim.pairs[0].b].sort(), ['APC', 'APC-R700']);
});

test('complexity index: 1 for orthonormal spectra, grows with overlap, infinite for duplicates', () => {
  const orthogonal = Array.from({ length: 6 }, (_, f) => Float64Array.from({ length: 20 }, (_, d) => (d === 3 * f ? 1 : 0)));
  assert.ok(Math.abs(complexityIndex(orthogonal) - 1) < 1e-12);
  let previous = 1;
  for (const width of [1, 2, 3, 4]) {
    const set = Array.from({ length: 6 }, (_, f) => spectrum(D, [[5 + 7 * f, width, 1]]));
    const ci = complexityIndex(set);
    assert.ok(ci > previous, `width ${width}: ${ci} > ${previous}`);
    previous = ci;
  }
  assert.ok(complexityIndex([SPECTRA[0].spectrum, SPECTRA[0].spectrum]) > 1e12);
});

// --- Unmixing --------------------------------------------------------------------------------------

test('OLS recovers abundances exactly without noise, from arrays or named columns', () => {
  const n = 500;
  const { columns, truth } = simulate({ spectra: SPECTRA, n, background: 0, gain: 0, abundance: (f, e, r) => (r() - 0.2) * 1e4 });
  const result = unmixOLS(columns, SPECTRA);
  assert.deepEqual(result.names, SPECTRA.map((s) => s.name));
  for (let f = 0; f < SPECTRA.length; f += 1) {
    for (let e = 0; e < n; e += 1) assert.ok(Math.abs(result.abundances[f][e] - truth[f][e]) < 1e-2, `f${f} e${e}`);
  }
  for (let e = 0; e < n; e += 1) assert.ok(result.residuals[e] < 1e-6);
  // Named columns and a subset of events.
  const named = Object.fromEntries(DETECTORS.map((name, d) => [name, columns[d]]));
  const indices = Uint32Array.from([3, 10, 499]);
  const subset = unmixOLS(named, SPECTRA, { indices });
  indices.forEach((e, k) => assert.ok(Math.abs(subset.abundances[4][k] - truth[4][e]) < 1e-2));
  assert.throws(() => unmixOLS(columns, [SPECTRA[0], SPECTRA[0]]), /linearly dependent/);
  assert.throws(() => unmixOLS({ V1: columns[0] }, SPECTRA), /no detector "V1-A"/);
});

test('NNLS satisfies the KKT conditions and equals OLS when OLS is non-negative', () => {
  const n = 3000;
  const { columns } = simulate({
    spectra: SPECTRA,
    n,
    abundance: (f, e, r) => (r() < 0.4 ? 3000 * Math.exp(r() * 2) : 0),
  });
  const result = unmixNNLS(columns, SPECTRA);
  const ref = referenceMatrix(SPECTRA);
  const { F, matrix } = ref;
  const g = gramOf(SPECTRA);
  let zeros = 0;
  for (let e = 0; e < n; e += 1) {
    const b = new Float64Array(F);
    for (let f = 0; f < F; f += 1) for (let d = 0; d < D; d += 1) b[f] += matrix[f * D + d] * columns[d][e];
    const scale = Math.max(...b.map(Math.abs));
    for (let f = 0; f < F; f += 1) {
      const a = result.abundances[f][e];
      assert.ok(a >= 0);
      let grad = -b[f];
      for (let k = 0; k < F; k += 1) grad += g[f * F + k] * result.abundances[k][e];
      if (a > 0) assert.ok(Math.abs(grad) <= 1e-5 * scale, `stationarity e${e} f${f}: ${grad}`);
      else {
        zeros += 1;
        assert.ok(grad >= -1e-5 * scale, `dual feasibility e${e} f${f}: ${grad}`);
      }
    }
  }
  assert.ok(zeros > n, 'many abundances are clipped to zero');
  // Clearly positive, noise-free events: the OLS solution is non-negative and NNLS must equal it.
  const clean = simulate({ spectra: SPECTRA, n: 300, background: 0, gain: 0, abundance: (f, e, r) => 500 + r() * 5000 });
  const ols = unmixOLS(clean.columns, SPECTRA);
  const nnls = unmixNNLS(clean.columns, SPECTRA);
  for (let f = 0; f < F; f += 1) {
    for (let e = 0; e < 300; e += 1) assert.ok(Math.abs(nnls.abundances[f][e] - ols.abundances[f][e]) <= 1e-5 * Math.abs(ols.abundances[f][e]) + 1e-3);
  }
});

test('WLS narrows the spread that a bright co-stain imposes on a negative channel', () => {
  // Every event is bright for FITC (photon noise dominates) and negative for the overlapping PE.
  const panel = [SPECTRA[3], SPECTRA[4], SPECTRA[1]];
  const n = 4000;
  const background = new Float64Array(D).fill(100);
  const { columns } = simulate({ spectra: panel, n, background: 100, gain: 1, abundance: (f) => (f === 0 ? 50000 : 0), seed: 3 });
  const ols = unmixOLS(columns, panel);
  const wls = unmixWLS(columns, panel, { background, gain: 1 });
  // Oracle: fixed weights from the true (noise-free) signal, the best linear unbiased estimator.
  const oracleWeights = Float64Array.from(panel[0].spectrum, (v) => 1 / (100 + 50000 * v));
  const oracle = unmixWLS(columns, panel, { mode: 'fixed', weights: oracleWeights, background });
  const olsSpread = robustSD(ols.abundances[1]);
  const wlsSpread = robustSD(wls.abundances[1]);
  // Measured: OLS rSD 74.9, iteratively reweighted WLS 57.5 (23% narrower), oracle 57.7.
  assert.ok(wlsSpread < 0.8 * olsSpread, `WLS ${wlsSpread.toFixed(1)} vs OLS ${olsSpread.toFixed(1)}`);
  assert.ok(Math.abs(wlsSpread / robustSD(oracle.abundances[1]) - 1) < 0.02);
  assert.ok(Math.abs(median(wls.abundances[1])) < 0.2 * wlsSpread);
  assert.ok(Math.abs(median(wls.abundances[0]) - 50000) < 50);
  // Fixed weights from detector background: unstained events on detectors of unequal noise.
  const noisy = Float64Array.from({ length: D }, (_, d) => (d % 3 === 0 ? 250000 : 400));
  const random = createRandom(5);
  const blank = Array.from({ length: D }, (_, d) => Float32Array.from({ length: n }, () => Math.sqrt(noisy[d]) * random.gaussian()));
  const olsBlank = unmixOLS(blank, SPECTRA);
  const fixed = unmixWLS(blank, SPECTRA, { mode: 'fixed', background: noisy });
  const ratio = SPECTRA.map((_, f) => robustSD(fixed.abundances[f]) / robustSD(olsBlank.abundances[f]));
  assert.ok(Math.max(...ratio) < 0.8, `fixed-weight spread ratios ${ratio.map((v) => v.toFixed(2))}`);
  // Background estimated from an unstained control gives the same operator as the true variances.
  const fromUnstained = unmixWLS(blank, SPECTRA, { mode: 'fixed', unstainedColumns: blank });
  assert.ok(Math.abs(robustSD(fromUnstained.abundances[2]) / robustSD(fixed.abundances[2]) - 1) < 0.05);
});

// --- Reference spectra from controls -----------------------------------------------------------------

function split(truthPositive) {
  const positive = [];
  const negative = [];
  truthPositive.forEach((p, e) => (p ? positive : negative).push(e));
  return { positive: Uint32Array.from(positive), negative: Uint32Array.from(negative) };
}

function control({ target, n = 6000, positiveFraction = 0.4, brightness = 20000, mixture = null, seed = 7, afSignature = AF_A, afLevel = 800 }) {
  const random = createRandom(seed);
  const columns = Array.from({ length: D }, () => new Float32Array(n));
  const truthPositive = new Uint8Array(n);
  for (let e = 0; e < n; e += 1) {
    const positive = random() < positiveFraction;
    truthPositive[e] = positive ? 1 : 0;
    const amount = positive ? brightness * Math.exp(0.4 * random.gaussian()) : 0;
    const sig = mixture && positive && random() < mixture.fraction ? mixture.spectrum : target;
    const af = afLevel * Math.exp(0.3 * random.gaussian());
    for (let d = 0; d < D; d += 1) {
      const s = amount * sig[d] + af * afSignature[d];
      columns[d][e] = s + Math.sqrt(900 + Math.max(s, 0)) * random.gaussian();
    }
  }
  return { columns, truthPositive };
}

test('referenceSpectrum recovers a planted spectrum and reports quality', () => {
  const target = SPECTRA[4].spectrum;
  const { columns, truthPositive } = control({ target });
  const { positive, negative } = split(truthPositive);
  const ref = referenceSpectrum(columns, DETECTORS, positive, negative, { name: 'PE' });
  assert.equal(ref.peakDetector, DETECTORS[23]);
  assert.equal(ref.spectrum[23], 1);
  assert.ok(cosine(ref.spectrum, target) > 0.9995, `cosine ${cosine(ref.spectrum, target)}`);
  assert.ok(ref.quality.separation > 50);
  assert.ok(ref.quality.heterogeneity > 0.995);
  assert.deepEqual(ref.quality.warnings, []);
  assert.ok(ref.snr[23] > ref.snr[45]);
  // A dim control is flagged.
  const dim = control({ target, brightness: 600, seed: 8 });
  const dimSplit = split(dim.truthPositive);
  const dimRef = referenceSpectrum(dim.columns, DETECTORS, dimSplit.positive, dimSplit.negative);
  assert.ok(dimRef.quality.warnings.some((w) => /dim/.test(w)), dimRef.quality.warnings.join(' | '));
  // Too few positives and off-scale events are flagged.
  const few = referenceSpectrum(columns, DETECTORS, positive.subarray(0, 50), negative, { range: 30000 });
  assert.ok(few.quality.warnings.some((w) => /Only 50 positive/.test(w)));
  assert.ok(few.quality.warnings.some((w) => /top of the detector range/.test(w)));
  assert.throws(() => referenceSpectrum(columns, DETECTORS, positive, null), /negative population/);
});

test('referenceSpectrum flags a dye mixture whose composition changes with brightness', () => {
  const target = SPECTRA[3].spectrum;
  const other = SPECTRA[5].spectrum;
  const random = createRandom(11);
  const n = 3000;
  const columns = Array.from({ length: D }, () => new Float32Array(n));
  const positive = [];
  const negative = [];
  for (let e = 0; e < n; e += 1) {
    const isPositive = e % 2 === 0;
    (isPositive ? positive : negative).push(e);
    const amount = isPositive ? 30000 * Math.exp(0.6 * random.gaussian()) : 0;
    // Dim positives carry a second dye (as a degraded tandem's acceptor-free emission does).
    const share = amount && amount < 30000 ? 0.4 : 0;
    for (let d = 0; d < D; d += 1) {
      const s = amount * ((1 - share) * target[d] + share * other[d]);
      columns[d][e] = s + Math.sqrt(900 + Math.max(s, 0)) * random.gaussian();
    }
  }
  const ref = referenceSpectrum(columns, DETECTORS, Uint32Array.from(positive), Uint32Array.from(negative));
  assert.ok(ref.quality.heterogeneity < 0.98, `heterogeneity ${ref.quality.heterogeneity}`);
  assert.ok(ref.quality.warnings.some((w) => /mixture/.test(w)));
});

test('autoGateControl finds the peak detector, positives and autofluorescence-matched negatives', () => {
  const target = SPECTRA[6].spectrum;
  const { columns, truthPositive } = control({ target, positiveFraction: 0.3, seed: 12 });
  const gate = autoGateControl(columns, DETECTORS);
  assert.equal(gate.peakDetector, DETECTORS[33]);
  assert.equal(gate.negativeSource, 'internal');
  let truePos = 0;
  for (const e of gate.positive) truePos += truthPositive[e];
  assert.ok(gate.positive.length >= 200);
  assert.ok(truePos / gate.positive.length > 0.99);
  let trueNeg = 0;
  for (const e of gate.negative) trueNeg += 1 - truthPositive[e];
  assert.ok(trueNeg / gate.negative.length > 0.98);
  const ref = referenceSpectrum(columns, DETECTORS, gate.positive, gate.negative);
  assert.ok(cosine(ref.spectrum, target) > 0.999);
  // Unstained control holding two cell types (AF_A and brighter AF_B); the stained cells are
  // AF_A only. Matching negatives on dye-dark detectors removes the AF mismatch.
  const random = createRandom(13);
  const nU = 6000;
  const unstained = Array.from({ length: D }, () => new Float32Array(nU));
  for (let e = 0; e < nU; e += 1) {
    const sig = e % 2 ? AF_B : AF_A;
    const level = (e % 2 ? 4000 : 800) * Math.exp(0.3 * random.gaussian());
    for (let d = 0; d < D; d += 1) {
      const s = level * sig[d];
      unstained[d][e] = s + Math.sqrt(900 + s) * random.gaussian();
    }
  }
  const stained = control({ target, positiveFraction: 0.9, seed: 14, brightness: 8000 });
  const matched = autoGateControl(stained.columns, DETECTORS, { unstainedColumns: unstained });
  const unmatched = autoGateControl(stained.columns, DETECTORS, { unstainedColumns: unstained, matchNegatives: false });
  assert.equal(matched.negativeSource, 'unstained');
  assert.ok(matched.matchedNegatives);
  const refMatched = referenceSpectrum(stained.columns, DETECTORS, matched.positive, matched.negative, { negativeColumns: unstained });
  const refUnmatched = referenceSpectrum(stained.columns, DETECTORS, unmatched.positive, unmatched.negative, { negativeColumns: unstained });
  const errMatched = 1 - cosine(refMatched.spectrum, target);
  const errUnmatched = 1 - cosine(refUnmatched.spectrum, target);
  assert.ok(errMatched < 0.25 * errUnmatched, `matched ${errMatched} vs unmatched ${errUnmatched}`);
  assert.ok(refUnmatched.quality.warnings.some((w) => /autofluorescence/.test(w)));
});

// --- Autofluorescence ----------------------------------------------------------------------------------

function unstainedMixture(n, seed) {
  return simulate({
    spectra: [],
    n,
    abundance: () => 0,
    seed,
    af: (e, random) => {
      const type = random() < 0.6 ? 0 : 1;
      return { type, signature: type ? AF_B : AF_A, amount: (type ? 3000 : 2000) * Math.exp(0.5 * random.gaussian()) };
    },
  });
}

test('extractAutofluorescence recovers two planted signatures and their proportions', () => {
  const { columns } = unstainedMixture(8000, 21);
  const result = extractAutofluorescence(columns, DETECTORS, { seed: 4 });
  assert.equal(result.k, 2, `residual by k: ${result.residualByK.map((v) => v.toFixed(4))}`);
  const [first, second] = result.signatures;
  assert.ok(cosine(first.spectrum, AF_A) >= 0.99, `AF1 ~ A: ${cosine(first.spectrum, AF_A)}`);
  assert.ok(cosine(second.spectrum, AF_B) >= 0.99, `AF2 ~ B: ${cosine(second.spectrum, AF_B)}`);
  assert.ok(Math.abs(first.fraction - 0.6) < 0.05 && Math.abs(second.fraction - 0.4) < 0.05);
  assert.ok(result.residualByK[1] < result.residualByK[0]);
  // A single-type sample yields one signature.
  const single = simulate({ spectra: [], n: 4000, abundance: () => 0, seed: 22, af: (e, r) => ({ type: 0, signature: AF_A, amount: 2000 * Math.exp(0.5 * r.gaussian()) }) });
  const one = extractAutofluorescence(single.columns, DETECTORS, { seed: 4 });
  assert.equal(one.k, 1);
  assert.ok(cosine(one.signatures[0].spectrum, AF_A) >= 0.995);
  // Deterministic for a seed.
  const again = extractAutofluorescence(columns, DETECTORS, { seed: 4 });
  assert.deepEqual(Array.from(again.signatures[0].spectrum), Array.from(first.spectrum));
});

test('extractAutofluorescence finds two signatures when detector noise dominates each event', () => {
  // Signal norm comparable to the noise norm, as for dim lymphocytes on a spectral cytometer: the
  // median relative residual barely changes between 1 and 2 signatures; the non-noise misfit does.
  const { columns } = simulate({
    spectra: [],
    n: 8000,
    abundance: () => 0,
    seed: 23,
    background: 900,
    af: (e, random) => {
      const type = random() < 0.7 ? 0 : 1;
      return { type, signature: type ? AF_B : AF_A, amount: (type ? 90 : 45) * Math.exp(0.4 * random.gaussian()) };
    },
  });
  const result = extractAutofluorescence(columns, DETECTORS, { seed: 4 });
  assert.equal(result.k, 2, `misfit by k: ${result.misfitByK.map((v) => v.toFixed(4))}`);
  const byA = result.signatures.map((s) => cosine(s.spectrum, AF_A));
  const a = byA.indexOf(Math.max(...byA));
  assert.ok(cosine(result.signatures[a].spectrum, AF_A) > 0.97);
  assert.ok(cosine(result.signatures[1 - a].spectrum, AF_B) > 0.97);
  // Measured: median relative residual 0.716 → 0.661 (−8%), non-noise misfit 0.166 → 0.067
  // (−60%) of the signal energy, then −5% for a third signature; noise is 27% of the energy.
  assert.ok(result.residualByK[0] - result.residualByK[1] < 0.1 * result.residualByK[0]);
  assert.ok(result.misfitByK[1] < 0.5 * result.misfitByK[0]);
  assert.ok(result.noiseFraction > 0.2);
  assert.ok(Math.abs(result.signatures[a].fraction - 0.7) < 0.05);
});

test('per-event autofluorescence selection fits better than one signature and matches the full fit', () => {
  const panel = SPECTRA.slice(0, 6);
  const n = 4000;
  const { columns, afType, truth } = simulate({
    spectra: panel,
    n,
    seed: 31,
    abundance: (f, e, r) => (r() < 0.3 ? 4000 * Math.exp(0.5 * r.gaussian()) : 0),
    af: (e, random) => {
      const type = random() < 0.5 ? 0 : 1;
      return { type, signature: type ? AF_B : AF_A, amount: 5000 * Math.exp(0.3 * random.gaussian()) };
    },
  });
  const both = unmixWithAutofluorescence(columns, panel, [{ name: 'AF1', spectrum: AF_A }, { name: 'AF2', spectrum: AF_B }]);
  const single = unmixWithAutofluorescence(columns, panel, [AF_A]);
  assert.deepEqual(both.names.at(-1), 'AF');
  const medBoth = median(both.residuals);
  const medSingle = median(single.residuals);
  assert.ok(medBoth < 0.6 * medSingle, `two signatures ${medBoth.toFixed(4)} vs one ${medSingle.toFixed(4)}`);
  let correct = 0;
  for (let e = 0; e < n; e += 1) if (both.afIndex[e] === afType[e]) correct += 1;
  assert.ok(correct / n > 0.97, `AF choice accuracy ${correct / n}`);
  // Fluorochrome estimates improve: error spread of BV510 (overlaps AF) against the truth.
  const err = (result) => robustSD(Float64Array.from({ length: n }, (_, e) => result.abundances[1][e] - truth[1][e]));
  assert.ok(err(both) < 0.5 * err(single));
  // The Schur-complement shortcut equals OLS with the chosen signature appended.
  const sample = [0, 1, 2, 17, 999];
  for (const e of sample) {
    const sig = both.afIndex[e] ? AF_B : AF_A;
    const direct = unmixOLS(columns, [...panel, { name: 'AF', spectrum: sig }], { indices: Uint32Array.of(e) });
    for (let f = 0; f <= panel.length; f += 1) {
      assert.ok(Math.abs(direct.abundances[f][0] - both.abundances[f][e]) < 1e-3 * (1 + Math.abs(direct.abundances[f][0])), `e${e} f${f}`);
    }
  }
  // NNLS variant: non-negative and no worse in residual than clipping would suggest.
  const nn = unmixWithAutofluorescence(columns, panel, [AF_A, AF_B], { method: 'nnls' });
  for (let f = 0; f <= panel.length; f += 1) for (let e = 0; e < n; e += 1) assert.ok(nn.abundances[f][e] >= 0);
});

// --- Diagnostics -----------------------------------------------------------------------------------------

test('spectralSpreading reproduces the planted spreading coefficients', () => {
  const random = createRandom(41);
  const n = 20000;
  const names = ['A', 'B', 'C'];
  const deltaF = 10000;
  const coefficients = [0, 3, 0.5];
  const abundances = names.map(() => new Float32Array(2 * n));
  const positive = new Uint32Array(n);
  const negative = new Uint32Array(n);
  for (let e = 0; e < 2 * n; e += 1) {
    const pos = e < n;
    if (pos) positive[e] = e;
    else negative[e - n] = e;
    abundances[0][e] = (pos ? deltaF : 0) + 50 * random.gaussian();
    for (let j = 1; j < 3; j += 1) {
      const variance = 2500 + (pos ? coefficients[j] ** 2 * deltaF : 0);
      abundances[j][e] = Math.sqrt(variance) * random.gaussian();
    }
  }
  const ssm = spectralSpreading([{ fluorochrome: 'A', abundances, positive, negative }], names);
  assert.equal(ssm.matrix[0], 0);
  assert.ok(Math.abs(ssm.matrix[1] - 3) < 0.1, `SS_AB ${ssm.matrix[1]}`);
  assert.ok(Math.abs(ssm.matrix[2] - 0.5) < 0.05, `SS_AC ${ssm.matrix[2]}`);
  assert.ok(Number.isNaN(ssm.matrix[3]));
  // On real unmixing: a bright APC control spreads more into APC-R700 than into BV421.
  const panel = SPECTRA;
  const sim = simulate({ spectra: panel, n: 6000, seed: 42, abundance: (f, e) => (f === 6 && e % 2 === 0 ? 40000 : 0) });
  const unmixed = unmixOLS(sim.columns, panel);
  const pos = Uint32Array.from({ length: 3000 }, (_, k) => 2 * k);
  const neg = Uint32Array.from({ length: 3000 }, (_, k) => 2 * k + 1);
  const real = spectralSpreading([{ fluorochrome: 'APC', abundances: unmixed, positive: pos, negative: neg }], panel.map((s) => s.name));
  const F = panel.length;
  assert.ok(real.matrix[6 * F + 7] > 3 * real.matrix[6 * F + 0]);
});

test('residual report reveals the shape of a missing reference spectrum', () => {
  const full = SPECTRA;
  const missing = 5; // PerCP is in the sample but not in the reference set
  const reduced = full.filter((_, f) => f !== missing);
  const sim = simulate({ spectra: full, n: 3000, seed: 51, abundance: (f, e, r) => (f === missing ? 20000 : r() < 0.3 ? 5000 : 0) });
  const unmixed = unmixOLS(sim.columns, reduced);
  const report = unmixingResidualReport(sim.columns, reduced, unmixed);
  // Expected misfit: the part of PerCP's spectrum outside the span of the remaining spectra.
  const fit = unmixOLS([...full[missing].spectrum].map((v) => Float32Array.of(v)), reduced, { residuals: false });
  const expected = Float64Array.from({ length: D }, (_, d) => {
    let s = full[missing].spectrum[d];
    reduced.forEach((sp, f) => { s -= fit.abundances[f][0] * sp.spectrum[d]; });
    return s;
  });
  assert.ok(cosine(report.medianResidual, expected) > 0.99, `cosine ${cosine(report.medianResidual, expected)}`);
  assert.ok(report.medianRelativeResidual > 0.05);
  const good = unmixingResidualReport(sim.columns, full, unmixOLS(sim.columns, full));
  assert.ok(good.medianRelativeResidual < 0.5 * report.medianRelativeResidual);
  assert.equal(report.strip.matrix.length, report.strip.bins * D);
  assert.equal(report.strip.counts.reduce((a, b) => a + b, 0), report.events);
});

test('compareUnmixing ranks models by negative spread and residual', () => {
  const panel = [SPECTRA[3], SPECTRA[4], SPECTRA[1]];
  const n = 4000;
  // FITC bright on even events, PE on every fourth odd event.
  const { columns } = simulate({
    spectra: panel, n, background: 100, gain: 1, seed: 61,
    abundance: (f, e) => (f === 0 && e % 2 === 0 ? 50000 : f === 1 && e % 4 === 1 ? 20000 : 0),
  });
  const negatives = { PE: Uint32Array.from({ length: n / 2 }, (_, k) => 2 * k) };
  // A FITC reference with too low a shoulder at PE's peak (e.g. from a mismatched control).
  const wrong = [{ name: 'FITC', spectrum: spectrum(D, [[18, 2, 1], [24, 3, 0.1]]) }, panel[1], panel[2]];
  const report = compareUnmixing(columns, [
    { name: 'OLS', method: 'ols', spectra: panel },
    { name: 'WLS', method: 'wls', spectra: panel, options: { background: new Float64Array(D).fill(100) } },
    { name: 'NNLS', method: 'nnls', spectra: panel },
    { name: 'OLS, wrong FITC', method: 'ols', spectra: wrong },
  ], { negatives });
  const byName = Object.fromEntries(report.models.map((m) => [m.name, m]));
  const pe = (name) => byName[name].fluorochromes.find((f) => f.name === 'PE');
  assert.equal(report.negativeSource, 'given');
  // Measured PE rSD among FITC-bright events: OLS 72.0, WLS 60.1; the wrong FITC reference moves
  // their PE median to ≈ 5400 and raises the bright-event residual from 0.005 to 0.043.
  assert.ok(pe('WLS').negativeRSD < 0.9 * pe('OLS').negativeRSD, `${pe('WLS').negativeRSD} vs ${pe('OLS').negativeRSD}`);
  // NNLS looks narrow only because it clips at zero, which zeroFraction and `clipped` expose.
  assert.ok(pe('NNLS').zeroFraction > 0.3 && pe('OLS').zeroFraction === 0);
  assert.ok(report.ranking.find((r) => r.name === 'NNLS').clipped);
  assert.equal(report.best.PE, 'WLS');
  assert.ok(!report.ranking.find((r) => r.name === 'WLS').clipped);
  // The wrong reference shifts FITC-bright events into PE and leaves a larger residual.
  assert.ok(pe('OLS, wrong FITC').negativeMedian > 10 * pe('OLS').negativeRSD, `${pe('OLS, wrong FITC').negativeMedian}`);
  assert.ok(byName['OLS, wrong FITC'].brightResidual > 2 * byName.OLS.brightResidual);
  assert.equal(report.ranking.length, 4);
  // Unstained-control mode (with an AF model) and default peak-detector negatives.
  const blank = simulate({ spectra: panel, n: 2000, background: 100, gain: 1, seed: 62, abundance: () => 0 }).columns;
  const viaBlank = compareUnmixing(columns, [{ name: 'OLS', spectra: panel }, { name: 'OLS+AF', spectra: panel, afSignatures: [AF_A] }], { unstainedColumns: blank });
  assert.equal(viaBlank.negativeSource, 'unstained');
  assert.equal(viaBlank.models[1].fluorochromes.length, 3);
  const viaPeak = compareUnmixing(columns, [{ name: 'OLS', spectra: panel }, { name: 'WLS', method: 'wls', spectra: panel }]);
  assert.equal(viaPeak.negativeSource, 'peak-detector');
  assert.ok(viaPeak.best.PE);
});

// --- Detector names ------------------------------------------------------------------------------------------

test('detector names: parsing, recognition and laser ordering', () => {
  assert.deepEqual(parseDetectorName('V7-A'), { laser: 'V', index: 7, measurement: 'A' });
  assert.deepEqual(parseDetectorName('YG10-H'), { laser: 'YG', index: 10, measurement: 'H' });
  assert.deepEqual(parseDetectorName('UV16'), { laser: 'UV', index: 16, measurement: null });
  assert.deepEqual(parseDetectorName('BV421 (V1)'), { laser: 'V', index: 1, measurement: null });
  assert.deepEqual(parseDetectorName('PE (YG1)-A'), { laser: 'YG', index: 1, measurement: 'A' });
  assert.deepEqual(parseDetectorName('405-3-A'), { laser: 'V', index: 3, measurement: 'A', wavelength: 405 });
  assert.equal(parseDetectorName('FSC-A'), null);
  assert.equal(parseDetectorName('SSC-B-A'), null);
  assert.equal(parseDetectorName('Time'), null);
  assert.equal(isSpectralDetector('R8-A'), true);
  assert.equal(isSpectralDetector('FITC-A'), false);
  const shuffled = ['R1-A', 'FSC-A', 'B2-A', 'UV10-A', 'V1-A', 'YG1-A', 'B10-A', 'UV2-A', 'Time', 'B1-A'];
  assert.deepEqual(detectorOrder(shuffled), ['UV2-A', 'UV10-A', 'V1-A', 'B1-A', 'B2-A', 'B10-A', 'YG1-A', 'R1-A', 'FSC-A', 'Time']);
});
