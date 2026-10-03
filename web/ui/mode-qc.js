// QC: acquisition quality control of every sample (PeacoQC, a flowAI-style flow-rate check,
// margin events and signal drift), batch normalization (CytoNorm; bead normalization for mass
// cytometry), debarcoding of barcoded samples, and the instrument's Q and B (qc-instrument.js). The computations run in the QC worker and the
// results are derived channels — a 0/1 "QC pass" mask, "<channel> (norm)", "Barcode" — so nothing
// is removed from the data, everything can be gated on, and every step can be undone.

import { h, icon, clear, debounce, formatBytes, formatCount, formatPercent } from './dom.js';
import { confirmDialog, progressToast, toast } from './overlays.js';
import { channelTransform } from '../lib/engine.js';
import { ROOT, addDerived, addGates, addGroup, channelLabel, setCollection, updateSample } from '../lib/workspace.js';
import { writeFCS } from '../lib/fcs.js';
import { combinationKey, normalizeKey } from '../lib/debarcode.js';
import { confoundingCheck, findMassChannel } from '../lib/normalize.js';
import { applyTransform, createTransform } from '../lib/transforms.js';
import { histogram } from '../lib/density.js';
import { categoricalColor } from '../lib/colormaps.js';
import { createRandom, sampleIndices } from '../lib/random.js';
import { createInstrumentSection } from './qc-instrument.js';

const QC_CHANNEL = 'QC pass';
const BEAD_CHANNEL = 'Bead';
const BARCODE_CHANNEL = 'Barcode';
const NORM_SUFFIX = ' (norm)';
const BEAD_SUFFIX = ' (beads)';
const PALLADIUM = ['Pd102', 'Pd104', 'Pd105', 'Pd106', 'Pd108', 'Pd110'];
const CLUSTER_PATTERN = /cluster|flowsom|\bsom\b|leiden|louvain|phenograph|k-?means/i;
const QC_GREEN = '#1f9d55';

const CITE = {
  peacoqc: 'PeacoQC: Emmaneel et al., Cytometry A 2022, doi:10.1002/cyto.a.24501',
  flowai: 'flowAI: Monaco et al., Bioinformatics 2016, doi:10.1093/bioinformatics/btw191',
  cytonorm: 'CytoNorm: Van Gassen et al., Cytometry A 2020, doi:10.1002/cyto.a.23904',
  beads: 'Bead normalization: Finck et al., Cytometry A 2013, doi:10.1002/cyto.a.22271',
  debarcode: 'Single-cell debarcoding: Zunder et al., Nat Protoc 2015, doi:10.1038/nprot.2014.090',
};

const DEFAULT_SETTINGS = {
  scope: 'all',
  includeControls: false,
  channels: 'auto',
  methods: { peacoQC: true, flowRate: true, margins: true, drift: true },
  mad: 6,
  itLimit: 0.6,
  consecutiveBins: 5,
  variant: 'refined',
};

const SECTIONS = [
  { id: 'clean', label: 'Clean', icon: 'qc', title: 'Acquisition QC: clogs, bursts, drift and saturated events' },
  { id: 'normalize', label: 'Normalize', icon: 'layers', title: 'Batch normalization with reference samples' },
  { id: 'debarcode', label: 'Debarcode', icon: 'tag', title: 'Split barcoded samples' },
  { id: 'instrument', label: 'Instrument', icon: 'gauge', title: 'Detector efficiency Q and background B from beads, and Levey–Jennings charts across runs' },
];

// --- Small helpers ------------------------------------------------------------------------------

function cssColors() {
  const style = getComputedStyle(document.documentElement);
  const get = (name) => style.getPropertyValue(name).trim();
  return {
    text: get('--text'), text2: get('--text-2'), text3: get('--text-3'), line: get('--line'), bg: get('--plot-bg'),
    panel2: get('--panel-2'), accent: get('--accent'), accent2: get('--accent-2'), ok: get('--ok'), warn: get('--warn'), danger: get('--danger'),
  };
}

function alpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
  if (!m) return color;
  const n = Number.parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function niceTicks(lo, hi, count = 5) {
  const span = hi - lo;
  if (!(span > 0) || !Number.isFinite(span)) return [lo];
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const step = (unit < 1.5 ? 1 : unit < 3 ? 2 : unit < 7 ? 5 : 10) * power;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(10));
  return out;
}

function formatSeconds(t) {
  const abs = Math.abs(t);
  return abs >= 100 ? t.toFixed(0) : abs >= 10 ? t.toFixed(1) : t.toFixed(2);
}

function scoreKind(score) {
  return score >= 90 ? 'ok' : score >= 70 ? 'warn' : 'danger';
}

function scoreBadge(score) {
  return h(`span.badge.qc-score.${scoreKind(score)}`, { title: 'Quality score, 0–100 (100 = nothing to flag)' }, String(score));
}

function downsample(values, n) {
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

function mergeSpans(spans) {
  const sorted = spans.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function choose(n, k) {
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
  return Math.round(result);
}

function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function sameSet(a = [], b = []) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

// The x domain of a QC result: seconds when the file has a time channel, else event numbers.
function timeDomain(result) {
  const flow = result.flowRate;
  if (flow) return { lo: flow.start, hi: flow.end, unit: 's' };
  const bins = result.peacoQC?.bins ?? [];
  if (bins.length && bins[0].time) return { lo: bins[0].time[0], hi: bins[bins.length - 1].time[1], unit: 's' };
  return { lo: 0, hi: bins.length ? bins[bins.length - 1].end : 1, unit: 'events' };
}

function binSpan(bin, unit) {
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

function paramsOf(settings) {
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
function summaryOf(result, sample, params) {
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

function toInt32(column) {
  const out = new Int32Array(column.length);
  for (let i = 0; i < column.length; i += 1) out[i] = Number.isFinite(column[i]) ? Math.round(column[i]) : -1;
  return out;
}

// --- Drawing ----------------------------------------------------------------------------------

function drawXTicks(ctx, c, pad, w, hgt, lo, hi, unit) {
  const ticks = niceTicks(lo, hi, Math.max(2, Math.floor((w - pad.l - pad.r) / 90)));
  ctx.fillStyle = c.text3;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of ticks) {
    const x = pad.l + ((t - lo) / (hi - lo || 1)) * (w - pad.l - pad.r);
    if (x < pad.l - 1 || x > w - pad.r + 1) continue;
    ctx.fillRect(x, hgt - pad.b, 1, 3);
    ctx.fillText(unit === 's' ? `${formatSeconds(t)} s` : unit === 'events' ? formatCount(t) : String(+t.toPrecision(4)), x, hgt - pad.b + 4);
  }
}

function drawSpark(ctx, w, hgt, c, spark) {
  const X = (v) => ((v - spark.lo) / (spark.hi - spark.lo || 1)) * w;
  ctx.fillStyle = alpha(c.danger, 0.22);
  for (const [a, b] of spark.removed) ctx.fillRect(X(a), 0, Math.max(1.5, X(b) - X(a)), hgt);
  const values = spark.values;
  let lo = spark.kind === 'rate' ? 0 : Math.min(...values);
  let hi = Math.max(...values);
  if (!(hi > lo)) {
    hi = lo + 1;
    lo -= 1;
  }
  if (spark.kind !== 'rate') {
    const span = hi - lo;
    lo -= span * 0.1;
    hi += span * 0.1;
  }
  const pad = 3;
  const Y = (v) => hgt - pad - ((v - lo) / (hi - lo)) * (hgt - 2 * pad);
  const xOf = (i) => ((i + 0.5) / values.length) * w;
  ctx.beginPath();
  values.forEach((v, i) => (i ? ctx.lineTo(xOf(i), Y(v)) : ctx.moveTo(xOf(i), Y(v))));
  if (spark.kind === 'rate') {
    ctx.lineTo(xOf(values.length - 1), hgt);
    ctx.lineTo(xOf(0), hgt);
    ctx.closePath();
    ctx.fillStyle = alpha(c.accent, 0.14);
    ctx.fill();
    ctx.beginPath();
    values.forEach((v, i) => (i ? ctx.lineTo(xOf(i), Y(v)) : ctx.moveTo(xOf(i), Y(v))));
  }
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.lineWidth = 1;
}

const REMOVAL_COLORS = (c) => ({ isolationTree: c.danger, mad: c.warn, consecutive: c.text3 });

function drawPeakTrack(ctx, w, hgt, c, result, channel, label) {
  const peaco = result.peacoQC;
  const track = peaco.channelTracks[channel];
  const domain = timeDomain(result);
  const pad = { l: 46, r: 10, t: 20, b: 20 };
  const pw = w - pad.l - pad.r;
  const ph = hgt - pad.t - pad.b;
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, hgt);
  const X = (v) => pad.l + ((v - domain.lo) / (domain.hi - domain.lo || 1)) * pw;
  const colors = REMOVAL_COLORS(c);
  for (const bin of peaco.bins) {
    if (!bin.removedBy.length) continue;
    const [a, b] = binSpan(bin, domain.unit);
    ctx.fillStyle = alpha(colors[bin.removedBy[0]] ?? c.danger, 0.17);
    ctx.fillRect(X(a), pad.t, Math.max(1, X(b) - X(a)), ph);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const peaks of track.peaks) for (const v of peaks) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!(hi > lo)) {
    hi = lo + 0.05;
    lo -= 0.05;
  }
  const span = hi - lo;
  lo -= span * 0.15;
  hi += span * 0.15;
  const Y = (v) => pad.t + ph - ((v - lo) / (hi - lo)) * ph;
  // Y ticks from the channel's scale.
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  try {
    const ticks = createTransform(track.transform).ticks().filter((t) => t.major && t.label && t.position >= lo && t.position <= hi);
    for (const tick of ticks) {
      const y = Y(tick.position);
      ctx.fillStyle = alpha(c.text3, 0.18);
      ctx.fillRect(pad.l, y, pw, 1);
      ctx.fillStyle = c.text3;
      ctx.fillText(tick.label, pad.l - 5, y);
    }
  } catch {
    // A scale without ticks: leave the axis bare.
  }
  const xs = peaco.bins.map((bin) => {
    const [a, b] = binSpan(bin, domain.unit);
    return X((a + b) / 2);
  });
  track.peaks.forEach((peaks, j) => {
    ctx.strokeStyle = alpha(c.text3, 0.7);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(track.medians[j]));
    ctx.lineTo(w - pad.r, Y(track.medians[j]));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = j % 2 ? c.accent2 : c.accent;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let b = 0; b < peaks.length; b += 1) {
      const y = Y(peaks[b]);
      if (b) ctx.lineTo(xs[b], y);
      else ctx.moveTo(xs[b], y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  });
  ctx.fillStyle = c.text;
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(label, pad.l, 4);
  ctx.fillStyle = c.text3;
  ctx.font = '10.5px system-ui, sans-serif';
  ctx.textAlign = 'right';
  const peaksText = `${track.peaks.length} peak${track.peaks.length === 1 ? '' : 's'} followed · MAD flags ${track.madContribution.toFixed(1)}% of bins`;
  ctx.fillText(peaksText, w - pad.r, 5);
  drawXTicks(ctx, c, pad, w, hgt, domain.lo, domain.hi, domain.unit);
}

function drawRateTrack(ctx, w, hgt, c, result) {
  const flow = result.flowRate;
  const domain = timeDomain(result);
  const pad = { l: 46, r: 10, t: 20, b: 20 };
  const pw = w - pad.l - pad.r;
  const ph = hgt - pad.t - pad.b;
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, hgt);
  const X = (v) => pad.l + ((v - domain.lo) / (domain.hi - domain.lo || 1)) * pw;
  ctx.fillStyle = alpha(c.danger, 0.18);
  for (const episode of flow.episodes) ctx.fillRect(X(episode.startTime), pad.t, Math.max(1.5, X(episode.endTime) - X(episode.startTime)), ph);
  // PeacoQC's removed stretches as a strip along the bottom, to compare the two methods.
  ctx.fillStyle = alpha(c.warn, 0.55);
  for (const bin of result.peacoQC?.bins ?? []) {
    if (!bin.removedBy.length) continue;
    const [a, b] = binSpan(bin, domain.unit);
    ctx.fillRect(X(a), pad.t + ph - 4, Math.max(1, X(b) - X(a)), 4);
  }
  const n = flow.rate.length;
  const buckets = Math.max(1, Math.min(n, Math.floor(pw)));
  const values = new Float64Array(buckets);
  const centers = new Float64Array(buckets);
  for (let i = 0; i < buckets; i += 1) {
    const a = Math.floor((i * n) / buckets);
    const b = Math.max(a + 1, Math.floor(((i + 1) * n) / buckets));
    let sum = 0;
    for (let k = a; k < b; k += 1) sum += flow.rate[k];
    values[i] = sum / (b - a);
    centers[i] = flow.start + ((a + b) / 2) * flow.sliceSeconds;
  }
  let top = 0;
  for (const v of values) if (v > top) top = v;
  top = Math.max(top, 2 * flow.medianRate, 1) * 1.08;
  const Y = (v) => pad.t + ph - (Math.min(v, top) / top) * ph;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const t of niceTicks(0, top, 3)) {
    ctx.fillStyle = alpha(c.text3, 0.18);
    ctx.fillRect(pad.l, Y(t), pw, 1);
    ctx.fillStyle = c.text3;
    ctx.fillText(formatCount(t), pad.l - 5, Y(t));
  }
  ctx.strokeStyle = alpha(c.text3, 0.8);
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(pad.l, Y(flow.medianRate));
  ctx.lineTo(w - pad.r, Y(flow.medianRate));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let i = 0; i < buckets; i += 1) {
    const x = X(centers[i]);
    if (i) ctx.lineTo(x, Y(values[i]));
    else ctx.moveTo(x, Y(values[i]));
  }
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = c.text;
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Events per second', pad.l, 4);
  ctx.fillStyle = c.text3;
  ctx.font = '10.5px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`median ${formatCount(flow.medianRate)}/s · ${formatSeconds(flow.sliceSeconds)} s slices`, w - pad.r, 5);
  drawXTicks(ctx, c, pad, w, hgt, domain.lo, domain.hi, domain.unit);
}

