// limma's moderated t-statistics for many linear models at once (Smyth 2004), as diffcyt-DS-limma
// uses them: weighted least squares per row (lmFit with observation weights), one coefficient
// (contrasts.fit with a single coefficient), and empirical Bayes moderation of the residual
// variances with or without a mean-variance trend (eBayes, squeezeVar). Written from the R and C
// sources of limma 3.68.5 (GPL >= 2) and statmod 1.5 so that results equal R's (validation suite
// differential, reference/diffcyt.json): the trend is a natural cubic spline when every row
// has the same residual df (fitFDist; Smyth 2004, Phipson et al. 2016) and a weighted lowess
// with the prior df found by maximum likelihood when they differ (fitFDistUnequalDF1; Chen et al.
// 2025, edgeR v4). Not ported: robust=TRUE, blocking (duplicateCorrelation) and the B-statistic.

import { adjustPValues, digamma, logGamma, studentTSurvival, normalCDF, tetragamma, trigamma } from './hypothesis.js';

// --- Helpers as R computes them ------------------------------------------------------------------

const EPS = 2.220446049250313e-16;

// R's quantile(type = 7).
function quantile7(values, p) {
  const x = Float64Array.from(values).sort();
  const n = x.length;
  const index = 1 + Math.max(n - 1, 0) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const qs = x[lo - 1];
  const h = index - lo;
  return index > lo && x[hi - 1] !== qs ? (1 - h) * qs + h * x[hi - 1] : qs;
}

const median = (values) => quantileMedian(Float64Array.from(values).sort());
function quantileMedian(sorted) {
  const n = sorted.length;
  if (!n) return Number.NaN;
  const half = Math.floor((n + 1) / 2);
  return n % 2 ? sorted[half - 1] : (sorted[half - 1] + sorted[half]) / 2;
}

// statmod's logmdigamma: log(x) − digamma(x), without cancellation for large x.
export function logmdigamma(x) {
  if (!(x > 0)) return Number.NaN;
  if (x < 5) return Math.log(x / (x + 5)) + logmdigamma(x + 5) + 1 / x + 1 / (x + 1) + 1 / (x + 2) + 1 / (x + 3) + 1 / (x + 4);
  const r = 1 / (x * x);
  const tail = r * (-1 / 12 + r * (1 / 120 + r * (-1 / 252 + r * (1 / 240 + r * (-1 / 132 + r * (691 / 32760 + r * (-1 / 12 + (3617 * r) / 8160)))))));
  return 1 / (2 * x) - tail;
}

// limma's trigammaInverse: y with trigamma(y) = x, by Newton's method on 1/trigamma.
export function trigammaInverse(x) {
  if (Number.isNaN(x)) return x;
  if (x < 0) return Number.NaN;
  if (x > 1e7) return 1 / Math.sqrt(x);
  if (x < 1e-6) return 1 / x;
  let y = 0.5 + 1 / x;
  for (let iter = 1; iter <= 51; iter += 1) {
    const tri = trigamma(y);
    const dif = (tri * (1 - tri / x)) / tetragamma(y);
    y += dif;
    if (-dif / y < 1e-8) break;
  }
  return y;
}

// R's optimize (Brent's fmin, src/library/stats/src/optimize.c) with tol = .Machine$double.eps^0.25.
export function optimize(f, lower, upper, tol = Math.pow(EPS, 0.25)) {
  const c = (3 - Math.sqrt(5)) * 0.5;
  const eps = Math.sqrt(EPS);
  let a = lower;
  let b = upper;
  let v = a + c * (b - a);
  let w = v;
  let x = v;
  let d = 0;
  let e = 0;
  let fx = f(x);
  let fv = fx;
  let fw = fx;
  const tol3 = tol / 3;
  for (;;) {
    const xm = (a + b) * 0.5;
    const tol1 = eps * Math.abs(x) + tol3;
    const t2 = tol1 * 2;
    if (Math.abs(x - xm) <= t2 - (b - a) * 0.5) break;
    let p = 0;
    let q = 0;
    let r = 0;
    if (Math.abs(e) > tol1) {
      r = (x - w) * (fx - fv);
      q = (x - v) * (fx - fw);
      p = (x - v) * q - (x - w) * r;
      q = (q - r) * 2;
      if (q > 0) p = -p;
      else q = -q;
      r = e;
      e = d;
    }
    let u;
    if (Math.abs(p) >= Math.abs(q * 0.5 * r) || p <= q * (a - x) || p >= q * (b - x)) {
      e = x < xm ? b - x : a - x;
      d = c * e;
    } else {
      d = p / q;
      u = x + d;
      if (u - a < t2 || b - u < t2) {
        d = tol1;
        if (x >= xm) d = -d;
      }
    }
    if (Math.abs(d) >= tol1) u = x + d;
    else if (d > 0) u = x + tol1;
    else u = x - tol1;
    const fu = f(u);
    if (fu <= fx) {
      if (u < x) b = x;
      else a = x;
      v = w; w = x; x = u;
      fv = fw; fw = fx; fx = fu;
    } else {
      if (u < x) a = u;
      else b = u;
      if (fu <= fw || w === x) {
        v = w; fv = fw;
        w = u; fw = fu;
      } else if (fu <= fv || v === x || v === w) {
        v = u; fv = fu;
      }
    }
  }
  return x;
}

