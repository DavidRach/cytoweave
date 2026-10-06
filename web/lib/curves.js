// Dose-response and standard curves: four- and five-parameter log-logistic models fitted by least
// squares (fit.js), in the parameterization of R's drc package (Ritz, Baty, Streibig & Gerhard
// 2015, doi:10.1371/journal.pone.0146021), which the validation compares with:
//   LL.4  f(x) = c + (d − c) / (1 + exp(b (ln x − ln e)))
//   LL.5  f(x) = c + (d − c) / (1 + exp(b (ln x − ln e)))^f
// With b > 0, d is the response at zero dose and c at an infinite one (the other way round for
// b < 0). Results are also given in the terms of most lab software: bottom and top (the
// asymptotes), a Hill slope (|b|, negative for a falling curve) and the EC50, the dose halfway from
// the zero-dose response to the other asymptote (e for LL.4; e (2^(1/f) − 1)^(1/b) for LL.5, drc's relative ED50), with
// its standard error and a 95% confidence interval from the delta method on the log scale (so it
// stays positive). The five-parameter model's asymmetry suits immunoassay standard curves
// (Gottschalk & Dunn 2005, doi:10.1016/j.ab.2005.04.035).
//
// Weighting: residuals divided by σᵢ = 1 (none), √yᵢ ("1/Y") or yᵢ ("1/Y²", relative errors, for
// responses spanning decades such as bead MFIs); drc's `weights` argument takes these σᵢ.
// Standard errors come from the observed information (the Hessian of the residual sum of squares,
// not its Gauss–Newton approximation) scaled by the residual variance, as drc's do.

import { fitLeastSquares, invertSymmetric } from './fit.js';
import { fSurvival, studentTQuantile } from './hypothesis.js';

export const MODELS = ['LL.4', 'LL.5'];
export const WEIGHTINGS = ['none', '1/y', '1/y2'];
const NAMES = ['b', 'c', 'd', 'e', 'f'];

function softplus(u) {
  return u > 0 ? u + Math.log1p(Math.exp(-u)) : Math.log1p(Math.exp(u));
}

function sigmoid(u) {
  if (u >= 0) return 1 / (1 + Math.exp(-u));
  const t = Math.exp(u);
  return t / (1 + t);
}

// The response at dose x for { b, c, d, e, f } (f = 1 for LL.4).
export function logLogistic(x, { b, c, d, e, f = 1 }) {
  if (!(x > 0)) {
    if (b > 0) return d;
    if (b < 0) return c;
    return c + (d - c) * 2 ** -f;
  }
  return c + (d - c) * Math.exp(-f * softplus(b * (Math.log(x) - Math.log(e))));
}

// The dose giving response y (drc's absolute ED), or NaN when y is not between the asymptotes.
export function inverseLogLogistic(y, { b, c, d, e, f = 1 }) {
  const g = (y - c) / (d - c);
  if (!(g > 0 && g < 1) || b === 0) return Number.NaN;
  const t = g ** (-1 / f) - 1;
  return e * t ** (1 / b);
}

// The dose giving p% of the way from the zero-dose response to the other asymptote (drc's
// relative ED): EC50 is p = 50; for a falling curve, p% inhibition.
export function effectiveDose({ b, e, f = 1 }, p = 50) {
  if (!(p > 0 && p < 100) || b === 0) return Number.NaN;
  return e * ((100 / (100 - p)) ** (1 / f) - 1) ** (1 / b);
}

// Model and analytic Jacobian over the internal parameters [b, c, d, ln e, f].
function makeModel(x) {
  const n = x.length;
  const logs = Float64Array.from(x, (v) => (v > 0 ? Math.log(v) : Number.NEGATIVE_INFINITY));
  const model = (p, out) => {
    const [b, c, d, le, f] = p;
    for (let i = 0; i < n; i += 1) {
      if (logs[i] === Number.NEGATIVE_INFINITY) out[i] = b > 0 ? d : b < 0 ? c : c + (d - c) * 2 ** -f;
      else out[i] = c + (d - c) * Math.exp(-f * softplus(b * (logs[i] - le)));
    }
    return out;
  };
  const jacobian = (p, J) => {
    const [b, c, d, le, f] = p;
    for (let i = 0; i < n; i += 1) {
      const row = i * 5;
      if (logs[i] === Number.NEGATIVE_INFINITY) {
        const g = b > 0 ? 1 : b < 0 ? 0 : 2 ** -f;
        J[row] = 0;
        J[row + 1] = 1 - g;
        J[row + 2] = g;
        J[row + 3] = 0;
        J[row + 4] = b === 0 ? -(d - c) * g * Math.LN2 : 0;
        continue;
      }
      const L = logs[i] - le;
      const u = b * L;
      const sp = softplus(u);
      const g = Math.exp(-f * sp);
      const dgdu = -f * g * sigmoid(u);
      J[row] = (d - c) * dgdu * L;
      J[row + 1] = 1 - g;
      J[row + 2] = g;
      J[row + 3] = -(d - c) * dgdu * b;
      J[row + 4] = -(d - c) * g * sp;
    }
  };
  return { model, jacobian };
}

