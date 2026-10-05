import assert from 'node:assert/strict';
import test from 'node:test';
import { columnName, sheetNames, writeXLSX } from './xlsx.js';
import { readZip } from './zip.js';
import { parseXML, findAll, attr, child, textContent } from './xml.js';

test('column names and sheet names', () => {
  assert.deepEqual([0, 25, 26, 51, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AZ', 'ZZ', 'AAA']);
  assert.deepEqual(sheetNames(['Tregs: % [CD25]', 'tregs: % [cd25]', 'History', 'A'.repeat(40), '']), ['Tregs  %  CD25', 'tregs  %  cd25 (2)', 'History (table)', 'A'.repeat(31), 'Sheet']);
});

test('a workbook keeps numbers exactly, text as shared strings and empty cells empty', async () => {
  const value = 0.1 + 0.2;
  const bytes = await writeXLSX([
    { name: 'Data', rows: [[{ value: 'Sample', style: 'header' }, { value: 'Freq', style: 'header' }], ['A & B <1>', value], ['C', Number.NaN], ['D', 1e-7]], widths: [20, 10], freeze: { rows: 1, columns: 1 } },
    { name: 'About', rows: [['Exported', ' leading space']] },
  ], { date: new Date('2026-10-04T00:00:00Z') });
  const files = await readZip(bytes);
  const xml = (name) => parseXML(new TextDecoder().decode(files.get(name)));
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'docProps/core.xml', 'docProps/app.xml']) assert.ok(files.has(name), name);
  const strings = findAll(xml('xl/sharedStrings.xml'), 'si').map(textContent);
  const cells = findAll(xml('xl/worksheets/sheet1.xml'), 'c');
  const cell = (ref) => cells.find((c) => attr(c, 'r') === ref);
  assert.equal(strings[Number(textContent(child(cell('A2'), 'v')))], 'A & B <1>');
  assert.equal(Number(textContent(child(cell('B2'), 'v'))), value);
  assert.equal(cell('B3'), undefined);
  assert.equal(textContent(child(cell('B4'), 'v')), '1e-7');
  assert.equal(attr(cell('A1'), 's'), '1');
  assert.equal(attr(findAll(xml('xl/worksheets/sheet1.xml'), 'pane')[0], 'topLeftCell'), 'B2');
  assert.ok(strings.includes(' leading space'));
  assert.deepEqual(findAll(xml('xl/workbook.xml'), 'sheet').map((s) => attr(s, 'name')), ['Data', 'About']);
});
