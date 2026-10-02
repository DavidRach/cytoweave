// k-means clustering of events: k-means++ seeding, exact Lloyd iterations accelerated with
// Hamerly's bounds, restarts that keep the lowest inertia, and mini-batch k-means for very
// large inputs.
//
// Arthur D, Vassilvitskii S. k-means++: the advantages of careful seeding. SODA 2007 (greedy
// variant as scikit-learn: 2 + ⌊ln k⌋ candidates per step, keeping the one that lowers the
// potential most). Hamerly G. Making k-means even faster. SDM 2010,
// doi:10.1137/1.9781611972801.12. Sculley D. Web-scale k-means clustering. WWW 2010,
// doi:10.1145/1772690.1772862. Convergence and empty-cluster handling follow scikit-learn's
// KMeans: stop when no label changes or the summed squared centre shift is ≤ tol × the mean
// per-channel variance; an empty cluster is moved to the event farthest from its centre.
//
// Input: `data` is a dense row-major Float32Array of n × dim values on an analysis scale.

import { createRandom, sampleIndices } from './random.js';
import { checkMatrix } from './flowsom.js';

function cancelled() {
  const error = new Error('Clustering was cancelled.');
  error.name = 'AbortError';
  return error;
}

// k-means. Options: seed (1), nInit (3 restarts), maxIter (300 iterations; for mini-batch, at
// most 100 passes over the data), tol (1e-4), algorithm ('hamerly' | 'lloyd' | 'minibatch'; default 'hamerly'), batchSize
// (1024), maxNoImprovement (10, mini-batch early stopping), initSize (events used for k-means++
// seeding: all for Lloyd/Hamerly, 3 × batchSize for mini-batch), init (Float64Array of k × dim
// starting centres, used for the first restart), onProgress, signal.
// Returns { labels: Int32Array(n), centers: Float64Array(k × dim), counts: Uint32Array(k),
// inertia, iterations, converged, seed }.
export function kmeans(data, n, dim, k, options = {}) {
  checkMatrix(data, n, dim);
  if (!Number.isInteger(k) || k < 1) throw new Error('The number of clusters must be a whole number of at least 1.');
  if (k > n) throw new Error(`Cannot make ${k} clusters from ${n} events.`);
  const seed = options.seed ?? 1;
  const nInit = Math.max(1, options.nInit ?? 3);
  const algorithm = options.algorithm ?? 'hamerly';
  if (!['hamerly', 'lloyd', 'minibatch'].includes(algorithm)) {
    throw new Error(`Unknown k-means algorithm "${algorithm}"; use hamerly, lloyd or minibatch.`);
  }
  const { onProgress, signal } = options;
  const random = createRandom(seed);
  const tol = (options.tol ?? 1e-4) * meanVariance(data, n, dim);
  // Mini-batch seeds on a subsample, as scikit-learn (init_size = 3 × batch_size, at least 3k).
  const defaultInit = algorithm === 'minibatch' ? Math.max(3 * (options.batchSize ?? 1024), 3 * k) : n;
  const initSize = Math.max(k, Math.min(n, options.initSize ?? defaultInit));
  let best = null;
  for (let run = 0; run < nInit; run += 1) {
    if (signal?.aborted) throw cancelled();
    const report = onProgress
      ? (f, message) => onProgress((run + f) / nInit, nInit > 1 ? `${message} (start ${run + 1} of ${nInit})` : message)
      : null;
    let centers;
    if (run === 0 && options.init) centers = Float64Array.from(options.init);
    else if (initSize < n) {
      const pick = sampleIndices(n, initSize, random);
      const sample = new Float32Array(initSize * dim);
      for (let i = 0; i < initSize; i += 1) sample.set(data.subarray(pick[i] * dim, pick[i] * dim + dim), i * dim);
      centers = kmeansPlusPlus(sample, initSize, dim, k, random);
    } else {
      centers = kmeansPlusPlus(data, n, dim, k, random);
    }
    const result = algorithm === 'minibatch'
      ? miniBatch(data, n, dim, k, centers, random, { ...options, tol, report })
      : lloyd(data, n, dim, k, centers, { ...options, tol, report, accelerate: algorithm === 'hamerly' });
    if (!best || result.inertia < best.inertia) best = result;
  }
  if (onProgress) onProgress(1, 'k-means done');
  return { ...best, seed };
}

