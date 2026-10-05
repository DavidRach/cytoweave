// Sample-level statistics for comparing groups (CytoWeave's Compare view): distribution
// functions, classical tests, effect sizes, multiple-testing corrections, linear models and a
// quasi-binomial GLM for differential abundance.
//
// Conventions follow R (stats package) so results can be checked against it: two-sided p-values
// by default, `alternative: 'two-sided' | 'less' | 'greater'` (x relative to y), confidence
// level `confLevel` (0.95). Special functions are evaluated with series and continued fractions
// (modified Lentz; Press et al., Numerical Recipes, 3rd ed., §6.1–6.4) to ~1e-14 relative
// accuracy in the body of each distribution, and tail probabilities are computed directly (not
// as 1 − CDF) so small p-values keep their relative precision.

import { cholesky, choleskySolve, invertSymmetric } from './fit.js';
import { createRandom } from './random.js';
import { mean, quantileSorted, variance } from './stats.js';

// --- Special functions -------------------------------------------------------------------------

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];
const LOG_SQRT_2PI = 0.9189385332046728;
const TINY = 1e-300;
const EPS = 1e-16;

// ln Γ(x) for x > 0 (Lanczos approximation, g = 7, n = 9; reflection below ½).
export function logGamma(x) {
  if (Number.isNaN(x)) return Number.NaN;
  if (x === 0.5) return 0.5723649429247001; // ln √π, used by every normal-distribution call
  if (x === 1 || x === 2) return 0;
  if (x <= 0 && Number.isInteger(x)) return Infinity;
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += LANCZOS[i] / (z + i);
  return LOG_SQRT_2PI + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// Stirling remainder ln Γ(x) − ((x − ½) ln x − x + ln √(2π)) for x ≥ 10 (Bernoulli series).
function stirlingCorrection(x) {
  const r = 1 / x;
  const r2 = r * r;
  return r * (1 / 12 + r2 * (-1 / 360 + r2 * (1 / 1260 + r2 * (-1 / 1680 + r2 * (1 / 1188
    + r2 * (-691 / 360360 + r2 * (1 / 156 + r2 * (-3617 / 122400))))))));
}

// ln B(a, b). For large arguments the Γ terms are combined analytically (as R's lbeta), avoiding
// the cancellation of ln Γ values ~1e10 that would otherwise cost ~6 significant digits.
export function logBeta(a, b) {
  const p = Math.min(a, b);
  const q = Math.max(a, b);
  if (p >= 10) {
    const corr = stirlingCorrection(p) + stirlingCorrection(q) - stirlingCorrection(p + q);
    return -0.5 * Math.log(q) + LOG_SQRT_2PI + corr + (p - 0.5) * Math.log(p / (p + q)) + q * Math.log1p(-p / (p + q));
  }
  if (q >= 10) {
    const corr = stirlingCorrection(q) - stirlingCorrection(p + q);
    return logGamma(p) + corr + p - p * Math.log(p + q) + (q - 0.5) * Math.log1p(-p / (p + q));
  }
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

function logFactorial(n) {
  return logGamma(n + 1);
}

function gammaSeries(a, x) {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < 100000; n += 1) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaContinuedFraction(a, x) {
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 100000; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

// Regularized lower incomplete gamma P(a, x) = γ(a, x)/Γ(a).
export function gammaP(a, x) {
  if (Number.isNaN(x) || !(a > 0)) return Number.NaN;
  if (x <= 0) return 0;
  if (x === Infinity) return 1;
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaContinuedFraction(a, x);
}

// Regularized upper incomplete gamma Q(a, x) = 1 − P(a, x), accurate in the upper tail.
export function gammaQ(a, x) {
  if (Number.isNaN(x) || !(a > 0)) return Number.NaN;
  if (x <= 0) return 1;
  if (x === Infinity) return 0;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

function betaContinuedFraction(x, a, b) {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 100000; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// [I_x(a, b), 1 − I_x(a, b)], each computed directly where it is the smaller one. `y` = 1 − x
// may be passed when it is known more precisely than 1 − x.
function betaPair(x, a, b, y = 1 - x) {
  if (Number.isNaN(x) || !(a > 0) || !(b > 0)) return [Number.NaN, Number.NaN];
  if (x <= 0) return [0, 1];
  if (y <= 0) return [1, 0];
  // ln x via log1p(−y) when x is near 1 (and vice versa) keeps a·ln x exact for huge a.
  const lx = x < 0.5 ? Math.log(x) : Math.log1p(-y);
  const ly = y < 0.5 ? Math.log(y) : Math.log1p(-x);
  const front = Math.exp(a * lx + b * ly - logBeta(a, b));
  if (x < (a + 1) / (a + b + 2)) {
    const lower = (front * betaContinuedFraction(x, a, b)) / a;
    return [lower, 1 - lower];
  }
  const upper = (front * betaContinuedFraction(y, b, a)) / b;
  return [1 - upper, upper];
}

// Regularized incomplete beta function I_x(a, b).
export function incompleteBeta(x, a, b) {
  return betaPair(x, a, b)[0];
}

// 1 − I_x(a, b), accurate when it is small.
export function incompleteBetaComplement(x, a, b) {
  return betaPair(x, a, b)[1];
}

// Polygamma functions for x > 0: ψ (digamma), ψ′ (trigamma) and ψ″, by the recurrences
// ψ⁽ᵏ⁾(x) = ψ⁽ᵏ⁾(x + 1) − (−1)ᵏ k! / x^(k+1) up to x ≥ 10 and the asymptotic (Bernoulli) series
// there, whose next terms are below 1e-17 relative.
export function digamma(x) {
  if (!(x > 0)) return Number.NaN;
  let shift = 0;
  while (x < 10) {
    shift += 1 / x;
    x += 1;
  }
  const r2 = 1 / (x * x);
  return Math.log(x) - 0.5 / x - r2 * (1 / 12 - r2 * (1 / 120 - r2 * (1 / 252 - r2 * (1 / 240 - r2 * (1 / 132 - r2 * (691 / 32760 - r2 / 12)))))) - shift;
}

export function trigamma(x) {
  if (!(x > 0)) return Number.NaN;
  let shift = 0;
  while (x < 10) {
    shift += 1 / (x * x);
    x += 1;
  }
  const r = 1 / x;
  const r2 = r * r;
  return shift + r + 0.5 * r2 + r * r2 * (1 / 6 - r2 * (1 / 30 - r2 * (1 / 42 - r2 * (1 / 30 - r2 * (5 / 66 - r2 * (691 / 2730 - r2 * 7 / 6))))));
}

export function tetragamma(x) {
  if (!(x > 0)) return Number.NaN;
  let shift = 0;
  while (x < 10) {
    shift -= 2 / (x * x * x);
    x += 1;
  }
  const r = 1 / x;
  const r2 = r * r;
  return shift - r2 - r * r2 - r2 * r2 * (0.5 - r2 * (1 / 6 - r2 * (1 / 6 - r2 * (3 / 10 - r2 * (5 / 6 - r2 * (691 / 210 - r2 * 35 / 2))))));
}

export function erf(x) {
  return x < 0 ? -gammaP(0.5, x * x) : gammaP(0.5, x * x);
}

export function erfc(x) {
  return x < 0 ? 2 - gammaQ(0.5, x * x) : gammaQ(0.5, x * x);
}

// --- Distributions -----------------------------------------------------------------------------

export function normalCDF(x, mu = 0, sd = 1) {
  const z = (x - mu) / sd;
  if (Number.isNaN(z)) return Number.NaN;
  // erfc(|z|/√2) = Q(½, z²/2); forming z²/2 directly avoids rounding in |z|/√2.
  const tail = 0.5 * gammaQ(0.5, 0.5 * z * z);
  return z < 0 ? tail : 1 - tail;
}

export function normalPDF(x, mu = 0, sd = 1) {
  const z = (x - mu) / sd;
  return Math.exp(-0.5 * z * z - LOG_SQRT_2PI) / sd;
}

// Normal quantile: Acklam's rational approximation (relative error 1.15e-9) polished by two
// Halley steps against the accurate CDF.
const ACKLAM_A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
const ACKLAM_B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
const ACKLAM_C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
const ACKLAM_D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];

export function normalQuantile(p, mu = 0, sd = 1) {
  if (Number.isNaN(p) || p < 0 || p > 1) return Number.NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  if (p > 0.5) return mu - sd * standardNormalQuantile(1 - p);
  return mu + sd * standardNormalQuantile(p);
}

function standardNormalQuantile(p) {
  // p ≤ 0.5 here.
  let x;
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q + ACKLAM_C[4]) * q + ACKLAM_C[5])
      / ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r + ACKLAM_A[4]) * r + ACKLAM_A[5]) * q)
      / (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) * r + ACKLAM_B[4]) * r + 1);
  }
  for (let i = 0; i < 2; i += 1) {
    const e = normalCDF(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp(0.5 * x * x);
    if (!Number.isFinite(u)) break;
    x -= u / (1 + 0.5 * x * u);
  }
  return x;
}

