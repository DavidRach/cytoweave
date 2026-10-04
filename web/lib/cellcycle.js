// DNA-content histogram (cell-cycle) modeling of a single population.
//
// Input values are a linear DNA-dye parameter (PI-A, DAPI-A, DRAQ5-A, …) of singlet nuclei or
// cells. Two classical models are provided:
//   - Dean–Jett–Fox (Fox 1980, Cytometry 1:71–77, doi:10.1002/cyto.990010103): G1 and G2/M
//     Gaussians plus S phase as a second-order polynomial between the G1 and G2 means, broadened
//     by a Gaussian whose SD changes linearly from the G1 to the G2 SD; optional debris
//     (exponential decay) and aggregate (G1+G2 and G2+G2 doublet) components.
//   - Watson pragmatic (Watson, Chambers & Smith 1987, Cytometry 8:1–8,
//     doi:10.1002/cyto.990080101): Gaussians fitted to the outer flanks only (left of the G1
//     peak, right of the G2 peak); S phase is the remainder between them.
// Both return { percentG1, percentS, percentG2, g1, g2, s, g2g1Ratio, chiSquare,
// reducedChiSquare, rmsd, x, curves: { total, g1, s, g2, debris?, aggregates? }, warnings, … }.
// Phase percentages exclude debris and aggregates, as ModFit and FlowJo report them.

import { addGaussianBins, fitLeastSquares, normalCdfFast, smoothCounts } from './fit.js';
import { gather, quantileSorted } from './stats.js';

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const FWHM_TO_SD = 1 / Math.sqrt(2 * Math.log(2)); // HWHM → SD

// Histogram of linear DNA values. Options: bins (256), range [min, max] (default 0 to 1.1 × the
// 99.9th percentile, so G2 and some aggregates are included), indices (population).
// Returns { counts, centers, min, max, binWidth, bins, total, underflow, overflow }.
export function dnaHistogram(values, options = {}) {
  const bins = options.bins ?? 256;
  const data = gather(values, options.indices ?? null);
  if (!data.length) throw new Error('The population has no events with DNA values.');
  const min = options.range?.[0] ?? options.min ?? 0;
  let max = options.range?.[1] ?? options.max;
  if (max === undefined) max = 1.1 * quantileSorted(data.slice().sort(), 0.999);
  if (!(max > min)) throw new Error('The DNA histogram range is empty; check the channel and population.');
  const binWidth = (max - min) / bins;
  const counts = new Float64Array(bins);
  let underflow = 0;
  let overflow = 0;
  for (let i = 0; i < data.length; i += 1) {
    const b = Math.floor((data[i] - min) / binWidth);
    if (b < 0) underflow += 1;
    else if (b >= bins) overflow += 1;
    else counts[b] += 1;
  }
  const centers = new Float64Array(bins);
  for (let b = 0; b < bins; b += 1) centers[b] = min + (b + 0.5) * binWidth;
  return { counts, centers, min, max, binWidth, bins, total: data.length - underflow - overflow, underflow, overflow };
}

function normalizeHistogram(h) {
  const counts = h.counts;
  const bins = counts.length;
  let { min, max, binWidth, centers } = h;
  if (binWidth === undefined) {
    if (min !== undefined && max !== undefined) binWidth = (max - min) / bins;
    else if (centers) binWidth = centers[1] - centers[0];
    else throw new Error('A histogram needs counts plus min/max or centers.');
  }
  if (min === undefined) min = centers[0] - binWidth / 2;
  if (max === undefined) max = min + bins * binWidth;
  if (!centers) centers = Float64Array.from({ length: bins }, (_, b) => min + (b + 0.5) * binWidth);
  return { counts, centers, min, max, binWidth, bins };
}

function parabolicPeak(s, i) {
  if (i <= 0 || i >= s.length - 1) return 0;
  const d = s[i - 1] - 2 * s[i] + s[i + 1];
  return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (s[i - 1] - s[i + 1])) / d)) : 0;
}

