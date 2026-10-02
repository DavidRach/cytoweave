// Mass-cytometry barcode debarcoding: the single-cell debarcoder of Zunder et al. 2015 (Nat
// Protoc, doi:10.1038/nprot.2014.090) as implemented in CATALYST (Chevrier et al. 2018, Cell
// Syst, doi:10.1016/j.cels.2018.02.010).
//
// Barcode intensities are arcsinh-transformed (cofactor 10) and scaled per channel; each event
// is assigned to the code whose positive channels are its k highest barcode channels (k-of-n
// doublet-filtering keys such as 6-choose-3) or, for keys with varying k, the channels above its
// largest intensity gap. The separation (the gap between the lowest positive and the highest
// negative) and a Mahalanobis distance to the assigned population decide which assignments are
// kept.

import { quantileSorted } from './stats.js';
import { columnOf } from './qc.js';

function checkAbort(options) {
  if (options.signal?.aborted) throw new Error('Debarcoding was cancelled.');
}

function report(options, fraction, message) {
  if (options.onProgress) options.onProgress(fraction, message);
}

// Every k-of-n code over `channels` (e.g. 6-choose-3 = 20 codes), in lexicographic order.
export function combinationKey(channels, k) {
  const n = channels.length;
  if (!(k >= 1 && k <= n)) throw new Error('k must be between 1 and the number of barcode channels.');
  const codes = [];
  const pick = [];
  const visit = (start) => {
    if (pick.length === k) {
      const pattern = new Array(n).fill(0);
      for (const i of pick) pattern[i] = 1;
      codes.push({ id: String(codes.length + 1), pattern });
      return;
    }
    for (let i = start; i < n; i += 1) {
      pick.push(i);
      visit(i + 1);
      pick.pop();
    }
  };
  visit(0);
  return { channels: [...channels], codes };
}

// Accepts { channels, codes: [{ id, pattern: [0/1, …] }] } or { channels, ids, matrix } (rows =
// codes, columns = channels).
export function normalizeKey(key) {
  const channels = key?.channels;
  if (!Array.isArray(channels) || !channels.length) throw new Error('The barcode key needs its barcode channels.');
  let codes = key.codes;
  if (!codes && Array.isArray(key.matrix)) codes = key.matrix.map((row, i) => ({ id: String(key.ids?.[i] ?? i + 1), pattern: row }));
  if (!Array.isArray(codes) || !codes.length) throw new Error('The barcode key has no codes.');
  const seen = new Map();
  const out = codes.map((code, i) => {
    const pattern = Array.from(code.pattern ?? code.values ?? [], (v) => (Number(v) ? 1 : 0));
    if (pattern.length !== channels.length) throw new Error(`Code ${code.id ?? i + 1} has ${pattern.length} entries for ${channels.length} barcode channels.`);
    if (!pattern.some(Boolean)) throw new Error(`Code ${code.id ?? i + 1} has no positive channel.`);
    const signature = pattern.join('');
    if (seen.has(signature)) throw new Error(`Codes ${seen.get(signature)} and ${code.id ?? i + 1} have the same pattern.`);
    seen.set(signature, code.id ?? i + 1);
    return { id: String(code.id ?? i + 1), pattern };
  });
  return { channels: [...channels], codes: out };
}

function cutoffsFor(option, codes, fallback) {
  return Float64Array.from(codes, (code, i) => {
    if (option === undefined || option === null) return fallback;
    if (typeof option === 'number') return option;
    if (Array.isArray(option) || ArrayBuffer.isView(option)) return option[i] ?? fallback;
    return option[code.id] ?? fallback;
  });
}

// Assigns every event from per-event scaled intensities. `divisor(e, c)` gives the scale.
function assignAll(data, n, nc, divisor, uniformK, codeOf, assignment, separation, normalized) {
  const values = new Float64Array(nc);
  const index = new Int32Array(nc);
  for (let e = 0; e < n; e += 1) {
    for (let c = 0; c < nc; c += 1) {
      const v = data[e * nc + c] / divisor(e, c);
      values[c] = v;
      index[c] = c;
      if (normalized) normalized[e * nc + c] = v;
    }
    // Insertion sort, descending (nc is small).
    for (let i = 1; i < nc; i += 1) {
      const id = index[i];
      let j = i - 1;
      while (j >= 0 && values[index[j]] < values[id]) {
        index[j + 1] = index[j];
        j -= 1;
      }
      index[j + 1] = id;
    }
    let k = uniformK;
    let gap;
    if (k) {
      gap = k < nc ? values[index[k - 1]] - values[index[k]] : values[index[k - 1]];
    } else {
      gap = -Infinity;
      for (let j = 0; j < nc - 1; j += 1) {
        const d = values[index[j]] - values[index[j + 1]];
        if (d > gap) {
          gap = d;
          k = j + 1;
        }
      }
    }
    let signature = 0;
    for (let j = 0; j < k; j += 1) signature += 2 ** index[j];
    assignment[e] = codeOf.get(signature) ?? -1;
    separation[e] = gap;
  }
}

