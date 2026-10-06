// Plates and curves: the drug-screen and bead-immunoassay examples opened as the app opens them
// (samples with their annotations, the suggested gates, one view per well), and what the
// validation and the R oracles (reference/generate_curves.R) need from them.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beadAssay, standardConcentrations } from '../web/lib/beadassay.js';
import { fitLogLogistic, logLogistic, percentOfControls } from '../web/lib/curves.js';
import { SampleView, computeStatistic, population } from '../web/lib/engine.js';
import { SCREEN_COMPOUNDS, generateExample } from '../web/lib/examples.js';
import { parseFCS } from '../web/lib/fcs.js';
import { createRandom } from '../web/lib/random.js';
import { addGates, annotateSamples, createWorkspace, sampleFromDataset } from '../web/lib/workspace.js';

// An example as a workspace: { ws, views (sampleId → SampleView), files (by sample id), hints }.
export function exampleWorkspace(id, options = {}) {
  const result = generateExample(id, options);
  let ws = createWorkspace(id);
  const samples = [];
  const views = new Map();
  const files = new Map();
  for (const file of result.files) {
    const dataset = parseFCS(file.bytes).datasets[0];
    const record = sampleFromDataset(dataset, { name: file.name, size: file.bytes.length });
    samples.push(record);
    views.set(record.id, new SampleView(record, dataset));
    files.set(record.id, file);
  }
  ws = { ...ws, samples };
  const changes = {};
  for (const s of samples) {
    const meta = result.workspaceHints.sampleMeta?.[s.fileName] ?? {};
    changes[s.id] = Object.fromEntries(Object.entries(meta).filter(([k, v]) => !['role', 'stain'].includes(k) && typeof v !== 'object'));
  }
  ws = annotateSamples(ws, changes, 'example');
  ws = { ...ws, channelSettings: { ...ws.channelSettings, ...(result.workspaceHints.channelSettings ?? {}) } };
  ws = addGates(ws, result.workspaceHints.suggestedGates.map((g) => ({ ...g, overrides: {} }))).ws;
  return { ws, views, files, hints: result.workspaceHints };
}

// The screen: per well, % CD69+ of live T cells by the suggested gates, with the truth.
export function screenWells(example) {
  const { ws, views, files } = example;
  return ws.samples.map((s) => {
    const view = views.get(s.id);
    const truth = files.get(s.id).meta.truth.screen;
    return {
      sampleId: s.id,
      name: s.name,
      well: s.meta.well,
      compound: s.meta.compound,
      dose: s.meta.dose,
      control: s.meta.control ?? null,
      percent: computeStatistic(view, ws, { stat: 'freqParent', gateId: 'gsim-scr-cd69' }),
      truth,
    };
  });
}

// The bead assay: per well, the events of each bead-size gate (APC and PE values) and the truth.
export function beadWells(example) {
  const { ws, views, files } = example;
  return ws.samples.map((s) => {
    const view = views.get(s.id);
    const groups = ['gsim-bead-a', 'gsim-bead-b'].map((gateId) => {
      const indices = population(view, ws, gateId);
      const apc = view.column('APC-A');
      const pe = view.column('PE-A');
      const list = indices ? [...indices] : [];
      return { classification: Float32Array.from(list, (i) => apc[i]), reporter: Float32Array.from(list, (i) => pe[i]), indices: list };
    });
    return { id: s.id, name: s.name, meta: s.meta, groups, truth: files.get(s.id).meta.truth };
  });
}

// --- Inputs of the R oracles ------------------------------------------------------------------------

// The bead assay as the example's answer key describes it.
export const BEAD_SPEC = {
  groups: [{ name: 'Beads A', analytes: ['IL-2', 'IL-4', 'IL-6', 'IL-10'] }, { name: 'Beads B', analytes: ['IL-17A', 'IFN-γ', 'TNF-α', 'IL-1β'] }],
  standardField: 'standard',
  top: 10000,
  factor: 4,
  unit: 'pg/mL',
  dilutionField: 'dilution',
  sampleField: 'specimen',
  model: 'LL.5',
};

