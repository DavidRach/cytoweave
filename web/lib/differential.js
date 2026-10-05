// Differential testing across samples of a design (Compare's screens and the differential_analysis
// agent tool): cluster counts and per-sample marker medians of clusters or populations, the design
// matrix of groups, pairing and covariates, and differential state by diffcyt-DS-limma (Weber et
// al. 2019, doi:10.1038/s42003-019-0415-5): marker medians of arcsinh-transformed values per
// cluster and sample, clusters with too few cells in too many samples left out, and limma's
// moderated t-statistics (limma.js) with the cells per sample as weights and a mean-variance
// trend, adjusted by Benjamini–Hochberg across every cluster and marker tested.

import { population } from './engine.js';
import { designMatrix } from './hypothesis.js';
import { eBayes, lmFit } from './limma.js';
import { markerCandidates } from './explore.js';
import { ROOT } from './workspace.js';

// diffcyt's cofactors: 5 for mass cytometry counts, 150 for fluorescence.
export const defaultCofactor = (sample) => (sample?.technology === 'mass' ? 5 : 150);

// Cluster labels among a parent population's events: { events (indices into the sample), labels
// (Int32Array, −1 for none), total } or null when the sample lacks the channel or the parent.
export function clusterLabels(view, ws, channel, parentId = ROOT) {
  if (!view.hasChannel(channel)) return null;
  const parent = population(view, ws, parentId ?? ROOT);
  if (parent === undefined) return null;
  const n = parent ? parent.length : view.eventCount;
  const column = view.column(channel);
  const events = parent ? Uint32Array.from(parent) : Uint32Array.from({ length: n }, (_, i) => i);
  const labels = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = column[events[i]];
    labels[i] = Number.isFinite(v) && v >= 0 ? Math.round(v) : -1;
  }
  return { events, labels, total: n };
}

// Derived channels that hold cluster labels (integer categories): [{ name, record }], from the
// workspace's derived records, or else any loaded derived channel with few integer values.
export function clusterChannels(ws, views = []) {
  const out = [];
  for (const record of ws.derived ?? []) {
    for (const output of record.outputs ?? []) {
      const byName = /cluster|metacluster|leiden|louvain|phenograph|kmeans|som|label|population/i.test(`${record.kind} ${output}`);
      if (byName && !/umap|tsne|t-sne|pca|pc\d|embedding|mask|score|abundance/i.test(output)) out.push({ name: output, record });
    }
  }
  if (!out.length) {
    // Fall back to any loaded derived channel with few integer values.
    for (const view of views) {
      for (const [name, column] of view.derived) {
        if (out.some((c) => c.name === name)) continue;
        const seen = new Set();
        let integer = true;
        for (let i = 0; i < Math.min(column.length, 4000) && integer; i += 1) {
          const v = column[i];
          if (Number.isFinite(v) && v !== Math.round(v)) integer = false;
          seen.add(v);
        }
        if (integer && seen.size >= 2 && seen.size <= 300) out.push({ name, record: null });
      }
    }
  }
  return out;
}

// A cluster's name from its derived record (Explore keeps them in summary.clusters.names), or
// "Cluster k + 1", as Explore numbers them.
export function clusterNameOf(record, k) {
  const names = record?.summary?.clusters?.names ?? record?.summary?.names ?? record?.names;
  return (Array.isArray(names) ? names[k] : names?.[k]) ?? `Cluster ${k + 1}`;
}

// Counts of each cluster label among a parent population's events: { counts: Map, total }.
export function clusterCounts(view, ws, channel, parentId = ROOT) {
  const found = clusterLabels(view, ws, channel, parentId);
  if (!found) return null;
  const counts = new Map();
  for (const k of found.labels) if (k >= 0) counts.set(k, (counts.get(k) ?? 0) + 1);
  return { counts, total: found.total };
}

// The median as R computes it (the mean of the two middle values for an even count).
function medianOf(values) {
  const n = values.length;
  if (!n) return Number.NaN;
  values.sort();
  const half = Math.floor((n + 1) / 2);
  return n % 2 ? values[half - 1] : (values[half - 1] + values[half]) / 2;
}

