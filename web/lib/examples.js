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
  INSTRUMENTS,
  acquisitionKeywords,
  buildPanel,
  compilePopulations,
  createRandom,
  deriveSeed,
  encodeFCS,
  rangeFor,
  simulateCellCycle,
  simulateEvents,
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
      if (options.signal?.aborted) throw new Error('Simulation was cancelled.');
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
function simulateBeads(ctx, sample, instrument, panel, marker, targetSignal, rate) {
  let peak = 0;
  const row = 2 + panel.markers.indexOf(marker);
  for (let j = 0; j < panel.detectors.length; j += 1) peak = Math.max(peak, panel.emitters[row * panel.detectors.length + j]);
  const populations = compilePopulations(beadSpecs(marker, targetSignal / peak), panel.markers, { stained: new Set([marker]) });
  return simulateEvents({ count: sample.events, instrument, panel, populations, weights: Float64Array.from([1, 1]), mix: BEAD_MIX, debris: BEAD_DEBRIS, viability: null, rate }, ctx.random(sample.name), { signal: ctx.signal });
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

function pbmcDesign(scale) {
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
  return samples;
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
        anomalies: sample.anomaly === 'clog' ? CLOG : [],
        markerFactors: donorMarkerFactors(ctx, sample.subject, panel.markers),
        recordState: true,
      }, ctx.random(sample.name), { signal: ctx.signal });
      fileSetup = { ...setup, spill: written, truth: { state: sim.state, stateNames: ['resting', 'activated'], anomalies: windowsTruth(sim, instrument) } };
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
      // axis, 2a, with a the distance from the centre to the first edge point.
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

// --- 2. Spectral 25-colour (Cytek Aurora-like, 64 raw detectors) --------------------------------

const SPECTRAL_PANEL = [
  ['CD45RA', 'BUV395'], ['CD16', 'BUV496'], ['CD123', 'BUV563'], ['CD161', 'BUV615'], ['CD38', 'BUV661'],
  ['CD56', 'BUV737'], ['CD8', 'BUV805'], ['CCR7', 'BV421'], ['CD19', 'BV480'], ['Viability', 'Aqua'],
  ['CD57', 'BV570'], ['CD27', 'BV605'], ['HLA-DR', 'BV650'], ['CD95', 'BV711'], ['PD-1', 'BV750'],
  ['CD14', 'BV786'], ['TCRgd', 'FITC'], ['CD127', 'PerCP-Cy5.5'], ['CD25', 'PE'], ['CD28', 'PE-CF594'],
  ['CD11c', 'PE-Cy5'], ['CD45', 'PE-Cy7'], ['CD11b', 'APC'], ['CD3', 'Alexa Fluor 700'], ['CD4', 'APC-Cy7'],
].map(([marker, fluor]) => ({ marker, fluor, detector: null }));

function spectralDesign(scale) {
  const samples = [{ name: 'Unstained.fcs', events: eventsFor(20000, scale), role: 'unstained', condition: 'Control', subject: 'S1', carrier: 'cells' }];
  for (const a of SPECTRAL_PANEL) {
    const cells = a.marker === 'Viability';
    samples.push({ name: `Ref_${a.fluor}.fcs`, events: eventsFor(cells ? 8000 : 4000, scale), role: 'single-stain', stain: a.fluor, marker: a.marker, carrier: cells ? 'cells (50 % heat-killed)' : 'beads', condition: 'Control', subject: cells ? 'S1' : undefined });
  }
  for (const subject of ['S1', 'S2', 'S3']) samples.push({ name: `Donor_${subject}.fcs`, events: eventsFor(40000, scale), role: 'sample', condition: 'Healthy', subject, batch: 'B1' });
  return samples;
}

function spectralDetectorNames() {
  return INSTRUMENTS.aurora.detectors.map((d) => d.name);
}

