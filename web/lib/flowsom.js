// FlowSOM: self-organizing-map clustering with consensus metaclustering, plus the agglomerative
// hierarchical clustering it (and the cluster heatmaps) rely on.
//
// Van Gassen S, et al. FlowSOM: using self-organizing maps for visualization and interpretation
// of cytometry data. Cytometry A 2015;87:636–645, doi:10.1002/cyto.a.22625. Defaults and the
// training loop follow the R package (SOM() and its C_SOM routine): a 10 × 10 grid, rlen = 10
// passes of rlen·n online steps on events drawn at random (with replacement), a learning rate
// falling linearly from 0.05 to 0.01, and a neighborhood radius falling linearly from the 0.67
// quantile of the grid distances to 0 (floored at 0.5, so the winner alone is updated at the
// end). The neighborhood is every node within the radius in Chebyshev ("maximum") grid
// distance. Codes start as randomly chosen events. Metaclustering follows
// metaClustering_consensus: ConsensusClusterPlus (Wilkerson & Hayes 2010,
// doi:10.1093/bioinformatics/btq170) with average-linkage hierarchical clustering of Euclidean
// distances, 100 resamplings of 90 % of the nodes, and a final average-linkage tree on
// 1 − consensus.
//
// Input: `data` is a dense row-major Float32Array of n × dim values, already on an analysis
// scale (arcsinh, logicle, …). Codes are returned as Float32Array(nodes × dim), row-major.

import { createRandom, sampleIndices, shuffle } from './random.js';
import { quantileSorted } from './stats.js';

export const LINKAGES = ['single', 'complete', 'average', 'mcquitty', 'ward.D', 'ward.D2'];

const PROGRESS_STEPS = 1 << 16;

function canceled() {
  const error = new Error('Clustering was canceled.');
  error.name = 'AbortError';
  return error;
}

export function checkMatrix(data, n, dim) {
  if (!data || typeof data.length !== 'number') throw new Error('Clustering needs a data matrix.');
  if (!Number.isInteger(n) || n < 1) throw new Error('Clustering needs at least one event.');
  if (!Number.isInteger(dim) || dim < 1) throw new Error('Choose at least one channel to cluster on.');
  if (data.length < n * dim) {
    throw new Error(`The data matrix holds ${data.length} values, but ${n} events × ${dim} channels need ${n * dim}.`);
  }
  for (let i = 0, end = n * dim; i < end; i += 1) {
    const v = data[i];
    if (v - v !== 0) {
      throw new Error(`Event ${Math.floor(i / dim) + 1} has a missing or infinite value in channel ${(i % dim) + 1}; transform or remove such events before clustering.`);
    }
  }
}

function scaled(onProgress, from, to) {
  if (!onProgress) return null;
  return (fraction, message) => onProgress(from + (to - from) * fraction, message);
}

// ---------------------------------------------------------------------------------------------
// Self-organizing map

// Node coordinates on the grid, 0-based, node i at (i mod xdim, ⌊i / xdim⌋) as R's
// expand.grid(1:xdim, 1:ydim).
export function somGrid(xdim, ydim) {
  const nodes = xdim * ydim;
  const grid = new Float32Array(nodes * 2);
  for (let i = 0; i < nodes; i += 1) {
    grid[2 * i] = i % xdim;
    grid[2 * i + 1] = Math.floor(i / xdim);
  }
  return grid;
}

// Chebyshev distances between grid nodes (FlowSOM: dist(grid, method = "maximum")).
export function gridDistances(xdim, ydim) {
  const nodes = xdim * ydim;
  const out = new Float64Array(nodes * nodes);
  for (let a = 0; a < nodes; a += 1) {
    const ax = a % xdim; const ay = Math.floor(a / xdim);
    for (let b = 0; b < nodes; b += 1) {
      out[a * nodes + b] = Math.max(Math.abs(ax - (b % xdim)), Math.abs(ay - Math.floor(b / xdim)));
    }
  }
  return out;
}

// FlowSOM's starting radius: quantile(nhbrdist, 0.67) over the full node × node matrix (R type 7).
export function defaultRadius(xdim, ydim) {
  return quantileSorted(gridDistances(xdim, ydim).sort(), 0.67);
}

