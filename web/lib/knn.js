// Nearest-neighbor search for dimension reduction, graph clustering and embedding diagnostics.
//
//   exactKnn        brute force over all pairs (each pair computed once).
//   kdTreeKnn       exact k-d tree search (Bentley 1975; Friedman, Bentley & Finkel 1977,
//                   doi:10.1145/355744.355745) for low-dimensional data such as 2-D embeddings.
//   approximateKnn  NN-Descent (Dong, Moses & Li 2011, doi:10.1145/1963405.1963487) started from a
//                   random-projection forest (Dasgupta & Freund 2008), as pynndescent and umap-learn
//                   do (McInnes, Healy & Melville 2018, arXiv:1802.03426).
//   queryKnn        places new points against an indexed reference set by best-first search of the
//                   reference kNN graph entered from a random-projection tree leaf (pynndescent's
//                   query with epsilon = 0.1; Iwasaki & Miyazaki 2018, arXiv:1810.07355).
//
// Input is a dense row-major matrix (Float32Array of n × dim transformed values). Results are
// { indices: Int32Array(n·k), distances: Float32Array(n·k) }: row i lists point i's k nearest
// other points, nearest first. Distances are Euclidean, or the cosine distance 1 − cos θ with
// options.metric = 'cosine'.

import { createRandom } from './random.js';

export const DEFAULT_SEED = 42;
export const METRICS = ['euclidean', 'cosine'];

// Below this many events knn() searches exhaustively; above it, NN-Descent is far faster.
const EXACT_THRESHOLD = 5000;
const RP_EPSILON = 1e-8;

export function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const error = new Error('The calculation was canceled.');
    error.name = 'AbortError';
    throw error;
  }
}

// Maps a sub-task's progress fraction into [from, to] of the caller's progress.
export function progressRange(onProgress, from, to) {
  if (!onProgress) return null;
  return (fraction, message) => onProgress(from + (to - from) * Math.min(1, Math.max(0, fraction)), message);
}

function checkShape(data, n, dim) {
  if (!Number.isInteger(n) || n < 1) throw new Error('The number of events must be a positive whole number.');
  if (!Number.isInteger(dim) || dim < 1) throw new Error('The number of dimensions must be a positive whole number.');
  if (!data || data.length < n * dim) {
    throw new Error(`Expected ${n} events × ${dim} dimensions (${n * dim} values) but got ${data ? data.length : 0}.`);
  }
}

function checkK(n, k) {
  if (!Number.isInteger(k) || k < 1) throw new Error('The number of neighbors must be a positive whole number.');
  if (k > n - 1) throw new Error(`Cannot find ${k} neighbors among ${n} events; use fewer neighbors or more events.`);
}

// The matrix the search runs on: the data itself for Euclidean distance, or unit-length copies for
// cosine distance (on the unit sphere ‖a − b‖² = 2 − 2 cos θ, so Euclidean machinery finds cosine
// neighbors). All-zero rows stay zero (cosine distance 0.5 to everything). Non-finite values make
// distances undefined, so they are rejected with the offending event's number.
export function prepareMatrix(data, n, dim, metric = 'euclidean') {
  if (!METRICS.includes(metric)) throw new Error(`Unknown distance "${metric}"; use ${METRICS.join(' or ')}.`);
  checkShape(data, n, dim);
  const size = n * dim;
  for (let i = 0; i < size; i += 1) {
    if (!Number.isFinite(data[i])) {
      throw new Error(`Event ${Math.floor(i / dim) + 1} has a missing or infinite value in dimension ${(i % dim) + 1}; remove or clip such events first.`);
    }
  }
  if (metric === 'euclidean') return data.length === size ? data : data.subarray(0, size);
  const out = new Float32Array(size);
  for (let i = 0; i < n; i += 1) {
    const o = i * dim;
    let norm = 0;
    for (let t = 0; t < dim; t += 1) norm += data[o + t] * data[o + t];
    const s = norm > 0 ? 1 / Math.sqrt(norm) : 0;
    for (let t = 0; t < dim; t += 1) out[o + t] = data[o + t] * s;
  }
  return out;
}