// Per-sample cell counts and marker medians (of asinh(x / cofactor), on compensated values) of each
// unit: units = { kind: 'clusters', channel, parentId, labels: [label…] } (labels found when
// omitted) or { kind: 'populations', gateIds: [id…] }. Returns { units: [id…], counts
// (Float64Array per unit), medians: [marker index][unit index] } with NaN medians for no cells.
export function stateMedians(view, ws, units, markers, cofactor) {
  const groups = new Map(); // unit id → event indices
  if (units.kind === 'clusters') {
    const found = clusterLabels(view, ws, units.channel, units.parentId);
    if (found) {
      const byLabel = new Map();
      for (const k of found.labels) if (k >= 0) byLabel.set(k, (byLabel.get(k) ?? 0) + 1);
      const lists = new Map([...byLabel].map(([k, n]) => [k, { at: 0, events: new Uint32Array(n) }]));
      found.labels.forEach((k, i) => {
        if (k < 0) return;
        const list = lists.get(k);
        list.events[list.at] = found.events[i];
        list.at += 1;
      });
      for (const [k, list] of lists) groups.set(k, list.events);
    }
  } else {
    for (const id of units.gateIds) {
      const events = population(view, ws, id);
      if (events !== undefined) groups.set(id, events ?? Uint32Array.from({ length: view.eventCount }, (_, i) => i));
    }
  }
  const ids = units.kind === 'clusters' && units.labels ? units.labels : units.kind === 'clusters' ? [...groups.keys()].sort((a, b) => a - b) : units.gateIds;
  const counts = Float64Array.from(ids, (id) => groups.get(id)?.length ?? 0);
  const medians = markers.map((marker) => {
    const column = view.hasChannel(marker) ? view.column(marker) : null;
    return ids.map((id) => {
      const events = groups.get(id);
      if (!column || !events?.length) return Number.NaN;
      const values = new Float64Array(events.length);
      for (let i = 0; i < events.length; i += 1) values[i] = Math.asinh(column[events[i]] / cofactor);
      return medianOf(values);
    });
  });
  return { units: ids, counts, medians };
}

// Markers to test by default: the samples' marker channels, without those a cluster record was
// made from (diffcyt's "type" markers; the rest are "state" markers) when that leaves any.
export function stateMarkerCandidates(view, record = null) {
  const candidates = markerCandidates(view).filter((c) => c.selected);
  const used = new Set(record?.params?.markers ?? []);
  const state = candidates.filter((c) => !used.has(c.name));
  return { candidates, state: state.length ? state : candidates, clustering: candidates.filter((c) => used.has(c.name)) };
}

// The design: samples [{ group, pair?, meta }], levels (keys, reference first), the tested level,
// pairing and covariate fields. Treatment contrasts with the reference level; pairing and
// covariates enter as fixed effects; factors with a single level among the samples are left out.
// Returns { design (designMatrix), coefficient (name), covariates (names kept) }.
export function buildDesign(samples, { levels, contrast = levels[1], pairField = null, covariates = [] }) {
  const variables = [{ name: 'group', values: samples.map((s) => s.group), type: 'factor', reference: levels[0] }];
  if (pairField) variables.push({ name: pairField, values: samples.map((s) => String(s.meta?.[pairField] ?? 'NA')), type: 'factor' });
  for (const field of covariates.filter((f) => f !== pairField)) variables.push({ name: field, values: samples.map((s) => String(s.meta?.[field] ?? 'NA')), type: 'factor' });
  const kept = variables.filter((v, i) => i === 0 || new Set(v.values).size >= 2);
  const design = designMatrix(kept);
  const coefficient = `group[${contrast}]`;
  if (!design.names.includes(coefficient)) throw new Error(`No samples in group "${contrast}".`);
  if (samples.length <= design.p) throw new Error(`The model has ${design.p} coefficients but only ${samples.length} samples; remove covariates or add samples.`);
  return { design, coefficient, covariates: kept.slice(1).map((v) => v.name) };
}

