import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundaryTest,
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
  // (0.5, 0.5) is on the hypotenuse: Gating-ML polygons include their edges.
  assert.deepEqual(Array.from(membership('polygon', triangle, xs, ys, null)), [0, 1, 3]);
  // Candidates restrict the result.
  assert.deepEqual(Array.from(membership('polygon', triangle, xs, ys, Uint32Array.from([3, 4]))), [3]);
});

test('polygon edges and vertices are inside, on every side', () => {
  const square = pointTest('polygon', { vertices: [[0, 0], [2, 0], [2, 2], [0, 2]] });
  for (const [x, y] of [[0, 1], [2, 1], [1, 0], [1, 2], [0, 0], [2, 2]]) assert.equal(square(x, y), true, `${x}, ${y}`);
  assert.equal(square(2.0000001, 1), false);
  // A slanted edge, exactly representable in float32 (the ISAC suite's Poly1u case).
  const slanted = pointTest('polygon', { vertices: [[0, 0], [200000, 100000], [200000, 200000], [100000, 200000]] });
  const x = Math.fround(14.8);
  assert.equal(slanted(x, x / 2), true);
  assert.equal(slanted(x, Math.fround(7.39)), false);
});

test('upper half-open sides exclude +Infinity; lower sides include −Infinity', () => {
  const values = Float64Array.from([Infinity, -Infinity, Number.NaN, 2, 0]);
  const zeros = new Float64Array(values.length).fill(1);
  const members = (quadrant) => Array.from(membership('quadrant', { center: [1, 0], quadrant }, values, zeros, null));
  assert.deepEqual(members('UR'), [3]);
  assert.deepEqual(members('UL'), [1, 4]);
  assert.deepEqual(Array.from(membership('split', { threshold: 1, side: 'hi' }, values, null, null)), [3]);
  assert.deepEqual(Array.from(membership('split', { threshold: 1, side: 'lo' }, values, null, null)), [1, 4]);
  assert.deepEqual(Array.from(membership('range', { min: null, max: 1 }, values, null, null)), [1, 4]);
});

