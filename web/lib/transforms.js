// Display and gating transforms. Every transform maps data values to a display coordinate that is
// about 0 at the bottom of the axis and 1 at the top (the Gating-ML 2.0 convention), and back.
//
//   linear   { type: 'linear', min, max }                     (Gating-ML flin, generalized)
//   log      { type: 'log', min, max }                        (Gating-ML flog)
//   logicle  { type: 'logicle', T, W, M, A }                  (Parks, Roederer & Moore 2006;
//                                                              Moore & Parks 2012 algorithm)
//   biex     { type: 'biex', maxValue, widthBasis, positiveDecades, extraNegativeDecades }
//                                                             (FlowJo's biexponential, exactly)
//   arcsinh  { type: 'arcsinh', cofactor, max, min }          (asinh(x / cofactor), cytometry style)
//   fasinh   { type: 'fasinh', T, M, A }                      (Gating-ML fasinh)
//   hyperlog { type: 'hyperlog', T, W, M, A }                 (Bagwell 2005, Gating-ML hyperlog)

const LN10 = Math.LN10;
const EPS = Number.EPSILON;
const TAYLOR_LENGTH = 16;

export class TransformError extends Error {}

// --- Logicle -------------------------------------------------------------------------------

// Solves 2 (ln d − ln b) + w (b + d) = 0 for d (RTSAFE: Newton with bisection fallback).
function solveLogicleD(b, w) {
  if (w === 0) return b;
  const tolerance = 2 * b * EPS;
  let dLo = 0;
  let dHi = b;
  let d = (dLo + dHi) / 2;
  let delta;
  const fB = -2 * Math.log(b) + w * b;
  let f = 2 * Math.log(d) + w * d + fB;
  let lastF = Number.NaN;
  for (let i = 1; i < 60; i += 1) {
    const df = 2 / d + w;
    if (((d - dHi) * df - f) * ((d - dLo) * df - f) >= 0 || Math.abs(1.9 * f) > Math.abs(lastF * df)) {
      delta = (dHi - dLo) / 2;
      d = dLo + delta;
      if (d === dLo) return d;
    } else {
      delta = f / df;
      const t = d;
      d -= delta;
      if (d === t) return d;
    }
    if (Math.abs(delta) < tolerance) return d;
    f = 2 * Math.log(d) + w * d + fB;
    if (f === 0 || f === lastF) return d;
    lastF = f;
    if (f < 0) dLo = d;
    else dHi = d;
  }
  return d;
}

export function validateLogicle({ T, W, M, A }) {
  if (!(T > 0)) throw new TransformError('Logicle T (top of scale) must be positive.');
  if (!(M > 0)) throw new TransformError('Logicle M (decades) must be positive.');
  if (!(W >= 0)) throw new TransformError('Logicle W (linearization width) must be zero or positive.');
  if (2 * W > M + 1e-12) throw new TransformError('Logicle W must be at most M / 2.');
  if (-A > W + 1e-12 || A > M - 2 * W + 1e-12) throw new TransformError('Logicle A must lie between −W and M − 2W.');
}