// --- Least squares with LINPACK's limited pivoting ----------------------------------------------

// Householder QR of X (rows) as R's lm.fit (dqrdc2, tol 1e-7): a column whose remaining norm falls
// below tol × its original norm moves to the end, so estimable columns keep their order. Returns
// { rank, pivot, coefficients (NaN where not estimable), unscaledVar (diagonal of (XᵀX)⁻¹ for
// estimable columns), rss }.
export function leastSquares(X, y, tol = 1e-7) {
  const n = X.length;
  const p = n ? X[0].length : 0;
  const a = Array.from({ length: p }, (_, j) => Float64Array.from(X, (row) => row[j]));
  const qty = Float64Array.from(y);
  const original = a.map((col) => Math.hypot(...col) || 1);
  const pivot = Array.from({ length: p }, (_, j) => j);
  const lup = Math.min(n, p);
  let k = p; // columns from k on are negligible
  const R = Array.from({ length: p }, () => new Float64Array(p));
  let rank = 0;
  for (let l = 0; l < lup; l += 1) {
    for (;;) {
      if (l >= k) break;
      let norm = 0;
      for (let i = l; i < n; i += 1) norm += a[l][i] * a[l][i];
      if (Math.sqrt(norm) >= original[l] * tol) break;
      a.push(a.splice(l, 1)[0]);
      original.push(original.splice(l, 1)[0]);
      pivot.push(pivot.splice(l, 1)[0]);
      k -= 1;
    }
    if (l >= k) break;
    rank = l + 1;
    const col = a[l];
    let norm = 0;
    for (let i = l; i < n; i += 1) norm += col[i] * col[i];
    norm = Math.sqrt(norm);
    const alpha = col[l] > 0 ? -norm : norm;
    if (l < n - 1 && norm > 0) {
      col[l] -= alpha;
      let vv = 0;
      for (let i = l; i < n; i += 1) vv += col[i] * col[i];
      for (let j = l + 1; j < p; j += 1) {
        let s = 0;
        for (let i = l; i < n; i += 1) s += col[i] * a[j][i];
        const f = (2 * s) / vv;
        for (let i = l; i < n; i += 1) a[j][i] -= f * col[i];
      }
      let s = 0;
      for (let i = l; i < n; i += 1) s += col[i] * qty[i];
      const f = (2 * s) / vv;
      for (let i = l; i < n; i += 1) qty[i] -= f * col[i];
      R[l][l] = alpha;
    } else R[l][l] = col[l];
    for (let j = l + 1; j < p; j += 1) R[l][j] = a[j][l];
  }
  const beta = new Float64Array(rank);
  for (let j = rank - 1; j >= 0; j -= 1) {
    let s = qty[j];
    for (let m = j + 1; m < rank; m += 1) s -= R[j][m] * beta[m];
    beta[j] = s / R[j][j];
  }
  // (RᵀR)⁻¹ diagonal from R⁻¹ (upper triangular).
  const Rinv = Array.from({ length: rank }, () => new Float64Array(rank));
  for (let j = 0; j < rank; j += 1) {
    Rinv[j][j] = 1 / R[j][j];
    for (let i = j - 1; i >= 0; i -= 1) {
      let s = 0;
      for (let m = i + 1; m <= j; m += 1) s += R[i][m] * Rinv[m][j];
      Rinv[i][j] = -s / R[i][i];
    }
  }
  const coefficients = new Float64Array(p).fill(Number.NaN);
  const unscaledVar = new Float64Array(p).fill(Number.NaN);
  for (let j = 0; j < rank; j += 1) {
    coefficients[pivot[j]] = beta[j];
    let s = 0;
    for (let m = j; m < rank; m += 1) s += Rinv[j][m] * Rinv[j][m];
    unscaledVar[pivot[j]] = s;
  }
  let rss = 0;
  for (let i = rank; i < n; i += 1) rss += qty[i] * qty[i];
  return { rank, pivot, coefficients, unscaledVar, rss };
}