// Trains a SOM. Options: xdim, ydim (10), rlen (10), alpha ([0.05, 0.01]), radius
// ([quantile 0.67, 0]), seed (1), codes (initial Float32Array, else random events), onProgress,
// signal. Returns { codes, xdim, ydim, nodes, dim, grid, bmu } where bmu holds each event's last
// best-matching node during training (−1 if never drawn), used to speed up mapping.
export function trainSOM(data, n, dim, options = {}) {
  checkMatrix(data, n, dim);
  const xdim = options.xdim ?? 10;
  const ydim = options.ydim ?? 10;
  if (!Number.isInteger(xdim) || !Number.isInteger(ydim) || xdim < 1 || ydim < 1) {
    throw new Error('The SOM grid size must be a whole number of nodes in each direction.');
  }
  const nodes = xdim * ydim;
  const rlen = options.rlen ?? 10;
  const [alphaStart, alphaEnd] = options.alpha ?? [0.05, 0.01];
  const [radiusStart, radiusEnd] = options.radius ?? [defaultRadius(xdim, ydim), 0];
  const { onProgress, signal } = options;
  const random = createRandom(options.seed ?? 1);

  const codes = new Float64Array(nodes * dim);
  if (options.codes) {
    if (options.codes.length !== nodes * dim) throw new Error(`Initial codes must hold ${nodes} nodes × ${dim} channels.`);
    codes.set(options.codes);
  } else {
    if (n < nodes) {
      throw new Error(`A ${xdim} × ${ydim} map needs at least ${nodes} events; this population has ${n}. Use a smaller grid.`);
    }
    // R: data[sample(1:n, nCodes), ] — distinct random events, in random order.
    const picks = shuffle(sampleIndices(n, nodes, random), random);
    for (let c = 0; c < nodes; c += 1) {
      for (let j = 0; j < dim; j += 1) codes[c * dim + j] = data[picks[c] * dim + j];
    }
  }

  const bmu = new Int32Array(n).fill(-1);
  const x = new Float64Array(dim);
  const niter = rlen * n;
  const thresholdStep = (radiusStart - radiusEnd) / niter;
  const alphaStep = (alphaStart - alphaEnd) / niter;
  let threshold = radiusStart;

  for (let start = 0; start < niter; start += PROGRESS_STEPS) {
    if (signal?.aborted) throw canceled();
    if (onProgress && start) onProgress(start / niter, `Training the SOM (pass ${Math.floor(start / n) + 1} of ${rlen})`);
    const stop = Math.min(niter, start + PROGRESS_STEPS);
    for (let k = start; k < stop; k += 1) {
      const i = random.int(n);
      const base = i * dim;
      for (let j = 0; j < dim; j += 1) x[j] = data[base + j];
      // Nearest code; the event's previous winner gives a tight starting bound so most other
      // nodes are rejected after a few channels. Ties keep the lowest node index, as C_SOM.
      let nearest = bmu[i];
      let best = Infinity;
      if (nearest >= 0) {
        best = 0;
        const off = nearest * dim;
        for (let j = 0; j < dim; j += 1) {
          const t = x[j] - codes[off + j];
          best += t * t;
        }
      } else {
        nearest = 0;
      }
      for (let cd = 0, off = 0; cd < nodes; cd += 1, off += dim) {
        let s = 0;
        for (let j = 0; j < dim; j += 1) {
          const t = x[j] - codes[off + j];
          s += t * t;
          if (s > best) break;
        }
        if (s < best || (s === best && cd < nearest)) {
          best = s;
          nearest = cd;
        }
      }
      bmu[i] = nearest;

      if (threshold < 1) threshold = 0.5;
      const alpha = alphaStart - alphaStep * k;
      // Grid distances are integers, so "distance ≤ threshold" is a square window.
      const r = Math.floor(threshold);
      const wx = nearest % xdim;
      const wy = (nearest - wx) / xdim;
      const x0 = wx > r ? wx - r : 0;
      const x1 = wx + r < xdim ? wx + r : xdim - 1;
      const y0 = wy > r ? wy - r : 0;
      const y1 = wy + r < ydim ? wy + r : ydim - 1;
      for (let gy = y0; gy <= y1; gy += 1) {
        for (let gx = x0; gx <= x1; gx += 1) {
          const off = (gy * xdim + gx) * dim;
          for (let j = 0; j < dim; j += 1) codes[off + j] += alpha * (x[j] - codes[off + j]);
        }
      }
      threshold -= thresholdStep;
    }
  }
  if (onProgress) onProgress(1, 'SOM trained');
  return { codes: Float32Array.from(codes), xdim, ydim, nodes, dim, grid: somGrid(xdim, ydim), bmu };
}

// Assigns every event to its nearest code (Euclidean). Options: hint (Int32Array of likely
// nodes, e.g. som.bmu), onProgress, signal. Returns { mapping: Int32Array(n), distances:
// Float32Array(n) } as FlowSOM's MapDataToCodes.
export function mapToSOM(som, data, n, options = {}) {
  const { nodes, dim } = som;
  checkMatrix(data, n, dim);
  const codes = Float64Array.from(som.codes);
  const hint = options.hint && options.hint.length >= n ? options.hint : null;
  const { onProgress, signal } = options;
  const mapping = new Int32Array(n);
  const distances = new Float32Array(n);
  const x = new Float64Array(dim);
  let previous = 0;
  for (let start = 0; start < n; start += PROGRESS_STEPS) {
    if (signal?.aborted) throw canceled();
    if (onProgress && start) onProgress(start / n, 'Mapping events to the SOM');
    const stop = Math.min(n, start + PROGRESS_STEPS);
    for (let i = start; i < stop; i += 1) {
      const base = i * dim;
      for (let j = 0; j < dim; j += 1) x[j] = data[base + j];
      let nearest = hint && hint[i] >= 0 ? hint[i] : previous;
      let best = 0;
      let off = nearest * dim;
      for (let j = 0; j < dim; j += 1) {
        const t = x[j] - codes[off + j];
        best += t * t;
      }
      off = 0;
      for (let cd = 0; cd < nodes; cd += 1, off += dim) {
        let s = 0;
        for (let j = 0; j < dim; j += 1) {
          const t = x[j] - codes[off + j];
          s += t * t;
          if (s > best) break;
        }
        if (s < best || (s === best && cd < nearest)) {
          best = s;
          nearest = cd;
        }
      }
      mapping[i] = nearest;
      distances[i] = Math.sqrt(best);
      previous = nearest;
    }
  }
  if (onProgress) onProgress(1, 'Events mapped');
  return { mapping, distances };
}

