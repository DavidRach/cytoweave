// Kinetics (A4): a signal or a ratio against time, as in a calcium flux assay (Indo-1 violet/blue,
// Fluo-4), with the response measured from the curve.
//
// Events are binned by acquisition time; each bin gives a statistic of the population's values
// (median, mean, or the percentage above a threshold), and a centered moving average smooths the
// bins. The stimulus is where acquisition paused (the tube taken out to add it: the longest gap
// between events, when it is far longer than the usual interval), or is given; without either,
// the response's onset is found as a step in the curve. From the curve:
//   baseline        the statistic of every event before the stimulus;
//   peak            the smoothed curve's maximum after the stimulus, and the time to it: when
//                   the curve first comes within 3% of the amplitude of the maximum (a plateau's
//                   maximum is wherever its noise puts it);
//   amplitude, fold the peak above and over the baseline;
//   half-max time   when the curve first reaches the baseline plus half the amplitude;
//   area            under the smoothed curve above the baseline, from the stimulus (or when
//                   acquisition resumed) to the end of the response window (value × seconds);
//   end level       the smoothed curve over the last tenth of the response window;
//   responding      the percentage of events above a threshold (by default the 99th percentile of
//                   the baseline events), at its smoothed maximum after the stimulus, and net of the
//                   baseline's own share above it: (p − p₀) / (1 − p₀).
// A cell is measured once, so "responding" is the share responding at that moment: cells whose
// response has not started or has already ended are not counted.

import { quantileSorted } from './stats.js';

const finite = (v) => Number.isFinite(v);

// The values to follow: one channel, or the ratio of two (events where either is not positive are
// left out, as a ratio of noise around zero means nothing). columns: { name → Float32Array }.
// Returns { values (Float64Array, NaN where left out), excluded, label }.
export function kineticsMeasure(columns, spec) {
  if (spec.numerator) {
    const a = columns[spec.numerator];
    const b = columns[spec.denominator];
    if (!a || !b) throw new Error(`The sample has no ${!a ? spec.numerator : spec.denominator} channel.`);
    const values = new Float64Array(a.length);
    let excluded = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] > 0 && b[i] > 0) values[i] = a[i] / b[i];
      else {
        values[i] = Number.NaN;
        excluded += 1;
      }
    }
    return { values, excluded, label: `${spec.numeratorLabel ?? spec.numerator} / ${spec.denominatorLabel ?? spec.denominator}` };
  }
  const column = columns[spec.channel];
  if (!column) throw new Error(`The sample has no ${spec.channel} channel.`);
  return { values: Float64Array.from(column), excluded: 0, label: spec.label ?? spec.channel };
}

// Event times in seconds from a time column and $TIMESTEP (seconds per unit).
export function eventSeconds(timeColumn, timestep) {
  return Float64Array.from(timeColumn, (v) => v * timestep);
}

// The longest pause in acquisition, when it is at least `minimum` seconds (2) and 50 times the
// median interval between events, away from the first and last tenth: { start, end } or null.
export function findPause(times, options = {}) {
  const n = times.length;
  if (n < 100) return null;
  const sorted = isSorted(times) ? times : Float64Array.from(times).sort();
  const intervals = new Float64Array(n - 1);
  for (let i = 1; i < n; i += 1) intervals[i - 1] = sorted[i] - sorted[i - 1];
  const typical = quantileSorted(Float64Array.from(intervals).sort(), 0.5);
  const span = sorted[n - 1] - sorted[0];
  let best = -1;
  for (let i = 0; i < n - 1; i += 1) {
    const t = sorted[i];
    if (t < sorted[0] + 0.1 * span || t > sorted[n - 1] - 0.1 * span) continue;
    if (best < 0 || intervals[i] > intervals[best]) best = i;
  }
  if (best < 0) return null;
  const length = intervals[best];
  if (length < Math.max(options.minimum ?? 2, 50 * typical)) return null;
  return { start: sorted[best], end: sorted[best + 1] };
}

function isSorted(values) {
  for (let i = 1; i < values.length; i += 1) if (values[i] < values[i - 1]) return false;
  return true;
}

// A bin width (s) giving about 150 bins and at least 50 events per bin, rounded to 1, 2 or 5 × 10ⁿ.
export function autoBinWidth(duration, events) {
  if (!(duration > 0) || !events) return 1;
  const raw = Math.max(duration / 150, (50 * duration) / events);
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * power >= raw) return m * power;
  return 10 * power;
}

