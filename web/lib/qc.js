// Acquisition quality control. Every method is non-destructive: it returns a per-event mask
// (Uint8Array, 1 = keep) together with the tracks that explain what was flagged and why, so the
// UI can draw what would be removed and the user can overrule it.
//
//   peacoQC        PeacoQC (Emmaneel et al. 2022, Cytometry A, doi:10.1002/cyto.a.24501)
//   flowRateCheck  flowAI's flow-rate check (Monaco et al. 2016, Bioinformatics,
//                  doi:10.1093/bioinformatics/btw191)
//   marginEvents   events piled at the detector limits (as PeacoQC's RemoveMargins)
//   signalDrift    per-channel median drift over the acquisition
//   qcSummary      combined mask, a 0–100 score and plain-language findings

import { createRandom, sampleIndices } from './random.js';
import { quantileSorted } from './stats.js';
import { applyTransform, defaultTransform } from './transforms.js';

const EULER_GAMMA = 0.5772156649015329;
const MAD_SCALE = 1.4826;

// --- Shared helpers -------------------------------------------------------------------------

function checkAbort(options) {
  if (options.signal?.aborted) throw new Error('The quality-control analysis was cancelled.');
}

function report(options, fraction, message) {
  if (options.onProgress) options.onProgress(fraction, message);
}

function eventCountOf(sample) {
  if (Number.isInteger(sample.eventCount)) return sample.eventCount;
  const first = Object.values(sample.columns ?? {})[0];
  return first ? first.length : 0;
}

export function columnOf(sample, name) {
  const column = sample.columns?.[name];
  if (!column) throw new Error(`The sample has no channel named "${name}".`);
  return column;
}

function channelInfo(sample, name) {
  return sample.channels?.find((channel) => channel.name === name) ?? { name, type: 'fluorescence', range: 0 };
}

// Scatter and fluorescence channels: the ones whose signal says something about the cells.
export function signalChannels(sample) {
  return (sample.channels ?? []).filter((c) => c.type === 'scatter' || c.type === 'fluorescence').map((c) => c.name);
}

export function findTimeChannel(sample, options = {}) {
  if (options.timeChannel) {
    columnOf(sample, options.timeChannel);
    return options.timeChannel;
  }
  const channel = (sample.channels ?? []).find((c) => c.type === 'time' && sample.columns?.[c.name]);
  return channel ? channel.name : null;
}

// $TIMESTEP (seconds per time unit). flowAI assumes 0.01 s when the keyword is missing.
export function timestepOf(sample, options = {}) {
  if (options.timestep > 0) return { timestep: Number(options.timestep), assumed: false };
  const keyword = Number.parseFloat(sample.keywords?.$TIMESTEP);
  if (keyword > 0) return { timestep: keyword, assumed: false };
  return { timestep: 0.01, assumed: true };
}

function displayValues(sample, name, options) {
  const column = columnOf(sample, name);
  const spec = options.transforms?.[name]
    ?? defaultTransform(channelInfo(sample, name), options.technology ?? 'conventional', column);
  return { values: applyTransform(column, spec), spec };
}

export function median(values) {
  if (!values.length) return Number.NaN;
  return quantileSorted(Float64Array.from(values).sort(), 0.5);
}

// R's mad(): 1.4826 × the median absolute deviation from the median.
export function mad(values, center = median(values)) {
  const deviations = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) deviations[i] = Math.abs(values[i] - center);
  return MAD_SCALE * quantileSorted(deviations.sort(), 0.5);
}

// Theil–Sen line (Sen 1968): the median of pairwise slopes, intercept = median(y − slope·x).
export function theilSen(x, y) {
  const slopes = [];
  for (let i = 0; i < x.length; i += 1) {
    for (let j = i + 1; j < x.length; j += 1) {
      if (x[j] !== x[i]) slopes.push((y[j] - y[i]) / (x[j] - x[i]));
    }
  }
  const slope = slopes.length ? median(slopes) : 0;
  const residuals = new Float64Array(x.length);
  for (let i = 0; i < x.length; i += 1) residuals[i] = y[i] - slope * x[i];
  return { slope, intercept: median(residuals) };
}

