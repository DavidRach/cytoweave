// Clustering and embedding without the Explore view: the events of a population across samples
// are clustered (FlowSOM, Leiden or Louvain, k-means; every event gets a cluster) and embedded
// (UMAP, t-SNE or PCA, on an equal subsample per sample), with the embedding's honesty report and
// a cluster summary. The Explore view (mode-explore.js) and agents (remote.js) both run it.

import { channelTransform, countOf, population } from '../lib/engine.js';
import { ROOT, channelLabel, gatePath } from '../lib/workspace.js';
import { assignNearest, centroids, clusterName, gatherMatrix, pickEvents, samplingPlan } from '../lib/explore.js';
import { newId } from '../lib/gates.js';
import { categoricalColor } from '../lib/colormaps.js';

export const EMBEDDINGS = [
  { id: 'umap', label: 'UMAP', axis: 'UMAP' },
  { id: 'tsne', label: 't-SNE', axis: 't-SNE' },
  { id: 'pca', label: 'PCA', axis: 'PC' },
  { id: 'none', label: 'None', axis: '' },
];
export const CLUSTERINGS = [
  { id: 'flowsom', label: 'FlowSOM', channel: 'FlowSOM cluster' },
  { id: 'phenograph', label: 'Leiden (PhenoGraph)', short: 'Leiden', channel: 'Leiden cluster' },
  { id: 'louvain', label: 'Louvain', channel: 'Louvain cluster' },
  { id: 'kmeans', label: 'k-means', channel: 'k-means cluster' },
  { id: 'none', label: 'None', channel: '' },
];

export const DEFAULT_SETTINGS = { populationId: null, scope: 'all', perSample: 5000, maxTotal: 100000, markers: null, embedding: 'umap', nNeighbors: 15, minDist: 0.1, perplexity: 30, clustering: 'flowsom', k: 12, xdim: 10, ydim: 10, leidenK: 30, resolution: 1, seed: 42 };

export const shortLabel = (ws, channel) => channelLabel(ws, channel, { short: true }).replace(' (unmixed)', '');

