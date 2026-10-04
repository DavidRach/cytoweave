// Small dense linear algebra for analysis code (spectral unmixing, regression, PCA).
//
// Matrices are row-major Float64Arrays with explicit dimensions: an m × n matrix A holds A[i][j]
// at a[i * n + j]. The sizes met in cytometry (a few hundred rows, tens of columns) are small, so
// the algorithms favor numerical robustness and clarity over blocking. Functions never modify
// their inputs unless their name ends in `InPlace`.

export class LinearAlgebraError extends Error {}

const EPS = 2.220446049250313e-16;

export function identity(n) {
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) out[i * n + i] = 1;
  return out;
}

export function transpose(a, m, n) {
  const out = new Float64Array(m * n);
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < n; j += 1) out[j * m + i] = a[i * n + j];
  }
  return out;
}

// (m × k) · (k × n) → m × n.
export function multiply(a, b, m, k, n) {
  const out = new Float64Array(m * n);
  for (let i = 0; i < m; i += 1) {
    const row = i * n;
    for (let p = 0; p < k; p += 1) {
      const aip = a[i * k + p];
      if (aip === 0) continue;
      const brow = p * n;
      for (let j = 0; j < n; j += 1) out[row + j] += aip * b[brow + j];
    }
  }
  return out;
}

// A Aᵀ for an m × n matrix A (m × m, symmetric).
export function gram(a, m, n) {
  const out = new Float64Array(m * m);
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = 0;
      for (let p = 0; p < n; p += 1) sum += a[i * n + p] * a[j * n + p];
      out[i * m + j] = sum;
      out[j * m + i] = sum;
    }
  }
  return out;
}

// Aᵀ A for an m × n matrix A (n × n, symmetric).
export function crossProduct(a, m, n) {
  const out = new Float64Array(n * n);
  for (let p = 0; p < m; p += 1) {
    const row = p * n;
    for (let i = 0; i < n; i += 1) {
      const v = a[row + i];
      if (v === 0) continue;
      for (let j = 0; j <= i; j += 1) out[i * n + j] += v * a[row + j];
    }
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < i; j += 1) out[j * n + i] = out[i * n + j];
  }
  return out;
}

// A x for an m × n matrix A and a length-n vector x.
export function matVec(a, x, m, n) {
  const out = new Float64Array(m);
  for (let i = 0; i < m; i += 1) {
    let sum = 0;
    for (let j = 0; j < n; j += 1) sum += a[i * n + j] * x[j];
    out[i] = sum;
  }
  return out;
}

export function dot(x, y) {
  let sum = 0;
  for (let i = 0; i < x.length; i += 1) sum += x[i] * y[i];
  return sum;
}

// Euclidean norm, scaled to avoid overflow and underflow.
export function norm2(x) {
  let scale = 0;
  for (let i = 0; i < x.length; i += 1) scale = Math.max(scale, Math.abs(x[i]));
  if (scale === 0 || !Number.isFinite(scale)) return scale;
  let sum = 0;
  for (let i = 0; i < x.length; i += 1) {
    const v = x[i] / scale;
    sum += v * v;
  }
  return scale * Math.sqrt(sum);
}

export function frobeniusNorm(a) {
  return norm2(a);
}

// Householder QR of an m × n matrix with m ≥ n: A = Q R with Q m × n (orthonormal columns, the
// "thin" factor) and R n × n upper triangular (Golub & Van Loan, Matrix Computations, §5.2).
export function qr(a, m, n) {
  if (m < n) throw new LinearAlgebraError('QR needs at least as many rows as columns.');
  const r = Float64Array.from(a);
  const vs = [];
  for (let k = 0; k < n; k += 1) {
    const v = new Float64Array(m - k);
    let norm = 0;
    for (let i = k; i < m; i += 1) {
      v[i - k] = r[i * n + k];
      norm += v[i - k] * v[i - k];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) {
      vs.push(null);
      continue;
    }
    const alpha = v[0] >= 0 ? -norm : norm;
    v[0] -= alpha;
    const vnorm = norm2(v);
    if (vnorm === 0) {
      vs.push(null);
      continue;
    }
    for (let i = 0; i < v.length; i += 1) v[i] /= vnorm;
    for (let j = k; j < n; j += 1) {
      let s = 0;
      for (let i = k; i < m; i += 1) s += v[i - k] * r[i * n + j];
      s *= 2;
      for (let i = k; i < m; i += 1) r[i * n + j] -= s * v[i - k];
    }
    vs.push(v);
  }
  // Q = H₀ H₁ … H_{n−1} applied to the first n columns of the identity.
  const q = new Float64Array(m * n);
  for (let j = 0; j < n; j += 1) q[j * n + j] = 1;
  for (let k = n - 1; k >= 0; k -= 1) {
    const v = vs[k];
    if (!v) continue;
    for (let j = 0; j < n; j += 1) {
      let s = 0;
      for (let i = k; i < m; i += 1) s += v[i - k] * q[i * n + j];
      s *= 2;
      for (let i = k; i < m; i += 1) q[i * n + j] -= s * v[i - k];
    }
  }
  const upper = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = i; j < n; j += 1) upper[i * n + j] = r[i * n + j];
  }
  return { q, r: upper };
}