// lmFit(y, design, weights) for one coefficient (contrasts.fit with a unit contrast is exact):
// rows of y (genes × samples, NaN for missing), design rows per sample, weights like y (or null);
// weights ≤ 0 make an observation missing, as in lm.series. Returns per row the coefficient, its
// unscaled standard deviation, sigma, the residual df, and Amean (the row mean of y).
export function lmFit(y, design, options = {}) {
  const { weights = null, coefficient = design[0].length - 1 } = options;
  const G = y.length;
  const out = {
    coefficient: new Float64Array(G), stdevUnscaled: new Float64Array(G), sigma: new Float64Array(G),
    dfResidual: new Float64Array(G), Amean: new Float64Array(G),
  };
  for (let g = 0; g < G; g += 1) {
    const row = y[g];
    let sum = 0;
    let count = 0;
    for (const v of row) if (Number.isFinite(v)) { sum += v; count += 1; }
    out.Amean[g] = count ? sum / count : Number.NaN;
    const X = [];
    const yy = [];
    for (let i = 0; i < row.length; i += 1) {
      const w = weights ? weights[g][i] : 1;
      if (!Number.isFinite(row[i]) || !(w > 0)) continue;
      const sw = Math.sqrt(w);
      X.push(design[i].map((v) => v * sw));
      yy.push(row[i] * sw);
    }
    if (!X.length) {
      out.coefficient[g] = out.stdevUnscaled[g] = out.sigma[g] = Number.NaN;
      out.dfResidual[g] = 0;
      continue;
    }
    const fit = leastSquares(X, yy);
    const df = X.length - fit.rank;
    out.coefficient[g] = fit.coefficients[coefficient];
    out.stdevUnscaled[g] = Math.sqrt(fit.unscaledVar[coefficient]);
    out.dfResidual[g] = df;
    out.sigma[g] = df > 0 ? Math.sqrt(fit.rss / df) : Number.NaN;
  }
  return out;
}

// --- Natural cubic splines (splines::ns with intercept) ------------------------------------------

// Cubic B-spline basis functions (order 4) at x, or their first or second derivatives, for knots
// with the boundary knots repeated four times (Cox–de Boor recursion; de Boor 2001, ch. X). x at
// the right boundary belongs to the last interval, as in splines::splineDesign.
export function bsplineRow(knots, x, deriv = 0) {
  const L = knots.length;
  let last = L - 2;
  while (last > 0 && !(knots[last] < knots[last + 1])) last -= 1;
  // Order 1.
  let B = Float64Array.from({ length: L - 1 }, (_, i) => ((knots[i] <= x && x < knots[i + 1]) || (i === last && x === knots[i + 1]) ? 1 : 0));
  const ratio = (a, b) => (b > 0 ? a / b : 0);
  const orders = [B];
  for (let k = 2; k <= 4; k += 1) {
    const next = new Float64Array(L - k);
    for (let i = 0; i < L - k; i += 1) {
      next[i] = ratio(x - knots[i], knots[i + k - 1] - knots[i]) * B[i] + ratio(knots[i + k] - x, knots[i + k] - knots[i + 1]) * B[i + 1];
    }
    B = next;
    orders.push(B);
  }
  // Derivatives: B′(i, k) = (k − 1) [B(i, k − 1) / (t(i+k−1) − t(i)) − B(i+1, k − 1) / (t(i+k) − t(i+1))],
  // applied deriv times starting from the order (4 − deriv) values.
  let values = orders[3 - deriv];
  for (let k = 5 - deriv; k <= 4; k += 1) {
    const next = new Float64Array(L - k);
    for (let i = 0; i < L - k; i += 1) {
      next[i] = (k - 1) * (ratio(values[i], knots[i + k - 1] - knots[i]) - ratio(values[i + 1], knots[i + k] - knots[i + 1]));
    }
    values = next;
  }
  return values;
}