function sigmaFor(y, weighting) {
  if (!weighting || weighting === 'none') return null;
  // A floor keeps a zero or negative response from getting an infinite weight.
  const positive = y.filter((v) => v > 0);
  const floor = positive.length ? Math.min(...positive) / 10 : 1;
  return Float64Array.from(y, (v) => {
    const a = Math.max(Math.abs(v), floor);
    return weighting === '1/y' ? Math.sqrt(a) : a;
  });
}

// Starting points: the asymptotes from the responses at the lowest and highest doses (widened a
// little), b and e from the linearized model ln((d − y)/(y − c)) = b ln x − b ln e, and a spread
// of e and b around them.
function startingPoints(x, y, fixed) {
  const byDose = new Map();
  for (let i = 0; i < x.length; i += 1) {
    if (!byDose.has(x[i])) byDose.set(x[i], []);
    byDose.get(x[i]).push(y[i]);
  }
  const doses = [...byDose.keys()].sort((a, b) => a - b);
  const means = doses.map((dose) => byDose.get(dose).reduce((s, v) => s + v, 0) / byDose.get(dose).length);
  const lo = Math.min(...means);
  const hi = Math.max(...means);
  const range = hi - lo || Math.abs(hi) * 0.1 || 1;
  const falling = means[0] >= means.at(-1);
  let d = fixed.d ?? (falling ? hi + 0.05 * range : lo - 0.05 * range);
  let c = fixed.c ?? (falling ? lo - 0.05 * range : hi + 0.05 * range);
  if (d === c) d = c + range;
  const positive = doses.filter((v) => v > 0);
  const logDoses = positive.map(Math.log);
  let b0 = falling ? 1 : -1;
  let le0 = logDoses.length ? (logDoses[0] + logDoses.at(-1)) / 2 : 0;
  const lx = [];
  const lz = [];
  doses.forEach((dose, k) => {
    if (!(dose > 0)) return;
    const z = (d - means[k]) / (means[k] - c);
    if (z > 0 && Number.isFinite(z)) {
      lx.push(Math.log(dose));
      lz.push(Math.log(z));
    }
  });
  if (lx.length >= 2) {
    const mx = lx.reduce((s, v) => s + v, 0) / lx.length;
    const mz = lz.reduce((s, v) => s + v, 0) / lz.length;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < lx.length; i += 1) {
      sxy += (lx[i] - mx) * (lz[i] - mz);
      sxx += (lx[i] - mx) ** 2;
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    if (Number.isFinite(slope) && Math.abs(slope) > 1e-3) {
      b0 = Math.max(-20, Math.min(20, slope));
      le0 = mx - mz / slope;
    }
  }
  if (fixed.b !== undefined) b0 = fixed.b;
  if (fixed.e !== undefined) le0 = Math.log(fixed.e);
  const f0 = fixed.f ?? 1;
  const starts = [[b0, c, d, le0, f0]];
  if (logDoses.length >= 2 && fixed.e === undefined) {
    const span = logDoses.at(-1) - logDoses[0];
    for (const q of [0.2, 0.5, 0.8]) starts.push([b0, c, d, logDoses[0] + q * span, f0]);
  }
  if (fixed.b === undefined) starts.push([b0 * 3, c, d, le0, f0], [b0 / 3, c, d, le0, f0]);
  if (fixed.f === undefined) {
    starts.push([b0, c, d, le0, 0.4], [b0, c, d, le0, 2.5]);
    // The five-parameter curve is not symmetric: the same rise with b of the other sign (c and d
    // swapped) is a different shape.
    if (fixed.b === undefined && fixed.c === undefined && fixed.d === undefined) starts.push([-b0, d, c, le0, f0], [-b0, d, c, le0, 0.4], [-b0, d, c, le0, 2.5]);
  }
  return starts;
}