// Student t CDF P(T ≤ t) with df degrees of freedom (df may be fractional, or Infinity).
export function studentTCDF(t, df) {
  if (Number.isNaN(t) || !(df > 0)) return Number.NaN;
  if (t === Infinity) return 1;
  if (t === -Infinity) return 0;
  if (df === Infinity) return normalCDF(t);
  const t2 = t * t;
  const tail = 0.5 * betaPair(df / (df + t2), df / 2, 0.5, t2 / (df + t2))[0]; // P(T > |t|)
  return t > 0 ? 1 - tail : tail;
}

// P(T > t), accurate in the upper tail.
export function studentTSurvival(t, df) {
  return studentTCDF(-t, df);
}

export function studentTPDF(t, df) {
  if (df === Infinity) return normalPDF(t);
  return Math.exp(logGamma((df + 1) / 2) - logGamma(df / 2) - 0.5 * Math.log(df * Math.PI)
    - ((df + 1) / 2) * Math.log1p((t * t) / df));
}

// Student t quantile. Closed forms for df = 1, 2; otherwise a Cornish–Fisher start (Abramowitz &
// Stegun 26.7.5) refined by safeguarded Newton steps on the log tail probability.
export function studentTQuantile(p, df) {
  if (Number.isNaN(p) || p < 0 || p > 1 || !(df > 0)) return Number.NaN;
  if (p === 0) return -Infinity;
  if (p === 1) return Infinity;
  if (p === 0.5) return 0;
  if (df === Infinity) return normalQuantile(p);
  const lowerTail = p < 0.5;
  const q = lowerTail ? p : 1 - p; // P(T > t) for the positive quantile t
  let t;
  if (df === 1) {
    t = 1 / Math.tan(Math.PI * q);
  } else if (df === 2) {
    t = (1 - 2 * q) / Math.sqrt(2 * q * (1 - q));
  } else {
    const z = -standardNormalQuantile(q);
    const z2 = z * z;
    const g1 = (z2 * z + z) / 4;
    const g2 = (5 * z2 * z2 * z + 16 * z2 * z + 3 * z) / 96;
    const g3 = (3 * z2 * z2 * z2 * z + 19 * z2 * z2 * z + 17 * z2 * z - 15 * z) / 384;
    t = z + g1 / df + g2 / (df * df) + g3 / (df * df * df);
    if (!(t > 0) || !Number.isFinite(t)) t = z > 0 ? z : 1;
    let lo = 0;
    let hi = Infinity;
    const logQ = Math.log(q);
    for (let iter = 0; iter < 200; iter += 1) {
      const tail = studentTCDF(-t, df);
      if (tail > q) lo = t;
      else hi = t;
      const dens = studentTPDF(t, df);
      let next = t + ((Math.log(tail) - logQ) * tail) / dens;
      if (!(next > lo && next < hi) || !Number.isFinite(next)) next = Number.isFinite(hi) ? 0.5 * (lo + hi) : 2 * t;
      if (Math.abs(next - t) <= 4e-16 * t) {
        t = next;
        break;
      }
      t = next;
    }
  }
  return lowerTail ? -t : t;
}

export function chiSquareCDF(x, df) {
  return gammaP(df / 2, x / 2);
}

export function chiSquareSurvival(x, df) {
  return gammaQ(df / 2, x / 2);
}

export function fCDF(x, df1, df2) {
  if (Number.isNaN(x)) return Number.NaN;
  if (x <= 0) return 0;
  if (x === Infinity) return 1;
  const s = df1 * x + df2;
  return betaPair((df1 * x) / s, df1 / 2, df2 / 2, df2 / s)[0];
}

export function fSurvival(x, df1, df2) {
  if (Number.isNaN(x)) return Number.NaN;
  if (x <= 0) return 1;
  if (x === Infinity) return 0;
  const s = df1 * x + df2;
  return betaPair((df1 * x) / s, df1 / 2, df2 / 2, df2 / s)[1];
}

// --- Helpers -----------------------------------------------------------------------------------

function toArray(values) {
  const out = [];
  for (let i = 0; i < values.length; i += 1) if (Number.isFinite(values[i])) out.push(Number(values[i]));
  return Float64Array.from(out);
}

function sumOf(values) {
  let s = 0;
  for (let i = 0; i < values.length; i += 1) s += values[i];
  return s;
}

function checkAlternative(alternative) {
  if (!['two-sided', 'less', 'greater'].includes(alternative)) {
    throw new Error(`Unknown alternative "${alternative}": use two-sided, less or greater.`);
  }
  return alternative;
}

function pFromT(t, df, alternative) {
  if (alternative === 'less') return studentTCDF(t, df);
  if (alternative === 'greater') return studentTCDF(-t, df);
  return Math.min(1, 2 * studentTCDF(-Math.abs(t), df));
}

function pFromZ(z, alternative) {
  if (alternative === 'less') return normalCDF(z);
  if (alternative === 'greater') return normalCDF(-z);
  return Math.min(1, 2 * normalCDF(-Math.abs(z)));
}

function tInterval(estimate, se, df, confLevel, alternative) {
  if (alternative === 'less') return [-Infinity, estimate + studentTQuantile(confLevel, df) * se];
  if (alternative === 'greater') return [estimate - studentTQuantile(confLevel, df) * se, Infinity];
  const q = studentTQuantile(1 - (1 - confLevel) / 2, df);
  return [estimate - q * se, estimate + q * se];
}

// Average ranks (1-based) with ties sharing the mean rank; also the tie-group sizes.
export function rank(values) {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Float64Array(n);
  const ties = [];
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j += 1;
    const r = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) ranks[order[k]] = r;
    if (j > i) ties.push(j - i + 1);
    i = j + 1;
  }
  return { ranks, ties };
}

function tieSum(ties) {
  let s = 0;
  for (const t of ties) s += t * t * t - t;
  return s;
}

// --- t-tests and ANOVA -------------------------------------------------------------------------

// One-sample t-test of mean(x) = mu.
export function oneSampleTTest(x, options = {}) {
  const alternative = checkAlternative(options.alternative ?? 'two-sided');
  const confLevel = options.confLevel ?? 0.95;
  const mu = options.mu ?? 0;
  const v = toArray(x);
  const n = v.length;
  if (n < 2) throw new Error('A t-test needs at least two values.');
  const m = mean(v);
  const se = Math.sqrt(variance(v, m) / n);
  if (!(se > 0)) throw new Error('The values are constant, so a t-test is undefined.');
  const t = (m - mu) / se;
  const df = n - 1;
  const ci = tInterval(m, se, df, confLevel, alternative);
  return { method: 'One-sample t-test', statistic: t, df, p: pFromT(t, df, alternative), estimate: m, stderr: se, ci, alternative };
}