// Events per node.
export function nodeCounts(mapping, nodes) {
  const counts = new Uint32Array(nodes);
  for (let i = 0; i < mapping.length; i += 1) {
    const c = mapping[i];
    if (c >= 0 && c < nodes) counts[c] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Minimum spanning tree and its layout

// Full n × n distance matrix between rows of a row-major matrix. metric: 'euclidean',
// 'manhattan', 'maximum', or 'pearson' (1 − Pearson correlation).
export function distanceMatrix(data, n, dim, metric = 'euclidean') {
  const out = new Float64Array(n * n);
  let rows = data;
  if (metric === 'pearson') {
    rows = new Float64Array(n * dim);
    for (let i = 0; i < n; i += 1) {
      let m = 0;
      for (let j = 0; j < dim; j += 1) m += data[i * dim + j];
      m /= dim;
      let ss = 0;
      for (let j = 0; j < dim; j += 1) {
        const d = data[i * dim + j] - m;
        rows[i * dim + j] = d;
        ss += d * d;
      }
      const norm = ss > 0 ? 1 / Math.sqrt(ss) : 0;
      for (let j = 0; j < dim; j += 1) rows[i * dim + j] *= norm;
    }
  } else if (!['euclidean', 'manhattan', 'maximum'].includes(metric)) {
    throw new Error(`Unknown distance "${metric}"; use euclidean, manhattan, maximum or pearson.`);
  }
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      let s = 0;
      if (metric === 'euclidean') {
        for (let j = 0; j < dim; j += 1) {
          const t = rows[a * dim + j] - rows[b * dim + j];
          s += t * t;
        }
        s = Math.sqrt(s);
      } else if (metric === 'manhattan') {
        for (let j = 0; j < dim; j += 1) s += Math.abs(rows[a * dim + j] - rows[b * dim + j]);
      } else if (metric === 'maximum') {
        for (let j = 0; j < dim; j += 1) s = Math.max(s, Math.abs(rows[a * dim + j] - rows[b * dim + j]));
      } else {
        for (let j = 0; j < dim; j += 1) s += rows[a * dim + j] * rows[b * dim + j];
        s = 1 - s;
      }
      out[a * n + b] = s;
      out[b * n + a] = s;
    }
  }
  return out;
}

// Prim's minimum spanning tree over the SOM codes (Euclidean), as FlowSOM's BuildMST, with a
// Kamada–Kawai layout of the tree (FlowSOM uses igraph's layout.kamada.kawai with edge lengths
// = weights / mean weight). Returns { edges: [[a, b], ...], weights: Float64Array, layout:
// Float32Array(nodes × 2) }.
export function buildMST(som, options = {}) {
  const { nodes, dim, codes } = som;
  const dist = distanceMatrix(codes, nodes, dim);
  const { edges, weights } = primMST(dist, nodes);
  const layout = treeLayout(nodes, edges, weights, options);
  return { edges, weights, layout };
}

export function primMST(dist, n) {
  const inTree = new Uint8Array(n);
  const key = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const edges = [];
  const weights = new Float64Array(Math.max(0, n - 1));
  if (n === 0) return { edges, weights };
  key[0] = 0;
  for (let step = 0; step < n; step += 1) {
    let u = -1;
    let best = Infinity;
    for (let v = 0; v < n; v += 1) {
      if (!inTree[v] && (key[v] < best || u < 0)) {
        best = key[v];
        u = v;
      }
    }
    inTree[u] = 1;
    if (parent[u] >= 0) {
      weights[edges.length] = dist[parent[u] * n + u];
      edges.push([parent[u], u]);
    }
    for (let v = 0; v < n; v += 1) {
      if (!inTree[v] && dist[u * n + v] < key[v]) {
        key[v] = dist[u * n + v];
        parent[v] = u;
      }
    }
  }
  return { edges, weights };
}

