// Uncertainty-aware autogating (G9): a shared gate adapted to each sample, with a confidence, so
// that confident adjustments are proposed and uncertain samples go to review instead of being
// moved silently.
//
// Method. A gate's geometry is known to be right on some samples, its exemplars: the samples the
// user adjusted it on (their overrides), the sample the shared gate was drawn on, and samples the
// user confirmed. For a target sample, the gate is carried over from an exemplar by landmark
// registration along each of its axes (as flowStats' gaussNorm registers channels, re-implemented
// here): the peaks of the parent population's density near the gate are found in both samples,
// matched in order, and a monotone piecewise-linear warp through the matched peaks maps the gate's
// coordinates. A boundary that sat in a density valley on the exemplar snaps to the valley it
// lands in. The result is repeated over the most similar exemplars, several smoothing bandwidths
// and random halves of the target's events; their disagreement is the uncertainty. Each event's
// membership probability is the weighted share of these geometries that contain it.
//
// The confidence combines (i) the agreement of the ensemble (weighted mean Jaccard index of each
// member's population with the proposal's), (ii) how much of the exemplar's peak structure was
// found and aligned in the target, and (iii) whether the adapted boundary cuts through denser
// events than the exemplar's did (or, across a cohort, than the cohort's typically do); a boundary
// the gate-robustness check would rate robust is never held against it. Everything works in the
// gate's own scale space (0–1 per axis).
//
// The method is conservative, as checked against experts' own per-sample gates (the ALS ICS data
// of the validation suite). A gate is adjusted only where its current boundary cuts into a
// population (it is not robust there) and the adaptation puts it in sparser events: experts do
// not move a boundary that sits in a valley, and populations that moved for biological reasons
// (CD3 and CD4 down-regulated by a stimulation) should not be gated away. Landmarks are matched
// only within 0.16 of the axis (about a 5-fold gain on a logicle scale): larger displacements are
// not instrument drift.

import { bin1d, blur1d } from './density.js';
import { forEachChunk } from './eventset.js';
import { offsetGeometry, pointTest } from './gates.js';
import { ellipseFromConjugateDiameters } from './flowjo.js';
import { createRandom } from './random.js';

const RANGE = [-0.15, 1.15];
const BINS = 260;
const STEP = (RANGE[1] - RANGE[0]) / BINS;
const MAX_DENSITY_EVENTS = 60000;
// Events the ensemble's populations are compared on (probabilities.full: all of them).
const MAX_MEMBER_EVENTS = 200000;

export const ADAPT_DEFAULTS = {
  bandwidths: [1.8, 2.6, 3.8], // smoothing, in bins
  halves: 2, // random halves of the target's events, besides all of them
  exemplars: 3, // the most similar exemplars used
  maxShift: 0.16, // largest landmark displacement, in scale units
  snap: 0.04, // how far a boundary may move to reach a valley
  confident: 0.8, // confidence at or above which an adjustment is proposed
  unchanged: 0.985, // Jaccard index with the current gate above which nothing changes
  sparser: 1.25, // an adjustment must put the boundary in this many times sparser events
  robust: 0.05, // boundary sensitivity (change per 1% of the axis) that is never penalized
  groupAgreement: 0.9, // Jaccard index below which a sample is unlike the rest of its group
  seed: 1,
};

const binOf = (v) => Math.floor((v - RANGE[0]) / STEP);
const posOf = (b) => RANGE[0] + (b + 0.5) * STEP;

// Event indices of a population as a plain array (indices may be null, an array or an EventSet).
export function indexList(indices, size) {
  if (indices === null) return Uint32Array.from({ length: size }, (_, i) => i);
  const out = [];
  forEachChunk(indices, size, (chunk, length) => { for (let k = 0; k < length; k += 1) out.push(chunk[k]); });
  return Uint32Array.from(out);
}

function thin(list, limit, random) {
  if (list.length <= limit) return list;
  const out = new Uint32Array(limit);
  const stride = list.length / limit;
  const offset = random ? random() * stride : 0;
  for (let i = 0; i < limit; i += 1) out[i] = list[Math.min(list.length - 1, Math.floor(offset + i * stride))];
  return out;
}