function drawEmdBars(ctx, w, hgt, c, entry, batches, top) {
  const pad = { l: 2, r: 2, t: 4, b: 14 };
  const ph = hgt - pad.t - pad.b;
  const group = (w - pad.l - pad.r) / batches.length;
  ctx.fillStyle = alpha(c.text3, 0.25);
  ctx.fillRect(pad.l, pad.t + ph, w - pad.l - pad.r, 1);
  batches.forEach((batch, i) => {
    const x0 = pad.l + i * group;
    const bar = Math.max(2, Math.min(14, group * 0.3));
    const before = entry.before?.[batch]?.emd ?? 0;
    const after = entry.after?.[batch]?.emd;
    const hb = (before / top) * ph;
    ctx.fillStyle = alpha(c.text3, 0.5);
    ctx.fillRect(x0 + group / 2 - bar - 1, pad.t + ph - hb, bar, hb);
    if (after !== undefined) {
      const ha = (after / top) * ph;
      ctx.fillStyle = c.accent;
      ctx.fillRect(x0 + group / 2 + 1, pad.t + ph - ha, bar, ha);
    }
    ctx.fillStyle = c.text3;
    ctx.font = '9.5px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const text = String(batch);
    ctx.fillText(text.length > 8 ? `${text.slice(0, 7)}…` : text, x0 + group / 2, pad.t + ph + 2);
  });
}

function drawDensities(ctx, w, hgt, c, curves, transform, title) {
  const pad = { l: 8, r: 8, t: 20, b: 20 };
  const pw = w - pad.l - pad.r;
  const ph = hgt - pad.t - pad.b;
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, hgt);
  let top = 0;
  for (const curve of curves) for (const v of curve.values) if (v > top) top = v;
  top = top || 1;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const tick of transform.ticks()) {
    if (!tick.major || !tick.label || tick.position < 0 || tick.position > 1) continue;
    const x = pad.l + tick.position * pw;
    ctx.fillStyle = alpha(c.text3, 0.18);
    ctx.fillRect(x, pad.t, 1, ph);
    ctx.fillStyle = c.text3;
    ctx.fillText(tick.label, x, hgt - pad.b + 4);
  }
  for (const curve of curves) {
    ctx.strokeStyle = curve.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    curve.values.forEach((v, i) => {
      const x = pad.l + ((i + 0.5) / curve.values.length) * pw;
      const y = pad.t + ph - (v / top) * ph;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  ctx.fillStyle = c.text;
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, pad.l, 4);
}

function drawBeadTrack(ctx, w, hgt, c, result, channel) {
  const track = result.beadTracks[channel];
  const times = result.beadTimes;
  const n = times.length;
  const pad = { l: 40, r: 8, t: 18, b: 20 };
  const pw = w - pad.l - pad.r;
  const ph = hgt - pad.t - pad.b;
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, hgt);
  if (!n) return;
  const f = (v) => Math.asinh(v / 5);
  const sorted = Float64Array.from(track.raw, f).sort();
  let lo = Math.min(sorted[Math.floor(0.01 * (n - 1))], f(result.baseline[channel]));
  let hi = Math.max(sorted[Math.floor(0.99 * (n - 1))], f(result.baseline[channel]));
  const span = hi - lo || 1;
  lo -= span * 0.15;
  hi += span * 0.15;
  const t0 = times[0];
  const t1 = times[n - 1];
  const X = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * pw;
  const Y = (v) => pad.t + ph - ((f(v) - lo) / (hi - lo)) * ph;
  ctx.fillStyle = alpha(c.text3, 0.35);
  const step = Math.max(1, Math.ceil(n / 1500));
  for (let i = 0; i < n; i += step) ctx.fillRect(X(times[i]) - 0.8, Y(track.raw[i]) - 0.8, 1.6, 1.6);
  const line = (values, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    const s = Math.max(1, Math.floor(n / pw));
    for (let i = 0; i < n; i += s) (i ? ctx.lineTo(X(times[i]), Y(values[i])) : ctx.moveTo(X(times[i]), Y(values[i])));
    ctx.stroke();
    ctx.lineWidth = 1;
  };
  line(track.smoothed, c.danger, 1.5);
  line(track.normalized, c.ok, 1.8);
  ctx.strokeStyle = c.text2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(pad.l, Y(result.baseline[channel]));
  ctx.lineTo(w - pad.r, Y(result.baseline[channel]));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = c.text;
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(channel, pad.l, 3);
  ctx.fillStyle = c.text3;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of niceTicks(Math.sinh(lo) * 5, Math.sinh(hi) * 5, 3)) {
    if (v <= 0) continue;
    const y = Y(v);
    if (y < pad.t || y > pad.t + ph) continue;
    ctx.fillText(formatCount(v), pad.l - 4, y);
  }
  drawXTicks(ctx, c, pad, w, hgt, t0, t1, result.timeChannel ? 'time' : 'events');
}

