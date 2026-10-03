// Compensation for conventional fluorescence cytometry.
//
// A spillover matrix S has one row per fluorochrome and one column per detector: an event with
// true fluorochrome amounts t is observed as r = t S. Compensated values are t = r S⁻¹
// (FlowJo, flowCore and FlowKit all use this convention, as does $SPILLOVER).

import { conditionNumber as conditionNumber2 } from './linalg.js';

export class CompensationError extends Error {}

// Gauss–Jordan inversion with partial pivoting; matrix is row-major, n × n.
export function invertMatrix(matrix, n) {
  const a = Float64Array.from(matrix);
  const inv = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) inv[i * n + i] = 1;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let best = Math.abs(a[col * n + col]);
    for (let row = col + 1; row < n; row += 1) {
      const value = Math.abs(a[row * n + col]);
      if (value > best) {
        best = value;
        pivot = row;
      }
    }
    if (best < 1e-14) throw new CompensationError('The spillover matrix is singular and cannot be inverted.');
    if (pivot !== col) {
      for (let k = 0; k < n; k += 1) {
        [a[col * n + k], a[pivot * n + k]] = [a[pivot * n + k], a[col * n + k]];
        [inv[col * n + k], inv[pivot * n + k]] = [inv[pivot * n + k], inv[col * n + k]];
      }
    }
    const scale = 1 / a[col * n + col];
    for (let k = 0; k < n; k += 1) {
      a[col * n + k] *= scale;
      inv[col * n + k] *= scale;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row * n + col];
      if (factor === 0) continue;
      for (let k = 0; k < n; k += 1) {
        a[row * n + k] -= factor * a[col * n + k];
        inv[row * n + k] -= factor * inv[col * n + k];
      }
    }
  }
  return inv;
}

export function multiplyMatrices(a, b, n) {
  const out = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k < n; k += 1) {
      const aik = a[i * n + k];
      if (aik === 0) continue;
      for (let j = 0; j < n; j += 1) out[i * n + j] += aik * b[k * n + j];
    }
  }
  return out;
}

function norm1(matrix, n) {
  let best = 0;
  for (let j = 0; j < n; j += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += Math.abs(matrix[i * n + j]);
    best = Math.max(best, sum);
  }
  return best;
}

// Condition number in the 1-norm: how much compensation amplifies relative noise. (The panel
// "complexity index" of spectral cytometry is the 2-norm condition number: linalg.js.)
export function conditionNumber1(matrix, n) {
  try {
    return norm1(matrix, n) * norm1(invertMatrix(matrix, n), n);
  } catch {
    return Infinity;
  }
}

// The 2-norm condition number (ratio of extreme singular values), comparable with the spectral
// complexity index.
export function conditionNumber(matrix, n) {
  return conditionNumber2(Float64Array.from(matrix), n, n);
}

export function identityMatrix(n) {
  const m = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) m[i * n + i] = 1;
  return m;
}

// Compensates the named channels. columns: { [channel]: Float32Array }. Returns new columns for
// the matrix channels (others are untouched and not returned).
export function compensate(columns, spill) {
  const compensated = compensator(columns, spill);
  return Object.fromEntries(spill.channels.map((name) => [name, compensated.column(name)]));
}

// Compensation one channel at a time, for samples too large to compensate every channel up front:
// { channels, inverse, column(name) } computes a channel's compensated values when first asked.
// Channel j is Σᵢ rawᵢ · S⁻¹[i][j] over the nonzero entries, summed in the order of i, in double
// precision and stored as float32 (as compensate always has).
export function compensator(columns, spill, allocate = (n) => new Float32Array(n)) {
  const { channels, matrix } = spill;
  const n = channels.length;
  const inverse = invertMatrix(matrix, n);
  const inputs = channels.map((name) => {
    const column = columns[name];
    if (!column) throw new CompensationError(`The data have no channel "${name}" named by the compensation matrix.`);
    return column;
  });
  const count = inputs[0].length;
  const index = new Map(channels.map((c, j) => [c, j]));
  const cache = new Map();
  const column = (name) => {
    const j = index.get(name);
    if (j === undefined) return undefined;
    let out = cache.get(j);
    if (out) return out;
    // Sparse inverse columns speed up the common case of mostly-zero spillover.
    const sources = [];
    const weights = [];
    for (let i = 0; i < n; i += 1) {
      if (inverse[i * n + j] !== 0) {
        sources.push(inputs[i]);
        weights.push(inverse[i * n + j]);
      }
    }
    out = allocate(count);
    // In blocks, one input at a time: each event's sum still adds the inputs in the same order.
    const block = new Float64Array(4096);
    for (let start = 0; start < count; start += block.length) {
      const n = Math.min(block.length, count - start);
      block.fill(0, 0, n);
      for (let k = 0; k < sources.length; k += 1) {
        const source = sources[k];
        const w = weights[k];
        for (let i = 0; i < n; i += 1) block[i] += source[start + i] * w;
      }
      for (let i = 0; i < n; i += 1) out[start + i] = block[i];
    }
    cache.set(j, out);
    return out;
  };
  return { channels, inverse, column, computed: () => [...cache.values()] };
}