// Kamada–Kawai layout of a tree (Kamada & Kawai 1989, doi:10.1016/0020-0190(89)90102-6): the
// energy Σ (‖xᵢ − xⱼ‖ − dᵢⱼ)² / dᵢⱼ² over tree path lengths dᵢⱼ, minimized by stress
// majorization (Gansner, Koren & North 2004, doi:10.1007/978-3-540-31843-9_25) from a classical
// MDS start. Edge lengths are normalized to mean 1, as FlowSOM does.
function treeLayout(nodes, edges, weights, options = {}) {
  const layout = new Float32Array(nodes * 2);
  if (nodes < 2) return layout;
  let mean = 0;
  for (let e = 0; e < edges.length; e += 1) mean += weights[e];
  mean = mean / edges.length || 1;
  const adjacency = Array.from({ length: nodes }, () => []);
  edges.forEach(([a, b], e) => {
    const w = weights[e] / mean || 1e-9;
    adjacency[a].push(b, w);
    adjacency[b].push(a, w);
  });
  // Path lengths: one traversal per source (paths in a tree are unique).
  const d = new Float64Array(nodes * nodes).fill(-1);
  const stack = new Int32Array(nodes);
  for (let s = 0; s < nodes; s += 1) {
    const row = s * nodes;
    d[row + s] = 0;
    let top = 0;
    stack[top++] = s;
    while (top) {
      const u = stack[--top];
      const list = adjacency[u];
      for (let q = 0; q < list.length; q += 2) {
        const v = list[q];
        if (d[row + v] < 0) {
          d[row + v] = d[row + u] + list[q + 1];
          stack[top++] = v;
        }
      }
    }
  }
  let maxD = 0;
  for (let i = 0; i < d.length; i += 1) if (d[i] > maxD) maxD = d[i];
  for (let i = 0; i < d.length; i += 1) if (d[i] < 0) d[i] = maxD + 1; // disconnected (not for an MST)

  const random = createRandom(options.seed ?? 1);
  const pos = classicalMDS(d, nodes, random);
  for (let i = 0; i < pos.length; i += 1) pos[i] += (random() - 0.5) * 1e-3; // break exact overlaps

  const stress = () => {
    let s = 0;
    for (let i = 0; i < nodes; i += 1) {
      for (let j = i + 1; j < nodes; j += 1) {
        const dij = d[i * nodes + j];
        if (!(dij > 0)) continue;
        const dx = pos[2 * i] - pos[2 * j];
        const dy = pos[2 * i + 1] - pos[2 * j + 1];
        const r = Math.sqrt(dx * dx + dy * dy) - dij;
        s += (r * r) / (dij * dij);
      }
    }
    return s;
  };
  let last = stress();
  for (let sweep = 0; sweep < 500; sweep += 1) {
    for (let i = 0; i < nodes; i += 1) {
      let nx = 0; let ny = 0; let wsum = 0;
      const xi = pos[2 * i]; const yi = pos[2 * i + 1];
      for (let j = 0; j < nodes; j += 1) {
        const dij = d[i * nodes + j];
        if (j === i || !(dij > 0)) continue;
        const w = 1 / (dij * dij);
        const dx = xi - pos[2 * j];
        const dy = yi - pos[2 * j + 1];
        const len = Math.sqrt(dx * dx + dy * dy);
        const f = len > 0 ? dij / len : 0;
        nx += w * (pos[2 * j] + f * dx);
        ny += w * (pos[2 * j + 1] + f * dy);
        wsum += w;
      }
      if (wsum > 0) {
        pos[2 * i] = nx / wsum;
        pos[2 * i + 1] = ny / wsum;
      }
    }
    if (sweep % 5 === 4) {
      const now = stress();
      if (last - now <= 1e-5 * last) break;
      last = now;
    }
  }
  layout.set(pos);
  return layout;
}

// Top two principal coordinates of a distance matrix (Torgerson), by power iteration.
function classicalMDS(d, n, random) {
  const b = new Float64Array(n * n);
  const rowMean = new Float64Array(n);
  let grand = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const sq = d[i * n + j] * d[i * n + j];
      b[i * n + j] = sq;
      rowMean[i] += sq / n;
    }
    grand += rowMean[i] / n;
  }
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) b[i * n + j] = -0.5 * (b[i * n + j] - rowMean[i] - rowMean[j] + grand);
  }
  const pos = new Float64Array(n * 2);
  const vectors = [];
  for (let axis = 0; axis < 2; axis += 1) {
    let v = new Float64Array(n);
    for (let i = 0; i < n; i += 1) v[i] = random() - 0.5;
    let lambda = 0;
    for (let iter = 0; iter < 300; iter += 1) {
      const w = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        let s = 0;
        for (let j = 0; j < n; j += 1) s += b[i * n + j] * v[j];
        w[i] = s;
      }
      for (const [u, lu] of vectors) {
        let dot = 0;
        for (let i = 0; i < n; i += 1) dot += u[i] * v[i];
        for (let i = 0; i < n; i += 1) w[i] -= lu * dot * u[i];
      }
      let norm = 0;
      for (let i = 0; i < n; i += 1) norm += w[i] * w[i];
      norm = Math.sqrt(norm);
      if (!(norm > 0)) break;
      lambda = 0;
      for (let i = 0; i < n; i += 1) lambda += v[i] * w[i];
      for (let i = 0; i < n; i += 1) w[i] /= norm;
      v = w;
    }
    vectors.push([v, lambda]);
    const scale = Math.sqrt(Math.max(lambda, 0));
    for (let i = 0; i < n; i += 1) pos[2 * i + axis] = v[i] * scale;
  }
  return pos;
}