// Squared Euclidean distances on the prepared matrix → the metric's distances.
function finishDistances(squared, metric) {
  const out = new Float32Array(squared.length);
  if (metric === 'cosine') {
    for (let i = 0; i < squared.length; i += 1) out[i] = squared[i] / 2;
  } else {
    for (let i = 0; i < squared.length; i += 1) out[i] = Math.sqrt(squared[i]);
  }
  return out;
}

// --- Bounded max-heaps -----------------------------------------------------------------------
// One heap per row in flat arrays: row r occupies [r·k, r·k + k), the largest distance at the
// root. Empty slots hold index −1 and distance +∞, so the root is +∞ until the row is full.

// Replaces the root with (j, d) and restores the heap. The caller has checked d < root.
function heapReplace(idx, dist, base, k, j, d) {
  let pos = 0;
  for (;;) {
    const left = 2 * pos + 1;
    if (left >= k) break;
    const right = left + 1;
    let child = left;
    if (right < k && dist[base + right] > dist[base + left]) child = right;
    if (!(dist[base + child] > d)) break;
    dist[base + pos] = dist[base + child];
    idx[base + pos] = idx[base + child];
    pos = child;
  }
  dist[base + pos] = d;
  idx[base + pos] = j;
}

// As heapReplace with a per-entry "new" flag (NN-Descent), refusing duplicates. Returns 1 if added.
function flaggedPush(idx, dist, flags, base, k, j, d) {
  if (!(d < dist[base])) return 0;
  const end = base + k;
  for (let t = base; t < end; t += 1) if (idx[t] === j) return 0;
  let pos = 0;
  for (;;) {
    const left = 2 * pos + 1;
    if (left >= k) break;
    const right = left + 1;
    let child = left;
    if (right < k && dist[base + right] > dist[base + left]) child = right;
    if (!(dist[base + child] > d)) break;
    dist[base + pos] = dist[base + child];
    idx[base + pos] = idx[base + child];
    flags[base + pos] = flags[base + child];
    pos = child;
  }
  dist[base + pos] = d;
  idx[base + pos] = j;
  flags[base + pos] = 1;
  return 1;
}

// Heap-sorts every row ascending by distance (ties keep no particular order).
function sortRows(idx, dist, rows, k) {
  for (let r = 0; r < rows; r += 1) {
    const base = r * k;
    for (let end = k - 1; end > 0; end -= 1) {
      const d = dist[base + end];
      const j = idx[base + end];
      dist[base + end] = dist[base];
      idx[base + end] = idx[base];
      // Sift (j, d) down from the root within [0, end).
      let pos = 0;
      for (;;) {
        const left = 2 * pos + 1;
        if (left >= end) break;
        const right = left + 1;
        let child = left;
        if (right < end && dist[base + right] > dist[base + left]) child = right;
        if (!(dist[base + child] > d)) break;
        dist[base + pos] = dist[base + child];
        idx[base + pos] = idx[base + child];
        pos = child;
      }
      dist[base + pos] = d;
      idx[base + pos] = j;
    }
  }
}

// --- Exact search ----------------------------------------------------------------------------

// Brute-force kNN: O(n² · dim), each pair once. Use for n up to a few thousand and as a reference.
export function exactKnn(data, n, dim, k, options = {}) {
  const { metric = 'euclidean', onProgress, signal } = options;
  checkK(n, k);
  const X = prepareMatrix(data, n, dim, metric);
  const indices = new Int32Array(n * k).fill(-1);
  const dist = new Float64Array(n * k).fill(Infinity);
  for (let i = 0; i < n; i += 1) {
    if ((i & 127) === 0) {
      throwIfAborted(signal);
      if (onProgress) onProgress(1 - ((n - i) / n) ** 2, 'Finding nearest neighbors (exact)');
    }
    const oi = i * dim;
    const bi = i * k;
    for (let j = i + 1; j < n; j += 1) {
      const oj = j * dim;
      let d = 0;
      for (let t = 0; t < dim; t += 1) {
        const diff = X[oi + t] - X[oj + t];
        d += diff * diff;
      }
      if (d < dist[bi]) heapReplace(indices, dist, bi, k, j, d);
      const bj = j * k;
      if (d < dist[bj]) heapReplace(indices, dist, bj, k, i, d);
    }
  }
  sortRows(indices, dist, n, k);
  return { indices, distances: finishDistances(dist, metric) };
}

