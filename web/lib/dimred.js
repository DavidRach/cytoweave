// Dimension reduction of event data: PCA, Barnes-Hut t-SNE and UMAP.
//
//   pca            covariance (or correlation) matrix + Jacobi eigen-decomposition (Pearson 1901;
//                  Hotelling 1933).
//   tsne           Barnes-Hut t-SNE (van der Maaten 2014, JMLR 15:3221) on a 3·perplexity kNN
//                  graph, PCA initialisation with PC1 sd = 1e-4 (Kobak & Linderman 2021,
//                  doi:10.1038/s41587-020-00809-z), learning rate n / early exaggeration (Belkina
//                  et al. 2019, doi:10.1038/s41467-019-13055-y; Kobak & Berens 2019), optional
//                  opt-SNE stopping rules (Belkina et al. 2019).
//   umap           UMAP (McInnes, Healy & Melville 2018, arXiv:1802.03426) following umap-learn
//                  0.5 defaults: fuzzy simplicial set, spectral initialisation, SGD with negative
//                  sampling. transformUmap places new events into an existing embedding.
//   spectralEmbedding  normalised-Laplacian eigenvectors of a sparse graph by Chebyshev-filtered
//                  subspace iteration (Zhou & Saad 2007, doi:10.1016/j.jcp.2006.06.033).
//
// Input is a dense row-major Float32Array (n × dim) of transformed values (e.g. arcsinh or
// logicle scale), already restricted to the channels of interest. Embeddings are Float32Array
// (n × nComponents), row-major.

import { createRandom } from './random.js';
import { DEFAULT_SEED, createKnnIndex, knn, progressRange, queryKnn, throwIfAborted } from './knn.js';
import { connectedComponents, fuzzySimplicialSet, membershipStrengths, smoothKnnDist, symmetrize } from './graph-cluster.js';
import { symmetricEigen } from './linalg.js';

function checkMatrix(data, n, dim, minEvents = 2) {
  if (!Number.isInteger(n) || !Number.isInteger(dim) || dim < 1) throw new Error('Event count and dimension count must be positive whole numbers.');
  if (n < minEvents) throw new Error(`This method needs at least ${minEvents} events; the selection has ${n}.`);
  if (!data || data.length < n * dim) throw new Error(`Expected ${n} events × ${dim} dimensions but got ${data ? data.length : 0} values.`);
}

// --- PCA -------------------------------------------------------------------------------------------

// Principal component analysis. Options: components (2), center (true), scale (false: covariance
// PCA; true: correlation PCA, each dimension divided by its SD). Returns scores (n × components),
// explainedVariance (eigenvalues, i.e. variance along each component), explainedVarianceRatio,
// eigenvalues (all), mean, scale, and loadings (components × dim, unit eigenvectors; the sign is
// fixed so each vector's largest-magnitude entry is positive).
export function pca(data, n, dim, options = {}) {
  const { center = true, scale = false, onProgress, signal } = options;
  checkMatrix(data, n, dim, 2);
  const nc = Math.max(1, Math.min(options.components ?? 2, dim));
  const mean = new Float64Array(dim);
  if (center) {
    for (let i = 0; i < n; i += 1) for (let t = 0; t < dim; t += 1) mean[t] += data[i * dim + t];
    for (let t = 0; t < dim; t += 1) mean[t] /= n;
  }
  for (let i = 0; i < n * dim; i += 1) {
    if (!Number.isFinite(data[i])) throw new Error(`Event ${Math.floor(i / dim) + 1} has a missing or infinite value.`);
  }
  const cov = new Float64Array(dim * dim);
  const row = new Float64Array(dim);
  for (let i = 0; i < n; i += 1) {
    if ((i & 65535) === 0) throwIfAborted(signal);
    const o = i * dim;
    for (let t = 0; t < dim; t += 1) row[t] = data[o + t] - mean[t];
    for (let a = 0; a < dim; a += 1) {
      const xa = row[a];
      const base = a * dim;
      for (let b = a; b < dim; b += 1) cov[base + b] += xa * row[b];
    }
  }
  for (let a = 0; a < dim; a += 1) {
    for (let b = a; b < dim; b += 1) {
      cov[a * dim + b] /= n - 1;
      cov[b * dim + a] = cov[a * dim + b];
    }
  }
  const sd = new Float64Array(dim).fill(1);
  if (scale) {
    for (let t = 0; t < dim; t += 1) sd[t] = Math.sqrt(cov[t * dim + t]) || 1;
    for (let a = 0; a < dim; a += 1) for (let b = 0; b < dim; b += 1) cov[a * dim + b] /= sd[a] * sd[b];
  }
  if (onProgress) onProgress(0.5, 'PCA: eigen-decomposition');
  const { values, vectors } = symmetricEigen(cov, dim);
  const loadings = new Float64Array(nc * dim);
  for (let c = 0; c < nc; c += 1) {
    let big = 0;
    for (let t = 0; t < dim; t += 1) if (Math.abs(vectors[t * dim + c]) > Math.abs(big)) big = vectors[t * dim + c];
    const sign = big < 0 ? -1 : 1;
    for (let t = 0; t < dim; t += 1) loadings[c * dim + t] = sign * vectors[t * dim + c];
  }
  const eigenvalues = Float64Array.from(values, (v) => Math.max(0, v));
  let totalVariance = 0;
  for (let t = 0; t < dim; t += 1) totalVariance += eigenvalues[t];
  const explainedVariance = eigenvalues.slice(0, nc);
  const explainedVarianceRatio = Float64Array.from(explainedVariance, (v) => (totalVariance > 0 ? v / totalVariance : 0));
  const scores = new Float32Array(n * nc);
  for (let i = 0; i < n; i += 1) {
    const o = i * dim;
    for (let t = 0; t < dim; t += 1) row[t] = (data[o + t] - mean[t]) / sd[t];
    for (let c = 0; c < nc; c += 1) {
      let s = 0;
      const lb = c * dim;
      for (let t = 0; t < dim; t += 1) s += row[t] * loadings[lb + t];
      scores[i * nc + c] = s;
    }
  }
  if (onProgress) onProgress(1, 'PCA done');
  return { scores, components: nc, explainedVariance, explainedVarianceRatio, eigenvalues, mean, scale: sd, loadings };
}

