// Reagent titration and detector voltage walks: a series of samples that differ in one setting
// (antibody amount, or PMT voltage), and on each the positive and negative cells of one channel.
//
// Statistics per step, on linear values:
//   stain index       (median+ − median−) / (2 × rSD−)                 Maecker et al. 2004
//   separation index  (median+ − median−) / ((P84− − median−) / 0.995)  Bigos 2007
//   with rSD = (P84.13 − P15.87) / 2, BD FACSDiva's robust SD. (FlowJo 11's "Robust SD" is
//   1.4826 × the median absolute deviation: the same for a symmetric population, not for a skewed
//   one.)
//
// Titration (Bonilla et al. 2024): the stain index rises with the amount of antibody until the
// antigen is saturated, then levels off or falls as unbound antibody raises the background. A
// saturation curve SI = SImax × c / (K + c) is fitted to the steps up to the highest stain index;
// 90% of saturation is reached at c90 = 9K, and the recommended amount is the first tested one at
// or above 2 × c90.
//
// Voltage walk: the negative cells' spread is electronic noise at low voltages and grows with the
// gain above it; the minimum voltage is where the negative cells' rSD reaches 2.5 times the
// detector's electronic noise rSD (rSD_EN; BD technical bulletin, Meinelt et al. 2012), taken
// from the cytometer's baseline report or estimated from the walk: rSD−² = rSD_EN² + a V^2n, with
// the gain exponent n from the positive cells' median (∝ V^n). The maximum voltage keeps the
// brightest cells (their 99th percentile) within the detector's linear range.

import { modesOf, valleyBetween } from './recipes.js';
import { quantileSorted } from './stats.js';
import { channelTransform, population } from './engine.js';
import { ROOT } from './workspace.js';

export const REFERENCES = {
  stainIndex: 'Maecker HT, Frey T, Nomura LE, Trotter J. Selecting fluorochrome conjugates for maximum sensitivity. Cytometry A. 2004;62(2):169–173. doi:10.1002/cyto.a.20092',
  separationIndex: 'Bigos M. Separation index: an easy-to-use metric for evaluation of different configurations on the same flow cytometer. Curr Protoc Cytom. 2007;Chapter 1:Unit 1.21. doi:10.1002/0471142956.cy0121s40',
  titration: 'Bonilla DL, Paul A, Gil-Pulido J, Park LM, Jaimes MC. The power of reagent titration in flow cytometry. Cells. 2024;13(20):1677. doi:10.3390/cells13201677',
  voltage: 'Meinelt E, Reunanen M, Edinger M, et al. Standardizing application setup across multiple flow cytometers using BD FACSDiva version 6 software. BD Biosciences technical bulletin, 2012',
  voltration: 'Maecker HT, Trotter J. Flow cytometry controls, instrument setup, and the determination of positivity. Cytometry A. 2006;69(9):1037–1042. doi:10.1002/cyto.a.20333',
};

// --- Reading the series from names and keywords ---------------------------------------------------

const MASS = { pg: 1e-3, ng: 1, ug: 1e3, µg: 1e3, μg: 1e3, mg: 1e6 };

// The amount of reagent a sample name or annotation gives: { kind: 'mass' (ng), 'volume' (µL) or
// 'dilution' (relative concentration 1/d), value, label } or null. "125 ng", "0.5ug/test",
// "1-200", "1:200", "1_200", "2.5 uL".
export function parseAmount(text) {
  const s = String(text ?? '');
  let m = /(\d+(?:[.,]\d+)?)\s*(pg|ng|ug|µg|μg|mg)\b/i.exec(s);
  if (m) {
    const value = Number(m[1].replace(',', '.')) * MASS[m[2].toLowerCase()];
    return { kind: 'mass', value, label: `${+value.toPrecision(4)} ng` };
  }
  m = /(\d+(?:[.,]\d+)?)\s*(ul|µl|μl)\b/i.exec(s);
  if (m) {
    const value = Number(m[1].replace(',', '.'));
    return { kind: 'volume', value, label: `${value} µL` };
  }
  m = /(?:^|[^\d.])1\s*[:_-]\s*(\d+(?:\.\d+)?)(?![\d.])/.exec(s);
  if (m && Number(m[1]) >= 2) {
    const d = Number(m[1]);
    return { kind: 'dilution', value: 1 / d, label: `1:${d}` };
  }
  return null;
}

