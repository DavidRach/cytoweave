// Virtual FMO controls (C4): where a population's negative would fall in a channel if its dye were
// left out, predicted from the panel's spread model (spread.js) instead of stained as an FMO tube.
//
// In an FMO, a cell negative for dye X still has a value in X's channel: its autofluorescence and
// the electronic noise (what the unstained control shows), plus the spread every other dye on the
// cell adds to X's channel once compensated or unmixed. The spread model gives that second part
// per dye: photon noise, a variance of ΔF_i · Σ_d U_dX² s_id c1_d, and laser noise,
// ΔF_i² · Σ_L cv_L² (Σ_{d∈L} U_dX s_id)², where ΔF_i is the cell's brightness of dye i above the
// negative. So each event of the population gets the variance the other dyes would add from its
// own measured brightness of each, and its value without X is drawn as a value of the unstained
// control's matching events (the population's scatter gates applied to it) plus that spread, from
// a seeded normal (draws per event). The upper quantile of these values (99.5% by default) is the
// threshold an FMO would give; binned by another channel, it is the curve an FMO shows on a plot
// of X against it, rising with the brightness of the dyes that spread into X.
//
// The spread model comes from a spread record kept where the spread was fitted: a compensation
// computed from single-stain controls (compensation.spread) or the spectral setup's spreading
// (spreading.model), each { names, detectors, spectra, channels, noise }.

import { evaluateGate, population } from './engine.js';
import { createNormal } from './simulate.js';
import { createRandom } from './random.js';
import { noiseOn, spreadModel, spreadTerms } from './spread.js';

export { spreadRecord } from './spread.js';
import { ROOT, effectiveGeometry, gateAncestors, gateById } from './workspace.js';

export const DEFAULT_QUANTILE = 0.995;

// The spread records of a workspace: [{ id, label, record, applies(sample) }].
export function spreadRecords(ws) {
  const out = [];
  for (const comp of ws.compensations ?? []) {
    if (!comp.spread?.noise) continue;
    out.push({ id: comp.id, label: `the compensation "${comp.name}"`, record: comp.spread, applies: (sample) => sample.compensationId === comp.id });
  }
  const setup = (ws.derived ?? []).find((d) => d.kind === 'spectral-setup');
  const model = setup?.spreading?.model;
  if (model?.noise) out.push({ id: 'spectral-setup', label: 'the spectral setup', record: model, applies: () => true });
  return out;
}

// The spread record that covers a channel of a sample, as { source, record, j } (j: the dye's
// index), or null.
export function spreadFor(ws, sample, channel) {
  for (const source of spreadRecords(ws)) {
    if (!source.applies(sample)) continue;
    const j = source.record.channels.indexOf(channel);
    if (j >= 0) return { source, record: source.record, j };
  }
  return null;
}

// The population's scatter gates (and time gates) applied to another sample, such as the
// unstained control: its events that the population's gates on non-fluorescence channels keep.
// Returns { indices (or null for all events), gates (names applied), skipped (names left out) }.
export function scatterPopulation(ws, view, populationId) {
  const path = populationId && populationId !== ROOT ? [...gateAncestors(ws, populationId), gateById(ws, populationId)].filter(Boolean) : [];
  const applied = [];
  const skipped = [];
  let current = null;
  for (const gate of path) {
    const channels = (gate.dims ?? []).map((d) => d.channel);
    const nonFluorescent = gate.type !== 'boolean' && channels.length > 0 && channels.every((c) => {
      const type = view.channelInfo(c)?.type;
      return type === 'scatter' || type === 'time' || /^(FSC|SSC|Time)/i.test(c);
    });
    if (!nonFluorescent || !channels.every((c) => view.hasChannel(c))) {
      skipped.push(gate.name);
      continue;
    }
    current = evaluateGate(view, ws, gate, effectiveGeometry(gate, view.id), current);
    applied.push(gate.name);
  }
  return { indices: current ? view.indicesOf(current) : null, gates: applied, skipped };
}

const median = (values) => {
  const sorted = Float64Array.from(values).sort();
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN;
};