// Cholesky factor of a symmetric positive-definite matrix, computed in place from its lower
// triangle (the upper triangle is ignored and left unchanged). Returns false when the matrix is
// not numerically positive definite. Used in hot loops, so it allocates nothing.
export function choleskyInPlace(a, n) {
  for (let j = 0; j < n; j += 1) {
    const rowJ = j * n;
    let diag = a[rowJ + j];
    for (let k = 0; k < j; k += 1) diag -= a[rowJ + k] * a[rowJ + k];
    if (!(diag > EPS * Math.abs(a[rowJ + j]) * n) || !Number.isFinite(diag)) return false;
    const ljj = Math.sqrt(diag);
    a[rowJ + j] = ljj;
    for (let i = j + 1; i < n; i += 1) {
      const rowI = i * n;
      let sum = a[rowI + j];
      for (let k = 0; k < j; k += 1) sum -= a[rowI + k] * a[rowJ + k];
      a[rowI + j] = sum / ljj;
    }
  }
  return true;
}

// Solves L Lᵀ x = b in place (b becomes x), with L from choleskyInPlace.
export function choleskySolveInPlace(l, b, n) {
  for (let i = 0; i < n; i += 1) {
    let sum = b[i];
    const row = i * n;
    for (let k = 0; k < i; k += 1) sum -= l[row + k] * b[k];
    b[i] = sum / l[row + i];
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    let sum = b[i];
    for (let k = i + 1; k < n; k += 1) sum -= l[k * n + i] * b[k];
    b[i] = sum / l[i * n + i];
  }
  return b;
}

// Lower-triangular Cholesky factor L of a symmetric positive-definite matrix (A = L Lᵀ).
export function cholesky(a, n) {
  const l = Float64Array.from(a);
  if (!choleskyInPlace(l, n)) throw new LinearAlgebraError('The matrix is not positive definite.');
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) l[i * n + j] = 0;
  }
  return l;
}

// Solves L Lᵀ X = B for X, where B is n × nrhs.
export function choleskySolve(l, b, n, nrhs = 1) {
  const out = Float64Array.from(b);
  const column = new Float64Array(n);
  for (let c = 0; c < nrhs; c += 1) {
    for (let i = 0; i < n; i += 1) column[i] = out[i * nrhs + c];
    choleskySolveInPlace(l, column, n);
    for (let i = 0; i < n; i += 1) out[i * nrhs + c] = column[i];
  }
  return out;
}