// SD from the half-maximum crossing on one side (direction −1 left, +1 right) of peak bin i,
// corrected for the smoothing kernel.
function flankSD(s, i, binWidth, direction, smoothing) {
  const half = s[i] / 2;
  let j = i;
  while (j + direction >= 0 && j + direction < s.length && s[j] > half) j += direction;
  const a = s[j - direction];
  const b = s[j];
  const frac = a !== b ? (a - half) / (a - b) : 0.5;
  const hwhm = (Math.abs(j - direction - i) + frac) * binWidth;
  const sdObserved = hwhm * FWHM_TO_SD;
  const sdKernel = smoothing * binWidth;
  return Math.sqrt(Math.max(sdObserved * sdObserved - sdKernel * sdKernel, (0.5 * binWidth) ** 2));
}

// Finds the G1 peak (the tallest, unless a substantial peak sits at about half its position, in
// which case the tallest is a G2 peak, e.g. after G2/M arrest) and the G2 candidate near twice the
// G1 position. Options: smoothing (SD in bins, default bins/256 ≥ 1), skipBins (low-end bins
// ignored for debris/zero pile-up, default 3% of bins). Returns { g1, g2 | null, peaks } with
// { bin, position, height, sd } entries (height in counts per bin of the smoothed histogram).
export function autoPeaks(histogram, options = {}) {
  const h = normalizeHistogram(histogram);
  const { centers, binWidth } = h;
  const nb = h.counts.length;
  const smoothing = options.smoothing ?? Math.max(1, nb / 256);
  const s = smoothCounts(h.counts, smoothing);
  const skip = options.skipBins ?? Math.max(2, Math.round(nb * 0.03));
  const maxima = [];
  for (let i = Math.max(1, skip); i < nb - 1; i += 1) if (s[i] > 0 && s[i] >= s[i - 1] && s[i] > s[i + 1]) maxima.push(i);
  if (!maxima.length) throw new Error('No peak was found in the DNA histogram; check the channel, gate and range.');
  let top = maxima[0];
  for (const i of maxima) if (s[i] > s[top]) top = i;
  let g1 = top;
  for (const i of maxima) {
    if (centers[i] > 0.42 * centers[top] && centers[i] < 0.58 * centers[top] && s[i] >= 0.15 * s[top]) {
      if (g1 === top || s[i] > s[g1]) g1 = i;
    }
  }
  const describe = (i, direction) => ({
    bin: i,
    position: centers[i] + parabolicPeak(s, i) * binWidth,
    height: s[i],
    sd: flankSD(s, i, binWidth, direction, smoothing),
  });
  const peak1 = describe(g1, -1);
  let g2 = null;
  for (const i of maxima) {
    if (centers[i] >= 1.7 * peak1.position && centers[i] <= 2.3 * peak1.position && s[i] >= 0.01 * s[g1]) {
      if (g2 === null || s[i] > s[g2]) g2 = i;
    }
  }
  return {
    g1: peak1,
    g2: g2 === null ? null : describe(g2, 1),
    peaks: maxima.map((i) => ({ bin: i, position: centers[i], height: s[i] })),
  };
}

// --- Dean–Jett–Fox ------------------------------------------------------------------------------

// Adds the broadened S-phase polynomial to `out`: Bernstein form s(t) = b0(1−t)² + 2b1 t(1−t) +
// b2 t², t = (u − μ1)/(μ2 − μ1), in counts per bin width, integrated over u ∈ [μ1, μ2] with a
// Gaussian of SD interpolated linearly from sd1 to sd2 (Fox 1980). Non-negative b keeps the
// S-phase density non-negative everywhere.
function addSPhase(out, edge0, bw, mu1, mu2, sd1, sd2, b0, b1, b2, from, to) {
  const span = mu2 - mu1;
  if (!(span > 0)) return;
  const steps = Math.max(32, Math.min(512, Math.ceil((2 * span) / bw)));
  const du = span / steps;
  for (let k = 0; k < steps; k += 1) {
    const t = (k + 0.5) / steps;
    const density = b0 * (1 - t) * (1 - t) + 2 * b1 * t * (1 - t) + b2 * t * t;
    if (!(density > 0)) continue;
    addGaussianBins(out, edge0, bw, (density * du) / bw, mu1 + t * span, sd1 + t * (sd2 - sd1), from, to);
  }
}

