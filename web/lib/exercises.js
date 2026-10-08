// Teaching mode: exercises on the simulated examples, checked against the simulator's truth.
//
// An exercise is an analysis a teacher would set, on an example generated with a seed of the
// attempt's own (a class code gives a class the same data), with the answer given in a short form
// rather than in words. Its truth comes from the simulator's record of that attempt's data and is
// never stored in the workspace: the workspace keeps only the exercise's id and seed, and the
// truth is computed again from them when the learner checks or reveals (ui/exercises.js).
//
// Each exercise has:
//   id, title, level ('beginner' | 'intermediate' | 'advanced'), minutes, topic, views (where the
//     work is done)
//   example: { id, scale, gates (add the example's suggested gates when it opens) }
//   setup(seed): the attempt's own choices (a planted fault, the serum asked about), plain data
//   options(setup): generation options for examples.js beyond { seed, scale }
//   brief(setup): what to do, as a teacher would ask it
//   hints(setup): hints, shown one at a time, the last nearest to the answer
//   questions(setup): [{ id, label, kind, options?, unit?, sample? }], kinds:
//     'population' (one of the workspace's gates, measured against the true events of `sample`),
//     'sample' (a sample's name), 'channel' (a fluorescence channel), 'choice', 'choices' (several)
//     and 'number'
//   truthSamples(setup): the files the truth needs, which are generated again for it: null (none),
//     'all', or file names
//   truth(generated, setup): the answers, from the generated files' records; a population
//     question's true events go in truth.events[questionId] = { sample, indices }
//   grade(answers, truth, measures, setup): { parts: [{ name, weight, score, detail }] }, scores
//     between 0 and 1; measures[questionId] = measurePopulation(...) for population questions
//   explain(truth, setup): what was planted and why, shown when the truth is revealed
// Everything here is pure: it runs in the window, in workers and in Node.

import { BEAD_ANALYTES, COUNTING, COUNT_PATIENTS, PBMC_PANEL, PRECURSOR_FREQUENCIES, SCREEN_COMPOUNDS, TITRATION, proliferationStatistics } from './examples.js';
import { INSTRUMENTS, buildPanel, createRandom, deriveSeed } from './simulate.js';

// Version of the exercises: a workspace made by another version is checked against that version's
// truth only if its data still match (the files' checksums are compared when the truth is made).
export const EXERCISES_VERSION = 1;

// --- Scores ---------------------------------------------------------------------------------------

const clamp = (v) => Math.max(0, Math.min(1, v));
// 1 at an error up to `full`, falling linearly to 0 at `zero`.
const closeness = (error, full, zero) => (Number.isFinite(error) ? clamp(1 - (error - full) / (zero - full)) : 0);
const number = (v) => (typeof v === 'number' ? v : Number.parseFloat(String(v ?? '').replace(/[^\d.eE+-]/g, '')));
const part = (name, weight, score, detail) => ({ name, weight, score: clamp(score), detail });
const fmt = (v, digits = 1) => (Number.isFinite(v) ? `${+v.toFixed(digits)}` : '—');
const stripFCS = (name) => String(name ?? '').replace(/\.fcs$/i, '');

// An exercise's score: the weighted sum of its parts.
export function totalScore(graded) {
  const parts = graded?.parts ?? [];
  const weight = parts.reduce((a, p) => a + p.weight, 0) || 1;
  return parts.reduce((a, p) => a + p.weight * p.score, 0) / weight;
}

// A population (an EventSet or anything with has(e) and count) against the true events (sorted
// indices): { f1, precision, recall, n, truthN, truePositives }.
export function measurePopulation(set, indices) {
  const n = set ? set.count : 0;
  let tp = 0;
  if (set) for (const e of indices) if (set.has(e)) tp += 1;
  const precision = n ? tp / n : 0;
  const recall = indices.length ? tp / indices.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { f1, precision, recall, n, truthN: indices.length, truePositives: tp };
}

// The events of a file whose true population matches `test(name)`, as sorted indices.
function eventsWhere(file, test) {
  const { labels, names } = file.meta.truth;
  const match = names.map((name) => test(name));
  const out = [];
  for (let e = 0; e < labels.length; e += 1) if (labels[e] >= 0 && match[labels[e]]) out.push(e);
  return Uint32Array.from(out);
}

const fileNamed = (generated, name) => {
  const file = generated.files.find((f) => f.name === name);
  if (!file) throw new Error(`The exercise's data have no file ${name}.`);
  return file;
};

