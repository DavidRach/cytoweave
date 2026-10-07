// Example experiments: a catalog of simulated datasets for onboarding, tutorials, demos,
// screenshots and validation. Real public datasets carry licensing restrictions, so CytoWeave
// generates its examples in the browser with web/lib/simulate.js and writes them as genuine
// FCS 3.1 files, which then take exactly the import path of real data.
//
// Every file is deterministic for (seed, example, file name) and carries ground truth (event
// labels and, where relevant, abundances, phases or sort wells) beside the bytes, never inside
// the FCS file.

import { compensate } from './compensation.js';
import { combinationKey } from './debarcode.js';
import { parseFCS } from './fcs.js';
import { pointTest } from './gates.js';
import { createTransform } from './transforms.js';
import {
  FLUOROCHROMES,
  INSTRUMENTS,
  acquisitionKeywords,
  buildPanel,
  getDetector,
  compilePopulations,
  createNormal,
  createRandom,
  deriveSeed,
  encodeFCS,
  rangeFor,
  beadDetectorTruth,
  simulateBeadRun,
  simulateCellCycle,
  simulateEvents,
  degradeTandem,
  shiftedFluorochrome,
  simulateMassEvents,
  spectralSignature,
} from './simulate.js';

export const DEFAULT_SEED = 20260312;

// --- PBMC biology -------------------------------------------------------------------------------
//
// Marker levels are antibody binding capacities (molecules per cell, log-normal medians with a
// natural-log SD), approximating published quantitative flow data; a panel turns them into signal
// with each fluorochrome's brightness. Scatter is in BD units (FSC/SSC area).

const LYMPH = { fsc: [60000, 0.1], ssc: [14000, 0.2], af: 1 };
const MONO = { fsc: [105000, 0.12], ssc: [45000, 0.25], afType: 'M', af: 3 };
const T_BASE = { CD45: [2.2e5, 0.22], CD3: [8e4, 0.22], CD28: [1.8e4, 0.35], CD127: [1.2e4, 0.4], CD27: [1.8e4, 0.35], CD95: [800, 0.6], CD38: [3e3, 0.5], CD45RO: [1e3, 0.6] };

function population(name, base, markers, extra = {}) {
  return { name, ...base, ...extra, markers };
}

export const PBMC_POPULATIONS = [
  population('CD4 naive T', LYMPH, { ...T_BASE, CD4: [4e4, 0.2], CD45RA: [6e4, 0.3], CCR7: [8e3, 0.4], CD27: [2e4, 0.3], CD28: [2e4, 0.3], CD127: [1.5e4, 0.35], CD38: [4e3, 0.5], CD25: [500, 0.6] }, { corr: [['CD45RA', 'CCR7', 0.35]] }),
  population('CD4 central memory T', LYMPH, { ...T_BASE, CD4: [4e4, 0.2], CD45RA: [2e3, 0.6], CD45RO: [3e4, 0.3], CCR7: [5e3, 0.45], CD27: [1.5e4, 0.35], CD28: [2.5e4, 0.3], CD95: [1e4, 0.4], CD25: [1.5e3, 0.5], 'PD-1': [1.5e3, 0.7], CD161: [800, 1.0], CD38: [1.5e3, 0.6] }),
  population('CD4 effector memory T', LYMPH, { ...T_BASE, CD4: [3.8e4, 0.22], CD45RA: [1.5e3, 0.6], CD45RO: [3.5e4, 0.3], CCR7: [300, 0.7], CD27: [5e3, 0.9], CD28: [2e4, 0.4], CD95: [1.5e4, 0.35], CD127: [9e3, 0.4], 'PD-1': [4e3, 0.6], CD161: [2e3, 1.1], 'HLA-DR': [800, 1.0], CD57: [300, 1.2], CD25: [1e3, 0.6], CD38: [1.2e3, 0.7] }, { ssc: [15000, 0.2] }),
  population('CD4 TEMRA', LYMPH, { ...T_BASE, CD4: [3.5e4, 0.22], CD45RA: [3e4, 0.4], CD45RO: [2e3, 0.6], CCR7: [200, 0.7], CD27: [800, 0.8], CD28: [2e3, 1.0], CD57: [8e3, 0.8], CD95: [1.2e4, 0.4], CD127: [3e3, 0.6], 'PD-1': [1.5e3, 0.7] }),
  population('Regulatory T', LYMPH, { ...T_BASE, CD4: [3.5e4, 0.2], CD25: [8e3, 0.45], CD127: [1.2e3, 0.5], CD45RA: [3e3, 1.4], CD45RO: [2.5e4, 0.4], CCR7: [3e3, 0.6], CD95: [9e3, 0.4], CD27: [1.5e4, 0.35], CD28: [2.5e4, 0.3], 'PD-1': [2e3, 0.7], 'HLA-DR': [800, 1.1], CD38: [2e3, 0.7] }, { corr: [['CD25', 'CD127', -0.3]] }),
  population('CD8 naive T', LYMPH, { ...T_BASE, CD8: [1.2e5, 0.22], CD45RA: [7e4, 0.3], CD45RO: [800, 0.6], CCR7: [7e3, 0.4], CD27: [2.2e4, 0.3], CD28: [1.8e4, 0.3], CD127: [1.2e4, 0.35], CD95: [600, 0.6], CD38: [3e3, 0.5] }, { corr: [['CD45RA', 'CCR7', 0.35]] }),
  population('CD8 central memory T', LYMPH, { ...T_BASE, CD8: [1.1e5, 0.25], CD45RA: [3e3, 0.7], CD45RO: [2.5e4, 0.35], CCR7: [4e3, 0.5], CD27: [1.5e4, 0.35], CD28: [1.5e4, 0.4], CD95: [1.2e4, 0.4], CD127: [1e4, 0.4], CD161: [1e3, 1.2] }),
  population('CD8 effector memory T', LYMPH, { ...T_BASE, CD8: [1e5, 0.3], CD45RA: [3e3, 0.8], CD45RO: [3e4, 0.35], CCR7: [250, 0.7], CD27: [5e3, 1.0], CD28: [5e3, 1.1], CD95: [1.5e4, 0.35], CD127: [6e3, 0.6], 'PD-1': [5e3, 0.7], CD161: [2e3, 1.4], 'HLA-DR': [1.5e3, 1.0], CD57: [1e3, 1.4], CD38: [1.5e3, 0.8] }, { ssc: [16000, 0.2], corr: [['CD27', 'CD28', 0.5]] }),
  population('CD8 TEMRA', LYMPH, { ...T_BASE, CD8: [1e5, 0.3], CD45RA: [5e4, 0.35], CD45RO: [1.5e3, 0.6], CCR7: [150, 0.7], CD27: [600, 0.8], CD28: [600, 0.9], CD57: [2e4, 0.6], CD95: [1.2e4, 0.4], CD16: [800, 1.2], CD127: [2e3, 0.7], 'PD-1': [1e3, 0.8], CD11b: [3e3, 1.0], CD56: [1e3, 1.2] }, { ssc: [17000, 0.2] }),
  population('Gamma-delta T', LYMPH, { ...T_BASE, CD3: [1.2e5, 0.25], TCRgd: [3e4, 0.35], CD8: [3e3, 1.3], CD161: [4e3, 0.8], CD45RA: [2e4, 1.0], CD45RO: [8e3, 1.0], CD27: [3e3, 1.1], CD28: [3e3, 1.0], CD95: [1e4, 0.5], CD16: [1e3, 1.2], CD56: [2e3, 1.2], CD127: [5e3, 0.6] }),
  population('Naive B', { fsc: [57000, 0.1], ssc: [12000, 0.2], af: 1.1 }, { CD45: [1.6e5, 0.25], CD19: [2e4, 0.3], CD20: [8e4, 0.3], 'HLA-DR': [1.2e5, 0.35], CD45RA: [8e4, 0.3], CCR7: [9e3, 0.4], IgD: [2e4, 0.45], CD38: [5e3, 0.5], CD25: [400, 0.8], CD11c: [200, 0.8] }, { corr: [['CD19', 'CD20', 0.6]] }),
  population('Memory B', { fsc: [59000, 0.1], ssc: [13000, 0.2], af: 1.1 }, { CD45: [1.6e5, 0.25], CD19: [2.2e4, 0.3], CD20: [9e4, 0.3], 'HLA-DR': [1.3e5, 0.35], CD45RA: [4e4, 0.4], CCR7: [6e3, 0.5], IgD: [1e3, 1.2], CD27: [1.2e4, 0.4], CD95: [4e3, 0.6], CD38: [1.5e3, 0.7], CD11c: [800, 1.2], CD25: [800, 0.8] }, { corr: [['CD19', 'CD20', 0.6]] }),
  population('Plasmablasts', { fsc: [80000, 0.12], ssc: [22000, 0.2], af: 1.5 }, { CD45: [1.2e5, 0.3], CD19: [8e3, 0.4], CD20: [1.5e3, 0.8], 'HLA-DR': [3e4, 0.5], CD27: [6e4, 0.4], CD38: [1.5e5, 0.3], CD45RA: [2e3, 0.8], CCR7: [1e3, 0.8], CD95: [8e3, 0.5] }),
  population('CD56bright NK', { fsc: [62000, 0.1], ssc: [18000, 0.2], af: 1.15 }, { CD45: [2.5e5, 0.22], CD56: [4e4, 0.3], CD16: [1e3, 0.8], CD45RA: [4e4, 0.4], CD127: [2e3, 0.6], CD161: [8e3, 0.5], CD11b: [3e3, 0.6], CD38: [1e4, 0.4], 'HLA-DR': [600, 1.0], CD25: [1.5e3, 0.6], CD11c: [1e3, 0.8], CD27: [3e3, 0.8] }),
  population('CD56dim NK', { fsc: [62000, 0.1], ssc: [21000, 0.22], af: 1.15 }, { CD45: [2.4e5, 0.22], CD56: [7e3, 0.4], CD16: [6e4, 0.45], CD57: [4e3, 1.4], CD45RA: [5e4, 0.35], CD8: [2e3, 1.5], CD161: [4e3, 0.8], CD11b: [1.5e4, 0.5], CD38: [1.5e4, 0.4], CD11c: [2e3, 1.0], CD95: [2e3, 0.7] }, { corr: [['CD16', 'CD57', 0.3]] }),
  population('Other lymphoid', LYMPH, { CD45: [1.8e5, 0.25], CD127: [6e3, 0.7], CD161: [5e3, 1.0], CD45RA: [1e4, 1.0], 'HLA-DR': [1e3, 1.2], CD38: [3e3, 0.8] }),
  population('Basophils', { fsc: [65000, 0.1], ssc: [18000, 0.2], af: 1.3 }, { CD45: [6e4, 0.3], CD123: [4e4, 0.35], CD294: [1.5e4, 0.45], CD38: [2e4, 0.4], CD11b: [6e3, 0.6], CD25: [1e3, 0.6], CD45RA: [3e3, 0.7], CD11c: [1.5e3, 0.7] }),
  population('Plasmacytoid DC', { fsc: [72000, 0.1], ssc: [20000, 0.2], af: 1.4 }, { CD45: [1.2e5, 0.25], CD123: [6e4, 0.3], 'HLA-DR': [5e4, 0.4], CD45RA: [3e4, 0.4], CD4: [1.2e4, 0.3], CD11c: [300, 0.8], CD38: [8e3, 0.5], CD27: [1e3, 0.9] }),
  population('Myeloid DC', { fsc: [90000, 0.12], ssc: [35000, 0.25], afType: 'M', af: 2.5 }, { CD45: [1.4e5, 0.25], CD11c: [4e4, 0.35], 'HLA-DR': [1e5, 0.4], CD4: [6e3, 0.4], CD14: [1e3, 1.0], CD11b: [5e3, 0.7], CD123: [1.5e3, 0.8], CD38: [5e3, 0.6] }),
  population('Classical monocytes', MONO, { CD45: [1.3e5, 0.25], CD14: [1.1e5, 0.3], CD16: [600, 0.6], 'HLA-DR': [4e4, 0.5], CD11c: [3e4, 0.35], CD11b: [6e4, 0.35], CD4: [7e3, 0.35], CD38: [1.2e4, 0.4], CD45RA: [1.5e3, 1.0], CD45RO: [1.5e4, 0.4], CD123: [2e3, 0.6], CD95: [3e3, 0.6] }),
  population('Intermediate monocytes', MONO, { CD45: [1.4e5, 0.25], CD14: [6e4, 0.3], CD16: [1e4, 0.45], 'HLA-DR': [8e4, 0.4], CD11c: [3.5e4, 0.35], CD11b: [4e4, 0.4], CD4: [6e3, 0.4], CD38: [8e3, 0.5], CD45RO: [1.5e4, 0.4], CD95: [3e3, 0.6] }),
  population('Non-classical monocytes', { ...MONO, fsc: [100000, 0.12], ssc: [38000, 0.25], af: 2.6 }, { CD45: [1.6e5, 0.25], CD14: [3e3, 0.6], CD16: [4e4, 0.4], 'HLA-DR': [5e4, 0.45], CD11c: [4e4, 0.35], CD11b: [1.5e4, 0.5], CD4: [5e3, 0.4], CD45RA: [3e3, 1.0], CD45RO: [1e4, 0.5], CD38: [2e3, 0.8] }),
  population('Neutrophils', { fsc: [100000, 0.12], ssc: [130000, 0.18], afType: 'M', af: 5 }, { CD45: [6e4, 0.3], CD66b: [5e4, 0.35], CD16: [1e5, 0.5], CD11b: [8e4, 0.4], CD14: [2e3, 0.6], CD11c: [6e3, 0.6], CD45RO: [8e3, 0.6], CD294: [500, 1.0] }),
];

// Composition of live single PBMC: [name, relative weight, children]. Leaves are populations.
// Lymphocytes ≈ 72 % of live singlets (≈ 64 % of all singlets once dead cells and debris are
// counted), monocytes 20 %, T ≈ 66 % of lymphocytes with CD4:CD8 ≈ 2:1, B ≈ 12 %, NK ≈ 13 %,
// Treg 7 % of CD4 T cells.
export const PBMC_TREE = ['Live singlets', 1, [
  ['Lymphocyte gate', 0.75, [
    ['T cells', 0.64, [
      ['CD4 T', 0.64, [['CD4 naive T', 0.46], ['CD4 central memory T', 0.26], ['CD4 effector memory T', 0.19], ['CD4 TEMRA', 0.02], ['Regulatory T', 0.07]]],
      ['CD8 T', 0.31, [['CD8 naive T', 0.4], ['CD8 central memory T', 0.1], ['CD8 effector memory T', 0.25], ['CD8 TEMRA', 0.25]]],
      ['Gamma-delta T', 0.05],
    ]],
    ['B cells', 0.12, [['Naive B', 0.62], ['Memory B', 0.33], ['Plasmablasts', 0.05]]],
    ['NK cells', 0.13, [['CD56bright NK', 0.1], ['CD56dim NK', 0.9]]],
    ['Other lymphoid', 0.08],
    ['Basophils', 0.02],
    ['Plasmacytoid DC', 0.01],
  ]],
  ['Monocytes', 0.2, [['Classical monocytes', 0.85], ['Intermediate monocytes', 0.05], ['Non-classical monocytes', 0.1]]],
  ['Myeloid DC', 0.01],
  ['Neutrophils', 0.04],
]];

// Groups of leaves, for truth summaries.
export const PBMC_GROUPS = {
  'T cells': ['CD4 naive T', 'CD4 central memory T', 'CD4 effector memory T', 'CD4 TEMRA', 'Regulatory T', 'CD8 naive T', 'CD8 central memory T', 'CD8 effector memory T', 'CD8 TEMRA', 'Gamma-delta T'],
  'CD4 T': ['CD4 naive T', 'CD4 central memory T', 'CD4 effector memory T', 'CD4 TEMRA', 'Regulatory T'],
  'CD8 T': ['CD8 naive T', 'CD8 central memory T', 'CD8 effector memory T', 'CD8 TEMRA'],
  'B cells': ['Naive B', 'Memory B', 'Plasmablasts'],
  'NK cells': ['CD56bright NK', 'CD56dim NK'],
  Lymphocytes: ['CD4 naive T', 'CD4 central memory T', 'CD4 effector memory T', 'CD4 TEMRA', 'Regulatory T', 'CD8 naive T', 'CD8 central memory T', 'CD8 effector memory T', 'CD8 TEMRA', 'Gamma-delta T', 'Naive B', 'Memory B', 'Plasmablasts', 'CD56bright NK', 'CD56dim NK', 'Other lymphoid'],
  Monocytes: ['Classical monocytes', 'Intermediate monocytes', 'Non-classical monocytes'],
};

// Leaf weights of a composition tree. With `random`, each node varies log-normally (between-donor
// variation, wider for small subsets) before its siblings are renormalized; `factors` multiply
// named nodes afterwards (differential abundance).
export function treeWeights(tree, random = null, factors = {}) {
  const out = new Map();
  const walk = (node, weight, depth) => {
    const [name, , children] = node;
    const w = weight * (factors[name] ?? 1);
    if (!children) {
      out.set(name, w);
      return;
    }
    const sd = depth === 0 ? 0.1 : depth === 1 ? 0.15 : 0.22;
    let total = 0;
    let varied = 0;
    const local = children.map((child) => {
      const v = child[1] * (random ? Math.exp(sd * random.gaussian()) : 1);
      total += child[1];
      varied += v;
      return v;
    });
    children.forEach((child, i) => walk(child, (w * local[i] * total) / varied, depth + 1));
  };
  walk(tree, 1, 0);
  return out;
}

function pairOf(value, sd = 0.3) {
  return Array.isArray(value) ? [value[0], value[1] ?? sd] : [value, sd];
}

// Anti-CD3/CD28-like activation: CD25, HLA-DR, CD38 and PD-1 up, CD127 down, CD45RA and CCR7
// lost, TCR/CD3 internalized, cells enlarge (blasts).
function activate(spec) {
  const m = { ...spec.markers };
  const scale = (key, factor, min = 0, sd = null) => {
    const [v, s] = pairOf(m[key] ?? [150, 0.6]);
    m[key] = [Math.max(min, v * factor), sd ?? s];
  };
  scale('CD25', 8, 4e3, 0.55);
  m['HLA-DR'] = [6e3, 0.6];
  scale('CD127', 0.5);
  scale('CD45RA', 0.6);
  scale('CCR7', 0.6);
  scale('CD38', 3);
  scale('PD-1', 3, 3e3);
  scale('CD3', 0.8);
  return { ...spec, state: 1, fsc: [spec.fsc[0] * 1.15, spec.fsc[1]], ssc: [spec.ssc[0] * 1.1, spec.ssc[1]], markers: m };
}

const ACTIVATED_FRACTION = {
  'CD4 naive T': 0.25, 'CD4 central memory T': 0.45, 'CD4 effector memory T': 0.5, 'CD4 TEMRA': 0.2, 'Regulatory T': 0.5,
  'CD8 naive T': 0.2, 'CD8 central memory T': 0.4, 'CD8 effector memory T': 0.45, 'CD8 TEMRA': 0.2, 'Gamma-delta T': 0.3,
};

// PBMC population specs and weights for a donor, optionally stimulated.
function pbmcComposition(ctx, subject, options = {}) {
  const random = subject ? ctx.random('subject', subject) : null;
  const leaf = treeWeights(PBMC_TREE, random, options.factors ?? {});
  const specs = [];
  const weights = [];
  for (const spec of options.populations ?? PBMC_POPULATIONS) {
    let w = leaf.get(spec.name) ?? 0;
    if (options.boost?.[spec.name]) w *= options.boost[spec.name];
    const f = options.stimulated ? ACTIVATED_FRACTION[spec.name] ?? 0 : 0;
    if (f > 0) {
      specs.push(spec, activate(spec));
      weights.push(w * (1 - f), w * f);
    } else {
      specs.push(spec);
      weights.push(w);
    }
  }
  return { specs, weights: Float64Array.from(weights), leaf };
}

// Small donor-to-donor differences in staining intensity.
function donorMarkerFactors(ctx, subject, markers, sd = 0.06) {
  const random = ctx.random('expression', subject);
  const out = {};
  for (const marker of markers) out[marker] = Math.exp(sd * random.gaussian());
  return out;
}

// --- Transforms and gates -----------------------------------------------------------------------

const linear = (max) => ({ type: 'linear', min: 0, max });
const LINEAR_BD = linear(262144);
const LOGICLE_BD = { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 };
const LOGICLE_AURORA = { type: 'logicle', T: 4194304, W: 0.75, M: 5.6, A: 0 };
const ARCSINH_MASS = { type: 'arcsinh', cofactor: 5, max: 10000, min: -5 * Math.sinh(1) };

function channelTransforms(channels, fluorescence, scatterMax, timeMax) {
  const out = {};
  for (const c of channels) {
    if (c.name === 'Time') out[c.name] = linear(timeMax);
    else if (/^(FSC|SSC)/.test(c.name)) out[c.name] = linear(scatterMax);
    else out[c.name] = fluorescence(c);
  }
  return out;
}

