// Virtual FMOs on plots (lib/virtual-fmo.js): the guides a plot draws for the channels it shows
// a virtual FMO of (spec.options.virtualFMO), the line under the plot that says what they are,
// and a gate above the threshold on request.

import { h } from './dom.js';
import { gateSignature } from '../lib/engine.js';
import { createTransform, formatNumber } from '../lib/transforms.js';
import { DEFAULT_QUANTILE, fmoControlFor, fmoThreshold, spreadFor, virtualFMO } from '../lib/virtual-fmo.js';
import { ROOT, addGates, channelLabel, gateById, uniqueGateName } from '../lib/workspace.js';

// Line colors with 3:1 contrast on the plot's background in either theme.
const COLORS = { light: { virtual: '#c2410c', real: '#475569' }, dark: { virtual: '#fb923c', real: '#cbd5e1' } };
const cache = new Map();

// The unstained control a virtual FMO starts from: the spectral setup's, or the first unstained
// sample.
export function unstainedFor(ws) {
  const setup = (ws.derived ?? []).find((d) => d.kind === 'spectral-setup');
  const chosen = setup?.params?.unstainedId && ws.samples.find((s) => s.id === setup.params.unstainedId);
  return chosen ?? ws.samples.find((s) => s.role === 'unstained') ?? null;
}

// Whether a channel of a sample can have a virtual FMO: { ok, reason }.
export function virtualFMOAvailable(ws, sample, channel) {
  if (!sample) return { ok: false, reason: 'no sample' };
  if (!spreadFor(ws, sample, channel)) return { ok: false, reason: 'needs the spread model: compute the compensation from the single-stain controls (Compensate) or the spreading matrix (Spectral → Panel)' };
  if (!unstainedFor(ws)) return { ok: false, reason: 'needs an unstained control' };
  return { ok: true };
}

const popKey = (ws, populationId, sampleId) => {
  const gate = populationId && populationId !== ROOT ? gateById(ws, populationId) : null;
  return gate ? gateSignature(ws, gate, sampleId) : 'root';
};

// One channel's virtual FMO (and the real FMO's, when the workspace has one), cached.
// Returns { result, real, pending } where pending means a sample is still loading.
function compute(app, { sample, view, populationId, channel, other, onReady }) {
  const ws = app.store.ws;
  const found = spreadFor(ws, sample, channel);
  const unstainedSample = unstainedFor(ws);
  if (!found || !unstainedSample) return null;
  const unstained = app.data.view(unstainedSample.id);
  if (!unstained) {
    app.data.ensure(unstainedSample.id).then(() => onReady?.(), () => {});
    return { pending: true };
  }
  const marker = sample.channels.find((c) => c.name === channel)?.marker ?? null;
  const fmoSample = fmoControlFor(ws, channel, marker);
  const fmoView = fmoSample ? app.data.view(fmoSample.id) : null;
  if (fmoSample && !fmoView) app.data.ensure(fmoSample.id).then(() => onReady?.(), () => {});
  const key = [sample.id, view.version, unstained.version, popKey(ws, populationId, sample.id), channel, other ?? '', JSON.stringify(found.record.noise?.fitted ?? ''), fmoView?.version ?? 'none'].join('|');
  if (cache.has(key)) return cache.get(key);
  let entry;
  try {
    const result = virtualFMO({ ws, view, unstained, populationId, channel, record: found.record, yChannel: other });
    let real = null;
    if (fmoView) {
      try {
        real = { sample: fmoSample, ...fmoThreshold({ ws, view: fmoView, populationId, channel, yChannel: other }) };
      } catch {
        real = null;
      }
    }
    entry = { result, real, source: found.source };
  } catch (error) {
    entry = { error: error.message };
  }
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(key, entry);
  return entry;
}