// A voltage written in a name ("PE 450V", "450 V", "V450"): the number, or null.
export function parseVoltage(text) {
  const m = /(?:^|[^\d])(\d{3,4})\s*V(?![a-z])/i.exec(String(text ?? '')) ?? /(?:^|[^a-z])V\s*(\d{3,4})(?!\d)/i.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
}

const UNSTAINED = /unstain|\bUS\b|no stain|blank|\bFMO\b/i;

// Groups samples into a titration series: [{ sample, amount }] sorted by amount, all of one kind;
// samples whose name says unstained are returned apart. samples: [{ id, name, meta }]; an
// annotation (meta.amount, meta.concentration, meta.dilution) wins over the name.
export function titrationSeries(samples) {
  const steps = [];
  const unstained = [];
  for (const sample of samples) {
    const annotated = sample.meta?.amount ?? sample.meta?.concentration ?? sample.meta?.dilution;
    const amount = parseAmount(annotated ?? '') ?? parseAmount(sample.name);
    if (amount) steps.push({ sample, amount });
    else if (UNSTAINED.test(sample.name)) unstained.push(sample);
  }
  if (!steps.length) return { steps: [], unstained, kind: null };
  // The most common kind wins (a file named "… 1-2 …" in a mass series is not a step).
  const counts = new Map();
  for (const s of steps) counts.set(s.amount.kind, (counts.get(s.amount.kind) ?? 0) + 1);
  const kind = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  return { steps: steps.filter((s) => s.amount.kind === kind).sort((a, b) => a.amount.value - b.amount.value), unstained, kind };
}

// --- Positive and negative cells -----------------------------------------------------------------

const DEPTH = 0.5;

// Where a step's values divide, on its display-scaled values ([0, 1]): the negative cells lie
// below the valley above the dimmest population, the positive cells above the valley below the
// brightest. Resolved when a valley between the dimmest and brightest populations is below half
// the lower of their peaks.
// Returns { resolved, lower, upper } in scaled units (null when unresolved).
export function divide(scaled) {
  const { modes, smooth, bins } = modesOf(scaled, null, 0.02);
  if (modes.length < 2) return { resolved: false, lower: null, upper: null };
  const first = modes[0];
  const last = modes[modes.length - 1];
  const second = modes[1];
  const beforeLast = modes[modes.length - 2];
  const lowValley = valleyBetween(smooth, first, second);
  const highValley = valleyBetween(smooth, beforeLast, last);
  // Resolved when the dimmest and brightest populations are apart (a small population between
  // them, such as CD4-dim monocytes among CD4 T cells, does not count against it).
  const deep = smooth[valleyBetween(smooth, first, last)] < DEPTH * Math.min(smooth[first], smooth[last]);
  if (!deep) return { resolved: false, lower: null, upper: null };
  return { resolved: true, lower: (lowValley + 0.5) / bins, upper: (highValley + 0.5) / bins };
}

function sorted(values) {
  return Float64Array.from(values).sort();
}

function summarize(sortedValues, range) {
  const n = sortedValues.length;
  if (!n) return null;
  const q = (p) => quantileSorted(sortedValues, p);
  let top = 0;
  if (range) for (let i = n - 1; i >= 0 && sortedValues[i] >= range - 1; i -= 1) top += 1;
  return { count: n, median: q(0.5), rsd: (q(0.8413) - q(0.1587)) / 2, p84: q(0.84), p99: q(0.99), atTop: top / n };
}

