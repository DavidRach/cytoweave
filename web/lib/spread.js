// Predicted spillover spreading (S6): how much a panel's dyes will spread into each other's
// channels, from their spectra (or spillover values) and the instrument's noise, before the panel
// is run.
//
// A dye i at brightness ΔF puts ΔF·s_id into detector d. Two kinds of noise reach unmixed (or
// compensated) channel j through the operator U (abundances = signal · U):
// - photon counting: detector d's variance grows by c1_d per unit of signal (c1 = 1/Q in the
//   units of the data; Parks et al. 2017), so channel j gains ΔF · Σ_d U_dj² c1_d s_id;
// - laser intensity: each laser's intensity varies from event to event, independently of the
//   other lasers (they cross the stream at different places). Unmixing cancels the dye exactly
//   only when all its light varies together, so a dye excited by several lasers leaves
//   ΔF² · Σ_L cv_L² (Σ_{d∈L} U_dj s_id)² in channel j.
// The spreading coefficient SS_ij = √(Δσ²_j / ΔF_i) (Nguyen et al. 2013) is then
// √(photon_ij + ΔF_i · laser_ij): constant for photon noise, growing with brightness for laser
// noise, so a predicted matrix is stated at a brightness.
//
// A dye excited by two lasers has equal and opposite terms on them, so its spread tells only the
// sum cv_1² + cv_2²: individual laser CVs are not identifiable from such controls, but the
// predictions for dyes on the same lasers are, which is what a panel needs.
//
// c1 and the laser CVs are fitted to the variance differences of single-stain controls
// (spectralSpreading and spilloverSpreading return them), weighted by their standard errors and
// shrunk toward a common c1 where a detector receives too little light to be estimated; or c1
// comes from bead runs of the instrument (qb.js). On the 15 bead controls of a BD LSRFortessa,
// each control's spread predicted from the other 14 was within 2× of the observed for 79% of the
// entries measured to 4 SE (67% with photon noise alone); on simulated controls, 98%
// (validation/run.mjs, suites "fortessa" and "spread").

import { parseDetectorName, unmixingOperator } from './spectral.js';
import { nnlsGramInPlace } from './linalg.js';

const LASER_ALIASES = { U: 'UV', Y: 'YG', G: 'YG' };

// The laser of a detector named after it: spectral names ('B3-A', 'YG1 (575)-A') and BD
// conventional ones ('B 530/30-A', 'Y 586/15-A', 'U 450/50-A'); null otherwise.
export function detectorLaser(name) {
  const info = parseDetectorName(name);
  if (info) return info.laser;
  const match = /^(UV|U|V|B|YG|Y|G|R|IR)\s*\d{3}\s*\/\s*\d{1,3}/i.exec(String(name ?? '').trim());
  if (!match) return null;
  const code = match[1].toUpperCase();
  return LASER_ALIASES[code] ?? code;
}

// A panel's spread model. spectra: F rows over D detectors, as unmixing uses them (peak-normalized
// for spectral data; spillover rows, 1 in the dye's own detector, for compensation). operator:
// the D × F unmixing operator (default: the pseudo-inverse, i.e. OLS or, for a square spillover
// matrix, its inverse). lasers: the laser of each detector (default: from the names).
export function spreadModel({ names, detectors, spectra, operator = null, lasers = null }) {
  const F = names.length;
  const D = detectors.length;
  const S = new Float64Array(F * D);
  for (let i = 0; i < F; i += 1) {
    const row = ArrayBuffer.isView(spectra) ? spectra.subarray(i * D, i * D + D) : spectra[i];
    if (!row || row.length !== D) throw new Error(`The spectrum of ${names[i]} does not cover the ${D} detectors.`);
    for (let d = 0; d < D; d += 1) S[i * D + d] = row[d];
  }
  const P = operator ? Float64Array.from(operator) : unmixingOperator({ names, detectors, matrix: S });
  const laserNames = [];
  const laserOf = new Int32Array(D).fill(-1);
  detectors.forEach((detector, d) => {
    const laser = lasers ? lasers[d] : detectorLaser(detector);
    if (!laser) return;
    if (!laserNames.includes(laser)) laserNames.push(laser);
    laserOf[d] = laserNames.indexOf(laser);
  });
  return { names: [...names], detectors: [...detectors], F, D, S, P, lasers: laserNames, laserOf };
}

