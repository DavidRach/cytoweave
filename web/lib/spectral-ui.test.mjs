import assert from 'node:assert/strict';
import test from 'node:test';
import {
  abundanceTransform,
  commonDetectors,
  complexityInterpretation,
  copyColumns,
  detectorTick,
  guessFluorochrome,
  laserBands,
  peakHint,
  recommendFromComparison,
  residualTransform,
  ribbonCounts,
  serializeSpectrum,
  similarPairs,
  spectralDetectors,
  thinIndices,
} from './spectral-ui.js';
import { createTransform } from './transforms.js';

const AURORA = [
  ...['FSC-A', 'FSC-H', 'SSC-A', 'SSC-H', 'SSC-B-A', 'SSC-B-H'],
  ...Array.from({ length: 16 }, (_, i) => `UV${i + 1}-A`),
  ...Array.from({ length: 16 }, (_, i) => `V${i + 1}-A`),
  ...Array.from({ length: 14 }, (_, i) => `B${i + 1}-A`),
  ...Array.from({ length: 10 }, (_, i) => `YG${i + 1}-A`),
  ...Array.from({ length: 8 }, (_, i) => `R${i + 1}-A`),
  'Time',
].map((name) => ({ name, type: /^(FSC|SSC)/.test(name) ? 'scatter' : name === 'Time' ? 'time' : 'fluorescence' }));

test('spectral detectors of an Aurora file, in laser order, and their laser bands', () => {
  const shuffled = [...AURORA].reverse();
  const detectors = spectralDetectors(shuffled, 'spectral');
  assert.equal(detectors.length, 64);
  assert.equal(detectors[0], 'UV1-A');
  assert.equal(detectors[16], 'V1-A');
  assert.equal(detectors[63], 'R8-A');
  const bands = laserBands(detectors);
  assert.deepEqual(bands.map((b) => [b.laser, b.start, b.end]), [['UV', 0, 16], ['V', 16, 32], ['B', 32, 46], ['YG', 46, 56], ['R', 56, 64]]);
  assert.equal(detectorTick('YG10-A'), '10');
  // Heights are ignored; unknown vendor names fall back to fluorescence channels of a spectral file.
  assert.equal(spectralDetectors([...AURORA, { name: 'V1-H', type: 'fluorescence' }]).length, 64);
  const sony = Array.from({ length: 20 }, (_, i) => ({ name: `FL${i + 1}-A`, type: 'fluorescence' }));
  assert.equal(spectralDetectors(sony, 'spectral').length, 20);
  assert.deepEqual(spectralDetectors(sony, 'conventional'), []);
  // An unmixed export (dye channels only) has no raw detectors.
  assert.deepEqual(spectralDetectors([{ name: 'BV421-A', type: 'fluorescence' }, { name: 'PE-A', type: 'fluorescence' }], 'spectral'), []);
  assert.deepEqual(commonDetectors([['A', 'B', 'C'], ['C', 'A'], []]), ['A', 'C']);
});

test('fluorochrome names and peak hints for controls', () => {
  const detectors = ['V1-A', 'V7-A', 'B2-A'];
  assert.equal(guessFluorochrome({ name: 'Ref_BV421', stain: 'BV421', meta: {} }, detectors), 'BV421');
  assert.equal(guessFluorochrome({ name: 'whatever', stain: 'FITC-A', meta: {} }, detectors), 'FITC');
  assert.equal(guessFluorochrome({ name: 'PE-Cy7 Stained Control', stain: 'V7-A', meta: {} }, detectors), 'PE-Cy7');
  assert.equal(guessFluorochrome({ name: 'Comp_APC (Beads)', stain: null, meta: {} }, detectors), 'APC');
  assert.equal(guessFluorochrome({ name: 'Ref_BV421', stain: 'BV421', meta: { fluorochrome: 'Super Bright 436' } }, detectors), 'Super Bright 436');
  assert.equal(peakHint({ stain: 'V7-A' }, detectors), 'V7-A');
  assert.equal(peakHint({ stain: 'BV421' }, detectors), null);
});

