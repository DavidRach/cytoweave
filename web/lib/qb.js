// Instrument characterization (Q5): detector efficiency Q, optical background B and the intrinsic
// CV of multi-level beads or LED pulses, from the quadratic variance model of Parks et al. 2017
// (Cytometry A 91:232, doi:10.1002/cyto.a.23052), as flowQB computes them; and Levey–Jennings
// statistics with Westgard rules for tracking an instrument across runs.
//
// Model. A peak's variance in measurement units grows with its mean M as
//   V(M) = c0 + c1·M + c2·M²,
// whose terms are the background (electronic noise and optical background light), photoelectron
// counting (Poisson) and the intrinsic intensity variation of the particles. Then
//   Q = 1/c1 statistical photoelectrons (Spe) per measurement unit,
//   B = c0/c1² Spe of background,
//   CV0² = c2.
// The fit is weighted least squares with weights 1/Var[V] = (N − 1)/(2V²), first from each
// peak's own variance, then re-estimated from the fitted V until the coefficients settle.
//
// Each peak's mean and SD are the parameters of a normal distribution fitted to its central
// 80% (extremevalues' getOutliers, method I, as flowQB uses): sorted values against the normal
// quantiles of their plotting positions i/(N + 1), between the 10th and 90th percentiles. So
// tails and stray events of a neighboring peak barely move them.

import { normalQuantile, studentTSurvival } from './hypothesis.js';
import { kmeans } from './kmeans.js';
import { createTransform } from './transforms.js';

export const QB_DEFAULTS = {
  bounds: { minimum: -100, maximum: 100000 }, // peaks whose mean falls outside are left out
  maximumCV: 0.65, // for height signals: peaks with a larger CV are left out
  iterations: 10,
  tolerance: 5e-5, // largest relative change of a coefficient that ends the iterations
  minimumPeaks: 3,
};

// Bead products with their number of intensity levels (including the blank).
export const BEAD_PRODUCTS = [
  { id: 'spherotech-8', label: 'Spherotech 8-peak (Rainbow)', peaks: 8 },
  { id: 'thermo-6', label: 'Thermo Fisher 6-peak', peaks: 6 },
  { id: 'other', label: 'Other multi-level beads', peaks: null },
];

// --- Peak statistics ------------------------------------------------------------------------------

// A normal distribution fitted to the central part of the values (extremevalues' getOutliers,
// method I, FLim = [0.1, 0.9]). Returns { n, mean, sd }.
export function robustNormal(values, flim = [0.1, 0.9]) {
  const n = values.length;
  if (n < 3) return { n, mean: Number.NaN, sd: Number.NaN };
  const y = Float64Array.from(values).sort();
  let sz = 0; let szz = 0; let sy = 0; let szy = 0; let m = 0;
  for (let i = 0; i < n; i += 1) {
    const p = (i + 1) / (n + 1);
    if (p < flim[0] || p > flim[1]) continue;
    const z = normalQuantile(p);
    sz += z; szz += z * z; sy += y[i]; szy += z * y[i]; m += 1;
  }
  if (m < 2) return { n, mean: Number.NaN, sd: Number.NaN };
  const sd = (m * szy - sz * sy) / (m * szz - sz * sz);
  return { n, mean: (sy - sd * sz) / m, sd };
}

// The densest window of a sample and the extent around it where the window stays within 1/width
// of its narrowest (flowQB's find_peak, a full-width-at-half-maximum-like range). Returns
// { lo, hi }.
export function findPeak(values, width = 0.5, fraction = 0.1) {
  const x = Float64Array.from(values).sort();
  const N = x.length;
  const M = Math.ceil(N * fraction);
  const M2 = Math.floor((M + 1) / 2);
  // 1-based indices as in the original.
  const at = (i) => x[i - 1];
  let first = 1;
  for (first = 1; first <= N - M - 1; first += 1) if (at(first) < at(first + 1)) break;
  let last = N;
  for (last = N; last >= first + M; last -= 1) if (at(last - 1) < at(last)) break;
  let i = first;
  let dx = at(last) - at(first);
  let lo = first;
  let hi = last - M;
  for (let j = first; j <= last - M + 1; j += 1) {
    const d = at(j + M - 1) - at(j);
    if (d < dx) { i = j; dx = d; }
  }
  for (let j = i; j >= first; j -= 1) {
    if (at(j + M - 1) - at(j) > dx / width) { lo = j; break; }
  }
  for (let j = i; j <= last - M + 1; j += 1) {
    if (at(j + M - 1) - at(j) > dx / width) { hi = j; break; }
  }
  return { lo: at(lo + M2), hi: at(hi + M2) };
}

