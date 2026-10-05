// Calibrated units from multi-level beads: MEF (molecules of equivalent fluorochrome, such as
// MEFL for fluorescein) or ERF (equivalent reference fluorophores), following FlowCal
// (Castillo-Hair et al. 2016, "FlowCal: a user-friendly, open source software tool for
// automatically converting flow cytometry data from arbitrary to calibrated units", ACS Synth Biol
// 5:774–780, doi:10.1021/acssynbio.5b00284):
//   1. the bead sample's intensity levels are found together on one or more channels;
//   2. each level's median is taken on the channel to calibrate;
//   3. levels near either end of the channel's range are left out: on the logicle scale, the
//      level's mean ± 2.5 SD must lie within 1.5%–98.5% of the range (FlowCal's selection_std);
//   4. the bead model m·ln(RFI) + b = ln(MEF + MEF_auto), with MEF_auto ≥ 0 the beads'
//      autofluorescence, is fitted by least squares in log space to the levels left and their
//      values from the manufacturer's datasheet (a level without a value, such as an uncalibrated
//      blank, is left out);
//   5. the standard curve MEF = sign(RFI)·e^b·|RFI|^m converts any value, without the beads'
//      autofluorescence (cells have their own).
// The conversion holds for samples acquired with the same settings as the beads.

import { findBeadPeaks } from './qb.js';
import { createTransform } from './transforms.js';

// Common calibration units, with the fluorochromes they are named after.
export const UNITS = [
  { id: 'MEFL', label: 'MEFL (fluorescein)' },
  { id: 'MEPE', label: 'MEPE (phycoerythrin)' },
  { id: 'MEAPC', label: 'MEAPC (allophycocyanin)' },
  { id: 'MEPTR', label: 'MEPTR (PE–Texas Red)' },
  { id: 'MECY', label: 'MECY (PE–Cy5)' },
  { id: 'MEPCY7', label: 'MEPCY7 (PE–Cy7)' },
  { id: 'MEBFP', label: 'MEBFP (blue fluorescent protein)' },
  { id: 'ERF', label: 'ERF (equivalent reference fluorophores)' },
];

// The standard curve of fitted parameters { m, b }: sign(x)·e^b·|x|^m (odd, so negative values
// stay negative, as FlowCal extends it).
export function standardCurve({ m, b }) {
  const scale = Math.exp(b);
  return (x) => Math.sign(x) * scale * Math.abs(x) ** m;
}

// The linear range of a channel as the file describes it: [lowest, highest] value after $PnE and
// $PnG, as FlowCal's FCSData.range after to_rfi: [0, (R − 1)/G] for a linear channel,
// [f2, f2·10^(f1·(R − 1)/R)] for a log-amplified one (f2 = 1 when the file gives 0).
export function channelBounds(keywords, index, range) {
  const n = index + 1;
  const [f1 = 0, f2 = 0] = String(keywords?.[`$P${n}E`] ?? '0,0').split(',').map(Number);
  const R = Number(keywords?.[`$P${n}R`]) || range;
  if (f1 > 0) {
    const low = f2 > 0 ? f2 : 1;
    return [low, low * 10 ** ((f1 * (R - 1)) / R)];
  }
  const gain = Number(keywords?.[`$P${n}G`]) || 1;
  return [0, (R - 1) / gain];
}

// FlowCal's logicle in decades (its _LogicleTransform with data): T the top of the range,
// M = max(4.5, 4.5·log10(T)/log10(262144)), W = (M − log10(T/|r|))/2 for the lowest negative
// value r (0 without negative values).
function displayScale(T, values) {
  const M = Math.max(4.5, (4.5 / Math.log10(262144)) * Math.log10(T));
  let lowest = 0;
  for (const v of values) if (v < lowest) lowest = v;
  const W = lowest < 0 ? Math.max(0, (M - Math.log10(T / Math.abs(lowest))) / 2) : 0;
  const transform = createTransform({ type: 'logicle', T, W, M, A: 0 });
  return (x) => transform.forward(x) * M;
}