function meanVariance(data, n, dim) {
  let total = 0;
  for (let j = 0; j < dim; j += 1) {
    let m = 0;
    for (let i = 0; i < n; i += 1) m += data[i * dim + j];
    m /= n;
    let ss = 0;
    for (let i = 0; i < n; i += 1) {
      const t = data[i * dim + j] - m;
      ss += t * t;
    }
    total += ss / n;
  }
  return total / dim;
}

function squaredDistance(data, base, centers, off, dim) {
  let s = 0;
  for (let j = 0; j < dim; j += 1) {
    const t = data[base + j] - centers[off + j];
    s += t * t;
  }
  return s;
}

// Greedy k-means++ seeding. Returns Float64Array(k × dim).
export function kmeansPlusPlus(data, n, dim, k, random) {
  const centers = new Float64Array(k * dim);
  const trials = 2 + Math.floor(Math.log(k));
  let closest = new Float64Array(n);
  let candidate = new Float64Array(n);
  let bestNext = new Float64Array(n);
  const cumulative = new Float64Array(n);
  const first = random.int(n);
  for (let j = 0; j < dim; j += 1) centers[j] = data[first * dim + j];
  let potential = 0;
  for (let i = 0; i < n; i += 1) {
    closest[i] = squaredDistance(data, i * dim, centers, 0, dim);
    potential += closest[i];
  }
  for (let c = 1; c < k; c += 1) {
    let acc = 0;
    for (let i = 0; i < n; i += 1) {
      acc += closest[i];
      cumulative[i] = acc;
    }
    let bestIndex = -1;
    let bestPotential = Infinity;
    for (let t = 0; t < trials; t += 1) {
      let index;
      if (acc > 0) {
        // First event whose cumulative potential exceeds a uniform draw (probability ∝ D²).
        const r = random() * acc;
        let lo = 0; let hi = n - 1;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (cumulative[mid] > r) hi = mid;
          else lo = mid + 1;
        }
        index = lo;
      } else {
        index = random.int(n); // every event coincides with a centre already
      }
      const base = index * dim;
      let p = 0;
      for (let i = 0; i < n; i += 1) {
        const d = squaredDistance(data, i * dim, data, base, dim);
        const v = d < closest[i] ? d : closest[i];
        candidate[i] = v;
        p += v;
      }
      if (p < bestPotential) {
        bestPotential = p;
        bestIndex = index;
        const swap = bestNext; bestNext = candidate; candidate = swap;
      }
    }
    for (let j = 0; j < dim; j += 1) centers[c * dim + j] = data[bestIndex * dim + j];
    const swap = closest; closest = bestNext; bestNext = swap;
    potential = bestPotential;
  }
  return centers;
}

// Nearest and second-nearest centre of one event by full scan; writes into out = [label, d1², d2²].
function scan(data, base, centers, k, dim, out) {
  let b1 = -1; let d1 = Infinity; let d2 = Infinity;
  for (let c = 0, off = 0; c < k; c += 1, off += dim) {
    const d = squaredDistance(data, base, centers, off, dim);
    if (d < d1) {
      d2 = d1;
      d1 = d;
      b1 = c;
    } else if (d < d2) {
      d2 = d;
    }
  }
  out[0] = b1; out[1] = d1; out[2] = d2;
}