// A k-d tree over the rows of X: median splits on the widest dimension, leaves of ≤ leafSize points.
function buildKdTree(X, n, dim, leafSize = 16) {
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i += 1) perm[i] = i;
  const minLeaf = Math.max(1, (leafSize + 1) >> 1);
  const maxNodes = 2 * Math.ceil(n / minLeaf) + 3;
  const start = new Int32Array(maxNodes);
  const end = new Int32Array(maxNodes);
  const left = new Int32Array(maxNodes).fill(-1);
  const right = new Int32Array(maxNodes).fill(-1);
  const splitDim = new Int32Array(maxNodes);
  const splitValue = new Float64Array(maxNodes);
  let count = 1;
  start[0] = 0;
  end[0] = n;
  const stack = [0];
  while (stack.length) {
    const node = stack.pop();
    const s = start[node];
    const e = end[node];
    if (e - s <= leafSize) continue;
    let best = -1;
    let bestSpread = 0;
    for (let t = 0; t < dim; t += 1) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let p = s; p < e; p += 1) {
        const v = X[perm[p] * dim + t];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > bestSpread) {
        bestSpread = hi - lo;
        best = t;
      }
    }
    if (best < 0) continue; // all points identical: keep as one leaf
    const mid = (s + e) >> 1;
    selectByKey(perm, X, dim, best, s, e - 1, mid);
    splitDim[node] = best;
    splitValue[node] = X[perm[mid] * dim + best];
    const l = count++;
    const r = count++;
    start[l] = s; end[l] = mid;
    start[r] = mid; end[r] = e;
    left[node] = l;
    right[node] = r;
    stack.push(l, r);
  }
  return { perm, start, end, left, right, splitDim, splitValue, count };
}

// Hoare quickselect: reorders perm[lo…hi] so perm[kth] holds the kth smallest key, smaller keys
// before it and larger after.
function selectByKey(perm, X, dim, t, lo, hi, kth) {
  while (hi > lo) {
    const pivot = X[perm[(lo + hi) >> 1] * dim + t];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (X[perm[i] * dim + t] < pivot) i += 1;
      while (X[perm[j] * dim + t] > pivot) j -= 1;
      if (i <= j) {
        const tmp = perm[i];
        perm[i] = perm[j];
        perm[j] = tmp;
        i += 1;
        j -= 1;
      }
    }
    if (kth <= j) hi = j;
    else if (kth >= i) lo = i;
    else break;
  }
}

// Exact kNN with a k-d tree; efficient for dim ≤ ~5 (embeddings). Euclidean only.
export function kdTreeKnn(data, n, dim, k, options = {}) {
  const { onProgress, signal, leafSize = 16 } = options;
  checkK(n, k);
  const X = prepareMatrix(data, n, dim, 'euclidean');
  const tree = buildKdTree(X, n, dim, leafSize);
  const { perm, start, end, left, right, splitDim, splitValue } = tree;
  const indices = new Int32Array(n * k).fill(-1);
  const dist = new Float64Array(n * k).fill(Infinity);
  const stackNode = new Int32Array(256);
  const stackBound = new Float64Array(256);
  for (let i = 0; i < n; i += 1) {
    if ((i & 1023) === 0) {
      throwIfAborted(signal);
      if (onProgress) onProgress(i / n, 'Finding nearest neighbors (k-d tree)');
    }
    const oi = i * dim;
    const base = i * k;
    let sp = 0;
    stackNode[sp] = 0;
    stackBound[sp] = 0;
    sp += 1;
    while (sp > 0) {
      sp -= 1;
      const node = stackNode[sp];
      const bound = stackBound[sp];
      if (!(bound < dist[base])) continue;
      if (left[node] === -1) {
        for (let p = start[node]; p < end[node]; p += 1) {
          const j = perm[p];
          if (j === i) continue;
          const oj = j * dim;
          let d = 0;
          for (let t = 0; t < dim; t += 1) {
            const diff = X[oi + t] - X[oj + t];
            d += diff * diff;
          }
          if (d < dist[base]) heapReplace(indices, dist, base, k, j, d);
        }
      } else {
        const diff = X[oi + splitDim[node]] - splitValue[node];
        const near = diff < 0 ? left[node] : right[node];
        const far = diff < 0 ? right[node] : left[node];
        stackNode[sp] = far;
        stackBound[sp] = Math.max(bound, diff * diff);
        sp += 1;
        stackNode[sp] = near;
        stackBound[sp] = bound;
        sp += 1;
      }
    }
  }
  sortRows(indices, dist, n, k);
  return { indices, distances: finishDistances(dist, 'euclidean') };
}

