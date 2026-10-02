import assert from 'node:assert/strict';
import test from 'node:test';
import { assignNearest, centroids, clusterName, embeddingRanges, embeddingRaster, gatherMatrix, markerCandidates, pickEvents, robustRange, samplingPlan } from './explore.js';

test('sampling plans respect per-sample and total limits and reuse spare quota', () => {
  assert.deepEqual(samplingPlan([10000, 10000, 10000], 5000, 100000), [5000, 5000, 5000]);
  assert.deepEqual(samplingPlan([10000, 10000], 5000, 6000), [3000, 3000]);
  const plan = samplingPlan([1000, 10000, 10000], 5000, 12000);
  assert.equal(plan[0], 1000);
  assert.equal(plan.reduce((a, b) => a + b, 0), 11000);
  assert.ok(plan[1] <= 5000 && plan[2] <= 5000);
});

test('picked events come from the population, are distinct and reproducible', () => {
  const population = Uint32Array.from({ length: 500 }, (_, i) => i * 3);
  const a = pickEvents(population, 1500, 100, 9);
  const b = pickEvents(population, 1500, 100, 9);
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.equal(new Set(a).size, 100);
  for (const e of a) assert.equal(e % 3, 0);
  assert.equal(pickEvents(null, 50, 100, 1).length, 50);
});

test('matrices, centroids and nearest-centroid assignment', () => {
  const x = Float32Array.from([0, 0, 10, 10]);
  const y = Float32Array.from([0, 1, 10, 11]);
  const m = gatherMatrix([x, y], Uint32Array.from([0, 1, 2, 3]));
  assert.deepEqual(Array.from(m), [0, 0, 0, 1, 10, 10, 10, 11]);
  const centers = centroids(m, 4, 2, Int32Array.from([0, 0, 1, -1]), 2);
  assert.deepEqual(Array.from(centers), [0, 0.5, 10, 10]);
  assert.deepEqual(Array.from(assignNearest(Float32Array.from([1, 1, 9, 12]), 2, 2, centers, 2)), [0, 1]);
});

test('embedding rasters place points and color them', () => {
  const embedding = Float32Array.from([0, 0, 1, 1]);
  const ranges = embeddingRanges(embedding, 2);
  assert.ok(ranges[0][0] < 0 && ranges[0][1] > 1);
  const rgba = embeddingRaster(embedding, 2, [[0, 1.0001], [0, 1.0001]], 10, 10, { kind: 'category', labels: Int32Array.from([0, 1]), colors: ['#ff0000', '#0000ff'] });
  // (0, 0) is the bottom-left pixel; (1, 1) the top-right.
  const at = (x, y) => Array.from(rgba.slice((y * 10 + x) * 4, (y * 10 + x) * 4 + 4));
  assert.deepEqual(at(0, 9), [255, 0, 0, 255]);
  assert.deepEqual(at(9, 0), [0, 0, 255, 255]);
  const valued = embeddingRaster(embedding, 2, [[0, 1.0001], [0, 1.0001]], 10, 10, { kind: 'value', values: Float32Array.from([0, 1]), lo: 0, hi: 1 });
  assert.equal(valued[(9 * 10 + 0) * 4 + 3], 255);
  const density = embeddingRaster(embedding, 2, [[0, 1.0001], [0, 1.0001]], 10, 10, { kind: 'density' });
  assert.equal(density[(9 * 10 + 0) * 4 + 3], 255);
});

test('marker candidates leave out viability and DNA channels', () => {
  const view = {
    derived: new Map(),
    parameters: [
      { name: 'FITC-A', type: 'fluorescence', marker: 'CD3' },
      { name: 'BV510-A', type: 'fluorescence', marker: 'Viability' },
      { name: 'Ir191Di', type: 'fluorescence', marker: 'DNA1' },
      { name: 'FSC-A', type: 'scatter', marker: '' },
    ],
  };
  const candidates = markerCandidates(view);
  assert.deepEqual(candidates.filter((c) => c.selected).map((c) => c.name), ['FITC-A']);
  const spectral = { derived: new Map([['CD3 BV421 (unmixed)', 1], ['AF (unmixed)', 1]]), parameters: [] };
  assert.deepEqual(markerCandidates(spectral).map((c) => c.name), ['CD3 BV421 (unmixed)']);
});

test('ranges and names', () => {
  assert.deepEqual(robustRange(Float32Array.from({ length: 101 }, (_, i) => i)), [1, 99]);
  assert.equal(clusterName(2, null, 'CD3+8 CD8+6 CD4−4'), 'C3 CD3+ CD8+');
  assert.equal(clusterName(0, 'CD4 T cells', 'x'), 'CD4 T cells');
  assert.equal(clusterName(4, null, ''), 'Cluster 5');
});
