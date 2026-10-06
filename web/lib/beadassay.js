// Bead-based immunoassays (BioLegend LEGENDplex, BD CBA and the like): capture beads of one or two
// sizes (told apart by scatter), each analyte's bead at its own level of a classification dye, and
// a reporter (usually PE) whose intensity grows with the analyte's concentration.
//
// Per bead group (a scatter population), the classification levels are found once from events
// pooled across wells (log-scale histogram, its highest well-separated peaks, boundaries at the
// valleys between them, and events farther than 3 robust SDs from their level's median left out),
// then every well's beads are assigned. Each analyte's reporter MFI (median by default; geometric
// mean as beadplexr's calc_analyte_mfi) gives, on the standards, a standard curve (five-parameter
// log-logistic by default, curves.js), from which the other wells' concentrations are
// back-calculated (drc's ED(type = "absolute"), as beadplexr's calculate_concentration) and
// multiplied by their dilution.
//
// The quantifiable range runs between the lowest and highest standards whose replicates
// back-calculate within 20% of their nominal concentration with a CV of at most 20% (25% for both at
// the two ends), the acceptance limits of the FDA's bioanalytical method validation guidance for
// ligand-binding assays (2018); the limit of detection is the concentration at the blanks' mean MFI
// + 3 SD, when there are two or more blanks.

import { fitLogLogistic, inverseLogLogistic, inverseWithError } from './curves.js';
import { smoothCounts } from './fit.js';
import { parseQuantity } from './plates.js';

export const REFERENCES = {
  bmv: 'U.S. Food and Drug Administration. Bioanalytical Method Validation: Guidance for Industry. May 2018',
  beadplexr: 'Ulrik Stervbo. beadplexr: Analyse Bead Based Assays Using Flow Cytometry. R package (CRAN)',
  fivePL: 'Gottschalk PG, Dunn JR. The five-parameter logistic: a characterization and comparison with the four-parameter logistic. Anal Biochem. 2005;343(1):54–65. doi:10.1016/j.ab.2005.04.035',
};

const BINS = 256;

