// Module worker for acquisition QC, batch normalization and debarcoding.
//
// Protocol (see cytoweave-spec/conventions.md): the page posts { id, type, payload }; the worker
// replies { id, progress: [fraction, message] } zero or more times, then { id, result } or
// { id, error }. payload carries the function's arguments by name plus `options`; typed-array
// buffers in the result are transferred, not copied. { type: 'cancel', payload: { id } } cancels a
// queued task (it replies with an error); a task that is already running is not interrupted (the
// computation is synchronous), so terminate the worker to stop one immediately.
//
//   acquisitionQC    { sample, rawColumns, options: { methods, peacoQC, flowRate, margins, drift,
//                      driftChannels } } — PeacoQC, flow rate, margins and drift of one sample in one
//                      call, compacted for the page (the combined mask plus the explanatory tracks)
//   peacoQC          { sample, options }
//   peacoQCChannels  { sample, names, options (with eventsPerBin) } — PeacoQC's per-channel work on
//                      some channels → { results }; the page splits a sample's channels among
//                      several workers (sample columns on SharedArrayBuffers are not copied) and
//                      passes the results to acquisitionQC as options.peacoQC.channelResults
//   flowRateCheck    { sample, options }
//   marginEvents     { sample, options }
//   signalDrift      { sample, channels, options }
//   qcSummary        { results }
//   trainCytoNorm    { references: [{ sample, batch, labels? }], options }
//   applyCytoNorm    { model, sample, batch, labels?, options }
//   quantileNormalize { samples, channels, options }
//   beadNormalize    { sample, options }
//   beadBaseline     { samples, options }
//   batchDiagnostics { samples, batches, channels, options }
//   confoundingCheck { design, options }
//   debarcode        { sample, key, options }
//
// applyCytoNorm and beadNormalize return only the columns they changed (not the input columns).

import { applyCytoNorm, batchDiagnostics, beadBaseline, beadNormalize, confoundingCheck, quantileNormalize, trainCytoNorm } from '../lib/normalize.js';
import { createDensityWorkspace, flowRateCheck, marginEvents, peacoQC, peacoQCChannel, peacoQCLayout, qcSummary, signalDrift } from '../lib/qc.js';
import { debarcode } from '../lib/debarcode.js';

function pickColumns(columns, names) {
  return Object.fromEntries(names.filter((name) => columns[name]).map((name) => [name, columns[name]]));
}

// PeacoQC's result without its per-event mask, isolation-tree nodes and duplicate MAD tracks.
function compactPeacoQC(r) {
  if (!r) return null;
  const channelTracks = {};
  for (const [name, track] of Object.entries(r.channelTracks)) {
    channelTracks[name] = {
      transform: track.transform,
      fullPeaks: track.fullPeaks,
      medians: track.medians,
      peaks: track.peaks,
      madContribution: track.madContribution,
      mad: (track.mad ?? []).map((m) => ({ smooth: m.smooth, lower: m.lower, upper: m.upper, skipped: m.skipped })),
    };
  }
  return {
    eventsPerBin: r.eventsPerBin,
    bins: r.bins,
    channelTracks,
    features: r.features,
    itPerformed: r.itPerformed,
    removed: r.removed,
    percentRemoved: r.percentRemoved,
    byMethod: r.byMethod,
    episodes: r.episodes,
    warnings: r.warnings,
    timeChannel: r.timeChannel,
    timestep: r.timestep,
    parameters: r.parameters,
  };
}

function compactFlowRate(r) {
  if (!r) return null;
  return {
    timeChannel: r.timeChannel,
    timestep: r.timestep,
    timestepAssumed: r.timestepAssumed,
    sliceSeconds: r.sliceSeconds,
    start: r.start,
    end: r.end,
    rate: Float32Array.from(r.rate),
    flagged: r.flagged,
    medianRate: r.medianRate,
    episodes: r.episodes,
    removed: r.removed,
    percentRemoved: r.percentRemoved,
  };
}

function compactDrift(r) {
  if (!r) return null;
  const channels = {};
  for (const [name, c] of Object.entries(r.channels)) {
    channels[name] = {
      medians: Float32Array.from(c.medians),
      foldChange: c.foldChange,
      percentChange: c.percentChange,
      drifted: c.drifted,
      firstDecileMedian: c.firstDecileMedian,
      lastDecileMedian: c.lastDecileMedian,
    };
  }
  return { timeUnit: r.timeUnit, start: r.start, end: r.end, binCenters: r.binCenters, binCounts: r.binCounts, channels, drifted: r.drifted, foldThreshold: r.foldThreshold };
}

