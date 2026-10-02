import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import { combinationKey, debarcode, normalizeKey } from './debarcode.js';

const BARCODES = ['Pd102Di', 'Pd104Di', 'Pd105Di', 'Pd106Di', 'Pd108Di', 'Pd110Di'];
const KEY = combinationKey(BARCODES, 3);

// Palladium-barcoded events: per code 500 singlets whose positive channels are bright (channel
// brightness, a per-sample staining factor and a per-cell size factor shared by its channels),
// negatives near zero with 1% cross-talk; plus doublets of two different codes, events with 4
// equally bright channels, and very bright events of code 1 that only the Mahalanobis filter
// can reject.
function simulate(seed) {
  const random = createRandom(seed);
  const g = random.gaussian;
  const brightness = [1.0, 0.7, 1.3, 0.9, 1.1, 0.8];
  const rows = [];
  const singlet = (p, boost = 1) => {
    const pattern = KEY.codes[p].pattern;
    const sampleFactor = 0.7 + (0.6 * p) / (KEY.codes.length - 1);
    const size = Math.exp(0.2 * g());
    const values = pattern.map((v, c) => (v ? 250 * brightness[c] * sampleFactor * size * boost * Math.exp(0.15 * g()) : 0));
    const total = values.reduce((s, v) => s + v, 0);
    return values.map((v, c) => (pattern[c] ? v : Math.abs(4 * g()) + 0.01 * total * Math.exp(0.3 * g())));
  };
  KEY.codes.forEach((_, p) => { for (let i = 0; i < 500; i += 1) rows.push({ truth: p, kind: 'singlet', values: singlet(p) }); });
  for (let i = 0; i < 600; i += 1) {
    const a = random.int(KEY.codes.length);
    let b = random.int(KEY.codes.length - 1);
    if (b >= a) b += 1;
    const va = singlet(a);
    const vb = singlet(b);
    rows.push({ truth: -1, kind: 'doublet', values: va.map((v, c) => v + vb[c]) });
  }
  for (let i = 0; i < 30; i += 1) rows.push({ truth: -1, kind: 'ambiguous', values: brightness.map((b, c) => (c < 4 ? 250 * b : Math.abs(4 * g()))) });
  for (let i = 0; i < 5; i += 1) rows.push({ truth: -1, kind: 'bright', values: singlet(0, 8) });
  const n = rows.length;
  const columns = Object.fromEntries(BARCODES.map((name) => [name, new Float32Array(n)]));
  rows.forEach((row, e) => BARCODES.forEach((name, c) => { columns[name][e] = row.values[c]; }));
  return {
    sample: { eventCount: n, channels: BARCODES.map((name) => ({ name, type: 'fluorescence', range: 0 })), columns },
    rows,
  };
}

const { sample, rows } = simulate(17);
const RESULT = debarcode(sample, KEY);

test('a 6-choose-3 key has 20 codes of three positive channels', () => {
  assert.equal(KEY.codes.length, 20);
  assert.ok(KEY.codes.every((code) => code.pattern.reduce((s, v) => s + v, 0) === 3));
  assert.deepEqual(KEY.codes[0].pattern, [1, 1, 1, 0, 0, 0]);
  assert.deepEqual(KEY.codes[19].pattern, [0, 0, 0, 1, 1, 1]);
  const fromMatrix = normalizeKey({ channels: ['a', 'b'], ids: ['s1', 's2'], matrix: [[1, 0], [0, 1]] });
  assert.deepEqual(fromMatrix.codes.map((c) => c.id), ['s1', 's2']);
  assert.throws(() => normalizeKey({ channels: ['a', 'b'], matrix: [[1, 0], [1, 0]] }), /same pattern/);
});

test('debarcoding assigns at least 95% of singlets correctly', () => {
  let correct = 0;
  let wrong = 0;
  let singlets = 0;
  rows.forEach((row, e) => {
    if (row.kind !== 'singlet') return;
    singlets += 1;
    if (RESULT.assignments[e] === row.truth) correct += 1;
    else if (RESULT.assignments[e] >= 0) wrong += 1;
  });
  assert.ok(correct / singlets >= 0.95, `correct ${correct}/${singlets}`);
  assert.ok(wrong / singlets <= 0.002, `misassigned ${wrong}`);
  // Counts per code agree with the assignments.
  const total = RESULT.counts.reduce((s, v) => s + v, 0);
  assert.equal(total + RESULT.unassigned, rows.length);
});

test('doublets, ambiguous and aberrant events are left unassigned', () => {
  const unassigned = { doublet: 0, ambiguous: 0, bright: 0 };
  const totals = { doublet: 0, ambiguous: 0, bright: 0 };
  rows.forEach((row, e) => {
    if (row.kind === 'singlet') return;
    totals[row.kind] += 1;
    if (RESULT.assignments[e] === -1) unassigned[row.kind] += 1;
  });
  assert.ok(unassigned.doublet / totals.doublet >= 0.95, `doublets unassigned ${unassigned.doublet}/${totals.doublet}`);
  assert.equal(unassigned.ambiguous, totals.ambiguous);
  // Four channels each at its typical positive level: no separation between the 3rd and 4th.
  rows.forEach((row, e) => { if (row.kind === 'ambiguous') assert.ok(RESULT.separations[e] < 0.1, `${RESULT.separations[e]}`); });
  // The very bright events separate well, but sit far from their population.
  assert.equal(unassigned.bright, totals.bright);
  rows.forEach((row, e) => {
    if (row.kind !== 'bright') return;
    assert.ok(RESULT.separations[e] >= 0.3);
    assert.ok(RESULT.mahalanobis[e] > 30);
  });
});

test('yields fall with the separation cutoff and match the assignments at the default cutoff', () => {
  const { cutoffs, counts, fractions } = RESULT.yields;
  assert.equal(cutoffs.length, 101);
  for (const curve of counts) for (let j = 1; j < curve.length; j += 1) assert.ok(curve[j] <= curve[j - 1]);
  for (const curve of fractions) assert.equal(curve[0], 1);
  // At 0.3, the yield is the separation-passing count, before the Mahalanobis filter.
  const j = cutoffs.findIndex((c) => Math.abs(c - 0.3) < 1e-12);
  for (let p = 0; p < counts.length; p += 1) {
    let passing = 0;
    for (let e = 0; e < rows.length; e += 1) if (RESULT.preliminary[e] === p && RESULT.separations[e] >= 0.3) passing += 1;
    assert.equal(counts[p][j], passing);
    assert.ok(RESULT.counts[p] <= passing);
  }
});

test('a stricter separation cutoff assigns fewer events, per code if asked', () => {
  const strict = debarcode(sample, KEY, { separationCutoff: 0.6 });
  assert.ok(strict.unassigned > RESULT.unassigned);
  const perCode = debarcode(sample, KEY, { separationCutoff: { 1: 1.5 } });
  assert.equal(perCode.counts[0], 0);
  assert.equal(perCode.counts[1], RESULT.counts[1]);
  // Deterministic.
  assert.deepEqual(Array.from(debarcode(sample, KEY).assignments), Array.from(RESULT.assignments));
});