export function createLogicle(params) {
  const { T, W, M } = params;
  const A = params.A ?? 0;
  validateLogicle({ T, W, M, A });
  const w = W / (M + A);
  const x2 = A / (M + A);
  const x1 = x2 + w;
  const x0 = x2 + 2 * w;
  const b = (M + A) * LN10;
  const d = solveLogicleD(b, w);
  const cA = Math.exp(x0 * (b + d));
  const mfA = Math.exp(b * x1) - cA / Math.exp(d * x1);
  const a = T / (Math.exp(b) - mfA - cA / Math.exp(d));
  const c = cA * a;
  const f = -mfA * a;
  const xTaylor = x1 + w / 4;
  const taylor = new Float64Array(TAYLOR_LENGTH);
  let posCoef = a * Math.exp(b * x1);
  let negCoef = -c / Math.exp(d * x1);
  for (let i = 0; i < TAYLOR_LENGTH; i += 1) {
    posCoef *= b / (i + 1);
    negCoef *= -d / (i + 1);
    taylor[i] = posCoef + negCoef;
  }
  taylor[1] = 0;

  const series = (scale) => {
    const x = scale - x1;
    let sum = taylor[TAYLOR_LENGTH - 1] * x;
    for (let i = TAYLOR_LENGTH - 2; i >= 2; i -= 1) sum = (sum + taylor[i]) * x;
    return (sum * x + taylor[0]) * x;
  };

  const forward = (input) => {
    let value = input;
    if (value === 0) return x1;
    if (!Number.isFinite(value)) return value > 0 ? Infinity : value < 0 ? -Infinity : Number.NaN;
    const negative = value < 0;
    if (negative) value = -value;
    let x = value < f ? x1 + value / taylor[0] : Math.log(value / a) / b;
    let tolerance = 3 * EPS;
    if (x > 1) tolerance = 3 * x * EPS;
    for (let i = 0; i < 20; i += 1) {
      const ae2bx = a * Math.exp(b * x);
      const ce2mdx = c / Math.exp(d * x);
      const y = x < xTaylor ? series(x) - value : (ae2bx + f) - (ce2mdx + value);
      const abe2bx = b * ae2bx;
      const cde2mdx = d * ce2mdx;
      const dy = abe2bx + cde2mdx;
      const ddy = b * abe2bx - d * cde2mdx;
      const delta = y / (dy * (1 - (y * ddy) / (2 * dy * dy)));
      x -= delta;
      if (Math.abs(delta) < tolerance) break;
    }
    return negative ? 2 * x1 - x : x;
  };

  const inverse = (input) => {
    let scale = input;
    const negative = scale < x1;
    if (negative) scale = 2 * x1 - scale;
    const value = scale < xTaylor ? series(scale) : (a * Math.exp(b * scale) + f) - c / Math.exp(d * scale);
    return negative ? -value : value;
  };

  // The data value at the bottom of the scale (display 0).
  const bottom = inverse(0);
  return { forward, inverse, params: { T, W, M, A }, x1, bottom, top: T, constants: { a, b, c, d, f, w, x0, x1, x2 } };
}

// Parks et al. 2006 (as in flowCore's estimateLogicle): with r the 5th percentile of the data,
// W = (M − log10(T / |r|)) / 2 when r < 0. Data without a negative tail get `minimum` (default
// 0.25 decades), which keeps a narrow linear region around zero.
export function estimateLogicleW(values, T, M = 4.5, options = {}) {
  const minimum = options.minimum ?? 0.25;
  const r = quantile(values, options.quantile ?? 0.05);
  let W = minimum;
  if (r < 0 && Number.isFinite(r)) W = (M - Math.log10(T / Math.abs(r))) / 2;
  if (!Number.isFinite(W)) W = minimum;
  return Math.min(Math.max(W, minimum), M / 2, 2);
}

// --- Other transforms --------------------------------------------------------------------

function createLinear({ min = 0, max = 262144 }) {
  const span = max - min || 1;
  return {
    forward: (x) => (x - min) / span,
    inverse: (y) => min + y * span,
    bottom: min,
    top: max,
  };
}

function createLog({ min = 1, max = 262144 }) {
  if (!(min > 0) || !(max > min)) throw new TransformError('Log scale needs 0 < min < max.');
  const lmin = Math.log10(min);
  const span = Math.log10(max) - lmin;
  return {
    forward: (x) => (x > 0 ? (Math.log10(x) - lmin) / span : -Infinity),
    inverse: (y) => 10 ** (lmin + y * span),
    bottom: min,
    top: max,
  };
}

function createArcsinh({ cofactor = 150, max = 262144, min }) {
  if (!(cofactor > 0)) throw new TransformError('The arcsinh cofactor must be positive.');
  const low = min ?? -cofactor * Math.sinh(1);
  const lo = Math.asinh(low / cofactor);
  const hi = Math.asinh(max / cofactor);
  const span = hi - lo || 1;
  return {
    forward: (x) => (Math.asinh(x / cofactor) - lo) / span,
    inverse: (y) => cofactor * Math.sinh(lo + y * span),
    bottom: low,
    top: max,
  };
}

function createFasinh({ T = 262144, M = 4.5, A = 0 }) {
  const sinhM = Math.sinh(M * LN10);
  const denom = (M + A) * LN10;
  return {
    forward: (x) => (Math.asinh((x * sinhM) / T) + A * LN10) / denom,
    inverse: (y) => (T * Math.sinh(y * denom - A * LN10)) / sinhM,
    bottom: (T * Math.sinh(-A * LN10)) / sinhM,
    top: T,
  };
}

