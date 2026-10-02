// "Embedding honesty": how far a 2-D map (t-SNE, UMAP, …) can be trusted.
//
//   trustworthiness    Venna & Kaski 2001 (doi:10.1007/3-540-44668-0_68), with continuity, its
//                      mirror image; computed exactly for a seeded subsample of query events
//                      against all events, which estimates the full-data value without bias.
//   knnPreservation    mean fraction of each event's k nearest neighbours (high-dimensional) that
//                      are also among its k nearest in the embedding (Kobak & Berens 2019).
//   seedStability      neighbourhood overlap and Procrustes disparity between two embeddings of
//                      the same events (e.g. two seeds); Gower 1975 orthogonal Procrustes.
//   mixingEntropy      per-event normalised Shannon entropy of a category (sample, batch) among
//                      its embedding neighbours.
//   lisi               local inverse Simpson's index with perplexity 30 (Korsunsky et al. 2019,
//                      Harmony, doi:10.1038/s41592-019-0619-0), as the LISI R package computes it.
//   regionReliability  per-event neighbourhood precision and recall (Venna et al. 2010, JMLR
//                      11:451) for shading unreliable regions of a map.
//   assessEmbedding    all of the above with plain-language warnings.
//
// `high` is the n × dimHigh row-major matrix the embedding was computed from (same transform and
// channels); `low` the n × dimLow embedding. All results are deterministic for options.seed.

import { createRandom, sampleIndices } from './random.js';
import { DEFAULT_SEED, createKnnIndex, knn, progressRange, queryKnn, throwIfAborted } from './knn.js';

function checkMatrix(data, n, dim, name) {
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(dim) || dim < 1) throw new Error('Event and dimension counts must be positive whole numbers.');
  if (!data || data.length < n * dim) throw new Error(`The ${name} should hold ${n} × ${dim} values but has ${data ? data.length : 0}.`);
}

function checkK(n, k) {
  if (!Number.isInteger(k) || k < 1) throw new Error('The neighbourhood size k must be a positive whole number.');
  if (k >= n / 2) throw new Error(`A neighbourhood of ${k} needs more than ${2 * k} events; this selection has ${n}.`);
}

// Max-heap of (distance, index) pairs of fixed size k in flat arrays; root = current worst.
function heapInsert(idx, dist, k, j, d) {
  let pos = 0;
  for (;;) {
    const left = 2 * pos + 1;
    if (left >= k) break;
    const right = left + 1;
    let child = left;
    if (right < k && dist[right] > dist[left]) child = right;
    if (!(dist[child] > d)) break;
    dist[pos] = dist[child];
    idx[pos] = idx[child];
    pos = child;
  }
  dist[pos] = d;
  idx[pos] = j;
}

// Squared distances from row i of X to every row (Float64Array n).
function distancesFrom(X, n, dim, i, out) {
  const o = i * dim;
  for (let l = 0; l < n; l += 1) {
    const b = l * dim;
    let d = 0;
    for (let t = 0; t < dim; t += 1) {
      const diff = X[o + t] - X[b + t];
      d += diff * diff;
    }
    out[l] = d;
  }
}

// The k nearest (excluding `self`) by the distances in `dist`, ascending by (distance, index).
function nearest(dist, n, self, k, idxOut, distOut) {
  idxOut.fill(-1);
  distOut.fill(Infinity);
  for (let l = 0; l < n; l += 1) {
    if (l === self) continue;
    const d = dist[l];
    if (d < distOut[0] || (d === distOut[0] && l < idxOut[0])) heapInsert(idxOut, distOut, k, l, d);
  }
  const order = Array.from({ length: k }, (_, t) => t).sort((a, b) => distOut[a] - distOut[b] || idxOut[a] - idxOut[b]);
  const ids = order.map((t) => idxOut[t]);
  const ds = order.map((t) => distOut[t]);
  for (let t = 0; t < k; t += 1) {
    idxOut[t] = ids[t];
    distOut[t] = ds[t];
  }
}

// Σ (r(j) − k) over `items`, where r(j) = 1 + #{l ≠ self : (dist[l], l) < (dist[j], j)} is j's
// rank among all other events (ties broken by index, as a stable argsort).
function rankPenalty(dist, n, self, items, count, k) {
  if (!count) return 0;
  const sorted = Array.from(items.subarray(0, count)).sort((a, b) => dist[a] - dist[b] || a - b);
  const vals = Float64Array.from(sorted, (j) => dist[j]);
  const ids = Int32Array.from(sorted);
  const hist = new Int32Array(count + 1);
  const vmax = vals[count - 1];
  for (let l = 0; l < n; l += 1) {
    if (l === self) continue;
    const d = dist[l];
    if (d > vmax) continue;
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vals[mid] < d || (vals[mid] === d && ids[mid] <= l)) lo = mid + 1;
      else hi = mid;
    }
    hist[lo] += 1;
  }
  let sum = 0;
  let cumulative = 0;
  for (let t = 0; t < count; t += 1) {
    cumulative += hist[t];
    sum += 1 + cumulative - k;
  }
  return sum;
}