// The main particle population on forward and side scatter: positive events within R radii of
// the densest region of each log-scaled channel (flowQB's fitted_ellipse_gate). Returns the kept
// event indices (Uint32Array).
export function scatterGate(fsc, ssc, R = 2) {
  const n = fsc.length;
  const kept = [];
  for (let e = 0; e < n; e += 1) if (fsc[e] > 0 && ssc[e] > 0) kept.push(e);
  const r2 = new Float64Array(kept.length);
  for (const column of [fsc, ssc]) {
    const logs = Float64Array.from(kept, (e) => Math.log(column[e]));
    const { lo, hi } = findPeak(logs);
    const center = (hi + lo) / 2;
    const radius = (hi - lo) / 2;
    for (let k = 0; k < logs.length; k += 1) r2[k] += ((logs[k] - center) / radius) ** 2;
  }
  return Uint32Array.from(kept.filter((_, k) => r2[k] <= R * R));
}

// The intensity levels of a multi-level bead sample: k-means with `peaks` clusters on the
// logicle-scaled fluorescence channels together (each bead carries every level's dyes), after the
// scatter gate. columns: { name → Float32Array }; options: { channels, scatter: [fsc, ssc], peaks,
// range (for the logicle scale, default 262144), width (logicle W, default 1), seed }.
// Returns { events (the gated indices), labels (Int32Array: each gated event's peak, ordered by
// brightness) }.
export function findBeadPeaks(columns, options) {
  const { channels, peaks } = options;
  if (!(peaks >= 2)) throw new Error('Say how many intensity levels the beads have.');
  const [fscName, sscName] = options.scatter ?? [];
  const events = fscName && sscName && columns[fscName] && columns[sscName]
    ? scatterGate(columns[fscName], columns[sscName])
    : Uint32Array.from({ length: columns[channels[0]].length }, (_, i) => i);
  if (events.length < peaks * 20) throw new Error(`Only ${events.length} bead events passed the scatter gate.`);
  const logicle = createTransform({ type: 'logicle', T: options.range ?? 262144, W: options.width ?? 1, M: 4.5, A: 0 });
  const dim = channels.length;
  const data = new Float32Array(events.length * dim);
  for (let c = 0; c < dim; c += 1) {
    const column = columns[channels[c]];
    for (let k = 0; k < events.length; k += 1) data[k * dim + c] = logicle.forward(column[events[k]]);
  }
  const result = kmeans(data, events.length, dim, peaks, { seed: options.seed ?? 1, nInit: 10, algorithm: 'lloyd', maxIter: 500 });
  // Order the clusters by brightness (the sum of their centers).
  const brightness = Array.from({ length: peaks }, (_, p) => {
    let s = 0;
    for (let c = 0; c < dim; c += 1) s += result.centers[p * dim + c];
    return s;
  });
  const rank = new Int32Array(peaks);
  [...brightness.keys()].sort((a, b) => brightness[a] - brightness[b]).forEach((p, r) => { rank[p] = r; });
  return { events, labels: Int32Array.from(result.labels, (l) => rank[l]) };
}

// Statistics of each peak of one channel, with flowQB's rules for leaving peaks out: a mean
// outside the bounds, a zero SD, and for height signals a mean below 10× the lowest peak's or a
// CV above maximumCV. peaks: [Float32Array | number[]] (each peak's values), in any order.
// Returns rows sorted by mean: { peak (input index), n, mean, sd, v, w, omit, why }.
export function peakStatistics(peaks, options = {}) {
  const o = { ...QB_DEFAULTS, ...options, bounds: { ...QB_DEFAULTS.bounds, ...options.bounds } };
  const rows = peaks.map((values, peak) => {
    const { n, mean, sd } = robustNormal(values);
    const v = sd * sd;
    return { peak, n, mean, sd, v, w: (n - 1) / (2 * v * v), omit: false, why: '' };
  }).sort((a, b) => a.mean - b.mean);
  const lowest = rows[0]?.mean;
  for (const r of rows) {
    if (!Number.isFinite(r.mean) || !Number.isFinite(r.sd)) { r.omit = true; r.why = 'too few events'; continue; }
    if (o.height && r.mean < 10 * lowest) { r.omit = true; r.why = 'below 10× the lowest peak (height)'; continue; }
    if (r.mean > o.bounds.maximum) { r.omit = true; r.why = `above ${o.bounds.maximum}`; continue; }
    if (r.sd === 0) { r.omit = true; r.why = 'no spread'; continue; }
    if (r.mean < o.bounds.minimum) { r.omit = true; r.why = `below ${o.bounds.minimum}`; continue; }
    if (o.height && r.sd / r.mean > o.maximumCV) { r.omit = true; r.why = `CV above ${Math.round(100 * o.maximumCV)}% (height)`; }
  }
  return rows;
}