// --- Random-projection trees -----------------------------------------------------------------

// One random-projection tree (pynndescent's euclidean_random_projection_split): each node splits
// by the hyperplane equidistant from two random member points. Leaves are contiguous ranges of
// `perm`. With keepPlanes the hyperplanes are stored so new points can be routed to a leaf.
function buildRpTree(X, n, dim, leafSize, random, keepPlanes) {
  const perm = new Int32Array(n);
  for (let i = 0; i < n; i += 1) perm[i] = i;
  const nodeStart = [0];
  const nodeEnd = [n];
  const nodeLeft = [-1];
  const nodeRight = [-1];
  const nodePlane = [-1];
  const leaves = [];
  const planes = keepPlanes ? [] : null;
  const offsets = keepPlanes ? [] : null;
  const normal = new Float64Array(dim);
  const stack = [0];
  while (stack.length) {
    const node = stack.pop();
    const s = nodeStart[node];
    const e = nodeEnd[node];
    const size = e - s;
    if (size <= leafSize) {
      leaves.push(s, e);
      continue;
    }
    const ia = random.int(size);
    let ib = random.int(size - 1);
    if (ib >= ia) ib += 1;
    const a = perm[s + ia] * dim;
    const b = perm[s + ib] * dim;
    let offset = 0;
    for (let t = 0; t < dim; t += 1) {
      normal[t] = X[a + t] - X[b + t];
      offset -= (normal[t] * (X[a + t] + X[b + t])) / 2;
    }
    let i = s;
    let j = e - 1;
    while (i <= j) {
      const p = perm[i];
      const o = p * dim;
      let margin = offset;
      for (let t = 0; t < dim; t += 1) margin += normal[t] * X[o + t];
      const goLeft = margin > RP_EPSILON ? true : margin < -RP_EPSILON ? false : random() < 0.5;
      if (goLeft) {
        i += 1;
      } else {
        perm[i] = perm[j];
        perm[j] = p;
        j -= 1;
      }
    }
    let mid = i;
    // Everything on one side (e.g. identical points): split the range arbitrarily in half.
    if (mid === s || mid === e) mid = (s + e) >> 1;
    let plane = -1;
    if (keepPlanes) {
      plane = offsets.length;
      planes.push(Float32Array.from(normal));
      offsets.push(offset);
    }
    const l = nodeStart.length;
    nodeStart.push(s, mid);
    nodeEnd.push(mid, e);
    nodeLeft.push(-1, -1);
    nodeRight.push(-1, -1);
    nodePlane.push(-1, -1);
    nodeLeft[node] = l;
    nodeRight[node] = l + 1;
    nodePlane[node] = plane;
    stack.push(l, l + 1);
  }
  const tree = { perm, leaves: Int32Array.from(leaves) };
  if (keepPlanes) {
    const nPlanes = offsets.length;
    const flat = new Float32Array(nPlanes * dim);
    for (let p = 0; p < nPlanes; p += 1) flat.set(planes[p], p * dim);
    Object.assign(tree, {
      start: Int32Array.from(nodeStart),
      end: Int32Array.from(nodeEnd),
      left: Int32Array.from(nodeLeft),
      right: Int32Array.from(nodeRight),
      plane: Int32Array.from(nodePlane),
      planes: flat,
      offsets: Float64Array.from(offsets),
    });
  }
  return tree;
}

// The leaf range [start, end) of `perm` that a point (Q[o…o+dim)) falls into.
function routeToLeaf(tree, Q, o, dim) {
  let node = 0;
  while (tree.left[node] !== -1) {
    const p = tree.plane[node];
    const pb = p * dim;
    let margin = tree.offsets[p];
    for (let t = 0; t < dim; t += 1) margin += tree.planes[pb + t] * Q[o + t];
    node = margin >= 0 ? tree.left[node] : tree.right[node];
  }
  return node;
}

