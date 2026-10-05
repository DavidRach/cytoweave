// Events out of CytoWeave (I6): a population's events in chosen samples, optionally downsampled,
// written as one concatenated FCS file with a sample identifier channel, or as one FCS file per
// sample; the same selection goes into AnnData files (anndata.js).
//
// Downsampling is seeded: the same seed picks the same events. Each sample's events are drawn
// with its own seed derived from the seed and the file's checksum (or the sample's id), so a
// sample's choice does not depend on which other samples are exported. "count" keeps up to that
// many events per sample (all of a smaller population), "fraction" that share of each sample's
// events (rounded to the nearest event); both are uniform without replacement.

import { createRandom, sampleIndices } from './random.js';
import { deriveSeed } from './simulate.js';
import { population } from './engine.js';
import { ROOT, gatePath } from './workspace.js';
import { writeFCS } from './fcs.js';

export const SAMPLE_CHANNEL = 'SampleID';
export const EVENT_CHANNEL = 'SourceEvent';

// A population's events in a view as sorted indices (all events: 0…n−1); null when it does not
// apply to the sample.
export function populationIndices(view, ws, populationId = ROOT) {
  const members = population(view, ws, populationId ?? ROOT);
  if (members === undefined) return null;
  return members === null ? Uint32Array.from({ length: view.eventCount }, (_, i) => i) : members;
}

// Downsamples sorted indices. spec: { mode: 'none' | 'count' | 'fraction', value, seed }; key: the
// sample's own part of the seed.
export function downsample(indices, spec, key) {
  if (!spec || spec.mode === 'none' || !spec.mode) return indices;
  const n = indices.length;
  const k = spec.mode === 'count' ? Math.min(n, Math.max(0, Math.floor(spec.value))) : Math.min(n, Math.max(0, Math.round(n * spec.value)));
  if (k >= n) return indices;
  return sampleIndices(n, k, createRandom(deriveSeed(spec.seed ?? 1, key)), indices);
}

// The events to export: [{ sample, view, indices }] for options { sampleIds, populationId,
// downsample }. viewOf(sampleId) gives loaded views; a population that does not apply to a sample
// (a gate scoped to another group) leaves the sample out, with a note.
export function selectEvents(ws, viewOf, options = {}) {
  const notes = [];
  const items = [];
  for (const id of options.sampleIds ?? ws.samples.map((s) => s.id)) {
    const sample = ws.samples.find((s) => s.id === id);
    const view = viewOf(id);
    if (!sample || !view) {
      notes.push(`${sample?.name ?? id} is not loaded and is left out.`);
      continue;
    }
    const all = populationIndices(view, ws, options.populationId);
    if (!all) {
      notes.push(`${options.populationId && options.populationId !== ROOT ? gatePath(ws, options.populationId) : 'The population'} does not apply to ${sample.name}, which is left out.`);
      continue;
    }
    items.push({ sample, view, total: all.length, indices: downsample(all, options.downsample, sample.sha256 ?? sample.id) });
  }
  return { items, notes };
}

// Channels every sample has, in the first sample's order; and those some lack.
export function commonChannels(items) {
  if (!items.length) return { channels: [], dropped: [] };
  const sets = items.map((it) => new Set(it.view.parameters.map((p) => p.name)));
  const first = items[0].view.parameters;
  const channels = first.filter((p) => sets.every((s) => s.has(p.name))).map((p) => p.name);
  const dropped = [...new Set(items.flatMap((it) => it.view.parameters.map((p) => p.name)))].filter((name) => !channels.includes(name));
  return { channels, dropped };
}

const sameMatrix = (a, b) => (!a && !b) || (a && b && a.channels.join('|') === b.channels.join('|') && a.matrix.length === b.matrix.length && Array.from(a.matrix).every((v, i) => v === b.matrix[i]));

// Whether the samples were compensated alike (so raw values and one $SPILLOVER describe them all).
export function sharedCompensation(items) {
  const first = items[0]?.view.compensation ?? null;
  return items.every((it) => sameMatrix(it.view.compensation ?? null, first)) ? { shared: true, compensation: first } : { shared: false, compensation: null };
}

const spilloverKeyword = (comp) => [comp.channels.length, ...comp.channels, ...Array.from(comp.matrix)].join(',');