// ---------------------------------------------------------------------------------------------
// Agglomerative hierarchical clustering

// Hierarchical clustering of a full n × n dissimilarity matrix with Lance–Williams updates
// (Lance & Williams 1967), as R's hclust: linkage 'single', 'complete', 'average' (UPGMA),
// 'mcquitty' (WPGMA), 'ward.D' (Ward's update on the given dissimilarities) or 'ward.D2'
// (Ward's criterion on squared dissimilarities, heights square-rooted; Murtagh & Legendre 2014,
// doi:10.1007/s00357-014-9161-z). A nearest-neighbor cache keeps it O(n²) in practice.
//
// Returns { n, merges: Int32Array((n − 1) × 2), heights: Float64Array(n − 1), sizes:
// Int32Array(n − 1), order: Int32Array(n) }. In merges, ids 0…n−1 are items and n + s is the
// cluster formed at step s; each row lists the smaller id first (R's convention), and `order`
// is the left-to-right leaf order for drawing the dendrogram.
export function hclust(dist, n, linkage = 'average') {
  if (!LINKAGES.includes(linkage)) throw new Error(`Unknown linkage "${linkage}"; use one of ${LINKAGES.join(', ')}.`);
  if (dist.length < n * n) throw new Error(`hclust needs an ${n} × ${n} distance matrix.`);
  const merges = new Int32Array(Math.max(0, n - 1) * 2);
  const heights = new Float64Array(Math.max(0, n - 1));
  const sizes = new Int32Array(Math.max(0, n - 1));
  if (n < 2) return { n, merges, heights, sizes, order: n ? Int32Array.of(0) : new Int32Array(0) };
  const ward2 = linkage === 'ward.D2';
  const d = new Float64Array(n * n);
  for (let i = 0; i < n * n; i += 1) {
    const v = dist[i];
    if (v - v !== 0) throw new Error('Distances for hierarchical clustering must be finite numbers.');
    d[i] = ward2 ? v * v : v;
  }
  const size = new Float64Array(n).fill(1);
  const id = Int32Array.from({ length: n }, (_, i) => i);
  const active = new Uint8Array(n).fill(1);
  const nn = new Int32Array(n);
  const nnd = new Float64Array(n);
  const findNN = (i) => {
    let b = -1; let bd = Infinity;
    const row = i * n;
    for (let j = 0; j < n; j += 1) {
      if (j !== i && active[j] && (d[row + j] < bd || b < 0)) {
        bd = d[row + j];
        b = j;
      }
    }
    nn[i] = b;
    nnd[i] = bd;
  };
  for (let i = 0; i < n; i += 1) findNN(i);

  for (let s = 0; s < n - 1; s += 1) {
    let a = -1; let ad = Infinity;
    for (let i = 0; i < n; i += 1) {
      if (active[i] && (nnd[i] < ad || a < 0)) {
        ad = nnd[i];
        a = i;
      }
    }
    const i = Math.min(a, nn[a]);
    const j = Math.max(a, nn[a]);
    const idA = id[i]; const idB = id[j];
    merges[2 * s] = Math.min(idA, idB);
    merges[2 * s + 1] = Math.max(idA, idB);
    heights[s] = ward2 ? Math.sqrt(Math.max(ad, 0)) : ad;
    const ni = size[i]; const nj = size[j];
    sizes[s] = ni + nj;
    const dij = d[i * n + j];
    for (let k = 0; k < n; k += 1) {
      if (!active[k] || k === i || k === j) continue;
      const dki = d[k * n + i]; const dkj = d[k * n + j];
      const nk = size[k];
      let v;
      switch (linkage) {
        case 'single': v = Math.min(dki, dkj); break;
        case 'complete': v = Math.max(dki, dkj); break;
        case 'average': v = (ni * dki + nj * dkj) / (ni + nj); break;
        case 'mcquitty': v = (dki + dkj) / 2; break;
        default: v = ((ni + nk) * dki + (nj + nk) * dkj - nk * dij) / (ni + nj + nk); // Ward
      }
      d[k * n + i] = v;
      d[i * n + k] = v;
    }
    active[j] = 0;
    size[i] = ni + nj;
    id[i] = n + s;
    for (let k = 0; k < n; k += 1) {
      if (!active[k] || k === i) continue;
      if (nn[k] === i || nn[k] === j) findNN(k);
      else if (d[k * n + i] < nnd[k]) {
        nn[k] = i;
        nnd[k] = d[k * n + i];
      }
    }
    findNN(i);
  }
  return { n, merges, heights, sizes, order: leafOrder(merges, n) };
}

function leafOrder(merges, n) {
  const order = new Int32Array(n);
  let p = 0;
  const stack = [2 * n - 2];
  while (stack.length) {
    const node = stack.pop();
    if (node < n) order[p++] = node;
    else {
      const s = node - n;
      stack.push(merges[2 * s + 1], merges[2 * s]);
    }
  }
  return order;
}