// The terms of dye i's spread into channel j: photon[d] = U_dj² max(s_id, 0) (times ΔF·c1_d) and
// laser[L] = (Σ_{d∈L} U_dj s_id)² (times ΔF²·cv_L²).
export function spreadTerms(model, i, j) {
  const { F, D, S, P, lasers, laserOf } = model;
  const photon = new Float64Array(D);
  const sums = new Float64Array(lasers.length);
  for (let d = 0; d < D; d += 1) {
    const u = P[d * F + j];
    const s = S[i * D + d];
    // A measured spectrum can dip below zero in dark detectors; photon noise cannot.
    photon[d] = u * u * Math.max(s, 0);
    if (laserOf[d] >= 0) sums[laserOf[d]] += u * s;
  }
  return { photon, laser: sums.map((v) => v * v) };
}

// The variance a dye at brightness deltaF adds to channel j under a noise model
// { c1: per detector, laserCV: per laser of the model }.
export function predictedVariance(model, noise, i, j, deltaF) {
  const { photon, laser } = spreadTerms(model, i, j);
  let p = 0;
  for (let d = 0; d < photon.length; d += 1) p += photon[d] * noise.c1[d];
  let l = 0;
  for (let k = 0; k < laser.length; k += 1) l += laser[k] * (noise.laserCV?.[k] ?? 0) ** 2;
  return deltaF * p + deltaF * deltaF * l;
}

// The predicted spreading matrix at the dyes' brightness (a number or one per dye, in the units
// of the unmixed channels): { names, matrix (SS, F × F), photon (the brightness-independent
// photon part), laser (Δσ² per ΔF² from the lasers), brightness }.
export function predictedSpreading(model, noise, brightness) {
  const { F } = model;
  const bright = Float64Array.from({ length: F }, (_, i) => (typeof brightness === 'number' ? brightness : brightness?.[i] ?? Number.NaN));
  const matrix = new Float64Array(F * F);
  const photon = new Float64Array(F * F);
  const laser = new Float64Array(F * F);
  for (let i = 0; i < F; i += 1) {
    for (let j = 0; j < F; j += 1) {
      if (i === j) continue;
      const terms = spreadTerms(model, i, j);
      let p = 0;
      for (let d = 0; d < terms.photon.length; d += 1) p += terms.photon[d] * noise.c1[d];
      let l = 0;
      for (let k = 0; k < terms.laser.length; k += 1) l += terms.laser[k] * (noise.laserCV?.[k] ?? 0) ** 2;
      photon[i * F + j] = Math.sqrt(p);
      laser[i * F + j] = l;
      matrix[i * F + j] = Number.isFinite(bright[i]) ? Math.sqrt(p + bright[i] * l) : Math.sqrt(p);
    }
  }
  return { names: model.names, n: F, matrix, photon, laser, brightness: bright };
}