function createHyperlog({ T = 262144, W = 0.5, M = 4.5, A = 0 }) {
  validateLogicle({ T, W, M, A });
  const w = W / (M + A);
  const x2 = A / (M + A);
  const x1 = x2 + w;
  const x0 = x2 + 2 * w;
  const b = (M + A) * LN10;
  const e0 = Math.exp(b * x0);
  const cA = e0 / w;
  const fA = Math.exp(b * x1) + cA * x1;
  const a = T / (Math.exp(b) + cA - fA);
  const c = cA * a;
  const f = fA * a;
  const eh = (y) => (y >= x1 ? a * Math.exp(b * y) + c * y - f : -(a * Math.exp(b * (2 * x1 - y)) + c * (2 * x1 - y) - f));
  const forward = (x) => {
    if (!Number.isFinite(x)) return x > 0 ? Infinity : -Infinity;
    // Monotone: bracket and bisect with a few Newton refinements.
    let lo = -1;
    let hi = 2;
    while (eh(lo) > x) lo -= 1;
    while (eh(hi) < x) hi += 1;
    for (let i = 0; i < 80; i += 1) {
      const mid = (lo + hi) / 2;
      if (eh(mid) < x) lo = mid;
      else hi = mid;
      if (hi - lo < 1e-14) break;
    }
    return (lo + hi) / 2;
  };
  return { forward, inverse: eh, bottom: eh(0), top: T };
}

// --- FlowJo biexponential -------------------------------------------------------------------
//
// FlowJo's biex is not a logicle: it is a 4097-point table built by TreeStar's legacy algorithm
// (ported here from FlowKit's generate_biex_lut, BSD-3, itself from cytolib), read with linear
// interpolation. The port reproduces BD's published FlowJo lookup tables (MIT, 2020) to their
// six printed digits once the width basis is clamped to −√10, which FlowJo does: its tables for
// width bases −1, −1.58 and −2.51 are identical to the one for −3.16 (validation/biex).

const BIEX_CHANNELS = 4096;
const BIEX_MIN_WIDTH = -Math.sqrt(10);

// The negative-range root, with the legacy code's quirks kept (they change the result).
function biexLogRoot(b, w) {
  if (w === 0) return b;
  let lo = 0;
  let hi = b;
  let d = (lo + hi) / 2;
  let dx = Math.abs(Math.trunc(lo - hi));
  let dxLast = dx;
  const fb = -2 * Math.log(b) + w * b;
  let f = 2 * Math.log(d) + w * b + fb;
  let df = 2 / d + w;
  for (let i = 0; i < 100; i += 1) {
    if (((d - hi) * df - f) - ((d - lo) * df - f) > 0 || Math.abs(2 * f) > Math.abs(dxLast * df)) {
      dx = (hi - lo) / 2;
      d = lo + dx;
      if (d === lo) return d;
    } else {
      dx = f / df;
      const t = d;
      d -= dx;
      if (d === t) return d;
    }
    if (Math.abs(dx) < 1e-12) return d;
    dxLast = dx;
    f = 2 * Math.log(d) + w * d + fb;
    df = 2 / d + w;
    if (f < 0) lo = d;
    else hi = d;
  }
  return d;
}

// Data values at channels 0…4096 (the table FlowJo interpolates).
export function biexTable({ maxValue = 262144, widthBasis = -10, positiveDecades = 4.5, extraNegativeDecades = 0 } = {}) {
  if (!(maxValue > 0)) throw new TransformError('The biexponential top of scale must be positive.');
  if (!(positiveDecades > 0)) throw new TransformError('The biexponential needs a positive number of decades.');
  const range = BIEX_CHANNELS;
  let width = Math.log10(-Math.min(widthBasis, BIEX_MIN_WIDTH));
  let decades = positiveDecades - width / 2;
  const extra = Math.max(extraNegativeDecades, 0) + width / 2;
  let zero = Math.trunc((extra * range) / (extra + decades));
  zero = Math.trunc(Math.min(zero, range / 2));
  if (zero > 0) decades = (extra * range) / zero;
  width /= 2 * decades;
  const positiveRange = LN10 * decades;
  const minimum = maxValue / Math.exp(positiveRange);
  const negativeRange = biexLogRoot(positiveRange, width);
  const n = range + 1;
  const positive = new Float64Array(n);
  const negative = new Float64Array(n);
  const s = Math.exp((positiveRange + negativeRange) * (width + extra / decades));
  for (let i = 0; i < n; i += 1) {
    positive[i] = Math.exp((i / n) * positiveRange);
    negative[i] = Math.exp((-i / n) * negativeRange) * s;
  }
  const offset = positive[zero] - negative[zero];
  for (let i = zero; i < n; i += 1) positive[i] = minimum * (positive[i] - negative[i] - offset);
  for (let i = 0; i < zero; i += 1) positive[i] = -positive[2 * zero - i];
  return positive;
}