// Runs a clustering and/or an embedding. settings: as DEFAULT_SETTINGS, with markers an array of
// channels; samples: sample records; popId: the population (ROOT for all events). options:
// onProgress(fraction, message), track(job) (each worker job, to cancel). Returns { result (a
// derived result for saveDerived, with perSample), run (what the view displays) } without changing
// the workspace.
export async function runExplore(app, { settings, samples, popId }, options = {}) {
  const { onProgress, track = (job) => job } = options;
  const { store, data } = app;
  const ws = store.ws;
  if (!samples.length) throw new Error('No samples to analyze.');
  if (settings.markers.length < 2) throw new Error('Choose at least two markers.');
  if (settings.embedding === 'none' && settings.clustering === 'none') throw new Error('Choose a clustering, an embedding or both.');
  const progress = { update: (fraction, message) => onProgress?.(fraction, message) };
  const call = (worker, type, payload, transfer, from, to) => track(app.worker(worker).run(type, payload, { transfer, onProgress: (f, m) => progress.update(from + (to - from) * f, m) })).promise;
  const shortOf = (channel) => shortLabel(ws, channel);

  // 1. The population of every sample and the subsample to embed.
  const loaded = [];
  for (const [i, sample] of samples.entries()) {
    progress.update((0.15 * i) / samples.length, `Loading ${sample.name}`);
    const view = await data.ensure(sample.id);
    const indices = population(view, ws, popId);
    if (indices === undefined) continue;
    const missing = settings.markers.filter((m) => !view.hasChannel(m));
    if (missing.length) throw new Error(`${sample.name} lacks ${missing.join(', ')}.`);
    loaded.push({ sample, view, indices, count: countOf(indices, view) });
  }
  if (!loaded.length) throw new Error('The population applies to none of the samples.');
  const plan = samplingPlan(loaded.map((l) => l.count), settings.perSample, settings.maxTotal);
  const dim = settings.markers.length;
  const n = plan.reduce((a, b) => a + b, 0);
  const matrix = new Float32Array(n * dim);
  const sampleOf = new Int32Array(n);
  const scaledOf = (view) => settings.markers.map((m) => view.scaled(m, channelTransform(ws, view, m)));
  let offset = 0;
  for (const [i, item] of loaded.entries()) {
    item.picked = pickEvents(item.indices, item.view.eventCount, plan[i], settings.seed + i);
    item.offset = offset;
    gatherMatrix(scaledOf(item.view), item.picked, matrix, offset);
    sampleOf.fill(i, offset, offset + item.picked.length);
    offset += item.picked.length;
  }

  // 2. Clustering of every event (FlowSOM trained on the subsample, every event mapped; Leiden
  // on the subsample, other events assigned to the nearest cluster centroid).
  let labels = null;
  let k = 0;
  let fullLabels = null;
  let flowsomResult = null;
  // How events outside the subsample (and placed samples) get a cluster.
  let assign = null;
  if (settings.clustering === 'flowsom') {
    progress.update(0.18, 'FlowSOM: training the map');
    flowsomResult = await call('cluster', 'flowsom', { data: matrix.slice(), n, dim, options: { xdim: settings.xdim, ydim: settings.xdim, k: settings.k, seed: settings.seed } }, [], 0.18, 0.4);
    labels = Int32Array.from(flowsomResult.labels);
    k = flowsomResult.k;
    assign = { som: flowsomResult.som, metaclusters: flowsomResult.metaclusters, k };
    fullLabels = [];
    for (const [i, item] of loaded.entries()) {
      progress.update(0.4 + (0.1 * i) / loaded.length, `FlowSOM: mapping ${item.sample.name}`);
      const all = item.indices ?? Uint32Array.from({ length: item.view.eventCount }, (_, e) => e);
      const full = gatherMatrix(scaledOf(item.view), all);
      const mapped = await call('cluster', 'map', { som: flowsomResult.som, data: full, n: all.length }, [full.buffer], 0.4, 0.5);
      fullLabels.push({ all, labels: Int32Array.from(mapped.mapping, (node) => flowsomResult.metaclusters[node]) });
    }
  } else if (settings.clustering === 'phenograph' || settings.clustering === 'louvain' || settings.clustering === 'kmeans') {
    if (settings.clustering === 'kmeans') {
      progress.update(0.18, 'k-means clustering');
      const result = await call('cluster', 'kmeans', { data: matrix.slice(), n, dim, k: Math.min(settings.k, n), options: { seed: settings.seed } }, [], 0.18, 0.45);
      labels = Int32Array.from(result.labels);
      k = Math.min(settings.k, n);
    } else {
      const louvain = settings.clustering === 'louvain';
      progress.update(0.18, louvain ? 'Louvain clustering' : 'Leiden clustering');
      const result = await call('dimred', 'phenograph', { data: matrix.slice(), n, dim, options: { k: settings.leidenK, resolution: settings.resolution, seed: settings.seed, algorithm: louvain ? 'louvain' : 'leiden' } }, [], 0.18, 0.45);
      labels = Int32Array.from(result.labels);
      k = result.communities ?? (Math.max(...labels) + 1);
    }
    const centers = centroids(matrix, n, dim, labels, k);
    assign = { centers, k };
    fullLabels = loaded.map((item) => {
      const all = item.indices ?? Uint32Array.from({ length: item.view.eventCount }, (_, e) => e);
      return { all, labels: assignNearest(gatherMatrix(scaledOf(item.view), all), all.length, dim, centers, k) };
    });
    // The embedded events keep their own Leiden labels.
    for (const [i, item] of loaded.entries()) {
      const position = new Map();
      fullLabels[i].all.forEach((e, j) => position.set(e, j));
      item.picked.forEach((e, j) => { fullLabels[i].labels[position.get(e)] = labels[item.offset + j]; });
    }
  }

  // 3. Embedding of the subsample.
  let embedding = null;
  let modelId = null;
  if (settings.embedding === 'umap') {
    const result = await call('dimred', 'umap', { data: matrix.slice(), n, dim, options: { nNeighbors: settings.nNeighbors, minDist: settings.minDist, seed: settings.seed }, keepModel: true }, [], 0.5, 0.82);
    embedding = result.embedding;
    modelId = result.modelId;
  } else if (settings.embedding === 'tsne') {
    const result = await call('dimred', 'tsne', { data: matrix.slice(), n, dim, options: { perplexity: settings.perplexity, seed: settings.seed } }, [], 0.5, 0.82);
    embedding = result.embedding;
  } else if (settings.embedding === 'pca') {
    const result = await call('dimred', 'pca', { data: matrix.slice(), n, dim, options: { components: 2 } }, [], 0.5, 0.82);
    embedding = Float32Array.from(result.scores);
  }

  // 4. Honesty report.
  let quality = null;
  if (embedding) {
    quality = await call('dimred', 'assessEmbedding', { high: matrix.slice(), low: embedding.slice(), n, dimHigh: dim, dimLow: 2, modelId, options: { labels: loaded.length > 1 ? Int32Array.from(sampleOf) : null, seed: settings.seed } }, [], 0.82, 0.92);
  }

  // 5. Cluster summary (on the subsample) and abundance (on every event).
  let summary = null;
  if (labels) {
    progress.update(0.93, 'Summarizing clusters');
    summary = await call('cluster', 'summary', { data: matrix.slice(), n, dim, labels: Int32Array.from(labels), k, markers: settings.markers.map((m) => shortOf(m)), heatmap: { scale: 'quantile' } }, [], 0.93, 0.97);
  }
  const abundance = fullLabels ? fullLabels.map(({ labels: l }) => {
    const counts = new Float64Array(k);
    for (const c of l) if (c >= 0) counts[c] += 1;
    return Array.from(counts, (c) => (100 * c) / (l.length || 1));
  }) : null;

  // 6. The result as derived channels with the method and parameters.
  progress.update(0.97, 'Saving the result');
  const method = EMBEDDINGS.find((m) => m.id === settings.embedding);
  const clustering = CLUSTERINGS.find((m) => m.id === settings.clustering);
  const outputs = [];
  if (embedding) outputs.push(`${method.axis} 1`, `${method.axis} 2`, 'Embedded');
  if (fullLabels) outputs.push(clustering.channel);
  const perSample = new Map();
  for (const [i, item] of loaded.entries()) {
    const columns = {};
    if (embedding) {
      const x = new Float32Array(item.view.eventCount).fill(Number.NaN);
      const y = new Float32Array(item.view.eventCount).fill(Number.NaN);
      const embedded = new Float32Array(item.view.eventCount);
      item.picked.forEach((e, j) => {
        x[e] = embedding[(item.offset + j) * 2];
        y[e] = embedding[(item.offset + j) * 2 + 1];
        embedded[e] = 1;
      });
      columns[`${method.axis} 1`] = x;
      columns[`${method.axis} 2`] = y;
      columns.Embedded = embedded;
    }
    if (fullLabels) {
      const column = new Float32Array(item.view.eventCount).fill(-1);
      fullLabels[i].all.forEach((e, j) => { column[e] = fullLabels[i].labels[j]; });
      columns[clustering.channel] = column;
    }
    perSample.set(item.sample.id, columns);
  }
  const names = summary ? Array.from({ length: k }, (_, c) => clusterName(c, summary.annotation?.clusters?.[c]?.name, summary.mem?.labels?.[c])) : [];
  const label = [clustering.id !== 'none' ? clustering.label : null, method.id !== 'none' ? method.label : null].filter(Boolean);
  const result = {
    kind: settings.embedding !== 'none' ? settings.embedding : settings.clustering,
    name: label.join(' + '),
    method: label.join(' and '),
    params: { markers: settings.markers, populationId: popId, population: popId === ROOT ? 'All events' : gatePath(ws, popId), samples: loaded.map((l) => l.sample.name), events: n, nNeighbors: settings.nNeighbors, minDist: settings.minDist, perplexity: settings.perplexity, k, xdim: settings.xdim, ydim: settings.xdim, leidenK: settings.leidenK, resolution: settings.resolution, embedding: settings.embedding, clustering: settings.clustering },
    seed: settings.seed,
    outputs,
    perSample,
    summary: {
      quality: quality ? { trustworthiness: quality.trustworthiness, continuity: quality.continuity, knnPreservation: quality.knnPreservation, k: quality.k, batch: quality.batch, warnings: quality.warnings } : null,
      clusters: summary ? { k, names, mem: summary.mem?.labels ?? null, frequencies: Array.from(summary.summary.frequencies ?? []) } : null,
      abundance,
    },
  };
  return { result, run: { settings, loaded, matrix, n, dim, sampleOf, embedding, labels, k, summary, names, quality, abundance, method, clustering, popId, modelId, assign } };
}

// Category gates, one per cluster not yet a population, under the analyzed population.
export function clusterGates(ws, { popId, k, names, clustering, mem }) {
  const parentId = popId === ROOT ? null : popId;
  const existing = new Set(ws.gates.filter((g) => g.type === 'category' && g.dims[0]?.channel === clustering.channel && (g.parentId ?? null) === parentId).map((g) => g.geometry.values[0]));
  const gates = [];
  for (let c = 0; c < k; c += 1) {
    if (existing.has(c)) continue;
    gates.push({ id: newId('g'), parentId, name: names[c], type: 'category', dims: [{ channel: clustering.channel }], geometry: { values: [c] }, color: categoricalColor(c), meta: { origin: 'auto', method: clustering.label, note: `${clustering.label} cluster ${c + 1}${mem?.[c] ? `: ${mem[c]}` : ''}.` } });
  }
  return gates;
}
