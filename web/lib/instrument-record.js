// An instrument's characterization history: runs of multi-level beads or LED pulses (qb.js), each
// with every detector's Q, B and CV0, kept in the workspace that measured them and in the
// library's record of the instrument (kind INSTRUMENT_RECORDS), from which Levey–Jennings charts
// follow it across experiments.

import { characterize, findBeadPeaks, leveyJennings, QB_DEFAULTS } from './qb.js';

export const INSTRUMENT_RECORDS = 'instrument-qc';

// The metrics a Levey–Jennings chart can follow. The bead level is the same in every run: the
// brightest level kept (within the detector's linear range) in all of them, so a dimmer run is
// not compared with a different level.
export const LJ_METRICS = [
  { id: 'Q', label: 'Q (photoelectrons per unit)', of: (c) => c.Q },
  { id: 'B', label: 'B (photoelectrons)', of: (c) => c.B },
  { id: 'CV0', label: 'Intrinsic CV of the beads', of: (c) => c.CV0 },
  { id: 'level', label: 'Bead level, mean', level: true, of: (c, l) => c.peaks?.[l]?.mean },
  { id: 'levelCV', label: 'Bead level, CV', level: true, of: (c, l) => { const p = c.peaks?.[l]; return p ? p.sd / p.mean : null; } },
];

