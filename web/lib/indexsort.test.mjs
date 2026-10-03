import assert from 'node:assert/strict';
import test from 'node:test';
import { generateExample } from './examples.js';
import { parseFCS } from './fcs.js';
import { eventsByWell, plateFor, readIndexSort, wellName } from './indexsort.js';

test('well names and plate sizes', () => {
  assert.equal(wellName(0, 0), 'A1');
  assert.equal(wellName(7, 11), 'H12');
  assert.equal(wellName(15, 23), 'P24');
  assert.equal(wellName(26, 0), 'AA1');
  assert.deepEqual(plateFor(7, 11), { wells: 96, rows: 8, columns: 12 });
  assert.deepEqual(plateFor(3, 3, '384 Well - Flat'), { wells: 384, rows: 16, columns: 24 });
  assert.deepEqual(plateFor(9, 2, '96 Well'), { wells: 384, rows: 16, columns: 24 }, 'positions beyond the named plate win');
});

test('BD keyword locations are read in event order, with mismatches and shared wells noted', () => {
  const dataset = (locations, n) => ({ eventCount: n, keywords: { 'INDEX SORTING LOCATIONS': locations, 'INDEX SORTING DEVICE TYPE': '96 Well - U bottom' }, parameters: [], data: [] });
  const sort = readIndexSort(dataset('0,0;0,1;7,11;', 3));
  assert.equal(sort.source, 'INDEX SORTING LOCATIONS');
  assert.deepEqual([sort.rows, sort.columns], [8, 12]);
  assert.deepEqual(Array.from(sort.wells), [0, 1, 95]);
  assert.deepEqual(sort.notes, []);
  const short = readIndexSort(dataset('0,0;0,0;', 3));
  assert.deepEqual(Array.from(short.wells), [0, 0, -1]);
  assert.equal(short.notes.length, 2);
  assert.match(short.notes.join(' '), /2 wells for 3 events/);
  assert.match(short.notes.join(' '), /A1/);
});

test('well parameters (1-based, or 0-based when a value is 0); none means no index sort', () => {
  const params = [{ name: 'FSC-A', index: 0 }, { name: 'Index X', index: 1 }, { name: 'Index Y', index: 2 }];
  const sort = readIndexSort({ eventCount: 2, keywords: {}, parameters: params, data: [Float32Array.of(1, 2), Float32Array.of(1, 12), Float32Array.of(1, 8)] });
  assert.deepEqual(Array.from(sort.wells), [0, 95]);
  const zero = readIndexSort({ eventCount: 2, keywords: {}, parameters: params, data: [Float32Array.of(1, 2), Float32Array.of(0, 11), Float32Array.of(0, 7)] });
  assert.deepEqual(Array.from(zero.wells), [0, 95]);
  assert.match(zero.notes[0], /0-based/);
  assert.equal(readIndexSort({ eventCount: 1, keywords: {}, parameters: [{ name: 'FSC-A', index: 0 }], data: [Float32Array.of(1)] }), null);
});

test("the index-sort example: every event's well matches the simulation's truth", () => {
  const { files } = generateExample('index-sort', {});
  const file = files.find((f) => f.name === 'Plate1_IndexSort.fcs');
  const dataset = parseFCS(file.bytes).datasets[0];
  const sort = readIndexSort(dataset);
  assert.equal(sort.source, 'INDEX SORTING LOCATIONS');
  assert.deepEqual([sort.rows, sort.columns], [8, 12]);
  const truth = file.meta.truth;
  sort.wells.forEach((w, e) => assert.equal(wellName(Math.floor(w / 12), w % 12), truth.wellNames?.[truth.wells[e]] ?? truth.wells[e]));
  // Without the keyword, the Index X / Index Y parameters give the same wells.
  const { 'INDEX SORTING LOCATIONS': _, ...rest } = dataset.keywords;
  const fromParameters = readIndexSort({ ...dataset, keywords: rest });
  assert.equal(fromParameters.source, 'Index X and Index Y');
  assert.deepEqual(Array.from(fromParameters.wells), Array.from(sort.wells));
  const byWell = eventsByWell(sort);
  assert.equal(byWell.filter((list) => list.length === 0).length, 96 - new Set(sort.wells).size);
});