function quantile(sorted, q) {
  if (!sorted.length) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// The scale bead levels are found on: log10 of linear intensities, or the values as they are when
// they are already on a log-like scale (arcsinh-transformed, as beadplexr's read_fcs gives them).
function scaled(v, scale) {
  if (scale === 'linear') return Number.isFinite(v) ? v : Number.NaN;
  return v > 0 && Number.isFinite(v) ? Math.log10(v) : Number.NaN;
}

// Classification levels of one bead group from (pooled) classification values. k: the number of
// analytes (found from the peaks when null). options: scale ('log', or 'linear' for values already
// on a log-like scale), smoothing (bins), trim (robust SDs). Returns { levels: [{ center, median,
// rsd, lo, hi }] (dim to bright, on that scale), scale, histogram { lo, hi, smooth }, found } or
// throws.
export function findBeadLevels(values, k = null, options = {}) {
  const scale = options.scale ?? 'log';
  const logs = [];
  for (const v of values) {
    const l = scaled(v, scale);
    if (Number.isFinite(l)) logs.push(l);
  }
  if (logs.length < 20) throw new Error('Too few beads with a positive classification value to find the bead levels.');
  logs.sort((a, b) => a - b);
  const lo = quantile(logs, 0.001);
  const hi = quantile(logs, 0.999);
  const width = (hi - lo) / BINS || 1e-6;
  const counts = new Float64Array(BINS);
  for (const v of logs) {
    const b = Math.floor((v - lo) / width);
    if (b >= 0 && b < BINS) counts[b] += 1;
  }
  const smooth = smoothCounts(counts, options.smoothing ?? 2);
  const peaks = [];
  for (let i = 1; i < BINS - 1; i += 1) if (smooth[i] > smooth[i - 1] && smooth[i] >= smooth[i + 1]) peaks.push(i);
  const max = Math.max(...smooth);
  // Prominence: how far each peak stands above the higher of the valleys to its nearest higher
  // neighbors (or the ends).
  const prominence = (p) => {
    let left = smooth[p];
    for (let i = p - 1; i >= 0 && smooth[i] <= smooth[p]; i -= 1) left = Math.min(left, smooth[i]);
    let right = smooth[p];
    for (let i = p + 1; i < BINS && smooth[i] <= smooth[p]; i += 1) right = Math.min(right, smooth[i]);
    return smooth[p] - Math.max(left, right);
  };
  const ranked = peaks.map((p) => ({ p, prominence: prominence(p) })).sort((a, b) => b.prominence - a.prominence);
  let chosen;
  if (k) {
    if (ranked.length < k) throw new Error(`${ranked.length} bead level${ranked.length === 1 ? '' : 's'} found where ${k} analytes were expected.`);
    chosen = ranked.slice(0, k).map((r) => r.p);
  } else {
    chosen = ranked.filter((r) => r.prominence >= 0.05 * max).map((r) => r.p);
  }
  chosen.sort((a, b) => a - b);
  const cuts = [lo - 1];
  for (let j = 0; j + 1 < chosen.length; j += 1) {
    let valley = chosen[j];
    for (let i = chosen[j]; i <= chosen[j + 1]; i += 1) if (smooth[i] < smooth[valley]) valley = i;
    cuts.push(lo + (valley + 0.5) * width);
  }
  cuts.push(hi + 1);
  const levels = chosen.map((p, j) => {
    const members = logs.filter((v) => v > cuts[j] && v <= cuts[j + 1]);
    const median = quantile(members, 0.5);
    const mad = quantile(members.map((v) => Math.abs(v - median)).sort((a, b) => a - b), 0.5);
    const rsd = 1.4826 * mad;
    const trim = options.trim ?? 3;
    return { center: lo + (p + 0.5) * width, median, rsd, lo: Math.max(cuts[j], median - trim * rsd), hi: Math.min(cuts[j + 1], median + trim * rsd) };
  });
  return { levels, scale, histogram: { lo, hi, smooth }, found: ranked.filter((r) => r.prominence >= 0.05 * max).length };
}

// Each event's level (index into levels) or −1. scale as findBeadLevels'.
export function classifyBeads(values, levels, scale = 'log') {
  const out = new Int16Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i += 1) {
    const l = scaled(values[i], scale);
    if (!Number.isFinite(l)) continue;
    for (let j = 0; j < levels.length; j += 1) {
      if (l > levels[j].lo && l <= levels[j].hi) {
        out[i] = j;
        break;
      }
    }
  }
  return out;
}

export const MFI_STATISTICS = ['median', 'geometric', 'mean'];

// The reporter's MFI over a list of values.
export function mfiOf(values, statistic = 'median') {
  const v = values.filter(Number.isFinite);
  if (!v.length) return Number.NaN;
  if (statistic === 'mean') return v.reduce((s, x) => s + x, 0) / v.length;
  if (statistic === 'geometric') {
    const positive = v.filter((x) => x > 0);
    return positive.length ? Math.exp(positive.reduce((s, x) => s + Math.log(x), 0) / positive.length) : Number.NaN;
  }
  return quantile(v.sort((a, b) => a - b), 0.5);
}

// --- Standards ----------------------------------------------------------------------------------------

// How standard labels read: 'concentration' (the value is the concentration: "10000", "2500 pg/mL"),
// 'levels-top-high' (C7 … C1 with the highest number the top standard, as LEGENDplex numbers
// them; 0 or "C0" is the blank) or 'levels-top-low' (S1 the top standard). 'auto' takes levels
// when every label has a letter prefix or the labels are small consecutive whole numbers.
export function standardMode(labels) {
  const values = labels.map((l) => String(l).trim()).filter(Boolean);
  if (!values.length) return 'concentration';
  if (values.every((v) => /^[A-Za-z]+[\s_-]?\d+$/.test(v) || /^(blank|zero|bkg|background)$/i.test(v))) return 'levels-top-high';
  const numbers = values.map(Number);
  if (numbers.every((v) => Number.isInteger(v) && v >= 0 && v <= 12)) {
    const distinct = [...new Set(numbers)].sort((a, b) => a - b);
    if (distinct.every((v, i) => i === 0 || v === distinct[i - 1] + 1)) return 'levels-top-high';
  }
  return 'concentration';
}