test('display scales for unmixed channels', () => {
  // Negatives with SD 1000 around 0 and positives up to 1e6 on a 2²² range.
  const values = Float32Array.from({ length: 10000 }, (_, i) => (i % 2 ? (((i * 7919) % 2000) - 1000) * 1.6 : 1e5 + i * 50));
  const spec = abundanceTransform(values, 4194304);
  assert.equal(spec.type, 'logicle');
  assert.equal(spec.T, 4194304);
  assert.equal(spec.M, 5.6);
  assert.ok(spec.W > 0.3 && spec.W < 2, `W ${spec.W}`);
  createTransform(spec); // valid parameters
  const small = abundanceTransform(values, 262144);
  assert.ok(Math.abs(small.M - 4.42) < 0.01);
  const residual = residualTransform(Float32Array.from({ length: 1000 }, (_, i) => i / 4000));
  assert.equal(residual.type, 'linear');
  assert.ok(residual.max >= 0.25 && residual.max <= 0.35);
  assert.deepEqual(serializeSpectrum(Float64Array.of(1, 0.1234567891, Number.NaN)), [1, 0.123457, 0]);
});

test('complexity and similarity interpretation', () => {
  assert.equal(complexityInterpretation(1.2, 5).level, 'ok');
  assert.equal(complexityInterpretation(45, 30).label, 'High');
  assert.equal(complexityInterpretation(150).level, 'danger');
  assert.equal(complexityInterpretation(Infinity).label, 'Not unmixable');
  const sim = { pairs: [{ a: 'A', b: 'B', similarity: 0.97 }, { a: 'A', b: 'C', similarity: 0.91 }, { a: 'B', b: 'C', similarity: 0.5 }] };
  assert.deepEqual(similarPairs(sim).map((p) => p.b), ['B', 'C']);
});

test('recommendation from a model comparison names the best unclipped model and warns about NNLS', () => {
  const fluor = (rsd, zero = 0) => [{ name: 'PE', negativeRSD: rsd, zeroFraction: zero, negativeMedian: 0, count: 100 }];
  const report = {
    events: 5000,
    negativeSource: 'peak-detector',
    models: [
      { name: 'OLS', method: 'ols', autofluorescence: false, brightResidual: 0.05, fluorochromes: fluor(100) },
      { name: 'OLS + AF', method: 'ols', autofluorescence: true, brightResidual: 0.02, fluorochromes: fluor(80) },
      { name: 'NNLS', method: 'nnls', autofluorescence: false, brightResidual: 0.05, fluorochromes: fluor(60, 0.48) },
    ],
    ranking: [
      { name: 'NNLS', relativeSpread: 0.6, clipped: true },
      { name: 'OLS + AF', relativeSpread: 0.8, clipped: false },
      { name: 'OLS', relativeSpread: 1, clipped: false },
    ],
  };
  const rec = recommendFromComparison(report);
  assert.equal(rec.model, 'OLS + AF');
  assert.match(rec.sentence, /20% narrower/);
  assert.ok(rec.caveats.some((c) => /clips values at zero \(up to 48%/.test(c)));
  assert.ok(rec.caveats.some((c) => /Modeling autofluorescence/.test(c)));
  assert.ok(rec.caveats.some((c) => /5,000 events/.test(c)));
  const tie = recommendFromComparison({ ...report, ranking: [{ name: 'OLS', relativeSpread: 1, clipped: false }, { name: 'OLS + AF', relativeSpread: 0.99, clipped: false }] });
  assert.match(tie.sentence, /about equally/);
});

test('spectral ribbon counts, thinning and column copies', () => {
  const scaled = [Float32Array.of(0, 0.5, 0.99, 1.2), Float32Array.of(-0.1, 0.26, 0.26, Number.NaN)];
  const grid = ribbonCounts(scaled, null, 4);
  // Detector 0: bins 0, 2, 3, 3 (1.2 piles on the top bin); detector 1: bins 0, 1, 1 (NaN dropped).
  assert.deepEqual(Array.from(grid), [1, 1, 0, 2, 1, 0, 2, 0]);
  assert.deepEqual(Array.from(ribbonCounts(scaled, Uint32Array.of(1), 4)), [0, 0, 0, 1, 1, 0, 0, 0]);
  assert.deepEqual(Array.from(thinIndices(null, 10, 5)), [0, 2, 4, 6, 8]);
  assert.equal(thinIndices(Uint32Array.of(1, 2), 10, 5).length, 2);
  const source = [Float32Array.of(1, 2, 3)];
  const copies = copyColumns(source, Uint32Array.of(2, 0));
  assert.deepEqual(Array.from(copies[0]), [3, 1]);
  assert.notEqual(copyColumns(source)[0].buffer, source[0].buffer);
});