function gate(id, name, parentId, dims, type, geometry, color, note) {
  return { id, name, parentId, type, dims, geometry, linkId: null, scope: null, overrides: {}, color, meta: { origin: 'auto', method: 'simulator', note } };
}

// A polygon gate given in data units, stored in the dims' scale space.
function polygonGate(id, name, parentId, [cx, tx], [cy, ty], vertices, color, note) {
  const fx = createTransform(tx).forward;
  const fy = createTransform(ty).forward;
  return gate(id, name, parentId, [{ channel: cx, transform: tx }, { channel: cy, transform: ty }], 'polygon', { vertices: vertices.map(([x, y]) => [round6(fx(x)), round6(fy(y))]) }, color, note);
}

function rangeGate(id, name, parentId, [channel, transform], min, max, color, note) {
  const f = createTransform(transform).forward;
  return gate(id, name, parentId, [{ channel, transform }], 'range', { min: min === null ? null : round6(f(min)), max: max === null ? null : round6(f(max)) }, color, note);
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

// --- Context and file assembly ------------------------------------------------------------------

function createContext(entry, options) {
  const seed = (options.seed ?? DEFAULT_SEED) >>> 0;
  const scale = options.scale ?? 1;
  if (!(scale > 0)) throw new Error('The example size (options.scale) must be a positive number.');
  return {
    id: entry.id,
    title: entry.title,
    seed,
    scale,
    signal: options.signal,
    truth: options.truth !== false,
    only: options.samples ? new Set(options.samples) : null,
    // { fluorochrome → fraction }: tandems degraded in this experiment (spectral example), in
    // every file or only in the controls or the samples.
    degrade: options.tandemDegradation ?? null,
    degradeIn: options.degradationIn ?? 'all',
    // Faults of the reference controls (spectral example): { fluorochrome → the dye its control
    // was stained with instead }, { fluorochrome → nm its emission is shifted on beads }, and
    // an unstained control of lymphocytes only ('lymphocytes').
    substitutes: options.controlSubstitutes ?? null,
    beadShift: options.beadShift ?? null,
    unstainedCells: options.unstainedCells ?? null,
    // Detector gains that differ between the PBMC samples, as day-to-day instrument drift
    // (PBMC example): log-uniform within ±strength per fluorescence detector, a quarter of that
    // for scatter; the first sample is left as it is.
    shift: options.instrumentShift ?? null,
    // Laser intensity CV from event to event (a number or { laser: cv }; spectral example).
    laserCV: options.laserCV ?? null,
    // The files with a clog (PBMC example; default: D05_Unstim only).
    clogs: options.clogs ?? null,
    // FMO controls (PBMC and spectral examples): markers, each giving FMO_<marker>.fcs, the first
    // donor's cells stained with every dye of the panel but that marker's.
    fmos: options.fmos ?? null,
    random: (...parts) => createRandom(deriveSeed(seed, entry.id, ...parts)),
    // Acquisition start times follow the file's place in the full design, so a file generated
    // on its own is byte-identical to the same file generated with the whole example.
    slot: 300,
    schedule(rate, all) {
      const most = all.reduce((m, s) => Math.max(m, s.events), 0);
      this.slot = 120 + Math.ceil((1.3 * most) / rate);
    },
    startOf(sample) {
      return 9 * 3600 + 30 * 60 + (sample.index ?? 0) * this.slot;
    },
    onProgress: options.onProgress,
    check() {
      if (options.signal?.aborted) throw new Error('Simulation was canceled.');
    },
  };
}

function eventsFor(base, scale, minimum = 200) {
  return Math.max(minimum, Math.round(base * scale));
}

function sampleMeta(sample) {
  const meta = {};
  for (const key of ['condition', 'subject', 'batch', 'role', 'stain', 'marker', 'carrier', 'timepoint', 'well', 'anomaly']) {
    if (sample[key] !== undefined && sample[key] !== null) meta[key] = sample[key];
  }
  // Plate layouts: what each well holds (compound, dose, control, standard, …).
  if (sample.annotations) Object.assign(meta, sample.annotations);
  return meta;
}

// Builds the FCS file for a simulated flow sample.
function flowFile(ctx, sample, sim, setup) {
  const { instrument, panel, date } = setup;
  const labelOf = new Map((setup.assignments ?? []).filter((a) => a.detector).map((a) => [a.detector, a.label ?? a.marker]));
  const parameters = sim.order.map((name) => {
    const column = sim.columns[name];
    if (name === 'Time') return { name, label: '', range: Math.max(instrument.range, rangeFor(column)) };
    const detector = panel ? panel.detectors.find((d) => d.name === name) : null;
    if (detector) return { name, label: labelOf.get(name) ?? setup.labels?.[name] ?? '', range: instrument.range, voltage: detector.voltage };
    const sc = instrument.scatter.find((s) => name === `${s.base}-A` || name === `${s.base}-H` || name === `${s.base}-W`);
    if (sc) return { name, label: '', range: instrument.range, voltage: sc.voltage };
    return { name, label: setup.labels?.[name] ?? '', range: setup.ranges?.[name] ?? instrument.range };
  });
  const keywords = acquisitionKeywords({
    instrument,
    date,
    start: ctx.startOf(sample),
    duration: sim.duration,
    fileName: sample.name,
    tube: sample.tube ?? sample.name.replace(/\.fcs$/i, ''),
    experiment: ctx.title,
    source: sample.source ?? (sample.subject ? `${sample.subject}` : ''),
    spill: setup.spill ?? null,
    seed: ctx.seed,
    example: ctx.id,
    extra: setup.keywords,
  });
  const bytes = encodeFCS(parameters, sim.order.map((name) => sim.columns[name]), keywords);
  const meta = { ...sampleMeta(sample), eventCount: sim.order.length ? sim.columns[sim.order[0]].length : 0, channels: parameters.map((p) => p.name) };
  if (ctx.truth) meta.truth = { labels: sim.labels, names: sim.labelNames, ...(setup.truth ?? {}) };
  return { name: sample.name, bytes, meta };
}

function windowsTruth(sim, instrument) {
  return sim.windows.map((w) => ({ kind: w.kind, start: w.start, end: w.end, startTime: w.start / instrument.timestep, endTime: w.end / instrument.timestep }));
}

const CLOG = [
  { kind: 'clog', at: 0.42, length: 0.12, rate: 0.12, signal: 0.62, scatter: 0.82, cv: 0.3, debris: 0.25 },
  { kind: 'clog release', at: 0.54, length: 0.015, rate: 4, signal: 0.9, scatter: 0.95, cv: 0.12, junk: 0.3 },
];

// Single-stain capture beads: a negative and a positive bead population in one tube.
function beadSpecs(marker, abc) {
  const base = { fsc: [42000, 0.04], ssc: [9000, 0.06], af: 0.08, afSD: 0.15 };
  return [
    { ...base, name: 'Negative beads', markers: { [marker]: 0 } },
    { ...base, name: 'Positive beads', markers: { [marker]: [abc, 0.12] } },
  ];
}

const BEAD_MIX = { dead: 0, debris: 0.02, doublets: 0.03 };
const BEAD_DEBRIS = { fscMin: 3000, fscMean: 6000, ssc: [3000, 0.8], viabilityBright: 0 };

// Positive beads are made `targetSignal` bright in the fluorochrome's peak detector.
function simulateBeads(ctx, sample, instrument, panel, marker, targetSignal, rate, extra = {}) {
  let peak = 0;
  const row = 2 + panel.markers.indexOf(marker);
  for (let j = 0; j < panel.detectors.length; j += 1) peak = Math.max(peak, panel.emitters[row * panel.detectors.length + j]);
  const populations = compilePopulations(beadSpecs(marker, targetSignal / peak), panel.markers, { stained: new Set([marker]) });
  return simulateEvents({ count: sample.events, instrument, panel, populations, weights: Float64Array.from([1, 1]), mix: BEAD_MIX, debris: BEAD_DEBRIS, viability: null, rate, ...extra }, ctx.random(sample.name), { signal: ctx.signal });
}

// --- 1. PBMC immunophenotyping (conventional, BD LSRFortessa-like) ------------------------------

const PBMC_PANEL = [
  { marker: 'CD45RA', fluor: 'BUV395', detector: 'BUV395-A' },
  { marker: 'CD56', fluor: 'BUV737', detector: 'BUV737-A' },
  { marker: 'CCR7', fluor: 'BV421', detector: 'BV421-A' },
  { marker: 'Viability', fluor: 'Aqua', detector: 'BV510-A' },
  { marker: 'CD3', fluor: 'BV605', detector: 'BV605-A' },
  { marker: 'HLA-DR', fluor: 'BV650', detector: 'BV650-A' },
  { marker: 'CD19', fluor: 'BV711', detector: 'BV711-A' },
  { marker: 'CD45', fluor: 'BV786', detector: 'BV786-A' },
  { marker: 'CD16', fluor: 'FITC', detector: 'FITC-A' },
  { marker: 'CD14', fluor: 'PerCP-Cy5.5', detector: 'PerCP-Cy5-5-A' },
  { marker: 'CD25', fluor: 'PE', detector: 'PE-A' },
  { marker: 'CD127', fluor: 'PE-Cy7', detector: 'PE-Cy7-A' },
  { marker: 'CD8', fluor: 'APC', detector: 'APC-A' },
  { marker: 'CD4', fluor: 'Alexa Fluor 700', detector: 'Alexa Fluor 700-A' },
];

// The acquisition matrix written to $SPILLOVER under-compensates APC into Alexa Fluor 700
// (CD8 → CD4): the error a compensation review should find.
const PBMC_SPILL_ERROR = { from: 'APC-A', to: 'Alexa Fluor 700-A', factor: 0.7 };
const PBMC_DONORS = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06'];
const PBMC_MIX = { dead: 0.05, debris: 0.07, doublets: 0.04 };

function bdChannels(assignments, withWidth = true) {
  const scatter = withWidth ? ['FSC-A', 'FSC-H', 'FSC-W', 'SSC-A', 'SSC-H', 'SSC-W'] : ['FSC-A', 'FSC-H', 'SSC-A', 'SSC-H'];
  return [...scatter.map((name) => ({ name, label: '' })), ...assignments.map((a) => ({ name: a.detector, label: a.label ?? a.marker })), { name: 'Time', label: '' }];
}

function pbmcDesign(scale, ctx = {}) {
  const samples = [{ name: 'Unstained.fcs', events: eventsFor(20000, scale), role: 'unstained', condition: 'Control', subject: 'D01', carrier: 'cells' }];
  for (const a of PBMC_PANEL) {
    if (a.marker === 'Viability') samples.push({ name: `Comp_${a.fluor}.fcs`, events: eventsFor(10000, scale), role: 'single-stain', stain: a.detector, marker: a.marker, carrier: 'cells (50 % heat-killed)', condition: 'Control', subject: 'D01' });
    else samples.push({ name: `Comp_${a.fluor}.fcs`, events: eventsFor(5000, scale), role: 'single-stain', stain: a.detector, marker: a.marker, carrier: 'beads', condition: 'Control' });
  }
  for (const donor of PBMC_DONORS) {
    for (const condition of ['Unstimulated', 'Stimulated']) {
      const clog = donor === 'D05' && condition === 'Unstimulated';
      samples.push({ name: `${donor}_${condition === 'Unstimulated' ? 'Unstim' : 'Stim'}.fcs`, events: eventsFor(100000, scale), role: 'sample', condition, subject: donor, batch: 'B1', anomaly: clog ? 'clog' : null });
    }
  }
  for (const marker of ctx.fmos ?? []) {
    const a = PBMC_PANEL.find((x) => x.marker === marker);
    if (!a) throw new Error(`The PBMC panel has no ${marker}.`);
    samples.push({ name: `FMO_${marker}.fcs`, events: eventsFor(100000, scale), role: 'fmo', stain: a.detector, marker, condition: 'Unstimulated', subject: PBMC_DONORS[0], batch: 'B1' });
  }
  return samples;
}

// Multiplies a simulated sample's detectors by random gains (instrumentShift). Returns the gains.
function shiftSample(ctx, sample, sim, panel, strength) {
  const random = ctx.random('instrument-shift', sample.name);
  const gains = new Map();
  const scatter = Math.exp((random() * 2 - 1) * strength * 0.25);
  for (const name of sim.order) {
    if (name === 'Time' || /-W$/.test(name)) continue;
    const gain = /^(FSC|SSC)/.test(name) ? scatter : panel.detectors.some((d) => d.name === name) ? Math.exp((random() * 2 - 1) * strength) : 1;
    gains.set(name, gain);
    const column = sim.columns[name];
    for (let e = 0; e < column.length; e += 1) column[e] = Math.min(262143, column[e] * gain);
  }
  return gains;
}

// The spillover a sample's acquisition software would write after its detectors' gains changed:
// spill[i][j] × gain[j] / gain[i].
function shiftedSpill(spill, gains) {
  const { channels, n } = spill;
  const matrix = Float64Array.from(spill.matrix);
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) matrix[i * n + j] *= (gains.get(channels[j]) ?? 1) / (gains.get(channels[i]) ?? 1);
  return { ...spill, matrix };
}

function pbmcWrittenSpill(panel) {
  const { channels, matrix, n } = panel.spill;
  const written = Float64Array.from(matrix);
  const i = channels.indexOf(PBMC_SPILL_ERROR.from);
  const j = channels.indexOf(PBMC_SPILL_ERROR.to);
  written[i * n + j] = +(matrix[i * n + j] * PBMC_SPILL_ERROR.factor).toFixed(4);
  return { channels, matrix: written, n, error: { from: PBMC_SPILL_ERROR.from, to: PBMC_SPILL_ERROR.to, written: written[i * n + j], true: matrix[i * n + j] } };
}

function pbmcGates() {
  const fsc = ['FSC-A', LINEAR_BD];
  const ssc = ['SSC-A', LINEAR_BD];
  const fsch = ['FSC-H', LINEAR_BD];
  return [
    polygonGate('gsim-cells', 'Cells', null, fsc, ssc, [[26000, 0], [270000, 0], [270000, 270000], [45000, 270000], [26000, 40000]], '#64748b', 'Excludes debris (low FSC).'),
    polygonGate('gsim-singlets', 'Single cells', 'gsim-cells', fsc, fsch, [[15000, 11200], [270000, 201000], [270000, 270000], [215000, 270000], [15000, 18000]], '#0ea5e9', 'Singlets have FSC-H ≈ FSC-A; doublets fall below the diagonal.'),
    polygonGate('gsim-live', 'Live', 'gsim-singlets', ['BV510-A', LOGICLE_BD], ssc, [[-1000, 0], [2500, 0], [2500, 270000], [-1000, 270000]], '#22c55e', 'Viability dye (BV510-A) negative.'),
    polygonGate('gsim-lymph', 'Lymphocytes', 'gsim-live', fsc, ssc, [[33000, 1000], [92000, 1000], [95000, 34000], [40000, 36000]], '#3b82f6', 'FSC/SSC lymphocyte region.'),
    polygonGate('gsim-mono', 'Monocytes', 'gsim-live', fsc, ssc, [[72000, 26000], [165000, 30000], [170000, 95000], [80000, 90000]], '#f97316', 'FSC/SSC monocyte region.'),
    rangeGate('gsim-t', 'T cells', 'gsim-lymph', ['BV605-A', LOGICLE_BD], 4000, null, '#a855f7', 'CD3 (BV605-A) positive.'),
  ];
}

function* generatePBMC(ctx, samples, all) {
  ctx.schedule(1500, all);
  const instrument = INSTRUMENTS.fortessa;
  const panel = buildPanel(instrument, PBMC_PANEL);
  const written = pbmcWrittenSpill(panel);
  const date = '2026-03-12';
  const files = [];
  const setup = { instrument, panel, date, assignments: PBMC_PANEL };
  const rate = 2500;
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    let sim;
    let fileSetup = setup;
    if (sample.role === 'single-stain' && sample.carrier === 'beads') {
      sim = simulateBeads(ctx, sample, instrument, panel, sample.marker, 70000, 1500);
    } else if (sample.role === 'fmo') {
      // The donor's unstimulated cells with every dye but one.
      const { specs, weights } = pbmcComposition(ctx, sample.subject, { stimulated: false });
      const populations = compilePopulations(specs, panel.markers, { stained: new Set(panel.markers.filter((m) => m !== sample.marker)) });
      sim = simulateEvents({ count: sample.events, instrument, panel, populations, weights, mix: PBMC_MIX, viability: sample.marker === 'Viability' ? null : 'Viability', rate, markerFactors: donorMarkerFactors(ctx, sample.subject, panel.markers) }, ctx.random(sample.name), { signal: ctx.signal });
      fileSetup = { ...setup, spill: written };
    } else if (sample.role === 'single-stain' || sample.role === 'unstained') {
      const { specs, weights } = pbmcComposition(ctx, sample.subject);
      const stained = new Set(sample.role === 'unstained' ? [] : [sample.marker]);
      const populations = compilePopulations(specs, panel.markers, { stained });
      const mix = sample.role === 'unstained' ? PBMC_MIX : { dead: 0.45, debris: 0.08, doublets: 0.03 };
      sim = simulateEvents({ count: sample.events, instrument, panel, populations, weights, mix, viability: sample.role === 'unstained' ? null : 'Viability', rate }, ctx.random(sample.name), { signal: ctx.signal });
    } else {
      const stimulated = sample.condition === 'Stimulated';
      const { specs, weights } = pbmcComposition(ctx, sample.subject, { stimulated });
      const populations = compilePopulations(specs, panel.markers);
      sim = simulateEvents({
        count: sample.events,
        instrument,
        panel,
        populations,
        weights,
        mix: PBMC_MIX,
        viability: 'Viability',
        rate,
        anomalies: (ctx.clogs ? ctx.clogs.includes(sample.name) : sample.anomaly === 'clog') ? CLOG : [],
        markerFactors: donorMarkerFactors(ctx, sample.subject, panel.markers),
        recordState: true,
      }, ctx.random(sample.name), { signal: ctx.signal });
      fileSetup = { ...setup, spill: written, truth: { state: sim.state, stateNames: ['resting', 'activated'], anomalies: windowsTruth(sim, instrument) } };
      if (ctx.shift && sample !== all.find((x) => x.role === 'sample')) {
        const gains = shiftSample(ctx, sample, sim, panel, ctx.shift);
        fileSetup = { ...fileSetup, spill: shiftedSpill(written, gains), truth: { ...fileSetup.truth, gains: Object.fromEntries(gains) } };
      }
    }
    files.push(flowFile(ctx, sample, sim, fileSetup));
    yield;
  }
  const transforms = channelTransforms(bdChannels(PBMC_PANEL), () => LOGICLE_BD, 262144, 8192);
  return {
    files,
    workspaceHints: {
      groups: [
        { name: 'Compensation controls', color: '#64748b', files: samples.filter((s) => s.role !== 'sample').map((s) => s.name) },
        { name: 'Unstimulated', color: '#3b82f6', files: samples.filter((s) => s.condition === 'Unstimulated').map((s) => s.name) },
        { name: 'Stimulated', color: '#ef4444', files: samples.filter((s) => s.condition === 'Stimulated').map((s) => s.name) },
      ],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([k, v]) => [k, { transform: v }])),
      compensation: {
        fromFile: '$SPILLOVER',
        unstained: 'Unstained.fcs',
        controls: samples.filter((s) => s.role === 'single-stain').map((s) => ({ file: s.name, channel: s.stain, carrier: s.carrier })),
      },
      suggestedGates: pbmcGates(),
    },
  };
}

// --- 1b. A FlowJo workspace to migrate ------------------------------------------------------------
//
// Four PBMC samples with the FlowJo 10 workspace a lab would have made for them: the corrected
// compensation matrix, FlowJo's biexponential scales and a gating tree in FlowJo's own form
// (polygon vertices in data units, a quadrant as four rectangles, an ellipse, a Boolean OR node,
// sample groups). Every population count in the workspace is computed here, independently of
// CytoWeave's FlowJo import: polygons on FlowJo's display scales, rectangles in data units and the
// ellipse from its foci in FlowJo's 256 × 256 display space, the way FlowJo evaluates them. The
// migration report then compares those counts with CytoWeave's.

// The ellipse as FlowJo stores it: foci and edge points in display bins (256 across the axis;
// here linear 0–262144 axes), rounded as written to the workspace.
function flowJoEllipse(gate) {
  const c = Math.sqrt(gate.a ** 2 - gate.b ** 2);
  const [cx, cy] = gate.center;
  const cos = Math.cos(gate.theta);
  const sin = Math.sin(gate.theta);
  const bin = (v) => +(v / 1024).toFixed(6);
  return {
    foci: [[cx + c * cos, cy + c * sin], [cx - c * cos, cy - c * sin]].map((p) => p.map(bin)),
    edges: [[cx + gate.a * cos, cy + gate.a * sin], [cx - gate.a * cos, cy - gate.a * sin], [cx - gate.b * sin, cy + gate.b * cos], [cx + gate.b * sin, cy - gate.b * cos]].map((p) => p.map(bin)),
  };
}