// Orthonormal basis of the null space of a 2 × K constraint (Householder QR of its transpose).
function nullSpace(C) {
  const K = C[0].length;
  const cols = C.map((row) => Float64Array.from(row));
  const Q = Array.from({ length: K }, (_, i) => Float64Array.from({ length: K }, (_, j) => (i === j ? 1 : 0)));
  for (let l = 0; l < cols.length; l += 1) {
    const v = Float64Array.from(cols[l]);
    for (let i = 0; i < l; i += 1) v[i] = 0;
    let norm = 0;
    for (let i = l; i < K; i += 1) norm += v[i] * v[i];
    norm = Math.sqrt(norm);
    v[l] += v[l] > 0 ? norm : -norm;
    let vv = 0;
    for (let i = l; i < K; i += 1) vv += v[i] * v[i];
    if (!(vv > 0)) continue;
    const reflect = (x) => {
      let s = 0;
      for (let i = l; i < K; i += 1) s += v[i] * x[i];
      const f = (2 * s) / vv;
      for (let i = l; i < K; i += 1) x[i] -= f * v[i];
    };
    for (let j = l + 1; j < cols.length; j += 1) reflect(cols[j]);
    for (const q of Q) reflect(q);
  }
  // Q[i] now holds column i of Qᵀ = H₂H₁; rows 2.. of Qᵀ span the null space of C.
  return Array.from({ length: K - cols.length }, (_, r) => Float64Array.from(Q, (q) => q[r + cols.length]));
}

// The natural spline basis of splines::ns(x, df, intercept = TRUE) up to an invertible linear
// map (fitted values and residuals do not depend on it), and a predictor for new x (linear beyond
// the boundary knots, as predict.ns).
export function naturalSplineBasis(x, df) {
  const nIknots = df - 2;
  const lo = Math.min(...x);
  const hi = Math.max(...x);
  const interior = [];
  for (let k = 1; k <= nIknots; k += 1) interior.push(quantile7(x, k / (nIknots + 1)));
  const knots = [lo, lo, lo, lo, ...interior, hi, hi, hi, hi];
  const constraint = [bsplineRow(knots, lo, 2), bsplineRow(knots, hi, 2)];
  const Z = nullSpace(constraint);
  const project = (row) => Z.map((z) => z.reduce((s, zi, i) => s + zi * row[i], 0));
  const at = (v) => {
    if (v < lo || v > hi) {
      const pivotKnot = v < lo ? lo : hi;
      const value = bsplineRow(knots, pivotKnot, 0);
      const slope = bsplineRow(knots, pivotKnot, 1);
      return project(value.map((b, i) => b + (v - pivotKnot) * slope[i]));
    }
    return project(bsplineRow(knots, v, 0));
  };
  return { basis: Array.from(x, at), at };
}

// --- Weighted lowess (limma's weighted_lowess.c) ------------------------------------------------

function lowessFit(x, y, w, rw, cur, left, right, dist) {
  let ymean = 0;
  let all = 0;
  if (dist < 1e-7) {
    for (let pt = left; pt <= right; pt += 1) {
      const wt = w[pt] * rw[pt];
      ymean += y[pt] * wt;
      all += wt;
    }
    return ymean / all;
  }
  const work = new Float64Array(right - left + 1);
  let xmean = 0;
  for (let pt = left; pt <= right; pt += 1) {
    const wt = Math.pow(1 - Math.pow(Math.abs(x[cur] - x[pt]) / dist, 3), 3) * w[pt] * rw[pt];
    work[pt - left] = wt;
    xmean += wt * x[pt];
    ymean += wt * y[pt];
    all += wt;
  }
  xmean /= all;
  ymean /= all;
  let v = 0;
  let cov = 0;
  for (let pt = left; pt <= right; pt += 1) {
    const t = x[pt] - xmean;
    v += t * t * work[pt - left];
    cov += t * (y[pt] - ymean) * work[pt - left];
  }
  if (v < 1e-7) return ymean;
  const slope = cov / v;
  return slope * x[cur] + (ymean - slope * xmean);
}

