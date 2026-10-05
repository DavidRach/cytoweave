// Rare-event statistics: exact confidence intervals on counts and frequencies, the precision a
// count gives and the events needed for a target precision, and limits of blank, detection and
// quantification from blank and low-level samples.

import { gammaP, incompleteBeta, normalQuantile } from './hypothesis.js';

// The x in [lo, hi] where the increasing function f reaches `target`, by bisection to the
// precision of doubles.
function invert(f, target, lo, hi) {
  for (let k = 0; k < 2000; k += 1) {
    const mid = 0.5 * (lo + hi);
    if (mid <= lo || mid >= hi) break;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// Exact (Garwood 1936) confidence interval of a Poisson mean from an observed count n:
//   lower = ½·χ²(α/2; 2n),  upper = ½·χ²(1 − α/2; 2n + 2)
// the interval R's poisson.test reports. ½·χ² with 2n degrees of freedom is a gamma(n, 1)
// variable, so the limits are gamma quantiles.
export function poissonInterval(count, level = 0.95) {
  if (!(count >= 0) || !Number.isFinite(count)) return [Number.NaN, Number.NaN];
  const n = Math.round(count);
  const alpha = 1 - level;
  const span = (a) => a + 40 * Math.sqrt(a) + 60;
  const lower = n === 0 ? 0 : invert((x) => gammaP(n, x), alpha / 2, 0, span(n));
  const upper = invert((x) => gammaP(n + 1, x), 1 - alpha / 2, 0, span(n + 1));
  return [lower, upper];
}

// Exact (Clopper & Pearson 1934) confidence interval of a proportion from x events of n:
//   lower = B(α/2; x, n − x + 1),  upper = B(1 − α/2; x + 1, n − x)
// with B the beta quantile; the interval R's binom.test reports. Returned as fractions.
export function binomialInterval(x, n, level = 0.95) {
  if (!(n > 0) || !(x >= 0) || x > n) return [Number.NaN, Number.NaN];
  const alpha = 1 - level;
  const lower = x === 0 ? 0 : invert((p) => incompleteBeta(p, x, n - x + 1), alpha / 2, 0, 1);
  const upper = x === n ? 1 : invert((p) => incompleteBeta(p, x + 1, n - x), 1 - alpha / 2, 0, 1);
  return [lower, upper];
}

// The events needed to measure a population with a coefficient of variation `cv` (%):
//   of the population itself, from Poisson counting:  r = (100/cv)²
//   of its parent, for a frequency f (%) of the parent, from the binomial CV
//   √((1 − p)/(N·p)):                                N = (1 − p)/(p·(cv/100)²),  p = f/100
// (Roederer 2008, "How many events is enough?", Cytometry A 73:384–385, gives r = (100/cv)²).
export function eventsNeeded(cv, frequency = null) {
  if (!(cv > 0)) return { events: Number.NaN, parentEvents: Number.NaN };
  const c = cv / 100;
  const events = Math.ceil(1 / (c * c) - 1e-9);
  if (!(frequency > 0) || frequency > 100) return { events, parentEvents: Number.NaN };
  const p = frequency / 100;
  return { events, parentEvents: Math.ceil((1 - p) / (p * c * c) - 1e-9) };
}

// The CV (%) with which a count of n events estimates its frequency among N parent events
// (binomial), or with N omitted its count (Poisson, 100/√n).
export function countPrecision(n, parentEvents = null) {
  if (!(n > 0)) return Infinity;
  if (!(parentEvents > 0)) return 100 / Math.sqrt(n);
  const p = n / parentEvents;
  return 100 * Math.sqrt((1 - p) / n);
}

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sampleSD(values) {
  if (values.length < 2) return Number.NaN;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1));
}