// Per-bin statistic of the population's values: { start, binWidth, centers, counts, values }.
// statistic: 'median' | 'mean' | 'percent' (above options.threshold).
export function binStatistic(times, values, indices, options) {
  const { binWidth, start, end } = options;
  const bins = Math.max(1, Math.ceil((end - start) / binWidth));
  const lists = Array.from({ length: bins }, () => []);
  const each = (i) => {
    const v = values[i];
    if (!finite(v)) return;
    const b = Math.floor((times[i] - start) / binWidth);
    if (b >= 0 && b < bins) lists[b].push(v);
  };
  if (indices) for (const i of indices) each(i);
  else for (let i = 0; i < values.length; i += 1) each(i);
  const centers = Float64Array.from({ length: bins }, (_, b) => start + (b + 0.5) * binWidth);
  const counts = Int32Array.from(lists, (l) => l.length);
  const minimum = options.minimumEvents ?? 10;
  const out = Float64Array.from(lists, (l) => (l.length >= minimum ? statistic(l, options.statistic, options.threshold) : Number.NaN));
  return { start, binWidth, centers, counts, values: out };
}

function statistic(list, kind, threshold) {
  if (kind === 'mean') {
    let s = 0;
    for (const v of list) s += v;
    return s / list.length;
  }
  if (kind === 'percent') {
    let above = 0;
    for (const v of list) if (v > threshold) above += 1;
    return (100 * above) / list.length;
  }
  return quantileSorted(Float64Array.from(list).sort(), 0.5);
}

// Centered moving average over `window` bins (odd), skipping empty bins; an empty bin stays empty.
export function smoothBins(values, window) {
  const half = Math.floor(Math.max(1, window) / 2);
  return Float64Array.from(values, (v, b) => {
    if (!finite(v)) return Number.NaN;
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, b - half); k <= Math.min(values.length - 1, b + half); k += 1) {
      if (finite(values[k])) {
        s += values[k];
        n += 1;
      }
    }
    return n ? s / n : Number.NaN;
  });
}

// The onset of a response without a pause: the split of the smoothed curve into two levels that
// leaves the least squared error (between 10% and 90% of the bins), then, walking back from it,
// the first bin of the run that stays above the first level by 3 of its bin-to-bin SDs. Null when
// the two levels differ by less than 5 such SDs.
function findOnset(centers, smooth) {
  const idx = [];
  for (let b = 0; b < smooth.length; b += 1) if (finite(smooth[b])) idx.push(b);
  if (idx.length < 20) return null;
  const prefix = [0];
  const prefix2 = [0];
  for (const b of idx) {
    prefix.push(prefix.at(-1) + smooth[b]);
    prefix2.push(prefix2.at(-1) + smooth[b] ** 2);
  }
  const sse = (i, j) => {
    const n = j - i;
    const s = prefix[j] - prefix[i];
    return prefix2[j] - prefix2[i] - (s * s) / n;
  };
  const n = idx.length;
  let split = -1;
  let best = Infinity;
  for (let k = Math.floor(0.1 * n); k <= Math.floor(0.9 * n); k += 1) {
    const e = sse(0, k) + sse(k, n);
    if (e < best) {
      best = e;
      split = k;
    }
  }
  const before = idx.slice(0, split).map((b) => smooth[b]);
  const level = before.reduce((a, b) => a + b, 0) / before.length;
  const diffs = [];
  for (let k = 1; k < before.length; k += 1) diffs.push(Math.abs(before[k] - before[k - 1]));
  const sd = Math.max(1e-12, (diffs.length ? quantileSorted(Float64Array.from(diffs).sort(), 0.5) : 0) / (0.6745 * Math.SQRT2));
  const after = idx.slice(split).map((b) => smooth[b]);
  const levelAfter = after.reduce((a, b) => a + b, 0) / after.length;
  if (Math.abs(levelAfter - level) < 5 * sd) return null;
  const rising = levelAfter > level;
  let onset = split;
  while (onset > 0 && (rising ? smooth[idx[onset - 1]] > level + 3 * sd : smooth[idx[onset - 1]] < level - 3 * sd)) onset -= 1;
  return { time: centers[idx[onset]] - 0.5 * (centers[1] - centers[0]), level, sd };
}