// The guides and the explanation of a plot: { guides, info (an element or null) }.
export function plotVirtualFMO(app, { spec, sample, view, dims, onGate, onReady, theme = 'light' }) {
  const { virtual: VIRTUAL_COLOR, real: REAL_COLOR } = COLORS[theme] ?? COLORS.light;
  const wanted = spec.options?.virtualFMO ?? [];
  if (!wanted.length || !sample) return { guides: [], info: null };
  const ws = app.store.ws;
  const guides = [];
  const lines = [];
  const axes = [{ axis: 'x', channel: spec.x, other: dims[1] ? spec.y : null }, ...(dims[1] ? [{ axis: 'y', channel: spec.y, other: spec.x }] : [])];
  for (const { axis, channel, other } of axes) {
    if (!wanted.includes(channel)) continue;
    const label = channelLabel(ws, channel, { short: true });
    const entry = compute(app, { sample, view, populationId: spec.populationId ?? ROOT, channel, other, onReady });
    if (!entry) {
      lines.push(h('div', `Virtual FMO of ${label}: unavailable (${virtualFMOAvailable(ws, sample, channel).reason}).`));
      continue;
    }
    if (entry.pending) {
      lines.push(h('div', `Virtual FMO of ${label}: loading the unstained control…`));
      continue;
    }
    if (entry.error) {
      lines.push(h('div', `Virtual FMO of ${label}: ${entry.error}`));
      continue;
    }
    const { result, real } = entry;
    const pct = `${(100 * result.quantile).toFixed(1)}%`;
    guides.push({ axis, value: result.threshold, color: VIRTUAL_COLOR, dash: true, label: 'virtual FMO' });
    if (result.curve?.length > 1) guides.push({ points: result.curve.map((c) => (axis === 'x' ? [c.threshold, c.y] : [c.y, c.threshold])), color: VIRTUAL_COLOR, dash: false, width: 1.2 });
    if (real) {
      guides.push({ axis, value: real.threshold, color: REAL_COLOR, dash: true, label: 'FMO', labelAt: 'bottom' });
      if (real.curve?.length > 1) guides.push({ points: real.curve.map((c) => (axis === 'x' ? [c.threshold, c.y] : [c.y, c.threshold])), color: REAL_COLOR, dash: false, width: 1.2 });
    }
    const top = result.contributions.slice(0, 2).map((c) => `${channelLabel(ws, c.channel, { short: true })} ${Math.round(100 * c.share)}%`).join(', ');
    const gateButton = h('button.btn.small', { type: 'button', style: { marginLeft: '6px' }, title: `A range gate on ${label} from the virtual FMO's threshold up`, onclick: () => onGate?.({ channel, threshold: result.threshold, axisIndex: axis === 'x' ? 0 : 1 }) }, 'Gate above it');
    lines.push(h('div',
      h('span.swatch', { style: { background: VIRTUAL_COLOR } }),
      `Virtual FMO of ${label}: ${pct} at ${formatNumber(result.threshold)}`,
      real ? ` · FMO control ${real.sample.name}: ${formatNumber(real.threshold)}` : '',
      ` · unstained alone: ${formatNumber(result.unstainedThreshold)}`,
      top ? ` · spread from ${top}` : '',
      gateButton));
  }
  if (lines.length) lines.push(h('div.muted', { style: { fontSize: '10.5px' } }, 'Predicted from the spread model: a guide where the negative ends, not a replacement for a real FMO on dim or critical markers.'));
  return { guides, info: lines.length ? lines : null };
}

// A range gate from a threshold up, on a channel of a plot (its display transform).
export function gateAbove(app, { spec, channel, threshold, transform }) {
  const ws = app.store.ws;
  const marker = ws.samples.flatMap((s) => s.channels).find((c) => c.name === channel)?.marker;
  const parentId = spec.populationId && spec.populationId !== ROOT ? spec.populationId : null;
  const name = uniqueGateName(ws, parentId, `${marker || channelLabel(ws, channel, { short: true })}+`);
  const forward = createTransform(transform).forward;
  const added = addGates(ws, [{ name, type: 'range', parentId, dims: [{ channel, transform }], geometry: { min: forward(threshold), max: null }, meta: { origin: 'virtual-fmo', created: new Date().toISOString(), note: `From the virtual FMO's ${(100 * DEFAULT_QUANTILE).toFixed(1)}th percentile` } }], 'add-gate');
  app.store.commit(added.ws, `Add ${name} above the virtual FMO`);
  return added.gates[0];
}