// One pass (iterations = 1) of limma's weightedLowess(x, y, weights, span, npts = 200); returns
// fitted values in the input order.
export function weightedLowess(xIn, yIn, wIn, span, npts = 200) {
  const n = xIn.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => xIn[a] - xIn[b] || a - b);
  const x = Float64Array.from(order, (i) => xIn[i]);
  const y = Float64Array.from(order, (i) => yIn[i]);
  const w = Float64Array.from(order, (i) => wIn[i]);
  let delta = 0;
  if (npts < n) {
    const dx = Float64Array.from({ length: n - 1 }, (_, i) => x[i + 1] - x[i]).sort();
    const cum = new Float64Array(dx.length);
    let s = 0;
    for (let i = 0; i < dx.length; i += 1) cum[i] = s += dx[i];
    delta = Infinity;
    for (let k = 0; k < npts; k += 1) delta = Math.min(delta, cum[dx.length - k - 1] / (npts - k));
  }
  let total = 0;
  for (const v of w) total += v;
  const spanWeight = total * span;
  const subrange = (x[n - 1] - x[0]) / n;
  const seeds = [0];
  let last = 0;
  for (let pt = 1; pt < n - 1; pt += 1) if (x[pt] - x[last] > delta) { seeds.push(pt); last = pt; }
  seeds.push(n - 1);
  const rw = new Float64Array(n).fill(1);
  const fit = new Float64Array(n);
  const frame = (cur) => {
    let left = cur;
    let right = cur;
    let curw = w[cur];
    let ende = cur === n - 1;
    let ends = cur === 0;
    let mdist = 0;
    while (curw < spanWeight && (!ende || !ends)) {
      if (ende) {
        left -= 1;
        curw += w[left];
        if (left === 0) ends = true;
        mdist = Math.max(mdist, x[cur] - x[left]);
      } else if (ends) {
        right += 1;
        curw += w[right];
        if (right === n - 1) ende = true;
        mdist = Math.max(mdist, x[right] - x[cur]);
      } else {
        const ld = x[cur] - x[left - 1];
        const rd = x[right + 1] - x[cur];
        if (ld < rd) {
          left -= 1;
          curw += w[left];
          if (left === 0) ends = true;
          mdist = Math.max(mdist, ld);
        } else {
          right += 1;
          curw += w[right];
          if (right === n - 1) ende = true;
          mdist = Math.max(mdist, rd);
        }
      }
    }
    while (left > 0 && x[left] === x[left - 1]) left -= 1;
    while (right < n - 1 && x[right] === x[right + 1]) right += 1;
    return [left, right, mdist];
  };
  last = 0;
  seeds.forEach((pt, s) => {
    const [left, right, dist] = frame(pt);
    fit[pt] = lowessFit(x, y, w, rw, pt, left, right, dist);
    if (s > 0 && pt - last > 1) {
      const gap = x[pt] - x[last];
      if (gap > 1e-7 * subrange) {
        const slope = (fit[pt] - fit[last]) / gap;
        const intercept = fit[pt] - slope * x[pt];
        for (let q = last + 1; q < pt; q += 1) fit[q] = slope * x[q] + intercept;
      } else {
        const mid = 0.5 * (fit[pt] + fit[last]);
        for (let q = last + 1; q < pt; q += 1) fit[q] = mid;
      }
    }
    last = pt;
  });
  const out = new Float64Array(n);
  order.forEach((i, k) => { out[i] = fit[k]; });
  return out;
}

// limma's loessFit(y, x, weights, span, iterations = 1, min.weight, max.weight).
function loessFit(y, x, w, span, minWeight, maxWeight) {
  const n = y.length;
  if (span < 1 / n) return Float64Array.from(y);
  const wobs = Float64Array.from(w, (v) => Math.min(maxWeight, Math.max(Number.isFinite(v) ? v : 0, minWeight)));
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of wobs) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (hi - lo < 1e-15) throw new Error('Equal weights: not reached by fitFDistUnequalDF1.');
  if (n < 4 + 1 / span) {
    const fit = leastSquares(Array.from(x, (v, i) => [Math.sqrt(wobs[i]), Math.sqrt(wobs[i]) * v]), Array.from(y, (v, i) => Math.sqrt(wobs[i]) * v));
    return Float64Array.from(x, (v) => fit.coefficients[0] + fit.coefficients[1] * v);
  }
  return weightedLowess(x, y, wobs, span);
}

