import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import { quantileSorted } from './stats.js';
import {
  applyCytoNorm,
  batchDiagnostics,
  beadBaseline,
  beadNormalize,
  confoundingCheck,
  cytoNormProbabilities,
  evaluateSpline,
  findMassChannel,
  monotoneSpline,
  otsuThreshold,
  quantileNormalize,
  trainCytoNorm,
} from './normalize.js';

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected} (tolerance ${tolerance})`);
}

function medianOf(column, indices = null) {
  const values = indices ? Float64Array.from(indices, (i) => column[i]) : Float64Array.from(column);
  return quantileSorted(values.sort(), 0.5);
}

const ARCSINH = { type: 'arcsinh', cofactor: 5, max: 10000 };
const TRANSFORMS = { CD3: ARCSINH, CD4: ARCSINH };

// Two markers in arcsinh(x/5) units; batch B is batch A scaled and shifted there:
// t_B = scale·t_A + shift (per cluster when `clusterShift` is given).
function simulateBatch(seed, n, { scale = 1, shift = 0, clusterShift = null } = {}) {
  const random = createRandom(seed);
  const cd3 = new Float32Array(n);
  const cd4 = new Float32Array(n);
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const cluster = random() < 0.3 ? 0 : 1;
    labels[i] = cluster;
    let t3 = cluster === 0 ? 1.5 + 0.3 * random.gaussian() : 4 + 0.35 * random.gaussian();
    let t4 = cluster === 0 ? 2.5 + 0.3 * random.gaussian() : 3.5 + 0.35 * random.gaussian();
    if (clusterShift) {
      t3 += clusterShift[cluster];
      t4 += clusterShift[cluster];
    } else {
      t3 = scale * t3 + shift;
      t4 = scale * t4 + shift;
    }
    cd3[i] = 5 * Math.sinh(t3);
    cd4[i] = 5 * Math.sinh(t4);
  }
  return {
    sample: {
      eventCount: n,
      channels: [{ name: 'CD3', type: 'fluorescence', range: 10000 }, { name: 'CD4', type: 'fluorescence', range: 10000 }],
      columns: { CD3: cd3, CD4: cd4 },
    },
    labels,
  };
}

test('monotone spline (R monoH.FC) matches hand-computed values', () => {
  // splinefun(c(1,2,3,4), c(0,1,1,2), method = 'monoH.FC'): slopes become 1, 0, 0, 1.
  const spline = monotoneSpline([1, 2, 3, 4], [0, 1, 1, 2]);
  assert.deepEqual(spline.m, [1, 0, 0, 1]);
  close(evaluateSpline(spline, 1.5), 0.625, 1e-12);
  close(evaluateSpline(spline, 2.5), 1, 1e-12);
  close(evaluateSpline(spline, 3.5), 1.375, 1e-12);
  // Linear extrapolation with the end slopes.
  close(evaluateSpline(spline, 0), -1, 1e-12);
  close(evaluateSpline(spline, 5), 3, 1e-12);
  // Straight lines are reproduced exactly.
  const line = monotoneSpline([0, 1, 3, 7], [1, 3, 7, 15]);
  for (const v of [-2, 0.3, 2.2, 6.9, 10]) close(evaluateSpline(line, v), 2 * v + 1, 1e-12);
  // Tied x are merged with the mean y.
  const tied = monotoneSpline([0, 1, 1, 2], [0, 1, 3, 4]);
  assert.deepEqual(tied.x, [0, 1, 2]);
  assert.deepEqual(tied.y, [0, 2, 4]);
});

test('monotone spline interpolates its knots exactly and is monotone between them', () => {
  const random = createRandom(21);
  for (let trial = 0; trial < 20; trial += 1) {
    const x = [];
    const y = [];
    let xv = 0;
    let yv = 0;
    for (let k = 0; k < 15; k += 1) {
      xv += 0.05 + random() * 2;
      yv += random() < 0.3 ? 0 : random() ** 3 * 5; // flat stretches and sharp steps
      x.push(xv);
      y.push(yv);
    }
    const spline = monotoneSpline(x, y);
    for (let k = 0; k < x.length; k += 1) assert.equal(evaluateSpline(spline, x[k]), y[k]);
    let previous = -Infinity;
    for (let v = x[0] - 1; v <= x[x.length - 1] + 1; v += 0.003) {
      const value = evaluateSpline(spline, v);
      assert.ok(value >= previous - 1e-12, `not monotone at ${v}`);
      previous = value;
    }
  }
});

test("CytoNorm quantiles are CytoNorm 2.x's: 0.01 … 0.99 by default", () => {
  const p = cytoNormProbabilities();
  assert.equal(p.length, 99);
  close(p[0], 0.01, 1e-15);
  close(p[49], 0.5, 1e-15);
  close(p[98], 0.99, 1e-15);
  close(cytoNormProbabilities(101)[0], 1 / 102, 1e-15);
});

test('CytoNorm aligns two batches with a known shift and scale and preserves rank order', () => {
  const anchorA = simulateBatch(1, 60000);
  const anchorB = simulateBatch(2, 60000, { scale: 1.15, shift: 0.4 });
  const model = trainCytoNorm([{ sample: anchorA.sample, batch: 'A' }, { sample: anchorB.sample, batch: 'B' }], { channels: ['CD3', 'CD4'], transforms: TRANSFORMS });
  assert.deepEqual(model.batches, ['A', 'B']);
  assert.ok(JSON.parse(JSON.stringify(model)).splines['0'].B.CD3.x.length > 50, 'the model is plain JSON');
  const validA = simulateBatch(3, 60000);
  const validB = simulateBatch(4, 60000, { scale: 1.15, shift: 0.4 });
  const normA = applyCytoNorm(model, validA.sample, 'A');
  const normB = applyCytoNorm(model, validB.sample, 'B');
  for (const name of ['CD3', 'CD4']) {
    const before = [medianOf(validA.sample.columns[name]), medianOf(validB.sample.columns[name])];
    assert.ok(Math.abs(before[1] / before[0] - 1) > 0.5, `${name} differs before: ${before}`);
    const after = [medianOf(normA.columns[name]), medianOf(normB.columns[name])];
    assert.ok(Math.abs(after[1] - after[0]) / ((after[0] + after[1]) / 2) < 0.02, `${name} medians after: ${after}`);
    // Rank order of events is preserved.
    const original = validB.sample.columns[name];
    const normalized = normB.columns[name];
    const order = Uint32Array.from({ length: original.length }, (_, i) => i).sort((a, b) => original[a] - original[b]);
    for (let k = 1; k < order.length; k += 1) assert.ok(normalized[order[k]] >= normalized[order[k - 1]], `${name} rank order broken at ${k}`);
  }
  // Untouched channels are passed through.
  assert.throws(() => applyCytoNorm(model, validA.sample, 'C'), /no reference sample/);
});

test('clustered CytoNorm corrects cluster-specific batch effects', () => {
  const shift = { clusterShift: [0.6, -0.4] };
  const anchorA = simulateBatch(5, 60000);
  const anchorB = simulateBatch(6, 60000, shift);
  const model = trainCytoNorm([
    { sample: anchorA.sample, batch: 'A', labels: anchorA.labels },
    { sample: anchorB.sample, batch: 'B', labels: anchorB.labels },
  ], { channels: ['CD3', 'CD4'], transforms: TRANSFORMS });
  assert.deepEqual(model.clusters, [0, 1]);
  const validA = simulateBatch(7, 60000);
  const validB = simulateBatch(8, 60000, shift);
  const normA = applyCytoNorm(model, validA.sample, 'A', validA.labels);
  const normB = applyCytoNorm(model, validB.sample, 'B', validB.labels);
  assert.throws(() => applyCytoNorm(model, validB.sample, 'B'), /cluster label/);
  for (const cluster of [0, 1]) {
    const inA = [];
    const inB = [];
    validA.labels.forEach((l, i) => { if (l === cluster) inA.push(i); });
    validB.labels.forEach((l, i) => { if (l === cluster) inB.push(i); });
    for (const name of ['CD3', 'CD4']) {
      const a = medianOf(normA.columns[name], inA);
      const b = medianOf(normB.columns[name], inB);
      assert.ok(Math.abs(a - b) / ((a + b) / 2) < 0.02, `cluster ${cluster} ${name}: ${a} vs ${b}`);
    }
  }
});

test('a batch with minCells or fewer cells in a cluster is left out of that goal and left unchanged there', () => {
  const shift = { clusterShift: [0.6, -0.4] };
  const anchorA = simulateBatch(9, 20000);
  const full = simulateBatch(10, 20000, shift);
  // Batch B keeps only 40 of its cluster-0 events (CytoNorm's minCells is 50).
  const keep = [];
  let small = 0;
  full.labels.forEach((l, i) => { if (l === 1 || small++ < 40) keep.push(i); });
  const pick = (column) => Float32Array.from(keep, (i) => column[i]);
  const anchorB = {
    sample: { ...full.sample, eventCount: keep.length, columns: { CD3: pick(full.sample.columns.CD3), CD4: pick(full.sample.columns.CD4) } },
    labels: Int32Array.from(keep, (i) => full.labels[i]),
  };
  const model = trainCytoNorm([
    { sample: anchorA.sample, batch: 'A', labels: anchorA.labels },
    { sample: anchorB.sample, batch: 'B', labels: anchorB.labels },
  ], { channels: ['CD3', 'CD4'], transforms: TRANSFORMS });
  assert.ok(model.warnings.some((w) => /only 40 cells in batch B \(50 or fewer\)/.test(w)), model.warnings.join(' | '));
  const validA = simulateBatch(11, 20000);
  const validB = simulateBatch(12, 20000, shift);
  const normA = applyCytoNorm(model, validA.sample, 'A', validA.labels);
  const normB = applyCytoNorm(model, validB.sample, 'B', validB.labels);
  for (const name of ['CD3', 'CD4']) {
    let moved = 0;
    validB.labels.forEach((l, i) => {
      const before = validB.sample.columns[name][i];
      const after = normB.columns[name][i];
      if (l === 0) assert.equal(after, before, `${name}: batch B's sparse cluster is left unchanged`);
      else if (Math.abs(after - before) > 1e-3 * Math.abs(before)) moved += 1;
    });
    assert.ok(moved > 10000, `${name}: batch B's other cluster is normalized (${moved} moved)`);
    // The goal of cluster 0 is batch A's own quantiles, so batch A is mapped onto itself there.
    validA.labels.forEach((l, i) => {
      if (l === 0) close(normA.columns[name][i], validA.sample.columns[name][i], 1e-3 * Math.max(1, Math.abs(validA.sample.columns[name][i])), `${name}: batch A, cluster 0`);
    });
  }
});

