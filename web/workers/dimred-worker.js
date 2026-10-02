// Runs dimension reduction (PCA, t-SNE, UMAP), graph clustering (Louvain, Leiden, PhenoGraph) and
// embedding diagnostics off the main thread.
//
// Protocol (see cytoweave-spec/conventions.md): the page posts { id, type, payload }; the worker
// replies { id, progress: [fraction, message] } zero or more times, then { id, result } or
// { id, error }. Typed arrays are transferred both ways; send `data` as a Float32Array (n × dim,
// row-major) and expect Float32Array / Int32Array results.
//
// Requests (payload fields; `options` are the library function's options):
//   knn              { data, n, dim, k, options }            → { indices, distances }
//   pca              { data, n, dim, options }               → pca() result
//   tsne             { data, n, dim, options }               → { embedding, kl, iterations, … }
//   umap             { data, n, dim, options, keepModel }    → { embedding, modelId, init, … }
//   transformUmap    { modelId, data, m, options }           → { embedding }
//   releaseModel     { modelId }                             → { released }
//   knnGraph         { indices, distances, n, k, options }   → CSR graph
//   louvain, leiden  { graph, options }                      → { labels, quality, communities, … }
//   phenograph       { data, n, dim, options }               → { labels, quality, communities, … }
//   assessEmbedding  { high, low, n, dimHigh, dimLow, options, modelId? } → summary
//   trustworthiness, knnPreservation, regionReliability  { high, low, n, dimHigh, dimLow, k?, options }
//   seedStability    { a, b, n, k, options }
//   mixingEntropy    { low, n, labels, k, options }
//   lisi             { low, n, labels, options }
//
// The UMAP model (reference data, embedding and neighbour index) stays in this worker under its
// modelId so new samples can be projected without sending the reference again; a modelId is lost
// if the worker is terminated (WorkerClient.cancel does that). Long loops check `signal.aborted`:
// pass payload.abortBuffer (a SharedArrayBuffer whose first Int32 the page sets to 1) when the
// page is cross-origin isolated; otherwise cancel by terminating the worker.

import { knn } from '../lib/knn.js';
import { pca, transformUmap, tsne, umap } from '../lib/dimred.js';
import { knnGraph, leiden, louvain, phenograph } from '../lib/graph-cluster.js';
import {
  assessEmbedding, knnPreservation, lisi, mixingEntropy, regionReliability, seedStability, trustworthiness,
} from '../lib/embedding-quality.js';

const MAX_MODELS = 4;
const models = new Map();
let nextModelId = 1;

function float32(value, name) {
  if (value instanceof Float32Array) return value;
  if (value instanceof ArrayBuffer) return new Float32Array(value);
  if (ArrayBuffer.isView(value) || Array.isArray(value)) return Float32Array.from(value);
  throw new Error(`Missing ${name}.`);
}

function makeSignal(payload) {
  if (typeof SharedArrayBuffer !== 'undefined' && payload?.abortBuffer instanceof SharedArrayBuffer) {
    const flag = new Int32Array(payload.abortBuffer);
    return { get aborted() { return Atomics.load(flag, 0) !== 0; } };
  }
  return { aborted: false };
}

// Progress messages at most every 100 ms (and always the final one).
function reporter(id) {
  let last = 0;
  return (fraction, message) => {
    const now = Date.now();
    if (fraction < 1 && now - last < 100) return;
    last = now;
    self.postMessage({ id, progress: [fraction, message] });
  };
}

// Buffers of every typed array reachable in `value` (objects and arrays, a few levels deep).
function transferables(value, out = new Set(), depth = 0) {
  if (!value || depth > 4) return out;
  if (ArrayBuffer.isView(value)) {
    if (!(typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer)) out.add(value.buffer);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) transferables(item, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const key of Object.keys(value)) transferables(value[key], out, depth + 1);
  }
  return out;
}

function storeModel(model) {
  const modelId = `umap-${nextModelId++}`;
  models.set(modelId, model);
  while (models.size > MAX_MODELS) models.delete(models.keys().next().value);
  return modelId;
}