function createBiex(spec) {
  const values = biexTable(spec);
  const n = values.length;
  const last = n - 1;
  for (let i = 1; i < n; i += 1) {
    if (!(values[i] > values[i - 1])) throw new TransformError('These biexponential parameters do not give an increasing scale.');
  }
  // Beyond the table, continue the end segments linearly (FlowJo clamps instead; continuing keeps
  // the scale invertible and data-space gate bounds exact).
  const lowSlope = values[1] - values[0];
  const highSlope = values[last] - values[last - 1];
  const forward = (x) => {
    if (Number.isNaN(x)) return x;
    if (x <= values[0]) return (x - values[0]) / lowSlope / BIEX_CHANNELS;
    if (x >= values[last]) return (last + (x - values[last]) / highSlope) / BIEX_CHANNELS;
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (values[mid] <= x) lo = mid;
      else hi = mid;
    }
    return (lo + (x - values[lo]) / (values[hi] - values[lo])) / BIEX_CHANNELS;
  };
  const inverse = (y) => {
    const c = y * BIEX_CHANNELS;
    if (Number.isNaN(c)) return c;
    if (c <= 0) return values[0] + c * lowSlope;
    if (c >= last) return values[last] + (c - last) * highSlope;
    const i = Math.floor(c);
    return values[i] + (c - i) * (values[i + 1] - values[i]);
  };
  const scales = Float64Array.from({ length: n }, (_, i) => i / BIEX_CHANNELS);
  return { forward, inverse, bottom: values[0], top: values[last], table: { n, values, scales, step: 1 / BIEX_CHANNELS, lo: values[0], hi: values[last] } };
}

// The logicle closest to a FlowJo biex (for Gating-ML, which has no biex): the width basis wb
// sets W = log10(|wb|) / 2 decades. BD notes biex(−10) is nearly logicle(W 0.5, A 0).
export function biexToLogicle({ maxValue = 262144, widthBasis = -10, positiveDecades = 4.5, extraNegativeDecades = 0 }) {
  const M = positiveDecades;
  let W = Math.log10(Math.abs(Math.min(widthBasis, BIEX_MIN_WIDTH))) / 2;
  W = Math.min(W, M / 2);
  let A = extraNegativeDecades;
  A = Math.max(-W, Math.min(A, M - 2 * W));
  return { T: maxValue, W, M, A };
}

const cache = new Map();

const DEFAULTS = {
  linear: { min: 0, max: 262144 },
  log: { min: 1, max: 262144 },
  logicle: { A: 0 },
  biex: { maxValue: 262144, widthBasis: -10, positiveDecades: 4.5, extraNegativeDecades: 0 },
  arcsinh: { cofactor: 150, max: 262144 },
  fasinh: { T: 262144, M: 4.5, A: 0 },
  hyperlog: { T: 262144, W: 0.5, M: 4.5, A: 0 },
};

// A canonical key: defaults filled in, so equivalent specs share caches and compare equal.
export function transformKey(spec) {
  const type = spec?.type ?? 'linear';
  const full = { ...(DEFAULTS[type] ?? {}), ...(spec ?? {}), type };
  if (type === 'arcsinh' && full.min === undefined) full.min = -full.cofactor * Math.sinh(1);
  const keys = Object.keys(full).filter((key) => full[key] !== undefined && full[key] !== null).sort();
  return keys.map((key) => `${key}=${typeof full[key] === 'number' ? +full[key].toPrecision(12) : full[key]}`).join(';');
}

// Builds (and caches) a transform: { spec, key, forward, inverse, bottom, top, ticks(), label }.
export function createTransform(spec) {
  const key = transformKey(spec);
  const hit = cache.get(key);
  if (hit) return hit;
  let core;
  switch (spec?.type ?? 'linear') {
    case 'linear': core = createLinear(spec ?? {}); break;
    case 'log': core = createLog(spec); break;
    case 'logicle': core = createLogicle(spec); break;
    case 'biex': core = createBiex(spec); break;
    case 'arcsinh': core = createArcsinh(spec); break;
    case 'fasinh': core = createFasinh(spec); break;
    case 'hyperlog': core = createHyperlog(spec); break;
    default: throw new TransformError(`Unknown transform "${spec.type}".`);
  }
  const transform = {
    spec: { ...spec },
    key,
    forward: core.forward,
    inverse: core.inverse,
    bottom: core.bottom,
    top: core.top,
    logicle: spec?.type === 'logicle' ? core : null,
    table: core.table ?? null,
  };
  transform.ticks = () => axisTicks(transform);
  transform.label = describeTransform(spec);
  if (cache.size > 512) cache.clear();
  cache.set(key, transform);
  return transform;
}

