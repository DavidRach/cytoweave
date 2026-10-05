// Descriptive statistics of populations, as cytometrists report them.
//
// All functions take a column (Float32Array of linear, compensated values) and optional event
// indices (a sorted Uint32Array or an EventSet; null means all events).

import { EventSet, forEachChunk } from './eventset.js';

export const STATISTICS = [
  { id: 'count', label: 'Count', needsChannel: false },
  { id: 'freqParent', label: '% of parent', needsChannel: false },
  { id: 'freqGrandparent', label: '% of grandparent', needsChannel: false },
  { id: 'freqTotal', label: '% of total', needsChannel: false },
  { id: 'freqOf', label: '% of …', needsChannel: false, needsAncestor: true },
  { id: 'concentration', label: 'Concentration (/µL)', needsChannel: false, needsDilution: true },
  { id: 'absoluteCount', label: 'Absolute count (/µL, counting beads)', needsChannel: false, needsCounting: true, needsDilution: true },
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
  // Rare events (rare-events.js): exact 95% intervals and the counting precision.
  { id: 'countLow', label: 'Count, lower 95% limit', needsChannel: false },
  { id: 'countHigh', label: 'Count, upper 95% limit', needsChannel: false },
  { id: 'countCV', label: 'Counting CV (%)', needsChannel: false },
  { id: 'freqLow', label: '% of parent, lower 95% limit', needsChannel: false },
  { id: 'freqHigh', label: '% of parent, upper 95% limit', needsChannel: false },
  // Comparisons with a control sample's population on one channel (distribution.js).
  { id: 'overton', label: '% positive vs control (Overton)', needsChannel: true, needsControl: true },
  { id: 'sed', label: '% positive vs control (SED)', needsChannel: true, needsControl: true },
  { id: 'pbPositive', label: '% positive vs control (probability binning)', needsChannel: true, needsControl: true },
  { id: 'pbT', label: 'T(χ) vs control (probability binning)', needsChannel: true, needsControl: true },
  { id: 'ksD', label: 'K-S D vs control', needsChannel: true, needsControl: true },
];

// Statistics expressed as percentages, formatted alike.
const PERCENT = new Set(['positive', 'cv', 'rcv', 'countCV', 'overton', 'sed', 'pbPositive']);

