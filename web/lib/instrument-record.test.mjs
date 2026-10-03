import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateExample } from './examples.js';
import { parseFCS } from './fcs.js';
import { SampleView } from './engine.js';
import { sampleFromDataset } from './workspace.js';
import { acquisitionDate, beadRun, instrumentOf, ljSeries, mergeRuns, runFlags, withRun } from './instrument-record.js';

test('acquisition dates and instruments are read from the keywords', () => {
  assert.equal(acquisitionDate({ $DATE: '01-OCT-2013', $BTIM: '14:05:30' }), '2013-10-01T14:05:30.000Z');
  assert.equal(acquisitionDate({ $DATE: '2026-03-02' }), '2026-03-02T00:00:00.000Z');
  assert.equal(acquisitionDate({ $DATE: 'yesterday' }), null);
  assert.deepEqual(instrumentOf({ $CYT: 'LSR II', $CYTSN: 'H47100068' }), { id: 'lsr-ii-h47100068', name: 'LSR II (H47100068)', cytometer: 'LSR II', serial: 'H47100068' });
});

test('runs of simulated beads recover Q and B, and the record follows the instrument', () => {
  const names = ['Beads_2026-03-02.fcs', 'Beads_2026-03-03.fcs', 'Beads_2026-04-03.fcs'];
  const { files } = generateExample('bead-qc', { samples: names });
  let record = { name: 'sim', runs: [] };
  const runs = [];
  const errors = [];
  for (const file of files) {
    const data = parseFCS(file.bytes).datasets[0];
    const sample = sampleFromDataset(data, { name: file.name, sha256: file.name });
    const run = beadRun(new SampleView(sample, data), sample, { peaks: 8 });
    runs.push(run);
    record = withRun(record, run);
    for (const [ch, truth] of Object.entries(file.meta.truth.detectors)) {
      const got = run.channels[ch];
      errors.push(Math.abs(got.Q - truth.Q) / truth.Q);
      assert.ok(errors.at(-1) < 0.15, `${file.name} ${ch} Q ${got.Q} vs ${truth.Q}`);
      assert.ok(got.se.Q > 0);
    }
  }
  errors.sort((a, b) => a - b);
  assert.ok(errors[Math.floor(errors.length / 2)] < 0.04, `median error ${errors[Math.floor(errors.length / 2)]}`);
  assert.equal(record.runs.length, 3);
  assert.equal(withRun(record, runs[0]).runs.length, 3, 'a run replaces itself');
  assert.ok(record.runs[0].date < record.runs[2].date);
  // The workspace's runs come first; the library adds only runs it does not have.
  const merged = mergeRuns({ runs: [runs[2]], source: 'workspace' }, { runs: record.runs, source: 'library' });
  assert.equal(merged.length, 3);
  assert.equal(merged.find((r) => r.id === runs[2].id).source, 'workspace');
  const series = ljSeries(merged, 'BV421-A', 'Q', { baseline: 2 });
  assert.equal(series.values.length, 3);
  assert.ok(series.flags[2].rules.length > 0, 'the aged PMT is flagged');
  assert.ok(runFlags(merged, 2, { baseline: 2 }).some((f) => f.channel === 'BV421-A' && f.metric === 'Q'));
});