// Projects new events onto a fitted PCA (same dimensions, same order).
export function pcaTransform(model, data, m) {
  const { mean, scale, loadings, components: nc } = model;
  const dim = mean.length;
  checkMatrix(data, m, dim, 1);
  const scores = new Float32Array(m * nc);
  for (let i = 0; i < m; i += 1) {
    for (let c = 0; c < nc; c += 1) {
      let s = 0;
      for (let t = 0; t < dim; t += 1) s += ((data[i * dim + t] - mean[t]) / scale[t]) * loadings[c * dim + t];
      scores[i * nc + c] = s;
    }
  }
  return scores;
}

// --- t-SNE -----------------------------------------------------------------------------------------

// Conditional probabilities p(j|i) ∝ exp(−β_i d_ij²) over each row's kNN, β_i found by bisection so
// that the entropy equals log(perplexity) (van der Maaten & Hinton 2008), then P = (P + Pᵀ) / 2n.
export function tsneAffinities(neighbours, n, k, perplexity) {
  const target = Math.log(perplexity);
  const values = new Float32Array(n * k);
  const d2 = new Float64Array(k);
  const p = new Float64Array(k);
  for (let i = 0; i < n; i += 1) {
    const base = i * k;
    let dmin = Infinity;
    for (let t = 0; t < k; t += 1) {
      const d = neighbours.distances[base + t];
      d2[t] = d * d;
      if (d2[t] < dmin) dmin = d2[t];
    }
    for (let t = 0; t < k; t += 1) d2[t] -= dmin; // shift for stability; entropy is unchanged
    let beta = 1;
    let lo = 0;
    let hi = Infinity;
    let sum = 0;
    for (let it = 0; it < 200; it += 1) {
      sum = 0;
      let dp = 0;
      for (let t = 0; t < k; t += 1) {
        p[t] = Math.exp(-beta * d2[t]);
        sum += p[t];
        dp += d2[t] * p[t];
      }
      const entropy = Math.log(sum) + (beta * dp) / sum;
      if (Math.abs(entropy - target) < 1e-5) break;
      if (entropy > target) {
        lo = beta;
        beta = hi === Infinity ? beta * 2 : (beta + hi) / 2;
      } else {
        hi = beta;
        beta = (beta + lo) / 2;
      }
    }
    for (let t = 0; t < k; t += 1) values[base + t] = p[t] / sum;
  }
  const P = symmetrize(neighbours.indices, values, n, k, 'sum');
  const scale = 1 / (2 * n);
  for (let e = 0; e < P.weights.length; e += 1) P.weights[e] *= scale;
  return P;
}

// Quadtree for the Barnes-Hut approximation, in flat typed arrays reused between iterations.
// Each node has a square cell (centre cx, cy and half-width hw, used while building) and, packed
// in `node` with stride 4, its centre of mass, mass and squared cell width. Leaves chain their
// points through `next` (several only at MAX_DEPTH, i.e. coincident points). `order` lists the
// points depth-first, so consecutive force evaluations walk similar paths (cache locality).
const MAX_DEPTH = 48;

function createTree(n) {
  const cap = 4 * n + 64;
  return {
    cap,
    count: 0,
    child: new Int32Array(cap),
    first: new Int32Array(cap),
    node: new Float64Array(4 * cap),
    cx: new Float64Array(cap),
    cy: new Float64Array(cap),
    hw: new Float64Array(cap),
    next: new Int32Array(n),
    order: new Int32Array(n),
  };
}

function growTree(tree) {
  const cap = tree.cap * 2;
  for (const key of ['child', 'first', 'cx', 'cy', 'hw']) {
    const bigger = new tree[key].constructor(cap);
    bigger.set(tree[key]);
    tree[key] = bigger;
  }
  const node = new Float64Array(4 * cap);
  node.set(tree.node);
  tree.node = node;
  tree.cap = cap;
}

function buildTree(tree, Y, n) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const x = Y[2 * i];
    const y = Y[2 * i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  let { child, first, node, cx, cy, hw } = tree;
  const { next } = tree;
  tree.count = 1;
  child[0] = -1;
  first[0] = -1;
  cx[0] = (minX + maxX) / 2;
  cy[0] = (minY + maxY) / 2;
  hw[0] = (Math.max(maxX - minX, maxY - minY) / 2) * (1 + 1e-6) + 1e-12;
  node[0] = 0;
  node[1] = 0;
  node[2] = 0;
  node[3] = 4 * hw[0] * hw[0];
  for (let i = 0; i < n; i += 1) {
    const x = Y[2 * i];
    const y = Y[2 * i + 1];
    let v = 0;
    for (let depth = 0; ; depth += 1) {
      const o = 4 * v;
      const m1 = node[o + 2] + 1;
      node[o] += (x - node[o]) / m1;
      node[o + 1] += (y - node[o + 1]) / m1;
      node[o + 2] = m1;
      if (child[v] === -1) {
        const p = first[v];
        if (p === -1) {
          first[v] = i;
          next[i] = -1;
          break;
        }
        if (depth >= MAX_DEPTH) {
          next[i] = p;
          first[v] = i;
          break;
        }
        if (tree.count + 4 > tree.cap) {
          growTree(tree);
          ({ child, first, node, cx, cy, hw } = tree);
        }
        const c = tree.count;
        tree.count += 4;
        const h = hw[v] / 2;
        for (let q = 0; q < 4; q += 1) {
          const cq = c + q;
          child[cq] = -1;
          first[cq] = -1;
          cx[cq] = cx[v] + (q & 1 ? h : -h);
          cy[cq] = cy[v] + (q & 2 ? h : -h);
          hw[cq] = h;
          node[4 * cq] = 0;
          node[4 * cq + 1] = 0;
          node[4 * cq + 2] = 0;
          node[4 * cq + 3] = 4 * h * h;
        }
        child[v] = c;
        first[v] = -1;
        const px = Y[2 * p];
        const py = Y[2 * p + 1];
        const qp = c + (px >= cx[v] ? 1 : 0) + (py >= cy[v] ? 2 : 0);
        first[qp] = p;
        next[p] = -1;
        node[4 * qp] = px;
        node[4 * qp + 1] = py;
        node[4 * qp + 2] = 1;
      }
      v = child[v] + (x >= cx[v] ? 1 : 0) + (y >= cy[v] ? 2 : 0);
    }
  }
  // Depth-first point order.
  const { order } = tree;
  const stack = new Int32Array(4 * MAX_DEPTH + 16);
  let sp = 0;
  let k = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    const v = stack[--sp];
    if (child[v] === -1) {
      for (let p = first[v]; p !== -1; p = next[p]) order[k++] = p;
    } else {
      const c = child[v];
      for (let q = 3; q >= 0; q -= 1) if (node[4 * (c + q) + 2] > 0) stack[sp++] = c + q;
    }
  }
}