// Dean–Jett–Fox fit. Options:
//   ratio        fixed G2/G1 mean ratio (default free within ratioBounds [1.6, 2.4])
//   equalCV      G2 CV = G1 CV (default true; false fits a separate G2 CV)
//   cv           fixed G1 (and G2) CV, as a fraction (e.g. 0.04)
//   debris       add an exponential debris component (default false)
//   aggregates   add G1+G2 and G2+G2 doublet peaks (default false)
//   fitRange     [lo, hi] in data units (default G1 − 4.5 SD … G2 + 4.5 SD, widened for
//                debris/aggregates)
//   peaks        result of autoPeaks() to start from (default computed)
export function fitDeanJettFox(histogram, options = {}) {
  const h = normalizeHistogram(histogram);
  const { counts, binWidth: bw, min: edge0 } = h;
  const nb = counts.length;
  const peaks = options.peaks ?? autoPeaks(h, options);
  const smooth = smoothCounts(counts, Math.max(1, nb / 256));
  const ratioFixed = typeof options.ratio === 'number';
  const [ratioLo, ratioHi] = options.ratioBounds ?? [1.6, 2.4];
  const equalCV = options.equalCV ?? true;
  const cvFixed = typeof options.cv === 'number';
  const debris = Boolean(options.debris);
  const aggregates = Boolean(options.aggregates);

  const mu1 = peaks.g1.position;
  const cv1 = cvFixed ? options.cv : Math.min(0.15, Math.max(0.01, peaks.g1.sd / mu1));
  let ratio = ratioFixed ? options.ratio : peaks.g2 ? peaks.g2.position / mu1 : 2;
  ratio = ratioFixed ? ratio : Math.min(ratioHi, Math.max(ratioLo, ratio));
  const mu2 = ratio * mu1;
  const sd1 = cv1 * mu1;
  const sd2 = cv1 * mu2;

  // Parameter layout.
  const names = ['g1Area', 'g1Mean', 'g1CV', 'g2Area', 'ratio'];
  if (!equalCV) names.push('g2CV');
  names.push('s0', 's1', 's2');
  if (debris) names.push('debrisAmplitude', 'debrisDecay');
  if (aggregates) names.push('aggregate3', 'aggregate4');
  const at = Object.fromEntries(names.map((n, i) => [n, i]));

  // Fit window.
  let lo = mu1 - 4.5 * sd1;
  let hi = mu2 + 4.5 * sd2;
  if (debris) lo = edge0 + Math.max(2, Math.round(0.02 * nb)) * bw;
  if (aggregates) hi = Math.min(edge0 + nb * bw, 2 * mu2 + 4.5 * Math.SQRT2 * sd2);
  if (options.fitRange) [lo, hi] = options.fitRange;
  const first = Math.max(0, Math.floor((lo - edge0) / bw));
  const last = Math.min(nb - 1, Math.ceil((hi - edge0) / bw) - 1);
  if (last - first < names.length + 3) throw new Error('Too few histogram bins in the fit range; use more bins or a wider range.');
  const fitN = last - first + 1;
  const xLow = edge0 + first * bw;

  // Starting values from the smoothed histogram.
  const binAt = (x) => Math.max(0, Math.min(nb - 1, Math.floor((x - edge0) / bw)));
  const between = [];
  for (let b = binAt(mu1 + 2.5 * sd1); b <= binAt(mu2 - 2.5 * sd2); b += 1) between.push(smooth[b]);
  between.sort((a, b) => a - b);
  const sLevel = between.length ? between[between.length >> 1] : 0.05 * peaks.g1.height;
  const p0 = new Float64Array(names.length);
  p0[at.g1Area] = Math.max(1, peaks.g1.height - sLevel / 2) * (sd1 / bw) * SQRT_2PI;
  p0[at.g1Mean] = mu1;
  p0[at.g1CV] = cv1;
  const h2 = peaks.g2 ? peaks.g2.height : smooth[binAt(mu2)];
  p0[at.g2Area] = Math.max(0.02 * p0[at.g1Area], (h2 - sLevel / 2) * (sd2 / bw) * SQRT_2PI);
  p0[at.ratio] = ratio;
  if (!equalCV) p0[at.g2CV] = cv1;
  p0[at.s0] = sLevel;
  p0[at.s1] = sLevel;
  p0[at.s2] = sLevel;
  if (debris) {
    p0[at.debrisAmplitude] = Math.max(1, smooth[first]);
    p0[at.debrisDecay] = 0.3;
  }
  if (aggregates) {
    p0[at.aggregate3] = Math.max(1, smooth[binAt(mu1 + mu2)] * (Math.hypot(sd1, sd2) / bw) * SQRT_2PI * 0.5);
    p0[at.aggregate4] = Math.max(1, smooth[binAt(2 * mu2)] * ((Math.SQRT2 * sd2) / bw) * SQRT_2PI * 0.5);
  }
  const lower = new Array(names.length).fill(0);
  const upper = new Array(names.length).fill(null);
  lower[at.g1Mean] = 0.85 * mu1;
  upper[at.g1Mean] = 1.15 * mu1;
  lower[at.g1CV] = 0.005;
  upper[at.g1CV] = 0.25;
  lower[at.ratio] = ratioLo;
  upper[at.ratio] = ratioHi;
  if (!equalCV) {
    lower[at.g2CV] = 0.005;
    upper[at.g2CV] = 0.25;
  }
  if (debris) {
    lower[at.debrisDecay] = 0.01;
    upper[at.debrisDecay] = 5;
  }
  const fixed = new Array(names.length).fill(false);
  if (ratioFixed) fixed[at.ratio] = true;
  if (cvFixed) {
    fixed[at.g1CV] = true;
    if (!equalCV) {
      fixed[at.g2CV] = true;
      p0[at.g2CV] = options.cv;
    }
  }

  const components = (p, from, to) => {
    const m1 = p[at.g1Mean];
    const m2 = p[at.ratio] * m1;
    const s1 = p[at.g1CV] * m1;
    const s2 = (equalCV ? p[at.g1CV] : p[at.g2CV]) * m2;
    const g1 = new Float64Array(nb);
    const g2 = new Float64Array(nb);
    const sPhase = new Float64Array(nb);
    addGaussianBins(g1, edge0, bw, p[at.g1Area], m1, s1, from, to);
    addGaussianBins(g2, edge0, bw, p[at.g2Area], m2, s2, from, to);
    addSPhase(sPhase, edge0, bw, m1, m2, s1, s2, p[at.s0], p[at.s1], p[at.s2], from, to);
    const out = { g1, g2, s: sPhase };
    if (debris) {
      const d = new Float64Array(nb);
      const scale = p[at.debrisDecay] * m1;
      for (let b = from; b < to; b += 1) d[b] = p[at.debrisAmplitude] * Math.exp(-(edge0 + (b + 0.5) * bw - xLow) / scale);
      out.debris = d;
    }
    if (aggregates) {
      const a = new Float64Array(nb);
      addGaussianBins(a, edge0, bw, p[at.aggregate3], m1 + m2, Math.hypot(s1, s2), from, to);
      addGaussianBins(a, edge0, bw, p[at.aggregate4], 2 * m2, Math.SQRT2 * s2, from, to);
      out.aggregates = a;
    }
    return out;
  };
  const model = (p, out) => {
    const c = components(p, first, last + 1);
    for (let i = 0; i < fitN; i += 1) {
      const b = first + i;
      let v = c.g1[b] + c.g2[b] + c.s[b];
      if (c.debris) v += c.debris[b];
      if (c.aggregates) v += c.aggregates[b];
      out[i] = v;
    }
    return out;
  };
  const y = counts.slice(first, last + 1);
  // Poisson weights (Neyman χ²): Var(count) ≈ max(count, 1).
  const weights = Float64Array.from(y, (v) => 1 / Math.max(v, 1));
  const fit = fitLeastSquares(model, p0, y, {
    weights, lower, upper, fixed, absoluteSigma: true, signal: options.signal, maxIterations: options.maxIterations ?? 300,
  });
  const p = fit.params;
  const curves = components(p, 0, nb);
  const m1 = p[at.g1Mean];
  const m2 = p[at.ratio] * m1;
  const cvG1 = p[at.g1CV];
  const cvG2 = equalCV ? cvG1 : p[at.g2CV];
  const areaS = (q) => (((q[at.ratio] - 1) * q[at.g1Mean]) / bw) * ((q[at.s0] + q[at.s1] + q[at.s2]) / 3);
  const percents = (q) => {
    const a1 = q[at.g1Area];
    const a2 = q[at.g2Area];
    const as = areaS(q);
    const total = a1 + a2 + as;
    return [(100 * a1) / total, (100 * as) / total, (100 * a2) / total];
  };
  const pct = percents(p);
  const pctSE = propagate(percents, p, fit.covariance, names.length);
  const total = new Float64Array(nb);
  for (let b = 0; b < nb; b += 1) {
    total[b] = curves.g1[b] + curves.g2[b] + curves.s[b] + (curves.debris ? curves.debris[b] : 0) + (curves.aggregates ? curves.aggregates[b] : 0);
  }
  let sq = 0;
  for (let i = 0; i < fitN; i += 1) sq += fit.residuals[i] ** 2;
  const parameters = {};
  const standardErrors = {};
  names.forEach((n, i) => {
    parameters[n] = p[i];
    standardErrors[n] = fit.standardErrors[i];
  });
  const counted = sumRange(counts, first, last + 1);
  const result = {
    model: 'dean-jett-fox',
    percentG1: pct[0],
    percentS: pct[1],
    percentG2: pct[2],
    percentSE: { g1: pctSE[0], s: pctSE[1], g2: pctSE[2] },
    g1: { mean: m1, cv: cvG1, sd: cvG1 * m1, area: p[at.g1Area] },
    s: { area: areaS(p), coefficients: [p[at.s0], p[at.s1], p[at.s2]] },
    g2: { mean: m2, cv: cvG2, sd: cvG2 * m2, area: p[at.g2Area] },
    g2g1Ratio: p[at.ratio],
    debris: debris ? { area: sumRange(curves.debris, first, last + 1), percent: (100 * sumRange(curves.debris, first, last + 1)) / counted } : null,
    aggregates: aggregates ? { area: p[at.aggregate3] + p[at.aggregate4], percent: (100 * (p[at.aggregate3] + p[at.aggregate4])) / counted } : null,
    chiSquare: fit.chiSquare,
    reducedChiSquare: fit.reducedChiSquare,
    dof: fit.dof,
    rmsd: Math.sqrt(sq / fitN),
    fitRange: [edge0 + first * bw, edge0 + (last + 1) * bw],
    fitBins: [first, last],
    x: h.centers,
    curves: { total, ...curves },
    parameters,
    standardErrors,
    converged: fit.converged,
    iterations: fit.iterations,
    method: fit.method,
  };
  result.warnings = cellCycleWarnings(result, { ratioFixed, ratioAtBound: !ratioFixed && fit.atBound[at.ratio], g2Found: Boolean(peaks.g2) });
  return result;
}

