import assert from 'node:assert/strict';
import test from 'node:test';
import {
  convexHull,
  difference,
  gateOutline,
  intersect,
  membership,
  offsetGeometry,
  plotPointToGate,
  pointTest,
  polygonArea,
  polygonCentroid,
  quadrantGates,
  quadrantNames,
  simplifyPolyline,
  union,
} from './gates.js';

const xs = Float32Array.from([0.1, 0.5, 0.9, 0.5, 0.2, 0.75]);
const ys = Float32Array.from([0.1, 0.5, 0.9, 0.2, 0.8, 0.75]);

test('rectangle, range and polygon membership', () => {
  assert.deepEqual(Array.from(membership('rectangle', { min: [0.4, 0.4], max: [0.8, 0.8] }, xs, ys, null)), [1, 5]);
  assert.deepEqual(Array.from(membership('rectangle', { min: [0.4, null], max: [null, null] }, xs, ys, null)), [1, 2, 3, 5]);
  assert.deepEqual(Array.from(membership('range', { min: 0.45, max: 0.8 }, xs, null, null)), [1, 3, 5]);
  const triangle = { vertices: [[0, 0], [1, 0], [0, 1]] };
  assert.deepEqual(Array.from(membership('polygon', triangle, xs, ys, null)), [0, 3]);
  // Candidates restrict the result.
  assert.deepEqual(Array.from(membership('polygon', triangle, xs, ys, Uint32Array.from([3, 4]))), [3]);
});

test('ellipse membership honors rotation', () => {
  const test45 = pointTest('ellipse', { center: [0.5, 0.5], radii: [0.4, 0.05], angle: Math.PI / 4 });
  assert.equal(test45(0.7, 0.7), true);
  assert.equal(test45(0.7, 0.3), false);
  const flat = pointTest('ellipse', { center: [0.5, 0.5], radii: [0.4, 0.05], angle: 0 });
  assert.equal(flat(0.85, 0.5), true);
  assert.equal(flat(0.5, 0.6), false);
});

test('quadrants partition the plane without overlap', () => {
  const center = [0.5, 0.5];
  const all = [];
  for (const quadrant of ['UL', 'UR', 'LR', 'LL']) all.push(...membership('quadrant', { center, quadrant }, xs, ys, null));
  assert.deepEqual(all.sort(), [0, 1, 2, 3, 4, 5]);
  const gates = quadrantGates({ parentId: null, dims: [], center, names: quadrantNames('CD4', 'CD8') });
  assert.equal(gates.length, 4);
  assert.equal(new Set(gates.map((g) => g.linkId)).size, 1);
  assert.equal(gates.find((g) => g.geometry.quadrant === 'UR').name, 'CD4+ CD8+');
});

test('category gates select derived labels', () => {
  const labels = Float32Array.from([0, 1, 2, 1, 3, 2]);
  assert.deepEqual(Array.from(membership('category', { values: [1, 2] }, labels, null, null)), [1, 2, 3, 5]);
});

test('set operations on sorted indices', () => {
  const a = Uint32Array.from([1, 3, 5, 7]);
  const b = Uint32Array.from([3, 4, 5]);
  assert.deepEqual(Array.from(intersect(a, b)), [3, 5]);
  assert.deepEqual(Array.from(union(a, b)), [1, 3, 4, 5, 7]);
  assert.deepEqual(Array.from(difference(a, b)), [1, 7]);
  assert.deepEqual(Array.from(difference(null, b, 6)), [0, 1, 2]);
  assert.equal(intersect(null, null), null);
  assert.equal(union(Uint32Array.from([0, 1]), Uint32Array.from([2]), 3), null);
});

test('polygon helpers', () => {
  const square = [[0, 0], [2, 0], [2, 2], [0, 2]];
  assert.equal(polygonArea(square), 4);
  assert.deepEqual(polygonCentroid(square), [1, 1]);
  const hull = convexHull([[0, 0], [1, 1], [2, 0], [2, 2], [0, 2], [1, 0.5]]);
  assert.equal(hull.length, 4);
  const line = Array.from({ length: 50 }, (_, i) => [i / 49, (i / 49) ** 2 * 0.001]);
  assert.ok(simplifyPolyline(line, 0.01).length <= 3);
});

test('offset expands and shrinks polygons and rectangles', () => {
  const square = { vertices: [[0.2, 0.2], [0.6, 0.2], [0.6, 0.6], [0.2, 0.6]] };
  const bigger = offsetGeometry('polygon', square, 0.05);
  const smaller = offsetGeometry('polygon', square, -0.05);
  assert.ok(Math.abs(polygonArea(bigger.vertices) - 0.5 * 0.5) < 1e-9);
  assert.ok(Math.abs(polygonArea(smaller.vertices) - 0.3 * 0.3) < 1e-9);
  // Clockwise input expands outward too.
  const clockwise = { vertices: square.vertices.slice().reverse() };
  assert.ok(Math.abs(polygonArea(offsetGeometry('polygon', clockwise, 0.05).vertices) - 0.25) < 1e-9);
  const rect = offsetGeometry('rectangle', { min: [0.2, null], max: [0.6, 0.8] }, 0.1);
  assert.deepEqual(rect.min.map((v) => (v === null ? null : +v.toFixed(6))), [0.1, null]);
  assert.deepEqual(rect.max.map((v) => +v.toFixed(6)), [0.7, 0.9]);
});

test('outlines map between transforms and axis orders', () => {
  const linear = { type: 'linear', min: 0, max: 1000 };
  const log = { type: 'log', min: 1, max: 1000 };
  const gate = { type: 'polygon', dims: [{ channel: 'A', transform: linear }, { channel: 'B', transform: linear }] };
  const geometry = { vertices: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5]] };
  const same = gateOutline(gate, geometry, [{ channel: 'A', transform: linear }, { channel: 'B', transform: linear }]);
  assert.deepEqual(same.vertices, geometry.vertices);
  const swapped = gateOutline(gate, geometry, [{ channel: 'B', transform: linear }, { channel: 'A', transform: linear }]);
  assert.deepEqual(swapped.vertices[1], [0.1, 0.5]);
  const remapped = gateOutline(gate, geometry, [{ channel: 'A', transform: log }, { channel: 'B', transform: linear }]);
  // A = 100 (0.1 of linear 0–1000) is 2/3 of the way up a 1–1000 log axis.
  assert.ok(Math.abs(remapped.vertices[0][0] - 2 / 3) < 1e-9);
  assert.ok(remapped.points.length > geometry.vertices.length, 'edges are densified when transforms differ');
  assert.equal(gateOutline(gate, geometry, [{ channel: 'A', transform: linear }, { channel: 'C', transform: linear }]), null);
  const back = plotPointToGate(remapped.vertices[0], gate, [{ channel: 'A', transform: log }, { channel: 'B', transform: linear }]);
  assert.ok(Math.abs(back[0] - 0.1) < 1e-9 && Math.abs(back[1] - 0.1) < 1e-9);
});