function quantileOf(values, q) {
  const sorted = Float64Array.from(values).sort();
  if (!sorted.length) return Number.NaN;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const pick = (column, indices) => (indices ? Float64Array.from(indices, (e) => column[e]) : Float64Array.from(column));

// Equal-count bins of y with the q-quantile of x in each: [{ y (median of the bin), threshold, n }].
function binnedThresholds(xs, ys, q, bins) {
  const order = Array.from(ys.keys()).sort((a, b) => ys[a] - ys[b]);
  const size = Math.max(50, Math.ceil(order.length / bins));
  const out = [];
  for (let start = 0; start < order.length; start += size) {
    const chunk = order.slice(start, start + size);
    if (chunk.length < Math.min(50, size)) break;
    out.push({ y: median(chunk.map((k) => ys[k])), threshold: quantileOf(chunk.map((k) => xs[k]), q), n: chunk.length });
  }
  return out;
}

// The virtual FMO of a population in a channel. args: { ws, view (the stained sample), unstained
// (the unstained control's view), populationId, channel, record (a spread record), quantile,
// draws (per event, default 4), seed, yChannel (for the curve), bins (default 20) }.
// Returns { channel, dye, threshold, quantile, events, curve, contributions: [{ dye, channel,
// share }], base: { events, gates, skipped }, virtual (the values drawn), method }.
export function virtualFMO(args) {
  const { ws, view, unstained, populationId = ROOT, channel, record } = args;
  const q = args.quantile ?? DEFAULT_QUANTILE;
  const draws = Math.max(1, Math.round(args.draws ?? 4));
  const model = spreadModel({ names: record.names, detectors: record.detectors, spectra: record.spectra });
  const noise = noiseOn(model, record.noise);
  if (!noise) throw new Error('The spread model\'s noise does not cover its detectors.');
  const j = record.channels.indexOf(channel);
  if (j < 0) throw new Error(`The spread model does not cover ${channel}.`);
  if (!unstained) throw new Error('A virtual FMO needs an unstained control (its autofluorescence and noise in the channel).');
  if (!unstained.hasChannel(channel)) throw new Error(`The unstained control has no ${channel}: unmix or compensate it as the samples are.`);
  // Each other dye's spread into channel j: photon variance per unit brightness, laser variance
  // per unit brightness squared.
  const photon = new Float64Array(model.F);
  const laser = new Float64Array(model.F);
  for (let i = 0; i < model.F; i += 1) {
    if (i === j) continue;
    const terms = spreadTerms(model, i, j);
    for (let d = 0; d < terms.photon.length; d += 1) photon[i] += terms.photon[d] * noise.c1[d];
    for (let k = 0; k < terms.laser.length; k += 1) laser[i] += terms.laser[k] * (noise.laserCV[k] ?? 0) ** 2;
  }
  // The unstained control's matching events: its values in channel j, and each dye's negative.
  const base = scatterPopulation(ws, unstained, populationId);
  const baseX = pick(unstained.column(channel), base.indices);
  if (baseX.length < 50) throw new Error(`Only ${baseX.length} events of the unstained control fall in the population's scatter gates.`);
  const others = record.channels.map((c, i) => (i !== j && (photon[i] > 0 || laser[i] > 0) && view.hasChannel(c) ? i : -1)).filter((i) => i >= 0);
  const negatives = new Float64Array(model.F);
  for (const i of others) negatives[i] = unstained.hasChannel(record.channels[i]) ? median(pick(unstained.column(record.channels[i]), base.indices)) : 0;
  // The population's events and their brightness of each other dye.
  const indices = population(view, ws, populationId);
  if (indices === undefined) throw new Error('The population does not apply to this sample.');
  const n = indices ? indices.length : view.eventCount;
  if (n < 20) throw new Error(`The population has only ${n} events.`);
  const columns = others.map((i) => view.column(record.channels[i]));
  const variance = new Float64Array(n);
  const byDye = new Float64Array(model.F);
  for (let k = 0; k < n; k += 1) {
    const e = indices ? indices[k] : k;
    let v = 0;
    others.forEach((i, m) => {
      const bright = Math.max(columns[m][e] - negatives[i], 0);
      const part = photon[i] * bright + laser[i] * bright * bright;
      v += part;
      byDye[i] += part;
    });
    variance[k] = v;
  }
  // Values without the dye: an unstained value plus the spread, drawn.
  const random = createRandom(args.seed ?? 1);
  const normal = createNormal(random);
  const virtual = new Float64Array(n * draws);
  for (let k = 0; k < n; k += 1) {
    const s = Math.sqrt(variance[k]);
    for (let r = 0; r < draws; r += 1) {
      const u = baseX[Math.floor(random() * baseX.length)];
      virtual[k * draws + r] = u + s * normal();
    }
  }
  const threshold = quantileOf(virtual, q);
  let curve = null;
  if (args.yChannel && view.hasChannel(args.yChannel)) {
    const yColumn = view.column(args.yChannel);
    const ys = new Float64Array(n * draws);
    for (let k = 0; k < n; k += 1) {
      const y = yColumn[indices ? indices[k] : k];
      for (let r = 0; r < draws; r += 1) ys[k * draws + r] = y;
    }
    curve = binnedThresholds(virtual, ys, q, args.bins ?? 20);
  }
  const total = byDye.reduce((a, b) => a + b, 0);
  const contributions = others.map((i) => ({ dye: record.names[i], channel: record.channels[i], share: total > 0 ? byDye[i] / total : 0 })).filter((c) => c.share > 0).sort((a, b) => b.share - a.share);
  const baseSpread = quantileOf(baseX, q);
  return {
    channel,
    dye: record.names[j],
    threshold,
    unstainedThreshold: baseSpread,
    quantile: q,
    events: n,
    draws,
    curve,
    contributions,
    base: { events: baseX.length, gates: base.gates, skipped: base.skipped },
    virtual,
    method: `Virtual FMO: each of the ${n} events' value in ${channel} without ${record.names[j]} drawn ${draws} times as a value of the unstained control's ${baseX.length} matching events plus the spread the other dyes add at the event's own brightness (photon and laser noise of the fitted spread model); threshold at the ${(100 * q).toFixed(1)}th percentile.`,
  };
}

// A real FMO's threshold for comparison: the q-quantile of the population's values in the
// channel in the FMO tube (and, with yChannel, binned as virtualFMO bins it).
export function fmoThreshold({ ws, view, populationId = ROOT, channel, quantile = DEFAULT_QUANTILE, yChannel = null, bins = 20 }) {
  const indices = population(view, ws, populationId);
  if (indices === undefined) throw new Error('The population does not apply to the FMO control.');
  const xs = pick(view.column(channel), indices);
  const out = { channel, threshold: quantileOf(xs, quantile), quantile, events: xs.length, curve: null };
  if (yChannel && view.hasChannel(yChannel)) out.curve = binnedThresholds(xs, pick(view.column(yChannel), indices), quantile, bins);
  return out;
}

// The FMO control of a channel among the workspace's samples (role "fmo", its stain the channel,
// or its omitted marker the channel's), or null.
export function fmoControlFor(ws, channel, marker = null) {
  return ws.samples.find((s) => s.role === 'fmo' && (s.stain === channel || (marker && String(s.meta?.marker ?? '').toLowerCase() === String(marker).toLowerCase()))) ?? null;
}