// Synthetic curves with known parameters (drc's b, c, d, e, f) and noise from a fixed seed.
export function curveCases() {
  const random = createRandom(20261006);
  const noise = () => random() + random() + random() - 1.5;
  const doses = (top, steps, factor, zero) => [...(zero ? [0] : []), ...Array.from({ length: steps }, (_, k) => +(top / factor ** k).toPrecision(6))].sort((a, b) => a - b);
  const make = (name, model, truth, xs, reps, sd, options = {}) => {
    const x = [];
    const y = [];
    for (const dose of xs) {
      for (let r = 0; r < reps; r += 1) {
        const mean = logLogistic(dose, truth);
        x.push(dose);
        y.push(+(options.relative ? mean * (1 + sd * noise()) : mean + sd * noise()).toPrecision(8));
      }
    }
    return { name, model, truth, x, y, weighting: options.weighting ?? 'none', fixed: options.fixed ?? null };
  };
  return [
    make('falling LL.4, triplicates with zero dose', 'LL.4', { b: 1.2, c: 5, d: 60, e: 100, f: 1 }, doses(10000, 10, 3, true), 3, 2),
    make('rising LL.4, singlicate', 'LL.4', { b: -0.8, c: 2, d: 95, e: 40, f: 1 }, doses(3000, 12, 2.5, false), 1, 2.5),
    make('steep LL.4, duplicates', 'LL.4', { b: 3, c: 0, d: 100, e: 250, f: 1 }, doses(10000, 10, 2, false), 2, 3),
    make('LL.4 with bottom and top fixed at 0 and 100', 'LL.4', { b: 1, c: 0, d: 100, e: 75, f: 1 }, doses(10000, 9, 3, false), 2, 4, { fixed: { c: 0, d: 100 } }),
    make('LL.5 standard curve, relative noise, duplicates', 'LL.5', { b: -1.1, c: 40, d: 50000, e: 6000, f: 0.8 }, doses(10000, 7, 4, true), 2, 0.04, { relative: true }),
    make('LL.5 standard curve weighted 1/Y²', 'LL.5', { b: -1.0, c: 50, d: 45000, e: 5000, f: 1.3 }, doses(10000, 7, 4, true), 2, 0.05, { relative: true, weighting: '1/y2' }),
    make('LL.5 falling, asymmetric', 'LL.5', { b: 1.4, c: 10, d: 200, e: 50, f: 0.5 }, doses(5000, 11, 2.5, false), 2, 3),
    make('LL.4 weighted 1/Y', 'LL.4', { b: -1.3, c: 100, d: 20000, e: 300, f: 1 }, doses(10000, 9, 3, true), 2, 0.05, { relative: true, weighting: '1/y' }),
  ];
}

// The drug screen's measured % CD69+ of T cells: per compound, its doses (nM) and responses; the
// controls' means; and one compound as % of controls with the asymptotes fixed at 0 and 100.
export function screenInput() {
  const wells = screenWells(exampleWorkspace('plate-screen'));
  const positive = wells.filter((w) => w.control === 'positive').map((w) => w.percent);
  const negative = wells.filter((w) => w.control === 'negative').map((w) => w.percent);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const compounds = SCREEN_COMPOUNDS.map((c) => {
    const rows = wells.filter((w) => w.compound === c.name);
    return { name: c.name, x: rows.map((w) => Number.parseFloat(w.dose)), y: rows.map((w) => w.percent) };
  });
  const first = compounds[0];
  const normalized = { name: `${first.name}, % of controls`, x: first.x, y: percentOfControls(first.y, mean(negative), mean(positive)) };
  return { compounds, normalized, positive, negative };
}

