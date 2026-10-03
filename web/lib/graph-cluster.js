// Graph-based clustering of events: kNN graphs and modularity optimization.
//
//   knnGraph      undirected weighted graph from a kNN result, with Jaccard weights as PhenoGraph
//                 (Levine et al. 2015, doi:10.1016/j.cell.2015.05.047) or UMAP fuzzy weights
//                 (McInnes, Healy & Melville 2018, arXiv:1802.03426).
//   louvain       Blondel, Guillaume, Lambiotte & Lefebvre 2008, doi:10.1088/1742-5468/2008/10/P10008.
//   leiden        Traag, Waltman & van Eck 2019, doi:10.1038/s41598-019-41695-z: fast local moving,
//                 refinement (guarantees γ-connected communities) and aggregation on the refined
//                 partition. Follows the reference Java implementation (networkanalysis).
//   phenograph    kNN (k = 30) → Jaccard graph → Leiden.
//
// Graphs are CSR: { n, offsets: Int32Array(n+1), targets: Int32Array, weights: Float32Array },
// undirected (each edge stored in both rows), no self-loops unless a caller adds them.
//
// Quality is modularity with resolution γ (Reichardt & Bornholdt 2006):
//   Q = Σ_c [ in_c / 2m − γ (tot_c / 2m)² ]
// where in_c sums A_ij over ordered pairs inside c and tot_c sums node strengths in c.

import { createRandom } from './random.js';
import { DEFAULT_SEED, knn, progressRange, throwIfAborted } from './knn.js';

// --- Building graphs ---------------------------------------------------------------------------

function combineWeights(mode, mix) {
  switch (mode) {
    case 'sum': return (a, b) => a + b;
    case 'mean': return (a, b) => (a + b) / 2;
    case 'max': return (a, b) => (a > b ? a : b);
    case 'min': return (a, b) => (a < b ? a : b);
    case 'product': return (a, b) => a * b;
    // Fuzzy set union a + b − ab, blended with the intersection ab (umap-learn set_op_mix_ratio).
    case 'fuzzy': return (a, b) => mix * (a + b - a * b) + (1 - mix) * a * b;
    default: throw new Error(`Unknown symmetrization "${mode}".`);
  }
}

// Turns a directed kNN-shaped relation (row i has k entries: indices[i·k + t] → values[i·k + t])
// into an undirected CSR graph whose weight for {i, j} combines w(i→j) and w(j→i) (0 when absent).
// Entries with index < 0 or pointing to themselves are ignored; combined weights of 0 are dropped.
export function symmetrize(indices, values, n, k, mode = 'mean', mix = 1) {
  const combine = combineWeights(mode, mix);
  const total = n * k;
  const reverseOffsets = new Int32Array(n + 1);
  for (let e = 0; e < total; e += 1) {
    const j = indices[e];
    if (j >= 0 && j !== Math.floor(e / k)) reverseOffsets[j + 1] += 1;
  }
  for (let i = 0; i < n; i += 1) reverseOffsets[i + 1] += reverseOffsets[i];
  const reverseSource = new Int32Array(reverseOffsets[n]);
  const reverseValue = new Float64Array(reverseOffsets[n]);
  const cursor = reverseOffsets.slice(0, n);
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) {
      const j = indices[i * k + t];
      if (j < 0 || j === i) continue;
      const pos = cursor[j]++;
      reverseSource[pos] = i;
      reverseValue[pos] = values[i * k + t];
    }
  }
  const owner = new Int32Array(n).fill(-1);
  const forward = new Float64Array(n);
  const offsets = new Int32Array(n + 1);
  // Two passes over the same logic: count, then fill (avoids a 2·n·k temporary).
  let targets = null;
  let weights = null;
  for (let pass = 0; pass < 2; pass += 1) {
    owner.fill(-1);
    let nnz = 0;
    for (let i = 0; i < n; i += 1) {
      offsets[i] = nnz;
      for (let t = 0; t < k; t += 1) {
        const j = indices[i * k + t];
        if (j < 0 || j === i) continue;
        const v = values[i * k + t];
        if (owner[j] === i) forward[j] = Math.max(forward[j], v); // repeated entry: keep the larger
        else {
          owner[j] = i;
          forward[j] = v;
        }
      }
      for (let r = reverseOffsets[i]; r < reverseOffsets[i + 1]; r += 1) {
        const j = reverseSource[r];
        // owner[j]: i = forward entry waiting, −2 − i = already emitted for row i.
        if (owner[j] === -2 - i) continue; // a repeated reverse entry
        const w = combine(owner[j] === i ? forward[j] : 0, reverseValue[r]);
        owner[j] = -2 - i;
        if (w !== 0) {
          if (pass) {
            targets[nnz] = j;
            weights[nnz] = w;
          }
          nnz += 1;
        }
      }
      for (let t = 0; t < k; t += 1) {
        const j = indices[i * k + t];
        if (j < 0 || j === i || owner[j] !== i) continue;
        owner[j] = -2 - i;
        const w = combine(forward[j], 0);
        if (w !== 0) {
          if (pass) {
            targets[nnz] = j;
            weights[nnz] = w;
          }
          nnz += 1;
        }
      }
    }
    offsets[n] = nnz;
    if (!pass) {
      targets = new Int32Array(nnz);
      weights = new Float32Array(nnz);
    }
  }
  return { n, offsets, targets, weights };
}

