// Running acquisition QC on a sample and keeping the result, shared by the QC view (mode-qc.js)
// and the live queue of a watched folder (live-qc.js): the payload sent to the QC worker, the
// run itself (PeacoQC's per-channel work split among several workers when the sample is large),
// the part of a result kept in the workspace, and saving the "QC pass" channel.

import { channelTransform } from '../lib/engine.js';
import { addDerived } from '../lib/workspace.js';
import { peacoQCLayout } from '../lib/qc.js';
import { WorkerClient } from './workers.js';

export const QC_CHANNEL = 'QC pass';

export const QC_CITE = {
  peacoqc: 'PeacoQC: Emmaneel et al., Cytometry A 2022, doi:10.1002/cyto.a.24501',
  flowai: 'flowAI: Monaco et al., Bioinformatics 2016, doi:10.1093/bioinformatics/btw191',
};

export const DEFAULT_SETTINGS = {
  scope: 'all',
  includeControls: false,
  channels: 'auto',
  methods: { peacoQC: true, flowRate: true, margins: true, drift: true },
  mad: 6,
  itLimit: 0.6,
  consecutiveBins: 5,
  variant: 'refined',
};

// Below this many events × channels, one worker is as fast as several (the data are passed once).
const PARALLEL_MIN_VALUES = 2e6;

export function downsample(values, n) {
  if (values.length <= n) return Array.from(values, (v) => +Number(v).toPrecision(4));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = Math.floor((i * values.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * values.length) / n));
    let sum = 0;
    for (let k = a; k < b; k += 1) sum += values[k];
    out.push(+(sum / (b - a)).toPrecision(4));
  }
  return out;
}

