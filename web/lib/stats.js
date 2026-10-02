// Descriptive statistics of populations, as cytometrists report them.
//
// All functions take a column (Float32Array of linear, compensated values) and optional event
// indices (sorted Uint32Array; null means all events).

export const STATISTICS = [
  { id: 'count', label: 'Count', needsChannel: false },
  { id: 'freqParent', label: '% of parent', needsChannel: false },
  { id: 'freqGrandparent', label: '% of grandparent', needsChannel: false },
  { id: 'freqTotal', label: '% of total', needsChannel: false },
  { id: 'freqOf', label: '% of …', needsChannel: false, needsAncestor: true },
  { id: 'concentration', label: 'Concentration (/µL)', needsChannel: false },
  { id: 'median', label: 'Median', needsChannel: true },
  { id: 'mean', label: 'Mean', needsChannel: true },
  { id: 'geomean', label: 'Geometric mean', needsChannel: true },
  { id: 'sd', label: 'SD', needsChannel: true },
  { id: 'rsd', label: 'Robust SD', needsChannel: true },
  { id: 'cv', label: 'CV (%)', needsChannel: true },
  { id: 'rcv', label: 'Robust CV (%)', needsChannel: true },
  { id: 'mad', label: 'Median absolute deviation', needsChannel: true },
  { id: 'min', label: 'Minimum', needsChannel: true },
  { id: 'max', label: 'Maximum', needsChannel: true },
  { id: 'percentile', label: 'Percentile', needsChannel: true, needsValue: true },
  { id: 'mode', label: 'Mode', needsChannel: true },
  { id: 'positive', label: '% above threshold', needsChannel: true, needsValue: true },
];

// Copies the selected values into a new Float64Array, dropping non-finite ones.
export function gather(column, indices = null) {
  const n = indices ? indices.length : column.length;
  const out = new Float64Array(n);
  let k = 0;
  if (indices) {
    for (let i = 0; i < n; i += 1) {
      const v = column[indices[i]];
      if (Number.isFinite(v)) out[k++] = v;
    }
  } else {
    for (let i = 0; i < n; i += 1) {
      const v = column[i];
      if (Number.isFinite(v)) out[k++] = v;
    }
  }
  return k === n ? out : out.slice(0, k);
}

export function sortedValues(column, indices = null) {
  return gather(column, indices).sort();
}

// Linear interpolation between order statistics (R type 7, the default of R and NumPy).
export function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (!n) return Number.NaN;
  if (n === 1) return sorted[0];
  const pos = Math.min(Math.max(q, 0), 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function mean(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += values[i];
  return values.length ? sum / values.length : Number.NaN;
}

export function variance(values, m = mean(values)) {
  if (values.length < 2) return Number.NaN;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const d = values[i] - m;
    sum += d * d;
  }
  return sum / (values.length - 1);
}

// Geometric mean of the positive values (non-positive values have no logarithm). The number of
// values left out is returned so the user can judge it.
export function geometricMean(values) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > 0) {
      sum += Math.log(values[i]);
      n += 1;
    }
  }
  return { value: n ? Math.exp(sum / n) : Number.NaN, excluded: values.length - n };
}

// The densest value, from a histogram of `bins` bins between the 0.5th and 99.5th percentiles.
export function modeOf(sorted, bins = 256) {
  if (!sorted.length) return Number.NaN;
  const lo = quantileSorted(sorted, 0.005);
  const hi = quantileSorted(sorted, 0.995);
  if (!(hi > lo)) return lo;
  const counts = new Uint32Array(bins);
  const scale = bins / (hi - lo);
  for (let i = 0; i < sorted.length; i += 1) {
    const b = Math.floor((sorted[i] - lo) * scale);
    if (b >= 0 && b < bins) counts[b] += 1;
  }
  let best = 0;
  for (let b = 1; b < bins; b += 1) if (counts[b] > counts[best]) best = b;
  return lo + (best + 0.5) / scale;
}