// Concentrations of standard labels. options: mode (as above, or 'auto'), top (the top standard's
// concentration), factor (dilution between steps, 4 for LEGENDplex). Returns a Map label → value
// (0 for blanks, NaN when unreadable).
export function standardConcentrations(labels, options = {}) {
  const mode = !options.mode || options.mode === 'auto' ? standardMode(labels) : options.mode;
  const out = new Map();
  if (mode === 'concentration') {
    for (const label of labels) out.set(label, parseQuantity(label)?.value ?? Number.NaN);
    return out;
  }
  const levelOf = (label) => {
    const s = String(label).trim();
    if (/^(blank|zero|bkg|background)$/i.test(s)) return 0;
    const m = /(\d+)$/.exec(s);
    return m ? Number(m[1]) : Number.NaN;
  };
  const levels = labels.map(levelOf).filter((v) => Number.isFinite(v) && v > 0);
  const highest = Math.max(...levels);
  const lowest = Math.min(...levels);
  const top = Number(options.top);
  const factor = Number(options.factor ?? 4);
  for (const label of labels) {
    const level = levelOf(label);
    if (level === 0) out.set(label, 0);
    else if (!Number.isFinite(level) || !(top > 0) || !(factor > 0)) out.set(label, Number.NaN);
    else out.set(label, top / factor ** (mode === 'levels-top-low' ? level - lowest : highest - level));
  }
  return out;
}

// --- Standard curves and concentrations ---------------------------------------------------------------

// A standard curve from standards [{ concentration, mfi, well }] (blanks have concentration 0).
// options: model ('LL.5'), weighting ('none'), blanks ('fit': in the fit as zero doses; 'exclude').
// Returns { fit, standards (with back-calculated concentration and recovery), lloq, uloq, lod,
// blankMean, blankSD, notes } or { fit: null, error }.
export function standardCurve(standards, options = {}) {
  const notes = [];
  const usable = standards.filter((s) => Number.isFinite(s.concentration) && Number.isFinite(s.mfi));
  const blanks = usable.filter((s) => s.concentration === 0);
  const points = usable.filter((s) => s.concentration > 0 || options.blanks !== 'exclude');
  let fit;
  try {
    fit = fitLogLogistic(points.map((s) => s.concentration), points.map((s) => s.mfi), { model: options.model ?? 'LL.5', weighting: options.weighting ?? 'none' });
  } catch (error) {
    return { fit: null, error: error.message, standards: usable, notes };
  }
  if (!fit.rising) notes.push('The standard curve falls as the concentration rises: check the standards\' labels and concentrations.');
  const out = usable.map((s) => {
    const back = s.concentration > 0 ? inverseLogLogistic(s.mfi, fit.parameters) : Number.NaN;
    return { ...s, back, recovery: s.concentration > 0 && Number.isFinite(back) ? (100 * back) / s.concentration : Number.NaN };
  });
  // The quantifiable range: the longest run of standards (by concentration) whose replicates
  // back-calculate on average within 20% of the nominal concentration with a CV of at most 20%
  // (25% for both at the run's two ends).
  const levels = [...new Set(out.filter((s) => s.concentration > 0).map((s) => s.concentration))].sort((a, b) => a - b);
  const levelStats = levels.map((c) => {
    const backs = out.filter((s) => s.concentration === c).map((s) => s.back);
    const finite = backs.filter(Number.isFinite);
    if (finite.length < backs.length || !finite.length) return { concentration: c, recovery: Number.NaN, cv: Number.NaN, n: backs.length };
    const mean = finite.reduce((sum, v) => sum + v, 0) / finite.length;
    const sd = finite.length > 1 ? Math.sqrt(finite.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (finite.length - 1)) : 0;
    return { concentration: c, recovery: (100 * mean) / c, cv: (100 * sd) / mean, n: finite.length };
  });
  const recoveryAt = levelStats.map((l) => l.recovery);
  const within = (l, end) => Number.isFinite(l.recovery) && Math.abs(l.recovery - 100) <= (end ? 25 : 20) && l.cv <= (end ? 25 : 20);
  let best = null;
  for (let i = 0; i < levels.length; i += 1) {
    for (let j = levels.length - 1; j >= i; j -= 1) {
      let ok = within(levelStats[i], true) && within(levelStats[j], true);
      for (let m = i + 1; ok && m < j; m += 1) ok = within(levelStats[m], false);
      if (ok && (!best || j - i > best[1] - best[0])) best = [i, j];
    }
  }
  const lloq = best ? levels[best[0]] : null;
  const uloq = best ? levels[best[1]] : null;
  if (!best) notes.push('No standard back-calculates within 25% of its concentration with a CV under 25%: the curve does not describe the standards.');
  let lod = null;
  let blankMean = null;
  let blankSD = null;
  if (blanks.length >= 2) {
    blankMean = blanks.reduce((s, b) => s + b.mfi, 0) / blanks.length;
    blankSD = Math.sqrt(blanks.reduce((s, b) => s + (b.mfi - blankMean) ** 2, 0) / (blanks.length - 1));
    const at = inverseLogLogistic(blankMean + 3 * blankSD, fit.parameters);
    lod = Number.isFinite(at) ? at : null;
  }
  return { fit, standards: out, levels: levelStats, recoveryAt, lloq, uloq, lod, blankMean, blankSD, notes };
}