function sortedInsert(window, size, value) {
  let lo = 0;
  let hi = size;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (window[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  window.copyWithin(lo + 1, lo, size);
  window[lo] = value;
}

function sortedRemove(window, size, value) {
  let lo = 0;
  let hi = size;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (window[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  window.copyWithin(lo, lo + 1, size);
}

// Running median of odd width k (as R's runmed). Ends: 'median' (default) uses the largest
// centred window that fits, with Tukey's end-point rule at the first and last point (as R's
// smoothEnds, which keeps a linear trend unbiased at the ends); 'constant' repeats the first and
// last full-window medians.
export function runningMedian(values, k, options = {}) {
  const n = values.length;
  const out = new Float64Array(n);
  if (!n) return out;
  let width = Math.max(1, Math.floor(k));
  if (width % 2 === 0) width += 1;
  if (width > n) width = n % 2 ? n : n - 1;
  const half = (width - 1) / 2;
  const window = new Float64Array(width);
  let size = 0;
  for (let i = 0; i < width; i += 1) sortedInsert(window, size++, values[i]);
  out[half] = window[half];
  for (let i = half + 1; i < n - half; i += 1) {
    sortedRemove(window, size--, values[i - half - 1]);
    sortedInsert(window, size++, values[i + half]);
    out[i] = window[half];
  }
  if (half === 0) return out;
  if ((options.endrule ?? 'median') === 'constant') {
    for (let i = 0; i < half; i += 1) {
      out[i] = out[half];
      out[n - 1 - i] = out[n - 1 - half];
    }
    return out;
  }
  // Shrinking centred windows 2j + 1 for j = 1 … half − 1, built incrementally.
  for (const side of [0, 1]) {
    const at = (i) => (side === 0 ? i : n - 1 - i);
    const grow = new Float64Array(width);
    let count = 0;
    sortedInsert(grow, count++, values[at(0)]);
    for (let j = 1; j < half; j += 1) {
      sortedInsert(grow, count++, values[at(2 * j - 1)]);
      sortedInsert(grow, count++, values[at(2 * j)]);
      out[at(j)] = grow[j];
    }
    if (n >= 3) {
      const s1 = out[at(1)];
      const s2 = out[at(2)];
      out[at(0)] = median3(values[at(0)], s1, 3 * s1 - 2 * s2);
    }
  }
  return out;
}

function median3(a, b, c) {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

// Counts events covered by the flagged half-open intervals [start, end) (bins are sorted by start).
function coveredEvents(bins, flagged) {
  let total = 0;
  let reach = 0;
  for (let b = 0; b < bins.length; b += 1) {
    if (!flagged[b]) continue;
    const start = Math.max(bins[b].start, reach);
    if (bins[b].end > start) {
      total += bins[b].end - start;
      reach = bins[b].end;
    }
  }
  return total;
}

// "41–44 s", or with a decimal when the stretch is short ("70.0–70.2 s").
function formatTimeRange(start, end) {
  const digits = end - start < 5 && Math.abs(end) < 1000 && Math.round(start) === Math.round(end) ? 1 : 0;
  return `${start.toFixed(digits)}–${end.toFixed(digits)} s`;
}

function formatPercent(value) {
  return value >= 10 ? value.toFixed(0) : value >= 1 ? value.toFixed(1) : value.toFixed(2);
}

// --- Kernel density and peak detection (PeacoQC's FindThemPeaks) ----------------------------

const DENSITY_POINTS = 512;
// smooth.spline(spar = 0.6) on 512 equally spaced density points corresponds to a penalty of
// λ ≈ r·256^(3·0.6 − 1) with r = tr(XᵀWX)/tr(Ω) ≈ 4.6e-7 on x ∈ [0, 1]; on the discrete grid that
// is a Whittaker (second-difference) smoother with λ ≈ λ·511³ ≈ 5000.
const DEFAULT_DENSITY_SMOOTHING = 5000;

// R's bw.nrd0 (Silverman's rule of thumb) of sorted values.
export function bandwidthNrd0(sorted) {
  const n = sorted.length;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += sorted[i];
  mean /= n;
  let ss = 0;
  for (let i = 0; i < n; i += 1) ss += (sorted[i] - mean) ** 2;
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
  let lo = Math.min(sd, iqr / 1.34);
  if (!(lo > 0)) lo = sd > 0 ? sd : Math.abs(sorted[0]) > 0 ? Math.abs(sorted[0]) : 1;
  return 0.9 * lo * n ** -0.2;
}

function createDensityWorkspace(lambda = DEFAULT_DENSITY_SMOOTHING) {
  const n = DENSITY_POINTS;
  return {
    binned: new Float64Array(n),
    conv: new Float64Array(n),
    kernel: new Float64Array(n),
    x: new Float64Array(n),
    y: new Float64Array(n),
    forward: new Float64Array(n),
    smoother: whittakerFactor(n, lambda),
  };
}

// Cholesky factor (bandwidth 2) of I + λ DᵀD, D the second-difference matrix.
function whittakerFactor(n, lambda) {
  const l0 = new Float64Array(n);
  const l1 = new Float64Array(n);
  const l2 = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const dtd = i === 0 || i === n - 1 ? 1 : i === 1 || i === n - 2 ? 5 : 6;
    const diag = 1 + lambda * dtd;
    const off1 = i >= 1 ? lambda * (i - 1 === 0 || i - 1 === n - 2 ? -2 : -4) : 0;
    const off2 = i >= 2 ? lambda : 0;
    const a = i >= 2 ? off2 / l0[i - 2] : 0;
    const b = i >= 1 ? (off1 - a * l1[i - 1]) / l0[i - 1] : 0;
    l2[i] = a;
    l1[i] = b;
    l0[i] = Math.sqrt(diag - a * a - b * b);
  }
  return { l0, l1, l2, n };
}

function whittakerSmooth(factor, y, out, work) {
  const { l0, l1, l2, n } = factor;
  for (let i = 0; i < n; i += 1) {
    let v = y[i];
    if (i >= 1) v -= l1[i] * work[i - 1];
    if (i >= 2) v -= l2[i] * work[i - 2];
    work[i] = v / l0[i];
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    let v = work[i];
    if (i + 1 < n) v -= l1[i + 1] * out[i + 1];
    if (i + 2 < n) v -= l2[i + 2] * out[i + 2];
    out[i] = v / l0[i];
  }
  return out;
}

// stats::density(x) with the defaults (Gaussian kernel, bw.nrd0, n = 512, cut = 3): linear
// binning on [lo, up] = [min − 7bw, max + 7bw], convolution with the kernel, interpolation onto
// [min − 3bw, max + 3bw]. Then smoothing (in place of smooth.spline) and clipping at zero.
function smoothedDensity(sorted, ws) {
  const n = sorted.length;
  const N = DENSITY_POINTS;
  const bw = bandwidthNrd0(sorted);
  const from = sorted[0] - 3 * bw;
  const to = sorted[n - 1] + 3 * bw;
  const lo = from - 4 * bw;
  const up = to + 4 * bw;
  const delta = (up - lo) / (N - 1);
  const { binned, conv, kernel, x, y } = ws;
  binned.fill(0);
  const weight = 1 / n;
  for (let i = 0; i < n; i += 1) {
    const pos = (sorted[i] - lo) / delta;
    const ix = Math.floor(pos);
    const fx = pos - ix;
    if (ix >= 0 && ix <= N - 2) {
      binned[ix] += weight * (1 - fx);
      binned[ix + 1] += weight * fx;
    } else if (ix === -1) binned[0] += weight * fx;
    else if (ix === N - 1) binned[ix] += weight * (1 - fx);
  }
  const reach = Math.min(N - 1, Math.ceil((8 * bw) / delta));
  const norm = 1 / (bw * Math.sqrt(2 * Math.PI));
  for (let d = 0; d <= reach; d += 1) {
    const z = (d * delta) / bw;
    kernel[d] = norm * Math.exp(-0.5 * z * z);
  }
  conv.fill(0);
  for (let j = 0; j < N; j += 1) {
    const mass = binned[j];
    if (mass === 0) continue;
    const i0 = Math.max(0, j - reach);
    const i1 = Math.min(N - 1, j + reach);
    for (let i = i0; i <= i1; i += 1) conv[i] += mass * kernel[i > j ? i - j : j - i];
  }
  const step = (to - from) / (N - 1);
  for (let i = 0; i < N; i += 1) {
    const xi = from + i * step;
    const pos = (xi - lo) / delta;
    const k = Math.min(N - 2, Math.floor(pos));
    const t = pos - k;
    x[i] = xi;
    y[i] = conv[k] * (1 - t) + conv[k + 1] * t;
  }
  whittakerSmooth(ws.smoother, y, conv, ws.forward);
  for (let i = 0; i < N; i += 1) y[i] = conv[i] > 0 ? conv[i] : 0;
  return { x, y, bw };
}

// PeacoQC's FindThemPeaks: local maxima of the smoothed density that are higher than
// `peakRemoval` × the highest density value. `sorted` is a sorted Float64Array.
export function findPeaks(sorted, options = {}, workspace = null) {
  if (sorted.length < 3) return [];
  const ws = workspace ?? createDensityWorkspace(options.densitySmoothing);
  const { x, y } = smoothedDensity(sorted, ws);
  let top = 0;
  for (let i = 0; i < y.length; i += 1) if (y[i] > top) top = y[i];
  const limit = (options.peakRemoval ?? 1 / 3) * top;
  const peaks = [];
  for (let i = 1; i < y.length - 1; i += 1) {
    if (y[i] - y[i - 1] > 0 && y[i + 1] - y[i] < 0 && y[i] > limit) peaks.push(x[i]);
  }
  return peaks;
}

// --- Isolation trees --------------------------------------------------------------------------

// Average path length of an unsuccessful search in a binary search tree of n points
// (Liu, Ting & Zhou 2008; PeacoQC's avgPL).
export function averagePathLength(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER_GAMMA) - (2 * (n - 1)) / n;
}

// PeacoQC's isolationTreeSD: one deterministic tree whose splits maximize the drop in standard
// deviation, gain = (sd − mean(sd_left, sd_right)) / sd, among all columns and split points. A
// node is split while it has more than 3 rows, is shallower than max_depth and the best gain
// exceeds `gainLimit` (PeacoQC's IT_limit). The largest leaf holds the good rows.
//
// With `coherence` (CytoWeave's refinement), a split is accepted only if the smaller side is
// coherent in time: at least that fraction of its rows (bins, in acquisition order) have a
// neighbouring row on the same side. Clogs and bursts span consecutive, half-overlapping bins;
// a split on a peak that flickers between bins scatters its smaller side through the whole run.
export function isolationTreeSD(columns, options = {}) {
  const nRows = columns.length ? columns[0].length : 0;
  const gainLimit = options.gainLimit ?? 0.6;
  const coherence = options.coherence ?? 0;
  const maxDepth = options.maxDepth ?? Math.ceil(Math.log2(Math.max(nRows, 2)));
  const nodes = [];
  const leafOf = new Int32Array(nRows);
  const buffer = new Float64Array(nRows);
  const queue = [{ rows: Uint32Array.from({ length: nRows }, (_, i) => i), depth: 0, parent: -1, side: '' }];
  while (queue.length) {
    const { rows, depth, parent, side } = queue.shift();
    const id = nodes.length;
    const node = { id, parent, depth, size: rows.length, left: -1, right: -1, column: -1, value: Number.NaN, gain: Number.NaN, pathLength: Number.NaN };
    nodes.push(node);
    if (parent >= 0) nodes[parent][side] = id;
    let best = gainLimit;
    const candidates = coherence > 0 ? [] : null;
    if (rows.length > 3 && depth < maxDepth) {
      const n = rows.length;
      const vals = buffer.subarray(0, n);
      for (let c = 0; c < columns.length; c += 1) {
        const column = columns[c];
        for (let i = 0; i < n; i += 1) vals[i] = column[rows[i]];
        vals.sort();
        let mean = 0;
        for (let i = 0; i < n; i += 1) mean += vals[i];
        mean /= n;
        let total = 0;
        let totalSq = 0;
        for (let i = 0; i < n; i += 1) {
          const v = vals[i] - mean;
          total += v;
          totalSq += v * v;
        }
        const base = Math.sqrt(Math.max(0, (totalSq - (total * total) / n) / (n - 1)));
        if (!(base > 0)) continue;
        let left = 0;
        let leftSq = 0;
        for (let i = 1; i < n; i += 1) {
          const v = vals[i - 1] - mean;
          left += v;
          leftSq += v * v;
          if (vals[i - 1] === vals[i]) continue;
          const nr = n - i;
          const sd1 = i > 1 ? Math.sqrt(Math.max(0, (leftSq - (left * left) / i) / (i - 1))) : 0;
          const right = total - left;
          const rightSq = totalSq - leftSq;
          const sd2 = nr > 1 ? Math.sqrt(Math.max(0, (rightSq - (right * right) / nr) / (nr - 1))) : 0;
          const gain = (base - (sd1 + sd2) / 2) / base;
          if (candidates && gain > gainLimit) candidates.push({ gain, column: c, value: vals[i - 1] });
          else if (gain > best) {
            best = gain;
            node.column = c;
            node.value = vals[i - 1];
            node.gain = gain;
          }
        }
      }
    }
    if (candidates?.length) {
      candidates.sort((a, b) => b.gain - a.gain);
      for (const candidate of candidates.slice(0, 64)) {
        if (timeCoherence(rows, columns[candidate.column], candidate.value, nRows) >= coherence) {
          node.column = candidate.column;
          node.value = candidate.value;
          node.gain = candidate.gain;
          break;
        }
      }
    }
    if (node.column >= 0) {
      const column = columns[node.column];
      let nLeft = 0;
      for (let i = 0; i < rows.length; i += 1) if (column[rows[i]] <= node.value) nLeft += 1;
      const leftRows = new Uint32Array(nLeft);
      const rightRows = new Uint32Array(rows.length - nLeft);
      let a = 0;
      let b = 0;
      for (let i = 0; i < rows.length; i += 1) {
        if (column[rows[i]] <= node.value) leftRows[a++] = rows[i];
        else rightRows[b++] = rows[i];
      }
      queue.push({ rows: leftRows, depth: depth + 1, parent: id, side: 'left' });
      queue.push({ rows: rightRows, depth: depth + 1, parent: id, side: 'right' });
    } else {
      node.pathLength = depth + averagePathLength(rows.length);
      for (let i = 0; i < rows.length; i += 1) leafOf[rows[i]] = id;
    }
  }
  let largest = -1;
  for (const node of nodes) {
    if (node.column < 0 && (largest < 0 || node.size > nodes[largest].size)) largest = node.id;
  }
  const good = new Uint8Array(nRows);
  for (let i = 0; i < nRows; i += 1) good[i] = leafOf[i] === largest ? 1 : 0;
  return { nodes, leafOf, good, largestLeaf: largest };
}

// The fraction of the smaller side of a split whose rows have a neighbouring row (in row order)
// on the same side.
function timeCoherence(rows, column, value, nRows) {
  let nLeft = 0;
  for (let i = 0; i < rows.length; i += 1) if (column[rows[i]] <= value) nLeft += 1;
  const smallerIsLeft = nLeft <= rows.length - nLeft;
  const side = new Uint8Array(nRows);
  let count = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const left = column[rows[i]] <= value;
    if (left === smallerIsLeft) {
      side[rows[i]] = 1;
      count += 1;
    }
  }
  if (!count) return 0;
  let connected = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (side[r] && ((r > 0 && side[r - 1]) || (r < nRows - 1 && side[r + 1]))) connected += 1;
  }
  return connected / count;
}

// Isolation Forest (Liu, Ting & Zhou 2008, ICDM, doi:10.1109/ICDM.2008.17): anomaly scores
// s = 2^(−E[h(x)] / c(ψ)) in (0, 1]; values near 1 are anomalies, well below 0.5 are normal.
// `columns` is an array of equally long numeric arrays (one per feature).
export function isolationForest(columns, options = {}) {
  const n = columns.length ? columns[0].length : 0;
  const d = columns.length;
  const scores = new Float64Array(n);
  if (!n || !d) return { scores };
  const trees = options.trees ?? 100;
  const psi = Math.min(options.sampleSize ?? 256, n);
  const limit = options.maxDepth ?? Math.ceil(Math.log2(Math.max(psi, 2)));
  const random = createRandom(options.seed ?? 20220516);
  const pathSum = new Float64Array(n);
  const cPsi = averagePathLength(psi);
  for (let t = 0; t < trees; t += 1) {
    const sample = sampleIndices(n, psi, random);
    // Flat tree: feature (−1 = leaf), split value, children, leaf size.
    const feature = [];
    const split = [];
    const left = [];
    const right = [];
    const size = [];
    const stack = [{ rows: sample, depth: 0, slot: -1, side: 0 }];
    while (stack.length) {
      const { rows, depth, slot, side } = stack.pop();
      const id = feature.length;
      if (slot >= 0) (side === 0 ? left : right)[slot] = id;
      feature.push(-1);
      split.push(0);
      left.push(-1);
      right.push(-1);
      size.push(rows.length);
      if (depth >= limit || rows.length <= 1) continue;
      // A random feature among those that still vary, and a uniform split within its range.
      const candidates = [];
      const ranges = [];
      for (let f = 0; f < d; f += 1) {
        let lo = Infinity;
        let hi = -Infinity;
        const column = columns[f];
        for (let i = 0; i < rows.length; i += 1) {
          const v = column[rows[i]];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi > lo) {
          candidates.push(f);
          ranges.push([lo, hi]);
        }
      }
      if (!candidates.length) continue;
      const pick = random.int(candidates.length);
      const f = candidates[pick];
      const [lo, hi] = ranges[pick];
      const value = lo + random() * (hi - lo);
      const column = columns[f];
      const a = [];
      const b = [];
      for (let i = 0; i < rows.length; i += 1) (column[rows[i]] < value ? a : b).push(rows[i]);
      feature[id] = f;
      split[id] = value;
      stack.push({ rows: b, depth: depth + 1, slot: id, side: 1 });
      stack.push({ rows: a, depth: depth + 1, slot: id, side: 0 });
    }
    for (let i = 0; i < n; i += 1) {
      let node = 0;
      let depth = 0;
      while (feature[node] >= 0) {
        node = columns[feature[node]][i] < split[node] ? left[node] : right[node];
        depth += 1;
      }
      pathSum[i] += depth + averagePathLength(size[node]);
    }
    checkAbort(options);
  }
  for (let i = 0; i < n; i += 1) scores[i] = 2 ** (-(pathSum[i] / trees) / cPsi);
  return { scores };
}

// --- PeacoQC ------------------------------------------------------------------------------------

// PeacoQC's FindEventsPerBin: about max_bins/2 non-overlapping bins (max_bins overlapping ones),
// rounded up to the next multiple of `step`, and at least `min_cells`.
export function findEventsPerBin(nEvents, options = {}) {
  const minCells = options.minCells ?? 150;
  const maxBins = options.maxBins ?? 500;
  const step = options.step ?? 500;
  let maxCells = Math.ceil((nEvents / maxBins) * 2);
  maxCells = Math.floor(maxCells / step) * step + step;
  return Math.max(minCells, maxCells);
}

// PeacoQC's SplitWithOverlap: bins of `eventsPerBin` consecutive events that overlap by half.
export function makeBins(nEvents, eventsPerBin) {
  const overlap = Math.ceil(eventsPerBin / 2);
  const stride = Math.max(1, eventsPerBin - overlap);
  const bins = [];
  for (let start = 0; start < nEvents; start += stride) bins.push({ start, end: Math.min(nEvents, start + eventsPerBin) });
  return bins;
}

// PeacoQC's DetermineAllPeaks: the number of peaks is the largest count found in at least
// `minPercent` % of the bins; the median positions of those peaks seed a 1-D k-means of every
// bin's peaks; per cluster and bin the peak nearest the cluster median is kept, and bins without
// a peak in a cluster get the cluster median.
// With `tolerance` (CytoWeave's refinement, on by default), a bin's peak joins a trajectory only
// when it lies closer to that trajectory's median than half the distance to the neighbouring
// trajectory (and within `maxJump` of the axis); otherwise the bin counts as having no such peak.
// Without it, a peak of another population in a bin where the minor peak was not found is
// assigned to the minor peak's trajectory as its nearest cluster, and the jump looks like an
// acquisition anomaly.
function trackPeaks(binPeaks, minPercent, options = {}) {
  const nBins = binPeaks.length;
  const frequency = new Map();
  for (const peaks of binPeaks) frequency.set(peaks.length, (frequency.get(peaks.length) ?? 0) + 1);
  const limit = (minPercent / 100) * nBins;
  let k = 0;
  for (const [count, f] of frequency) if (count > 0 && f >= limit && count > k) k = count;
  if (!k) {
    let best = 0;
    for (const [count, f] of frequency) if (count > 0 && f > best) { best = f; k = count; }
  }
  if (!k) return null;
  const centers = new Float64Array(k);
  for (let j = 0; j < k; j += 1) {
    const values = [];
    for (const peaks of binPeaks) if (peaks.length === k) values.push(peaks[j]);
    centers[j] = median(values);
  }
  const flatValues = [];
  const flatBins = [];
  binPeaks.forEach((peaks, b) => peaks.forEach((p) => { flatValues.push(p); flatBins.push(b); }));
  const assign = new Int32Array(flatValues.length).fill(-1);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    let changed = false;
    for (let i = 0; i < flatValues.length; i += 1) {
      let best = 0;
      for (let j = 1; j < k; j += 1) if (Math.abs(flatValues[i] - centers[j]) < Math.abs(flatValues[i] - centers[best])) best = j;
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    if (!changed) break;
    const sums = new Float64Array(k);
    const counts = new Float64Array(k);
    for (let i = 0; i < flatValues.length; i += 1) { sums[assign[i]] += flatValues[i]; counts[assign[i]] += 1; }
    for (let j = 0; j < k; j += 1) if (counts[j]) centers[j] = sums[j] / counts[j];
  }
  const order = Array.from({ length: k }, (_, j) => j).sort((a, b) => centers[a] - centers[b]);
  const trajectories = [];
  const medians = [];
  const present = [];
  const sortedCenters = order.map((j) => centers[j]);
  for (const [rank, j] of order.entries()) {
    const members = [];
    for (let i = 0; i < flatValues.length; i += 1) if (assign[i] === j) members.push(flatValues[i]);
    if (!members.length) continue;
    const m = median(members);
    let tolerance = Infinity;
    if (options.tolerance !== false) {
      const below = rank > 0 ? (sortedCenters[rank] - sortedCenters[rank - 1]) / 2 : Infinity;
      const above = rank < k - 1 ? (sortedCenters[rank + 1] - sortedCenters[rank]) / 2 : Infinity;
      tolerance = Math.min(below, above, options.maxJump ?? 0.15);
    }
    const track = new Float64Array(nBins).fill(Number.NaN);
    for (let i = 0; i < flatValues.length; i += 1) {
      if (assign[i] !== j || Math.abs(flatValues[i] - m) > tolerance) continue;
      const b = flatBins[i];
      if (Number.isNaN(track[b]) || Math.abs(flatValues[i] - m) < Math.abs(track[b] - m)) track[b] = flatValues[i];
    }
    const has = new Uint8Array(nBins);
    for (let b = 0; b < nBins; b += 1) {
      if (Number.isNaN(track[b])) track[b] = m;
      else has[b] = 1;
    }
    trajectories.push(track);
    medians.push(m);
    present.push(has);
  }
  return { trajectories, medians, present };
}

// R's ksmooth(kernel = 'box') at the data points 1…n: the mean of the points within ±bandwidth/2.
export function boxSmooth(values, bandwidth = 50) {
  const n = values.length;
  const half = Math.floor(bandwidth / 2 + 1e-9);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i] + values[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    out[i] = (prefix[b + 1] - prefix[a]) / (b - a + 1);
  }
  return out;
}