// --- NN-Descent ------------------------------------------------------------------------------

function defaultTrees(n) {
  return Math.min(32, 5 + Math.round(Math.sqrt(Math.sqrt(n))));
}

// Runs the RP-forest initialization and NN-Descent on the prepared matrix. Returns squared
// distances, rows sorted ascending, plus the trees asked to be kept for queries.
function nnDescent(X, n, dim, k, options) {
  const {
    seed = DEFAULT_SEED,
    nTrees = defaultTrees(n),
    leafSize = Math.max(10, Math.min(k, 40)),
    maxIterations = Math.max(5, Math.round(Math.log2(n))),
    delta = 0.001,
    maxCandidates = k <= 30 ? k : 20,
    keepTrees = 0,
    onProgress,
    signal,
  } = options;
  const random = createRandom(seed);
  const leaf = Math.max(2, leafSize);
  const idx = new Int32Array(n * k).fill(-1);
  const dist = new Float32Array(n * k).fill(Infinity);
  const flags = new Uint8Array(n * k);
  const trees = [];

  // 1. Random-projection forest: every pair within a leaf is a candidate neighbor.
  for (let tr = 0; tr < nTrees; tr += 1) {
    throwIfAborted(signal);
    const tree = buildRpTree(X, n, dim, leaf, random, tr < keepTrees);
    if (tr < keepTrees) trees.push(tree);
    const { perm, leaves } = tree;
    for (let l = 0; l < leaves.length; l += 2) {
      const s = leaves[l];
      const e = leaves[l + 1];
      for (let a = s; a < e; a += 1) {
        const p = perm[a];
        const op = p * dim;
        const bp = p * k;
        for (let b = a + 1; b < e; b += 1) {
          const q = perm[b];
          const oq = q * dim;
          let d = 0;
          for (let t = 0; t < dim; t += 1) {
            const diff = X[op + t] - X[oq + t];
            d += diff * diff;
          }
          if (d < dist[bp]) flaggedPush(idx, dist, flags, bp, k, q, d);
          const bq = q * k;
          if (d < dist[bq]) flaggedPush(idx, dist, flags, bq, k, p, d);
        }
      }
    }
    if (onProgress) onProgress((0.3 * (tr + 1)) / nTrees, 'Nearest neighbors: random-projection forest');
  }
  // Rows not yet full (tiny leaves) get random neighbors, then a scan as a last resort.
  for (let i = 0; i < n; i += 1) {
    const base = i * k;
    let tries = 0;
    while (idx[base] === -1 && tries < 4 * k + 32) {
      tries += 1;
      const j = random.int(n);
      if (j === i) continue;
      flaggedPush(idx, dist, flags, base, k, j, squaredDistance(X, i * dim, X, j * dim, dim));
    }
    for (let j = 0; idx[base] === -1 && j < n; j += 1) {
      if (j !== i) flaggedPush(idx, dist, flags, base, k, j, squaredDistance(X, i * dim, X, j * dim, dim));
    }
  }

  // 2. NN-Descent: a neighbor of a neighbor is likely a neighbor. Each round joins sampled "new"
  // candidates (forward and reverse) with each other and with "old" ones (Dong et al. 2011, §2.3).
  const maxC = Math.max(1, maxCandidates);
  const newIdx = new Int32Array(n * maxC);
  const newPri = new Float32Array(n * maxC);
  const oldIdx = new Int32Array(n * maxC);
  const oldPri = new Float32Array(n * maxC);
  const stamp = new Int32Array(n);
  let stampValue = 0;
  const newList = new Int32Array(maxC);
  const oldList = new Int32Array(maxC);
  let iterations = 0;
  for (let iter = 0; iter < maxIterations; iter += 1) {
    throwIfAborted(signal);
    iterations = iter + 1;
    newIdx.fill(-1);
    newPri.fill(Infinity);
    oldIdx.fill(-1);
    oldPri.fill(Infinity);
    for (let i = 0; i < n; i += 1) {
      const base = i * k;
      for (let t = 0; t < k; t += 1) {
        const j = idx[base + t];
        if (j < 0) continue;
        const priority = random();
        if (flags[base + t]) {
          candidatePush(newIdx, newPri, i * maxC, maxC, j, priority);
          candidatePush(newIdx, newPri, j * maxC, maxC, i, priority);
        } else {
          candidatePush(oldIdx, oldPri, i * maxC, maxC, j, priority);
          candidatePush(oldIdx, oldPri, j * maxC, maxC, i, priority);
        }
      }
    }
    // Neighbors sampled as new candidates become old.
    for (let i = 0; i < n; i += 1) {
      stampValue += 1;
      const cb = i * maxC;
      for (let c = 0; c < maxC; c += 1) {
        const j = newIdx[cb + c];
        if (j >= 0) stamp[j] = stampValue;
      }
      const base = i * k;
      for (let t = 0; t < k; t += 1) {
        const j = idx[base + t];
        if (flags[base + t] && j >= 0 && stamp[j] === stampValue) flags[base + t] = 0;
      }
    }
    let updates = 0;
    for (let i = 0; i < n; i += 1) {
      if ((i & 4095) === 0) throwIfAborted(signal);
      const cb = i * maxC;
      let nNew = 0;
      let nOld = 0;
      for (let c = 0; c < maxC; c += 1) {
        const a = newIdx[cb + c];
        if (a >= 0) newList[nNew++] = a;
        const b = oldIdx[cb + c];
        if (b >= 0) oldList[nOld++] = b;
      }
      for (let a = 0; a < nNew; a += 1) {
        const p = newList[a];
        const op = p * dim;
        const bp = p * k;
        for (let b = a + 1; b < nNew; b += 1) {
          const q = newList[b];
          const oq = q * dim;
          let d = 0;
          for (let t = 0; t < dim; t += 1) {
            const diff = X[op + t] - X[oq + t];
            d += diff * diff;
          }
          if (d < dist[bp]) updates += flaggedPush(idx, dist, flags, bp, k, q, d);
          const bq = q * k;
          if (d < dist[bq]) updates += flaggedPush(idx, dist, flags, bq, k, p, d);
        }
        for (let b = 0; b < nOld; b += 1) {
          const q = oldList[b];
          if (q === p) continue;
          const oq = q * dim;
          let d = 0;
          for (let t = 0; t < dim; t += 1) {
            const diff = X[op + t] - X[oq + t];
            d += diff * diff;
          }
          if (d < dist[bp]) updates += flaggedPush(idx, dist, flags, bp, k, q, d);
          const bq = q * k;
          if (d < dist[bq]) updates += flaggedPush(idx, dist, flags, bq, k, p, d);
        }
      }
    }
    if (onProgress) onProgress(0.3 + (0.7 * (iter + 1)) / maxIterations, `Nearest neighbors: NN-Descent round ${iter + 1}`);
    if (updates <= delta * n * k) break;
  }
  sortRows(idx, dist, n, k);
  return { indices: idx, squared: dist, trees, iterations };
}

