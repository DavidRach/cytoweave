import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateExample } from './examples.js';
import { parseFCS, readSpillover } from './fcs.js';
import { SampleView, computeStatistic } from './engine.js';
import { ROOT, addGates, addSamples, createWorkspace, gateById, sampleFromDataset } from './workspace.js';
import { pairedTTest, welchTTest, wilcoxonSignedRank } from './hypothesis.js';
import {
  arrange, choicesFor, compareTwo, conclusionOf, methodsSentence, minimumRankP, offsetGate, pathGates, qcGateOf,
  runMultiverse, specifications, summarize, withGateChannel, withOverrides, withoutGate, workspaceFor,
} from './multiverse.js';

test('specifications: the declared one, each alternative alone, then distinct random combinations', () => {
  const choices = [{ options: [0, 1, 2, 3, 4] }, { options: [0, 1, 2] }, { options: [0, 1] }];
  const specs = specifications(choices, { max: 30, seed: 3 });
  assert.equal(specs[0].kind, 'declared');
  assert.deepEqual(specs[0].picks, [0, 0, 0]);
  assert.equal(specs.filter((s) => s.kind === 'single').length, 4 + 2 + 1);
  const combined = specs.filter((s) => s.kind === 'combined');
  assert.equal(specs.length, 30);
  assert.ok(combined.every((s) => s.changed >= 2));
  assert.equal(new Set(specs.map((s) => s.picks.join())).size, specs.length, 'no duplicates');
  assert.deepEqual(specifications(choices, { max: 30, seed: 3 }), specs, 'seeded');
  // A small space is enumerated without looping for ever.
  assert.equal(specifications([{ options: [0, 1] }, { options: [0, 1] }], { max: 64 }).length, 4);
});

test('two-group tests: estimates, intervals and both kinds of test', () => {
  const a = [10, 12, 11, 13, 12];
  const b = [15, 16, 14, 17, 15];
  const welch = welchTTest(b, a);
  const r = compareTwo('two', 'parametric', a, b);
  assert.equal(r.estimate, welch.estimate);
  assert.deepEqual(r.ci, welch.ci);
  assert.ok(compareTwo('two', 'rank', a, b).p > r.p, 'Mann–Whitney is less powerful here');
  assert.equal(conclusionOf(r), 'higher');
  assert.equal(conclusionOf({ p: 0.2, estimate: 3 }), 'none');
  const paired = compareTwo('paired-two', 'rank', a, b);
  assert.equal(paired.estimate, pairedTTest(b, a).estimate);
  assert.equal(paired.p, wilcoxonSignedRank(b, a).p);
  // Pairs are aligned by subject, incomplete ones left out.
  const samples = [{ group: 0, pair: 's1' }, { group: 1, pair: 's1' }, { group: 1, pair: 's2' }, { group: 0, pair: 's2' }, { group: 0, pair: 's3' }];
  assert.deepEqual(arrange(samples, [1, 2, 4, 3, 9], 'paired-two'), { a: [1, 3], b: [2, 4] });
  // Rank tests with too few samples cannot be significant, and are not offered.
  assert.equal(minimumRankP('two', [3, 3]), 0.1);
  assert.equal(minimumRankP('paired-two', [4]), 0.125);
  assert.ok(minimumRankP('two', [6, 6]) < 0.01);
  const ws = createWorkspace('w');
  assert.equal(choicesFor({ ws, gateId: null, design: 'two', counts: [3, 3] }).at(-1).options.length, 1);
  assert.match(choicesFor({ ws, gateId: null, design: 'two', counts: [3, 3] }).at(-1).omitted, /Mann–Whitney U cannot reach/);
  assert.equal(choicesFor({ ws, gateId: null, design: 'paired-two', counts: [6] }).at(-1).options.length, 2);
});

