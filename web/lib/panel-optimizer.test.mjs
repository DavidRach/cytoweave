import assert from 'node:assert/strict';
import test from 'node:test';
import { dyeBrightness, dyeInfo, energyTransferPairs } from './dyes.js';
import { DEFAULT_BACKGROUND_SD, assignmentFrom, backgroundCovariance, compareWithRun, designPanel, levelValue, panelProblem, searchPanel, setTerms } from './panel-optimizer.js';
import { createRandom } from './random.js';
import { INSTRUMENTS, spectralSignature, spilloverMatrix } from './simulate.js';
import { predictedSpreading, spreadModel } from './spread.js';

const aurora = INSTRUMENTS.aurora;
const detectors = aurora.detectors.map((d) => d.name);
const lasers = ['UV', 'V', 'B', 'YG', 'R'];
const noise = { detectors, c1: aurora.detectors.map((d) => d.k), lasers, laserCV: [0.03, 0.02, 0.015, 0.025, 0.02] };
const spectrum = (name) => Array.from(spectralSignature(name, aurora.detectors));
const dyesOf = (names) => names.map((name) => ({ name, spectrum: spectrum(name) }));

test('the spread terms of a dye set are spread.js\'s prediction for that panel (OLS over every detector)', () => {
  const names = ['BV421', 'BV605', 'PE', 'PE-Cy7', 'APC', 'FITC'];
  const p = panelProblem({ markers: [{ name: 'A', level: 'high' }], dyes: dyesOf(names), detectors, noise, signalScale: 12 });
  const t = setTerms(p, [0, 1, 2, 3, 4, 5]);
  const model = spreadModel({ names, detectors, spectra: names.map(spectrum) });
  const predicted = predictedSpreading(model, { c1: Float64Array.from(noise.c1), laserCV: Float64Array.from(model.lasers, (l) => noise.laserCV[lasers.indexOf(l)]) }, 1);
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 6; j += 1) {
      if (i === j) continue;
      const k = i * 6 + j;
      assert.ok(Math.abs(Math.sqrt(t.photon[k]) - predicted.photon[k]) <= 1e-8 * Math.max(1, predicted.photon[k]), `photon ${names[i]} → ${names[j]}`);
      assert.ok(Math.abs(t.laser[k] - predicted.laser[k]) <= 1e-8 * Math.max(1e-12, predicted.laser[k]), `laser ${names[i]} → ${names[j]}`);
    }
  }
  // The background: every detector's variance carried through the unmixing (twice the SD, four
  // times the variance), the assumed one by default.
  assert.ok(t.bg.every((v) => v > 0 && Number.isFinite(v)));
  const twice = panelProblem({ markers: [{ name: 'A', level: 'high' }], dyes: dyesOf(names), detectors, noise, signalScale: 12, background: { sd: new Array(detectors.length).fill(2 * DEFAULT_BACKGROUND_SD * 12) } });
  setTerms(twice, [0, 1, 2, 3, 4, 5]).bg.forEach((v, q) => assert.ok(Math.abs(v / t.bg[q] - 4) < 1e-9));
  // Linearly dependent spectra cannot be unmixed.
  const twin = panelProblem({ markers: [{ name: 'A', level: 'high' }], dyes: [...dyesOf(['PE']), { name: 'PE again', spectrum: spectrum('PE') }], detectors, noise });
  assert.equal(setTerms(twin, [0, 1]), null);
});

test('a conventional panel is compensated on its dyes\' own detectors', () => {
  const fortessa = INSTRUMENTS.fortessa;
  const fluors = ['BV421', 'FITC', 'PE', 'APC'];
  const own = ['BV421-A', 'FITC-A', 'PE-A', 'APC-A'];
  const dets = own.map((n) => fortessa.detectors.find((d) => d.name === n));
  const spill = spilloverMatrix(fluors, dets).matrix;
  const rows = fluors.map((_, i) => Array.from(spill.slice(i * 4, i * 4 + 4)));
  const conventionalNoise = { detectors: own, c1: dets.map((d) => d.k), lasers: [], laserCV: [] };
  const p = panelProblem({ markers: [{ name: 'A', level: 'high' }], dyes: fluors.map((name, i) => ({ name, spectrum: rows[i], detector: own[i] })), detectors: own, noise: conventionalNoise, square: true });
  const t = setTerms(p, [1, 2, 3]);
  const model = spreadModel({ names: fluors.slice(1), detectors: own.slice(1), spectra: rows.slice(1).map((r) => r.slice(1)) });
  const predicted = predictedSpreading(model, { c1: Float64Array.from(dets.slice(1), (d) => d.k), laserCV: new Float64Array(model.lasers.length) }, 1);
  for (let k = 0; k < 9; k += 1) assert.ok(Math.abs(Math.sqrt(t.photon[k]) - predicted.photon[k]) < 1e-9 * Math.max(1, predicted.photon[k]));
  assert.throws(() => panelProblem({ markers: [{ name: 'A', level: 'high' }], dyes: [{ name: 'X', spectrum: [1, 0, 0, 0] }], detectors: own, noise: conventionalNoise, square: true }), /no detector of its own/);
});