// Transforms a column into display coordinates. `out` may be supplied to avoid allocation.
export function applyTransform(column, transformOrSpec, out) {
  const transform = transformOrSpec.forward ? transformOrSpec : createTransform(transformOrSpec);
  const result = out ?? new Float32Array(column.length);
  const type = transform.spec.type ?? 'linear';
  if (type === 'logicle' || type === 'biex' || type === 'hyperlog') {
    // A dense lookup table with linear interpolation in data space is accurate to ~1e-7 of the
    // scale and many times faster than Halley's method per event.
    const lut = lookupTable(transform);
    const { lo, hi, n, values, scales, step } = lut;
    for (let i = 0; i < column.length; i += 1) {
      const v = column[i];
      if (v <= lo || v >= hi || !Number.isFinite(v)) {
        result[i] = transform.forward(v);
        continue;
      }
      // Locate v among `values` (monotone in scale steps) by binary search.
      let left = 0;
      let right = n - 1;
      while (right - left > 1) {
        const mid = (left + right) >> 1;
        if (values[mid] <= v) left = mid;
        else right = mid;
      }
      const v0 = values[left];
      const v1 = values[right];
      const t = v1 === v0 ? 0 : (v - v0) / (v1 - v0);
      result[i] = scales[left] + t * step;
    }
    return result;
  }
  const f = transform.forward;
  for (let i = 0; i < column.length; i += 1) result[i] = f(column[i]);
  return result;
}

const lutCache = new WeakMap();

function lookupTable(transform) {
  if (transform.table) return transform.table;
  let lut = lutCache.get(transform);
  if (lut) return lut;
  const n = 1 << 14;
  const s0 = -0.25;
  const s1 = 1.25;
  const step = (s1 - s0) / (n - 1);
  const scales = new Float64Array(n);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    scales[i] = s0 + i * step;
    values[i] = transform.inverse(scales[i]);
  }
  lut = { n, scales, values, step, lo: values[0], hi: values[n - 1] };
  lutCache.set(transform, lut);
  return lut;
}

// --- Axis ticks ------------------------------------------------------------------------------

const SUPERSCRIPT = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

export function powerLabel(exponent, negative = false) {
  const sup = String(exponent).split('').map((ch) => SUPERSCRIPT[ch] ?? ch).join('');
  return `${negative ? '−' : ''}10${sup}`;
}

export function formatNumber(value) {
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  if (abs >= 1) return trim(value);
  return value.toPrecision(2).replace(/\.?0+$/, '');
}

function trim(value) {
  const text = Math.abs(value) >= 100 ? value.toFixed(0) : Math.abs(value) >= 10 ? value.toFixed(1) : value.toFixed(2);
  return text.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1').replace('-', '−');
}

function niceStep(span, target) {
  const raw = span / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const nice = unit < 1.5 ? 1 : unit < 3 ? 2 : unit < 7 ? 5 : 10;
  return nice * power;
}