function drawYield(ctx, w, hgt, c, run, cutoff) {
  const { yields } = run.result;
  const pad = { l: 40, r: 12, t: 14, b: 26 };
  const pw = w - pad.l - pad.r;
  const ph = hgt - pad.t - pad.b;
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, w, hgt);
  const X = (v) => pad.l + v * pw;
  const Y = (v) => pad.t + ph - v * ph;
  ctx.font = '10px system-ui, sans-serif';
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    ctx.fillStyle = alpha(c.text3, 0.18);
    ctx.fillRect(pad.l, Y(v), pw, 1);
    ctx.fillStyle = c.text3;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(v * 100)}%`, pad.l - 5, Y(v));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let v = 0; v <= 1.0001; v += 0.1) ctx.fillText(v.toFixed(1), X(v), hgt - pad.b + 4);
  ctx.fillText('Separation cutoff', pad.l + pw / 2, hgt - 11);
  const grid = yields.cutoffs;
  const path = (values, scale) => {
    ctx.beginPath();
    for (let j = 0; j < grid.length; j += 1) {
      const y = Y(scale ? values[j] / scale : 0);
      if (j) ctx.lineTo(X(grid[j]), y);
      else ctx.moveTo(X(grid[j]), y);
    }
  };
  yields.fractions.forEach((fractions, p) => {
    if (!yields.counts[p][0]) return;
    ctx.strokeStyle = alpha(categoricalColor(p), 0.55);
    ctx.lineWidth = 1.1;
    path(fractions, 1);
    ctx.stroke();
  });
  ctx.strokeStyle = c.text;
  ctx.lineWidth = 2.2;
  path(yields.total, yields.total[0]);
  ctx.stroke();
  ctx.lineWidth = 1;
  const x = X(cutoff);
  ctx.strokeStyle = c.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, pad.t);
  ctx.lineTo(x, pad.t + ph);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = c.accent;
  ctx.beginPath();
  ctx.arc(x, pad.t + 2, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = x > w - 90 ? 'right' : 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`cutoff ${cutoff.toFixed(2)}`, x + (x > w - 90 ? -7 : 7), pad.t + 2);
  return { pad, pw };
}

// --- The mode ---------------------------------------------------------------------------------

export function mountQCMode(app, container) {
  const { store, data } = app;
  // Session state survives switching modes; the workspace keeps the saved results.
  const S = (app.qcState ??= {
    section: 'clean',
    results: new Map(),
    selectedId: null,
    settings: structuredClone(DEFAULT_SETTINGS),
    detailChannels: null,
    comparison: null,
    norm: { channels: null, clustering: '', cofactor: null, nQ: 99, goal: 'mean', acknowledged: false, ackKey: '', result: null, histChannel: null },
    beads: { sampleId: null, scope: 'sample', baseline: 'file', results: new Map(), shownId: null },
    debarcode: { sampleId: null, channels: null, k: 3, keyMode: 'combination', csv: '', cofactor: 10, cutoff: 0.3, mahalanobis: 30, run: null, updating: false },
  });
  const worker = app.worker('qc');
  const jobs = new Set();
  const live = new Set();
  let running = null;
  let destroyed = false;
  let renderScheduled = false;
  let cardsScheduled = false;

  const segmented = h('div.segmented', { role: 'tablist' });
  const sectionHost = h('div');
  const root = h('div.view',
    h('div.workbench-head', h('h1', icon('qc'), 'Quality control'), segmented, h('span.spacer'),
      h('span.muted', { style: { fontSize: '12px' } }, 'Results are new channels; your data are never changed.')),
    h('div.view-body', sectionHost));
  container.append(root);

  // --- Canvases ---------------------------------------------------------------------------------

  function chart(height, draw, className = '') {
    const canvas = h(`canvas.qc-canvas${className ? `.${className}` : ''}`, { style: { height: `${height}px` } });
    const entry = { canvas, draw, height, layout: null };
    live.add(entry);
    requestAnimationFrame(() => paint(entry));
    canvas.entry = entry;
    return canvas;
  }

  function paint(entry, colors = cssColors()) {
    const { canvas } = entry;
    if (!canvas.isConnected) {
      live.delete(entry);
      return;
    }
    const w = canvas.clientWidth || 300;
    const hgt = entry.height;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    entry.layout = entry.draw(ctx, w, hgt, colors) ?? null;
    entry.width = w;
  }

  function repaintAll() {
    const colors = cssColors();
    for (const entry of [...live]) paint(entry, colors);
  }

  const resizer = new ResizeObserver(debounce(() => { if (!destroyed) repaintAll(); }, 120));
  resizer.observe(root);

  function track(job) {
    jobs.add(job);
    job.promise.finally(() => jobs.delete(job)).catch(() => {});
    return job;
  }

  const instrumentSection = createInstrumentSection({ app, chart, alpha, rerender: () => scheduleRender() });

  // --- Rendering ------------------------------------------------------------------------------

  function renderTabs() {
    clear(segmented);
    for (const section of SECTIONS) {
      segmented.append(h(`button${S.section === section.id ? '.active' : ''}`, {
        type: 'button',
        role: 'tab',
        title: section.title,
        onclick: () => {
          if (S.section === section.id) return;
          S.section = section.id;
          render();
        },
      }, icon(section.icon), section.label));
    }
  }

  function render() {
    renderScheduled = false;
    if (destroyed) return;
    renderTabs();
    const scroll = root.querySelector('.view-body')?.scrollTop ?? 0;
    clear(sectionHost);
    if (!store.ws.samples.length) {
      sectionHost.append(h('div.empty', icon('qc'), h('h3', 'Quality control, batch normalization and debarcoding'),
        h('p', 'Check every sample for acquisition problems (clogs, bubbles, bursts, drifting signal and saturated events), align batches with reference samples, and split barcoded mass-cytometry samples. Add FCS files to begin: drag them onto the window or use Open.')));
      return;
    }
    if (S.section === 'normalize') renderNormalize();
    else if (S.section === 'debarcode') renderDebarcode();
    else if (S.section === 'instrument') instrumentSection.render(sectionHost);
    else renderClean();
    const body = root.querySelector('.view-body');
    if (body) body.scrollTop = scroll;
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(render);
  }

  function citations(...keys) {
    return h('div.qc-cite', keys.map((key) => h('div', CITE[key])));
  }

  function explain(...parts) {
    return h('p.qc-explain', ...parts);
  }

  // ===========================================================================================
  // Clean: acquisition QC
  // ===========================================================================================

  let controlsHost = null;
  let gridHost = null;
  let detailHost = null;

  function cleanSamples() {
    return store.ws.samples.filter((s) => S.settings.includeControls || s.role === 'sample' || s.role === 'reference');
  }

  function qcRecord() {
    return store.ws.derived.find((d) => d.kind === 'qc' && d.outputs?.includes(QC_CHANNEL)) ?? null;
  }

  function qcGate() {
    return store.ws.gates.find((g) => g.type === 'category' && g.dims?.[0]?.channel === QC_CHANNEL) ?? null;
  }

  // What a card shows: the saved summary, or this session's result when it is not saved (undone).
  function cardInfo(sampleId) {
    const saved = qcRecord()?.summary?.perSample?.[sampleId];
    if (saved && qcRecord().files?.[sampleId]) return saved;
    const session = S.results.get(sampleId);
    return session ? { ...session.persisted, unsaved: true } : null;
  }

  function scopeSamples() {
    const all = cleanSamples();
    const scope = S.settings.scope;
    if (scope === 'selection') return all.filter((s) => store.ui.selectedSamples.has(s.id));
    if (scope === 'unchecked') return all.filter((s) => !cardInfo(s.id));
    if (scope.startsWith('group:')) {
      const group = store.ws.groups.find((g) => `group:${g.id}` === scope);
      return group ? all.filter((s) => group.sampleIds.includes(s.id)) : [];
    }
    return all;
  }

  function renderClean() {
    controlsHost = h('div');
    gridHost = h('div');
    detailHost = h('div.qc-detail');
    sectionHost.append(
      h('div.pane', controlsHost),
      h('div.qc-layout', h('div.qc-cards', gridHost), detailHost));
    renderControls();
    renderCards();
    renderDetail();
  }

  function renderControls() {
    if (!controlsHost) return;
    clear(controlsHost);
    const ws = store.ws;
    const settings = S.settings;
    const all = cleanSamples();
    const list = scopeSamples();
    const selected = all.filter((s) => store.ui.selectedSamples.has(s.id)).length;
    const unchecked = all.filter((s) => !cardInfo(s.id)).length;
    const scope = h('select.input.small', { onchange: (event) => { settings.scope = event.target.value; renderControls(); } },
      h('option', { value: 'all', selected: settings.scope === 'all' }, `All samples (${all.length})`),
      h('option', { value: 'unchecked', selected: settings.scope === 'unchecked' }, `Not yet checked (${unchecked})`),
      h('option', { value: 'selection', selected: settings.scope === 'selection' }, `Selected in the sample list (${selected})`),
      ...ws.groups.map((g) => h('option', { value: `group:${g.id}`, selected: settings.scope === `group:${g.id}` }, `Group: ${g.name} (${all.filter((s) => g.sampleIds.includes(s.id)).length})`)));
    const method = (key, label, title) => h('label.check', { title },
      h('input', { type: 'checkbox', checked: settings.methods[key], onchange: (event) => { settings.methods[key] = event.target.checked; renderControls(); } }), label);
    const anyMethod = Object.values(settings.methods).some(Boolean);
    const runButton = running
      ? h('button.btn.small', { type: 'button', onclick: () => cancelRun() }, icon('stop'), 'Stop')
      : h('button.btn.primary.small', { type: 'button', disabled: !list.length || !anyMethod, onclick: () => runSamples(list) }, icon('play'), `Run QC on ${list.length} sample${list.length === 1 ? '' : 's'}`);
    const record = qcRecord();
    const gate = qcGate();
    let gateRow = null;
    if (gate) {
      gateRow = h('div.callout.ok', icon('check'),
        h('span.grow', 'A “QC pass” gate is at the top of the gating tree: every population below it uses only events that passed QC.'),
        h('button.btn.small', { type: 'button', onclick: () => app.selectGate(gate.id) }, 'Show'));
    } else if (record) {
      gateRow = h('div.callout.accent', icon('gate'),
        h('span.grow', 'Use the result in your gating: a category gate on “QC pass” = 1 becomes the root and your existing gates move beneath it. Undo restores the tree.'),
        h('button.btn.small.primary', { type: 'button', onclick: () => addQCGate() }, 'Add a “QC pass” gate at the top'));
    }
    controlsHost.append(
      h('h3', icon('qc'), 'Acquisition quality control', h('span.spacer'), record ? h('span.badge.ok', `${Object.keys(record.files ?? {}).length} checked`) : null),
      explain('Finds events recorded while the fluidics misbehaved — clogs, bubbles, bursts, a drifting signal — and events at the detector limits. ',
        h('b', 'PeacoQC'), ' follows the density peaks of every channel in bins of consecutive events and flags bins whose peaks jump (isolation tree) or drift away (MAD) — by default with CytoWeave’s safeguards against false removals in clean data, or as published (choose under Sensitivity); ',
        h('b', 'the flow-rate check'), ' (after flowAI) flags 0.1 s slices with abnormal event rates; ',
        h('b', 'margin events'), ' are saturated at $PnR − 1 or piled at the lowest value. Nothing is deleted: the result is a “QC pass” channel (1 = keep) to gate on.'),
      h('div.qc-toolbar',
        h('label.field', h('span', 'Samples'), scope),
        h('label.field', h('span', 'Channels'), h('select.input.small', { onchange: (event) => { settings.channels = event.target.value; } },
          h('option', { value: 'auto', selected: settings.channels === 'auto' }, 'Scatter and fluorescence (markers only for mass cytometry)'),
          h('option', { value: 'all', selected: settings.channels === 'all' }, 'All scatter and fluorescence channels'),
          h('option', { value: 'markers', selected: settings.channels === 'markers' }, 'Scatter and channels with a marker'))),
        h('div.field', h('span', 'Methods'), h('div.row', { style: { flexWrap: 'wrap', gap: '4px 12px', minHeight: '26px' } },
          method('peacoQC', 'PeacoQC', 'Peak trajectories per channel; isolation tree + MAD'),
          method('flowRate', 'Flow rate', 'Events per 0.1 s; generalized ESD test (needs a time channel)'),
          method('margins', 'Margin events', 'Saturated or piled-up events per channel'),
          method('drift', 'Drift', 'Median per time bin; fold change start → end (reported, not removed)'))),
        h('label.check', { style: { marginBottom: '6px' } }, h('input', { type: 'checkbox', checked: settings.includeControls, onchange: (event) => { settings.includeControls = event.target.checked; renderCards(); renderControls(); } }), 'Include controls'),
        h('span.grow'),
        h('div.field', h('span', ' '), runButton)),
      gateRow ? h('div', { style: { marginTop: '10px' } }, gateRow) : null);
  }

  function renderCards() {
    cardsScheduled = false;
    if (destroyed || S.section !== 'clean' || !gridHost) return;
    clear(gridHost);
    const samples = cleanSamples();
    if (!samples.length) {
      gridHost.append(h('div.empty', icon('qc'), h('h3', 'No samples to check'), h('p', 'Only controls are loaded. Tick “Include controls” to check them too.')));
      return;
    }
    const grid = h('div.qc-grid');
    for (const sample of samples) grid.append(card(sample));
    gridHost.append(grid);
  }

  function scheduleCards() {
    if (cardsScheduled) return;
    cardsScheduled = true;
    requestAnimationFrame(renderCards);
  }

  function card(sample) {
    const info = cardInfo(sample.id);
    const isRunning = running?.sampleId === sample.id;
    const status = data.statusOf(sample.id);
    const findings = (info?.findings ?? []).filter((f) => f.method !== 'summary');
    const shown = findings.slice(0, 2);
    return h(`div.qc-card${S.selectedId === sample.id ? '.selected' : ''}${isRunning ? '.running' : ''}`, {
      tabIndex: 0,
      onclick: () => selectCard(sample.id),
      onkeydown: (event) => { if (event.key === 'Enter') selectCard(sample.id); },
    },
    h('div.qc-card-head',
      h('span.qc-card-name', { title: sample.name }, sample.name),
      isRunning ? h('span.badge.accent', 'checking…') : info ? scoreBadge(info.score) : h('span.badge', status === 'missing' ? 'file missing' : 'not checked')),
    h('div.qc-card-meta',
      info ? h('span', `${formatPercent(info.percentRemoved)} removed`) : null,
      h('span', `${formatCount(info?.eventCount ?? sample.eventCount)} events`),
      sample.role !== 'sample' ? h('span.badge', sample.role) : null,
      sample.meta?.batch ? h('span.badge', `batch ${sample.meta.batch}`) : null,
      info?.unsaved ? h('span.badge.warn', { title: 'This result was undone; run again or redo to save it.' }, 'not saved') : null),
    info?.sparkline
      ? chart(38, (ctx, w, hgt, c) => drawSpark(ctx, w, hgt, c, info.sparkline), 'qc-spark')
      : h('div.qc-spark.qc-spark-empty', info ? '' : 'Run QC to see the event rate and what is flagged'),
    info
      ? (shown.length
        ? h('ul.qc-findings', shown.map((f) => h(`li.${f.severity === 'warning' ? 'warn' : 'info'}`, f.text)), findings.length > 2 ? h('li.more', `+${findings.length - 2} more`) : null)
        : h('div.qc-clean', icon('check'), 'No problems found'))
      : null);
  }

  function selectCard(id) {
    S.selectedId = S.selectedId === id ? null : id;
    S.comparison = null;
    renderCards();
    renderDetail();
  }

  // --- Detail ---------------------------------------------------------------------------------

  function renderDetail() {
    if (!detailHost) return;
    clear(detailHost);
    const ws = store.ws;
    const sample = ws.samples.find((s) => s.id === S.selectedId);
    if (!sample) {
      detailHost.append(cohortOverview());
      return;
    }
    const info = cardInfo(sample.id);
    const result = S.results.get(sample.id) ?? null;
    const pane = h('div.pane');
    pane.append(h('h3', h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sample.name), info ? scoreBadge(info.score) : null, h('span.spacer'),
      h('button.btn.small', { type: 'button', title: 'Open this sample in the gating view', onclick: () => { app.selectSample(sample.id); app.setMode('gate'); } }, icon('gate'), 'Gate'),
      h('button.btn.small', { type: 'button', disabled: Boolean(running), onclick: () => runSamples([sample]) }, icon('play'), info ? 'Re-run' : 'Run'),
      h('button.icon-button.small', { type: 'button', title: 'Back to the overview', onclick: () => selectCard(sample.id) }, icon('close'))));
    if (!info) {
      pane.append(h('div.empty', icon('qc'), h('h3', 'Not checked yet'), h('p', 'Run QC on this sample to see how its signal and event rate behaved over the acquisition.')));
      detailHost.append(pane);
      return;
    }
    const by = info.byMethod ?? {};
    const tile = (k, v, title) => h('div.stat-tile', { title }, h('div.k', k), h('div.v', v));
    pane.append(h('div.stat-grid.qc-stats',
      tile('Kept', formatPercent(100 - info.percentRemoved), `${formatCount(info.eventCount - info.removed)} of ${formatCount(info.eventCount)} events`),
      tile('PeacoQC', by.peacoQC ? formatPercent(by.peacoQC.percent) : '—', 'Events in bins PeacoQC removed'),
      tile('Flow rate', by.flowRate ? formatPercent(by.flowRate.percent) : '—', 'Events in time slices with an abnormal rate'),
      tile('Margins', by.margins ? formatPercent(by.margins.percent) : '—', 'Saturated or piled-up events'),
      tile('Score', String(info.score), 'Score = 100 − 2 per % removed (max 60) − 3 per flow-rate episode (max 15) − 5 per drifting channel (max 20)')));
    const findings = info.findings.filter((f) => f.method !== 'summary');
    pane.append(h('div.qc-finding-list', findings.length
      ? findings.map((f) => h(`div.callout${f.severity === 'warning' ? '.warn' : ''}`, icon(f.severity === 'warning' ? 'warning' : 'info'), h('span', f.text)))
      : h('div.callout.ok', icon('check'), h('span', 'No acquisition problems were found.'))));
    if (!result) {
      pane.append(h('div.callout.accent', { style: { marginTop: '10px' } }, icon('info'),
        h('span.grow', 'The signal and event-rate tracks are kept for this session only. Re-run QC on this sample to see them.'),
        h('button.btn.small', { type: 'button', disabled: Boolean(running), onclick: () => runSamples([sample]) }, 'Re-run')));
      detailHost.append(pane);
      return;
    }
    pane.append(peakSection(result), rateSection(result), h('div.qc-two', marginSection(result), driftSection(result)), sensitivitySection(sample, result, info),
      citations('peacoqc', 'flowai'));
    detailHost.append(pane);
  }

  function cohortOverview() {
    const samples = cleanSamples();
    const infos = samples.map((s) => [s, cardInfo(s.id)]).filter(([, info]) => info);
    const pane = h('div.pane');
    pane.append(h('h3', 'Cohort overview'));
    if (!infos.length) {
      pane.append(explain('Run QC to give every sample a score and a list of findings. Click a sample to see its signal over time, the event rate, saturated events per channel and how much each channel drifted.'),
        h('div.callout.accent', icon('info'), h('span', 'How to read the score: 100 means nothing was flagged. It loses 2 points per % of events removed (at most 60), 3 per flow-rate episode (at most 15) and 5 per drifting channel (at most 20). Below 70, look at the sample before using it.')),
        citations('peacoqc', 'flowai'));
      return pane;
    }
    const scores = infos.map(([, i]) => i.score).sort((a, b) => a - b);
    const median = scores[Math.floor((scores.length - 1) / 2)];
    const poor = infos.filter(([, i]) => i.score < 70).length;
    let removed = 0;
    let total = 0;
    for (const [, i] of infos) {
      removed += i.removed;
      total += i.eventCount;
    }
    pane.append(h('div.stat-grid.qc-stats',
      h('div.stat-tile', h('div.k', 'Checked'), h('div.v', `${infos.length}/${samples.length}`)),
      h('div.stat-tile', h('div.k', 'Median score'), h('div.v', String(median))),
      h('div.stat-tile', h('div.k', 'Score below 70'), h('div.v', String(poor))),
      h('div.stat-tile', h('div.k', 'Events removed'), h('div.v', formatPercent((100 * removed) / (total || 1))))));
    const worst = infos.slice().sort((a, b) => a[1].score - b[1].score).slice(0, 10);
    const body = h('tbody');
    for (const [sample, info] of worst) {
      const first = info.findings.find((f) => f.method !== 'summary' && f.severity === 'warning');
      body.append(h('tr', { style: { cursor: 'pointer' }, onclick: () => selectCard(sample.id) },
        h('td', { style: { whiteSpace: 'nowrap', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis' } }, sample.name),
        h('td', scoreBadge(info.score)),
        h('td.r', formatPercent(info.percentRemoved)),
        h('td.muted', first?.text ?? 'No problems found')));
    }
    pane.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Samples to review first'),
      h('table.data', h('thead', h('tr', h('th', 'Sample'), h('th', 'Score'), h('th.r', 'Removed'), h('th', 'Main finding'))), body),
      h('p.muted', { style: { fontSize: '11.5px', marginTop: '8px' } }, 'Score = 100 − 2 per % of events removed (max 60) − 3 per flow-rate episode (max 15) − 5 per drifting channel (max 20).'),
      citations('peacoqc', 'flowai'));
    return pane;
  }

  function peakSection(result) {
    const host = h('div');
    const peaco = result.peacoQC;
    if (!peaco) return h('div.callout', { style: { marginTop: '12px' } }, icon('info'), h('span', 'PeacoQC was not run for this sample.'));
    const channels = Object.keys(peaco.channelTracks);
    if (!channels.length) return h('div.callout.warn', { style: { marginTop: '12px' } }, icon('warning'), h('span', peaco.warnings.join(' ') || 'PeacoQC found no density peaks to follow.'));
    // Default: channels involved in removed stretches first, then the most variable.
    if (!S.detailChannels || !S.detailChannels.some((c) => channels.includes(c))) {
      const fromEpisodes = [...new Set(peaco.episodes.map((e) => e.channel).filter(Boolean))];
      const byMad = channels.slice().sort((a, b) => peaco.channelTracks[b].madContribution - peaco.channelTracks[a].madContribution);
      S.detailChannels = [...new Set([...fromEpisodes, ...byMad])].slice(0, 3);
    }
    const shown = S.detailChannels.filter((c) => channels.includes(c));
    const colors = REMOVAL_COLORS(cssColors());
    const chips = h('div.qc-chips', channels.map((name) => h(`button.chip${shown.includes(name) ? '.active' : ''}`, {
      type: 'button',
      onclick: () => {
        S.detailChannels = shown.includes(name) ? shown.filter((c) => c !== name) : [...shown, name];
        renderDetail();
      },
    }, channelLabel(store.ws, name, { short: true }))));
    host.append(
      h('div.section-title', { style: { marginTop: '14px' } }, 'Signal over the acquisition (PeacoQC)'),
      explain(`Each line follows one density peak of a channel across ${peaco.bins.length} bins of ${formatCount(peaco.eventsPerBin)} consecutive events (bins overlap by half); the dashed line is its median. Shaded bins were removed. `,
        peaco.itPerformed ? '' : 'The isolation tree was skipped because there were fewer than 150 bins. '),
      h('div.qc-legend',
        h('span', h('i.qc-key', { style: { background: alpha(colors.isolationTree, 0.35) } }), `Isolation tree (${formatPercent(peaco.byMethod.isolationTree.percent)})`),
        h('span', h('i.qc-key', { style: { background: alpha(colors.mad, 0.35) } }), `MAD > ${peaco.parameters.mad} (${formatPercent(peaco.byMethod.mad.percent)})`),
        h('span', h('i.qc-key', { style: { background: alpha(colors.consecutive, 0.35) } }), `Short good stretches (${formatPercent(peaco.byMethod.consecutive.percent)})`)),
      chips);
    for (const name of shown) host.append(h('div.qc-track', chart(132, (ctx, w, hgt, c) => drawPeakTrack(ctx, w, hgt, c, result, name, channelLabel(store.ws, name)))));
    if (!shown.length) host.append(h('p.muted', 'Pick channels above to show their tracks.'));
    return host;
  }

  function rateSection(result) {
    const host = h('div');
    host.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Event rate (flow-rate check)'));
    if (!result.flowRate) {
      host.append(h('div.callout', icon('info'), h('span', result.hasTime
        ? 'The flow-rate check was not run.'
        : 'This file has no time channel, so the event rate cannot be checked. PeacoQC still works on the order of events; consider recording Time on the instrument.')));
      return host;
    }
    const flow = result.flowRate;
    host.append(
      explain(`Events per ${formatSeconds(flow.sliceSeconds)} s slice. Slices whose rate differs from the median by more than a robust generalized ESD test allows (α = 0.01) are shaded and their events removed; the strip along the bottom marks what PeacoQC removed, for comparison.`,
        flow.timestepAssumed ? ' The file has no $TIMESTEP, so 0.01 s per time unit was assumed.' : ''),
      h('div.qc-track', chart(120, (ctx, w, hgt, c) => drawRateTrack(ctx, w, hgt, c, result))));
    return host;
  }

  function marginSection(result) {
    const host = h('div');
    host.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Margin events'));
    if (!result.margins) {
      host.append(h('p.muted', 'Not run.'));
      return host;
    }
    const rows = Object.entries(result.margins.counts).sort((a, b) => (b[1].upper + b[1].lower) - (a[1].upper + a[1].lower));
    const body = h('tbody');
    for (const [name, counts] of rows) {
      const flagged = counts.upper + counts.lower > 0;
      body.append(h('tr', h('td', { style: { whiteSpace: 'nowrap' } }, channelLabel(store.ws, name, { short: true })),
        h(`td.r${counts.upper ? '' : '.muted'}`, counts.upper ? `${formatCount(counts.upper)} (${formatPercent(counts.percentUpper)})` : '0'),
        h(`td.r${counts.lower ? '' : '.muted'}`, counts.lower ? `${formatCount(counts.lower)} (${formatPercent(counts.percentLower)})` : '0'),
        h('td', flagged && counts.percentUpper + counts.percentLower >= 1 ? h('span.badge.warn', 'check') : null)));
    }
    host.append(h('div.qc-table-scroll', h('table.data', h('thead', h('tr', h('th', 'Channel'), h('th.r', 'Saturated'), h('th.r', 'Piled low'), h('th'))), body)),
      h('p.muted.qc-small', 'Saturated: at or above $PnR − 1 on the uncompensated values. Piled low: at least two events share the channel minimum.'));
    return host;
  }

  function driftSection(result) {
    const host = h('div');
    host.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Signal drift'));
    if (!result.drift) {
      host.append(h('p.muted', 'Not run.'));
      return host;
    }
    const rows = Object.entries(result.drift.channels).filter(([, d]) => Number.isFinite(d.percentChange)).sort((a, b) => Math.abs(b[1].percentChange) - Math.abs(a[1].percentChange));
    const body = h('tbody');
    for (const [name, d] of rows) {
      body.append(h('tr', h('td', { style: { whiteSpace: 'nowrap' } }, channelLabel(store.ws, name, { short: true })),
        h('td.r', `${d.percentChange >= 0 ? '+' : '−'}${Math.abs(d.percentChange).toFixed(1)}%`),
        h('td', d.drifted ? h('span.badge.warn', 'drifts') : h('span.badge.ok', 'stable'))));
    }
    host.append(h('div.qc-table-scroll', h('table.data', h('thead', h('tr', h('th', 'Channel'), h('th.r', 'Start → end'), h('th'))), body)),
      h('p.muted.qc-small', `Change of the median signal between the first and last tenth of the ${result.drift.timeUnit === 's' ? 'acquisition time' : 'events'}, from a robust (Theil–Sen) trend over 20 bins. Drift beyond ±20% is flagged; it is reported, not removed.`));
    return host;
  }

  function sensitivitySection(sample, result, info) {
    const host = h('div');
    const params = { variant: S.settings.variant ?? 'refined', mad: S.settings.mad, itLimit: S.settings.itLimit, consecutiveBins: S.settings.consecutiveBins, ...(S.comparison?.sampleId === sample.id ? S.comparison.params : {}) };
    const variant = h('select.input.small', { onchange: (event) => { params.variant = event.target.value; } },
      h('option', { value: 'refined', selected: params.variant !== 'classic' }, 'Refined (CytoWeave)'),
      h('option', { value: 'classic', selected: params.variant === 'classic' }, 'Classic (as published)'));
    const number = (label, key, step, min, max, hint) => {
      const input = h('input.input.small', { type: 'number', value: params[key], step, min, max, style: { width: '86px' } });
      input.addEventListener('input', () => { const v = Number.parseFloat(input.value); if (Number.isFinite(v)) params[key] = v; });
      return h('label.field', { title: hint }, h('span', label), input);
    };
    host.append(
      h('div.section-title', { style: { marginTop: '14px' } }, 'Sensitivity'),
      explain('How much does the result depend on PeacoQC\'s settings? Re-run this sample with other values and compare before keeping anything. Lower MAD or IT limit = stricter.'),
      h('div.qc-toolbar',
        h('label.field', { title: 'Refined adds three safeguards to PeacoQC: a bin\'s peak joins a trajectory only when it is nearer to it than to the neighbouring one; MAD flags are narrowed to bins whose own value deviates (the smoother otherwise spreads a short clog over ±25 bins); and the isolation tree only isolates bins that are contiguous in time. Classic reproduces the published algorithm.' }, h('span', 'Variant'), variant),
        number('MAD threshold', 'mad', 0.5, 1, 20, 'Bins whose smoothed peak trajectory is more than this many MADs from the median are removed (PeacoQC default 6).'),
        number('IT limit', 'itLimit', 0.05, 0.1, 0.99, 'Minimum gain for the isolation tree to split (PeacoQC default 0.6).'),
        number('Consecutive bins', 'consecutiveBins', 1, 1, 50, 'Good stretches shorter than this are removed too (PeacoQC default 5).'),
        h('div.field', h('span', ' '), h('button.btn.small', { type: 'button', disabled: Boolean(running), onclick: () => compare(sample, params) }, icon('play'), 'Re-run and compare'))));
    const comparison = S.comparison?.sampleId === sample.id ? S.comparison : null;
    if (comparison?.after) host.append(comparisonTable(comparison, result, info));
    return host;
  }

  function comparisonTable(comparison, before, info) {
    const after = comparison.after;
    const row = (label, a, b, fmt = formatPercent, lowerIsBetter = true) => {
      const change = Number.isFinite(a) && Number.isFinite(b) ? b - a : Number.NaN;
      const better = lowerIsBetter ? change < 0 : change > 0;
      return h('tr', h('td', label), h('td.r', Number.isFinite(a) ? fmt(a) : '—'), h('td.r', Number.isFinite(b) ? fmt(b) : '—'),
        h(`td.r${!Number.isFinite(change) || Math.abs(change) < 1e-9 ? '.muted' : better ? '.qc-better' : '.qc-worse'}`, Number.isFinite(change) ? `${change > 0 ? '+' : change < 0 ? '−' : ''}${fmt(Math.abs(change))}` : ''));
    };
    const pb = before.peacoQC?.byMethod;
    const pa = after.peacoQC?.byMethod;
    const p0 = before.peacoQC?.parameters ?? {};
    const p1 = after.peacoQC?.parameters ?? {};
    const score = (v) => String(Math.round(v));
    return h('div.qc-compare',
      h('table.data',
        h('thead', h('tr', h('th', 'Removed'), h('th.r', `Current (MAD ${p0.mad}, IT ${p0.itLimit}, ${p0.consecutiveBins} bins)`), h('th.r', `New (MAD ${p1.mad}, IT ${p1.itLimit}, ${p1.consecutiveBins} bins)`), h('th.r', 'Change'))),
        h('tbody',
          row('Isolation tree', pb?.isolationTree.percent, pa?.isolationTree.percent),
          row('MAD', pb?.mad.percent, pa?.mad.percent),
          row('Short stretches', pb?.consecutive.percent, pa?.consecutive.percent),
          row('PeacoQC in total', before.peacoQC?.percentRemoved, after.peacoQC?.percentRemoved),
          row('All methods', info.percentRemoved, after.summary.percentRemoved),
          row('Score', info.score, after.summary.score, score, false))),
      h('div.btn-row', { style: { marginTop: '8px' } },
        h('button.btn.small.primary', { type: 'button', onclick: () => acceptComparison(comparison) }, icon('check'), 'Use the new result'),
        h('button.btn.small', { type: 'button', onclick: () => { S.comparison = null; renderDetail(); } }, 'Keep the current result')));
  }

  // --- Running QC -----------------------------------------------------------------------------

  function qcPayload(view, settings) {
    const ws = store.ws;
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

  async function runOne(sample, settings, onProgress) {
    const view = await data.ensure(sample.id);
    const payload = qcPayload(view, settings);
    const job = track(worker.run('acquisitionQC', payload, { onProgress }));
    if (running) running.job = job;
    const result = await job.promise;
    const params = paramsOf(settings);
    result.sampleId = sample.id;
    result.params = params;
    result.persisted = summaryOf(result, sample, params);
    return result;
  }

  async function runSamples(list) {
    if (running || !list.length) return;
    const settings = structuredClone(S.settings);
    const token = { cancelled: false, job: null, sampleId: null };
    running = token;
    renderControls();
    const progress = progressToast(`Checking ${list.length} sample${list.length === 1 ? '' : 's'}…`, () => cancelRun());
    const done = [];
    const failures = [];
    for (let i = 0; i < list.length && !token.cancelled; i += 1) {
      const sample = list[i];
      token.sampleId = sample.id;
      scheduleCards();
      progress.update(i / list.length, `Loading ${sample.name} (${i + 1}/${list.length})`);
      try {
        const result = await runOne(sample, settings, (fraction, message) => progress.update((i + fraction) / list.length, `${sample.name} (${i + 1}/${list.length}): ${message}`));
        S.results.set(sample.id, result);
        done.push(sample.id);
      } catch (error) {
        if (error.cancelled || token.cancelled) break;
        failures.push(`${sample.name}: ${error.message}`);
      }
      token.job = null;
    }
    token.sampleId = null;
    if (done.length) {
      try {
        await saveQC(done, settings);
      } catch (error) {
        failures.push(`Saving: ${error.message}`);
      }
    }
    running = null;
    const message = token.cancelled
      ? `Stopped after ${done.length} of ${list.length} samples; their results were saved.`
      : `Checked ${done.length} sample${done.length === 1 ? '' : 's'}; “QC pass” saved.${failures.length ? ` ${failures.length} failed.` : ''}`;
    if (failures.length && !done.length) progress.fail(failures[0]);
    else progress.done(message, failures.length ? 'error' : 'ok');
    for (const failure of failures.slice(0, 3)) toast(failure, { kind: 'error' });
    if (!destroyed && S.section === 'clean') {
      if (list.length === 1 && done.length) S.selectedId = list[0].id;
      render();
    }
  }

  function cancelRun() {
    if (!running) return;
    running.cancelled = true;
    running.job?.cancel();
  }

  // Saves the "QC pass" masks of `ids`, merging with the samples checked earlier.
  async function saveQC(ids, settings, options = {}) {
    const perSample = new Map();
    const summaries = {};
    for (const id of ids) {
      const result = S.results.get(id);
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
      summary: { version: 1, software: `CytoWeave ${app.version ?? ''}`.trim(), references: [CITE.peacoqc, CITE.flowai], perSample: summaries },
    };
    await saveDerivedMerged(record, perSample, `Acquisition QC (${ids.length} sample${ids.length === 1 ? '' : 's'})`, options);
  }

  // As app.saveDerived, but a record with the same kind and outputs keeps its other samples
  // (QC and debarcoding run on a few samples at a time).
  async function saveDerivedMerged(record, perSample, label, options = {}) {
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

  async function compare(sample, params) {
    if (running) return;
    const settings = { ...structuredClone(S.settings), ...params };
    const token = { cancelled: false, job: null, sampleId: sample.id };
    running = token;
    const progress = progressToast(`Re-running ${sample.name} (${params.variant === 'classic' ? 'classic' : 'refined'}) with MAD ${params.mad}, IT ${params.itLimit}, ${params.consecutiveBins} bins…`, () => cancelRun());
    try {
      const after = await runOne(sample, settings, (fraction, message) => progress.update(fraction, `${sample.name}: ${message}`));
      S.comparison = { sampleId: sample.id, params: { ...params }, settings, after };
      progress.done();
    } catch (error) {
      if (error.cancelled || token.cancelled) progress.done('Cancelled.', 'ok');
      else progress.fail(error.message);
    }
    running = null;
    if (!destroyed && S.section === 'clean') renderDetail();
  }

  async function acceptComparison(comparison) {
    S.results.set(comparison.sampleId, comparison.after);
    S.comparison = null;
    await saveQC([comparison.sampleId], comparison.settings, { keepParams: true });
    toast('The new result replaces the previous one for this sample (undo restores it).', { kind: 'ok' });
    if (!destroyed) render();
  }

  async function addQCGate() {
    const ws = store.ws;
    const record = qcRecord();
    if (!record || qcGate()) return;
    const missing = ws.samples.filter((s) => !record.files?.[s.id]);
    if (missing.length) {
      const names = missing.slice(0, 4).map((s) => s.name).join(', ');
      const ok = await confirmDialog({
        title: 'Some samples have no QC result',
        message: `${missing.length} sample(s) (${names}${missing.length > 4 ? ', …' : ''}) have no “QC pass” channel, so no population under the QC gate will apply to them until they are checked. Add the gate anyway?`,
        confirm: 'Add the gate',
      });
      if (!ok) return;
    }
    const added = addGates(store.ws, [{
      name: 'QC pass',
      type: 'category',
      dims: [{ channel: QC_CHANNEL }],
      geometry: { values: [1] },
      color: QC_GREEN,
      parentId: null,
      meta: { origin: 'auto', method: 'Acquisition QC (PeacoQC + flow rate + margins)', note: 'Events that passed acquisition QC (QC pass = 1).' },
    }], 'add-qc-gate');
    const gate = added.gates[0];
    const gates = added.ws.gates.map((g) => (g.id !== gate.id && !g.parentId ? { ...g, parentId: gate.id } : g));
    const next = { ...setCollection(added.ws, 'gates', gates, 'reparent-under-qc'), plots: (added.ws.plots ?? []).map((p) => (p.populationId === ROOT ? { ...p, populationId: gate.id } : p)) };
    store.commit(next, 'Add “QC pass” gate', ['gate', 'plots']);
    toast('“QC pass” is now the root population; your gates and plots moved beneath it. Undo restores the previous tree.', { kind: 'ok' });
  }

  // ===========================================================================================
  // Normalize: CytoNorm and bead normalization
  // ===========================================================================================

  function normCandidates() {
    return store.ws.samples.filter((s) => s.role === 'sample' || s.role === 'reference');
  }

  function batchOf(sample) {
    const value = sample.meta?.batch;
    return value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim();
  }

  function fluorescenceCatalog() {
    const map = new Map();
    for (const sample of store.ws.samples) for (const c of sample.channels) if (c.type === 'fluorescence' && !map.has(c.name)) map.set(c.name, c);
    return [...map.values()];
  }

  function defaultNormChannels() {
    const all = fluorescenceCatalog();
    const marked = all.filter((c) => c.marker);
    return (marked.length ? marked : all).map((c) => c.name);
  }

  function clusterChannels() {
    const out = [];
    const add = (name) => { if (name && !out.includes(name)) out.push(name); };
    for (const d of store.ws.derived) {
      if (['qc', 'normalization', 'debarcode'].includes(d.kind)) continue;
      const clusterish = CLUSTER_PATTERN.test(`${d.kind ?? ''} ${d.name ?? ''} ${d.method ?? ''}`);
      for (const output of d.outputs ?? []) if (clusterish || CLUSTER_PATTERN.test(output)) add(output);
    }
    for (const sample of store.ws.samples) {
      const view = data.view(sample.id);
      if (view) for (const name of view.derived.keys()) if (CLUSTER_PATTERN.test(name)) add(name);
    }
    return out;
  }

  function mostlyMass() {
    const samples = normCandidates();
    return samples.length > 0 && samples.filter((s) => s.technology === 'mass').length > samples.length / 2;
  }

  // CytoNorm works on transformed values; the transform must be the same for every sample.
  function normTransform(channel) {
    const configured = store.ws.channelSettings?.[channel]?.transform;
    if (configured && ['arcsinh', 'logicle', 'biex', 'fasinh', 'hyperlog'].includes(configured.type)) return configured;
    const mass = mostlyMass();
    return { type: 'arcsinh', cofactor: S.norm.cofactor ?? (mass ? 5 : 150), max: mass ? 10000 : 262144 };
  }

  function renderNormalize() {
    const ws = store.ws;
    const N = S.norm;
    const samples = normCandidates();
    const withBatch = samples.filter((s) => batchOf(s));
    const without = samples.filter((s) => !batchOf(s));
    const batches = [...new Set(withBatch.map(batchOf))].sort(naturalCompare);
    const references = withBatch.filter((s) => s.role === 'reference');
    const anchored = batches.filter((b) => references.some((r) => batchOf(r) === b));
    const unanchored = batches.filter((b) => !anchored.includes(b));
    const studySamples = withBatch.filter((s) => s.role === 'sample');
    const conditions = [...new Set(studySamples.map((s) => s.meta?.condition).filter((v) => v !== undefined && v !== null && String(v).trim() !== '').map(String))].sort(naturalCompare);
    const check = confoundingCheck(studySamples.map((s) => ({ batch: batchOf(s), condition: s.meta?.condition })));
    const ackKey = check.warnings.join('|');
    if (N.ackKey !== ackKey) {
      N.ackKey = ackKey;
      N.acknowledged = false;
    }

    // Design.
    const design = h('div.pane');
    design.append(h('h3', icon('layers'), 'Batch design'),
      explain('Batch effects — differences in staining, reagent lots or instrument settings between acquisition days — make the same population look different from batch to batch. ',
        h('b', 'CytoNorm'), ' learns from a reference (anchor) sample acquired in every batch — ideally aliquots of the same control — how each channel\'s quantiles differ from their mean across batches, fits a monotone spline per batch and channel, and applies it to all samples of that batch. It needs a ', h('code', 'batch'), ' for every sample and at least one sample with the role ', h('b', 'Reference'), ' per batch.'));
    if (!withBatch.length) {
      design.append(h('div.callout.warn', icon('warning'), h('span.grow', 'No sample has a batch yet. Annotate the samples with a “batch” field (the day or run they were acquired), and set the role of each batch\'s anchor sample to “Reference”.'),
        h('button.btn.small.primary', { type: 'button', onclick: () => app.annotateSamples?.(samples.map((s) => s.id)) }, icon('tag'), 'Annotate samples…')));
    } else {
      const head = h('tr', h('th', 'Batch'), h('th.r', 'References'), h('th.r', 'Samples'), ...conditions.map((c) => h('th.r', c)), conditions.length ? h('th.r', 'No condition') : null);
      const body = h('tbody');
      for (const batch of batches) {
        const inBatch = withBatch.filter((s) => batchOf(s) === batch);
        const refs = inBatch.filter((s) => s.role === 'reference');
        const study = inBatch.filter((s) => s.role === 'sample');
        body.append(h('tr', h('td', h('b', batch)),
          h('td.r', refs.length ? String(refs.length) : h('span.badge.danger', 'none')),
          h('td.r', String(study.length)),
          ...conditions.map((c) => { const n = study.filter((s) => String(s.meta?.condition) === c).length; return h(`td.r${n ? '' : '.muted'}`, String(n)); }),
          conditions.length ? h('td.r.muted', String(study.filter((s) => s.meta?.condition === undefined || String(s.meta.condition).trim() === '').length)) : null));
      }
      design.append(h('div.qc-table-scroll', h('table.data', h('thead', head), body)));
      if (without.length) {
        design.append(h('div.callout.warn', { style: { marginTop: '8px' } }, icon('warning'),
          h('span.grow', `${without.length} sample(s) have no batch and will not be normalized: ${without.slice(0, 5).map((s) => s.name).join(', ')}${without.length > 5 ? ', …' : ''}.`),
          h('button.btn.small', { type: 'button', onclick: () => app.annotateSamples?.(without.map((s) => s.id)) }, 'Annotate…')));
      }
      if (unanchored.length) {
        design.append(h('div.callout.danger', { style: { marginTop: '8px' } }, icon('warning'),
          h('span', `Batch${unanchored.length > 1 ? 'es' : ''} ${unanchored.join(', ')} ha${unanchored.length > 1 ? 've' : 's'} no reference sample, so ${unanchored.length > 1 ? 'they' : 'it'} cannot be normalized. Set the role of the anchor sample acquired in ${unanchored.length > 1 ? 'each' : 'that'} batch to “Reference” (sample menu → Set role).`)));
      }
      if (!conditions.length) {
        design.append(h('div.callout', { style: { marginTop: '8px' } }, icon('info'), h('span', 'Add a “condition” to the samples to check whether batch and condition are confounded (a condition acquired in one batch only cannot be told apart from that batch\'s effect).')));
      }
      if (check.warnings.length) {
        design.append(h('div.callout.danger.qc-confounded', { style: { marginTop: '8px' } }, icon('warning'),
          h('div.grow',
            h('b', 'Batch and condition are confounded.'),
            h('ul', check.warnings.map((w) => h('li', w))),
            h('div', `Cramér's V = ${check.cramersV.toFixed(2)} (0 = balanced design, 1 = each condition in its own batch). Normalization may then remove real biological differences along with the batch effect.`),
            h('label.check', { style: { marginTop: '6px' } }, h('input', { type: 'checkbox', checked: N.acknowledged, onchange: (event) => { N.acknowledged = event.target.checked; render(); } }), 'I understand; normalize anyway'))));
      } else if (conditions.length && batches.length > 1) {
        design.append(h('div.callout.ok', { style: { marginTop: '8px' } }, icon('check'), h('span', `Batch and condition are not confounded (Cramér's V = ${check.cramersV.toFixed(2)}).`)));
      }
      for (const note of check.notes) design.append(h('p.muted.qc-small', note));
    }

    // Settings.
    const settings = h('div.pane');
    const catalog = fluorescenceCatalog();
    if (!N.channels) N.channels = defaultNormChannels();
    const chosen = N.channels.filter((name) => catalog.some((c) => c.name === name));
    const clusters = clusterChannels();
    if (N.clustering && !clusters.includes(N.clustering)) N.clustering = '';
    const checks = h('div.qc-checks', catalog.map((c) => h('label.check', { title: c.name },
      h('input', { type: 'checkbox', checked: chosen.includes(c.name), onchange: (event) => { N.channels = event.target.checked ? [...chosen, c.name] : chosen.filter((n) => n !== c.name); render(); } }),
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.marker ? `${c.marker} · ${c.name}` : c.name))));
    const transformNote = chosen.length ? (() => {
      const spec = normTransform(chosen[0]);
      return spec.type === 'arcsinh' && !ws.channelSettings?.[chosen[0]]?.transform ? `arcsinh(x / ${spec.cofactor})` : `the workspace scale of each channel (${spec.type})`;
    })() : '';
    const targets = withBatch.filter((s) => anchored.includes(batchOf(s)));
    const memory = targets.reduce((sum, s) => sum + s.eventCount, 0) * chosen.length * 4;
    const blockers = [];
    if (anchored.length < 2) blockers.push('at least two batches with a reference sample');
    if (!chosen.length) blockers.push('at least one channel');
    if (check.warnings.length && !N.acknowledged) blockers.push('the confounding acknowledgement');
    const goalSelect = h('select.input.small', { onchange: (event) => { N.goal = event.target.value; } },
      h('option', { value: 'mean', selected: N.goal === 'mean' }, 'Mean of the batches (CytoNorm default)'),
      h('option', { value: 'median', selected: N.goal === 'median' }, 'Median of the batches'),
      ...anchored.map((b) => h('option', { value: b, selected: N.goal === b }, `Batch ${b}`)));
    settings.append(h('h3', icon('settings'), 'Normalize with CytoNorm'),
      h('div.row', { style: { justifyContent: 'space-between' } }, h('span.field-label', `Channels (${chosen.length} of ${catalog.length})`),
        h('div.btn-row',
          h('button.btn.small.ghost', { type: 'button', onclick: () => { N.channels = defaultNormChannels(); render(); } }, 'Markers'),
          h('button.btn.small.ghost', { type: 'button', onclick: () => { N.channels = catalog.map((c) => c.name); render(); } }, 'All'),
          h('button.btn.small.ghost', { type: 'button', onclick: () => { N.channels = []; render(); } }, 'None'))),
      checks,
      h('div.qc-toolbar', { style: { marginTop: '10px' } },
        h('label.field', { title: 'Per-cluster normalization corrects batch effects that differ between cell types. Cluster first (e.g. FlowSOM) on all samples.' }, h('span', 'Clustering'),
          h('select.input.small', { onchange: (event) => { N.clustering = event.target.value; } },
            h('option', { value: '' }, 'None: one global model'),
            ...clusters.map((name) => h('option', { value: name, selected: N.clustering === name }, `Per cluster of “${name}”`)))),
        h('label.field', { title: 'Used when the workspace has no fixed scale for a channel' }, h('span', 'Arcsinh cofactor'),
          h('input.input.small', { type: 'number', min: 0.1, step: 1, value: S.norm.cofactor ?? (mostlyMass() ? 5 : 150), style: { width: '80px' }, onchange: (event) => { const v = Number.parseFloat(event.target.value); S.norm.cofactor = v > 0 ? v : null; render(); } })),
        h('label.field', { title: 'Number of quantiles per channel (CytoNorm default 99)' }, h('span', 'Quantiles'),
          h('input.input.small', { type: 'number', min: 5, max: 1001, step: 1, value: N.nQ, style: { width: '76px' }, onchange: (event) => { const v = Math.round(Number.parseFloat(event.target.value)); if (v >= 5) N.nQ = v; } })),
        h('label.field', h('span', 'Target distribution'), goalSelect)),
      clusters.length ? null : h('p.muted.qc-small', 'No clustering channel found. Without one, CytoNorm fits one model for all cells; cluster the samples first (for example FlowSOM in Explore) to normalize per cell type.'),
      h('div.callout', { style: { marginTop: '8px' } }, icon('info'), h('span',
        targets.length && chosen.length
          ? `Trains on ${references.filter((r) => anchored.includes(batchOf(r))).length} reference sample(s) from ${anchored.length} batches, then normalizes ${targets.length} sample(s) on ${transformNote}. Adds ${chosen.length} channel${chosen.length === 1 ? '' : 's'} named “<channel> (norm)” (about ${formatBytes(memory)} in memory); the original channels stay as they are.`
          : 'Choose channels and make sure at least two batches have a reference sample.')),
      h('div.btn-row', { style: { marginTop: '10px' } },
        h('button.btn.primary', { type: 'button', disabled: Boolean(blockers.length) || Boolean(running), title: blockers.length ? `Needs ${blockers.join(', ')}` : '', onclick: () => runNormalization({ channels: chosen, anchored, targets, references: references.filter((r) => anchored.includes(batchOf(r))) }) }, icon('play'), 'Train and normalize'),
        blockers.length ? h('span.muted', { style: { fontSize: '12px' } }, `Needs ${blockers.join(', ')}.`) : null));

    sectionHost.append(design, settings);
    if (N.result) sectionHost.append(normResultPane(N.result));
    if (ws.samples.some((s) => s.technology === 'mass')) sectionHost.append(beadPane());
    sectionHost.append(h('div.pane', citations('cytonorm', 'beads')));
  }

  function samplePayload(view, channels) {
    return {
      eventCount: view.eventCount,
      channels: channels.map((name) => ({ name, type: 'fluorescence', range: view.channelInfo(name)?.range ?? 0 })),
      columns: Object.fromEntries(channels.map((name) => [name, view.column(name)])),
    };
  }

  async function runNormalization({ channels, anchored, targets, references }) {
    if (running) return;
    const N = S.norm;
    const token = { cancelled: false, job: null };
    running = token;
    const transforms = Object.fromEntries(channels.map((name) => [name, normTransform(name)]));
    const clustering = N.clustering || null;
    const steps = references.length + targets.length + 2;
    let step = 0;
    const progress = progressToast('Normalizing batches…', () => cancelRun());
    const advance = (message) => progress.update(step++ / steps, message);
    const run = async (type, payload, message) => {
      const job = track(worker.run(type, payload, { onProgress: (f, m) => progress.update((step - 1 + f) / steps, `${message}: ${m}`) }));
      token.job = job;
      const result = await job.promise;
      token.job = null;
      return result;
    };
    const labelsOf = (view, sample) => {
      if (!clustering) return undefined;
      if (!view.hasChannel(clustering)) throw new Error(`${sample.name} has no “${clustering}” channel; cluster every sample first.`);
      return toInt32(view.column(clustering));
    };
    try {
      const refPayloads = [];
      for (const ref of references) {
        if (token.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        advance(`Loading reference ${ref.name}`);
        const view = await data.ensure(ref.id);
        const missing = channels.filter((c) => !view.hasChannel(c));
        if (missing.length) throw new Error(`Reference ${ref.name} lacks ${missing.join(', ')}.`);
        refPayloads.push({ sample: samplePayload(view, channels), batch: batchOf(ref), labels: labelsOf(view, ref) });
      }
      advance('Training CytoNorm');
      const model = await run('trainCytoNorm', { references: refPayloads, options: { channels, transforms, nQ: N.nQ, goal: N.goal } }, 'Training');
      refPayloads.length = 0;
      const perSample = new Map();
      const diag = [];
      const random = createRandom(7);
      const skipped = [];
      let unmatched = 0;
      for (const sample of targets) {
        if (token.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        advance(`Normalizing ${sample.name}`);
        const view = await data.ensure(sample.id);
        const missing = channels.filter((c) => !view.hasChannel(c));
        if (missing.length) {
          skipped.push(`${sample.name} (lacks ${missing.join(', ')})`);
          continue;
        }
        const result = await run('applyCytoNorm', { model, sample: samplePayload(view, channels), batch: batchOf(sample), labels: labelsOf(view, sample) }, sample.name);
        unmatched += result.unmatched ?? 0;
        perSample.set(sample.id, Object.fromEntries(channels.map((name) => [`${name}${NORM_SUFFIX}`, result.columns[name]])));
        const indices = sampleIndices(view.eventCount, Math.min(view.eventCount, 4000), random);
        const pick = (column) => Float32Array.from(indices, (e) => column[e]);
        diag.push({
          id: sample.id,
          name: sample.name,
          batch: batchOf(sample),
          reference: sample.role === 'reference',
          before: Object.fromEntries(channels.map((name) => [name, pick(view.column(name))])),
          after: Object.fromEntries(channels.map((name) => [name, pick(result.columns[name])])),
        });
      }
      if (!perSample.size) throw new Error('No sample could be normalized.');
      advance('Comparing batches before and after');
      const diagnostics = await run('batchDiagnostics', {
        samples: diag.map((d) => ({ eventCount: d.before[channels[0]].length, columns: d.before })),
        batches: diag.map((d) => d.batch),
        channels,
        options: { after: diag.map((d) => ({ columns: d.after })), transforms, maxEvents: 4000 },
      }, 'Diagnostics');
      advance('Saving');
      await app.saveDerived({
        kind: 'normalization',
        name: 'CytoNorm',
        method: 'CytoNorm (Van Gassen et al. 2020): per-batch monotone quantile splines from reference samples',
        params: { channels, transforms, nQ: N.nQ, goal: N.goal, clustering, references: references.map((r) => ({ id: r.id, name: r.name, batch: batchOf(r) })), batches: anchored },
        seed: 7,
        outputs: channels.map((name) => `${name}${NORM_SUFFIX}`),
        perSample,
        summary: {
          normalized: perSample.size,
          skipped,
          warnings: model.warnings,
          unmatchedEvents: unmatched,
          diagnostics: diagnostics.summary,
          perChannel: diagnostics.channels.map((e) => ({ channel: e.channel, meanEmdBefore: e.meanEmdBefore, meanEmdAfter: e.meanEmdAfter })),
          references: [CITE.cytonorm],
        },
      }, `CytoNorm (${perSample.size} samples)`);
      N.result = { at: new Date().toISOString(), channels, transforms, diagnostics, diag, batches: anchored, skipped, warnings: model.warnings, unmatched, clustering };
      if (!N.histChannel || !channels.includes(N.histChannel)) N.histChannel = channels[0];
      const s = diagnostics.summary;
      progress.done(`Normalized ${perSample.size} samples; mean batch distance ${s.meanEmdBefore.toFixed(3)} → ${s.meanEmdAfter.toFixed(3)}.`);
    } catch (error) {
      if (error.cancelled || token.cancelled) progress.done('Normalization stopped; nothing was saved.', 'ok');
      else progress.fail(error.message);
    }
    running = null;
    if (!destroyed && S.section === 'normalize') render();
  }

  function normResultPane(result) {
    const pane = h('div.pane');
    const { diagnostics, channels } = result;
    const batches = diagnostics.batches;
    const s = diagnostics.summary;
    const change = s.meanEmdBefore > 0 ? (100 * (s.meanEmdAfter - s.meanEmdBefore)) / s.meanEmdBefore : 0;
    pane.append(h('h3', icon('check'), 'Result', h('span.spacer'), h('span.muted', { style: { fontSize: '11.5px', fontWeight: 500 } }, new Date(result.at).toLocaleString())),
      h(`div.callout.${s.improved ? 'ok' : 'warn'}`, icon(s.improved ? 'check' : 'warning'), h('span',
        `Mean distance of each batch to all batches pooled: ${s.meanEmdBefore.toFixed(3)} → ${s.meanEmdAfter.toFixed(3)} (${change <= 0 ? '−' : '+'}${Math.abs(change).toFixed(0)}%); it fell in ${s.channelsImproved} of ${channels.length} channels. `,
        `Saved as ${channels.length} new channel${channels.length === 1 ? '' : 's'} “<channel> (norm)”; plot, gate and compare them like any channel.`)));
    for (const warning of [...result.warnings, ...result.skipped.map((n) => `Skipped ${n}.`), result.unmatched ? `${formatCount(result.unmatched)} events were in clusters the model did not know and were left unchanged.` : null].filter(Boolean)) {
      pane.append(h('div.callout.warn', { style: { marginTop: '6px' } }, icon('warning'), h('span', warning)));
    }
    let top = 0;
    for (const entry of diagnostics.channels) for (const b of batches) top = Math.max(top, entry.before[b]?.emd ?? 0, entry.after?.[b]?.emd ?? 0);
    top = top || 1;
    pane.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Distance of each batch to the pooled distribution'),
      explain('Earth mover\'s distance between each batch and all batches pooled, in fractions of the transformed axis (0 = identical). Grey: before; colored: after. Bars share one scale across channels.'),
      h('div.qc-multiples', diagnostics.channels.map((entry) => {
        const delta = entry.meanEmdBefore > 0 ? (100 * (entry.meanEmdAfter - entry.meanEmdBefore)) / entry.meanEmdBefore : 0;
        return h('div.qc-multiple',
          h('div.t', h('span', { title: entry.channel }, channelLabel(store.ws, entry.channel, { short: true })), h(`span.${delta < 0 ? 'qc-better' : 'qc-worse'}`, `${delta <= 0 ? '−' : '+'}${Math.abs(delta).toFixed(0)}%`)),
          chart(64, (ctx, w, hgt, c) => drawEmdBars(ctx, w, hgt, c, entry, batches, top)));
      })));
    // Overlaid densities of the reference samples.
    const refs = result.diag.filter((d) => d.reference);
    const channel = channels.includes(S.norm.histChannel) ? S.norm.histChannel : channels[0];
    const transform = createTransform(result.transforms[channel]);
    const curvesOf = (phase) => refs.map((d) => {
      const scaled = applyTransform(d[phase][channel], transform);
      const hist = histogram(scaled, null, { bins: 128 });
      const values = Array.from(hist.smoothed, (v) => v / (hist.total || 1));
      return { values, color: categoricalColor(batches.indexOf(d.batch)) };
    });
    const select = h('select.input.small', { style: { width: 'auto' }, onchange: (event) => { S.norm.histChannel = event.target.value; render(); } },
      channels.map((name) => h('option', { value: name, selected: name === channel }, channelLabel(store.ws, name))));
    pane.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Reference samples before and after'),
      h('div.row', { style: { marginBottom: '8px', flexWrap: 'wrap' } }, select,
        h('div.qc-legend', { style: { margin: 0 } }, batches.map((b, i) => h('span', h('i.qc-key', { style: { background: categoricalColor(i) } }), `batch ${b}`)))),
      refs.length
        ? h('div.qc-two',
          h('div.qc-track', chart(150, (ctx, w, hgt, c) => drawDensities(ctx, w, hgt, c, curvesOf('before'), transform, 'Before'))),
          h('div.qc-track', chart(150, (ctx, w, hgt, c) => drawDensities(ctx, w, hgt, c, curvesOf('after'), transform, 'After (normalized)'))))
        : h('p.muted', 'No reference sample was normalized.'),
      h('p.muted.qc-small', 'The references should overlap after normalization: they are the same control acquired in each batch.'));
    return pane;
  }

  // --- Bead normalization -----------------------------------------------------------------------

  function massSamples() {
    return store.ws.samples.filter((s) => s.technology === 'mass');
  }

  function beadPane() {
    const B = S.beads;
    const mass = massSamples();
    if (!B.sampleId || !mass.some((s) => s.id === B.sampleId)) B.sampleId = mass.find((s) => s.id === store.ui.sampleId)?.id ?? mass[0]?.id ?? null;
    const pane = h('div.pane');
    const sample = mass.find((s) => s.id === B.sampleId);
    const beadChannels = sample ? ['Ce140', 'Eu151', 'Eu153', 'Ho165', 'Lu175'].map((t) => findMassChannel(sample, t)) : [];
    const missing = beadChannels.filter((c) => !c).length;
    pane.append(h('h3', icon('dots'), 'Bead normalization (mass cytometry)'),
      explain('Mass cytometers lose sensitivity during a run. EQ beads (Ce140, Eu151, Eu153, Ho165, Lu175) added to the sample trace that drift over time. ',
        'Beads are found automatically (high in all five bead channels, low in DNA), their intensities are smoothed with a running median over 501 beads, and every event is multiplied by baseline ÷ smoothed bead intensity at its acquisition time, so beads — and cells — read the same throughout the run. Beads are marked in a “Bead” channel (1 = bead) so you can gate them out.'),
      h('div.qc-toolbar',
        h('label.field', h('span', 'Sample'), h('select.input.small', { onchange: (event) => { B.sampleId = event.target.value; render(); } }, mass.map((s) => h('option', { value: s.id, selected: s.id === B.sampleId }, s.name)))),
        h('label.field', h('span', 'Run on'), h('select.input.small', { onchange: (event) => { B.scope = event.target.value; } },
          h('option', { value: 'sample', selected: B.scope === 'sample' }, 'This sample'),
          h('option', { value: 'all', selected: B.scope === 'all' }, `All ${mass.length} mass-cytometry samples`))),
        h('label.field', { title: 'A shared baseline puts every file on the same scale; a per-file baseline only removes the drift within each file.' }, h('span', 'Baseline'), h('select.input.small', { onchange: (event) => { B.baseline = event.target.value; } },
          h('option', { value: 'file', selected: B.baseline === 'file' }, 'Each file\'s own bead medians'),
          h('option', { value: 'mean', selected: B.baseline === 'mean' }, 'Mean bead medians of the files (shared)'))),
        h('div.field', h('span', ' '), h('button.btn.small.primary', { type: 'button', disabled: !sample || Boolean(running), onclick: () => runBeads() }, icon('play'), 'Normalize with beads'))));
    if (missing) pane.append(h('div.callout.warn', { style: { marginTop: '8px' } }, icon('warning'), h('span', `${missing} of the 5 bead channels were not found in ${sample?.name}. Bead normalization needs Ce140, Eu151, Eu153, Ho165 and Lu175.`)));
    const shown = B.results.get(B.shownId) ?? B.results.get(B.sampleId);
    if (shown) {
      const slopes = shown.slopes;
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of slopes) { if (v < lo) lo = v; if (v > hi) hi = v; }
      pane.append(h('div.section-title', { style: { marginTop: '14px' } }, `Bead tracks · ${shown.name}`),
        h('div.stat-grid.qc-stats',
          h('div.stat-tile', h('div.k', 'Beads'), h('div.v', formatCount(shown.beadCount))),
          h('div.stat-tile', h('div.k', 'Of all events'), h('div.v', formatPercent((100 * shown.beadCount) / (shown.eventCount || 1)))),
          h('div.stat-tile', { title: 'The range of the multiplicative correction over the run' }, h('div.k', 'Correction'), h('div.v', `×${lo.toFixed(2)}–${hi.toFixed(2)}`))),
        h('div.qc-legend', h('span', h('i.qc-key', { style: { background: 'var(--text-3)' } }), 'bead events'), h('span', h('i.qc-key', { style: { background: 'var(--danger)' } }), 'smoothed (before)'), h('span', h('i.qc-key', { style: { background: 'var(--ok)' } }), 'after normalization'), h('span', h('i.qc-key.dashed'), 'baseline')),
        h('div.qc-multiples.wide', shown.beadChannels.map((channel) => h('div.qc-track', chart(120, (ctx, w, hgt, c) => drawBeadTrack(ctx, w, hgt, c, shown, channel))))));
    }
    return pane;
  }

  function beadPayload(view) {
    const params = view.parameters.filter((p) => p.type === 'fluorescence' || p.type === 'time');
    return {
      eventCount: view.eventCount,
      channels: params.map((p) => ({ name: p.name, type: p.type, range: p.range })),
      columns: Object.fromEntries(params.map((p) => [p.name, view.column(p.name)])),
    };
  }

  async function runBeads() {
    if (running) return;
    const B = S.beads;
    const list = B.scope === 'all' ? massSamples() : massSamples().filter((s) => s.id === B.sampleId);
    if (!list.length) return;
    const token = { cancelled: false, job: null };
    running = token;
    const progress = progressToast('Bead normalization…', () => cancelRun());
    const total = list.length * (B.baseline === 'mean' && list.length > 1 ? 2 : 1);
    let step = 0;
    const run = async (type, payload, message) => {
      const job = track(worker.run(type, payload, { onProgress: (f) => progress.update((step + f) / total, message) }));
      token.job = job;
      const result = await job.promise;
      token.job = null;
      step += 1;
      return result;
    };
    try {
      let baseline = null;
      if (B.baseline === 'mean' && list.length > 1) {
        const sums = {};
        for (const sample of list) {
          if (token.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
          const view = await data.ensure(sample.id);
          const one = await run('beadBaseline', { samples: [beadPayload(view)] }, `Bead medians of ${sample.name}`);
          for (const [key, value] of Object.entries(one)) sums[key] = (sums[key] ?? 0) + value / list.length;
        }
        baseline = sums;
      }
      const perSample = new Map();
      const outputs = new Set([BEAD_CHANNEL]);
      const summaries = {};
      for (const sample of list) {
        if (token.cancelled) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        const view = await data.ensure(sample.id);
        const result = await run('beadNormalize', { sample: beadPayload(view), options: baseline ? { baseline } : {} }, `Normalizing ${sample.name}`);
        const columns = { [BEAD_CHANNEL]: Float32Array.from(result.beadMask) };
        for (const name of result.corrected) {
          columns[`${name}${BEAD_SUFFIX}`] = result.columns[name];
          outputs.add(`${name}${BEAD_SUFFIX}`);
        }
        perSample.set(sample.id, columns);
        B.results.set(sample.id, { ...result, columns: null, name: sample.name, eventCount: view.eventCount });
        summaries[sample.id] = { beads: result.beadCount, percentBeads: (100 * result.beadCount) / view.eventCount, baseline: result.baseline, thresholds: result.thresholds };
      }
      await saveDerivedMerged({
        kind: 'normalization',
        name: 'Bead normalization',
        method: 'Bead normalization (Finck et al. 2013): running median of EQ beads over time, least-squares slope to the baseline',
        params: { beadChannels: ['Ce140', 'Eu151', 'Eu153', 'Ho165', 'Lu175'], window: 501, cofactor: 5, baseline: B.baseline === 'mean' && baseline ? { mode: 'shared mean of bead medians', values: baseline } : { mode: 'each file\'s bead medians' } },
        seed: null,
        outputs: [...outputs],
        summary: { perSample: summaries, references: [CITE.beads] },
      }, perSample, `Bead normalization (${list.length} sample${list.length === 1 ? '' : 's'})`);
      B.shownId = list.find((s) => s.id === B.sampleId)?.id ?? list[0].id;
      progress.done(`Bead-normalized ${list.length} sample${list.length === 1 ? '' : 's'}; new channels end in “(beads)”.`);
    } catch (error) {
      if (error.cancelled || token.cancelled) progress.done('Bead normalization stopped; nothing was saved.', 'ok');
      else progress.fail(error.message);
    }
    running = null;
    if (!destroyed && S.section === 'normalize') render();
  }

  // ===========================================================================================
  // Debarcode
  // ===========================================================================================

  function debarcodeSample() {
    const D = S.debarcode;
    const ws = store.ws;
    let sample = ws.samples.find((s) => s.id === D.sampleId);
    if (!sample) {
      const mass = ws.samples.filter((s) => s.technology === 'mass');
      const current = ws.samples.find((s) => s.id === store.ui.sampleId);
      sample = current && (current.technology === 'mass' || !mass.length) ? current : mass[0] ?? ws.samples[0] ?? null;
      D.sampleId = sample?.id ?? null;
    }
    return sample;
  }

  function barcodeChannels(sample) {
    const D = S.debarcode;
    if (D.channels) return D.channels.filter((name) => sample.channels.some((c) => c.name === name));
    const found = PALLADIUM.map((token) => findMassChannel(sample, token)).filter(Boolean);
    return found.length >= 3 ? found : [];
  }

  // A key from text: a header row naming the barcode channels (names or masses such as 102), then
  // one row per code: an id and 0/1 per channel.
  function parseKeyCSV(text, channels) {
    const rows = text.trim().split(/\r?\n/).map((line) => line.split(/[,;\t]/).map((cell) => cell.trim())).filter((row) => row.some(Boolean));
    if (rows.length < 2) throw new Error('The key needs a header row and at least one code.');
    const header = rows[0].slice(1);
    const mapped = header.map((token) => {
      const exact = channels.find((c) => c === token);
      if (exact) return exact;
      const mass = /\d{2,3}/.exec(token)?.[0];
      const hit = mass ? channels.filter((c) => new RegExp(`(^|\\D)${mass}(\\D|$)`).test(c)) : [];
      if (hit.length === 1) return hit[0];
      throw new Error(`Key column “${token}” matches ${hit.length ? 'more than one' : 'none'} of the selected barcode channels.`);
    });
    const codes = rows.slice(1).map((row, i) => ({ id: row[0] || String(i + 1), pattern: header.map((_, j) => (Number(row[j + 1]) ? 1 : 0)) }));
    return normalizeKey({ channels: mapped, codes });
  }

  function buildKey(channels) {
    const D = S.debarcode;
    if (D.keyMode === 'csv') return parseKeyCSV(D.csv, channels);
    return combinationKey(channels, Math.max(1, Math.min(channels.length - 1, Math.round(D.k))));
  }

  function renderDebarcode() {
    const ws = store.ws;
    const D = S.debarcode;
    const sample = debarcodeSample();
    const pane = h('div.pane');
    pane.append(h('h3', icon('tag'), 'Debarcoding'),
      explain('Barcoding pools many samples into one tube: each sample is labelled with its own combination of k of n barcode channels (for mass cytometry, palladium isotopes Pd102–Pd110), stained and acquired together, then split again. ',
        'Each event is assigned to the code whose positive channels are its k brightest barcode channels. The ', h('b', 'separation'), ' — the gap between the weakest positive and the strongest negative channel after scaling each population to its 95th percentile — says how sure that call is: doublets of two codes and debris have small separations. Events below the cutoff, or far from their population (Mahalanobis distance), stay unassigned.'));
    if (!sample) {
      pane.append(h('div.empty', icon('tag'), h('h3', 'No sample'), h('p', 'Add the barcoded FCS file first.')));
      sectionHost.append(pane);
      return;
    }
    // A sample can carry its barcode key (sample.barcodeKey, CSV as for "Paste a key"); it is
    // loaded once per sample and stays editable.
    if (sample.barcodeKey && D.keyFor !== sample.id) {
      D.keyFor = sample.id;
      D.keyMode = 'csv';
      D.csv = sample.barcodeKey;
    }
    if (sample.barcodeKey && D.keyMode === 'csv' && D.csv === sample.barcodeKey) pane.append(h('div.callout.accent', { style: { marginBottom: '8px' } }, icon('info'), h('span', `${sample.name} comes with its barcode key: the codes are named after the pooled samples.`)));
    const mass = ws.samples.filter((s) => s.technology === 'mass');
    if (!mass.length) pane.append(h('div.callout', icon('info'), h('span', 'Debarcoding is designed for mass-cytometry barcodes; none of the samples is a mass-cytometry file. You can still choose any channels as barcodes.')));
    const fluorescence = sample.channels.filter((c) => c.type === 'fluorescence');
    const chosen = barcodeChannels(sample);
    const checks = h('div.qc-checks', fluorescence.map((c) => h('label.check', { title: c.name },
      h('input', { type: 'checkbox', checked: chosen.includes(c.name), onchange: (event) => { D.channels = event.target.checked ? [...chosen, c.name] : chosen.filter((n) => n !== c.name); render(); } }),
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, c.marker ? `${c.name} · ${c.marker}` : c.name))));
    const keyMode = h('div.segmented',
      h(`button${D.keyMode === 'combination' ? '.active' : ''}`, { type: 'button', onclick: () => { D.keyMode = 'combination'; render(); } }, 'k of n'),
      h(`button${D.keyMode === 'csv' ? '.active' : ''}`, { type: 'button', onclick: () => { D.keyMode = 'csv'; render(); } }, 'Paste a key'));
    let keyInfo = null;
    let keyError = null;
    const k = Math.max(1, Math.min(chosen.length - 1, Math.round(D.k)));
    try {
      if (chosen.length >= 2) {
        const key = buildKey(chosen);
        keyInfo = D.keyMode === 'csv' ? `${key.codes.length} codes over ${key.channels.length} channels.` : `${chosen.length} choose ${k} = ${choose(chosen.length, k)} codes; every code has ${k} positive channels, so a doublet of two codes shows at least ${k + 1} bright channels and is caught.`;
      }
    } catch (error) {
      keyError = error.message;
    }
    const number = (label, key, step, min, max, title) => h('label.field', { title }, h('span', label),
      h('input.input.small', { type: 'number', step, min, max, value: D[key], style: { width: '86px' }, onchange: (event) => { const v = Number.parseFloat(event.target.value); if (Number.isFinite(v)) { D[key] = v; render(); } } }));
    pane.append(
      h('div.qc-toolbar',
        h('label.field', h('span', 'Sample'), h('select.input.small', { onchange: (event) => { D.sampleId = event.target.value; D.channels = null; render(); } },
          ws.samples.map((s) => h('option', { value: s.id, selected: s.id === sample.id }, `${s.name}${s.technology === 'mass' ? '' : ' (not mass cytometry)'}`)))),
        h('div.field', h('span', 'Key'), keyMode),
        D.keyMode === 'combination' ? number('Positive channels (k)', 'k', 1, 1, Math.max(1, chosen.length - 1), 'How many barcode channels are positive in every code') : null,
        number('Arcsinh cofactor', 'cofactor', 1, 0.1, 1000, 'Barcode intensities are compared on arcsinh(x / cofactor); 10 is the CATALYST default'),
        number('Mahalanobis cutoff', 'mahalanobis', 1, 1, 1000, 'Squared Mahalanobis distance to the population above which an event is unassigned (default 30)')),
      h('div.field-label', { style: { marginTop: '8px' } }, `Barcode channels (${chosen.length})`, chosen.length ? '' : ' — none detected; tick the barcode channels'),
      checks);
    if (D.keyMode === 'csv') {
      const textarea = h('textarea.input.mono', { rows: 6, placeholder: 'code,102,104,105,106,108,110\nA1,1,1,1,0,0,0\nA2,1,1,0,1,0,0\n…', style: { marginTop: '8px', fontSize: '12px' } });
      textarea.value = D.csv;
      textarea.addEventListener('input', () => { D.csv = textarea.value; });
      textarea.addEventListener('change', () => render());
      pane.append(textarea, h('p.muted.qc-small', 'First row: a label, then the barcode channels (names, or masses such as 102). Then one row per code: its id (for example the sample name) and 1/0 per channel. Commas, semicolons or tabs.'));
    }
    if (keyError) pane.append(h('div.callout.danger', { style: { marginTop: '8px' } }, icon('warning'), h('span', keyError)));
    else if (keyInfo) pane.append(h('div.callout', { style: { marginTop: '8px' } }, icon('info'), h('span', keyInfo)));
    pane.append(h('div.btn-row', { style: { marginTop: '10px' } },
      h('button.btn.primary', { type: 'button', disabled: chosen.length < 2 || Boolean(keyError) || Boolean(running), onclick: () => runDebarcode(sample) }, icon('play'), `Debarcode ${sample.name}`)));
    sectionHost.append(pane);
    const run = D.run?.sampleId === sample.id ? D.run : null;
    if (run) sectionHost.append(debarcodeResult(sample, run));
    sectionHost.append(h('div.pane', citations('debarcode')));
  }

  async function runDebarcode(sample, options = {}) {
    if (running && !options.quiet) return;
    const D = S.debarcode;
    const chosen = barcodeChannels(sample);
    let key;
    try {
      key = buildKey(chosen);
    } catch (error) {
      toast(error.message, { kind: 'error' });
      return;
    }
    const token = { cancelled: false, job: null };
    if (!options.quiet) running = token;
    const progress = options.quiet ? null : progressToast(`Debarcoding ${sample.name}…`, () => { token.cancelled = true; token.job?.cancel(); });
    try {
      const view = await data.ensure(sample.id);
      const params = { cofactor: D.cofactor, separationCutoff: D.cutoff, mahalanobisCutoff: D.mahalanobis };
      const job = track(worker.run('debarcode', { sample: samplePayload(view, key.channels), key, options: params }, { onProgress: (f, m) => progress?.update(f, m) }));
      token.job = job;
      const result = await job.promise;
      D.run = { sampleId: sample.id, key, params, result, at: new Date().toISOString() };
      progress?.done(`${formatPercent(result.percentAssigned)} of events assigned to a code.`);
    } catch (error) {
      if (error.cancelled || token.cancelled) progress?.done('Cancelled.', 'ok');
      else if (progress) progress.fail(error.message);
      else toast(error.message, { kind: 'error' });
    }
    if (!options.quiet) running = null;
    D.updating = false;
    if (!destroyed && S.section === 'debarcode') render();
  }

  const rerunDebarcode = debounce((sample) => runDebarcode(sample, { quiet: true }), 250);

  function debarcodeResult(sample, run) {
    const D = S.debarcode;
    const { result, key } = run;
    const pane = h('div.pane');
    const n = result.assignments.length;
    const grid = result.yields.cutoffs;
    const nearest = () => {
      let j = 0;
      for (let k = 1; k < grid.length; k += 1) if (Math.abs(grid[k] - D.cutoff) < Math.abs(grid[j] - D.cutoff)) j = k;
      return j;
    };
    const assignedCodes = result.counts.filter((c) => c > 0).length;
    const stale = Math.abs(run.params.separationCutoff - D.cutoff) > 1e-9 || run.params.mahalanobisCutoff !== D.mahalanobis || run.params.cofactor !== D.cofactor;
    const tableHost = h('div');
    const renderTable = () => {
      clear(tableHost);
      const j = nearest();
      const totalAssigned = n - result.unassigned;
      const body = h('tbody');
      key.codes.forEach((code, p) => {
        const positives = key.channels.filter((_, c) => code.pattern[c]).map((name) => name.replace(/Di$|Dd$/, '')).join(' ');
        body.append(h('tr',
          h('td', h('span.swatch', { style: { background: categoricalColor(p), marginRight: '6px' } }), h('b', code.id)),
          h('td.muted.mono', { style: { fontSize: '11px' } }, positives),
          h('td.r', formatCount(result.counts[p])),
          h('td.r', formatPercent((100 * result.counts[p]) / (totalAssigned || 1))),
          h('td.r.muted', { title: 'Events above the cutoff on the yield curve (before the Mahalanobis filter)' }, formatCount(result.yields.counts[p][j]))));
      });
      tableHost.append(h('div.qc-table-scroll.tall', h('table.data', h('thead', h('tr', h('th', 'Code'), h('th', 'Positive channels'), h('th.r', 'Events'), h('th.r', '% of assigned'), h('th.r', `At ${grid[j].toFixed(2)}`))), body)));
    };
    const plot = chart(230, (ctx, w, hgt, c) => drawYield(ctx, w, hgt, c, run, D.cutoff), 'qc-yield');
    let dragging = false;
    const setFromEvent = (event) => {
      const entry = plot.entry;
      if (!entry.layout) return;
      const rect = plot.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const value = Math.min(1, Math.max(0, (x - entry.layout.pad.l) / entry.layout.pw));
      D.cutoff = Math.round(value * 100) / 100;
      paint(entry);
      renderTable();
      cutoffLabel.textContent = `Separation cutoff ${D.cutoff.toFixed(2)}`;
    };
    plot.addEventListener('pointerdown', (event) => {
      dragging = true;
      plot.setPointerCapture(event.pointerId);
      setFromEvent(event);
    });
    plot.addEventListener('pointermove', (event) => { if (dragging) setFromEvent(event); });
    const release = () => {
      if (!dragging) return;
      dragging = false;
      D.updating = true;
      status.textContent = 'Updating assignments…';
      rerunDebarcode(sample);
    };
    plot.addEventListener('pointerup', release);
    plot.addEventListener('pointercancel', release);
    const cutoffLabel = h('span', `Separation cutoff ${D.cutoff.toFixed(2)}`);
    const status = h('span.muted', { style: { fontSize: '11.5px' } }, D.updating ? 'Updating assignments…' : stale ? 'Settings changed: run again to update.' : '');
    renderTable();
    const existingGates = store.ws.gates.filter((g) => g.type === 'category' && g.dims?.[0]?.channel === BARCODE_CHANNEL);
    pane.append(h('h3', icon('check'), `Result · ${sample.name}`, h('span.spacer'), status),
      h('div.stat-grid.qc-stats',
        h('div.stat-tile', h('div.k', 'Assigned'), h('div.v', formatPercent(result.percentAssigned))),
        h('div.stat-tile', h('div.k', 'Unassigned'), h('div.v', formatCount(result.unassigned))),
        h('div.stat-tile', h('div.k', 'Codes with events'), h('div.v', `${assignedCodes}/${key.codes.length}`)),
        h('div.stat-tile', h('div.k', 'Cutoff'), h('div.v', run.params.separationCutoff.toFixed(2)))),
      h('div.section-title', { style: { marginTop: '14px' } }, 'Yield against the separation cutoff'),
      explain('Each thin line is one code: the fraction of its events whose separation exceeds the cutoff. The thick line is all codes together. A good cutoff sits where the curves flatten — past the doublets and debris (steep drop at low cutoffs) but before real events are lost. Drag the cutoff; the assignments update when you let go.'),
      h('div.row', { style: { marginBottom: '6px' } }, cutoffLabel),
      h('div.qc-track', plot),
      h('div.section-title', { style: { marginTop: '14px' } }, 'Events per code'),
      tableHost,
      h('div.btn-row', { style: { marginTop: '10px' } },
        h('button.btn.primary.small', { type: 'button', disabled: stale || D.updating, title: stale ? 'Run again with the current settings first' : '', onclick: () => saveBarcodes(sample, run) }, icon('save'), `Save the “${BARCODE_CHANNEL}” channel`),
        h('button.btn.small', { type: 'button', disabled: Boolean(existingGates.length), title: existingGates.length ? 'Barcode gates exist already' : 'One category gate per code at the top of the gating tree', onclick: () => addBarcodeGates(run) }, icon('gate'), existingGates.length ? 'Gates per code exist' : 'Add a gate per code'),
        h('button.btn.small', { type: 'button', disabled: stale || D.updating, title: stale ? 'Run again with the current settings first' : 'One new sample per code, with that code\'s events (raw values and the original keywords), as if each had been acquired alone', onclick: () => splitIntoSamples(sample, run) }, icon('layers'), 'Split into samples'),
        stale ? h('button.btn.small', { type: 'button', onclick: () => runDebarcode(sample) }, icon('play'), 'Run again') : null),
      h('p.muted.qc-small', `“${BARCODE_CHANNEL}” holds the code number (1–${key.codes.length}, in the order of the table) or −1 for unassigned events; a category gate on it selects one code.`));
    return pane;
  }

  async function saveBarcodes(sample, run) {
    const { result, key, params } = run;
    const values = new Float32Array(result.assignments.length);
    for (let e = 0; e < values.length; e += 1) values[e] = result.assignments[e] >= 0 ? result.assignments[e] + 1 : -1;
    await saveDerivedMerged({
      kind: 'debarcode',
      name: 'Debarcoding',
      method: 'Single-cell debarcoding (Zunder et al. 2015): k-of-n separation with population-wise scaling and a Mahalanobis filter',
      params: { channels: key.channels, codes: key.codes, cofactor: params.cofactor, separationCutoff: params.separationCutoff, mahalanobisCutoff: params.mahalanobisCutoff },
      seed: null,
      outputs: [BARCODE_CHANNEL],
      summary: {
        references: [CITE.debarcode],
        perSample: { [sample.id]: { codes: key.codes.map((code, p) => ({ value: p + 1, id: code.id, count: result.counts[p] })), unassigned: result.unassigned, percentAssigned: result.percentAssigned, separationCutoff: params.separationCutoff } },
      },
    }, new Map([[sample.id, { [BARCODE_CHANNEL]: values }]]), `Debarcode ${sample.name}`);
    toast(`Saved “${BARCODE_CHANNEL}” for ${sample.name}: ${formatPercent(result.percentAssigned)} of events assigned.`, { kind: 'ok' });
  }

  // Writes each code's events as an FCS file of its own (raw values, the pooled file's keywords
  // and spillover) and adds them as samples in a group, the way CATALYST writes one file per
  // barcode. The new samples are named after the codes, so a key with sample names gives samples
  // that "Suggest from file names" can annotate.
  async function splitIntoSamples(sample, run) {
    const { result, key, params } = run;
    const view = await data.ensure(sample.id);
    const dataset = view.dataset;
    const base = { ...dataset.keywords };
    for (const name of Object.keys(base)) if (/^\$P\d+/.test(name) || /^\$(BEGIN|END|NEXTDATA|TOT|PAR)/.test(name)) delete base[name];
    const members = key.codes.map(() => []);
    result.assignments.forEach((code, e) => { if (code >= 0) members[code].push(e); });
    const items = [];
    key.codes.forEach((code, p) => {
      const events = members[p];
      if (!events.length) return;
      const fileName = `${String(code.id).replace(/[^\w.+-]+/g, '_')}.fcs`;
      const keywords = {
        ...base,
        $FIL: fileName,
        $ORIGINALITY: 'DataModified',
        'CYTOWEAVE DEBARCODE': `${sample.name}; code ${code.id}; separation cutoff ${params.separationCutoff}; Mahalanobis cutoff ${params.mahalanobisCutoff}`,
      };
      const columns = dataset.parameters.map((parameter) => {
        const column = dataset.data[parameter.index];
        const out = new Float32Array(events.length);
        for (let i = 0; i < events.length; i += 1) out[i] = column[events[i]];
        return out;
      });
      const bytes = writeFCS({ parameters: dataset.parameters.map((q) => ({ name: q.name, label: q.label, range: q.range })), data: columns, keywords });
      items.push({ name: fileName, bytes, order: items.length, folder: null });
    });
    if (!items.length) {
      toast('No code has events to split off.', { kind: 'error' });
      return;
    }
    const records = await app.importFCSItems(items, { select: false, noGroups: true });
    if (!records.length) return;
    let next = store.ws;
    for (const record of records) next = updateSample(next, record.id, { role: 'sample', meta: { ...record.meta, debarcodedFrom: sample.name } });
    next = addGroup(next, `Debarcoded ${sample.name.replace(/\.fcs$/i, '')}`, records.map((r) => r.id)).ws;
    store.commit(next, `Split ${sample.name} into ${records.length} samples`);
    toast(`Added ${records.length} samples, one per code. Annotate them (Suggest from file names) to compare them.`, { kind: 'ok', timeout: 7000 });
  }

  function addBarcodeGates(run) {
    const { key } = run;
    const gates = key.codes.map((code, p) => ({
      name: `Barcode ${code.id}`,
      type: 'category',
      dims: [{ channel: BARCODE_CHANNEL }],
      geometry: { values: [p + 1] },
      color: categoricalColor(p),
      parentId: null,
      meta: { origin: 'auto', method: 'Debarcoding', note: `Code ${code.id}` },
    }));
    gates.push({ name: 'Barcode unassigned', type: 'category', dims: [{ channel: BARCODE_CHANNEL }], geometry: { values: [-1] }, color: '#8a8f99', parentId: null, meta: { origin: 'auto', method: 'Debarcoding' } });
    store.commit(addGates(store.ws, gates, 'add-barcode-gates').ws, `Add ${gates.length} barcode gates`, ['gate']);
    toast(`Added ${gates.length} gates on “${BARCODE_CHANNEL}”. They select events once the channel is saved for a sample.`, { kind: 'ok' });
  }

  // --- Lifecycle --------------------------------------------------------------------------------

  render();
  return {
    update(topics) {
      if (destroyed) return;
      if (topics.has('theme')) repaintAll();
      if (topics.has('ws') || topics.has('derived') || topics.has('selection') || topics.has('workspace-loaded')) scheduleRender();
      else if (topics.has('data') && S.section === 'clean') scheduleCards();
      else if (topics.has('sample') && S.section === 'debarcode' && !S.debarcode.run) scheduleRender();
    },
    destroy() {
      destroyed = true;
      if (running) cancelRun();
      for (const job of jobs) job.cancel();
      rerunDebarcode.cancel();
      resizer.disconnect();
      live.clear();
      root.remove();
    },
  };
}