// --- Statistics used by the control-based methods ---------------------------------------------

function select(values, indices) {
  if (!indices) return values;
  const out = new Float64Array(indices.length);
  for (let i = 0; i < indices.length; i += 1) out[i] = values[indices[i]];
  return out;
}

export function median(values) {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  if (!n) return Number.NaN;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

function percentile(sorted, q) {
  const n = sorted.length;
  if (!n) return Number.NaN;
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Robust SD as Nguyen et al. 2013 define it for spillover spreading: the 84.13th minus the 50th
// percentile (stats.js's rSD is the symmetric (84.13th − 15.87th) / 2).
export function robustSD(values) {
  const sorted = Float64Array.from(values).sort();
  return percentile(sorted, 0.8413) - percentile(sorted, 0.5);
}

// Picks the positive and negative events of a single-stain control from its primary detector:
// positives are the brightest `positiveFraction` of events; negatives the dimmest, unless an
// unstained control is given. Events at or above `saturation` (off scale) are left out, as BD
// FACSDiva and FlowJo do: their clipped values would bias every ratio.
export function splitControl(primary, options = {}) {
  const n = primary.length;
  const saturation = options.saturation ?? Infinity;
  // Thresholds from one typed-array sort (fast at millions of events; NaNs sort last and are
  // excluded by the comparisons below).
  const sorted = Float64Array.from(primary).sort();
  let finite = n;
  while (finite > 0 && (Number.isNaN(sorted[finite - 1]) || sorted[finite - 1] >= saturation)) finite -= 1;
  const posCount = Math.max(5, Math.floor(finite * (options.positiveFraction ?? 0.1)));
  const negCount = Math.max(5, Math.floor(finite * (options.negativeFraction ?? 0.3)));
  const hi = sorted[Math.max(0, finite - posCount)];
  const lo = sorted[Math.min(finite - 1, negCount - 1)];
  const positive = new Uint32Array(n);
  const negative = new Uint32Array(n);
  let p = 0;
  let q = 0;
  let saturated = 0;
  for (let e = 0; e < n; e += 1) {
    const v = primary[e];
    if (v >= saturation) {
      saturated += 1;
      continue;
    }
    if (v >= hi) positive[p++] = e;
    else if (v <= lo) negative[q++] = e;
  }
  return { positive: positive.slice(0, p), negative: negative.slice(0, q), saturated };
}

// The value at which a detector is off scale: just under its range ($PnR) when known.
function saturationOf(options, channel) {
  const range = options.ranges?.[channel] ?? options.range;
  return range > 0 ? range * 0.999 : Infinity;
}

// Events of `indices` whose value in `column` is on scale.
function onScale(column, indices, saturation) {
  if (!(saturation < Infinity)) return indices;
  const out = [];
  for (const e of indices) if (column[e] < saturation) out.push(e);
  return out;
}

// Spillover from single-stain controls.
// controls: [{ fluorochrome channel, columns: { [detector]: Float32Array }, positive?: indices,
//              negative?: indices }]
// unstained (optional): { columns } used as the negative for every control.
// method: 'median' (difference of medians, as BD FACSDiva and FlowJo) or 'regression' (the
// slope of a robust fit of each detector on the primary, as AutoSpill).
export function computeSpillover(controls, detectors, options = {}) {
  const n = detectors.length;
  const matrix = identityMatrix(n);
  const report = [];
  const method = options.method ?? 'median';
  for (const control of controls) {
    const i = detectors.indexOf(control.channel);
    if (i < 0) throw new CompensationError(`Control channel "${control.channel}" is not among the detectors.`);
    const primary = control.columns[control.channel];
    let { positive, negative } = control;
    let saturated = 0;
    if (!positive || !negative) {
      const split = splitControl(primary, { ...options, saturation: saturationOf(options, control.channel) });
      positive = positive ?? split.positive;
      negative = negative ?? split.negative;
      saturated = split.saturated;
    }
    const useUnstained = options.unstained && !control.negative;
    const negPrimary = useUnstained ? median(options.unstained.columns[control.channel]) : median(select(primary, negative));
    const posPrimary = median(select(primary, positive));
    const delta = posPrimary - negPrimary;
    const quality = { channel: control.channel, positiveEvents: positive.length, negativeEvents: useUnstained ? options.unstained.columns[control.channel].length : negative.length, separation: delta, saturated, warnings: [] };
    if (saturated > 0.01 * primary.length) quality.warnings.push(`${saturated} events (${((100 * saturated) / primary.length).toFixed(1)}%) are off scale in ${control.channel} and were left out; a lower voltage or a dimmer control would keep them.`);
    if (!(delta > 0)) {
      quality.warnings.push('The positive population is not brighter than the negative.');
      report.push(quality);
      continue;
    }
    if (positive.length < 200) quality.warnings.push(`Only ${positive.length} positive events; 200 or more give stable spillover values.`);
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const detector = control.columns[detectors[j]];
      // Positives off scale in this detector would understate its spillover.
      const pos = onScale(detector, positive, saturationOf(options, detectors[j]));
      if (!pos.length) continue;
      let value;
      if (method === 'regression') {
        // With an unstained control, its events anchor the fit's low end instead of the control's
        // own dim events.
        const negX = useUnstained ? options.unstained.columns[control.channel] : select(primary, negative);
        const negY = useUnstained ? options.unstained.columns[detectors[j]] : select(detector, negative);
        value = robustSlope(select(primary, pos), select(detector, pos), negX, negY);
      } else {
        const negDetector = useUnstained ? median(options.unstained.columns[detectors[j]]) : median(select(detector, negative));
        value = (median(select(detector, pos)) - negDetector) / (median(select(primary, pos)) - negPrimary);
      }
      matrix[i * n + j] = value;
    }
    // A positive population that is dim relative to the detector's range gives noisy values.
    if (options.range && delta < options.range * 0.01) quality.warnings.push('The positive population is dim; brighter controls give more accurate spillover.');
    report.push(quality);
  }
  return { channels: detectors.slice(), matrix, n, report, method };
}

// Slope of y on x through positive and negative events: Tukey biweight IRLS from an OLS start.
export function robustSlope(xPos, yPos, xNeg = [], yNeg = []) {
  const x = Float64Array.from([...xPos, ...xNeg]);
  const y = Float64Array.from([...yPos, ...yNeg]);
  const n = x.length;
  const w = new Float64Array(n).fill(1);
  let slope = 0;
  let intercept = 0;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    let sw = 0; let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
    for (let k = 0; k < n; k += 1) {
      sw += w[k]; sx += w[k] * x[k]; sy += w[k] * y[k]; sxx += w[k] * x[k] * x[k]; sxy += w[k] * x[k] * y[k];
    }
    const det = sw * sxx - sx * sx;
    if (Math.abs(det) < 1e-12) break;
    const nextSlope = (sw * sxy - sx * sy) / det;
    intercept = (sy - nextSlope * sx) / sw;
    const converged = Math.abs(nextSlope - slope) < 1e-9 * Math.max(1, Math.abs(nextSlope));
    slope = nextSlope;
    if (converged && iteration > 0) break;
    const residuals = new Float64Array(n);
    for (let k = 0; k < n; k += 1) residuals[k] = Math.abs(y[k] - slope * x[k] - intercept);
    const scale = median(residuals) / 0.6745 || 1;
    const c = 4.685 * scale;
    for (let k = 0; k < n; k += 1) {
      const u = residuals[k] / c;
      w[k] = u < 1 ? (1 - u * u) ** 2 : 0;
    }
  }
  return slope;
}

