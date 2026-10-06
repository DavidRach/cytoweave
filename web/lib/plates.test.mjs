import assert from 'node:assert/strict';
import test from 'node:test';
import { commonDoses, controlRole, layoutCSV, layoutChanges, paddedWellName, parseLayout, parseQuantity, parseWell, platesOf, sampleWells, zPrime } from './plates.js';

test('well names in their usual spellings', () => {
  assert.deepEqual(parseWell('A1'), { row: 0, column: 0 });
  assert.deepEqual(parseWell('h12'), { row: 7, column: 11 });
  assert.deepEqual(parseWell('B007'), { row: 1, column: 6 });
  assert.deepEqual(parseWell('C-5'), { row: 2, column: 4 });
  assert.deepEqual(parseWell('AF48'), { row: 31, column: 47 });
  assert.deepEqual(parseWell('R02C03'), { row: 1, column: 2 });
  assert.equal(parseWell('Unstim'), null);
  assert.equal(parseWell('A0'), null);
  assert.equal(paddedWellName(0, 4), 'A05');
});

const sample = (id, name, extra = {}) => ({ id, name, meta: {}, keywords: {}, ...extra });

test('wells from annotations, keywords and names; names only when they place every sample once', () => {
  const placed = sampleWells([
    sample('a', 'x', { meta: { well: 'B3' } }),
    sample('b', 'y', { keywords: { $WELLID: 'C04', $PLATENAME: 'P1' } }),
    sample('c', 'Run1_D05.fcs'),
    sample('d', 'Run1_D06.fcs'),
  ]);
  assert.equal(placed.get('a').well, 'B3');
  assert.equal(placed.get('a').source, 'annotation');
  assert.equal(placed.get('b').plate, 'P1');
  assert.equal(placed.get('b').source, 'keyword');
  assert.equal(placed.get('c').well, 'D5');
  assert.equal(placed.get('c').source, 'name');
  // Donor IDs that look like wells (D01 twice) are not wells.
  const donors = sampleWells([sample('a', 'D01_Unstim.fcs'), sample('b', 'D01_Stim.fcs'), sample('c', 'D02_Stim.fcs')]);
  assert.equal(donors.size, 0);
  // Plates from the parts before the well when they differ.
  const two = platesOf([sample('a', 'P1_A01.fcs'), sample('b', 'P2_A01.fcs'), sample('c', 'P2_H12.fcs')]);
  assert.deepEqual(two.map((p) => [p.name, p.format, p.placed.length]), [['P1', 96, 1], ['P2', 96, 2]]);
});

test('a plate holds its wells; a 384-well plate when columns pass 12', () => {
  const samples = Array.from({ length: 20 }, (_, k) => sample(`s${k}`, 'x', { meta: { well: `B${k + 1}` } }));
  const [plate] = platesOf(samples);
  assert.equal(plate.format, 384);
  assert.deepEqual(plate.wells[1 * 24 + 19], ['s19']);
  assert.equal(platesOf(samples.slice(0, 12))[0].format, 96);
});

test('layouts: one row per well, and plate maps', () => {
  const long = parseLayout('Well,Compound,Dose (nM),Control\nA01,CW-1,10,\nA02,CW-1,3.3,\n"H12",,,negative\n');
  assert.equal(long.format, 'wells');
  assert.deepEqual(long.fields, ['compound', 'dose (nM)', 'control']);
  assert.deepEqual(long.entries[2], { plate: null, row: 7, column: 11, well: 'H12', values: { control: 'negative' } });
  const map = parseLayout('Compound,1,2,3\nA,CW-1,CW-1,DMSO\nB,CW-2,CW-2,\n\nDose,1,2,3\nA,10,1,\nB,10,1,\n');
  assert.equal(map.format, 'map');
  assert.deepEqual(map.fields, ['compound', 'dose']);
  assert.deepEqual(map.entries.find((e) => e.well === 'B2').values, { compound: 'CW-2', dose: '1' });
  assert.deepEqual(map.entries.find((e) => e.well === 'A3').values, { compound: 'DMSO' });
  assert.throws(() => parseLayout('sample,condition\nx,y\n'), /No "well" column/);
});

test('a layout applied to a plate, and written back', () => {
  const samples = [sample('a', 'P_A01.fcs'), sample('b', 'P_A02.fcs')];
  const [plate] = platesOf(samples);
  const layout = parseLayout('well,compound\nA1,CW-1\nA2,CW-2\nB1,CW-3\n');
  const { changes, matched, unmatched } = layoutChanges(layout, plate);
  assert.equal(matched, 2);
  assert.deepEqual(unmatched, ['B1']);
  assert.deepEqual(changes.a, { compound: 'CW-1', well: 'A1' });
  const annotated = samples.map((s) => ({ ...s, meta: changes[s.id] }));
  const csv = layoutCSV(plate, new Map(annotated.map((s) => [s.id, s])), ['compound']);
  assert.equal(csv, 'plate,well,sample,compound\nPlate,A01,P_A01.fcs,CW-1\nPlate,A02,P_A02.fcs,CW-2\n');
  assert.deepEqual(parseLayout(csv).entries.map((e) => e.values.compound), ['CW-1', 'CW-2']);
});

test('doses in mixed units on one scale', () => {
  assert.deepEqual(parseQuantity('10 nM'), { value: 10, unit: 'nM', base: 10e-9, dimension: 'M' });
  assert.equal(parseQuantity('0.5 µg/mL').dimension, 'g/mL');
  assert.equal(parseQuantity('abc'), null);
  const { unit, values } = commonDoses(['10 nM', '1 µM', '100 nM', 'vehicle']);
  assert.equal(unit, 'nM');
  assert.ok(Math.abs(values[1] - 1000) < 1e-9);
  assert.ok(Number.isNaN(values[3]));
});

test('Z′ of separated and overlapping controls', () => {
  const z = zPrime([60, 62, 58, 61, 59], [4, 5, 3, 4, 4]);
  const sp = Math.sqrt(2.5);
  const sn = Math.sqrt(0.5);
  assert.ok(Math.abs(z.z - (1 - (3 * (sp + sn)) / 56)) < 1e-12);
  assert.equal(z.rating, 'excellent');
  assert.equal(zPrime([10, 20, 30], [15, 25, 5]).rating, 'controls overlap');
  assert.equal(zPrime([1], [2, 3]), null);
  assert.equal(zPrime([60, 62, 58, 61, 59, 200], [4, 5, 3, 4, 4, 4], { robust: true }).rating, 'excellent');
  assert.equal(controlRole('Positive'), 'positive');
  assert.equal(controlRole('DMSO'), null);
  assert.equal(controlRole('DMSO', { positive: ['DMSO'], negative: ['Unstim'] }), 'positive');
});