// PeacoQC's MADOutliers on one trajectory: smoothed values beyond median ± MAD × mad.
//
// With `localize` (CytoWeave's refinement, on by default), each run of flagged bins is narrowed to
// the bins whose own value (a 5-bin running median) leaves the band median ± `rawLimit` × the
// trajectory's noise SD (from successive differences), plus one bin either side. The box smoother
// spreads a short clog over ±bandwidth/2 bins; without this step the clean events around it are
// removed too. A flagged run with no such bin is a smoothing artifact and is kept.
// The Theil–Sen line through (bin, track value), evaluated at every bin.
function theilSenTrend(track) {
  const x = Float64Array.from(track, (_, i) => i);
  const { slope, intercept } = theilSen(x, track);
  return Float64Array.from(x, (i) => intercept + slope * i);
}

function madOutliers(track, madLimit, bandwidth, options = {}) {
  const smooth = boxSmooth(track, bandwidth);
  const center = median(smooth);
  const spread = mad(smooth, center);
  const flagged = new Uint8Array(track.length);
  if (!(spread > 0)) return { flagged, smooth, lower: center, upper: center, skipped: true };
  const lower = center - madLimit * spread;
  const upper = center + madLimit * spread;
  for (let i = 0; i < track.length; i += 1) if (smooth[i] > upper || smooth[i] < lower) flagged[i] = 1;
  if (options.localize === false) return { flagged, smooth, lower, upper, skipped: false };
  const n = track.length;
  const diffs = new Float64Array(Math.max(0, n - 1));
  for (let i = 1; i < n; i += 1) diffs[i - 1] = track[i] - track[i - 1];
  const noise = (mad(diffs, median(diffs)) / Math.SQRT2) || spread;
  // Deviations are measured from a robust linear trend (Theil–Sen) rather than from the median:
  // a slow, steady drift then flags nothing at the start and end of the run (drift is reported
  // separately), while clogs and bubbles, which are local, still stand out from the trend.
  const trend = theilSenTrend(track);
  const local = runningMedian(track, 5);
  // Peak positions are quantized to the density grid, and a population piled near a fixed value
  // (a detector floor, or the negatives of a compensated channel below the scale) gives a track
  // that is mostly flat with single-step jumps: its noise estimate is then ~0 and one grid step
  // would count. Shifts under minShift (1.5% of the axis) are never a clog or a bubble.
  const limit = Math.max((options.rawLimit ?? 4) * noise, options.minShift ?? 0.015);
  const refined = new Uint8Array(n);
  for (let b = 0; b < n;) {
    if (!flagged[b]) { b += 1; continue; }
    let e = b;
    while (e < n && flagged[e]) e += 1;
    for (let i = b; i < e; i += 1) {
      if (Math.abs(local[i] - trend[i]) > limit) {
        for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j += 1) refined[j] = 1;
      }
    }
    b = e;
  }
  return { flagged: refined, smooth, lower, upper, skipped: false, noise };
}