// Every channel statistic at once, from one sort. Returns an object keyed by statistic id.
export function describe(column, indices = null, options = {}) {
  const sorted = sortedValues(column, indices);
  const n = sorted.length;
  if (!n) return { n: 0 };
  const m = mean(sorted);
  const v = variance(sorted, m);
  const sd = Math.sqrt(v);
  const med = quantileSorted(sorted, 0.5);
  const p16 = quantileSorted(sorted, 0.1587);
  const p84 = quantileSorted(sorted, 0.8413);
  const rsd = (p84 - p16) / 2;
  const deviations = new Float64Array(n);
  for (let i = 0; i < n; i += 1) deviations[i] = Math.abs(sorted[i] - med);
  deviations.sort();
  const geo = geometricMean(sorted);
  const result = {
    n,
    median: med,
    mean: m,
    geomean: geo.value,
    geomeanExcluded: geo.excluded,
    sd,
    rsd,
    cv: (100 * sd) / Math.abs(m),
    rcv: (100 * rsd) / Math.abs(med),
    mad: quantileSorted(deviations, 0.5),
    min: sorted[0],
    max: sorted[n - 1],
    mode: modeOf(sorted),
    p1: quantileSorted(sorted, 0.01),
    p5: quantileSorted(sorted, 0.05),
    p25: quantileSorted(sorted, 0.25),
    p75: quantileSorted(sorted, 0.75),
    p95: quantileSorted(sorted, 0.95),
    p99: quantileSorted(sorted, 0.99),
  };
  if (options.percentile !== undefined) result.percentile = quantileSorted(sorted, options.percentile / 100);
  if (options.threshold !== undefined) {
    let above = 0;
    for (let i = 0; i < n; i += 1) if (sorted[i] >= options.threshold) above += 1;
    result.positive = (100 * above) / n;
  }
  return result;
}

// A single statistic, computed without the full description when cheap.
export function statistic(id, column, indices = null, options = {}) {
  if (id === 'mean') return mean(gather(column, indices));
  if (id === 'sd') return Math.sqrt(variance(gather(column, indices)));
  if (id === 'min' || id === 'max') {
    let lo = Infinity; let hi = -Infinity;
    const n = indices ? indices.length : column.length;
    for (let i = 0; i < n; i += 1) {
      const v = column[indices ? indices[i] : i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return id === 'min' ? lo : hi;
  }
  return describe(column, indices, options)[id];
}

// Staining index (Maecker & Trotter): (median+ − median−) / (2 × rSD−).
export function stainIndex(positive, negative) {
  const pos = sortedValues(positive);
  const neg = sortedValues(negative);
  const rsdNeg = (quantileSorted(neg, 0.8413) - quantileSorted(neg, 0.1587)) / 2;
  return (quantileSorted(pos, 0.5) - quantileSorted(neg, 0.5)) / (2 * rsdNeg);
}

// Formats a statistic for display with sensible precision.
export function formatStatistic(id, value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '−∞';
  if (id === 'count') return Math.round(value).toLocaleString('en-US');
  if (id.startsWith('freq') || id === 'positive' || id === 'cv' || id === 'rcv') {
    const abs = Math.abs(value);
    return abs >= 10 ? value.toFixed(1) : abs >= 1 ? value.toFixed(2) : abs >= 0.01 ? value.toFixed(3) : value.toPrecision(2);
  }
  const abs = Math.abs(value);
  if (abs >= 1e5) return value.toExponential(3);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(2);
  return value.toPrecision(3);
}

// Binomial confidence interval of a frequency (Wilson score), for rare-event reporting.
export function wilsonInterval(successes, trials, z = 1.959963984540054) {
  if (!trials) return [Number.NaN, Number.NaN];
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

// Coefficient of variation of a count from Poisson statistics: 1/√n, as a percentage.
export function poissonCV(count) {
  return count > 0 ? 100 / Math.sqrt(count) : Infinity;
}
