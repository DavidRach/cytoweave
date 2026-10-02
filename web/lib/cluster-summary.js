// What CytoWeave shows about clusters: per-cluster marker statistics and heatmaps, abundance per
// sample, agreement and stability between clusterings, rule-based annotation and marker
// enrichment labels.
//
// Event data come either as columns (an array of Float32Array, one per marker, as
// dataset.data) or as a dense row-major matrix { data, n, dim }. Labels are an Int32Array per
// event; labels outside 0…k−1 (e.g. −1 for unassigned) are ignored. Marker statistics are
// computed on the values given, so pass transformed (analysis-scale) values.

import { dendrogramLayout, distanceMatrix, hclust } from './flowsom.js';
import { quantileSorted } from './stats.js';

// ---------------------------------------------------------------------------------------------
// Per-cluster marker statistics

// Float32 bit patterns mapped to unsigned keys that sort in numeric order.
function sortKeys(column, n, keys) {
  const bits = new Uint32Array(column.buffer, column.byteOffset, n);
  for (let i = 0; i < n; i += 1) {
    const b = bits[i];
    keys[i] = b & 0x80000000 ? ~b >>> 0 : (b | 0x80000000) >>> 0;
  }
}

// Stable LSD radix argsort of 32-bit keys in three 11-bit passes.
function radixArgsort(keys, n, work) {
  let srcKeys = keys; let srcOrder = work.order;
  let dstKeys = work.keys2; let dstOrder = work.order2;
  const counts = work.counts;
  for (let i = 0; i < n; i += 1) srcOrder[i] = i;
  for (let shift = 0; shift < 33; shift += 11) {
    counts.fill(0);
    for (let i = 0; i < n; i += 1) counts[(srcKeys[i] >>> shift) & 0x7ff] += 1;
    let total = 0;
    for (let b = 0; b < 2048; b += 1) {
      const c = counts[b];
      counts[b] = total;
      total += c;
    }
    for (let i = 0; i < n; i += 1) {
      const key = srcKeys[i];
      const at = counts[(key >>> shift) & 0x7ff]++;
      dstKeys[at] = key;
      dstOrder[at] = srcOrder[i];
    }
    [srcKeys, dstKeys] = [dstKeys, srcKeys];
    [srcOrder, dstOrder] = [dstOrder, srcOrder];
  }
  return srcOrder;
}

function sourceShape(source, options) {
  if (Array.isArray(source)) {
    const columns = options.columns ?? source.map((_, i) => i);
    return { kind: 'columns', columns: columns.map((c) => source[c]), dim: columns.length };
  }
  if (source && source.data && Number.isInteger(source.dim)) return { kind: 'rows', ...source };
  throw new Error('Cluster statistics need event columns or a { data, n, dim } matrix.');
}

