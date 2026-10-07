import assert from 'node:assert/strict';
import test from 'node:test';
import { compensate, computeSpillover, spilloverSpreading } from './compensation.js';
import { population, workspaceView } from './engine.js';
import { generateExample } from './examples.js';
import { parseFCS } from './fcs.js';
import { buildPlotScene, sceneToSVG } from './plot.js';
import { fitNoise, noiseRecord, spreadModel, spreadRecord } from './spread.js';
import { fmoControlFor, fmoThreshold, scatterPopulation, spreadFor, spreadRecords, virtualFMO } from './virtual-fmo.js';
import { ROOT, addGates, createWorkspace, sampleFromDataset } from './workspace.js';

// The PBMC example with an FMO tube for CD25 and one for CD127, compensated from its controls with
// the spread fitted to them.
function example() {
  const r = generateExample('pbmc-immunophenotyping', { scale: 0.2, fmos: ['CD25', 'CD127'] });
  const datasets = new Map(r.files.map((f) => [f.name, parseFCS(f.bytes).datasets[0]]));
  const meta = r.workspaceHints.sampleMeta;
  const detectors = r.workspaceHints.compensation.controls.map((c) => c.channel);
  const pick = (d) => Object.fromEntries(detectors.map((n) => [n, d.data[d.parameters.findIndex((p) => p.name === n)]]));
  const controls = r.workspaceHints.compensation.controls.map((c) => ({ channel: c.channel, columns: pick(datasets.get(c.file)) }));
  const spill = computeSpillover(controls, detectors, { method: 'median', range: 262144 });
  const spreading = spilloverSpreading(controls.map((c) => ({ channel: c.channel, raw: c.columns, columns: compensate(c.columns, { channels: detectors, matrix: spill.matrix }) })), detectors, { range: 262144 });
  const n = detectors.length;
  const rows = Array.from({ length: n }, (_, i) => Array.from(spill.matrix.slice(i * n, i * n + n)));
  const model = spreadModel({ names: detectors, detectors, spectra: rows });
  const record = spreadRecord({ names: detectors, detectors, spectra: rows, channels: detectors, noise: noiseRecord(model, fitNoise(model, spreading.observations)) });
  let ws = createWorkspace('Virtual FMO');
  ws = {
    ...ws,
    compensations: [{ id: 'comp', name: 'From the controls', channels: detectors, matrix: Array.from(spill.matrix), spread: record }],
    samples: r.files.map((f) => ({ ...sampleFromDataset(datasets.get(f.name), { name: f.name }), id: f.name, role: meta[f.name].role ?? 'sample', stain: meta[f.name].stain ?? null, meta: { marker: meta[f.name].marker }, compensationId: 'comp' })),
  };
  ws = addGates(ws, r.workspaceHints.suggestedGates.map((g) => ({ ...g, overrides: {} }))).ws;
  const view = (id) => workspaceView(ws, ws.samples.find((s) => s.id === id), datasets.get(id));
  return { ws, record, view };
}

test('the virtual FMO of CD25 and CD127 in T cells lands where the same donor\'s FMO tubes put the negative, far above the unstained control', () => {
  const { ws, record, view } = example();
  const tCells = ws.gates.find((g) => g.name === 'T cells').id;
  const donor = view('D01_Unstim.fcs');
  const unstained = view('Unstained.fcs');
  for (const [marker, channel] of [['CD25', 'PE-A'], ['CD127', 'PE-Cy7-A']]) {
    const v = virtualFMO({ ws, view: donor, unstained, populationId: tCells, channel, record, yChannel: 'BV605-A' });
    const real = fmoThreshold({ ws, view: view(`FMO_${marker}.fcs`), populationId: tCells, channel });
    assert.ok(v.threshold / real.threshold > 0.75 && v.threshold / real.threshold < 1.33, `${marker}: virtual ${v.threshold}, real ${real.threshold}`);
    assert.ok(v.unstainedThreshold < real.threshold / 1.5, `${marker}: the unstained control alone is too low`);
    assert.ok(v.contributions.length > 0 && Math.abs(v.contributions.reduce((a, c) => a + c.share, 0) - 1) < 1e-9);
    assert.ok(v.curve.length >= 5 && v.curve.every((c) => Number.isFinite(c.threshold)));
    assert.equal(fmoControlFor(ws, channel, marker).id, `FMO_${marker}.fcs`);
  }
  // Seeded: the same prediction twice.
  const again = virtualFMO({ ws, view: donor, unstained, populationId: tCells, channel: 'PE-A', record });
  assert.equal(again.threshold, virtualFMO({ ws, view: donor, unstained, populationId: tCells, channel: 'PE-A', record }).threshold);
});