// Welch's unequal-variance two-sample t-test (R: t.test(x, y)).
export function welchTTest(x, y, options = {}) {
  const alternative = checkAlternative(options.alternative ?? 'two-sided');
  const confLevel = options.confLevel ?? 0.95;
  const mu = options.mu ?? 0;
  const a = toArray(x);
  const b = toArray(y);
  if (a.length < 2 || b.length < 2) throw new Error('Each group needs at least two values for a t-test.');
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a, ma) / a.length;
  const vb = variance(b, mb) / b.length;
  const se = Math.sqrt(va + vb);
  if (!(se > 0)) throw new Error('Both groups are constant, so a t-test is undefined.');
  const df = ((va + vb) ** 2) / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1));
  const estimate = ma - mb;
  const t = (estimate - mu) / se;
  return {
    method: 'Welch two-sample t-test', statistic: t, df, p: pFromT(t, df, alternative), estimate, means: [ma, mb],
    stderr: se, ci: tInterval(estimate, se, df, confLevel, alternative), alternative,
  };
}

// Student's pooled-variance two-sample t-test (R: t.test(x, y, var.equal = TRUE)).
export function studentTTest(x, y, options = {}) {
  const alternative = checkAlternative(options.alternative ?? 'two-sided');
  const confLevel = options.confLevel ?? 0.95;
  const mu = options.mu ?? 0;
  const a = toArray(x);
  const b = toArray(y);
  if (a.length + b.length < 3 || !a.length || !b.length) throw new Error('A pooled t-test needs at least three values in two groups.');
  const ma = mean(a);
  const mb = mean(b);
  const df = a.length + b.length - 2;
  let ss = 0;
  for (const v of a) ss += (v - ma) ** 2;
  for (const v of b) ss += (v - mb) ** 2;
  const pooled = ss / df;
  const se = Math.sqrt(pooled * (1 / a.length + 1 / b.length));
  if (!(se > 0)) throw new Error('The values are constant, so a t-test is undefined.');
  const estimate = ma - mb;
  const t = (estimate - mu) / se;
  return {
    method: 'Two-sample t-test (pooled variance)', statistic: t, df, p: pFromT(t, df, alternative), estimate,
    means: [ma, mb], stderr: se, ci: tInterval(estimate, se, df, confLevel, alternative), alternative,
  };
}

// Paired t-test on x − y (pairs with a non-finite member are dropped).
export function pairedTTest(x, y, options = {}) {
  if (x.length !== y.length) throw new Error('Paired values must come in pairs (equal lengths).');
  const d = [];
  for (let i = 0; i < x.length; i += 1) if (Number.isFinite(x[i]) && Number.isFinite(y[i])) d.push(x[i] - y[i]);
  const result = oneSampleTTest(d, options);
  return { ...result, method: 'Paired t-test' };
}

// Dispatcher mirroring R's t.test(x, y, paired, var.equal).
export function tTest(x, y = null, options = {}) {
  if (!y) return oneSampleTTest(x, options);
  if (options.paired) return pairedTTest(x, y, options);
  return options.varEqual ? studentTTest(x, y, options) : welchTTest(x, y, options);
}

// Classical one-way ANOVA (equal variances). groups: array of arrays.
export function oneWayAnova(groups) {
  const gs = groups.map(toArray).filter((g) => g.length);
  const k = gs.length;
  const n = gs.reduce((s, g) => s + g.length, 0);
  if (k < 2 || n <= k) throw new Error('ANOVA needs at least two groups and more values than groups.');
  const grand = gs.reduce((s, g) => s + sumOf(g), 0) / n;
  let ssb = 0;
  let ssw = 0;
  for (const g of gs) {
    const m = mean(g);
    ssb += g.length * (m - grand) ** 2;
    for (const v of g) ssw += (v - m) ** 2;
  }
  const df1 = k - 1;
  const df2 = n - k;
  const F = ssb / df1 / (ssw / df2);
  return {
    method: 'One-way ANOVA', statistic: F, df1, df2, p: fSurvival(F, df1, df2),
    ssBetween: ssb, ssWithin: ssw, msBetween: ssb / df1, msWithin: ssw / df2, etaSquared: ssb / (ssb + ssw),
  };
}

// Welch's heteroscedastic one-way ANOVA (Welch 1951; R: oneway.test(var.equal = FALSE)).
export function welchAnova(groups) {
  const gs = groups.map(toArray).filter((g) => g.length);
  const k = gs.length;
  if (k < 2) throw new Error('ANOVA needs at least two groups.');
  if (gs.some((g) => g.length < 2)) throw new Error("Welch's ANOVA needs at least two values per group.");
  const w = gs.map((g) => g.length / variance(g));
  if (w.some((v) => !Number.isFinite(v))) throw new Error("A group has zero variance, so Welch's ANOVA is undefined.");
  const means = gs.map((g) => mean(g));
  const W = sumOf(w);
  const mw = w.reduce((s, wi, i) => s + wi * means[i], 0) / W;
  const A = w.reduce((s, wi, i) => s + wi * (means[i] - mw) ** 2, 0) / (k - 1);
  const tmp = w.reduce((s, wi, i) => s + (1 - wi / W) ** 2 / (gs[i].length - 1), 0);
  const B = 1 + ((2 * (k - 2)) / (k * k - 1)) * tmp;
  const F = A / B;
  const df1 = k - 1;
  const df2 = (k * k - 1) / (3 * tmp);
  return { method: "Welch's one-way ANOVA", statistic: F, df1, df2, p: fSurvival(F, df1, df2) };
}

// --- Rank tests --------------------------------------------------------------------------------

// Number of arrangements giving each Mann–Whitney U = 0…m·n (all additions, so exact in
// floating point up to 2⁵³ and relatively exact beyond).
function mannWhitneyCounts(m, n) {
  const size = m * n + 1;
  let previous = null;
  for (let j = 0; j <= n; j += 1) {
    const current = [];
    for (let i = 0; i <= m; i += 1) {
      const c = new Float64Array(size);
      if (i === 0 && j === 0) c[0] = 1;
      if (j > 0) c.set(previous[i]);
      if (i > 0) {
        const left = current[i - 1];
        for (let u = j; u < size; u += 1) c[u] += left[u - j];
      }
      current.push(c);
    }
    previous = current;
  }
  return previous[m];
}

function signedRankCounts(n) {
  const max = (n * (n + 1)) / 2;
  const c = new Float64Array(max + 1);
  c[0] = 1;
  for (let k = 1; k <= n; k += 1) for (let s = max; s >= k; s -= 1) c[s] += c[s - k];
  return c;
}

function cumulative(counts) {
  const total = sumOf(counts);
  const lower = new Float64Array(counts.length); // P(X ≤ k)
  let acc = 0;
  for (let k = 0; k < counts.length; k += 1) {
    acc += counts[k];
    lower[k] = acc / total;
  }
  const upper = new Float64Array(counts.length); // P(X ≥ k)
  acc = 0;
  for (let k = counts.length - 1; k >= 0; k -= 1) {
    acc += counts[k];
    upper[k] = acc / total;
  }
  return { lower, upper };
}

function exactRankP(statistic, center, counts, alternative) {
  const { lower, upper } = cumulative(counts);
  const s = Math.round(statistic);
  if (alternative === 'less') return lower[s];
  if (alternative === 'greater') return upper[s];
  return Math.min(1, 2 * (s > center ? upper[s] : lower[s]));
}

