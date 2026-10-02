// Module worker for clustering: FlowSOM, k-means and cluster summaries.
//
// Protocol (see cytoweave-spec/conventions.md): the page posts { id, type, payload }; the worker
// replies { id, progress: [fraction, message] } zero or more times, then { id, result } or
// { id, error }. Typed arrays in results are transferred, not copied.
//
// Types and payloads (data = row-major Float32Array of n × dim analysis-scale values):
//   'flowsom'     { data, n, dim, options }            → flowsom() result (som.bmu dropped)
//   'map'         { som, data, n }                     → { mapping, distances }
//   'metacluster' { codes, nodes, dim, k, options }    → { metaclusters }
//   'suggestK'    { codes, nodes, dim, options }       → suggestK() result
//   'kmeans'      { data, n, dim, k, options }         → kmeans() result
//   'summary'     { columns | data+n+dim, labels, k, markers?, options?, heatmap?, rules?,
//                   mem?, sampleOf?, nSamples? }       → { summary, heatmap, mem?, annotation?,
//                                                          abundance? }
//   'stability'   { runs: [Int32Array], options }      → clusterStability() result
//   'agreement'   { a, b }                             → { ari, nmi }
//   'cancel'      { id }                               → cancels that job if it has not started
// A job that is running can be stopped through payload.abort, an Int32Array on a
// SharedArrayBuffer whose first element the page sets to 1 (needs cross-origin isolation), or
// by terminating the worker.

import { flowsom, mapToSOM, metacluster, suggestK } from '../lib/flowsom.js';
import { kmeans } from '../lib/kmeans.js';
import {
  adjustedRandIndex,
  annotateClusters,
  clusterAbundance,
  clusterMedians,
  clusterStability,
  heatmapMatrix,
  markerEnrichment,
  normalizedMutualInformation,
} from '../lib/cluster-summary.js';

const cancelledIds = new Set();

function signalFor(id, payload) {
  const flag = payload?.abort instanceof Int32Array ? payload.abort : null;
  return {
    get aborted() {
      return cancelledIds.has(id) || (flag ? Atomics.load(flag, 0) !== 0 : false);
    },
  };
}

function progressFor(id) {
  let last = 0;
  return (fraction, message) => {
    const now = Date.now();
    if (now - last < 100 && fraction < 1) return;
    last = now;
    self.postMessage({ id, progress: [fraction, message] });
  };
}

// Every distinct ArrayBuffer under value (shared buffers cannot be transferred).
function transferables(value, found = new Set(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return found;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) found.add(value.buffer);
    return found;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) transferables(item, found, seen);
  return found;
}

const handlers = {
  flowsom({ data, n, dim, options = {} }, common) {
    const result = flowsom(data, n, dim, { ...options, ...common });
    delete result.som.bmu;
    return result;
  },
  map({ som, data, n }, common) {
    return mapToSOM(som, data, n, common);
  },
  metacluster({ codes, nodes, dim, k, options = {} }, common) {
    return { metaclusters: metacluster(codes, nodes, dim, k, { ...options, ...common }) };
  },
  suggestK({ codes, nodes, dim, options = {} }, common) {
    return suggestK(codes, nodes, dim, { ...options, ...common });
  },
  kmeans({ data, n, dim, k, options = {} }, common) {
    return kmeans(data, n, dim, k, { ...options, ...common });
  },
  summary(payload) {
    const source = payload.columns ?? { data: payload.data, n: payload.n, dim: payload.dim };
    const summary = clusterMedians(source, payload.labels, payload.k, { ...(payload.options ?? {}), markers: payload.markers });
    const out = { summary, heatmap: heatmapMatrix(summary, payload.heatmap ?? {}) };
    if (payload.markers && payload.mem !== false) out.mem = markerEnrichment(summary, payload.markers, payload.mem ?? {});
    if (payload.markers && payload.rules) out.annotation = annotateClusters(summary, payload.markers, payload.rules, payload.annotate ?? {});
    if (payload.sampleOf) out.abundance = clusterAbundance(payload.labels, payload.sampleOf, payload.nSamples, payload.k);
    return out;
  },
  stability({ runs, options = {} }) {
    return clusterStability(runs, options);
  },
  agreement({ a, b }) {
    return { ari: adjustedRandIndex(a, b), nmi: normalizedMutualInformation(a, b) };
  },
};

// Jobs run one at a time from a queue drained on a timer, so a 'cancel' posted while an earlier
// job runs can still remove a waiting job.
const queue = [];
let draining = false;

function run({ id, type, payload }) {
  try {
    const handler = handlers[type];
    if (!handler) throw new Error(`The clustering worker does not know "${type}".`);
    const signal = signalFor(id, payload);
    if (signal.aborted) throw Object.assign(new Error('Clustering was cancelled.'), { name: 'AbortError' });
    const result = handler(payload ?? {}, { onProgress: progressFor(id), signal });
    self.postMessage({ id, result }, [...transferables(result)]);
  } catch (error) {
    self.postMessage({ id, error: error?.message ?? String(error), cancelled: error?.name === 'AbortError' });
  } finally {
    cancelledIds.delete(id);
  }
}

function drain() {
  draining = false;
  const job = queue.shift();
  if (job) run(job);
  if (queue.length && !draining) {
    draining = true;
    setTimeout(drain, 0);
  }
}

self.onmessage = (event) => {
  const message = event.data ?? {};
  if (message.type === 'cancel') {
    cancelledIds.add(message.payload?.id ?? message.id);
    return;
  }
  queue.push(message);
  if (!draining) {
    draining = true;
    setTimeout(drain, 0);
  }
};
