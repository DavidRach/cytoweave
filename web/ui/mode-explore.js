// Explore: high-dimensional analysis. Cells of a population, across samples, are clustered
// (FlowSOM or Leiden/PhenoGraph, on every event of the population) and embedded (UMAP, t-SNE or
// PCA, on an equal subsample per sample). Every embedding comes with an honesty report: how well
// it keeps neighbourhoods, how it mixes samples, where it is unreliable. Clusters get a marker
// heatmap, enrichment labels and abundances, and become populations with one click.

import { h, icon, clear, formatCount, formatPercent, downloadBlob } from './dom.js';
import { showDialog, showMenu, toast, progressToast } from './overlays.js';
import { channelTransform, countOf, population } from '../lib/engine.js';
import { ROOT, addGates, channelLabel, gateById, gatePath } from '../lib/workspace.js';
import { newId } from '../lib/gates.js';
import { categoricalColor, colormapColor, colormapLUT } from '../lib/colormaps.js';
import { RELIABILITY_THRESHOLD } from '../lib/embedding-quality.js';
import { assignNearest, centroids, clusterName, embeddingRanges, embeddingRaster, gatherMatrix, markerCandidates, pickEvents, robustRange, samplingPlan } from '../lib/explore.js';

const EMBEDDINGS = [
  { id: 'umap', label: 'UMAP', axis: 'UMAP' },
  { id: 'tsne', label: 't-SNE', axis: 't-SNE' },
  { id: 'pca', label: 'PCA', axis: 'PC' },
  { id: 'none', label: 'None', axis: '' },
];
const CLUSTERINGS = [
  { id: 'flowsom', label: 'FlowSOM', channel: 'FlowSOM cluster' },
  { id: 'phenograph', label: 'Leiden (PhenoGraph)', channel: 'Leiden cluster' },
  { id: 'louvain', label: 'Louvain', channel: 'Louvain cluster' },
  { id: 'kmeans', label: 'k-means', channel: 'k-means cluster' },
  { id: 'none', label: 'None', channel: '' },
];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function mountExploreMode(app, container) {
  const { store, data } = app;
  const S = (store.state.ui.explore ??= {
    settings: { populationId: null, scope: 'all', perSample: 5000, maxTotal: 100000, markers: null, embedding: 'umap', nNeighbors: 15, minDist: 0.1, perplexity: 30, clustering: 'flowsom', k: 12, xdim: 10, ydim: 10, leidenK: 30, resolution: 1, seed: 42 },
    run: null,
    colorBy: 'cluster',
    highlight: null,
    hidden: new Set(),
    shade: false,
  });
  let running = null;
  let destroyed = false;

  const setupHost = h('div');
  const plotHost = h('div.pane.explore-plot-pane');
  const qualityHost = h('div.pane');
  const heatmapHost = h('div.pane');
  const abundanceHost = h('div.pane');
  const headActions = h('div.btn-row');
  const root = h('div.view',
    h('div.workbench-head', h('h1', icon('explore'), 'Explore'), h('span.muted', 'clustering and embeddings across samples'), h('span.spacer'), headActions),
    h('div.view-body', h('div.split.explore-split',
      h('div', setupHost),
      h('div', { style: { minWidth: 0 } },
        h('div.explore-top', plotHost, qualityHost),
        heatmapHost,
        abundanceHost))));
  container.append(root);

  // --- Setup --------------------------------------------------------------------------------------

  function populationId() {
    return S.settings.populationId ?? store.ui.gateId ?? ROOT;
  }

  function scopedSamples() {
    const ws = store.ws;
    if (S.settings.scope === 'current') return ws.samples.filter((s) => s.id === store.ui.sampleId);
    if (S.settings.scope.startsWith('group:')) {
      const group = ws.groups.find((g) => g.id === S.settings.scope.slice(6));
      return group ? ws.samples.filter((s) => group.sampleIds.includes(s.id)) : [];
    }
    return ws.samples.filter((s) => s.role === 'sample' || s.role === 'reference');
  }

  function renderSetup() {
    clear(setupHost);
    const ws = store.ws;
    const view = data.view(store.ui.sampleId) ?? data.view(scopedSamples()[0]?.id);
    const settings = S.settings;
    const field = (label, control, hint) => h('label.field', { title: hint ?? '' }, h('span', label), control);
    const number = (key, step, min, max) => {
      const input = h('input.input.small', { type: 'number', value: settings[key], step, min, max });
      input.addEventListener('change', () => { const v = Number.parseFloat(input.value); if (Number.isFinite(v)) settings[key] = v; });
      return input;
    };
    const popSelect = h('select.input.small', { onchange: (e) => { settings.populationId = e.target.value; renderSetup(); } },
      h('option', { value: ROOT, selected: populationId() === ROOT }, 'All events'),
      ...ws.gates.filter((g) => !g.meta?.helper).map((g) => h('option', { value: g.id, selected: g.id === populationId() }, gatePath(ws, g.id))));
    const scopeSelect = h('select.input.small', { onchange: (e) => { settings.scope = e.target.value; renderSetup(); } },
      h('option', { value: 'all', selected: settings.scope === 'all' }, 'All samples (not controls)'),
      h('option', { value: 'current', selected: settings.scope === 'current' }, 'The current sample'),
      ...ws.groups.map((g) => h('option', { value: `group:${g.id}`, selected: settings.scope === `group:${g.id}` }, `Group: ${g.name}`)));
    const samples = scopedSamples();
    const markersBox = h('div.explore-markers');
    if (!view) {
      markersBox.append(h('p.muted', 'Select a sample to list its markers.'));
    } else {
      const candidates = markerCandidates(view);
      if (!settings.markers) settings.markers = new Set(candidates.filter((c) => c.selected).map((c) => c.name));
      for (const c of candidates) {
        markersBox.append(h('label.check', h('input', { type: 'checkbox', checked: settings.markers.has(c.name), onchange: (e) => { if (e.target.checked) settings.markers.add(c.name); else settings.markers.delete(c.name); countLabel.textContent = `${settings.markers.size} selected`; } }), c.label));
      }
    }
    const countLabel = h('span.muted', `${settings.markers?.size ?? 0} selected`);
    const embeddingSeg = h('div.segmented', ...EMBEDDINGS.map((m) => h(`button${settings.embedding === m.id ? '.active' : ''}`, { type: 'button', onclick: () => { settings.embedding = m.id; renderSetup(); } }, m.label)));
    const clusterSeg = h('div.segmented', ...CLUSTERINGS.map((m) => h(`button${settings.clustering === m.id ? '.active' : ''}`, { type: 'button', onclick: () => { settings.clustering = m.id; renderSetup(); } }, m.label)));
    const embeddingParams = settings.embedding === 'umap'
      ? h('div.row', field('Neighbours', number('nNeighbors', 1, 2, 200), 'UMAP n_neighbors (default 15): larger values favor global structure.'), field('Minimum distance', number('minDist', 0.05, 0, 1), 'UMAP min_dist (default 0.1): how tightly points pack.'))
      : settings.embedding === 'tsne' ? h('div.row', field('Perplexity', number('perplexity', 5, 5, 200), 'Effective number of neighbours (default 30). The learning rate follows opt-SNE (n/12).')) : null;
    const clusterParams = settings.clustering === 'flowsom'
      ? h('div.row', field('Metaclusters', number('k', 1, 2, 60), 'Number of metaclusters by consensus clustering of the SOM nodes.'), field('Grid', number('xdim', 1, 3, 30), 'Self-organizing map of grid × grid nodes (default 10 × 10).'))
      : settings.clustering === 'phenograph' || settings.clustering === 'louvain' ? h('div.row', field('Neighbours', number('leidenK', 1, 5, 200), 'k of the nearest-neighbour graph (PhenoGraph default 30).'), field('Resolution', number('resolution', 0.1, 0.05, 5), `${settings.clustering === 'louvain' ? 'Louvain' : 'Leiden'} resolution: higher gives more, smaller clusters.`))
        : settings.clustering === 'kmeans' ? h('div.row', field('Clusters', number('k', 1, 2, 100), 'k-means makes exactly this many clusters (k-means++ seeding). Clusters are trained on the embedded subsample; every other event goes to the nearest centre.')) : null;
    const total = samplingPlan(samples.map((s) => s.eventCount), settings.perSample, settings.maxTotal).reduce((a, b) => a + b, 0);
    setupHost.append(
      h('div.pane',
        h('h3', icon('target'), 'Cells'),
        field('Population', popSelect, 'The analysis uses the events of this population.'),
        field('Samples', scopeSelect),
        h('div.row', field('Events per sample (embedding)', number('perSample', 500, 200, 200000)), field('Seed', number('seed', 1, 0, 1e9), 'Random seed: the same seed gives the same result.')),
        h('p.muted', { style: { margin: '2px 0 0', fontSize: '11.5px' } }, `${samples.length} sample(s); about ${formatCount(total)} events are embedded (equal numbers per sample, so no sample dominates). Clustering uses every event of the population.`)),
      h('div.pane',
        h('h3', icon('tag'), 'Markers', h('span.spacer'), countLabel,
          h('button.btn.small.ghost', { type: 'button', onclick: () => { settings.markers = null; renderSetup(); } }, 'Reset')),
        h('p.muted', { style: { margin: '0 0 6px', fontSize: '11.5px' } }, 'Cluster on lineage and phenotype markers. Viability, DNA, dump and bead channels are left out by default. Values use each channel\'s scale (logicle, arcsinh) as in the plots.'),
        markersBox),
      h('div.pane',
        h('h3', icon('sparkles'), 'Methods'),
        h('div.field-label', 'Clustering'), clusterSeg, clusterParams,
        h('div.field-label', { style: { marginTop: '10px' } }, 'Embedding'), embeddingSeg, embeddingParams,
        h('button.btn.primary.block', { type: 'button', style: { marginTop: '12px' }, disabled: Boolean(running), onclick: () => run() }, icon('play'), running ? 'Running…' : 'Run'),
        h('p.muted', { style: { margin: '8px 0 0', fontSize: '11px' } }, 'FlowSOM: Van Gassen et al. 2015 · Leiden: Traag et al. 2019 · PhenoGraph: Levine et al. 2015 · UMAP: McInnes et al. 2018 · t-SNE: van der Maaten 2014, opt-SNE: Belkina et al. 2019.')));
  }

  // --- Running ------------------------------------------------------------------------------------

  async function run() {
    const ws = store.ws;
    const settings = { ...S.settings, markers: [...(S.settings.markers ?? [])] };
    const samples = scopedSamples();
    const popId = populationId();
    if (!samples.length) return toast('No samples to analyze.', { kind: 'error' });
    if (settings.markers.length < 2) return toast('Choose at least two markers.', { kind: 'error' });
    if (settings.embedding === 'none' && settings.clustering === 'none') return toast('Choose a clustering, an embedding or both.', { kind: 'error' });
    const jobs = [];
    const progress = progressToast('Preparing the cells…', () => { for (const job of jobs) job.cancel(); running = null; renderSetup(); });
    running = { progress };
    renderSetup();
    const call = (worker, type, payload, transfer, from, to) => {
      const job = app.worker(worker).run(type, payload, { transfer, onProgress: (f, m) => progress.update(from + (to - from) * f, m) });
      jobs.push(job);
      return job.promise;
    };
    try {
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
        let centers;
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
        centers = centroids(matrix, n, dim, labels, k);
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
        summary = await call('cluster', 'summary', { data: matrix.slice(), n, dim, labels: Int32Array.from(labels), k, markers: settings.markers.map((m) => shortLabel(m)), heatmap: { scale: 'quantile' } }, [], 0.93, 0.97);
      }
      const abundance = fullLabels ? fullLabels.map(({ labels: l }) => {
        const counts = new Float64Array(k);
        for (const c of l) if (c >= 0) counts[c] += 1;
        return Array.from(counts, (c) => (100 * c) / (l.length || 1));
      }) : null;

      // 6. Store the results as derived channels with the method and parameters.
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
      const record = await app.saveDerived({
        kind: settings.embedding !== 'none' ? settings.embedding : settings.clustering,
        name: [clustering.id !== 'none' ? clustering.label : null, method.id !== 'none' ? method.label : null].filter(Boolean).join(' + '),
        method: [clustering.id !== 'none' ? clustering.label : null, method.id !== 'none' ? method.label : null].filter(Boolean).join(' and '),
        params: { markers: settings.markers, populationId: popId, population: popId === ROOT ? 'All events' : gatePath(ws, popId), samples: loaded.map((l) => l.sample.name), events: n, nNeighbors: settings.nNeighbors, minDist: settings.minDist, perplexity: settings.perplexity, k, xdim: settings.xdim, ydim: settings.xdim, leidenK: settings.leidenK, resolution: settings.resolution, embedding: settings.embedding, clustering: settings.clustering },
        seed: settings.seed,
        outputs,
        perSample,
        summary: {
          quality: quality ? { trustworthiness: quality.trustworthiness, continuity: quality.continuity, knnPreservation: quality.knnPreservation, k: quality.k, batch: quality.batch, warnings: quality.warnings } : null,
          clusters: summary ? { k, names, mem: summary.mem?.labels ?? null, frequencies: Array.from(summary.summary.frequencies ?? []) } : null,
          abundance,
        },
      }, `Explore: ${clustering.id !== 'none' ? clustering.label : ''}${clustering.id !== 'none' && method.id !== 'none' ? ' + ' : ''}${method.id !== 'none' ? method.label : ''}`);
      S.run = { recordId: record.id, settings, loaded: loaded.map((l) => ({ id: l.sample.id, name: l.sample.name, count: l.count, offset: l.offset, n: l.picked.length })), matrix, n, dim, sampleOf, embedding, ranges: embedding ? embeddingRanges(embedding, n) : null, labels, k, summary, names, quality, abundance, method, clustering, popId, reliability: quality?.reliability?.score ?? null, modelId, assign, placed: [] };
      S.mapShows = 'reference';
      S.colorBy = labels ? 'cluster' : 'density';
      S.highlight = null;
      S.hidden = new Set();
      progress.done(`Done: ${k ? `${k} clusters` : ''}${k && embedding ? ' and ' : ''}${embedding ? `a ${method.label} of ${formatCount(n)} events` : ''}.`);
    } catch (error) {
      if (!error.cancelled) progress.fail(error.message);
    } finally {
      running = null;
      if (!destroyed) renderAll();
    }
  }

  function shortLabel(channel) {
    return channelLabel(store.ws, channel, { short: true }).replace(' (unmixed)', '');
  }

  // --- Embedding plot -------------------------------------------------------------------------

  function colorOptions(r) {
    const options = [];
    if (r.labels) options.push(['cluster', 'Cluster']);
    options.push(['density', 'Density']);
    if (r.loaded.length > 1) options.push(['sample', 'Sample']);
    const fields = [...new Set(r.loaded.flatMap((l) => Object.keys(store.ws.samples.find((s) => s.id === l.id)?.meta ?? {})))];
    for (const f of fields) options.push([`meta:${f}`, f[0].toUpperCase() + f.slice(1)]);
    if (r.loaded.some((l) => data.view(l.id)?.derived.has('Truth (simulated)'))) options.push(['truth', 'Simulated truth']);
    r.settings.markers.forEach((m, i) => options.push([`marker:${i}`, shortLabel(m)]));
    return options;
  }

  function categoricalColoring(r) {
    if (S.colorBy === 'cluster') return { labels: r.labels, names: r.names, colors: Array.from({ length: r.k }, (_, c) => categoricalColor(c)) };
    if (S.colorBy === 'sample') return { labels: r.sampleOf, names: r.loaded.map((l) => l.name), colors: r.loaded.map((_, i) => categoricalColor(i)) };
    if (S.colorBy.startsWith('meta:')) {
      const field = S.colorBy.slice(5);
      const values = r.loaded.map((l) => String(store.ws.samples.find((s) => s.id === l.id)?.meta?.[field] ?? '—'));
      const levels = [...new Set(values)];
      const labels = Int32Array.from(r.sampleOf, (s) => levels.indexOf(values[s]));
      return { labels, names: levels, colors: levels.map((_, i) => categoricalColor(i)) };
    }
    if (S.colorBy === 'truth') {
      const labels = new Int32Array(r.n).fill(-1);
      for (const l of r.loaded) {
        const truth = data.view(l.id)?.derived.get('Truth (simulated)');
        const embedded = data.view(l.id)?.derived.get('Embedded');
        if (!truth || !embedded) continue;
        let j = 0;
        for (let e = 0; e < embedded.length && j < l.n; e += 1) if (embedded[e]) labels[l.offset + j++] = truth[e];
      }
      const k = Math.max(0, ...labels) + 1;
      return { labels, names: Array.from({ length: k }, (_, c) => `Truth ${c}`), colors: Array.from({ length: k }, (_, c) => categoricalColor(c)) };
    }
    return null;
  }

  function renderPlot() {
    clear(plotHost);
    const r = displayRun(S.run);
    if (!r?.embedding) {
      plotHost.append(h('div.empty', { style: { minHeight: '420px' } }, icon('explore'), h('h3', r ? 'Clusters without an embedding' : 'Explore cells across samples'),
        h('p', r ? 'Run again with UMAP, t-SNE or PCA to see the cells as a map.' : 'Choose a population, markers and methods, then Run. Clusters become populations you can gate, plot and compare; embeddings come with a report of how faithful they are.')));
      return;
    }
    const select = h('select.input.small', { onchange: (e) => { S.colorBy = e.target.value; S.highlight = null; S.hidden = new Set(); renderPlot(); } },
      ...colorOptions(r).map(([value, label]) => h('option', { value, selected: S.colorBy === value }, label)));
    const shade = h('label.check', { title: 'Dim events whose map neighbours mostly come from elsewhere in the data (fewer than two in five among their wider neighbourhood)' }, h('input', { type: 'checkbox', checked: S.shade, onchange: (e) => { S.shade = e.target.checked; renderPlot(); } }), 'Shade unreliable regions');
    const lassoButton = h('button.btn.small', { type: 'button', title: 'Draw around cells on the map to make a population of them' }, icon('lasso'), 'Lasso a population');
    const canvas = h('canvas.explore-canvas');
    const wrap = h('div.explore-canvas-wrap', canvas);
    const legend = h('div.explore-legend');
    // Samples placed on a UMAP after it was made can be shown with the reference or alone.
    const placed = S.run.placed ?? [];
    const showSelect = placed.length ? h('select.input.small', { 'aria-label': 'Map of', onchange: (e) => { S.mapShows = e.target.value; S.highlight = null; S.hidden = new Set(); renderPlot(); } },
      h('option', { value: 'reference', selected: S.mapShows === 'reference' }, `The map's own ${formatCount(S.run.n)} events`),
      h('option', { value: 'all', selected: S.mapShows === 'all' }, 'With the placed samples'),
      ...placed.map((p) => h('option', { value: `placed:${p.id}`, selected: S.mapShows === `placed:${p.id}` }, `Placed: ${p.name}`))) : null;
    const placeButton = S.run.method?.id === 'umap' ? h('button.btn.small', { type: 'button', disabled: Boolean(running), title: 'Position the events of other samples on this map without changing it (UMAP transform)', onclick: () => placeSamples() }, icon('plus'), 'Place samples on this map') : null;
    plotHost.append(h('h3', `${r.method.label} of ${formatCount(r.n)} events`, h('span.spacer'), h('span.field-label', 'Color'), select),
      h('div.row', { style: { marginBottom: '6px', flexWrap: 'wrap', gap: '8px' } }, shade, h('span.grow'), showSelect, placeButton, lassoButton), wrap, legend);
    let lasso = null;
    let lassoMode = false;
    lassoButton.addEventListener('click', () => {
      lassoMode = !lassoMode;
      lassoButton.classList.toggle('primary', lassoMode);
      canvas.style.cursor = lassoMode ? 'crosshair' : 'default';
    });
    const draw = () => {
      const size = Math.min(wrap.clientWidth, 640);
      if (!size) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = cssVar('--plot-bg') || '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const grid = Math.round(size * Math.min(dpr, 2));
      const dot = r.n > 60000 ? 1 : 2;
      const dim = S.shade && r.reliability ? Float32Array.from(r.reliability, (s) => (s < RELIABILITY_THRESHOLD ? 1 : 0)) : null;
      let coloring;
      const categorical = categoricalColoring(r);
      if (S.colorBy === 'density') coloring = { kind: 'density', colormap: store.ui.colormap };
      else if (S.colorBy.startsWith('marker:')) {
        const m = Number(S.colorBy.slice(7));
        const values = new Float32Array(r.n);
        for (let i = 0; i < r.n; i += 1) values[i] = r.matrix[i * r.dim + m];
        const [lo, hi] = robustRange(values);
        coloring = { kind: 'value', values, lo, hi, colormap: 'viridis' };
      } else coloring = { kind: 'category', labels: categorical.labels, colors: categorical.colors, highlight: S.highlight, hidden: S.hidden };
      const rgba = embeddingRaster(r.embedding, r.n, r.ranges, grid, grid, coloring, { dim, dotSize: dot });
      const image = new OffscreenCanvas(grid, grid);
      image.getContext('2d').putImageData(new ImageData(rgba, grid, grid), 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      if (lasso?.length > 1) {
        ctx.strokeStyle = '#5b4ce6';
        ctx.fillStyle = 'rgba(91,76,230,0.12)';
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        lasso.forEach(([px, py], i) => (i ? ctx.lineTo(px * dpr, py * dpr) : ctx.moveTo(px * dpr, py * dpr)));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      clear(legend);
      if (coloring.kind === 'category') {
        categorical.names.forEach((name, c) => {
          const count = countLabel(categorical.labels, c);
          if (!count) return;
          legend.append(h(`button.explore-chip${S.hidden.has(c) ? '.off' : ''}${S.highlight === c ? '.on' : ''}`, {
            type: 'button',
            title: 'Click to highlight; ⌥-click to hide',
            onclick: (e) => {
              if (e.altKey) { if (S.hidden.has(c)) S.hidden.delete(c); else S.hidden.add(c); } else S.highlight = S.highlight === c ? null : c;
              draw();
              if (S.colorBy === 'cluster') renderHeatmap();
            },
          }, h('span.swatch', { style: { background: categorical.colors[c] } }), name, h('span.muted', formatPercent((100 * count) / r.n))));
        });
      } else if (coloring.kind === 'value') {
        legend.append(h('div.explore-gradient', { style: { background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => colormapColor('viridis', t)).join(',')})` } }), h('span.muted', `${shortLabel(r.settings.markers[Number(S.colorBy.slice(7))])}: 1st to 99th percentile`));
      }
    };
    const toEmbedding = (px, py, size) => {
      const [[x0, x1], [y0, y1]] = r.ranges;
      return [x0 + (px / size) * (x1 - x0), y1 - (py / size) * (y1 - y0)];
    };
    canvas.addEventListener('pointerdown', (event) => {
      if (!lassoMode) return;
      const rect = canvas.getBoundingClientRect();
      lasso = [[event.clientX - rect.left, event.clientY - rect.top]];
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!lasso) return;
      const rect = canvas.getBoundingClientRect();
      lasso.push([event.clientX - rect.left, event.clientY - rect.top]);
      draw();
    });
    canvas.addEventListener('pointerup', () => {
      if (!lasso) return;
      const size = canvas.getBoundingClientRect().width;
      const points = lasso.filter((_, i) => i % 2 === 0).map(([px, py]) => toEmbedding(px, py, size));
      lasso = null;
      lassoMode = false;
      lassoButton.classList.remove('primary');
      canvas.style.cursor = 'default';
      draw();
      if (points.length >= 3) createLassoPopulation(points);
    });
    new ResizeObserver(() => draw()).observe(wrap);
    requestAnimationFrame(draw);
  }

  // The run as the map shows it: the reference events, or with (or only) the placed samples.
  function displayRun(r) {
    if (!r?.placed?.length || !S.mapShows || S.mapShows === 'reference') return r;
    const parts = S.mapShows === 'all' ? [{ reference: true }, ...r.placed] : r.placed.filter((p) => `placed:${p.id}` === S.mapShows);
    if (!parts.length) return r;
    const n = parts.reduce((sum, p) => sum + (p.reference ? r.n : p.n), 0);
    const embedding = new Float32Array(n * 2);
    const matrix = new Float32Array(n * r.dim);
    const sampleOf = new Int32Array(n);
    const labels = r.labels ? new Int32Array(n) : null;
    const loaded = [];
    let offset = 0;
    for (const part of parts) {
      if (part.reference) {
        embedding.set(r.embedding, 0);
        matrix.set(r.matrix, 0);
        sampleOf.set(r.sampleOf, 0);
        if (labels) labels.set(r.labels, 0);
        loaded.push(...r.loaded);
        offset = r.n;
        continue;
      }
      embedding.set(part.embedding, offset * 2);
      matrix.set(part.matrix, offset * r.dim);
      sampleOf.fill(loaded.length, offset, offset + part.n);
      if (labels) labels.set(part.labels, offset);
      loaded.push({ id: part.id, name: `${part.name} (placed)`, count: part.count, offset, n: part.n });
      offset += part.n;
    }
    return { ...r, n, embedding, matrix, sampleOf, labels, loaded, reliability: null };
  }

  // Places other samples' events on the UMAP: each event goes among its nearest neighbours of the
  // map's own events (UMAP's transform), the map itself unchanged; clusters come as for the
  // events outside the subsample (FlowSOM's map, or the nearest cluster centre).
  async function placeSamples() {
    const r = S.run;
    if (!r?.embedding || r.method.id !== 'umap') return;
    const ws = store.ws;
    const taken = new Set([...r.loaded.map((l) => l.id), ...(r.placed ?? []).map((p) => p.id)]);
    const candidates = ws.samples.filter((s) => !taken.has(s.id) && s.role !== 'single-stain' && s.role !== 'unstained');
    if (!candidates.length) return toast('Every sample is already on this map.');
    const chosen = new Set(candidates.map((s) => s.id));
    const list = h('div.boolean-list', ...candidates.map((sample) => {
      const box = h('input', { type: 'checkbox', checked: true });
      box.addEventListener('change', () => { if (box.checked) chosen.add(sample.id); else chosen.delete(sample.id); });
      return h('label.boolean-option', box, h('span.swatch', { style: { background: 'var(--line-strong)' } }), h('span', sample.name));
    }));
    const ok = await new Promise((resolve) => showDialog({
      title: 'Place samples on this map',
      content: h('div', h('p.muted', `Up to ${formatCount(r.settings.perSample)} events of ${r.popId === ROOT ? 'all events' : gatePath(ws, r.popId)} per sample are positioned among their nearest neighbours on the map, which does not change. Their quality is not measured: a sample unlike any on the map lands on its nearest look-alikes.`), list),
      buttons: [{ label: 'Cancel', ghost: true, value: false }, { label: 'Place', primary: true, value: true, onClick: () => true }],
      onClose: (result) => resolve(Boolean(result)),
    }));
    if (!ok || !chosen.size) return;
    const progress = progressToast('Placing samples on the map…');
    running = { cancel: () => {} };
    renderAll();
    try {
      const markers = r.settings.markers;
      const perSample = new Map();
      const placedNow = [];
      const targets = candidates.filter((s) => chosen.has(s.id));
      for (const [i, sample] of targets.entries()) {
        progress.update(i / targets.length, `Placing ${sample.name}`);
        const view = await data.ensure(sample.id);
        const indices = population(view, store.ws, r.popId);
        if (indices === undefined) continue;
        const missing = markers.filter((m) => !view.hasChannel(m));
        if (missing.length) throw new Error(`${sample.name} lacks ${missing.join(', ')}.`);
        const scaled = markers.map((m) => view.scaled(m, channelTransform(store.ws, view, m)));
        const count = countOf(indices, view);
        const picked = pickEvents(indices, view.eventCount, r.settings.perSample, r.settings.seed + 7919 + i);
        const matrix = gatherMatrix(scaled, picked);
        const placed = await app.worker('dimred').call('transformUmap', { modelId: r.modelId, data: matrix.slice(), m: picked.length, options: { seed: r.settings.seed } }, { onProgress: (f) => progress.update((i + 0.8 * f) / targets.length, `Placing ${sample.name}`) });
        const columns = {};
        const x = new Float32Array(view.eventCount).fill(Number.NaN);
        const y = new Float32Array(view.eventCount).fill(Number.NaN);
        const embedded = new Float32Array(view.eventCount);
        picked.forEach((e, j) => { x[e] = placed.embedding[2 * j]; y[e] = placed.embedding[2 * j + 1]; embedded[e] = 1; });
        columns[`${r.method.axis} 1`] = x;
        columns[`${r.method.axis} 2`] = y;
        columns.Embedded = embedded;
        let labels = null;
        if (r.assign && r.clustering?.channel) {
          const all = indices ?? Uint32Array.from({ length: view.eventCount }, (_, e) => e);
          const full = gatherMatrix(scaled, all);
          let fullLabels;
          if (r.assign.som) {
            const mapped = await app.worker('cluster').call('map', { som: r.assign.som, data: full, n: all.length }, { transfer: [full.buffer] });
            fullLabels = Int32Array.from(mapped.mapping, (node) => r.assign.metaclusters[node]);
          } else {
            fullLabels = assignNearest(full, all.length, r.dim, r.assign.centers, r.assign.k);
          }
          const column = new Float32Array(view.eventCount).fill(-1);
          all.forEach((e, j) => { column[e] = fullLabels[j]; });
          columns[r.clustering.channel] = column;
          labels = Int32Array.from(picked, (e) => column[e]);
        }
        perSample.set(sample.id, columns);
        placedNow.push({ id: sample.id, name: sample.name, count, n: picked.length, embedding: Float32Array.from(placed.embedding), matrix, labels: labels ?? new Int32Array(picked.length) });
      }
      if (!placedNow.length) throw new Error('The population applies to none of the chosen samples.');
      const record = store.ws.derived.find((d) => d.id === r.recordId);
      const names = [...(record?.params?.placed ?? []), ...placedNow.map((p) => p.name)];
      await app.addDerivedSamples(r.recordId, perSample, { placed: names }, `Place ${placedNow.length} sample${placedNow.length === 1 ? '' : 's'} on the ${r.method.label}`);
      r.placed = [...(r.placed ?? []), ...placedNow];
      S.mapShows = 'all';
      S.colorBy = 'sample';
      progress.done(`Placed ${placedNow.map((p) => p.name).join(', ')} on the map.`);
    } catch (error) {
      progress.fail(/model/i.test(error.message) ? 'The map\'s model is no longer in memory (it lasts for this session); run the UMAP again, then place the samples.' : error.message);
    } finally {
      running = null;
      if (!destroyed) renderAll();
    }
  }

  function countLabel(labels, c) {
    let n = 0;
    for (let i = 0; i < labels.length; i += 1) if (labels[i] === c) n += 1;
    return n;
  }

  // A polygon on the embedding becomes a gate on the embedding channels, under an "Embedded"
  // gate so its frequency is relative to the embedded subsample.
  function createLassoPopulation(points) {
    const r = S.run;
    let ws = store.ws;
    const parentId = r.popId === ROOT ? null : r.popId;
    let embeddedGate = ws.gates.find((g) => g.type === 'category' && g.dims[0]?.channel === 'Embedded' && (g.parentId ?? null) === parentId);
    const gates = [];
    if (!embeddedGate) {
      embeddedGate = { id: newId('g'), parentId, name: `Embedded (${r.method.label})`, type: 'category', dims: [{ channel: 'Embedded' }], geometry: { values: [1] }, color: '#94a3b8', meta: { origin: 'auto', method: 'subsample', note: `The events of this population that the ${r.method.label} embedded (an equal number per sample). Populations drawn on the map sit under it, so their frequencies are relative to the embedded events.` } };
      gates.push(embeddedGate);
    }
    const [[x0, x1], [y0, y1]] = r.ranges;
    const tx = { type: 'linear', min: x0, max: x1 };
    const ty = { type: 'linear', min: y0, max: y1 };
    const vertices = points.map(([x, y]) => [(x - x0) / (x1 - x0), (y - y0) / (y1 - y0)]);
    const name = `${r.method.label} region ${ws.gates.filter((g) => g.dims[0]?.channel === `${r.method.axis} 1`).length + 1}`;
    gates.push({ id: newId('g'), parentId: embeddedGate.id, name, type: 'polygon', dims: [{ channel: `${r.method.axis} 1`, transform: tx }, { channel: `${r.method.axis} 2`, transform: ty }], geometry: { vertices }, meta: { origin: 'manual', note: `Drawn on the ${r.method.label} map.` } });
    const result = addGates(ws, gates);
    store.commit(result.ws, `Add ${name}`);
    toast(`Added ${name}. Rename it in the population tree; it backgates onto any plot.`, { kind: 'ok' });
  }

  // --- Quality ------------------------------------------------------------------------------------

  function renderQuality() {
    clear(qualityHost);
    const r = S.run;
    qualityHost.append(h('h3', icon('qc'), 'How faithful is the map?'));
    if (!r?.quality) {
      qualityHost.append(h('p.muted', 'Embeddings are summaries, not proof of populations: islands can split one population or merge several, and distances between islands mean little. CytoWeave measures, for every map, how well it keeps each cell\'s neighbours and whether samples or batches drive the layout.'));
      return;
    }
    const q = r.quality;
    // good: true (green), false (amber) or null (no judgement).
    const tile = (label, value, good, hint) => h('div.stat-tile', { title: hint }, h('div.k', label), h('div.v', { style: { color: good === null ? 'var(--text)' : good ? 'var(--ok)' : 'var(--warn)' } }, value));
    const knnLost = q.knnPreservation < Math.max(0.05, 10 * q.chance);
    qualityHost.append(h('div.stat-grid',
      tile('Trustworthiness', q.trustworthiness.toFixed(2), q.trustworthiness >= 0.92, 'Are map neighbours true neighbours? (Venna & Kaski 2001; 1 is perfect)'),
      tile('Continuity', q.continuity.toFixed(2), q.continuity >= 0.92, 'Do true neighbours stay together on the map?'),
      tile(`kNN kept (k=${q.k})`, formatPercent(100 * q.knnPreservation), knnLost ? false : q.knnPreservation >= 0.35 ? true : null, `Share of each event's ${q.k} nearest neighbours (in marker space) that stay among its nearest on the map; chance is ${formatPercent(100 * q.chance)}. A strict test: among similar cells the very nearest are largely noise, so t-SNE and UMAP usually keep a minority of them.`)));
    if (q.batch && q.batch.categories > 1) {
      qualityHost.append(h('div.kv', { style: { marginTop: '10px' } },
        h('dt', 'Sample mixing on the map'), h('dd', formatPercent(100 * q.batch.mixingEmbedding)),
        h('dt', 'Sample mixing in the data'), h('dd', formatPercent(100 * q.batch.mixingOriginal))));
    }
    for (const w of q.warnings ?? []) qualityHost.append(h(`div.callout.${w.level === 'warning' ? 'warn' : 'accent'}`, { style: { marginTop: '8px' } }, icon(w.level === 'warning' ? 'warning' : 'info'), h('span', w.message)));
    if (!(q.warnings ?? []).length) qualityHost.append(h('div.callout.ok', { style: { marginTop: '8px' } }, icon('check'), h('span', 'The map keeps neighbourhoods well and samples mix as they do in the data.')));
    qualityHost.append(
      h('button.btn.small', { type: 'button', style: { marginTop: '10px' }, disabled: Boolean(running), onclick: () => seedCheck() }, icon('history'), 'Compare with another seed'),
      r.stability ? h('div.kv', { style: { marginTop: '8px' } }, h('dt', 'Neighbours shared between seeds'), h('dd', formatPercent(100 * r.stability.neighbourOverlap)), h('dt', 'Arrangement change (Procrustes)'), h('dd', r.stability.disparity.toFixed(2))) : null,
      h('p.muted', { style: { fontSize: '11px', margin: '8px 0 0' } }, 'Trustworthiness and continuity: Venna & Kaski 2001. Sample mixing: LISI, Korsunsky et al. 2019 (Harmony), as a fraction of perfect mixing.'));
  }

  async function seedCheck() {
    const r = S.run;
    if (!r?.embedding || r.method.id === 'pca') return toast('PCA does not depend on a seed.');
    const progress = progressToast('Embedding again with another seed…');
    try {
      const type = r.method.id === 'umap' ? 'umap' : 'tsne';
      const options = type === 'umap' ? { nNeighbors: r.settings.nNeighbors, minDist: r.settings.minDist, seed: r.settings.seed + 1 } : { perplexity: r.settings.perplexity, seed: r.settings.seed + 1 };
      const second = await app.worker('dimred').call(type, { data: r.matrix.slice(), n: r.n, dim: r.dim, options, keepModel: false }, { onProgress: (f, m) => progress.update(f * 0.8, m) });
      const quality = await app.worker('dimred').call('seedStability', { a: r.embedding.slice(), b: second.embedding, n: r.n, k: 15, options: { dim: 2 } }, { onProgress: (f) => progress.update(0.8 + 0.2 * f) });
      r.stability = quality;
      progress.done(`Seeds share ${formatPercent(100 * quality.neighbourOverlap)} of map neighbours.`);
      renderQuality();
    } catch (error) {
      progress.fail(error.message);
    }
  }

  // --- Heatmap ------------------------------------------------------------------------------------

  function renderHeatmap() {
    clear(heatmapHost);
    const r = S.run;
    if (!r?.summary) {
      heatmapHost.append(h('h3', icon('grid'), 'Clusters'), h('p.muted', 'Cluster phenotypes appear here: the median of every marker per cluster, scaled per marker, with marker enrichment labels.'));
      return;
    }
    const { heatmap, summary } = r.summary;
    const markers = r.settings.markers.map(shortLabel);
    const rows = heatmap.rows;
    const cols = heatmap.cols;
    const cell = 22;
    const labelWidth = 230;
    const headHeight = 92;
    const canvas = h('canvas');
    const width = labelWidth + cols * cell + 70;
    const height = headHeight + rows * cell + 8;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const text = cssVar('--text') || '#111';
    const muted = cssVar('--text-3') || '#777';
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    const lut = colormapLUT('viridis');
    for (let q = 0; q < cols; q += 1) {
      const m = heatmap.colOrder[q];
      ctx.save();
      ctx.translate(labelWidth + q * cell + cell / 2 + 4, headHeight - 6);
      ctx.rotate(-Math.PI / 3);
      ctx.fillStyle = text;
      ctx.textAlign = 'left';
      ctx.fillText(markers[m], 0, 0);
      ctx.restore();
    }
    for (let i = 0; i < rows; i += 1) {
      const c = heatmap.rowOrder[i];
      const y = headHeight + i * cell;
      if (S.highlight === c) {
        ctx.fillStyle = 'rgba(91,76,230,0.15)';
        ctx.fillRect(0, y, width, cell);
      }
      ctx.fillStyle = categoricalColor(c);
      ctx.fillRect(4, y + 5, 12, 12);
      ctx.fillStyle = text;
      ctx.textAlign = 'left';
      ctx.font = '600 11.5px Inter, system-ui, sans-serif';
      ctx.fillText(r.names[c].slice(0, 30), 22, y + 15);
      ctx.fillStyle = muted;
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(formatPercent(100 * (summary.frequencies?.[c] ?? 0)), labelWidth - 6, y + 15);
      for (let q = 0; q < cols; q += 1) {
        const v = heatmap.ordered[i * cols + q];
        const k = Math.round(Math.max(0, Math.min(1, v)) * 255) * 3;
        ctx.fillStyle = `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`;
        ctx.fillRect(labelWidth + q * cell, y + 1, cell - 1, cell - 2);
      }
    }
    canvas.addEventListener('click', (event) => {
      const rect = canvas.getBoundingClientRect();
      const row = Math.floor((event.clientY - rect.top - headHeight) / cell);
      if (row < 0 || row >= rows) return;
      const c = heatmap.rowOrder[row];
      S.colorBy = 'cluster';
      S.highlight = S.highlight === c ? null : c;
      renderPlot();
      renderHeatmap();
    });
    canvas.style.cursor = 'pointer';
    heatmapHost.append(
      h('h3', icon('grid'), `${r.k} clusters (${r.clustering.label})`, h('span.spacer'),
        h('button.btn.small', { type: 'button', onclick: () => exportClusters() }, icon('download'), 'CSV'),
        h('button.btn.small.primary', { type: 'button', onclick: () => createClusterPopulations() }, icon('plus'), 'Make populations of the clusters')),
      h('p.muted', { style: { margin: '0 0 8px', fontSize: '11.5px' } }, 'Median of each marker per cluster, scaled from the 1st to the 99th percentile of the marker; rows and columns ordered by similarity. Names come from marker enrichment (MEM, Diggins et al. 2017): + and − with a 0–10 score against the other cells. Click a cluster to find it on the map.'),
      h('div', { style: { overflow: 'auto' } }, canvas));
  }

  function createClusterPopulations() {
    const r = S.run;
    const ws = store.ws;
    const parentId = r.popId === ROOT ? null : r.popId;
    const existing = new Set(ws.gates.filter((g) => g.type === 'category' && g.dims[0]?.channel === r.clustering.channel && (g.parentId ?? null) === parentId).map((g) => g.geometry.values[0]));
    const gates = [];
    for (let c = 0; c < r.k; c += 1) {
      if (existing.has(c)) continue;
      gates.push({ id: newId('g'), parentId, name: r.names[c], type: 'category', dims: [{ channel: r.clustering.channel }], geometry: { values: [c] }, color: categoricalColor(c), meta: { origin: 'auto', method: r.clustering.label, note: `${r.clustering.label} cluster ${c + 1}${r.summary?.mem?.labels?.[c] ? `: ${r.summary.mem.labels[c]}` : ''}.` } });
    }
    if (!gates.length) return toast('The clusters are already populations.');
    store.commit(addGates(ws, gates).ws, `Add ${gates.length} cluster populations`);
    toast(`Added ${gates.length} cluster populations under ${parentId ? gateById(ws, parentId).name : 'All events'}. Rename them in the tree; compare them in Compare → Screen populations.`, { kind: 'ok' });
  }

  function exportClusters() {
    const r = S.run;
    const markers = r.settings.markers.map(shortLabel);
    const lines = [['Cluster', 'Name', 'Frequency (subsample)', ...markers.map((m) => `${m} median`)].join(',')];
    for (let c = 0; c < r.k; c += 1) {
      lines.push([c + 1, JSON.stringify(r.names[c]), (r.summary.summary.frequencies?.[c] ?? 0).toFixed(6), ...markers.map((_, m) => (r.summary.summary.medians[c * r.dim + m]).toPrecision(6))].join(','));
    }
    downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), 'clusters.csv');
  }

  // --- Abundance ----------------------------------------------------------------------------------

  function renderAbundance() {
    clear(abundanceHost);
    const r = S.run;
    if (!r?.abundance) {
      abundanceHost.hidden = true;
      return;
    }
    abundanceHost.hidden = false;
    const head = h('tr', h('th', 'Sample'), ...Array.from({ length: r.k }, (_, c) => h('th.r', { title: r.names[c] }, h('span.swatch', { style: { background: categoricalColor(c), marginRight: '4px' } }), `C${c + 1}`)));
    const body = h('tbody');
    let max = 0;
    for (const row of r.abundance) for (const v of row) max = Math.max(max, v);
    r.loaded.forEach((l, i) => {
      body.append(h('tr', h('td', { style: { whiteSpace: 'nowrap' } }, l.name), ...r.abundance[i].map((v) => h('td.r', { style: { background: `rgba(91,76,230,${(0.06 + 0.55 * v / (max || 1)).toFixed(3)})` } }, v.toFixed(1)))));
    });
    abundanceHost.append(
      h('h3', icon('table'), 'Cluster frequencies per sample (% of the population, every event)', h('span.spacer'),
        h('button.btn.small', { type: 'button', onclick: () => { createClusterPopulations(); app.setMode('compare'); } }, icon('compare'), 'Test differences')),
      h('div', { style: { overflow: 'auto', maxHeight: '360px' } }, h('table.data', h('thead', head), body)));
  }

  // --- Restoring a saved result ------------------------------------------------------------------

  async function restore() {
    const record = [...store.ws.derived].reverse().find((d) => ['umap', 'tsne', 'pca', 'flowsom', 'phenograph'].includes(d.kind) && d.params?.markers);
    if (!record || S.run?.recordId === record.id) return false;
    const settings = { ...S.settings, ...record.params, markers: record.params.markers, seed: record.seed };
    const method = EMBEDDINGS.find((m) => m.id === record.params.embedding) ?? EMBEDDINGS[3];
    const clustering = CLUSTERINGS.find((m) => m.id === record.params.clustering) ?? CLUSTERINGS[2];
    const ids = Object.keys(record.files ?? {});
    const samples = ids.map((id) => store.ws.samples.find((s) => s.id === id)).filter(Boolean);
    if (!samples.length) return false;
    const loaded = [];
    const rows = [];
    let offset = 0;
    for (const sample of samples) {
      const view = await data.ensure(sample.id);
      await data.restoreDerived(view);
      if (destroyed) return false;
      const embedded = view.derived.get('Embedded');
      const picked = [];
      if (embedded) for (let e = 0; e < embedded.length; e += 1) if (embedded[e]) picked.push(e);
      loaded.push({ id: sample.id, name: sample.name, count: view.eventCount, offset, n: picked.length, view, picked });
      offset += picked.length;
      rows.push(picked);
    }
    const n = offset;
    const dim = settings.markers.length;
    if (!n && method.id !== 'none') return false;
    const matrix = new Float32Array(n * dim);
    const sampleOf = new Int32Array(n);
    const embedding = method.id !== 'none' ? new Float32Array(n * 2) : null;
    const labels = clustering.id !== 'none' ? new Int32Array(n) : null;
    for (const [i, l] of loaded.entries()) {
      const ws = store.ws;
      gatherMatrix(settings.markers.map((m) => l.view.scaled(m, channelTransform(ws, l.view, m))), Uint32Array.from(l.picked), matrix, l.offset);
      sampleOf.fill(i, l.offset, l.offset + l.n);
      const x = l.view.derived.get(`${method.axis} 1`);
      const y = l.view.derived.get(`${method.axis} 2`);
      const cl = l.view.derived.get(clustering.channel);
      l.picked.forEach((e, j) => {
        if (embedding && x && y) {
          embedding[(l.offset + j) * 2] = x[e];
          embedding[(l.offset + j) * 2 + 1] = y[e];
        }
        if (labels && cl) labels[l.offset + j] = cl[e];
      });
    }
    const k = record.summary?.clusters?.k ?? (labels ? Math.max(0, ...labels) + 1 : 0);
    let summary = null;
    if (labels && n) summary = await app.worker('cluster').call('summary', { data: matrix.slice(), n, dim, labels: Int32Array.from(labels), k, markers: settings.markers.map((m) => shortLabel(m)), heatmap: { scale: 'quantile' } });
    S.run = { recordId: record.id, settings, loaded: loaded.map(({ view, picked, ...rest }) => rest), matrix, n, dim, sampleOf, embedding, ranges: embedding ? embeddingRanges(embedding, n) : null, labels, k, summary, names: record.summary?.clusters?.names ?? Array.from({ length: k }, (_, c) => `Cluster ${c + 1}`), quality: record.summary?.quality ? { ...record.summary.quality, chance: 15 / Math.max(1, n - 1) } : null, abundance: record.summary?.abundance ?? null, method, clustering, popId: record.params.populationId ?? ROOT, reliability: null };
    return true;
  }

  function renderHead() {
    clear(headActions);
    const r = S.run;
    if (!r) return;
    const record = store.ws.derived.find((d) => d.id === r.recordId);
    headActions.append(h('span.muted', `${record?.name ?? ''} · ${r.loaded.length} sample(s) · seed ${r.settings.seed}`));
  }

  function renderAll() {
    renderSetup();
    renderHead();
    renderPlot();
    renderQuality();
    renderHeatmap();
    renderAbundance();
  }

  renderAll();
  if (!S.run) {
    restore().then((restored) => { if (restored && !destroyed) renderAll(); }).catch(() => {});
  }
  return {
    update(topics) {
      if (running) return;
      if (topics.has('sample') || topics.has('gate') || topics.has('workspace-loaded')) {
        if (topics.has('workspace-loaded')) S.run = null;
        if (!S.settings.populationId || topics.has('workspace-loaded')) renderSetup();
      }
      if (topics.has('theme')) renderAll();
      if (topics.has('workspace-loaded')) {
        S.settings.markers = null;
        renderAll();
        restore().then((restored) => { if (restored && !destroyed) renderAll(); }).catch(() => {});
      }
    },
    destroy() {
      destroyed = true;
      root.remove();
    },
  };
}
