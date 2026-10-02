// Comparing single-parameter (and low-dimensional) distributions between samples: probability
// binning, Overton subtraction, Kolmogorov–Smirnov, Earth Mover's distance, Jensen–Shannon
// divergence and kernel density estimates.
//
// Inputs are event values as Float32Array/Float64Array/arrays; multivariate inputs are arrays of
// columns ([Float32Array, …], column-major as dataset.data). Distances that depend on the axis
// (probability-binning splits, EMD, KDE) should be given values on the display scale (e.g.
// after a logicle transform), which is where cytometrists judge differences.

import { gather, quantileSorted } from './stats.js';

function sortedCopy(values) {
  return gather(values).sort();
}

function isMultivariate(data) {
  return Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && data[0] !== null && 'length' in data[0];
}

// --- Probability binning (Roederer et al. 2001) --------------------------------------------------

// Bins are built on the control so each holds (nearly) the same number of control events: in
// 1-D at control quantiles; in d dimensions by recursively splitting every bin at the median of
// the dimension with the largest variance (Roederer, Moore, Treister, Hardy & Herzenberg 2001,
// "Probability binning comparison: a metric for quantitating multivariate distribution
// differences", Cytometry 45:47–55). The test
// sample is classified into the same bins and
//   χ² = Σᵢ (cᵢ − sᵢ)² / (cᵢ + sᵢ)        (cᵢ, sᵢ = fractions of control and test events)
//   T(χ) = max(0, (χ² − B/K) / (√B / K)),  K = min(N_control, N_test), B = number of bins
// where B/K and √B/K are the expected value and spread of χ² for two samples drawn from the same
// distribution (Roederer, Treister, Hardy & Herzenberg 2001, Cytometry 45:37–46,
// doi:10.1002/1097-0320(20010901)45:1<37::AID-CYTO1142>3.0.CO;2-E). T(χ) > 4 corresponds roughly
// to p < 0.01. `percentPositive` = 100·Σᵢ max(0, sᵢ − cᵢ): the share of test events in excess of
// the control's probability mass, the probability-binning analogue of Overton subtraction.
// Options: bins (default: power of two ≤ N_control/10, at most 1024 in d dimensions and 256 in
// 1-D), minPerBin (10).
export function probabilityBinning(control, test, options = {}) {
  const multi = isMultivariate(control);
  const controlColumns = multi ? control : [control];
  const testColumns = multi ? test : [test];
  const dims = controlColumns.length;
  if (testColumns.length !== dims) throw new Error('Control and test must have the same number of parameters.');
  const nc = controlColumns[0].length;
  const nt = testColumns[0].length;
  if (nc < 2 || nt < 1) throw new Error('Probability binning needs events in both samples.');
  const minPerBin = options.minPerBin ?? 10;
  const cap = dims === 1 ? 256 : 1024;
  let bins = options.bins ?? Math.min(cap, 2 ** Math.max(1, Math.floor(Math.log2(nc / minPerBin))));
  bins = Math.max(2, Math.min(bins, nc));
  let controlCounts;
  let testCounts;
  let assignTest;
  if (dims === 1) {
    const sorted = sortedCopy(controlColumns[0]);
    const cuts = new Float64Array(bins - 1);
    for (let b = 1; b < bins; b += 1) cuts[b - 1] = quantileSorted(sorted, b / bins);
    const binOf = (v) => {
      let lo = 0;
      let hi = cuts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (v > cuts[mid]) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    controlCounts = new Float64Array(bins);
    for (let i = 0; i < sorted.length; i += 1) controlCounts[binOf(sorted[i])] += 1;
    assignTest = binOf;
  } else {
    const levels = Math.max(1, Math.round(Math.log2(bins)));
    bins = 2 ** levels;
    const tree = buildMedianTree(controlColumns, levels);
    controlCounts = tree.counts;
    assignTest = null;
    testCounts = new Float64Array(bins);
    for (let e = 0; e < nt; e += 1) {
      let node = 0;
      for (let level = 0; level < levels; level += 1) {
        const split = tree.splits[node];
        const v = testColumns[split.dim][e];
        node = 2 * node + (v <= split.threshold ? 1 : 2);
      }
      testCounts[node - (bins - 1)] += 1;
    }
  }
  if (assignTest) {
    testCounts = new Float64Array(bins);
    const column = testColumns[0];
    for (let e = 0; e < nt; e += 1) {
      const v = column[e];
      if (Number.isFinite(v)) testCounts[assignTest(v)] += 1;
    }
  }
  const totalC = controlCounts.reduce((a, b) => a + b, 0);
  const totalT = testCounts.reduce((a, b) => a + b, 0);
  const controlFractions = new Float64Array(bins);
  const testFractions = new Float64Array(bins);
  let chi = 0;
  let excess = 0;
  for (let b = 0; b < bins; b += 1) {
    const c = controlCounts[b] / totalC;
    const s = testCounts[b] / totalT;
    controlFractions[b] = c;
    testFractions[b] = s;
    if (c + s > 0) chi += ((c - s) * (c - s)) / (c + s);
    if (s > c) excess += s - c;
  }
  const K = Math.min(totalC, totalT);
  const expected = bins / K;
  const spread = Math.sqrt(bins) / K;
  return {
    chiSquare: chi,
    T: Math.max(0, (chi - expected) / spread),
    expectedChiSquare: expected,
    bins,
    controlCount: totalC,
    testCount: totalT,
    percentPositive: 100 * excess,
    controlFractions,
    testFractions,
  };
}

// Recursive median splits over `levels` levels; splits[node] for a complete binary tree in
// array order (children of node k are 2k+1 and 2k+2). Returns counts of control events per leaf.
function buildMedianTree(columns, levels) {
  const n = columns[0].length;
  let groups = [];
  const all = [];
  for (let e = 0; e < n; e += 1) {
    let ok = true;
    for (const col of columns) if (!Number.isFinite(col[e])) ok = false;
    if (ok) all.push(e);
  }
  groups.push(Uint32Array.from(all));
  const splits = [];
  for (let level = 0; level < levels; level += 1) {
    const next = [];
    for (const members of groups) {
      let bestDim = 0;
      let bestVar = -1;
      for (let d = 0; d < columns.length; d += 1) {
        const col = columns[d];
        let s = 0;
        let s2 = 0;
        for (let i = 0; i < members.length; i += 1) {
          const v = col[members[i]];
          s += v;
          s2 += v * v;
        }
        const m = members.length ? s / members.length : 0;
        const variance = members.length ? s2 / members.length - m * m : 0;
        if (variance > bestVar) {
          bestVar = variance;
          bestDim = d;
        }
      }
      const col = columns[bestDim];
      const values = Float64Array.from(members, (e) => col[e]).sort();
      const threshold = values.length ? quantileSorted(values, 0.5) : 0;
      splits.push({ dim: bestDim, threshold });
      const left = [];
      const right = [];
      for (let i = 0; i < members.length; i += 1) (col[members[i]] <= threshold ? left : right).push(members[i]);
      next.push(Uint32Array.from(left), Uint32Array.from(right));
    }
    groups = next;
  }
  return { splits, counts: Float64Array.from(groups, (g) => g.length) };
}

// --- Overton cumulative subtraction ---------------------------------------------------------------

// Overton (1988, Cytometry 9:619–626, doi:10.1002/cyto.990090617) cumulative histogram
// subtraction: % positive = max over x of [F_control(x) − F_test(x)] × 100, the largest excess of
// the control's cumulative fraction over the test's (the test shifted to higher values). Computed
// exactly from the sorted events (the limit of infinitely fine histogram channels); the result
// does not depend on the axis transform. Also returns the threshold where the maximum occurs and,
// when `bins` is given, cumulative curves on a grid for drawing.
export function overtonSubtraction(control, test, options = {}) {
  const c = sortedCopy(control);
  const t = sortedCopy(test);
  if (!c.length || !t.length) throw new Error('Overton subtraction needs events in both samples.');
  let i = 0;
  let j = 0;
  let best = 0;
  let threshold = c[0];
  while (i < c.length || j < t.length) {
    const v = j >= t.length || (i < c.length && c[i] <= t[j]) ? c[i] : t[j];
    while (i < c.length && c[i] === v) i += 1;
    while (j < t.length && t[j] === v) j += 1;
    const diff = i / c.length - j / t.length;
    if (diff > best) {
      best = diff;
      threshold = v;
    }
  }
  const result = { percentPositive: 100 * best, threshold };
  if (options.bins) {
    const lo = Math.min(c[0], t[0]);
    const hi = Math.max(c[c.length - 1], t[t.length - 1]);
    const n = options.bins;
    const x = new Float64Array(n);
    const controlCdf = new Float64Array(n);
    const testCdf = new Float64Array(n);
    let a = 0;
    let b = 0;
    for (let k = 0; k < n; k += 1) {
      x[k] = lo + ((hi - lo) * (k + 1)) / n;
      while (a < c.length && c[a] <= x[k]) a += 1;
      while (b < t.length && t[b] <= x[k]) b += 1;
      controlCdf[k] = a / c.length;
      testCdf[k] = b / t.length;
    }
    result.curves = { x, controlCdf, testCdf };
  }
  return result;
}

// --- Kolmogorov–Smirnov ---------------------------------------------------------------------------

// Kolmogorov's limiting distribution Q(λ) = P(K > λ) = 2 Σ (−1)^{k−1} e^{−2k²λ²}; for small λ the
// equivalent theta-function series √(2π)/λ Σ e^{−(2k−1)²π²/(8λ²)} converges faster.
export function kolmogorovSurvival(lambda) {
  if (!(lambda > 0)) return 1;
  if (lambda < 1.18) {
    const y = Math.exp(-(Math.PI * Math.PI) / (8 * lambda * lambda));
    let s = 0;
    for (let k = 1; k < 50; k += 2) {
      const term = y ** (k * k);
      s += term;
      if (term < 1e-17 * s) break;
    }
    return 1 - (Math.sqrt(2 * Math.PI) / lambda) * s;
  }
  let s = 0;
  for (let k = 1; k < 100; k += 1) {
    const term = Math.exp(-2 * k * k * lambda * lambda);
    s += k % 2 ? term : -term;
    if (term < 1e-17) break;
  }
  return Math.max(0, Math.min(1, 2 * s));
}

// Two-sample Kolmogorov–Smirnov test: D = max |F₁ − F₂| and the asymptotic p-value
// Q(√(n₁n₂/(n₁+n₂)) · D) (as R's ks.test(exact = FALSE)). Flow samples are large, so the
// asymptotic p is the practical choice; note that with 10⁵ events trivial shifts are significant.
export function ksTest(x, y) {
  const a = sortedCopy(x);
  const b = sortedCopy(y);
  const n = a.length;
  const m = b.length;
  if (!n || !m) throw new Error('The KS test needs values in both samples.');
  let i = 0;
  let j = 0;
  let D = 0;
  while (i < n && j < m) {
    const v = Math.min(a[i], b[j]);
    while (i < n && a[i] === v) i += 1;
    while (j < m && b[j] === v) j += 1;
    D = Math.max(D, Math.abs(i / n - j / m));
  }
  const lambda = Math.sqrt((n * m) / (n + m)) * D;
  return { statistic: D, D, p: kolmogorovSurvival(lambda), n1: n, n2: m };
}

// --- Earth Mover's (Wasserstein-1) distance -------------------------------------------------------

// Exact 1-D Wasserstein-1 distance ∫ |F₁(t) − F₂(t)| dt between two samples (each event weight
// 1/n), in the units of the values (Orlova et al. 2016, PLoS One 11:e0151859,
// doi:10.1371/journal.pone.0151859).
export function wasserstein1D(x, y) {
  return weightedWasserstein(sortedCopy(x), null, sortedCopy(y), null);
}

// W₁ between weighted point sets with ascending positions (weights null = equal weights).
function weightedWasserstein(pa, wa, pb, wb) {
  const n = pa.length;
  const m = pb.length;
  if (!n || !m) return Number.NaN;
  let totalA = n;
  let totalB = m;
  if (wa) totalA = wa.reduce((s, v) => s + v, 0);
  if (wb) totalB = wb.reduce((s, v) => s + v, 0);
  let i = 0;
  let j = 0;
  let Fa = 0;
  let Fb = 0;
  let previous = Math.min(pa[0], pb[0]);
  let distance = 0;
  while (i < n || j < m) {
    const v = j >= m || (i < n && pa[i] <= pb[j]) ? pa[i] : pb[j];
    distance += Math.abs(Fa - Fb) * (v - previous);
    while (i < n && pa[i] === v) {
      Fa += (wa ? wa[i] : 1) / totalA;
      i += 1;
    }
    while (j < m && pb[j] === v) {
      Fb += (wb ? wb[j] : 1) / totalB;
      j += 1;
    }
    previous = v;
  }
  return distance;
}

// 2-D EMD approximation: both samples are binned on a common grid (bins × bins over the pooled
// range) and compared by the sliced Wasserstein distance over `directions` evenly spaced
// projection angles (Rabin et al. 2011; Bonneel et al. 2015). The mean over directions of a 2-D
// translation by v is (2/π)|v|, so `distance` = (π/2)·mean is reported, which is exact for pure
// shifts and close to the true EMD for similar shapes; `sliced` (the raw mean, a lower bound on
// W₁) and `maxSliced` (largest projection, also a lower bound) are returned too.
// a, b: [xs, ys]. Options: bins (64), directions (64), range [[xmin, xmax], [ymin, ymax]].
export function emd2D(a, b, options = {}) {
  const bins = options.bins ?? 64;
  const directions = options.directions ?? 64;
  const [ax, ay] = a;
  const [bx, by] = b;
  let range = options.range;
  if (!range) {
    const lim = (arrays) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const arr of arrays) {
        for (let i = 0; i < arr.length; i += 1) {
          const v = arr[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      return hi > lo ? [lo, hi] : [lo - 0.5, lo + 0.5];
    };
    range = [lim([ax, bx]), lim([ay, by])];
  }
  const [[x0, x1], [y0, y1]] = range;
  const sx = bins / (x1 - x0);
  const sy = bins / (y1 - y0);
  const histogram = (xs, ys) => {
    const h = new Float64Array(bins * bins);
    for (let i = 0; i < xs.length; i += 1) {
      const bxi = Math.floor((xs[i] - x0) * sx);
      const byi = Math.floor((ys[i] - y0) * sy);
      if (!(bxi >= 0 && byi >= 0)) continue;
      h[Math.min(bins - 1, byi) * bins + Math.min(bins - 1, bxi)] += 1;
    }
    return h;
  };
  const ha = histogram(ax, ay);
  const hb = histogram(bx, by);
  const cells = [];
  for (let k = 0; k < bins * bins; k += 1) if (ha[k] || hb[k]) cells.push(k);
  const cx = Float64Array.from(cells, (k) => x0 + ((k % bins) + 0.5) / sx);
  const cy = Float64Array.from(cells, (k) => y0 + (Math.floor(k / bins) + 0.5) / sy);
  const wa = Float64Array.from(cells, (k) => ha[k]);
  const wb = Float64Array.from(cells, (k) => hb[k]);
  const proj = new Float64Array(cells.length);
  const order = Array.from({ length: cells.length }, (_, i) => i);
  let sum = 0;
  let max = 0;
  for (let d = 0; d < directions; d += 1) {
    const theta = (Math.PI * d) / directions;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    for (let i = 0; i < cells.length; i += 1) proj[i] = c * cx[i] + s * cy[i];
    order.sort((p, q) => proj[p] - proj[q]);
    const positions = Float64Array.from(order, (i) => proj[i]);
    const w1 = Float64Array.from(order, (i) => wa[i]);
    const w2 = Float64Array.from(order, (i) => wb[i]);
    const distance = weightedWasserstein(positions, w1, positions, w2);
    sum += distance;
    if (distance > max) max = distance;
  }
  const sliced = sum / directions;
  return { distance: (Math.PI / 2) * sliced, sliced, maxSliced: max, bins, directions, range };
}

// --- Jensen–Shannon divergence ------------------------------------------------------------------

// Jensen–Shannon divergence between two histograms (counts or probabilities over the same bins):
// JS = ½ KL(P‖M) + ½ KL(Q‖M), M = (P + Q)/2 (Lin 1991, doi:10.1109/18.61115). In bits by default
// (0 ≤ JS ≤ 1); `base: Math.E` for nats. Returns { divergence, distance = √divergence }.
export function jensenShannon(p, q, options = {}) {
  if (p.length !== q.length) throw new Error('Histograms must have the same bins.');
  const base = options.base ?? 2;
  let sp = 0;
  let sq = 0;
  for (let i = 0; i < p.length; i += 1) {
    sp += p[i];
    sq += q[i];
  }
  if (!(sp > 0) || !(sq > 0)) throw new Error('Both histograms need some counts.');
  let js = 0;
  for (let i = 0; i < p.length; i += 1) {
    const a = p[i] / sp;
    const b = q[i] / sq;
    const m = 0.5 * (a + b);
    if (a > 0) js += 0.5 * a * Math.log(a / m);
    if (b > 0) js += 0.5 * b * Math.log(b / m);
  }
  const divergence = Math.max(0, js / Math.log(base));
  return { divergence, distance: Math.sqrt(divergence) };
}

// --- Kernel density estimation ------------------------------------------------------------------

function spreadOf(sorted) {
  const n = sorted.length;
  let s = 0;
  for (let i = 0; i < n; i += 1) s += sorted[i];
  const m = s / n;
  let ss = 0;
  for (let i = 0; i < n; i += 1) ss += (sorted[i] - m) ** 2;
  const sd = Math.sqrt(ss / (n - 1));
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
  let lo = Math.min(sd, iqr / 1.34);
  if (!(lo > 0)) lo = sd || Math.abs(sorted[0]) || 1;
  return lo;
}

// Silverman's rule of thumb, 0.9·min(SD, IQR/1.34)·n^(−1/5) (Silverman 1986, eq. 3.31; R's
// bw.nrd0).
export function bandwidthSilverman(values) {
  const sorted = sortedCopy(values);
  if (sorted.length < 2) throw new Error('A bandwidth needs at least two values.');
  return 0.9 * spreadOf(sorted) * sorted.length ** -0.2;
}

// Scott's rule, 1.06·min(SD, IQR/1.34)·n^(−1/5) (Scott 1992; R's bw.nrd).
export function bandwidthScott(values) {
  const sorted = sortedCopy(values);
  if (sorted.length < 2) throw new Error('A bandwidth needs at least two values.');
  return 1.06 * spreadOf(sorted) * sorted.length ** -0.2;
}

// Gaussian kernel density estimate on a regular grid. Events are linearly binned onto the grid
// and convolved with the kernel (as R's density()), so 10⁶ events cost little more than 10³.
// Options: bandwidth ('silverman' | 'scott' | number), points (512), range [lo, hi] (default
// data range ± cut·h), cut (3). Returns { x, y (density, integrates to ~1), bandwidth, n }.
export function kde(values, options = {}) {
  const sorted = sortedCopy(values);
  const n = sorted.length;
  if (n < 2) throw new Error('A density estimate needs at least two values.');
  const bw = options.bandwidth ?? 'silverman';
  const h = typeof bw === 'number' ? bw
    : bw === 'scott' ? 1.06 * spreadOf(sorted) * n ** -0.2
      : bw === 'silverman' ? 0.9 * spreadOf(sorted) * n ** -0.2 : Number.NaN;
  if (!(h > 0)) throw new Error(`Unknown or invalid bandwidth "${bw}".`);
  const points = options.points ?? 512;
  const cut = options.cut ?? 3;
  const [lo, hi] = options.range ?? [sorted[0] - cut * h, sorted[n - 1] + cut * h];
  const step = (hi - lo) / (points - 1);
  const grid = new Float64Array(points);
  for (let i = 0; i < n; i += 1) {
    const pos = (sorted[i] - lo) / step;
    const k = Math.floor(pos);
    const f = pos - k;
    if (k >= 0 && k < points) grid[k] += 1 - f;
    if (k + 1 >= 0 && k + 1 < points) grid[k + 1] += f;
  }
  const reach = Math.min(points - 1, Math.ceil((5 * h) / step));
  const kernel = new Float64Array(reach + 1);
  const norm = 1 / (n * h * Math.sqrt(2 * Math.PI));
  for (let k = 0; k <= reach; k += 1) kernel[k] = norm * Math.exp(-0.5 * ((k * step) / h) ** 2);
  const x = new Float64Array(points);
  const y = new Float64Array(points);
  for (let g = 0; g < points; g += 1) x[g] = lo + g * step;
  for (let j = 0; j < points; j += 1) {
    const w = grid[j];
    if (!w) continue;
    const from = Math.max(0, j - reach);
    const to = Math.min(points - 1, j + reach);
    for (let g = from; g <= to; g += 1) y[g] += w * kernel[Math.abs(g - j)];
  }
  return { x, y, bandwidth: h, n };
}
