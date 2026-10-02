// Nonlinear least-squares fitting for CytoWeave's models (cell cycle, proliferation, …).
//
// levenbergMarquardt() minimises χ² = Σ wᵢ (yᵢ − fᵢ(p))² by the Levenberg–Marquardt method
// (Levenberg 1944; Marquardt 1963, doi:10.1137/0111030) with Marquardt's diagonal scaling of the
// normal equations and Nielsen's (1999, IMM-REP-1999-05) damping update. Box bounds are enforced
// by projecting every trial point onto the box (a projected LM); parameters that finish on a
// bound are flagged, since their standard errors come from local curvature only.
// nelderMead() is the derivative-free simplex method (Nelder & Mead 1965,
// doi:10.1093/comjnl/7.4.308) with the dimension-adaptive coefficients of Gao & Han (2012,
// doi:10.1007/s10589-010-9329-3); fitLeastSquares() uses it as a fallback when LM stalls.
//
// A model is a function (params, out) that writes its predictions for every data point into
// `out` (a Float64Array of the data length). It may return an array instead of filling `out`.

const SQRT_EPS = 1.4901161193847656e-8;

function project(p, lower, upper) {
  for (let j = 0; j < p.length; j += 1) {
    if (lower && lower[j] !== undefined && lower[j] !== null && p[j] < lower[j]) p[j] = lower[j];
    if (upper && upper[j] !== undefined && upper[j] !== null && p[j] > upper[j]) p[j] = upper[j];
  }
  return p;
}

function weightsFrom(options, n) {
  if (options.weights) return Float64Array.from(options.weights);
  if (options.sigma) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i += 1) w[i] = 1 / (options.sigma[i] * options.sigma[i]);
    return w;
  }
  return null;
}

function weightedCost(y, f, w) {
  let sum = 0;
  for (let i = 0; i < y.length; i += 1) {
    const r = y[i] - f[i];
    sum += w ? w[i] * r * r : r * r;
  }
  return sum;
}

// In-place Cholesky factorisation of a symmetric k×k matrix (row-major). Returns false when the
// matrix is not numerically positive definite.
export function cholesky(a, k) {
  for (let j = 0; j < k; j += 1) {
    let d = a[j * k + j];
    for (let s = 0; s < j; s += 1) d -= a[j * k + s] * a[j * k + s];
    if (!(d > 0) || !Number.isFinite(d)) return false;
    const l = Math.sqrt(d);
    a[j * k + j] = l;
    for (let i = j + 1; i < k; i += 1) {
      let v = a[i * k + j];
      for (let s = 0; s < j; s += 1) v -= a[i * k + s] * a[j * k + s];
      a[i * k + j] = v / l;
    }
  }
  return true;
}

// Solves L Lᵀ x = b given the factor from cholesky(); overwrites and returns x.
export function choleskySolve(l, k, b, x = new Float64Array(k)) {
  for (let i = 0; i < k; i += 1) {
    let v = b[i];
    for (let s = 0; s < i; s += 1) v -= l[i * k + s] * x[s];
    x[i] = v / l[i * k + i];
  }
  for (let i = k - 1; i >= 0; i -= 1) {
    let v = x[i];
    for (let s = i + 1; s < k; s += 1) v -= l[s * k + i] * x[s];
    x[i] = v / l[i * k + i];
  }
  return x;
}

// Inverse of a symmetric positive-definite k×k matrix, or null if it is singular. Used for
// parameter covariances (Jᵀ W J)⁻¹.
export function invertSymmetric(a, k) {
  // Scale to unit diagonal first so badly scaled parameters (means of 10⁵, CVs of 10⁻²) do not
  // defeat the positive-definiteness test.
  const scale = new Float64Array(k);
  for (let i = 0; i < k; i += 1) scale[i] = a[i * k + i] > 0 ? 1 / Math.sqrt(a[i * k + i]) : 0;
  for (let i = 0; i < k; i += 1) if (!scale[i]) return null;
  const l = new Float64Array(k * k);
  for (let i = 0; i < k; i += 1) for (let j = 0; j < k; j += 1) l[i * k + j] = a[i * k + j] * scale[i] * scale[j];
  if (!cholesky(l, k)) return null;
  const inv = new Float64Array(k * k);
  const e = new Float64Array(k);
  const col = new Float64Array(k);
  for (let j = 0; j < k; j += 1) {
    e.fill(0);
    e[j] = 1;
    choleskySolve(l, k, e, col);
    for (let i = 0; i < k; i += 1) inv[i * k + j] = col[i] * scale[i] * scale[j];
  }
  return inv;
}