// The extent of a geometry along each axis (null for an unbounded side).
function extent(type, geometry) {
  switch (type) {
    case 'polygon': {
      const xs = geometry.vertices.map((v) => v[0]);
      const ys = geometry.vertices.map((v) => v[1]);
      return [[Math.min(...xs), Math.max(...xs)], [Math.min(...ys), Math.max(...ys)]];
    }
    case 'rectangle': return [[geometry.min?.[0] ?? null, geometry.max?.[0] ?? null], [geometry.min?.[1] ?? null, geometry.max?.[1] ?? null]];
    case 'ellipse': {
      const r = Math.max(...geometry.radii);
      return [[geometry.center[0] - r, geometry.center[0] + r], [geometry.center[1] - r, geometry.center[1] + r]];
    }
    case 'range': return [[geometry.min ?? null, geometry.max ?? null]];
    default: return [[null, null], [null, null]];
  }
}

// The window of the other axis that the density of an axis is taken in: the gate's extent widened
// by half of itself (whole axis when unbounded), so the peaks are those of the populations near it.
function windowOf(span) {
  if (!span || span[0] === null || span[1] === null) return null;
  const width = Math.max(0.05, span[1] - span[0]);
  return [span[0] - 0.5 * width - 0.03, span[1] + 0.5 * width + 0.03];
}

// Smoothed density along `axis` of the events in `list`, restricted to `window` on the other axis.
export function localDensity(columns, list, axis, window, sigma) {
  const counts = new Float64Array(BINS);
  const x = columns[axis];
  const other = window ? columns[1 - axis] : null;
  for (let k = 0; k < list.length; k += 1) {
    const e = list[k];
    if (other) {
      const o = other[e];
      if (!(o >= window[0] && o <= window[1])) continue;
    }
    const b = binOf(x[e]);
    if (b >= 0 && b < BINS) counts[b] += 1;
  }
  const smooth = blur1d(counts, sigma);
  let total = 0;
  for (const v of smooth) total += v;
  if (total > 0) for (let i = 0; i < BINS; i += 1) smooth[i] /= total;
  return smooth;
}

// Peaks of a density: local maxima of at least 3% of the highest, with a prominence of 2%.
export function landmarks(density) {
  let max = 0;
  for (const v of density) if (v > max) max = v;
  if (!(max > 0)) return [];
  const peaks = [];
  for (let i = 1; i < density.length - 1; i += 1) {
    if (!(density[i] >= density[i - 1] && density[i] > density[i + 1])) continue;
    if (density[i] < 0.03 * max) continue;
    let left = density[i];
    for (let j = i - 1; j >= 0 && density[j] <= density[i]; j -= 1) left = Math.min(left, density[j]);
    let right = density[i];
    for (let j = i + 1; j < density.length && density[j] <= density[i]; j += 1) right = Math.min(right, density[j]);
    if (density[i] - Math.max(left, right) < 0.02 * max) continue;
    peaks.push({ bin: i, pos: posOf(i), height: density[i] / max });
  }
  return peaks.sort((a, b) => b.height - a.height).slice(0, 6).sort((a, b) => a.pos - b.pos);
}

// Order-preserving matching of reference to target peaks (dynamic programming): matching costs
// the displacement (relative to maxShift) and the difference of heights; leaving a peak unmatched
// costs more the higher it is. Returns [[referencePeak, targetPeak], …].
export function matchLandmarks(ref, tgt, maxShift = ADAPT_DEFAULTS.maxShift) {
  const n = ref.length;
  const m = tgt.length;
  const skipR = (i) => 0.4 + ref[i].height;
  const skipT = (j) => 0.4 + tgt[j].height;
  const pair = (i, j) => {
    const d = Math.abs(ref[i].pos - tgt[j].pos);
    if (d > maxShift) return Infinity;
    return d / maxShift + 0.3 * Math.abs(Math.log((ref[i].height + 0.05) / (tgt[j].height + 0.05)));
  };
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const move = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  for (let i = 1; i <= n; i += 1) { cost[i][0] = cost[i - 1][0] + skipR(i - 1); move[i][0] = 1; }
  for (let j = 1; j <= m; j += 1) { cost[0][j] = cost[0][j - 1] + skipT(j - 1); move[0][j] = 2; }
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const options = [cost[i - 1][j - 1] + pair(i - 1, j - 1), cost[i - 1][j] + skipR(i - 1), cost[i][j - 1] + skipT(j - 1)];
      const best = options[0] <= options[1] && options[0] <= options[2] ? 0 : options[1] <= options[2] ? 1 : 2;
      cost[i][j] = options[best];
      move[i][j] = best;
    }
  }
  const pairs = [];
  for (let i = n, j = m; i > 0 || j > 0;) {
    const step = move[i][j];
    if (i > 0 && j > 0 && step === 0) {
      pairs.push([ref[i - 1], tgt[j - 1]]);
      i -= 1;
      j -= 1;
    } else if (i > 0 && (j === 0 || step === 1)) i -= 1;
    else j -= 1;
  }
  return pairs.reverse();
}