export function mergeSpans(spans) {
  const sorted = spans.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

// The x domain of a QC result: seconds when the file has a time channel, else event numbers.
export function timeDomain(result) {
  const flow = result.flowRate;
  if (flow) return { lo: flow.start, hi: flow.end, unit: 's' };
  const bins = result.peacoQC?.bins ?? [];
  if (bins.length && bins[0].time) return { lo: bins[0].time[0], hi: bins[bins.length - 1].time[1], unit: 's' };
  return { lo: 0, hi: bins.length ? bins[bins.length - 1].end : 1, unit: 'events' };
}

export function binSpan(bin, unit) {
  return unit === 's' && bin.time ? bin.time : [bin.start, bin.end];
}

// A small, persistable sparkline: the event rate (or, without time, the most variable peak
// trajectory) and the stretches QC removed.
function sparklineOf(result) {
  const domain = timeDomain(result);
  let values = null;
  let kind = 'rate';
  if (result.flowRate) values = downsample(result.flowRate.rate, 96);
  else if (result.peacoQC) {
    kind = 'signal';
    const tracks = Object.values(result.peacoQC.channelTracks).sort((a, b) => b.madContribution - a.madContribution);
    if (tracks[0]) values = downsample(tracks[0].peaks[0], 96);
  }
  if (!values) return null;
  const spans = [];
  for (const bin of result.peacoQC?.bins ?? []) if (bin.removedBy.length) spans.push(binSpan(bin, domain.unit).slice());
  for (const episode of result.flowRate?.episodes ?? []) spans.push([episode.startTime, episode.endTime]);
  const removed = mergeSpans(spans).slice(0, 80).map(([a, b]) => [+a.toPrecision(7), +b.toPrecision(7)]);
  return { kind, unit: domain.unit, lo: domain.lo, hi: domain.hi, values, removed };
}

export function paramsOf(settings) {
  return {
    methods: { ...settings.methods },
    channels: settings.channels,
    peacoQC: { variant: settings.variant ?? 'refined', MAD: settings.mad, IT_limit: settings.itLimit, consecutive_bins: settings.consecutiveBins, peak_removal: 1 / 3, min_nr_bins_peakdetection: 10, isolation: 'isolationTreeSD' },
    flowRate: { second_fraction: 0.1, alpha: 0.01, test: 'robust generalized ESD' },
    margins: { limit: '$PnR − 1', minPile: 2, values: 'uncompensated' },
    drift: { bins: 20, foldThreshold: 1.2 },
  };
}

// The part of a QC result kept in the workspace (the tracks stay in memory for the session).
export function summaryOf(result, sample, params) {
  const s = result.summary;
  const findings = [
    ...s.findings,
    ...result.notes.map((text) => ({ method: 'note', severity: 'info', text })),
    ...(result.peacoQC?.warnings ?? []).map((text) => ({ method: 'peacoQC', severity: 'info', text })),
  ];
  return {
    name: sample.name,
    at: new Date().toISOString(),
    eventCount: s.kept + s.removed,
    removed: s.removed,
    percentRemoved: s.percentRemoved,
    score: s.score,
    grade: s.grade,
    byMethod: s.byMethod,
    findings,
    drifted: result.drift?.drifted ?? [],
    hasTime: result.hasTime,
    sparkline: sparklineOf(result),
    params,
  };
}

export function qcPayload(ws, view, settings) {
  const technology = view.record.technology;
  let signal = view.parameters.filter((p) => p.type === 'scatter' || p.type === 'fluorescence');
  if (settings.channels === 'markers' || (settings.channels === 'auto' && technology === 'mass')) {
    const marked = signal.filter((p) => p.type === 'scatter' || p.marker);
    if (marked.length >= 2) signal = marked;
  }
  if (!signal.length) throw new Error('The sample has no scatter or fluorescence channels to check.');
  const time = view.parameters.find((p) => p.type === 'time');
  const columns = {};
  const rawColumns = {};
  for (const p of signal) {
    columns[p.name] = view.column(p.name);
    const raw = view.raw.get(p.name);
    if (raw && raw !== columns[p.name]) rawColumns[p.name] = raw;
  }
  if (time) columns[time.name] = view.column(time.name);
  const names = signal.map((p) => p.name);
  const transforms = Object.fromEntries(names.map((name) => [name, channelTransform(ws, view, name)]));
  return {
    sample: {
      eventCount: view.eventCount,
      channels: view.parameters.filter((p) => columns[p.name]).map((p) => ({ name: p.name, type: p.type, range: p.range })),
      columns,
      keywords: { $TIMESTEP: view.dataset.keywords?.$TIMESTEP },
    },
    rawColumns,
    options: {
      methods: { ...settings.methods },
      peacoQC: { mode: settings.variant ?? 'refined', channels: names, transforms, technology, mad: settings.mad, itLimit: settings.itLimit, consecutiveBins: settings.consecutiveBins, removeZeros: technology === 'mass' },
      flowRate: {},
      margins: { channels: names },
      drift: { bins: 20 },
      driftChannels: names,
    },
  };
}

// The pool of workers that find PeacoQC's peaks in parallel: up to four, leaving a core free.
function peakPool(app) {
  const cores = Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1);
  app.workers['qc-peaks'] ??= new WorkerClient('../workers/qc-worker.js', { max: Math.min(4, cores) });
  return app.workers['qc-peaks'];
}

// PeacoQC's per-channel work on several workers: the channels are dealt out in turn (neighboring
// channels cost about the same), each worker gets only its channels' columns (shared, not copied,
// when the page is cross-origin isolated), and the results come back in channel order.
async function parallelChannels(app, payload, onProgress, jobs) {
  const pool = peakPool(app);
  const options = payload.options.peacoQC;
  const { channels, eventsPerBin } = peacoQCLayout(payload.sample, options);
  const groups = Array.from({ length: Math.min(pool.max, channels.length) }, () => []);
  channels.forEach((name, c) => groups[c % groups.length].push(name));
  const done = new Array(groups.length).fill(0);
  const runs = groups.map((names, g) => {
    const sample = { ...payload.sample, columns: Object.fromEntries(names.map((name) => [name, payload.sample.columns[name]])) };
    const job = pool.run('peacoQCChannels', { sample, names, options: { ...options, eventsPerBin } }, {
      onProgress: (fraction) => {
        done[g] = fraction;
        onProgress?.((0.8 * done.reduce((a, b) => a + b, 0)) / groups.length, `Finding peaks in ${channels.length} channels on ${groups.length} workers`);
      },
    });
    jobs.push(job);
    return job.promise.then((r) => r.results);
  });
  const results = await Promise.all(runs);
  const byName = new Map();
  groups.forEach((names, g) => names.forEach((name, k) => byName.set(name, results[g][k])));
  return { eventsPerBin, channelResults: channels.map((name) => byName.get(name)) };
}