// Lloyd iterations; with `accelerate`, Hamerly's upper/lower bounds skip most distance
// computations while giving the same assignments as a full scan.
function lloyd(data, n, dim, k, centers, options) {
  const { tol, report, signal } = options;
  const maxIter = options.maxIter ?? 300;
  const accelerate = options.accelerate;
  const labels = new Int32Array(n);
  const upper = new Float64Array(n);
  const lower = new Float64Array(n);
  const sums = new Float64Array(k * dim);
  const counts = new Float64Array(k);
  const old = new Float64Array(k * dim);
  const moved = new Float64Array(k);
  const half = new Float64Array(k);
  const out = new Float64Array(3);

  for (let i = 0; i < n; i += 1) {
    const base = i * dim;
    scan(data, base, centers, k, dim, out);
    const c = out[0];
    labels[i] = c;
    upper[i] = Math.sqrt(out[1]);
    lower[i] = Math.sqrt(out[2]);
    counts[c] += 1;
    for (let j = 0; j < dim; j += 1) sums[c * dim + j] += data[base + j];
  }

  let iterations = 0;
  let strict = false;
  for (let iter = 0; iter < maxIter; iter += 1) {
    if (signal?.aborted) throw cancelled();
    iterations = iter + 1;
    if (iter > 0) {
      // Assignment step.
      let changed = 0;
      if (accelerate) {
        for (let a = 0; a < k; a += 1) {
          let m = Infinity;
          for (let b = 0; b < k; b += 1) {
            if (b === a) continue;
            const d = squaredDistance(centers, a * dim, centers, b * dim, dim);
            if (d < m) m = d;
          }
          half[a] = Math.sqrt(m) / 2;
        }
      }
      for (let i = 0; i < n; i += 1) {
        const base = i * dim;
        const a = labels[i];
        if (accelerate) {
          const bound = half[a] > lower[i] ? half[a] : lower[i];
          if (upper[i] <= bound) continue;
          upper[i] = Math.sqrt(squaredDistance(data, base, centers, a * dim, dim));
          if (upper[i] <= bound) continue;
        }
        scan(data, base, centers, k, dim, out);
        const c = out[0];
        upper[i] = Math.sqrt(out[1]);
        lower[i] = Math.sqrt(out[2]);
        if (c !== a) {
          changed += 1;
          labels[i] = c;
          counts[a] -= 1;
          counts[c] += 1;
          for (let j = 0; j < dim; j += 1) {
            const v = data[base + j];
            sums[a * dim + j] -= v;
            sums[c * dim + j] += v;
          }
        }
      }
      if (changed === 0) {
        strict = true;
        break;
      }
    }
    // Update step, with empty clusters moved to the events farthest from their centres.
    relocateEmpty(data, n, dim, k, centers, labels, counts, sums, upper, lower);
    old.set(centers);
    let shift = 0;
    let maxMove = 0; let maxIndex = -1; let secondMove = 0;
    for (let c = 0; c < k; c += 1) {
      let s = 0;
      if (counts[c] > 0) {
        for (let j = 0; j < dim; j += 1) {
          const v = sums[c * dim + j] / counts[c];
          const t = v - old[c * dim + j];
          s += t * t;
          centers[c * dim + j] = v;
        }
      }
      shift += s;
      moved[c] = Math.sqrt(s);
      if (moved[c] > maxMove) {
        secondMove = maxMove;
        maxMove = moved[c];
        maxIndex = c;
      } else if (moved[c] > secondMove) {
        secondMove = moved[c];
      }
    }
    for (let i = 0; i < n; i += 1) {
      const a = labels[i];
      upper[i] += moved[a];
      lower[i] -= a === maxIndex ? secondMove : maxMove;
    }
    if (report) report(Math.min(0.99, iterations / maxIter), `k-means iteration ${iterations}`);
    if (shift <= tol) break;
  }
  if (!strict) {
    // Final assignment so the labels match the returned centres.
    counts.fill(0);
    for (let i = 0; i < n; i += 1) {
      scan(data, i * dim, centers, k, dim, out);
      labels[i] = out[0];
      counts[out[0]] += 1;
    }
  }
  return finish(data, n, dim, k, centers, labels, iterations, strict || iterations < maxIter);
}