// A monotone piecewise-linear warp through matched peaks; beyond the outermost, a shift.
export function warpFunction(pairs) {
  if (!pairs.length) return (v) => v;
  const xs = pairs.map(([r]) => r.pos);
  const ys = pairs.map(([, t]) => t.pos);
  return (v) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return v;
    if (v <= xs[0]) return v + (ys[0] - xs[0]);
    const last = xs.length - 1;
    if (v >= xs[last]) return v + (ys[last] - xs[last]);
    let k = 0;
    while (v > xs[k + 1]) k += 1;
    const t = (v - xs[k]) / (xs[k + 1] - xs[k]);
    return ys[k] + t * (ys[k + 1] - ys[k]);
  };
}

// How well a warp aligns: the share of the reference's peak height matched, and the correlation
// of the warped reference density with the target's.
function alignment(refDensity, tgtDensity, pairs, refPeaks, warp) {
  const matched = pairs.reduce((s, [r]) => s + r.height, 0) / Math.max(1e-9, refPeaks.reduce((s, p) => s + p.height, 0));
  const warped = new Float64Array(BINS);
  for (let b = 0; b < BINS; b += 1) {
    const to = binOf(warp(posOf(b)));
    if (to >= 0 && to < BINS) warped[to] += refDensity[b];
  }
  const smooth = blur1d(warped, 1.5);
  let sa = 0; let sb = 0; let saa = 0; let sbb = 0; let sab = 0;
  for (let b = 0; b < BINS; b += 1) {
    const a = smooth[b];
    const c = tgtDensity[b];
    sa += a; sb += c; saa += a * a; sbb += c * c; sab += a * c;
  }
  const cov = sab - (sa * sb) / BINS;
  const r = cov / Math.sqrt(Math.max(1e-30, (saa - (sa * sa) / BINS) * (sbb - (sb * sb) / BINS)));
  return { matched: refPeaks.length ? matched : 0, correlation: Number.isFinite(r) ? Math.max(0, r) : 0 };
}

// A boundary that sat in a valley of the exemplar's density moves to the lowest point of the
// target's density within `snap` of where it was carried.
function snapToValley(value, refDensity, tgtDensity, refValue, snap) {
  if (value === null || !Number.isFinite(value)) return value;
  const rb = binOf(refValue);
  if (rb < 1 || rb >= BINS - 1) return value;
  let leftPeak = 0;
  for (let b = rb; b >= 0; b -= 1) leftPeak = Math.max(leftPeak, refDensity[b]);
  let rightPeak = 0;
  for (let b = rb; b < BINS; b += 1) rightPeak = Math.max(rightPeak, refDensity[b]);
  // A valley: lower than 40% of the smaller peak on either side.
  if (!(refDensity[rb] < 0.4 * Math.min(leftPeak, rightPeak))) return value;
  const center = binOf(value);
  const radius = Math.round(snap / STEP);
  let best = center;
  for (let b = Math.max(1, center - radius); b <= Math.min(BINS - 2, center + radius); b += 1) {
    if (tgtDensity[b] < tgtDensity[best] - 1e-12) best = b;
  }
  return best === center ? value : posOf(best);
}