// Covariance of the internal parameters from the observed information: s² (H/2)⁻¹ with H the
// Hessian of the weighted residual sum of squares (central differences of its analytic gradient)
// and s² = RSS/df. Null when H is not positive definite.
function observedCovariance(model, jacobian, p, y, sigma, mask, rss, df) {
  const n = y.length;
  const free = [];
  for (let j = 0; j < 5; j += 1) if (!mask[j]) free.push(j);
  const k = free.length;
  if (!k || !(df > 0)) return null;
  const out = new Float64Array(n);
  const J = new Float64Array(n * 5);
  const gradient = (q) => {
    model(q, out);
    jacobian(q, J);
    const g = new Float64Array(5);
    for (let i = 0; i < n; i += 1) {
      const w = sigma ? 1 / sigma[i] ** 2 : 1;
      const r = y[i] - out[i];
      for (let j = 0; j < 5; j += 1) g[j] -= 2 * w * r * J[i * 5 + j];
    }
    return g;
  };
  const H = new Float64Array(k * k);
  for (let a = 0; a < k; a += 1) {
    const j = free[a];
    const h = 1e-5 * Math.max(1, Math.abs(p[j]));
    const up = Float64Array.from(p);
    const down = Float64Array.from(p);
    up[j] += h;
    down[j] -= h;
    const gu = gradient(up);
    const gd = gradient(down);
    for (let b = 0; b < k; b += 1) H[b * k + a] = (gu[free[b]] - gd[free[b]]) / (4 * h); // H/2
  }
  for (let a = 0; a < k; a += 1) for (let b = 0; b < a; b += 1) H[a * k + b] = H[b * k + a] = (H[a * k + b] + H[b * k + a]) / 2;
  const inv = invertSymmetric(H, k);
  if (!inv) return null;
  const s2 = rss / df;
  const cov = new Float64Array(25);
  for (let a = 0; a < k; a += 1) for (let b = 0; b < k; b += 1) cov[free[a] * 5 + free[b]] = inv[a * k + b] * s2;
  return cov;
}

function weightedMean(y, sigma) {
  let s = 0;
  let w = 0;
  for (let i = 0; i < y.length; i += 1) {
    const wi = sigma ? 1 / sigma[i] ** 2 : 1;
    s += wi * y[i];
    w += wi;
  }
  return s / w;
}