// t-SNE gradient (without the conventional factor 4, as bhtsne/openTSNE, so learning rates are
// comparable with theirs): ∂C/∂y_i = α Σ_j p_ij q̃_ij (y_i − y_j) − (1/Z) Σ_j q̃_ij² (y_i − y_j),
// q̃_ij = 1/(1 + ‖y_i − y_j‖²), Z = Σ q̃. Repulsion by Barnes-Hut: a cell of width w at distance d
// from its centre of mass is summarised when w < θ·d. Returns KL(P‖Q) when withKl.
function tsneGradient(Y, n, P, exaggeration, theta2, tree, grad, negX, negY, sumPLogP, withKl) {
  buildTree(tree, Y, n);
  const { child, first, node, next, order } = tree;
  const stack = new Int32Array(4 * MAX_DEPTH + 16);
  let Z = 0;
  for (let a = 0; a < n; a += 1) {
    const i = order[a];
    const x = Y[2 * i];
    const y = Y[2 * i + 1];
    let sumQ = 0;
    let fx = 0;
    let fy = 0;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const v = stack[--sp];
      const c = child[v];
      if (c === -1) {
        for (let p = first[v]; p !== -1; p = next[p]) {
          if (p === i) continue;
          const dx = x - Y[2 * p];
          const dy = y - Y[2 * p + 1];
          const q = 1 / (1 + dx * dx + dy * dy);
          sumQ += q;
          const q2 = q * q;
          fx += q2 * dx;
          fy += q2 * dy;
        }
      } else {
        const o = 4 * v;
        const dx = x - node[o];
        const dy = y - node[o + 1];
        const d2 = dx * dx + dy * dy;
        if (node[o + 3] < theta2 * d2) {
          const m = node[o + 2];
          const q = 1 / (1 + d2);
          sumQ += m * q;
          const mq2 = m * q * q;
          fx += mq2 * dx;
          fy += mq2 * dy;
        } else {
          if (node[4 * c + 2] > 0) stack[sp++] = c;
          if (node[4 * c + 6] > 0) stack[sp++] = c + 1;
          if (node[4 * c + 10] > 0) stack[sp++] = c + 2;
          if (node[4 * c + 14] > 0) stack[sp++] = c + 3;
        }
      }
    }
    Z += sumQ;
    negX[i] = fx;
    negY[i] = fy;
  }
  const invZ = 1 / Z;
  const { offsets, targets, weights } = P;
  let sumPLogQ = 0;
  for (let i = 0; i < n; i += 1) {
    const x = Y[2 * i];
    const y = Y[2 * i + 1];
    let ax = 0;
    let ay = 0;
    for (let e = offsets[i]; e < offsets[i + 1]; e += 1) {
      const j = targets[e];
      const dx = x - Y[2 * j];
      const dy = y - Y[2 * j + 1];
      const q = 1 / (1 + dx * dx + dy * dy);
      const pq = weights[e] * q;
      ax += pq * dx;
      ay += pq * dy;
      if (withKl) sumPLogQ += weights[e] * Math.log(q);
    }
    grad[2 * i] = exaggeration * ax - negX[i] * invZ;
    grad[2 * i + 1] = exaggeration * ay - negY[i] * invZ;
  }
  return withKl ? sumPLogP - sumPLogQ + Math.log(Z) : NaN;
}

