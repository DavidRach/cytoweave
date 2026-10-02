// Batch normalization and batch-effect diagnostics.
//
//   trainCytoNorm / applyCytoNorm  CytoNorm (Van Gassen et al. 2020, Cytometry A,
//                                  doi:10.1002/cyto.a.23904)
//   quantileNormalize              the same quantile-spline mapping, every sample its own batch
//   beadNormalize / beadBaseline   bead normalization for mass cytometry (Finck et al. 2013,
//                                  Cytometry A, doi:10.1002/cyto.a.22271)
//   batchDiagnostics               per-channel EMD and KS distance of each batch to the pool
//   confoundingCheck               batch × condition association (Cramér's V)

import { createRandom, sampleIndices } from './random.js';
import { quantileSorted } from './stats.js';
import { applyTransform, createTransform } from './transforms.js';
import { columnOf, median, runningMedian } from './qc.js';

function checkAbort(options) {
  if (options.signal?.aborted) throw new Error('The normalization was cancelled.');
}

function report(options, fraction, message) {
  if (options.onProgress) options.onProgress(fraction, message);
}

function eventCountOf(sample) {
  if (Number.isInteger(sample.eventCount)) return sample.eventCount;
  const first = Object.values(sample.columns ?? {})[0];
  return first ? first.length : 0;
}

function fluorescenceChannels(sample) {
  return (sample.channels ?? []).filter((c) => c.type === 'fluorescence').map((c) => c.name);
}

// CytoNorm works on arcsinh-transformed values (cofactor 5 for mass cytometry, 150 for flow).
function defaultSpec(options) {
  const mass = options.technology === 'mass';
  return { type: 'arcsinh', cofactor: options.cofactor ?? (mass ? 5 : 150), max: mass ? 10000 : 262144 };
}

// --- Monotone cubic spline ------------------------------------------------------------------

