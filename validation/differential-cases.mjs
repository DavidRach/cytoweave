// Differential state (wave 6, slice 5): synthetic matrices that take every path through the limma
// port (reference/diffcyt.json holds limma's own results for them), and the mass cytometry
// examples split into samples for diffcyt-DS-limma end to end: the two-batch cohort (case against
// control with batch in the design; no marker differs) and the barcoded plate split by well (ten
// donors unstimulated and stimulated, paired; activation raises CD25, HLA-DR, CD38 and PD-1 and
// lowers CD127, CD45RA, CCR7 and CD3 on part of every T-cell population).

import { createRandom } from '../web/lib/random.js';
import { generateExample } from '../web/lib/examples.js';
import { parseFCS } from '../web/lib/fcs.js';
import { encodeFCS } from '../web/lib/simulate.js';
import { SampleView } from '../web/lib/engine.js';
import { markerCandidates } from '../web/lib/explore.js';
import { ROOT, addSamples, createWorkspace, sampleFromDataset } from '../web/lib/workspace.js';
import { buildDesign, defaultCofactor, differentialState, stateMedians } from '../web/lib/differential.js';

// --- limma ---------------------------------------------------------------------------------------

// Rows like cluster × marker medians: means between 0.5 and 6, variances that fall with the mean
// (a trend) and, with spread, also from row to row; weights like cell counts. Each case:
// { name, y, weights, design, coefficient, trend }.
export function limmaCases() {
  const cases = [];
  const make = (name, { rows, samples, seed, design, coefficient, trend = true, weighted = true, missing = 0, effect = 0, deficient = null, zeroDf = 0, spread = 0 }) => {
    const random = createRandom(seed);
    const y = [];
    const weights = [];
    for (let g = 0; g < rows; g += 1) {
      const mean = 0.5 + 5.5 * random();
      const sd = (0.05 + 0.25 * Math.exp(-0.5 * mean)) * Math.exp(spread * random.gaussian());
      const size = Math.exp(1 + 5 * random());
      const differs = g < rows * 0.1;
      const row = [];
      const w = [];
      for (let s = 0; s < samples; s += 1) {
        const count = Math.max(0, Math.round(size * Math.exp(0.6 * random.gaussian())));
        let value = mean + sd * random.gaussian() + (differs ? effect * design[s][coefficient] : 0);
        let absent = count === 0 || (missing > 0 && random() < missing);
        // Every seventh row without two donors' samples; the first rows with one sample per group.
        if (deficient && g % 7 === 0 && deficient.includes(s)) absent = true;
        if (g < zeroDf && s !== 0 && s !== samples - 1) absent = true;
        if (absent) value = Number.NaN;
        row.push(value);
        w.push(absent ? 0 : Math.max(1, count));
      }
      y.push(row);
      weights.push(w);
    }
    cases.push({ name, y, weights: weighted ? weights : null, design, coefficient, trend });
  };
  const twoGroups = (n) => Array.from({ length: n }, (_, s) => [1, s >= n / 2 ? 1 : 0]);
  const withBatch = (n) => Array.from({ length: n }, (_, s) => [1, s % 2, s >= n / 2 ? 1 : 0]);
  const paired = (donors) => Array.from({ length: 2 * donors }, (_, s) => {
    const donor = Math.floor(s / 2);
    return [1, ...Array.from({ length: donors - 1 }, (_, d) => (donor === d + 1 ? 1 : 0)), s % 2];
  });
  make('equal df, trend (spline, 4 df)', { rows: 200, samples: 8, seed: 11, design: withBatch(8), coefficient: 1, effect: 0.4 });
  make('equal df, no trend', { rows: 150, samples: 8, seed: 12, design: withBatch(8), coefficient: 1, trend: false, effect: 0.4 });
  make('equal df, unweighted', { rows: 120, samples: 6, seed: 13, design: twoGroups(6), coefficient: 1, weighted: false, effect: 0.5 });
  make('equal df, 5 rows (spline, 2 df)', { rows: 5, samples: 8, seed: 14, design: twoGroups(8), coefficient: 1 });
  make('equal df, 20 rows (spline, 3 df)', { rows: 20, samples: 8, seed: 15, design: twoGroups(8), coefficient: 1, effect: 0.3 });
  make('unequal df, trend (lowess, span 1)', { rows: 200, samples: 10, seed: 16, design: twoGroups(10), coefficient: 1, missing: 0.08, effect: 0.4 });
  make('unequal df, unweighted (prior df inside the interval)', { rows: 250, samples: 10, seed: 21, design: twoGroups(10), coefficient: 1, missing: 0.1, weighted: false, effect: 0.4, spread: 0.35 });
  make('unequal df, no trend', { rows: 150, samples: 10, seed: 17, design: twoGroups(10), coefficient: 1, missing: 0.08, trend: false, effect: 0.4 });
  make('unequal df, 600 rows (lowess, span < 1, interpolated)', { rows: 600, samples: 12, seed: 18, design: withBatch(12), coefficient: 1, missing: 0.05, effect: 0.3 });
  make('paired, donors missing (rank-deficient rows)', { rows: 140, samples: 12, seed: 19, design: paired(6), coefficient: 6, deficient: [2, 3], effect: 0.5 });
  make('rows without residual df', { rows: 60, samples: 8, seed: 20, design: twoGroups(8), coefficient: 1, zeroDf: 4, effect: 0.5 });
  return cases;
}