function chooseSample(n, options) {
  const { sampleSize = 1000, seed = DEFAULT_SEED, sample } = options;
  if (sample) return Uint32Array.from(sample);
  return sampleIndices(n, Math.min(n, sampleSize), createRandom(seed));
}

// Exact neighbourhood statistics of the sampled events against all events, in both spaces.
function sampledNeighbourhoods(high, low, n, dimHigh, dimLow, k, sample, options = {}) {
  const { keepHigh = 0, keepLow = 0, onProgress, signal } = options;
  const m = sample.length;
  const dH = new Float64Array(n);
  const dL = new Float64Array(n);
  const hIdx = new Int32Array(k);
  const hDist = new Float64Array(k);
  const lIdx = new Int32Array(k);
  const lDist = new Float64Array(k);
  const markH = new Int32Array(n).fill(-1);
  const markL = new Int32Array(n).fill(-1);
  const missing = new Int32Array(k);
  const trustPenalty = new Float64Array(m);
  const continuityPenalty = new Float64Array(m);
  const overlap = new Float64Array(m);
  const wideH = keepHigh ? { indices: new Int32Array(m * keepHigh), distances: new Float64Array(m * keepHigh) } : null;
  const wideL = keepLow ? { indices: new Int32Array(m * keepLow), distances: new Float64Array(m * keepLow) } : null;
  const tmpIdx = new Int32Array(Math.max(keepHigh, keepLow, 1));
  const tmpDist = new Float64Array(Math.max(keepHigh, keepLow, 1));
  for (let s = 0; s < m; s += 1) {
    if ((s & 31) === 0) {
      throwIfAborted(signal);
      if (onProgress) onProgress(s / m, 'Comparing neighbourhoods');
    }
    const i = sample[s];
    distancesFrom(high, n, dimHigh, i, dH);
    distancesFrom(low, n, dimLow, i, dL);
    nearest(dH, n, i, k, hIdx, hDist);
    nearest(dL, n, i, k, lIdx, lDist);
    for (let t = 0; t < k; t += 1) {
      markH[hIdx[t]] = s;
      markL[lIdx[t]] = s;
    }
    let shared = 0;
    let count = 0;
    for (let t = 0; t < k; t += 1) {
      if (markH[lIdx[t]] === s) shared += 1;
      else missing[count++] = lIdx[t];
    }
    overlap[s] = shared / k;
    trustPenalty[s] = rankPenalty(dH, n, i, missing, count, k);
    count = 0;
    for (let t = 0; t < k; t += 1) if (markL[hIdx[t]] !== s) missing[count++] = hIdx[t];
    continuityPenalty[s] = rankPenalty(dL, n, i, missing, count, k);
    if (wideH) {
      nearest(dH, n, i, keepHigh, tmpIdx.subarray(0, keepHigh), tmpDist.subarray(0, keepHigh));
      for (let t = 0; t < keepHigh; t += 1) {
        wideH.indices[s * keepHigh + t] = tmpIdx[t];
        wideH.distances[s * keepHigh + t] = Math.sqrt(tmpDist[t]);
      }
    }
    if (wideL) {
      nearest(dL, n, i, keepLow, tmpIdx.subarray(0, keepLow), tmpDist.subarray(0, keepLow));
      for (let t = 0; t < keepLow; t += 1) {
        wideL.indices[s * keepLow + t] = tmpIdx[t];
        wideL.distances[s * keepLow + t] = Math.sqrt(tmpDist[t]);
      }
    }
  }
  const norm = 2 / (k * (2 * n - 3 * k - 1));
  const localTrust = new Float32Array(m);
  const localContinuity = new Float32Array(m);
  let trust = 0;
  let continuity = 0;
  let preserved = 0;
  for (let s = 0; s < m; s += 1) {
    localTrust[s] = 1 - norm * trustPenalty[s];
    localContinuity[s] = 1 - norm * continuityPenalty[s];
    trust += 1 - norm * trustPenalty[s];
    continuity += 1 - norm * continuityPenalty[s];
    preserved += overlap[s];
  }
  return {
    trustworthiness: trust / m,
    continuity: continuity / m,
    knnPreservation: preserved / m,
    localTrust,
    localContinuity,
    overlap: Float32Array.from(overlap),
    wideHigh: wideH,
    wideLow: wideL,
  };
}