// PeacoQC (Emmaneel et al. 2022). Events are split into overlapping bins of consecutive events;
// in each bin and channel the density peaks are found; the peak trajectories over the bins are
// screened by an isolation tree (IT) and by MAD on smoothed trajectories; good stretches shorter
// than `consecutiveBins` are also removed. An event is removed when any bin containing it is.
//
// Options (PeacoQC argument in brackets): channels, transforms { [name]: spec }, technology,
// mad (MAD = 6), itLimit (IT_limit = 0.6), consecutiveBins (consecutive_bins = 5), eventsPerBin,
// minCells (150), maxBins (500), step (500), forceIT (force_IT = 150), peakRemoval
// (peak_removal = 1/3), minPeakBinsPercent (min_nr_bins_peakdetection = 10), removeZeros
// (remove_zeros = false), method ('all' | 'IT' | 'MAD', determine_good_cells), isolation
// ('sd-tree' = PeacoQC's isolationTreeSD | 'forest' = seeded Isolation Forest, score > itLimit),
// madBandwidth (ksmooth bandwidth 50), densitySmoothing, seed, timestep, onProgress, signal.
export function peacoQC(sample, options = {}) {
  const nEvents = eventCountOf(sample);
  const channels = options.channels?.length ? options.channels : signalChannels(sample);
  if (!channels.length) throw new Error('PeacoQC needs at least one scatter or fluorescence channel.');
  const madLimit = options.mad ?? 6;
  const itLimit = options.itLimit ?? 0.6;
  const consecutiveBins = options.consecutiveBins ?? 5;
  const forceIT = options.forceIT ?? 150;
  const method = options.method ?? 'all';
  const removeZeros = options.removeZeros ?? false;
  // 'refined' (default) adds CytoWeave's peak-tracking tolerance and MAD localization;
  // 'classic' follows PeacoQC as published.
  const classic = options.mode === 'classic';
  const warnings = [];

  let countForBins = nEvents;
  if (removeZeros) {
    for (const name of channels) {
      const column = columnOf(sample, name);
      let nonZero = 0;
      for (let i = 0; i < column.length; i += 1) if (column[i] !== 0) nonZero += 1;
      countForBins = Math.min(countForBins, nonZero);
    }
  }
  const eventsPerBin = options.eventsPerBin ?? findEventsPerBin(countForBins, options);
  const bins = makeBins(nEvents, eventsPerBin);
  const nBins = bins.length;
  const mask = new Uint8Array(nEvents).fill(1);

  const timeName = findTimeChannel(sample, options);
  const { timestep } = timestepOf(sample, options);
  const time = timeName ? columnOf(sample, timeName) : null;
  if (time) {
    let decreasing = 0;
    for (let i = 1; i < time.length; i += 1) if (time[i] < time[i - 1]) decreasing += 1;
    if (decreasing) warnings.push(`The time channel decreases ${decreasing} time(s); the events may not be in acquisition order.`);
  }
  for (const bin of bins) {
    bin.removedBy = [];
    if (time) bin.time = [time[bin.start] * timestep, time[bin.end - 1] * timestep];
  }

  const empty = (reason) => {
    warnings.push(reason);
    return {
      mask, binSize: eventsPerBin, eventsPerBin, bins, channelTracks: {}, features: [], percentRemoved: 0, removed: 0,
      byMethod: { isolationTree: { bins: 0, events: 0, percent: 0 }, mad: { bins: 0, events: 0, percent: 0 }, consecutive: { bins: 0, events: 0, percent: 0 } },
      itPerformed: false, episodes: [], warnings, timeChannel: timeName, timestep,
    };
  };
  if (nBins < Math.max(3, 2 * consecutiveBins)) {
    return empty(`PeacoQC needs more events: ${nEvents} events make only ${nBins} bins of ${eventsPerBin}.`);
  }

  // Peak trajectories per channel.
  const ws = createDensityWorkspace(options.densitySmoothing);
  const peakOptions = { peakRemoval: options.peakRemoval ?? 1 / 3 };
  const channelTracks = {};
  const features = [];
  const featureColumns = [];
  const binBuffer = new Float64Array(eventsPerBin);
  channels.forEach((name, c) => {
    checkAbort(options);
    report(options, (0.8 * c) / channels.length, `Finding peaks in ${name}`);
    const { values, spec } = displayValues(sample, name, options);
    const keep = (v) => Number.isFinite(v) && (!removeZeros || v !== 0);
    const raw = columnOf(sample, name);
    let full = new Float64Array(values.length);
    let k = 0;
    for (let i = 0; i < values.length; i += 1) if (keep(raw[i]) && Number.isFinite(values[i])) full[k++] = values[i];
    full = full.subarray(0, k).sort();
    const fullPeaks = findPeaks(full, peakOptions, ws);
    if (!fullPeaks.length) {
      warnings.push(`No density peak was found in ${name}; it was left out.`);
      return;
    }
    const binPeaks = bins.map((bin) => {
      let m = 0;
      for (let i = bin.start; i < bin.end; i += 1) if (keep(raw[i]) && Number.isFinite(values[i])) binBuffer[m++] = values[i];
      return findPeaks(binBuffer.subarray(0, m).sort(), peakOptions, ws);
    });
    const tracked = trackPeaks(binPeaks, options.minPeakBinsPercent ?? 10, { tolerance: !classic, maxJump: options.maxJump });
    if (!tracked) {
      warnings.push(`No stable peaks were found in ${name}; it was left out.`);
      return;
    }
    channelTracks[name] = {
      transform: spec,
      fullPeaks,
      medians: tracked.medians,
      peaks: tracked.trajectories.map((t) => Float32Array.from(t)),
      present: tracked.present,
      madContribution: 0,
    };
    tracked.trajectories.forEach((track, j) => {
      features.push({ channel: name, peak: j });
      featureColumns.push(track);
    });
  });
  if (!featureColumns.length) return empty('No channel had density peaks to follow.');

  // Isolation tree on all trajectories.
  checkAbort(options);
  report(options, 0.85, 'Isolation tree');
  const goodIT = new Uint8Array(nBins).fill(1);
  let itPerformed = false;
  let isolation = null;
  if ((method === 'all' || method === 'IT') && nBins >= forceIT) {
    itPerformed = true;
    if ((options.isolation ?? 'sd-tree') === 'forest') {
      const { scores } = isolationForest(featureColumns, { seed: options.seed, trees: options.trees, sampleSize: options.sampleSize, signal: options.signal });
      for (let b = 0; b < nBins; b += 1) goodIT[b] = scores[b] > itLimit ? 0 : 1;
      isolation = { method: 'forest', scores };
    } else {
      const tree = isolationTreeSD(featureColumns, { gainLimit: itLimit, maxDepth: options.maxDepth, coherence: classic ? 0 : options.coherence ?? 0.8 });
      goodIT.set(tree.good);
      isolation = { method: 'sd-tree', nodes: tree.nodes, largestLeaf: tree.largestLeaf };
    }
  } else if (method === 'all' || method === 'IT') {
    warnings.push(`The isolation tree was skipped: ${nBins} bins are fewer than ${forceIT} (force_IT).`);
  }

  // MAD on the smoothed trajectories of the bins the tree kept.
  report(options, 0.9, 'MAD outliers');
  const badMAD = new Uint8Array(nBins);
  const kept = [];
  for (let b = 0; b < nBins; b += 1) if (goodIT[b]) kept.push(b);
  const madTracks = [];
  if ((method === 'all' || method === 'MAD') && kept.length > 2) {
    featureColumns.forEach((track, f) => {
      const sub = new Float64Array(kept.length);
      for (let i = 0; i < kept.length; i += 1) sub[i] = track[kept[i]];
      const result = madOutliers(sub, madLimit, options.madBandwidth ?? 50, { localize: !classic, rawLimit: options.rawLimit });
      let count = 0;
      for (let i = 0; i < kept.length; i += 1) {
        if (result.flagged[i]) {
          badMAD[kept[i]] = 1;
          count += 1;
        }
      }
      const smooth = new Float32Array(nBins).fill(Number.NaN);
      for (let i = 0; i < kept.length; i += 1) smooth[kept[i]] = result.smooth[i];
      madTracks.push({ ...features[f], smooth, lower: result.lower, upper: result.upper, flaggedBins: count, skipped: result.skipped });
      const entry = channelTracks[features[f].channel];
      entry.madContribution += (100 * count) / kept.length;
      if (!entry.mad) entry.mad = [];
      entry.mad.push({ smooth, lower: result.lower, upper: result.upper, skipped: result.skipped });
    });
  }

  // Good stretches shorter than consecutiveBins are removed too (PeacoQC's RemoveShortRegions).
  const good = new Uint8Array(nBins);
  for (let b = 0; b < nBins; b += 1) good[b] = goodIT[b] && !badMAD[b] ? 1 : 0;
  const badConsecutive = new Uint8Array(nBins);
  for (let b = 0; b < nBins;) {
    let e = b;
    while (e < nBins && good[e] === good[b]) e += 1;
    if (good[b] && e - b < consecutiveBins) for (let i = b; i < e; i += 1) badConsecutive[i] = 1;
    b = e;
  }
  const badIT = new Uint8Array(nBins);
  const bad = new Uint8Array(nBins);
  for (let b = 0; b < nBins; b += 1) {
    badIT[b] = goodIT[b] ? 0 : 1;
    bad[b] = badIT[b] || badMAD[b] || badConsecutive[b] ? 1 : 0;
    if (badIT[b]) bins[b].removedBy.push('isolationTree');
    if (badMAD[b]) bins[b].removedBy.push('mad');
    if (badConsecutive[b]) bins[b].removedBy.push('consecutive');
    if (bad[b]) mask.fill(0, bins[b].start, bins[b].end);
  }
  let removed = 0;
  for (let i = 0; i < nEvents; i += 1) if (!mask[i]) removed += 1;
  const methodSummary = (flags) => {
    let count = 0;
    for (let b = 0; b < nBins; b += 1) count += flags[b];
    const events = coveredEvents(bins, flags);
    return { bins: count, events, percent: nEvents ? (100 * events) / nEvents : 0 };
  };

  const episodes = describeEpisodes(bins, bad, good, featureColumns, features, mask, time, timestep);
  report(options, 1, 'Done');
  return {
    mask,
    binSize: eventsPerBin,
    eventsPerBin,
    bins,
    channelTracks,
    features,
    madTracks,
    isolation,
    itPerformed,
    removed,
    percentRemoved: nEvents ? (100 * removed) / nEvents : 0,
    byMethod: { isolationTree: methodSummary(badIT), mad: methodSummary(badMAD), consecutive: methodSummary(badConsecutive) },
    episodes,
    warnings,
    timeChannel: timeName,
    timestep,
    parameters: { mode: classic ? 'classic' : 'refined', mad: madLimit, itLimit, consecutiveBins, forceIT, method, removeZeros, peakRemoval: peakOptions.peakRemoval },
  };
}