// Wilcoxon rank-sum / Mann–Whitney U test (R: wilcox.test(x, y)). W is the U statistic of x.
// Exact p-values when both groups have < 50 values and there are no ties (or `exact: true`
// without ties); otherwise the normal approximation with tie and continuity corrections.
export function mannWhitneyU(x, y, options = {}) {
  const alternative = checkAlternative(options.alternative ?? 'two-sided');
  const correct = options.correct ?? true;
  const mu = options.mu ?? 0;
  const a = Array.from(toArray(x), (v) => v - mu);
  const b = toArray(y);
  const m = a.length;
  const n = b.length;
  if (!m || !n) throw new Error('Each group needs at least one value.');
  const { ranks, ties } = rank([...a, ...b]);
  let rx = 0;
  for (let i = 0; i < m; i += 1) rx += ranks[i];
  const W = rx - (m * (m + 1)) / 2;
  const exact = options.exact ?? (m < 50 && n < 50);
  if (exact && !ties.length) {
    const p = exactRankP(W, (m * n) / 2, mannWhitneyCounts(m, n), alternative);
    return { method: 'Wilcoxon rank-sum exact test', statistic: W, U: W, U2: m * n - W, p, exact: true, alternative };
  }
  let z = W - (m * n) / 2;
  const sigma = Math.sqrt(((m * n) / 12) * (m + n + 1 - tieSum(ties) / ((m + n) * (m + n - 1))));
  let correction = 0;
  if (correct) correction = alternative === 'two-sided' ? Math.sign(z) * 0.5 : alternative === 'greater' ? 0.5 : -0.5;
  z = (z - correction) / sigma;
  return {
    method: 'Wilcoxon rank-sum test with continuity correction', statistic: W, U: W, U2: m * n - W, z,
    p: pFromZ(z, alternative), exact: false, alternative, ties: ties.length > 0,
  };
}

// Wilcoxon signed-rank test, one-sample (x − mu) or paired (x − y). Zeros are dropped (as R).
export function wilcoxonSignedRank(x, y = null, options = {}) {
  const alternative = checkAlternative(options.alternative ?? 'two-sided');
  const correct = options.correct ?? true;
  const mu = options.mu ?? 0;
  const d = [];
  let zeros = 0;
  if (y) {
    if (x.length !== y.length) throw new Error('Paired values must come in pairs (equal lengths).');
    for (let i = 0; i < x.length; i += 1) {
      if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
      const v = x[i] - y[i] - mu;
      if (v === 0) zeros += 1;
      else d.push(v);
    }
  } else {
    for (let i = 0; i < x.length; i += 1) {
      if (!Number.isFinite(x[i])) continue;
      const v = x[i] - mu;
      if (v === 0) zeros += 1;
      else d.push(v);
    }
  }
  const n = d.length;
  if (!n) throw new Error('All differences are zero, so the signed-rank test is undefined.');
  const { ranks, ties } = rank(d.map(Math.abs));
  let V = 0;
  for (let i = 0; i < n; i += 1) if (d[i] > 0) V += ranks[i];
  const exact = options.exact ?? n < 50;
  if (exact && !ties.length && !zeros) {
    const p = exactRankP(V, (n * (n + 1)) / 4, signedRankCounts(n), alternative);
    return { method: 'Wilcoxon signed-rank exact test', statistic: V, p, n, exact: true, alternative };
  }
  let z = V - (n * (n + 1)) / 4;
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tieSum(ties) / 48);
  let correction = 0;
  if (correct) correction = alternative === 'two-sided' ? Math.sign(z) * 0.5 : alternative === 'greater' ? 0.5 : -0.5;
  z = (z - correction) / sigma;
  return {
    method: 'Wilcoxon signed-rank test with continuity correction', statistic: V, z, p: pFromZ(z, alternative),
    n, zeros, exact: false, alternative, ties: ties.length > 0,
  };
}

// Kruskal–Wallis rank-sum test with tie correction (R: kruskal.test).
export function kruskalWallis(groups) {
  const gs = groups.map(toArray).filter((g) => g.length);
  const k = gs.length;
  if (k < 2) throw new Error('The Kruskal–Wallis test needs at least two groups.');
  const all = [];
  for (const g of gs) for (const v of g) all.push(v);
  const n = all.length;
  const { ranks, ties } = rank(all);
  let s = 0;
  let offset = 0;
  for (const g of gs) {
    let r = 0;
    for (let i = 0; i < g.length; i += 1) r += ranks[offset + i];
    s += (r * r) / g.length;
    offset += g.length;
  }
  const H = ((12 * s) / (n * (n + 1)) - 3 * (n + 1)) / (1 - tieSum(ties) / (n * n * n - n));
  return { method: 'Kruskal–Wallis rank-sum test', statistic: H, df: k - 1, p: chiSquareSurvival(H, k - 1) };
}

// Friedman rank-sum test for complete blocks (R: friedman.test). blocks: rows = subjects (blocks),
// columns = conditions; ranks within each block, ties averaged and corrected.
export function friedmanTest(blocks) {
  const rows = blocks.filter((row) => row.every((v) => Number.isFinite(v)));
  const n = rows.length;
  const k = rows[0]?.length ?? 0;
  if (n < 2 || k < 2) throw new Error('The Friedman test needs at least two complete blocks and two conditions.');
  const sums = new Float64Array(k);
  let ties = 0;
  for (const row of rows) {
    const r = rank(row);
    for (let j = 0; j < k; j += 1) sums[j] += r.ranks[j];
    ties += tieSum(r.ties);
  }
  let ss = 0;
  for (let j = 0; j < k; j += 1) ss += (sums[j] - (n * (k + 1)) / 2) ** 2;
  const statistic = (12 * ss) / (n * k * (k + 1) - ties / (k - 1));
  return { method: 'Friedman rank-sum test', statistic, df: k - 1, p: chiSquareSurvival(statistic, k - 1), blocks: n };
}

// Randomized-block (repeated-measures) ANOVA for complete blocks: two-way additive model
// value = subject + condition, F test of condition on (k − 1, (n − 1)(k − 1)) df (equivalent to
// the univariate repeated-measures ANOVA without sphericity correction).
export function blockAnova(blocks) {
  const rows = blocks.filter((row) => row.every((v) => Number.isFinite(v)));
  const n = rows.length;
  const k = rows[0]?.length ?? 0;
  if (n < 2 || k < 2) throw new Error('A repeated-measures ANOVA needs at least two complete blocks and two conditions.');
  let grand = 0;
  for (const row of rows) for (const v of row) grand += v;
  grand /= n * k;
  let ssTotal = 0;
  let ssCondition = 0;
  let ssSubject = 0;
  for (let j = 0; j < k; j += 1) {
    let m = 0;
    for (const row of rows) m += row[j];
    ssCondition += n * (m / n - grand) ** 2;
  }
  for (const row of rows) {
    const m = row.reduce((a, b) => a + b, 0) / k;
    ssSubject += k * (m - grand) ** 2;
    for (const v of row) ssTotal += (v - grand) ** 2;
  }
  const ssError = Math.max(0, ssTotal - ssCondition - ssSubject);
  const df1 = k - 1;
  const df2 = (n - 1) * (k - 1);
  const F = ssCondition / df1 / (ssError / df2);
  return { method: 'Repeated-measures ANOVA (subjects as blocks)', statistic: F, df1, df2, p: fSurvival(F, df1, df2), ssCondition, ssSubject, ssError, blocks: n };
}

// --- Contingency tables ------------------------------------------------------------------------

// Fisher's exact test of a 2×2 table [[a, b], [c, d]] (R: fisher.test). Two-sided p sums the
// probabilities of tables no more likely than the observed one (relative tolerance 1e-7, as R).
export function fisherExact(table, options = {}) {
  const alternative = checkAlternative(options.alternative ?? 'two-sided');
  const [[a, b], [c, d]] = table;
  if ([a, b, c, d].some((v) => !(v >= 0) || !Number.isInteger(v))) throw new Error('Fisher’s test needs a 2×2 table of non-negative whole counts.');
  const m = a + c; // column 1 total
  const n = b + d; // column 2 total
  const k = a + b; // row 1 total
  const lo = Math.max(0, k - n);
  const hi = Math.min(k, m);
  const logDenom = logFactorial(m + n) - logFactorial(k) - logFactorial(m + n - k);
  const logP = (x) => logFactorial(m) - logFactorial(x) - logFactorial(m - x)
    + logFactorial(n) - logFactorial(k - x) - logFactorial(n - k + x) - logDenom;
  const probs = [];
  for (let x = lo; x <= hi; x += 1) probs.push(Math.exp(logP(x)));
  const observed = probs[a - lo];
  let p = 0;
  if (alternative === 'less') for (let x = lo; x <= a; x += 1) p += probs[x - lo];
  else if (alternative === 'greater') for (let x = a; x <= hi; x += 1) p += probs[x - lo];
  else for (const q of probs) if (q <= observed * (1 + 1e-7)) p += q;
  return { method: "Fisher's exact test", p: Math.min(1, p), oddsRatio: (a * d) / (b * c), alternative };
}