// Bounded max-heap keyed by random priority: keeps a uniform random subset of the candidates.
function candidatePush(idx, pri, base, size, j, priority) {
  if (!(priority < pri[base])) return;
  const end = base + size;
  for (let t = base; t < end; t += 1) if (idx[t] === j) return;
  heapReplace(idx, pri, base, size, j, priority);
}

function squaredDistance(A, oa, B, ob, dim) {
  let d = 0;
  for (let t = 0; t < dim; t += 1) {
    const diff = A[oa + t] - B[ob + t];
    d += diff * diff;
  }
  return d;
}

// Approximate kNN by NN-Descent from a random-projection forest. Typical recall is > 0.95 on
// cytometry-like data. Options: metric, seed, nTrees, leafSize, maxIterations, delta (early stop
// when fewer than delta·n·k neighbor lists improve in a round), maxCandidates.
export function approximateKnn(data, n, dim, k, options = {}) {
  const { metric = 'euclidean' } = options;
  checkK(n, k);
  const X = prepareMatrix(data, n, dim, metric);
  const result = nnDescent(X, n, dim, k, options);
  return { indices: result.indices, distances: finishDistances(result.squared, metric), iterations: result.iterations };
}

// kNN with the method suited to the size: a k-d tree for 1–3-D Euclidean data, brute force up to
// options.exactThreshold events (default 5000), NN-Descent above. options.method forces
// 'exact' | 'kdtree' | 'approximate'.
export function knn(data, n, dim, k, options = {}) {
  const { method = 'auto', metric = 'euclidean', exactThreshold = EXACT_THRESHOLD } = options;
  if (method === 'kdtree' || (method === 'auto' && metric === 'euclidean' && dim <= 3)) {
    if (metric !== 'euclidean') throw new Error('The k-d tree search supports Euclidean distance only.');
    return kdTreeKnn(data, n, dim, k, options);
  }
  if (method === 'exact' || (method === 'auto' && n <= exactThreshold)) return exactKnn(data, n, dim, k, options);
  if (method !== 'approximate' && method !== 'auto') throw new Error(`Unknown neighbor search method "${method}".`);
  return approximateKnn(data, n, dim, k, options);
}