// Fits the noise of the instrument to controls' variance differences: observations
// [{ i, deltaF, rows: [{ j, variance, se }] }] (from spectralSpreading or spilloverSpreading).
// options: exclude (a dye index left out, for cross-validation), c1 (fixed per-detector values,
// e.g. from beads: only the laser CVs are fitted), shrinkage (toward a common c1; default 0.02),
// laser (fit laser CVs; default true).
// Returns { c1, laserCV, common, identified (per detector; the others take the common value),
// entries, outliers }.
export function fitNoise(model, observations, options = {}) {
  const { D, lasers } = model;
  const L = options.laser === false ? 0 : lasers.length;
  const fixed = options.c1 ? Float64Array.from(options.c1) : null;
  const entries = [];
  for (const o of observations) {
    if (o.i === options.exclude || !(o.deltaF > 0)) continue;
    for (const r of o.rows) {
      if (!Number.isFinite(r.variance) || !(r.se > 0)) continue;
      const terms = spreadTerms(model, o.i, r.j);
      entries.push({ i: o.i, j: r.j, y: r.variance, se: r.se, photon: terms.photon, laser: terms.laser, deltaF: o.deltaF, weight: 1 });
    }
  }
  if (!entries.length) throw new Error('No control spread to fit the noise to.');
  // Columns: c1 per detector (unless fixed), then cv² per laser.
  const P = (fixed ? 0 : D) + L;
  const row = (e) => {
    const f = new Float64Array(P);
    if (!fixed) for (let d = 0; d < D; d += 1) f[d] = e.deltaF * e.photon[d];
    for (let k = 0; k < L; k += 1) f[(fixed ? 0 : D) + k] = e.deltaF * e.deltaF * e.laser[k];
    return f;
  };
  const offset = (e) => {
    if (!fixed) return 0;
    let p = 0;
    for (let d = 0; d < D; d += 1) p += e.photon[d] * fixed[d];
    return e.deltaF * p;
  };
  const rows = entries.map(row);
  const scale = new Float64Array(P);
  for (const f of rows) for (let p = 0; p < P; p += 1) scale[p] = Math.max(scale[p], Math.abs(f[p]));
  // A detector that (almost) no dye reaches has (almost) no data: scale it like the others, so
  // that its shrinkage toward the common value is not lost below the solver's tolerance.
  const photonScales = Array.from(scale.subarray(0, fixed ? 0 : D)).filter((v) => v > 0).sort((a, b) => a - b);
  const typical = photonScales.length ? photonScales[Math.floor(photonScales.length / 2)] : 1;
  for (let p = 0; p < P; p += 1) {
    if (p < (fixed ? 0 : D)) scale[p] = Math.max(scale[p], 0.01 * typical);
    else if (!(scale[p] > 0)) scale[p] = 1;
  }

  const solve = (common, lambda) => {
    const G = new Float64Array(P * P);
    const b = new Float64Array(P);
    entries.forEach((e, k) => {
      const w = e.weight / (e.se * e.se);
      const f = rows[k];
      const y = e.y - offset(e);
      for (let p = 0; p < P; p += 1) {
        if (!f[p]) continue;
        const fp = f[p] / scale[p];
        b[p] += w * fp * y;
        for (let q = 0; q < P; q += 1) if (f[q]) G[p * P + q] += w * fp * (f[q] / scale[q]);
      }
    });
    // Shrinkage of each c1 toward the common value (on the scaled coefficients).
    if (!fixed && lambda > 0) {
      let diag = 0;
      for (let d = 0; d < D; d += 1) diag += G[d * P + d];
      const ridge = (lambda * diag) / D;
      for (let d = 0; d < D; d += 1) {
        G[d * P + d] += ridge;
        b[d] += ridge * common * scale[d];
      }
    }
    const x = new Float64Array(P);
    nnlsGramInPlace(G, b, P, x);
    for (let p = 0; p < P; p += 1) x[p] /= scale[p];
    return x;
  };
  const predict = (x, e, k) => {
    const f = rows[k];
    let v = offset(e);
    for (let p = 0; p < P; p += 1) v += f[p] * x[p];
    return v;
  };

  // A common c1 first (one shared coefficient, with the lasers), then per detector, shrunk
  // toward it; two rounds of down-weighting entries far from the fit (Huber, at 3 SE), which
  // keeps a heterogeneous control (a degraded tandem) from bending every detector.
  let common = 0;
  if (!fixed) {
    const shared = fitShared(entries, L, D);
    common = shared;
  }
  const lambda = options.shrinkage ?? 0.02;
  let x = solve(common, lambda);
  let outliers = 0;
  for (let round = 0; round < 2; round += 1) {
    outliers = 0;
    entries.forEach((e, k) => {
      const z = Math.abs(e.y - predict(x, e, k)) / e.se;
      e.weight = z > 3 ? 3 / z : 1;
      if (z > 3) outliers += 1;
    });
    x = solve(common, lambda);
  }
  const c1 = fixed ?? x.slice(0, D);
  const laserCV = new Float64Array(lasers.length);
  for (let k = 0; k < L; k += 1) laserCV[k] = Math.sqrt(Math.max(0, x[(fixed ? 0 : D) + k]));
  // A detector is identified when its photon term is at least a tenth of the predicted spread in
  // two or more entries.
  const identified = new Uint8Array(D);
  if (!fixed) {
    const involved = new Int32Array(D);
    entries.forEach((e, k) => {
      const total = predict(x, e, k);
      if (!(total > 0)) return;
      for (let d = 0; d < D; d += 1) if (e.deltaF * e.photon[d] * (c1[d] || common) >= 0.1 * total) involved[d] += 1;
    });
    for (let d = 0; d < D; d += 1) identified[d] = involved[d] >= 2 ? 1 : 0;
    // Detectors the controls cannot determine (traded off against their neighbors) take the
    // common value, which matters when the model is kept and applied to another panel.
    for (let d = 0; d < D; d += 1) if (!identified[d]) c1[d] = common;
  } else identified.fill(1);
  return { c1: Float64Array.from(c1), laserCV, lasers: [...lasers], common, identified, entries: entries.length, outliers, source: fixed ? 'beads' : 'controls' };
}

