import assert from 'node:assert/strict';
import test from 'node:test';
import { geometrySide } from './phenotype.js';

test('a gate open on one side says which side of the marker it takes', () => {
  assert.deepEqual(['UL', 'UR', 'LR', 'LL'].map((quadrant) => [0, 1].map((i) => geometrySide({ type: 'quadrant', geometry: { center: [0.5, 0.5], quadrant } }, i)).join('')), ['-+', '++', '+-', '--']);
  assert.equal(geometrySide({ type: 'split', geometry: { threshold: 0.4, side: 'hi' } }, 0), '+');
  assert.equal(geometrySide({ type: 'range', geometry: { min: 0.4, max: null } }, 0), '+');
  assert.equal(geometrySide({ type: 'range', geometry: { min: 0.4, max: 0.99 } }, 0), '+', 'a bound at the end of the axis counts as open');
  assert.equal(geometrySide({ type: 'range', geometry: { min: 0, max: 0.4 } }, 0), '-');
  assert.equal(geometrySide({ type: 'range', geometry: { min: 0.3, max: 0.6 } }, 0), null, 'closed: decided from the data');
  assert.deepEqual([0, 1].map((i) => geometrySide({ type: 'rectangle', geometry: { min: [null, 0.6], max: [0.4, null] } }, i)), ['-', '+']);
  assert.equal(geometrySide({ type: 'polygon', geometry: { vertices: [] } }, 0), null);
});