// --- Index for placing new points --------------------------------------------------------------

// A reusable search index over a reference set: its kNN graph (which callers such as UMAP need
// anyway) plus one random-projection tree for entry points. The returned object holds a reference
// to `data` (or a normalized copy for cosine) and is consumed by queryKnn.
export function createKnnIndex(data, n, dim, k, options = {}) {
  const { metric = 'euclidean', seed = DEFAULT_SEED, exactThreshold = EXACT_THRESHOLD, method = 'auto' } = options;
  checkK(n, k);
  const X = prepareMatrix(data, n, dim, metric);
  let indices;
  let squared;
  let trees;
  if (method === 'exact' || (method === 'auto' && n <= exactThreshold)) {
    const exact = exactKnn(X, n, dim, k, { ...options, metric: 'euclidean' });
    indices = exact.indices;
    squared = new Float32Array(exact.distances.length);
    for (let i = 0; i < squared.length; i += 1) squared[i] = exact.distances[i] * exact.distances[i];
    trees = [buildRpTree(X, n, dim, Math.max(10, Math.min(k, 40)), createRandom(seed ^ 0x5bd1e995), true)];
  } else {
    const result = nnDescent(X, n, dim, k, { ...options, keepTrees: 1 });
    indices = result.indices;
    squared = result.squared;
    trees = result.trees;
  }
  return { data: X, n, dim, k, metric, indices, distances: finishDistances(squared, metric), trees, searchGraph: null };
}

// Undirected search graph: each point's kNN plus up to k reverse neighbors (pynndescent also adds
// reverse edges so that hubs are reachable).
function buildSearchGraph(index) {
  const { n, k, indices } = index;
  const reverseCount = new Int32Array(n);
  for (let e = 0; e < n * k; e += 1) {
    const j = indices[e];
    if (j >= 0 && reverseCount[j] < k) reverseCount[j] += 1;
  }
  const offsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i += 1) offsets[i + 1] = offsets[i] + k + reverseCount[i];
  const targets = new Int32Array(offsets[n]).fill(-1);
  const cursor = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) targets[offsets[i] + t] = indices[i * k + t];
    cursor[i] = offsets[i] + k;
  }
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) {
      const j = indices[i * k + t];
      if (j >= 0 && cursor[j] < offsets[j + 1]) targets[cursor[j]++] = i;
    }
  }
  return { offsets, targets };
}

