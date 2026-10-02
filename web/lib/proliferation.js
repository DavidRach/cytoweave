// Dye-dilution proliferation modelling (CFSE, CellTrace Violet, …), after FlowJo's proliferation
// platform and Roederer 2011 ("Interpretation of cellular proliferation data: avoid the
// panglossian", Cytometry A 79:95–101, doi:10.1002/cyto.a.21010).
//
// Each division halves the dye per cell, so generation g sits at peak₀ / ratio^(g·r) (ratio = 2,
// r ≈ 1 fitted to absorb dye loss or compensation effects). On a log10 (or logicle) scale the
// generations are a mixture of Gaussians with equally spaced means and a shared width (a shared
// CV in linear units) and free non-negative weights, fitted to the histogram by Levenberg–
// Marquardt. Events are then assigned to generations by posterior probability.

import { addGaussianBins, cholesky, choleskySolve, fitLeastSquares, smoothCounts } from './fit.js';
import { gather, quantileSorted } from './stats.js';
import { createTransform } from './transforms.js';

// Indices from cell counts per generation (index 0 = undivided). With precursor frequencies
// Pg = Ng / 2^g (the number of starting cells that gave rise to generation g):
//   divisionIndex      Σ g·Pg / Σ Pg            average divisions of all original cells,
//                                              including those that never divided
//   proliferationIndex Σ g·Pg / Σ_{g≥1} Pg      total divisions / cells that divided at least once
//   expansionIndex     Σ Ng / Σ Pg              fold expansion of the whole culture
//   replicationIndex   Σ_{g≥1} Ng / Σ_{g≥1} Pg  fold expansion of the responding cells
//   percentDivided     100·Σ_{g≥1} Pg / Σ Pg    % of original cells that divided (assumes no death)
// (FlowJo proliferation-platform definitions; Roederer 2011.) Indices that need dividing cells
// are NaN when none divided.
export function proliferationIndices(counts) {
  let totalP = 0;
  let dividedP = 0;
  let weighted = 0;
  let cells = 0;
  let dividedCells = 0;
  const precursors = new Float64Array(counts.length);
  for (let g = 0; g < counts.length; g += 1) {
    const n = Math.max(0, counts[g]);
    const p = n / 2 ** g;
    precursors[g] = p;
    totalP += p;
    weighted += g * p;
    cells += n;
    if (g >= 1) {
      dividedP += p;
      dividedCells += n;
    }
  }
  return {
    divisionIndex: totalP > 0 ? weighted / totalP : Number.NaN,
    proliferationIndex: dividedP > 0 ? weighted / dividedP : Number.NaN,
    expansionIndex: totalP > 0 ? cells / totalP : Number.NaN,
    replicationIndex: dividedP > 0 ? dividedCells / dividedP : Number.NaN,
    percentDivided: totalP > 0 ? (100 * dividedP) / totalP : Number.NaN,
    precursorFrequencies: Float64Array.from(precursors, (p) => (totalP > 0 ? p / totalP : Number.NaN)),
    precursors,
  };
}

// Weighted least squares for non-negative coefficients of fixed basis curves, by a simple
// active-set loop (drop the most negative coefficient and re-solve). Good enough for starting
// values; Lawson–Hanson NNLS would be exact.
function nonNegativeLeastSquares(basis, y, w) {
  const K = basis.length;
  const n = y.length;
  const active = new Array(K).fill(true);
  const coef = new Float64Array(K);
  for (let round = 0; round <= K; round += 1) {
    const idx = [];
    for (let g = 0; g < K; g += 1) if (active[g]) idx.push(g);
    const m = idx.length;
    coef.fill(0);
    if (!m) break;
    const A = new Float64Array(m * m);
    const b = new Float64Array(m);
    for (let i = 0; i < n; i += 1) {
      for (let a = 0; a < m; a += 1) {
        const va = basis[idx[a]][i] * w[i];
        if (!va) continue;
        b[a] += va * y[i];
        for (let c = 0; c < m; c += 1) A[a * m + c] += va * basis[idx[c]][i];
      }
    }
    for (let a = 0; a < m; a += 1) A[a * m + a] += 1e-12 * (A[a * m + a] || 1);
    if (!cholesky(A, m)) break;
    const x = choleskySolve(A, m, b);
    let worst = -1;
    for (let a = 0; a < m; a += 1) {
      coef[idx[a]] = x[a];
      if (x[a] < 0 && (worst < 0 || x[a] < coef[idx[worst]])) worst = a;
    }
    if (worst < 0) break;
    active[idx[worst]] = false;
  }
  for (let g = 0; g < K; g += 1) coef[g] = Math.max(0, coef[g]);
  let cost = 0;
  for (let i = 0; i < n; i += 1) {
    let f = 0;
    for (let g = 0; g < K; g += 1) f += coef[g] * basis[g][i];
    cost += w[i] * (y[i] - f) ** 2;
  }
  return { coef, cost };
}

