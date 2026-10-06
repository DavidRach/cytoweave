import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import { logLogistic } from './curves.js';
import { beadAssay, classifyBeads, concentrationOf, findBeadLevels, mfiOf, standardConcentrations, standardCurve, standardMode } from './beadassay.js';

function gaussian(random) {
  return random() + random() + random() + random() + random() + random() - 3;
}

// Beads at classification levels (log10 centers), with a reporter per level.
function beads(random, centers, n, reporter = () => 100) {
  const classification = [];
  const signal = [];
  centers.forEach((c, k) => {
    for (let i = 0; i < n; i += 1) {
      classification.push(10 ** (c + 0.03 * gaussian(random)));
      signal.push(reporter(k) * Math.exp(0.1 * gaussian(random)));
    }
  });
  return { classification: Float32Array.from(classification), reporter: Float32Array.from(signal) };
}

test('bead levels: the expected number, dim to bright, and every bead assigned to its own', () => {
  const random = createRandom(2);
  const centers = [2.9, 3.5, 4.0, 4.6];
  const { classification } = beads(random, centers, 300);
  const found = findBeadLevels(classification, 4);
  assert.equal(found.levels.length, 4);
  found.levels.forEach((l, k) => assert.ok(Math.abs(l.median - centers[k]) < 0.01, `${l.median} vs ${centers[k]}`));
  const labels = classifyBeads(classification, found.levels);
  let right = 0;
  labels.forEach((l, i) => { if (l === Math.floor(i / 300)) right += 1; });
  assert.ok(right / labels.length > 0.99, `${right} of ${labels.length}`);
  // Without a count, the peaks found; asking for more than there are fails.
  assert.equal(findBeadLevels(classification).levels.length, 4);
  assert.throws(() => findBeadLevels(classification, 6), /4 bead levels found where 6/);
  // Values already on a log-like scale.
  const asinh = Float32Array.from(classification, (v) => Math.asinh(v));
  assert.equal(findBeadLevels(asinh, 4, { scale: 'linear' }).levels.length, 4);
});

test('MFIs and standards', () => {
  assert.equal(mfiOf([1, 2, 100]), 2);
  assert.ok(Math.abs(mfiOf([1, 100], 'geometric') - 10) < 1e-12);
  assert.equal(standardMode(['C7', 'C6', 'C0']), 'levels-top-high');
  assert.equal(standardMode(['10000', '2500', '0']), 'concentration');
  const c = standardConcentrations(['C7', 'C6', 'C1', 'C0'], { top: 10000, factor: 4 });
  assert.equal(c.get('C7'), 10000);
  assert.equal(c.get('C6'), 2500);
  assert.equal(c.get('C1'), 10000 / 4 ** 6);
  assert.equal(c.get('C0'), 0);
  const s = standardConcentrations(['S1', 'S2', 'Blank'], { mode: 'levels-top-low', top: 500, factor: 2 });
  assert.deepEqual([s.get('S1'), s.get('S2'), s.get('Blank')], [500, 250, 0]);
});

test('a standard curve: recovery, quantifiable range, LOD and concentrations', () => {
  const truth = { b: -1.0, c: 40, d: 50000, e: 5000, f: 0.9 };
  const random = createRandom(7);
  const standards = [];
  for (let level = 0; level <= 7; level += 1) {
    const concentration = level ? 10000 / 4 ** (7 - level) : 0;
    for (let r = 0; r < 2; r += 1) standards.push({ concentration, mfi: logLogistic(concentration, truth) * (1 + 0.02 * gaussian(random)) + 0.5 * gaussian(random) });
  }
  const curve = standardCurve(standards, { model: 'LL.5', weighting: '1/y2' });
  assert.ok(curve.fit.rising);
  assert.ok(curve.lloq <= 40 && curve.uloq === 10000, `${curve.lloq}–${curve.uloq}`);
  assert.ok(curve.lod > 0 && curve.lod < curve.lloq);
  const mid = concentrationOf(curve, logLogistic(300, truth), 2);
  assert.ok(Math.abs(mid.value / 600 - 1) < 0.1, `${mid.value}`);
  assert.equal(mid.flag, 'ok');
  assert.equal(concentrationOf(curve, 30).flag, 'below curve');
  assert.equal(concentrationOf(curve, logLogistic(30000, truth)).flag, '> ULOQ');
});

test('the whole assay: levels pooled across wells, curves per analyte, replicates per specimen', () => {
  const random = createRandom(11);
  const truths = [{ b: -1, c: 40, d: 40000, e: 4000, f: 1 }, { b: -1.2, c: 60, d: 60000, e: 7000, f: 0.8 }];
  const wells = [];
  for (let level = 0; level <= 7; level += 1) {
    const concentration = level ? 10000 / 4 ** (7 - level) : 0;
    for (let r = 0; r < 2; r += 1) wells.push({ id: `std${level}${r}`, name: `C${level}-${r}`, meta: { standard: `C${level}` }, groups: [beads(random, [3, 4], 200, (k) => logLogistic(concentration, truths[k]))] });
  }
  const sera = [[30, 900], [1200, 15]];
  sera.forEach(([a, b], k) => {
    for (let r = 0; r < 2; r += 1) wells.push({ id: `s${k}${r}`, name: `S${k}-${r}`, meta: { specimen: `S${k}`, dilution: '2' }, groups: [beads(random, [3, 4], 200, (j) => logLogistic([a, b][j] / 2, truths[j]))] });
  });
  const r = beadAssay(wells, { groups: [{ name: 'Beads', analytes: ['IL-6', 'TNF'] }], top: 10000, factor: 4, dilutionField: 'dilution', sampleField: 'specimen', weighting: '1/y2' });
  assert.equal(r.analytes.length, 2);
  assert.equal(r.wells.filter((w) => w.kind === 'blank').length, 2);
  for (const [k, specimen] of r.samples.entries()) {
    for (const [j, name] of ['IL-6', 'TNF'].entries()) {
      const got = specimen.results[name].mean;
      assert.ok(Math.abs(got / sera[k][j] - 1) < 0.15, `${specimen.name} ${name}: ${got} vs ${sera[k][j]}`);
      assert.equal(specimen.results[name].n, 2);
    }
  }
});