// The level a channel's bead-level metrics follow over runs: the brightest kept in all of them
// (runs with as many levels as the first), or null.
export function trackedLevel(runs, channel) {
  const withPeaks = runs.map((r) => r.channels?.[channel]?.peaks).filter((p) => p?.length);
  if (!withPeaks.length) return null;
  const n = withPeaks[0].length;
  let level = n - 1;
  for (const peaks of withPeaks) {
    if (peaks.length !== n) continue;
    let top = -1;
    peaks.forEach((p, i) => { if (!p.omit) top = i; });
    level = Math.min(level, top);
  }
  return level >= 0 ? level : null;
}

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// The acquisition time of a file from $DATE (dd-MMM-yyyy, or yyyy-mm-dd) and $BTIM, as an ISO
// string, or null.
export function acquisitionDate(keywords = {}) {
  const date = String(keywords.$DATE ?? '').trim();
  let y; let m; let d;
  let match = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$/.exec(date);
  if (match) {
    d = Number(match[1]);
    m = MONTHS[match[2].toUpperCase()];
    y = Number(match[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
  } else if ((match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date))) {
    [y, m, d] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  } else {
    return null;
  }
  if (m === undefined) return null;
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(keywords.$BTIM ?? ''));
  const stamp = Date.UTC(y, m, d, time ? Number(time[1]) : 0, time ? Number(time[2]) : 0, time?.[3] ? Number(time[3]) : 0);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

// The instrument a file was acquired on: { id, name, cytometer, serial }.
export function instrumentOf(keywords = {}) {
  const cytometer = String(keywords.$CYT ?? '').trim() || 'Unknown cytometer';
  const serial = String(keywords.$CYTSN ?? keywords.CYTNUM ?? '').trim();
  const id = `${cytometer}-${serial || 'unknown'}`.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unknown';
  return { id, name: serial ? `${cytometer} (${serial})` : cytometer, cytometer, serial };
}

// The fluorescence channels of a sample, area and (optionally) height.
export function fluorescenceChannels(sample, { heights = false } = {}) {
  return sample.channels.filter((c) => c.type === 'fluorescence' && (heights || !/-H$/.test(c.name)) && !/-W$/.test(c.name)).map((c) => c.name);
}

function compact(channel) {
  const { fit } = channel;
  const se = fit ? {
    Q: fit.se[1] / (fit.c[1] * fit.c[1]),
    // Delta method, ignoring the covariance of c0 and c1.
    B: Math.hypot(fit.se[0] / (fit.c[1] * fit.c[1]), (2 * fit.c[0] * fit.se[1]) / fit.c[1] ** 3),
  } : null;
  return {
    Q: fit?.Q ?? null,
    B: fit?.B ?? null,
    CV0: fit && Number.isFinite(fit.CV0) ? fit.CV0 : null,
    se,
    c: fit?.c ?? null,
    used: fit?.used ?? 0,
    iterations: fit?.iterations ?? 0,
    bright: channel.bright,
    peaks: channel.peaks.map((p) => ({ mean: p.mean, sd: p.sd, n: p.n, omit: p.omit, why: p.why || undefined })),
    residuals: fit?.residuals ?? null,
  };
}

// Characterizes one multi-level bead sample. view: its SampleView; sample: its record. options:
// { peaks, channels, maximum (bound on peak means), product, seed }. Returns a run.
export function beadRun(view, sample, options) {
  const channels = options.channels ?? fluorescenceChannels(sample);
  const columns = Object.fromEntries([...view.raw.entries()]);
  const scatter = ['FSC-A', 'SSC-A'].every((c) => columns[c]) ? ['FSC-A', 'SSC-A'] : null;
  const range = Number(sample.channels.find((c) => c.name === channels[0])?.range) || 262144;
  const { events, labels } = findBeadPeaks(columns, { channels, scatter, peaks: options.peaks, range, seed: options.seed });
  const byChannel = {};
  for (const ch of channels) {
    const peaks = Array.from({ length: options.peaks }, () => []);
    const column = columns[ch];
    events.forEach((e, k) => peaks[labels[k]].push(column[e]));
    byChannel[ch] = peaks;
  }
  const bounds = { ...QB_DEFAULTS.bounds, maximum: options.maximum ?? QB_DEFAULTS.bounds.maximum * (range / 262144) };
  const results = characterize(byChannel, { bounds });
  return {
    id: sample.sha256 ?? sample.id,
    date: acquisitionDate(sample.keywords) ?? sample.added ?? null,
    file: sample.fileName ?? sample.name,
    sha256: sample.sha256 ?? null,
    method: 'beads',
    product: options.product ?? null,
    peaks: options.peaks,
    gated: events.length,
    events: view.eventCount,
    bounds,
    channels: Object.fromEntries(Object.entries(results).map(([ch, r]) => [ch, compact(r)])),
  };
}

// Characterizes a series of files with one level each (an LED pulser, or single-level beads),
// all events of each file being its peak. items: [{ view, sample }] in any order. Returns a run
// dated by its first file.
export function seriesRun(items, options = {}) {
  const sample = items[0].sample;
  const channels = options.channels ?? fluorescenceChannels(sample);
  const range = Number(sample.channels.find((c) => c.name === channels[0])?.range) || 262144;
  const byChannel = Object.fromEntries(channels.map((ch) => [ch, items.map(({ view }) => view.raw.get(ch))]));
  const bounds = { ...QB_DEFAULTS.bounds, maximum: options.maximum ?? QB_DEFAULTS.bounds.maximum * (range / 262144) };
  const results = characterize(byChannel, { bounds });
  const dates = items.map(({ sample: s }) => acquisitionDate(s.keywords)).filter(Boolean).sort();
  return {
    id: items.map(({ sample: s }) => s.sha256 ?? s.id).sort().join('+').slice(0, 200),
    date: dates[0] ?? null,
    file: `${items.length} files (${items[0].sample.name} …)`,
    sha256: null,
    files: items.map(({ sample: s }) => s.fileName ?? s.name),
    method: 'series',
    peaks: items.length,
    events: items.reduce((sum, { view }) => sum + view.eventCount, 0),
    bounds,
    channels: Object.fromEntries(Object.entries(results).map(([ch, r]) => [ch, compact(r)])),
  };
}

// A record with a run added (or replaced, by id), runs in date order.
export function withRun(record, run) {
  const runs = [...(record.runs ?? []).filter((r) => r.id !== run.id), run].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
  return { ...record, runs, modified: new Date().toISOString() };
}

// Runs of one instrument from several sources (the workspace's, the library's), each once (by
// id; the first source wins), in date order, each marked with its source.
export function mergeRuns(...sources) {
  const seen = new Map();
  for (const { runs, source } of sources) for (const run of runs ?? []) if (!seen.has(run.id)) seen.set(run.id, { ...run, source });
  return [...seen.values()].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
}

// A Levey–Jennings series of one detector and metric over runs: { values, ...leveyJennings }.
export function ljSeries(runs, channel, metricId, options = {}) {
  const metric = LJ_METRICS.find((m) => m.id === metricId) ?? LJ_METRICS[0];
  const level = metric.level ? trackedLevel(runs, channel) : null;
  const values = runs.map((r) => {
    const c = r.channels?.[channel];
    if (!c || (metric.level && (level === null || c.peaks?.length !== runs.find((x) => x.channels?.[channel])?.channels[channel].peaks.length))) return null;
    const v = metric.of(c, level);
    return Number.isFinite(v) ? v : null;
  });
  return { values, level, ...leveyJennings(values, options) };
}

// Every detector and metric flagged on a run (rules that reject: see REJECT_RULES).
export function runFlags(runs, index, options = {}) {
  const flags = [];
  const channels = new Set(runs.flatMap((r) => Object.keys(r.channels ?? {})));
  for (const ch of channels) {
    for (const metric of LJ_METRICS.filter((m) => ['Q', 'B', 'level'].includes(m.id))) {
      const series = ljSeries(runs, ch, metric.id, options);
      const f = series.flags[index];
      if (f?.rules.length) flags.push({ channel: ch, metric: metric.id, z: f.z, rules: f.rules });
    }
  }
  return flags;
}