// A choice from the seed: the same seed gives the same choice, whatever else changes.
const random = (seed, key) => createRandom(deriveSeed(seed, 'exercise', key));
const pick = (seed, key, list) => list[Math.floor(random(seed, key)() * list.length)];
const between = (seed, key, lo, hi) => lo + (hi - lo) * random(seed, key)();
const shuffled = (seed, key, list) => {
  const r = random(seed, key);
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

// --- The exercises --------------------------------------------------------------------------------

const PBMC_STAINED = ['D01', 'D02', 'D03', 'D04', 'D05', 'D06'].flatMap((d) => [`${d}_Unstim.fcs`, `${d}_Stim.fcs`]);
const PBMC_CHANNELS = PBMC_PANEL.map((a) => `${a.marker} (${a.fluor}, ${a.detector})`).join('; ');
const isTCell = (name) => / T$|TEMRA$/.test(name);
const isCD4T = (name) => /^CD4 /.test(name) || name === 'Regulatory T';
const QC_PROBLEM_OF = { none: 'clean', clog: 'clog', drift: 'drift', burst: 'bubble' };
const BEAD_DETECTORS = ['BUV395-A', 'BUV496-A', 'BUV737-A', 'BV421-A', 'BV510-A', 'BV605-A', 'BV650-A', 'BV711-A', 'BV786-A', 'FITC-A', 'PerCP-Cy5-5-A', 'PE-A', 'PE-CF594-A', 'PE-Cy5-A', 'PE-Cy7-A', 'APC-A', 'Alexa Fluor 700-A', 'APC-Cy7-A'];
const LASER_NAMES = { UV: 'ultraviolet (355 nm)', V: 'violet (405 nm)', B: 'blue (488 nm)', YG: 'yellow-green (561 nm)', R: 'red (640 nm)' };
const LASER_OF = (detector) => (/^BUV/.test(detector) ? 'UV' : /^BV/.test(detector) ? 'V' : /^(FITC|PerCP)/.test(detector) ? 'B' : /^PE/.test(detector) ? 'YG' : 'R');
const CYTOF_CANDIDATES = ['Non-classical monocytes', 'Plasmacytoid DC', 'Memory B', 'Gamma-delta T', 'Basophils'];
const QC_KINDS = [
  { value: 'clean', label: 'Clean: no problem' },
  { value: 'clog', label: 'A clog: the flow slows or stops' },
  { value: 'bubble', label: 'An air bubble: a burst of junk events' },
  { value: 'drift', label: 'Drift: signals change gradually' },
];
const SPECTRAL_DYES = ['BUV395', 'BUV496', 'BUV563', 'BUV615', 'BUV661', 'BUV737', 'BUV805', 'BV421', 'BV480', 'Aqua', 'BV570', 'BV605', 'BV650', 'BV711', 'BV750', 'BV786', 'FITC', 'PerCP-Cy5.5', 'PE', 'PE-CF594', 'PE-Cy5', 'PE-Cy7', 'APC', 'Alexa Fluor 700', 'APC-Cy7'];
// Tandems that can be degraded in the spectral example, and the marker each carries there.
const SPECTRAL_TANDEMS = { 'PE-Cy7': 'CD45', 'PE-Cy5': 'CD11c', 'APC-Cy7': 'CD4', 'PE-CF594': 'CD28' };
const TITRATION_STEPS = Array.from({ length: 10 }, (_, k) => 1000 / 2 ** k);
const ngLabel = (v) => `${+v.toPrecision(3)} ng`;

export const EXERCISES = [
  {
    id: 'gate-t-cells',
    title: 'Gate the T cells',
    level: 'beginner',
    minutes: 10,
    topic: 'Gating',
    views: ['Gate'],
    example: { id: 'pbmc-immunophenotyping', scale: 0.3 },
    setup: () => ({}),
    brief: () => 'Six donors\' PBMC stained with a 14-color panel. In D01_Unstim, gate the T cells: single, live lymphocytes that are CD3+. Then give the T cells\' percentage of all the events in the file.',
    hints: () => [
      'Work from the top down, one gate inside another: cells (leave out the debris at low FSC), then single cells, then live cells, then lymphocytes, then CD3+.',
      'Single cells: plot FSC-A against FSC-H. Single cells lie on the diagonal; doublets have more area for their height.',
      `The viability dye is Aqua, read in BV510-A: live cells are the dim ones. The panel: ${PBMC_CHANNELS}.`,
      'Lymphocytes are the small cells with low side scatter (FSC-A against SSC-A); monocytes are larger and more granular. CD3 is read in BV605-A.',
      'The inspector shows the selected population\'s "% of total": the percentage of all events.',
    ],
    questions: () => [
      { id: 'tCells', label: 'Your T-cell population', kind: 'population', sample: 'D01_Unstim.fcs' },
      { id: 'percent', label: 'T cells as a percentage of all events in D01_Unstim', kind: 'number', unit: '%' },
    ],
    truthSamples: () => ['D01_Unstim.fcs'],
    truth(generated) {
      const file = fileNamed(generated, 'D01_Unstim.fcs');
      const indices = eventsWhere(file, isTCell);
      return { events: { tCells: { sample: 'D01_Unstim.fcs', indices } }, percent: (100 * indices.length) / file.meta.truth.labels.length };
    },
    grade(answers, truth, measures) {
      const m = measures.tCells;
      const percent = number(answers.percent);
      return { parts: [
        part('Your gate holds the true T cells (F1 of 0.9 or more for full marks)', 0.6, m ? closeness(1 - m.f1, 0.1, 0.3) : 0, m ? `F1 ${m.f1.toFixed(3)}: ${(100 * m.recall).toFixed(1)}% of the true T cells are in your gate, and ${(100 * m.precision).toFixed(1)}% of your gate's events are T cells` : 'No population chosen'),
        part('The percentage of all events (within 1.5 points for full marks)', 0.4, closeness(Math.abs(percent - truth.percent), 1.5, 5), `${fmt(percent, 2)}%; the true T cells are ${truth.percent.toFixed(2)}% of the events`),
      ] };
    },
    explain: (truth) => [
      `The simulator made every event, so it knows which ones are T cells: ${truth.percent.toFixed(2)}% of the events in D01_Unstim. They include conventional CD4 and CD8 T cells, regulatory T cells and γδ T cells.`,
      'Your gate loses true T cells when a parent gate cuts into them: a tight lymphocyte gate, a viability gate that also drops some live cells, or a CD3 boundary placed too high. It takes in other cells when a gate is loose: monocytes in the lymphocyte gate, doublets, or dim CD3− events.',
    ],
  },
  {
    id: 'gate-tregs',
    title: 'Find the regulatory T cells',
    level: 'intermediate',
    minutes: 15,
    topic: 'Gating',
    views: ['Gate'],
    example: { id: 'pbmc-immunophenotyping', scale: 0.3, gates: true },
    setup: () => ({}),
    brief: () => 'The workspace has a gating strategy down to the T cells. In D01_Unstim, gate the regulatory T cells among the CD4 T cells, and give their percentage of the CD4 T cells.',
    hints: () => [
      'First gate the CD4 T cells inside "T cells": CD4 (Alexa Fluor 700-A) against CD8 (APC-A).',
      'Regulatory T cells are CD25 high and CD127 low: plot CD127 (PE-Cy7-A) against CD25 (PE-A) for the CD4 T cells.',
      'They are a small population, a few percent of CD4 T cells, set apart from the CD127+ conventional cells. A polygon around the CD25+ CD127-dim corner fits them better than a quadrant.',
      'The inspector gives the selected population\'s percentage of its parent.',
    ],
    questions: () => [
      { id: 'tregs', label: 'Your regulatory T-cell population', kind: 'population', sample: 'D01_Unstim.fcs' },
      { id: 'percent', label: 'Regulatory T cells as a percentage of CD4 T cells', kind: 'number', unit: '%' },
    ],
    truthSamples: () => ['D01_Unstim.fcs'],
    truth(generated) {
      const file = fileNamed(generated, 'D01_Unstim.fcs');
      const indices = eventsWhere(file, (n) => n === 'Regulatory T');
      const cd4 = eventsWhere(file, isCD4T);
      return { events: { tregs: { sample: 'D01_Unstim.fcs', indices } }, percent: (100 * indices.length) / cd4.length };
    },
    grade(answers, truth, measures) {
      const m = measures.tregs;
      const percent = number(answers.percent);
      return { parts: [
        part('Your gate holds the true regulatory T cells (F1 of 0.8 or more for full marks)', 0.7, m ? closeness(1 - m.f1, 0.2, 0.5) : 0, m ? `F1 ${m.f1.toFixed(3)}: ${(100 * m.recall).toFixed(1)}% of the true Tregs are in your gate, and ${(100 * m.precision).toFixed(1)}% of your gate's events are Tregs` : 'No population chosen'),
        part('Their percentage of CD4 T cells (within 1.5 points for full marks)', 0.3, closeness(Math.abs(percent - truth.percent), 1.5, 4), `${fmt(percent, 2)}%; truly ${truth.percent.toFixed(2)}%`),
      ] };
    },
    explain: (truth) => [
      `Regulatory T cells are ${truth.percent.toFixed(2)}% of the true CD4 T cells in D01_Unstim. They were simulated CD25 high (about 16 times conventional naive CD4 T cells) and CD127 low, with CD25 and CD127 slightly anticorrelated.`,
      'Effector memory CD4 T cells carry some CD25 too, so a CD25+ gate alone takes them in; CD127 is what sets the Tregs apart.',
    ],
  },
  {
    id: 'compensation-error',
    title: 'Find the wrong spillover value',
    level: 'intermediate',
    minutes: 15,
    topic: 'Compensation',
    views: ['Compensate'],
    example: { id: 'pbmc-immunophenotyping', scale: 0.3 },
    setup: () => ({}),
    brief: () => 'The stained samples use the spillover matrix the cytometer wrote into the files, and one of its values is wrong. Use the single-stain controls to find which value, and what it should be.',
    hints: () => [
      'The Compensate view holds the matrices: the one from the files, and any you compute from the controls.',
      'Check the file\'s matrix against the controls: each single-stain control is compensated with it, and what remains in other detectors is measured.',
      'A wrong value shows as a control whose dye is left over in one other detector, leaning populations on that pair\'s plot. Read "from" as the dye\'s own detector and "into" as the detector it spills into.',
      'The check suggests a corrected value, and a matrix computed from the controls gives it too.',
    ],
    questions: () => [
      { id: 'from', label: 'The detector the dye is read in ("from")', kind: 'channel' },
      { id: 'into', label: 'The detector it spills into ("into")', kind: 'channel' },
      { id: 'value', label: 'The correct spillover value', kind: 'number', unit: '%' },
    ],
    truthSamples: () => null,
    truth() {
      const panel = buildPanel(INSTRUMENTS.fortessa, PBMC_PANEL);
      const n = panel.spill.channels.length;
      const i = panel.spill.channels.indexOf('APC-A');
      const j = panel.spill.channels.indexOf('Alexa Fluor 700-A');
      return { from: 'APC-A', into: 'Alexa Fluor 700-A', percent: 100 * panel.spill.matrix[i * n + j] };
    },
    grade(answers, truth) {
      const pair = answers.from === truth.from && answers.into === truth.into;
      const value = number(answers.value);
      return { parts: [
        part('The wrong entry', 0.6, pair ? 1 : 0, `${answers.from ?? '?'} into ${answers.into ?? '?'}`),
        part('Its correct value (within 1.5 points for full marks)', 0.4, pair ? closeness(Math.abs(value - truth.percent), 1.5, 5) : 0, pair ? `${fmt(value, 2)}%; truly ${truth.percent.toFixed(2)}%` : 'Scored once the entry is right'),
      ] };
    },
    explain: (truth) => [
      `The files' matrix gives APC's spillover into Alexa Fluor 700-A as far less than it is: truly ${truth.percent.toFixed(2)}%. APC (CD8) is under-compensated in the Alexa Fluor 700 detector (CD4), so CD8 T cells lean up into CD4 on a CD4 × CD8 plot.`,
      'A matrix computed from the controls corrects it. A matrix is checked best against the controls themselves: biology differs between a sample\'s bright and dim events, but a single-stain control holds one dye only.',
    ],
  },
  {
    id: 'find-clog',
    title: 'Find the sample with an acquisition problem',
    level: 'beginner',
    minutes: 10,
    topic: 'Quality control',
    views: ['QC'],
    example: { id: 'pbmc-immunophenotyping', scale: 0.3 },
    setup: (seed) => ({ clogged: pick(seed, 'clog', PBMC_STAINED) }),
    options: (setup) => ({ clogs: [setup.clogged] }),
    brief: () => 'One of the twelve stained PBMC samples had a problem while it was acquired. Which one, and what kind of problem was it?',
    hints: () => [
      'Problems during acquisition show over time: plot a channel, or the event rate, against Time.',
      'QC → Clean runs the acquisition QC on every sample and scores each one.',
      'Look at the event rate: a clog slows or stops the flow; an air bubble throws a burst of junk events; drift changes the signals slowly.',
    ],
    questions: () => [
      { id: 'sample', label: 'The sample', kind: 'sample' },
      { id: 'problem', label: 'The problem', kind: 'choice', options: QC_KINDS.filter((k) => k.value !== 'clean') },
    ],
    truthSamples: () => null,
    truth: (generated, setup) => ({ sample: setup.clogged, problem: 'clog' }),
    grade(answers, truth) {
      const right = stripFCS(answers.sample) === stripFCS(truth.sample);
      return { parts: [
        part('The sample', 0.7, right ? 1 : 0, stripFCS(answers.sample) || 'None chosen'),
        part('The problem', 0.3, right && answers.problem === truth.problem ? 1 : 0, right ? (QC_KINDS.find((k) => k.value === answers.problem)?.label ?? 'None chosen') : 'Scored once the sample is right'),
      ] };
    },
    explain: (truth) => [
      `${stripFCS(truth.sample)} had a clog from about 42% to 54% of its acquisition: the event rate fell about eight times and the signals fell with it, then a short surge followed as the clog cleared.`,
      'Events acquired during a clog are not like the others (slower, dimmer, more doublets), so they shift population frequencies. Acquisition QC removes the stretch, and it can be put back.',
    ],
  },
  {
    id: 'qc-four-wells',
    title: 'Name each acquisition\'s problem',
    level: 'beginner',
    minutes: 10,
    topic: 'Quality control',
    views: ['QC'],
    example: { id: 'qc-showcase', scale: 1 },
    setup: (seed) => ({ wells: shuffled(seed, 'wells', ['none', 'clog', 'drift', 'burst']) }),
    options: (setup) => ({ qcWells: setup.wells }),
    brief: () => 'Four wells of the same stained PBMC, A01 to A04, were acquired from a plate. Check each one for problems during acquisition, and say what, if anything, went wrong with it.',
    hints: () => [
      'Plot the event rate and a few channels against Time for each well.',
      'QC → Clean runs the acquisition QC on every sample and lists what it finds.',
      'A clog: the rate collapses and signals fall, then surge as it clears. An air bubble: a short burst of junk events. Drift: signals change slowly through the run.',
    ],
    questions: () => ['A01', 'A02', 'A03', 'A04'].map((well) => ({ id: well, label: well, kind: 'choice', options: QC_KINDS })),
    truthSamples: () => null,
    truth: (generated, setup) => Object.fromEntries(['A01', 'A02', 'A03', 'A04'].map((well, i) => [well, QC_PROBLEM_OF[setup.wells[i]]])),
    grade(answers, truth) {
      return { parts: Object.entries(truth).map(([well, kind]) => {
        const said = answers[well];
        const label = QC_KINDS.find((k) => k.value === said)?.label ?? 'None chosen';
        if (kind === 'clean') return part(`${well} is clean`, 0.25, said === 'clean' ? 1 : 0, label);
        return part(`${well} has a problem, and which`, 0.25, (said && said !== 'clean' ? 0.6 : 0) + (said === kind ? 0.4 : 0), label);
      }) };
    },
    explain: (truth) => [
      Object.entries(truth).map(([well, kind]) => ({ clean: `${well} is clean.`, clog: `${well} has a clog: the event rate collapses and the signals fall, then surge as it clears.`, drift: `${well} drifts: its fluorescence falls by about 40% through the run.`, bubble: `${well} has an air bubble: a short burst of junk events at about 62% of the run.` })[kind]).join(' '),
      'Finding that a well has a problem matters most: its bad stretch can then be removed. Naming the kind tells you what to fix at the instrument.',
    ],
  },
  {
    id: 'stimulation-test',
    title: 'Test a stimulation effect',
    level: 'intermediate',
    minutes: 20,
    topic: 'Statistics',
    views: ['Gate', 'Compare'],
    example: { id: 'pbmc-immunophenotyping', scale: 0.3, gates: true },
    setup: () => ({}),
    brief: () => 'Six donors\' PBMC were acquired unstimulated and stimulated. Does stimulation change the percentage of CD25+ cells among CD4 T cells? Gate what you need, choose a test that fits this design, and give the direction of the change and its p-value.',
    hints: () => [
      'Gate CD4 T cells inside "T cells", then CD25+ inside them. The samples are annotated with their condition and donor (subject).',
      'Compare compares a population\'s frequency between groups of samples: group by condition.',
      'Each donor gave both an unstimulated and a stimulated sample. Comparing within each donor removes the differences between donors.',
    ],
    questions: () => [
      { id: 'direction', label: 'The change with stimulation', kind: 'choice', options: [{ value: 'up', label: 'CD25+ rises' }, { value: 'down', label: 'CD25+ falls' }, { value: 'none', label: 'No change' }] },
      { id: 'test', label: 'The test that fits this design', kind: 'choice', options: [
        { value: 'welch', label: 'Welch\'s t test of the two groups' },
        { value: 'paired', label: 'A paired t test (or Wilcoxon signed-rank), paired by donor' },
        { value: 'mann-whitney', label: 'A Mann–Whitney U test of the two groups' },
        { value: 'chi-square', label: 'A chi-square test of the pooled cell counts' },
      ] },
      { id: 'p', label: 'The p-value', kind: 'number' },
    ],
    truthSamples: () => null,
    truth: () => ({ direction: 'up', test: 'paired' }),
    grade(answers, truth) {
      const p = number(answers.p);
      return { parts: [
        part('The direction', 0.5, answers.direction === truth.direction ? 1 : 0, answers.direction ?? 'None chosen'),
        part('A test paired by donor', 0.25, answers.test === truth.test ? 1 : 0, answers.test ?? 'None chosen'),
        part('A significant p-value (below 0.05)', 0.25, p > 0 && p < 0.05 ? 1 : 0, Number.isFinite(p) ? String(p) : 'None given'),
      ] };
    },
    explain: () => [
      'Stimulation activated 20–50% of each T-cell subset, raising CD25 about eightfold on them, so CD25+ CD4 T cells rise in every donor.',
      'Each donor gave both samples, so the comparison is paired: the differences within donors are tested, and the donors\' own differences drop out. Pooling cell counts treats cells as independent replicates, which they are not; unpaired tests waste the design.',
    ],
  },
  {
    id: 'spectral-tandem',
    title: 'Diagnose a problem in a spectral panel',
    level: 'advanced',
    minutes: 25,
    topic: 'Spectral unmixing',
    views: ['Spectral'],
    example: { id: 'spectral-25color', scale: 0.4 },
    setup: (seed) => ({ dye: pick(seed, 'tandem', Object.keys(SPECTRAL_TANDEMS)) }),
    options: (setup) => ({ tandemDegradation: { [setup.dye]: 0.1 }, degradationIn: 'samples' }),
    brief: () => 'A 25-color panel on a spectral cytometer: raw detector data, single-stain reference controls, an unstained control and three donors. Unmix the donors. Something is wrong with one of the dyes in the donor samples. Which dye, and what is the most likely cause?',
    hints: () => [
      'The Spectral view unmixes the samples with the reference spectra from the controls.',
      'After unmixing, look for populations that lean or spread where they should not, and at the residuals: the part of each event the references do not explain.',
      'The Diagnose tab looks for the usual causes of a poor unmixing and names the dye.',
      'A tandem dye is a donor and an acceptor coupled together. When it breaks down, part of its light comes from the donor alone.',
    ],
    questions: () => [
      { id: 'dye', label: 'The dye', kind: 'choice', options: SPECTRAL_DYES.map((d) => ({ value: d, label: d })) },
      { id: 'cause', label: 'The most likely cause', kind: 'choice', options: [
        { value: 'tandem', label: 'The tandem dye degraded in the samples' },
        { value: 'wrong-control', label: 'Its reference control was stained with another dye' },
        { value: 'bead-control', label: 'Its bead control differs from the dye on cells' },
        { value: 'autofluorescence', label: 'Autofluorescence that the unstained control lacks' },
      ] },
    ],
    truthSamples: () => null,
    truth: (generated, setup) => ({ dye: setup.dye, cause: 'tandem' }),
    grade(answers, truth) {
      const right = answers.dye === truth.dye;
      return { parts: [
        part('The dye', 0.6, right ? 1 : 0, answers.dye ?? 'None chosen'),
        part('The cause', 0.4, right && answers.cause === truth.cause ? 1 : 0, right ? (answers.cause ?? 'None chosen') : 'Scored once the dye is right'),
      ] };
    },
    explain: (truth) => [
      `${truth.dye} (on ${SPECTRAL_TANDEMS[truth.dye]}) was degraded in the donor samples only: 10% of its emission came from its donor, ${truth.dye.split('-')[0]}, alone. Its single-stain control was made with intact dye, so its reference spectrum no longer matches the dye in the samples.`,
      `Unmixing then puts the donor's light into ${truth.dye.split('-')[0]}'s channel: ${SPECTRAL_TANDEMS[truth.dye]}+ cells look falsely positive there. Tandems degrade with light, heat and fixation; controls stained with the same vial, treated as the samples were, avoid it.`,
    ],
  },
  {
    id: 'titration',
    title: 'Choose an antibody amount',
    level: 'beginner',
    minutes: 10,
    topic: 'Assay setup',
    views: ['QC'],
    example: { id: 'titration-voltage', scale: 0.3 },
    setup: () => ({}),
    brief: () => 'CD4-PE was titrated on PBMC in two-fold steps, the tubes named "CD4-PE … ng", with an unstained tube. How much antibody per test should be used?',
    hints: () => [
      'QC → Titration reads the amount from each tube\'s name and measures how well the stained cells separate from the unstained ones.',
      'The stain index rises as more antibody binds, then levels off once CD4 is saturated; beyond that, more antibody only raises the background.',
      'A common rule: twice the amount that gives 90% of the saturating signal, so small changes in cell numbers do not matter.',
    ],
    questions: () => [{ id: 'amount', label: 'Antibody per test', kind: 'choice', options: TITRATION_STEPS.map((v) => ({ value: String(v), label: ngLabel(v) })) }],
    truthSamples: () => null,
    truth: () => ({ amount: 125, ninety: 9 * TITRATION.kd }),
    grade(answers, truth) {
      const amount = number(answers.amount);
      const score = Math.abs(amount - truth.amount) < 1 ? 1 : (Math.abs(amount - truth.amount / 2) < 1 || Math.abs(amount - truth.amount * 2) < 1) ? 0.4 : 0;
      return { parts: [part('The amount', 1, score, Number.isFinite(amount) ? ngLabel(amount) : 'None chosen')] };
    },
    explain: (truth) => [
      `CD4 binds the antibody with a dissociation constant of ${TITRATION.kd} ng per test, so 90% of CD4 is bound at about ${truth.ninety} ng. Following Bonilla et al. (2024), at least twice that, the first amount tested at or above it: 125 ng.`,
      'Less antibody leaves the signal sensitive to small changes in cell numbers or staining time; more adds non-specific binding to every cell and costs antibody.',
    ],
  },
  {
    id: 'dose-response',
    title: 'Find the most potent compound',
    level: 'intermediate',
    minutes: 20,
    topic: 'Plates',
    views: ['Plates'],
    example: { id: 'plate-screen', scale: 0.6, gates: true },
    setup: () => ({}),
    brief: () => 'A 96-well plate tests six compounds, CW-101 to CW-106, at ten doses each for inhibition of T-cell activation, read as CD69+ among live T cells, with stimulated and unstimulated control wells. Which compound is the most potent, what is its IC50, and which compounds do not inhibit at the doses tested?',
    hints: () => [
      'The Plates view shows each well; color it by % CD69+ of T cells to see the plate at a glance, and check the controls\' Z′.',
      'Dose-response curves (in the Plates view, or from the command search) fit each compound\'s doses.',
      'The most potent compound has the lowest IC50 among those that inhibit fully. A flat curve is an inactive compound; a curve that only starts to fall at the top dose has an IC50 beyond the doses tested.',
    ],
    questions: () => {
      const compounds = SCREEN_COMPOUNDS.map((c) => ({ value: c.name, label: c.name }));
      return [
        { id: 'mostPotent', label: 'The most potent compound', kind: 'choice', options: compounds },
        { id: 'ic50', label: 'Its IC50', kind: 'number', unit: 'nM' },
        { id: 'inactive', label: 'The compounds that do not inhibit', kind: 'choices', options: compounds },
      ];
    },
    truthSamples: () => null,
    truth() {
      const potent = [...SCREEN_COMPOUNDS].filter((c) => c.inhibition >= 0.9).sort((a, b) => a.ic50 - b.ic50)[0];
      return {
        mostPotent: potent.name,
        ic50: potent.ic50,
        inactive: SCREEN_COMPOUNDS.filter((c) => !c.inhibition).map((c) => c.name),
        active: SCREEN_COMPOUNDS.filter((c) => c.inhibition && c.ic50 < 1000).map((c) => c.name),
        compounds: SCREEN_COMPOUNDS.map((c) => ({ name: c.name, inhibition: c.inhibition, ic50: c.ic50 })),
      };
    },
    grade(answers, truth) {
      const potent = answers.mostPotent === truth.mostPotent;
      const ic50 = number(answers.ic50);
      const inactive = Array.isArray(answers.inactive) ? answers.inactive : [];
      const inactiveRight = truth.inactive.every((c) => inactive.includes(c)) && !truth.active.some((c) => inactive.includes(c));
      return { parts: [
        part('The most potent compound', 0.4, potent ? 1 : 0, answers.mostPotent ?? 'None chosen'),
        part('Its IC50 (within 2× for full marks)', 0.3, potent && ic50 > 0 ? closeness(Math.abs(Math.log2(ic50 / truth.ic50)), 1, 2) : 0, potent ? `${fmt(ic50, 2)} nM; truly ${truth.ic50} nM` : 'Scored once the compound is right'),
        part('The inactive compounds', 0.3, inactiveRight ? 1 : 0, inactive.length ? inactive.join(', ') : 'None chosen'),
      ] };
    },
    explain: (truth) => [
      `Simulated: ${truth.compounds.map((c) => `${c.name} ${c.inhibition ? `${Math.round(100 * c.inhibition)}% inhibition, IC50 ${c.ic50} nM` : 'inactive'}`).join('; ')}.`,
      `${truth.inactive.join(' and ')} does not inhibit. A compound whose IC50 lies beyond the top dose (10 µM) can be called inactive at these doses or left out; either answer is accepted.`,
    ],
  },
  {
    id: 'bead-assay',
    title: 'Read a cytokine concentration',
    level: 'intermediate',
    minutes: 20,
    topic: 'Bead immunoassay',
    views: ['Gate', 'Plates'],
    example: { id: 'bead-immunoassay', scale: 0.6, gates: true },
    setup: (seed) => ({ serum: pick(seed, 'serum', Array.from({ length: 20 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`)), analyte: pick(seed, 'analyte', BEAD_ANALYTES.map((a) => a.name)) }),
    brief: (setup) => `A LEGENDplex-like 8-plex cytokine bead assay on a plate: standards C0 (blank) to C7 (10,000 pg/mL, 4-fold steps) and twenty sera, each diluted 2-fold, in duplicate. Beads A carry IL-2, IL-4, IL-6 and IL-10; beads B IL-17A, IFN-γ, TNF-α and IL-1β, each in that order from the dimmest to the brightest APC level. What is the ${setup.analyte} concentration in serum ${setup.serum}, in pg/mL of serum?`,
    hints: () => [
      'The two bead sizes are gated on scatter. Within each size, the analytes are told apart by their APC level, and the PE reporter grows with the cytokine\'s concentration.',
      'The bead immunoassay analysis (in the population menu, or from the command search) finds each analyte\'s beads, fits the standard curves and reads the samples.',
      'The sera were diluted 2-fold before they were read: the concentration in serum is twice the concentration in the well.',
    ],
    questions: (setup) => [{ id: 'concentration', label: `${setup.analyte} in serum ${setup.serum}`, kind: 'number', unit: 'pg/mL' }],
    truthSamples: () => 'all',
    truth(generated, setup) {
      const file = generated.files.find((f) => generated.workspaceHints.sampleMeta?.[f.name]?.specimen === setup.serum);
      if (!file) throw new Error(`The exercise's data have no serum ${setup.serum}.`);
      return { concentration: file.meta.truth.beads.serum[setup.analyte] };
    },
    grade(answers, truth, measures, setup) {
      const value = number(answers.concentration);
      return { parts: [part(`The ${setup.analyte} concentration (within 20% for full marks)`, 1, value > 0 ? closeness(Math.abs(Math.log(value / truth.concentration)), Math.log(1.2), Math.log(2)) : 0, `${fmt(value, 1)} pg/mL; truly ${truth.concentration.toPrecision(4)} pg/mL`)] };
    },
    explain: (truth, setup) => [
      `Serum ${setup.serum} truly held ${truth.concentration.toPrecision(4)} pg/mL of ${setup.analyte}; its wells held half that, after the 2-fold dilution.`,
      'Concentrations near the bottom of the standard curve are uncertain: the fit flags values outside the quantifiable range, and those should be reported as below it.',
    ],
  },
  {
    id: 'calcium-flux',
    title: 'Compare calcium responses',
    level: 'intermediate',
    minutes: 20,
    topic: 'Kinetics',
    views: ['Gate'],
    example: { id: 'calcium-flux', scale: 0.5 },
    setup: () => ({}),
    brief: () => 'A calcium flux assay with Indo-1: buffer, two doses of anti-CD3 and ionomycin, each added during acquisition. Which stimulus gives the strongest response, and what percentage of all the cells respond to it?',
    hints: () => [
      'Indo-1 shifts from blue to violet emission when it binds calcium, so the violet/blue ratio follows calcium in each cell.',
      'The kinetics analysis (in the population menu) plots a signal or ratio against time, finds the moment the stimulus was added, and measures the baseline, the peak and the share of responding cells.',
      'Responding cells are those whose ratio rises well above the baseline after the stimulus. Use all events, not only T cells, for "all the cells".',
    ],
    questions: () => [
      { id: 'strongest', label: 'The strongest response', kind: 'sample' },
      { id: 'percent', label: 'Its share of responding cells', kind: 'number', unit: '%' },
    ],
    truthSamples: () => ['Buffer.fcs', 'aCD3_low.fcs', 'aCD3_high.fcs', 'Ionomycin.fcs', 'aCD3_high_injected.fcs'],
    truth(generated) {
      const rows = generated.files.map((f) => ({ name: f.name, percent: (100 * f.meta.truth.responder.reduce((a, b) => a + b, 0)) / f.meta.truth.responder.length }));
      const strongest = rows.sort((a, b) => b.percent - a.percent)[0];
      return { strongest: strongest.name, percent: strongest.percent, rows };
    },
    grade(answers, truth) {
      const right = stripFCS(answers.strongest) === stripFCS(truth.strongest);
      const value = number(answers.percent);
      return { parts: [
        part('The strongest response', 0.5, right ? 1 : 0, stripFCS(answers.strongest) || 'None chosen'),
        part('Its share of responding cells (within 10 points for full marks)', 0.5, right ? closeness(Math.abs(value - truth.percent), 10, 25) : 0, right ? `${fmt(value)}%; truly ${truth.percent.toFixed(1)}%` : 'Scored once the sample is right'),
      ] };
    },
    explain: (truth) => [
      `The simulator knows each cell's calcium. Responding cells: ${truth.rows.map((r) => `${stripFCS(r.name)} ${r.percent.toFixed(1)}%`).join(', ')}.`,
      'Ionomycin carries calcium into every cell, bypassing the receptor, so nearly all cells respond: it is the assay\'s positive control. Anti-CD3 acts through the T-cell receptor, so only T cells respond, more at the higher dose.',
    ],
  },
  {
    id: 'cell-cycle',
    title: 'Measure cell-cycle phases',
    level: 'beginner',
    minutes: 15,
    topic: 'Cell cycle',
    views: ['Gate'],
    example: { id: 'cell-cycle', scale: 1 },
    setup(seed) {
      const s = between(seed, 's', 0.2, 0.36);
      const g2m = between(seed, 'g2m', 0.1, 0.2);
      const arrested = between(seed, 'arrest', 0.35, 0.6);
      const sArrested = between(seed, 's-arrest', 0.2, 0.3);
      return { phases: { 'Asynchronous.fcs': { G1: 1 - s - g2m, S: s, G2M: g2m }, 'Nocodazole_16h.fcs': { G1: 1 - sArrested - arrested, S: sArrested, G2M: arrested } } };
    },
    options: (setup) => ({ phases: setup.phases }),
    brief: () => 'Fixed cells of a T-cell line stained with propidium iodide: an asynchronous culture and one treated with nocodazole. Gate the single nuclei, fit the cell cycle, and give the percentage in S phase of the asynchronous culture and in G2/M of the treated one.',
    hints: () => [
      'DNA content is read on a linear scale: PI-A is proportional to the DNA in each nucleus.',
      'Two G1 nuclei stuck together have the DNA of one G2 nucleus. Plot PI-W (or PI-H) against PI-A: doublets are wider for their area, so gate the single nuclei.',
      'From the single nuclei\'s population menu, Cell cycle (DNA content) fits G1 and G2/M peaks with S phase between them.',
    ],
    questions: () => [
      { id: 's', label: 'S phase in Asynchronous', kind: 'number', unit: '%' },
      { id: 'g2m', label: 'G2/M in Nocodazole_16h', kind: 'number', unit: '%' },
    ],
    truthSamples: () => ['Asynchronous.fcs', 'Nocodazole_16h.fcs'],
    truth(generated) {
      const phases = (file) => {
        const count = (name) => eventsWhere(file, (n) => n === name).length;
        const g1 = count('G1'); const s = count('S'); const g2m = count('G2/M');
        const all = g1 + s + g2m;
        return { G1: (100 * g1) / all, S: (100 * s) / all, G2M: (100 * g2m) / all };
      };
      return { asynchronous: phases(fileNamed(generated, 'Asynchronous.fcs')), nocodazole: phases(fileNamed(generated, 'Nocodazole_16h.fcs')) };
    },
    grade(answers, truth) {
      const s = number(answers.s);
      const g2m = number(answers.g2m);
      return { parts: [
        part('S phase in the asynchronous culture (within 3 points for full marks)', 0.5, closeness(Math.abs(s - truth.asynchronous.S), 3, 10), `${fmt(s)}%; truly ${truth.asynchronous.S.toFixed(1)}%`),
        part('G2/M in the treated culture (within 3 points for full marks)', 0.5, closeness(Math.abs(g2m - truth.nocodazole.G2M), 3, 10), `${fmt(g2m)}%; truly ${truth.nocodazole.G2M.toFixed(1)}%`),
      ] };
    },
    explain: (truth) => [
      `True phases of the single nuclei: Asynchronous G1 ${truth.asynchronous.G1.toFixed(1)}%, S ${truth.asynchronous.S.toFixed(1)}%, G2/M ${truth.asynchronous.G2M.toFixed(1)}%; Nocodazole_16h G1 ${truth.nocodazole.G1.toFixed(1)}%, S ${truth.nocodazole.S.toFixed(1)}%, G2/M ${truth.nocodazole.G2M.toFixed(1)}%.`,
      'Nocodazole stops cells in mitosis, so G2/M builds up. Doublets left in the gate count as G2/M and raise it; that is why single nuclei are gated first.',
    ],
  },
  {
    id: 'proliferation',
    title: 'Measure T-cell proliferation',
    level: 'intermediate',
    minutes: 20,
    topic: 'Proliferation',
    views: ['Gate'],
    example: { id: 'proliferation', scale: 1 },
    setup: () => ({}),
    brief: () => 'PBMC labeled with CellTrace Violet and cultured four days with anti-CD3/CD28, beside unstimulated and day-0 tubes. Gate live CD4 T cells in the stimulated tube, fit the generations, and give the percentage of the starting CD4 T cells that divided at least once (% divided).',
    hints: () => [
      'Gate single, live lymphocytes, then CD3+ CD4+ T cells. The viability dye and the panel are in the channel names.',
      'Each division halves the dye, so generations are peaks at halving CellTrace Violet intensity. The day-0 tube marks the undivided peak.',
      'From the CD4 T cells\' population menu, Proliferation (dye dilution) fits the generations and gives the indices. % divided counts starting cells, not cells now: one cell that divided three times is eight cells now but one starting cell.',
    ],
    questions: () => [{ id: 'divided', label: '% divided of the stimulated CD4 T cells', kind: 'number', unit: '%' }],
    truthSamples: () => null,
    truth: () => ({ divided: proliferationStatistics(PRECURSOR_FREQUENCIES.stimulated.CD4).percentDivided, stats: proliferationStatistics(PRECURSOR_FREQUENCIES.stimulated.CD4) }),
    grade(answers, truth) {
      const divided = number(answers.divided);
      return { parts: [part('% divided (within 5 points for full marks)', 1, closeness(Math.abs(divided - truth.divided), 5, 20), `${fmt(divided)}%; truly ${truth.divided.toFixed(1)}%`)] };
    },
    explain: (truth) => [
      `${truth.divided.toFixed(0)}% of the starting CD4 T cells divided (precursor frequencies by generation: ${truth.stats.precursorFrequencies.map((f) => `${Math.round(100 * f)}%`).join(', ')}). Division index ${truth.stats.divisionIndex.toFixed(2)}, proliferation index ${truth.stats.proliferationIndex.toFixed(2)}, expansion index ${truth.stats.expansionIndex.toFixed(2)}.`,
      'Counting cells now overstates division: the cells that divided most are most numerous. The fit divides each generation\'s count by 2 to the power of its generation to count starting cells (Roederer 2011).',
    ],
  },
  {
    id: 'bead-qc',
    title: 'Follow an instrument with daily beads',
    level: 'intermediate',
    minutes: 20,
    topic: 'Instrument QC',
    views: ['QC'],
    example: { id: 'bead-qc', scale: 0.5 },
    setup(seed) {
      const aging = pick(seed, 'aging', BEAD_DETECTORS);
      const flowCell = pick(seed, 'flow-cell', BEAD_DETECTORS.filter((d) => d !== aging && LASER_OF(d) !== LASER_OF(aging)));
      const laser = pick(seed, 'laser', ['UV', 'V', 'B', 'YG', 'R'].filter((l) => l !== LASER_OF(aging) && l !== LASER_OF(flowCell)));
      const runs = shuffled(seed, 'runs', [21, 23, 25, 27]).slice(0, 3).sort((a, b) => a - b);
      const [agingFrom, flowCellFrom, laserFrom] = shuffled(seed, 'order', runs);
      return { aging: { detector: aging, from: agingFrom }, flowCell: { detector: flowCell, from: flowCellFrom }, laser: { laser, from: laserFrom } };
    },
    options: (setup) => ({ beadEvents: setup }),
    brief: (setup) => `Thirty daily runs of 8-peak rainbow beads on an 18-color cytometer. Measure the detectors' efficiency Q and background B on each run and follow them over time. One detector's photomultiplier is aging: which one, and from which run? And what went wrong on run ${setup.flowCell.from}?`,
    hints: () => [
      'QC → Instrument measures Q, B and the beads\' CV in every detector from multi-level beads, and saves runs to the instrument\'s record.',
      'Levey–Jennings charts follow a value across runs, against the mean and SD of the first runs; Westgard rules flag runs out of control.',
      'An aging photomultiplier loses efficiency: Q falls run after run. A dirty flow cell scatters stray light into a detector: its background B rises.',
    ],
    questions: (setup) => [
      { id: 'detector', label: 'The aging detector', kind: 'channel' },
      { id: 'from', label: 'The first run it shows', kind: 'number' },
      { id: 'run25', label: `What went wrong on run ${setup.flowCell.from}`, kind: 'choice', options: [
        { value: 'flow-cell', label: 'A dirty flow cell: more background in a detector' },
        { value: 'laser', label: 'A laser lost power' },
        { value: 'pmt', label: 'A second photomultiplier aged' },
        { value: 'beads', label: 'A new lot of beads' },
      ] },
    ],
    truthSamples: () => null,
    truth: (generated, setup) => ({ detector: setup.aging.detector, from: setup.aging.from, run25: 'flow-cell', run25Run: setup.flowCell.from, run25Detector: setup.flowCell.detector, laser: setup.laser.laser, laserRun: setup.laser.from }),
    grade(answers, truth) {
      const right = answers.detector === truth.detector;
      const from = number(answers.from);
      const off = Math.abs(from - truth.from);
      return { parts: [
        part('The aging detector', 0.4, right ? 1 : 0, answers.detector ?? 'None chosen'),
        part('The first run (within 1 run for full marks)', 0.2, right && Number.isFinite(from) ? (off <= 1 ? 1 : off <= 3 ? 0.5 : 0) : 0, right ? (Number.isFinite(from) ? `Run ${from}; truly run ${truth.from}` : 'None given') : 'Scored once the detector is right'),
        part(`Run ${truth.run25Run}`, 0.4, answers.run25 === truth.run25 ? 1 : 0, answers.run25 ?? 'None chosen'),
      ] };
    },
    explain: (truth) => [
      `${truth.detector}'s photomultiplier ages from run ${truth.from}: its Q falls 7% per run. On run ${truth.run25Run} the flow cell gets dirty, and ${truth.run25Detector}'s background B rises fivefold. On run ${truth.laserRun} the ${LASER_NAMES[truth.laser]} laser drops to 70% power: its detectors' bead signals fall 30%, while their Q and B stay the same.`,
      'Q and B separate causes that bead brightness alone mixes up: a dimmer signal can be a weaker laser (Q and B unchanged), an aging detector (Q falls) or stray light (B rises).',
    ],
  },
  {
    id: 'cytof-differential',
    title: 'Find a population that differs between groups',
    level: 'advanced',
    minutes: 30,
    topic: 'High-dimensional analysis',
    views: ['QC', 'Explore', 'Compare'],
    example: { id: 'cytof-cohort', scale: 0.5 },
    setup: (seed) => ({ population: pick(seed, 'population', CYTOF_CANDIDATES), fold: pick(seed, 'direction', [2, 0.5]) }),
    options: (setup) => ({ differential: { population: setup.population, fold: setup.fold } }),
    brief: () => 'A mass cytometry study of eight subjects, four controls and four cases, acquired in two batches with an anchor sample in each. Clean up the data, deal with the batches, cluster, and find the population whose abundance differs between cases and controls.',
    hints: () => [
      'Gate out beads, debris and doublets (DNA and event length) and dead cells (cisplatin) first.',
      'QC → Normalize corrects the signal drift with the beads and the batch differences with the anchors, which come from the same donor in both batches.',
      'Cluster the live cells in Explore (FlowSOM), name the clusters from their markers, then test differential abundance between the groups in Compare.',
    ],
    questions: () => [
      { id: 'population', label: 'The population that differs', kind: 'choice', options: ['Classical monocytes', 'Intermediate monocytes', 'Non-classical monocytes', 'Naive B', 'Memory B', 'Plasmablasts', 'CD56bright NK', 'CD56dim NK', 'CD4 naive T', 'CD8 effector memory T', 'Regulatory T', 'Gamma-delta T', 'Basophils', 'Plasmacytoid DC', 'Myeloid DC'].map((p) => ({ value: p, label: p })) },
      { id: 'direction', label: 'In the cases', kind: 'choice', options: [{ value: 'up', label: 'More abundant' }, { value: 'down', label: 'Less abundant' }] },
    ],
    truthSamples: () => null,
    truth: (generated, setup) => ({ population: setup.population, direction: setup.fold > 1 ? 'up' : 'down', fold: setup.fold }),
    grade(answers, truth) {
      const right = answers.population === truth.population;
      return { parts: [
        part('The population', 0.7, right ? 1 : 0, answers.population ?? 'None chosen'),
        part('The direction', 0.3, right && answers.direction === truth.direction ? 1 : 0, right ? (answers.direction ?? 'None chosen') : 'Scored once the population is right'),
      ] };
    },
    explain: (truth) => [
      `${truth.population} are ${truth.fold > 1 ? 'twice' : 'half'} as abundant in the cases as in the controls; nothing else differs between the groups.`,
      'Batch 2 was acquired with lower sensitivity and different staining, and signals drift down within each run. Without normalization, clusters can split by batch, and a batch difference can look like a group difference where batches and groups overlap.',
    ],
  },
  {
    id: 'absolute-counts',
    title: 'Count CD4 T cells per microliter',
    level: 'beginner',
    minutes: 15,
    topic: 'Absolute counts',
    views: ['Gate', 'Tables'],
    example: { id: 'absolute-counts', scale: 1 },
    setup: (seed) => ({ patient: pick(seed, 'patient', Object.keys(COUNT_PATIENTS)) }),
    brief: (setup) => `Whole blood from three patients, stained lyse/no-wash in tubes that each hold ${COUNTING.beadsPerTube.toLocaleString('en-US')} counting beads, ${COUNTING.volume} µL of blood per tube. How many CD4 T cells per µL of blood does patient ${setup.patient} have?`,
    hints: () => [
      'Counting beads are small and brighter than any cell in every fluorescence channel: gate them on two fluorescence channels.',
      'For the cells: CD45+ leukocytes (CD45 against side scatter), then lymphocytes (CD45 bright, low side scatter), CD3+ T cells, and CD4+ CD8− among them.',
      `Cells per µL = cell events ÷ bead events × beads in the tube ÷ volume of blood. Tables can add it as a column: "Absolute count (/µL, counting beads)", with the bead population, ${COUNTING.beadsPerTube.toLocaleString('en-US')} beads and ${COUNTING.volume} µL.`,
    ],
    questions: (setup) => [{ id: 'count', label: `CD4 T cells per µL in ${setup.patient}`, kind: 'number', unit: 'cells/µL' }],
    truthSamples: () => null,
    truth: (generated, setup) => ({ count: COUNT_PATIENTS[setup.patient]['CD4 T'], all: COUNT_PATIENTS }),
    grade(answers, truth) {
      const value = number(answers.count);
      return { parts: [part('The CD4 T-cell count (within 10% for full marks)', 1, value > 0 ? closeness(Math.abs(Math.log(value / truth.count)), Math.log(1.1), Math.log(1.5)) : 0, `${fmt(value, 0)} cells/µL; truly ${truth.count} cells/µL`)] };
    },
    explain: (truth, setup) => [
      `${setup.patient} truly has ${truth.count} CD4 T cells per µL. All three: ${Object.entries(truth.all).map(([p, c]) => `${p} ${c['CD4 T']}`).join(', ')} CD4 T cells/µL. A count below 200/µL, as in P03, is the threshold clinicians watch in HIV infection.`,
      'The count needs no event count of the blood itself: the beads stand in for a known volume. It is as precise as the bead and cell events counted (Poisson), so a few thousand of each are acquired.',
    ],
  },
  {
    id: 'spectral-day-two',
    title: 'Find what is wrong with the day-2 controls',
    level: 'advanced',
    minutes: 25,
    topic: 'Spectral unmixing',
    views: ['Spectral'],
    example: { id: 'spectral-troubleshooting', scale: 0.5 },
    setup: () => ({}),
    brief: () => 'The 25-color panel, acquired again with new reference controls, and today\'s unmixing looks wrong. Two of today\'s reference controls are at fault, each in a different way. Which controls, and what is wrong with each?',
    hints: () => [
      'Unmix the donors in the Spectral view, then open its Diagnose tab: it names likely causes and proposes fixes.',
      'Day 1\'s references are a good comparison: open the 25-color spectral example first and keep its references in the spectral library, then come back to this workspace.',
      'A tandem that broke down emits partly as its donor. A control stained with another dye has another spectrum, though it peaks near the right detector.',
    ],
    questions: () => [
      { id: 'degraded', label: 'The control whose tandem dye degraded', kind: 'choice', options: SPECTRAL_DYES.map((d) => ({ value: d, label: d })) },
      { id: 'wrongDye', label: 'The control stained with another dye', kind: 'choice', options: SPECTRAL_DYES.map((d) => ({ value: d, label: d })) },
    ],
    truthSamples: () => null,
    truth: () => ({ degraded: 'PE-Cy7', wrongDye: 'APC', usedDye: 'Alexa Fluor 647' }),
    grade(answers, truth) {
      return { parts: [
        part('The degraded tandem', 0.5, answers.degraded === truth.degraded ? 1 : 0, answers.degraded ?? 'None chosen'),
        part('The control stained with another dye', 0.5, answers.wrongDye === truth.wrongDye ? 1 : 0, answers.wrongDye ?? 'None chosen'),
      ] };
    },
    explain: (truth) => [
      `The ${truth.degraded} control was stained from a vial whose tandem had degraded: 10% of its emission came from PE alone, while the donors' ${truth.degraded} was intact. The ${truth.wrongDye} control was stained with ${truth.usedDye} instead: a similar dye that peaks in the same detector but has another spectrum.`,
      'Either way, the reference no longer describes the dye in the samples, so unmixing moves light between dyes. Comparing controls with the library\'s spectra from earlier experiments on the same cytometer catches both before the samples are unmixed.',
    ],
  },
  {
    id: 'batch-gates',
    title: 'Adjust gates for a second day',
    level: 'intermediate',
    minutes: 15,
    topic: 'Gating',
    views: ['Gate'],
    example: { id: 'pbmc-immunophenotyping', scale: 0.3, gates: true },
    setup: (seed) => ({ sample: pick(seed, 'sample', ['D04_Unstim.fcs', 'D05_Stim.fcs', 'D06_Unstim.fcs']) }),
    brief: (setup) => `The workspace's gates were drawn on the first day's samples (D01–D03). Donors D04–D06 were acquired the next day with different detector settings. Make the "T cells" population right for ${stripFCS(setup.sample)} without changing it for the first day's samples.`,
    hints: () => [
      'Look at each gate of the strategy on the second day\'s samples: the populations have moved, on scatter a little and in fluorescence more.',
      'A gate can be adjusted for one sample only (its own copy of the shared gate), or adapted to every sample at once: the population menu\'s "Adapt to each sample" learns where the population moved and proposes each sample\'s adjustment.',
      'Check every gate down to T cells, not only the last one: a lymphocyte or viability gate that misses on day 2 removes T cells before the CD3 gate sees them.',
    ],
    questions: (setup) => [{ id: 'tCells', label: `The T-cell population of ${stripFCS(setup.sample)}`, kind: 'population', sample: setup.sample }],
    truthSamples: (setup) => [setup.sample],
    truth(generated, setup) {
      const file = fileNamed(generated, setup.sample);
      return { events: { tCells: { sample: setup.sample, indices: eventsWhere(file, isTCell) } }, gains: file.meta.truth.gains };
    },
    grade(answers, truth, measures) {
      const m = measures.tCells;
      return { parts: [part('Your gates hold the true T cells of the day-2 sample (F1 of 0.9 or more for full marks)', 1, m ? closeness(1 - m.f1, 0.1, 0.3) : 0, m ? `F1 ${m.f1.toFixed(3)}: ${(100 * m.recall).toFixed(1)}% of the true T cells are in, and ${(100 * m.precision).toFixed(1)}% of the population's events are T cells` : 'No population chosen')] };
    },
    explain: (truth) => {
      const shifts = Object.entries(truth.gains ?? {}).filter(([channel]) => /^(BV510|BV605)/.test(channel) || /^(FSC|SSC)-A$/.test(channel)).map(([channel, gain]) => `${channel} ×${gain.toFixed(2)}`);
      return [
        `On day 2 every detector's gain changed: ${shifts.join(', ')} for the channels the T-cell strategy uses. The day-1 viability, lymphocyte and CD3 gates sit in the wrong place for those samples.`,
        'Adjusting a shared gate per sample keeps one strategy with recorded exceptions; the change log and the review report show which samples were adjusted and how.',
      ];
    },
  },
];

export function exerciseById(id) {
  return EXERCISES.find((e) => e.id === id) ?? null;
}

// A seed for a new attempt (a class code is a seed chosen by the teacher).
export function newExerciseSeed(random = Math.random) {
  return 100000 + Math.floor(random() * 900000);
}

// What an attempt is: the exercise, its seed and the choices made from it, and the generation
// options of its example.
export function exerciseAttempt(exercise, seed) {
  const setup = exercise.setup(seed);
  return {
    setup,
    options: { seed, scale: exercise.example.scale ?? 1, ...(exercise.options?.(setup) ?? {}) },
  };
}

// The answer key, from the attempt's generated data (all its files, or the exercise's
// truthSamples): the exercise's truth.
export function exerciseTruth(exercise, seed, generated) {
  const { setup } = exerciseAttempt(exercise, seed);
  return exercise.truth(generated, setup);
}

// Grades answers: { parts, score }.
export function gradeExercise(exercise, seed, answers, truth, measures = {}) {
  const { setup } = exerciseAttempt(exercise, seed);
  const graded = exercise.grade(answers ?? {}, truth, measures, setup);
  return { parts: graded.parts, score: totalScore(graded) };
}