// diffcyt-DS-limma (testDS_limma, diffcyt 1.32): counts[s][u] cells and medians[s][m][u] per
// sample s, unit u and marker m; design rows per sample. Units with at least minCells cells in at
// least minSamples samples (default half the samples) are tested; rows are marker by marker over
// the kept units, as diffcyt orders them. Returns { rows, kept, filtered, dfPrior, legacy }.
export function differentialState({ counts, medians, design, coefficient, units, markers, minCells = 3, minSamples = null, trend = true, weights = true }) {
  const S = counts.length;
  const needed = minSamples ?? S / 2;
  const coef = typeof coefficient === 'string' ? design.names.indexOf(coefficient) : coefficient;
  if (coef < 0) throw new Error(`Coefficient "${coefficient}" is not in the design.`);
  const kept = [];
  const filtered = [];
  units.forEach((unit, u) => {
    let enough = 0;
    for (let s = 0; s < S; s += 1) if (counts[s][u] >= minCells) enough += 1;
    (enough >= needed ? kept : filtered).push(u);
  });
  if (!kept.length) throw new Error(`Nothing to test: no cluster or population has at least ${minCells} cells in ${needed} or more of the ${S} samples.`);
  const y = [];
  const w = [];
  const index = [];
  markers.forEach((marker, m) => {
    for (const u of kept) {
      y.push(Array.from({ length: S }, (_, s) => medians[s][m][u]));
      w.push(Array.from({ length: S }, (_, s) => counts[s][u]));
      index.push({ unit: units[u], u, marker, m });
    }
  });
  const rows = design.matrix ?? design;
  const fit = lmFit(y, rows, { weights: weights ? w : null, coefficient: coef });
  const result = eBayes(fit, { trend });
  return {
    rows: index.map((r, g) => ({
      ...r, logFC: result.coefficient[g], aveExpr: result.Amean[g], t: result.t[g], p: result.p[g], padj: result.padj[g],
      dfResidual: result.dfResidual[g], dfTotal: result.dfTotal[g], samples: y[g].filter((v, s) => Number.isFinite(v) && (!weights || w[g][s] > 0)).length,
    })),
    kept: kept.map((u) => units[u]),
    filtered: filtered.map((u) => units[u]),
    dfPrior: result.dfPrior,
    legacy: result.legacy,
    minSamples: needed,
  };
}

// The methods sentence of a differential state analysis.
export function stateMethods({ unitsLabel, markers, contrastLabel, referenceLabel, covariates = [], cofactor, minCells, minSamples, tested, version = '' }) {
  return `Differential state of ${markers.length} marker${markers.length === 1 ? '' : 's'} in ${unitsLabel} between ${contrastLabel} and ${referenceLabel} was tested with diffcyt-DS-limma (Weber et al. 2019) as implemented in CytoWeave ${version}: per sample, the median of arcsinh(x / ${cofactor}) of each marker in each ${/population/.test(unitsLabel) ? 'population' : 'cluster'}, those with at least ${minCells} cells in at least ${minSamples} samples kept, a linear model per ${/population/.test(unitsLabel) ? 'population' : 'cluster'} and marker (design ~ group${covariates.length ? ` + ${covariates.join(' + ')}` : ''}) weighted by the cells in each sample, empirical Bayes moderated t-statistics with a mean–variance trend (limma; Smyth 2004; Ritchie et al. 2015), and p-values adjusted across all ${tested} combinations by the Benjamini–Hochberg procedure.`;
}

export const STATE_CITATIONS = [
  'diffcyt: Weber et al. 2019, Commun Biol 2:183, doi:10.1038/s42003-019-0415-5',
  'limma: Ritchie et al. 2015, Nucleic Acids Res 43:e47, doi:10.1093/nar/gkv007',
  'Moderated t-statistics: Smyth 2004, Stat Appl Genet Mol Biol 3:3, doi:10.2202/1544-6115.1027',
  'Unequal residual df: Chen et al. 2025, Nucleic Acids Res 53:gkaf018, doi:10.1093/nar/gkaf018',
];