// Debarcodes `sample` with `key`. Options: cofactor (10), separationCutoff (0.3; a number, an
// array per code or { [id]: value }), mahalanobisCutoff (30, on the squared distance as R's
// mahalanobis()), initialQuantile (0.995: pass-one channel scale), populationQuantile (0.95:
// pass-two scale of each population's positive channels), minPopulation (20), cutoffs (the grid
// for the yield curves, default 0, 0.01, …, 1), onProgress, signal.
//
// Pass one scales each channel by its 99.5th percentile and assigns preliminary codes. Pass two
// rescales each preliminary population so the 95th percentile of each of its positive channels
// is 1 (negative channels by the median positive-population scale of that channel), then
// reassigns and recomputes separations (CATALYST's population-wise normalization). Events below
// their code's separation cutoff are unassigned; so are events whose squared Mahalanobis
// distance to their population (on the normalized barcode intensities, populations of at least
// 2 × channels events) exceeds the cutoff.
export function debarcode(sample, key, options = {}) {
  const { channels, codes } = normalizeKey(key);
  const nc = channels.length;
  if (nc > 30) throw new Error('At most 30 barcode channels are supported.');
  const nk = codes.length;
  const columns = channels.map((name) => columnOf(sample, name));
  const n = Number.isInteger(sample.eventCount) ? sample.eventCount : columns[0].length;
  const cofactor = options.cofactor ?? 10;
  const positives = codes.map((code) => code.pattern.reduce((s, v) => s + v, 0));
  const uniformK = positives.every((k) => k === positives[0]) ? positives[0] : 0;
  const codeOf = new Map();
  codes.forEach((code, i) => {
    let signature = 0;
    code.pattern.forEach((v, c) => { if (v) signature += 2 ** c; });
    codeOf.set(signature, i);
  });

  report(options, 0, 'Scaling barcode channels');
  const data = new Float32Array(n * nc);
  const initial = new Float64Array(nc);
  for (let c = 0; c < nc; c += 1) {
    const column = columns[c];
    const sorted = new Float64Array(n);
    for (let e = 0; e < n; e += 1) {
      const t = Math.asinh(column[e] / cofactor);
      data[e * nc + c] = t;
      sorted[e] = t;
    }
    sorted.sort();
    const q = quantileSorted(sorted, options.initialQuantile ?? 0.995);
    initial[c] = q > 0 ? q : 1;
  }
  checkAbort(options);

  // Pass one.
  const preliminary = new Int32Array(n);
  const separations = new Float32Array(n);
  assignAll(data, n, nc, (e, c) => initial[c], uniformK, codeOf, preliminary, separations, null);
  checkAbort(options);
  report(options, 0.3, 'Normalizing barcode populations');

  // Pass two: population-wise scales.
  const minPopulation = options.minPopulation ?? 20;
  const populationQuantile = options.populationQuantile ?? 0.95;
  const members = Array.from({ length: nk }, () => []);
  for (let e = 0; e < n; e += 1) if (preliminary[e] >= 0) members[preliminary[e]].push(e);
  const scale = new Float64Array(nk * nc).fill(Number.NaN);
  const perChannel = Array.from({ length: nc }, () => []);
  codes.forEach((code, p) => {
    if (members[p].length < minPopulation) return;
    for (let c = 0; c < nc; c += 1) {
      if (!code.pattern[c]) continue;
      const values = Float64Array.from(members[p], (e) => data[e * nc + c]).sort();
      const q = quantileSorted(values, populationQuantile);
      if (q > 0) {
        scale[p * nc + c] = q;
        perChannel[c].push(q);
      }
    }
  });
  const positiveScale = Float64Array.from(perChannel, (values, c) => (values.length ? quantileSorted(Float64Array.from(values).sort(), 0.5) : initial[c]));
  const assignments = new Int32Array(n);
  const normalized = new Float32Array(n * nc);
  assignAll(data, n, nc, (e, c) => {
    const p = preliminary[e];
    if (p >= 0) {
      const s = scale[p * nc + c];
      if (s > 0) return s;
    }
    return positiveScale[c];
  }, uniformK, codeOf, assignments, separations, normalized);
  const assigned = Int32Array.from(assignments);
  checkAbort(options);
  report(options, 0.6, 'Applying cutoffs');

  // Yields as functions of the separation cutoff (before the Mahalanobis filter).
  const grid = options.cutoffs ? Float64Array.from(options.cutoffs) : Float64Array.from({ length: 101 }, (_, j) => j / 100);
  const bySeparation = Array.from({ length: nk }, () => []);
  for (let e = 0; e < n; e += 1) if (assigned[e] >= 0) bySeparation[assigned[e]].push(separations[e]);
  const yieldCounts = bySeparation.map((values) => {
    const sorted = Float64Array.from(values).sort();
    return Float64Array.from(grid, (cut) => {
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < cut) lo = mid + 1;
        else hi = mid;
      }
      return sorted.length - lo;
    });
  });
  const yieldFractions = yieldCounts.map((counts) => Float64Array.from(counts, (v) => (counts[0] ? v / counts[0] : 0)));
  const totalYield = Float64Array.from(grid, (_, j) => yieldCounts.reduce((s, counts) => s + counts[j], 0));

  // Separation cutoffs.
  const separationCutoffs = cutoffsFor(options.separationCutoff, codes, 0.3);
  for (let e = 0; e < n; e += 1) {
    const p = assignments[e];
    if (p >= 0 && !(separations[e] >= separationCutoffs[p])) assignments[e] = -1;
  }

  // Mahalanobis distance within each population.
  const mahalanobisCutoff = options.mahalanobisCutoff ?? 30;
  const mahalanobis = new Float32Array(n).fill(Number.NaN);
  const population = Array.from({ length: nk }, () => []);
  for (let e = 0; e < n; e += 1) if (assignments[e] >= 0) population[assignments[e]].push(e);
  const diff = new Float64Array(nc);
  const solved = new Float64Array(nc);
  population.forEach((events, p) => {
    const m = events.length;
    if (m < 2 * nc || m < nc + 2) return;
    const mean = new Float64Array(nc);
    for (const e of events) for (let c = 0; c < nc; c += 1) mean[c] += normalized[e * nc + c];
    for (let c = 0; c < nc; c += 1) mean[c] /= m;
    const cov = new Float64Array(nc * nc);
    for (const e of events) {
      for (let a = 0; a < nc; a += 1) {
        const da = normalized[e * nc + a] - mean[a];
        for (let b = 0; b <= a; b += 1) cov[a * nc + b] += da * (normalized[e * nc + b] - mean[b]);
      }
    }
    for (let a = 0; a < nc; a += 1) for (let b = 0; b <= a; b += 1) {
      cov[a * nc + b] /= m - 1;
      cov[b * nc + a] = cov[a * nc + b];
    }
    const chol = cholesky(cov, nc);
    if (!chol) return;
    for (const e of events) {
      for (let c = 0; c < nc; c += 1) diff[c] = normalized[e * nc + c] - mean[c];
      // Solve L y = diff; d² = |y|².
      let d2 = 0;
      for (let i = 0; i < nc; i += 1) {
        let v = diff[i];
        for (let j = 0; j < i; j += 1) v -= chol[i * nc + j] * solved[j];
        solved[i] = v / chol[i * nc + i];
        d2 += solved[i] * solved[i];
      }
      mahalanobis[e] = d2;
      if (d2 > mahalanobisCutoff) assignments[e] = -1;
    }
  });

  const counts = new Int32Array(nk);
  let unassigned = 0;
  for (let e = 0; e < n; e += 1) {
    if (assignments[e] >= 0) counts[assignments[e]] += 1;
    else unassigned += 1;
  }
  report(options, 1, 'Done');
  return {
    channels,
    codes: codes.map((code) => ({ id: code.id, pattern: code.pattern })),
    assignments,
    preliminary: assigned,
    separations,
    mahalanobis,
    counts,
    unassigned,
    percentAssigned: n ? (100 * (n - unassigned)) / n : 0,
    separationCutoffs,
    mahalanobisCutoff,
    yields: { cutoffs: grid, counts: yieldCounts, fractions: yieldFractions, total: totalYield },
    scales: {
      initial: Object.fromEntries(channels.map((name, c) => [name, initial[c]])),
      positive: Object.fromEntries(channels.map((name, c) => [name, positiveScale[c]])),
    },
  };
}

// Lower-triangular Cholesky factor of a symmetric positive-definite n × n matrix (row-major), with
// a tiny ridge so a degenerate population does not fail; null when it is not positive definite.
function cholesky(matrix, n) {
  let trace = 0;
  for (let i = 0; i < n; i += 1) trace += matrix[i * n + i];
  const ridge = 1e-10 * (trace / n || 1);
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i * n + j] + (i === j ? ridge : 0);
      for (let k = 0; k < j; k += 1) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(sum > 0)) return null;
        L[i * n + i] = Math.sqrt(sum);
      } else {
        L[i * n + j] = sum / L[j * n + j];
      }
    }
  }
  return L;
}