// The whole acquisition QC of one sample. rawColumns (uncompensated values, where they differ)
// are used for margin events, which compensation would move off the detector limits.
function acquisitionQC(payload, o) {
  const { sample, rawColumns = {}, options = {} } = payload;
  const methods = { peacoQC: true, flowRate: true, margins: true, drift: true, ...(options.methods ?? {}) };
  const notes = [];
  const hasTime = (sample.channels ?? []).some((c) => c.type === 'time' && sample.columns?.[c.name]);
  const stage = (from, to) => (fraction, message) => o.onProgress(from + (to - from) * fraction, message);
  const peaco = methods.peacoQC ? peacoQC(sample, { ...(options.peacoQC ?? {}), signal: o.signal, onProgress: stage(0, 0.85) }) : null;
  let flow = null;
  if (methods.flowRate) {
    if (hasTime) flow = flowRateCheck(sample, options.flowRate ?? {});
    else notes.push('The file has no time channel, so the flow-rate check was skipped; PeacoQC and the drift check used the order of events instead.');
  }
  o.onProgress(0.9, 'Margin events and drift');
  const margins = methods.margins ? marginEvents({ ...sample, columns: { ...sample.columns, ...rawColumns } }, options.margins ?? {}) : null;
  const drift = methods.drift ? signalDrift(sample, options.driftChannels ?? null, options.drift ?? {}) : null;
  const summary = qcSummary({ peacoQC: peaco, flowRate: flow, margins, drift, eventCount: sample.eventCount });
  const { mask, ...rest } = summary;
  return {
    mask,
    summary: rest,
    hasTime,
    notes,
    methods,
    peacoQC: compactPeacoQC(peaco),
    flowRate: compactFlowRate(flow),
    margins: margins ? { counts: margins.counts, removed: margins.removed, percentRemoved: margins.percentRemoved } : null,
    drift: compactDrift(drift),
  };
}

const TASKS = {
  acquisitionQC,
  peacoQC: (p, o) => peacoQC(p.sample, o),
  peacoQCChannels: (p, o) => {
    if (!(o.eventsPerBin > 0)) throw new Error('peacoQCChannels needs the eventsPerBin of the whole sample.');
    const { bins } = peacoQCLayout(p.sample, { ...o, channels: p.names });
    const shared = { ws: createDensityWorkspace(o.densitySmoothing), buffer: new Float64Array(o.eventsPerBin) };
    return {
      results: p.names.map((name, k) => {
        o.onProgress(k / p.names.length, `Finding peaks in ${name}`);
        return peacoQCChannel(p.sample, name, bins, o, shared);
      }),
    };
  },
  flowRateCheck: (p, o) => flowRateCheck(p.sample, o),
  marginEvents: (p, o) => marginEvents(p.sample, o),
  signalDrift: (p, o) => signalDrift(p.sample, p.channels ?? null, o),
  qcSummary: (p) => qcSummary(p.results),
  trainCytoNorm: (p, o) => trainCytoNorm(p.references, o),
  applyCytoNorm: (p, o) => {
    const result = applyCytoNorm(p.model, p.sample, p.batch, p.labels ?? null, o);
    return { ...result, columns: pickColumns(result.columns, result.channels) };
  },
  quantileNormalize: (p, o) => quantileNormalize(p.samples, p.channels ?? null, o),
  beadNormalize: (p, o) => {
    const result = beadNormalize(p.sample, o);
    return { ...result, columns: pickColumns(result.columns, result.corrected) };
  },
  beadBaseline: (p, o) => beadBaseline(p.samples, o),
  batchDiagnostics: (p, o) => batchDiagnostics(p.samples, p.batches, p.channels ?? null, o),
  confoundingCheck: (p, o) => confoundingCheck(p.design, o),
  debarcode: (p, o) => debarcode(p.sample, p.key, o),
};

const cancelled = new Set();

// The distinct ArrayBuffers behind typed arrays in a result, for transfer.
function transferables(value, found = new Set(), seen = new Set(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return found;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer) found.add(value.buffer);
    return found;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) transferables(item, found, seen, depth + 1);
  return found;
}

self.onmessage = (event) => {
  const { id, type, payload = {} } = event.data ?? {};
  if (type === 'cancel') {
    cancelled.add(payload.id ?? id);
    return;
  }
  const task = TASKS[type];
  if (!task) {
    self.postMessage({ id, error: `Unknown QC worker task "${type}".` });
    return;
  }
  if (cancelled.delete(id)) {
    self.postMessage({ id, error: 'The task was cancelled.' });
    return;
  }
  const signal = { aborted: false };
  let lastProgress = 0;
  const options = {
    ...(payload.options ?? {}),
    signal,
    onProgress: (fraction, message) => {
      // At most ~20 progress messages per second.
      const now = Date.now();
      if (now - lastProgress < 50 && fraction < 1) return;
      lastProgress = now;
      self.postMessage({ id, progress: [fraction, message] });
    },
  };
  try {
    const result = task(payload, options);
    self.postMessage({ id, result }, [...transferables(result)]);
  } catch (error) {
    self.postMessage({ id, error: error?.message ?? String(error) });
  }
};
