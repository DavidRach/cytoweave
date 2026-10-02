import assert from 'node:assert/strict';
import test from 'node:test';
import { readCLR, writeCLR } from './clr.js';

test('writes crisp classes as 0/1 columns', () => {
  const text = writeCLR(5, [
    { name: 'T cells', members: Uint32Array.from([0, 2, 3]) },
    { name: 'B cells', members: Uint32Array.from([1]) },
    { name: 'Odd, "name"', members: new Uint32Array(0) },
  ]);
  assert.equal(text, 'T cells,B cells,"Odd, ""name"""\n1,0,0\n0,1,0\n1,0,0\n1,0,0\n0,0,0\n');
  const back = readCLR(text);
  assert.deepEqual(back.names, ['T cells', 'B cells', 'Odd, "name"']);
  assert.equal(back.eventCount, 5);
  assert.deepEqual(Array.from(back.classes[0].members), [0, 2, 3]);
  assert.equal(back.classes[0].probabilities, null);
  assert.deepEqual(Array.from(back.classes[2].members), []);
});

test('writes and reads probabilities', () => {
  const probabilities = Float32Array.from([0, 0.25, 0.5, 0.999999, 1, 1e-9]);
  const text = writeCLR(6, [{ name: 'Cluster 1', probabilities }, { name: 'Gate', members: Uint32Array.from([5]) }], { newline: '\r\n' });
  assert.equal(text.split('\r\n')[2], '0.25,0');
  assert.equal(text.split('\r\n')[6], '0,1');
  assert.doesNotMatch(text, /e-/);
  const back = readCLR(text);
  assert.deepEqual(Array.from(back.classes[0].probabilities), Array.from(Float32Array.from([0, 0.25, 0.5, 0.999999, 1, 0])));
  assert.deepEqual(Array.from(back.classes[0].members), [2, 3, 4]);
  assert.deepEqual(Array.from(readCLR(text, { threshold: 0.9 }).classes[0].members), [3, 4]);
  assert.deepEqual(Array.from(back.classes[1].members), [5]);
});

test('reads tolerant variants and rejects malformed tables', () => {
  const tab = readCLR('﻿# exported by tool X\nA\tB\n1\t0\n\n0\t1\n');
  assert.deepEqual(tab.names, ['A', 'B']);
  assert.equal(tab.eventCount, 2);
  assert.deepEqual(Array.from(tab.classes[1].members), [1]);
  assert.throws(() => readCLR('A,B\n1\n'), /1 values for 2 classes/);
  assert.throws(() => readCLR('A\n1.5\n'), /not a value between 0 and 1/);
  assert.throws(() => readCLR(''), /empty/);
  assert.throws(() => writeCLR(3, [{ name: 'A', members: [3] }]), /outside/);
  assert.throws(() => writeCLR(2, [{ name: 'A', probabilities: Float32Array.from([0.5, Number.NaN]) }]), /not a probability/);
  assert.throws(() => writeCLR(2, [{ name: 'A', members: [] }, { name: 'A', members: [] }]), /Two classes/);
});

test('large crisp tables are fast', () => {
  const n = 1_000_000;
  const members = new Uint32Array(n / 2);
  for (let i = 0; i < members.length; i += 1) members[i] = 2 * i;
  const start = performance.now();
  const text = writeCLR(n, [{ name: 'Even', members }, { name: 'None', members: new Uint32Array(0) }]);
  assert.ok(performance.now() - start < 1500);
  assert.equal(text.length, 'Even,None\n'.length + n * 4);
  const back = readCLR(text);
  assert.equal(back.classes[0].members.length, n / 2);
});