// The whole analysis. times: seconds per event; values: the measure per event (NaN left out);
// options: { indices (the population's events; all when absent), statistic ('median' | 'mean'),
// binWidth (s, or automatic), smoothing (bins, odd; 3), stimulus (s; found when absent),
// pause ({ start, end }: found from options.allTimes, all events' times, when absent), baselineStart,
// responseEnd (s), threshold (for responding; the baseline's 99th percentile when absent) }.
export function analyzeKinetics(times, values, options = {}) {
  const indices = options.indices ?? null;
  const n = indices ? indices.length : times.length;
  if (n < 100) throw new Error(`Only ${n} events: a kinetic curve needs at least 100.`);
  let first = Infinity;
  let last = -Infinity;
  let used = 0;
  const visit = (fn) => {
    if (indices) for (const i of indices) fn(i);
    else for (let i = 0; i < times.length; i += 1) fn(i);
  };
  visit((i) => {
    if (!finite(values[i])) return;
    used += 1;
    if (times[i] < first) first = times[i];
    if (times[i] > last) last = times[i];
  });
  if (used < 100) throw new Error(`Only ${used} events have a value: a kinetic curve needs at least 100.`);
  const warnings = [];
  const binWidth = options.binWidth > 0 ? options.binWidth : autoBinWidth(last - first, used);
  const smoothing = Math.max(1, Math.round(options.smoothing ?? 3));
  const window = smoothing % 2 ? smoothing : smoothing + 1;
  const start = Math.floor(first / binWidth) * binWidth;
  const end = last + 1e-9;

  // The stimulus: given, a pause, or the onset of the response.
  const pause = options.pause !== undefined ? options.pause : findPause(options.allTimes ?? times);
  const median = binStatistic(times, values, indices, { binWidth, start, end, statistic: options.statistic ?? 'median' });
  const smooth = smoothBins(median.values, window);
  let stimulus = null;
  if (finite(options.stimulus)) stimulus = { time: options.stimulus, source: 'given', resume: pause && pause.start <= options.stimulus && pause.end > options.stimulus ? pause.end : options.stimulus };
  else if (pause) stimulus = { time: pause.start, source: 'pause', resume: pause.end };
  else {
    const onset = findOnset(median.centers, smooth);
    if (onset) {
      stimulus = { time: onset.time, source: 'onset', resume: onset.time };
      warnings.push(`No pause in acquisition marks the stimulus, so the response's onset (${onset.time.toFixed(1)} s) is used: times are counted from it, not from when the stimulus was added. Enter the stimulus time if it is known.`);
    }
  }
  const responseEnd = finite(options.responseEnd) ? Math.min(options.responseEnd, last) : last;
  const baselineStart = finite(options.baselineStart) ? options.baselineStart : first;
  const baselineEnd = stimulus ? stimulus.time : last;

  // Baseline: every event before the stimulus.
  const before = [];
  visit((i) => { if (finite(values[i]) && times[i] >= baselineStart && times[i] < baselineEnd) before.push(values[i]); });
  if (before.length < 50) throw new Error(`Only ${before.length} events before the stimulus: the baseline needs at least 50 (set the stimulus later or the baseline start earlier).`);
  const sortedBefore = Float64Array.from(before).sort();
  const statOf = (list) => statistic(list, options.statistic ?? 'median');
  const baseline = statOf(before);
  const threshold = finite(options.threshold) ? options.threshold : quantileSorted(sortedBefore, 0.99);
  const baselineAbove = (100 * before.filter((v) => v > threshold).length) / before.length;
  // Bin-to-bin variation of the baseline bins (robust: from successive differences).
  const baseBins = [];
  for (let b = 0; b < median.centers.length; b += 1) if (finite(median.values[b]) && median.centers[b] < baselineEnd && median.centers[b] >= baselineStart) baseBins.push(median.values[b]);
  const diffs = [];
  for (let k = 1; k < baseBins.length; k += 1) diffs.push(Math.abs(baseBins[k] - baseBins[k - 1]));
  const baselineSD = diffs.length ? quantileSorted(Float64Array.from(diffs).sort(), 0.5) / (0.6745 * Math.SQRT2) : Number.NaN;

  const percent = binStatistic(times, values, indices, { binWidth, start, end, statistic: 'percent', threshold });
  const percentSmooth = smoothBins(percent.values, window);

  const result = {
    statistic: options.statistic ?? 'median',
    events: used,
    excluded: n - used,
    first,
    last,
    binWidth,
    smoothing: window,
    pause,
    stimulus,
    baselineWindow: [baselineStart, baselineEnd],
    responseWindow: stimulus ? [stimulus.resume, responseEnd] : null,
    baseline,
    baselineSD,
    baselineEvents: before.length,
    threshold,
    baselineAbove,
    curve: { centers: median.centers, counts: median.counts, values: median.values, smooth },
    percentCurve: { values: percent.values, smooth: percentSmooth },
    warnings,
  };
  if (!stimulus) {
    warnings.push('No stimulus was found (no pause in acquisition and no step in the curve): there is no response to measure. Enter the stimulus time to measure one.');
    return result;
  }
  // The response, from when acquisition resumed to the end of the window.
  let peakBin = -1;
  let percentBin = -1;
  for (let b = 0; b < smooth.length; b += 1) {
    const c = median.centers[b];
    if (c < stimulus.resume || c > responseEnd) continue;
    if (finite(smooth[b]) && (peakBin < 0 || smooth[b] > smooth[peakBin])) peakBin = b;
    if (finite(percentSmooth[b]) && (percentBin < 0 || percentSmooth[b] > percentSmooth[percentBin])) percentBin = b;
  }
  if (peakBin < 0) {
    warnings.push('No events after the stimulus.');
    return result;
  }
  const peak = smooth[peakBin];
  const amplitude = peak - baseline;
  // When the curve first comes within 3% of the amplitude of its maximum: the maximum itself for
  // a sharp peak, the start of the plateau for a sustained response (whose exact maximum is wherever
  // the noise puts it).
  let reachBin = peakBin;
  for (let b = 0; b <= peakBin; b += 1) {
    if (median.centers[b] < stimulus.resume || !finite(smooth[b])) continue;
    if (smooth[b] >= peak - 0.03 * Math.abs(amplitude)) {
      reachBin = b;
      break;
    }
  }
  const peakTime = median.centers[reachBin];
  let halfMax = null;
  for (let b = 0; b <= peakBin; b += 1) {
    if (median.centers[b] < stimulus.resume || !finite(smooth[b])) continue;
    if (smooth[b] >= baseline + 0.5 * amplitude) {
      // Interpolated within the bin from the previous one.
      const prev = b > 0 && finite(smooth[b - 1]) && median.centers[b - 1] >= stimulus.resume ? b - 1 : -1;
      halfMax = prev >= 0 && smooth[b] > smooth[prev]
        ? median.centers[prev] + ((baseline + 0.5 * amplitude - smooth[prev]) / (smooth[b] - smooth[prev])) * binWidth
        : median.centers[b];
      break;
    }
  }
  // Area above the baseline (trapezoids between bins with values; empty bins are bridged).
  let area = 0;
  let prev = null;
  for (let b = 0; b < smooth.length; b += 1) {
    const c = median.centers[b];
    if (c < stimulus.resume || c > responseEnd || !finite(smooth[b])) continue;
    if (prev) area += 0.5 * (prev.v + (smooth[b] - baseline)) * (c - prev.c);
    prev = { c, v: smooth[b] - baseline };
  }
  const tail = [];
  for (let b = 0; b < smooth.length; b += 1) {
    const c = median.centers[b];
    if (c >= responseEnd - 0.1 * (responseEnd - stimulus.resume) && c <= responseEnd && finite(smooth[b])) tail.push(smooth[b]);
  }
  const responding = percentBin >= 0 ? percentSmooth[percentBin] : Number.NaN;
  Object.assign(result, {
    peak,
    peakTime,
    timeToPeak: peakTime - stimulus.time,
    responded: finite(baselineSD) ? amplitude >= 3 * baselineSD : amplitude > 0,
    amplitude,
    fold: baseline > 0 ? peak / baseline : Number.NaN,
    halfMaxTime: halfMax === null ? null : halfMax - stimulus.time,
    area,
    endLevel: tail.length ? tail.reduce((a, b) => a + b, 0) / tail.length : Number.NaN,
    responding,
    respondingTime: percentBin >= 0 ? median.centers[percentBin] : null,
    respondingNet: finite(responding) ? Math.max(0, (100 * (responding - baselineAbove)) / (100 - baselineAbove)) : Number.NaN,
  });
  if (finite(baselineSD) && amplitude < 3 * baselineSD) warnings.push(`The peak is within 3 bin-to-bin SDs of the baseline (${(amplitude / baselineSD).toFixed(1)}): there may be no response.`);
  return result;
}

// Curves of several samples on one time axis, each shifted so its stimulus is at 0:
// [{ name, centers (s after the stimulus), smooth }].
export function alignedCurves(results) {
  return results.filter((r) => r.result?.stimulus).map((r) => ({
    name: r.name,
    centers: Float64Array.from(r.result.curve.centers, (c) => c - r.result.stimulus.time),
    smooth: r.result.curve.smooth,
  }));
}