// Carries a geometry through per-axis warps (and valley snapping of axis-aligned boundaries).
export function warpGeometry(type, geometry, warps, snap = null) {
  const [wx, wy] = warps;
  const s = (k, v) => (snap ? snap(k, v, k === 0 ? wx(v) : wy(v)) : k === 0 ? wx(v) : wy(v));
  switch (type) {
    case 'polygon': return { vertices: geometry.vertices.map(([x, y]) => [wx(x), wy(y)]) };
    case 'rectangle': return { min: [geometry.min?.[0] == null ? null : s(0, geometry.min[0]), geometry.min?.[1] == null ? null : s(1, geometry.min[1])], max: [geometry.max?.[0] == null ? null : s(0, geometry.max[0]), geometry.max?.[1] == null ? null : s(1, geometry.max[1])] };
    case 'range': return { min: geometry.min == null ? null : s(0, geometry.min), max: geometry.max == null ? null : s(0, geometry.max) };
    case 'split': return { ...geometry, threshold: s(0, geometry.threshold) };
    case 'quadrant': return { ...geometry, center: [s(0, geometry.center[0]), s(1, geometry.center[1])] };
    case 'ellipse': {
      const { center, radii, angle = 0 } = geometry;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const ends = [
        [center[0] + radii[0] * cos, center[1] + radii[0] * sin], [center[0] - radii[0] * cos, center[1] - radii[0] * sin],
        [center[0] - radii[1] * sin, center[1] + radii[1] * cos], [center[0] + radii[1] * sin, center[1] - radii[1] * cos],
      ].map(([x, y]) => [wx(x), wy(y)]);
      return ellipseFromConjugateDiameters(ends)?.ellipse ?? geometry;
    }
    default: return geometry;
  }
}

const DIMS = { range: 1, split: 1, rectangle: 2, polygon: 2, ellipse: 2, quadrant: 2 };
export const ADAPTABLE = new Set(Object.keys(DIMS));

// Carries an exemplar's geometry to a target. sample: { columns: [xs, ys?], list (parent indices) }.
export function carryOver(type, geometry, exemplar, target, options = {}) {
  const sigma = options.sigma ?? 2.6;
  const span = extent(type, geometry);
  const axes = DIMS[type];
  const warps = [];
  const quality = [];
  const densities = [];
  const counts = [];
  for (let axis = 0; axis < axes; axis += 1) {
    const window = axes === 2 && type !== 'quadrant' ? windowOf(span[1 - axis]) : null;
    const ref = localDensity(exemplar.columns, exemplar.list, axis, window, sigma);
    const tgt = localDensity(target.columns, target.list, axis, window, sigma);
    const rp = landmarks(ref);
    const tp = landmarks(tgt);
    let pairs = matchLandmarks(rp, tp, options.maxShift ?? ADAPT_DEFAULTS.maxShift);
    counts.push(pairs.length);
    // A variant without one matched pair: if that match was wrong, the variants disagree.
    if (options.drop?.axis === axis && pairs.length > 1) pairs = pairs.filter((_, k) => k !== options.drop.index);
    const warp = warpFunction(pairs);
    warps.push(warp);
    quality.push(alignment(ref, tgt, pairs, rp, warp));
    densities.push({ ref, tgt });
  }
  if (axes === 1) warps.push((v) => v);
  const snapper = options.snap === 0 ? null : (k, original, carried) => (densities[k] ? snapToValley(carried, densities[k].ref, densities[k].tgt, original, options.snap ?? ADAPT_DEFAULTS.snap) : carried);
  return { geometry: warpGeometry(type, geometry, warps, snapper), quality, pairs: counts };
}

// The members of a population (positions in `list`) inside a geometry.
export function members(type, geometry, columns, list) {
  const test = pointTest(type, geometry);
  const out = new Uint8Array(list.length);
  const [xs, ys] = columns;
  if (DIMS[type] === 1) for (let k = 0; k < list.length; k += 1) out[k] = test(xs[list[k]]) ? 1 : 0;
  else for (let k = 0; k < list.length; k += 1) out[k] = test(xs[list[k]], ys[list[k]]) ? 1 : 0;
  return out;
}