// Pearson's chi-square test of independence for an r×c table (array of rows). Yates' continuity
// correction is applied to 2×2 tables unless `correct: false` (as R's chisq.test).
export function chiSquareTest(table, options = {}) {
  const r = table.length;
  const c = table[0].length;
  const rows = table.map((row) => sumOf(row));
  const cols = Array.from({ length: c }, (_, j) => table.reduce((s, row) => s + row[j], 0));
  const total = sumOf(rows);
  if (!(total > 0)) throw new Error('The table is empty.');
  const correct = (options.correct ?? true) && r === 2 && c === 2;
  const expected = table.map((row, i) => row.map((_, j) => (rows[i] * cols[j]) / total));
  let yates = 0;
  if (correct) {
    yates = 0.5;
    for (let i = 0; i < r; i += 1) for (let j = 0; j < c; j += 1) yates = Math.min(yates, Math.abs(table[i][j] - expected[i][j]));
  }
  let stat = 0;
  for (let i = 0; i < r; i += 1) {
    for (let j = 0; j < c; j += 1) {
      const e = expected[i][j];
      if (e > 0) stat += (Math.abs(table[i][j] - e) - yates) ** 2 / e;
    }
  }
  const df = (r - 1) * (c - 1);
  const warnings = [];
  if (expected.some((row) => row.some((e) => e < 5))) warnings.push('Some expected counts are below 5; the chi-square approximation may be poor (consider Fisher’s exact test).');
  return { method: correct ? "Pearson's chi-square test with Yates' correction" : "Pearson's chi-square test", statistic: stat, df, p: chiSquareSurvival(stat, df), expected, warnings };
}

// --- Correlation -------------------------------------------------------------------------------

function pairedFinite(x, y) {
  if (x.length !== y.length) throw new Error('Correlation needs two columns of equal length.');
  const a = [];
  const b = [];
  for (let i = 0; i < x.length; i += 1) {
    if (Number.isFinite(x[i]) && Number.isFinite(y[i])) {
      a.push(x[i]);
      b.push(y[i]);
    }
  }
  return [Float64Array.from(a), Float64Array.from(b)];
}

function pearsonR(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
}

// Pearson correlation with a t-test of r = 0 and a Fisher-z confidence interval (R: cor.test).
export function pearsonCorrelation(x, y, options = {}) {
  const alternative = checkAlternative(options.alternative ?? 'two-sided');
  const confLevel = options.confLevel ?? 0.95;
  const [a, b] = pairedFinite(x, y);
  const n = a.length;
  if (n < 3) throw new Error('Correlation needs at least three pairs.');
  const r = Math.max(-1, Math.min(1, pearsonR(a, b)));
  const df = n - 2;
  const t = (r * Math.sqrt(df)) / Math.sqrt(1 - r * r);
  let ci = null;
  if (n > 3) {
    const z = Math.atanh(r);
    const se = 1 / Math.sqrt(n - 3);
    if (alternative === 'less') ci = [-1, Math.tanh(z + normalQuantile(confLevel) * se)];
    else if (alternative === 'greater') ci = [Math.tanh(z - normalQuantile(confLevel) * se), 1];
    else {
      const q = normalQuantile(1 - (1 - confLevel) / 2);
      ci = [Math.tanh(z - q * se), Math.tanh(z + q * se)];
    }
  }
  return { method: "Pearson's correlation", estimate: r, statistic: t, df, p: pFromT(t, df, alternative), ci, n, alternative };
}

// Spearman rank correlation; p-value from the t approximation on the ranks (R's
// cor.test(method = 'spearman', exact = FALSE)), valid with ties.
export function spearmanCorrelation(x, y, options = {}) {
  const alternative = checkAlternative(options.alternative ?? 'two-sided');
  const [a, b] = pairedFinite(x, y);
  const n = a.length;
  if (n < 3) throw new Error('Correlation needs at least three pairs.');
  const rho = Math.max(-1, Math.min(1, pearsonR(rank(a).ranks, rank(b).ranks)));
  const df = n - 2;
  const t = (rho * Math.sqrt(df)) / Math.sqrt(1 - rho * rho);
  return { method: "Spearman's rank correlation", estimate: rho, statistic: t, df, p: pFromT(t, df, alternative), n, alternative };
}

// --- Multiple testing --------------------------------------------------------------------------

// Adjusted p-values as R's p.adjust: 'bonferroni', 'holm', 'BH' (alias 'fdr'), 'BY', 'none'.
// Non-finite entries are left as NaN and do not count toward the number of tests.
export function adjustPValues(pValues, method = 'BH') {
  const key = String(method).toLowerCase();
  const out = new Float64Array(pValues.length).fill(Number.NaN);
  const idx = [];
  for (let i = 0; i < pValues.length; i += 1) if (Number.isFinite(pValues[i])) idx.push(i);
  const n = idx.length;
  if (!n) return out;
  if (key === 'none') {
    for (const i of idx) out[i] = pValues[i];
    return out;
  }
  if (key === 'bonferroni') {
    for (const i of idx) out[i] = Math.min(1, pValues[i] * n);
    return out;
  }
  if (key === 'holm') {
    const order = idx.slice().sort((a, b) => pValues[a] - pValues[b]);
    let running = 0;
    order.forEach((i, rankIndex) => {
      running = Math.max(running, Math.min(1, (n - rankIndex) * pValues[i]));
      out[i] = running;
    });
    return out;
  }
  if (key === 'bh' || key === 'fdr' || key === 'by') {
    let q = 1;
    if (key === 'by') {
      q = 0;
      for (let k = 1; k <= n; k += 1) q += 1 / k;
    }
    const order = idx.slice().sort((a, b) => pValues[b] - pValues[a]);
    let running = Infinity;
    order.forEach((i, position) => {
      const rankFromBottom = n - position; // rank in ascending order, 1-based
      running = Math.min(running, Math.min(1, (q * n * pValues[i]) / rankFromBottom));
      out[i] = running;
    });
    return out;
  }
  throw new Error(`Unknown p-value adjustment "${method}": use BH, BY, holm, bonferroni or none.`);
}

// --- Effect sizes ------------------------------------------------------------------------------

// Percentile bootstrap: resamples each group with replacement and recomputes
// statistic(...groups). Returns { estimate, ci, se, replicates }.
export function bootstrap(groups, statistic, options = {}) {
  const iterations = options.iterations ?? 2000;
  const confLevel = options.confLevel ?? 0.95;
  const random = createRandom(options.seed ?? 12345);
  const data = groups.map(toArray);
  const estimate = statistic(...data);
  const replicates = new Float64Array(iterations);
  const scratch = data.map((g) => new Float64Array(g.length));
  let valid = 0;
  for (let it = 0; it < iterations; it += 1) {
    if (options.signal?.aborted) throw new Error('The bootstrap was canceled.');
    for (let g = 0; g < data.length; g += 1) {
      const src = data[g];
      const dst = scratch[g];
      for (let i = 0; i < src.length; i += 1) dst[i] = src[random.int(src.length)];
    }
    const v = statistic(...scratch);
    if (Number.isFinite(v)) replicates[valid++] = v;
  }
  const reps = replicates.slice(0, valid).sort();
  const alpha = 1 - confLevel;
  const m = mean(reps);
  return {
    estimate,
    ci: [quantileSorted(reps, alpha / 2), quantileSorted(reps, 1 - alpha / 2)],
    se: Math.sqrt(variance(reps, m)),
    replicates: reps,
    iterations: valid,
  };
}