// Trustworthiness T(k) = 1 − 2/(n k (2n − 3k − 1)) Σ_i Σ_{j ∈ U_k(i)} (r(i, j) − k), where U_k(i)
// are the embedding neighbours of i that are not among its k nearest in the original space and r
// their rank there (Venna & Kaski 2001; equals sklearn.manifold.trustworthiness on all events).
// Evaluated for options.sampleSize (1000) seeded query events against all n events. Returns
// { value, continuity, knnPreservation, perPoint (local trustworthiness of the sampled events),
// sample, k }.
export function trustworthiness(high, low, n, dimHigh, dimLow, k = 15, options = {}) {
  checkMatrix(high, n, dimHigh, 'original data');
  checkMatrix(low, n, dimLow, 'embedding');
  checkK(n, k);
  const sample = chooseSample(n, options);
  const stats = sampledNeighbourhoods(high, low, n, dimHigh, dimLow, k, sample, options);
  return {
    value: stats.trustworthiness,
    continuity: stats.continuity,
    knnPreservation: stats.knnPreservation,
    perPoint: stats.localTrust,
    perPointContinuity: stats.localContinuity,
    sample,
    k,
  };
}

// Mean fraction of each event's k nearest original-space neighbours that are also among its k
// nearest embedding neighbours. Exact on a seeded subsample (options.sampleSize, default 1000);
// with options.full = true, over all events using the neighbour searches of knn.js (approximate in
// the original space above 5000 events). Chance level is k / (n − 1).
export function knnPreservation(high, low, n, dimHigh, dimLow, k = 15, options = {}) {
  checkMatrix(high, n, dimHigh, 'original data');
  checkMatrix(low, n, dimLow, 'embedding');
  checkK(n, k);
  if (options.full) {
    const highKnn = options.highKnn ?? knn(high, n, dimHigh, k, { seed: options.seed, signal: options.signal });
    const lowKnn = options.lowKnn ?? knn(low, n, dimLow, k, { signal: options.signal });
    const kh = highKnn.indices.length / n;
    const kl = lowKnn.indices.length / n;
    const perPoint = new Float32Array(n);
    const mark = new Int32Array(n).fill(-1);
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      for (let t = 0; t < k; t += 1) mark[highKnn.indices[i * kh + t]] = i;
      let shared = 0;
      for (let t = 0; t < k; t += 1) if (mark[lowKnn.indices[i * kl + t]] === i) shared += 1;
      perPoint[i] = shared / k;
      total += shared / k;
    }
    return { value: total / n, perPoint, chance: k / (n - 1), k };
  }
  const sample = chooseSample(n, options);
  const stats = sampledNeighbourhoods(high, low, n, dimHigh, dimLow, k, sample, options);
  return { value: stats.knnPreservation, perPoint: stats.overlap, sample, chance: k / (n - 1), k };
}

// --- Seed stability ------------------------------------------------------------------------------

// Orthogonal Procrustes (reflections allowed) after centring both and scaling each to unit
// Frobenius norm, as scipy.spatial.procrustes: disparity = 1 − (Σ σ)², σ the singular values of
// BᵀA. Returns { disparity, rmsd (aligned RMS distance in units of A's RMS radius), scale,
// rotation (dim × dim, B·R ≈ A), displacement (per event, same units) }.
export function procrustes(A, B, n, dim) {
  const ca = new Float64Array(dim);
  const cb = new Float64Array(dim);
  for (let i = 0; i < n; i += 1) {
    for (let d = 0; d < dim; d += 1) {
      ca[d] += A[i * dim + d];
      cb[d] += B[i * dim + d];
    }
  }
  for (let d = 0; d < dim; d += 1) {
    ca[d] /= n;
    cb[d] /= n;
  }
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    for (let d = 0; d < dim; d += 1) {
      na += (A[i * dim + d] - ca[d]) ** 2;
      nb += (B[i * dim + d] - cb[d]) ** 2;
    }
  }
  na = Math.sqrt(na) || 1;
  nb = Math.sqrt(nb) || 1;
  // M = Bᵀ A (dim × dim) of the standardised configurations.
  const M = new Float64Array(dim * dim);
  for (let i = 0; i < n; i += 1) {
    for (let r = 0; r < dim; r += 1) {
      const b = (B[i * dim + r] - cb[r]) / nb;
      for (let c = 0; c < dim; c += 1) M[r * dim + c] += b * ((A[i * dim + c] - ca[c]) / na);
    }
  }
  // Polar decomposition M = R S via the eigen-decomposition of MᵀM: R = M V Σ⁻¹ Vᵀ.
  const MtM = new Float64Array(dim * dim);
  for (let r = 0; r < dim; r += 1) {
    for (let c = 0; c < dim; c += 1) {
      let s = 0;
      for (let t = 0; t < dim; t += 1) s += M[t * dim + r] * M[t * dim + c];
      MtM[r * dim + c] = s;
    }
  }
  const { values, vectors } = jacobiEigen(MtM, dim);
  let traceNorm = 0;
  const inv = new Float64Array(dim);
  for (let c = 0; c < dim; c += 1) {
    const sigma = Math.sqrt(Math.max(0, values[c]));
    traceNorm += sigma;
    inv[c] = sigma > 1e-12 ? 1 / sigma : 0;
  }
  const R = new Float64Array(dim * dim);
  for (let r = 0; r < dim; r += 1) {
    for (let c = 0; c < dim; c += 1) {
      let s = 0;
      for (let t = 0; t < dim; t += 1) {
        // (M V Σ⁻¹ Vᵀ)_{rc} = Σ_t (M V)_{rt} inv_t V_{ct}
        let mv = 0;
        for (let u = 0; u < dim; u += 1) mv += M[r * dim + u] * vectors[u * dim + t];
        s += mv * inv[t] * vectors[c * dim + t];
      }
      R[r * dim + c] = s;
    }
  }
  const disparity = Math.max(0, 1 - traceNorm * traceNorm);
  // Per-event displacement after alignment, in units of A's RMS radius (‖A‖_F / √n).
  const displacement = new Float32Array(n);
  const unit = Math.sqrt(n);
  for (let i = 0; i < n; i += 1) {
    let e = 0;
    for (let c = 0; c < dim; c += 1) {
      let aligned = 0;
      for (let r = 0; r < dim; r += 1) aligned += ((B[i * dim + r] - cb[r]) / nb) * R[r * dim + c];
      const diff = (A[i * dim + c] - ca[c]) / na - traceNorm * aligned;
      e += diff * diff;
    }
    displacement[i] = Math.sqrt(e) * unit;
  }
  return { disparity, rmsd: Math.sqrt(disparity), scale: (traceNorm * na) / nb, rotation: R, displacement };
}

