import assert from 'node:assert/strict';
import test from 'node:test';
import { SampleView } from './engine.js';
import { addGates, createWorkspace } from './workspace.js';
import { expandReport, fillPlaceholders, fillStatistics, followedSample, reportFields, statsLayout } from './reports.js';
import { prismTables, tablesWorkbook } from './spreadsheets.js';
import { columnLabel, tableCells } from './tables.js';

const lin = { type: 'linear', min: 0, max: 1000 };

// Six tubes: subjects A–C × unstim/stim, and a control without a subject; FL1 of tube k is k.
function experiment() {
  const names = [['A', 'unstim'], ['A', 'stim'], ['B', 'unstim'], ['B', 'stim'], ['C', 'unstim'], ['C', 'stim'], [null, null]];
  const views = new Map();
  const samples = names.map(([subject, condition], k) => {
    const id = `s${k}`;
    const values = Float32Array.from({ length: 100 }, (_, e) => (e < 10 * (k + 1) ? 800 : 100));
    const record = { id, name: subject ? `${subject} ${condition}` : 'Control', role: subject ? 'sample' : 'unstained', meta: subject ? { subject, condition } : {}, channels: [{ name: 'FL1', type: 'fluorescence', range: 1024 }], keywords: {} };
    views.set(id, new SampleView(record, { eventCount: 100, parameters: [{ index: 0, name: 'FL1', type: 'fluorescence', range: 1024 }], data: [values], keywords: {} }));
    return record;
  });
  let ws = { ...createWorkspace('Test'), samples };
  ws = addGates(ws, [{ id: 'pos', name: 'Positive', parentId: null, type: 'range', dims: [{ channel: 'FL1', transform: lin }], geometry: { min: 0.5, max: null } }]).ws;
  const table = { id: 't', name: 'Table', columns: [{ id: 'c1', gateId: 'pos', stat: 'freqParent' }, { id: 'c2', gateId: 'pos', stat: 'count' }] };
  const plot = (id, sampleId) => ({ id, kind: 'plot', x: 0, y: 0, w: 100, h: 100, sampleId, spec: { populationId: 'root', x: 'FL1', y: null, type: 'histogram', options: {} } });
  const figure = { id: 'f', name: 'F', width: 800, height: 600, items: [plot('p1', 's0'), plot('p2', 's0'), plot('p3', 's1'), plot('p4', 's6'), { id: 't1', kind: 'text', text: '{subject} {condition} {page}/{pages} {unknown}', x: 0, y: 0, w: 100, h: 20 }, { id: 'st', kind: 'stats', x: 0, y: 200, w: 400, h: 100, tableId: 't', rows: 'page' }] };
  return { ws: { ...ws, tables: [table], figures: [figure] }, figure, viewOf: (id) => views.get(id) ?? null };
}

test('placeholders, fields and the followed sample', () => {
  const { ws, figure } = experiment();
  assert.equal(fillPlaceholders('{Page} of {pages}: {x}', { page: '2', pages: '5' }), '2 of 5: {x}');
  assert.deepEqual(reportFields(ws), ['condition', 'subject']);
  assert.equal(followedSample(figure), 's0');
});

test('by sample: the followed sample\'s plots move, the others stay; statistics list the page\'s samples', () => {
  const { ws, figure, viewOf } = experiment();
  const report = expandReport(ws, figure, { by: 'sample', date: new Date('2026-10-04T00:00:00Z') });
  assert.equal(report.pages.length, 6, 'the control is not iterated');
  const page = report.pages[2];
  assert.deepEqual(page.items.filter((i) => i.kind === 'plot').map((i) => i.sampleId), ['s2', 's2', 's1', 's6']);
  assert.equal(page.items.find((i) => i.id === 't1').text, 'B unstim 3/6 {unknown}', 'the page\'s sample\'s annotations');
  const trace = fillStatistics(ws, report, viewOf);
  const stats = page.items.find((i) => i.kind === 'stats');
  assert.deepEqual(stats.rowIds, ['s2', 's1', 's6']);
  assert.deepEqual(stats.content.rows.map((r) => r.cells.map((c) => c.text)), [['30.0', '30'], ['20.0', '20'], ['70.0', '70']]);
  assert.equal(trace.filter((t) => t.page === 3).length, 6);
  assert.ok(trace.every((t) => t.source === 'table' && t.table === 'Table'));
});