test('local search finds the exhaustive optimum of small panels', () => {
  const pool = ['BUV395', 'BUV737', 'BV421', 'BV605', 'BV711', 'FITC', 'PE', 'PE-Cy7', 'APC', 'APC-Cy7'];
  const random = createRandom(3);
  for (let round = 0; round < 3; round += 1) {
    const markers = Array.from({ length: 6 }, (_, k) => ({ name: `M${k}`, level: ['high', 'medium', 'low'][Math.floor(random() * 3)] }));
    const groups = [markers.slice(0, 4).map((m) => m.name), markers.slice(2).map((m) => m.name)];
    const names = pool.filter(() => random() < 0.85).slice(0, 8);
    const input = { markers, groups, dyes: dyesOf(names), detectors, noise, signalScale: 12 };
    const exact = searchPanel(panelProblem(input), { exhaustiveLimit: 1e6 });
    const local = searchPanel(panelProblem(input), { exhaustiveLimit: 0, seed: round + 1 });
    assert.equal(exact.method, 'exhaustive');
    assert.equal(local.method, 'local search');
    assert.ok(Math.abs(local.cost - exact.cost) <= 1e-9 * exact.cost, `round ${round}: ${local.cost} vs ${exact.cost}`);
  }
});

test('without spread between markers, the dim marker takes the bright dye; with fixed and excluded dyes honored', () => {
  const dyes = [{ name: 'Bright', spectrum: spectrum('BV421'), brightness: 1 }, { name: 'Dim', spectrum: spectrum('APC'), brightness: 0.1 }, { name: 'Middle', spectrum: spectrum('PE'), brightness: 0.4 }];
  const base = { dyes, detectors, noise, background: { sd: new Array(detectors.length).fill(100) }, signalScale: 1 };
  const free = designPanel({ ...base, markers: [{ name: 'Strong', level: 'high' }, { name: 'Faint', level: 'low' }] });
  assert.deepEqual(Object.fromEntries(free.assignments.map((a) => [a.marker, a.dye])), { Strong: 'Middle', Faint: 'Bright' });
  assert.equal(free.method, 'exhaustive');
  const fixed = designPanel({ ...base, markers: [{ name: 'Strong', level: 'high', dye: 'Bright' }, { name: 'Faint', level: 'low', exclude: ['Middle'] }] });
  assert.deepEqual(Object.fromEntries(fixed.assignments.map((a) => [a.marker, a.dye])), { Strong: 'Bright', Faint: 'Dim' });
  assert.equal(fixed.assignments[0].fixed, true);
  assert.throws(() => designPanel({ ...base, markers: [{ name: 'A', level: 'high', dye: 'Nope' }] }), /not among the dyes/);
  assert.throws(() => designPanel({ ...base, markers: [{ name: 'A', level: 'high', dye: 'Dim' }, { name: 'B', level: 'low', dye: 'Dim' }] }), /same dye/);
  assert.throws(() => designPanel({ ...base, markers: ['A', 'B', 'C', 'D'].map((name) => ({ name, level: 'high' })) }), /only 3 dyes/);
  assert.throws(() => levelValue('bright'), /Unknown expression level/);
  assert.equal(levelValue('5e4'), 5e4);
});