// umap-learn's smooth_knn_dist: for each row of k ascending distances find ρ (the distance to the
// local_connectivity-th nearest non-zero neighbor, interpolated) and σ by binary search so that
// Σ_{j≥1} exp(−max(0, d_j − ρ)/σ) = log2(k) · bandwidth. Column 0 is skipped in the sum, as in
// umap-learn, where it holds the point itself.
export function smoothKnnDist(distances, n, k, options = {}) {
  const { localConnectivity = 1, bandwidth = 1, nIter = 64 } = options;
  const SMOOTH_K_TOLERANCE = 1e-5;
  const MIN_K_DIST_SCALE = 1e-3;
  const target = Math.log2(k) * bandwidth;
  const rhos = new Float64Array(n);
  const sigmas = new Float64Array(n);
  let meanAll = 0;
  for (let e = 0; e < n * k; e += 1) meanAll += distances[e];
  meanAll /= n * k;
  const index = Math.floor(localConnectivity);
  const interpolation = localConnectivity - index;
  for (let i = 0; i < n; i += 1) {
    const base = i * k;
    let nonZero = 0;
    let rowSum = 0;
    for (let t = 0; t < k; t += 1) {
      if (distances[base + t] > 0) nonZero += 1;
      rowSum += distances[base + t];
    }
    // Rows are ascending, so the non-zero distances are the last `nonZero` entries.
    const firstNonZero = base + k - nonZero;
    let rho = 0;
    if (nonZero >= localConnectivity) {
      if (index > 0) {
        rho = distances[firstNonZero + index - 1];
        if (interpolation > SMOOTH_K_TOLERANCE && index < nonZero) {
          rho += interpolation * (distances[firstNonZero + index] - distances[firstNonZero + index - 1]);
        }
      } else {
        rho = interpolation * distances[firstNonZero];
      }
    } else if (nonZero > 0) {
      rho = distances[base + k - 1];
    }
    let lo = 0;
    let hi = Infinity;
    let mid = 1;
    for (let it = 0; it < nIter; it += 1) {
      let psum = 0;
      for (let t = 1; t < k; t += 1) {
        const d = distances[base + t] - rho;
        psum += d > 0 ? Math.exp(-(d / mid)) : 1;
      }
      if (Math.abs(psum - target) < SMOOTH_K_TOLERANCE) break;
      if (psum > target) {
        hi = mid;
        mid = (lo + hi) / 2;
      } else {
        lo = mid;
        mid = hi === Infinity ? mid * 2 : (lo + hi) / 2;
      }
    }
    let sigma = mid;
    if (rho > 0) {
      const meanRow = rowSum / k;
      if (sigma < MIN_K_DIST_SCALE * meanRow) sigma = MIN_K_DIST_SCALE * meanRow;
    } else if (sigma < MIN_K_DIST_SCALE * meanAll) {
      sigma = MIN_K_DIST_SCALE * meanAll;
    }
    rhos[i] = rho;
    sigmas[i] = sigma;
  }
  return { sigmas, rhos };
}