function cohensDValue(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  const df = a.length + b.length - 2;
  const pooled = ((a.length - 1) * variance(a, ma) + (b.length - 1) * variance(b, mb)) / df;
  return (ma - mb) / Math.sqrt(pooled);
}

// Small-sample correction J(df) = Γ(df/2) / (√(df/2) Γ((df−1)/2)) (Hedges 1981).
function hedgesJ(df) {
  return Math.exp(logGamma(df / 2) - 0.5 * Math.log(df / 2) - logGamma((df - 1) / 2));
}

// Cohen's d (pooled SD) and Hedges' g, with normal-approximation CIs (Hedges & Olkin 1985:
// SE(d) = √((n₁+n₂)/(n₁n₂) + d²/(2(n₁+n₂)))) or percentile bootstrap CIs (`bootstrap: true`).
export function cohensD(x, y, options = {}) {
  const a = toArray(x);
  const b = toArray(y);
  if (a.length < 2 || b.length < 2) throw new Error("Cohen's d needs at least two values per group.");
  const d = cohensDValue(a, b);
  const df = a.length + b.length - 2;
  const J = hedgesJ(df);
  const g = d * J;
  const confLevel = options.confLevel ?? 0.95;
  const n1 = a.length;
  const n2 = b.length;
  const se = Math.sqrt((n1 + n2) / (n1 * n2) + (d * d) / (2 * (n1 + n2)));
  const zq = normalQuantile(1 - (1 - confLevel) / 2);
  let ciD = [d - zq * se, d + zq * se];
  let ciG = [ciD[0] * J, ciD[1] * J];
  let method = 'normal approximation';
  if (options.bootstrap) {
    const boot = bootstrap([a, b], cohensDValue, options);
    ciD = boot.ci;
    ciG = [boot.ci[0] * J, boot.ci[1] * J];
    method = 'percentile bootstrap';
  }
  return { d, g, se, ciD, ciG, correction: J, ciMethod: method };
}

function hodgesLehmannValue(a, b) {
  const diffs = new Float64Array(a.length * b.length);
  let k = 0;
  for (let i = 0; i < a.length; i += 1) for (let j = 0; j < b.length; j += 1) diffs[k++] = a[i] - b[j];
  diffs.sort();
  return quantileSorted(diffs, 0.5);
}

// Hodges–Lehmann shift estimate (median of all pairwise differences x − y) with the
// distribution-free CI from the Mann–Whitney distribution (Bauer 1972; exact quantiles for
// m, n < 50, normal approximation otherwise).
export function hodgesLehmann(x, y, options = {}) {
  const a = toArray(x);
  const b = toArray(y);
  const m = a.length;
  const n = b.length;
  if (!m || !n) throw new Error('Each group needs at least one value.');
  const confLevel = options.confLevel ?? 0.95;
  const diffs = new Float64Array(m * n);
  let k = 0;
  for (let i = 0; i < m; i += 1) for (let j = 0; j < n; j += 1) diffs[k++] = a[i] - b[j];
  diffs.sort();
  const estimate = quantileSorted(diffs, 0.5);
  const alpha = 1 - confLevel;
  let c;
  if (m < 50 && n < 50) {
    // c = qwilcox(α/2, m, n), the smallest u with P(U ≤ u) ≥ α/2 (at least 1); the CI is
    // [D(c), D(mn+1−c)] in 1-based order statistics, as R's wilcox.test(conf.int = TRUE).
    const { lower } = cumulative(mannWhitneyCounts(m, n));
    c = 0;
    while (c < lower.length && lower[c] < alpha / 2) c += 1;
    c = Math.max(1, c);
  } else {
    const z = normalQuantile(1 - alpha / 2);
    c = Math.floor((m * n) / 2 - z * Math.sqrt((m * n * (m + n + 1)) / 12));
  }
  let ci = [-Infinity, Infinity];
  if (c >= 1) ci = [diffs[c - 1], diffs[m * n - c]];
  if (options.bootstrap) ci = bootstrap([a, b], hodgesLehmannValue, options).ci;
  return { estimate, ci };
}

// Fold change of x over y (statistic 'mean' | 'median' | 'geomean') and log2 fold change.
// CI: 'mean' uses the delta method on log means with Welch degrees of freedom; 'geomean' is an
// exact Welch t interval on log2 values; 'median' (or `bootstrap: true`) uses the percentile
// bootstrap. CIs are reported on the log2 scale and as ratios.
export function foldChange(x, y, options = {}) {
  const statistic = options.statistic ?? 'mean';
  const confLevel = options.confLevel ?? 0.95;
  const a = toArray(x);
  const b = toArray(y);
  if (!a.length || !b.length) throw new Error('Each group needs at least one value.');
  const center = {
    mean: (v) => mean(v),
    median: (v) => quantileSorted(Float64Array.from(v).sort(), 0.5),
    geomean: (v) => {
      let s = 0;
      for (let i = 0; i < v.length; i += 1) s += Math.log(v[i]);
      return Math.exp(s / v.length);
    },
  }[statistic];
  if (!center) throw new Error(`Unknown fold-change statistic "${statistic}".`);
  if (statistic === 'geomean' && (a.some((v) => v <= 0) || b.some((v) => v <= 0))) {
    throw new Error('Geometric-mean fold change needs positive values.');
  }
  const ca = center(a);
  const cb = center(b);
  const fc = ca / cb;
  const log2fc = Math.log2(fc);
  let ciLog2 = null;
  let method = null;
  const useBootstrap = options.bootstrap || statistic === 'median';
  if (useBootstrap) {
    const boot = bootstrap([a, b], (u, v) => Math.log2(center(u) / center(v)), options);
    ciLog2 = boot.ci;
    method = 'percentile bootstrap';
  } else if (statistic === 'geomean') {
    const la = Array.from(a, Math.log2);
    const lb = Array.from(b, Math.log2);
    if (la.length >= 2 && lb.length >= 2) {
      ciLog2 = welchTTest(la, lb, { confLevel }).ci;
      method = 'Welch t on log2 values';
    }
  } else if (a.length >= 2 && b.length >= 2 && ca > 0 && cb > 0) {
    const va = variance(a) / (a.length * ca * ca);
    const vb = variance(b) / (b.length * cb * cb);
    const se = Math.sqrt(va + vb) / Math.LN2;
    const df = ((va + vb) ** 2) / ((va * va) / (a.length - 1) + (vb * vb) / (b.length - 1));
    const q = studentTQuantile(1 - (1 - confLevel) / 2, df);
    ciLog2 = [log2fc - q * se, log2fc + q * se];
    method = 'delta method (t)';
  }
  return {
    foldChange: fc, log2FoldChange: log2fc, ciLog2, ci: ciLog2 ? [2 ** ciLog2[0], 2 ** ciLog2[1]] : null, ciMethod: method,
  };
}

// --- Linear models -----------------------------------------------------------------------------

function matrixRows(design) {
  const rows = design.matrix ?? design;
  return rows.map((r) => Array.from(r, Number));
}