const FLOWJO_SAMPLES = ['D01_Unstim.fcs', 'D01_Stim.fcs', 'D02_Unstim.fcs', 'D02_Stim.fcs'];
const FLOWJO_BIEX = { maxValue: 262144, widthBasis: -100, positiveDecades: 4.42, extraNegativeDecades: 0 };
const FLOWJO_WORKSPACE = 'PBMC_FlowJo.wsp';

// The gating tree. Channels named "Comp-…" are compensated, as in FlowJo.
const FLOWJO_TREE = [
  { name: 'Cells', gate: { type: 'polygon', x: 'FSC-A', y: 'SSC-A', vertices: [[26000, 0], [262000, 0], [262000, 262000], [45000, 262000], [26000, 40000]] }, children: [
    { name: 'Single Cells', gate: { type: 'polygon', x: 'FSC-A', y: 'FSC-H', vertices: [[15000, 11200], [262000, 195000], [262000, 262000], [215000, 262000], [15000, 18000]] }, children: [
      { name: 'Live', gate: { type: 'polygon', x: 'Comp-BV510-A', y: 'SSC-A', vertices: [[-2000, 0], [2500, 0], [2500, 262000], [-2000, 262000]] }, children: [
        { name: 'Monocytes', gate: { type: 'ellipse', x: 'FSC-A', y: 'SSC-A', center: [121000, 60000], a: 52000, b: 30000, theta: 0.35 } },
        { name: 'Lymphocytes', gate: { type: 'polygon', x: 'FSC-A', y: 'SSC-A', vertices: [[33000, 1000], [92000, 1000], [95000, 34000], [40000, 36000]] }, children: [
          { name: 'T cells', gate: { type: 'rect', dims: [{ channel: 'Comp-BV605-A', min: 5000 }] }, children: [
            { name: 'Q1: CD4- , CD8+', quad: 'UL', gate: { type: 'rect', dims: [{ channel: 'Comp-Alexa Fluor 700-A', max: 2000 }, { channel: 'Comp-APC-A', min: 3000 }] } },
            { name: 'Q2: CD4+ , CD8+', quad: 'UR', gate: { type: 'rect', dims: [{ channel: 'Comp-Alexa Fluor 700-A', min: 2000 }, { channel: 'Comp-APC-A', min: 3000 }] } },
            { name: 'Q3: CD4+ , CD8-', quad: 'LR', gate: { type: 'rect', dims: [{ channel: 'Comp-Alexa Fluor 700-A', min: 2000 }, { channel: 'Comp-APC-A', max: 3000 }] }, children: [
              { name: 'Tregs', gate: { type: 'polygon', x: 'Comp-PE-A', y: 'Comp-PE-Cy7-A', vertices: [[2500, -1500], [200000, -1500], [200000, 1200], [2500, 800]] } },
            ] },
            { name: 'Q4: CD4- , CD8-', quad: 'LL', gate: { type: 'rect', dims: [{ channel: 'Comp-Alexa Fluor 700-A', max: 2000 }, { channel: 'Comp-APC-A', max: 3000 }] } },
            { name: 'CD4 or CD8 T cells', or: ['Q1: CD4- , CD8+', 'Q3: CD4+ , CD8-'] },
          ] },
          { name: 'B cells', gate: { type: 'rect', dims: [{ channel: 'Comp-BV711-A', min: 1500 }, { channel: 'Comp-BV605-A', max: 2000 }] } },
          { name: 'NK cells', gate: { type: 'polygon', x: 'Comp-BV605-A', y: 'Comp-BUV737-A', vertices: [[-1000, 800], [2000, 800], [2000, 200000], [-1000, 200000]] } },
        ] },
      ] },
    ] },
  ] },
];

function flowJoDesign(scale) {
  return pbmcDesign(scale / 2).filter((s) => FLOWJO_SAMPLES.includes(s.name));
}

// Counts of every population, path → count, evaluated as FlowJo does.
function flowJoCounts(dataset, spill) {
  const raw = Object.fromEntries(dataset.parameters.map((p) => [p.name, dataset.data[p.index]]));
  const comp = compensate(raw, { channels: spill.channels, matrix: spill.matrix });
  const n = dataset.eventCount;
  const biex = createTransform({ type: 'biex', ...FLOWJO_BIEX });
  const value = (channel) => (channel.startsWith('Comp-') ? comp[channel.slice(5)] : raw[channel]);
  const display = (channel) => (channel.startsWith('Comp-') ? (v) => biex.forward(v) : (v) => v / 262144);
  const inside = (gate) => {
    const out = new Uint8Array(n);
    if (gate.type === 'rect') {
      const columns = gate.dims.map((d) => value(d.channel));
      for (let e = 0; e < n; e += 1) {
        out[e] = gate.dims.every((d, k) => (d.min === undefined || columns[k][e] >= d.min) && (d.max === undefined || columns[k][e] < d.max)) ? 1 : 0;
      }
    } else if (gate.type === 'polygon') {
      const fx = display(gate.x);
      const fy = display(gate.y);
      const test = pointTest('polygon', { vertices: gate.vertices.map(([x, y]) => [fx(x), fy(y)]) });
      const xs = value(gate.x);
      const ys = value(gate.y);
      for (let e = 0; e < n; e += 1) out[e] = test(fx(xs[e]), fy(ys[e])) ? 1 : 0;
    } else {
      // Ellipse in display bins: the points whose distances to the foci sum to at most the major
      // axis, 2a, with a the distance from the center to the first edge point.
      const { foci: [f1, f2], edges } = flowJoEllipse(gate);
      const center = [(f1[0] + f2[0]) / 2, (f1[1] + f2[1]) / 2];
      const major = 2 * Math.hypot(edges[0][0] - center[0], edges[0][1] - center[1]);
      const xs = value(gate.x);
      const ys = value(gate.y);
      for (let e = 0; e < n; e += 1) {
        const x = xs[e] / 1024;
        const y = ys[e] / 1024;
        out[e] = Math.hypot(x - f1[0], y - f1[1]) + Math.hypot(x - f2[0], y - f2[1]) <= major ? 1 : 0;
      }
    }
    return out;
  };
  const counts = {};
  const walk = (nodes, parent, path) => {
    const members = new Map();
    for (const node of nodes) {
      if (node.or) continue;
      const mask = inside(node.gate);
      for (let e = 0; e < n; e += 1) mask[e] &= parent[e];
      members.set(node.name, mask);
      const own = path ? `${path}/${node.name}` : node.name;
      counts[own] = mask.reduce((sum, v) => sum + v, 0);
      if (node.children) walk(node.children, mask, own);
    }
    for (const node of nodes) {
      if (!node.or) continue;
      let count = 0;
      for (let e = 0; e < n; e += 1) if (node.or.some((name) => members.get(name)[e])) count += 1;
      counts[`${path}/${node.name}`] = count;
    }
  };
  walk(FLOWJO_TREE, new Uint8Array(n).fill(1), '');
  return counts;
}

const xmlEscape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function flowJoWorkspaceXML(entries, spill) {
  let id = 0;
  const dim = (name, { min, max } = {}) => `<gating:dimension${min !== undefined ? ` gating:min="${min}"` : ''}${max !== undefined ? ` gating:max="${max}"` : ''}><data-type:fcs-dimension data-type:name="${xmlEscape(name)}"/></gating:dimension>`;
  const vertex = ([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`;
  const gateXML = (gate, gid) => {
    if (gate.type === 'rect') return `<gating:RectangleGate eventsInside="1" gating:id="${gid}">${gate.dims.map((d) => dim(d.channel, d)).join('')}</gating:RectangleGate>`;
    if (gate.type === 'polygon') return `<gating:PolygonGate eventsInside="1" userDefined="1" gating:id="${gid}">${dim(gate.x)}${dim(gate.y)}${gate.vertices.map(vertex).join('')}</gating:PolygonGate>`;
    const { foci, edges } = flowJoEllipse(gate);
    return `<gating:EllipsoidGate eventsInside="1" gating:id="${gid}">${dim(gate.x)}${dim(gate.y)}<gating:foci>${foci.map(vertex).join('')}</gating:foci><gating:edge>${edges.map(vertex).join('')}</gating:edge></gating:EllipsoidGate>`;
  };
  const nodesXML = (nodes, path, counts, quadId) => nodes.map((node) => {
    const own = path ? `${path}/${node.name}` : node.name;
    const count = counts[own] ?? 0;
    if (node.or) {
      return `<OrNode name="${xmlEscape(node.name)}" annotation="" owningGroup="" expanded="0" sortPriority="10" count="${count}"><Graph/><Dependents>${node.or.map((d) => `<Dependent name="${xmlEscape(`${path}/${d}`)}"/>`).join('')}</Dependents><Subpopulations/></OrNode>`;
    }
    id += 1;
    const gid = `ID${id}`;
    const quad = node.quad ? ` quadId="${quadId}"` : '';
    const children = node.children ? nodesXML(node.children, own, counts, `QUAD${id}`) : '';
    return `<Population name="${xmlEscape(node.name)}" annotation="" owningGroup="" expanded="1" sortPriority="10" count="${count}"><Graph smoothing="0" backColor="#ffffff" foreColor="#000000" type="Pseudocolor" fast="0"/><Gate gating:id="${gid}"${quad}>${gateXML(node.gate, gid)}</Gate><Subpopulations>${children}</Subpopulations></Population>`;
  }).join('');
  const spillXML = `<transforms:spilloverMatrix prefix="Comp-" name="Corrected matrix" editable="1" color="#c0c0c0" version="FlowJo-10.10.0" status="FINALIZED" transforms:id="SPILL1" suffix="">
      <data-type:parameters>${spill.channels.map((c) => `<data-type:parameter data-type:name="${xmlEscape(c)}" userProvidedCompInfix="Comp-${xmlEscape(c)}"/>`).join('')}</data-type:parameters>
      ${spill.channels.map((from, i) => `<transforms:spillover data-type:parameter="${xmlEscape(from)}" userProvidedCompInfix="Comp-${xmlEscape(from)}">${spill.channels.map((to, j) => `<transforms:coefficient data-type:parameter="${xmlEscape(to)}" transforms:value="${+spill.matrix[i * spill.channels.length + j].toPrecision(6)}"/>`).join('')}</transforms:spillover>`).join('\n      ')}
    </transforms:spilloverMatrix>`;
  const samplesXML = entries.map(({ name, dataset, counts }, i) => {
    const sampleID = String(i + 1);
    const keywords = [`<Keyword name="$FIL" value="${xmlEscape(name)}"/>`, `<Keyword name="$TOT" value="${dataset.eventCount}"/>`, `<Keyword name="$CYT" value="${xmlEscape(dataset.keywords.$CYT ?? '')}"/>`, `<Keyword name="$DATE" value="${xmlEscape(dataset.keywords.$DATE ?? '')}"/>`];
    dataset.parameters.forEach((p, k) => {
      keywords.push(`<Keyword name="$P${k + 1}N" value="${xmlEscape(p.name)}"/>`, `<Keyword name="$P${k + 1}R" value="${p.range}"/>`);
      if (p.label) keywords.push(`<Keyword name="$P${k + 1}S" value="${xmlEscape(p.label)}"/>`);
    });
    const transforms = dataset.parameters.map((p) => (p.type === 'fluorescence'
      ? `<transforms:biex transforms:length="256" transforms:maxRange="${FLOWJO_BIEX.maxValue}" transforms:neg="${FLOWJO_BIEX.extraNegativeDecades}" transforms:width="${FLOWJO_BIEX.widthBasis}" transforms:pos="${FLOWJO_BIEX.positiveDecades}"><data-type:parameter data-type:name="Comp-${xmlEscape(p.name)}"/></transforms:biex>`
      : `<transforms:linear transforms:minRange="0" transforms:maxRange="${p.range}" gain="1"><data-type:parameter data-type:name="${xmlEscape(p.name)}"/></transforms:linear>`)).join('');
    return `<Sample>
    <DataSet uri="file:/Users/lab/FlowJo/PBMC/${encodeURIComponent(name)}" sampleID="${sampleID}"/>
    ${spillXML}
    <Transformations>${transforms}</Transformations>
    <Keywords>${keywords.join('')}</Keywords>
    <SampleNode name="${xmlEscape(name)}" annotation="" owningGroup="" expanded="1" sortPriority="10" count="${dataset.eventCount}" sampleID="${sampleID}"><Graph/><Subpopulations>${nodesXML(FLOWJO_TREE, '', counts, 'QUAD0')}</Subpopulations></SampleNode>
  </Sample>`;
  }).join('\n  ');
  const groupXML = (name, ids, builtIn = false) => `<GroupNode name="${name}" annotation="" owningGroup="${name}" expanded="0" sortPriority="10" count="${ids.length}"><Group name="${name}"${builtIn ? ' builtIn="1"' : ''}><Criteria/><SampleRefs>${ids.map((sid) => `<SampleRef sampleID="${sid}"/>`).join('')}</SampleRefs></Group></GroupNode>`;
  const idsWhere = (test) => entries.map((entry, i) => (test(entry.name) ? String(i + 1) : null)).filter(Boolean);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" modDate="Tue May 12 16:20:00 PDT 2026" flowJoVersion="10.10.0" curGroup="All Samples" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <Groups>
    ${groupXML('All Samples', idsWhere(() => true), true)}
    ${groupXML('Unstimulated', idsWhere((name) => /Unstim/.test(name)))}
    ${groupXML('Stimulated', idsWhere((name) => /_Stim/.test(name)))}
  </Groups>
  <SampleList>
  ${samplesXML}
  </SampleList>
</Workspace>
`;
}

function* generateFlowJo(ctx, samples, all) {
  const base = yield* generatePBMC(ctx, samples, all);
  const spill = buildPanel(INSTRUMENTS.fortessa, PBMC_PANEL).spill;
  const entries = base.files.map((file) => {
    const dataset = parseFCS(file.bytes).datasets[0];
    return { name: file.name, dataset, counts: flowJoCounts(dataset, spill) };
  });
  const text = flowJoWorkspaceXML(entries, spill);
  return {
    files: base.files,
    attachments: [{ name: FLOWJO_WORKSPACE, text, kind: 'flowjo' }],
    workspaceHints: {
      groups: base.workspaceHints.groups.filter((g) => g.files.length),
      sampleMeta: base.workspaceHints.sampleMeta,
    },
  };
}

// --- 2. Spectral 25-color (Cytek Aurora-like, 64 raw detectors) --------------------------------

const SPECTRAL_PANEL = [
  ['CD45RA', 'BUV395'], ['CD16', 'BUV496'], ['CD123', 'BUV563'], ['CD161', 'BUV615'], ['CD38', 'BUV661'],
  ['CD56', 'BUV737'], ['CD8', 'BUV805'], ['CCR7', 'BV421'], ['CD19', 'BV480'], ['Viability', 'Aqua'],
  ['CD57', 'BV570'], ['CD27', 'BV605'], ['HLA-DR', 'BV650'], ['CD95', 'BV711'], ['PD-1', 'BV750'],
  ['CD14', 'BV786'], ['TCRgd', 'FITC'], ['CD127', 'PerCP-Cy5.5'], ['CD25', 'PE'], ['CD28', 'PE-CF594'],
  ['CD11c', 'PE-Cy5'], ['CD45', 'PE-Cy7'], ['CD11b', 'APC'], ['CD3', 'Alexa Fluor 700'], ['CD4', 'APC-Cy7'],
].map(([marker, fluor]) => ({ marker, fluor, detector: null }));

function spectralDesign(scale, ctx = {}) {
  const samples = [{ name: 'Unstained.fcs', events: eventsFor(20000, scale), role: 'unstained', condition: 'Control', subject: 'S1', carrier: 'cells' }];
  for (const a of SPECTRAL_PANEL) {
    const cells = a.marker === 'Viability';
    samples.push({ name: `Ref_${a.fluor}.fcs`, events: eventsFor(cells ? 8000 : 4000, scale), role: 'single-stain', stain: a.fluor, marker: a.marker, carrier: cells ? 'cells (50 % heat-killed)' : 'beads', condition: 'Control', subject: cells ? 'S1' : undefined });
  }
  for (const subject of ['S1', 'S2', 'S3']) samples.push({ name: `Donor_${subject}.fcs`, events: eventsFor(40000, scale), role: 'sample', condition: 'Healthy', subject, batch: 'B1' });
  for (const marker of ctx.fmos ?? []) {
    const a = SPECTRAL_PANEL.find((x) => x.marker === marker);
    if (!a) throw new Error(`The spectral panel has no ${marker}.`);
    samples.push({ name: `FMO_${marker}.fcs`, events: eventsFor(40000, scale), role: 'fmo', stain: a.fluor, marker, condition: 'Healthy', subject: 'S1', batch: 'B1' });
  }
  return samples;
}

function spectralDetectorNames() {
  return INSTRUMENTS.aurora.detectors.map((d) => d.name);
}

function* generateSpectral(ctx, samples, all) {
  ctx.schedule(3000, all);
  const instrument = INSTRUMENTS.aurora;
  const names = spectralDetectorNames();
  for (const fluor of Object.keys(ctx.degrade ?? {})) if (!SPECTRAL_PANEL.some((x) => x.fluor === fluor)) throw new Error(`The spectral panel has no ${fluor}.`);
  for (const [fluor, dye] of Object.entries(ctx.substitutes ?? {})) {
    if (!SPECTRAL_PANEL.some((x) => x.fluor === fluor)) throw new Error(`The spectral panel has no ${fluor}.`);
    if (!FLUOROCHROMES[dye]) throw new Error(`Unknown fluorochrome "${dye}".`);
  }
  // The panel as a file sees it: its tandems degraded or not, and one control's dye replaced.
  const panels = new Map();
  const panelOf = (degraded, marker = null, dye = null, key = '') => {
    const id = `${degraded}|${marker}|${key}`;
    if (!panels.has(id)) {
      const panel = buildPanel(instrument, SPECTRAL_PANEL.map((a) => (a.marker === marker ? { ...a, dye } : a)), names);
      if (degraded) {
        for (const [fluor, fraction] of Object.entries(ctx.degrade)) {
          const a = SPECTRAL_PANEL.find((x) => x.fluor === fluor);
          degradeTandem(panel, a.marker, fluor.split('-')[0], fraction);
        }
      }
      panels.set(id, panel);
    }
    return panels.get(id);
  };
  const panel = panelOf(Boolean(ctx.degrade));
  const panelFor = (sample) => {
    const control = sample.role !== 'sample';
    const degraded = Boolean(ctx.degrade) && (ctx.degradeIn === 'all' || (ctx.degradeIn === 'controls') === control);
    if (sample.role === 'single-stain') {
      const substitute = ctx.substitutes?.[sample.stain];
      const shift = sample.carrier === 'beads' ? ctx.beadShift?.[sample.stain] : null;
      if (substitute) return panelOf(degraded, sample.marker, FLUOROCHROMES[substitute], `as ${substitute}`);
      if (shift) return panelOf(degraded, sample.marker, shiftedFluorochrome(sample.stain, shift), `shifted ${shift}`);
    }
    return panelOf(degraded);
  };
  const signatures = {};
  const peaks = {};
  for (const a of SPECTRAL_PANEL) {
    const sig = spectralSignature(a.fluor, instrument.detectors);
    signatures[a.fluor] = Array.from(sig, (v) => +v.toFixed(5));
    peaks[a.fluor] = names[sig.indexOf(1)];
  }
  for (const af of ['AF', 'AFM']) signatures[af] = Array.from(spectralSignature(af, instrument.detectors), (v) => +v.toFixed(5));
  const date = '2026-05-20';
  const files = [];
  const rate = 5000;
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    let sim;
    let truth = {};
    const filePanel = panelFor(sample);
    // What the control's tube really holds (another dye when it was substituted).
    const held = ctx.substitutes?.[sample.stain] ?? sample.stain;
    const heldSignature = () => signatures[held] ?? Array.from(spectralSignature(held, instrument.detectors), (v) => +v.toFixed(5));
    if (sample.role === 'fmo') {
      // Donor S1's cells with every dye but one.
      const { specs, weights } = pbmcComposition(ctx, sample.subject);
      const populations = compilePopulations(specs, filePanel.markers, { stained: new Set(filePanel.markers.filter((m) => m !== sample.marker)) });
      sim = simulateEvents({ count: sample.events, instrument, panel: filePanel, populations, weights, mix: PBMC_MIX, viability: sample.marker === 'Viability' ? null : 'Viability', rate, markerFactors: donorMarkerFactors(ctx, sample.subject, panel.markers), laserCV: ctx.laserCV }, ctx.random(sample.name), { signal: ctx.signal });
    } else if (sample.role === 'single-stain' && sample.carrier === 'beads') {
      sim = simulateBeads(ctx, sample, instrument, filePanel, sample.marker, 1.2e6, 3000, { laserCV: ctx.laserCV });
      const shift = ctx.beadShift?.[sample.stain];
      truth = { signature: shift && held === sample.stain ? Array.from(spectralSignature(shiftedFluorochrome(held, shift), instrument.detectors), (v) => +v.toFixed(5)) : heldSignature(), fluorochrome: held };
    } else if (sample.role !== 'sample') {
      const { specs, weights } = pbmcComposition(ctx, sample.subject);
      // An unstained control of lymphocytes only has none of the myeloid cells' autofluorescence.
      if (sample.role === 'unstained' && ctx.unstainedCells === 'lymphocytes') specs.forEach((spec, k) => { if (spec.afType === 'M') weights[k] = 0; });
      const stained = new Set(sample.role === 'unstained' ? [] : [sample.marker]);
      const populations = compilePopulations(specs, filePanel.markers, { stained });
      const mix = sample.role === 'unstained' ? PBMC_MIX : { dead: 0.45, debris: 0.08, doublets: 0.03 };
      sim = simulateEvents({ count: sample.events, instrument, panel: filePanel, populations, weights, mix, viability: sample.role === 'unstained' ? null : 'Viability', rate, scatterWidth: false, laserCV: ctx.laserCV }, ctx.random(sample.name), { signal: ctx.signal });
      if (sample.role === 'single-stain') truth = { signature: heldSignature(), fluorochrome: held };
    } else {
      const { specs, weights } = pbmcComposition(ctx, sample.subject);
      const populations = compilePopulations(specs, filePanel.markers);
      sim = simulateEvents({ count: sample.events, instrument, panel: filePanel, populations, weights, mix: PBMC_MIX, viability: 'Viability', rate, keepAbundances: ctx.truth, markerFactors: donorMarkerFactors(ctx, sample.subject, panel.markers), laserCV: ctx.laserCV }, ctx.random(sample.name), { signal: ctx.signal });
      if (sim.abundances) {
        truth = {
          abundances: sim.abundances,
          abundanceNames: ['AF (lymphoid)', 'AF (myeloid)', ...SPECTRAL_PANEL.map((a) => a.fluor)],
          abundanceMarkers: ['Autofluorescence', 'Autofluorescence', ...SPECTRAL_PANEL.map((a) => a.marker)],
        };
      }
    }
    files.push(flowFile(ctx, sample, sim, { instrument, panel: filePanel, date, truth }));
    yield;
  }
  const transforms = channelTransforms(spectralChannels(), () => LOGICLE_AURORA, 4194304, 1 << 20);
  return {
    files,
    workspaceHints: {
      groups: [
        { name: 'Reference controls', color: '#64748b', files: samples.filter((s) => s.role !== 'sample').map((s) => s.name) },
        { name: 'Samples', color: '#8b5cf6', files: samples.filter((s) => s.role === 'sample').map((s) => s.name) },
      ],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([k, v]) => [k, { transform: v }])),
      spectral: {
        detectors: names,
        unstained: 'Unstained.fcs',
        fluorochromes: SPECTRAL_PANEL.map((a) => ({ name: a.fluor, marker: a.marker, peakDetector: peaks[a.fluor], reference: `Ref_${a.fluor}.fcs` })),
        autofluorescence: [{ name: 'AF (lymphoid)', signature: signatures.AF }, { name: 'AF (myeloid)', signature: signatures.AFM }],
        signatures,
      },
    },
  };
}