// Cyclic Jacobi for the tiny symmetric matrices above (dim ≤ 3 in practice); eigenvalues
// descending, eigenvectors as columns.
function jacobiEigen(matrix, n) {
  const m = Float64Array.from(matrix);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 64; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n; p += 1) for (let q = p + 1; q < n; q += 1) off += m[p * n + q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = m[p * n + q];
        if (apq === 0) continue;
        const theta = (m[q * n + q] - m[p * n + p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = m[k * n + p];
          const akq = m[k * n + q];
          m[k * n + p] = c * akp - s * akq;
          m[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = m[p * n + k];
          const aqk = m[q * n + k];
          m[p * n + k] = c * apk - s * aqk;
          m[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = v[k * n + p];
          const vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => m[y * n + y] - m[x * n + x]);
  const values = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  order.forEach((j, c) => {
    values[c] = m[j * n + j];
    for (let i = 0; i < n; i += 1) vectors[i * n + c] = v[i * n + j];
  });
  return { values, vectors };
}

// Agreement of two embeddings of the same events (different seeds, subsamples or parameters):
// per-event fraction of shared k nearest neighbours, and the Procrustes disparity of the whole
// layouts (0 = identical up to rotation, reflection, scale and shift). Options: dim (2).
export function seedStability(embeddingA, embeddingB, n, k = 15, options = {}) {
  const { dim = 2, signal } = options;
  checkMatrix(embeddingA, n, dim, 'first embedding');
  checkMatrix(embeddingB, n, dim, 'second embedding');
  checkK(n, k);
  const knnA = knn(embeddingA, n, dim, k, { signal });
  const knnB = knn(embeddingB, n, dim, k, { signal });
  const perPoint = new Float32Array(n);
  const mark = new Int32Array(n).fill(-1);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) mark[knnA.indices[i * k + t]] = i;
    let shared = 0;
    for (let t = 0; t < k; t += 1) if (mark[knnB.indices[i * k + t]] === i) shared += 1;
    perPoint[i] = shared / k;
    total += shared / k;
  }
  const fit = procrustes(embeddingA, embeddingB, n, dim);
  return {
    neighbourOverlap: total / n,
    perPoint,
    disparity: fit.disparity,
    rmsd: fit.rmsd,
    displacement: fit.displacement,
    rotation: fit.rotation,
    scale: fit.scale,
    k,
  };
}

// --- Batch mixing --------------------------------------------------------------------------------

// Category codes 0…C−1 for any array of labels (numbers or strings).
function encodeLabels(labels, n) {
  if (!labels || labels.length < n) throw new Error(`Expected ${n} labels (one per event).`);
  const map = new Map();
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    let c = map.get(labels[i]);
    if (c === undefined) {
      c = map.size;
      map.set(labels[i], c);
    }
    codes[i] = c;
  }
  const counts = new Float64Array(map.size);
  for (let i = 0; i < n; i += 1) counts[codes[i]] += 1;
  return { codes, categories: map.size, proportions: Float64Array.from(counts, (c) => c / n) };
}