// Runs of removed bins, with the channel whose peaks moved most and in which direction.
function describeEpisodes(bins, bad, good, featureColumns, features, mask, time, timestep) {
  const centers = featureColumns.map((track) => {
    const values = [];
    for (let b = 0; b < bins.length; b += 1) if (good[b]) values.push(track[b]);
    const center = values.length ? median(values) : median(track);
    const spread = values.length > 2 ? mad(values, center) : 0;
    return { center, spread };
  });
  const episodes = [];
  for (let b = 0; b < bins.length;) {
    if (!bad[b]) { b += 1; continue; }
    let e = b;
    while (e + 1 < bins.length && bad[e + 1]) e += 1;
    const startEvent = bins[b].start;
    const endEvent = bins[e].end;
    let removed = 0;
    for (let i = startEvent; i < endEvent; i += 1) if (!mask[i]) removed += 1;
    let bestFeature = -1;
    let bestShift = 0;
    let bestScore = 0;
    featureColumns.forEach((track, f) => {
      let sum = 0;
      for (let i = b; i <= e; i += 1) sum += track[i];
      const shift = sum / (e - b + 1) - centers[f].center;
      const score = Math.abs(shift) / (centers[f].spread || 1e-9);
      if (score > bestScore) { bestScore = score; bestShift = shift; bestFeature = f; }
    });
    const reasons = new Set();
    for (let i = b; i <= e; i += 1) bins[i].removedBy.forEach((r) => reasons.add(r));
    episodes.push({
      startBin: b,
      endBin: e,
      startEvent,
      endEvent,
      startTime: time ? time[startEvent] * timestep : null,
      endTime: time ? time[endEvent - 1] * timestep : null,
      removed,
      channel: bestFeature >= 0 ? features[bestFeature].channel : null,
      direction: bestShift < 0 ? 'drop' : bestShift > 0 ? 'rise' : 'none',
      shift: bestShift,
      reasons: [...reasons],
    });
    b = e + 1;
  }
  return episodes;
}