function sumRange(array, from, to) {
  let s = 0;
  for (let i = from; i < to; i += 1) s += array[i];
  return s;
}

// Standard errors of f(p) (a vector function) by the delta method with a numerical gradient.
function propagate(f, p, covariance, m) {
  const base = f(p);
  const k = base.length;
  const grads = Array.from({ length: k }, () => new Float64Array(m));
  const q = Float64Array.from(p);
  for (let j = 0; j < m; j += 1) {
    if (!(covariance[j * m + j] > 0)) continue;
    const step = 1e-6 * Math.max(Math.abs(p[j]), Math.sqrt(covariance[j * m + j]));
    q[j] = p[j] + step;
    const fv = f(q);
    q[j] = p[j];
    for (let r = 0; r < k; r += 1) grads[r][j] = (fv[r] - base[r]) / step;
  }
  return grads.map((g) => {
    let v = 0;
    for (let a = 0; a < m; a += 1) {
      if (!g[a]) continue;
      for (let b = 0; b < m; b += 1) if (g[b]) v += g[a] * covariance[a * m + b] * g[b];
    }
    return Math.sqrt(Math.max(0, v));
  });
}

function cellCycleWarnings(result, context) {
  const warnings = [];
  if (result.g1.cv > 0.08) {
    warnings.push(`G1 CV is ${(100 * result.g1.cv).toFixed(1)}% (above 8%): resolution is poor and phase fractions are unreliable.`);
  }
  if (!context.g2Found && !context.ratioFixed) warnings.push('No G2 peak was found near twice the G1 position; G2 was placed at the assumed ratio.');
  if (context.ratioAtBound) warnings.push(`The G2/G1 ratio ran to its limit (${result.g2g1Ratio.toFixed(2)}); fix the ratio (e.g. 2.0) or check the peaks.`);
  else if (result.g2g1Ratio < 1.9 || result.g2g1Ratio > 2.1) warnings.push(`The G2/G1 ratio is ${result.g2g1Ratio.toFixed(2)}, outside the usual 1.9–2.1 (dye saturation, nonlinearity or a misidentified peak).`);
  if (result.reducedChiSquare > 3) warnings.push(`Poor fit: reduced χ² = ${result.reducedChiSquare.toFixed(1)} (above 3). Consider debris, aggregates or doublet gating.`);
  if (!result.converged) warnings.push('The fit did not converge; results may be unreliable.');
  return warnings;
}