function median(values) {
  const sorted = Float64Array.from(values).sort();
  const m = sorted.length;
  if (!m) return NaN;
  return m % 2 ? sorted[(m - 1) / 2] : (sorted[m / 2 - 1] + sorted[m / 2]) / 2;
}

// Normalised Shannon entropy H/ln C of the labels among each event's k embedding neighbours
// (1 = as mixed as possible, 0 = all neighbours share one label). `expected` is the entropy of the
// overall label proportions — the value perfect mixing would give. Options: dim (2).
export function mixingEntropy(low, n, labels, k = 30, options = {}) {
  const { dim = 2, signal } = options;
  checkMatrix(low, n, dim, 'embedding');
  const kk = Math.min(k, n - 1);
  const { codes, categories, proportions } = encodeLabels(labels, n);
  const perPoint = new Float32Array(n);
  if (categories < 2) return { perPoint: perPoint.fill(1), mean: 1, median: 1, expected: 1, relative: 1, categories, k: kk };
  const neighbours = options.knn ?? knn(low, n, dim, kk, { signal });
  const kn = neighbours.indices.length / n;
  const counts = new Int32Array(categories);
  const logC = Math.log(categories);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    counts.fill(0);
    for (let t = 0; t < kn; t += 1) counts[codes[neighbours.indices[i * kn + t]]] += 1;
    let h = 0;
    for (let c = 0; c < categories; c += 1) {
      if (counts[c]) {
        const p = counts[c] / kn;
        h -= p * Math.log(p);
      }
    }
    perPoint[i] = h / logC;
    total += perPoint[i];
  }
  let expected = 0;
  for (let c = 0; c < categories; c += 1) if (proportions[c] > 0) expected -= (proportions[c] * Math.log(proportions[c])) / logC;
  const mean = total / n;
  return { perPoint, mean, median: median(perPoint), expected, relative: expected > 0 ? mean / expected : 1, categories, k: kn };
}

// Simpson's index Σ_c (Σ_{j ∈ c} P_j)² of one neighbourhood with Gaussian weights P_j ∝
// exp(−β d_j) on (unsquared) distances, β set by bisection to the perplexity, as LISI's
// compute_simpson_index. `d` includes the event itself at distance 0.
function simpsonIndex(d, codes, ids, kk, perplexity, P, counts) {
  const logU = Math.log(perplexity);
  let beta = 1;
  let betaMin = -Infinity;
  let betaMax = Infinity;
  const evaluate = () => {
    let sum = 0;
    let dp = 0;
    for (let t = 0; t < kk; t += 1) {
      P[t] = Math.exp(-d[t] * beta);
      sum += P[t];
      dp += d[t] * P[t];
    }
    if (!(sum > 0)) return -Infinity;
    const h = Math.log(sum) + (beta * dp) / sum;
    for (let t = 0; t < kk; t += 1) P[t] /= sum;
    return h;
  };
  let H = evaluate();
  for (let tries = 0; tries < 50 && Math.abs(H - logU) > 1e-5; tries += 1) {
    if (H > logU) {
      betaMin = beta;
      beta = betaMax === Infinity ? beta * 2 : (beta + betaMax) / 2;
    } else {
      betaMax = beta;
      beta = betaMin === -Infinity ? beta / 2 : (beta + betaMin) / 2;
    }
    H = evaluate();
  }
  if (!(H > 0)) return 1; // all weight on one event: no mixing is measurable
  counts.fill(0);
  for (let t = 0; t < kk; t += 1) counts[codes[ids[t]]] += P[t];
  let simpson = 0;
  for (let c = 0; c < counts.length; c += 1) simpson += counts[c] * counts[c];
  return simpson;
}

// LISI from neighbour lists that exclude the events themselves (rows of `indices`/`distances`,
// width kn), for the events `rows` (null = 0…m−1, the row's own event id).
function lisiFromNeighbours(indices, distances, kn, codes, categories, perplexity, rowIds) {
  const m = rowIds.length;
  const kk = kn + 1;
  const d = new Float64Array(kk);
  const ids = new Int32Array(kk);
  const P = new Float64Array(kk);
  const counts = new Float64Array(categories);
  const out = new Float32Array(m);
  for (let r = 0; r < m; r += 1) {
    d[0] = 0;
    ids[0] = rowIds[r];
    for (let t = 0; t < kn; t += 1) {
      d[t + 1] = distances[r * kn + t];
      ids[t + 1] = indices[r * kn + t];
    }
    out[r] = 1 / simpsonIndex(d, codes, ids, kk, perplexity, P, counts);
  }
  return out;
}