// Per-cluster statistics of every marker: count and frequency, median, mean and quartiles; the
// same quantiles over all other labeled events ("rest", the reference of marker enrichment);
// and over all labeled events, with the lower/upper percentiles used to scale heatmaps.
// Quantiles are R type 7 (median of an even count = mean of the middle two); non-finite values
// are left out. Options: columns (indices into a column array), markers (names, carried
// through), percentiles ([0.01, 0.99]).
// Returns { k, dim, markers, counts: Uint32Array(k), frequencies: Float64Array(k), medians,
// means, q1, q3: Float64Array(k × dim) (row = cluster), rest: { medians, q1, q3 }, overall:
// { median, mean, q1, q3, lower, upper }: Float64Array(dim) }.
export function clusterMedians(source, labels, k, options = {}) {
  const shape = sourceShape(source, options);
  const n = labels.length;
  const { dim } = shape;
  if (!Number.isInteger(k) || k < 1) throw new Error('The number of clusters must be at least 1.');
  if (shape.kind === 'rows' && shape.data.length < n * dim) throw new Error(`The data matrix must hold ${n} events × ${dim} markers.`);
  if (shape.kind === 'columns' && shape.columns.some((c) => !c || c.length < n)) {
    throw new Error(`Every marker column must hold the ${n} labeled events.`);
  }
  const [pLow, pHigh] = options.percentiles ?? [0.01, 0.99];
  const counts = new Uint32Array(k);
  let labeled = 0;
  for (let i = 0; i < n; i += 1) {
    const c = labels[i];
    if (c >= 0 && c < k) {
      counts[c] += 1;
      labeled += 1;
    }
  }
  const frequencies = new Float64Array(k);
  for (let c = 0; c < k; c += 1) frequencies[c] = labeled ? counts[c] / labeled : Number.NaN;

  const medians = new Float64Array(k * dim);
  const means = new Float64Array(k * dim);
  const q1 = new Float64Array(k * dim);
  const q3 = new Float64Array(k * dim);
  const rest = { medians: new Float64Array(k * dim), q1: new Float64Array(k * dim), q3: new Float64Array(k * dim) };
  const overall = {
    median: new Float64Array(dim), mean: new Float64Array(dim), q1: new Float64Array(dim),
    q3: new Float64Array(dim), lower: new Float64Array(dim), upper: new Float64Array(dim),
  };

  const keys = new Uint32Array(n);
  const work = { order: new Uint32Array(n), order2: new Uint32Array(n), keys2: new Uint32Array(n), counts: new Uint32Array(2048) };
  const sorted = new Float64Array(n);
  const sortedLabel = new Int32Array(n);
  const positions = new Uint32Array(n);
  const valid = new Float64Array(k);
  const sums = new Float64Array(k);
  const offsets = new Uint32Array(k + 1);
  const fill = new Uint32Array(k);
  const scratch = shape.kind === 'rows' ? new Float32Array(n) : null;

  for (let m = 0; m < dim; m += 1) {
    let column;
    if (shape.kind === 'rows') {
      for (let i = 0; i < n; i += 1) scratch[i] = shape.data[i * dim + m];
      column = scratch;
    } else {
      column = shape.columns[m] instanceof Float32Array ? shape.columns[m] : Float32Array.from(shape.columns[m].subarray?.(0, n) ?? shape.columns[m].slice(0, n));
    }
    sortKeys(column, n, keys);
    const order = radixArgsort(keys, n, work);
    valid.fill(0);
    sums.fill(0);
    let total = 0;
    for (let p = 0; p < n; p += 1) {
      const e = order[p];
      const c = labels[e];
      if (!(c >= 0 && c < k)) continue;
      const v = column[e];
      if (v - v !== 0) continue;
      sorted[total] = v;
      sortedLabel[total] = c;
      total += 1;
      valid[c] += 1;
      sums[c] += v;
    }
    offsets[0] = 0;
    for (let c = 0; c < k; c += 1) offsets[c + 1] = offsets[c] + valid[c];
    fill.set(offsets.subarray(0, k));
    for (let q = 0; q < total; q += 1) positions[fill[sortedLabel[q]]++] = q;

    // The r-th smallest value (0-based) of cluster c, or of every labeled event outside c.
    const inside = (c, r) => sorted[positions[offsets[c] + r]];
    const outside = (c, r) => {
      // Values of c before sorted position P[t] number t, so P[t] − t others precede it; find
      // the first t with more than r others before it: the answer sits at position r + t.
      let lo = 0; let hi = valid[c];
      const base = offsets[c];
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (positions[base + mid] - mid > r) hi = mid;
        else lo = mid + 1;
      }
      return sorted[r + lo];
    };
    const quantile = (get, c, count, q) => {
      if (!count) return Number.NaN;
      const h = q * (count - 1);
      const lo = Math.floor(h);
      const vLo = get(c, lo);
      return h === lo ? vLo : vLo + (h - lo) * (get(c, lo + 1) - vLo);
    };
    for (let c = 0; c < k; c += 1) {
      const at = c * dim + m;
      const count = valid[c];
      means[at] = count ? sums[c] / count : Number.NaN;
      q1[at] = quantile(inside, c, count, 0.25);
      medians[at] = quantile(inside, c, count, 0.5);
      q3[at] = quantile(inside, c, count, 0.75);
      const others = total - count;
      rest.q1[at] = quantile(outside, c, others, 0.25);
      rest.medians[at] = quantile(outside, c, others, 0.5);
      rest.q3[at] = quantile(outside, c, others, 0.75);
    }
    const all = sorted.subarray(0, total);
    let sum = 0;
    for (let c = 0; c < k; c += 1) sum += sums[c];
    overall.mean[m] = total ? sum / total : Number.NaN;
    overall.median[m] = quantileSorted(all, 0.5);
    overall.q1[m] = quantileSorted(all, 0.25);
    overall.q3[m] = quantileSorted(all, 0.75);
    overall.lower[m] = quantileSorted(all, pLow);
    overall.upper[m] = quantileSorted(all, pHigh);
  }
  return { k, dim, markers: options.markers ?? null, counts, frequencies, medians, means, q1, q3, rest, overall };
}