// Cuts a tree into k groups (R's cutree): undo the last k − 1 merges; groups are numbered
// 0, 1, … in order of their first item.
export function cutTree(tree, k) {
  const { n, merges } = tree;
  const labels = new Int32Array(n);
  if (n === 0) return labels;
  const target = Math.max(1, Math.min(n, Math.round(k)));
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const rep = new Int32Array(Math.max(0, n - 1));
  for (let s = 0; s < n - target; s += 1) {
    const a = merges[2 * s]; const b = merges[2 * s + 1];
    const ra = find(a < n ? a : rep[a - n]);
    const rb = find(b < n ? b : rep[b - n]);
    parent[rb] = ra;
    rep[s] = ra;
  }
  const map = new Int32Array(n).fill(-1);
  let next = 0;
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    if (map[r] < 0) map[r] = next++;
    labels[i] = map[r];
  }
  return labels;
}

// Coordinates for drawing a dendrogram: leaves at x = 0…n−1 in tree order and y = 0; merge s
// (node n + s) at the midpoint of its children and y = its height. Returns { x, y } of length
// 2n − 1, indexed by node id.
export function dendrogramLayout(tree) {
  const { n, merges, heights, order } = tree;
  const total = Math.max(0, 2 * n - 1);
  const x = new Float64Array(total);
  const y = new Float64Array(total);
  for (let p = 0; p < n; p += 1) x[order[p]] = p;
  for (let s = 0; s < n - 1; s += 1) {
    x[n + s] = (x[merges[2 * s]] + x[merges[2 * s + 1]]) / 2;
    y[n + s] = heights[s];
  }
  return { x, y };
}

// ---------------------------------------------------------------------------------------------
// Metaclustering

// ConsensusClusterPlus with hierarchical clustering, as FlowSOM's metaClustering_consensus:
// `reps` resamplings of ⌊pItem·nodes⌋ nodes, each clustered (average linkage, Euclidean) and cut
// at every k; consensus = (times together) / (times sampled together); the final grouping cuts
// an average-linkage tree on 1 − consensus. Options: ks (list of k, default 2…maxK), reps (100),
// pItem (0.9), linkage ('average'), finalLinkage ('average'), seed (1), onProgress, signal.
// Returns { ks, classes: { [k]: Int32Array(nodes) }, consensus: { [k]: Float64Array },
// area, delta, pac } where area is the area under the consensus CDF (100-bin histogram, as
// ConsensusClusterPlus), delta its relative change from k − 1, and pac the proportion of
// ambiguous clustering, CDF(0.9) − CDF(0.1) (Șenbabaoğlu et al. 2014, doi:10.1038/srep06207).
export function consensusClustering(codes, nodes, dim, maxK, options = {}) {
  const ks = options.ks ?? Array.from({ length: Math.max(0, maxK - 1) }, (_, i) => i + 2);
  const reps = options.reps ?? 100;
  const pItem = options.pItem ?? 0.9;
  const linkage = options.linkage ?? 'average';
  const finalLinkage = options.finalLinkage ?? 'average';
  const { onProgress, signal } = options;
  const weights = options.weights ?? null;
  for (const k of ks) {
    if (!Number.isInteger(k) || k < 1 || k > nodes) throw new Error(`Cannot make ${k} metaclusters from ${nodes} nodes.`);
  }
  const random = createRandom(options.seed ?? 1);
  const full = distanceMatrix(codes, nodes, dim);
  const m = Math.max(2, Math.min(nodes, Math.floor(nodes * pItem)));
  const count = new Float64Array(nodes * nodes);
  const together = ks.map(() => new Float64Array(nodes * nodes));
  const sub = new Float64Array(m * m);
  for (let rep = 0; rep < reps; rep += 1) {
    if (signal?.aborted) throw canceled();
    if (onProgress && rep % 10 === 0) onProgress((0.9 * rep) / reps, `Consensus metaclustering (${rep} of ${reps})`);
    const pick = sampleIndices(nodes, m, random);
    for (let a = 0; a < m; a += 1) {
      for (let b = 0; b < m; b += 1) sub[a * m + b] = full[pick[a] * nodes + pick[b]];
    }
    const tree = hclust(sub, m, linkage);
    for (let a = 0; a < m; a += 1) {
      const row = pick[a] * nodes;
      for (let b = a + 1; b < m; b += 1) count[row + pick[b]] += 1;
    }
    ks.forEach((k, ki) => {
      const lab = cutTree(tree, k);
      const tg = together[ki];
      for (let a = 0; a < m; a += 1) {
        const row = pick[a] * nodes;
        for (let b = a + 1; b < m; b += 1) if (lab[a] === lab[b]) tg[row + pick[b]] += 1;
      }
    });
  }
  // Histogram breaks as R's seq(0, 1, by = 0.01).
  const breaks = Float64Array.from({ length: 101 }, (_, i) => i * 0.01);
  const classes = {};
  const consensus = {};
  const area = new Float64Array(ks.length);
  const pac = new Float64Array(ks.length);
  ks.forEach((k, ki) => {
    const c = new Float64Array(nodes * nodes);
    const hist = new Float64Array(100);
    let ambiguous = 0;
    let pairs = 0;
    for (let a = 0; a < nodes; a += 1) {
      c[a * nodes + a] = 1;
      for (let b = a + 1; b < nodes; b += 1) {
        const total = count[a * nodes + b];
        const v = total > 0 ? together[ki][a * nodes + b] / total : 0;
        c[a * nodes + b] = v;
        c[b * nodes + a] = v;
        const w = weights ? weights[a] * weights[b] : 1;
        if (!w) continue;
        let bin = Math.min(99, Math.max(0, Math.ceil(v * 100) - 1));
        while (bin > 0 && v <= breaks[bin]) bin -= 1;
        while (bin < 99 && v > breaks[bin + 1]) bin += 1;
        hist[bin] += w;
        if (v > 0.1 && v <= 0.9) ambiguous += w;
        pairs += w;
      }
    }
    let cumulative = 0;
    for (let bin = 0; bin < 100; bin += 1) {
      cumulative += hist[bin];
      area[ki] += (pairs ? cumulative / pairs : 1) * (breaks[bin + 1] - breaks[bin]);
    }
    pac[ki] = pairs ? ambiguous / pairs : 0;
    const dissim = new Float64Array(nodes * nodes);
    for (let i = 0; i < c.length; i += 1) dissim[i] = 1 - c[i];
    classes[k] = cutTree(hclust(dissim, nodes, finalLinkage), k);
    consensus[k] = c;
  });
  const delta = new Float64Array(ks.length);
  for (let ki = 0; ki < ks.length; ki += 1) {
    delta[ki] = ki === 0 ? area[0] : (area[ki] - area[ki - 1]) / area[ki - 1];
  }
  if (onProgress) onProgress(1, 'Metaclustering done');
  return { ks: Int32Array.from(ks), classes, consensus, area, delta, pac };
}