// Builds a design matrix from named variables, R-style treatment contrasts: numeric variables
// enter as columns; categorical ones (any non-number value, or type 'factor') as indicators of
// each level except the reference (first level in sorted order unless `reference` is given).
// variables: [{ name, values, type?, reference? }] or { name: values }.
// Returns { matrix: rows (number[][]), names, n, p }.
export function designMatrix(variables, options = {}) {
  const list = Array.isArray(variables)
    ? variables
    : Object.entries(variables).map(([name, values]) => ({ name, values }));
  if (!list.length) throw new Error('A design needs at least one variable.');
  const n = list[0].values.length;
  const columns = [];
  const names = [];
  if (options.intercept !== false) {
    columns.push(new Array(n).fill(1));
    names.push('(Intercept)');
  }
  for (const variable of list) {
    if (variable.values.length !== n) throw new Error(`Variable "${variable.name}" has ${variable.values.length} values; expected ${n}.`);
    const factor = variable.type === 'factor' || variable.values.some((v) => typeof v !== 'number');
    if (!factor) {
      columns.push(Array.from(variable.values, Number));
      names.push(variable.name);
      continue;
    }
    const levels = [...new Set(variable.values.map(String))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const reference = variable.reference !== undefined ? String(variable.reference) : levels[0];
    if (!levels.includes(reference)) throw new Error(`Reference level "${reference}" does not occur in "${variable.name}".`);
    for (const level of levels) {
      if (level === reference) continue;
      columns.push(variable.values.map((v) => (String(v) === level ? 1 : 0)));
      names.push(`${variable.name}[${level}]`);
    }
  }
  const matrix = Array.from({ length: n }, (_, i) => columns.map((col) => col[i]));
  return { matrix, names, n, p: names.length };
}

// Ordinary least squares by Householder QR. X: rows (n × p) or { matrix, names }; y: n values.
// Returns coefficient estimates with standard errors, t statistics, p-values and CIs, the
// residual SE, R², adjusted R² and the overall F test (against the intercept-only model when an
// intercept column is present).
export function linearRegression(X, y, options = {}) {
  const rows = matrixRows(X);
  const names = options.names ?? X.names ?? rows[0].map((_, j) => `x${j}`);
  const confLevel = options.confLevel ?? 0.95;
  const n = rows.length;
  const p = rows[0].length;
  if (y.length !== n) throw new Error('The response and the design matrix have different numbers of rows.');
  if (n <= p) throw new Error(`A linear model with ${p} coefficients needs more than ${p} samples.`);
  const a = new Float64Array(n * p); // column-major copy
  for (let i = 0; i < n; i += 1) for (let j = 0; j < p; j += 1) a[j * n + i] = rows[i][j];
  const qty = Float64Array.from(y, Number);
  const R = new Float64Array(p * p);
  for (let j = 0; j < p; j += 1) {
    let colNorm = 0;
    for (let i = 0; i < n; i += 1) colNorm += rows[i][j] * rows[i][j];
    colNorm = Math.sqrt(colNorm);
    let norm = 0;
    for (let i = j; i < n; i += 1) norm += a[j * n + i] * a[j * n + i];
    norm = Math.sqrt(norm);
    if (!(norm > 1e-10 * colNorm) || colNorm === 0) {
      throw new Error(`Design column "${names[j]}" is constant zero or a combination of earlier columns (collinear).`);
    }
    const alpha = a[j * n + j] > 0 ? -norm : norm;
    a[j * n + j] -= alpha;
    let vv = 0;
    for (let i = j; i < n; i += 1) vv += a[j * n + i] * a[j * n + i];
    for (let k = j + 1; k < p; k += 1) {
      let s = 0;
      for (let i = j; i < n; i += 1) s += a[j * n + i] * a[k * n + i];
      const f = (2 * s) / vv;
      for (let i = j; i < n; i += 1) a[k * n + i] -= f * a[j * n + i];
    }
    let s = 0;
    for (let i = j; i < n; i += 1) s += a[j * n + i] * qty[i];
    const f = (2 * s) / vv;
    for (let i = j; i < n; i += 1) qty[i] -= f * a[j * n + i];
    R[j * p + j] = alpha;
    for (let k = j + 1; k < p; k += 1) R[j * p + k] = a[k * n + j];
  }
  const beta = new Float64Array(p);
  for (let j = p - 1; j >= 0; j -= 1) {
    let s = qty[j];
    for (let k = j + 1; k < p; k += 1) s -= R[j * p + k] * beta[k];
    beta[j] = s / R[j * p + j];
  }
  // R⁻¹ (upper triangular) for (XᵀX)⁻¹ = R⁻¹R⁻ᵀ.
  const Rinv = new Float64Array(p * p);
  for (let j = 0; j < p; j += 1) {
    Rinv[j * p + j] = 1 / R[j * p + j];
    for (let i = j - 1; i >= 0; i -= 1) {
      let s = 0;
      for (let k = i + 1; k <= j; k += 1) s += R[i * p + k] * Rinv[k * p + j];
      Rinv[i * p + j] = -s / R[i * p + i];
    }
  }
  const fitted = new Float64Array(n);
  const residuals = new Float64Array(n);
  let rss = 0;
  for (let i = 0; i < n; i += 1) {
    let v = 0;
    for (let j = 0; j < p; j += 1) v += rows[i][j] * beta[j];
    fitted[i] = v;
    residuals[i] = y[i] - v;
    rss += residuals[i] * residuals[i];
  }
  const dfResidual = n - p;
  const sigma2 = rss / dfResidual;
  const covariance = new Float64Array(p * p);
  for (let i = 0; i < p; i += 1) {
    for (let j = 0; j < p; j += 1) {
      let s = 0;
      for (let k = Math.max(i, j); k < p; k += 1) s += Rinv[i * p + k] * Rinv[j * p + k];
      covariance[i * p + j] = s * sigma2;
    }
  }
  const tq = studentTQuantile(1 - (1 - confLevel) / 2, dfResidual);
  const coefficients = Array.from(beta, (b, j) => {
    const se = Math.sqrt(covariance[j * p + j]);
    const t = b / se;
    return { name: names[j], estimate: b, se, t, p: pFromT(t, dfResidual, 'two-sided'), ci: [b - tq * se, b + tq * se] };
  });
  const hasIntercept = rows[0].some((_, j) => rows.every((r) => r[j] === rows[0][j] && r[j] !== 0));
  let tss = 0;
  const my = hasIntercept ? mean(Float64Array.from(y, Number)) : 0;
  for (let i = 0; i < n; i += 1) tss += (y[i] - my) ** 2;
  const rSquared = 1 - rss / tss;
  const dfModel = hasIntercept ? p - 1 : p;
  const adjustedRSquared = 1 - (1 - rSquared) * ((n - (hasIntercept ? 1 : 0)) / dfResidual);
  const fStatistic = dfModel > 0 ? ((tss - rss) / dfModel) / sigma2 : Number.NaN;
  return {
    coefficients, estimates: beta, standardErrors: Float64Array.from(coefficients, (c) => c.se), covariance,
    sigma: Math.sqrt(sigma2), dfResidual, rSquared, adjustedRSquared, fStatistic, fDf: [dfModel, dfResidual],
    fP: dfModel > 0 ? fSurvival(fStatistic, dfModel, dfResidual) : Number.NaN, fitted, residuals, names,
  };
}

// --- Binomial GLM (logit link) and differential abundance ---------------------------------------

const logistic = (eta) => 1 / (1 + Math.exp(-eta));

export function logit(p, epsilon = 0) {
  const q = Math.min(1 - epsilon, Math.max(epsilon, p));
  return Math.log(q / (1 - q));
}

// Variance-stabilizing arcsine square-root transform of a proportion.
export function arcsineSqrt(p) {
  return Math.asin(Math.sqrt(Math.min(1, Math.max(0, p))));
}

function binomialDeviance(s, t, mu) {
  let dev = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (!(t[i] > 0)) continue;
    const yi = s[i];
    const fi = t[i] - s[i];
    if (yi > 0) dev += yi * Math.log(yi / (t[i] * mu[i]));
    if (fi > 0) dev += fi * Math.log(fi / (t[i] * (1 - mu[i])));
  }
  return 2 * dev;
}