test('a design explains each marker and its alternatives, warns of energy transfer and compares other assignments', () => {
  const markers = [{ name: 'CD3', level: 'high' }, { name: 'CD4', level: 'high' }, { name: 'CD25', level: 'low' }, { name: 'CD127', level: 'medium' }];
  const result = designPanel({ markers, groups: [{ name: 'T cells', markers: ['CD3', 'CD4', 'CD25', 'CD127'] }], dyes: dyesOf(['FITC', 'PE', 'PE-Cy7', 'BV421', 'APC']), detectors, noise, signalScale: 12 }, { compare: { naive: { CD3: 'PE', CD4: 'BV421', CD25: 'FITC', CD127: 'APC' } } });
  assert.equal(result.assignments.length, 4);
  for (const row of result.assignments) {
    assert.ok(row.stainIndex > 0 && Number.isFinite(row.stainIndex));
    assert.equal(row.group, 'T cells');
    assert.ok(row.alternatives.length >= 1 && row.alternatives.every((a) => a.increase >= -1e-12));
    assert.ok(Math.abs(row.background + row.from.reduce((a, f) => a + f.share, 0) - 1) < 1e-9);
  }
  assert.ok(result.compared[0].cost >= result.cost);
  assert.ok(result.rule.cost >= result.cost);
  assert.match(result.warnings.join(' '), /No unstained control/);
  const dyes = result.assignments.map((a) => a.dye);
  if (dyes.includes('PE') && dyes.includes('PE-Cy7')) assert.ok(result.energyTransfer.some((e) => e.kind === 'tandem'));
  assert.equal(result.spread.names.length, 4);
  assert.equal(assignmentFrom(panelProblem({ markers: markers.slice(0, 2), dyes: dyesOf(['FITC', 'PE']), detectors, noise }), { CD3: 'FITC' }), null);
});

test('the dye table: names in controls, brightness, tandems and energy transfer', () => {
  assert.equal(dyeInfo('CD8 BV480').name, 'BV480');
  assert.equal(dyeInfo('PE-Dazzle 594').name, 'PE-CF594');
  assert.equal(dyeInfo('Ly6G Alexa Fluor 700').name, 'Alexa Fluor 700');
  assert.equal(dyeInfo('CD169 PE-Cy7').name, 'PE-Cy7');
  assert.equal(dyeInfo('Spark NIR 685'), null);
  assert.equal(dyeBrightness('PE'), 0.5);
  // BV605 emits at 603 nm, where APC absorbs; BV421's 421 nm is far from it.
  const pairs = energyTransferPairs([['FITC', 'PE'], ['PE', 'PE-Cy7'], ['BV421', 'APC'], ['BV605', 'APC'], ['Spark NIR 685', 'APC'], ['PE', 'FITC']]);
  assert.deepEqual(pairs.map((p) => [p.kind, p.donor, p.acceptor]), [['tandem', 'PE', 'PE-Cy7'], ['transfer', 'FITC', 'PE'], ['transfer', 'BV605', 'APC']]);
});

test('a design\'s spread against a run, and the background of an unstained control', () => {
  const spread = { names: ['A', 'B'], photon: [0, 4, 9, 0], laser: [0, 0, 0, 0] };
  const observed = { names: ['B', 'A', 'C'], observations: [{ i: 1, deltaF: 100, rows: [{ j: 0, variance: 400, se: 10 }, { j: 2, variance: 50, se: 1 }] }, { i: 0, deltaF: 100, rows: [{ j: 1, variance: 1800, se: 10 }] }] };
  const c = compareWithRun(spread, observed);
  assert.equal(c.measurable, 2);
  assert.equal(c.shared, 2);
  assert.ok(Math.abs(c.rows[0].observed - 2) < 1e-12 && Math.abs(c.rows[0].predicted - 2) < 1e-12);
  assert.ok(Math.abs(c.rows[1].observed / c.rows[1].predicted - Math.sqrt(2)) < 1e-12);
  // Correlated noise in two detectors, with a few outliers left out.
  const random = createRandom(9);
  const n = 20000;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let e = 0; e < n; e += 1) {
    const z = random.gaussian();
    a[e] = 1000 + 30 * z + 40 * random.gaussian();
    b[e] = 500 + 30 * z + 10 * random.gaussian();
    if (e % 500 === 0) a[e] = 1e6;
  }
  const { covariance } = backgroundCovariance([a, b]);
  assert.ok(Math.abs(covariance[1] / 900 - 1) < 0.12, `covariance ${covariance[1]}`);
  assert.ok(covariance[0] < 2600 * 1.05);
});