// Copies the selected values into a new Float64Array, dropping non-finite ones. `indices` may also
// be an EventSet (eventset.js).
export function gather(column, indices = null) {
  if (indices instanceof EventSet) {
    const out = new Float64Array(indices.count);
    let k = 0;
    forEachChunk(indices, column.length, (chunk, length) => {
      for (let i = 0; i < length; i += 1) {
        const v = column[chunk[i]];
        if (Number.isFinite(v)) out[k++] = v;
      }
    });
    return k === out.length ? out : out.slice(0, k);
  }
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

// As gather, into a Float32Array (for float32 columns: no value changes).
function gather32(column, indices) {
  const out = new Float32Array(indices === null ? column.length : indices instanceof EventSet ? indices.count : indices.length);
  let k = 0;
  forEachChunk(indices, column.length, (chunk, length) => {
    for (let i = 0; i < length; i += 1) {
      const v = column[chunk[i]];
      if (Number.isFinite(v)) out[k++] = v;
    }
  });
  return k === out.length ? out : out.slice(0, k);
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

// --- Order statistics without sorting ----------------------------------------------------------
//
// The k-th smallest values of a Float64Array or Float32Array (no NaN), exactly as sorting would
// give them, in a few passes: a most-significant-digit radix selection on the bits of each value,
// made to sort as unsigned integers (sign bit flipped for positives, all bits for negatives, so −0
// precedes +0 as in a typed-array sort). Each pass counts 16 bits of the key (four levels for a
// double, two for a float); only the buckets holding a wanted rank are kept for the next, and a
// small remainder is sorted.

const RADIX_BITS = 16;
const RADIX = 1 << RADIX_BITS;
const SORT_BELOW = 2048;

function keyWords(values) {
  const words = values instanceof Float32Array ? 1 : 2;
  return new Uint32Array(values.buffer, values.byteOffset, values.length * words);
}

// 16-bit digit `level` (0 = most significant) of value i's sortable key; little-endian words.
function digitOf(words, i, level) {
  let hi = words[2 * i + 1];
  let lo = words[2 * i];
  if (hi & 0x80000000) { hi = ~hi; lo = ~lo; } else hi |= 0x80000000;
  switch (level) {
    case 0: return hi >>> 16;
    case 1: return hi & 0xffff;
    case 2: return lo >>> 16;
    default: return lo & 0xffff;
  }
}

function digitOf32(words, i, level) {
  let key = words[i];
  key = key & 0x80000000 ? ~key : key | 0x80000000;
  return level === 0 ? key >>> 16 : key & 0xffff;
}

function selectInto(values, ranks, level, out, slots) {
  const n = values.length;
  if (n <= SORT_BELOW) {
    const sorted = values.slice().sort();
    ranks.forEach((r, i) => { out[slots[i]] = sorted[r]; });
    return;
  }
  const single = values instanceof Float32Array;
  const lastLevel = single ? 1 : 3;
  const digit = single ? digitOf32 : digitOf;
  const words = keyWords(values);
  const counts = new Uint32Array(RADIX);
  for (let i = 0; i < n; i += 1) counts[digit(words, i, level)] += 1;
  // Each rank's bucket and its rank within the bucket.
  const groups = new Map();
  let bucket = 0;
  let below = 0;
  ranks.forEach((rank, i) => {
    while (below + counts[bucket] <= rank) { below += counts[bucket]; bucket += 1; }
    if (!groups.has(bucket)) groups.set(bucket, { start: below, ranks: [], slots: [] });
    const group = groups.get(bucket);
    group.ranks.push(rank - below);
    group.slots.push(slots[i]);
  });
  const fill = new Int32Array(RADIX).fill(-1);
  const buffers = [];
  for (const [b, group] of groups) {
    fill[b] = buffers.length;
    buffers.push({ values: new values.constructor(counts[b]), length: 0, group });
  }
  for (let i = 0; i < n; i += 1) {
    const slot = fill[digit(words, i, level)];
    if (slot >= 0) {
      const target = buffers[slot];
      target.values[target.length++] = values[i];
    }
  }
  for (const { values: part, group } of buffers) {
    // Every value of a bucket at the last level has the same key: they are equal.
    if (level === lastLevel) group.ranks.forEach((_, i) => { out[group.slots[i]] = part[0]; });
    else selectInto(part, group.ranks, level + 1, out, group.slots);
  }
}

// The values of the given 0-based ranks (any order, repeats allowed), as a sort would place them.
export function orderStatistics(values, ranks) {
  const out = new Float64Array(ranks.length);
  if (!ranks.length) return out;
  for (const r of ranks) if (!(r >= 0 && r < values.length && Number.isInteger(r))) throw new RangeError(`Rank ${r} is outside 0…${values.length - 1}.`);
  const order = ranks.map((r, i) => [r, i]).sort((a, b) => a[0] - b[0]);
  selectInto(values, order.map((o) => o[0]), 0, out, order.map((o) => o[1]));
  return out;
}

// R type 7 quantiles of unsorted values (no NaN): the same numbers as quantileSorted on the sorted
// values.
export function quantiles(values, probabilities) {
  const n = values.length;
  if (!n) return probabilities.map(() => Number.NaN);
  const positions = probabilities.map((q) => Math.min(Math.max(q, 0), 1) * (n - 1));
  const ranks = [];
  for (const pos of positions) ranks.push(Math.floor(pos), Math.min(n - 1, Math.floor(pos) + 1));
  const at = orderStatistics(values, ranks);
  return positions.map((pos, i) => {
    const lo = at[2 * i];
    return n === 1 ? lo : lo + (at[2 * i + 1] - lo) * (pos - Math.floor(pos));
  });
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
  return modeBetween(sorted, quantileSorted(sorted, 0.005), quantileSorted(sorted, 0.995), bins);
}

// The same for values in any order, given those percentiles.
function modeBetween(values, lo, hi, bins = 256) {
  if (!(hi > lo)) return lo;
  const counts = new Uint32Array(bins);
  const scale = bins / (hi - lo);
  for (let i = 0; i < values.length; i += 1) {
    const b = Math.floor((values[i] - lo) * scale);
    if (b >= 0 && b < bins) counts[b] += 1;
  }
  let best = 0;
  for (let b = 1; b < bins; b += 1) if (counts[b] > counts[best]) best = b;
  return lo + (best + 0.5) / scale;
}

const DESCRIBE_QUANTILES = [0.5, 0.1587, 0.8413, 0.005, 0.995, 0.01, 0.05, 0.25, 0.75, 0.95, 0.99];

// Every channel statistic at once. Returns an object keyed by statistic id. Order statistics are
// selected (orderStatistics), not sorted, so a population of millions takes a few passes.
export function describe(column, indices = null, options = {}) {
  const values = gather(column, indices);
  const n = values.length;
  if (!n) return { n: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const m = sum / n;
  const v = variance(values, m);
  const sd = Math.sqrt(v);
  const wanted = options.percentile !== undefined ? [...DESCRIBE_QUANTILES, options.percentile / 100] : DESCRIBE_QUANTILES;
  const [med, p16, p84, p005, p995, p1, p5, p25, p75, p95, p99, percentile] = quantiles(values, wanted);
  const rsd = (p84 - p16) / 2;
  const deviations = new Float64Array(n);
  for (let i = 0; i < n; i += 1) deviations[i] = Math.abs(values[i] - med);
  const geo = geometricMean(values);
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
    mad: quantiles(deviations, [0.5])[0],
    min,
    max,
    mode: modeBetween(values, p005, p995),
    p1,
    p5,
    p25,
    p75,
    p95,
    p99,
  };
  if (options.percentile !== undefined) result.percentile = percentile;
  if (options.threshold !== undefined) {
    let above = 0;
    for (let i = 0; i < n; i += 1) if (values[i] >= options.threshold) above += 1;
    result.positive = (100 * above) / n;
  }
  return result;
}

// The median, mean and robust SD only (the inspector's table): one selection pass, without the
// deviations, logarithms and histogram of describe.
export function summarize(column, indices = null) {
  // Float32 columns are selected as floats: the same values, half the memory and passes.
  const values = column instanceof Float32Array ? gather32(column, indices) : gather(column, indices);
  const n = values.length;
  if (!n) return { n: 0 };
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += values[i];
  const [median, p16, p84] = quantiles(values, [0.5, 0.1587, 0.8413]);
  return { n, median, mean: sum / n, rsd: (p84 - p16) / 2 };
}

// A single statistic, computed without the full description when cheap.
export function statistic(id, column, indices = null, options = {}) {
  if (id === 'mean') return mean(gather(column, indices));
  if (id === 'sd') return Math.sqrt(variance(gather(column, indices)));
  if (id === 'min' || id === 'max') {
    let lo = Infinity; let hi = -Infinity;
    forEachChunk(indices, column.length, (chunk, length) => {
      for (let i = 0; i < length; i += 1) {
        const v = column[chunk[i]];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    });
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

// A frequency in percent as plots label gates: 12.3%, 4.56%, 0.789%, 0.0012%.
export function formatPercent(p) {
  if (!Number.isFinite(p)) return '—';
  if (p >= 10) return `${p.toFixed(1)}%`;
  if (p >= 1) return `${p.toFixed(2)}%`;
  if (p >= 0.01) return `${p.toFixed(3)}%`;
  if (p === 0) return '0%';
  return `${p.toPrecision(2)}%`;
}

// Formats a statistic for display with sensible precision.
export function formatStatistic(id, value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '−∞';
  if (id === 'count') return Math.round(value).toLocaleString('en-US');
  if (id === 'countLow' || id === 'countHigh') return value >= 1000 ? Math.round(value).toLocaleString('en-US') : value.toFixed(value >= 10 ? 1 : 2);
  if (id === 'ksD') return value.toFixed(3);
  if (id.startsWith('freq') || PERCENT.has(id)) {
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
