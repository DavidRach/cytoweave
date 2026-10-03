// Module worker: generates CytoWeave's simulated example experiments off the main thread.
//
// Protocol (cytoweave-spec/conventions.md): the page posts { id, type, payload }; the worker
// replies { id, progress: [fraction, message] } zero or more times, then { id, result } or
// { id, error }. Requests:
//   generateExample  payload { id, options: { seed, scale, samples, truth, tandemDegradation, instrumentShift } }
//                    → { files: [{ name, bytes, meta }], workspaceHints }
//   listExamples     → catalog summaries
//   getExample       payload { id } → the catalog entry
//   cancel           payload { id: <request id> } → stops a running generation between files
// FCS bytes and ground-truth arrays are transferred, not copied.

import { generateExampleAsync, getExample, listExamples } from '../lib/examples.js';

const running = new Map();

// Every ArrayBuffer under a result (FCS bytes, truth labels, abundances), each listed once.
function transferables(value, out = new Set()) {
  if (!value || typeof value !== 'object') return out;
  if (ArrayBuffer.isView(value)) {
    out.add(value.buffer);
    return out;
  }
  if (value instanceof ArrayBuffer) {
    out.add(value);
    return out;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) transferables(item, out);
  return out;
}

self.addEventListener('message', async (event) => {
  const { id, type, payload = {} } = event.data ?? {};
  try {
    switch (type) {
      case 'cancel': {
        const signal = running.get(payload.id ?? id);
        if (signal) signal.aborted = true;
        return;
      }
      case 'listExamples':
        self.postMessage({ id, result: listExamples() });
        return;
      case 'getExample':
        self.postMessage({ id, result: getExample(payload.id) });
        return;
      case 'generateExample': {
        const signal = { aborted: false };
        running.set(id, signal);
        try {
          const { seed, scale, samples, truth, tandemDegradation, instrumentShift } = payload.options ?? {};
          const result = await generateExampleAsync(payload.id, {
            seed,
            scale,
            samples,
            truth,
            tandemDegradation,
            instrumentShift,
            signal,
            onProgress: (fraction, message) => self.postMessage({ id, progress: [fraction, message] }),
          });
          self.postMessage({ id, result }, [...transferables(result)]);
        } finally {
          running.delete(id);
        }
        return;
      }
      default:
        throw new Error(`Unknown request "${type}".`);
    }
  } catch (error) {
    self.postMessage({ id, error: error?.message ?? String(error) });
  }
});