// Positive and negative cells of every step. steps: [{ linear, scaled, range? }] (values of the
// same events). A step whose populations are not resolved takes the series' fractions: its top
// share as positive and its bottom share as negative, the shares the resolved steps have (the
// same cells were stained). Returns [{ resolved, estimated, cuts ({ lower, upper } in scaled
// units), positive, negative, fraction }], with
// positive and negative summaries ({ count, median, rsd, p84, p99, atTop }) and fraction the
// share of events positive (null when estimated).
export function splitSteps(steps) {
  const divisions = steps.map((s) => divide(s.scaled));
  const shares = [];
  for (const [i, d] of divisions.entries()) {
    if (!d.resolved) continue;
    const { scaled } = steps[i];
    let low = 0;
    let high = 0;
    for (const v of scaled) {
      if (v < d.lower) low += 1;
      if (v >= d.upper) high += 1;
    }
    shares.push([low / scaled.length, high / scaled.length]);
  }
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
  };
  const negShare = median(shares.map((s) => s[0]));
  const posShare = median(shares.map((s) => s[1]));
  return steps.map((step, i) => {
    const d = divisions[i];
    const all = sorted(step.linear);
    if (d.resolved) {
      const neg = [];
      const pos = [];
      for (let e = 0; e < step.scaled.length; e += 1) {
        if (step.scaled[e] < d.lower) neg.push(step.linear[e]);
        else if (step.scaled[e] >= d.upper) pos.push(step.linear[e]);
      }
      return { resolved: true, estimated: false, cuts: { lower: d.lower, upper: d.upper }, negative: summarize(sorted(neg), step.range), positive: summarize(sorted(pos), step.range), fraction: pos.length / step.linear.length };
    }
    if (negShare === null || !all.length) return { resolved: false, estimated: false, cuts: null, negative: null, positive: null, fraction: null };
    const nNeg = Math.max(1, Math.round(negShare * all.length));
    const nPos = Math.max(1, Math.round(posShare * all.length));
    const order = Float64Array.from(step.scaled).sort();
    return { resolved: false, estimated: true, cuts: { lower: order[nNeg - 1], upper: order[order.length - nPos] }, negative: summarize(all.slice(0, nNeg), step.range), positive: summarize(all.slice(all.length - nPos), step.range), fraction: null };
  });
}

export function stainIndex(positive, negative) {
  return positive && negative && negative.rsd > 0 ? (positive.median - negative.median) / (2 * negative.rsd) : null;
}

export function separationIndex(positive, negative) {
  const spread = negative ? (negative.p84 - negative.median) / 0.995 : 0;
  return positive && spread > 0 ? (positive.median - negative.median) / spread : null;
}

// --- Titration -------------------------------------------------------------------------------------

// Least-squares saturation curve y = top × x / (k + x): k searched on a log grid and refined, top
// in closed form. Returns { top, k, rss } or null.
export function fitSaturation(xs, ys) {
  if (xs.length < 2) return null;
  const fitAt = (k) => {
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < xs.length; i += 1) {
      const f = xs[i] / (k + xs[i]);
      sxy += f * ys[i];
      sxx += f * f;
    }
    const top = sxx > 0 ? sxy / sxx : 0;
    let rss = 0;
    for (let i = 0; i < xs.length; i += 1) rss += (ys[i] - (top * xs[i]) / (k + xs[i])) ** 2;
    return { top, k, rss };
  };
  const lo = Math.log(Math.min(...xs) / 1000);
  const hi = Math.log(Math.max(...xs) * 1000);
  let best = null;
  const N = 400;
  for (let i = 0; i <= N; i += 1) {
    const fit = fitAt(Math.exp(lo + ((hi - lo) * i) / N));
    if (!best || fit.rss < best.rss) best = fit;
  }
  // Golden-section refinement in log k around the best grid point.
  let a = Math.log(best.k) - (hi - lo) / N;
  let b = Math.log(best.k) + (hi - lo) / N;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 60; i += 1) {
    const c = b - g * (b - a);
    const d = a + g * (b - a);
    if (fitAt(Math.exp(c)).rss < fitAt(Math.exp(d)).rss) b = d;
    else a = c;
  }
  const refined = fitAt(Math.exp((a + b) / 2));
  return refined.rss <= best.rss ? refined : best;
}