// Barnes-Hut t-SNE into 2-D. Options: perplexity (30), theta (0.5), maxIterations (750),
// earlyExaggeration (12), earlyExaggerationIterations (250), learningRate ('auto' = max(n/12, 50)),
// momentum (0.5 → finalMomentum 0.8), init ('pca' | 'random' | Float32Array n×2), optSNE (false:
// when true, early exaggeration ends once the relative KL decrease peaks and the run stops when KL
// improves by less than KL/5000 per iteration, Belkina et al. 2019), metric, seed, knn (a
// precomputed kNN result), onProgress, signal.
export function tsne(data, n, dim, options = {}) {
  const {
    perplexity = 30,
    theta = 0.5,
    maxIterations = 750,
    earlyExaggeration = 12,
    earlyExaggerationIterations = 250,
    learningRate = 'auto',
    momentum = 0.5,
    finalMomentum = 0.8,
    init = 'pca',
    optSNE = false,
    metric = 'euclidean',
    seed = DEFAULT_SEED,
    onProgress,
    signal,
  } = options;
  checkMatrix(data, n, dim, 5);
  if ((options.nComponents ?? 2) !== 2) throw new Error('t-SNE here embeds into two dimensions only.');
  const perp = Math.max(1, Math.min(perplexity, (n - 1) / 3));
  let k = Math.min(n - 1, Math.floor(3 * perp));
  let neighbours = options.knn;
  if (neighbours) k = neighbours.indices.length / n;
  else neighbours = knn(data, n, dim, k, { metric, seed, onProgress: progressRange(onProgress, 0, 0.2), signal });
  throwIfAborted(signal);
  if (onProgress) onProgress(0.2, 't-SNE: calibrating perplexity');
  const P = tsneAffinities(neighbours, n, k, perp);
  let sumPLogP = 0;
  for (let e = 0; e < P.weights.length; e += 1) if (P.weights[e] > 0) sumPLogP += P.weights[e] * Math.log(P.weights[e]);

  const random = createRandom(seed);
  const Y = new Float64Array(2 * n);
  if (init === 'pca') {
    const scores = pca(data, n, dim, { components: 2 }).scores;
    let s1 = 0;
    let m1 = 0;
    for (let i = 0; i < n; i += 1) m1 += scores[2 * i];
    m1 /= n;
    for (let i = 0; i < n; i += 1) s1 += (scores[2 * i] - m1) ** 2;
    s1 = Math.sqrt(s1 / (n - 1)) || 1;
    for (let i = 0; i < 2 * n; i += 1) Y[i] = (scores[i] / s1) * 1e-4;
    // Coincident events would share a position; a negligible jitter separates them.
    for (let i = 0; i < 2 * n; i += 1) Y[i] += random.gaussian() * 1e-10;
  } else if (init === 'random') {
    for (let i = 0; i < 2 * n; i += 1) Y[i] = random.gaussian() * 1e-4;
  } else if (init && init.length === 2 * n) {
    for (let i = 0; i < 2 * n; i += 1) Y[i] = init[i];
  } else {
    throw new Error("t-SNE init must be 'pca', 'random' or an n × 2 array.");
  }
  const lr = learningRate === 'auto' ? Math.max(n / earlyExaggeration, 50) : learningRate;
  const update = new Float64Array(2 * n);
  const gains = new Float64Array(2 * n).fill(1);
  const grad = new Float64Array(2 * n);
  const negX = new Float64Array(n);
  const negY = new Float64Array(n);
  const tree = createTree(n);
  const theta2 = theta * theta;
  let eeEnd = optSNE ? Math.floor(maxIterations / 2) : Math.min(earlyExaggerationIterations, maxIterations);
  let kl = NaN;
  let lastKl = NaN;
  let prevKl = NaN;
  let maxRate = -Infinity;
  let belowPeak = 0;
  let iterations = 0;
  const history = [];
  for (let iter = 0; iter < maxIterations; iter += 1) {
    if ((iter & 7) === 0) throwIfAborted(signal);
    const inEE = iter < eeEnd;
    const report = iter % 10 === 0 || iter === maxIterations - 1;
    const withKl = optSNE || iter % 50 === 0 || iter === maxIterations - 1;
    kl = tsneGradient(Y, n, P, inEE ? earlyExaggeration : 1, theta2, tree, grad, negX, negY, sumPLogP, withKl);
    const mom = inEE ? momentum : finalMomentum;
    for (let c = 0; c < 2 * n; c += 1) {
      const g = grad[c];
      gains[c] = Math.sign(g) !== Math.sign(update[c]) ? gains[c] + 0.2 : Math.max(0.01, gains[c] * 0.8);
      update[c] = mom * update[c] - lr * gains[c] * g;
      Y[c] += update[c];
    }
    // Keep the embedding centred (bhtsne does the same).
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i += 1) {
      mx += Y[2 * i];
      my += Y[2 * i + 1];
    }
    mx /= n;
    my /= n;
    for (let i = 0; i < n; i += 1) {
      Y[2 * i] -= mx;
      Y[2 * i + 1] -= my;
    }
    iterations = iter + 1;
    if (withKl) {
      history.push([iter, kl]);
      lastKl = kl;
    }
    if (optSNE && iter > 0 && Number.isFinite(prevKl)) {
      const rate = (prevKl - kl) / kl;
      if (inEE) {
        // End exaggeration once the relative KL decrease has passed its maximum (ten
        // consecutive iterations below the peak, to ride out Barnes-Hut noise and early wiggles).
        belowPeak = rate < maxRate ? belowPeak + 1 : 0;
        maxRate = Math.max(maxRate, rate);
        if (iter >= 20 && belowPeak >= 10) eeEnd = iter + 1;
      } else if (iter > eeEnd + 50 && prevKl - kl < kl / 5000) {
        prevKl = kl;
        break;
      }
    }
    prevKl = withKl ? kl : prevKl;
    if (report && onProgress) {
      onProgress(0.25 + (0.75 * iterations) / maxIterations, `t-SNE iteration ${iterations}/${maxIterations}, KL ${lastKl.toFixed(3)}`);
    }
  }
  // KL divergence of the returned layout (Barnes-Hut estimate of Z).
  kl = tsneGradient(Y, n, P, 1, theta2, tree, grad, negX, negY, sumPLogP, true);
  if (onProgress) onProgress(1, `t-SNE done, KL ${kl.toFixed(3)}`);
  return {
    embedding: Float32Array.from(Y),
    kl,
    klHistory: history,
    iterations,
    earlyExaggerationIterations: Math.min(eeEnd, iterations),
    learningRate: lr,
    perplexity: perp,
    k,
  };
}

// --- UMAP: curve parameters ----------------------------------------------------------------------

// umap-learn's find_ab_params: least-squares fit of 1/(1 + a x^{2b}) to the target membership
// (1 below min_dist, exp(−(x − min_dist)/spread) above) on 300 points in [0, 3·spread], starting
// from a = b = 1 as scipy's curve_fit. Solved here by Levenberg–Marquardt with an analytic Jacobian.
export function findAbParams(spread = 1, minDist = 0.1) {
  if (!(spread > 0) || !(minDist >= 0)) throw new Error('UMAP spread must be positive and min_dist non-negative.');
  const m = 300;
  const xs = new Float64Array(m);
  const ys = new Float64Array(m);
  for (let i = 0; i < m; i += 1) {
    xs[i] = (3 * spread * i) / (m - 1);
    ys[i] = xs[i] < minDist ? 1 : Math.exp(-(xs[i] - minDist) / spread);
  }
  const cost = (a, b) => {
    let s = 0;
    for (let i = 0; i < m; i += 1) {
      const r = 1 / (1 + a * xs[i] ** (2 * b)) - ys[i];
      s += r * r;
    }
    return s;
  };
  let a = 1;
  let b = 1;
  let lambda = 1e-3;
  let current = cost(a, b);
  for (let it = 0; it < 500; it += 1) {
    let jaa = 0; let jab = 0; let jbb = 0; let ga = 0; let gb = 0;
    for (let i = 0; i < m; i += 1) {
      const x = xs[i];
      const x2b = x > 0 ? x ** (2 * b) : 0;
      const u = 1 + a * x2b;
      const f = 1 / u;
      const r = f - ys[i];
      const da = -x2b / (u * u);
      const db = x > 0 ? (-a * x2b * 2 * Math.log(x)) / (u * u) : 0;
      jaa += da * da; jab += da * db; jbb += db * db;
      ga += da * r; gb += db * r;
    }
    let improved = false;
    for (let tries = 0; tries < 30 && !improved; tries += 1) {
      const A = jaa * (1 + lambda);
      const B = jbb * (1 + lambda);
      const det = A * B - jab * jab;
      const sa = (-ga * B + gb * jab) / det;
      const sb = (-gb * A + ga * jab) / det;
      const next = cost(a + sa, b + sb);
      if (Number.isFinite(next) && next < current) {
        const relative = (current - next) / current;
        a += sa;
        b += sb;
        current = next;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        if (relative < 1e-14) return { a, b };
      } else {
        lambda *= 10;
      }
    }
    if (!improved) break;
  }
  return { a, b };
}