function spectralChannels() {
  return [
    ...['FSC-A', 'FSC-H', 'SSC-A', 'SSC-H', 'SSC-B-A', 'SSC-B-H'].map((name) => ({ name, label: '' })),
    ...spectralDetectorNames().map((name) => ({ name, label: '' })),
    { name: 'Time', label: '' },
  ];
}

// --- 3. Cell cycle (DNA content) ----------------------------------------------------------------

const CELL_CYCLE_SAMPLES = [
  { file: 'Asynchronous.fcs', condition: 'Untreated', phases: { G1: 0.55, S: 0.3, G2M: 0.15 }, mix: { doublets: 0.06, aggregates: 0.015, debris: 0.045 } },
  { file: 'Nocodazole_16h.fcs', condition: 'Nocodazole (G2/M arrest)', phases: { G1: 0.25, S: 0.3, G2M: 0.45 }, mix: { doublets: 0.07, aggregates: 0.02, debris: 0.09 } },
];

function cellCycleDesign(scale) {
  return CELL_CYCLE_SAMPLES.map((s) => ({ name: s.file, events: eventsFor(30000, scale), role: 'sample', condition: s.condition, subject: 'Jurkat-like line', batch: 'B1', phases: s.phases, mix: s.mix }));
}

function* generateCellCycle(ctx, samples, all) {
  ctx.schedule(300, all);
  const instrument = INSTRUMENTS.canto;
  const files = [];
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    const sim = simulateCellCycle({ count: sample.events, instrument, phases: sample.phases, mix: sample.mix, rate: 300 }, ctx.random(sample.name), { signal: ctx.signal });
    const singlets = sim.phaseCounts[0] + sim.phaseCounts[1] + sim.phaseCounts[2];
    files.push(flowFile(ctx, sample, sim, {
      instrument,
      panel: null,
      date: '2026-02-03',
      labels: { 'PI-A': 'DNA (PI)', 'PI-H': 'DNA (PI)', 'PI-W': 'DNA (PI)' },
      truth: {
        phases: { G1: sample.phases.G1, S: sample.phases.S, G2M: sample.phases.G2M },
        phaseFractions: { G1: sim.phaseCounts[0] / singlets, S: sim.phaseCounts[1] / singlets, G2M: sim.phaseCounts[2] / singlets },
        g1Position: 50000,
        g2g1Ratio: 1.97,
        cv: 0.04,
      },
    }));
    yield;
  }
  const linearAll = linear(262144);
  const hints = {
    groups: [{ name: 'Cell cycle', color: '#0ea5e9', files: samples.map((s) => s.name) }],
    sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
    channelSettings: Object.fromEntries(cellCycleChannels().map((c) => [c.name, { transform: c.name === 'Time' ? linear(65536) : linearAll }])),
    suggestedGates: [
      polygonGate('gsim-nuclei', 'Nuclei', null, ['FSC-A', linearAll], ['SSC-A', linearAll], [[25000, 3000], [270000, 3000], [270000, 270000], [25000, 270000]], '#64748b', 'Excludes small debris.'),
      polygonGate('gsim-dna-singlets', 'Single nuclei', 'gsim-nuclei', ['PI-A', linearAll], ['PI-W', linearAll], [[20000, 50000], [135000, 50000], [135000, 81000], [20000, 77000]], '#0ea5e9', 'Doublets of G1 nuclei have G2 DNA content (PI-A) but a longer pulse (PI-W).'),
    ],
  };
  return { files, workspaceHints: hints };
}

function cellCycleChannels() {
  return ['FSC-A', 'FSC-H', 'FSC-W', 'SSC-A', 'SSC-H', 'SSC-W', 'PI-A', 'PI-H', 'PI-W', 'Time'].map((name) => ({ name, label: name.startsWith('PI') ? 'DNA (PI)' : '' }));
}

// --- 4. Proliferation (CellTrace Violet dilution) -----------------------------------------------

const PROLIFERATION_PANEL = [
  { marker: 'CTV', fluor: 'CTV', detector: 'BV421-A', label: 'CellTrace Violet' },
  { marker: 'CD3', fluor: 'FITC', detector: 'FITC-A' },
  { marker: 'CD25', fluor: 'PE', detector: 'PE-A' },
  { marker: 'CD4', fluor: 'PE-Cy7', detector: 'PE-Cy7-A' },
  { marker: 'CD8', fluor: 'APC', detector: 'APC-A' },
  { marker: 'Viability', fluor: 'Zombie NIR', detector: 'APC-Cy7-A' },
];

// Precursor frequencies: the fraction of the starting cells that reached each generation.
export const PRECURSOR_FREQUENCIES = {
  stimulated: { CD4: [0.3, 0.08, 0.12, 0.17, 0.16, 0.12, 0.05], CD8: [0.2, 0.04, 0.07, 0.12, 0.2, 0.21, 0.16] },
  unstimulated: { CD4: [0.985, 0.012, 0.003, 0, 0, 0, 0], CD8: [0.99, 0.008, 0.002, 0, 0, 0, 0] },
  day0: { CD4: [1, 0, 0, 0, 0, 0, 0], CD8: [1, 0, 0, 0, 0, 0, 0] },
};

// FlowJo-style proliferation statistics from precursor frequencies p[i] (Roederer 2011,
// Cytometry A 79:95): division index Σ i·p, proliferation index over responders, expansion
// index Σ p·2^i, replication index (fold expansion of responders).
export function proliferationStatistics(p) {
  let divisions = 0;
  let expansion = 0;
  let responders = 0;
  let responderCells = 0;
  p.forEach((f, i) => {
    divisions += i * f;
    expansion += f * 2 ** i;
    if (i > 0) {
      responders += f;
      responderCells += f * 2 ** i;
    }
  });
  return {
    precursorFrequencies: p.slice(),
    percentDivided: 100 * responders,
    divisionIndex: divisions,
    proliferationIndex: responders ? divisions / responders : 0,
    expansionIndex: expansion,
    replicationIndex: responders ? responderCells / responders : 0,
  };
}

function proliferationDesign(scale) {
  return [
    { name: 'Day0_CTV.fcs', events: eventsFor(20000, scale), role: 'reference', condition: 'Day 0 (undivided)', timepoint: 'Day 0', subject: 'D01', batch: 'B1', design: 'day0' },
    { name: 'Day4_Unstim.fcs', events: eventsFor(60000, scale), role: 'sample', condition: 'Unstimulated', timepoint: 'Day 4', subject: 'D01', batch: 'B1', design: 'unstimulated' },
    { name: 'Day4_aCD3CD28.fcs', events: eventsFor(60000, scale), role: 'sample', condition: 'Anti-CD3/CD28', timepoint: 'Day 4', subject: 'D01', batch: 'B1', design: 'stimulated' },
  ];
}

function proliferationPopulations(design) {
  const byName = Object.fromEntries(PBMC_POPULATIONS.map((p) => [p.name, p]));
  const ctv0 = design === 'day0' ? 9e4 : 7e4;
  const specs = [];
  const weights = [];
  const start = { CD4: 0.48, CD8: 0.3 };
  for (const lineage of ['CD4', 'CD8']) {
    const base = byName[lineage === 'CD4' ? 'CD4 naive T' : 'CD8 naive T'];
    const p = PRECURSOR_FREQUENCIES[design][lineage];
    p.forEach((f, generation) => {
      if (!f) return;
      let spec = { ...base, name: `${lineage} T gen ${generation}`, corr: null, markers: { ...base.markers, CTV: [ctv0 / 2 ** generation, 0.17] } };
      if (design === 'stimulated') {
        const blast = generation > 0 ? 1.3 : 1.08;
        spec = { ...spec, fsc: [spec.fsc[0] * blast, 0.12], ssc: [spec.ssc[0] * (generation > 0 ? 1.25 : 1.05), 0.22], markers: { ...spec.markers, CD25: generation > 0 ? [1.5e4, 0.5] : [3e3, 0.8], CD3: [8e4 * 0.75, 0.25] } };
      }
      specs.push(spec);
      weights.push(start[lineage] * f * 2 ** generation);
    });
  }
  for (const [name, w] of [['Naive B', 0.08], ['CD56dim NK', 0.09], ['Classical monocytes', 0.05]]) {
    specs.push({ ...byName[name], name: name === 'Naive B' ? 'B cells' : name === 'CD56dim NK' ? 'NK cells' : 'Monocytes', corr: null, markers: { ...byName[name].markers, CTV: [ctv0, 0.17] } });
    weights.push(w);
  }
  return { specs, weights: Float64Array.from(weights) };
}

function* generateProliferation(ctx, samples, all) {
  ctx.schedule(1500, all);
  const instrument = INSTRUMENTS.fortessa;
  const panel = buildPanel(instrument, PROLIFERATION_PANEL);
  const files = [];
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    const { specs, weights } = proliferationPopulations(sample.design);
    const populations = compilePopulations(specs, panel.markers);
    const mix = sample.design === 'stimulated' ? { dead: 0.18, debris: 0.08, doublets: 0.05 } : sample.design === 'unstimulated' ? { dead: 0.12, debris: 0.06, doublets: 0.03 } : { dead: 0.04, debris: 0.03, doublets: 0.03 };
    const sim = simulateEvents({ count: sample.events, instrument, panel, populations, weights, mix, viability: 'Viability', rate: 1500 }, ctx.random(sample.name), { signal: ctx.signal });
    const p = PRECURSOR_FREQUENCIES[sample.design];
    files.push(flowFile(ctx, sample, sim, {
      instrument,
      panel,
      date: sample.design === 'day0' ? '2026-01-12' : '2026-01-16',
      assignments: PROLIFERATION_PANEL,
      spill: panel.spill,
      truth: { proliferation: { CD4: proliferationStatistics(p.CD4), CD8: proliferationStatistics(p.CD8) }, undividedCTV: sample.design === 'day0' ? 9e4 : 7e4 },
    }));
    yield;
  }
  const transforms = channelTransforms(bdChannels(PROLIFERATION_PANEL), () => LOGICLE_BD, 262144, 8192);
  return {
    files,
    workspaceHints: {
      groups: [
        { name: 'Day 0', color: '#64748b', files: [samples[0]?.name].filter(Boolean) },
        { name: 'Day 4', color: '#ef4444', files: samples.filter((s) => s.timepoint === 'Day 4').map((s) => s.name) },
      ],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([k, v]) => [k, { transform: v }])),
      compensation: { fromFile: '$SPILLOVER' },
    },
  };
}

// --- 4b. Calcium flux (Indo-1 ratio over time) -------------------------------------------------

// Indo-1 is read on the UV laser in two detectors: violet (379/28, mostly the calcium-bound dye)
// and blue (515/30, mostly the free dye); their ratio rises with intracellular calcium and does
// not depend on how much dye a cell took up.
const CALCIUM_PANEL = [
  { marker: 'Indo-1 bound', fluor: 'Indo-1 (Ca-bound)', detector: 'BUV395-A', label: 'Indo-1 (Violet)' },
  { marker: 'Indo-1 free', fluor: 'Indo-1 (free)', detector: 'BUV496-A', label: 'Indo-1 (Blue)' },
  { marker: 'CD19', fluor: 'FITC', detector: 'FITC-A' },
  { marker: 'CD3', fluor: 'APC', detector: 'APC-A' },
  // On the violet laser, where neither CD3 nor Indo-1 reaches (the files are not compensated: the
  // Indo-1 ratio is taken from raw values).
  { marker: 'Viability', fluor: 'Aqua', detector: 'BV510-A' },
];

// Calcium (nM) and the dye: Kd of Indo-1 for calcium, resting calcium (log-normal), dye loading
// (signal of the fully free or bound dye at its own detector, log-normal).
const CALCIUM = { kd: 250, rest: [90, 0.2], loading: [24000, 0.35], baseline: 60, pause: 8, after: 172 };

// Each tube: buffer, anti-CD3 at two doses (T cells respond), ionomycin (every cell responds),
// and the high dose injected without stopping acquisition. A responder's calcium rises after a
// lag (log-normal) by `amplitude` nM with time constant `rise`, then decays with time constant
// `decay` to `plateau` of its peak rise.
export const CALCIUM_STIMULI = {
  buffer: null,
  low: { target: 'T', responders: 0.35, amplitude: [320, 0.35], lag: [14, 0.45], rise: 6, decay: 60, plateau: 0.3 },
  high: { target: 'T', responders: 0.75, amplitude: [700, 0.3], lag: [6, 0.4], rise: 4, decay: 45, plateau: 0.35 },
  ionomycin: { target: 'all', responders: 0.97, amplitude: [1500, 0.25], lag: [2, 0.4], rise: 3, decay: 400, plateau: 0.85 },
};

function calciumDesign(scale) {
  return [
    { name: 'Buffer.fcs', condition: 'Buffer', stimulus: 'buffer', pause: true },
    { name: 'aCD3_low.fcs', condition: 'Anti-CD3 0.1 µg/mL', stimulus: 'low', pause: true },
    { name: 'aCD3_high.fcs', condition: 'Anti-CD3 1 µg/mL', stimulus: 'high', pause: true },
    { name: 'Ionomycin.fcs', condition: 'Ionomycin 1 µM', stimulus: 'ionomycin', pause: true },
    { name: 'aCD3_high_injected.fcs', condition: 'Anti-CD3 1 µg/mL, injected', stimulus: 'high', pause: false },
  ].map((s) => ({ ...s, events: eventsFor(100000, scale, 5000), role: 'sample', subject: 'D01', batch: 'B1' }));
}

const T_CELL = /( T$|TEMRA|Regulatory T)/;

function* generateCalcium(ctx, samples, all) {
  ctx.schedule(500, all);
  const instrument = INSTRUMENTS.fortessa;
  const panel = buildPanel(instrument, CALCIUM_PANEL);
  const nDet = panel.detectors.length;
  const violet = panel.detectors.findIndex((d) => d.name === 'BUV395-A');
  const blue = panel.detectors.findIndex((d) => d.name === 'BUV496-A');
  const bound = 2 + panel.markers.indexOf('Indo-1 bound');
  const free = 2 + panel.markers.indexOf('Indo-1 free');
  const files = [];
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    const { specs, weights } = pbmcComposition(ctx, sample.subject);
    const populations = compilePopulations(specs, panel.markers);
    const isT = specs.map((spec) => T_CELL.test(spec.name));
    const stimulus = CALCIUM_STIMULI[sample.stimulus];
    const duration = CALCIUM.baseline + CALCIUM.after;
    const ratio = new Float32Array(sample.events);
    const responding = new Uint8Array(sample.events);
    const responder = new Uint8Array(sample.events);
    const modulate = (e, t, kind, p, amt, normal, random) => {
      let calcium = CALCIUM.rest[0] * Math.exp(CALCIUM.rest[1] * normal());
      let loading = CALCIUM.loading[0] * Math.exp(CALCIUM.loading[1] * normal());
      if (kind === 'dead') {
        // Dead cells leak dye and flood with calcium.
        loading *= 0.15;
        calcium = 1500;
      } else if (kind === 'live' && stimulus && (stimulus.target === 'all' || isT[p]) && random() < stimulus.responders) {
        responder[e] = 1;
        const since = t - CALCIUM.baseline - stimulus.lag[0] * Math.exp(stimulus.lag[1] * normal());
        if (since > 0) {
          responding[e] = 1;
          const rise = stimulus.amplitude[0] * Math.exp(stimulus.amplitude[1] * normal());
          calcium += rise * (1 - Math.exp(-since / stimulus.rise)) * (stimulus.plateau + (1 - stimulus.plateau) * Math.exp(-since / stimulus.decay));
        }
      }
      if (kind === 'live' || kind === 'dead') {
        const f = calcium / (calcium + CALCIUM.kd);
        amt[bound] = loading * f;
        amt[free] = loading * (1 - f);
      }
      // The noise-free ratio, autofluorescence included.
      let v = 0;
      let b = 0;
      for (let k = 0; k < amt.length; k += 1) {
        v += amt[k] * panel.emitters[k * nDet + violet];
        b += amt[k] * panel.emitters[k * nDet + blue];
      }
      ratio[e] = b > 0 ? v / b : 0;
    };
    const rate = sample.events / duration;
    const sim = simulateEvents({
      count: sample.events,
      instrument,
      panel,
      populations,
      weights,
      mix: { dead: 0.05, debris: 0.05, doublets: 0.03 },
      viability: 'Viability',
      rate,
      pauses: sample.pause ? [{ at: CALCIUM.baseline, duration: CALCIUM.pause }] : [],
      modulate,
    }, ctx.random(sample.name), { signal: ctx.signal });
    files.push(flowFile(ctx, sample, sim, {
      instrument,
      panel,
      date: '2026-03-04',
      assignments: CALCIUM_PANEL,
      truth: {
        calcium: { stimulus: sample.stimulus, stimulusTime: CALCIUM.baseline, resumeTime: sample.pause ? CALCIUM.baseline + CALCIUM.pause : CALCIUM.baseline, parameters: stimulus, kd: CALCIUM.kd },
        ratio,
        responder,
        responding,
      },
    }));
    yield;
  }
  const channels = bdChannels(CALCIUM_PANEL);
  const transforms = channelTransforms(channels, () => LOGICLE_BD, 262144, 65536);
  const fsc = ['FSC-A', LINEAR_BD];
  const ssc = ['SSC-A', LINEAR_BD];
  return {
    files,
    workspaceHints: {
      groups: [{ name: 'Calcium flux', color: '#0ea5e9', files: samples.map((s) => s.name) }],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([k, v]) => [k, { transform: v }])),
      suggestedGates: [
        polygonGate('gsim-ca-lymph', 'Lymphocytes', null, fsc, ssc, [[33000, 1000], [92000, 1000], [95000, 34000], [40000, 36000]], '#3b82f6', 'FSC/SSC lymphocyte region.'),
        rangeGate('gsim-ca-live', 'Live', 'gsim-ca-lymph', ['BV510-A', LOGICLE_BD], null, 2000, '#10b981', 'Viability dye negative.'),
        rangeGate('gsim-ca-t', 'T cells', 'gsim-ca-live', ['APC-A', LOGICLE_BD], 6000, null, '#ef4444', 'CD3 positive: the cells anti-CD3 stimulates.'),
        rangeGate('gsim-ca-b', 'B cells', 'gsim-ca-live', ['FITC-A', LOGICLE_BD], 900, null, '#8b5cf6', 'CD19 positive: they respond to ionomycin, not to anti-CD3.'),
      ],
    },
  };
}