// Solves A X = B for a square n × n matrix A and an n × nrhs right-hand side, by Gaussian
// elimination with partial pivoting.
export function solve(a, b, n, nrhs = 1) {
  const lu = Float64Array.from(a);
  const x = Float64Array.from(b);
  let scale = 0;
  for (let i = 0; i < lu.length; i += 1) scale = Math.max(scale, Math.abs(lu[i]));
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let best = Math.abs(lu[col * n + col]);
    for (let row = col + 1; row < n; row += 1) {
      const v = Math.abs(lu[row * n + col]);
      if (v > best) {
        best = v;
        pivot = row;
      }
    }
    if (!(best > EPS * n * scale)) throw new LinearAlgebraError('The matrix is singular.');
    if (pivot !== col) {
      for (let k = 0; k < n; k += 1) {
        const t = lu[col * n + k];
        lu[col * n + k] = lu[pivot * n + k];
        lu[pivot * n + k] = t;
      }
      for (let k = 0; k < nrhs; k += 1) {
        const t = x[col * nrhs + k];
        x[col * nrhs + k] = x[pivot * nrhs + k];
        x[pivot * nrhs + k] = t;
      }
    }
    const inv = 1 / lu[col * n + col];
    for (let row = col + 1; row < n; row += 1) {
      const factor = lu[row * n + col] * inv;
      if (factor === 0) continue;
      for (let k = col; k < n; k += 1) lu[row * n + k] -= factor * lu[col * n + k];
      for (let k = 0; k < nrhs; k += 1) x[row * nrhs + k] -= factor * x[col * nrhs + k];
    }
  }
  for (let row = n - 1; row >= 0; row -= 1) {
    for (let k = 0; k < nrhs; k += 1) {
      let sum = x[row * nrhs + k];
      for (let j = row + 1; j < n; j += 1) sum -= lu[row * n + j] * x[j * nrhs + k];
      x[row * nrhs + k] = sum / lu[row * n + row];
    }
  }
  return x;
}

export function inverse(a, n) {
  return solve(a, identity(n), n, n);
}

// Least-squares solution of A X ≈ B (A m × n with m ≥ n and full column rank; B m × nrhs) by QR.
export function leastSquares(a, b, m, n, nrhs = 1) {
  const { q, r } = qr(a, m, n);
  const x = new Float64Array(n * nrhs);
  for (let c = 0; c < nrhs; c += 1) {
    for (let j = 0; j < n; j += 1) {
      let sum = 0;
      for (let i = 0; i < m; i += 1) sum += q[i * n + j] * b[i * nrhs + c];
      x[j * nrhs + c] = sum;
    }
    for (let i = n - 1; i >= 0; i -= 1) {
      let sum = x[i * nrhs + c];
      for (let j = i + 1; j < n; j += 1) sum -= r[i * n + j] * x[j * nrhs + c];
      const d = r[i * n + i];
      if (Math.abs(d) <= EPS * m * Math.abs(r[0])) throw new LinearAlgebraError('The matrix does not have full column rank.');
      x[i * nrhs + c] = sum / d;
    }
  }
  return x;
}

// Singular value decomposition A = U diag(s) Vᵀ of an m × n matrix by one-sided Jacobi rotations
// (Hestenes 1958; Demmel & Veselić 1992, SIAM J Matrix Anal Appl 13:1204), which computes small
// singular values to high relative accuracy. With k = min(m, n): U is m × k, s has k values in
// decreasing order, V is n × k. Columns of U that belong to zero singular values are zero.
export function svd(a, m, n, options = {}) {
  if (m < n) {
    const t = svd(transpose(a, m, n), n, m, options);
    return { u: t.v, s: t.s, v: t.u, k: t.k };
  }
  const maxSweeps = options.maxSweeps ?? 60;
  // Rotations stop once every column pair is orthogonal to rounding level (≈ m·ε).
  const tol = options.tolerance ?? m * EPS;
  // Work on Aᵀ so that each column of A is a contiguous row.
  const w = transpose(a, m, n);
  const v = identity(n); // row j of v holds column j of V (v is Vᵀ while we work)
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let rotated = false;
    for (let p = 0; p < n - 1; p += 1) {
      const rp = p * m;
      for (let q = p + 1; q < n; q += 1) {
        const rq = q * m;
        let alpha = 0; let beta = 0; let gamma = 0;
        for (let i = 0; i < m; i += 1) {
          const x = w[rp + i];
          const y = w[rq + i];
          alpha += x * x;
          beta += y * y;
          gamma += x * y;
        }
        if (gamma === 0 || Math.abs(gamma) <= tol * Math.sqrt(alpha * beta)) continue;
        rotated = true;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = c * t;
        for (let i = 0; i < m; i += 1) {
          const x = w[rp + i];
          const y = w[rq + i];
          w[rp + i] = c * x - s * y;
          w[rq + i] = s * x + c * y;
        }
        const vp = p * n;
        const vq = q * n;
        for (let i = 0; i < n; i += 1) {
          const x = v[vp + i];
          const y = v[vq + i];
          v[vp + i] = c * x - s * y;
          v[vq + i] = s * x + c * y;
        }
      }
    }
    if (!rotated) break;
  }
  const sigma = new Float64Array(n);
  for (let j = 0; j < n; j += 1) {
    let sum = 0;
    for (let i = 0; i < m; i += 1) sum += w[j * m + i] * w[j * m + i];
    sigma[j] = Math.sqrt(sum);
  }
  const order = Array.from({ length: n }, (_, j) => j).sort((x, y) => sigma[y] - sigma[x]);
  const k = n;
  const u = new Float64Array(m * k);
  const vOut = new Float64Array(n * k);
  const s = new Float64Array(k);
  const floor = (sigma[order[0]] || 0) * EPS * m;
  for (let c = 0; c < k; c += 1) {
    const j = order[c];
    s[c] = sigma[j];
    if (sigma[j] > floor && sigma[j] > 0) {
      for (let i = 0; i < m; i += 1) u[i * k + c] = w[j * m + i] / sigma[j];
    }
    for (let i = 0; i < n; i += 1) vOut[i * k + c] = v[j * n + i];
  }
  return { u, s, v: vOut, k };
}