// --- Watson pragmatic -----------------------------------------------------------------------------

// Fits one Gaussian peak to a flank of the histogram. `stepLevel` adds the broadened edge of a
// flat S-phase plateau (direction +1: plateau above the mean, −1: below), which otherwise leaks
// into the flank and inflates the peak area.
function fitFlank(counts, edge0, bw, from, to, start, options) {
  const { stepLevel = 0, stepDirection = 1, fixedMean = null, cvFrom = null } = options;
  const n = to - from;
  const y = counts.slice(from, to);
  const weights = Float64Array.from(y, (v) => 1 / Math.max(v, 1));
  const centersOf = (i) => edge0 + (from + i + 0.5) * bw;
  // Parameters: area, mean, sd (mean fixed when the ratio is fixed; sd tied when cvFrom given).
  const model = (p, out) => {
    out.fill(0);
    const mean = fixedMean ?? p[1];
    const sd = cvFrom !== null ? cvFrom * mean : p[2];
    const shifted = new Float64Array(counts.length);
    addGaussianBins(shifted, edge0, bw, p[0], mean, sd, from, to);
    for (let i = 0; i < n; i += 1) {
      const x = centersOf(i);
      out[i] = shifted[from + i] + stepLevel * normalCdfFast((stepDirection * (x - mean)) / sd);
    }
    return out;
  };
  const fixed = [false, fixedMean !== null, cvFrom !== null];
  const p0 = [start.area, fixedMean ?? start.mean, start.sd];
  const fit = fitLeastSquares(model, p0, y, {
    weights, fixed, absoluteSigma: true,
    lower: [0, start.mean - 3 * start.sd, 0.2 * bw],
    upper: [null, start.mean + 3 * start.sd, 4 * start.sd],
  });
  const mean = fixedMean ?? fit.params[1];
  return { area: fit.params[0], mean, sd: cvFrom !== null ? cvFrom * mean : fit.params[2], fit, n };
}