// --- Plates: a T-cell activation screen and a cytokine bead assay --------------------------------

// The screen: PBMC stimulated with anti-CD3/CD28 in the presence of six compounds, ten 3-fold
// doses each, one file per well of a 96-well plate. Activated T cells express CD69.
const SCREEN_PANEL = [
  { marker: 'CD69', fluor: 'PE', detector: 'PE-A' },
  { marker: 'CD3', fluor: 'APC', detector: 'APC-A' },
  { marker: 'Viability', fluor: 'Aqua', detector: 'BV510-A' },
];

// Activated share of live T cells in stimulated (vehicle) and unstimulated wells; each well's share
// varies by a log-normal factor (wellCV); CD69 of resting and activated T cells (log-normal).
const SCREEN = { stimulated: 0.62, unstimulated: 0.04, wellCV: 0.05, resting: [250, 0.5], activated: [9000, 0.4], plate: 'Screen plate 1', plateId: 'SCR-0001' };

// Each compound inhibits activation: share = stimulated − inhibition × (stimulated − unstimulated)
// × dose^h / (ic50^h + dose^h), with inhibition 1 for a full inhibitor.
export const SCREEN_COMPOUNDS = [
  { name: 'CW-101', ic50: 30, hill: 1.0, inhibition: 1 },
  { name: 'CW-102', ic50: 350, hill: 1.6, inhibition: 1 },
  { name: 'CW-103', ic50: 4, hill: 0.8, inhibition: 1 },
  { name: 'CW-104', ic50: 120, hill: 1.2, inhibition: 0.55 },
  { name: 'CW-105', ic50: null, hill: null, inhibition: 0 },
  { name: 'CW-106', ic50: 25000, hill: 1.1, inhibition: 1 },
];

// Doses (nM) of columns 1–10: 10 µM down in 3-fold steps.
export const SCREEN_DOSES = Array.from({ length: 10 }, (_, k) => +(10000 / 3 ** k).toPrecision(4));

// The expected activated share of a compound at a dose (before the well's own variation).
export function screenShare(compound, dose) {
  const span = SCREEN.stimulated - SCREEN.unstimulated;
  if (!compound || !compound.inhibition || !(dose > 0)) return SCREEN.stimulated;
  const occupied = dose ** compound.hill / (compound.ic50 ** compound.hill + dose ** compound.hill);
  return SCREEN.stimulated - compound.inhibition * span * occupied;
}

// The compound's curve in drc's LL.4 terms, on the % CD69+ of T cells.
export function screenTruth(compound) {
  if (!compound.inhibition) return null;
  return { b: compound.hill, c: 100 * (SCREEN.stimulated - compound.inhibition * (SCREEN.stimulated - SCREEN.unstimulated)), d: 100 * SCREEN.stimulated, e: compound.ic50, f: 1 };
}

const ROWS = 'ABCDEFGH';

function screenDesign(scale) {
  const wells = [];
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 12; c += 1) {
      const well = `${ROWS[r]}${String(c + 1).padStart(2, '0')}`;
      const annotations = {};
      let state;
      if (r < 6 && c < 10) {
        state = { compound: SCREEN_COMPOUNDS[r].name, dose: SCREEN_DOSES[c] };
        annotations.compound = SCREEN_COMPOUNDS[r].name;
        annotations.dose = `${SCREEN_DOSES[c]} nM`;
      } else if ((r < 6 && c === 10) || r === 6) {
        state = { control: 'positive' };
        annotations.control = 'positive';
        annotations.compound = 'DMSO';
      } else {
        state = { control: 'negative' };
        annotations.control = 'negative';
        annotations.compound = 'Unstimulated';
      }
      wells.push({ name: `Plate1_${well}.fcs`, well, row: r, column: c, ...state, annotations, events: eventsFor(6000, scale, 1000), role: 'sample', subject: 'D01', batch: 'B1' });
    }
  }
  return wells;
}

function* generateScreen(ctx, samples, all) {
  ctx.schedule(1500, all);
  const instrument = INSTRUMENTS.fortessa;
  const panel = buildPanel(instrument, SCREEN_PANEL);
  const cd69 = 2 + panel.markers.indexOf('CD69');
  const files = [];
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    const random = ctx.random(sample.name);
    const { specs, weights } = pbmcComposition(ctx, sample.subject);
    const populations = compilePopulations(specs, panel.markers);
    const isT = specs.map((spec) => T_CELL.test(spec.name));
    const compound = SCREEN_COMPOUNDS.find((c) => c.name === sample.compound);
    const expected = sample.control === 'negative' ? SCREEN.unstimulated : sample.control === 'positive' ? SCREEN.stimulated : screenShare(compound, sample.dose);
    // The well's own share: a log-normal factor on the activated share.
    const g = createNormal(ctx.random(sample.name, 'well'));
    const share = Math.min(1, expected * Math.exp(SCREEN.wellCV * g() - SCREEN.wellCV ** 2 / 2));
    const activated = new Uint8Array(sample.events);
    let tCells = 0;
    let tActivated = 0;
    const modulate = (e, t, kind, p, amt, normal, rand) => {
      if (kind !== 'live' || !isT[p]) return;
      tCells += 1;
      if (rand() < share) {
        activated[e] = 1;
        tActivated += 1;
        amt[cd69] = SCREEN.activated[0] * Math.exp(SCREEN.activated[1] * normal());
      } else {
        amt[cd69] = SCREEN.resting[0] * Math.exp(SCREEN.resting[1] * normal());
      }
    };
    const sim = simulateEvents({
      count: sample.events,
      instrument,
      panel,
      populations,
      weights,
      mix: { dead: 0.06, debris: 0.05, doublets: 0.03 },
      viability: 'Viability',
      rate: 1500,
      modulate,
    }, random, { signal: ctx.signal });
    files.push(flowFile(ctx, sample, sim, {
      instrument,
      panel,
      date: '2026-05-12',
      assignments: SCREEN_PANEL,
      keywords: { $PLATEID: SCREEN.plateId, $PLATENAME: SCREEN.plate, $WELLID: sample.well },
      truth: {
        activated,
        screen: { compound: sample.compound ?? null, dose: sample.dose ?? null, control: sample.control ?? null, expectedShare: expected, wellShare: share, tCells, tActivated, percent: tCells ? (100 * tActivated) / tCells : null },
      },
    }));
    yield;
  }
  const channels = bdChannels(SCREEN_PANEL);
  const transforms = channelTransforms(channels, () => LOGICLE_BD, 262144, 65536);
  const fsc = ['FSC-A', LINEAR_BD];
  const ssc = ['SSC-A', LINEAR_BD];
  return {
    files,
    workspaceHints: {
      groups: [{ name: 'Screen plate 1', color: '#0ea5e9', files: samples.map((s) => s.name) }],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([k, v]) => [k, { transform: v }])),
      suggestedGates: [
        polygonGate('gsim-scr-lymph', 'Lymphocytes', null, fsc, ssc, [[33000, 1000], [92000, 1000], [95000, 34000], [40000, 36000]], '#3b82f6', 'FSC/SSC lymphocyte region.'),
        rangeGate('gsim-scr-live', 'Live', 'gsim-scr-lymph', ['BV510-A', LOGICLE_BD], null, 2000, '#10b981', 'Viability dye negative.'),
        rangeGate('gsim-scr-t', 'T cells', 'gsim-scr-live', ['APC-A', LOGICLE_BD], 6000, null, '#ef4444', 'CD3 positive.'),
        rangeGate('gsim-scr-cd69', 'CD69+', 'gsim-scr-t', ['PE-A', LOGICLE_BD], 1500, null, '#f59e0b', 'Activated: CD69 positive.'),
      ],
    },
  };
}

// The bead assay: a LEGENDplex-like 8-plex of cytokines. Capture beads of two sizes (A smaller, B
// larger), four analytes each at their own APC level, and a PE reporter whose intensity follows
// each analyte's concentration on a five-parameter logistic curve. Standards C7 (10 000 pg/mL) to
// C1 in 4-fold steps and C0 (assay buffer) in duplicate in columns 1–2, and 20 sera, diluted 2-fold,
// in duplicate in columns 3–7.
const BEAD_ASSAY_PANEL = [
  { marker: 'Reporter', fluor: 'PE', detector: 'PE-A', label: 'PE (reporter)' },
  { marker: 'Classifier', fluor: 'APC', detector: 'APC-A', label: 'APC (bead ID)' },
];

// Per analyte: bead group and APC signal of its bead; reporter MFI (PE-A signal) against pg/mL as
// bottom + (top − bottom) / (1 + (ec/x)^hill)^asym (drc LL.5 with b = −hill, c = bottom, d = top,
// e = ec, f = asym); a population's serum level (log-normal, pg/mL), and the share of sera with the
// analyte raised tenfold.
export const BEAD_ANALYTES = [
  { name: 'IL-2', group: 'A', apc: 900, bottom: 45, top: 52000, ec: 6000, hill: 1.05, asym: 0.8, serum: [15, 1.2], raised: 0.2 },
  { name: 'IL-4', group: 'A', apc: 3200, bottom: 38, top: 47000, ec: 4500, hill: 0.95, asym: 1.0, serum: [8, 1.0], raised: 0.1 },
  { name: 'IL-6', group: 'A', apc: 11000, bottom: 52, top: 60000, ec: 8000, hill: 1.1, asym: 0.7, serum: [40, 1.3], raised: 0.3 },
  { name: 'IL-10', group: 'A', apc: 38000, bottom: 41, top: 44000, ec: 5200, hill: 1.0, asym: 1.2, serum: [12, 1.1], raised: 0.2 },
  { name: 'IL-17A', group: 'B', apc: 1100, bottom: 35, top: 50000, ec: 7000, hill: 0.9, asym: 0.9, serum: [6, 1.0], raised: 0.15 },
  { name: 'IFN-γ', group: 'B', apc: 3800, bottom: 48, top: 56000, ec: 5500, hill: 1.15, asym: 0.75, serum: [25, 1.3], raised: 0.25 },
  { name: 'TNF-α', group: 'B', apc: 13000, bottom: 44, top: 48000, ec: 6500, hill: 1.0, asym: 1.1, serum: [20, 1.1], raised: 0.25 },
  { name: 'IL-1β', group: 'B', apc: 42000, bottom: 39, top: 46000, ec: 4800, hill: 1.05, asym: 0.85, serum: [5, 1.2], raised: 0.1 },
];

export const BEAD_STANDARDS = { top: 10000, factor: 4, levels: 7, unit: 'pg/mL', dilution: 2 };

const BEAD_SIZES = { A: { fsc: [38000, 0.035], ssc: [6500, 0.05] }, B: { fsc: [62000, 0.035], ssc: [16000, 0.05] } };

// The reporter signal of a bead of `analyte` at concentration x (pg/mL), before photon noise.
export function beadSignal(analyte, x) {
  if (!(x > 0)) return analyte.bottom;
  return analyte.bottom + (analyte.top - analyte.bottom) / (1 + (analyte.ec / x) ** analyte.hill) ** analyte.asym;
}

// The serum concentrations of specimen k (deterministic from the seed).
function beadSerum(ctx, k) {
  const random = ctx.random('serum', k);
  const g = createNormal(random);
  return Object.fromEntries(BEAD_ANALYTES.map((a) => {
    const raised = random() < a.raised ? 10 : 1;
    return [a.name, +(a.serum[0] * raised * Math.exp(a.serum[1] * g())).toPrecision(5)];
  }));
}

function beadAssayDesign(scale) {
  const wells = [];
  for (let level = 0; level <= BEAD_STANDARDS.levels; level += 1) {
    for (let c = 0; c < 2; c += 1) {
      const well = `${ROWS[level]}${String(c + 1).padStart(2, '0')}`;
      wells.push({ name: `Plate1_${well}.fcs`, well, standard: `C${level}`, annotations: { standard: `C${level}` } });
    }
  }
  for (let k = 0; k < 20; k += 1) {
    for (let rep = 0; rep < 2; rep += 1) {
      // Specimens fill columns 3–7 down the rows, each in two adjacent wells.
      const slot = 2 * k + rep;
      const row = slot % 8;
      const column = 2 + Math.floor(slot / 8);
      const well = `${ROWS[row]}${String(column + 1).padStart(2, '0')}`;
      const specimen = `S${String(k + 1).padStart(2, '0')}`;
      wells.push({ name: `Plate1_${well}.fcs`, well, specimen: k, annotations: { specimen, dilution: String(BEAD_STANDARDS.dilution) } });
    }
  }
  return wells.map((w) => ({ ...w, events: eventsFor(4000, scale, 800), role: 'sample', subject: 'Sera', batch: 'B1' }));
}

function* generateBeadAssay(ctx, samples, all) {
  ctx.schedule(1200, all);
  const instrument = INSTRUMENTS.fortessa;
  const panel = buildPanel(instrument, BEAD_ASSAY_PANEL);
  const nDet = panel.detectors.length;
  const reporter = 2 + panel.markers.indexOf('Reporter');
  const classifier = 2 + panel.markers.indexOf('Classifier');
  // Emitter amounts that give the wanted signals at each dye's own detector.
  const peak = (row) => Math.max(...Array.from({ length: nDet }, (_, j) => panel.emitters[row * nDet + j]));
  const pePeak = peak(reporter);
  const apcPeak = peak(classifier);
  const specs = BEAD_ANALYTES.map((a) => ({ name: `${a.group}: ${a.name}`, ...BEAD_SIZES[a.group], af: 0.05, afSD: 0.15, markers: { Classifier: [a.apc / apcPeak, 0.07], Reporter: [1, 0] }, loading: { Classifier: 0, Reporter: 0 } }));
  const populations = compilePopulations(specs, panel.markers, { stained: new Set(['Classifier', 'Reporter']) });
  const files = [];
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    const level = sample.standard !== undefined ? Number(sample.standard.slice(1)) : null;
    const standardConcentration = level === null ? null : level === 0 ? 0 : BEAD_STANDARDS.top / BEAD_STANDARDS.factor ** (BEAD_STANDARDS.levels - level);
    const serum = sample.specimen !== undefined ? beadSerum(ctx, sample.specimen) : null;
    // Concentrations in the well (sera diluted), per analyte.
    const inWell = BEAD_ANALYTES.map((a) => (serum ? serum[a.name] / BEAD_STANDARDS.dilution : standardConcentration));
    const signals = BEAD_ANALYTES.map((a, k) => beadSignal(a, inWell[k]));
    const modulate = (e, t, kind, p, amt, normal) => {
      if (kind !== 'live') return;
      // Bead-to-bead variation of the captured reporter (log-normal, CV ≈ 12%).
      amt[reporter] = (signals[p] / pePeak) * Math.exp(0.12 * normal());
    };
    const sim = simulateEvents({
      count: sample.events,
      instrument,
      panel,
      populations,
      weights: Float64Array.from(BEAD_ANALYTES, () => 1),
      mix: { dead: 0, debris: 0.04, doublets: 0.04 },
      debris: BEAD_DEBRIS,
      viability: null,
      rate: 1200,
      modulate,
    }, ctx.random(sample.name), { signal: ctx.signal });
    files.push(flowFile(ctx, sample, sim, {
      instrument,
      panel,
      date: '2026-06-02',
      assignments: BEAD_ASSAY_PANEL,
      keywords: { $PLATEID: 'LP-0001', $PLATENAME: 'Cytokine plate 1', $WELLID: sample.well },
      truth: {
        beads: {
          standard: sample.standard ?? null,
          concentrations: Object.fromEntries(BEAD_ANALYTES.map((a, k) => [a.name, inWell[k]])),
          serum,
          signals: Object.fromEntries(BEAD_ANALYTES.map((a, k) => [a.name, signals[k]])),
        },
      },
    }));
    yield;
  }
  const channels = bdChannels(BEAD_ASSAY_PANEL);
  const transforms = channelTransforms(channels, () => LOGICLE_BD, 262144, 65536);
  const fsc = ['FSC-A', LINEAR_BD];
  const ssc = ['SSC-A', LINEAR_BD];
  return {
    files,
    workspaceHints: {
      groups: [{ name: 'Cytokine plate 1', color: '#a855f7', files: samples.map((s) => s.name) }],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([k, v]) => [k, { transform: v }])),
      suggestedGates: [
        polygonGate('gsim-bead-a', 'Beads A', null, fsc, ssc, [[30000, 4500], [46000, 4500], [46000, 9000], [30000, 9000]], '#3b82f6', 'The smaller beads (analytes A).'),
        polygonGate('gsim-bead-b', 'Beads B', null, fsc, ssc, [[52000, 12000], [74000, 12000], [74000, 21000], [52000, 21000]], '#ef4444', 'The larger beads (analytes B).'),
      ],
    },
  };
}

// --- 5. Mass cytometry cohort (Helios-like) -----------------------------------------------------

const CYTOF_CHANNELS = [
  ['Y', 89, 'CD45'], ['Ce', 140, null, 'bead'], ['Pr', 141, 'CD294'], ['Nd', 143, 'CD123'], ['Nd', 144, 'CD19'],
  ['Nd', 145, 'CD4'], ['Nd', 146, 'CD8'], ['Sm', 147, 'CD11c'], ['Nd', 148, 'CD16'], ['Sm', 149, 'CD45RO'],
  ['Nd', 150, 'CD45RA'], ['Eu', 151, null, 'bead'], ['Sm', 152, 'TCRgd'], ['Eu', 153, null, 'bead'], ['Sm', 154, 'CD3'],
  ['Gd', 155, 'CD27'], ['Gd', 156, 'CD25'], ['Gd', 158, 'CD127'], ['Tb', 159, 'CD161'], ['Gd', 160, 'CD14'],
  ['Dy', 161, 'IgD'], ['Dy', 163, 'CD57'], ['Dy', 164, 'CD66b'], ['Ho', 165, null, 'bead'], ['Er', 167, 'CCR7'],
  ['Er', 168, 'CD38'], ['Tm', 169, 'CD20'], ['Yb', 174, 'HLA-DR'], ['Lu', 175, null, 'bead'], ['Yb', 176, 'CD56'],
  ['Ir', 191, 'DNA1', 'dna1'], ['Ir', 193, 'DNA2', 'dna2'], ['Pt', 195, 'Cisplatin', 'viability'],
].map(([element, mass, marker, role]) => ({
  name: `${element}${mass}Di`,
  label: marker ? `${mass}${element}_${marker}` : `${mass}${element}`,
  mass,
  marker: role === 'viability' ? 'Viability' : marker,
  role: role ?? 'marker',
}));

const CYTOF_MARKERS = [...CYTOF_CHANNELS.filter((c) => c.role === 'marker').map((c) => c.marker), 'Viability'];
// EQ four-element calibration beads (Ce, Eu, Ho, Lu); 176Lu (2.6 % of Lu) shows in Yb176Di.
const CYTOF_BEADS = { Ce140Di: 1800, Eu151Di: 1500, Eu153Di: 1650, Ho165Di: 2600, Lu175Di: 2400, Yb176Di: 64 };
const HELIOS = { id: 'helios', cyt: 'Helios (CytoWeave simulation)', serial: 'SIM-H0000005', timestep: 0.001, flowRate: 30, range: 16384 };
const CYTOF_DIFFERENTIAL = { population: 'Non-classical monocytes', fold: 2, condition: 'Case' };

function cytofDesign(scale) {
  const samples = [];
  const plan = [['Batch1', ['S01', 'S02', 'S03', 'S04']], ['Batch2', ['S05', 'S06', 'S07', 'S08']]];
  for (const [batch, subjects] of plan) {
    const tag = batch === 'Batch1' ? 'B1' : 'B2';
    samples.push({ name: `${tag}_Anchor.fcs`, events: eventsFor(25000, scale), role: 'reference', condition: 'Reference', subject: 'Anchor', batch });
    subjects.forEach((subject, i) => samples.push({ name: `${tag}_${subject}.fcs`, events: eventsFor(25000, scale), role: 'sample', condition: i < 2 ? 'Control' : 'Case', subject, batch }));
  }
  return samples;
}

// Batch 2: lower instrument sensitivity per channel (affects beads too), different staining per
// marker (antibody lot, incubation), and a higher ion background (an additive shift).
function batchFactors(ctx, batch) {
  if (batch === 'Batch1') return { channelFactors: null, markerFactors: null, background: 0.15 };
  const random = ctx.random('batch', batch);
  const channelFactors = {};
  for (const c of CYTOF_CHANNELS) channelFactors[c.name] = 0.82 * Math.exp(0.1 * random.gaussian());
  const markerFactors = {};
  for (const marker of CYTOF_MARKERS) markerFactors[marker] = Math.exp(0.18 * random.gaussian());
  return { channelFactors, markerFactors, background: 0.35 };
}