// --- Spectral initialisation --------------------------------------------------------------------

function orthonormalize(X, n, p, v0) {
  for (let pass = 0; pass < 2; pass += 1) {
    for (let a = 0; a < p; a += 1) {
      if (v0) {
        let dot = 0;
        for (let i = 0; i < n; i += 1) dot += X[i * p + a] * v0[i];
        for (let i = 0; i < n; i += 1) X[i * p + a] -= dot * v0[i];
      }
      for (let b = 0; b < a; b += 1) {
        let dot = 0;
        for (let i = 0; i < n; i += 1) dot += X[i * p + a] * X[i * p + b];
        for (let i = 0; i < n; i += 1) X[i * p + a] -= dot * X[i * p + b];
      }
      let norm = 0;
      for (let i = 0; i < n; i += 1) norm += X[i * p + a] * X[i * p + a];
      norm = Math.sqrt(norm);
      if (!(norm > 1e-300)) return false;
      for (let i = 0; i < n; i += 1) X[i * p + a] /= norm;
    }
  }
  return true;
}

// Y = M X for the n × p block X, M = D^{-1/2} W D^{-1/2} with normalised weights wn.
function blockMultiply(offsets, targets, wn, X, Y, n, p) {
  for (let i = 0; i < n; i += 1) {
    const yb = i * p;
    for (let a = 0; a < p; a += 1) Y[yb + a] = 0;
    for (let e = offsets[i]; e < offsets[i + 1]; e += 1) {
      const w = wn[e];
      const xb = targets[e] * p;
      for (let a = 0; a < p; a += 1) Y[yb + a] += w * X[xb + a];
    }
  }
}

// Rayleigh–Ritz on span(X): rotates X and MX to the Ritz vectors (descending Ritz values).
function rayleighRitz(X, MX, n, p) {
  const H = new Float64Array(p * p);
  for (let a = 0; a < p; a += 1) {
    for (let b = a; b < p; b += 1) {
      let s = 0;
      for (let i = 0; i < n; i += 1) s += X[i * p + a] * MX[i * p + b];
      H[a * p + b] = s;
      H[b * p + a] = s;
    }
  }
  const { values, vectors } = symmetricEigen(H, p);
  const rowX = new Float64Array(p);
  const rowM = new Float64Array(p);
  for (let i = 0; i < n; i += 1) {
    for (let c = 0; c < p; c += 1) {
      let sx = 0;
      let sm = 0;
      for (let a = 0; a < p; a += 1) {
        sx += X[i * p + a] * vectors[a * p + c];
        sm += MX[i * p + a] * vectors[a * p + c];
      }
      rowX[c] = sx;
      rowM[c] = sm;
    }
    for (let c = 0; c < p; c += 1) {
      X[i * p + c] = rowX[c];
      MX[i * p + c] = rowM[c];
    }
  }
  return values;
}