function* generateSpectral(ctx, samples, all) {
  ctx.schedule(3000, all);
  const instrument = INSTRUMENTS.aurora;
  const names = spectralDetectorNames();
  const panel = buildPanel(instrument, SPECTRAL_PANEL, names);
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
    if (sample.role === 'single-stain' && sample.carrier === 'beads') {
      sim = simulateBeads(ctx, sample, instrument, panel, sample.marker, 1.2e6, 3000);
      truth = { signature: signatures[sample.stain], fluorochrome: sample.stain };
    } else if (sample.role !== 'sample') {
      const { specs, weights } = pbmcComposition(ctx, sample.subject);
      const stained = new Set(sample.role === 'unstained' ? [] : [sample.marker]);
      const populations = compilePopulations(specs, panel.markers, { stained });
      const mix = sample.role === 'unstained' ? PBMC_MIX : { dead: 0.45, debris: 0.08, doublets: 0.03 };
      sim = simulateEvents({ count: sample.events, instrument, panel, populations, weights, mix, viability: sample.role === 'unstained' ? null : 'Viability', rate, scatterWidth: false }, ctx.random(sample.name), { signal: ctx.signal });
      if (sample.role === 'single-stain') truth = { signature: signatures[sample.stain], fluorochrome: sample.stain };
    } else {
      const { specs, weights } = pbmcComposition(ctx, sample.subject);
      const populations = compilePopulations(specs, panel.markers);
      sim = simulateEvents({ count: sample.events, instrument, panel, populations, weights, mix: PBMC_MIX, viability: 'Viability', rate, keepAbundances: ctx.truth, markerFactors: donorMarkerFactors(ctx, sample.subject, panel.markers) }, ctx.random(sample.name), { signal: ctx.signal });
      if (sim.abundances) {
        truth = {
          abundances: sim.abundances,
          abundanceNames: ['AF (lymphoid)', 'AF (myeloid)', ...SPECTRAL_PANEL.map((a) => a.fluor)],
          abundanceMarkers: ['Autofluorescence', 'Autofluorescence', ...SPECTRAL_PANEL.map((a) => a.marker)],
        };
      }
    }
    files.push(flowFile(ctx, sample, sim, { instrument, panel, date, truth }));
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
// Twenty samples (ten donors, unstimulated and anti-CD3/CD28-stimulated) are each labelled with
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
// event order, modelled on how BD FACSDiva records index sorts.

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

// --- Catalog ------------------------------------------------------------------------------------

const DEFINITIONS = [
  {
    id: 'pbmc-immunophenotyping',
    title: 'PBMC immunophenotyping, 14 colours',
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
    title: 'Spectral 25-colour panel (raw detectors)',
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
    description: 'PBMC labelled with CellTrace Violet and cultured four days without stimulation or with anti-CD3/CD28, plus a day-0 reference that marks the undivided peak. CD4 and CD8 T cells halve their dye with each division, giving up to six generations, while B and NK cells stay undivided. Gate live CD4 and CD8 T cells, fit the generations and compare the division, proliferation and expansion indices with the known precursor frequencies.',
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
    description: 'Twenty PBMC samples — ten donors, unstimulated and stimulated with anti-CD3/CD28 — each labelled with three of six palladium isotopes (Pd102–Pd110), pooled into one tube and acquired as a single Helios-like file. The file comes with its barcode key. Debarcode it (QC → Debarcode): doublets of cells from two wells carry four or more palladium channels and are left unassigned. Split the plate into one sample per well, annotate them from their names, and compare stimulated with unstimulated wells, paired by donor: CD25, CD38 and HLA-DR rise on T cells.',
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
  const all = def.design(ctx.scale);
  all.forEach((sample, index) => { sample.index = index; });
  const samples = ctx.only ? all.filter((s) => ctx.only.has(s.name)) : all;
  if (ctx.only && !samples.length) throw new Error(`None of the requested files belong to the example "${id}".`);
  return { ctx, steps: def.generate(ctx, samples, all) };
}

// Generates an example's files. options: { seed, scale (event-count multiplier, default 1),
// samples (file names to generate; default all), truth (default true), onProgress, signal }.
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