function* generateCytof(ctx, samples, all) {
  ctx.schedule(350, all);
  const files = [];
  const frequencies = {};
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    const factors = sample.condition === 'Case' ? { [CYTOF_DIFFERENTIAL.population]: CYTOF_DIFFERENTIAL.fold } : {};
    const { specs, weights } = pbmcComposition(ctx, sample.subject, { factors });
    const populations = compilePopulations(specs, CYTOF_MARKERS, { background: [150, 0.7] });
    const batch = batchFactors(ctx, sample.batch);
    const sampleFactors = donorMarkerFactors(ctx, sample.name, CYTOF_MARKERS, 0.04);
    const markerFactors = {};
    for (const marker of CYTOF_MARKERS) markerFactors[marker] = (batch.markerFactors?.[marker] ?? 1) * sampleFactors[marker];
    const sim = simulateMassEvents({
      count: sample.events,
      channels: CYTOF_CHANNELS,
      populations,
      weights,
      markers: CYTOF_MARKERS,
      mix: { dead: 0.06, debris: 0.05, doublets: 0.05, beads: 0.03 },
      rate: 350,
      drift: 0.25,
      channelFactors: batch.channelFactors,
      markerFactors,
      beadLevels: CYTOF_BEADS,
      background: batch.background,
      range: HELIOS.range,
    }, ctx.random(sample.name), { signal: ctx.signal });
    const order = ['Time', 'Event_length', ...CYTOF_CHANNELS.map((c) => c.name), 'Center', 'Offset', 'Width', 'Residual'];
    const columns = { Time: sim.time, Event_length: sim.eventLength, Center: sim.center, Offset: sim.offset, Width: sim.width, Residual: sim.residual };
    CYTOF_CHANNELS.forEach((c, j) => { columns[c.name] = sim.channels[j]; });
    const total = {};
    for (const [name, w] of treeWeightsFor(weights, specs)) total[name] = w;
    frequencies[sample.name] = total;
    const flat = { columns, order, labels: sim.labels, labelNames: sim.labelNames, duration: sim.duration };
    const labels = Object.fromEntries(CYTOF_CHANNELS.map((c) => [c.name, c.label]));
    const ranges = { Event_length: 256, Center: HELIOS.range, Offset: HELIOS.range, Width: HELIOS.range, Residual: HELIOS.range };
    for (const c of CYTOF_CHANNELS) ranges[c.name] = HELIOS.range;
    files.push(flowFile(ctx, sample, flat, {
      instrument: { ...HELIOS, scatter: [] },
      panel: null,
      date: sample.batch === 'Batch1' ? '2026-04-07' : '2026-04-21',
      labels,
      ranges,
      truth: { differential: sample.condition === 'Case' ? CYTOF_DIFFERENTIAL : null, expectedFrequencies: total, drift: 0.25 },
    }));
    yield;
  }
  const transforms = {};
  for (const c of [{ name: 'Time' }, { name: 'Event_length' }, ...CYTOF_CHANNELS, { name: 'Center' }, { name: 'Offset' }, { name: 'Width' }, { name: 'Residual' }]) {
    if (c.mass) transforms[c.name] = ARCSINH_MASS;
    else transforms[c.name] = c.name === 'Time' ? linear(1 << 18) : c.name === 'Event_length' ? linear(100) : linear(2000);
  }
  return {
    files,
    workspaceHints: {
      groups: [
        { name: 'Batch 1', color: '#3b82f6', files: samples.filter((s) => s.batch === 'Batch1').map((s) => s.name) },
        { name: 'Batch 2', color: '#f59e0b', files: samples.filter((s) => s.batch === 'Batch2').map((s) => s.name) },
        { name: 'Control', color: '#22c55e', files: samples.filter((s) => s.condition === 'Control').map((s) => s.name) },
        { name: 'Case', color: '#ef4444', files: samples.filter((s) => s.condition === 'Case').map((s) => s.name) },
        { name: 'Anchors', color: '#64748b', files: samples.filter((s) => s.role === 'reference').map((s) => s.name) },
      ],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([k, v]) => [k, { transform: v }])),
      normalization: { beads: Object.keys(CYTOF_BEADS).filter((k) => k !== 'Yb176Di'), anchors: { Batch1: 'B1_Anchor.fcs', Batch2: 'B2_Anchor.fcs' } },
      suggestedGates: [
        rangeGate('gsim-nonbeads', 'Non-beads', null, ['Ce140Di', ARCSINH_MASS], null, 60, '#64748b', 'EQ beads are bright in Ce140Di.'),
        polygonGate('gsim-dna', 'Intact cells', 'gsim-nonbeads', ['Ir191Di', ARCSINH_MASS], ['Ir193Di', ARCSINH_MASS], [[120, 200], [900, 200], [900, 1500], [120, 1500]], '#0ea5e9', 'DNA (iridium intercalator) positive.'),
        rangeGate('gsim-length', 'Singlets', 'gsim-dna', ['Event_length', linear(100)], 10, 36, '#22c55e', 'Doublets have long event length.'),
        rangeGate('gsim-live', 'Live', 'gsim-length', ['Pt195Di', ARCSINH_MASS], null, 25, '#a855f7', 'Cisplatin negative.'),
      ],
    },
  };
}

// Expected live-cell frequencies (leaf name → fraction) from compiled weights.
function treeWeightsFor(weights, specs) {
  const out = new Map();
  let sum = 0;
  for (let i = 0; i < weights.length; i += 1) sum += weights[i];
  specs.forEach((spec, i) => out.set(spec.name, (out.get(spec.name) ?? 0) + weights[i] / sum));
  return out;
}

// --- 5b. Barcoded mass cytometry plate (palladium 6-choose-3) ----------------------------------
//
// Twenty samples (ten donors, unstimulated and anti-CD3/CD28-stimulated) are each labeled with
// three of six palladium isotopes (Zunder et al. 2015), pooled into one tube and acquired as one
// file. Doublets of two cells from different wells carry four to six palladium channels, which is
// what the debarcoder uses to remove them.

const PALLADIUM = [102, 104, 105, 106, 108, 110];
// Barcoding reagent levels per isotope (signal units; ~500–1000 counts on a positive cell).
const PALLADIUM_LEVELS = { 102: 6e5, 104: 9e5, 105: 1.1e6, 106: 1.2e6, 108: 1.1e6, 110: 1.0e6 };
const BARCODE_CHANNELS = [
  ...CYTOF_CHANNELS,
  ...PALLADIUM.map((mass) => ({ name: `Pd${mass}Di`, label: `${mass}Pd`, mass, marker: null, role: 'barcode' })),
].sort((a, b) => a.mass - b.mass);
const BARCODE_KEY = combinationKey(PALLADIUM.map((mass) => `Pd${mass}Di`), 3);
const BARCODE_DONORS = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10'];
// Code k (in the key's lexicographic order) is well k: donors in order, unstimulated then stimulated.
const BARCODE_WELLS = BARCODE_DONORS.flatMap((donor) => [`${donor}_Unstim`, `${donor}_Stim`]);

function barcodeKeyCSV() {
  const header = ['sample', ...PALLADIUM.map(String)].join(',');
  return [header, ...BARCODE_KEY.codes.map((code, i) => [BARCODE_WELLS[i], ...code.pattern].join(','))].join('\n');
}

function barcodedDesign(scale) {
  return [{ name: 'Plate1_barcoded.fcs', events: eventsFor(4000, scale, 100) * BARCODE_WELLS.length, role: 'sample', batch: 'Plate1' }];
}

function* generateBarcoded(ctx, samples) {
  const files = [];
  for (const sample of samples) {
    const perWell = Math.round(sample.events / BARCODE_WELLS.length);
    const levelsOf = (code) => Float64Array.from(BARCODE_CHANNELS, (c) => (c.role === 'barcode' && code.pattern[PALLADIUM.indexOf(c.mass)] ? PALLADIUM_LEVELS[c.mass] : 0));
    const levels = BARCODE_KEY.codes.map(levelsOf);
    const names = [];
    const parts = [];
    for (const [w, well] of BARCODE_WELLS.entries()) {
      ctx.check();
      ctx.onProgress?.(w / BARCODE_WELLS.length, `Simulating well ${well}`);
      const [donor, condition] = well.split('_');
      const { specs, weights } = pbmcComposition(ctx, donor, { stimulated: condition === 'Stim' });
      const populations = compilePopulations(specs, CYTOF_MARKERS, { background: [150, 0.7] });
      const random = ctx.random(sample.name, well);
      const sim = simulateMassEvents({
        count: perWell,
        channels: BARCODE_CHANNELS,
        populations,
        weights,
        markers: CYTOF_MARKERS,
        mix: { dead: 0.06, debris: 0.05, doublets: 0.07, beads: 0.02 },
        rate: 350,
        drift: 0,
        markerFactors: donorMarkerFactors(ctx, donor, CYTOF_MARKERS, 0.05),
        beadLevels: CYTOF_BEADS,
        background: 0.15,
        range: HELIOS.range,
        // The partner of a doublet comes from any of the 20 wells (the tube is mixed).
        barcode: { levels: levels[w], other: () => levels[Math.floor(random() * levels.length)] },
      }, random, { signal: ctx.signal });
      const labels = Int32Array.from(sim.labels, (l) => {
        const name = sim.labelNames[l];
        let index = names.indexOf(name);
        if (index < 0) {
          index = names.length;
          names.push(name);
        }
        return index;
      });
      parts.push({ sim, labels, well: w });
      yield;
    }
    // Pool: a random event order and one acquisition clock for the tube.
    const total = parts.reduce((sum, part) => sum + part.labels.length, 0);
    const random = ctx.random(sample.name, 'pool');
    const order = Uint32Array.from({ length: total }, (_, i) => i);
    for (let i = total - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const t = order[i];
      order[i] = order[j];
      order[j] = t;
    }
    const source = new Int32Array(total);
    const offset = new Int32Array(total);
    let k = 0;
    parts.forEach((part, p) => { for (let i = 0; i < part.labels.length; i += 1) { source[k] = p; offset[k] = i; k += 1; } });
    const take = (pick) => {
      const out = new Float32Array(total);
      for (let e = 0; e < total; e += 1) out[e] = pick(parts[source[order[e]]].sim, offset[order[e]]);
      return out;
    };
    const columns = {
      Event_length: take((sim, i) => sim.eventLength[i]),
      Center: take((sim, i) => sim.center[i]),
      Offset: take((sim, i) => sim.offset[i]),
      Width: take((sim, i) => sim.width[i]),
      Residual: take((sim, i) => sim.residual[i]),
    };
    BARCODE_CHANNELS.forEach((c, j) => { columns[c.name] = take((sim, i) => sim.channels[j][i]); });
    let t = 0;
    columns.Time = new Float32Array(total);
    for (let e = 0; e < total; e += 1) {
      t += -Math.log(1 - random()) / 350;
      columns.Time[e] = Math.floor(t * 1000);
    }
    const doublet = names.indexOf('Doublets');
    const bead = names.indexOf('Beads');
    const labels = new Int32Array(total);
    const wells = new Int16Array(total);
    for (let e = 0; e < total; e += 1) {
      const part = parts[source[order[e]]];
      const label = part.labels[offset[order[e]]];
      labels[e] = label;
      wells[e] = label === bead ? -1 : label === doublet ? -2 : part.well;
    }
    const channelOrder = ['Time', 'Event_length', ...BARCODE_CHANNELS.map((c) => c.name), 'Center', 'Offset', 'Width', 'Residual'];
    const ranges = { Event_length: 256, Center: HELIOS.range, Offset: HELIOS.range, Width: HELIOS.range, Residual: HELIOS.range };
    for (const c of BARCODE_CHANNELS) ranges[c.name] = HELIOS.range;
    files.push(flowFile(ctx, sample, { columns, order: channelOrder, labels, labelNames: names, duration: t }, {
      instrument: { ...HELIOS, scatter: [] },
      panel: null,
      date: '2026-05-12',
      labels: Object.fromEntries(BARCODE_CHANNELS.map((c) => [c.name, c.label])),
      ranges,
      truth: { wells, wellNames: BARCODE_WELLS },
    }));
  }
  const transforms = { Time: linear(1 << 20), Event_length: linear(100), Center: linear(2000), Offset: linear(2000), Width: linear(2000), Residual: linear(2000) };
  for (const c of BARCODE_CHANNELS) transforms[c.name] = ARCSINH_MASS;
  return {
    files,
    workspaceHints: {
      groups: [{ name: 'Pooled plate', color: '#64748b', files: samples.map((s) => s.name) }],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([name, transform]) => [name, { transform }])),
      barcodeKeys: Object.fromEntries(samples.map((s) => [s.name, barcodeKeyCSV()])),
      suggestedGates: [
        rangeGate('gsim-bc-nonbeads', 'Non-beads', null, ['Ce140Di', ARCSINH_MASS], null, 60, '#64748b', 'EQ beads are bright in Ce140Di.'),
        polygonGate('gsim-bc-dna', 'Intact cells', 'gsim-bc-nonbeads', ['Ir191Di', ARCSINH_MASS], ['Ir193Di', ARCSINH_MASS], [[120, 200], [900, 200], [900, 1500], [120, 1500]], '#0ea5e9', 'DNA (iridium intercalator) positive.'),
        rangeGate('gsim-bc-length', 'Singlets', 'gsim-bc-dna', ['Event_length', linear(100)], 10, 36, '#22c55e', 'Doublets have long event length.'),
        rangeGate('gsim-bc-live', 'Live', 'gsim-bc-length', ['Pt195Di', ARCSINH_MASS], null, 25, '#a855f7', 'Cisplatin negative.'),
      ],
    },
  };
}

// --- 6. Index sort (96-well plate) --------------------------------------------------------------
//
// Index-sorted events carry two event-level parameters, "Index X" (plate column 1–12) and
// "Index Y" (plate row 1–8, A = 1), so every sorted cell's measured values link to its well.
// The INDEX SORTING LOCATIONS keyword repeats the positions as "row,column;" pairs (0-based) in
// event order, modeled on how BD FACSDiva records index sorts.

const SORT_PANEL = [
  { marker: 'CD19', fluor: 'BV421', detector: 'BV421-A' },
  { marker: 'Viability', fluor: 'Aqua', detector: 'BV510-A' },
  { marker: 'CD3', fluor: 'FITC', detector: 'FITC-A' },
  { marker: 'CD27', fluor: 'PE', detector: 'PE-A' },
  { marker: 'CD38', fluor: 'PE-Cy7', detector: 'PE-Cy7-A' },
  { marker: 'IgD', fluor: 'APC', detector: 'APC-A' },
];

// Plate layout: columns 1–5 memory B, 6–8 naive B, 9–11 plasmablasts, column 12 rows A–G T cells
// (positive controls), H12 left empty (no-cell control). Gates are on compensated values; every
// sort also requires viability (BV510-A) < 1500.
const SORT_TARGETS = [
  { population: 'Memory B', columns: [1, 2, 3, 4, 5], gate: { 'BV421-A': [3000, null], 'FITC-A': [null, 1500], 'PE-A': [2500, null], 'APC-A': [null, 1500], 'PE-Cy7-A': [null, 8000] } },
  { population: 'Naive B', columns: [6, 7, 8], gate: { 'BV421-A': [3000, null], 'FITC-A': [null, 1500], 'PE-A': [null, 1000], 'APC-A': [3000, null] } },
  { population: 'Plasmablasts', columns: [9, 10, 11], gate: { 'BV421-A': [1500, null], 'PE-A': [12000, null], 'PE-Cy7-A': [20000, null] } },
  { population: 'T cells', columns: [12], rows: 7, gate: { 'FITC-A': [4000, null], 'BV421-A': [null, 1500] } },
];

function indexSortDesign(scale) {
  return [
    { name: 'Presort.fcs', events: eventsFor(50000, scale), role: 'sample', condition: 'Presort (B-cell enriched PBMC)', subject: 'D01', batch: 'B1' },
    { name: 'Plate1_IndexSort.fcs', events: 95, role: 'sample', condition: 'Index sort', subject: 'D01', batch: 'B1', plate: 'Plate1' },
  ];
}

function* generateIndexSort(ctx, samples, all) {
  ctx.schedule(8000, all);
  const instrument = INSTRUMENTS.aria;
  const panel = buildPanel(instrument, SORT_PANEL);
  const files = [];
  const boost = { 'Naive B': 4, 'Memory B': 4, Plasmablasts: 6 };
  const plateKeywords = { $PLATEID: 'SIM-PLATE-0001', $PLATENAME: 'Plate1', 'INDEX SORTING DEVICE TYPE': '96 Well - U bottom', 'SORT PRECISION MODE': 'Single Cell' };
  const byName = Object.fromEntries(PBMC_POPULATIONS.map((p) => [p.name, p]));
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    if (!sample.plate) {
      const { specs, weights } = pbmcComposition(ctx, sample.subject, { boost });
      const populations = compilePopulations(specs, panel.markers);
      const sim = simulateEvents({ count: sample.events, instrument, panel, populations, weights, mix: PBMC_MIX, viability: 'Viability', rate: 8000 }, ctx.random(sample.name), { signal: ctx.signal });
      files.push(flowFile(ctx, sample, sim, { instrument, panel, date: '2026-06-09', assignments: SORT_PANEL, spill: panel.spill, keywords: { 'SORT MODE': 'Presort analysis' } }));
      yield;
      continue;
    }
    // Sorted cells: draw candidates from each target population and keep those inside the sort gate.
    const random = ctx.random(sample.name);
    const sorted = [];
    for (const target of SORT_TARGETS) {
      const wells = [];
      for (const col of target.columns) for (let row = 0; row < (target.rows ?? 8); row += 1) wells.push([row, col]);
      wells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
      const specs = target.population === 'T cells' ? [byName['CD4 naive T'], byName['CD8 naive T']] : [byName[target.population]];
      const populations = compilePopulations(specs, panel.markers);
      let attempt = 0;
      const picked = [];
      while (picked.length < wells.length && attempt < 20) {
        const sim = simulateEvents({ count: 400, instrument, panel, populations, weights: Float64Array.from(specs.map(() => 1)), mix: {}, viability: 'Viability', rate: 8000 }, ctx.random(sample.name, target.population, attempt), {});
        // The sorter gates on compensated values.
        const comp = compensate(sim.columns, panel.spill);
        for (let e = 0; e < 400 && picked.length < wells.length; e += 1) {
          let inside = comp['BV510-A'][e] < 1500;
          for (const [channel, [lo, hi]] of Object.entries(target.gate)) {
            const v = comp[channel][e];
            if ((lo !== null && v < lo) || (hi !== null && v >= hi)) inside = false;
          }
          if (inside) picked.push(Object.fromEntries(sim.order.map((name) => [name, sim.columns[name][e]])));
        }
        attempt += 1;
      }
      picked.forEach((values, i) => sorted.push({ values, well: wells[i], population: target.population }));
    }
    // Sort order: the plate is filled row by row (A1, A2, … H11).
    sorted.sort((a, b) => a.well[0] - b.well[0] || a.well[1] - b.well[1]);
    const order = ['FSC-A', 'FSC-H', 'FSC-W', 'SSC-A', 'SSC-H', 'SSC-W', ...SORT_PANEL.map((a) => a.detector), 'Time', 'Index X', 'Index Y'];
    const n = sorted.length;
    const columns = Object.fromEntries(order.map((name) => [name, new Float32Array(n)]));
    let t = 0;
    const populationNames = SORT_TARGETS.map((s) => s.population);
    const labels = new Int32Array(n);
    sorted.forEach((cell, i) => {
      t += 0.9 + 0.6 * random();
      for (const name of order) if (name in cell.values) columns[name][i] = cell.values[name];
      columns.Time[i] = Math.floor(t / instrument.timestep);
      columns['Index X'][i] = cell.well[1];
      columns['Index Y'][i] = cell.well[0] + 1;
      labels[i] = populationNames.indexOf(cell.population);
    });
    const wells = sorted.map((cell) => `${'ABCDEFGH'[cell.well[0]]}${cell.well[1]}`);
    const sim = { columns, order, labels, labelNames: populationNames, duration: t };
    files.push(flowFile(ctx, sample, sim, {
      instrument,
      panel,
      date: '2026-06-09',
      assignments: SORT_PANEL,
      spill: panel.spill,
      labels: { 'Index X': 'Plate column (1-12)', 'Index Y': 'Plate row (1-8, A=1)' },
      ranges: { 'Index X': 16, 'Index Y': 16 },
      keywords: { ...plateKeywords, 'INDEX SORTING LOCATIONS': sorted.map((cell) => `${cell.well[0]},${cell.well[1] - 1}`).join(';') + ';', 'INDEX SORTING SORTED LOCATION COUNT': String(n) },
      truth: { wells, emptyWells: ['H12'], gates: Object.fromEntries(SORT_TARGETS.map((s) => [s.population, s.gate])) },
    }));
    yield;
  }
  const transforms = channelTransforms(bdChannels(SORT_PANEL), () => LOGICLE_BD, 262144, 65536);
  transforms['Index X'] = linear(13);
  transforms['Index Y'] = linear(9);
  return {
    files,
    workspaceHints: {
      groups: [{ name: 'Index sort', color: '#0ea5e9', files: samples.map((s) => s.name) }],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([k, v]) => [k, { transform: v }])),
      indexSort: { file: 'Plate1_IndexSort.fcs', reference: 'Presort.fcs', columnChannel: 'Index X', rowChannel: 'Index Y', plate: { rows: 8, columns: 12 } },
      compensation: { fromFile: '$SPILLOVER' },
    },
  };
}