// Metacluster label (0…k−1) for each SOM node. Options: method 'consensus' (FlowSOM's default,
// see consensusClustering) or 'hierarchical' (FlowSOM's metaClustering_hclust: one tree on
// Euclidean distances, linkage default 'complete'), plus seed, reps, pItem, linkage.
export function metacluster(codes, nodes, dim, k, options = {}) {
  if (!Number.isInteger(k) || k < 1) throw new Error('The number of metaclusters must be a whole number of at least 1.');
  if (k > nodes) throw new Error(`Cannot make ${k} metaclusters from ${nodes} SOM nodes; choose at most ${nodes}.`);
  const method = options.method ?? 'consensus';
  if (method === 'hierarchical') {
    return cutTree(hclust(distanceMatrix(codes, nodes, dim), nodes, options.linkage ?? 'complete'), k);
  }
  if (method !== 'consensus') throw new Error(`Unknown metaclustering method "${method}".`);
  if (k === 1) return new Int32Array(nodes);
  return consensusClustering(codes, nodes, dim, k, { ...options, ks: [k] }).classes[k];
}

// Within-cluster sum of squares of rows grouped by labels, optionally weighting each row (for
// SOM codes, by its event count, which approximates the event-level sum of squares).
export function withinSS(data, n, dim, labels, weights = null) {
  let k = 0;
  for (let i = 0; i < n; i += 1) k = Math.max(k, labels[i] + 1);
  const sums = new Float64Array(k * dim);
  const counts = new Float64Array(k);
  for (let i = 0; i < n; i += 1) {
    const c = labels[i];
    const w = weights ? weights[i] : 1;
    counts[c] += w;
    for (let j = 0; j < dim; j += 1) sums[c * dim + j] += w * data[i * dim + j];
  }
  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    const c = labels[i];
    const w = weights ? weights[i] : 1;
    if (!w) continue;
    for (let j = 0; j < dim; j += 1) {
      const t = data[i * dim + j] - sums[c * dim + j] / counts[c];
      sse += w * t * t;
    }
  }
  return sse;
}

// FlowSOM's findElbow: the break point i (1-based) minimizing the summed absolute residuals of
// two least-squares lines, one through points 1…i−1 and one through i…n.
export function findElbow(values) {
  const n = values.length;
  const residuals = (from, to) => { // 1-based inclusive
    const m = to - from + 1;
    if (m <= 2) return 0;
    let sx = 0; let sy = 0;
    for (let x = from; x <= to; x += 1) { sx += x; sy += values[x - 1]; }
    const mx = sx / m; const my = sy / m;
    let sxy = 0; let sxx = 0;
    for (let x = from; x <= to; x += 1) {
      sxy += (x - mx) * (values[x - 1] - my);
      sxx += (x - mx) * (x - mx);
    }
    const slope = sxy / sxx;
    let r = 0;
    for (let x = from; x <= to; x += 1) r += Math.abs(values[x - 1] - (my + slope * (x - mx)));
    return r;
  };
  let best = Infinity;
  let optimal = 1;
  for (let i = 2; i <= n - 1; i += 1) {
    const r = residuals(1, i - 1) + residuals(i, n);
    if (r < best) {
      best = r;
      optimal = i;
    }
  }
  return optimal;
}