test('workspace variants: moved boundaries, removed and replaced adjustments, a gate taken out', () => {
  let ws = createWorkspace('w');
  ws = addGates(ws, [
    { id: 'qc', name: 'QC pass', type: 'category', dims: [{ channel: 'QC pass', transform: { type: 'linear', min: 0, max: 1 } }], geometry: { values: [1] }, parentId: null },
    { id: 'r', name: 'R', type: 'rectangle', dims: [{ channel: 'X' }, { channel: 'Y' }], geometry: { min: [0.2, 0.2], max: [0.6, 0.6] }, overrides: { s1: { min: [0.25, 0.2], max: [0.65, 0.6] } }, parentId: 'qc' },
    { id: 'c', name: 'C', type: 'range', dims: [{ channel: 'X' }], geometry: { min: 0.3, max: 0.5 }, parentId: 'r' },
  ]).ws;
  assert.deepEqual(pathGates(ws, 'c').map((g) => g.id), ['qc', 'r', 'c']);
  assert.equal(qcGateOf(pathGates(ws, 'c')).id, 'qc');
  const moved = gateById(offsetGate(ws, 'r', 0.01), 'r');
  assert.deepEqual(moved.geometry, { min: [0.19, 0.19], max: [0.61, 0.61] });
  assert.ok(Math.abs(moved.overrides.s1.min[0] - 0.24) < 1e-12, 'adjustments move too');
  assert.deepEqual(gateById(withOverrides(ws, ['r'], null), 'r').overrides, {});
  assert.deepEqual(gateById(withOverrides(ws, ['r'], { r: { s2: { min: [0, 0], max: [1, 1] } } }), 'r').overrides, { s2: { min: [0, 0], max: [1, 1] } });
  const noQC = withoutGate(ws, 'qc');
  assert.equal(gateById(noQC, 'qc'), null);
  assert.equal(gateById(noQC, 'r').parentId, null, 'children move up');
  assert.equal(gateById(withGateChannel(ws, 'qc', 'QC pass · MAD 4'), 'qc').dims[0].channel, 'QC pass · MAD 4');
  // The choices: boundaries of the offsettable gates, adjustments, QC and the test.
  const choices = choicesFor({ ws, gateId: 'c', design: 'two', qcVariants: [{ id: 'mad4', label: 'MAD 4', channel: 'QC pass · MAD 4' }] });
  assert.deepEqual(choices.map((c) => c.kind), ['boundary', 'boundary', 'per-sample', 'qc', 'test']);
  const qc = choices.findIndex((c) => c.kind === 'qc');
  const picks = choices.map((c, i) => (i === qc ? 2 : 0));
  assert.equal(gateById(workspaceFor(ws, choices, picks, { gateId: 'c' }), 'qc').dims[0].channel, 'QC pass · MAD 4');
});

// Six PBMC samples: D01–D03 unstimulated and stimulated (paired by donor).
function cohort() {
  const names = ['D01_Unstim', 'D01_Stim', 'D02_Unstim', 'D02_Stim', 'D03_Unstim', 'D03_Stim'];
  const { files, workspaceHints } = generateExample('pbmc-immunophenotyping', { samples: names.map((n) => `${n}.fcs`), scale: 0.1 });
  let ws = createWorkspace('multiverse');
  const views = new Map();
  const spills = new Map();
  for (const file of files.filter((f) => /^D0/.test(f.name))) {
    const data = parseFCS(file.bytes).datasets[0];
    const record = sampleFromDataset(data, { name: file.name });
    ws = addSamples(ws, [record]);
    const view = new SampleView(record, data);
    const spill = readSpillover(data.keywords, data.parameters);
    spills.set(record.id, spill);
    view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
    views.set(record.id, view);
  }
  ws = addGates(ws, workspaceHints.suggestedGates).ws;
  const samples = ws.samples.map((s) => ({ id: s.id, group: /Stim/.test(s.name) && !/Unstim/.test(s.name) ? 1 : 0, pair: s.name.slice(0, 3) }));
  return { ws, views, spills, samples };
}

test('a comparison run under every specification, with compensation switched and restored', () => {
  const { ws, views, spills, samples } = cohort();
  const gate = ws.gates.find((g) => g.name === 'T cells');
  const statistic = { stat: 'freqParent', gateId: gate.id };
  // An alternative matrix: the file's with one spillover value off.
  const setCompensation = (vs, id) => {
    for (const [sampleId, view] of vs) {
      const spill = spills.get(sampleId);
      const matrix = Array.from(spill.matrix);
      if (id === 'off') matrix[1] += 0.2;
      view.setCompensation({ id: id === 'off' ? 'off' : 'file', channels: spill.channels, matrix });
    }
  };
  const choices = choicesFor({ ws, gateId: gate.id, ancestorId: gate.parentId, design: 'paired-two', compensations: [{ id: 'off', label: 'a wrong matrix' }] });
  const specs = specifications(choices, { max: 24 });
  const results = runMultiverse({ ws, views, samples, design: 'paired-two', statistic, choices, specs, setCompensation, gateId: gate.id });
  assert.equal(results.length, specs.length);
  // The declared specification is the analysis as the workspace has it.
  const declared = results.find((r) => r.kind === 'declared');
  const direct = samples.map((s) => computeStatistic(views.get(s.id), ws, statistic));
  assert.deepEqual(declared.values, direct);
  const { a, b } = arrange(samples, direct, 'paired-two');
  assert.equal(declared.result.estimate, pairedTTest(b, a).estimate);
  // Moving a boundary outward never shrinks the population's own count relative to the gate.
  const outward = results.find((r) => r.kind === 'single' && choices[r.picks.findIndex((p) => p > 0)].kind === 'boundary' && choices[r.picks.findIndex((p) => p > 0)].gateId === gate.id && choices[r.picks.findIndex((p) => p > 0)].options[r.picks.find((p) => p > 0)].distance > 0);
  assert.ok(outward.values.every((v, i) => v >= direct[i] - 1e-9), 'outward boundary');
  // The views are back on the declared compensation.
  for (const view of views.values()) assert.equal(view.compensation.id, 'file');
  assert.deepEqual(samples.map((s) => computeStatistic(views.get(s.id), ws, statistic)), direct);
  const summary = summarize(results, choices);
  assert.equal(summary.total, results.filter((r) => r.result).length);
  assert.ok(summary.share > 0 && summary.share <= 1);
  assert.ok(['holds', 'mostly', 'fragile'].includes(summary.verdict));
  assert.match(methodsSentence(summary, choices), /alternative analyses/);
  assert.equal(statistic.gateId === ROOT, false);
});