// umap-learn's compute_membership_strengths: exp(−(d − ρ_i)/σ_i), 1 within ρ, 0 for the point
// itself unless `bipartite` (new points against a reference set).
export function membershipStrengths(indices, distances, n, k, sigmas, rhos, bipartite = false) {
  const values = new Float32Array(n * k);
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) {
      const e = i * k + t;
      const j = indices[e];
      if (j < 0 || (!bipartite && j === i)) values[e] = 0;
      else if (distances[e] - rhos[i] <= 0 || sigmas[i] === 0) values[e] = 1;
      else values[e] = Math.exp(-(distances[e] - rhos[i]) / sigmas[i]);
    }
  }
  return values;
}

// UMAP's fuzzy simplicial set from a kNN result that excludes the points themselves (as knn.js
// returns): the point is prepended as umap-learn's neighbor 0, so n_neighbors = k + 1.
export function fuzzySimplicialSet(knnResult, n, options = {}) {
  const { localConnectivity = 1, setOpMixRatio = 1, bandwidth = 1 } = options;
  const k = knnResult.indices.length / n;
  const kk = k + 1;
  const indices = new Int32Array(n * kk);
  const distances = new Float32Array(n * kk);
  for (let i = 0; i < n; i += 1) {
    indices[i * kk] = i;
    distances[i * kk] = 0;
    for (let t = 0; t < k; t += 1) {
      indices[i * kk + t + 1] = knnResult.indices[i * k + t];
      distances[i * kk + t + 1] = knnResult.distances[i * k + t];
    }
  }
  const { sigmas, rhos } = smoothKnnDist(distances, n, kk, { localConnectivity, bandwidth });
  const values = membershipStrengths(indices, distances, n, kk, sigmas, rhos);
  const graph = symmetrize(indices, values, n, kk, 'fuzzy', setOpMixRatio);
  return { ...graph, sigmas, rhos };
}

// PhenoGraph's jaccard_kernel: w(i→j) = |N(i) ∩ N(j)| / |N(i) ∪ N(j)| for j ∈ N(i), with N the
// k nearest neighbors (self excluded), then symmetrized by averaging with the transpose.
export function jaccardWeights(indices, n, k) {
  const values = new Float32Array(n * k);
  const mark = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) {
      const j = indices[i * k + t];
      if (j >= 0) mark[j] = i;
    }
    for (let t = 0; t < k; t += 1) {
      const j = indices[i * k + t];
      if (j < 0) continue;
      let shared = 0;
      for (let u = 0; u < k; u += 1) {
        const l = indices[j * k + u];
        if (l >= 0 && mark[l] === i) shared += 1;
      }
      values[i * k + t] = shared / (2 * k - shared);
    }
  }
  return values;
}

// An undirected weighted graph from a kNN result ({ indices, distances }, n × k, self excluded).
// options.weighting: 'jaccard' (PhenoGraph, default) | 'fuzzy' (UMAP) | 'binary' (1 per edge).
export function knnGraph(knnResult, n, k, options = {}) {
  const { weighting = 'jaccard' } = options;
  if (knnResult.indices.length !== n * k) throw new Error(`The neighbor table should hold ${n} × ${k} entries.`);
  if (weighting === 'jaccard') return symmetrize(knnResult.indices, jaccardWeights(knnResult.indices, n, k), n, k, 'mean');
  if (weighting === 'fuzzy') {
    const graph = fuzzySimplicialSet(knnResult, n, options);
    return { n, offsets: graph.offsets, targets: graph.targets, weights: graph.weights };
  }
  if (weighting === 'binary') {
    const ones = new Float32Array(n * k).fill(1);
    return symmetrize(knnResult.indices, ones, n, k, 'max');
  }
  throw new Error(`Unknown graph weighting "${weighting}"; use 'jaccard', 'fuzzy' or 'binary'.`);
}

// A CSR graph from an undirected edge list [[i, j, w?], …] (each edge listed once).
export function graphFromEdges(edges, n = 0) {
  let size = n;
  for (const [i, j] of edges) size = Math.max(size, i + 1, j + 1);
  const degree = new Int32Array(size + 1);
  for (const [i, j] of edges) {
    degree[i + 1] += 1;
    if (i !== j) degree[j + 1] += 1;
  }
  for (let i = 0; i < size; i += 1) degree[i + 1] += degree[i];
  const offsets = degree.slice();
  const targets = new Int32Array(offsets[size]);
  const weights = new Float32Array(offsets[size]);
  const cursor = offsets.slice(0, size);
  for (const [i, j, w = 1] of edges) {
    targets[cursor[i]] = j;
    weights[cursor[i]++] = w;
    if (i !== j) {
      targets[cursor[j]] = i;
      weights[cursor[j]++] = w;
    }
  }
  return { n: size, offsets, targets, weights };
}