export function jaccard(a, b) {
  let both = 0;
  let either = 0;
  for (let k = 0; k < a.length; k += 1) {
    both += a[k] & b[k];
    either += a[k] | b[k];
  }
  return either ? both / either : 1;
}

// How much a population changes when its boundary moves by 1% of the axis: (n(+) − n(−)) / 2n.
export function boundarySensitivity(type, geometry, columns, list) {
  const count = (g) => members(type, g, columns, list).reduce((s, v) => s + v, 0);
  const n = count(geometry);
  if (!n) return 1;
  try {
    return Math.abs(count(offsetGeometry(type, geometry, 0.01)) - count(offsetGeometry(type, geometry, -0.01))) / (2 * n);
  } catch {
    return 0;
  }
}

// How alike two samples are around a gate: 1 − half the L1 distance of their local densities.
function similarity(type, geometry, a, b) {
  const span = extent(type, geometry);
  const axes = DIMS[type];
  let total = 0;
  for (let axis = 0; axis < axes; axis += 1) {
    const window = axes === 2 && type !== 'quadrant' ? windowOf(span[1 - axis]) : null;
    const da = localDensity(a.columns, a.list, axis, window, 2.6);
    const db = localDensity(b.columns, b.list, axis, window, 2.6);
    let l1 = 0;
    for (let i = 0; i < BINS; i += 1) l1 += Math.abs(da[i] - db[i]);
    total += 1 - l1 / 2;
  }
  return total / axes;
}

// Adapts a gate to one sample.
//   type: the gate's type; current: its geometry for the sample now;
//   exemplars: [{ sampleId, geometry, columns, list }] (samples where the geometry is right);
//   target: { columns, list } (the sample's parent population, in the gate's scales).
// Returns { geometry, confidence, status ('keep' | 'adjust' | 'review'), agreement, alignment,
// boundary, change (Jaccard index with the current gate), exemplars used, probabilities (per
// event of `list`: target.list, thinned to 200,000 events unless options.fullProbabilities),
// frequencies { current, adapted } }.
export function adaptGate({ type, current, exemplars, target, options = {} }) {
  const o = { ...ADAPT_DEFAULTS, ...options };
  if (!ADAPTABLE.has(type)) throw new Error(`${type} gates cannot be adapted.`);
  if (!exemplars.length) throw new Error('Adapting a gate needs at least one exemplar.');
  const random = createRandom(o.seed);
  const fit = (s) => ({ columns: s.columns, list: thin(s.list, MAX_DENSITY_EVENTS, null) });
  const tgtFull = fit(target);
  // The most similar exemplars, weighted by similarity.
  const ranked = exemplars.map((ex) => ({ ex, fitted: fit(ex), sim: similarity(type, ex.geometry, fit(ex), tgtFull) }))
    .sort((a, b) => b.sim - a.sim).slice(0, o.exemplars);
  const halves = [];
  for (let h = 0; h < o.halves; h += 1) {
    const keep = target.list.filter(() => random() < 0.5);
    halves.push(fit({ columns: target.columns, list: keep }));
  }
  const ensemble = [];
  ranked.forEach(({ ex, fitted, sim }, rank) => {
    const weight = Math.max(0.05, sim) ** 4;
    for (const sigma of o.bandwidths) {
      for (const tgt of [tgtFull, ...halves]) {
        const result = carryOver(type, ex.geometry, fitted, tgt, { sigma, maxShift: o.maxShift, snap: o.snap });
        ensemble.push({ ...result, weight, primary: rank === 0 && sigma === o.bandwidths[1] && tgt === tgtFull, exemplar: ex.sampleId });
      }
    }
  });
  let primary = ensemble.find((m) => m.primary) ?? ensemble[0];
  // Leave-one-landmark-out variants of the primary carry-over.
  const best = ranked[0];
  primary.pairs.forEach((n, axis) => {
    if (n < 2) return;
    for (let index = 0; index < n; index += 1) {
      const result = carryOver(type, best.ex.geometry, best.fitted, tgtFull, { sigma: o.bandwidths[1], maxShift: o.maxShift, snap: o.snap, drop: { axis, index } });
      ensemble.push({ ...result, weight: primary.weight, primary: false, exemplar: best.ex.sampleId });
    }
  });
  primary = ensemble.find((m) => m.primary) ?? ensemble[0];
  // Large populations are compared on a thinned set of their events (all, for CLR export).
  const compared = o.fullProbabilities ? target.list : thin(target.list, MAX_MEMBER_EVENTS, null);
  const masks = ensemble.map((m) => members(type, m.geometry, target.columns, compared));
  const primaryMask = masks[ensemble.indexOf(primary)];
  let wsum = 0;
  let agreement = 0;
  const probabilities = new Float32Array(compared.length);
  ensemble.forEach((m, i) => {
    wsum += m.weight;
    agreement += m.weight * jaccard(masks[i], primaryMask);
    const mask = masks[i];
    for (let k = 0; k < mask.length; k += 1) if (mask[k]) probabilities[k] += m.weight;
  });
  agreement /= wsum;
  for (let k = 0; k < probabilities.length; k += 1) probabilities[k] /= wsum;
  const align = Math.min(...primary.quality.map((q) => Math.min(1, q.matched) * q.correlation));
  // Boundary density: how much the population changes when its boundary moves by 1% of the axis,
  // on the exemplar and on the target. decide() compares them (or, across a cohort, the target's
  // with the cohort's typical value).
  const sRef = boundarySensitivity(type, best.ex.geometry, best.ex.columns, thin(best.ex.list, MAX_MEMBER_EVENTS, null));
  const sTgt = boundarySensitivity(type, primary.geometry, target.columns, compared);
  const sCur = boundarySensitivity(type, current, target.columns, compared);
  const currentMask = members(type, current, target.columns, compared);
  const change = jaccard(currentMask, primaryMask);
  const count = (mask) => mask.reduce((s, v) => s + v, 0);
  const n = compared.length || 1;
  return decide({
    geometry: primary.geometry,
    agreement,
    alignment: align,
    sensitivity: { exemplar: sRef, adapted: sTgt, current: sCur },
    change,
    exemplars: ranked.map((r) => ({ sampleId: r.ex.sampleId, similarity: r.sim })),
    members: ensemble.length,
    probabilities,
    list: compared, // the events `probabilities` refer to
    frequencies: { current: count(currentMask) / n, adapted: count(primaryMask) / n },
  }, sRef, o);
}