// --- Prior distribution of the variances --------------------------------------------------------

// limma's fitFDist(x, df1, covariate): moment estimates of the scaled F distribution.
export function fitFDist(xIn, df1In, covariateIn = null) {
  const n = xIn.length;
  const ok = Array.from(xIn, (v, i) => Number.isFinite(df1In[i]) && df1In[i] > 1e-15 && Number.isFinite(v) && v > -1e-15);
  const idx = [];
  ok.forEach((v, i) => { if (v) idx.push(i); });
  const nok = idx.length;
  if (nok === 1) return { scale: new Float64Array(n).fill(xIn[idx[0]]), df2: 0 };
  let x = idx.map((i) => xIn[i]);
  const df1 = idx.map((i) => df1In[i]);
  let covariate = covariateIn ? idx.map((i) => covariateIn[i]) : null;
  let splinedf = 1;
  if (covariate) {
    splinedf = Math.min(1 + (nok >= 3) + (nok >= 6) + (nok >= 30), new Set(covariate).size);
    if (splinedf < 2) {
      const out = fitFDist(x, df1, null);
      return { scale: new Float64Array(n).fill(out.scale[0]), df2: out.df2 };
    }
  }
  x = x.map((v) => Math.max(v, 0));
  let m = median(x);
  if (m === 0) m = 1;
  x = x.map((v) => Math.max(v, 1e-5 * m));
  const e = x.map((v, i) => Math.log(v) + logmdigamma(df1[i] / 2));
  const emean = new Float64Array(n);
  let evar;
  if (!covariate) {
    const mean = e.reduce((a, b) => a + b, 0) / nok;
    evar = e.reduce((a, b) => a + (b - mean) ** 2, 0) / (nok - 1);
    emean.fill(mean);
  } else {
    const ns = naturalSplineBasis(covariate, splinedf);
    const fit = leastSquares(ns.basis, e);
    const fitted = (row) => row.reduce((s, v, j) => s + v * fit.coefficients[j], 0);
    for (let i = 0; i < n; i += 1) emean[i] = fitted(ns.at(covariateIn[i]));
    evar = fit.rss / (nok - fit.rank);
  }
  evar -= df1.reduce((a, d) => a + trigamma(d / 2), 0) / nok;
  if (evar > 0) {
    const df2 = 2 * trigammaInverse(evar);
    return { scale: emean.map((v) => Math.exp(v - logmdigamma(df2 / 2))), df2 };
  }
  return { scale: covariate ? emean.map(Math.exp) : new Float64Array(n).fill(x.reduce((a, b) => a + b, 0) / nok), df2: Infinity };
}

// limma's fitFDistUnequalDF1(x, df1, covariate, robust = FALSE): the prior df by maximum
// likelihood, the scale from a weighted lowess trend of log variances (Chen et al. 2025).
export function fitFDistUnequalDF1(xIn, df1In, covariate = null) {
  const n = xIn.length;
  const x = Float64Array.from(xIn);
  const df1 = Float64Array.from(df1In);
  let priorWeights = null;
  for (let i = 0; i < n; i += 1) {
    if (Number.isNaN(x[i])) {
      priorWeights ??= new Float64Array(n).fill(1);
      priorWeights[i] = 0;
      x[i] = 0;
    }
  }
  for (let i = 0; i < n; i += 1) {
    if (df1[i] < 0.01) {
      priorWeights ??= new Float64Array(n).fill(1);
      priorWeights[i] = 0;
      df1[i] = 1;
    }
  }
  const informative = [];
  for (let i = 0; i < n; i += 1) if (x[i] > 0 && (!priorWeights || priorWeights[i] !== 0)) informative.push(x[i]);
  if (informative.length < 2) return { scale: Number.NaN, df2: Number.NaN };
  let cov = covariate;
  if (informative.length === 2) {
    cov = null;
    priorWeights = null;
  }
  const m = median(informative);
  const xpos = x.map((v) => Math.max(v, 1e-12 * m));
  const d1 = df1.map((d) => d / 2);
  const e = xpos.map((v, i) => Math.log(v) + logmdigamma(d1[i]));
  const w = d1.map((d, i) => (1 / trigamma(d)) * (priorWeights ? priorWeights[i] : 1));
  let emean;
  if (!cov) {
    let sw = 0;
    let swe = 0;
    for (let i = 0; i < n; i += 1) { sw += w[i]; swe += w[i] * e[i]; }
    emean = new Float64Array(n).fill(swe / sw);
  } else {
    const span = Math.min(0.3 + 0.7 * Math.pow(500 / n, 1 / 3), 1);
    const q75 = quantile7(w, 0.75);
    emean = loessFit(e, cov, w.map((v) => v / q75), span, 1e-8, 1e2);
  }
  const d1x = d1.map((d, i) => d * xpos[i]);
  const minusTwiceLogLik = (par) => {
    const d2 = par / (1 - par);
    const lgd2 = logGamma(d2);
    const lmd = logmdigamma(d2);
    let s = 0;
    for (let i = 0; i < n; i += 1) {
      const d2s20 = d2 * Math.exp(emean[i] - lmd);
      const term = -(d1[i] + d2) * Math.log1p(d1x[i] / d2s20) - d1[i] * Math.log(d2s20) + logGamma(d1[i] + d2) - lgd2;
      s += priorWeights ? priorWeights[i] * term : term;
    }
    return -2 * s;
  };
  const par = optimize(minusTwiceLogLik, 0.5, 0.9998);
  const d2 = par / (1 - par);
  return { scale: emean.map((v) => Math.exp(v - logmdigamma(d2))), df2: 2 * d2 };
}