// Connected components (weights > 0). Returns { labels: Int32Array, count }.
export function connectedComponents(graph) {
  const n = graph.n ?? graph.offsets.length - 1;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let count = 0;
  for (let s = 0; s < n; s += 1) {
    if (labels[s] !== -1) continue;
    let sp = 0;
    stack[sp++] = s;
    labels[s] = count;
    while (sp > 0) {
      const v = stack[--sp];
      for (let e = graph.offsets[v]; e < graph.offsets[v + 1]; e += 1) {
        const u = graph.targets[e];
        if (labels[u] === -1 && graph.weights[e] > 0) {
          labels[u] = count;
          stack[sp++] = u;
        }
      }
    }
    count += 1;
  }
  return { labels, count };
}

// --- Modularity ----------------------------------------------------------------------------------

// Modularity of a partition (labels: integer per node) with resolution γ.
export function modularity(graph, labels, resolution = 1) {
  const n = graph.n ?? graph.offsets.length - 1;
  let nComm = 0;
  for (let i = 0; i < n; i += 1) nComm = Math.max(nComm, labels[i] + 1);
  const inside = new Float64Array(nComm);
  const tot = new Float64Array(nComm);
  let twoM = 0;
  for (let i = 0; i < n; i += 1) {
    const c = labels[i];
    for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e += 1) {
      const w = graph.weights[e];
      twoM += w;
      tot[c] += w;
      if (labels[graph.targets[e]] === c) inside[c] += w;
    }
  }
  if (twoM === 0) return 0;
  let q = 0;
  for (let c = 0; c < nComm; c += 1) q += inside[c] / twoM - resolution * (tot[c] / twoM) ** 2;
  return q;
}

// --- Optimization internals --------------------------------------------------------------------
// A level graph is { n, offsets, targets, weights: Float64Array } without self-loops; node weights
// (strengths, summed over aggregated nodes) are kept separately, as networkanalysis does, so the
// quality of moving node v into cluster c is  w(v, c) − k_v · K_c · γ / 2m.

function levelGraph(graph) {
  const n = graph.n ?? graph.offsets.length - 1;
  const nodeWeight = new Float64Array(n);
  let nnz = 0;
  for (let i = 0; i < n; i += 1) {
    for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e += 1) {
      const w = graph.weights[e];
      if (!(w >= 0) || !Number.isFinite(w)) throw new Error('Graph weights must be finite and non-negative.');
      nodeWeight[i] += w;
      if (graph.targets[e] !== i && w > 0) nnz += 1;
    }
  }
  const offsets = new Int32Array(n + 1);
  const targets = new Int32Array(nnz);
  const weights = new Float64Array(nnz);
  let p = 0;
  for (let i = 0; i < n; i += 1) {
    offsets[i] = p;
    for (let e = graph.offsets[i]; e < graph.offsets[i + 1]; e += 1) {
      const j = graph.targets[e];
      const w = graph.weights[e];
      if (j === i || !(w > 0)) continue;
      targets[p] = j;
      weights[p++] = w;
    }
  }
  offsets[n] = p;
  let total = 0;
  for (let i = 0; i < n; i += 1) total += nodeWeight[i];
  return { G: { n, offsets, targets, weights }, nodeWeight, total };
}