// Fits a log-logistic curve. x: doses (≥ 0; zero doses sit on the zero-dose asymptote), y: responses.
// options: model 'LL.4' | 'LL.5', weighting 'none' | '1/y' | '1/y2', fixed { b, c, d, e, f }
// (values held, as drc's `fixed`), level (0.95), signal.
// Returns { model, n, parameters { b, c, d, e, f }, standardErrors, covariance (of b, c, d, e, f),
//   bottom, top, hill, rising, ec50, ec50SE, ec50CI, logEC50SE, rss, df, residualSE, r2,
//   noEffect { F, p }, fitted, residuals, converged, flags, x, y } or throws when the data cannot
//   support the model.
export function fitLogLogistic(xIn, yIn, options = {}) {
  const model = options.model ?? 'LL.4';
  if (!MODELS.includes(model)) throw new Error(`Unknown model ${model}: use ${MODELS.join(' or ')}.`);
  const xs = [];
  const ys = [];
  for (let i = 0; i < xIn.length; i += 1) {
    const xv = Number(xIn[i]);
    const yv = Number(yIn[i]);
    if (Number.isFinite(xv) && xv >= 0 && Number.isFinite(yv)) {
      xs.push(xv);
      ys.push(yv);
    }
  }
  const fixed = { ...(options.fixed ?? {}) };
  if (model === 'LL.4') fixed.f = 1;
  for (const key of Object.keys(fixed)) if (fixed[key] === null || fixed[key] === undefined || !Number.isFinite(Number(fixed[key]))) delete fixed[key];
  const mask = NAMES.map((name) => name in fixed);
  const free = mask.filter((m) => !m).length;
  const n = xs.length;
  const distinct = new Set(xs).size;
  if (n <= free) throw new Error(`${n} points cannot fit ${free} parameters.`);
  if (distinct < Math.min(free, 4)) throw new Error(`${distinct} different doses are too few to fit a ${model} curve.`);
  const x = Float64Array.from(xs);
  const y = Float64Array.from(ys);
  const sigma = sigmaFor(y, options.weighting);
  const { model: f, jacobian } = makeModel(x);
  const positive = xs.filter((v) => v > 0);
  const minLog = Math.log(Math.min(...positive));
  const maxLog = Math.log(Math.max(...positive));
  // The EC50 parameter stays within 100-fold of the tested doses and the asymmetry within 1/20–20:
  // beyond them a five-parameter curve runs off to a limit shape (f and e growing together) that
  // fits no better than a sensible one and whose parameters mean nothing. A fit that reaches a
  // bound is flagged.
  const lower = [-60, null, null, minLog - Math.log(100), 0.05];
  const upper = [60, null, null, maxLog + Math.log(100), 20];
  let best = null;
  for (const start of startingPoints(xs, ys, fixed)) {
    const p0 = Float64Array.from(start);
    NAMES.forEach((name, j) => {
      if (name in fixed) p0[j] = name === 'e' ? Math.log(fixed.e) : Number(fixed[name]);
    });
    let result;
    try {
      result = fitLeastSquares(f, p0, y, { jacobian, fixed: mask, sigma, lower, upper, maxIterations: 400, signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      continue;
    }
    if (Number.isFinite(result.chiSquare) && (!best || result.chiSquare < best.chiSquare * (1 - 1e-12))) best = result;
  }
  if (!best) throw new Error('The curve could not be fitted to these data.');
  const internal = observedCovariance(f, jacobian, best.params, y, sigma, mask, best.chiSquare, best.dof) ?? best.covariance;
  const [b, c, d, le, fAsym] = best.params;
  const e = Math.exp(le);
  const parameters = { b, c, d, e, f: fAsym };
  // Covariance of (b, c, d, e, f): e = exp(ln e) scales its row and column by e.
  const scale = [1, 1, 1, e, 1];
  const covariance = new Float64Array(25);
  for (let i = 0; i < 5; i += 1) for (let j = 0; j < 5; j += 1) covariance[i * 5 + j] = internal[i * 5 + j] * scale[i] * scale[j];
  const standardErrors = Object.fromEntries(NAMES.map((name, j) => [name, mask[j] ? null : Math.sqrt(Math.max(0, covariance[j * 5 + j]))]));
  const rss = best.chiSquare;
  const df = best.dof;
  const ec50 = effectiveDose(parameters, 50);
  // ln EC50 = ln e + (1/b) ln(2^(1/f) − 1): its gradient over the internal (b, c, d, ln e, f).
  const a = 2 ** (1 / fAsym) - 1;
  const grad = [-Math.log(a) / (b * b), 0, 0, 1, (1 / b) * (2 ** (1 / fAsym) * Math.LN2 * (-1 / (fAsym * fAsym))) / a];
  let logVar = 0;
  for (let i = 0; i < 5; i += 1) for (let j = 0; j < 5; j += 1) logVar += grad[i] * internal[i * 5 + j] * grad[j];
  const logEC50SE = Math.sqrt(Math.max(0, logVar));
  const level = options.level ?? 0.95;
  const tq = df > 0 ? studentTQuantile(1 - (1 - level) / 2, df) : Number.NaN;
  const ec50CI = Number.isFinite(logEC50SE) && Number.isFinite(tq) ? [ec50 * Math.exp(-tq * logEC50SE), ec50 * Math.exp(tq * logEC50SE)] : [Number.NaN, Number.NaN];
  const mean = weightedMean(y, sigma);
  let tss = 0;
  for (let i = 0; i < n; i += 1) tss += ((y[i] - mean) / (sigma ? sigma[i] : 1)) ** 2;
  // Against a flat line (the mean): an F test of the curve's extra parameters.
  const extra = free - 1;
  const F = extra > 0 && df > 0 && rss > 0 ? ((tss - rss) / extra) / (rss / df) : Number.NaN;
  const noEffect = { F, p: Number.isFinite(F) ? fSurvival(F, extra, df) : Number.NaN };
  // Rising when the response at an infinite dose (c for b > 0, d for b < 0) is the larger.
  const rising = b > 0 ? c > d : d > c;
  const flags = [];
  if (!best.converged) flags.push('not-converged');
  if (noEffect.p >= 0.05) flags.push('no-effect');
  if (Number.isFinite(ec50) && positive.length && (ec50 < Math.min(...positive) || ec50 > Math.max(...positive))) flags.push('extrapolated');
  if (ec50CI[1] / ec50CI[0] > 100 || !Number.isFinite(ec50CI[1])) flags.push('wide-ci');
  if (best.atBound.some(Boolean)) flags.push('at-bound');
  return {
    model,
    weighting: options.weighting ?? 'none',
    n,
    parameters,
    standardErrors,
    covariance,
    fixed: mask,
    bottom: Math.min(c, d),
    top: Math.max(c, d),
    hill: rising ? Math.abs(b) : -Math.abs(b),
    rising,
    ec50,
    ec50SE: ec50 * logEC50SE,
    logEC50SE,
    ec50CI,
    level,
    rss,
    df,
    residualSE: df > 0 ? Math.sqrt(rss / df) : Number.NaN,
    r2: tss > 0 ? 1 - rss / tss : Number.NaN,
    noEffect,
    fitted: Float64Array.from(best.fitted),
    residuals: Float64Array.from(best.residuals),
    converged: best.converged,
    flags,
    x,
    y,
    internalCovariance: internal,
  };
}

// The dose giving response y on a fitted curve with its standard error (delta method, as drc's
// ED(type = "absolute") gives): { dose, se }.
export function inverseWithError(fit, y) {
  const dose = inverseLogLogistic(y, fit.parameters);
  if (!Number.isFinite(dose)) return { dose, se: Number.NaN };
  const p = [fit.parameters.b, fit.parameters.c, fit.parameters.d, Math.log(fit.parameters.e), fit.parameters.f];
  const at = (q) => Math.log(inverseLogLogistic(y, { b: q[0], c: q[1], d: q[2], e: Math.exp(q[3]), f: q[4] }));
  const base = Math.log(dose);
  const grad = new Float64Array(5);
  for (let j = 0; j < 5; j += 1) {
    if (fit.fixed[j]) continue;
    const h = 1e-6 * Math.max(1, Math.abs(p[j]));
    const up = p.slice();
    const down = p.slice();
    up[j] += h;
    down[j] -= h;
    const a = at(up);
    const b = at(down);
    grad[j] = Number.isFinite(a) && Number.isFinite(b) ? (a - b) / (2 * h) : Number.isFinite(a) ? (a - base) / h : Number.isFinite(b) ? (base - b) / h : 0;
  }
  let v = 0;
  for (let i = 0; i < 5; i += 1) for (let j = 0; j < 5; j += 1) v += grad[i] * fit.internalCovariance[i * 5 + j] * grad[j];
  return { dose, se: dose * Math.sqrt(Math.max(0, v)) };
}

// Points along a fitted curve for drawing: `count` doses spaced evenly in log between lo and hi.
export function curvePoints(fit, lo, hi, count = 120) {
  const out = [];
  for (let k = 0; k < count; k += 1) {
    const x = Math.exp(Math.log(lo) + ((Math.log(hi) - Math.log(lo)) * k) / (count - 1));
    out.push([x, logLogistic(x, fit.parameters)]);
  }
  return out;
}

// Responses as a percentage of the controls: 0% at the negative controls' mean, 100% at the
// positive controls'. For an inhibitor screen with stimulated (positive) and unstimulated
// (negative) controls, 100 minus this is the inhibition.
export function percentOfControls(values, negativeMean, positiveMean) {
  const span = positiveMean - negativeMean;
  return values.map((v) => (span !== 0 ? (100 * (v - negativeMean)) / span : Number.NaN));
}

// What a fit's flags mean, for tables and notes.
export const FLAG_TEXT = {
  'not-converged': 'the fit did not converge',
  'no-effect': 'no dose-response: the curve fits no better than a flat line (F test, p ≥ 0.05)',
  extrapolated: 'the EC50 lies outside the tested doses',
  'wide-ci': 'the EC50 is poorly determined (its 95% CI spans more than 100-fold)',
  'at-bound': 'a parameter reached its limit (the EC50 100-fold beyond the tested doses, or the asymmetry 1/20 or 20)',
};
