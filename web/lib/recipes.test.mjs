import assert from 'node:assert/strict';
import test from 'node:test';
import { negativeEdge, positiveThreshold, quadrantDivider, sideThreshold } from './recipes.js';

// Seeded normal values in scale space: populations [[count, mean, sd]].
function mixture(populations, seed = 7) {
  let state = seed;
  const uniform = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state + 0.5) / 2 ** 32;
  };
  const values = [];
  for (const [count, mean, sd] of populations) {
    for (let i = 0; i < count; i += 1) values.push(mean + sd * Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()));
  }
  return Float32Array.from(values);
}

test('one broad population is one mode, however noisy its histogram', () => {
  // 600 cells: few enough that the histogram has ripples, which must not be cut between.
  const values = mixture([[600, 0.3, 0.08]]);
  const { threshold, how } = sideThreshold(values, null, '-');
  assert.match(how, /one mode/);
  assert.ok(threshold > 0.5, `${threshold}`);
});

test('a positive selection is judged where all events show the negative population', () => {
  // HLA-DR: negative lymphocytes, then monocytes and dendritic cells, both positive.
  const all = mixture([[4000, 0.2, 0.04], [1500, 0.55, 0.04], [300, 0.75, 0.04]]);
  const myeloid = Array.from({ length: 1800 }, (_, i) => 4000 + i);
  const { threshold } = positiveThreshold(all, myeloid);
  assert.ok(threshold > 0.3 && threshold < 0.45, `${threshold}`);
  // On the parent alone, the valley would have fallen between the two positive populations.
  assert.ok(quadrantDivider(all, myeloid, '+').threshold > 0.6);
});

test('with one mode on all events, the parent decides a positive selection', () => {
  const all = mixture([[3000, 0.6, 0.05]]);
  const { threshold, how } = positiveThreshold(all, null);
  assert.match(how, /one mode, taken as positive/);
  assert.ok(threshold < 0.5);
});

test('the negative edge ignores a bright shoulder', () => {
  // CD16 among CD14+ monocytes: classical cells, with intermediate ones as a shoulder above.
  const values = mixture([[3000, 0.4, 0.03], [250, 0.52, 0.03]]);
  const { threshold } = negativeEdge(values, null);
  assert.ok(threshold > 0.44 && threshold < 0.5, `${threshold}`);
});
