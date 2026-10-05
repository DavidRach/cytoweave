import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDesign, clusterCounts, differentialState, stateMarkerCandidates, stateMedians, stateMethods } from './differential.js';
import { SampleView } from './engine.js';
import { ROOT, addGates, createWorkspace } from './workspace.js';

function view(id, columns) {
  const names = Object.keys(columns);
  const record = { id, name: id, role: 'sample', technology: 'mass', channels: names.map((name) => ({ name, type: 'fluorescence', marker: name === 'cluster' ? '' : name })) };
  return new SampleView(record, { eventCount: columns[names[0]].length, parameters: names.map((name, index) => ({ index, name, type: 'fluorescence', marker: name === 'cluster' ? '' : name, range: 1024 })), data: names.map((n) => Float32Array.from(columns[n])), keywords: {} });
}

test('cluster counts and medians of asinh(x / cofactor) per cluster, as diffcyt computes them', () => {
  const v = view('s1', { cluster: [0, 0, 1, 1, 1, 0, -1, 2], CD25: [5, 15, 0, 10, 20, 25, 99, 40], CD3: [1, 1, 1, 1, 1, 1, 1, 1] });
  const ws = createWorkspace('t');
  const counts = clusterCounts(v, ws, 'cluster', ROOT);
  assert.deepEqual([...counts.counts].sort(), [[0, 3], [1, 3], [2, 1]]);
  assert.equal(counts.total, 8);
  const m = stateMedians(v, ws, { kind: 'clusters', channel: 'cluster', parentId: ROOT, labels: [0, 1, 2, 3] }, ['CD25', 'CD3'], 5);
  assert.deepEqual(Array.from(m.counts), [3, 3, 1, 0]);
  assert.equal(m.medians[0][0], Math.asinh(15 / 5));
  assert.equal(m.medians[0][1], Math.asinh(10 / 5));
  assert.equal(m.medians[0][2], Math.asinh(8));
  assert.ok(Number.isNaN(m.medians[0][3]));
  // An even count: the mean of the two middle values (R's median).
  const even = stateMedians(view('s2', { cluster: [0, 0, 0, 0], CD25: [5, 10, 20, 40] }), ws, { kind: 'clusters', channel: 'cluster', parentId: ROOT }, ['CD25'], 5);
  assert.deepEqual(even.units, [0]);
  assert.equal(even.medians[0][0], (Math.asinh(2) + Math.asinh(4)) / 2);
});

test('medians of gated populations', () => {
  const v = view('s1', { cluster: [0, 0, 0, 0, 0, 0], CD25: [5, 50, 100, 500, 1000, 2000] });
  const lin = { type: 'linear', min: 0, max: 5000 };
  const { ws } = addGates(createWorkspace('t'), [{ id: 'hi', name: 'CD25 high', parentId: null, type: 'range', dims: [{ channel: 'CD25', transform: lin }], geometry: { min: 0.05, max: null } }]);
  const m = stateMedians(v, ws, { kind: 'populations', gateIds: [ROOT, 'hi'] }, ['CD25'], 150);
  assert.deepEqual(Array.from(m.counts), [6, 3]);
  assert.equal(m.medians[0][1], Math.asinh(1000 / 150));
});

test('the design: treatment contrasts, pairing as a fixed effect, single-level covariates left out', () => {
  const samples = ['A', 'B', 'C'].flatMap((donor) => ['unstim', 'stim'].map((group) => ({ group, meta: { donor, batch: 'one' } })));
  const { design, coefficient, covariates } = buildDesign(samples, { levels: ['unstim', 'stim'], pairField: 'donor', covariates: ['batch'] });
  assert.equal(coefficient, 'group[stim]');
  assert.deepEqual(design.names, ['(Intercept)', 'group[stim]', 'donor[B]', 'donor[C]']);
  assert.deepEqual(covariates, ['donor']);
  assert.throws(() => buildDesign(samples.slice(0, 3), { levels: ['unstim', 'stim'], pairField: 'donor' }), /coefficients but only 3 samples/);
});

test('diffcyt-DS-limma: clusters with too few cells left out, rows marker by marker, a planted shift found', () => {
  // Eight samples, two groups; three clusters, the last with fewer than 3 cells in most samples.
  const S = 8;
  const units = [1, 2, 3];
  const markers = ['CD25', 'CD3'];
  const counts = Array.from({ length: S }, (_, s) => Float64Array.from([200 + 10 * s, 150 + 5 * s, s < 3 ? 5 : 1]));
  const medians = Array.from({ length: S }, (_, s) => {
    const stim = s >= S / 2;
    const jitter = (k) => 0.05 * Math.sin(7 * s + 3 * k);
    return [[1 + jitter(1) + (stim ? 1 : 0), 2 + jitter(2), 0.5 + jitter(3)], [3 + jitter(4), 3.5 + jitter(5), 1 + jitter(6)]];
  });
  const design = { matrix: Array.from({ length: S }, (_, s) => [1, s >= S / 2 ? 1 : 0]), names: ['(Intercept)', 'group[stim]'] };
  const result = differentialState({ counts, medians, design, coefficient: 'group[stim]', units, markers });
  assert.deepEqual(result.kept, [1, 2]);
  assert.deepEqual(result.filtered, [3]);
  assert.deepEqual(result.rows.map((r) => `${r.marker}:${r.unit}`), ['CD25:1', 'CD25:2', 'CD3:1', 'CD3:2']);
  assert.ok(result.rows[0].padj < 1e-6 && Math.abs(result.rows[0].logFC - 1) < 0.1);
  assert.ok(result.rows.slice(1).every((r) => r.padj > 0.05));
  assert.throws(() => differentialState({ counts, medians, design, coefficient: 'group[stim]', units, markers, minCells: 1000 }), /no cluster or population has at least 1000 cells/);
  const text = stateMethods({ unitsLabel: '2 clusters (FlowSOM)', markers, contrastLabel: 'stim', referenceLabel: 'unstim', cofactor: 5, minCells: 3, minSamples: 4, tested: 4 });
  assert.match(text, /diffcyt-DS-limma \(Weber et al\. 2019\)/);
  assert.match(text, /arcsinh\(x \/ 5\)/);
});

test('state markers: the markers a clustering did not use', () => {
  const v = view('s1', { cluster: [0], CD3: [1], CD4: [1], CD25: [1] });
  const { state, clustering } = stateMarkerCandidates(v, { params: { markers: ['CD3', 'CD4'] } });
  assert.deepEqual(state.map((c) => c.name), ['CD25']);
  assert.deepEqual(clustering.map((c) => c.name), ['CD3', 'CD4']);
  assert.deepEqual(stateMarkerCandidates(v, null).state.map((c) => c.name), ['CD3', 'CD4', 'CD25']);
});