function randomPermutation(n, random) {
  const order = new Int32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  for (let i = n - 1; i > 0; i -= 1) {
    const j = random.int(i + 1);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

// Relabels to 0…count−1 in order of first appearance.
function renumber(labels) {
  const map = new Int32Array(labels.length).fill(-1);
  let count = 0;
  for (let i = 0; i < labels.length; i += 1) {
    const c = labels[i];
    if (map[c] === -1) map[c] = count++;
    labels[i] = map[c];
  }
  return count;
}

// Shared scratch for local moving on a level graph of n nodes.
function createMover(n) {
  return {
    clusterWeight: new Float64Array(n),
    clusterSize: new Int32Array(n),
    unused: new Int32Array(n),
    edgeWeight: new Float64Array(n),
    seen: new Int32Array(n).fill(-1),
    neighbors: new Int32Array(n + 1),
    nUnused: 0,
  };
}

function initClusters(state, G, nodeWeight, comm) {
  const { clusterWeight, clusterSize, unused } = state;
  clusterWeight.fill(0);
  clusterSize.fill(0);
  for (let v = 0; v < G.n; v += 1) {
    clusterWeight[comm[v]] += nodeWeight[v];
    clusterSize[comm[v]] += 1;
  }
  state.nUnused = 0;
  for (let c = G.n - 1; c >= 0; c -= 1) if (clusterSize[c] === 0) unused[state.nUnused++] = c;
}

// Moves v to the cluster with the largest quality increment (an empty cluster included). Returns
// the new cluster. Ties keep v where it is.
function moveNode(state, G, nodeWeight, comm, v, resolution, visit) {
  const { clusterWeight, clusterSize, unused, edgeWeight, seen, neighbors } = state;
  const current = comm[v];
  const kv = nodeWeight[v];
  clusterWeight[current] -= kv;
  clusterSize[current] -= 1;
  if (clusterSize[current] === 0) unused[state.nUnused++] = current;
  let nn = 0;
  const empty = unused[state.nUnused - 1];
  neighbors[nn++] = empty;
  seen[empty] = visit;
  edgeWeight[empty] = 0;
  if (seen[current] !== visit) {
    seen[current] = visit;
    edgeWeight[current] = 0;
    neighbors[nn++] = current;
  }
  for (let e = G.offsets[v]; e < G.offsets[v + 1]; e += 1) {
    const c = comm[G.targets[e]];
    if (seen[c] !== visit) {
      seen[c] = visit;
      edgeWeight[c] = 0;
      neighbors[nn++] = c;
    }
    edgeWeight[c] += G.weights[e];
  }
  let best = current;
  let bestGain = edgeWeight[current] - kv * clusterWeight[current] * resolution;
  for (let a = 0; a < nn; a += 1) {
    const c = neighbors[a];
    const gain = edgeWeight[c] - kv * clusterWeight[c] * resolution;
    if (gain > bestGain) {
      best = c;
      bestGain = gain;
    }
  }
  clusterWeight[best] += kv;
  clusterSize[best] += 1;
  if (best === unused[state.nUnused - 1]) state.nUnused -= 1;
  comm[v] = best;
  return best;
}

// Leiden's fast local moving: a queue of nodes, re-queueing neighbors of moved nodes.
function moveNodesFast(G, nodeWeight, comm, resolution, random, state, counter) {
  const n = G.n;
  initClusters(state, G, nodeWeight, comm);
  const queue = randomPermutation(n, random);
  const inQueue = new Uint8Array(n).fill(1);
  let head = 0;
  let size = n;
  let changed = false;
  while (size > 0) {
    const v = queue[head];
    head = head + 1 === n ? 0 : head + 1;
    size -= 1;
    inQueue[v] = 0;
    const old = comm[v];
    counter.visit += 1;
    const best = moveNode(state, G, nodeWeight, comm, v, resolution, counter.visit);
    if (best !== old) {
      changed = true;
      for (let e = G.offsets[v]; e < G.offsets[v + 1]; e += 1) {
        const u = G.targets[e];
        if (!inQueue[u] && comm[u] !== best) {
          let tail = head + size;
          if (tail >= n) tail -= n;
          queue[tail] = u;
          size += 1;
          inQueue[u] = 1;
        }
      }
    }
  }
  return changed;
}

// Louvain's local moving: sweeps in random order until a sweep moves nothing.
function moveNodesSweep(G, nodeWeight, comm, resolution, random, state, counter, maxSweeps = 1000) {
  const n = G.n;
  initClusters(state, G, nodeWeight, comm);
  let changed = false;
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    const order = randomPermutation(n, random);
    let moves = 0;
    for (let a = 0; a < n; a += 1) {
      const v = order[a];
      const old = comm[v];
      counter.visit += 1;
      if (moveNode(state, G, nodeWeight, comm, v, resolution, counter.visit) !== old) moves += 1;
    }
    if (!moves) break;
    changed = true;
  }
  return changed;
}

// Leiden refinement (Traag et al. 2019, Algorithm A.2, as networkanalysis' LeidenAlgorithm):
// inside each cluster S of `comm`, singletons that are well connected to S merge, in random order,
// into well-connected sub-clusters chosen at random with probability ∝ exp(Δ/θ) over Δ ≥ 0.
function refinePartition(G, nodeWeight, comm, resolution, randomness, random, counter) {
  const n = G.n;
  const refined = new Int32Array(n);
  for (let v = 0; v < n; v += 1) refined[v] = v;
  const clusterTotal = new Float64Array(n);
  for (let v = 0; v < n; v += 1) clusterTotal[comm[v]] += nodeWeight[v];
  const weight = Float64Array.from(nodeWeight);
  const external = new Float64Array(n);
  for (let v = 0; v < n; v += 1) {
    for (let e = G.offsets[v]; e < G.offsets[v + 1]; e += 1) {
      if (comm[G.targets[e]] === comm[v]) external[v] += G.weights[e];
    }
  }
  const singleton = new Uint8Array(n).fill(1);
  const order = randomPermutation(n, random);
  const edgeWeight = new Float64Array(n);
  const seen = new Int32Array(n).fill(-1);
  const neighbors = new Int32Array(n);
  const gains = new Float64Array(n);
  for (let a = 0; a < n; a += 1) {
    const v = order[a];
    if (!singleton[v]) continue;
    const S = comm[v];
    const kv = nodeWeight[v];
    if (external[v] < weight[v] * (clusterTotal[S] - weight[v]) * resolution) continue;
    weight[v] = 0;
    external[v] = 0;
    counter.visit += 1;
    const visit = counter.visit;
    let nn = 0;
    neighbors[nn++] = v;
    seen[v] = visit;
    edgeWeight[v] = 0;
    for (let e = G.offsets[v]; e < G.offsets[v + 1]; e += 1) {
      const u = G.targets[e];
      if (comm[u] !== S) continue;
      const r = refined[u];
      if (seen[r] !== visit) {
        seen[r] = visit;
        edgeWeight[r] = 0;
        neighbors[nn++] = r;
      }
      edgeWeight[r] += G.weights[e];
    }
    let best = v;
    let maxGain = 0;
    for (let b = 0; b < nn; b += 1) {
      const r = neighbors[b];
      if (external[r] >= weight[r] * (clusterTotal[S] - weight[r]) * resolution) {
        const gain = edgeWeight[r] - kv * weight[r] * resolution;
        gains[b] = gain;
        if (gain > maxGain) {
          maxGain = gain;
          best = r;
        }
      } else {
        gains[b] = -Infinity;
      }
    }
    let chosen = best;
    if (randomness > 0) {
      // exp((Δ − Δmax)/θ) gives the same probabilities as exp(Δ/θ) without overflow.
      let totalP = 0;
      for (let b = 0; b < nn; b += 1) if (gains[b] >= 0) totalP += Math.exp((gains[b] - maxGain) / randomness);
      let r = totalP * random();
      for (let b = 0; b < nn; b += 1) {
        if (!(gains[b] >= 0)) continue;
        r -= Math.exp((gains[b] - maxGain) / randomness);
        chosen = neighbors[b];
        if (r < 0) break;
      }
    }
    weight[chosen] += kv;
    for (let e = G.offsets[v]; e < G.offsets[v + 1]; e += 1) {
      const u = G.targets[e];
      if (comm[u] !== S) continue;
      if (refined[u] === chosen) external[chosen] -= G.weights[e];
      else external[chosen] += G.weights[e];
    }
    if (chosen !== v) {
      refined[v] = chosen;
      singleton[chosen] = 0;
    }
  }
  const count = renumber(refined);
  return { refined, count };
}

// Collapses each cluster of `labels` (0…count−1) to one node; edges between clusters are summed
// and edges within a cluster dropped (their weight lives on in the node weights).
function aggregate(G, nodeWeight, labels, count) {
  const n = G.n;
  const start = new Int32Array(count + 1);
  for (let v = 0; v < n; v += 1) start[labels[v] + 1] += 1;
  for (let c = 0; c < count; c += 1) start[c + 1] += start[c];
  const members = new Int32Array(n);
  const cursor = start.slice(0, count);
  for (let v = 0; v < n; v += 1) members[cursor[labels[v]]++] = v;
  const weights2 = new Float64Array(count);
  for (let v = 0; v < n; v += 1) weights2[labels[v]] += nodeWeight[v];
  const offsets = new Int32Array(count + 1);
  const targets = new Int32Array(G.targets.length);
  const weights = new Float64Array(G.targets.length);
  const acc = new Float64Array(count);
  const mark = new Int32Array(count).fill(-1);
  const list = new Int32Array(count);
  let nnz = 0;
  for (let c = 0; c < count; c += 1) {
    offsets[c] = nnz;
    let nl = 0;
    for (let m = start[c]; m < start[c + 1]; m += 1) {
      const v = members[m];
      for (let e = G.offsets[v]; e < G.offsets[v + 1]; e += 1) {
        const d = labels[G.targets[e]];
        if (d === c) continue;
        if (mark[d] !== c) {
          mark[d] = c;
          acc[d] = 0;
          list[nl++] = d;
        }
        acc[d] += G.weights[e];
      }
    }
    for (let a = 0; a < nl; a += 1) {
      targets[nnz] = list[a];
      weights[nnz++] = acc[list[a]];
    }
  }
  offsets[count] = nnz;
  return {
    G: { n: count, offsets, targets: targets.slice(0, nnz), weights: weights.slice(0, nnz) },
    nodeWeight: weights2,
  };
}

// Labels renumbered 0…count−1 by decreasing community size (ties: lowest first member).
export function renumberBySize(labels) {
  const n = labels.length;
  let count = 0;
  for (let i = 0; i < n; i += 1) count = Math.max(count, labels[i] + 1);
  const size = new Int32Array(count);
  const first = new Int32Array(count).fill(n);
  for (let i = 0; i < n; i += 1) {
    size[labels[i]] += 1;
    if (first[labels[i]] === n) first[labels[i]] = i;
  }
  const used = [];
  for (let c = 0; c < count; c += 1) if (size[c] > 0) used.push(c);
  used.sort((a, b) => size[b] - size[a] || first[a] - first[b]);
  const map = new Int32Array(count).fill(-1);
  used.forEach((c, rank) => { map[c] = rank; });
  const out = new Int32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = map[labels[i]];
  return { labels: out, count: used.length, sizes: Int32Array.from(used, (c) => size[c]) };
}

function checkGraph(graph) {
  const n = graph?.n ?? (graph?.offsets ? graph.offsets.length - 1 : -1);
  if (!(n >= 0) || !graph.targets || !graph.weights) throw new Error('Expected a graph { n, offsets, targets, weights }.');
  return n;
}

function finishClustering(graph, comm, resolution, extra) {
  const { labels, count, sizes } = renumberBySize(comm);
  return { labels, quality: modularity(graph, labels, resolution), communities: count, sizes, ...extra };
}

// Louvain modularity optimization. Options: resolution γ (1), seed.
export function louvain(graph, options = {}) {
  const { resolution = 1, seed = DEFAULT_SEED, onProgress, signal } = options;
  const n = checkGraph(graph);
  const random = createRandom(seed);
  const level0 = levelGraph(graph);
  if (level0.total === 0) return finishClustering(graph, Int32Array.from({ length: n }, (_, i) => i), resolution, { levels: 0 });
  const res = resolution / level0.total;
  const counter = { visit: 0 };
  let { G, nodeWeight } = level0;
  const maps = [];
  let comm = Int32Array.from({ length: n }, (_, i) => i);
  for (let level = 0; level < 64; level += 1) {
    throwIfAborted(signal);
    const changed = moveNodesSweep(G, nodeWeight, comm, res, random, createMover(G.n), counter);
    const count = renumber(comm);
    if (onProgress) onProgress(Math.min(0.95, (level + 1) / 10), `Louvain level ${level + 1}: ${count} communities`);
    if (!changed || count === G.n) break;
    const next = aggregate(G, nodeWeight, comm, count);
    maps.push(comm);
    G = next.G;
    nodeWeight = next.nodeWeight;
    comm = Int32Array.from({ length: count }, (_, i) => i);
  }
  let labels = comm;
  for (let l = maps.length - 1; l >= 0; l -= 1) {
    const lower = new Int32Array(maps[l].length);
    for (let v = 0; v < lower.length; v += 1) lower[v] = labels[maps[l][v]];
    labels = lower;
  }
  return finishClustering(graph, labels, resolution, { levels: maps.length + 1 });
}

// One Leiden iteration from partition `comm` of the original graph; returns whether anything moved.
function leidenIteration(level0, comm, res, randomness, random, counter, signal) {
  let G = level0.G;
  let nodeWeight = level0.nodeWeight;
  let current = comm;
  const maps = [];
  let changed = false;
  for (;;) {
    throwIfAborted(signal);
    if (moveNodesFast(G, nodeWeight, current, res, random, createMover(G.n), counter)) changed = true;
    const count = renumber(current);
    if (count === G.n) break;
    const { refined, count: nRefined } = refinePartition(G, nodeWeight, current, res, randomness, random, counter);
    let map;
    let nextComm;
    let next;
    if (nRefined < G.n) {
      // Aggregate on the refined partition; each aggregate node starts in its parent cluster.
      next = aggregate(G, nodeWeight, refined, nRefined);
      nextComm = new Int32Array(nRefined);
      for (let v = 0; v < G.n; v += 1) nextComm[refined[v]] = current[v];
      map = refined;
    } else {
      // Refinement merged nothing: aggregate on the clusters themselves so the graph shrinks.
      next = aggregate(G, nodeWeight, current, count);
      nextComm = Int32Array.from({ length: count }, (_, i) => i);
      map = current;
    }
    maps.push(map);
    G = next.G;
    nodeWeight = next.nodeWeight;
    current = nextComm;
  }
  let labels = current;
  for (let l = maps.length - 1; l >= 0; l -= 1) {
    const lower = new Int32Array(maps[l].length);
    for (let v = 0; v < lower.length; v += 1) lower[v] = labels[maps[l][v]];
    labels = lower;
  }
  comm.set(labels);
  return changed;
}

// Leiden modularity optimization. Options: resolution γ (1), seed, randomness θ (0.01),
// iterations (−1 = repeat until an iteration changes nothing, at most 50), initial (labels).
export function leiden(graph, options = {}) {
  const { resolution = 1, seed = DEFAULT_SEED, randomness = 0.01, iterations = -1, initial = null, onProgress, signal } = options;
  const n = checkGraph(graph);
  const random = createRandom(seed);
  const level0 = levelGraph(graph);
  const comm = initial ? Int32Array.from(initial) : Int32Array.from({ length: n }, (_, i) => i);
  if (initial) renumber(comm);
  if (level0.total === 0) return finishClustering(graph, comm, resolution, { iterations: 0 });
  const res = resolution / level0.total;
  const counter = { visit: 0 };
  const maxIterations = iterations < 0 ? 50 : iterations;
  let done = 0;
  for (let it = 0; it < maxIterations; it += 1) {
    const changed = leidenIteration(level0, comm, res, randomness, random, counter, signal);
    done = it + 1;
    if (onProgress) onProgress(Math.min(0.95, done / Math.min(maxIterations, 5)), `Leiden iteration ${done}`);
    if (!changed) break;
  }
  return finishClustering(graph, comm, resolution, { iterations: done });
}

// PhenoGraph (Levine et al. 2015) with Leiden: kNN (k = 30) → Jaccard graph → Leiden.
// Options: k, metric, resolution, seed, algorithm ('leiden' | 'louvain'), returnGraph.
export function phenograph(data, n, dim, options = {}) {
  const { k = 30, algorithm = 'leiden', returnGraph = false, onProgress, signal } = options;
  const kk = Math.min(k, n - 1);
  if (kk < 1) throw new Error('PhenoGraph needs at least two events.');
  const neighbors = knn(data, n, dim, kk, { ...options, onProgress: progressRange(onProgress, 0, 0.6), signal });
  throwIfAborted(signal);
  if (onProgress) onProgress(0.6, 'Building the Jaccard graph');
  const graph = knnGraph(neighbors, n, kk, { weighting: 'jaccard' });
  const cluster = algorithm === 'louvain' ? louvain : leiden;
  const result = cluster(graph, { ...options, onProgress: progressRange(onProgress, 0.65, 1) });
  if (onProgress) onProgress(1, `${result.communities} clusters`);
  return returnGraph ? { ...result, graph, k: kk } : { ...result, k: kk };
}