// A titration series. steps: [{ label, amount ({ kind, value, label }), linear, scaled, range }]
// sorted by amount. Returns { rows, fit, c90, recommended, best, notes }: rows per step with the
// positive and negative summaries, stain and separation indices and the share positive; best the
// step with the highest stain index; recommended the first step at or above 2 × c90.
export function analyzeTitration(steps) {
  const split = splitSteps(steps);
  const rows = steps.map((step, i) => {
    const s = split[i];
    return { label: step.label, amount: step.amount, resolved: s.resolved, estimated: s.estimated, cuts: s.cuts, positive: s.positive, negative: s.negative, fraction: s.fraction, stainIndex: stainIndex(s.positive, s.negative), separationIndex: separationIndex(s.positive, s.negative) };
  });
  const notes = [];
  const scored = rows.map((r, i) => ({ r, i })).filter(({ r }) => Number.isFinite(r.stainIndex));
  if (!scored.length) return { rows, fit: null, c90: null, recommended: null, best: null, notes: ['No step has both positive and negative cells: the marker\'s positive cells could not be found.'] };
  const best = scored.reduce((a, b) => (b.r.stainIndex > a.r.stainIndex ? b : a));
  // The saturation curve through the steps up to the highest stain index.
  const rising = scored.filter(({ i }) => i <= best.i);
  let fit = null;
  let c90 = null;
  let recommended = null;
  if (rising.length >= 3) {
    fit = fitSaturation(rising.map(({ r }) => r.amount.value), rising.map(({ r }) => r.stainIndex));
    if (fit) {
      c90 = 9 * fit.k;
      const target = 2 * c90;
      const at = scored.find(({ r }) => r.amount.value >= target * (1 - 1e-9));
      recommended = at ? { index: at.i, row: at.r, target } : null;
      if (!at) notes.push(`Twice the amount that gives 90% of saturation (${formatAmount(target, steps[0].amount.kind)}) is above the highest amount tested: titrate higher.`);
      if (c90 < steps[0].amount.value) notes.push('Even the lowest amount is near saturation: titrate lower to see the curve rise.');
    }
  } else if (best.i === 0) notes.push('The stain index is highest at the lowest amount tested: titrate lower to see it rise.');
  else notes.push('Too few steps below the highest stain index to fit a saturation curve.');
  if (best.i === steps.length - 1 && steps.length > 1) notes.push('The stain index is still rising at the highest amount tested: the antigen may not be saturated.');
  if (recommended && recommended.row.stainIndex < 0.9 * best.r.stainIndex) notes.push(`At the recommended amount the stain index is ${Math.round((100 * recommended.row.stainIndex) / best.r.stainIndex)}% of the highest: excess antibody raises the background.`);
  const estimated = rows.filter((r) => r.estimated).map((r) => r.label);
  if (estimated.length) notes.push(`Positive and negative cells overlap at ${estimated.join(', ')}; there they are the brightest and dimmest shares of events that the resolved steps have.`);
  return { rows, fit, c90, recommended, best: { index: best.i, row: best.r }, notes };
}

export function formatAmount(value, kind) {
  if (kind === 'dilution') return `1:${+(1 / value).toPrecision(3)}`;
  if (kind === 'volume') return `${+value.toPrecision(3)} µL`;
  return `${+value.toPrecision(3)} ng`;
}

// --- Voltage walk ----------------------------------------------------------------------------------

// Ordinary least squares slope and intercept.
function line(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : NaN;
  return { slope, intercept: my - slope * mx };
}