// limma's squeezeVar(var, df, covariate): { dfPrior, varPrior, varPost } (robust = FALSE).
export function squeezeVar(varIn, df, covariate = null) {
  const n = varIn.length;
  if (n < 3) return { dfPrior: 0, varPrior: Float64Array.from(varIn), varPost: Float64Array.from(varIn), legacy: true };
  const variances = Float64Array.from(varIn, (v, i) => (df[i] === 0 ? 0 : v));
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of df) if (d > 0) { lo = Math.min(lo, d); hi = Math.max(hi, d); }
  const legacy = lo === hi;
  const fit = legacy ? fitFDist(variances, df, covariate) : fitFDistUnequalDF1(variances, df, covariate);
  if (Number.isNaN(fit.df2)) throw new Error('Could not estimate the prior degrees of freedom (too few rows with residual variance).');
  const scale = typeof fit.scale === 'number' ? new Float64Array(n).fill(fit.scale) : fit.scale;
  const varPost = Number.isFinite(fit.df2)
    ? Float64Array.from(variances, (v, i) => (df[i] * v + fit.df2 * scale[i]) / (df[i] + fit.df2))
    : Float64Array.from(scale);
  return { dfPrior: fit.df2, varPrior: scale, varPost, legacy };
}

// eBayes(fit, trend) on lmFit()'s single-coefficient fit, then topTable(adjust = "BH"): moderated
// t, its df, two-sided p-values and BH-adjusted p-values over the rows with a p-value.
export function eBayes(fit, options = {}) {
  const { trend = false } = options;
  const G = fit.coefficient.length;
  let pooled = 0;
  for (const d of fit.dfResidual) pooled += d;
  if (!(pooled > 0)) throw new Error('No residual degrees of freedom in the linear models.');
  const variances = Float64Array.from(fit.sigma, (s) => s * s);
  const squeezed = squeezeVar(variances, fit.dfResidual, trend ? fit.Amean : null);
  const t = new Float64Array(G);
  const dfTotal = new Float64Array(G);
  const p = new Float64Array(G);
  for (let g = 0; g < G; g += 1) {
    t[g] = fit.coefficient[g] / fit.stdevUnscaled[g] / Math.sqrt(squeezed.varPost[g]);
    dfTotal[g] = Math.min(fit.dfResidual[g] + squeezed.dfPrior, pooled);
    p[g] = Number.isFinite(t[g]) ? 2 * (Number.isFinite(dfTotal[g]) ? studentTSurvival(Math.abs(t[g]), dfTotal[g]) : normalCDF(-Math.abs(t[g]))) : Number.NaN;
  }
  return { ...fit, t, dfTotal, p, padj: adjustPValues(p, 'BH'), dfPrior: squeezed.dfPrior, s2Prior: squeezed.varPrior, s2Post: squeezed.varPost, legacy: squeezed.legacy };
}

export { digamma };