// --- Student t quantiles (for the generalized ESD test) -------------------------------------

const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

export function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i += 1) a += LANCZOS[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// Regularized incomplete beta I_x(a, b) by its continued fraction (modified Lentz).
export function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x)) / a;
  const TINY = 1e-300;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 400; i += 1) {
    const m = i >> 1;
    let numerator;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-15) break;
  }
  return front * (f - 1);
}

// Upper tail P(T > t) of Student's t with df degrees of freedom, t ≥ 0.
function studentTUpper(t, df) {
  return 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
}

// The p-quantile of Student's t (qt(p, df)), by safeguarded Newton iteration on the tail.
export function studentTQuantile(p, df) {
  if (!(df > 0)) return Number.NaN;
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  if (p >= 1) return Infinity;
  const q = 1 - p;
  let lo = 0;
  let hi = 1;
  while (studentTUpper(hi, df) > q) {
    lo = hi;
    hi *= 2;
    if (hi > 1e12) return hi;
  }
  const logDensityConst = logGamma((df + 1) / 2) - logGamma(df / 2) - 0.5 * Math.log(df * Math.PI);
  let t = (lo + hi) / 2;
  for (let i = 0; i < 200; i += 1) {
    const g = studentTUpper(t, df) - q;
    if (g > 0) lo = t;
    else hi = t;
    const density = Math.exp(logDensityConst - ((df + 1) / 2) * Math.log1p((t * t) / df));
    let next = t + g / density;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - t) <= 1e-12 * Math.max(1, t)) return next;
    t = next;
  }
  return t;
}

// Generalized ESD test for up to `maxOutliers` outliers (Rosner 1983, Technometrics,
// doi:10.1080/00401706.1983.10487848). With robust = true (default) the centre and spread are
// the median and MAD, as in flowAI's anomaly_detection (after Twitter's S-H-ESD).
export function generalizedESD(values, options = {}) {
  const n = values.length;
  const alpha = options.alpha ?? 0.01;
  const robust = options.robust ?? true;
  const maxOutliers = Math.max(0, Math.min(n - 3, options.maxOutliers ?? Math.floor(n * 0.2)));
  const order = Uint32Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const sorted = new Float64Array(n);
  for (let i = 0; i < n; i += 1) sorted[i] = values[order[i]];
  let lo = 0;
  let hi = n - 1;
  let mean0 = 0;
  for (let i = 0; i < n; i += 1) mean0 += sorted[i];
  mean0 = n ? mean0 / n : 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    sum += sorted[i] - mean0;
    sumSq += (sorted[i] - mean0) ** 2;
  }
  const removedOrder = [];
  const statistics = [];
  const critical = [];
  let count = 0;
  for (let i = 1; i <= maxOutliers; i += 1) {
    const m = hi - lo + 1;
    let center;
    let spread;
    if (robust) {
      center = (sorted[lo + ((m - 1) >> 1)] + sorted[lo + (m >> 1)]) / 2;
      spread = MAD_SCALE * medianDeviation(sorted, lo, hi, center);
    } else {
      center = mean0 + sum / m;
      spread = Math.sqrt(Math.max(0, (sumSq - (sum * sum) / m) / (m - 1)));
    }
    if (!(spread > 0)) break;
    const low = center - sorted[lo];
    const high = sorted[hi] - center;
    const takeHigh = high >= low;
    const index = takeHigh ? hi : lo;
    const r = (takeHigh ? high : low) / spread;
    const v = sorted[index] - mean0;
    sum -= v;
    sumSq -= v * v;
    if (takeHigh) hi -= 1;
    else lo += 1;
    const pp = 1 - alpha / (2 * (n - i + 1));
    const t = studentTQuantile(pp, n - i - 1);
    const lambda = ((n - i) * t) / Math.sqrt((n - i - 1 + t * t) * (n - i + 1));
    removedOrder.push(order[index]);
    statistics.push(r);
    critical.push(lambda);
    if (r > lambda) count = i;
  }
  return {
    outliers: Uint32Array.from(removedOrder.slice(0, count)),
    statistics: Float64Array.from(statistics),
    critical: Float64Array.from(critical),
  };
}