// One c1 shared by every detector (with the laser CVs), by weighted least squares.
function fitShared(entries, L, D) {
  const P = 1 + L;
  const G = new Float64Array(P * P);
  const b = new Float64Array(P);
  const scale = new Float64Array(P);
  const rows = entries.map((e) => {
    const f = new Float64Array(P);
    let p = 0;
    for (let d = 0; d < D; d += 1) p += e.photon[d];
    f[0] = e.deltaF * p;
    for (let k = 0; k < L; k += 1) f[1 + k] = e.deltaF * e.deltaF * e.laser[k];
    for (let q = 0; q < P; q += 1) scale[q] = Math.max(scale[q], Math.abs(f[q]));
    return f;
  });
  for (let q = 0; q < P; q += 1) if (!(scale[q] > 0)) scale[q] = 1;
  entries.forEach((e, k) => {
    const w = 1 / (e.se * e.se);
    const f = rows[k];
    for (let p = 0; p < P; p += 1) {
      b[p] += (w * f[p] * e.y) / scale[p];
      for (let q = 0; q < P; q += 1) G[p * P + q] += (w * f[p] * f[q]) / (scale[p] * scale[q]);
    }
  });
  const x = new Float64Array(P);
  nnlsGramInPlace(G, b, P, x);
  return x[0] / scale[0];
}

// Per-detector c1 from bead runs of the instrument (instrument-record.js): the median of the
// runs' linear coefficients, for the model's detectors. Returns { c1, found (per detector) } or
// null when no detector has a run.
export function c1FromRuns(model, runs) {
  const c1 = new Float64Array(model.D).fill(Number.NaN);
  const found = new Uint8Array(model.D);
  model.detectors.forEach((detector, d) => {
    const values = (runs ?? []).map((r) => r.channels?.[detector]?.c?.[1]).filter((v) => v > 0).sort((a, b) => a - b);
    if (!values.length) return;
    c1[d] = values[Math.floor(values.length / 2)];
    found[d] = 1;
  });
  if (!found.some(Boolean)) return null;
  // Detectors without beads take the median of the others.
  const known = Array.from(c1).filter(Number.isFinite).sort((a, b) => a - b);
  const fill = known[Math.floor(known.length / 2)];
  for (let d = 0; d < model.D; d += 1) if (!found[d]) c1[d] = fill;
  return { c1, found };
}

// Leave-one-control-out check of the noise model on the controls themselves: each control's
// spread predicted from a fit to the others. Entries whose spread is clearly measured (variance
// above options.significance standard errors, default 4: smaller ones are too noisy to judge a
// prediction by) are compared: { rows: [{ i, j, observed, predicted }] (SS), measurable,
// medianRatio (geometric, as a factor ≥ 1), within2x (fraction), correlation (of log SS) }.
export function crossValidate(model, observations, options = {}) {
  const rows = [];
  for (const o of observations) {
    if (!(o.deltaF > 0)) continue;
    let noise;
    try {
      noise = fitNoise(model, observations, { ...options, exclude: o.i });
    } catch {
      continue;
    }
    for (const r of o.rows) {
      if (!(r.variance > (options.significance ?? 4) * r.se)) continue;
      const predicted = predictedVariance(model, noise, o.i, r.j, o.deltaF);
      rows.push({ i: o.i, j: r.j, observed: Math.sqrt(r.variance / o.deltaF), predicted: Math.sqrt(Math.max(predicted, 0) / o.deltaF) });
    }
  }
  return { rows, measurable: rows.length, ...agreement(rows) };
}