// A well's concentration from its MFI: { value (× dilution, null when it cannot be read off the
// curve), raw (before dilution), se, flag: 'ok' | '< LLOQ' | '> ULOQ' | '< LOD' | 'below curve' |
// 'above curve' }. Values outside the quantifiable range are still given, flagged.
export function concentrationOf(curve, mfi, dilution = 1) {
  if (!curve?.fit || !Number.isFinite(mfi)) return { value: null, raw: null, se: null, flag: 'no curve' };
  const p = curve.fit.parameters;
  // The asymptote at zero concentration.
  const low = curve.fit.rising ? Math.min(p.c, p.d) : Math.max(p.c, p.d);
  const { dose, se } = inverseWithError(curve.fit, mfi);
  if (!Number.isFinite(dose)) {
    const below = curve.fit.rising ? mfi <= low : mfi >= low;
    return { value: null, raw: null, se: null, flag: below ? 'below curve' : 'above curve' };
  }
  let flag = 'ok';
  if (curve.lod !== null && dose < curve.lod) flag = '< LOD';
  else if (curve.lloq !== null && dose < curve.lloq) flag = '< LLOQ';
  else if (curve.uloq !== null && dose > curve.uloq) flag = '> ULOQ';
  return { value: dose * dilution, raw: dose, se: se * dilution, flag };
}

// --- The whole assay -------------------------------------------------------------------------------