// Median of |sorted[i] − center| for i in [lo, hi], by merging the two sorted deviation runs.
function medianDeviation(sorted, lo, hi, center) {
  const m = hi - lo + 1;
  let split = lo;
  while (split <= hi && sorted[split] < center) split += 1;
  let left = split - 1;
  let right = split;
  const a = (m - 1) >> 1;
  const b = m >> 1;
  let valueA = 0;
  let valueB = 0;
  for (let k = 0; k <= b; k += 1) {
    let v;
    if (left >= lo && (right > hi || center - sorted[left] <= sorted[right] - center)) {
      v = center - sorted[left];
      left -= 1;
    } else {
      v = sorted[right] - center;
      right += 1;
    }
    if (k === a) valueA = v;
    if (k === b) valueB = v;
  }
  return (valueA + valueB) / 2;
}

// --- Flow rate (flowAI) -----------------------------------------------------------------------

// flowAI's flow-rate check: events are counted in time slices (0.1 s), and slices whose rate is
// anomalous by a robust generalized ESD test (α = 0.01) are removed with their events. The rate
// (events per second) is used rather than the count so a short last slice is not penalized;
// options.detrend subtracts a running-median trend first (flowAI uses a CF-filter trend whose
// effect on the test is nearly nil, so the default is off).
export function flowRateCheck(sample, options = {}) {
  const timeName = findTimeChannel(sample, options);
  if (!timeName) throw new Error('The flow-rate check needs a time channel, and this sample has none.');
  const time = columnOf(sample, timeName);
  const n = time.length;
  const { timestep, assumed } = timestepOf(sample, options);
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const t = time[i] * timestep;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  if (!n || !Number.isFinite(tMin)) throw new Error('The time channel has no finite values.');
  const span = tMax - tMin;
  let slice = options.sliceSeconds ?? 0.1;
  const maxSlices = options.maxSlices ?? 20000;
  if (span / slice > maxSlices) slice = span / maxSlices;
  // The last slice absorbs the remainder (it lasts one to two slices), so no slice is short.
  const nSlices = Math.max(1, Math.floor(span / slice + 1e-9));
  const counts = new Float64Array(nSlices);
  const sliceOf = (t) => Math.min(nSlices - 1, Math.max(0, Math.floor((t * timestep - tMin) / slice)));
  for (let i = 0; i < n; i += 1) counts[sliceOf(time[i])] += 1;
  const rate = new Float64Array(nSlices);
  for (let s = 0; s < nSlices; s += 1) {
    const duration = s === nSlices - 1 ? Math.max(span - s * slice, slice) : slice;
    rate[s] = counts[s] / duration;
  }
  const centerRate = median(rate);
  let tested = rate;
  let trend = null;
  if (options.detrend) {
    const width = options.trendWindow ?? Math.max(51, 2 * Math.floor(nSlices / 20) + 1);
    trend = runningMedian(rate, width);
    tested = new Float64Array(nSlices);
    for (let s = 0; s < nSlices; s += 1) tested[s] = rate[s] - trend[s] + centerRate;
  }
  const esd = generalizedESD(tested, { alpha: options.alpha ?? 0.01, maxOutliers: Math.floor((options.maxAnomalies ?? 0.2) * nSlices) });
  const flagged = new Uint8Array(nSlices);
  for (const s of esd.outliers) flagged[s] = 1;
  const mask = new Uint8Array(n).fill(1);
  let removed = 0;
  for (let i = 0; i < n; i += 1) {
    if (flagged[sliceOf(time[i])]) {
      mask[i] = 0;
      removed += 1;
    }
  }
  const episodes = [];
  for (let s = 0; s < nSlices;) {
    if (!flagged[s]) { s += 1; continue; }
    let e = s;
    while (e + 1 < nSlices && flagged[e + 1]) e += 1;
    let events = 0;
    let rateSum = 0;
    for (let k = s; k <= e; k += 1) { events += counts[k]; rateSum += rate[k]; }
    const meanRate = rateSum / (e - s + 1);
    episodes.push({
      startSlice: s,
      endSlice: e,
      startTime: tMin + s * slice,
      endTime: e === nSlices - 1 ? tMax : tMin + (e + 1) * slice,
      events,
      meanRate,
      direction: events === 0 ? 'gap' : meanRate < centerRate ? 'low' : 'high',
    });
    s = e + 1;
  }
  return {
    mask,
    timeChannel: timeName,
    timestep,
    timestepAssumed: assumed,
    sliceSeconds: slice,
    start: tMin,
    end: tMax,
    counts,
    rate,
    trend,
    medianRate: centerRate,
    flagged,
    episodes,
    removed,
    percentRemoved: n ? (100 * removed) / n : 0,
    test: esd,
  };
}

// --- Margin events --------------------------------------------------------------------------