// Which levels to keep (FlowCal's selection_std): levels [values] of one channel and the channel's
// range [low, high]. Returns per level { mean, sd (on the logicle scale, in decades), used, why }.
export function selectLevels(levels, bounds, options = {}) {
  const nLow = options.nLow ?? 2.5;
  const nHigh = options.nHigh ?? 2.5;
  const scale = displayScale(bounds[1], levels[0] ?? []);
  const lo = scale(bounds[0]);
  const hi = scale(bounds[1]);
  const low = lo + 0.015 * (hi - lo);
  const high = lo + 0.985 * (hi - lo);
  return levels.map((values) => {
    let sum = 0;
    for (const v of values) sum += scale(v);
    const mean = sum / values.length;
    let ss = 0;
    for (const v of values) ss += (scale(v) - mean) ** 2;
    const sd = Math.max(0.005, Math.sqrt(ss / values.length));
    const tooLow = mean - nLow * sd <= low;
    const tooHigh = mean + nHigh * sd >= high;
    return { mean, sd, used: !tooLow && !tooHigh, why: tooLow ? 'too close to the bottom of the range' : tooHigh ? 'too close to the top of the range (saturating)' : '' };
  });
}

function median(values) {
  const s = Float64Array.from(values).sort();
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : Number.NaN;
}

// The bead model m·ln(x) + b = ln(y + a), a ≥ 0, by least squares in log space. For a given a,
// m and b follow from a straight-line fit of ln(y + a) on ln(x), so the fit searches a alone. The
// residuals shrink without bound as a grows (ln(y + a) flattens), so, as FlowCal does, the search
// is local: from FlowCal's starting point (the line through the two brightest levels, and a from
// the dimmest), downhill to the nearest minimum, refined by golden section. Levels are in order
// of brightness. Returns { m, b, autofluorescence, rss, n }.
export function fitBeadModel(rfi, mef) {
  const n = rfi.length;
  if (n < 3) throw new Error('A standard curve needs three or more bead levels with known values.');
  if (rfi.some((x) => !(x > 0))) throw new Error('Bead levels must be above zero to be fitted in log space.');
  const lx = rfi.map(Math.log);
  const line = (a) => {
    const ly = mef.map((y) => Math.log(y + a));
    if (ly.some((v) => !Number.isFinite(v))) return { rss: Infinity, a };
    const mx = lx.reduce((s, v) => s + v, 0) / n;
    const my = ly.reduce((s, v) => s + v, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i += 1) {
      sxy += (lx[i] - mx) * (ly[i] - my);
      sxx += (lx[i] - mx) ** 2;
    }
    const m = sxy / sxx;
    const b = my - m * mx;
    let rss = 0;
    for (let i = 0; i < n; i += 1) rss += (ly[i] - (m * lx[i] + b)) ** 2;
    return { m, b, rss, a };
  };
  const top = Math.max(...mef);
  const floor = Math.min(...mef) > 0 ? 0 : top * 1e-12;
  // FlowCal's starting point.
  const m0 = (Math.log(mef[n - 1]) - Math.log(mef[n - 2])) / (lx[n - 1] - lx[n - 2]);
  const b0 = Math.log(mef[n - 1]) - m0 * lx[n - 1];
  let a = Math.exp(m0 * lx[0] + b0) - mef[0];
  if (!(a > floor)) a = Math.max(floor, top * 1e-6);
  // Downhill in ln(a) by steps of 10%, then golden section on the bracket.
  const f = (t) => line(Math.exp(t)).rss;
  const step = Math.log(1.1);
  let t = Math.log(a);
  let ft = f(t);
  const direction = f(t + step) < ft ? 1 : f(t - step) < ft ? -1 : 0;
  let lo = t - step;
  let hi = t + step;
  if (direction) {
    for (let k = 0; k < 2000; k += 1) {
      const next = t + direction * step;
      const fn = f(next);
      if (!(fn < ft)) break;
      t = next;
      ft = fn;
      if (Math.exp(t) > top * 1e6) throw new Error('The beads\' autofluorescence could not be fitted: check the levels\' values.');
      if (Math.exp(t) <= Math.max(floor, top * 1e-12)) break;
    }
    lo = t - step;
    hi = t + step;
  }
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 300 && hi - lo > 1e-14; i += 1) {
    const c = hi - g * (hi - lo);
    const d = lo + g * (hi - lo);
    if (f(c) < f(d)) hi = d;
    else lo = c;
  }
  let best = line(Math.exp((lo + hi) / 2));
  // At the boundary a = 0 when every value is positive.
  if (floor === 0) {
    const zero = line(0);
    if (zero.rss <= best.rss) best = zero;
  }
  return { m: best.m, b: best.b, autofluorescence: best.a, rss: best.rss, n };
}