// The nComponents eigenvectors of the normalised Laplacian L = I − D^{-1/2} W D^{-1/2} with the
// smallest non-zero eigenvalues (Belkin & Niyogi 2003), as umap-learn's spectral_layout. Uses
// Chebyshev-filtered subspace iteration on M = I − L with a few guard vectors, deflating the
// trivial eigenvector D^{1/2}1. Returns null for a disconnected graph (umap-learn then lays out
// components separately; callers here fall back to PCA). Result: { embedding: Float64Array
// (n × nComponents), eigenvalues (of L), converged, iterations }.
export function spectralEmbedding(graph, nComponents = 2, options = {}) {
  const { seed = DEFAULT_SEED, maxIterations = 40, degree = 10, tolerance = 1e-4, guardVectors = 4, signal } = options;
  const n = graph.n ?? graph.offsets.length - 1;
  if (n < nComponents + 2) return null;
  if (connectedComponents(graph).count > 1) return null;
  const { offsets, targets, weights } = graph;
  const degreeOf = new Float64Array(n);
  for (let i = 0; i < n; i += 1) for (let e = offsets[i]; e < offsets[i + 1]; e += 1) degreeOf[i] += weights[e];
  const s = new Float64Array(n);
  const v0 = new Float64Array(n);
  let norm = 0;
  for (let i = 0; i < n; i += 1) {
    if (!(degreeOf[i] > 0)) return null;
    s[i] = 1 / Math.sqrt(degreeOf[i]);
    v0[i] = Math.sqrt(degreeOf[i]);
    norm += degreeOf[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < n; i += 1) v0[i] /= norm;
  const wn = new Float64Array(targets.length);
  for (let i = 0; i < n; i += 1) for (let e = offsets[i]; e < offsets[i + 1]; e += 1) wn[e] = s[i] * weights[e] * s[targets[e]];
  const p = Math.min(nComponents + guardVectors, n - 1);
  const random = createRandom(seed);
  let X = new Float64Array(n * p);
  for (let i = 0; i < n * p; i += 1) X[i] = random.gaussian();
  if (!orthonormalize(X, n, p, v0)) return null;
  let MX = new Float64Array(n * p);
  let T0 = new Float64Array(n * p);
  let T1 = new Float64Array(n * p);
  blockMultiply(offsets, targets, wn, X, MX, n, p);
  let ritz = rayleighRitz(X, MX, n, p);
  let converged = false;
  let iterations = 0;
  const residualOf = () => {
    let worst = 0;
    for (let c = 0; c < nComponents; c += 1) {
      let r = 0;
      for (let i = 0; i < n; i += 1) {
        const d = MX[i * p + c] - ritz[c] * X[i * p + c];
        r += d * d;
      }
      worst = Math.max(worst, Math.sqrt(r));
    }
    return worst;
  };
  for (let it = 0; it < maxIterations; it += 1) {
    throwIfAborted(signal);
    iterations = it + 1;
    if (residualOf() < tolerance) {
      converged = true;
      break;
    }
    // Chebyshev filter of the given degree damping [−1, cut], cut = lowest Ritz value in the block.
    const lo = -1;
    const hi = Math.max(ritz[p - 1], -0.9);
    const e = (hi - lo) / 2;
    const c = (hi + lo) / 2;
    // T0 = X, T1 = (M X − c X)/e (MX holds M X).
    T0.set(X);
    for (let i = 0; i < n * p; i += 1) T1[i] = (MX[i] - c * X[i]) / e;
    for (let d = 2; d <= degree; d += 1) {
      blockMultiply(offsets, targets, wn, T1, MX, n, p);
      for (let i = 0; i < n * p; i += 1) {
        const t2 = (2 * (MX[i] - c * T1[i])) / e - T0[i];
        T0[i] = T1[i];
        T1[i] = t2;
      }
    }
    const filtered = T1;
    T1 = X;
    X = filtered;
    if (!orthonormalize(X, n, p, v0)) return null;
    blockMultiply(offsets, targets, wn, X, MX, n, p);
    ritz = rayleighRitz(X, MX, n, p);
  }
  if (!converged && residualOf() < tolerance) converged = true;
  const embedding = new Float64Array(n * nComponents);
  for (let i = 0; i < n; i += 1) for (let c = 0; c < nComponents; c += 1) embedding[i * nComponents + c] = X[i * p + c];
  for (let i = 0; i < n * nComponents; i += 1) if (!Number.isFinite(embedding[i])) return null;
  const eigenvalues = Float64Array.from(ritz.slice(0, nComponents), (mu) => 1 - mu);
  return { embedding, eigenvalues, converged, iterations };
}

// --- UMAP: layout optimisation ---------------------------------------------------------------------

function clip4(v) {
  return v > 4 ? 4 : v < -4 ? -4 : v;
}

// umap-learn's make_epochs_per_sample: an edge of weight w is sampled every w_max / w epochs.
function epochsPerSample(weights, nEpochs) {
  let max = 0;
  for (let e = 0; e < weights.length; e += 1) if (weights[e] > max) max = weights[e];
  const out = new Float64Array(weights.length).fill(-1);
  for (let e = 0; e < weights.length; e += 1) {
    const samples = nEpochs * (weights[e] / max);
    if (samples > 0) out[e] = nEpochs / samples;
  }
  return out;
}

// umap-learn's optimize_layout_euclidean (one thread): for each epoch, edges due for sampling
// pull their endpoints together with the gradient of log(1/(1 + a d^{2b})) and push the head away
// from negativeSampleRate random vertices; gradients are clipped to ±4 and the learning rate
// decays linearly to 0. Negative samples use a xorshift32 stream seeded from `random` (umap-learn
// likewise uses a cheap Tausworthe generator there); d^{2b} is computed as exp(b·ln d²).
function optimizeLayout(head, tail, eps, headEmb, tailEmb, nVertices, nc, params, random, onProgress, signal) {
  const { a, b, gamma, initialAlpha, negativeSampleRate, nEpochs, moveOther } = params;
  const nEdges = head.length;
  const nextSample = Float64Array.from(eps);
  const epsNeg = new Float64Array(nEdges);
  for (let e = 0; e < nEdges; e += 1) epsNeg[e] = eps[e] / negativeSampleRate;
  const nextNeg = Float64Array.from(epsNeg);
  const delta = new Float64Array(nc);
  const twoAB = 2 * a * b;
  const twoGB = 2 * gamma * b;
  let state = random.uint32() || 0x9e3779b9;
  for (let epoch = 0; epoch < nEpochs; epoch += 1) {
    throwIfAborted(signal);
    const alpha = initialAlpha * (1 - epoch / nEpochs);
    for (let e = 0; e < nEdges; e += 1) {
      if (eps[e] <= 0 || nextSample[e] > epoch) continue;
      const cj = head[e] * nc;
      const ck = tail[e] * nc;
      const nNeg = Math.trunc((epoch - nextNeg[e]) / epsNeg[e]);
      if (nc === 2) {
        let hx = headEmb[cj];
        let hy = headEmb[cj + 1];
        const dx = hx - tailEmb[ck];
        const dy = hy - tailEmb[ck + 1];
        const d2 = dx * dx + dy * dy;
        if (d2 > 0) {
          const pb = Math.exp(b * Math.log(d2));
          const coeff = (-twoAB * (pb / d2)) / (a * pb + 1);
          let gx = coeff * dx;
          let gy = coeff * dy;
          gx = (gx > 4 ? 4 : gx < -4 ? -4 : gx) * alpha;
          gy = (gy > 4 ? 4 : gy < -4 ? -4 : gy) * alpha;
          hx += gx;
          hy += gy;
          if (moveOther) {
            tailEmb[ck] -= gx;
            tailEmb[ck + 1] -= gy;
          }
        }
        // The negative samples of one edge are evaluated at the same head position and their
        // (individually clipped) steps summed: umap-learn applies them one after another, but
        // with ≤ 5 small steps the difference is negligible, and independent evaluations avoid
        // a serial chain of exp/log latencies (about 3× faster here).
        let sx = 0;
        let sy = 0;
        for (let s = 0; s < nNeg; s += 1) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          const co = ((state & 0x7fffffff) % nVertices) * 2;
          const nx = hx - tailEmb[co];
          const ny = hy - tailEmb[co + 1];
          const nd2 = nx * nx + ny * ny;
          // Coincident with the sample (or the sample is the point itself): no repulsion, as
          // umap-learn 0.5 (grad_coeff = 0).
          if (nd2 > 0) {
            const coeff = twoGB / ((0.001 + nd2) * (a * Math.exp(b * Math.log(nd2)) + 1));
            const gx = coeff * nx;
            const gy = coeff * ny;
            sx += gx > 4 ? 4 : gx < -4 ? -4 : gx;
            sy += gy > 4 ? 4 : gy < -4 ? -4 : gy;
          }
        }
        headEmb[cj] = hx + sx * alpha;
        headEmb[cj + 1] = hy + sy * alpha;
      } else {
        let d2 = 0;
        for (let d = 0; d < nc; d += 1) {
          delta[d] = headEmb[cj + d] - tailEmb[ck + d];
          d2 += delta[d] * delta[d];
        }
        if (d2 > 0) {
          const pb = Math.exp(b * Math.log(d2));
          const coeff = (-twoAB * (pb / d2)) / (a * pb + 1);
          for (let d = 0; d < nc; d += 1) {
            const g = clip4(coeff * delta[d]) * alpha;
            headEmb[cj + d] += g;
            if (moveOther) tailEmb[ck + d] -= g;
          }
        }
        for (let s = 0; s < nNeg; s += 1) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          const co = ((state & 0x7fffffff) % nVertices) * nc;
          let nd2 = 0;
          for (let d = 0; d < nc; d += 1) {
            delta[d] = headEmb[cj + d] - tailEmb[co + d];
            nd2 += delta[d] * delta[d];
          }
          if (nd2 > 0) {
            const coeff = twoGB / ((0.001 + nd2) * (a * Math.exp(b * Math.log(nd2)) + 1));
            for (let d = 0; d < nc; d += 1) headEmb[cj + d] += clip4(coeff * delta[d]) * alpha;
          }
        }
      }
      nextSample[e] += eps[e];
      if (nNeg > 0) nextNeg[e] += nNeg * epsNeg[e];
    }
    if (onProgress && (epoch % 5 === 0 || epoch === nEpochs - 1)) onProgress((epoch + 1) / nEpochs, `UMAP epoch ${epoch + 1}/${nEpochs}`);
  }
}