// Moore–Penrose pseudo-inverse (n × m) of an m × n matrix, from the SVD. Singular values below
// tolerance × s_max are treated as zero (default tolerance max(m, n) · ε, as in NumPy/MATLAB).
export function pseudoInverse(a, m, n, options = {}) {
  const { u, s, v, k } = options.svd ?? svd(a, m, n);
  const tol = (options.tolerance ?? Math.max(m, n) * EPS) * (s[0] || 0);
  const out = new Float64Array(n * m);
  for (let c = 0; c < k; c += 1) {
    if (!(s[c] > tol)) continue;
    const inv = 1 / s[c];
    for (let i = 0; i < n; i += 1) {
      const vi = v[i * k + c] * inv;
      if (vi === 0) continue;
      const row = i * m;
      for (let j = 0; j < m; j += 1) out[row + j] += vi * u[j * k + c];
    }
  }
  return out;
}

// Condition number in the 2-norm, s_max / s_min (Infinity when rank deficient).
export function conditionNumber(a, m, n) {
  const { s } = svd(a, m, n);
  const min = s[s.length - 1];
  return min > 0 ? s[0] / min : Infinity;
}

// Numerical rank: singular values above tolerance × s_max.
export function rank(a, m, n, tolerance = Math.max(m, n) * EPS) {
  const { s } = svd(a, m, n);
  let r = 0;
  for (let i = 0; i < s.length; i += 1) if (s[i] > tolerance * s[0]) r += 1;
  return r;
}