// Suggests a number of metaclusters from ConsensusClusterPlus's diagnostics (Monti et al. 2003,
// doi:10.1023/A:1023949509487). Methods:
//   'delta' (default) — the smallest k after which adding a cluster raises the area under the
//     consensus CDF by less than `minDelta` (0.01) relative to the previous k: the point of "no
//     appreciable increase" in the delta-area plot.
//   'area' — the elbow of the area curve, located with FlowSOM's two-line findElbow.
//   'sse' — FlowSOM's DetermineNumberOfClusters: the elbow of the within-cluster sum of squares
//     of the codes (made non-increasing) for k = 1…maxK.
// Pass `weights` (events per node, e.g. flowsom's nodeCounts) so that each pair of nodes counts
// by its pairs of events and empty nodes count for nothing; on simulated data this is markedly
// more reliable for every method. Options: maxK (min(20, nodes − 1)), method, minDelta, weights,
// seed, reps, pItem, onProgress, signal. Returns { k, method, ks, area, delta, pac, sse,
// classes } so the UI can plot every diagnostic and switch k without recomputing.
export function suggestK(codes, nodes, dim, options = {}) {
  const maxK = Math.min(options.maxK ?? 20, nodes - 1);
  if (maxK < 3) throw new Error('Choosing the number of metaclusters needs a map of at least 4 nodes.');
  const method = options.method ?? 'delta';
  if (!['delta', 'area', 'sse'].includes(method)) {
    throw new Error(`Unknown method "${method}" for choosing k; use delta, area or sse.`);
  }
  const cc = consensusClustering(codes, nodes, dim, maxK, options);
  const weights = options.weights ?? null;
  const sse = new Float64Array(maxK);
  sse[0] = withinSS(codes, nodes, dim, new Int32Array(nodes), weights);
  for (let k = 2; k <= maxK; k += 1) sse[k - 1] = Math.min(sse[k - 2], withinSS(codes, nodes, dim, cc.classes[k], weights));
  let k = maxK;
  if (method === 'sse') {
    k = findElbow(sse);
  } else if (method === 'area') {
    k = findElbow(cc.area) + 1; // area[0] is k = 2
  } else {
    const minDelta = options.minDelta ?? 0.01;
    for (let i = 0; i < cc.ks.length - 1; i += 1) {
      if (cc.delta[i + 1] < minDelta) {
        k = cc.ks[i];
        break;
      }
    }
  }
  return { k, method, ks: cc.ks, area: cc.area, delta: cc.delta, pac: cc.pac, sse, classes: cc.classes };
}

// ---------------------------------------------------------------------------------------------
// The whole pipeline

// FlowSOM on a row-major matrix. Options: everything trainSOM takes, k (10, FlowSOM's nClus; or
// 'auto' to choose with suggestK using maxK and kMethod), metaclustering ({ method, reps, pItem,
// linkage }), seed, onProgress, signal. Returns { som, mapping, distances, nodeCounts, mst,
// metaclusters: Int32Array(nodes), labels: Int32Array(n), k, suggestion, params }.
export function flowsom(data, n, dim, options = {}) {
  const seed = options.seed ?? 1;
  const { onProgress, signal } = options;
  const som = trainSOM(data, n, dim, { ...options, seed, onProgress: scaled(onProgress, 0, 0.8) });
  const { mapping, distances } = mapToSOM(som, data, n, { hint: som.bmu, signal, onProgress: scaled(onProgress, 0.8, 0.88) });
  const counts = nodeCounts(mapping, som.nodes);
  const mst = buildMST(som, { seed });
  const metaOptions = { ...(options.metaclustering ?? {}), seed, signal, onProgress: scaled(onProgress, 0.9, 1) };
  let k = options.k ?? 10;
  let suggestion = null;
  let metaclusters;
  if (k === 'auto') {
    suggestion = suggestK(som.codes, som.nodes, dim, {
      ...metaOptions, maxK: options.maxK, method: options.kMethod, weights: counts,
    });
    k = suggestion.k;
    metaclusters = suggestion.classes[k] ?? new Int32Array(som.nodes);
  } else {
    metaclusters = metacluster(som.codes, som.nodes, dim, k, metaOptions);
  }
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i += 1) labels[i] = metaclusters[mapping[i]];
  if (onProgress) onProgress(1, 'FlowSOM done');
  const params = {
    xdim: som.xdim, ydim: som.ydim, rlen: options.rlen ?? 10, alpha: options.alpha ?? [0.05, 0.01],
    radius: options.radius ?? [defaultRadius(som.xdim, som.ydim), 0], k, seed,
    metaclustering: { method: 'consensus', reps: 100, pItem: 0.9, ...(options.metaclustering ?? {}) },
  };
  return { som, mapping, distances, nodeCounts: counts, mst, metaclusters, labels, k, suggestion, params };
}