// Local inverse Simpson's index (Korsunsky et al. 2019): the effective number of categories in
// each event's embedding neighbourhood (1 … C), from 3·perplexity neighbours (the event itself
// included, as RANN::nn2 returns it) weighted by a Gaussian kernel calibrated to the perplexity.
// `ideal` is 1/Σπ_c², the value of perfect mixing; `normalized` = (mean − 1)/(ideal − 1).
export function lisi(low, n, labels, options = {}) {
  const { perplexity = 30, dim = 2, signal } = options;
  checkMatrix(low, n, dim, 'embedding');
  const { codes, categories, proportions } = encodeLabels(labels, n);
  let ideal = 0;
  for (let c = 0; c < categories; c += 1) ideal += proportions[c] * proportions[c];
  ideal = 1 / ideal;
  const kn = Math.min(n - 1, Math.max(1, Math.round(3 * perplexity) - 1));
  const perp = Math.min(perplexity, (kn + 1) / 3);
  const neighbours = options.knn ?? knn(low, n, dim, kn, { signal });
  const width = neighbours.indices.length / n;
  const rowIds = Int32Array.from({ length: n }, (_, i) => i);
  const perPoint = lisiFromNeighbours(neighbours.indices, neighbours.distances, width, codes, categories, perp, rowIds);
  let total = 0;
  for (let i = 0; i < n; i += 1) total += perPoint[i];
  const mean = total / n;
  return {
    perPoint,
    mean,
    median: median(perPoint),
    ideal,
    normalized: ideal > 1 ? (mean - 1) / (ideal - 1) : 1,
    categories,
    perplexity: perp,
  };
}

// --- Local reliability ---------------------------------------------------------------------------

// Per-event neighbourhood precision (the share of its k embedding neighbours that are among its
// kWide nearest original-space neighbours — a local trustworthiness) and recall (the share of its
// k original-space neighbours found among its kWide nearest embedding neighbours — a local
// continuity), Venna et al. 2010. `score` is their mean, averaged over the event and its k
// embedding neighbours so that the UI can shade regions. Options: k (15), kWide (5k), highKnn,
// lowKnn (precomputed neighbour tables, e.g. from UMAP; ignored when narrower than kWide), smooth
// (true), seed, metric.
//
// kWide is wide on purpose. Among similar cells, which ones are the very nearest is mostly
// measurement noise that no map can keep, so with kWide = k even a good UMAP of simulated PBMC
// scores ~0.33 everywhere. Asking whether map neighbours come from the event's wider
// neighbourhood (5k) separates real distortion from noise: that UMAP scores a median of 0.74,
// a random layout 0.01.
export const RELIABILITY_THRESHOLD = 0.4;

//
// The wide neighbourhood must be a similar share of the data whatever the event count (75 of
// 60 000 events is again mostly noise), so maps of more than options.maxEvents (10 000) events
// are scored on a seeded subsample of that size, and every other event takes the score of its
// nearest scored neighbour on the map.
export function regionReliability(high, low, n, dimHigh, dimLow, options = {}) {
  checkMatrix(high, n, dimHigh, 'original data');
  checkMatrix(low, n, dimLow, 'embedding');
  const maxEvents = options.maxEvents ?? 10000;
  if (n <= maxEvents) return reliabilityOf(high, low, n, dimHigh, dimLow, options);
  const { seed = DEFAULT_SEED, signal, onProgress } = options;
  const sample = sampleIndices(n, maxEvents, createRandom(seed ^ 0x2c1b3c6d));
  const m = sample.length;
  const subHigh = new Float32Array(m * dimHigh);
  const subLow = new Float32Array(m * dimLow);
  for (let r = 0; r < m; r += 1) {
    const i = sample[r];
    for (let c = 0; c < dimHigh; c += 1) subHigh[r * dimHigh + c] = high[i * dimHigh + c];
    for (let c = 0; c < dimLow; c += 1) subLow[r * dimLow + c] = low[i * dimLow + c];
  }
  const sub = reliabilityOf(subHigh, subLow, m, dimHigh, dimLow, { ...options, highKnn: null, lowKnn: null, onProgress: progressRange(onProgress, 0, 0.85) });
  throwIfAborted(signal);
  const index = createKnnIndex(subLow, m, dimLow, Math.min(15, m - 1), { seed, signal });
  const nearest = queryKnn(index, low, n, 1, { seed, signal }).indices;
  const spread = (values) => Float32Array.from({ length: n }, (_, i) => values[nearest[i]]);
  const own = new Map();
  for (let r = 0; r < m; r += 1) own.set(sample[r], r);
  const out = { precision: spread(sub.precision), recall: spread(sub.recall), score: spread(sub.score), raw: spread(sub.raw) };
  // Scored events keep their own values (their nearest scored neighbour could be a tie).
  for (const [i, r] of own) {
    out.precision[i] = sub.precision[r];
    out.recall[i] = sub.recall[r];
    out.score[i] = sub.score[r];
    out.raw[i] = sub.raw[r];
  }
  if (onProgress) onProgress(1, 'Reliability done');
  return { ...out, mean: sub.mean, k: sub.k, kWide: sub.kWide, sampled: m };
}

