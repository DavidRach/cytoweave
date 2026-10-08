import assert from 'node:assert/strict';
import test from 'node:test';
import { TASKS, parseAnswer } from './tasks.mjs';

const task = (id) => TASKS.find((t) => t.id === id);
const score = async (id, answer, extra = {}) => {
  const t = task(id);
  const truth = await t.truth(extra.generated ?? null);
  const graded = await t.grade({ answer, text: '', page: null, truth, outputs: '/nonexistent', toolCalls: extra.toolCalls ?? [] });
  return +graded.parts.reduce((a, p) => a + p.weight * p.score, 0).toFixed(4);
};

test('answers are read from the last ANSWER line, in or out of a code block', () => {
  assert.deepEqual(parseAnswer('Some text.\nANSWER: {"a": 1}'), { a: 1 });
  assert.deepEqual(parseAnswer('First ANSWER: {"a": 1}\nThen ANSWER: ```json\n{"a": 2, "b": {"c": [1]}}\n```'), { a: 2, b: { c: [1] } });
  assert.equal(parseAnswer('No answer here'), null);
  assert.equal(parseAnswer('ANSWER: {not json}'), null);
});

test('every task is complete and its seed its own', () => {
  const seeds = new Set();
  for (const t of TASKS) {
    for (const key of ['id', 'category', 'title', 'prompt', 'truth', 'grade', 'expert']) assert.ok(t[key], `${t.id} lacks ${key}`);
    assert.match(t.prompt({ outputs: '/tmp/out' }), /ANSWER:/);
    const seed = t.example.options?.seed;
    assert.ok(Number.isInteger(seed) && seed !== 1 && !seeds.has(seed), `${t.id}: seed ${seed}`);
    seeds.add(seed);
  }
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
});

test('partial credit: the compensation error', async () => {
  const id = 'pbmc-compensation-error';
  assert.equal(await score(id, { from: 'APC-A', into: 'Alexa Fluor 700-A', correctPercent: 15.7 }), 1);
  assert.equal(await score(id, { from: 'APC', into: 'AF700', correctPercent: 30 }), 0.6, 'the right pair, a far value');
  assert.equal(await score(id, { from: 'PE-A', into: 'PE-Cy7-A', correctPercent: 15.7 }), 0, 'the wrong pair');
  assert.equal(await score(id, null), 0);
});

test('partial credit: statistics, QC, unmixing and plates', async () => {
  const paired = [{ name: 'compare', input: { pairBy: 'subject' }, ok: true }];
  assert.equal(await score('pbmc-stimulation-cd25', { direction: 'up', p: 0.001 }, { toolCalls: paired }), 1);
  assert.equal(await score('pbmc-stimulation-cd25', { direction: 'up', p: 0.001 }), 0.75, 'not paired');
  assert.equal(await score('pbmc-stimulation-cd25', { direction: 'down', p: 0.2 }, { toolCalls: paired }), 0.25);
  assert.equal(await score('qc-acquisition-problems', { A01: 'clean', A02: 'clog', A03: 'drift', A04: 'bubble' }), 1);
  assert.equal(await score('qc-acquisition-problems', { A01: 'clean', A02: 'other', A03: 'other', A04: 'clog' }), 0.25 + 3 * 0.15, 'problems found, kinds wrong');
  assert.equal(await score('qc-acquisition-problems', { A01: 'clog', A02: 'clean', A03: 'clean', A04: 'clean' }), 0);
  assert.equal(await score('spectral-dye-fault', { dye: 'PE-Cy7', cause: 'the tandem degraded in the samples' }), 1);
  assert.equal(await score('spectral-dye-fault', { dye: 'PE-Cy7', cause: 'wrong control' }), 0.6);
  assert.equal(await score('spectral-dye-fault', { dye: 'APC', cause: 'degraded tandem' }), 0);
  assert.equal(await score('plate-dose-response', { mostPotent: 'CW-103', ic50nM: 4.2, inactive: ['CW-105'] }), 1);
  assert.equal(await score('plate-dose-response', { mostPotent: 'CW-103', ic50nM: 40, inactive: ['CW-105', 'CW-106'] }), 0.7, 'IC50 10× off; CW-106 either way');
  assert.equal(await score('plate-dose-response', { mostPotent: 'CW-101', ic50nM: 4, inactive: ['CW-104'] }), 0);
  assert.equal(await score('antibody-titration', { amountNg: 125 }), 1);
  assert.equal(await score('antibody-titration', { amountNg: 250 }), 0.4);
  assert.equal(await score('antibody-titration', { amountNg: 1000 }), 0);
});

test('the PBMC tasks keep the example as version 2 had it (no FMO tube, beads or second day)', async () => {
  const { generateExample } = await import('../web/lib/examples.js');
  for (const t of TASKS.filter((x) => x.example.id === 'pbmc-immunophenotyping')) {
    const g = generateExample(t.example.id, { ...t.example.options, scale: 0.01 });
    assert.equal(g.files.length, 27, t.id);
    assert.ok(g.files.every((f) => f.meta.role !== 'fmo' && f.meta.role !== 'bead' && (f.meta.batch ?? 'B1') === 'B1'), t.id);
    assert.ok(g.files.every((f) => !f.meta.truth?.gains), t.id);
  }
});