test('by an annotation: plots match on what tells the figure\'s samples apart, and gaps are reported', () => {
  const { ws, figure } = experiment();
  const without = { ...ws, samples: ws.samples.filter((s) => s.id !== 's5') };
  const report = expandReport(without, figure, { by: 'subject' });
  assert.deepEqual(report.pages.map((p) => p.label), ['subject A', 'subject B', 'subject C']);
  const plots = (p) => p.items.filter((i) => i.kind === 'plot').map((i) => i.sampleId);
  assert.deepEqual(plots(report.pages[1]), ['s2', 's2', 's3', 's6']);
  assert.deepEqual(plots(report.pages[2]), ['s4', 's4', null, 's6']);
  assert.match(report.pages[2].items.find((i) => i.id === 'p3').missing, /subject C with condition = stim/);
  assert.equal(report.notes.length, 1);
  assert.equal(report.pages[1].items.find((i) => i.id === 't1').text, 'B unstim, stim 2/3 {unknown}');
  // A figure on one sample: each subject's tube sharing its annotations (unstim), without a note.
  const single = { ...figure, items: figure.items.filter((i) => i.kind !== 'plot' || i.sampleId === 's0') };
  const once = expandReport(ws, single, { by: 'subject' });
  assert.deepEqual(once.pages.map((p) => p.items.find((i) => i.id === 'p1').sampleId), ['s0', 's2', 's4']);
  assert.deepEqual(once.notes, []);
  assert.throws(() => expandReport(ws, figure, { by: 'batch' }), /None of the figure's plots is on a sample with a "batch" annotation/);
  assert.throws(() => expandReport(ws, { ...figure, items: [] }, { by: 'sample' }), /no plots/);
});

test('a figure of statistics alone lists the table\'s rows', () => {
  const { ws, figure, viewOf } = experiment();
  const only = { ...figure, items: figure.items.filter((i) => i.kind === 'stats') };
  const report = expandReport(ws, only, { by: null });
  fillStatistics(ws, report, viewOf);
  assert.deepEqual(report.pages[0].items[0].rowIds, ['s0', 's1', 's2', 's3', 's4', 's5']);
});

test('a statistics table shrinks its text to fit, then counts the rows left out', () => {
  const content = { header: ['Population: % of parent', 'Count'], rows: Array.from({ length: 30 }, (_, i) => ({ name: `Sample ${i}`, cells: [{ value: i, text: String(i) }, { value: i, text: String(i) }] })) };
  const roomy = statsLayout(content, 500, 2000, 11);
  assert.equal(roomy.size, 11);
  assert.equal(roomy.hidden, 0);
  const tight = statsLayout(content, 500, 200, 11);
  assert.equal(tight.size, 7);
  assert.ok(tight.hidden > 0 && tight.height <= 200);
  assert.ok(tight.cells.some((c) => c.lines[0] === `+ ${tight.hidden} more rows`));
});

test('tables: cells as shown, a workbook with its provenance sheets, and Prism tables by group', () => {
  const { ws, viewOf } = experiment();
  const table = ws.tables[0];
  assert.equal(columnLabel(ws, table.columns[0]), 'Positive: % of parent');
  assert.deepEqual(tableCells(ws, table, viewOf).cell(0, 's3'), { value: 40, text: '40.0', status: null, tag: '' });
  const book = tablesWorkbook(ws, [table], viewOf, { version: 'test', date: new Date('2026-10-04T00:00:00Z') });
  assert.deepEqual(book.sheets.map((s) => s.name), ['Table', 'Columns', 'Samples', 'Populations', 'About']);
  assert.deepEqual(book.sheets[0].rows[1].slice(0, 6), ['A unstim', '', 'A', 'unstim', 10, 10]);
  assert.equal(book.traced.length, 12);
  const prism = prismTables(ws, table, viewOf, { groupBy: 'condition' });
  assert.equal(prism.tables.length, 3);
  assert.deepEqual(prism.tables[1].columns.map((c) => [c.title, c.values]), [['unstim', [10, 30, 50]], ['stim', [20, 40, 60]]]);
});