function reliabilityOf(high, low, n, dimHigh, dimLow, options = {}) {
  const { smooth = true, seed = DEFAULT_SEED, metric = 'euclidean', onProgress, signal } = options;
  let k = options.k ?? 15;
  let kWide = options.kWide ?? 5 * k;
  if (n < 3) throw new Error('Reliability needs at least three events.');
  kWide = Math.min(kWide, n - 1);
  const wideEnough = (table) => table && table.indices.length / n >= kWide;
  const highKnn = wideEnough(options.highKnn) ? options.highKnn : knn(high, n, dimHigh, kWide, { seed, metric, signal, onProgress: progressRange(onProgress, 0, 0.8) });
  const kh = highKnn.indices.length / n;
  kWide = Math.min(kWide, kh);
  k = Math.min(k, kWide);
  const lowKnn = wideEnough(options.lowKnn) ? options.lowKnn : knn(low, n, dimLow, kWide, { signal });
  const kl = lowKnn.indices.length / n;
  const kw = Math.min(kWide, kl);
  const precision = new Float32Array(n);
  const recall = new Float32Array(n);
  const raw = new Float32Array(n);
  const markH = new Int32Array(n).fill(-1);
  const markL = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < kw; t += 1) {
      markH[highKnn.indices[i * kh + t]] = i;
      markL[lowKnn.indices[i * kl + t]] = i;
    }
    let p = 0;
    let r = 0;
    for (let t = 0; t < k; t += 1) {
      if (markH[lowKnn.indices[i * kl + t]] === i) p += 1;
      if (markL[highKnn.indices[i * kh + t]] === i) r += 1;
    }
    precision[i] = p / k;
    recall[i] = r / k;
    raw[i] = (precision[i] + recall[i]) / 2;
  }
  let score = raw;
  if (smooth) {
    score = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      let s = raw[i];
      for (let t = 0; t < k; t += 1) s += raw[lowKnn.indices[i * kl + t]];
      score[i] = s / (k + 1);
    }
  }
  let total = 0;
  for (let i = 0; i < n; i += 1) total += raw[i];
  if (onProgress) onProgress(1, 'Reliability done');
  return { precision, recall, score, raw, mean: total / n, k, kWide: kw };
}

// --- Summary ---------------------------------------------------------------------------------------

const percent = (x) => `${Math.round(100 * x)}%`;