// --- 7. QC showcase (plate-based acquisition with fluidic problems) -----------------------------

const QC_PANEL = [
  { marker: 'Viability', fluor: 'Aqua', detector: 'BV510-A' },
  { marker: 'CD3', fluor: 'BV605', detector: 'BV605-A' },
  { marker: 'CD19', fluor: 'BV711', detector: 'BV711-A' },
  { marker: 'CD45', fluor: 'BV786', detector: 'BV786-A' },
  { marker: 'CD14', fluor: 'PerCP-Cy5.5', detector: 'PerCP-Cy5-5-A' },
  { marker: 'CD8', fluor: 'APC', detector: 'APC-A' },
  { marker: 'CD4', fluor: 'Alexa Fluor 700', detector: 'Alexa Fluor 700-A' },
];

const QC_PROBLEMS = {
  none: { anomalies: [], drift: null },
  clog: { anomalies: CLOG, drift: null },
  drift: { anomalies: [], drift: { fluorescence: -0.4, scatter: -0.1 } },
  burst: { anomalies: [{ kind: 'air bubble', at: 0.62, length: 0.04, rate: 6, signal: 0.5, scatter: 0.6, cv: 0.4, junk: 0.65 }], drift: null },
};

function qcDesign(scale) {
  return [['A01', 'none'], ['A02', 'clog'], ['A03', 'drift'], ['A04', 'burst']].map(([well, anomaly]) => ({ name: `${well}.fcs`, events: eventsFor(40000, scale), role: 'sample', condition: 'QC', subject: 'D02', batch: 'B1', well, anomaly }));
}

function* generateQC(ctx, samples, all) {
  ctx.schedule(2000, all);
  const instrument = INSTRUMENTS.fortessa;
  const panel = buildPanel(instrument, QC_PANEL);
  const files = [];
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    const { specs, weights } = pbmcComposition(ctx, sample.subject);
    const populations = compilePopulations(specs, panel.markers);
    const problem = QC_PROBLEMS[sample.anomaly];
    const sim = simulateEvents({ count: sample.events, instrument, panel, populations, weights, mix: PBMC_MIX, viability: 'Viability', rate: 2000, anomalies: problem.anomalies, drift: problem.drift }, ctx.random(sample.name), { signal: ctx.signal });
    files.push(flowFile(ctx, sample, sim, {
      instrument,
      panel,
      date: '2026-07-01',
      assignments: QC_PANEL,
      spill: panel.spill,
      keywords: { $WELLID: sample.well, $PLATEID: 'SIM-QC-PLATE-01', $PLATENAME: 'QC plate', 'HTS MODE': 'Standard' },
      truth: { anomaly: sim.anomaly, problem: sample.anomaly, anomalies: windowsTruth(sim, instrument), drift: problem.drift },
    }));
    yield;
  }
  const transforms = channelTransforms(bdChannels(QC_PANEL), () => LOGICLE_BD, 262144, 4096);
  return {
    files,
    workspaceHints: {
      groups: [{ name: 'QC plate', color: '#f59e0b', files: samples.map((s) => s.name) }],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([k, v]) => [k, { transform: v }])),
      compensation: { fromFile: '$SPILLOVER' },
    },
  };
}

// --- 10. Daily bead QC (instrument characterization) ------------------------------------------

// Spherotech-like 8-peak rainbow beads: the blank and seven levels, in brightness units (a
// detector's response converts them to its signal).
const BEAD_LEVELS = [0, 0.012, 0.035, 0.1, 0.3, 0.9, 2.6, 7.5];
const BEAD_CV0 = 0.02;
const BEAD_RUNS = 30;
const BEAD_EVENTS = {
  'BV421-A': { from: 21, what: 'PMT aging: Q falls 7 % per run' },
  'FITC-A': { from: 25, what: 'dirty flow cell: optical background ×5' },
  violet: { from: 27, what: 'violet laser at 70 % power: bead signals of the BV detectors fall 30 % (Q and B unchanged)' },
};

// Run dates: weekdays from 2026-03-02.
function beadRunDates() {
  const dates = [];
  const day = new Date(Date.UTC(2026, 2, 2));
  while (dates.length < BEAD_RUNS) {
    const wd = day.getUTCDay();
    if (wd !== 0 && wd !== 6) dates.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

function beadQCDesign(scale) {
  return beadRunDates().map((date, i) => ({ name: `Beads_${date}.fcs`, events: eventsFor(15000, scale, 2000), role: 'bead', condition: 'Daily QC', timepoint: `Run ${i + 1}`, date, run: i + 1 }));
}

// Each detector's state on each run: the fixed instrument (k, sigma), a response and stray-light
// background drawn once, day-to-day wobble, and the planted events.
function beadDetectors(ctx, run) {
  const fixed = ctx.random('bead-detectors');
  const wobble = ctx.random('bead-run', run);
  const gf = () => fixed.gaussian();
  const gw = () => wobble.gaussian();
  return INSTRUMENTS.fortessa.detectors.map((d) => {
    const response = 15000 * Math.exp(0.3 * gf());
    const background = 120 * Math.exp(0.5 * gf());
    let k = d.k * Math.exp(0.012 * gw());
    let r = response * Math.exp(0.015 * gw());
    let bg = background * Math.exp(0.05 * gw());
    if (d.name === 'BV421-A' && run >= BEAD_EVENTS['BV421-A'].from) k *= 1.07 ** (run - BEAD_EVENTS['BV421-A'].from + 1);
    if (d.name === 'FITC-A' && run >= BEAD_EVENTS['FITC-A'].from) bg *= 5;
    if (d.laser === 'V' && run >= BEAD_EVENTS.violet.from) r *= 0.7;
    return { name: d.name, k, sigma: d.sigma, background: bg, response: r };
  });
}

function* generateBeadQC(ctx, samples, all) {
  ctx.schedule(800, all);
  const instrument = INSTRUMENTS.fortessa;
  const files = [];
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    const detectors = beadDetectors(ctx, sample.run);
    const sim = simulateBeadRun({ count: sample.events, instrument, detectors, levels: BEAD_LEVELS, cv0: BEAD_CV0, rate: 800 }, ctx.random(sample.name), { signal: ctx.signal });
    const panel = { detectors: instrument.detectors };
    files.push(flowFile(ctx, sample, sim, {
      instrument,
      panel,
      date: sample.date,
      keywords: { 'BEADS': 'Rainbow 8-peak (simulated)', 'BEAD LOT': 'SIM-8P-0426' },
      truth: {
        run: sample.run,
        detectors: Object.fromEntries(detectors.map((d) => [d.name, { ...beadDetectorTruth(d, BEAD_CV0), brightMean: BEAD_LEVELS[BEAD_LEVELS.length - 1] * d.response }])),
      },
    }));
    yield;
  }
  const transforms = channelTransforms(bdChannels(beadQCAssignments()), () => LOGICLE_BD, 262144, 4096);
  return {
    files,
    workspaceHints: {
      groups: [{ name: 'Daily QC beads', color: '#f59e0b', files: samples.map((s) => s.name) }],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([k, v]) => [k, { transform: v }])),
    },
  };
}

function beadQCAssignments() {
  return INSTRUMENTS.fortessa.detectors.map((d) => ({ detector: d.name, marker: '', label: '' }));
}

// --- 11. Titration and a voltage walk (panel setup) -------------------------------------------

// CD4-PE titrated in two-fold steps on PBMC, then the PE detector walked through its voltages
// with cells stained at 125 ng. Binding follows occupancy c / (c + K); unbound antibody sticks to
// every cell in proportion to the amount (non-specific binding). Every fluorescence PMT is set to
// the tube's voltage, as in a voltage walk; its gain grows as (V / V0)^n from the detector's own
// voltage V0, and the electronic noise stays as it is.
export const TITRATION = Object.freeze({
  marker: 'CD4',
  detector: 'PE-A',
  kd: 5, // ng per test at which half the antigen is bound
  amounts: [1000, 500, 250, 125, 62.5, 31.25, 15.625, 7.8125, 3.90625, 1.953125],
  nonspecific: 0.15, // abundance per ng bound non-specifically to every cell
  walkAmount: 125,
  voltages: [300, 350, 400, 450, 500, 550, 600, 650, 700, 750],
  exponent: 7.4, // PMT gain ∝ V^n (BD CS&T baseline reports show slopes of 7.3–7.5)
});
const TITRATION_PANEL = [
  { marker: 'CD3', fluor: 'FITC', detector: 'FITC-A' },
  { marker: 'CD4', fluor: 'PE', detector: 'PE-A' },
  { marker: 'CD8', fluor: 'APC', detector: 'APC-A' },
];

// The cells, with CD4 bound at an amount of antibody (ng per test; 0 for unstained).
export function titrationPopulations(amount) {
  const occupancy = amount > 0 ? amount / (amount + TITRATION.kd) : 0;
  const specs = [
    population('CD4 T', LYMPH, { CD4: [4e4 * occupancy, 0.2] }),
    population('CD8 T', LYMPH, {}),
    population('B cells', { fsc: [57000, 0.1], ssc: [12000, 0.2], af: 1.1 }, {}),
    population('NK cells', { fsc: [62000, 0.1], ssc: [19000, 0.22], af: 1.15 }, {}),
    population('Monocytes', MONO, { CD4: [7e3 * occupancy, 0.35] }),
  ];
  return {
    specs,
    weights: [0.3, 0.15, 0.08, 0.08, 0.2],
    options: amount > 0 ? { stained: new Set(['CD4']), background: [TITRATION.nonspecific * amount, 0.6] } : { stained: new Set() },
    occupancy,
  };
}

// Gains of the fluorescence detectors with every PMT at one voltage.
export function walkGains(voltage, instrument = INSTRUMENTS.fortessa) {
  return Object.fromEntries(instrument.detectors.map((d) => [d.name, (voltage / d.voltage) ** TITRATION.exponent]));
}

function titrationDesign(scale) {
  const name = (a) => `CD4-PE ${+a.toPrecision(4)} ng.fcs`;
  return [
    { name: 'Unstained.fcs', events: eventsFor(20000, scale), role: 'unstained', condition: 'Titration', amount: 0 },
    ...TITRATION.amounts.map((a) => ({ name: name(a), events: eventsFor(20000, scale), role: 'sample', condition: 'Titration', amount: a })),
    ...TITRATION.voltages.map((v) => ({ name: `Voltage walk ${v} V.fcs`, events: eventsFor(20000, scale), role: 'sample', condition: 'Voltage walk', amount: TITRATION.walkAmount, voltage: v })),
  ];
}

function* generateTitration(ctx, samples, all) {
  ctx.schedule(1500, all);
  const instrument = INSTRUMENTS.fortessa;
  const base = buildPanel(instrument, TITRATION_PANEL);
  const files = [];
  for (const [index, sample] of samples.entries()) {
    ctx.check();
    ctx.onProgress?.(index / samples.length, `Simulating ${sample.name}`);
    const { specs, weights, options, occupancy } = titrationPopulations(sample.amount);
    const populations = compilePopulations(specs, base.markers, options);
    const gains = sample.voltage ? walkGains(sample.voltage, instrument) : null;
    const panel = sample.voltage ? { ...base, detectors: base.detectors.map((d) => ({ ...d, voltage: sample.voltage })) } : base;
    const sim = simulateEvents({ count: sample.events, instrument, panel, populations, weights, mix: { dead: 0.03, debris: 0.04, doublets: 0.03 }, rate: 1500, detectorGains: gains }, ctx.random(sample.name), { signal: ctx.signal });
    files.push(flowFile(ctx, sample, sim, {
      instrument,
      panel,
      date: sample.voltage ? '2026-05-06' : '2026-05-05',
      assignments: TITRATION_PANEL,
      spill: base.spill,
      truth: { amount: sample.amount, occupancy, kd: TITRATION.kd, voltage: sample.voltage ?? null, gain: gains?.[TITRATION.detector] ?? 1, rsdEN: getDetector(instrument, TITRATION.detector).sigma },
    }));
    yield;
  }
  const transforms = channelTransforms(bdChannels(TITRATION_PANEL), () => LOGICLE_BD, 262144, 4096);
  return {
    files,
    workspaceHints: {
      groups: [
        { name: 'Titration', color: '#8b5cf6', files: samples.filter((s) => s.condition === 'Titration').map((s) => s.name) },
        { name: 'Voltage walk', color: '#0ea5e9', files: samples.filter((s) => s.condition === 'Voltage walk').map((s) => s.name) },
      ],
      sampleMeta: Object.fromEntries(samples.map((s) => [s.name, sampleMeta(s)])),
      channelSettings: Object.fromEntries(Object.entries(transforms).map(([k, v]) => [k, { transform: v }])),
      compensation: { fromFile: '$SPILLOVER' },
      suggestedGates: titrationGates(),
    },
  };
}

function titrationGates() {
  const fsc = ['FSC-A', LINEAR_BD];
  const ssc = ['SSC-A', LINEAR_BD];
  return [
    polygonGate('gsim-cells', 'Cells', null, fsc, ssc, [[26000, 0], [270000, 0], [270000, 270000], [45000, 270000], [26000, 40000]], '#64748b', 'Excludes debris (low FSC).'),
    polygonGate('gsim-singlets', 'Single cells', 'gsim-cells', fsc, ['FSC-H', LINEAR_BD], [[15000, 11200], [270000, 201000], [270000, 270000], [215000, 270000], [15000, 18000]], '#0ea5e9', 'Singlets have FSC-H ≈ FSC-A; doublets fall below the diagonal.'),
    polygonGate('gsim-lymph', 'Lymphocytes', 'gsim-singlets', fsc, ssc, [[33000, 1000], [92000, 1000], [95000, 34000], [40000, 36000]], '#3b82f6', 'FSC/SSC lymphocyte region: titrate on the cells that carry the antigen and those that do not, without monocytes, which are CD4-dim.'),
  ];
}

// --- Catalog ------------------------------------------------------------------------------------