// --- The fit ----------------------------------------------------------------------------------

// Weighted least squares of y on the columns of X (rows of length p), as R's lm with weights:
// coefficients, their standard errors (residual variance × (XᵀWX)⁻¹) and two-sided p-values.
function wls(X, y, w) {
  const n = y.length;
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Float64Array(p));
  const b = new Float64Array(p);
  for (let i = 0; i < n; i += 1) {
    for (let r = 0; r < p; r += 1) {
      b[r] += w[i] * X[i][r] * y[i];
      for (let c = 0; c < p; c += 1) A[r][c] += w[i] * X[i][r] * X[i][c];
    }
  }
  const inv = invert(A);
  if (!inv) return null;
  const coef = Array.from({ length: p }, (_, r) => inv[r].reduce((s, a, c) => s + a * b[c], 0));
  const residuals = y.map((yi, i) => yi - X[i].reduce((s, x, c) => s + x * coef[c], 0));
  const df = n - p;
  const rss = residuals.reduce((s, r, i) => s + w[i] * r * r, 0);
  const sigma2 = df > 0 ? rss / df : Number.NaN;
  const se = coef.map((_, r) => Math.sqrt(sigma2 * inv[r][r]));
  const pValues = coef.map((c, r) => (df > 0 ? 2 * studentTSurvival(Math.abs(c / se[r]), df) : Number.NaN));
  return { coef, se, p: pValues, residuals, df };
}

function invert(A) {
  const n = A.length;
  const M = A.map((row, r) => [...row, ...Array.from({ length: n }, (_, c) => (r === c ? 1 : 0))]);
  for (let c = 0; c < n; c += 1) {
    let pivot = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (!(Math.abs(M[pivot][c]) > 0)) return null;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    const d = M[c][c];
    for (let k = 0; k < 2 * n; k += 1) M[c][k] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let k = 0; k < 2 * n; k += 1) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row.slice(n));
}

// Fits V = c0 + c1·M (+ c2·M²) to the peaks that are not left out, with iterated weights.
// rows: from peakStatistics. options: { model: 'quadratic' (default) | 'linear', iterations,
// tolerance, minimumPeaks }. Returns null when too few peaks remain, else { model, c: [c0, c1,
// c2], se, p, Q, B, CV0 (√c2, or NaN when c2 < 0), iterations, used, residuals (weighted, per
// row, null for rows left out), initial (the same before re-weighting) }.
export function fitQB(rows, options = {}) {
  const o = { ...QB_DEFAULTS, ...options };
  const quadratic = (o.model ?? 'quadratic') === 'quadratic';
  const used = rows.filter((r) => !r.omit);
  if (used.length < Math.max(o.minimumPeaks, quadratic ? 3 : 2)) return null;
  const X = used.map((r) => (quadratic ? [1, r.mean, r.mean * r.mean] : [1, r.mean]));
  const y = used.map((r) => r.v);
  let w = used.map((r) => r.w);
  const first = wls(X, y, w);
  if (!first) return null;
  let fit = first;
  let iterations = 0;
  for (let it = 1; it <= o.iterations; it += 1) {
    iterations = it;
    w = used.map((r, i) => {
      const v = X[i].reduce((s, x, c) => s + x * fit.coef[c], 0);
      return (r.n - 1) / (2 * v * v);
    });
    const next = wls(X, y, w);
    if (!next) break;
    const change = Math.max(...next.coef.map((c, k) => Math.abs((c - fit.coef[k]) / fit.coef[k])));
    fit = next;
    if (change < o.tolerance) break;
  }
  const [c0, c1, c2 = 0] = fit.coef;
  const weighted = (f, weights) => {
    const out = rows.map(() => null);
    used.forEach((r, i) => { out[rows.indexOf(r)] = f.residuals[i] * Math.sqrt(weights[i]); });
    return out;
  };
  return {
    model: quadratic ? 'quadratic' : 'linear',
    c: [c0, c1, quadratic ? c2 : 0],
    se: [...fit.se, ...(quadratic ? [] : [0])],
    p: [...fit.p, ...(quadratic ? [] : [Number.NaN])],
    Q: 1 / c1,
    B: c0 / (c1 * c1),
    CV0: quadratic && c2 >= 0 ? Math.sqrt(c2) : Number.NaN,
    iterations,
    used: used.length,
    residuals: weighted(fit, w),
    initial: { c: [...first.coef, ...(quadratic ? [] : [0])], se: [...first.se, ...(quadratic ? [] : [0])] },
  };
}

