import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCSV, csvDatasets, detectFormat, headerName, looksLikeEvents, rangeFor } from './csv-events.js';

test('formats, headers, and events told apart from annotation tables', () => {
  assert.deepEqual(detectFormat(['a;b;c', '1,5;2;3', '2,25;4;5']), { delimiter: ';', decimalComma: true });
  assert.deepEqual(detectFormat(['a\tb', '1.5\t2']), { delimiter: '\t', decimalComma: false });
  assert.deepEqual(headerName('Comp-PE-A :: CD25'), { name: 'Comp-PE-A', marker: 'CD25' });
  assert.deepEqual(headerName('"FSC-A"'), { name: 'FSC-A', marker: '' });
  const events = ['FSC-A,FITC-A', ...Array.from({ length: 10 }, (_, i) => `${i * 100},${i}`)].join('\n');
  const annotations = ['Sample,condition,dose', ...Array.from({ length: 10 }, (_, i) => `S${i},stim,${i}`)].join('\n');
  assert.equal(looksLikeEvents(events), true);
  assert.equal(looksLikeEvents(annotations), false);
});

test('columns checked: quotes, missing and bad cells, an event number, labels, and guesses', () => {
  const rows = ['"Event","FSC-A","CD3, total",Cluster,Time'];
  for (let i = 0; i < 200; i += 1) rows.push(`${i + 1},${40000 + i},${i === 5 ? 'n/a' : i === 6 ? 'high' : 100 * i},${i % 4},${i * 0.5}`);
  const a = analyzeCSV(rows.join('\n'), 'test.csv');
  const byName = Object.fromEntries(a.columns.map((c) => [c.name, c]));
  assert.equal(a.rows, 200);
  assert.ok(byName.Event.eventNumber && !byName.Event.include);
  assert.equal(byName['FSC-A'].kind, 'scatter');
  assert.equal(byName['CD3, total'].bad, 1);
  assert.equal(byName['CD3, total'].missing, 1);
  assert.match(byName['CD3, total'].note, /row 8: "high"/);
  assert.ok(byName.Cluster.labels);
  assert.equal(byName.Time.kind, 'time');
  assert.equal(rangeFor(byName['FSC-A']), 262144);
  const { datasets, dropped } = csvDatasets(a, { splitBy: byName.Cluster.index });
  assert.equal(dropped, 2);
  assert.deepEqual(datasets.map((d) => [d.name, d.rows]), [['test Cluster 0', 50], ['test Cluster 1', 49], ['test Cluster 2', 49], ['test Cluster 3', 50]]);
  assert.deepEqual(datasets[0].parameters.map((p) => p.name), ['FSC-A', 'CD3, total', 'Time']);
  assert.equal(datasets[0].keywords.CYTOWEAVE_CSV, 'test.csv');
});