// A voltage walk of one detector. steps: [{ label, voltage, linear, scaled, range }] sorted by
// voltage. options: { rsdEN (the detector's electronic noise rSD, from the baseline report),
// linearMax (the top of its linear range; default 90% of the range) }. Returns { rows, exponent,
// noise: { rsdEN, source: 'given' | 'estimated' }, minimum, maximum, recommended, notes }.
export function analyzeVoltageWalk(steps, options = {}) {
  const split = splitSteps(steps);
  const rows = steps.map((step, i) => {
    const s = split[i];
    const linearMax = options.linearMax ?? 0.9 * (step.range ?? 262144);
    return { label: step.label, voltage: step.voltage, resolved: s.resolved, estimated: s.estimated, cuts: s.cuts, positive: s.positive, negative: s.negative, fraction: s.fraction, stainIndex: stainIndex(s.positive, s.negative), separationIndex: separationIndex(s.positive, s.negative), linearMax, inRange: s.positive ? s.positive.p99 <= linearMax : null };
  });
  const notes = [];
  // Gain exponent: the positive cells' median grows as V^n while it is within the linear range.
  const unsaturated = rows.filter((r) => r.positive && r.inRange && r.positive.median > 0);
  let exponent = null;
  if (unsaturated.length >= 2) {
    const fit = line(unsaturated.map((r) => Math.log(r.voltage)), unsaturated.map((r) => Math.log(r.positive.median)));
    if (Number.isFinite(fit.slope) && fit.slope > 0) exponent = fit.slope;
  }
  if (!exponent) {
    notes.push('The positive cells are within the linear range at fewer than two voltages: the gain\'s growth with voltage could not be measured.');
    return { rows, exponent: null, noise: null, minimum: null, maximum: null, recommended: null, notes };
  }
  // Negative cells' spread: rSD² = rSD_EN² + a V^2n, weighted for relative error.
  const withNeg = rows.filter((r) => r.negative && r.negative.rsd > 0);
  const x = withNeg.map((r) => r.voltage ** (2 * exponent));
  const y = withNeg.map((r) => r.negative.rsd ** 2);
  const w = y.map((v) => 1 / (v * v));
  let noise = null;
  let a = null;
  if (options.rsdEN > 0) {
    const s2 = options.rsdEN ** 2;
    let num = 0;
    let den = 0;
    for (let i = 0; i < x.length; i += 1) {
      num += w[i] * (y[i] - s2) * x[i];
      den += w[i] * x[i] * x[i];
    }
    a = den > 0 ? num / den : null;
    noise = { rsdEN: options.rsdEN, source: 'given' };
  } else if (x.length >= 3) {
    // Weighted least squares for (rSD_EN², a).
    let sw = 0; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
    for (let i = 0; i < x.length; i += 1) {
      sw += w[i]; sx += w[i] * x[i]; sy += w[i] * y[i]; sxx += w[i] * x[i] * x[i]; sxy += w[i] * x[i] * y[i];
    }
    const det = sw * sxx - sx * sx;
    const s2 = det ? (sy * sxx - sx * sxy) / det : NaN;
    a = det ? (sw * sxy - sx * sy) / det : NaN;
    const lowest = withNeg[0].negative.rsd;
    if (s2 > 0 && a > 0 && lowest <= 2 * Math.sqrt(s2)) noise = { rsdEN: Math.sqrt(s2), source: 'estimated' };
    else notes.push('The walk does not go low enough for the negative cells\' spread to reach the electronic noise: enter the detector\'s electronic noise rSD from the cytometer\'s baseline report.');
  }
  let minimum = null;
  if (noise && a > 0) {
    const v = (((2.5 ** 2 - 1) * noise.rsdEN ** 2) / a) ** (1 / (2 * exponent));
    minimum = { voltage: v, criterion: `negative cells' rSD = 2.5 × rSD_EN (${+noise.rsdEN.toPrecision(3)}${noise.source === 'estimated' ? ', estimated from the walk' : ''})` };
    if (v < steps[0].voltage || v > steps[steps.length - 1].voltage) notes.push(`The minimum voltage (${Math.round(v)} V) lies outside the voltages walked; it is extrapolated.`);
  }
  // Maximum: from the highest step within the linear range, the voltage at which the brightest
  // cells' 99th percentile reaches the top of it.
  let maximum = null;
  const inRange = rows.filter((r) => r.inRange);
  if (inRange.length) {
    const top = inRange[inRange.length - 1];
    const v = top.voltage * (top.linearMax / top.positive.p99) ** (1 / exponent);
    maximum = { voltage: v, criterion: `the positive cells' 99th percentile at the top of the linear range (${Math.round(top.linearMax).toLocaleString('en-US')})` };
    if (top === rows[rows.length - 1]) notes.push('The positive cells stay within the linear range at every voltage walked; the maximum is extrapolated.');
  } else notes.push('The positive cells exceed the linear range at every voltage walked.');
  let recommended = null;
  if (minimum && maximum) {
    if (minimum.voltage <= maximum.voltage) recommended = { voltage: Math.ceil(minimum.voltage / 5) * 5 };
    else notes.push(`The minimum voltage (${Math.round(minimum.voltage)} V) is above the maximum (${Math.round(maximum.voltage)} V): the positive cells are too bright for this detector at a voltage that lifts the negative cells above its noise; use less reagent or a dimmer fluorochrome.`);
  }
  if (recommended && maximum && recommended.voltage > maximum.voltage) recommended.voltage = Math.floor(maximum.voltage);
  return { rows, exponent, noise, minimum, maximum, recommended, notes };
}

// --- From samples to steps -------------------------------------------------------------------------

// A voltage walk among samples: [{ sample, voltage }] sorted by voltage, the channel's $PnV in each
// file (views: Map sampleId → view), else a voltage in the name; samples at a voltage already
// taken are left out.
export function voltageSeries(samples, views, channel) {
  const out = [];
  for (const sample of samples) {
    const view = views.get(sample.id);
    const voltage = view?.parameters?.find((p) => p.name === channel)?.voltage ?? parseVoltage(sample.name);
    if (Number.isFinite(voltage) && voltage > 0 && !out.some((s) => s.voltage === voltage)) out.push({ sample, voltage });
  }
  return out.sort((a, b) => a.voltage - b.voltage);
}