test('the async runner gives the same results and puts the compensation back when stopped', async () => {
  const { runMultiverseAsync } = await import('./multiverse.js');
  const { ws, views, spills, samples } = cohort();
  const gate = ws.gates.find((g) => g.name === 'Lymphocytes');
  const statistic = { stat: 'freqParent', gateId: gate.id };
  const setCompensation = (vs, id) => {
    for (const [sampleId, view] of vs) {
      const spill = spills.get(sampleId);
      view.setCompensation({ id: id === 'declared' ? 'file' : id, channels: spill.channels, matrix: Array.from(spill.matrix, (v, k) => (id === 'declared' || k !== 1 ? v : v + 0.2)) });
    }
  };
  const choices = choicesFor({ ws, gateId: gate.id, design: 'paired-two', counts: [3], compensations: [{ id: 'off', label: 'off' }] });
  const specs = specifications(choices, { max: 12 });
  const input = { ws, views, samples, design: 'paired-two', statistic, choices, specs, setCompensation, gateId: gate.id };
  const sync = runMultiverse(input);
  const later = await runMultiverseAsync(input);
  assert.deepEqual(later.map((r) => r.values), sync.map((r) => r.values));
  // Stopped part-way through, after the compensation was switched.
  let n = 0;
  const signal = { aborted: false };
  await assert.rejects(runMultiverseAsync({ ...input, signal, onProgress: () => { n += 1; if (n === specs.length - 1) signal.aborted = true; } }), /Cancelled/);
  for (const view of views.values()) assert.equal(view.compensation.id, 'file');
});

test('the summary names choices that change the conclusion, or the size of a difference found', () => {
  const choices = [{ label: 'Gate boundary', options: [{ label: 'as drawn' }, { label: '2% outward' }] }, { label: 'Compensation', options: [{ label: 'as assigned' }, { label: 'controls' }] }, { label: 'Test', options: [{ label: 't' }] }];
  const r = (kind, picks, estimate, p) => ({ kind, picks, result: { estimate, ci: [estimate - 2, estimate + 2], p }, conclusion: conclusionOf({ estimate, p }) });
  const found = summarize([r('declared', [0, 0, 0], 10, 0.001), r('single', [1, 0, 0], 1, 0.4), r('single', [0, 1, 0], 4, 0.01), r('combined', [1, 1, 0], 1, 0.5)], choices, { labels: ['Unstim', 'Stim'] });
  assert.equal(found.declared.conclusion, 'higher');
  assert.equal(found.agree, 2);
  assert.equal(found.verdict, 'fragile');
  assert.deepEqual(found.dependsOn.map((d) => d.choice), ['Gate boundary']);
  assert.deepEqual(found.sizeDependsOn.map((d) => [d.choice, d.estimate]), [['Compensation', 4]]);
  assert.match(found.text, /^Stim is significantly higher than Unstim in 2 of 4/);
  assert.match(found.text, /changes beyond its confidence interval with compensation controls \(10\.0 → 4\.0\)/);
  // No difference: its size is not followed.
  const none = summarize([r('declared', [0, 0, 0], 0.01, 0.9), r('single', [0, 1, 0], 3, 0.3)], choices);
  assert.equal(none.verdict, 'holds');
  assert.equal(none.sizeDependsOn.length, 0);
});