// Levenberg–Marquardt. `model(params, out)` fills predictions; `y` is the data; `p0` the start.
// Options:
//   weights | sigma          per-point weights wᵢ, or standard deviations (w = 1/σ²)
//   lower, upper             bound arrays (entries may be null/undefined for unbounded)
//   fixed                    boolean array: parameters held at their starting value
//   jacobian(params, J)      analytic Jacobian, J row-major n×m (∂fᵢ/∂pⱼ at J[i*m+j])
//   typical                  typical magnitudes for finite-difference steps (default |p0| or 1)
//   centralDifferences       two-sided numerical derivatives (twice the cost, more accurate)
//   maxIterations (200), ftol (1e-14: stop when the linearised model can lower χ² by less than
//   ftol·χ²), xtol (1e-10, relative step), gtol (1e-10), lambda (1e-3)
//   absoluteSigma            if true, covariance = (JᵀWJ)⁻¹ (weights are true 1/σ²); otherwise it
//                            is scaled by the reduced χ², as scipy's curve_fit does by default
//   signal                   AbortSignal-like { aborted }
// Returns { params, standardErrors, covariance (m×m row-major), chiSquare, reducedChiSquare,
//   dof, iterations, evaluations, converged, reason, atBound, fitted, residuals }.
export function levenbergMarquardt(model, p0, y, options = {}) {
  const n = y.length;
  const m = p0.length;
  if (!n) throw new Error('There are no data points to fit.');
  const lower = options.lower ?? null;
  const upper = options.upper ?? null;
  const fixed = options.fixed ?? null;
  const maxIterations = options.maxIterations ?? 200;
  const ftol = options.ftol ?? 1e-14;
  const xtol = options.xtol ?? 1e-10;
  const gtol = options.gtol ?? 1e-10;
  const central = Boolean(options.centralDifferences);
  const w = weightsFrom(options, n);
  const free = [];
  for (let j = 0; j < m; j += 1) if (!(fixed && fixed[j])) free.push(j);
  const k = free.length;
  const typical = new Float64Array(m);
  for (let j = 0; j < m; j += 1) typical[j] = options.typical?.[j] ?? (Math.abs(p0[j]) || 1);

  let evaluations = 0;
  const evaluate = (params, out) => {
    const result = model(params, out);
    evaluations += 1;
    if (result && result !== out) out.set(result);
    return out;
  };

  const p = project(Float64Array.from(p0), lower, upper);
  let f = evaluate(p, new Float64Array(n));
  let fTrial = new Float64Array(n);
  const fPlus = new Float64Array(n);
  const fMinus = new Float64Array(n);
  let cost = weightedCost(y, f, w);
  if (!Number.isFinite(cost)) throw new Error('The model gives non-finite values at the starting parameters.');

  const J = new Float64Array(n * k);
  const fullJ = options.jacobian ? new Float64Array(n * m) : null;
  const A = new Float64Array(k * k);
  const g = new Float64Array(k);
  const M = new Float64Array(k * k);
  const delta = new Float64Array(k);
  const step = new Float64Array(k);
  const movableIndex = new Int32Array(k);
  const gSub = new Float64Array(k);
  const deltaSub = new Float64Array(k);
  const pTrial = new Float64Array(m);

  const computeJacobian = (params, fx) => {
    if (fullJ) {
      fullJ.fill(0);
      options.jacobian(params, fullJ);
      for (let i = 0; i < n; i += 1) for (let c = 0; c < k; c += 1) J[i * k + c] = fullJ[i * m + free[c]];
      return;
    }
    const pt = Float64Array.from(params);
    for (let c = 0; c < k; c += 1) {
      const j = free[c];
      let h = SQRT_EPS * Math.max(Math.abs(params[j]), typical[j]);
      const hasUpper = upper && upper[j] !== undefined && upper[j] !== null;
      const hasLower = lower && lower[j] !== undefined && lower[j] !== null;
      if (central && !(hasUpper && params[j] + h > upper[j]) && !(hasLower && params[j] - h < lower[j])) {
        pt[j] = params[j] + h;
        const hp = pt[j] - params[j];
        evaluate(pt, fPlus);
        pt[j] = params[j] - h;
        const hm = params[j] - pt[j];
        evaluate(pt, fMinus);
        for (let i = 0; i < n; i += 1) J[i * k + c] = (fPlus[i] - fMinus[i]) / (hp + hm);
      } else {
        if (hasUpper && params[j] + h > upper[j]) h = -h;
        pt[j] = params[j] + h;
        const hh = pt[j] - params[j];
        evaluate(pt, fPlus);
        for (let i = 0; i < n; i += 1) J[i * k + c] = (fPlus[i] - fx[i]) / hh;
      }
      pt[j] = params[j];
    }
  };

  const normalEquations = () => {
    A.fill(0);
    g.fill(0);
    for (let i = 0; i < n; i += 1) {
      const wi = w ? w[i] : 1;
      if (!wi) continue;
      const r = (y[i] - f[i]) * wi;
      const row = i * k;
      for (let a = 0; a < k; a += 1) {
        const ja = J[row + a];
        if (!ja) continue;
        g[a] += ja * r;
        const wja = wi * ja;
        for (let b = 0; b <= a; b += 1) A[a * k + b] += wja * J[row + b];
      }
    }
    for (let a = 0; a < k; a += 1) for (let b = 0; b < a; b += 1) A[b * k + a] = A[a * k + b];
  };

  let lambda = options.lambda ?? 1e-3;
  let nu = 2;
  let iterations = 0;
  let converged = false;
  let reason = 'maximum iterations reached';
  if (k === 0) {
    converged = true;
    reason = 'no free parameters';
  } else {
    computeJacobian(p, f);
    normalEquations();
  }

  while (!converged && iterations < maxIterations) {
    if (options.signal?.aborted) throw new Error('The fit was cancelled.');
    iterations += 1;
    // Active set: free parameters sitting on a bound whose descent direction (+g, since
    // ∂χ²/∂p = −2g) points out of the box are held for this iteration, so the others can still
    // reach their conditional optimum.
    let movable = 0;
    for (let c = 0; c < k; c += 1) {
      const j = free[c];
      const atLower = lower && lower[j] !== undefined && lower[j] !== null && p[j] <= lower[j] && g[c] < 0;
      const atUpper = upper && upper[j] !== undefined && upper[j] !== null && p[j] >= upper[j] && g[c] > 0;
      if (!(atLower || atUpper)) movableIndex[movable++] = c;
    }
    if (movable === 0) {
      converged = true;
      reason = 'all parameters on bounds';
      break;
    }
    // Gradient test: cosine between the residual vector and each Jacobian column (MINPACK gtol).
    let gnorm = 0;
    for (let s = 0; s < movable; s += 1) {
      const a = movableIndex[s];
      const d = Math.sqrt(A[a * k + a] * cost);
      if (d > 0) gnorm = Math.max(gnorm, Math.abs(g[a]) / d);
    }
    if (!(gnorm > gtol)) {
      converged = true;
      reason = 'gradient below tolerance';
      break;
    }
    // χ² test: the largest decrease the linearised model still allows, gᵀA⁻¹g, is computed from
    // the gradient (no cancellation), so it resolves changes far below the rounding of χ² itself.
    for (let s = 0; s < movable; s += 1) {
      gSub[s] = g[movableIndex[s]];
      for (let t = 0; t < movable; t += 1) M[s * movable + t] = A[movableIndex[s] * k + movableIndex[t]];
    }
    if (cholesky(M, movable)) {
      choleskySolve(M, movable, gSub, deltaSub);
      let remaining = 0;
      for (let s = 0; s < movable; s += 1) remaining += gSub[s] * deltaSub[s];
      if (remaining <= ftol * cost) {
        converged = true;
        reason = 'χ² change below tolerance';
        break;
      }
    }
    let accepted = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      for (let s = 0; s < movable; s += 1) {
        const a = movableIndex[s];
        gSub[s] = g[a];
        for (let t = 0; t < movable; t += 1) M[s * movable + t] = A[a * k + movableIndex[t]];
        M[s * movable + s] += lambda * Math.max(A[a * k + a], 1e-30);
      }
      if (!cholesky(M, movable)) {
        lambda *= nu;
        nu *= 2;
        continue;
      }
      choleskySolve(M, movable, gSub, deltaSub);
      delta.fill(0);
      for (let s = 0; s < movable; s += 1) delta[movableIndex[s]] = deltaSub[s];
      pTrial.set(p);
      for (let c = 0; c < k; c += 1) pTrial[free[c]] += delta[c];
      project(pTrial, lower, upper);
      let small = true;
      for (let c = 0; c < k; c += 1) {
        const j = free[c];
        step[c] = pTrial[j] - p[j];
        if (Math.abs(step[c]) > xtol * (Math.abs(p[j]) + xtol)) small = false;
      }
      if (small) {
        converged = true;
        reason = 'step below tolerance';
        break;
      }
      evaluate(pTrial, fTrial);
      // χ²(trial) − χ²(current) = Σ w (f − f′)(2y − f − f′): exact even for tiny changes.
      let change = 0;
      for (let i = 0; i < n; i += 1) {
        const d = (f[i] - fTrial[i]) * (2 * y[i] - f[i] - fTrial[i]);
        change += w ? w[i] * d : d;
      }
      // Gauss–Newton predicted reduction for the (projected) step.
      let predicted = 0;
      for (let a = 0; a < k; a += 1) {
        let as = 0;
        for (let b = 0; b < k; b += 1) as += A[a * k + b] * step[b];
        predicted += step[a] * (2 * g[a] - as);
      }
      if (Number.isFinite(change) && change < 0) {
        const rho = predicted > 0 ? -change / predicted : 0.5;
        lambda = Math.max(lambda * Math.max(1 / 3, 1 - (2 * rho - 1) ** 3), 1e-15);
        nu = 2;
        p.set(pTrial);
        const swap = f;
        f = fTrial;
        fTrial = swap;
        cost = weightedCost(y, f, w);
        accepted = true;
        break;
      }
      lambda *= nu;
      nu *= 2;
      if (lambda > 1e20) break;
    }
    if (converged) break;
    if (!accepted) {
      // No step reduces χ² even with heavy damping: a minimum within numerical precision.
      converged = true;
      reason = 'no further improvement';
      break;
    }
    computeJacobian(p, f);
    normalEquations();
  }

  const dof = n - k;
  const reducedChiSquare = dof > 0 ? cost / dof : Number.NaN;
  const covariance = new Float64Array(m * m);
  const standardErrors = new Float64Array(m);
  let singular = false;
  if (k > 0) {
    // A = JᵀWJ is always current here: it is recomputed after every accepted step.
    const inv = invertSymmetric(A, k);
    const factor = options.absoluteSigma ? 1 : (dof > 0 ? reducedChiSquare : Number.NaN);
    if (!inv) {
      singular = true;
      standardErrors.fill(Number.NaN);
      covariance.fill(Number.NaN);
    } else {
      for (let a = 0; a < k; a += 1) {
        for (let b = 0; b < k; b += 1) covariance[free[a] * m + free[b]] = inv[a * k + b] * factor;
      }
      for (let j = 0; j < m; j += 1) standardErrors[j] = Math.sqrt(Math.max(0, covariance[j * m + j]));
    }
  }
  const atBound = new Array(m).fill(false);
  for (let j = 0; j < m; j += 1) {
    if (fixed && fixed[j]) continue;
    if (lower && lower[j] !== undefined && lower[j] !== null && p[j] <= lower[j]) atBound[j] = true;
    if (upper && upper[j] !== undefined && upper[j] !== null && p[j] >= upper[j]) atBound[j] = true;
  }
  const residuals = new Float64Array(n);
  for (let i = 0; i < n; i += 1) residuals[i] = y[i] - f[i];
  return {
    params: p,
    standardErrors,
    covariance,
    chiSquare: cost,
    reducedChiSquare,
    dof,
    iterations,
    evaluations,
    converged,
    reason,
    singular,
    atBound,
    fitted: f,
    residuals,
  };
}

