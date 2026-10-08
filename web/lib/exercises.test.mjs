import assert from 'node:assert/strict';
import test from 'node:test';
import { EXERCISES, exerciseAttempt, exerciseById, exerciseTruth, gradeExercise, measurePopulation, newExerciseSeed } from './exercises.js';
import { generateExample } from './examples.js';
import { EventSet } from './eventset.js';

const SEED = 314159;

// The attempt's data (only the files its truth needs, as the window regenerates them).
function generated(exercise, seed) {
  const { options, setup } = exerciseAttempt(exercise, seed);
  const files = exercise.truthSamples(setup);
  if (files === null) return null;
  return generateExample(exercise.example.id, { ...options, ...(files === 'all' ? {} : { samples: files }) });
}

// The right answer to every question, from the truth (population questions measured on the true
// events themselves).
function oracle(exercise, seed, truth) {
  const { setup } = exerciseAttempt(exercise, seed);
  const answers = {};
  const measures = {};
  for (const q of exercise.questions(setup)) {
    if (q.kind === 'population') {
      const { indices } = truth.events[q.id];
      measures[q.id] = measurePopulation(EventSet.fromIndices(indices, indices.length ? indices[indices.length - 1] + 1 : 1), indices);
      answers[q.id] = 'gate';
    }
  }
  const right = {
    'gate-t-cells': () => ({ percent: truth.percent }),
    'gate-tregs': () => ({ percent: truth.percent }),
    'compensation-error': () => ({ from: truth.from, into: truth.into, value: truth.percent }),
    'find-clog': () => ({ sample: truth.sample, problem: truth.problem }),
    'qc-four-wells': () => (truth),
    'stimulation-test': () => ({ direction: 'up', test: 'paired', p: 0.001 }),
    'spectral-tandem': () => ({ dye: truth.dye, cause: truth.cause }),
    titration: () => ({ amount: String(truth.amount) }),
    'dose-response': () => ({ mostPotent: truth.mostPotent, ic50: truth.ic50, inactive: truth.inactive }),
    'bead-assay': () => ({ concentration: truth.concentration }),
    'calcium-flux': () => ({ strongest: truth.strongest, percent: truth.percent }),
    'cell-cycle': () => ({ s: truth.asynchronous.S, g2m: truth.nocodazole.G2M }),
    proliferation: () => ({ divided: truth.divided }),
    'bead-qc': () => ({ detector: truth.detector, from: truth.from, run25: truth.run25 }),
    'cytof-differential': () => ({ population: truth.population, direction: truth.direction }),
    'absolute-counts': () => ({ count: truth.count }),
    'spectral-day-two': () => ({ degraded: truth.degraded, wrongDye: truth.wrongDye }),
    'batch-gates': () => ({}),
  }[exercise.id]?.();
  assert.ok(right, `${exercise.id} has no right answers in the test`);
  return { answers: { ...answers, ...right }, measures };
}

test('every exercise is complete, with its own id and an example that exists', () => {
  const ids = new Set();
  for (const e of EXERCISES) {
    assert.ok(!ids.has(e.id), e.id);
    ids.add(e.id);
    for (const key of ['title', 'level', 'minutes', 'topic', 'example', 'setup', 'brief', 'hints', 'questions', 'truthSamples', 'truth', 'grade', 'explain']) assert.ok(e[key] !== undefined, `${e.id} lacks ${key}`);
    assert.ok(['beginner', 'intermediate', 'advanced'].includes(e.level), e.id);
    const { setup, options } = exerciseAttempt(e, SEED);
    assert.equal(options.seed, SEED);
    assert.ok(e.brief(setup).length > 40, e.id);
    assert.ok(e.hints(setup).length >= 2, e.id);
    for (const q of e.questions(setup)) assert.ok(['population', 'sample', 'channel', 'choice', 'choices', 'number'].includes(q.kind), `${e.id}: ${q.kind}`);
    assert.equal(exerciseById(e.id), e);
  }
  const seed = newExerciseSeed(() => 0.5);
  assert.ok(seed >= 100000 && seed < 1000000);
});

test('a seed gives the same attempt every time, and seeds vary what is planted', () => {
  for (const e of EXERCISES) assert.deepEqual(exerciseAttempt(e, SEED), exerciseAttempt(e, SEED));
  const clogged = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => exerciseAttempt(exerciseById('find-clog'), s).setup.clogged));
  assert.ok(clogged.size >= 3, `the clogged sample varies (${[...clogged]})`);
  const orders = new Set([1, 2, 3, 4, 5, 6].map((s) => exerciseAttempt(exerciseById('qc-four-wells'), s).setup.wells.join()));
  assert.ok(orders.size >= 3);
});