// Eigen-decomposition of a symmetric n × n matrix by cyclic Jacobi rotations (Golub & Van Loan
// §8.5). Returns eigenvalues in decreasing order and eigenvectors as the columns of an n × n
// matrix (vectors[i * n + c] is component i of eigenvector c).
export function symmetricEigen(a, n, options = {}) {
  const maxSweeps = options.maxSweeps ?? 100;
  const m = Float64Array.from(a);
  const vec = identity(n);
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let off = 0;
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const x = m[i * n + j] * m[i * n + j];
        total += x;
        if (i !== j) off += x;
      }
    }
    if (off <= 1e-30 * total || off === 0) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = m[p * n + q];
        if (apq === 0) continue;
        const theta = (m[q * n + q] - m[p * n + p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = m[k * n + p];
          const akq = m[k * n + q];
          m[k * n + p] = c * akp - s * akq;
          m[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = m[p * n + k];
          const aqk = m[q * n + k];
          m[p * n + k] = c * apk - s * aqk;
          m[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = vec[k * n + p];
          const vkq = vec[k * n + q];
          vec[k * n + p] = c * vkp - s * vkq;
          vec[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => m[y * n + y] - m[x * n + x]);
  const values = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  order.forEach((j, c) => {
    values[c] = m[j * n + j];
    for (let i = 0; i < n; i += 1) vectors[i * n + c] = vec[i * n + j];
  });
  return { values, vectors };
}

// --- Non-negative least squares ---------------------------------------------------------------

// Workspace for nnlsGramInPlace, so per-event solves allocate nothing.
export function createNNLSWorkspace(n) {
  return {
    n,
    passive: new Uint8Array(n),
    skip: new Uint8Array(n),
    z: new Float64Array(n),
    sub: new Float64Array(n * n),
    rhs: new Float64Array(n),
    list: new Int32Array(n),
    flip: new Int32Array(n),
    iterations: 0,
  };
}

// Least squares restricted to the passive set: G_PP z_P = b_P, z = 0 elsewhere.
function solvePassive(g, b, n, ws) {
  const { passive, z, sub, rhs, list } = ws;
  let p = 0;
  for (let f = 0; f < n; f += 1) if (passive[f]) list[p++] = f;
  z.fill(0);
  if (!p) return;
  let ridge = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for (let i = 0; i < p; i += 1) {
      const gi = list[i] * n;
      for (let j = 0; j <= i; j += 1) sub[i * p + j] = g[gi + list[j]];
      sub[i * p + i] += ridge;
      rhs[i] = b[list[i]];
    }
    if (choleskyInPlace(sub, p)) break;
    // A passive set with (nearly) collinear columns: regularize slightly and retry.
    let maxDiag = 0;
    for (let i = 0; i < p; i += 1) maxDiag = Math.max(maxDiag, g[list[i] * n + list[i]]);
    ridge = (ridge ? ridge * 1e3 : 1e-12) * (maxDiag || 1);
    if (attempt === 3) return;
  }
  choleskySolveInPlace(sub, rhs, p);
  for (let i = 0; i < p; i += 1) z[list[i]] = rhs[i];
}

// Non-negative least squares on the normal equations: minimizes ½ xᵀ G x − bᵀ x subject to x ≥ 0,
// where G = AᵀA and b = Aᵀy (so it solves min ‖A x − y‖² with x ≥ 0). This is the Lawson–Hanson
// active-set method (Solving Least Squares Problems, 1974, ch. 23) in the Gram form of Bro & De
// Jong (J Chemometrics 1997, doi:10.1002/(SICI)1099-128X(199709/10)11:5<393::AID-CEM483>3.0.CO;2-L),
// which pays off when many problems share one A. `x` holds a warm start on entry (its positive
// entries seed the passive set; pass zeros for a cold start) and the solution on exit. Returns
// the number of outer iterations.
export function nnlsGramInPlace(g, b, n, x, ws = createNNLSWorkspace(n), options = {}) {
  const maxIter = options.maxIterations ?? 3 * n;
  let scale = 0;
  for (let f = 0; f < n; f += 1) scale = Math.max(scale, Math.abs(b[f]));
  const tol = (options.tolerance ?? 1e-10) * (scale || 1);
  const { passive, skip, z } = ws;
  // Phase 0: from the warm start, drop variables until the restricted solution is feasible.
  for (let f = 0; f < n; f += 1) passive[f] = x[f] > 0 ? 1 : 0;
  for (let guard = 0; guard <= n; guard += 1) {
    solvePassive(g, b, n, ws);
    let feasible = true;
    for (let f = 0; f < n; f += 1) {
      if (passive[f] && !(z[f] > 0)) {
        passive[f] = 0;
        feasible = false;
      }
    }
    if (feasible) break;
  }
  for (let f = 0; f < n; f += 1) x[f] = passive[f] ? z[f] : 0;
  skip.fill(0);
  let iter = 0;
  for (; iter < maxIter; iter += 1) {
    // The most positive component of the negative gradient w = b − G x among inactive variables.
    let best = -1;
    let bestW = tol;
    for (let f = 0; f < n; f += 1) {
      if (passive[f] || skip[f]) continue;
      let wf = b[f];
      const row = f * n;
      for (let k = 0; k < n; k += 1) if (passive[k]) wf -= g[row + k] * x[k];
      if (wf > bestW) {
        bestW = wf;
        best = f;
      }
    }
    if (best < 0) break;
    passive[best] = 1;
    solvePassive(g, b, n, ws);
    if (!(z[best] > 0)) {
      // Degenerate step (rounding): leave the variable out rather than cycle.
      passive[best] = 0;
      skip[best] = 1;
      continue;
    }
    for (let guard = 0; guard <= n; guard += 1) {
      let alpha = Infinity;
      let leaving = -1;
      for (let f = 0; f < n; f += 1) {
        if (passive[f] && !(z[f] > 0)) {
          const t = x[f] / (x[f] - z[f]);
          if (t < alpha) {
            alpha = t;
            leaving = f;
          }
        }
      }
      if (leaving < 0) break;
      for (let f = 0; f < n; f += 1) {
        if (!passive[f]) continue;
        x[f] += alpha * (z[f] - x[f]);
        if (f === leaving || !(x[f] > 0)) {
          x[f] = 0;
          passive[f] = 0;
        }
      }
      solvePassive(g, b, n, ws);
    }
    for (let f = 0; f < n; f += 1) x[f] = passive[f] ? z[f] : 0;
    skip.fill(0);
  }
  ws.iterations = iter;
  return iter;
}

// The same problem by block principal pivoting (Júdice & Pires 1994; Kim & Park 2011, SIAM J Sci
// Comput 33:3261, doi:10.1137/110821172): every infeasible variable (negative in the passive set,
// or with a negative gradient outside it) switches sets at once, so a good warm start converges in
// a few solves instead of one solve per variable. Kim & Park's backup rule (after 3 steps that do
// not reduce the number of infeasible variables, switch only the largest index) guarantees
// termination; if `maxIterations` is still reached, Lawson–Hanson finishes from the current
// point. Same arguments and result as nnlsGramInPlace; returns the number of solves. On badly
// conditioned Gram matrices the exchanges can oscillate for many steps, where Lawson–Hanson's
// one-variable steps are faster; on well-conditioned ones the two cost about the same.
export function nnlsBlockPivotInPlace(g, b, n, x, ws = createNNLSWorkspace(n), options = {}) {
  const maxIter = options.maxIterations ?? 5 * n;
  let scale = 0;
  for (let f = 0; f < n; f += 1) scale = Math.max(scale, Math.abs(b[f]));
  const tol = (options.tolerance ?? 1e-10) * (scale || 1);
  const { passive, z, flip } = ws;
  for (let f = 0; f < n; f += 1) passive[f] = x[f] > 0 ? 1 : 0;
  let best = n + 1;
  let lives = 3;
  for (let iter = 1; iter <= maxIter; iter += 1) {
    solvePassive(g, b, n, ws);
    // Infeasible variables: negative passive values (beyond rounding) and active variables whose
    // objective would decrease if released (gradient (G z − b)_f < 0).
    let count = 0;
    let last = -1;
    let zScale = 0;
    for (let f = 0; f < n; f += 1) if (passive[f]) zScale = Math.max(zScale, Math.abs(z[f]));
    const zTol = 1e-12 * zScale;
    for (let f = 0; f < n; f += 1) {
      let bad;
      if (passive[f]) bad = z[f] < -zTol;
      else {
        let grad = -b[f];
        const row = f * n;
        for (let k = 0; k < n; k += 1) if (passive[k]) grad += g[row + k] * z[k];
        bad = grad < -tol;
      }
      if (bad) {
        flip[count] = f;
        count += 1;
        last = f;
      }
    }
    if (!count) {
      for (let f = 0; f < n; f += 1) x[f] = passive[f] && z[f] > 0 ? z[f] : 0;
      ws.iterations = iter;
      return iter;
    }
    let flipAll = true;
    if (count < best) {
      best = count;
      lives = 3;
    } else if (lives > 0) lives -= 1;
    else flipAll = false;
    if (flipAll) for (let i = 0; i < count; i += 1) passive[flip[i]] ^= 1;
    else passive[last] ^= 1;
  }
  // Fall back to Lawson–Hanson from the feasible part of the last solution.
  for (let f = 0; f < n; f += 1) x[f] = passive[f] && z[f] > 0 ? z[f] : 0;
  return maxIter + nnlsGramInPlace(g, b, n, x, ws, options);
}

// Convenience NNLS for one problem: min ‖A x − y‖² subject to x ≥ 0, A m × n.
export function nonNegativeLeastSquares(a, y, m, n, options = {}) {
  const g = crossProduct(a, m, n);
  const b = new Float64Array(n);
  for (let i = 0; i < m; i += 1) {
    const yi = y[i];
    for (let j = 0; j < n; j += 1) b[j] += a[i * n + j] * yi;
  }
  const x = new Float64Array(n);
  nnlsGramInPlace(g, b, n, x, createNNLSWorkspace(n), options);
  return x;
}