function makeScale(transform) {
  if (!transform || transform === 'log10' || transform === 'log') {
    return {
      name: 'log10',
      forward: (x) => (x > 0 ? Math.log10(x) : Number.NaN),
      inverse: (y) => 10 ** y,
    };
  }
  const t = typeof transform.forward === 'function' ? transform : createTransform(transform);
  return { name: transform.type ?? 'custom', forward: (x) => t.forward(x), inverse: (y) => t.inverse(y) };
}

// Fits generations to dye intensities (linear values, e.g. compensated CTV-A). Options:
//   indices          population (sorted Uint32Array)
//   transform        'log10' (default; non-positive events are left out) or a transform spec
//                    such as { type: 'logicle', T, W, M, A } (or an object with forward/inverse)
//   undividedPeak    linear position of generation 0, e.g. the mode of an unstimulated control;
//                    held fixed unless fitPeak: true. Default: the brightest histogram mode
//                    holding at least minPeakHeight (0.05) of the tallest mode, then refined.
//   generations      number of divided generations to model (default auto from the data range,
//                    at most maxGenerations = 10)
//   ratio            dye dilution per division (2); spacingBounds [0.8, 1.2] limit the fitted
//                    factor r (fitSpacing: false holds r = 1)
//   cv               fixed shared linear CV (default fitted)
//   bins (256), range [lo, hi] (linear), signal
// Returns { generations: [{ generation, mean, position, count, fittedCount, fraction,
// precursors, precursorFraction }], indices, undividedPeak, spacingFactor, dilutionPerGeneration,
// sd, cv, x, xLinear, histogram, binWidth, curves: { total, components }, chiSquare,
// reducedChiSquare, converged, iterations, eventCount, excluded, warnings }.
export function fitProliferation(values, options = {}) {
  const scale = makeScale(options.transform);
  const data = gather(values, options.indices ?? null);
  const scaled = [];
  for (let i = 0; i < data.length; i += 1) {
    const y = scale.forward(data[i]);
    if (Number.isFinite(y)) scaled.push(y);
  }
  const excluded = data.length - scaled.length;
  if (scaled.length < 50) throw new Error('Too few events with dye signal to model proliferation.');
  const sorted = Float64Array.from(scaled).sort();
  const ratio = options.ratio ?? 2;
  const maxGenerations = Math.min(options.maxGenerations ?? 10, 30);
  let lo;
  let hi;
  if (options.range) {
    lo = scale.forward(options.range[0]);
    hi = scale.forward(options.range[1]);
  } else {
    const qlo = quantileSorted(sorted, 0.001);
    const qhi = quantileSorted(sorted, 0.999);
    const margin = 0.05 * (qhi - qlo || 1);
    lo = qlo - margin;
    hi = qhi + margin;
  }
  if (!(hi > lo)) throw new Error('The dye range is empty.');
  const bins = options.bins ?? 256;
  const bw = (hi - lo) / bins;
  const counts = new Float64Array(bins);
  for (const y of sorted) {
    const b = Math.floor((y - lo) / bw);
    if (b >= 0 && b < bins) counts[b] += 1;
  }
  const centers = Float64Array.from({ length: bins }, (_, b) => lo + (b + 0.5) * bw);
  const smooth = smoothCounts(counts, 1.5);

  // Undivided peak (generation 0).
  let peakLinear;
  const userPeak = typeof options.undividedPeak === 'number';
  if (userPeak) {
    peakLinear = options.undividedPeak;
    if (!Number.isFinite(scale.forward(peakLinear))) throw new Error('The undivided-peak position is outside the scale.');
  } else {
    const minHeight = (options.minPeakHeight ?? 0.05) * Math.max(...smooth);
    let best = -1;
    for (let b = 1; b < bins - 1; b += 1) {
      if (smooth[b] >= minHeight && smooth[b] >= smooth[b - 1] && smooth[b] > smooth[b + 1]) best = b;
    }
    if (best < 0) throw new Error('No undivided peak was found; give its position from an unstimulated control.');
    const d = smooth[best - 1] - 2 * smooth[best] + smooth[best + 1];
    const offset = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (smooth[best - 1] - smooth[best + 1])) / d)) : 0;
    peakLinear = scale.inverse(centers[best] + offset * bw);
  }
  const fitPeak = options.fitPeak ?? !userPeak;
  const logPeak = Math.log10(peakLinear);
  const logRatio = Math.log10(ratio);
  const meanOf = (lp, r, g) => scale.forward(10 ** (lp - g * r * logRatio));
  const spacing0 = meanOf(logPeak, 1, 0) - meanOf(logPeak, 1, 1);
  if (!(spacing0 > 0)) throw new Error('Generations cannot be separated on this scale; check the transform.');

  // Width from the bright (right) flank of the undivided peak, which no other generation overlaps.
  const peakBin = Math.max(0, Math.min(bins - 1, Math.floor((meanOf(logPeak, 1, 0) - lo) / bw)));
  let j = peakBin;
  while (j + 1 < bins && smooth[j] > smooth[peakBin] / 2) j += 1;
  const hwhm = Math.max(bw, (j - peakBin) * bw);
  const sdKernel = 1.5 * bw;
  let sd0 = Math.sqrt(Math.max((hwhm / Math.sqrt(2 * Math.LN2)) ** 2 - sdKernel ** 2, (0.5 * bw) ** 2));
  sd0 = Math.min(sd0, 0.45 * spacing0);
  const cvFixed = typeof options.cv === 'number';
  if (cvFixed) sd0 = (scale.forward(peakLinear * (1 + options.cv)) - scale.forward(peakLinear * (1 - options.cv))) / 2;

  // Number of divided generations.
  // Auto: every generation whose mean lies within half a spacing of the 0.5th percentile.
  const lowest = quantileSorted(sorted, 0.005);
  const generationsFor = (r) => {
    let g = 0;
    while (g < maxGenerations) {
      const next = meanOf(logPeak, r, g + 1);
      const step = meanOf(logPeak, r, g) - next;
      if (!(next >= lowest - 0.5 * step)) break;
      g += 1;
    }
    return Math.max(1, g);
  };
  const autoGenerations = typeof options.generations !== 'number';
  let G = autoGenerations ? generationsFor(1) : options.generations;
  G = Math.max(1, Math.min(maxGenerations, Math.round(G)));
  const K = G + 1;

  // Parameters: [log10 peak, spacing factor r, sd, w0 … wG].
  const p0 = new Float64Array(3 + K);
  p0[0] = logPeak;
  p0[1] = 1;
  p0[2] = sd0;
  for (let g = 0; g < K; g += 1) {
    const b = Math.max(0, Math.min(bins - 1, Math.floor((meanOf(logPeak, 1, g) - lo) / bw)));
    p0[3 + g] = Math.max(0.5, (smooth[b] * sd0 * Math.sqrt(2 * Math.PI)) / bw);
  }
  const [rLo, rHi] = options.spacingBounds ?? [0.8, 1.2];
  // Start the spacing factor from a grid search: a few percent of spacing error accumulates over
  // ten generations into whole-peak misalignment, a local minimum LM cannot leave.
  const weights = Float64Array.from(counts, (v) => 1 / Math.max(v, 1));
  if (options.fitSpacing !== false) {
    let bestCost = Infinity;
    const steps = Math.max(2, Math.round((rHi - rLo) / 0.005));
    for (let k = 0; k <= steps; k += 1) {
      const r = rLo + ((rHi - rLo) * k) / steps;
      const basis = [];
      for (let g = 0; g < K; g += 1) basis.push(addGaussianBins(new Float64Array(bins), lo, bw, 1, meanOf(logPeak, r, g), sd0));
      const { coef, cost } = nonNegativeLeastSquares(basis, counts, weights);
      if (cost < bestCost) {
        bestCost = cost;
        p0[1] = r;
        for (let g = 0; g < K; g += 1) p0[3 + g] = Math.max(0.5, coef[g]);
      }
    }
    // Closer spacing than ratio^1 fits more generations into the data range: model them too.
    if (autoGenerations && generationsFor(p0[1]) > G) {
      return fitProliferation(values, { ...options, generations: generationsFor(p0[1]) });
    }
  }
  const lower = [logPeak - 0.5 * logRatio, rLo, 0.25 * bw, ...new Array(K).fill(0)];
  const upper = [logPeak + 0.5 * logRatio, rHi, 0.6 * spacing0, ...new Array(K).fill(null)];
  const fixed = [!fitPeak, options.fitSpacing === false, cvFixed, ...new Array(K).fill(false)];
  const componentsOf = (p) => {
    const list = [];
    for (let g = 0; g < K; g += 1) {
      const c = new Float64Array(bins);
      addGaussianBins(c, lo, bw, p[3 + g], meanOf(p[0], p[1], g), p[2]);
      list.push(c);
    }
    return list;
  };
  const model = (p, out) => {
    out.fill(0);
    for (let g = 0; g < K; g += 1) addGaussianBins(out, lo, bw, p[3 + g], meanOf(p[0], p[1], g), p[2]);
    return out;
  };
  const fit = fitLeastSquares(model, p0, counts, {
    weights, lower, upper, fixed, absoluteSigma: true, signal: options.signal, maxIterations: options.maxIterations ?? 300,
  });
  const p = fit.params;
  const sd = p[2];
  const means = Float64Array.from({ length: K }, (_, g) => meanOf(p[0], p[1], g));

  // Posterior assignment of every event (log-sum-exp; equal widths cancel).
  const logW = Float64Array.from({ length: K }, (_, g) => (p[3 + g] > 0 ? Math.log(p[3 + g]) : -Infinity));
  const assigned = new Float64Array(K);
  const z = new Float64Array(K);
  const inv = 1 / (2 * sd * sd);
  for (let i = 0; i < sorted.length; i += 1) {
    if ((i & 0xffff) === 0 && options.signal?.aborted) throw new Error('The fit was cancelled.');
    const y = sorted[i];
    let max = -Infinity;
    for (let g = 0; g < K; g += 1) {
      const d = y - means[g];
      z[g] = logW[g] - d * d * inv;
      if (z[g] > max) max = z[g];
    }
    if (max === -Infinity) continue;
    let sum = 0;
    for (let g = 0; g < K; g += 1) {
      z[g] = Math.exp(z[g] - max);
      sum += z[g];
    }
    for (let g = 0; g < K; g += 1) assigned[g] += z[g] / sum;
  }
  const indices = proliferationIndices(assigned);
  const totalAssigned = assigned.reduce((a, b) => a + b, 0);
  const generations = Array.from({ length: K }, (_, g) => ({
    generation: g,
    mean: scale.inverse(means[g]),
    position: means[g],
    count: assigned[g],
    fittedCount: p[3 + g],
    fraction: assigned[g] / totalAssigned,
    precursors: indices.precursors[g],
    precursorFraction: indices.precursorFrequencies[g],
  }));
  const components = componentsOf(p);
  const total = new Float64Array(bins);
  for (const c of components) for (let b = 0; b < bins; b += 1) total[b] += c[b];
  const cv = scale.name === 'log10'
    ? Math.sqrt(Math.expm1((sd * Math.LN10) ** 2))
    : (scale.inverse(means[0] + sd) - scale.inverse(means[0] - sd)) / (2 * scale.inverse(means[0]));
  const spacing = means[0] - means[1];
  const warnings = [];
  if (excluded > 0) warnings.push(`${excluded} events with non-positive dye intensity were left out of the log scale; use a logicle transform to include them.`);
  if (!fixed[1] && fit.atBound[1]) warnings.push('The generation spacing ran to its limit; check the undivided peak or set the dilution ratio.');
  if (sd > 0.4 * spacing) warnings.push('Generations overlap heavily (peak width > 40% of the spacing); per-generation counts are uncertain.');
  if (G === maxGenerations && generations[K - 1].fraction > 0.05) warnings.push(`More than 5% of cells fall in the last modelled generation (${G}); cells may have divided further than the dye resolves.`);
  if (indices.percentDivided < 1) warnings.push('Less than 1% of the original cells divided.');
  if (!fit.converged) warnings.push('The fit did not converge; results may be unreliable.');
  return {
    generations,
    indices: {
      divisionIndex: indices.divisionIndex,
      proliferationIndex: indices.proliferationIndex,
      expansionIndex: indices.expansionIndex,
      replicationIndex: indices.replicationIndex,
      percentDivided: indices.percentDivided,
    },
    undividedPeak: fixed[0] ? peakLinear : scale.inverse(means[0]),
    spacingFactor: p[1],
    dilutionPerGeneration: ratio ** p[1],
    sd,
    cv,
    scale: scale.name,
    x: centers,
    xLinear: Float64Array.from(centers, (c) => scale.inverse(c)),
    histogram: counts,
    binWidth: bw,
    curves: { total, components },
    chiSquare: fit.chiSquare,
    reducedChiSquare: fit.reducedChiSquare,
    converged: fit.converged,
    iterations: fit.iterations,
    eventCount: sorted.length,
    excluded,
    warnings,
  };
}