// Runs acquisition QC on one sample. options: onProgress, track (job → job, for the caller's
// bookkeeping), onJob (the job to cancel), parallel (default: when the sample is large). Returns
// the worker's result with sampleId, params and persisted (summaryOf).
export async function runQC(app, sample, settings, options = {}) {
  const { onProgress, track = (job) => job, onJob } = options;
  const view = await app.data.ensure(sample.id);
  const payload = qcPayload(app.store.ws, view, settings);
  const peaco = payload.options.peacoQC;
  const parallel = options.parallel ?? (settings.methods?.peacoQC !== false && peaco.channels.length >= 4 && view.eventCount * peaco.channels.length >= PARALLEL_MIN_VALUES);
  const jobs = [];
  let canceled = false;
  onJob?.({ cancel: () => { canceled = true; jobs.forEach((job) => job.cancel()); } });
  let scale = (fraction, message) => onProgress?.(fraction, message);
  if (parallel) {
    const { eventsPerBin, channelResults } = await parallelChannels(app, payload, onProgress, jobs);
    if (canceled) throw Object.assign(new Error('Canceled.'), { canceled: true });
    payload.options.peacoQC = { ...peaco, eventsPerBin, channelResults };
    scale = (fraction, message) => onProgress?.(0.8 + 0.2 * fraction, message);
  }
  const job = track(app.worker('qc').run('acquisitionQC', payload, { onProgress: scale }));
  jobs.push(job);
  const result = await job.promise;
  const params = paramsOf(settings);
  result.sampleId = sample.id;
  result.params = params;
  result.parallel = parallel;
  result.persisted = summaryOf(result, sample, params);
  return result;
}

function sameSet(a = [], b = []) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

// As app.saveDerived, but a record with the same kind and outputs keeps its other samples
// (QC and debarcoding run on a few samples at a time).
export async function saveDerivedMergedIn(app, record, perSample, label, options = {}) {
  const { store, data } = app;
  const existing = store.ws.derived.find((d) => d.kind === record.kind && sameSet(d.outputs, record.outputs));
  if (!existing) return app.saveDerived({ ...record, perSample }, label);
  const files = { ...(existing.files ?? {}) };
  for (const [sampleId, columns] of perSample) {
    files[sampleId] = {};
    for (const [name, column] of Object.entries(columns)) {
      data.setDerived(sampleId, name, column);
      files[sampleId][name] = await data.persistColumn(column);
    }
  }
  const summary = {
    ...(existing.summary ?? {}),
    ...(record.summary ?? {}),
    perSample: { ...(existing.summary?.perSample ?? {}), ...(record.summary?.perSample ?? {}) },
  };
  const merged = { ...existing, ...record, params: options.keepParams ? existing.params : record.params, id: existing.id, created: existing.created, files, summary };
  store.commit(addDerived(store.ws, merged).ws, label, ['derived', 'data']);
  return merged;
}

// Saves the "QC pass" masks of `ids` (results: Map sample id → result), merging with the samples
// checked earlier.
export async function saveQCResults(app, results, ids, settings, options = {}) {
  const perSample = new Map();
  const summaries = {};
  for (const id of ids) {
    const result = results.get(id);
    perSample.set(id, { [QC_CHANNEL]: Float32Array.from(result.mask) });
    summaries[id] = result.persisted;
  }
  const record = {
    kind: 'qc',
    name: 'Acquisition QC',
    method: 'PeacoQC + flow rate + margins',
    params: paramsOf(settings),
    seed: 1,
    outputs: [QC_CHANNEL],
    summary: { version: 1, software: `CytoWeave ${app.version ?? ''}`.trim(), references: [QC_CITE.peacoqc, QC_CITE.flowai], perSample: summaries },
  };
  return saveDerivedMergedIn(app, record, perSample, `Acquisition QC (${ids.length} sample${ids.length === 1 ? '' : 's'})`, options);
}
