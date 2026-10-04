// Published strategies (strategies.js) applied to the PBMC example (the `strategies` suite of
// run.mjs): their recipe gates are placed on one sample's data, shared by every sample as applied
// gates are, and each population is compared with the simulator's true cell types (F1).

import { generateExample } from '../web/lib/examples.js';
import { readSpillover } from '../web/lib/fcs.js';
import { placeOnSample } from '../web/lib/recipes.js';
import { applyTemplate } from '../web/lib/templates.js';
import { loadSamples } from './template-cases.mjs';
import { f1 } from './autogating-cases.mjs';

// The true cell types each strategy population stands for.
export const TRUTH = {
  'Single cells': (n) => !['Debris', 'Doublets', 'Junk'].includes(n),
  Live: (n) => !['Debris', 'Doublets', 'Junk', 'Dead cells'].includes(n),
  Leukocytes: (n) => !['Debris', 'Doublets', 'Junk', 'Dead cells'].includes(n),
  Lymphocytes: (n) => /( T|T$|NK| B|^B|Plasmablast|Other lymphoid|Gamma-delta|TEMRA|Regulatory)/.test(n) && !/monocyte|DC|Basophil|Neutrophil/i.test(n),
  'T cells': (n) => / T$|Regulatory T|TEMRA|Gamma-delta T/.test(n),
  'CD4 T cells': (n) => /^CD4 |Regulatory T/.test(n),
  'CD3+ CD4+ T cells': (n) => /^CD4 |Regulatory T/.test(n),
  'CD8 T cells': (n) => /^CD8 /.test(n),
  'CD4 naive': (n) => n === 'CD4 naive T',
  'CD4 central memory': (n) => n === 'CD4 central memory T',
  'CD4 effector memory': (n) => n === 'CD4 effector memory T',
  'CD4 TEMRA': (n) => n === 'CD4 TEMRA',
  'CD8 naive': (n) => n === 'CD8 naive T',
  'CD8 central memory': (n) => n === 'CD8 central memory T',
  'CD8 effector memory': (n) => n === 'CD8 effector memory T',
  'CD8 TEMRA': (n) => n === 'CD8 TEMRA',
  'B cells': (n) => /^(Naive B|Memory B|Plasmablasts)$/.test(n),
  'NK cells': (n) => / NK$/.test(n),
  'Classical monocytes': (n) => n === 'Classical monocytes',
  'Intermediate monocytes': (n) => n === 'Intermediate monocytes',
  'Non-classical monocytes': (n) => n === 'Non-classical monocytes',
  Tregs: (n) => n === 'Regulatory T',
};

export function pbmcCohort(scale = 0.25) {
  const { files } = generateExample('pbmc-immunophenotyping', { scale });
  const samples = files.filter((f) => /^D0/.test(f.name));
  const { ws, views } = loadSamples(samples, 'strategies');
  // The files' matrix under-compensates APC into Alexa Fluor 700 by design (the compensation
  // check's planted error); strategies assume a correct matrix, so the true one is used.
  for (const view of views.values()) {
    const spill = readSpillover(view.dataset.keywords, view.parameters);
    const n = spill.channels.length;
    const matrix = Array.from(spill.matrix);
    matrix[spill.channels.indexOf('APC-A') * n + spill.channels.indexOf('Alexa Fluor 700-A')] /= 0.7;
    view.setCompensation({ id: 'file', channels: spill.channels, matrix });
  }
  const truth = new Map(ws.samples.map((s) => [s.id, samples.find((f) => f.name.replace(/\.fcs$/i, '') === s.name || f.name === s.fileName).meta.truth]));
  return { ws, views, truth };
}

// The place callback of applyTemplate for recipes, on one sample's events.
export const placeOn = placeOnSample;

// A strategy applied to the cohort, its recipes placed on the reference sample: { ws, report, rows:
// [{ population, f1: [per sample], median, min }] }.
export function applyStrategy(cohort, strategy, reference = 'D01_Unstim') {
  const sample = cohort.ws.samples.find((s) => s.name === reference) ?? cohort.ws.samples[0];
  const { ws, report, idMap } = applyTemplate(cohort.ws, strategy, { place: placeOn(cohort.views.get(sample.id), sample.name) });
  const rows = [];
  for (const g of strategy.gates) {
    const id = idMap.get(g.id);
    if (!id || !TRUTH[g.name]) continue;
    // A population's truth within its strategy parent's (live cells under lymphocytes are live
    // lymphocytes).
    const chain = [];
    for (let at = g; at; at = strategy.gates.find((x) => x.id === at.parentId)) if (TRUTH[at.name]) chain.push(TRUTH[at.name]);
    const isMember = (n) => chain.every((fn) => fn(n));
    const scores = ws.samples.map((s) => f1(ws, cohort.views, cohort.truth, id, s.id, isMember)).filter(Number.isFinite);
    const sorted = [...scores].sort((a, b) => a - b);
    rows.push({ population: g.name, f1: scores, median: sorted[Math.floor(sorted.length / 2)], min: sorted[0] });
  }
  return { ws, report, rows };
}