// Logistic regression of successes/trials on design X by iteratively reweighted least squares
// (McCullagh & Nelder 1989). family 'binomial' (dispersion 1, z tests) or 'quasibinomial'
// (dispersion = Pearson χ²/residual df, t tests, as R's glm). Returns coefficients, SEs,
// covariance, deviance, Pearson χ², dispersion and Wald tests.
export function binomialGLM(successes, trials, X, options = {}) {
  const rows = matrixRows(X);
  const names = options.names ?? X.names ?? rows[0].map((_, j) => `x${j}`);
  const family = options.family ?? 'binomial';
  const maxIterations = options.maxIterations ?? 50;
  const tolerance = options.tolerance ?? 1e-10;
  const n = rows.length;
  const p = rows[0].length;
  const s = Float64Array.from(successes, Number);
  const t = Float64Array.from(trials, Number);
  for (let i = 0; i < n; i += 1) {
    if (!(s[i] >= 0) || !(t[i] >= s[i])) throw new Error('Each count must be between zero and its total.');
  }
  let used = 0;
  for (let i = 0; i < n; i += 1) if (t[i] > 0) used += 1;
  if (used <= p) throw new Error(`The model has ${p} coefficients but only ${used} samples with events.`);
  const mu = new Float64Array(n);
  const eta = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    mu[i] = (s[i] + 0.5) / (t[i] + 1);
    eta[i] = Math.log(mu[i] / (1 - mu[i]));
  }
  let deviance = binomialDeviance(s, t, mu);
  const beta = new Float64Array(p);
  const XtWX = new Float64Array(p * p);
  const XtWz = new Float64Array(p);
  let converged = false;
  let iterations = 0;
  const accumulate = (withZ) => {
    XtWX.fill(0);
    XtWz.fill(0);
    for (let i = 0; i < n; i += 1) {
      if (!(t[i] > 0)) continue;
      const v = mu[i] * (1 - mu[i]);
      const w = t[i] * v;
      if (!(w > 0)) continue;
      const z = withZ ? eta[i] + (s[i] / t[i] - mu[i]) / v : 0;
      const row = rows[i];
      for (let a = 0; a < p; a += 1) {
        const wa = w * row[a];
        XtWz[a] += wa * z;
        for (let b = 0; b <= a; b += 1) XtWX[a * p + b] += wa * row[b];
      }
    }
    for (let a = 0; a < p; a += 1) for (let b = 0; b < a; b += 1) XtWX[b * p + a] = XtWX[a * p + b];
  };
  const L = new Float64Array(p * p);
  for (iterations = 1; iterations <= maxIterations; iterations += 1) {
    accumulate(true);
    L.set(XtWX);
    if (!cholesky(L, p)) throw new Error('The design is singular for these counts (collinear columns or complete separation).');
    choleskySolve(L, p, XtWz, beta);
    for (let i = 0; i < n; i += 1) {
      let e = 0;
      for (let j = 0; j < p; j += 1) e += rows[i][j] * beta[j];
      eta[i] = e;
      // Keep μ strictly inside (0, 1), as R's binomial()$linkinv does.
      mu[i] = Math.min(1 - 2.220446049250313e-16, Math.max(2.220446049250313e-16, logistic(e)));
    }
    const next = binomialDeviance(s, t, mu);
    const change = Math.abs(next - deviance) / (Math.abs(next) + 0.1);
    deviance = next;
    if (change < tolerance) {
      converged = true;
      break;
    }
  }
  iterations = Math.min(iterations, maxIterations);
  accumulate(false);
  const inv = invertSymmetric(XtWX, p);
  let pearson = 0;
  for (let i = 0; i < n; i += 1) {
    if (!(t[i] > 0)) continue;
    pearson += (s[i] - t[i] * mu[i]) ** 2 / (t[i] * mu[i] * (1 - mu[i]));
  }
  const dfResidual = used - p;
  const quasi = family === 'quasibinomial';
  const dispersion = quasi ? pearson / dfResidual : 1;
  const covariance = new Float64Array(p * p);
  if (inv) for (let k = 0; k < p * p; k += 1) covariance[k] = inv[k] * dispersion;
  else covariance.fill(Number.NaN);
  const coefficients = Array.from(beta, (b, j) => {
    const se = Math.sqrt(covariance[j * p + j]);
    const stat = b / se;
    return { name: names[j], estimate: b, se, statistic: stat, p: quasi ? pFromT(stat, dfResidual, 'two-sided') : pFromZ(stat, 'two-sided') };
  });
  return {
    family, coefficients, estimates: beta, standardErrors: Float64Array.from(coefficients, (c) => c.se), covariance,
    deviance, pearsonChiSquare: pearson, dispersion, dfResidual, fitted: mu, iterations, converged, names,
  };
}

// Differential abundance of clusters between conditions, approximating diffcyt's
// edgeR/GLMM approaches (Weber et al. 2019, doi:10.1038/s42003-019-0415-5) with a per-cluster
// quasi-binomial GLM: counts[s][c] cells of cluster c in sample s out of totals[s] (default the
// row sums), design rows per sample (or { matrix, names } from designMatrix; patient or batch
// enter as fixed effects). Tests one coefficient (index or name, default the last column) by a
// likelihood-ratio test (quasi: F = ΔD/φ on (1, df) — R's anova(test = 'F')) or a Wald test,
// then BH-adjusts across clusters. estimate is a log odds ratio (≈ log fold change of a rare
// cluster's frequency).
export function differentialAbundance(counts, totals, design, options = {}) {
  const S = counts.length;
  if (!S) throw new Error('No samples.');
  const C = counts[0].length;
  const tot = totals ? Float64Array.from(totals, Number) : Float64Array.from(counts, (row) => sumOf(row));
  const rows = matrixRows(design);
  if (rows.length !== S) throw new Error(`The design has ${rows.length} rows but there are ${S} samples.`);
  const names = options.names ?? design.names ?? rows[0].map((_, j) => `x${j}`);
  const p = rows[0].length;
  let coef = options.coefficient ?? p - 1;
  if (typeof coef === 'string') {
    coef = names.indexOf(coef);
    if (coef < 0) throw new Error(`Coefficient "${options.coefficient}" is not in the design.`);
  }
  const family = options.family ?? 'quasibinomial';
  const test = options.test ?? 'lr';
  const minCount = options.minCount ?? 1;
  const reducedRows = rows.map((r) => r.filter((_, j) => j !== coef));
  const results = [];
  for (let c = 0; c < C; c += 1) {
    const s = Float64Array.from(counts, (row) => Number(row[c]));
    const clusterTotal = sumOf(s);
    const base = { cluster: options.clusterNames?.[c] ?? c, total: clusterTotal };
    if (clusterTotal < minCount || clusterTotal === sumOf(tot)) {
      results.push({ ...base, estimate: Number.NaN, log2OddsRatio: Number.NaN, se: Number.NaN, statistic: Number.NaN, p: Number.NaN, note: 'too few or all cells' });
      continue;
    }
    try {
      const full = binomialGLM(s, tot, rows, { family, names });
      const k = full.coefficients[coef];
      let statistic;
      let pValue;
      if (test === 'lr') {
        const reduced = binomialGLM(s, tot, reducedRows, { family });
        const dDev = Math.max(0, reduced.deviance - full.deviance);
        if (family === 'quasibinomial') {
          statistic = dDev / full.dispersion;
          pValue = fSurvival(statistic, 1, full.dfResidual);
        } else {
          statistic = dDev;
          pValue = chiSquareSurvival(dDev, 1);
        }
      } else {
        statistic = k.statistic;
        pValue = k.p;
      }
      results.push({
        ...base, estimate: k.estimate, log2OddsRatio: k.estimate / Math.LN2, se: k.se, statistic, p: pValue,
        dispersion: full.dispersion, dfResidual: full.dfResidual, converged: full.converged,
      });
    } catch (error) {
      results.push({ ...base, estimate: Number.NaN, log2OddsRatio: Number.NaN, se: Number.NaN, statistic: Number.NaN, p: Number.NaN, note: error.message });
    }
  }
  const padj = adjustPValues(results.map((r) => r.p), 'BH');
  results.forEach((r, i) => { r.padj = padj[i]; });
  return { coefficient: names[coef], family, test, results };
}