// wells: [{ id, name, meta, groups: [{ classification: Float32Array, reporter: Float32Array }] }]
// (the events of each bead group's population). spec: { groups: [{ name, analytes: [names] }]
// (dim to bright), statistic, standardField, standardMode, top (number, or { analyte: number }),
// factor, unit, dilutionField, sampleField, model, weighting, blanks, minBeads (default 50) }.
// Returns { groups (levels per group), analytes [{ name, group, level, curve }], wells [{ id, name,
// kind: 'standard' | 'blank' | 'sample', standard, dilution, sample, results: { analyte: { beads,
// mfi, concentration } } }], samples [{ name, wells, results: { analyte: { mean, cv, n, flags } } }],
// notes }.
export function beadAssay(wells, spec) {
  const notes = [];
  const statistic = spec.statistic ?? 'median';
  const minBeads = spec.minBeads ?? 50;
  const field = spec.standardField ?? 'standard';
  // Bead levels per group from events pooled across the wells (at most 2000 per well).
  const groups = spec.groups.map((group, g) => {
    const pooled = [];
    for (const well of wells) {
      const values = well.groups[g]?.classification;
      if (!values) continue;
      const step = Math.max(1, Math.floor(values.length / 2000));
      for (let i = 0; i < values.length; i += step) pooled.push(values[i]);
    }
    const found = findBeadLevels(pooled, group.analytes.length, { scale: spec.scale ?? 'log' });
    return { name: group.name, analytes: group.analytes, ...found };
  });
  const analytes = groups.flatMap((g, gi) => g.analytes.map((name, level) => ({ name, group: g.name, groupIndex: gi, level, center: g.scale === 'linear' ? g.levels[level].median : 10 ** g.levels[level].median })));
  const labels = wells.map((w) => w.meta?.[field]).filter((v) => v !== undefined && v !== null && String(v).trim() !== '');
  const concentrationOfLabel = (analyte) => standardConcentrations([...new Set(labels)], { mode: spec.standardMode ?? 'auto', top: typeof spec.top === 'object' && spec.top ? spec.top[analyte] : spec.top, factor: spec.factor ?? 4 });
  const perAnalyteConcentrations = new Map(analytes.map((a) => [a.name, concentrationOfLabel(a.name)]));
  // Every well's beads and MFIs.
  const wellRows = wells.map((well) => {
    const label = well.meta?.[field];
    const isStandard = label !== undefined && label !== null && String(label).trim() !== '';
    const results = {};
    for (const a of analytes) {
      const group = groups[a.groupIndex];
      const ev = well.groups[a.groupIndex];
      if (!ev) {
        results[a.name] = { beads: 0, mfi: Number.NaN };
        continue;
      }
      const labelsOfEvents = classifyBeads(ev.classification, group.levels, group.scale);
      const values = [];
      for (let i = 0; i < labelsOfEvents.length; i += 1) if (labelsOfEvents[i] === a.level) values.push(ev.reporter[i]);
      results[a.name] = { beads: values.length, mfi: values.length ? mfiOf(values, statistic) : Number.NaN };
    }
    const dilutionText = spec.dilutionField ? well.meta?.[spec.dilutionField] : null;
    const dilution = dilutionText !== null && dilutionText !== undefined && String(dilutionText).trim() !== '' ? parseQuantity(dilutionText)?.value ?? 1 : 1;
    const concentration = isStandard ? perAnalyteConcentrations.get(analytes[0]?.name)?.get(label) : null;
    return {
      id: well.id,
      name: well.name,
      kind: isStandard ? (concentration === 0 ? 'blank' : 'standard') : 'sample',
      standard: isStandard ? String(label) : null,
      dilution,
      sample: spec.sampleField ? well.meta?.[spec.sampleField] ?? well.name : well.name,
      results,
    };
  });
  // Curves and concentrations.
  for (const a of analytes) {
    const concentrations = perAnalyteConcentrations.get(a.name);
    const standards = wellRows.filter((w) => w.kind !== 'sample' && w.results[a.name].beads >= minBeads).map((w) => ({ well: w.name, concentration: concentrations.get(w.standard), mfi: w.results[a.name].mfi }));
    a.curve = standardCurve(standards, { model: spec.model ?? 'LL.5', weighting: spec.weighting ?? 'none', blanks: spec.blanks ?? 'fit' });
    if (!a.curve.fit) notes.push(`${a.name}: no standard curve (${a.curve.error}).`);
    for (const w of wellRows) {
      const r = w.results[a.name];
      if (w.kind !== 'sample') {
        r.concentration = { value: concentrations.get(w.standard) ?? null, nominal: true };
        continue;
      }
      r.concentration = r.beads >= minBeads ? concentrationOf(a.curve, r.mfi, w.dilution) : { value: null, raw: null, se: null, flag: `< ${minBeads} beads` };
    }
  }
  // Replicate wells of each sample.
  const bySample = new Map();
  for (const w of wellRows.filter((row) => row.kind === 'sample')) {
    if (!bySample.has(w.sample)) bySample.set(w.sample, []);
    bySample.get(w.sample).push(w);
  }
  const samples = [...bySample].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true })).map(([name, rows]) => ({
    name,
    wells: rows.map((r) => r.name),
    results: Object.fromEntries(analytes.map((a) => {
      const values = rows.map((r) => r.results[a.name].concentration?.value).filter(Number.isFinite);
      const mean = values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
      const sd = values.length > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)) : null;
      const flags = [...new Set(rows.map((r) => r.results[a.name].concentration?.flag).filter((f) => f && f !== 'ok'))];
      return [a.name, { mean, cv: mean && sd !== null ? (100 * sd) / mean : null, n: values.length, flags }];
    })),
  }));
  return { groups, analytes, wells: wellRows, samples, notes, unit: spec.unit ?? '' };
}