test('quantile normalization maps every sample onto the mean distribution', () => {
  const a = simulateBatch(9, 20000);
  const b = simulateBatch(10, 20000, { scale: 0.9, shift: -0.3 });
  const { samples } = quantileNormalize([a.sample, b.sample], ['CD3'], { transforms: TRANSFORMS });
  const ma = medianOf(samples[0].columns.CD3);
  const mb = medianOf(samples[1].columns.CD3);
  assert.ok(Math.abs(ma - mb) / ((ma + mb) / 2) < 0.01, `${ma} vs ${mb}`);
});

test('batch diagnostics show the batch distance shrinking after CytoNorm', () => {
  const anchorA = simulateBatch(11, 15000);
  const anchorB = simulateBatch(12, 15000, { scale: 1.15, shift: 0.4 });
  const model = trainCytoNorm([{ sample: anchorA.sample, batch: 'A' }, { sample: anchorB.sample, batch: 'B' }], { channels: ['CD3', 'CD4'], transforms: TRANSFORMS });
  const samples = [simulateBatch(13, 15000).sample, simulateBatch(14, 15000, { scale: 1.15, shift: 0.4 }).sample];
  const after = [applyCytoNorm(model, samples[0], 'A'), applyCytoNorm(model, samples[1], 'B')];
  const diagnostics = batchDiagnostics(samples, ['A', 'B'], ['CD3', 'CD4'], { after, transforms: TRANSFORMS });
  for (const entry of diagnostics.channels) {
    assert.ok(entry.improved);
    assert.ok(entry.meanEmdAfter < 0.25 * entry.meanEmdBefore, `${entry.channel}: ${entry.meanEmdBefore} → ${entry.meanEmdAfter}`);
    assert.ok(entry.maxKsAfter < 0.03, `${entry.channel} KS after ${entry.maxKsAfter}`);
    // With two equally weighted batches, each is equally far from the pool.
    close(entry.before.A.emd, entry.before.B.emd, 1e-9);
  }
  // Identical batches are at distance zero.
  const same = batchDiagnostics([samples[0], samples[0]], ['A', 'B'], ['CD3'], { transforms: TRANSFORMS });
  close(same.channels[0].meanEmdBefore, 0, 1e-12);
});

