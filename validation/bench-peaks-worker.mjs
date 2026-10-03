// A worker thread for validation/bench.mjs: PeacoQC's per-channel work on some channels of a
// sample whose columns are on SharedArrayBuffers, as the QC worker pool does in the browser.

import { parentPort } from 'node:worker_threads';
import { createDensityWorkspace, peacoQCChannel, peacoQCLayout } from '../web/lib/qc.js';

parentPort.on('message', ({ sample, names, options }) => {
  const { bins } = peacoQCLayout(sample, { ...options, channels: names });
  const shared = { ws: createDensityWorkspace(), buffer: new Float64Array(options.eventsPerBin) };
  parentPort.postMessage(names.map((name) => peacoQCChannel(sample, name, bins, options, shared)));
});
