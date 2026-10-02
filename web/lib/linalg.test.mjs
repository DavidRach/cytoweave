import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import {
  cholesky,
  choleskySolve,
  conditionNumber,
  createNNLSWorkspace,
  crossProduct,
  gram,
  identity,
  inverse,
  leastSquares,
  matVec,
  multiply,
  nnlsBlockPivotInPlace,
  nnlsGramInPlace,
  nonNegativeLeastSquares,
  pseudoInverse,
  qr,
  rank,
  solve,
  svd,
  symmetricEigen,
  transpose,
} from './linalg.js';

function randomMatrix(m, n, seed) {
  const random = createRandom(seed);
  return Float64Array.from({ length: m * n }, () => random.gaussian());
}

function maxAbsDiff(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

function diag(values) {
  const n = values.length;
  const out = new Float64Array(n * n);
  values.forEach((v, i) => { out[i * n + i] = v; });
  return out;
}

function reconstruct({ u, s, v, k }, m, n) {
  const us = new Float64Array(m * k);
  for (let i = 0; i < m; i += 1) for (let c = 0; c < k; c += 1) us[i * k + c] = u[i * k + c] * s[c];
  return multiply(us, transpose(v, n, k), m, k, n);
}

test('multiply, transpose, gram and crossProduct agree', () => {
  const a = randomMatrix(5, 3, 1);
  const at = transpose(a, 5, 3);
  assert.ok(maxAbsDiff(gram(a, 5, 3), multiply(a, at, 5, 3, 5)) < 1e-12);
  assert.ok(maxAbsDiff(crossProduct(a, 5, 3), multiply(at, a, 3, 5, 3)) < 1e-12);
  const x = Float64Array.from([1, -2, 3]);
  assert.ok(maxAbsDiff(matVec(a, x, 5, 3), multiply(a, x, 5, 3, 1)) < 1e-12);
});

test('QR factors are orthonormal and upper triangular and reproduce A', () => {
  const m = 7; const n = 4;
  const a = randomMatrix(m, n, 2);
  const { q, r } = qr(a, m, n);
  assert.ok(maxAbsDiff(multiply(q, r, m, n, n), a) < 1e-12);
  assert.ok(maxAbsDiff(crossProduct(q, m, n), identity(n)) < 1e-12);
  for (let i = 0; i < n; i += 1) for (let j = 0; j < i; j += 1) assert.equal(r[i * n + j], 0);
});

test('Cholesky reproduces a known factor and rejects indefinite matrices', () => {
  // A = L Lᵀ with L = [[2,0,0],[6,1,0],[-8,5,3]] (classic textbook example).
  const a = Float64Array.from([4, 12, -16, 12, 37, -43, -16, -43, 98]);
  const l = cholesky(a, 3);
  assert.ok(maxAbsDiff(l, [2, 0, 0, 6, 1, 0, -8, 5, 3]) < 1e-12);
  const x = choleskySolve(l, Float64Array.from([1, 2, 3]), 3);
  assert.ok(maxAbsDiff(matVec(a, x, 3, 3), [1, 2, 3]) < 1e-10);
  assert.throws(() => cholesky(Float64Array.from([1, 2, 2, 1]), 2), /positive definite/);
});

test('solve, inverse and leastSquares', () => {
  const a = Float64Array.from([2, 1, -1, -3, -1, 2, -2, 1, 2]);
  const x = solve(a, Float64Array.from([8, -11, -3]), 3);
  assert.ok(maxAbsDiff(x, [2, 3, -1]) < 1e-12);
  assert.ok(maxAbsDiff(multiply(a, inverse(a, 3), 3, 3, 3), identity(3)) < 1e-12);
  assert.throws(() => solve(Float64Array.from([1, 2, 2, 4]), Float64Array.from([1, 1]), 2), /singular/);
  // Straight-line fit through (0,1), (1,3), (2,5), (3,7): intercept 1, slope 2.
  const design = Float64Array.from([1, 0, 1, 1, 1, 2, 1, 3]);
  const coef = leastSquares(design, Float64Array.from([1, 3, 5, 7]), 4, 2);
  assert.ok(maxAbsDiff(coef, [1, 2]) < 1e-12);
});

test('SVD of a 2 × 2 matrix matches the hand-computed singular values', () => {
  // [[3,0],[4,5]]: AᵀA = [[25,20],[20,25]] has eigenvalues 45 and 5.
  const { s } = svd(Float64Array.from([3, 0, 4, 5]), 2, 2);
  assert.ok(Math.abs(s[0] - Math.sqrt(45)) < 1e-12);
  assert.ok(Math.abs(s[1] - Math.sqrt(5)) < 1e-12);
});

test('SVD recovers planted singular values and reconstructs tall and wide matrices', () => {
  const m = 60; const n = 12;
  const qa = qr(randomMatrix(m, n, 3), m, n).q;
  const qb = qr(randomMatrix(n, n, 4), n, n).q;
  const planted = Array.from({ length: n }, (_, i) => 10 / (i + 1));
  const a = multiply(multiply(qa, diag(planted), m, n, n), transpose(qb, n, n), m, n, n);
  const result = svd(a, m, n);
  for (let i = 0; i < n; i += 1) assert.ok(Math.abs(result.s[i] - planted[i]) < 1e-12, `s${i}`);
  assert.ok(maxAbsDiff(reconstruct(result, m, n), a) < 1e-12);
  assert.ok(maxAbsDiff(crossProduct(result.u, m, n), identity(n)) < 1e-12);
  assert.ok(maxAbsDiff(crossProduct(result.v, n, n), identity(n)) < 1e-12);
  // Wide (m < n), as a 40 × 64 reference matrix is.
  const w = randomMatrix(40, 64, 5);
  const ws = svd(w, 40, 64);
  assert.equal(ws.k, 40);
  assert.ok(maxAbsDiff(reconstruct(ws, 40, 64), w) < 1e-11);
  for (let i = 1; i < ws.k; i += 1) assert.ok(ws.s[i] <= ws.s[i - 1]);
});

test('pseudo-inverse satisfies the Penrose conditions, including rank-deficient input', () => {
  const a = randomMatrix(8, 5, 6);
  const p = pseudoInverse(a, 8, 5);
  assert.ok(maxAbsDiff(multiply(multiply(a, p, 8, 5, 8), a, 8, 8, 5), a) < 1e-12);
  assert.ok(maxAbsDiff(multiply(p, a, 5, 8, 5), identity(5)) < 1e-12);
  // Rank 1: [[1,2],[2,4],[3,6]] has pseudo-inverse Aᵀ / 70.
  const r1 = Float64Array.from([1, 2, 2, 4, 3, 6]);
  const p1 = pseudoInverse(r1, 3, 2);
  assert.ok(maxAbsDiff(p1, Array.from(transpose(r1, 3, 2), (v) => v / 70)) < 1e-12);
  assert.equal(rank(r1, 3, 2), 1);
});

test('condition number: orthogonal is 1, diagonal is the ratio, Hilbert(5) is the published value', () => {
  const q = qr(randomMatrix(6, 6, 7), 6, 6).q;
  assert.ok(Math.abs(conditionNumber(q, 6, 6) - 1) < 1e-12);
  assert.ok(Math.abs(conditionNumber(diag([10, 2, 1]), 3, 3) - 10) < 1e-12);
  const h = Float64Array.from({ length: 25 }, (_, k) => 1 / (Math.floor(k / 5) + (k % 5) + 1));
  // κ₂(H₅) = 4.766072502e5 (Todd 1954; e.g. Higham, Accuracy and Stability, table 28.1).
  assert.ok(Math.abs(conditionNumber(h, 5, 5) / 476607.25 - 1) < 1e-6);
  assert.equal(conditionNumber(Float64Array.from([1, 2, 2, 4]), 2, 2), Infinity);
});

test('symmetric eigen-decomposition', () => {
  // [[2,1],[1,2]] has eigenvalues 3 and 1.
  const { values, vectors } = symmetricEigen(Float64Array.from([2, 1, 1, 2]), 2);
  assert.ok(Math.abs(values[0] - 3) < 1e-12 && Math.abs(values[1] - 1) < 1e-12);
  assert.ok(Math.abs(Math.abs(vectors[0]) - Math.SQRT1_2) < 1e-12);
  const a = gram(randomMatrix(6, 9, 8), 6, 9);
  const e = symmetricEigen(a, 6);
  const lambda = diag(Array.from(e.values));
  assert.ok(maxAbsDiff(multiply(multiply(e.vectors, lambda, 6, 6, 6), transpose(e.vectors, 6, 6), 6, 6, 6), a) < 1e-10);
});

test('NNLS solves the Lawson–Hanson textbook problem and satisfies KKT', () => {
  // min ‖A x − y‖, x ≥ 0 with a known active constraint: unconstrained solution has x₂ < 0.
  const a = Float64Array.from([1, 0, 0, 1, 1, 1]);
  const y = Float64Array.from([1, -1, 0]);
  // Unconstrained: x = (1, −1); constrained optimum: x₂ = 0, x₁ minimizes (x₁−1)² + 1 + x₁² → 0.5.
  const x = nonNegativeLeastSquares(a, y, 3, 2);
  assert.ok(Math.abs(x[0] - 0.5) < 1e-12 && x[1] === 0);
  // Random problems: KKT conditions hold.
  const random = createRandom(9);
  for (let trial = 0; trial < 50; trial += 1) {
    const m = 20; const n = 8;
    const A = randomMatrix(m, n, 100 + trial);
    const yy = Float64Array.from({ length: m }, () => random.gaussian());
    const g = crossProduct(A, m, n);
    const b = new Float64Array(n);
    for (let i = 0; i < m; i += 1) for (let j = 0; j < n; j += 1) b[j] += A[i * n + j] * yy[i];
    const sol = new Float64Array(n);
    nnlsGramInPlace(g, b, n, sol, createNNLSWorkspace(n));
    const grad = matVec(g, sol, n, n).map((v, j) => v - b[j]);
    for (let j = 0; j < n; j += 1) {
      assert.ok(sol[j] >= 0);
      if (sol[j] > 0) assert.ok(Math.abs(grad[j]) < 1e-9, `stationary ${j}`);
      else assert.ok(grad[j] > -1e-9, `dual feasible ${j}`);
    }
  }
});

test('block principal pivoting NNLS agrees with Lawson–Hanson from cold and warm starts', () => {
  const random = createRandom(10);
  const m = 64; const n = 40;
  // Overlapping Gaussian columns, as in a spectral panel: ill-conditioned but full rank.
  const a = new Float64Array(m * n);
  for (let i = 0; i < m; i += 1) for (let j = 0; j < n; j += 1) a[i * n + j] = Math.exp(-((i - 1.55 * j - 2) ** 2) / 8);
  const g = crossProduct(a, m, n);
  const ws = createNNLSWorkspace(n);
  let solves = 0;
  for (let trial = 0; trial < 40; trial += 1) {
    const truth = Float64Array.from({ length: n }, () => (random() < 0.3 ? 1000 * random() : 0));
    const y = matVec(a, truth, m, n).map((v) => v + 20 * random.gaussian());
    const b = new Float64Array(n);
    for (let i = 0; i < m; i += 1) for (let j = 0; j < n; j += 1) b[j] += a[i * n + j] * y[i];
    const lh = new Float64Array(n);
    nnlsGramInPlace(g, b, n, lh, ws);
    const cold = new Float64Array(n);
    nnlsBlockPivotInPlace(g, b, n, cold, ws);
    const warm = solve(g, b, n); // unconstrained solution as the warm start
    solves += nnlsBlockPivotInPlace(g, b, n, warm, ws);
    const scale = Math.max(...b.map(Math.abs));
    for (const x of [cold, warm]) {
      const grad = matVec(g, x, n, n).map((v, j) => v - b[j]);
      for (let j = 0; j < n; j += 1) {
        assert.ok(x[j] >= 0);
        if (x[j] > 0) assert.ok(Math.abs(grad[j]) < 1e-8 * scale);
        else assert.ok(grad[j] > -1e-8 * scale);
        assert.ok(Math.abs(x[j] - lh[j]) < 1e-6 * (1 + Math.abs(lh[j])), `trial ${trial} x${j}: ${x[j]} vs ${lh[j]}`);
      }
    }
  }
  assert.ok(solves / 40 < 12, `mean solves from a warm start ${solves / 40}`);
});