// --- diffcyt-DS-limma end to end -----------------------------------------------------------------

// Cells only (not beads, debris, dead cells or doublets), with their true population as a cluster
// channel ("cluster", 1 to K): the input diffcyt expects (pre-gated cells with cluster labels).
const NOT_CELLS = new Set(['Dead cells', 'Debris', 'Doublets', 'Beads']);

function cellsFile(name, dataset, keep, cluster) {
  const parameters = [...dataset.parameters.map((p) => ({ name: p.name, label: p.label ?? '', range: p.range })), { name: 'cluster', label: '', range: 64 }];
  const n = keep.length;
  const columns = dataset.parameters.map((p) => {
    const source = dataset.data[p.index];
    return Float32Array.from(keep, (i) => source[i]);
  });
  columns.push(Float32Array.from({ length: n }, (_, k) => cluster[k]));
  return { name, bytes: encodeFCS(parameters, columns, { $CYT: 'Helios-like (validation)' }) };
}

// The experiments: { name, files: [{ name, bytes }], samples: [{ name, group, subject, batch }],
// levels (reference first), contrast, pairField, covariates, clusters: [names], truth(cluster,
// marker) → true when the marker's distribution differs between the groups in that cluster }.
export function stateExperiments() {
  const out = [];
  // 1. Case against control in two batches; markers do not differ (non-classical monocytes are
  // more frequent in cases, which is differential abundance, not state).
  {
    const { files } = generateExample('cytof-cohort', { scale: 0.2, truth: true });
    const names = files[1].meta.truth.names;
    const clusters = names.filter((n) => !NOT_CELLS.has(n));
    const made = [];
    const samples = [];
    for (const file of files.filter((f) => f.meta.role === 'sample')) {
      const dataset = parseFCS(file.bytes).datasets[0];
      const labels = file.meta.truth.labels;
      const keep = [];
      const cluster = [];
      for (let i = 0; i < labels.length; i += 1) {
        const k = clusters.indexOf(file.meta.truth.names[labels[i]]);
        if (k >= 0) { keep.push(i); cluster.push(k + 1); }
      }
      made.push(cellsFile(file.name, dataset, keep, cluster));
      samples.push({ name: file.name, group: file.meta.condition, subject: file.meta.subject, batch: file.meta.batch });
    }
    out.push({ name: 'cohort', title: 'Mass cytometry cohort: case vs control, batch in the design', files: made, samples, levels: ['Control', 'Case'], contrast: 'Case', pairField: null, covariates: ['batch'], clusters, truth: () => false });
  }
  // 2. The barcoded plate split by well: stimulated against unstimulated, paired by donor.
  {
    const { files } = generateExample('cytof-barcoded', { scale: 1, truth: true });
    const file = files[0];
    const { labels, names, wells, wellNames } = file.meta.truth;
    const dataset = parseFCS(file.bytes).datasets[0];
    const clusters = names.filter((n) => !NOT_CELLS.has(n));
    const made = [];
    const samples = [];
    wellNames.forEach((well, w) => {
      const keep = [];
      const cluster = [];
      for (let i = 0; i < labels.length; i += 1) {
        if (wells[i] !== w) continue;
        const k = clusters.indexOf(names[labels[i]]);
        if (k >= 0) { keep.push(i); cluster.push(k + 1); }
      }
      const [donor, condition] = well.split('_');
      made.push(cellsFile(`${well}.fcs`, dataset, keep, cluster));
      samples.push({ name: `${well}.fcs`, group: condition, subject: donor, batch: 'Plate1' });
    });
    const activated = new Set(ACTIVATED_POPULATIONS);
    const changed = new Set(ACTIVATION_MARKERS);
    out.push({ name: 'plate', title: 'Barcoded plate by well: stimulated vs unstimulated, paired by donor', files: made, samples, levels: ['Unstim', 'Stim'], contrast: 'Stim', pairField: 'subject', covariates: [], clusters, truth: (cluster, marker) => activated.has(cluster) && changed.has(marker) });
  }
  return out;
}