function getModel(modelId) {
  const model = models.get(modelId);
  if (!model) throw new Error('The UMAP model is no longer in memory; run UMAP again before adding samples.');
  return model;
}

const handlers = {
  knn(p, o) {
    return knn(float32(p.data, 'data'), p.n, p.dim, p.k, o);
  },
  pca(p, o) {
    return pca(float32(p.data, 'data'), p.n, p.dim, o);
  },
  tsne(p, o) {
    return tsne(float32(p.data, 'data'), p.n, p.dim, o);
  },
  umap(p, o) {
    const result = umap(float32(p.data, 'data'), p.n, p.dim, o);
    const modelId = p.keepModel === false ? null : storeModel(result.model);
    // The model keeps its own embedding; the page gets a copy it can own.
    return { embedding: result.embedding.slice(), modelId, init: result.init, nEpochs: result.nEpochs, a: result.a, b: result.b };
  },
  transformUmap(p, o) {
    return transformUmap(getModel(p.modelId), float32(p.data, 'data'), p.m, o);
  },
  releaseModel(p) {
    return { released: models.delete(p.modelId) };
  },
  knnGraph(p, o) {
    return knnGraph({ indices: p.indices, distances: p.distances }, p.n, p.k, o);
  },
  louvain(p, o) {
    return louvain(p.graph, o);
  },
  leiden(p, o) {
    return leiden(p.graph, o);
  },
  phenograph(p, o) {
    const { graph, ...rest } = phenograph(float32(p.data, 'data'), p.n, p.dim, o);
    return o.returnGraph ? { ...rest, graph } : rest;
  },
  assessEmbedding(p, o) {
    const options = { ...o };
    if (p.modelId && !options.highKnn) {
      // Reuse the UMAP neighbour table of the same events.
      const model = getModel(p.modelId);
      if (model.n === p.n) options.highKnn = { indices: model.index.indices, distances: model.index.distances };
    }
    if (p.other) options.other = float32(p.other, 'second embedding');
    return assessEmbedding(float32(p.high, 'original data'), float32(p.low, 'embedding'), p.n, p.dimHigh, p.dimLow, options);
  },
  trustworthiness(p, o) {
    return trustworthiness(float32(p.high, 'original data'), float32(p.low, 'embedding'), p.n, p.dimHigh, p.dimLow, p.k ?? 15, o);
  },
  knnPreservation(p, o) {
    return knnPreservation(float32(p.high, 'original data'), float32(p.low, 'embedding'), p.n, p.dimHigh, p.dimLow, p.k ?? 15, o);
  },
  regionReliability(p, o) {
    return regionReliability(float32(p.high, 'original data'), float32(p.low, 'embedding'), p.n, p.dimHigh, p.dimLow, o);
  },
  seedStability(p, o) {
    return seedStability(float32(p.a, 'first embedding'), float32(p.b, 'second embedding'), p.n, p.k ?? 15, o);
  },
  mixingEntropy(p, o) {
    return mixingEntropy(float32(p.low, 'embedding'), p.n, p.labels, p.k ?? 30, o);
  },
  lisi(p, o) {
    return lisi(float32(p.low, 'embedding'), p.n, p.labels, o);
  },
};

self.onmessage = (event) => {
  const { id, type, payload = {} } = event.data ?? {};
  try {
    const handler = handlers[type];
    if (!handler) throw new Error(`Unknown request ${type}`);
    const options = { ...(payload.options ?? {}), onProgress: reporter(id), signal: makeSignal(payload) };
    const result = handler(payload, options);
    // Neighbour tables shared with a stored model must not be transferred (they would detach).
    const keep = new Set();
    for (const model of models.values()) {
      for (const array of [model.data, model.embedding, model.index?.data, model.index?.indices, model.index?.distances]) {
        if (array?.buffer) keep.add(array.buffer);
      }
    }
    const transfer = [...transferables(result)].filter((buffer) => !keep.has(buffer));
    self.postMessage({ id, result }, transfer);
  } catch (error) {
    self.postMessage({ id, error: error?.message ?? String(error) });
  }
};