// Watson pragmatic fit. Options: ratio (fixed G2/G1 ratio), equalCV (default true: the G2 SD is
// G1 CV × G2 mean), flankCorrection (default true: the broadened edge of the S-phase plateau is
// modeled inside each flank window, its level taken from a straight line through the residual
// S region and extrapolated to each mean, and the windows extend 1 SD past each mean; without it
// — Watson's original outer-half fits — S cells near G2 inflate the G2 area by ~3 points at 4% CV),
// peaks.
export function fitWatsonPragmatic(histogram, options = {}) {
  const h = normalizeHistogram(histogram);
  const { counts, binWidth: bw, min: edge0, centers } = h;
  const nb = counts.length;
  const peaks = options.peaks ?? autoPeaks(h, options);
  const equalCV = options.equalCV ?? true;
  const ratioFixed = typeof options.ratio === 'number';
  const flankCorrection = options.flankCorrection ?? true;
  const binAt = (x) => Math.max(0, Math.min(nb - 1, Math.floor((x - edge0) / bw)));
  const g1Start = { mean: peaks.g1.position, sd: peaks.g1.sd };
  g1Start.area = peaks.g1.height * (g1Start.sd / bw) * SQRT_2PI;
  const mu2Start = ratioFixed ? options.ratio * g1Start.mean : peaks.g2 ? peaks.g2.position : 2 * g1Start.mean;
  const g2Start = { mean: mu2Start, sd: peaks.g2 ? peaks.g2.sd : (g1Start.sd * mu2Start) / g1Start.mean };
  g2Start.area = Math.max(1, (peaks.g2 ? peaks.g2.height : counts[binAt(mu2Start)]) * (g2Start.sd / bw) * SQRT_2PI);

  let sLeft = 0;
  let sRight = 0;
  let g1;
  let g2;
  // Flank windows: from 4 SD outside each peak to `inner` SD past its mean (Watson et al. use
  // the outer half; with the S-phase edge modeled, a little of the inner side pins the mean).
  const inner = flankCorrection ? 1 : 0;
  const rounds = flankCorrection ? 3 : 1;
  for (let round = 0; round < rounds; round += 1) {
    const mean1 = g1 ? g1.mean : g1Start.mean;
    const sd1 = g1 ? g1.sd : g1Start.sd;
    const from1 = binAt(mean1 - 4 * sd1);
    const to1 = binAt(mean1 + inner * sd1) + 1;
    g1 = fitFlank(counts, edge0, bw, from1, to1, g1 ?? g1Start, { stepLevel: sLeft, stepDirection: 1 });
    const cv = g1.sd / g1.mean;
    const fixedMean = ratioFixed ? options.ratio * g1.mean : null;
    const mean2 = fixedMean ?? (g2 ? g2.mean : g2Start.mean);
    const sd2 = equalCV ? cv * mean2 : g2 ? g2.sd : g2Start.sd;
    const from2 = binAt(mean2 - inner * sd2);
    const to2 = Math.min(nb, binAt(mean2 + 4 * sd2) + 1);
    const start2 = g2 ?? { ...g2Start, sd: sd2 };
    g2 = fitFlank(counts, edge0, bw, from2, to2, start2, { stepLevel: sRight, stepDirection: -1, fixedMean, cvFrom: equalCV ? cv : null });
    if (!flankCorrection) break;
    // S-phase level at each peak: a straight line fitted to the residual (counts − G1 − G2) over
    // the S region clear of both peaks, extrapolated to the two means.
    const g = new Float64Array(nb);
    addGaussianBins(g, edge0, bw, g1.area, g1.mean, g1.sd);
    addGaussianBins(g, edge0, bw, g2.area, g2.mean, g2.sd);
    const a = binAt(g1.mean + 3 * g1.sd);
    const b = binAt(g2.mean - 3 * g2.sd);
    if (b - a < 3) break;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let k = a; k <= b; k += 1) {
      const x = centers[k];
      const r = counts[k] - g[k];
      n += 1;
      sx += x;
      sy += r;
      sxx += x * x;
      sxy += x * r;
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    sLeft = Math.max(0, intercept + slope * g1.mean);
    sRight = Math.max(0, intercept + slope * g2.mean);
  }

  const g1Curve = new Float64Array(nb);
  const g2Curve = new Float64Array(nb);
  addGaussianBins(g1Curve, edge0, bw, g1.area, g1.mean, g1.sd);
  addGaussianBins(g2Curve, edge0, bw, g2.area, g2.mean, g2.sd);
  const rFrom = binAt(g1.mean - 4 * g1.sd);
  const rTo = binAt(g2.mean + 4 * g2.sd);
  let inRegion = 0;
  let a1 = 0;
  let a2 = 0;
  const sCurve = new Float64Array(nb);
  for (let b = rFrom; b <= rTo; b += 1) {
    inRegion += counts[b];
    a1 += g1Curve[b];
    a2 += g2Curve[b];
    if (centers[b] > g1.mean - 2 * g1.sd && centers[b] < g2.mean + 2 * g2.sd) sCurve[b] = Math.max(0, counts[b] - g1Curve[b] - g2Curve[b]);
  }
  const sArea = Math.max(0, inRegion - a1 - a2);
  const totalArea = a1 + a2 + sArea;
  const total = new Float64Array(nb);
  for (let b = 0; b < nb; b += 1) total[b] = g1Curve[b] + g2Curve[b] + sCurve[b];
  const chiSquare = g1.fit.chiSquare + g2.fit.chiSquare;
  const dof = g1.fit.dof + g2.fit.dof;
  let sq = 0;
  for (const r of g1.fit.residuals) sq += r * r;
  for (const r of g2.fit.residuals) sq += r * r;
  const result = {
    model: 'watson-pragmatic',
    percentG1: (100 * a1) / totalArea,
    percentS: (100 * sArea) / totalArea,
    percentG2: (100 * a2) / totalArea,
    g1: { mean: g1.mean, cv: g1.sd / g1.mean, sd: g1.sd, area: a1 },
    s: { area: sArea, edgeLevels: [sLeft, sRight] },
    g2: { mean: g2.mean, cv: g2.sd / g2.mean, sd: g2.sd, area: a2 },
    g2g1Ratio: g2.mean / g1.mean,
    chiSquare,
    reducedChiSquare: dof > 0 ? chiSquare / dof : Number.NaN,
    dof,
    rmsd: Math.sqrt(sq / (g1.n + g2.n)),
    fitRange: [edge0 + rFrom * bw, edge0 + (rTo + 1) * bw],
    fitBins: [rFrom, rTo],
    x: centers,
    curves: { total, g1: g1Curve, s: sCurve, g2: g2Curve },
    converged: g1.fit.converged && g2.fit.converged,
  };
  result.warnings = cellCycleWarnings(result, { ratioFixed, ratioAtBound: false, g2Found: Boolean(peaks.g2) });
  return result;
}

