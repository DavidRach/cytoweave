import assert from 'node:assert/strict';
import test from 'node:test';
import { SampleView } from './engine.js';
import { addGates, createWorkspace } from './workspace.js';
import { commonChannels, concatenatedFCS, downsample, selectEvents, sharedCompensation } from './events.js';
import { parseFCS } from './fcs.js';

const lin = { type: 'linear', min: 0, max: 1000 };

function experiment() {
  const samples = [0, 1, 2].map((k) => ({ id: `s${k}`, name: `S${k}`, sha256: `${k}`.repeat(64), role: 'sample', meta: {}, channels: [] }));
  const views = new Map(samples.map((s, k) => {
    const parameters = [{ index: 0, name: 'A', type: 'fluorescence', range: 1024 }, { index: 1, name: 'B', type: 'fluorescence', range: 1024 }];
    if (k === 2) parameters.push({ index: 2, name: 'C', type: 'fluorescence', range: 1024 });
    const data = parameters.map((_, j) => Float32Array.from({ length: 100 }, (__, e) => e * 10 + j + k));
    return [s.id, new SampleView(s, { eventCount: 100, parameters, data, keywords: { $CYT: 'Test' } })];
  }));
  let ws = { ...createWorkspace('t'), samples };
  ws = addGates(ws, [{ id: 'hi', name: 'High A', parentId: null, type: 'range', dims: [{ channel: 'A', transform: lin }], geometry: { min: 0.5, max: null } }]).ws;
  return { ws, views, viewOf: (id) => views.get(id) };
}

test('downsampling: sizes, seeds and the indices kept sorted and inside the population', () => {
  const indices = Uint32Array.from({ length: 50 }, (_, i) => i * 2);
  assert.equal(downsample(indices, { mode: 'none' }, 'k'), indices);
  const picked = downsample(indices, { mode: 'count', value: 10, seed: 3 }, 'k');
  assert.equal(picked.length, 10);
  assert.ok(picked.every((v, i) => v % 2 === 0 && (i === 0 || v > picked[i - 1])));
  assert.deepEqual(Array.from(downsample(indices, { mode: 'count', value: 10, seed: 3 }, 'k')), Array.from(picked));
  assert.notDeepEqual(Array.from(downsample(indices, { mode: 'count', value: 10, seed: 3 }, 'other')), Array.from(picked));
  assert.equal(downsample(indices, { mode: 'fraction', value: 0.25, seed: 1 }, 'k').length, 13);
  assert.equal(downsample(indices, { mode: 'count', value: 500, seed: 1 }, 'k'), indices);
});

test('a concatenated file: common channels, SampleID and SourceEvent, the samples named', () => {
  const { ws, viewOf } = experiment();
  const { items } = selectEvents(ws, viewOf, { populationId: 'hi', downsample: { mode: 'count', value: 5, seed: 2 } });
  assert.deepEqual(items.map((it) => [it.indices.length, it.total]), [[5, 50], [5, 50], [5, 50]]);
  assert.deepEqual(commonChannels(items), { channels: ['A', 'B'], dropped: ['C'] });
  assert.equal(sharedCompensation(items).shared, true);
  const { bytes, report } = concatenatedFCS(ws, items, { populationId: 'hi', downsample: { mode: 'count', value: 5, seed: 2 } });
  const d = parseFCS(bytes).datasets[0];
  assert.deepEqual(d.parameters.map((p) => p.name), ['A', 'B', 'SampleID', 'SourceEvent']);
  assert.equal(d.eventCount, 15);
  assert.deepEqual(report.dropped, ['C']);
  for (let i = 0; i < 15; i += 1) {
    const k = d.data[2][i] - 1;
    const e = d.data[3][i];
    assert.equal(d.data[0][i], e * 10 + k);
    assert.ok(e >= 50);
  }
  assert.equal(d.keywords.CYTOWEAVE_SAMPLE_2, 'S1');
  assert.match(d.keywords.$COM, /High A, downsampled to 5 events per sample \(seed 2\)/);
});