test('events at a boundary are decided by the exact values', () => {
  // Stored (rounded) values put event 0 just outside and event 1 just inside; the exact values
  // say the opposite. Event 2 is far from the boundary and is not recomputed.
  const stored = Float32Array.from([0.5000001, 0.4999999, 0.2]);
  const exact = [0.4999999999, 0.5000000001, 0.2];
  const asked = [];
  const refine = { near: boundaryTest('range', { min: null, max: 0.5 }), exact: (e) => { asked.push(e); return exact[e] < 0.5; } };
  assert.deepEqual(Array.from(membership('range', { min: null, max: 0.5 }, stored, null, null, 3, refine)), [0, 2]);
  assert.deepEqual(asked, [0, 1]);
  assert.equal(boundaryTest('category', { values: [1] }), null);
  const nearEllipse = boundaryTest('ellipse', { center: [0.5, 0.5], radii: [0.2, 0.1], angle: 0 });
  assert.equal(nearEllipse(0.7, 0.5), true);
  assert.equal(nearEllipse(0.69, 0.5), false);
  const nearPolygon = boundaryTest('polygon', { vertices: [[0, 0], [1, 0], [0, 1]] });
  assert.equal(nearPolygon(0.5, 0.5000001), true);
  assert.equal(nearPolygon(0.4, 0.4), false);
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

test('polygon membership over many events (cell grid) decides every event as the plain test does', async () => {
  const { membershipSet } = await import('./gates.js');
  const { EventSet } = await import('./eventset.js');
  const { createRandom } = await import('./random.js');
  const random = createRandom(3);
  const polygons = [
    [[0.2, 0.2], [0.8, 0.25], [0.7, 0.9], [0.3, 0.6]],
    [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.5, 0.5], [0.1, 0.9]],
    [[1000, 1000], [250000, 2000], [120000, 200000]],
  ];
  for (const vertices of polygons) {
    const n = 60000;
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    const scale = Math.max(...vertices.flat().map(Math.abs), 1);
    for (let e = 0; e < n; e += 1) {
      const kind = e % 6;
      const [ax, ay] = vertices[e % vertices.length];
      const [bx, by] = vertices[(e + 1) % vertices.length];
      const u = random();
      if (kind === 0) { xs[e] = ax; ys[e] = ay; } // vertices
      else if (kind === 1) { xs[e] = ax + u * (bx - ax); ys[e] = ay + u * (by - ay); } // on edges (to float32)
      else if (kind === 2) { xs[e] = ax + u * (bx - ax) + (random() - 0.5) * 4e-6 * scale; ys[e] = ay + u * (by - ay); } // within the band
      else if (kind === 3) { xs[e] = random() * 1.2 * scale - 0.1 * scale; ys[e] = random() * 1.2 * scale - 0.1 * scale; }
      else if (kind === 4) { xs[e] = e % 12 === 4 ? Number.NaN : Infinity; ys[e] = 0.5 * scale; }
      else { xs[e] = random() * scale; ys[e] = random() * scale; }
    }
    const geometry = { vertices };
    const test = pointTest('polygon', geometry);
    const near = boundaryTest('polygon', geometry);
    // An "exact" decision that differs from the plain one shows which events took the exact path.
    const refine = { near, exact: (e) => !test(xs[e], ys[e]) };
    for (const r of [null, refine]) {
      const expected = [];
      for (let e = 0; e < n; e += 1) if (r && near(xs[e], ys[e]) ? r.exact(e) : test(xs[e], ys[e])) expected.push(e);
      const viaGrid = membershipSet('polygon', geometry, xs, ys, null, n, r);
      assert.ok(viaGrid instanceof EventSet);
      assert.deepEqual(Array.from(viaGrid.toIndices()), expected, `${vertices.length}-gon, refine ${Boolean(r)}`);
    }
  }
});

test('event sets: bitsets and index lists agree with plain arrays in every operation', async () => {
  const { EventSet, intersectSets, unionSets, differenceSets, forEachChunk, sizeOf } = await import('./eventset.js');
  const { createRandom } = await import('./random.js');
  const random = createRandom(9);
  const size = 10007;
  const make = (p) => Uint32Array.from({ length: size }, (_, i) => i).filter(() => random() < p);
  const plain = (set) => (set === null ? Array.from({ length: size }, (_, i) => i) : Array.from(set.toIndices()));
  for (const [pa, pb] of [[0.5, 0.3], [0.01, 0.6], [0.002, 0.004], [0.9, 0.97]]) {
    const a = make(pa);
    const b = make(pb);
    const sa = EventSet.fromIndices(a, size);
    const sb = EventSet.fromIndices(b, size);
    assert.equal(Boolean(sa.bits), a.length * 32 >= size, 'large sets are bitsets');
    assert.deepEqual(Array.from(sa.toIndices()), Array.from(a));
    assert.equal(sa.count, a.length);
    assert.equal(sizeOf(sa, size), a.length);
    const setB = new Set(b);
    assert.deepEqual(plain(intersectSets(sa, sb, size)), Array.from(a).filter((e) => setB.has(e)));
    assert.deepEqual(plain(unionSets(sa, sb, size)), [...new Set([...a, ...b])].sort((x, y) => x - y));
    assert.deepEqual(plain(differenceSets(sa, sb, size)), Array.from(a).filter((e) => !setB.has(e)));
    assert.deepEqual(plain(differenceSets(null, sb, size)), plain(null).filter((e) => !setB.has(e)));
    const seen = [];
    forEachChunk(sa, size, (chunk, length) => { for (let k = 0; k < length; k += 1) seen.push(chunk[k]); });
    assert.deepEqual(seen, Array.from(a));
    const inA = new Set(a);
    for (let e = 0; e < size; e += 97) assert.equal(sa.has(e), inA.has(e), `has(${e})`);
  }
  assert.equal(intersectSets(null, null, size), null);
  assert.equal(unionSets(EventSet.fromIndices(Uint32Array.from({ length: size }, (_, i) => i), size), EventSet.empty(size), size), null);
  let all = 0;
  forEachChunk(null, size, (chunk, length) => { all += length; });
  assert.equal(all, size);
});