// Fritsch–Carlson monotone cubic Hermite interpolation, as R's splinefun(method = 'monoH.FC')
// (Fritsch & Carlson 1980, SIAM J Numer Anal, doi:10.1137/0717021): tied x are merged (mean y,
// as regularize.values), initial slopes are the end secants and the mean of neighbouring
// secants, then monoFC_mod scales slopes back into the monotonicity region (plus a guard pass,
// below, where R's single pass is not monotone). Outside the knots
// the spline continues linearly with the end slopes. Returns a plain { x, y, m } object.
export function monotoneSpline(xs, ys) {
  if (xs.length !== ys.length || !xs.length) throw new Error('A spline needs the same, non-zero number of x and y values.');
  const order = [];
  for (let i = 0; i < xs.length; i += 1) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) order.push(i);
  if (!order.length) throw new Error('A spline needs finite knots.');
  order.sort((a, b) => xs[a] - xs[b]);
  const x = [];
  const y = [];
  for (let i = 0; i < order.length;) {
    let j = i;
    let sum = 0;
    while (j < order.length && xs[order[j]] === xs[order[i]]) {
      sum += ys[order[j]];
      j += 1;
    }
    x.push(Number(xs[order[i]]));
    y.push(sum / (j - i));
    i = j;
  }
  const n = x.length;
  if (n === 1) return { x, y, m: [1] };
  const secant = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k += 1) secant[k] = (y[k + 1] - y[k]) / (x[k + 1] - x[k]);
  const m = new Array(n);
  m[0] = secant[0];
  m[n - 1] = secant[n - 2];
  for (let k = 1; k < n - 1; k += 1) m[k] = (secant[k - 1] + secant[k]) / 2;
  for (let k = 0; k < n - 1; k += 1) {
    const s = secant[k];
    if (s === 0) {
      m[k] = 0;
      m[k + 1] = 0;
      continue;
    }
    const alpha = m[k] / s;
    const beta = m[k + 1] / s;
    const a2b3 = 2 * alpha + beta - 3;
    const ab23 = alpha + 2 * beta - 3;
    if (a2b3 > 0 && ab23 > 0 && alpha * (a2b3 + ab23) < a2b3 * a2b3) {
      const tauS = (3 * s) / Math.sqrt(alpha * alpha + beta * beta);
      m[k] = tauS * alpha;
      m[k + 1] = tauS * beta;
    }
  }
  // R's single left-to-right pass can leave an interval outside the monotonicity region when the
  // next interval lowers their shared slope (a steep interval followed by a flat one). Only such
  // intervals are pulled into the radius-3 disk, which stays monotone under further lowering.
  for (let pass = 0; pass < n; pass += 1) {
    let changed = false;
    for (let k = 0; k < n - 1; k += 1) {
      const s = secant[k];
      if (s === 0) continue;
      const alpha = m[k] / s;
      const beta = m[k + 1] / s;
      const a2b3 = 2 * alpha + beta - 3;
      const ab23 = alpha + 2 * beta - 3;
      if (a2b3 > 0 && ab23 > 0 && alpha * (a2b3 + ab23) < a2b3 * a2b3 && alpha * alpha + beta * beta > 9) {
        const tauS = (3 * s) / Math.sqrt(alpha * alpha + beta * beta);
        m[k] = tauS * alpha;
        m[k + 1] = tauS * beta;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { x, y, m };
}

// Evaluates a spline from monotoneSpline (a single knot is a pure shift).
export function evaluateSpline(spline, v) {
  const { x, y, m } = spline;
  const n = x.length;
  if (n === 1) return y[0] + (v - x[0]);
  if (v <= x[0]) return y[0] + m[0] * (v - x[0]);
  if (v >= x[n - 1]) return y[n - 1] + m[n - 1] * (v - x[n - 1]);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (x[mid] <= v) lo = mid;
    else hi = mid;
  }
  const h = x[hi] - x[lo];
  const t = (v - x[lo]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y[lo] + (t3 - 2 * t2 + t) * h * m[lo] + (3 * t2 - 2 * t3) * y[hi] + (t3 - t2) * h * m[hi];
}

// --- CytoNorm -------------------------------------------------------------------------------

// CytoNorm's quantiles: 0.001, 1/(nQ−1), …, (nQ−2)/(nQ−1), 0.999 (the extremes are too noisy).
export function cytoNormProbabilities(nQ = 101) {
  if (!(nQ >= 3)) throw new Error('CytoNorm needs at least 3 quantiles.');
  const p = new Array(nQ);
  for (let i = 0; i < nQ; i += 1) p[i] = i / (nQ - 1);
  p[0] = 0.001;
  p[nQ - 1] = 0.999;
  return p;
}

// Trains CytoNorm on reference (anchor) samples, one or more per batch:
// references = [{ sample, batch, labels? }] where labels (Int32Array, one per event) are cluster
// ids, e.g. from FlowSOM; without labels every event is in one global cluster. Per cluster, batch
// and channel the quantiles of the transformed values are computed, the goal is their mean over
// batches (goal: 'mean' | 'median' | a batch name) and a monotone spline maps each batch's
// quantiles onto the goal. options: channels, transforms { [name]: spec } (default arcsinh),
// cofactor, technology, nQ (101), goal ('mean'), limits ([lo, hi] in transformed units, added as
// fixed knots as CytoNorm's `limit`), minCells (50, a warning), onProgress, signal.
// The model is plain JSON.
export function trainCytoNorm(references, options = {}) {
  if (!Array.isArray(references) || !references.length) throw new Error('CytoNorm needs reference (anchor) samples, at least one per batch.');
  const channels = options.channels?.length ? options.channels : fluorescenceChannels(references[0].sample);
  if (!channels.length) throw new Error('Choose the channels to normalize.');
  const nQ = options.nQ ?? 101;
  const probabilities = cytoNormProbabilities(nQ);
  const goal = options.goal ?? 'mean';
  const minCells = options.minCells ?? 50;
  const transforms = {};
  for (const name of channels) transforms[name] = options.transforms?.[name] ?? defaultSpec(options);
  const batches = [];
  for (const ref of references) {
    if (ref.batch === undefined || ref.batch === null || ref.batch === '') throw new Error('Every reference sample needs a batch.');
    if (!batches.includes(String(ref.batch))) batches.push(String(ref.batch));
  }
  const clustered = references.some((r) => r.labels);
  if (clustered && references.some((r) => !r.labels)) throw new Error('Either every reference sample has cluster labels or none has.');
  let clusters = [0];
  if (clustered) {
    const seen = new Set();
    for (const ref of references) {
      if (ref.labels.length !== eventCountOf(ref.sample)) throw new Error('There must be one cluster label per event.');
      let last = Number.NaN;
      for (let i = 0; i < ref.labels.length; i += 1) {
        const v = ref.labels[i];
        if (v !== last && v >= 0) {
          seen.add(v);
          last = v;
        }
      }
    }
    clusters = [...seen].sort((a, b) => a - b);
  }
  const clusterIndex = new Map(clusters.map((c, i) => [c, i]));
  const nC = clusters.length;
  const nB = batches.length;
  const refBatch = references.map((r) => batches.indexOf(String(r.batch)));
  const counts = Array.from({ length: nC }, () => new Array(nB).fill(0));
  const refCluster = references.map((ref) => {
    const n = eventCountOf(ref.sample);
    const out = new Int32Array(n);
    for (let i = 0; i < n; i += 1) out[i] = clustered ? (clusterIndex.get(ref.labels[i]) ?? -1) : 0;
    return out;
  });

  const quantiles = {};
  const goalQuantiles = {};
  const splines = {};
  for (const c of clusters) {
    quantiles[c] = {};
    goalQuantiles[c] = {};
    splines[c] = {};
    for (const b of batches) {
      quantiles[c][b] = {};
      splines[c][b] = {};
    }
  }
  references.forEach((ref, r) => {
    const labels = refCluster[r];
    for (let i = 0; i < labels.length; i += 1) if (labels[i] >= 0) counts[labels[i]][refBatch[r]] += 1;
  });
  const warnings = [];
  for (let ci = 0; ci < nC; ci += 1) {
    for (let bi = 0; bi < nB; bi += 1) {
      const count = counts[ci][bi];
      const where = clustered ? `Cluster ${clusters[ci]}` : 'The reference data';
      if (count === 0) warnings.push(`${where} has no cells in batch ${batches[bi]}; its events there are left unchanged.`);
      else if (count < minCells) warnings.push(`${where} has only ${count} cells in batch ${batches[bi]}; its quantiles are uncertain.`);
    }
  }

  channels.forEach((name, k) => {
    checkAbort(options);
    report(options, k / channels.length, `Quantiles of ${name}`);
    const transform = createTransform(transforms[name]);
    const buckets = counts.map((row) => row.map((count) => new Float64Array(count)));
    const fill = counts.map((row) => row.map(() => 0));
    references.forEach((ref, r) => {
      const column = columnOf(ref.sample, name);
      const values = applyTransform(column, transform, new Float64Array(column.length));
      const labels = refCluster[r];
      const bi = refBatch[r];
      for (let i = 0; i < values.length; i += 1) {
        const ci = labels[i];
        if (ci < 0) continue;
        buckets[ci][bi][fill[ci][bi]++] = values[i];
      }
    });
    for (let ci = 0; ci < nC; ci += 1) {
      const perBatch = buckets[ci].map((values) => {
        if (!values.length) return null;
        const sorted = values.sort();
        return probabilities.map((p) => quantileSorted(sorted, p));
      });
      const present = perBatch.filter(Boolean);
      const c = clusters[ci];
      let target = null;
      if (present.length) {
        if (goal === 'mean' || goal === 'median') {
          target = probabilities.map((_, q) => {
            const values = present.map((row) => row[q]);
            return goal === 'mean' ? values.reduce((s, v) => s + v, 0) / values.length : median(values);
          });
        } else {
          const gi = batches.indexOf(String(goal));
          if (gi < 0) throw new Error(`The goal batch "${goal}" has no reference sample.`);
          target = perBatch[gi] ?? null;
          if (!target) warnings.push(`Cluster ${c} has no cells in the goal batch ${goal}; it is left unchanged.`);
        }
      }
      goalQuantiles[c][name] = target;
      perBatch.forEach((row, bi) => {
        const b = batches[bi];
        quantiles[c][b][name] = row;
        if (!row || !target) {
          splines[c][b][name] = null;
          return;
        }
        const xs = row.slice();
        const ys = target.slice();
        if (options.limits) {
          xs.unshift(options.limits[0]);
          ys.unshift(options.limits[0]);
          xs.push(options.limits[1]);
          ys.push(options.limits[1]);
        }
        splines[c][b][name] = monotoneSpline(xs, ys);
      });
    }
  });
  report(options, 1, 'Done');
  return {
    kind: 'cytonorm',
    version: 1,
    channels: [...channels],
    transforms,
    nQ,
    probabilities,
    goal: String(goal),
    batches,
    clustered,
    clusters,
    counts,
    quantiles,
    goalQuantiles,
    splines,
    warnings,
  };
}

// Normalizes one sample of `batch` with a trained CytoNorm model. `labels` (cluster per event)
// is required when the model was trained per cluster; events in clusters the model does not know
// (or labelled −1) are left unchanged and counted. Returns { columns } with new Float32Arrays for
// the normalized channels (linear values) and the other columns shared with the input.
export function applyCytoNorm(model, sample, batch, labels = null, options = {}) {
  if (model?.kind !== 'cytonorm') throw new Error('This is not a CytoNorm model.');
  const b = String(batch);
  if (!model.batches.includes(b)) throw new Error(`Batch "${b}" has no reference sample in this CytoNorm model, so it cannot be normalized.`);
  const n = eventCountOf(sample);
  if (model.clustered && !labels) throw new Error('This CytoNorm model was trained per cluster: give the cluster label of every event.');
  if (labels && labels.length !== n) throw new Error('There must be one cluster label per event.');
  let lookup = null;
  if (model.clustered) {
    const maxId = Math.max(...model.clusters, 0);
    lookup = new Int32Array(maxId + 1).fill(-1);
    model.clusters.forEach((c, i) => { if (c >= 0) lookup[c] = i; });
  }
  const clusterOf = (e) => {
    if (!lookup) return 0;
    const v = labels[e];
    return v >= 0 && v < lookup.length ? lookup[v] : -1;
  };
  const columns = { ...sample.columns };
  let unmatched = 0;
  if (lookup) for (let e = 0; e < n; e += 1) if (clusterOf(e) < 0) unmatched += 1;
  model.channels.forEach((name, k) => {
    checkAbort(options);
    report(options, k / model.channels.length, `Normalizing ${name}`);
    const transform = createTransform(model.transforms[name]);
    const column = columnOf(sample, name);
    const forward = applyTransform(column, transform, new Float64Array(n));
    const perCluster = model.clusters.map((c) => model.splines[c]?.[b]?.[name] ?? null);
    const out = new Float32Array(n);
    for (let e = 0; e < n; e += 1) {
      const ci = clusterOf(e);
      const spline = ci >= 0 ? perCluster[ci] : null;
      out[e] = spline && Number.isFinite(forward[e]) ? transform.inverse(evaluateSpline(spline, forward[e])) : column[e];
    }
    columns[name] = out;
  });
  const warnings = unmatched ? [`${unmatched} events are in clusters the model does not know and were left unchanged.`] : [];
  return { columns, channels: [...model.channels], batch: b, unmatched, warnings };
}

// Quantile normalization of every sample to the mean quantile distribution, with the same
// monotone-spline mapping as CytoNorm (each sample is its own batch, no clustering).
export function quantileNormalize(samples, channels = null, options = {}) {
  const references = samples.map((sample, i) => ({ sample, batch: String(i) }));
  const model = trainCytoNorm(references, { ...options, channels: channels ?? options.channels });
  return { model, samples: samples.map((sample, i) => applyCytoNorm(model, sample, String(i), null, options)) };
}

// --- Bead normalization (mass cytometry) ----------------------------------------------------

export const DEFAULT_BEAD_MASSES = ['Ce140', 'Eu151', 'Eu153', 'Ho165', 'Lu175'];
const DEFAULT_DNA_MASSES = ['Ir191', 'Ir193'];

// Finds the channel for an isotope token such as 'Ce140' ('Ce140Di', '(Ce140)Dd', '140Ce_…').
export function findMassChannel(sample, token) {
  const match = /^([A-Z][a-z]?)(\d{2,3})$/.exec(token);
  if (!match) return (sample.channels ?? []).some((c) => c.name === token) ? token : null;
  const [, element, mass] = match;
  const pattern = new RegExp(`${element}${mass}(?!\\d)|(?<!\\d)${mass}${element}(?![a-z])`);
  const hit = (sample.channels ?? []).find((c) => c.type !== 'time' && pattern.test(c.name));
  return hit ? hit.name : null;
}

// Otsu's threshold (Otsu 1979, doi:10.1109/TSMC.1979.4310076) on a 256-bin histogram between the
// 0.01st and 99.99th percentiles.
export function otsuThreshold(values) {
  const sorted = Float64Array.from(values).filter(Number.isFinite).sort();
  if (!sorted.length) return Number.NaN;
  const lo = quantileSorted(sorted, 0.0001);
  const hi = quantileSorted(sorted, 0.9999);
  if (!(hi > lo)) return lo;
  const bins = 256;
  const hist = new Float64Array(bins);
  const width = (hi - lo) / bins;
  for (let i = 0; i < sorted.length; i += 1) hist[Math.min(bins - 1, Math.max(0, Math.floor((sorted[i] - lo) / width)))] += 1;
  let total = 0;
  let totalSum = 0;
  for (let b = 0; b < bins; b += 1) {
    total += hist[b];
    totalSum += b * hist[b];
  }
  let weight = 0;
  let sum = 0;
  let best = -1;
  let bestBin = 0;
  for (let b = 0; b < bins - 1; b += 1) {
    weight += hist[b];
    sum += b * hist[b];
    if (weight === 0 || weight === total) continue;
    const m0 = sum / weight;
    const m1 = (totalSum - sum) / (total - weight);
    const between = weight * (total - weight) * (m0 - m1) ** 2;
    if (between > best) {
      best = between;
      bestBin = b;
    }
  }
  return lo + (bestBin + 1) * width;
}

// Bead events: high in every bead channel (above each channel's Otsu threshold of
// asinh(x / cofactor), or options.beadThresholds { [name]: linear value }) and, when DNA channels
// exist (Ir191/Ir193), low in DNA, which excludes bead–cell doublets.
function identifyBeads(sample, options) {
  const n = eventCountOf(sample);
  const cofactor = options.cofactor ?? 5;
  const beadChannels = (options.beadChannels ?? DEFAULT_BEAD_MASSES).map((token) => {
    const name = sample.columns?.[token] ? token : findMassChannel(sample, token);
    if (!name) throw new Error(`No ${token} bead channel was found; give the bead channel names in options.beadChannels.`);
    return name;
  });
  const dnaChannels = (options.dnaChannels ?? DEFAULT_DNA_MASSES)
    .map((token) => (sample.columns?.[token] ? token : findMassChannel(sample, token)))
    .filter(Boolean);
  const beadMask = new Uint8Array(n).fill(1);
  const thresholds = {};
  const gate = (name, high) => {
    const column = columnOf(sample, name);
    const t = new Float32Array(n);
    for (let i = 0; i < n; i += 1) t[i] = Math.asinh(column[i] / cofactor);
    const given = options.beadThresholds?.[name];
    const threshold = given !== undefined ? Math.asinh(given / cofactor) : otsuThreshold(t);
    thresholds[name] = cofactor * Math.sinh(threshold);
    for (let i = 0; i < n; i += 1) if (high ? !(t[i] > threshold) : !(t[i] < threshold)) beadMask[i] = 0;
  };
  for (const name of beadChannels) gate(name, true);
  if (options.excludeDNA !== false) for (const name of dnaChannels) gate(name, false);
  let beadCount = 0;
  for (let i = 0; i < n; i += 1) beadCount += beadMask[i];
  return { beadMask, beadCount, beadChannels, dnaChannels: options.excludeDNA !== false ? dnaChannels : [], thresholds };
}

// Mean over samples of each bead channel's median bead intensity: a shared baseline for
// normalizing several files to the same level.
export function beadBaseline(samples, options = {}) {
  const sums = {};
  let used = 0;
  for (const sample of samples) {
    const { beadMask, beadChannels } = identifyBeads(sample, options);
    beadChannels.forEach((name, k) => {
      const column = columnOf(sample, name);
      const values = [];
      for (let i = 0; i < beadMask.length; i += 1) if (beadMask[i]) values.push(column[i]);
      const key = (options.beadChannels ?? DEFAULT_BEAD_MASSES)[k];
      sums[key] = (sums[key] ?? 0) + median(values);
    });
    used += 1;
  }
  const baseline = {};
  for (const [key, sum] of Object.entries(sums)) baseline[key] = sum / used;
  return baseline;
}

// Bead normalization (Finck et al. 2013): bead intensities are smoothed over time with a running
// median (window of `window` beads, default 501 as CATALYST's k = 500); at each bead the
// correction is the least-squares slope through the origin of baseline on smoothed intensities,
// slope = Σ baseline·smoothed / Σ smoothed²; the slopes are interpolated linearly in time to every
// event (constant beyond the first and last bead) and multiply every mass channel. The baseline
// is the median bead intensity per channel in this sample, or options.baseline ({ [name or
// isotope]: value }, e.g. from beadBaseline). Beads are flagged in `mask` (1 = keep) unless
// options.removeBeads is false. options: beadChannels, dnaChannels, beadThresholds, cofactor (5),
// window, baseline, channels (default every fluorescence channel), timeChannel, removeBeads.
export function beadNormalize(sample, options = {}) {
  const n = eventCountOf(sample);
  const { beadMask, beadCount, beadChannels, dnaChannels, thresholds } = identifyBeads(sample, options);
  if (beadCount < 10) throw new Error(`Only ${beadCount} bead events were found; check the bead channels or set the bead thresholds.`);
  const timeName = options.timeChannel ?? (sample.channels ?? []).find((c) => c.type === 'time' && sample.columns?.[c.name])?.name ?? null;
  const time = timeName ? columnOf(sample, timeName) : null;
  const timeOf = (i) => (time ? time[i] : i);
  const beads = new Uint32Array(beadCount);
  for (let i = 0, k = 0; i < n; i += 1) if (beadMask[i]) beads[k++] = i;
  beads.sort((a, b) => timeOf(a) - timeOf(b) || a - b);
  const beadTimes = Float64Array.from(beads, (i) => timeOf(i));
  const window = Math.min(options.window ?? 501, beadCount);
  const tokens = options.beadChannels ?? DEFAULT_BEAD_MASSES;
  const baseline = {};
  const smoothed = [];
  const beadTracks = {};
  beadChannels.forEach((name, k) => {
    const column = columnOf(sample, name);
    const raw = Float64Array.from(beads, (i) => column[i]);
    const given = options.baseline?.[name] ?? options.baseline?.[tokens[k]];
    baseline[name] = given !== undefined ? Number(given) : median(raw);
    const smooth = runningMedian(raw, window);
    smoothed.push(smooth);
    beadTracks[name] = { raw: Float32Array.from(raw), smoothed: Float32Array.from(smooth), normalized: null };
  });
  const slopes = new Float64Array(beadCount);
  for (let j = 0; j < beadCount; j += 1) {
    let num = 0;
    let den = 0;
    beadChannels.forEach((name, k) => {
      num += baseline[name] * smoothed[k][j];
      den += smoothed[k][j] * smoothed[k][j];
    });
    slopes[j] = den > 0 ? num / den : 1;
  }
  beadChannels.forEach((name, k) => {
    beadTracks[name].normalized = Float32Array.from(smoothed[k], (v, j) => v * slopes[j]);
  });
  // Knots for interpolation: distinct bead times with the mean slope of tied beads.
  const knotT = [];
  const knotS = [];
  for (let j = 0; j < beadCount;) {
    let e = j;
    let sum = 0;
    while (e < beadCount && beadTimes[e] === beadTimes[j]) sum += slopes[e++];
    knotT.push(beadTimes[j]);
    knotS.push(sum / (e - j));
    j = e;
  }
  const factorAt = (t) => {
    if (t <= knotT[0]) return knotS[0];
    const last = knotT.length - 1;
    if (t >= knotT[last]) return knotS[last];
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (knotT[mid] <= t) lo = mid;
      else hi = mid;
    }
    return knotS[lo] + ((knotS[hi] - knotS[lo]) * (t - knotT[lo])) / (knotT[hi] - knotT[lo]);
  };
  const factors = new Float64Array(n);
  for (let i = 0; i < n; i += 1) factors[i] = factorAt(timeOf(i));
  const corrected = options.channels?.length ? options.channels : fluorescenceChannels(sample);
  const columns = { ...sample.columns };
  for (const name of corrected) {
    checkAbort(options);
    const column = columnOf(sample, name);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) out[i] = column[i] * factors[i];
    columns[name] = out;
  }
  const mask = new Uint8Array(n).fill(1);
  if (options.removeBeads !== false) for (let i = 0; i < n; i += 1) if (beadMask[i]) mask[i] = 0;
  return {
    columns,
    corrected,
    mask,
    beadMask,
    beadCount,
    beadChannels,
    dnaChannels,
    thresholds,
    baseline,
    window,
    timeChannel: timeName,
    beadTimes,
    slopes,
    beadTracks,
  };
}