for (const exercise of EXERCISES) {
  test(`${exercise.id}: the true answers score 100%, and wrong ones less`, { timeout: 240000 }, () => {
    const data = generated(exercise, SEED);
    const truth = exerciseTruth(exercise, SEED, data);
    const { answers, measures } = oracle(exercise, SEED, truth);
    const right = gradeExercise(exercise, SEED, answers, truth, measures);
    assert.equal(right.score, 1, `${exercise.id}: ${JSON.stringify(right.parts)}`);
    const none = gradeExercise(exercise, SEED, {}, truth, {});
    assert.equal(none.score, 0, `${exercise.id} without answers: ${JSON.stringify(none.parts)}`);
    for (const p of right.parts) assert.ok(p.name && Number.isFinite(p.weight) && p.detail !== undefined, exercise.id);
    assert.ok(exercise.explain(truth, exerciseAttempt(exercise, SEED).setup).every((line) => typeof line === 'string' && line.length > 20), exercise.id);
  });
}

test('what the seed plants is what the data hold', { timeout: 240000 }, () => {
  // The clogged sample: its file records the clog.
  const clog = exerciseById('find-clog');
  const { setup: cs, options: co } = exerciseAttempt(clog, SEED);
  const clogData = generateExample('pbmc-immunophenotyping', { ...co, samples: [cs.clogged, 'D01_Unstim.fcs'] });
  const anomalies = (name) => clogData.files.find((f) => f.name === name).meta.truth.anomalies;
  assert.ok(anomalies(cs.clogged).some((a) => a.kind === 'clog'));
  if (cs.clogged !== 'D01_Unstim.fcs') assert.equal(anomalies('D01_Unstim.fcs').length, 0);
  // The QC wells, the daily beads' events and the cohort's differential population.
  const wells = exerciseById('qc-four-wells');
  const w = exerciseAttempt(wells, SEED);
  const wellData = generateExample('qc-showcase', { ...w.options, scale: 0.05 });
  assert.deepEqual(wellData.files.map((f) => f.meta.anomaly), w.setup.wells);
  const beads = exerciseAttempt(exerciseById('bead-qc'), SEED);
  const beadData = generateExample('bead-qc', { ...beads.options, scale: 0.05, samples: ['Beads_2026-04-08.fcs'] });
  assert.deepEqual(beadData.files[0].meta.truth.events, beads.setup);
  const cohort = exerciseAttempt(exerciseById('cytof-differential'), SEED);
  const cohortData = generateExample('cytof-cohort', { ...cohort.options, scale: 0.02 });
  const cases = cohortData.files.filter((f) => f.meta.condition === 'Case');
  assert.ok(cases.length && cases.every((f) => f.meta.truth.differential.population === cohort.setup.population));
});

test('wrong answers get the partial credit the rubric gives', () => {
  const grade = (id, answers, truth, measures = {}) => gradeExercise(exerciseById(id), SEED, answers, truth, measures).score;
  const compensation = { from: 'APC-A', into: 'Alexa Fluor 700-A', percent: 15.7 };
  assert.equal(grade('compensation-error', { from: 'APC-A', into: 'Alexa Fluor 700-A', value: 40 }, compensation), 0.6);
  assert.equal(grade('compensation-error', { from: 'PE-A', into: 'PE-Cy7-A', value: 15.7 }, compensation), 0);
  const wells = { A01: 'clog', A02: 'clean', A03: 'drift', A04: 'bubble' };
  assert.ok(Math.abs(grade('qc-four-wells', { A01: 'bubble', A02: 'clean', A03: 'drift', A04: 'bubble' }, wells) - (0.25 * 0.6 + 0.75)) < 1e-9, 'a problem found but misnamed');
  assert.equal(grade('stimulation-test', { direction: 'up', test: 'welch', p: 0.01 }, { direction: 'up', test: 'paired' }), 0.75);
  assert.equal(grade('titration', { amount: '250' }, { amount: 125 }), 0.4);
  // A gate that holds 80% of the true events and as many others scores less than one that is right.
  const indices = Uint32Array.from({ length: 1000 }, (_, i) => i);
  const half = EventSet.fromIndices(Uint32Array.from({ length: 1000 }, (_, i) => (i < 800 ? i : 1000 + i)), 2000);
  const loose = measurePopulation(half, indices);
  assert.ok(Math.abs(loose.f1 - 0.8) < 1e-9);
  const truth = { percent: 10, events: { tCells: { sample: 'x', indices } } };
  assert.ok(grade('gate-t-cells', { percent: 10 }, truth, { tCells: loose }) < 1);
  assert.equal(grade('gate-t-cells', { percent: 10 }, truth, { tCells: measurePopulation(EventSet.fromIndices(indices, 2000), indices) }), 1);
});