// Everything at once, with warnings in plain language. Options: k (15), sampleSize (1000), seed,
// labels (sample/batch per event: adds mixing and LISI in both spaces), other (a second embedding
// of the same events, e.g. another seed: adds seed stability), reliability (true: per-event
// reliability for shading; needs a full original-space kNN unless options.highKnn is given),
// perplexity (30, for LISI), signal, onProgress.
// Returns { n, k, sampleSize, trustworthiness, continuity, knnPreservation, chance, batch?,
// stability?, reliability?, warnings: [{ level: 'warning' | 'info', code, message }] }.
export function assessEmbedding(high, low, n, dimHigh, dimLow, options = {}) {
  const { seed = DEFAULT_SEED, labels = null, other = null, perplexity = 30, onProgress, signal } = options;
  checkMatrix(high, n, dimHigh, 'original data');
  checkMatrix(low, n, dimLow, 'embedding');
  const k = Math.min(options.k ?? 15, Math.floor((n - 1) / 2) - 1);
  if (k < 1) throw new Error('Too few events to judge the embedding (at least 6 are needed).');
  const sample = chooseSample(n, options);
  const wantBatch = !!labels;
  const kLisi = Math.min(n - 1, Math.max(1, Math.round(3 * perplexity) - 1));
  const stats = sampledNeighbourhoods(high, low, n, dimHigh, dimLow, k, sample, {
    keepHigh: wantBatch ? kLisi : 0,
    keepLow: wantBatch ? kLisi : 0,
    signal,
    onProgress: progressRange(onProgress, 0, 0.5),
  });
  const result = {
    n,
    k,
    sampleSize: sample.length,
    trustworthiness: stats.trustworthiness,
    continuity: stats.continuity,
    knnPreservation: stats.knnPreservation,
    chance: k / (n - 1),
    warnings: [],
  };
  const warn = (level, code, message) => result.warnings.push({ level, code, message });

  // Exact neighbours are a strict test: among similar cells, which are the very nearest is largely
  // noise, so t-SNE and UMAP keep only a minority of them even when the map is faithful. A
  // value near chance means the map has lost local structure altogether.
  if (stats.knnPreservation < Math.max(0.05, 10 * result.chance)) {
    warn('warning', 'neighbourhoods', `Neighbourhoods are lost (${percent(stats.knnPreservation)} of each event's ${k} nearest neighbours stay neighbours in the map, close to chance): read nothing into shapes or positions inside islands.`);
  } else if (stats.knnPreservation < 0.35) {
    warn('info', 'neighbourhoods', `${percent(stats.knnPreservation)} of each event's ${k} nearest neighbours stay neighbours in the map. That is usual for t-SNE and UMAP: among similar cells the very nearest are largely noise. Islands are meaningful, the arrangement of events within them is not.`);
  }
  if (stats.trustworthiness < 0.85) {
    warn('warning', 'trustworthiness', `Many map neighbours are not true neighbours (trustworthiness ${stats.trustworthiness.toFixed(2)}): islands may merge unrelated events.`);
  } else if (stats.trustworthiness < 0.92) {
    warn('info', 'trustworthiness', `Some map neighbours are not true neighbours (trustworthiness ${stats.trustworthiness.toFixed(2)}).`);
  }
  if (stats.continuity < 0.85) {
    warn('warning', 'continuity', `True neighbours are torn apart (continuity ${stats.continuity.toFixed(2)}): one population may appear as several islands.`);
  }

  if (wantBatch) {
    throwIfAborted(signal);
    const { codes, categories, proportions } = encodeLabels(labels, n);
    let ideal = 0;
    for (let c = 0; c < categories; c += 1) ideal += proportions[c] * proportions[c];
    ideal = 1 / ideal;
    const perp = Math.min(perplexity, (kLisi + 1) / 3);
    const lisiHigh = lisiFromNeighbours(stats.wideHigh.indices, stats.wideHigh.distances, kLisi, codes, categories, perp, Int32Array.from(sample));
    const lisiLow = lisiFromNeighbours(stats.wideLow.indices, stats.wideLow.distances, kLisi, codes, categories, perp, Int32Array.from(sample));
    let mh = 0;
    let ml = 0;
    for (let s = 0; s < sample.length; s += 1) {
      mh += lisiHigh[s];
      ml += lisiLow[s];
    }
    mh /= sample.length;
    ml /= sample.length;
    const norm = (x) => (ideal > 1 ? (x - 1) / (ideal - 1) : 1);
    result.batch = {
      categories,
      ideal,
      lisiEmbedding: ml,
      lisiOriginal: mh,
      mixingEmbedding: norm(ml),
      mixingOriginal: norm(mh),
    };
    if (categories > 1) {
      const me = norm(ml);
      const mo = norm(mh);
      if (me < 0.3) {
        const cause = mo < 0.3
          ? 'the samples are already separated in the original data (a batch or biological effect), not only in the map'
          : 'the samples mix in the original data, so the map exaggerates their differences';
        warn('warning', 'batch', `Batch dominates the layout: neighbourhoods in the map are ${percent(me)} as mixed as ideal (LISI ${ml.toFixed(2)} of ${ideal.toFixed(2)}); ${cause}.`);
      } else if (me < mo - 0.25) {
        warn('info', 'batch', `The map separates samples more than the data do (mixing ${percent(me)} in the map vs ${percent(mo)} in the original space).`);
      }
    }
  }

  if (other) {
    throwIfAborted(signal);
    const stability = seedStability(low, other, n, k, { dim: dimLow, signal });
    result.stability = {
      neighbourOverlap: stability.neighbourOverlap,
      disparity: stability.disparity,
      rmsd: stability.rmsd,
      perPoint: stability.perPoint,
    };
    if (stability.disparity > 0.3) {
      warn('warning', 'seed-global', `Islands differ between seeds: the overall arrangement changes with the random seed (Procrustes disparity ${stability.disparity.toFixed(2)}). Do not interpret positions of islands relative to each other.`);
    }
    if (stability.neighbourOverlap < 0.5) {
      warn('warning', 'seed-local', `Local structure differs between seeds: only ${percent(stability.neighbourOverlap)} of map neighbours are shared between the two runs.`);
    }
  }

  if (options.reliability !== false) {
    throwIfAborted(signal);
    const reliability = regionReliability(high, low, n, dimHigh, dimLow, {
      k, highKnn: options.highKnn, seed, signal, onProgress: progressRange(onProgress, 0.6, 1),
    });
    result.reliability = { score: reliability.score, precision: reliability.precision, recall: reliability.recall, mean: reliability.mean };
    let unreliable = 0;
    for (let i = 0; i < n; i += 1) if (reliability.score[i] < RELIABILITY_THRESHOLD) unreliable += 1;
    result.reliability.unreliableFraction = unreliable / n;
    result.reliability.kWide = reliability.kWide;
    if (unreliable / n > 0.1) {
      warn('info', 'regions', `${percent(unreliable / n)} of events sit in regions where fewer than two in five of their map neighbours come from their ${reliability.kWide} nearest in the data; these are shaded as unreliable.`);
    }
  }
  if (onProgress) onProgress(1, 'Embedding assessed');
  return result;
}