// Ticks within the displayed range: [{ value, position (0–1), label, major }].
export function axisTicks(transform, options = {}) {
  const { spec } = transform;
  const type = spec.type ?? 'linear';
  const lo = transform.inverse(options.from ?? 0);
  const hi = transform.inverse(options.to ?? 1);
  const ticks = [];
  const push = (value, label, major) => {
    const position = transform.forward(value);
    if (position >= -1e-9 && position <= 1 + 1e-9 && Number.isFinite(position)) ticks.push({ value, position, label, major });
  };
  if (type === 'linear') {
    const step = niceStep(hi - lo, options.target ?? 5);
    const start = Math.ceil(lo / step) * step;
    for (let v = start; v <= hi + step * 1e-9; v += step) push(Math.abs(v) < step * 1e-9 ? 0 : v, formatNumber(Math.abs(v) < step * 1e-9 ? 0 : v), true);
    // Minor ticks at fifths.
    const minor = step / 5;
    const mstart = Math.ceil(lo / minor) * minor;
    for (let v = mstart; v <= hi; v += minor) {
      if (Math.abs(v / step - Math.round(v / step)) > 1e-6) push(v, '', false);
    }
    return ticks.sort((x, y) => x.position - y.position);
  }
  // Logarithmic-style axes: decades and their 2–9 subdivisions, both signs, plus zero.
  const maxExp = Math.ceil(Math.log10(Math.max(Math.abs(hi), 1)));
  const minPos = type === 'log' ? Math.floor(Math.log10(lo)) : 0;
  for (let e = minPos; e <= maxExp; e += 1) {
    const decade = 10 ** e;
    if (type === 'log' || e >= 1) push(decade, powerLabel(e), true);
    for (let m = 2; m <= 9; m += 1) push(m * decade, '', false);
  }
  if (type !== 'log') {
    push(0, '0', true);
    if (lo < 0) {
      const negExp = Math.ceil(Math.log10(Math.abs(lo)));
      for (let e = 1; e <= negExp; e += 1) {
        const decade = 10 ** e;
        push(-decade, powerLabel(e, true), true);
        for (let m = 2; m <= 9; m += 1) push(-m * decade, '', false);
      }
    }
  }
  ticks.sort((x, y) => x.position - y.position);
  // Drop major labels that would crowd: in the linear region of logicle-type scales, decades
  // 10¹ and 10² crowd zero.
  const minGap = options.minLabelGap ?? 0.045;
  let lastLabeled = -Infinity;
  const zero = ticks.find((t) => t.value === 0);
  for (const tick of ticks) {
    if (!tick.major || !tick.label) continue;
    const crowdsZero = zero && tick !== zero && Math.abs(tick.position - zero.position) < minGap;
    if (tick.position - lastLabeled < minGap || crowdsZero) {
      tick.label = '';
      continue;
    }
    lastLabeled = tick.position;
  }
  return ticks;
}

export function describeTransform(spec) {
  switch (spec?.type ?? 'linear') {
    case 'linear': return 'Linear';
    case 'log': return `Log (${formatNumber(spec.min)}–${formatNumber(spec.max)})`;
    case 'logicle': return `Logicle (W ${round(spec.W)}, M ${round(spec.M)}, A ${round(spec.A ?? 0)})`;
    case 'biex': return `Biexponential (width ${round(spec.widthBasis)}, ${round(spec.positiveDecades)} decades)`;
    case 'arcsinh': return `Arcsinh (cofactor ${round(spec.cofactor)})`;
    case 'fasinh': return `Gating-ML asinh (M ${round(spec.M)}, A ${round(spec.A ?? 0)})`;
    case 'hyperlog': return `Hyperlog (W ${round(spec.W)}, M ${round(spec.M)})`;
    default: return spec.type;
  }
}

function round(value) {
  return Number.isFinite(value) ? +value.toFixed(3) : value;
}

// Sensible default transform for a channel, given its type, range, technology and data.
export function defaultTransform(channel, technology = 'conventional', column = null) {
  const range = channel.range > 0 ? channel.range : 262144;
  if (channel.type === 'time' || channel.type === 'instrument') {
    let max = range;
    if (column && column.length) {
      let m = -Infinity;
      for (let i = 0; i < column.length; i += 1) if (column[i] > m) m = column[i];
      if (Number.isFinite(m) && m > 0) max = m;
    }
    return { type: 'linear', min: 0, max };
  }
  if (channel.type === 'scatter') {
    return { type: 'linear', min: 0, max: Math.min(range, 4194304) };
  }
  if (technology === 'mass') {
    let max = 10000;
    if (column && column.length) max = Math.max(1000, quantile(column, 0.9999) * 1.2);
    return { type: 'arcsinh', cofactor: 5, max, min: -5 * Math.sinh(1) };
  }
  const T = Math.max(range, 1024);
  const M = T >= 4e6 ? 5.6 : T >= 1e6 ? 5 : 4.5;
  const W = column ? estimateLogicleW(column, T, M) : 0.5;
  return { type: 'logicle', T, W: +W.toFixed(3), M, A: 0 };
}

export function quantile(values, q) {
  const n = values.length;
  if (!n) return Number.NaN;
  const step = Math.max(1, Math.floor(n / 100000));
  const sample = [];
  for (let i = 0; i < n; i += step) if (Number.isFinite(values[i])) sample.push(values[i]);
  sample.sort((a, b) => a - b);
  const pos = q * (sample.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sample[lo] + (sample[hi] - sample[lo]) * (pos - lo);
}