test('confounding check: Cramér\'s V and one-batch conditions', () => {
  // [[10, 5], [5, 10]]: χ² = 4 × 2.5² / 7.5 = 3.333, V = √(3.333 / 30) = 1/3.
  const design = [];
  const add = (batch, condition, count) => { for (let i = 0; i < count; i += 1) design.push({ batch, condition }); };
  add('B1', 'ctrl', 10);
  add('B1', 'stim', 5);
  add('B2', 'ctrl', 5);
  add('B2', 'stim', 10);
  const moderate = confoundingCheck(design);
  close(moderate.chiSquare, 10 / 3, 1e-12);
  close(moderate.cramersV, 1 / 3, 1e-12);
  assert.equal(moderate.confounded, false);
  const confounded = confoundingCheck({ batches: ['B1', 'B1', 'B2', 'B2'], conditions: ['ctrl', 'ctrl', 'stim', 'stim'] });
  close(confounded.cramersV, 1, 1e-12);
  assert.equal(confounded.confounded, true);
  assert.match(confounded.warnings.join(' '), /Cramér's V = 1\.00/);
  assert.match(confounded.warnings.join(' '), /"stim" was acquired only in batch "B2"/);
  const balanced = confoundingCheck({ batches: ['B1', 'B1', 'B2', 'B2'], conditions: ['ctrl', 'stim', 'ctrl', 'stim'] });
  assert.equal(balanced.cramersV, 0);
  assert.deepEqual(balanced.warnings, []);
});

// CyTOF-like run: cells and EQ beads over 600 s; every mass channel loses sensitivity linearly
// (× (1 − 0.35 t / 600)).
function simulateCytof(seed, n = 60000, beadFraction = 0.12) {
  const random = createRandom(seed);
  const g = random.gaussian;
  const names = ['Ce140Di', 'Eu151Di', 'Eu153Di', 'Ho165Di', 'Lu175Di', 'Ir191Di', 'Nd146Di', 'Time', 'Event_length'];
  const columns = Object.fromEntries(names.map((name) => [name, new Float32Array(n)]));
  const isBead = new Uint8Array(n);
  const beadLevel = { Ce140Di: 1200, Eu151Di: 3000, Eu153Di: 3300, Ho165Di: 2500, Lu175Di: 2000 };
  for (let i = 0; i < n; i += 1) {
    const t = (600 * i) / n;
    const drift = 1 - (0.35 * t) / 600;
    columns.Time[i] = t * 1000; // ms-like units
    columns.Event_length[i] = 20 + 5 * random();
    if (random() < beadFraction) {
      isBead[i] = 1;
      for (const [name, level] of Object.entries(beadLevel)) columns[name][i] = drift * level * Math.exp(0.1 * g());
      columns.Ir191Di[i] = Math.abs(2 * g());
      columns.Nd146Di[i] = Math.abs(2 * g());
    } else {
      for (const name of Object.keys(beadLevel)) columns[name][i] = Math.abs(3 * g());
      columns.Ir191Di[i] = drift * 800 * Math.exp(0.15 * g());
      columns.Nd146Di[i] = drift * 400 * Math.exp(0.2 * g());
    }
  }
  const channels = names.map((name) => ({ name, type: name === 'Time' ? 'time' : name === 'Event_length' ? 'instrument' : 'fluorescence', range: 0 }));
  return { sample: { eventCount: n, channels, columns }, isBead };
}

function decileRatio(column, indices) {
  const k = Math.floor(indices.length / 10);
  return medianOf(column, indices.slice(indices.length - k)) / medianOf(column, indices.slice(0, k));
}

test('bead normalization finds the beads and removes a linear time drift', () => {
  const { sample, isBead } = simulateCytof(31);
  assert.equal(findMassChannel(sample, 'Eu151'), 'Eu151Di');
  assert.equal(findMassChannel(sample, 'Yb176'), null);
  const result = beadNormalize(sample);
  let agree = 0;
  for (let i = 0; i < isBead.length; i += 1) if (result.beadMask[i] === isBead[i]) agree += 1;
  assert.ok(agree / isBead.length > 0.999, `bead identification ${agree}`);
  assert.deepEqual(result.dnaChannels, ['Ir191Di']);
  const cells = [];
  const beads = [];
  isBead.forEach((b, i) => (b ? beads : cells).push(i));
  // Before: 1 − 0.35 × 0.9 ≈ 0.69 between the first and last decile; after: within 2%.
  const before = decileRatio(sample.columns.Nd146Di, cells);
  assert.ok(before < 0.75, `drift before ${before}`);
  for (const name of ['Nd146Di', 'Ir191Di']) {
    const ratio = decileRatio(result.columns[name], cells);
    assert.ok(Math.abs(ratio - 1) < 0.02, `${name} residual drift ${ratio}`);
  }
  for (const name of ['Ce140Di', 'Eu151Di', 'Lu175Di']) {
    const ratio = decileRatio(result.columns[name], beads);
    assert.ok(Math.abs(ratio - 1) < 0.02, `${name} bead residual drift ${ratio}`);
    // Normalized beads sit at the baseline (the median bead intensity).
    close(medianOf(result.columns[name], beads) / result.baseline[name], 1, 0.02, name);
  }
  // Time and instrument channels are untouched; beads are flagged for removal.
  assert.equal(result.columns.Time, sample.columns.Time);
  assert.equal(result.columns.Event_length, sample.columns.Event_length);
  assert.equal(result.mask.reduce((s, v) => s + v, 0), isBead.length - result.beadCount);
  // A shared baseline from several files is the mean of their bead medians.
  const baseline = beadBaseline([sample, sample]);
  close(baseline.Ce140, medianOf(sample.columns.Ce140Di, beads), 1e-3);
});

test('Otsu threshold separates two well-separated modes', () => {
  const random = createRandom(4);
  const values = Float64Array.from({ length: 5000 }, (_, i) => (i < 4500 ? 1 : 6) + 0.3 * random.gaussian());
  const threshold = otsuThreshold(values);
  assert.ok(threshold > 2 && threshold < 5, `${threshold}`);
});