// Convenience wrapper for a scalar model fn(x, params) evaluated at each xᵢ.
// options.gradient(x, params, out) may give ∂f/∂p analytically. Other options as LM.
export function curveFit(fn, x, y, p0, options = {}) {
  const n = x.length;
  const m = p0.length;
  const model = (params, out) => {
    for (let i = 0; i < n; i += 1) out[i] = fn(x[i], params);
    return out;
  };
  let jacobian = options.jacobian;
  if (!jacobian && options.gradient) {
    const row = new Float64Array(m);
    jacobian = (params, J) => {
      for (let i = 0; i < n; i += 1) {
        row.fill(0);
        options.gradient(x[i], params, row);
        for (let j = 0; j < m; j += 1) J[i * m + j] = row[j];
      }
    };
  }
  return levenbergMarquardt(model, p0, y, { ...options, jacobian });
}

// Nelder–Mead minimisation of objective(params) → number. Bounds by projection of vertices.
// Options: lower, upper, step (per-parameter initial simplex size; default 5% of |p0| or
// 0.00025), maxIterations (200·m), maxEvaluations (400·m), xtol (1e-8, relative), ftol (1e-10,
// relative), adaptive (default true for m > 2), signal.
// Returns { params, value, iterations, evaluations, converged }.
export function nelderMead(objective, p0, options = {}) {
  const m = p0.length;
  const lower = options.lower ?? null;
  const upper = options.upper ?? null;
  const maxIterations = options.maxIterations ?? 200 * m;
  const maxEvaluations = options.maxEvaluations ?? 400 * m;
  const xtol = options.xtol ?? 1e-8;
  const ftol = options.ftol ?? 1e-10;
  const adaptive = options.adaptive ?? m > 2;
  const alpha = 1;
  const gamma = adaptive ? 1 + 2 / m : 2;
  const rho = adaptive ? 0.75 - 1 / (2 * m) : 0.5;
  const sigma = adaptive ? 1 - 1 / m : 0.5;
  let evaluations = 0;
  const f = (x) => {
    evaluations += 1;
    const v = objective(x);
    return Number.isFinite(v) ? v : Infinity;
  };
  const scale = new Float64Array(m);
  const simplex = [];
  const values = new Float64Array(m + 1);
  const start = project(Float64Array.from(p0), lower, upper);
  simplex.push(start);
  for (let j = 0; j < m; j += 1) {
    const s = options.step?.[j] ?? (start[j] !== 0 ? 0.05 * Math.abs(start[j]) : 0.00025);
    scale[j] = Math.abs(s) || 1e-12;
    const v = Float64Array.from(start);
    v[j] += s;
    project(v, lower, upper);
    if (v[j] === start[j]) {
      v[j] -= 2 * s;
      project(v, lower, upper);
    }
    simplex.push(v);
  }
  for (let i = 0; i <= m; i += 1) values[i] = f(simplex[i]);
  const order = Array.from({ length: m + 1 }, (_, i) => i);
  const centroid = new Float64Array(m);
  const xr = new Float64Array(m);
  const xe = new Float64Array(m);
  const xc = new Float64Array(m);
  let iterations = 0;
  let converged = false;
  while (iterations < maxIterations && evaluations < maxEvaluations) {
    if (options.signal?.aborted) throw new Error('The fit was cancelled.');
    order.sort((a, b) => values[a] - values[b]);
    const best = order[0];
    const worst = order[m];
    let fSpread = 0;
    let xSpread = 0;
    for (let i = 1; i <= m; i += 1) {
      const v = order[i];
      fSpread = Math.max(fSpread, Math.abs(values[v] - values[best]));
      for (let j = 0; j < m; j += 1) {
        const ref = Math.max(Math.abs(simplex[best][j]), scale[j] * 1e-3);
        xSpread = Math.max(xSpread, Math.abs(simplex[v][j] - simplex[best][j]) / ref);
      }
    }
    if (fSpread <= ftol * Math.abs(values[best]) + 1e-300 && xSpread <= xtol) {
      converged = true;
      break;
    }
    iterations += 1;
    centroid.fill(0);
    for (let i = 0; i < m; i += 1) {
      const v = simplex[order[i]];
      for (let j = 0; j < m; j += 1) centroid[j] += v[j] / m;
    }
    const xw = simplex[worst];
    for (let j = 0; j < m; j += 1) xr[j] = centroid[j] + alpha * (centroid[j] - xw[j]);
    project(xr, lower, upper);
    const fr = f(xr);
    const secondWorst = values[order[m - 1]];
    if (fr < values[best]) {
      for (let j = 0; j < m; j += 1) xe[j] = centroid[j] + gamma * (xr[j] - centroid[j]);
      project(xe, lower, upper);
      const fe = f(xe);
      if (fe < fr) {
        xw.set(xe);
        values[worst] = fe;
      } else {
        xw.set(xr);
        values[worst] = fr;
      }
      continue;
    }
    if (fr < secondWorst) {
      xw.set(xr);
      values[worst] = fr;
      continue;
    }
    let shrink = false;
    if (fr < values[worst]) {
      for (let j = 0; j < m; j += 1) xc[j] = centroid[j] + rho * (xr[j] - centroid[j]);
      project(xc, lower, upper);
      const fc = f(xc);
      if (fc <= fr) {
        xw.set(xc);
        values[worst] = fc;
      } else shrink = true;
    } else {
      for (let j = 0; j < m; j += 1) xc[j] = centroid[j] - rho * (centroid[j] - xw[j]);
      project(xc, lower, upper);
      const fc = f(xc);
      if (fc < values[worst]) {
        xw.set(xc);
        values[worst] = fc;
      } else shrink = true;
    }
    if (shrink) {
      const xb = simplex[best];
      for (let i = 1; i <= m; i += 1) {
        const v = simplex[order[i]];
        for (let j = 0; j < m; j += 1) v[j] = xb[j] + sigma * (v[j] - xb[j]);
        project(v, lower, upper);
        values[order[i]] = f(v);
      }
    }
  }
  let best = 0;
  for (let i = 1; i <= m; i += 1) if (values[i] < values[best]) best = i;
  return { params: Float64Array.from(simplex[best]), value: values[best], iterations, evaluations, converged };
}