// --- Diagnostics ----------------------------------------------------------------------------

// Per channel, the Earth Mover's (Wasserstein-1) and Kolmogorov–Smirnov distances between each
// batch and the pooled distribution (batches weighted equally), in transformed units (the
// fraction of the display axis), before and — with options.after, the normalized samples in the
// same order — after normalization. Each sample contributes at most options.maxEvents (20 000)
// events, the same ones before and after.
export function batchDiagnostics(samples, batches, channels = null, options = {}) {
  if (samples.length !== batches.length) throw new Error('Give one batch per sample.');
  const after = options.after ?? null;
  if (after && after.length !== samples.length) throw new Error('Give one normalized sample per sample.');
  const names = channels?.length ? channels : fluorescenceChannels(samples[0]);
  const keys = [...new Set(batches.map(String))];
  const batchOf = batches.map((b) => keys.indexOf(String(b)));
  const random = createRandom(options.seed ?? 1);
  const maxEvents = options.maxEvents ?? 20000;
  const nBins = options.bins ?? 512;
  const subsets = samples.map((sample) => {
    const n = eventCountOf(sample);
    return n > maxEvents ? sampleIndices(n, maxEvents, random) : null;
  });
  const phases = after ? [['before', samples], ['after', after]] : [['before', samples]];
  const entries = names.map((name) => {
    checkAbort(options);
    const transform = createTransform(options.transforms?.[name] ?? defaultSpec(options));
    const data = phases.map(([, set]) => set.map((s, i) => {
      const column = s.columns?.[name];
      if (!column) throw new Error(`A sample has no channel named "${name}".`);
      const subset = subsets[i];
      const picked = subset ? Float32Array.from(subset, (e) => column[e]) : column;
      return applyTransform(picked, transform, new Float64Array(picked.length));
    }));
    let lo = Infinity;
    let hi = -Infinity;
    for (const set of data) for (const values of set) for (let i = 0; i < values.length; i += 1) {
      const v = values[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const width = hi > lo ? (hi - lo) / nBins : 1;
    const entry = { channel: name };
    phases.forEach(([phase], p) => {
      const hists = keys.map(() => new Float64Array(nBins));
      const totals = new Float64Array(keys.length);
      data[p].forEach((values, s) => {
        const h = hists[batchOf[s]];
        for (let i = 0; i < values.length; i += 1) {
          const v = values[i];
          if (!Number.isFinite(v)) continue;
          h[Math.min(nBins - 1, Math.floor((v - lo) / width))] += 1;
          totals[batchOf[s]] += 1;
        }
      });
      const pooled = new Float64Array(nBins);
      hists.forEach((h, b) => { if (totals[b]) for (let i = 0; i < nBins; i += 1) pooled[i] += h[i] / totals[b] / keys.length; });
      const result = {};
      let emdSum = 0;
      let ksMax = 0;
      hists.forEach((h, b) => {
        let cdf = 0;
        let cdfPool = 0;
        let emd = 0;
        let ks = 0;
        for (let i = 0; i < nBins; i += 1) {
          cdf += totals[b] ? h[i] / totals[b] : 0;
          cdfPool += pooled[i];
          const d = Math.abs(cdf - cdfPool);
          emd += d * width;
          if (d > ks) ks = d;
        }
        result[keys[b]] = { emd, ks, events: totals[b] };
        emdSum += emd;
        ksMax = Math.max(ksMax, ks);
      });
      entry[phase] = result;
      entry[`meanEmd${phase === 'before' ? 'Before' : 'After'}`] = emdSum / keys.length;
      entry[`maxKs${phase === 'before' ? 'Before' : 'After'}`] = ksMax;
    });
    if (after) entry.improved = entry.meanEmdAfter < entry.meanEmdBefore;
    return entry;
  });
  const mean = (key) => entries.reduce((s, e) => s + e[key], 0) / (entries.length || 1);
  const summary = { meanEmdBefore: mean('meanEmdBefore') };
  if (after) {
    summary.meanEmdAfter = mean('meanEmdAfter');
    summary.improved = summary.meanEmdAfter < summary.meanEmdBefore;
    summary.channelsImproved = entries.filter((e) => e.improved).length;
  }
  return { batches: keys, channels: entries, summary };
}

// Warns when batch and condition are confounded: Cramér's V of the batch × condition table
// ≥ options.threshold (0.8), or a condition acquired in only one of several batches.
// design: [{ batch, condition }] or { batches: [...], conditions: [...] }.
export function confoundingCheck(design, options = {}) {
  const rows = Array.isArray(design)
    ? design
    : (design?.batches ?? []).map((batch, i) => ({ batch, condition: design.conditions?.[i] }));
  const valid = rows.filter((r) => r && r.batch !== undefined && r.batch !== null && r.batch !== '' && r.condition !== undefined && r.condition !== null && r.condition !== '');
  const batches = [...new Set(valid.map((r) => String(r.batch)))];
  const conditions = [...new Set(valid.map((r) => String(r.condition)))];
  const table = batches.map(() => new Array(conditions.length).fill(0));
  for (const r of valid) table[batches.indexOf(String(r.batch))][conditions.indexOf(String(r.condition))] += 1;
  const n = valid.length;
  const rowSums = table.map((row) => row.reduce((s, v) => s + v, 0));
  const colSums = conditions.map((_, j) => table.reduce((s, row) => s + row[j], 0));
  let chiSquare = 0;
  for (let i = 0; i < batches.length; i += 1) {
    for (let j = 0; j < conditions.length; j += 1) {
      const expected = (rowSums[i] * colSums[j]) / n;
      if (expected > 0) chiSquare += (table[i][j] - expected) ** 2 / expected;
    }
  }
  const k = Math.min(batches.length, conditions.length);
  const cramersV = k > 1 && n ? Math.sqrt(chiSquare / (n * (k - 1))) : 0;
  const threshold = options.threshold ?? 0.8;
  const warnings = [];
  const notes = [];
  if (k > 1 && cramersV >= threshold) {
    warnings.push(`Batch and condition are confounded (Cramér's V = ${cramersV.toFixed(2)}): differences between conditions cannot be told apart from batch effects. Spread each condition over the batches and include an anchor sample in every batch.`);
  }
  if (batches.length > 1) {
    conditions.forEach((condition, j) => {
      const present = batches.filter((_, i) => table[i][j] > 0);
      if (present.length === 1) warnings.push(`Condition "${condition}" was acquired only in batch "${present[0]}", so its difference from the other conditions is mixed with that batch's effect.`);
    });
  }
  if (conditions.length > 1) {
    batches.forEach((batch, i) => {
      const present = conditions.filter((_, j) => table[i][j] > 0);
      if (present.length === 1) notes.push(`Batch "${batch}" contains only condition "${present[0]}".`);
    });
  }
  const skipped = rows.length - valid.length;
  if (skipped) notes.push(`${skipped} sample(s) without a batch or condition were left out.`);
  return { batches, conditions, table, n, chiSquare, cramersV, confounded: warnings.length > 0, warnings, notes };
}