// ---------------------------------------------------------------------------------------------
// Heatmap

// A cluster × marker heatmap from clusterMedians output. Options:
//   statistic: 'median' (default) | 'mean'
//   scale: 'quantile' (default; each marker mapped to 0–1 between its lower and upper event
//     percentiles and clipped, as CATALYST's plotExprHeatmap), 'zscore' (per marker across
//     clusters, R's scale()), 'minmax' (per marker across clusters) or 'none'
//   clusterRows, clusterCols (true), linkage ('average', as CATALYST), distance ('euclidean').
// Returns { rows: k, cols: dim, scale, values: Float64Array(k × dim) in input order, ordered (the
// same values in rowOrder × colOrder), rowOrder, colOrder, rowTree, colTree, rowDendrogram,
// colDendrogram, range: [min, max] }. Empty clusters have NaN values and sort as zeros.
export function heatmapMatrix(summary, options = {}) {
  const { k, dim } = summary;
  const source = options.statistic === 'mean' ? summary.means : summary.medians;
  const scale = options.scale ?? 'quantile';
  const values = Float64Array.from(source);
  if (scale === 'quantile') {
    for (let m = 0; m < dim; m += 1) {
      const lo = summary.overall.lower[m];
      const span = summary.overall.upper[m] - lo;
      for (let c = 0; c < k; c += 1) {
        const v = span > 0 ? (values[c * dim + m] - lo) / span : 0;
        values[c * dim + m] = Number.isNaN(v) ? v : Math.min(1, Math.max(0, v));
      }
    }
  } else if (scale === 'zscore' || scale === 'minmax') {
    for (let m = 0; m < dim; m += 1) {
      let count = 0; let sum = 0; let min = Infinity; let max = -Infinity;
      for (let c = 0; c < k; c += 1) {
        const v = values[c * dim + m];
        if (Number.isNaN(v)) continue;
        count += 1;
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const mean = count ? sum / count : 0;
      let ss = 0;
      for (let c = 0; c < k; c += 1) {
        const v = values[c * dim + m];
        if (!Number.isNaN(v)) ss += (v - mean) * (v - mean);
      }
      const sd = count > 1 ? Math.sqrt(ss / (count - 1)) : 0;
      for (let c = 0; c < k; c += 1) {
        const v = values[c * dim + m];
        if (Number.isNaN(v)) continue;
        if (scale === 'zscore') values[c * dim + m] = sd > 0 ? (v - mean) / sd : 0;
        else values[c * dim + m] = max > min ? (v - min) / (max - min) : 0;
      }
    }
  } else if (scale !== 'none') {
    throw new Error(`Unknown heatmap scaling "${scale}"; use quantile, zscore, minmax or none.`);
  }
  const linkage = options.linkage ?? 'average';
  const distance = options.distance ?? 'euclidean';
  const filled = values.map((v) => (Number.isNaN(v) ? 0 : v));
  const transposed = new Float64Array(k * dim);
  for (let c = 0; c < k; c += 1) for (let m = 0; m < dim; m += 1) transposed[m * k + c] = filled[c * dim + m];
  const identity = (count) => Int32Array.from({ length: count }, (_, i) => i);
  const rowTree = options.clusterRows === false ? null : hclust(distanceMatrix(filled, k, dim, distance), k, linkage);
  const colTree = options.clusterCols === false ? null : hclust(distanceMatrix(transposed, dim, k, distance), dim, linkage);
  const rowOrder = rowTree ? rowTree.order : identity(k);
  const colOrder = colTree ? colTree.order : identity(dim);
  const ordered = new Float64Array(k * dim);
  let min = Infinity; let max = -Infinity;
  for (let r = 0; r < k; r += 1) {
    for (let q = 0; q < dim; q += 1) {
      const v = values[rowOrder[r] * dim + colOrder[q]];
      ordered[r * dim + q] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return {
    rows: k, cols: dim, scale, values, ordered, rowOrder, colOrder, rowTree, colTree,
    rowDendrogram: rowTree ? dendrogramLayout(rowTree) : null,
    colDendrogram: colTree ? dendrogramLayout(colTree) : null,
    range: [min, max],
  };
}

// ---------------------------------------------------------------------------------------------
// Abundance

// Events of each cluster in each sample. sampleOf maps each event to a sample index. Returns
// { counts: Uint32Array(nSamples × k) (row = sample), totals: Uint32Array(nSamples) (labeled
// events per sample), frequencies: Float64Array(nSamples × k) (fraction of the sample's labeled
// events, NaN for an empty sample), clusterTotals: Uint32Array(k) }.
export function clusterAbundance(labels, sampleOf, nSamples, k) {
  if (sampleOf.length !== labels.length) throw new Error('Every event needs both a cluster and a sample.');
  const counts = new Uint32Array(nSamples * k);
  const totals = new Uint32Array(nSamples);
  const clusterTotals = new Uint32Array(k);
  for (let i = 0; i < labels.length; i += 1) {
    const c = labels[i]; const s = sampleOf[i];
    if (c < 0 || c >= k || s < 0 || s >= nSamples) continue;
    counts[s * k + c] += 1;
    totals[s] += 1;
    clusterTotals[c] += 1;
  }
  const frequencies = new Float64Array(nSamples * k);
  for (let s = 0; s < nSamples; s += 1) {
    for (let c = 0; c < k; c += 1) frequencies[s * k + c] = totals[s] ? counts[s * k + c] / totals[s] : Number.NaN;
  }
  return { counts, totals, frequencies, clusterTotals };
}

// ---------------------------------------------------------------------------------------------
// Agreement between clusterings

// Dense codes 0…m−1 for arbitrary labels, numbered by first appearance.
function relabel(labels) {
  const n = labels.length;
  const codes = new Int32Array(n);
  let min = Infinity; let max = -Infinity; let integral = true;
  for (let i = 0; i < n; i += 1) {
    const v = labels[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (!Number.isInteger(v)) integral = false;
  }
  let next = 0;
  if (integral && n && max - min < 1 << 22) {
    const map = new Int32Array(max - min + 1).fill(-1);
    for (let i = 0; i < n; i += 1) {
      const at = labels[i] - min;
      if (map[at] < 0) map[at] = next++;
      codes[i] = map[at];
    }
  } else {
    const map = new Map();
    for (let i = 0; i < n; i += 1) {
      let code = map.get(labels[i]);
      if (code === undefined) {
        code = next++;
        map.set(labels[i], code);
      }
      codes[i] = code;
    }
  }
  return { codes, count: next };
}

// Contingency table of two labelings of the same events: { table: Float64Array(ka × kb), ka,
// kb, rows, cols, n } with clusters numbered by first appearance.
export function contingencyTable(a, b) {
  if (a.length !== b.length) throw new Error('Both clusterings must label the same events.');
  const A = relabel(a); const B = relabel(b);
  const ka = A.count; const kb = B.count;
  const table = new Float64Array(ka * kb);
  const rows = new Float64Array(ka);
  const cols = new Float64Array(kb);
  for (let i = 0; i < a.length; i += 1) {
    table[A.codes[i] * kb + B.codes[i]] += 1;
    rows[A.codes[i]] += 1;
    cols[B.codes[i]] += 1;
  }
  return { table, ka, kb, rows, cols, n: a.length };
}

const pairs = (x) => (x * (x - 1)) / 2;

// Adjusted Rand index (Hubert & Arabie 1985, doi:10.1007/BF01908075); 1 for identical
// partitions (also in the degenerate cases scikit-learn treats as perfect), ≈ 0 for chance.
export function adjustedRandIndex(a, b) {
  const { table, rows, cols, n } = contingencyTable(a, b);
  if (n < 2) return 1;
  let index = 0;
  for (let i = 0; i < table.length; i += 1) index += pairs(table[i]);
  let sumA = 0; let sumB = 0;
  for (let i = 0; i < rows.length; i += 1) sumA += pairs(rows[i]);
  for (let j = 0; j < cols.length; j += 1) sumB += pairs(cols[j]);
  const expected = (sumA * sumB) / pairs(n);
  const max = (sumA + sumB) / 2;
  if (max === expected) return 1;
  return (index - expected) / (max - expected);
}

// Normalized mutual information (Strehl & Ghosh 2002). average: 'arithmetic' (default, as
// scikit-learn), 'geometric', 'min' or 'max' of the two entropies.
export function normalizedMutualInformation(a, b, options = {}) {
  const { table, ka, kb, rows, cols, n } = contingencyTable(a, b);
  if (!n || (ka === 1 && kb === 1)) return 1;
  let mi = 0;
  for (let i = 0; i < ka; i += 1) {
    for (let j = 0; j < kb; j += 1) {
      const nij = table[i * kb + j];
      if (nij > 0) mi += (nij / n) * Math.log((n * nij) / (rows[i] * cols[j]));
    }
  }
  const entropy = (counts) => {
    let h = 0;
    for (let i = 0; i < counts.length; i += 1) if (counts[i] > 0) h -= (counts[i] / n) * Math.log(counts[i] / n);
    return h;
  };
  const ha = entropy(rows); const hb = entropy(cols);
  const average = options.average ?? 'arithmetic';
  let norm;
  if (average === 'arithmetic') norm = (ha + hb) / 2;
  else if (average === 'geometric') norm = Math.sqrt(ha * hb);
  else if (average === 'min') norm = Math.min(ha, hb);
  else if (average === 'max') norm = Math.max(ha, hb);
  else throw new Error(`Unknown NMI normalization "${average}".`);
  return norm > 0 ? Math.max(0, mi) / norm : 0;
}

// Stability of each cluster across repeated clusterings (different seeds, subsamples or
// parameters), as Hennig's clusterboot (Hennig 2007, doi:10.1016/j.csda.2006.11.025): for every
// reference cluster, the Jaccard similarity with its best-matching cluster in each run, over the
// events both clusterings labeled. `runs` is an array of Int32Array labelings of the same events
// (−1 = not in that run's subsample) or a function (run, seed) → labels called options.runs
// (10) times with seeds options.seed (1) + run. The reference is options.reference or the first
// run. Hennig reads mean Jaccard ≥ 0.75 as stable and ≤ 0.5 as dissolved.
// Returns { jaccard: Float64Array(k) (mean per reference cluster), jaccardPerRun:
// Float64Array(runs × k), dissolved: Uint32Array(k) (runs with Jaccard ≤ 0.5), recovered:
// Uint32Array(k) (runs with Jaccard ≥ 0.75), ari (mean), ariPerRun: Float64Array(runs) }.
export function clusterStability(runs, options = {}) {
  let list = runs;
  if (typeof runs === 'function') {
    const count = options.runs ?? 10;
    const seed = options.seed ?? 1;
    list = Array.from({ length: count }, (_, r) => runs(r, seed + r));
  }
  const reference = options.reference ?? list[0];
  const compared = options.reference ? list : list.slice(1);
  if (!reference || !compared.length) throw new Error('Cluster stability needs at least two clusterings to compare.');
  const n = reference.length;
  let k = 0;
  for (let i = 0; i < n; i += 1) if (reference[i] + 1 > k) k = reference[i] + 1;
  const jaccardPerRun = new Float64Array(compared.length * k);
  const ariPerRun = new Float64Array(compared.length);
  const dissolved = new Uint32Array(k);
  const recovered = new Uint32Array(k);
  const sum = new Float64Array(k);
  const seen = new Float64Array(k);
  compared.forEach((labels, r) => {
    if (labels.length !== n) throw new Error('Every clustering must label the same events.');
    let kr = 0;
    let overlap = 0;
    for (let i = 0; i < n; i += 1) {
      if (reference[i] >= 0 && labels[i] >= 0) {
        overlap += 1;
        if (labels[i] + 1 > kr) kr = labels[i] + 1;
      }
    }
    const refShared = new Int32Array(overlap);
    const runShared = new Int32Array(overlap);
    const table = new Float64Array(k * kr);
    const sizeRef = new Float64Array(k);
    const sizeRun = new Float64Array(kr);
    let q = 0;
    for (let i = 0; i < n; i += 1) {
      const a = reference[i]; const b = labels[i];
      if (a < 0 || b < 0) continue;
      refShared[q] = a;
      runShared[q] = b;
      q += 1;
      table[a * kr + b] += 1;
      sizeRef[a] += 1;
      sizeRun[b] += 1;
    }
    ariPerRun[r] = adjustedRandIndex(refShared, runShared);
    for (let a = 0; a < k; a += 1) {
      let best = Number.NaN;
      if (sizeRef[a] > 0) {
        best = 0;
        for (let b = 0; b < kr; b += 1) {
          const inter = table[a * kr + b];
          if (inter > 0) best = Math.max(best, inter / (sizeRef[a] + sizeRun[b] - inter));
        }
        sum[a] += best;
        seen[a] += 1;
        if (best <= 0.5) dissolved[a] += 1;
        if (best >= 0.75) recovered[a] += 1;
      }
      jaccardPerRun[r * k + a] = best;
    }
  });
  const jaccard = new Float64Array(k);
  for (let a = 0; a < k; a += 1) jaccard[a] = seen[a] ? sum[a] / seen[a] : Number.NaN;
  let ari = 0;
  for (let r = 0; r < ariPerRun.length; r += 1) ari += ariPerRun[r];
  return { jaccard, jaccardPerRun, dissolved, recovered, ari: ari / ariPerRun.length, ariPerRun };
}

// ---------------------------------------------------------------------------------------------
// Annotation

// Otsu's two-class split (Otsu 1979, doi:10.1109/TSMC.1979.4310076) of a few values (cluster
// medians of one marker): maximizes the between-class variance. Returns { threshold (midpoint of
// the two class means), low, high (class means), separation (between ÷ total variance, 0…1;
// ≈ 0.64 for one normal mode, → 1 for two clear modes) }.
export function otsuSplit(values) {
  const v = Float64Array.from(values).filter((x) => Number.isFinite(x)).sort();
  const m = v.length;
  if (m < 2 || v[0] === v[m - 1]) {
    const only = m ? v[0] : Number.NaN;
    return { threshold: only, low: only, high: only, separation: 0 };
  }
  const prefix = new Float64Array(m + 1);
  for (let i = 0; i < m; i += 1) prefix[i + 1] = prefix[i] + v[i];
  const mean = prefix[m] / m;
  let total = 0;
  for (let i = 0; i < m; i += 1) total += (v[i] - mean) * (v[i] - mean);
  total /= m;
  let best = -1; let split = 1;
  for (let s = 1; s < m; s += 1) {
    if (v[s] === v[s - 1]) continue; // a threshold cannot fall between equal values
    const w0 = s / m;
    const mu0 = prefix[s] / s;
    const mu1 = (prefix[m] - prefix[s]) / (m - s);
    const between = w0 * (1 - w0) * (mu0 - mu1) * (mu0 - mu1);
    if (between > best) {
      best = between;
      split = s;
    }
  }
  const low = prefix[split] / split;
  const high = (prefix[m] - prefix[split]) / (m - split);
  return { threshold: (low + high) / 2, low, high, separation: total > 0 ? best / total : 0 };
}

const SIGNS = new Map([
  ['+', 1], ['pos', 1], ['positive', 1], ['hi', 1], ['high', 1],
  ['-', -1], ['−', -1], ['neg', -1], ['negative', -1], ['lo', -1], ['low', -1],
]);

const normalizeName = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, '');

function markerIndex(name, markers) {
  let at = markers.indexOf(name);
  if (at >= 0) return at;
  const target = normalizeName(name);
  at = markers.findIndex((m) => normalizeName(m) === target);
  return at;
}

// Names clusters by marker-positivity rules, e.g.
//   { name: 'CD4 T', require: { CD3: '+', CD4: '+', CD8: '-' } }.
// Each marker's positive/negative threshold is the Otsu split of the cluster medians (or
// options.thresholds[marker]). A requirement's margin is the signed distance of the cluster's
// median from the threshold in units of half the gap between the two class means (margin 1 =
// as clearly positive/negative as the typical cluster of that class). A rule matches when every
// margin is positive; its confidence is the smallest margin, capped to 0…1. Among matching rules
// the most specific (most requirements) wins, then the most confident.
// Options: thresholds ({ marker: value }), statistic ('median' | 'mean'), minSeparation (0.75,
// below which a marker's automatic threshold is reported as unreliable).
// Returns { thresholds: [{ marker, index, threshold, low, high, separation, source }], clusters:
// [{ cluster, name, rule, confidence, margins, alternatives, nearest }], warnings }. `name` is
// null when no rule matches; `nearest` then names the closest rule and its failing markers.
export function annotateClusters(summary, markers, rules, options = {}) {
  const { k, dim } = summary;
  if (!markers || markers.length !== dim) throw new Error(`Give one marker name for each of the ${dim} columns.`);
  const values = options.statistic === 'mean' ? summary.means : summary.medians;
  const minSeparation = options.minSeparation ?? 0.75;
  const warnings = [];
  const thresholdCache = new Map();
  const thresholdOf = (m) => {
    if (thresholdCache.has(m)) return thresholdCache.get(m);
    const column = Array.from({ length: k }, (_, c) => values[c * dim + m]);
    const auto = otsuSplit(column);
    const user = options.thresholds?.[markers[m]];
    const info = { marker: markers[m], index: m, ...auto, source: 'otsu' };
    if (user !== undefined) {
      info.threshold = user;
      info.source = 'user';
      if (!(auto.high > user && auto.low < user)) {
        info.low = Math.min(auto.low, user);
        info.high = Math.max(auto.high, user);
      }
    } else if (auto.separation < minSeparation) {
      warnings.push(`${markers[m]} does not split the clusters into clear positive and negative groups (separation ${auto.separation.toFixed(2)}); consider setting its threshold by hand.`);
    }
    thresholdCache.set(m, info);
    return info;
  };
  const parsed = [];
  rules.forEach((rule, r) => {
    const requirements = [];
    let missing = null;
    for (const [marker, sign] of Object.entries(rule.require ?? {})) {
      const direction = SIGNS.get(String(sign).trim().toLowerCase());
      if (!direction) throw new Error(`Rule "${rule.name}": "${sign}" for ${marker} should be + or −.`);
      const m = markerIndex(marker, markers);
      if (m < 0) {
        missing = marker;
        break;
      }
      requirements.push({ marker: markers[m], m, direction });
    }
    if (missing) warnings.push(`Rule "${rule.name}" was skipped: no marker named ${missing}.`);
    else if (!requirements.length) warnings.push(`Rule "${rule.name}" was skipped: it requires no markers.`);
    else parsed.push({ name: rule.name, rule: r, requirements });
  });

  const clusters = [];
  for (let c = 0; c < k; c += 1) {
    const evaluations = parsed.map((rule) => {
      const margins = {};
      let min = Infinity;
      const failing = [];
      for (const { marker, m, direction } of rule.requirements) {
        const t = thresholdOf(m);
        const unit = (t.high - t.low) / 2;
        const raw = (values[c * dim + m] - t.threshold) * direction;
        const margin = unit > 0 ? raw / unit : raw > 0 ? Infinity : raw < 0 ? -Infinity : 0;
        margins[marker] = margin;
        if (!(margin > 0)) failing.push({ marker, margin });
        if (!(margin >= min)) min = margin;
      }
      return {
        name: rule.name, rule: rule.rule, specificity: rule.requirements.length, score: min,
        confidence: Math.min(1, Math.max(0, min)), margins, failing,
      };
    });
    const matched = evaluations.filter((e) => e.failing.length === 0)
      .sort((x, y) => y.specificity - x.specificity || y.score - x.score || x.rule - y.rule);
    const best = matched[0] ?? null;
    let nearest = null;
    if (!best && evaluations.length) {
      const closest = evaluations.slice().sort((x, y) => x.failing.length - y.failing.length || y.score - x.score)[0];
      nearest = { name: closest.name, rule: closest.rule, failing: closest.failing };
    }
    clusters.push({
      cluster: c,
      name: best ? best.name : null,
      rule: best ? best.rule : -1,
      confidence: best ? best.confidence : 0,
      margins: best ? best.margins : {},
      alternatives: matched.slice(1).map(({ name, rule, confidence, specificity }) => ({ name, rule, confidence, specificity })),
      nearest,
    });
  }
  const thresholds = [...thresholdCache.values()].sort((a, b) => a.index - b.index);
  return { thresholds, clusters, warnings };
}

// ---------------------------------------------------------------------------------------------
// Marker enrichment modeling

// MEM scores (Diggins et al. 2017, Nat Methods 14:275, doi:10.1038/nmeth.4149):
//   MEM = |MAG_pop − MAG_ref| + IQR_ref / IQR_pop − 1, negated when MAG_pop < MAG_ref,
// with MAG the magnitude |median| and IQRs below `iqrFloor` raised to it, then rescaled so the
// largest |MEM| in the table is 10. The reference is every other labeled event ('rest', MEM's
// default) or all events ('all'). iqrFloor defaults to 1/16 of the median p1–p99 range of the
// markers, which approximates MEM's 0.5 on arcsinh(x/5) data; pass 0.5 to reproduce MEM on that
// scale. Labels list markers with |score| ≥ minScore (1), positive (descending) then negative,
// e.g. "CD3+8 CD8+6 CD4−4", at most maxMarkers (8).
// Returns { raw: Float64Array(k × dim), scores: Float64Array(k × dim), labels: string[],
// iqrFloor, scaleMax }.
export function markerEnrichment(summary, markers, options = {}) {
  const { k, dim, medians, q1, q3 } = summary;
  if (!markers || markers.length !== dim) throw new Error(`Give one marker name for each of the ${dim} columns.`);
  const reference = options.reference ?? 'rest';
  if (reference !== 'rest' && reference !== 'all') throw new Error('The MEM reference must be "rest" or "all".');
  let iqrFloor = options.iqrFloor;
  if (iqrFloor === undefined) {
    const ranges = Float64Array.from({ length: dim }, (_, m) => summary.overall.upper[m] - summary.overall.lower[m]).sort();
    iqrFloor = quantileSorted(ranges, 0.5) / 16;
  }
  const raw = new Float64Array(k * dim);
  let scaleMax = 0;
  for (let c = 0; c < k; c += 1) {
    for (let m = 0; m < dim; m += 1) {
      const at = c * dim + m;
      const refMedian = reference === 'rest' ? summary.rest.medians[at] : summary.overall.median[m];
      const refIqr = reference === 'rest' ? summary.rest.q3[at] - summary.rest.q1[at] : summary.overall.q3[m] - summary.overall.q1[m];
      const magPop = Math.abs(medians[at]);
      const magRef = Math.abs(refMedian);
      const iqrPop = Math.max(q3[at] - q1[at], iqrFloor);
      const iqrRef = Math.max(refIqr, iqrFloor);
      let mem = Math.abs(magPop - magRef) + iqrRef / iqrPop - 1;
      if (!(magPop - magRef >= 0)) mem = -mem;
      raw[at] = mem;
      if (Number.isFinite(mem)) scaleMax = Math.max(scaleMax, Math.abs(mem));
    }
  }
  const scores = raw.map((v) => (scaleMax > 0 ? (v / scaleMax) * 10 : 0));
  const minScore = options.minScore ?? 1;
  const maxMarkers = options.maxMarkers ?? 8;
  const labels = [];
  for (let c = 0; c < k; c += 1) {
    const entries = [];
    for (let m = 0; m < dim; m += 1) {
      const s = Math.round(scores[c * dim + m]);
      if (Number.isFinite(s) && Math.abs(s) >= minScore) entries.push({ marker: markers[m], s, v: scores[c * dim + m] });
    }
    const positive = entries.filter((e) => e.s > 0).sort((a, b) => b.v - a.v);
    const negative = entries.filter((e) => e.s < 0).sort((a, b) => a.v - b.v);
    labels.push([...positive, ...negative].slice(0, maxMarkers)
      .map((e) => `${e.marker}${e.s > 0 ? '+' : '−'}${Math.abs(e.s)}`).join(' '));
  }
  return { raw, scores, labels, iqrFloor, scaleMax };
}