// The confidence, status and reason of an adaptation, given the boundary density it is judged
// against: the exemplar's, or (across a cohort) the median of the adapted boundaries'. A boundary
// that cuts through denser events than that is uncertain.
export function decide(result, reference, options = {}) {
  const o = { ...ADAPT_DEFAULTS, ...options };
  // A boundary the gate-robustness check rates robust (the population changes by at most 5% when
  // it moves by 1% of the axis) is never held against an adaptation.
  const boundary = Math.min(1, (Math.max(reference, o.robust) + 0.02) / (result.sensitivity.adapted + 0.02));
  const confidence = result.agreement * Math.sqrt(Math.max(0, result.alignment)) * boundary;
  let status;
  let reason;
  if (confidence < o.confident) {
    status = 'review';
    // The weakest of the three, in words.
    const factors = [[result.agreement, 'the ensemble of carried-over gates disagrees'], [Math.sqrt(Math.max(0, result.alignment)), 'the density landmarks do not match the exemplar\'s'], [boundary, options.cohort ? 'the boundary would cut through denser events than in the other samples' : 'the boundary would cut through denser events than on the exemplar']];
    reason = factors.sort((a, b) => a[0] - b[0])[0][1];
  } else if (result.change >= o.unchanged) {
    status = 'keep';
    reason = 'the gate already fits';
  } else if (!(result.sensitivity.current > Math.max(o.robust, o.sparser * result.sensitivity.adapted + 0.005))) {
    // Moving a boundary that is already robust here, or that the adaptation would not put in
    // sparser events, gains nothing: where populations moved for biological reasons (a
    // stimulation, a donor), the gate should stay.
    status = 'keep';
    reason = 'the gate does not cut into a population here';
  } else {
    status = 'adjust';
    reason = 'carried over with confidence';
  }
  return { ...result, boundary, confidence, status, reason };
}