// One FCS file of every selected event: the common channels (raw values with the shared
// $SPILLOVER, or compensated values), then SampleID (1, 2, … in the samples' order) and
// SourceEvent (the event's index in its own file, from 0). options: { values: 'raw' |
// 'compensated', populationId, downsample, version }. Returns { bytes, report }.
export function concatenatedFCS(ws, items, options = {}) {
  if (!items.length) throw new Error('No events to write: choose samples that are loaded.');
  const { channels, dropped } = commonChannels(items);
  const compensation = sharedCompensation(items);
  const values = options.values ?? (compensation.shared ? 'raw' : 'compensated');
  if (values === 'raw' && !compensation.shared) throw new Error('The samples were compensated with different matrices, so their raw values cannot share one $SPILLOVER: write compensated values.');
  const total = items.reduce((sum, it) => sum + it.indices.length, 0);
  if (total > 16777216) throw new Error(`${total.toLocaleString('en-US')} events are more than the 16,777,216 whose indices a 32-bit float holds exactly; downsample first.`);
  const first = items[0].view;
  const data = [...channels, SAMPLE_CHANNEL, EVENT_CHANNEL].map(() => new Float32Array(total));
  let at = 0;
  items.forEach((item, k) => {
    const columns = channels.map((name) => (values === 'raw' ? item.view.raw.get(name) : item.view.column(name)));
    for (const e of item.indices) {
      for (let c = 0; c < channels.length; c += 1) data[c][at] = columns[c][e];
      data[channels.length][at] = k + 1;
      data[channels.length + 1][at] = e;
      at += 1;
    }
  });
  const param = (name) => first.parameters.find((p) => p.name === name);
  const parameters = [
    ...channels.map((name) => ({ name, label: param(name).marker || param(name).label || '', range: Math.max(...items.map((it) => it.view.parameters.find((p) => p.name === name)?.range ?? 0)) })),
    { name: SAMPLE_CHANNEL, label: 'Sample', range: items.length + 1 },
    { name: EVENT_CHANNEL, label: 'Event in its file', range: Math.max(1, ...items.map((it) => it.view.eventCount)) },
  ];
  const keywords = {
    $CYT: [...new Set(items.map((it) => it.view.dataset.keywords?.$CYT).filter(Boolean))].join('; '),
    $SRC: 'CytoWeave concatenation',
    $COM: `${items.length} samples concatenated by CytoWeave${options.version ? ` ${options.version}` : ''}: ${options.populationId && options.populationId !== ROOT ? gatePath(ws, options.populationId) : 'all events'}${describeDownsampling(options.downsample)}; ${values} values. ${SAMPLE_CHANNEL} numbers the samples (CYTOWEAVE_SAMPLE_n names them), ${EVENT_CHANNEL} is each event's index in its own file.`,
    CYTOWEAVE_VALUES: values,
    ...(options.downsample?.mode && options.downsample.mode !== 'none' ? { CYTOWEAVE_DOWNSAMPLE: `${options.downsample.mode} ${options.downsample.value}`, CYTOWEAVE_SEED: String(options.downsample.seed ?? 1) } : {}),
  };
  items.forEach((item, k) => {
    keywords[`CYTOWEAVE_SAMPLE_${k + 1}`] = item.sample.name;
    if (item.sample.sha256) keywords[`CYTOWEAVE_SHA256_${k + 1}`] = item.sample.sha256;
  });
  if (values === 'raw' && compensation.compensation) keywords.$SPILLOVER = spilloverKeyword(compensation.compensation);
  const bytes = writeFCS({ parameters, data, keywords });
  return {
    bytes,
    report: { events: total, samples: items.map((it, k) => ({ id: k + 1, sample: it.sample.name, events: it.indices.length, of: it.total })), channels, dropped, values, spillover: Boolean(keywords.$SPILLOVER) },
  };
}

// One sample's selected events as an FCS file: raw values with the original keywords and the
// applied spillover (as Export population does), downsampling recorded.
export function sampleFCS(item, options = {}) {
  const view = item.view;
  const keywords = { ...view.dataset.keywords };
  for (const key of Object.keys(keywords)) if (/^\$P\d+/.test(key) || /^\$(BEGIN|END)/.test(key)) delete keywords[key];
  delete keywords.$SPILLOVER;
  delete keywords.SPILL;
  delete keywords.$SPILL;
  if (view.compensation) keywords.$SPILLOVER = spilloverKeyword(view.compensation);
  if (options.downsample?.mode && options.downsample.mode !== 'none') {
    keywords.CYTOWEAVE_DOWNSAMPLE = `${options.downsample.mode} ${options.downsample.value}: ${item.indices.length} of ${item.total} events`;
    keywords.CYTOWEAVE_SEED = String(options.downsample.seed ?? 1);
  }
  const parameters = view.parameters.map((p) => ({ name: p.name, label: p.marker || p.label || '', range: p.range }));
  const data = view.parameters.map((p) => {
    const column = view.raw.get(p.name);
    const out = new Float32Array(item.indices.length);
    for (let i = 0; i < item.indices.length; i += 1) out[i] = column[item.indices[i]];
    return out;
  });
  return writeFCS({ parameters, data, keywords });
}

export function describeDownsampling(spec) {
  if (!spec || !spec.mode || spec.mode === 'none') return '';
  return spec.mode === 'count' ? `, downsampled to ${Number(spec.value).toLocaleString('en-US')} events per sample (seed ${spec.seed ?? 1})` : `, downsampled to ${+(100 * spec.value).toPrecision(3)}% of each sample (seed ${spec.seed ?? 1})`;
}