// Events at the detector limits: at or above $PnR − 1 (saturated), or piled at the lowest value
// (at least `minPile` events share the channel minimum). Without $PnR, a pile at the observed
// maximum counts as saturation. options.upper / options.lower { [name]: value } override the
// limits. Run it on uncompensated data where possible: compensation moves saturated events off
// the limit. (PeacoQC's RemoveMargins also always drops the single lowest and highest event of
// every channel; that is not done here.)
export function marginEvents(sample, options = {}) {
  const n = eventCountOf(sample);
  const channels = options.channels?.length ? options.channels : signalChannels(sample);
  const minPile = options.minPile ?? 2;
  const mask = new Uint8Array(n).fill(1);
  const counts = {};
  for (const name of channels) {
    const column = columnOf(sample, name);
    const info = channelInfo(sample, name);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const v = column[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    let upperLimit = options.upper?.[name] ?? (info.range > 0 ? info.range - 1 : null);
    let lowerLimit = options.lower?.[name] ?? null;
    let upperCount = 0;
    let lowerCount = 0;
    const upperPile = upperLimit === null;
    const lowerPile = lowerLimit === null;
    if (upperPile) upperLimit = hi;
    if (lowerPile) lowerLimit = lo;
    for (let i = 0; i < n; i += 1) {
      const v = column[i];
      if (v >= upperLimit) upperCount += 1;
      else if (v <= lowerLimit) lowerCount += 1;
    }
    if (upperPile && upperCount < minPile) upperCount = 0;
    if (lowerPile && lowerCount < minPile) lowerCount = 0;
    if (upperCount || lowerCount) {
      for (let i = 0; i < n; i += 1) {
        const v = column[i];
        if ((upperCount && v >= upperLimit) || (lowerCount && v <= lowerLimit)) mask[i] = 0;
      }
    }
    counts[name] = {
      upper: upperCount,
      lower: lowerCount,
      upperLimit,
      lowerLimit,
      percentUpper: n ? (100 * upperCount) / n : 0,
      percentLower: n ? (100 * lowerCount) / n : 0,
    };
  }
  let removed = 0;
  for (let i = 0; i < n; i += 1) if (!mask[i]) removed += 1;
  return { mask, counts, removed, percentRemoved: n ? (100 * removed) / n : 0 };
}

// --- Signal drift ---------------------------------------------------------------------------

// Median per time bin per channel (linear values), a Theil–Sen trend through the bin medians,
// and the drift as the trend's fold change from the first to the last decile of the acquisition
// (with the empirical decile medians alongside). Without a time channel, event order is used.
export function signalDrift(sample, channels = null, options = {}) {
  const n = eventCountOf(sample);
  const names = channels?.length ? channels : signalChannels(sample);
  const nBins = Math.max(2, options.bins ?? 20);
  const minEvents = options.minEvents ?? 20;
  const threshold = options.foldThreshold ?? 1.2;
  const timeName = findTimeChannel(sample, options);
  const { timestep } = timestepOf(sample, options);
  const time = timeName ? columnOf(sample, timeName) : null;
  const at = (i) => (time ? time[i] * timestep : i);
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const t = at(i);
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const span = tMax - tMin || 1;
  const binOf = new Uint16Array(n);
  const binCounts = new Uint32Array(nBins);
  for (let i = 0; i < n; i += 1) {
    const b = Math.min(nBins - 1, Math.floor(((at(i) - tMin) / span) * nBins));
    binOf[i] = b;
    binCounts[b] += 1;
  }
  const offsets = new Uint32Array(nBins + 1);
  for (let b = 0; b < nBins; b += 1) offsets[b + 1] = offsets[b] + binCounts[b];
  const order = new Uint32Array(n);
  const fill = offsets.slice(0, nBins);
  for (let i = 0; i < n; i += 1) order[fill[binOf[i]]++] = i;
  const centers = new Float64Array(nBins);
  for (let b = 0; b < nBins; b += 1) centers[b] = tMin + ((b + 0.5) / nBins) * span;
  const tFirst = tMin + 0.05 * span;
  const tLast = tMin + 0.95 * span;
  const result = {};
  const drifted = [];
  for (const name of names) {
    checkAbort(options);
    const column = columnOf(sample, name);
    const medians = new Float64Array(nBins).fill(Number.NaN);
    const xs = [];
    const ys = [];
    for (let b = 0; b < nBins; b += 1) {
      const count = offsets[b + 1] - offsets[b];
      if (count < minEvents) continue;
      const values = new Float64Array(count);
      for (let k = 0; k < count; k += 1) values[k] = column[order[offsets[b] + k]];
      medians[b] = quantileSorted(values.sort(), 0.5);
      xs.push(centers[b]);
      ys.push(medians[b]);
    }
    const first = [];
    const last = [];
    for (let i = 0; i < n; i += 1) {
      const t = at(i);
      if (t < tMin + 0.1 * span) first.push(column[i]);
      else if (t >= tMin + 0.9 * span) last.push(column[i]);
    }
    const firstMedian = median(first);
    const lastMedian = median(last);
    const { slope, intercept } = xs.length >= 2 ? theilSen(xs, ys) : { slope: 0, intercept: ys[0] ?? Number.NaN };
    const startValue = intercept + slope * tFirst;
    const endValue = intercept + slope * tLast;
    const foldChange = startValue > 0 && endValue > 0 ? endValue / startValue : Number.NaN;
    const empiricalFoldChange = firstMedian > 0 && lastMedian > 0 ? lastMedian / firstMedian : Number.NaN;
    const isDrifted = Number.isFinite(foldChange) && Math.abs(Math.log2(foldChange)) >= Math.log2(threshold);
    if (isDrifted) drifted.push(name);
    result[name] = {
      medians,
      slope,
      intercept,
      startValue,
      endValue,
      foldChange,
      log2FoldChange: Number.isFinite(foldChange) ? Math.log2(foldChange) : Number.NaN,
      percentChange: Number.isFinite(foldChange) ? 100 * (foldChange - 1) : Number.NaN,
      firstDecileMedian: firstMedian,
      lastDecileMedian: lastMedian,
      empiricalFoldChange,
      drifted: isDrifted,
    };
  }
  return {
    timeUnit: time ? 's' : 'events',
    timeChannel: timeName,
    start: tMin,
    end: tMax,
    binCenters: centers,
    binCounts,
    channels: result,
    drifted,
    foldThreshold: threshold,
  };
}

// --- Summary --------------------------------------------------------------------------------

// Combines the masks of the QC methods that were run ({ peacoQC, flowRate, margins, drift }) into
// one mask, with per-method and unique removal counts, a 0–100 quality score and plain-language
// findings. Score: 100 − 2 per % of events removed (at most 60) − 3 per flow-rate episode (at
// most 15) − 5 per drifting channel (at most 20).
export function qcSummary(results = {}) {
  const methods = [
    ['peacoQC', results.peacoQC ?? results.peacoqc],
    ['flowRate', results.flowRate],
    ['margins', results.margins],
  ].filter(([, r]) => r?.mask);
  const n = methods.length ? methods[0][1].mask.length : (results.eventCount ?? 0);
  const mask = new Uint8Array(n).fill(1);
  for (const [name, r] of methods) {
    if (r.mask.length !== n) throw new Error(`The ${name} result is for a different number of events.`);
    for (let i = 0; i < n; i += 1) if (!r.mask[i]) mask[i] = 0;
  }
  let removed = 0;
  for (let i = 0; i < n; i += 1) if (!mask[i]) removed += 1;
  const byMethod = {};
  for (const [name, r] of methods) {
    let count = 0;
    let unique = 0;
    for (let i = 0; i < n; i += 1) {
      if (r.mask[i]) continue;
      count += 1;
      let other = false;
      for (const [otherName, o] of methods) if (otherName !== name && !o.mask[i]) { other = true; break; }
      if (!other) unique += 1;
    }
    byMethod[name] = { removed: count, percent: n ? (100 * count) / n : 0, unique };
  }
  const percentRemoved = n ? (100 * removed) / n : 0;
  const findings = [];
  const peaco = results.peacoQC ?? results.peacoqc;
  if (peaco?.episodes) {
    for (const episode of peaco.episodes) {
      const what = episode.direction === 'drop' ? 'A signal drop (possible clog)' : episode.direction === 'rise' ? 'A signal surge' : 'Unstable signal';
      const where = episode.startTime !== null
        ? `at ${formatTimeRange(episode.startTime, episode.endTime)}`
        : `in events ${episode.startEvent.toLocaleString('en-US')}–${episode.endEvent.toLocaleString('en-US')}`;
      const channel = episode.channel ? ` in ${episode.channel}` : '';
      findings.push({ method: 'peacoQC', severity: 'warning', text: `${what}${channel} ${where} removed ${formatPercent((100 * episode.removed) / (n || 1))}% of events.` });
    }
  }
  const flow = results.flowRate;
  if (flow?.episodes) {
    for (const episode of flow.episodes) {
      const where = formatTimeRange(episode.startTime, episode.endTime);
      let text;
      if (episode.direction === 'gap') text = `No events were acquired at ${where} (a gap in the flow).`;
      else if (episode.direction === 'low') text = `The flow rate dropped at ${where} (possible clog or bubble); ${formatPercent((100 * episode.events) / (n || 1))}% of events removed.`;
      else text = `A burst of events at ${where}; ${formatPercent((100 * episode.events) / (n || 1))}% of events removed.`;
      findings.push({ method: 'flowRate', severity: 'warning', text });
    }
    if (flow.timestepAssumed) findings.push({ method: 'flowRate', severity: 'info', text: 'The file has no $TIMESTEP; 0.01 s per time unit was assumed.' });
  }
  const margins = results.margins;
  if (margins?.counts) {
    for (const [name, c] of Object.entries(margins.counts)) {
      if (c.percentUpper >= 0.1) findings.push({ method: 'margins', severity: c.percentUpper >= 1 ? 'warning' : 'info', text: `${name}: ${formatPercent(c.percentUpper)}% of events are saturated at the detector maximum.` });
      if (c.percentLower >= 0.1) findings.push({ method: 'margins', severity: c.percentLower >= 1 ? 'warning' : 'info', text: `${name}: ${formatPercent(c.percentLower)}% of events are piled at the lowest value.` });
    }
  }
  const drift = results.drift;
  const driftedChannels = drift?.drifted ?? [];
  for (const name of driftedChannels) {
    const d = drift.channels[name];
    const sign = d.percentChange >= 0 ? '+' : '−';
    findings.push({ method: 'drift', severity: 'warning', text: `${name} drifted ${sign}${Math.abs(d.percentChange).toFixed(0)}% from the start to the end of acquisition.` });
  }
  const flowEpisodes = flow?.episodes?.length ?? 0;
  const penalties = {
    removal: Math.min(60, 2 * percentRemoved),
    flowRate: Math.min(15, 3 * flowEpisodes),
    drift: Math.min(20, 5 * driftedChannels.length),
  };
  const score = Math.max(0, Math.round(100 - penalties.removal - penalties.flowRate - penalties.drift));
  const grade = score >= 90 ? 'good' : score >= 70 ? 'acceptable' : 'poor';
  findings.unshift({
    method: 'summary',
    severity: grade === 'good' ? 'info' : 'warning',
    text: n ? `Quality control keeps ${formatPercent(100 - percentRemoved)}% of ${n.toLocaleString('en-US')} events (score ${score}/100).` : `Quality score ${score}/100.`,
  });
  return { mask, kept: n - removed, removed, percentRemoved, byMethod, score, grade, penalties, findings };
}