// Spillover spreading matrix (Nguyen, Perfetto, Mahnke, Chattopadhyay & Roederer 2013):
// SS_ij = sqrt(σ²_pos,j − σ²_neg,j) / sqrt(ΔF_i), from compensated single-stain controls,
// with σ the robust SD. Rows: fluorochromes (controls); columns: detectors.
export function spilloverSpreading(controls, detectors) {
  const n = detectors.length;
  const ssm = new Float64Array(n * n).fill(Number.NaN);
  for (const control of controls) {
    const i = detectors.indexOf(control.channel);
    if (i < 0) continue;
    const { positive, negative } = control.positive && control.negative ? control : splitControl(control.columns[control.channel]);
    const primary = control.columns[control.channel];
    const deltaF = median(select(primary, positive)) - median(select(primary, negative));
    if (!(deltaF > 0)) continue;
    for (let j = 0; j < n; j += 1) {
      if (j === i) {
        ssm[i * n + j] = 0;
        continue;
      }
      const detector = control.columns[detectors[j]];
      const sPos = robustSD(select(detector, positive));
      const sNeg = robustSD(select(detector, negative));
      const spread = sPos * sPos - sNeg * sNeg;
      ssm[i * n + j] = spread > 0 ? Math.sqrt(spread) / Math.sqrt(deltaF) : 0;
    }
  }
  return { channels: detectors.slice(), matrix: ssm, n };
}