// Levenberg–Marquardt with a Nelder–Mead fallback: if LM fails to converge or throws on a
// non-finite step, the simplex method minimises χ² from the best point so far and LM restarts
// from there (to polish and to obtain the covariance). Returns the LM result plus `method`.
export function fitLeastSquares(model, p0, y, options = {}) {
  let first = null;
  try {
    first = levenbergMarquardt(model, p0, y, options);
    if (first.converged && Number.isFinite(first.chiSquare)) return { ...first, method: 'levenberg-marquardt' };
  } catch (error) {
    if (options.signal?.aborted) throw error;
  }
  const n = y.length;
  const w = weightsFrom(options, n);
  const scratch = new Float64Array(n);
  const fixed = options.fixed ?? null;
  const freeIndex = [];
  for (let j = 0; j < p0.length; j += 1) if (!(fixed && fixed[j])) freeIndex.push(j);
  const startFull = Float64Array.from(first ? first.params : p0);
  const full = Float64Array.from(startFull);
  const objective = (q) => {
    for (let c = 0; c < freeIndex.length; c += 1) full[freeIndex[c]] = q[c];
    const out = model(full, scratch);
    return weightedCost(y, out && out !== scratch ? out : scratch, w);
  };
  const sub = (array) => (array ? freeIndex.map((j) => array[j]) : null);
  const simplex = nelderMead(objective, freeIndex.map((j) => startFull[j]), {
    lower: sub(options.lower),
    upper: sub(options.upper),
    maxIterations: options.nelderMeadIterations ?? 2000 * Math.max(1, freeIndex.length),
    maxEvaluations: options.nelderMeadEvaluations ?? 4000 * Math.max(1, freeIndex.length),
    signal: options.signal,
  });
  const restart = Float64Array.from(startFull);
  for (let c = 0; c < freeIndex.length; c += 1) restart[freeIndex[c]] = simplex.params[c];
  let second = null;
  try {
    second = levenbergMarquardt(model, restart, y, options);
  } catch (error) {
    if (options.signal?.aborted) throw error;
  }
  const candidates = [first, second].filter((r) => r && Number.isFinite(r.chiSquare));
  if (!candidates.length) throw new Error('The model could not be fitted to these data.');
  candidates.sort((a, b) => a.chiSquare - b.chiSquare);
  return { ...candidates[0], method: 'nelder-mead+levenberg-marquardt' };
}