// --- Doublet discrimination ------------------------------------------------------------------------

// Suggests a singlet gate on DNA area (x) vs pulse width (y): singlets have a width that rises
// only slowly with DNA content, doublets have a larger width at the same area. A line is fitted
// through the median widths of area deciles 2–8 (Theil–Sen on the decile medians, so G2 cells and
// doublets at high area do not tilt it); the gate keeps events within k robust SDs of it, up to
// 1.05 × the 99.5th percentile of the in-band areas.
// Options: indices, k (3), maxEvents (100000, deterministic stride subsample).
// Returns { vertices (polygon in data space, [area, width] pairs), slope, intercept, halfWidth,
// singletFraction }.
export function doubletDiscrimination(area, width, options = {}) {
  const k = options.k ?? 3;
  const indices = options.indices ?? null;
  const total = indices ? indices.length : area.length;
  const stride = Math.max(1, Math.floor(total / (options.maxEvents ?? 100000)));
  const xs = [];
  const ys = [];
  for (let i = 0; i < total; i += stride) {
    const e = indices ? indices[i] : i;
    if (Number.isFinite(area[e]) && Number.isFinite(width[e])) {
      xs.push(area[e]);
      ys.push(width[e]);
    }
  }
  if (xs.length < 50) throw new Error('Too few events to suggest a doublet gate.');
  const order = Array.from(xs.keys()).sort((a, b) => xs[a] - xs[b]);
  const deciles = [];
  for (let d = 1; d < 8; d += 1) {
    const from = Math.floor((d * order.length) / 10);
    const to = Math.floor(((d + 1) * order.length) / 10);
    const ax = Float64Array.from(order.slice(from, to), (i) => xs[i]).sort();
    const wy = Float64Array.from(order.slice(from, to), (i) => ys[i]).sort();
    deciles.push([quantileSorted(ax, 0.5), quantileSorted(wy, 0.5)]);
  }
  const slopes = [];
  for (let a = 0; a < deciles.length; a += 1) {
    for (let b = a + 1; b < deciles.length; b += 1) {
      if (deciles[b][0] > deciles[a][0]) slopes.push((deciles[b][1] - deciles[a][1]) / (deciles[b][0] - deciles[a][0]));
    }
  }
  const slope = slopes.length ? quantileSorted(Float64Array.from(slopes).sort(), 0.5) : 0;
  const intercept = quantileSorted(Float64Array.from(deciles, ([x, y]) => y - slope * x).sort(), 0.5);
  const core = [];
  const lo = Math.floor(0.1 * order.length);
  const hi = Math.floor(0.8 * order.length);
  for (let r = lo; r < hi; r += 1) core.push(ys[order[r]] - (intercept + slope * xs[order[r]]));
  const residuals = Float64Array.from(core).sort();
  const rsd = (quantileSorted(residuals, 0.8413) - quantileSorted(residuals, 0.1587)) / 2;
  const halfWidth = k * rsd;
  const line = (x) => intercept + slope * x;
  // Area extent: up to just past the singlet candidates (events inside the band), so the band is
  // not extrapolated into the high-area region where G2+G2 doublets dominate.
  const candidates = [];
  for (let i = 0; i < xs.length; i += 1) if (Math.abs(ys[i] - line(xs[i])) <= halfWidth) candidates.push(xs[i]);
  const sortedX = Float64Array.from(candidates.length ? candidates : xs).sort();
  const x0 = Math.min(0, sortedX[0]);
  const x1 = 1.05 * quantileSorted(sortedX, 0.995);
  const vertices = [[x0, line(x0) - halfWidth], [x1, line(x1) - halfWidth], [x1, line(x1) + halfWidth], [x0, line(x0) + halfWidth]];
  let inside = 0;
  for (let i = 0; i < xs.length; i += 1) if (xs[i] <= x1 && Math.abs(ys[i] - line(xs[i])) <= halfWidth) inside += 1;
  return { vertices, slope, intercept, halfWidth, singletFraction: inside / xs.length };
}