// Residual check of a compensated single-stain control: in every other detector, the positive
// population's median should equal the negative's. Returns per-detector residual spillover
// (positive − negative median, over the primary separation), which suggests a correction.
export function compensationResiduals(control, detectors) {
  const { positive, negative } = control.positive && control.negative ? control : splitControl(control.columns[control.channel]);
  const primary = control.columns[control.channel];
  const deltaF = median(select(primary, positive)) - median(select(primary, negative));
  return detectors.map((detector) => {
    if (detector === control.channel) return { detector, residual: 0 };
    const column = control.columns[detector];
    const residual = (median(select(column, positive)) - median(select(column, negative))) / deltaF;
    return { detector, residual };
  });
}

// Checks a spillover matrix against single-stain controls: each control is compensated with the
// matrix, and what remains of its fluorochrome in every other detector (relative to its primary
// separation) is the error of that matrix entry. This is the definitive check; the sample-based
// leanCheck below is only a hint, since biology also makes bright and dim events differ.
// controls: [{ channel, columns (raw) }]. Returns entries sorted by |residual|, each with the
// suggested corrected spillover value.
export function controlResiduals(controls, spill, options = {}) {
  const n = spill.channels.length;
  const rows = [];
  for (const control of controls) {
    const i = spill.channels.indexOf(control.channel);
    if (i < 0) continue;
    const present = spill.channels.filter((c) => control.columns[c]);
    if (present.length !== n) continue;
    const compensated = { ...control.columns, ...compensate(control.columns, spill) };
    for (const { detector, residual } of compensationResiduals({ channel: control.channel, columns: compensated, positive: control.positive, negative: control.negative }, spill.channels)) {
      if (detector === control.channel || !Number.isFinite(residual)) continue;
      const j = spill.channels.indexOf(detector);
      const current = spill.matrix[i * n + j];
      rows.push({ from: control.channel, to: detector, residual, current, suggested: current + residual });
    }
  }
  // One wrong entry leaves a residual in one detector (plus small knock-ons). Positives brighter
  // in several detectors at once point to a different cause: positive cells that are more
  // autofluorescent than the negatives (dead cells in a viability control, beads against cells).
  // Such rows are marked `broad` (the number of detectors affected); they are not spillover errors.
  const broadLevel = options.broadLevel ?? 0.004;
  const broadCount = options.broadCount ?? 3;
  const counts = new Map();
  for (const r of rows) if (r.residual >= broadLevel) counts.set(r.from, (counts.get(r.from) ?? 0) + 1);
  for (const r of rows) {
    const count = counts.get(r.from) ?? 0;
    if (count >= broadCount) r.broad = count;
  }
  const threshold = options.threshold ?? 0;
  return rows.filter((r) => Math.abs(r.residual) >= threshold).sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual));
}

// A hint, not a measurement: detects populations that "lean" after compensation in an ordinary sample: the bright events of
// channel A should have the same median in channel B as the dim events. Returns a suggested
// change to S[A][B] (`residual`) for each pair whose residual exceeds `threshold`.
export function leanCheck(columns, channels, options = {}) {
  const threshold = options.threshold ?? 0.01;
  const suggestions = [];
  for (const a of channels) {
    const primary = columns[a];
    if (!primary) continue;
    const { positive, negative } = splitControl(primary, { positiveFraction: options.positiveFraction ?? 0.05, negativeFraction: 0.5 });
    const deltaF = median(select(primary, positive)) - median(select(primary, negative));
    if (!(deltaF > 0)) continue;
    for (const b of channels) {
      if (a === b || !columns[b]) continue;
      const shift = median(select(columns[b], positive)) - median(select(columns[b], negative));
      const residual = shift / deltaF;
      // A residual near or above 1 means A's bright events are bright because of B, not the
      // reverse: they are not a correctable lean.
      if (Math.abs(residual) > threshold && Math.abs(residual) < (options.maxResidual ?? 0.5)) suggestions.push({ from: a, to: b, residual, shift });
    }
  }
  // Ranked by the shift in signal units: an error on a bright population matters more, and the
  // artifacts an error induces in other channels are dimmer than the error itself.
  return suggestions.sort((x, y) => Math.abs(y.shift) - Math.abs(x.shift));
}

// Spillover string as written to $SPILLOVER: "n,ch1,…,chn,v11,v12,…".
export function formatSpillover({ channels, matrix }) {
  return [channels.length, ...channels, ...Array.from(matrix, (v) => +v.toPrecision(10))].join(',');
}

// Applies a correction S' = S + ΔS for one entry, as a user edits a matrix cell.
export function withEntry(spill, from, to, value) {
  const i = spill.channels.indexOf(from);
  const j = spill.channels.indexOf(to);
  if (i < 0 || j < 0) throw new CompensationError('Unknown channel.');
  const matrix = Float64Array.from(spill.matrix);
  matrix[i * spill.channels.length + j] = value;
  return { ...spill, matrix };
}