// --- Model-building helpers -------------------------------------------------------------------

// Complementary error function, fractional error < 1.2e-7 everywhere (Chebyshev fit from Press
// et al., Numerical Recipes in C, 2nd ed., §6.2). Smooth, so safe inside finite differences; fast
// enough for histogram models evaluated thousands of times. For p-values use hypothesis.js.
export function erfcFast(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const ans = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418
    + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587
    + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? ans : 2 - ans;
}

// Standard normal CDF via erfcFast (absolute error < 1e-7).
export function normalCdfFast(z) {
  return 0.5 * erfcFast(-z * Math.SQRT1_2);
}

// Adds a Gaussian of total `area` (mean, sd in data units) to histogram bins: bin b spans
// [firstEdge + b·binWidth, firstEdge + (b+1)·binWidth) and receives area × the Gaussian's mass
// in it (exact bin integration, so narrow peaks are not mis-scaled). Bins farther than 8 SD
// from the mean are skipped. Returns `out`.
export function addGaussianBins(out, firstEdge, binWidth, area, mean, sd, from = 0, to = out.length) {
  if (!(sd > 0) || !area) return out;
  const reach = 8 * sd;
  const b0 = Math.max(from, Math.floor((mean - reach - firstEdge) / binWidth));
  const b1 = Math.min(to - 1, Math.ceil((mean + reach - firstEdge) / binWidth));
  if (b1 < b0) return out;
  const inv = Math.SQRT1_2 / sd;
  let previous = erfcFast((mean - (firstEdge + b0 * binWidth)) * inv);
  for (let b = b0; b <= b1; b += 1) {
    const next = erfcFast((mean - (firstEdge + (b + 1) * binWidth)) * inv);
    out[b] += 0.5 * area * (next - previous);
    previous = next;
  }
  return out;
}

// Gaussian smoothing of a histogram (kernel SD in bins), reflecting at the edges. For finding
// peaks, not for fitting.
export function smoothCounts(counts, sdBins = 1.5) {
  const n = counts.length;
  const out = new Float64Array(n);
  if (!(sdBins > 0)) {
    out.set(counts);
    return out;
  }
  const half = Math.max(1, Math.ceil(3 * sdBins));
  const kernel = new Float64Array(2 * half + 1);
  let total = 0;
  for (let k = -half; k <= half; k += 1) {
    kernel[k + half] = Math.exp(-0.5 * (k / sdBins) ** 2);
    total += kernel[k + half];
  }
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let k = -half; k <= half; k += 1) {
      let j = i + k;
      if (j < 0) j = -j - 1;
      if (j >= n) j = 2 * n - j - 1;
      if (j < 0 || j >= n) continue;
      sum += kernel[k + half] * counts[j];
    }
    out[i] = sum / total;
  }
  return out;
}