// Agreement of predicted and observed spread: rows [{ observed, predicted }] → { medianRatio,
// within2x, correlation (of log SS) }. A spread predicted as none counts as a miss.
export function agreement(rows) {
  if (!rows.length) return { medianRatio: Number.NaN, within2x: Number.NaN, correlation: Number.NaN };
  const tiny = 1e-3 * Math.max(...rows.map((r) => r.observed));
  const x = rows.map((r) => Math.log(Math.max(r.observed, tiny)));
  const y = rows.map((r) => Math.log(Math.max(r.predicted, tiny)));
  const abs = x.map((v, k) => Math.abs(y[k] - v) / Math.LN2).sort((a, b) => a - b);
  return {
    medianRatio: 2 ** abs[Math.floor(abs.length / 2)],
    within2x: abs.filter((v) => v <= 1).length / abs.length,
    correlation: pearson(x, y),
  };
}

function pearson(x, y) {
  const n = x.length;
  if (n < 3) return Number.NaN;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let k = 0; k < n; k += 1) {
    sxy += (x[k] - mx) * (y[k] - my);
    sxx += (x[k] - mx) ** 2;
    syy += (y[k] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : Number.NaN;
}

// A noise model as kept in a workspace or the instrument's library record (plain arrays, by
// detector and laser name): { detectors, c1, lasers, laserCV, source, entries, fitted }.
export function noiseRecord(model, noise, extra = {}) {
  return {
    detectors: [...model.detectors],
    c1: Array.from(noise.c1, (v) => +v.toPrecision(5)),
    lasers: [...model.lasers],
    laserCV: Array.from(noise.laserCV ?? [], (v) => +v.toPrecision(4)),
    source: noise.source ?? 'controls',
    entries: noise.entries ?? null,
    fitted: new Date().toISOString(),
    ...extra,
  };
}

// What the spread prediction of a panel needs, kept with the fit: the dyes (names) with their
// spectra (spillover rows for compensation) over the detectors, the data channel each dye is read
// from, and the fitted noise (spread.js noiseRecord).
export function spreadRecord({ names, detectors, spectra, channels, noise, source }) {
  return { names: [...names], detectors: [...detectors], spectra: spectra.map((row) => Array.from(row, (v) => +Number(v).toPrecision(6))), channels: [...channels], noise, source: source ?? null };
}

// A kept noise model on a model's detectors and lasers, or null when it lacks a detector.
export function noiseOn(model, record) {
  if (!record?.detectors) return null;
  const index = new Map(record.detectors.map((d, k) => [d, k]));
  if (!model.detectors.every((d) => index.has(d))) return null;
  const c1 = Float64Array.from(model.detectors, (d) => record.c1[index.get(d)]);
  const laserCV = Float64Array.from(model.lasers, (l) => {
    const k = (record.lasers ?? []).indexOf(l);
    return k >= 0 ? record.laserCV[k] ?? 0 : 0;
  });
  return { c1, laserCV, source: record.source, fitted: record.fitted };
}

// The spread each channel receives when every other dye of the panel is on the same cell at its
// brightness: √(Σ_i SS_ij² ΔF_i), in the channel's units. Low values suit dim markers.
export function spreadReceived(predicted) {
  const { n, matrix, brightness } = predicted;
  return Array.from({ length: n }, (_, j) => {
    let v = 0;
    for (let i = 0; i < n; i += 1) if (i !== j && Number.isFinite(brightness[i])) v += matrix[i * n + j] ** 2 * brightness[i];
    return Math.sqrt(v);
  });
}