// The calibration of one or more channels from a bead sample. columns: { name → Float32Array };
// options: { channels (to calibrate), values: { channel → [value per level, dimmest first; null
// for unknown] }, clustering (channels to find the levels on; default the calibrated ones),
// events (indices of the bead population; default flowQB's scatter gate on `scatter`),
// scatter: [fsc, ssc], bounds: { channel → [low, high] }, unit, seed }.
// Returns { events, levels: n, channels: { channel → { levels: [{ n, median, mean, sd, value,
// used, why }], fit, unit } } }.
export function calibrateBeads(columns, options) {
  const { channels, values } = options;
  const peaks = Math.max(...channels.map((c) => values[c]?.length ?? 0));
  if (!(peaks >= 3)) throw new Error('Give the beads\' values for three or more levels.');
  for (const channel of channels) {
    if (values[channel]?.length !== peaks) throw new Error(`${channel}: give a value (or a blank) for each of the ${peaks} levels.`);
  }
  const clustering = options.clustering?.length ? options.clustering : channels;
  const found = findBeadPeaks(options.events ? subset(columns, [...new Set([...clustering, ...channels])], options.events) : columns, {
    channels: clustering,
    peaks,
    scatter: options.events ? null : options.scatter,
    seed: options.seed ?? 1,
    // Log-like spacing for dim levels, as FlowCal's logicle without negative values (W = 0).
    width: 0,
    range: Math.max(...clustering.map((c) => options.bounds?.[c]?.[1] ?? 262144)),
  });
  const events = options.events ? Uint32Array.from(found.events, (k) => options.events[k]) : found.events;
  const out = {};
  for (const channel of channels) {
    const column = columns[channel];
    const levels = Array.from({ length: peaks }, () => []);
    found.labels.forEach((label, k) => levels[label].push(column[events[k]]));
    const empty = levels.findIndex((l) => !l.length);
    if (empty >= 0) throw new Error(`No events were found at bead level ${empty + 1}.`);
    const selection = selectLevels(levels, options.bounds?.[channel] ?? [0, 262143]);
    const rows = levels.map((l, i) => {
      const value = values[channel][i];
      const known = value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
      const used = selection[i].used && known;
      return { n: l.length, median: median(l), mean: selection[i].mean, sd: selection[i].sd, value: known ? Number(value) : null, used, why: !known ? 'no value given' : selection[i].why };
    });
    const kept = rows.filter((r) => r.used);
    let fit = null;
    let error = null;
    try {
      fit = fitBeadModel(kept.map((r) => r.median), kept.map((r) => r.value));
    } catch (e) {
      error = e.message;
    }
    out[channel] = { levels: rows, fit, error, unit: options.unit?.[channel] ?? options.unit ?? 'MEF' };
  }
  return { events, levels: peaks, channels: out };
}

function subset(columns, names, indices) {
  const out = {};
  for (const name of names) out[name] = Float32Array.from(indices, (e) => columns[name][e]);
  return out;
}

// The derived record of a calibrated channel: a computed channel "<channel> <unit>" for the given
// samples (null: every sample).
export function calibrationRecord(channel, result, { unit, beads, samples = null, id }) {
  return {
    id,
    kind: 'calibration',
    name: `${channel} in ${unit}`,
    inputs: [channel],
    outputs: [`${channel} ${unit}`],
    params: { m: result.fit.m, b: result.fit.b, autofluorescence: result.fit.autofluorescence, unit, beads, levels: result.levels.map((l) => ({ median: l.median, value: l.value, used: l.used })) },
    samples,
    created: new Date().toISOString(),
  };
}