// The bead assay's MFIs (median and geometric mean) of every analyte on the standards and sera.
export function beadInput() {
  const wells = beadWells(exampleWorkspace('bead-immunoassay'));
  const out = {};
  for (const statistic of ['median', 'geometric']) {
    const r = beadAssay(wells, { ...BEAD_SPEC, statistic });
    const concentrations = standardConcentrations(['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'], { top: BEAD_SPEC.top, factor: BEAD_SPEC.factor });
    out[statistic] = r.analytes.map((a) => ({
      name: a.name,
      standards: r.wells.filter((w) => w.kind !== 'sample').map((w) => ({ well: w.name, concentration: concentrations.get(w.standard), mfi: w.results[a.name].mfi })),
      samples: r.wells.filter((w) => w.kind === 'sample').map((w) => ({ well: w.name, mfi: w.results[a.name].mfi })),
    }));
  }
  return out;
}

// CytoWeave's fit of a curve input, as drc's starting values: { b, c, d, e, f } (null when it fails).
export function startOf(x, y, model, weighting = 'none', fixed = null) {
  try {
    return fitLogLogistic(x, y, { model, weighting, fixed: fixed ?? undefined }).parameters;
  } catch {
    return null;
  }
}

// --- beadplexr's LEGENDplex data ----------------------------------------------------------------------

// The lplex events with beadplexr's bead groups and analytes (written by generate_curves.R), or
// null when they have not been exported.
export function lplexFiles(folder) {
  if (!existsSync(folder)) return null;
  const files = readdirSync(folder).filter((f) => f.endsWith('.csv')).sort();
  if (files.length !== 18) return null;
  return files.map((file) => {
    const [head, ...lines] = readFileSync(join(folder, file), 'utf8').trim().split('\n');
    const names = head.split(',').map((h) => h.replace(/"/g, ''));
    const at = (name) => names.indexOf(name);
    const rows = lines.map((l) => l.split(',').map((c) => c.replace(/"/g, '')));
    const column = (name) => Float64Array.from(rows, (r) => Number(r[at(name)]));
    return {
      file: file.replace(/\.csv$/, '.fcs'),
      fsc: column('FSC-A'),
      ssc: column('SSC-A'),
      classification: column('FL6-H'),
      reporter: column('FL2-H'),
      group: rows.map((r) => r[at('Bead group')] || null),
      analyte: rows.map((r) => r[at('Analyte ID')] || null),
    };
  });
}

// The two bead sizes by a two-cluster split of the pooled, standardized FSC-A and SSC-A (the larger
// cluster in FSC is group B). Returns per file an array of 'A' | 'B'.
export function scatterGroups(files) {
  const fsc = files.flatMap((f) => [...f.fsc]);
  const ssc = files.flatMap((f) => [...f.ssc]);
  const stats = (v) => {
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    return [m, Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length)];
  };
  const [mf, sf] = stats(fsc);
  const [ms, ss] = stats(ssc);
  let centers = [[-1, -1], [1, 1]];
  const nearest = (p) => ((p[0] - centers[0][0]) ** 2 + (p[1] - centers[0][1]) ** 2 <= (p[0] - centers[1][0]) ** 2 + (p[1] - centers[1][1]) ** 2 ? 0 : 1);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const sums = [[0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < fsc.length; i += 1) {
      const p = [(fsc[i] - mf) / sf, (ssc[i] - ms) / ss];
      const k = nearest(p);
      sums[k][0] += p[0];
      sums[k][1] += p[1];
      sums[k][2] += 1;
    }
    const next = sums.map((s) => [s[0] / s[2], s[1] / s[2]]);
    const moved = Math.abs(next[0][0] - centers[0][0]) + Math.abs(next[1][0] - centers[1][0]);
    centers = next;
    if (moved < 1e-12) break;
  }
  const larger = centers[0][0] > centers[1][0] ? 0 : 1;
  return files.map((f) => Array.from(f.fsc, (v, i) => (nearest([(v - mf) / sf, (f.ssc[i] - ms) / ss]) === larger ? 'B' : 'A')));
}