// umap-learn's noisy_scale_coords followed by the rescale of every axis to [0, 10].
function scaleInitialLayout(init, n, nc, random, noise) {
  let maxAbs = 0;
  for (let i = 0; i < n * nc; i += 1) maxAbs = Math.max(maxAbs, Math.abs(init[i]));
  const expansion = maxAbs > 0 ? 10 / maxAbs : 1;
  const out = new Float64Array(n * nc);
  for (let i = 0; i < n * nc; i += 1) out[i] = init[i] * expansion + (noise ? random.gaussian() * noise : 0);
  for (let d = 0; d < nc; d += 1) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i += 1) {
      lo = Math.min(lo, out[i * nc + d]);
      hi = Math.max(hi, out[i * nc + d]);
    }
    const span = hi - lo || 1;
    for (let i = 0; i < n; i += 1) out[i * nc + d] = (10 * (out[i * nc + d] - lo)) / span;
  }
  return out;
}

// UMAP. Options (umap-learn defaults): nNeighbors 15, nComponents 2, minDist 0.1, spread 1,
// metric 'euclidean', nEpochs (500 if n ≤ 10 000 else 200), learningRate 1, negativeSampleRate 5,
// repulsionStrength 1, localConnectivity 1, setOpMixRatio 1, init 'spectral' | 'pca' | 'random' |
// Float32Array, a/b (fitted from minDist and spread when absent), seed, onProgress, signal.
// Returns { embedding, model, init (what was used), nEpochs, a, b, graph }; `model` feeds
// transformUmap.
export function umap(data, n, dim, options = {}) {
  const {
    nComponents = 2,
    minDist = 0.1,
    spread = 1,
    metric = 'euclidean',
    learningRate = 1,
    negativeSampleRate = 5,
    repulsionStrength = 1,
    localConnectivity = 1,
    setOpMixRatio = 1,
    init = 'spectral',
    seed = DEFAULT_SEED,
    onProgress,
    signal,
  } = options;
  checkMatrix(data, n, dim, 4);
  const nNeighbors = Math.max(2, Math.min(options.nNeighbors ?? 15, n - 1));
  const nEpochs = options.nEpochs ?? (n <= 10000 ? 500 : 200);
  const { a, b } = options.a !== undefined && options.b !== undefined ? { a: options.a, b: options.b } : findAbParams(spread, minDist);
  const random = createRandom(seed);

  // 1. Neighbours: umap-learn's n_neighbors counts the point itself.
  const index = options.index ?? createKnnIndex(data, n, dim, nNeighbors - 1, {
    metric, seed, onProgress: progressRange(onProgress, 0, 0.3), signal,
  });
  throwIfAborted(signal);
  if (onProgress) onProgress(0.3, 'UMAP: fuzzy simplicial set');
  const graph = fuzzySimplicialSet(index, n, { localConnectivity, setOpMixRatio });

  // 2. Drop edges too weak to be sampled even once (umap-learn simplicial_set_embedding).
  let wmax = 0;
  for (let e = 0; e < graph.weights.length; e += 1) wmax = Math.max(wmax, graph.weights[e]);
  const threshold = wmax / (nEpochs > 10 ? nEpochs : n <= 10000 ? 500 : 200);
  const pruned = pruneGraph(graph, threshold);

  // 3. Initial layout.
  if (onProgress) onProgress(0.32, 'UMAP: initial layout');
  let initial;
  let initUsed = typeof init === 'string' ? init : 'custom';
  if (init === 'spectral') {
    const spectral = spectralEmbedding(pruned, nComponents, { seed, signal });
    if (spectral) {
      initial = scaleInitialLayout(spectral.embedding, n, nComponents, random, 1e-4);
      if (!spectral.converged) initUsed = 'spectral (approximate)';
    } else {
      initUsed = 'pca (no spectral layout: the neighbour graph is disconnected or too small)';
    }
  }
  if (!initial) {
    if (init === 'random') {
      const r = new Float64Array(n * nComponents);
      for (let i = 0; i < r.length; i += 1) r[i] = random() * 20 - 10;
      initial = scaleInitialLayout(r, n, nComponents, random, 0);
    } else if (init === 'pca' || init === 'spectral') {
      const scores = pca(data, n, dim, { components: nComponents }).scores;
      initial = scaleInitialLayout(scores, n, nComponents, random, 1e-4);
    } else if (init && init.length === n * nComponents) {
      initial = scaleInitialLayout(init, n, nComponents, random, 0);
    } else {
      throw new Error("UMAP init must be 'spectral', 'pca', 'random' or an n × nComponents array.");
    }
  }

  // 4. Stochastic gradient descent on the fuzzy cross-entropy.
  const edges = csrToEdges(pruned);
  const eps = epochsPerSample(edges.weights, nEpochs);
  optimizeLayout(edges.head, edges.tail, eps, initial, initial, n, nComponents, {
    a, b, gamma: repulsionStrength, initialAlpha: learningRate, negativeSampleRate, nEpochs, moveOther: true,
  }, random, progressRange(onProgress, 0.35, 1), signal);

  const embedding = Float32Array.from(initial);
  const model = {
    kind: 'umap', n, dim, nComponents, nNeighbors, metric, minDist, spread, a, b, nEpochs, learningRate,
    negativeSampleRate, repulsionStrength, localConnectivity, seed, embedding, index,
    nEpochsOption: options.nEpochs ?? null,
  };
  return { embedding, model, init: initUsed, nEpochs, a, b, graph: pruned };
}

