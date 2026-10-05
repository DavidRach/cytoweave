import assert from 'node:assert/strict';
import test from 'node:test';
import { writePZFX } from './pzfx.js';
import { parseXML, children, child, attr, textContent } from './xml.js';

test('Prism column tables with row titles, empty values and escaped titles', () => {
  const text = writePZFX([
    { title: 'CD4 & CD8', rowTitles: ['S1', 'S2 <rep>'], columns: [{ title: 'Freq', values: [12.5, null], decimals: 1 }] },
    { title: 'By group', columns: [{ title: 'A', values: [1, 2, 3] }, { title: 'B', values: [4] }] },
  ], { date: new Date('2026-10-04T00:00:00Z'), project: 'Test' });
  const root = parseXML(text);
  assert.equal(root.name, 'GraphPadPrismFile');
  const tables = children(root, 'Table');
  assert.equal(tables.length, 2);
  assert.equal(attr(tables[0], 'TableType'), 'OneWay');
  assert.equal(textContent(child(tables[0], 'Title')), 'CD4 & CD8');
  assert.deepEqual(children(child(child(tables[0], 'RowTitlesColumn'), 'Subcolumn'), 'd').map(textContent), ['S1', 'S2 <rep>']);
  const values = children(child(child(tables[0], 'YColumn'), 'Subcolumn'), 'd').map(textContent);
  assert.deepEqual(values, ['12.5', '']);
  assert.equal(child(tables[1], 'RowTitlesColumn'), null);
  assert.deepEqual(children(tables[1], 'YColumn').map((c) => children(child(c, 'Subcolumn'), 'd').length), [3, 1]);
  assert.equal(children(child(root, 'TableSequence'), 'Ref').length, 2);
  assert.match(text, /<Constant><Name>Experiment Date<\/Name><Value>2026-10-04<\/Value><\/Constant>/);
});