// The k nearest reference points of each of m new points (queryData: Float32Array m × dim).
// Searches exhaustively for small references (options.method = 'exact'), otherwise best-first on
// the reference kNN graph; options.epsilon (default 0.1) widens the search for higher recall.
export function queryKnn(index, queryData, m, k, options = {}) {
  const { epsilon = 0.1, seed = DEFAULT_SEED, method = 'auto', onProgress, signal } = options;
  const { n, dim, metric } = index;
  const X = index.data;
  if (!Number.isInteger(k) || k < 1 || k > n) throw new Error(`Cannot find ${k} neighbors among ${n} reference events.`);
  const Q = prepareMatrix(queryData, m, dim, metric);
  const indices = new Int32Array(m * k).fill(-1);
  const dist = new Float64Array(m * k).fill(Infinity);
  if (method === 'exact' || (method === 'auto' && n <= 2048) || !index.indices) {
    for (let q = 0; q < m; q += 1) {
      if ((q & 255) === 0) {
        throwIfAborted(signal);
        if (onProgress) onProgress(q / m, 'Placing new events (exact)');
      }
      const base = q * k;
      for (let j = 0; j < n; j += 1) {
        const d = squaredDistance(Q, q * dim, X, j * dim, dim);
        if (d < dist[base]) heapReplace(indices, dist, base, k, j, d);
      }
    }
    sortRows(indices, dist, m, k);
    return { indices, distances: finishDistances(dist, metric) };
  }
  if (!index.searchGraph) index.searchGraph = buildSearchGraph(index);
  const { offsets, targets } = index.searchGraph;
  const random = createRandom(seed);
  const visited = new Int32Array(n);
  const candIdx = new Int32Array(n);
  const candDist = new Float64Array(n);
  const scale = (1 + epsilon) * (1 + epsilon); // distances are squared
  for (let q = 0; q < m; q += 1) {
    if ((q & 255) === 0) {
      throwIfAborted(signal);
      if (onProgress) onProgress(q / m, 'Placing new events');
    }
    const stampValue = q + 1;
    const oq = q * dim;
    const base = q * k;
    let size = 0;
    const visit = (j) => {
      visited[j] = stampValue;
      const d = squaredDistance(Q, oq, X, j * dim, dim);
      if (d < dist[base]) heapReplace(indices, dist, base, k, j, d);
      size = minHeapPush(candIdx, candDist, size, j, d);
    };
    for (const tree of index.trees) {
      const leaf = routeToLeaf(tree, Q, oq, dim);
      for (let p = tree.start[leaf]; p < tree.end[leaf]; p += 1) {
        const j = tree.perm[p];
        if (visited[j] !== stampValue) visit(j);
      }
    }
    for (let tries = 0; (indices[base] === -1 || tries < 4) && tries < 8 * k + 32; tries += 1) {
      const j = random.int(n);
      if (visited[j] !== stampValue) visit(j);
    }
    while (size > 0) {
      const c = candIdx[0];
      const dc = candDist[0];
      size = minHeapPop(candIdx, candDist, size);
      if (dc > dist[base] * scale) break;
      for (let e = offsets[c]; e < offsets[c + 1]; e += 1) {
        const u = targets[e];
        if (u < 0 || visited[u] === stampValue) continue;
        visited[u] = stampValue;
        const d = squaredDistance(Q, oq, X, u * dim, dim);
        if (d < dist[base] * scale) {
          size = minHeapPush(candIdx, candDist, size, u, d);
          if (d < dist[base]) heapReplace(indices, dist, base, k, u, d);
        }
      }
    }
  }
  sortRows(indices, dist, m, k);
  return { indices, distances: finishDistances(dist, metric) };
}

function minHeapPush(idx, dist, size, j, d) {
  let pos = size;
  while (pos > 0) {
    const parent = (pos - 1) >> 1;
    if (!(dist[parent] > d)) break;
    idx[pos] = idx[parent];
    dist[pos] = dist[parent];
    pos = parent;
  }
  idx[pos] = j;
  dist[pos] = d;
  return size + 1;
}

function minHeapPop(idx, dist, size) {
  const last = size - 1;
  const j = idx[last];
  const d = dist[last];
  let pos = 0;
  for (;;) {
    const left = 2 * pos + 1;
    if (left >= last) break;
    const right = left + 1;
    let child = left;
    if (right < last && dist[right] < dist[left]) child = right;
    if (!(dist[child] < d)) break;
    idx[pos] = idx[child];
    dist[pos] = dist[child];
    pos = child;
  }
  idx[pos] = j;
  dist[pos] = d;
  return last;
}

// Fraction of the true neighbors (rows of `truth`) found in `approx`, both n × k index arrays.
export function knnRecall(approx, truth, n, k) {
  let size = 1;
  for (let e = 0; e < n * k; e += 1) size = Math.max(size, truth[e] + 1, approx[e] + 1);
  const mark = new Int32Array(size).fill(-1);
  let hits = 0;
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    for (let t = 0; t < k; t += 1) {
      const j = truth[i * k + t];
      if (j >= 0 && j < mark.length) mark[j] = i;
    }
    for (let t = 0; t < k; t += 1) {
      const j = approx[i * k + t];
      if (j >= 0 && j < mark.length && mark[j] === i) hits += 1;
    }
    total += k;
  }
  return total ? hits / total : 1;
}