function pruneGraph(graph, threshold) {
  const { n, offsets, targets, weights } = graph;
  let nnz = 0;
  for (let e = 0; e < weights.length; e += 1) if (weights[e] >= threshold) nnz += 1;
  const o = new Int32Array(n + 1);
  const t = new Int32Array(nnz);
  const w = new Float32Array(nnz);
  let p = 0;
  for (let i = 0; i < n; i += 1) {
    o[i] = p;
    for (let e = offsets[i]; e < offsets[i + 1]; e += 1) {
      if (weights[e] >= threshold) {
        t[p] = targets[e];
        w[p++] = weights[e];
      }
    }
  }
  o[n] = p;
  return { n, offsets: o, targets: t, weights: w };
}

function csrToEdges(graph) {
  const { n, offsets, targets, weights } = graph;
  const head = new Int32Array(targets.length);
  for (let i = 0; i < n; i += 1) for (let e = offsets[i]; e < offsets[i + 1]; e += 1) head[e] = i;
  return { head, tail: targets, weights };
}

// Places m new events (newData: Float32Array m × dim, same channels and transforms as the model's
// data) into an existing UMAP embedding without moving it, as umap-learn's transform: kNN against
// the reference, membership weights with local connectivity − 1, a weighted-average start, then
// n_epochs/3 epochs (100 for m ≤ 10 000, else 30, by default) of optimisation at a quarter of the
// learning rate with the reference fixed.
export function transformUmap(model, newData, m, options = {}) {
  const { seed = model.seed ?? DEFAULT_SEED, onProgress, signal } = options;
  if (!model || model.kind !== 'umap') throw new Error('transformUmap needs the model returned by umap().');
  const { n, nComponents: nc, nNeighbors, a, b } = model;
  checkMatrix(newData, m, model.dim, 1);
  const k = Math.min(nNeighbors, n);
  const neighbours = queryKnn(model.index, newData, m, k, { seed, onProgress: progressRange(onProgress, 0, 0.3), signal });
  const { sigmas, rhos } = smoothKnnDist(neighbours.distances, m, k, { localConnectivity: Math.max(0, model.localConnectivity - 1) });
  const values = membershipStrengths(neighbours.indices, neighbours.distances, m, k, sigmas, rhos, true);
  const ref = Float64Array.from(model.embedding);
  // Weighted average of the neighbours' positions; an exact match (weight 1 at distance 0) wins.
  const emb = new Float64Array(m * nc);
  for (let i = 0; i < m; i += 1) {
    let rowSum = 0;
    for (let t = 0; t < k; t += 1) rowSum += values[i * k + t];
    if (!(rowSum > 0)) {
      for (let d = 0; d < nc; d += 1) emb[i * nc + d] = ref[neighbours.indices[i * k] * nc + d];
      continue;
    }
    for (let t = 0; t < k; t += 1) {
      const w = values[i * k + t];
      const j = neighbours.indices[i * k + t];
      if (w === 1 && neighbours.distances[i * k + t] === 0) {
        for (let d = 0; d < nc; d += 1) emb[i * nc + d] = ref[j * nc + d];
        break;
      }
      for (let d = 0; d < nc; d += 1) emb[i * nc + d] += (w / rowSum) * ref[j * nc + d];
    }
  }
  const nEpochs = options.nEpochs ?? (model.nEpochsOption ? Math.floor(model.nEpochsOption / 3) : m <= 10000 ? 100 : 30);
  let wmax = 0;
  for (let e = 0; e < values.length; e += 1) wmax = Math.max(wmax, values[e]);
  const threshold = wmax / nEpochs;
  let count = 0;
  for (let e = 0; e < values.length; e += 1) if (values[e] >= threshold && values[e] > 0) count += 1;
  const head = new Int32Array(count);
  const tail = new Int32Array(count);
  const w = new Float64Array(count);
  let p = 0;
  for (let i = 0; i < m; i += 1) {
    for (let t = 0; t < k; t += 1) {
      const v = values[i * k + t];
      if (v >= threshold && v > 0) {
        head[p] = i;
        tail[p] = neighbours.indices[i * k + t];
        w[p++] = v;
      }
    }
  }
  if (nEpochs > 0 && count > 0) {
    const random = createRandom(seed ^ 0x2545f491);
    optimizeLayout(head, tail, epochsPerSample(w, nEpochs), emb, ref, n, nc, {
      a, b, gamma: model.repulsionStrength, initialAlpha: model.learningRate / 4, negativeSampleRate: model.negativeSampleRate,
      nEpochs, moveOther: false,
    }, random, progressRange(onProgress, 0.3, 1), signal);
  }
  return { embedding: Float32Array.from(emb), nEpochs };
}