// Limits of blank, detection and quantification (CLSI EP17-A2; Armbruster & Pry 2008, Clin Biochem
// Rev 29 Suppl 1:S49–S52):
//   LoB = mean(blank) + 1.645·SD(blank), or with method 'nonparametric' the blanks' 95th
//         percentile, the value at rank 0.5 + 0.95·N of the N sorted blanks (interpolated);
//   LoD = LoB + 1.645·SD(low), with SD(low) pooled over the low-level samples' groups;
//   LoQ = the lowest mean among the low-level groups whose CV meets `cvTarget` (%), not below the
//         LoD (EP17's precision-profile approach).
// `blanks` are values (one per blank measurement: the statistic of a population in a sample with
// none of it); `low` is an array of groups, each the values of replicate measurements of one
// low-level sample. EP17 asks for 60 blank and 60 low-level results to establish limits and 20 to
// verify them; fewer are accepted and reported in `notes`. Options: method ('parametric'),
// cvTarget (20), level (0.95, the one-sided coverage of each limit).
export function detectionLimits(blanks, low = [], options = {}) {
  const method = options.method ?? 'parametric';
  const z = normalQuantile(options.level ?? 0.95);
  const cvTarget = options.cvTarget ?? 20;
  const notes = [];
  const b = blanks.filter(Number.isFinite).sort((x, y) => x - y);
  const result = { method, cvTarget, blankCount: b.length, blankMean: Number.NaN, blankSD: Number.NaN, lob: Number.NaN, lod: Number.NaN, loq: Number.NaN, lowSD: Number.NaN, lowGroups: [], notes };
  if (!b.length) {
    notes.push('No blank values.');
    return result;
  }
  result.blankMean = mean(b);
  result.blankSD = sampleSD(b);
  if (method === 'nonparametric') {
    const rank = 0.5 + (options.level ?? 0.95) * b.length;
    if (rank > b.length) {
      result.lob = b[b.length - 1];
      notes.push(`With ${b.length} blanks the 95th percentile lies beyond the highest blank; the highest is used.`);
    } else if (rank <= 1) result.lob = b[0];
    else {
      const k = Math.floor(rank);
      result.lob = k >= b.length ? b[b.length - 1] : b[k - 1] + (rank - k) * (b[k] - b[k - 1]);
    }
  } else if (b.length >= 2) result.lob = result.blankMean + z * result.blankSD;
  else notes.push('One blank gives no SD; a parametric limit of blank needs two or more.');
  if (b.length < 20) notes.push(`${b.length} blank value(s); EP17 asks for 20 to verify a limit and 60 to establish one.`);

  const groups = low.map((g) => g.filter(Number.isFinite)).filter((g) => g.length);
  let pooledSS = 0;
  let pooledDF = 0;
  let lowCount = 0;
  for (const g of groups) {
    const m = mean(g);
    const sd = sampleSD(g);
    lowCount += g.length;
    if (g.length >= 2) {
      pooledSS += (g.length - 1) * sd * sd;
      pooledDF += g.length - 1;
    }
    result.lowGroups.push({ n: g.length, mean: m, sd, cv: m ? (100 * sd) / Math.abs(m) : Number.NaN });
  }
  if (pooledDF > 0) {
    result.lowSD = Math.sqrt(pooledSS / pooledDF);
    if (Number.isFinite(result.lob)) result.lod = result.lob + z * result.lowSD;
    if (lowCount < 20) notes.push(`${lowCount} low-level value(s); EP17 asks for 20 to verify a limit and 60 to establish one.`);
  } else if (groups.length) notes.push('The low-level samples need two or more values in a group for an SD.');
  const meeting = result.lowGroups.filter((g) => g.cv <= cvTarget && !(g.mean < result.lod)).map((g) => g.mean);
  if (meeting.length) result.loq = Math.min(...meeting);
  else if (result.lowGroups.length) notes.push(`No low-level group reached a CV of ${cvTarget}% at or above the limit of detection.`);
  return result;
}

// Where a measured value stands against the limits: 'not-detected' (at or below the LoB),
// 'detected' (above the LoB, below the LoQ) or 'quantifiable' (at or above the LoQ, or above the
// LoB when there is no LoQ). `loq` may be given per value (a count limit differs by sample).
export function classifyValue(value, { lob, loq } = {}) {
  if (!Number.isFinite(value)) return null;
  if (Number.isFinite(lob) && value <= lob) return 'not-detected';
  if (Number.isFinite(loq) && value < loq) return 'detected';
  return 'quantifiable';
}