// The populations and markers activation changes (examples.js: ACTIVATED_FRACTION and activate()).
export const ACTIVATED_POPULATIONS = ['CD4 naive T', 'CD4 central memory T', 'CD4 effector memory T', 'CD4 TEMRA', 'Regulatory T', 'CD8 naive T', 'CD8 central memory T', 'CD8 effector memory T', 'CD8 TEMRA', 'Gamma-delta T'];
export const ACTIVATION_MARKERS = ['CD25', 'HLA-DR', 'CD127', 'CD45RA', 'CCR7', 'CD38', 'PD-1', 'CD3'];

// CytoWeave's analysis of an experiment: the files opened as samples (no compensation: mass
// cytometry), the markers CytoWeave proposes, per-sample counts and medians of each cluster, the
// design and diffcyt-DS-limma. Returns { ws, views, samples, markers, design, perSample, result }.
export function analyzeExperiment(experiment, options = {}) {
  let ws = createWorkspace(experiment.name);
  const views = [];
  for (const [i, file] of experiment.files.entries()) {
    const dataset = parseFCS(file.bytes).datasets[0];
    const record = { ...sampleFromDataset(dataset, { name: file.name }), meta: { group: experiment.samples[i].group, subject: experiment.samples[i].subject, batch: experiment.samples[i].batch } };
    ws = addSamples(ws, [record]);
    views.push(new SampleView(ws.samples[ws.samples.length - 1], dataset));
  }
  const markers = options.markers ?? markerCandidates(views[0]).filter((c) => c.selected).map((c) => c.name);
  const labels = experiment.clusters.map((_, k) => k + 1);
  const cofactor = defaultCofactor(ws.samples[0]);
  const perSample = views.map((view) => stateMedians(view, ws, { kind: 'clusters', channel: 'cluster', parentId: ROOT, labels }, markers, cofactor));
  const samples = ws.samples.map((s) => ({ ...s, group: s.meta.group }));
  const { design, coefficient, covariates } = buildDesign(samples, { levels: experiment.levels, contrast: experiment.contrast, pairField: experiment.pairField, covariates: experiment.covariates });
  const result = differentialState({ counts: perSample.map((p) => p.counts), medians: perSample.map((p) => p.medians), design, coefficient, units: labels, markers, ...options.state });
  return { ws, views, samples, markers, labels, cofactor, design, coefficient, covariates, perSample, result };
}