const DEFINITIONS = [
  {
    id: 'pbmc-immunophenotyping',
    title: 'PBMC immunophenotyping, 14 colors',
    description: 'Six donors\' PBMC, unstimulated and stimulated, on a 5-laser BD LSRFortessa-like instrument with a 13-marker panel plus viability, and a full set of compensation controls (unstained cells, capture beads, heat-killed cells for the viability dye). Gate singlets, live cells, lymphocytes, T, B and NK cells, Tregs and naive/memory subsets, and compare conditions: stimulation raises CD25 and HLA-DR on T cells. The acquisition matrix in $SPILLOVER under-compensates one pair of channels, so check the compensation diagnostics against the controls; D05_Unstim has a clog worth finding in the time QC.',
    technology: 'conventional',
    instrument: 'BD LSRFortessa X-20-like (UV, violet, blue, yellow-green, red lasers), range 2^18',
    tags: ['immunophenotyping', 'PBMC', 'compensation', 'stimulation', 'Treg', 'QC', 'beginner'],
    design: pbmcDesign,
    channels: () => bdChannels(PBMC_PANEL),
    transforms: () => channelTransforms(bdChannels(PBMC_PANEL), () => LOGICLE_BD, 262144, 8192),
    answerKey: () => {
      const panel = buildPanel(INSTRUMENTS.fortessa, PBMC_PANEL);
      const written = pbmcWrittenSpill(panel);
      return {
        labels: 'files[i].meta.truth.labels / names (per event); meta.truth.state marks activated T cells (1).',
        expected: {
          'Lymphocytes / singlets': '≈ 64 %', 'Monocytes / singlets': '≈ 17 %', 'T / lymphocytes': '≈ 66 %', 'CD4:CD8': '≈ 2:1',
          'B / lymphocytes': '≈ 12 %', 'NK / lymphocytes': '≈ 13 %', 'Treg / CD4 T': '≈ 7 %', 'Dead / all events': '5 %', 'Doublets / all events': '4 %',
        },
        populations: PBMC_POPULATIONS.map((p) => p.name),
        compensationError: written.error,
        anomalies: { 'D05_Unstim.fcs': 'clog at about 42–54 % of the acquisition time (rate drops ~8×, signals fall), then a short surge' },
        stimulation: 'Stimulated samples: 20–50 % of each T subset activated (CD25 ×8, HLA-DR+, CD127 ×0.5, CD45RA/CCR7 ×0.6, larger FSC).',
      };
    },
    generate: generatePBMC,
  },
  {
    id: 'flowjo-workspace',
    title: 'Moving from FlowJo: a PBMC workspace',
    description: 'Four PBMC samples from two donors with the FlowJo 10 workspace a lab made for them: a corrected compensation matrix, FlowJo biexponential scales, and a gating tree with polygons, a CD4 × CD8 quadrant, an ellipse, a Boolean population and sample groups. Opening the example opens the FlowJo import: see how each population converts, import it, and read the migration report, which recomputes every population and compares its count with the count FlowJo saved.',
    technology: 'conventional',
    instrument: 'BD LSRFortessa X-20-like, range 2^18; FlowJo 10.10 workspace',
    tags: ['FlowJo', 'migration', 'workspace import', 'biexponential', 'beginner'],
    design: flowJoDesign,
    channels: () => bdChannels(PBMC_PANEL),
    transforms: () => channelTransforms(bdChannels(PBMC_PANEL), () => ({ type: 'biex', ...FLOWJO_BIEX }), 262144, 8192),
    answerKey: () => ({
      workspace: `${FLOWJO_WORKSPACE} (result.attachments): every population count in it was computed from the files with the gates as FlowJo evaluates them, so a faithful import reproduces each one.`,
      compensation: 'The workspace holds the true spillover; the files\' $SPILLOVER still has the acquisition error of the PBMC example (APC → Alexa Fluor 700 under-compensated).',
      labels: 'files[i].meta.truth.labels / names (per event).',
    }),
    generate: generateFlowJo,
  },
  {
    id: 'spectral-25color',
    title: 'Spectral 25-color panel (raw detectors)',
    description: 'Raw data from a 5-laser Cytek Aurora-like spectral cytometer: 64 detectors (UV1–UV16, V1–V16, B1–B14, YG1–YG10, R1–R8) plus FSC, SSC and violet SSC-B. It includes an unstained control with lymphoid (dim) and myeloid (bright) autofluorescence, a single-stain reference for each of 25 fluorochromes, and three stained PBMC samples. Inspect the reference spectra and their similarity, unmix with and without autofluorescence extraction, and check the result against the true abundances kept for every event.',
    technology: 'spectral',
    instrument: 'Cytek Aurora-like, 5 lasers, 64 fluorescence detectors, range 2^22',
    tags: ['spectral', 'unmixing', 'autofluorescence', 'reference controls', 'high-parameter', 'advanced'],
    design: spectralDesign,
    channels: spectralChannels,
    transforms: () => channelTransforms(spectralChannels(), () => LOGICLE_AURORA, 4194304, 1 << 20),
    answerKey: () => ({
      labels: 'files[i].meta.truth.labels / names; Donor files also carry meta.truth.abundances (Float32Array per fluorochrome and both autofluorescence types, in signal units at the peak detector).',
      fluorochromes: SPECTRAL_PANEL.map((a) => ({ fluorochrome: a.fluor, marker: a.marker })),
      signatures: 'workspaceHints.spectral.signatures (peak-normalized, 64 detectors) are the generating spectra.',
    }),
    generate: generateSpectral,
  },
  {
    id: 'cell-cycle',
    title: 'Cell cycle: DNA content with propidium iodide',
    description: 'Fixed cells of a T-cell line stained with propidium iodide, measured with PI-A, PI-H and PI-W on a FACSCanto II-like instrument: an asynchronous culture (G1 55 %, S 30 %, G2/M 15 %, CV 4 %) and a nocodazole-treated culture arrested in G2/M (45 %). Both contain doublets, aggregates and sub-G1 debris. Gate single nuclei on PI-A versus PI-W (G1 doublets sit at the G2 position on PI-A), then fit the cell-cycle model and compare with the true phase fractions.',
    technology: 'conventional',
    instrument: 'BD FACSCanto II-like, linear DNA channel, range 2^18',
    tags: ['cell cycle', 'DNA content', 'doublet discrimination', 'linear scale', 'beginner'],
    design: cellCycleDesign,
    channels: cellCycleChannels,
    transforms: () => Object.fromEntries(cellCycleChannels().map((c) => [c.name, c.name === 'Time' ? linear(65536) : linear(262144)])),
    answerKey: () => ({
      labels: 'files[i].meta.truth.labels / names: G1, S, G2/M, Doublets, Aggregates, Debris.',
      phases: Object.fromEntries(CELL_CYCLE_SAMPLES.map((s) => [s.file, s.phases])),
      g1Position: 'PI-A ≈ 50 000; G2/G1 ratio 1.97; CV 4 %.',
    }),
    generate: generateCellCycle,
  },
  {
    id: 'proliferation',
    title: 'T-cell proliferation by dye dilution',
    description: 'PBMC labeled with CellTrace Violet and cultured four days without stimulation or with anti-CD3/CD28, plus a day-0 reference that marks the undivided peak. CD4 and CD8 T cells halve their dye with each division, giving up to six generations, while B and NK cells stay undivided. Gate live CD4 and CD8 T cells, fit the generations and compare the division, proliferation and expansion indices with the known precursor frequencies.',
    technology: 'conventional',
    instrument: 'BD LSRFortessa X-20-like, range 2^18',
    tags: ['proliferation', 'CellTrace Violet', 'dye dilution', 'T cells', 'intermediate'],
    design: proliferationDesign,
    channels: () => bdChannels(PROLIFERATION_PANEL),
    transforms: () => channelTransforms(bdChannels(PROLIFERATION_PANEL), () => LOGICLE_BD, 262144, 8192),
    answerKey: () => ({
      labels: 'files[i].meta.truth.labels / names: "CD4 T gen 0" … "CD8 T gen 6", B cells, NK cells, Monocytes, Dead cells, Debris, Doublets.',
      stimulated: { CD4: proliferationStatistics(PRECURSOR_FREQUENCIES.stimulated.CD4), CD8: proliferationStatistics(PRECURSOR_FREQUENCIES.stimulated.CD8) },
      unstimulated: { CD4: proliferationStatistics(PRECURSOR_FREQUENCIES.unstimulated.CD4), CD8: proliferationStatistics(PRECURSOR_FREQUENCIES.unstimulated.CD8) },
      undividedPeak: 'CTV (BV421-A) ≈ 90 000 on day 0 and ≈ 70 000 in undivided cells on day 4; each division halves it.',
    }),
    generate: generateProliferation,
  },
  {
    id: 'calcium-flux',
    title: 'Calcium flux: Indo-1 ratio over time',
    description: 'PBMC loaded with the calcium dye Indo-1 and acquired for four minutes on a BD LSRFortessa-like instrument: 60 s of baseline, the tube taken out for 8 s to add the stimulus, then the response. Tubes with buffer, anti-CD3 at a low and a high dose (T cells respond), ionomycin (every cell responds) and the high dose injected without stopping acquisition. Gate live T cells, plot the Indo-1 violet/blue ratio against time and measure the baseline, the peak, the time to peak, the area under the curve and the fraction of responding cells, overlaying the tubes; the simulator knows each cell\'s calcium.',
    technology: 'conventional',
    instrument: 'BD LSRFortessa X-20-like with a UV laser, range 2^18',
    tags: ['calcium flux', 'kinetics', 'Indo-1', 'ratio', 'T cells', 'intermediate'],
    design: calciumDesign,
    channels: () => bdChannels(CALCIUM_PANEL),
    transforms: () => channelTransforms(bdChannels(CALCIUM_PANEL), () => LOGICLE_BD, 262144, 65536),
    answerKey: () => ({
      ratio: 'Indo-1 (Violet) / Indo-1 (Blue): BUV395-A / BUV496-A, uncompensated.',
      stimulus: `Added at ${CALCIUM.baseline} s; acquisition resumes at ${CALCIUM.baseline + CALCIUM.pause} s (the injected tube runs on without a pause).`,
      truth: 'files[i].meta.truth.ratio (the noise-free ratio of every event), responder (a cell that responds) and responding (responding when measured); calcium.parameters: the stimulus (responders among its target cells, amplitude, lag, rise, decay, plateau).',
      stimuli: CALCIUM_STIMULI,
    }),
    generate: generateCalcium,
  },
  {
    id: 'plate-screen',
    title: 'Drug screen on a 96-well plate',
    description: 'PBMC stimulated with anti-CD3/CD28 in a 96-well plate, one file per well from a plate loader: six compounds at ten 3-fold doses from 10 µM (rows A–F, columns 1–10), stimulated vehicle wells as positive controls (column 11 and row G) and unstimulated wells as negative controls (column 12 and row H). Activated T cells express CD69. Gate live CD3+ T cells and CD69+, show % CD69+ across the plate as a heat map, check the screen\'s Z′ from its controls, and fit each compound\'s dose-response curve: four full inhibitors, one partial and one inactive, with one IC50 beyond the highest dose.',
    technology: 'conventional',
    instrument: 'BD LSRFortessa X-20-like with a plate loader, range 2^18',
    tags: ['plate', 'screen', 'dose-response', 'IC50', 'Z′', 'T cells', 'intermediate'],
    design: screenDesign,
    channels: () => bdChannels(SCREEN_PANEL),
    transforms: () => channelTransforms(bdChannels(SCREEN_PANEL), () => LOGICLE_BD, 262144, 65536),
    answerKey: () => ({
      layout: 'Wells come from the files\' $WELLID and $PLATENAME keywords (and their names); the layout is in each sample\'s annotations: compound, dose (nM), control (positive, negative).',
      response: `% CD69+ of live T cells: ${100 * SCREEN.stimulated}% in stimulated wells, ${100 * SCREEN.unstimulated}% in unstimulated ones, each well varying by a log-normal factor (CV ${100 * SCREEN.wellCV}%).`,
      compounds: SCREEN_COMPOUNDS.map((c) => ({ ...c, curve: screenTruth(c) })),
      doses: SCREEN_DOSES,
      truth: 'files[i].meta.truth.activated (each event activated or not) and truth.screen: the well\'s expected and actual activated share and its live T cells.',
    }),
    generate: generateScreen,
  },
  {
    id: 'bead-immunoassay',
    title: 'Cytokine bead assay (LEGENDplex-like)',
    description: 'An 8-plex cytokine bead immunoassay read on a plate: capture beads of two sizes, four analytes each told apart by their APC level, and a PE reporter that grows with each cytokine\'s concentration. Standards C7 (10 000 pg/mL) to C1 in 4-fold steps and C0 (buffer) in duplicate, and 20 sera, diluted 2-fold, in duplicate. Gate the two bead sizes, let CytoWeave find the beads of each analyte, fit the standard curves and read the sera\'s concentrations, with their quantifiable range; every serum\'s true concentrations are known.',
    technology: 'conventional',
    instrument: 'BD LSRFortessa X-20-like with a plate loader, range 2^18',
    tags: ['plate', 'bead assay', 'LEGENDplex', 'CBA', 'standard curve', 'cytokines', 'intermediate'],
    design: beadAssayDesign,
    channels: () => bdChannels(BEAD_ASSAY_PANEL),
    transforms: () => channelTransforms(bdChannels(BEAD_ASSAY_PANEL), () => LOGICLE_BD, 262144, 65536),
    answerKey: () => ({
      beads: 'Beads A (smaller): IL-2, IL-4, IL-6, IL-10; Beads B (larger): IL-17A, IFN-γ, TNF-α, IL-1β; within each, from the dimmest APC level to the brightest.',
      standards: `C7 = ${BEAD_STANDARDS.top} ${BEAD_STANDARDS.unit}, ${BEAD_STANDARDS.factor}-fold steps down to C1; C0 is buffer. Annotations: standard (C0 … C7); sera: specimen (S01 … S20) and dilution (${BEAD_STANDARDS.dilution}).`,
      analytes: BEAD_ANALYTES.map((a) => ({ name: a.name, group: a.group, apc: a.apc, curve: { b: -a.hill, c: a.bottom, d: a.top, e: a.ec, f: a.asym } })),
      truth: 'files[i].meta.truth.labels / names (each event\'s bead, or debris and doublets); truth.beads: the concentrations in the well, the serum\'s (before dilution) and each bead\'s expected reporter signal.',
    }),
    generate: generateBeadAssay,
  },
  {
    id: 'cytof-cohort',
    title: 'Mass cytometry cohort, two batches',
    description: 'A Helios-like mass cytometry study of 8 subjects (4 control, 4 case) acquired in two batches, each with an anchor sample from the same reference donor, a 25-marker immune panel, DNA and cisplatin channels, EQ calibration beads and Gaussian discrimination parameters. Signal drifts down during each run and batch 2 differs in sensitivity and staining. Clean up with beads, DNA, event length and viability, normalize with the beads and the anchors, then cluster (FlowSOM, UMAP) and test differential abundance: non-classical monocytes are doubled in the case group.',
    technology: 'mass',
    instrument: 'Helios-like CyTOF, dual-count ion counts, randomized, range ~10^4',
    tags: ['mass cytometry', 'CyTOF', 'batch effects', 'normalization', 'clustering', 'differential abundance', 'advanced'],
    design: cytofDesign,
    channels: () => [{ name: 'Time', label: '' }, { name: 'Event_length', label: '' }, ...CYTOF_CHANNELS.map((c) => ({ name: c.name, label: c.label })), ...['Center', 'Offset', 'Width', 'Residual'].map((name) => ({ name, label: '' }))],
    transforms: () => Object.fromEntries(CYTOF_CHANNELS.map((c) => [c.name, ARCSINH_MASS])),
    answerKey: () => ({
      labels: 'files[i].meta.truth.labels / names (23 populations plus Dead cells, Debris, Doublets, Beads); meta.truth.expectedFrequencies gives each file\'s live-cell composition.',
      differential: CYTOF_DIFFERENTIAL,
      batches: 'Batch 2: instrument sensitivity ×0.82 (±10 % per channel), staining ×exp(N(0, 0.18)) per marker and a higher ion background; anchors share one donor so their differences are pure batch effect.',
      drift: 'Sensitivity falls by up to 25 % over each run (more for heavy masses); beads show it.',
    }),
    generate: generateCytof,
  },
  {
    id: 'cytof-barcoded',
    title: 'Barcoded mass cytometry plate',
    description: 'Twenty PBMC samples — ten donors, unstimulated and stimulated with anti-CD3/CD28 — each labeled with three of six palladium isotopes (Pd102–Pd110), pooled into one tube and acquired as a single Helios-like file. The file comes with its barcode key. Debarcode it (QC → Debarcode): doublets of cells from two wells carry four or more palladium channels and are left unassigned. Split the plate into one sample per well, annotate them from their names, and compare stimulated with unstimulated wells, paired by donor: CD25, CD38 and HLA-DR rise on T cells.',
    technology: 'mass',
    instrument: 'Helios-like CyTOF with palladium barcoding, range ~10^4',
    tags: ['mass cytometry', 'barcoding', 'debarcoding', 'stimulation', 'paired design', 'intermediate'],
    design: barcodedDesign,
    channels: () => [{ name: 'Time', label: '' }, { name: 'Event_length', label: '' }, ...BARCODE_CHANNELS.map((c) => ({ name: c.name, label: c.label })), ...['Center', 'Offset', 'Width', 'Residual'].map((name) => ({ name, label: '' }))],
    transforms: () => Object.fromEntries(BARCODE_CHANNELS.map((c) => [c.name, ARCSINH_MASS])),
    answerKey: () => ({
      labels: 'files[0].meta.truth.labels / names (populations, Dead cells, Debris, Doublets, Beads); meta.truth.wells gives each event\'s well (index into meta.truth.wellNames), −1 for beads and −2 for doublets (whose partner may come from another well).',
      key: '6-choose-3 palladium key in lexicographic order: code k is well k of wellNames (D01_Unstim, D01_Stim, D02_Unstim, …).',
      stimulation: 'Stimulated wells: 20–50 % of each T subset activated (CD25 ×8, HLA-DR+, CD38 ×3, CD127 ×0.5).',
    }),
    generate: generateBarcoded,
  },
  {
    id: 'index-sort',
    title: 'Index sort into a 96-well plate',
    description: 'A B-cell-enriched PBMC presort analysis and the index-sorted events of one 96-well plate from a FACSAria-like sorter: memory B cells (columns 1–5), naive B cells (6–8), plasmablasts (9–11) and T-cell controls (12), with H12 left empty. Each sorted event carries "Index X" (column) and "Index Y" (row) parameters. Overlay the sorted cells on the presort plots, check that every well received a cell from its gate, and link wells to phenotypes.',
    technology: 'conventional',
    instrument: 'BD FACSAria Fusion-like sorter, range 2^18',
    tags: ['index sort', 'single-cell', 'plate', 'B cells', 'intermediate'],
    design: indexSortDesign,
    channels: () => [...bdChannels(SORT_PANEL), { name: 'Index X', label: 'Plate column (1-12)' }, { name: 'Index Y', label: 'Plate row (1-8, A=1)' }],
    transforms: () => ({ ...channelTransforms(bdChannels(SORT_PANEL), () => LOGICLE_BD, 262144, 65536), 'Index X': linear(13), 'Index Y': linear(9) }),
    answerKey: () => ({
      labels: 'Plate1_IndexSort.fcs meta.truth.labels / names give the sorted population; meta.truth.wells the well of each event (A1 … H11).',
      layout: SORT_TARGETS.map((t) => ({ population: t.population, columns: t.columns, rows: t.rows ?? 8 })),
      emptyWells: ['H12'],
      parameters: 'Index X = plate column 1–12; Index Y = plate row 1–8 (A = 1). Keyword INDEX SORTING LOCATIONS lists "row,column;" (0-based) in event order.',
    }),
    generate: generateIndexSort,
  },
  {
    id: 'qc-showcase',
    title: 'Acquisition QC showcase',
    description: 'Four wells of the same stained PBMC acquired from a plate on an LSRFortessa-like instrument: one clean, one with a clog (the event rate collapses and signals fall, then surge), one with gradual signal drift, and one with an air-bubble burst of junk events. Plot each channel against Time and run the automated time-QC to flag and remove the bad stretches, then compare population frequencies before and after.',
    technology: 'conventional',
    instrument: 'BD LSRFortessa X-20-like with plate loader, range 2^18',
    tags: ['QC', 'time', 'clog', 'drift', 'flow rate', 'beginner'],
    design: qcDesign,
    channels: () => bdChannels(QC_PANEL),
    transforms: () => channelTransforms(bdChannels(QC_PANEL), () => LOGICLE_BD, 262144, 4096),
    answerKey: () => ({
      labels: 'files[i].meta.truth.anomaly flags events acquired inside an anomaly window; meta.truth.anomalies gives the windows in seconds and Time units.',
      wells: { 'A01.fcs': 'clean', 'A02.fcs': 'clog (≈ 42–54 % of the run) and a release surge', 'A03.fcs': 'drift: fluorescence −40 %, scatter −10 % by the end', 'A04.fcs': 'air bubble burst at ≈ 62–66 % of the run' },
    }),
    generate: generateQC,
  },
  {
    id: 'bead-qc',
    title: 'Daily bead QC: Q, B and Levey–Jennings',
    description: 'Thirty daily runs of 8-peak rainbow beads on an 18-color LSRFortessa-like instrument. Measure each detector\'s efficiency Q, optical background B and the beads\' intrinsic CV (QC → Instrument), save the runs to the instrument\'s record, and follow them on Levey–Jennings charts against the first 20 runs: one detector\'s PMT ages from run 21, the flow cell gets dirty on run 25, and the violet laser weakens on run 27. The true Q and B of every detector on every run are known.',
    technology: 'conventional',
    instrument: 'BD LSRFortessa X-20-like, 18 fluorescence detectors, range 2^18',
    tags: ['QC', 'Q and B', 'Levey–Jennings', 'beads', 'instrument', 'intermediate'],
    design: beadQCDesign,
    channels: () => bdChannels(beadQCAssignments()),
    transforms: () => channelTransforms(bdChannels(beadQCAssignments()), () => LOGICLE_BD, 262144, 4096),
    answerKey: () => ({
      truth: 'files[i].meta.truth.detectors: the true Q (photoelectrons per unit), B (photoelectrons) and CV0 of every detector on that run, and the brightest level\'s mean signal; meta.truth.labels gives each event\'s level (doublets and debris after the 8 levels).',
      beads: `${BEAD_LEVELS.length} levels (a blank and 7), intrinsic CV ${BEAD_CV0 * 100} %`,
      events: Object.fromEntries(Object.entries(BEAD_EVENTS).map(([k, v]) => [k, `from run ${v.from}: ${v.what}`])),
    }),
    generate: generateBeadQC,
  },
  {
    id: 'titration-voltage',
    title: 'Antibody titration and a voltage walk',
    description: 'Setting up a panel: CD4-PE titrated on PBMC in ten two-fold steps from 1000 ng to 2 ng per test, with an unstained tube, and then the PE detector walked from 300 V to 750 V with cells stained at 125 ng. Find the amount of antibody that saturates CD4 without adding background (QC → Titration), and the voltage range that lifts the negative cells above the detector\'s electronic noise while keeping the positive cells within its linear range. The binding constant, the detector\'s noise and its gain at every voltage are known.',
    technology: 'conventional',
    instrument: 'BD LSRFortessa X-20-like, range 2^18',
    tags: ['titration', 'voltage walk', 'stain index', 'panel setup', 'beginner'],
    design: titrationDesign,
    channels: () => bdChannels(TITRATION_PANEL),
    transforms: () => channelTransforms(bdChannels(TITRATION_PANEL), () => LOGICLE_BD, 262144, 4096),
    answerKey: () => ({
      labels: 'files[i].meta.truth.labels / names: CD4 T, CD8 T, B cells, NK cells, Monocytes, Dead cells, Debris, Doublets, Junk.',
      binding: `CD4 occupancy = c / (c + ${TITRATION.kd} ng); 90% bound at ${9 * TITRATION.kd} ng; non-specific binding ${TITRATION.nonspecific} units per ng on every cell.`,
      titration: 'Recommended (Bonilla et al. 2024: at least twice the amount giving 90% of saturation): the first amount tested at or above 90 ng, 125 ng.',
      walk: `PE-A gain (V / 430 V)^${TITRATION.exponent}; electronic noise SD ${INSTRUMENTS.fortessa.detectors.find((d) => d.name === TITRATION.detector).sigma} (rSD_EN); linear range taken as 90% of 262,144.`,
    }),
    generate: generateTitration,
  },
];

function summarize(def) {
  const samples = def.design(1);
  return Object.freeze({
    id: def.id,
    title: def.title,
    description: def.description,
    technology: def.technology,
    instrument: def.instrument,
    tags: def.tags.slice(),
    channels: def.channels(),
    transforms: def.transforms(),
    samples: samples.map((s) => ({ name: s.name, events: s.events, ...sampleMeta(s) })),
    defaultEvents: samples.reduce((sum, s) => sum + s.events, 0),
    answerKey: def.answerKey(),
  });
}

// The catalog (plain data; JSON-serializable).
export const EXAMPLES = Object.freeze(DEFINITIONS.map(summarize));

// Short summaries for a picker.
export function listExamples() {
  return EXAMPLES.map(({ id, title, description, technology, tags, defaultEvents, samples }) => ({ id, title, description, technology, tags, defaultEvents, files: samples.length }));
}

export function getExample(id) {
  const entry = EXAMPLES.find((e) => e.id === id);
  if (!entry) throw new Error(`There is no example called "${id}".`);
  return entry;
}

function startGeneration(id, options) {
  const def = DEFINITIONS.find((d) => d.id === id);
  if (!def) throw new Error(`There is no example called "${id}".`);
  const ctx = createContext(def, options);
  const all = def.design(ctx.scale, ctx);
  all.forEach((sample, index) => { sample.index = index; });
  const samples = ctx.only ? all.filter((s) => ctx.only.has(s.name)) : all;
  if (ctx.only && !samples.length) throw new Error(`None of the requested files belong to the example "${id}".`);
  return { ctx, steps: def.generate(ctx, samples, all) };
}

// Generates an example's files. options: { seed, scale (event-count multiplier, default 1),
// samples (file names to generate; default all), truth (default true), tandemDegradation
// ({ fluorochrome: fraction of its emission from its donor }, spectral example), instrumentShift
// (strength of per-sample detector gains, PBMC example), laserCV (laser intensity CV from event
// to event, a number or { laser: cv }, spectral example), clogs (file names of the PBMC example
// with a clog, instead of D05_Unstim), onProgress, signal }.
// Returns { files: [{ name, bytes (Uint8Array, FCS 3.1), meta }], workspaceHints }.
export function generateExample(id, options = {}) {
  const { ctx, steps } = startGeneration(id, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  ctx.onProgress?.(1, 'Done');
  return step.value;
}

// As generateExample, but yields to the event loop between files so that a worker can receive
// a cancellation (options.signal.aborted) while it runs.
export async function generateExampleAsync(id, options = {}) {
  const { ctx, steps } = startGeneration(id, options);
  let step = steps.next();
  while (!step.done) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    step = steps.next();
  }
  ctx.onProgress?.(1, 'Done');
  return step.value;
}