function relocateEmpty(data, n, dim, k, centers, labels, counts, sums, upper, lower) {
  let taken = null;
  for (let c = 0; c < k; c += 1) {
    if (counts[c] > 0) continue;
    taken ??= new Uint8Array(n);
    let far = -1; let farD = -1;
    for (let i = 0; i < n; i += 1) {
      if (taken[i] || counts[labels[i]] <= 1) continue;
      const d = squaredDistance(data, i * dim, centers, labels[i] * dim, dim);
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far < 0) continue; // fewer distinct events than clusters
    taken[far] = 1;
    const from = labels[far];
    const base = far * dim;
    counts[from] -= 1;
    counts[c] = 1;
    for (let j = 0; j < dim; j += 1) {
      sums[from * dim + j] -= data[base + j];
      sums[c * dim + j] = data[base + j];
    }
    labels[far] = c;
    upper[far] = 0;
    lower[far] = 0;
  }
}

// Mini-batch k-means: random batches (with replacement) pull each centre toward its members at
// a per-centre rate 1 / (events seen), stopping when the smoothed batch inertia has not improved
// for maxNoImprovement batches or the centres stop moving.
function miniBatch(data, n, dim, k, centers, random, options) {
  const { tol, report, signal } = options;
  const batchSize = Math.min(n, options.batchSize ?? 1024);
  const maxSteps = Math.ceil(((options.maxIter ?? 100) * n) / batchSize);
  const maxNoImprovement = options.maxNoImprovement ?? 10;
  const seen = new Float64Array(k);
  const batchSums = new Float64Array(k * dim);
  const batchCounts = new Float64Array(k);
  const out = new Float64Array(3);
  const alpha = Math.min(1, (2 * batchSize) / (n + 1));
  let ewa = -1;
  let bestEwa = Infinity;
  let stale = 0;
  let steps = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    if ((step & 63) === 0) {
      if (signal?.aborted) throw cancelled();
      if (report) report(Math.min(0.99, step / maxSteps), 'Mini-batch k-means');
    }
    steps = step + 1;
    batchSums.fill(0);
    batchCounts.fill(0);
    let inertia = 0;
    for (let b = 0; b < batchSize; b += 1) {
      const i = random.int(n);
      const base = i * dim;
      scan(data, base, centers, k, dim, out);
      const c = out[0];
      inertia += out[1];
      batchCounts[c] += 1;
      for (let j = 0; j < dim; j += 1) batchSums[c * dim + j] += data[base + j];
    }
    let shift = 0;
    for (let c = 0; c < k; c += 1) {
      if (!batchCounts[c]) continue;
      const total = seen[c] + batchCounts[c];
      for (let j = 0; j < dim; j += 1) {
        const v = (centers[c * dim + j] * seen[c] + batchSums[c * dim + j]) / total;
        const t = v - centers[c * dim + j];
        shift += t * t;
        centers[c * dim + j] = v;
      }
      seen[c] = total;
    }
    inertia /= batchSize;
    ewa = ewa < 0 ? inertia : ewa * (1 - alpha) + inertia * alpha;
    if (ewa < bestEwa) {
      bestEwa = ewa;
      stale = 0;
    } else {
      stale += 1;
    }
    if (step > 0 && (shift <= tol || stale >= maxNoImprovement)) break;
  }
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    scan(data, i * dim, centers, k, dim, out);
    labels[i] = out[0];
  }
  return finish(data, n, dim, k, centers, labels, steps, steps < maxSteps);
}

function finish(data, n, dim, k, centers, labels, iterations, converged) {
  const counts = new Uint32Array(k);
  let inertia = 0;
  for (let i = 0; i < n; i += 1) {
    const c = labels[i];
    counts[c] += 1;
    inertia += squaredDistance(data, i * dim, centers, c * dim, dim);
  }
  return { labels, centers, counts, inertia, iterations, converged };
}

// Labels of new events by their nearest centre (e.g. to apply a clustering to other samples).
export function assignToCenters(data, n, dim, centers, k) {
  const labels = new Int32Array(n);
  const out = new Float64Array(3);
  for (let i = 0; i < n; i += 1) {
    scan(data, i * dim, centers, k, dim, out);
    labels[i] = out[0];
  }
  return labels;
}