test('the unstained control gets only the population\'s scatter gates', () => {
  const { ws, view } = example();
  const unstained = view('Unstained.fcs');
  const tCells = ws.gates.find((g) => g.name === 'T cells').id;
  const base = scatterPopulation(ws, unstained, tCells);
  assert.deepEqual(base.gates, ['Cells', 'Single cells', 'Lymphocytes']);
  assert.deepEqual(base.skipped, ['Live', 'T cells']);
  assert.ok(base.indices.length > 0 && base.indices.length < unstained.eventCount);
  assert.equal(scatterPopulation(ws, unstained, ROOT).indices, null);
});

test('spread records are found on a computed compensation and in the spectral setup; without them or an unstained control, it says what is missing', () => {
  const { ws, view } = example();
  const sample = ws.samples.find((s) => s.id === 'D01_Unstim.fcs');
  assert.equal(spreadFor(ws, sample, 'PE-A').source.id, 'comp');
  assert.equal(spreadFor(ws, { ...sample, compensationId: 'none' }, 'PE-A'), null);
  const spectral = { ...ws, derived: [{ id: 'spectral-setup', kind: 'spectral-setup', spreading: { model: { ...ws.compensations[0].spread, channels: ws.compensations[0].spread.channels.map((c) => `${c} (unmixed)`) } } }] };
  assert.deepEqual(spreadRecords(spectral).map((r) => r.id), ['comp', 'spectral-setup']);
  assert.equal(spreadFor(spectral, sample, 'PE-A (unmixed)').source.id, 'spectral-setup');
  const record = ws.compensations[0].spread;
  assert.throws(() => virtualFMO({ ws, view: view('D01_Unstim.fcs'), unstained: null, channel: 'PE-A', record }), /unstained control/);
  assert.throws(() => virtualFMO({ ws, view: view('D01_Unstim.fcs'), unstained: view('Unstained.fcs'), channel: 'Time', record }), /does not cover Time/);
});

test('plot guides: a line at a value, a polyline in data units, drawn in SVG with their labels', () => {
  const xs = Float32Array.from({ length: 200 }, (_, i) => i * 10);
  const scene = buildPlotScene({
    width: 300, height: 260, type: 'pseudocolor',
    x: { channel: 'A', transform: { type: 'linear', min: 0, max: 2000 } },
    y: { channel: 'B', transform: { type: 'linear', min: 0, max: 2000 } },
    xs: Float32Array.from(xs, (v) => v / 2000), ys: Float32Array.from(xs, (v) => v / 2000), indices: null,
    guides: [{ axis: 'x', value: 500, label: 'virtual FMO' }, { points: [[400, 0], [600, 1000], [900, 2000]], dash: false }, { axis: 'y', value: Number.NaN }],
  });
  assert.equal(scene.guides.length, 2, 'a guide without a finite value is left out');
  assert.deepEqual(scene.guides[0].points, [[0.25, 0], [0.25, 1]]);
  assert.deepEqual(scene.guides[1].points[1], [0.3, 0.5]);
  const svg = sceneToSVG(scene, {});
  assert.match(svg, /stroke-dasharray="6 4"/);
  assert.match(svg, />virtual FMO</);
});