// Robust CV of a peak (as FlowJo documents its rCV): half the central 68.27% range over the median.
export function robustCV(values) {
  const x = Float64Array.from(values).sort();
  const q = (p) => {
    const at = p * (x.length - 1);
    const i = Math.floor(at);
    return i + 1 < x.length ? x[i] + (at - i) * (x[i + 1] - x[i]) : x[i];
  };
  const median = q(0.5);
  return { median, rcv: (q(0.841345) - q(0.158655)) / 2 / median };
}

// Characterizes the detectors of one run. peaksByChannel: { channel → [values of each peak] }
// (each peak's values, the same peaks for every channel). options: { height: (channel) →
// boolean, bounds, model }. Returns { channel → { peaks (rows), fit (quadratic), linear, bright
// ({ median, rcv } of the brightest peak kept) } }.
export function characterize(peaksByChannel, options = {}) {
  const out = {};
  for (const [channel, peaks] of Object.entries(peaksByChannel)) {
    const height = typeof options.height === 'function' ? options.height(channel) : /-H$/.test(channel);
    const rows = peakStatistics(peaks, { ...options, height });
    const kept = rows.filter((r) => !r.omit);
    const top = kept[kept.length - 1];
    out[channel] = {
      peaks: rows,
      fit: fitQB(rows, { ...options, model: 'quadratic' }),
      linear: fitQB(rows, { ...options, model: 'linear' }),
      bright: top ? robustCV(peaks[top.peak]) : null,
    };
  }
  return out;
}

// --- Levey–Jennings ---------------------------------------------------------------------------

// Westgard rules on a series of values against a baseline mean and SD. Returns, for each value,
// { z, rules: ['1-2s' | '1-3s' | '2-2s' | 'R-4s' | '4-1s' | '10x'] } and the overall { mean, sd,
// n (baseline runs) }. options.baseline: how many leading runs set the mean and SD (default: up
// to 20, and all when fewer).
export function leveyJennings(values, options = {}) {
  const finite = values.map((v) => (Number.isFinite(v) ? v : null));
  const usable = finite.filter((v) => v !== null);
  const nBase = Math.min(options.baseline ?? 20, usable.length);
  const base = usable.slice(0, nBase);
  const mean = base.reduce((s, v) => s + v, 0) / Math.max(1, base.length);
  const sd = base.length > 1 ? Math.sqrt(base.reduce((s, v) => s + (v - mean) ** 2, 0) / (base.length - 1)) : Number.NaN;
  const z = finite.map((v) => (v === null || !(sd > 0) ? null : (v - mean) / sd));
  const flags = z.map((zi, i) => {
    const rules = [];
    if (zi === null) return { z: null, rules };
    const prev = (k) => {
      const out = [];
      for (let j = i; j >= 0 && out.length < k; j -= 1) if (z[j] !== null) out.push(z[j]);
      return out.length === k ? out : null;
    };
    if (Math.abs(zi) > 3) rules.push('1-3s');
    else if (Math.abs(zi) > 2) rules.push('1-2s');
    const two = prev(2);
    if (two && two.every((x) => x > 2) || two && two.every((x) => x < -2)) rules.push('2-2s');
    if (two && Math.abs(two[0] - two[1]) > 4 && Math.sign(two[0]) !== Math.sign(two[1])) rules.push('R-4s');
    const four = prev(4);
    if (four && (four.every((x) => x > 1) || four.every((x) => x < -1))) rules.push('4-1s');
    const ten = prev(10);
    if (ten && (ten.every((x) => x > 0) || ten.every((x) => x < 0))) rules.push('10x');
    return { z: zi, rules };
  });
  return { mean, sd, n: base.length, flags };
}

// Rules that reject a run (the others warn).
export const REJECT_RULES = new Set(['1-3s', '2-2s', 'R-4s', '4-1s', '10x']);