// The events of a population in each sample, on one channel: steps for analyzeTitration and
// analyzeVoltageWalk. items: [{ sample, view, ...fields }]; the fields (label, amount, voltage)
// are kept. Linear values are compensated as the sample is; scaled ones use the channel's scale.
export function stepsFrom(ws, items, { channel, populationId = ROOT }) {
  return items.map(({ sample, view, ...fields }) => {
    const indices = population(view, ws, populationId);
    if (indices === undefined) return { ...fields, sampleId: sample.id, linear: new Float64Array(0), scaled: new Float64Array(0), range: null };
    const column = view.column(channel);
    const scaledColumn = view.scaled(channel, channelTransform(ws, view, channel));
    const n = indices ? indices.length : column.length;
    const linear = new Float64Array(n);
    const scaled = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const e = indices ? indices[i] : i;
      linear[i] = column[e];
      scaled[i] = scaledColumn[e];
    }
    const range = view.parameters?.find((p) => p.name === channel)?.range ?? sample.channels?.find((c) => c.name === channel)?.range ?? null;
    return { ...fields, sampleId: sample.id, linear, scaled, range };
  });
}

// The channel a series is about: one whose marker the sample names mention ("CD4-PE 125 ng");
// else, for a titration, the fluorescence channel whose 99th percentile grows most from the first
// step to the last, and for a voltage walk (where every channel grows with the gain), the one
// whose positive and negative cells are best separated at the middle voltage.
export function guessChannel(ws, samples, views, mode = 'titration') {
  const channels = (samples[0]?.channels ?? []).filter((c) => c.type === 'fluorescence');
  const words = new Set(samples.flatMap((s) => s.name.toUpperCase().split(/[^A-Z0-9]+/)));
  const byMarker = channels.find((c) => c.marker && words.has(String(c.marker).toUpperCase().replace(/[^A-Z0-9]/g, '')));
  if (byMarker) return byMarker.name;
  if (mode === 'voltage') {
    const middle = samples[Math.floor(samples.length / 2)];
    const view = views.get(middle?.id);
    if (!view) return channels[0]?.name ?? null;
    let best = null;
    for (const c of channels) {
      const [step] = stepsFrom(ws, [{ sample: middle, view }], { channel: c.name });
      const [split] = splitSteps([step]);
      const si = split.resolved ? stainIndex(split.positive, split.negative) : null;
      if (Number.isFinite(si) && (!best || si > best.si)) best = { name: c.name, si };
    }
    return best?.name ?? channels[0]?.name ?? null;
  }
  const first = views.get(samples[0]?.id);
  const last = views.get(samples[samples.length - 1]?.id);
  if (!first || !last) return channels[0]?.name ?? null;
  const p99 = (view, name) => {
    const col = view.column(name);
    const step = Math.max(1, Math.floor(col.length / 5000));
    const sample = [];
    for (let i = 0; i < col.length; i += step) sample.push(col[i]);
    return quantileSorted(Float64Array.from(sample).sort(), 0.99);
  };
  let best = null;
  for (const c of channels) {
    const ratio = Math.abs(p99(last, c.name)) / Math.max(1, Math.abs(p99(first, c.name)));
    if (!best || ratio > best.ratio) best = { name: c.name, ratio };
  }
  return best?.name ?? null;
}

// The workspace record of an analysis (a derived result of kind 'titration'), which the methods
// describe. analysis: from analyzeTitration or analyzeVoltageWalk.
export function titrationRecord(analysis, { mode, channel, marker = null, population = null, sampleIds = [], params = {} }) {
  const steps = analysis.rows.map((r) => ({ label: mode === 'voltage' ? `${r.voltage} V` : r.amount.label, value: mode === 'voltage' ? r.voltage : r.amount.value, stainIndex: r.stainIndex, separationIndex: r.separationIndex }));
  const summary = mode === 'voltage'
    ? { exponent: analysis.exponent, rsdEN: analysis.noise?.rsdEN ?? null, noiseSource: analysis.noise?.source ?? null, minimum: analysis.minimum?.voltage ?? null, maximum: analysis.maximum?.voltage ?? null, recommended: analysis.recommended?.voltage ?? null }
    : { kind: analysis.rows[0]?.amount.kind ?? null, c90: analysis.c90 ? formatAmount(analysis.c90, analysis.rows[0].amount.kind) : null, recommended: analysis.recommended?.row.amount.label ?? null, best: analysis.best?.row.amount.label ?? null };
  return { kind: 'titration', name: `${mode === 'voltage' ? 'Voltage walk' : 'Titration'} · ${marker ? `${marker} ` : ''}${channel}`, mode, channel, marker, population, sampleIds, params, steps, summary, notes: analysis.notes };
}
