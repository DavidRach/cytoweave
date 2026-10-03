import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptGate, landmarks, localDensity, matchLandmarks, warpFunction, indexList } from './adapt.js';
import { createRandom } from './random.js';
import { pointTest } from './gates.js';

// Samples of a mixture: components [{ n, mean: [x, y], sd: [sx, sy], label }].
function mixture(components, seed) {
  const random = createRandom(seed);
  const xs = []; const ys = []; const labels = [];
  for (const c of components) {
    for (let i = 0; i < c.n; i += 1) {
      xs.push(c.mean[0] + c.sd[0] * random.gaussian());
      ys.push(c.mean[1] + c.sd[1] * random.gaussian());
      labels.push(c.label ?? 0);
    }
  }
  return { columns: [Float32Array.from(xs), Float32Array.from(ys)], list: indexList(null, xs.length), labels };
}

function f1(type, geometry, sample, label) {
  const test = pointTest(type, geometry);
  let tp = 0; let fp = 0; let fn = 0;
  for (const e of sample.list) {
    const inside = type === 'split' || type === 'range' ? test(sample.columns[0][e]) : test(sample.columns[0][e], sample.columns[1][e]);
    const truth = sample.labels[e] === label;
    if (inside && truth) tp += 1; else if (inside) fp += 1; else if (truth) fn += 1;
  }
  return (2 * tp) / (2 * tp + fp + fn);
}

test('landmarks are found and matched in order, and the warp maps between them', () => {
  const a = mixture([{ n: 4000, mean: [0.25, 0], sd: [0.04, 0.1] }, { n: 3000, mean: [0.7, 0], sd: [0.05, 0.1] }], 1);
  const b = mixture([{ n: 4000, mean: [0.3, 0], sd: [0.04, 0.1] }, { n: 3000, mean: [0.8, 0], sd: [0.05, 0.1] }], 2);
  const pa = landmarks(localDensity(a.columns, a.list, 0, null, 2.6));
  const pb = landmarks(localDensity(b.columns, b.list, 0, null, 2.6));
  assert.equal(pa.length, 2);
  const pairs = matchLandmarks(pa, pb);
  assert.equal(pairs.length, 2);
  const warp = warpFunction(pairs);
  assert.ok(Math.abs(warp(0.25) - 0.3) < 0.02 && Math.abs(warp(0.7) - 0.8) < 0.02);
  assert.ok(Math.abs(warp(0.475) - 0.55) < 0.03, 'between peaks, interpolated');
  assert.ok(Math.abs(warp(0.9) - 1.0) < 0.03, 'beyond, shifted');
});

test('a split in a valley follows the valley of a shifted sample', () => {
  const comps = (shift) => [{ n: 5000, mean: [0.2 + shift, 0], sd: [0.05, 0.1], label: 0 }, { n: 3000, mean: [0.68 + shift * 1.05, 0], sd: [0.06, 0.1], label: 1 }];
  const exemplar = { sampleId: 'a', geometry: { threshold: 0.4, side: 'hi' }, ...mixture(comps(0), 3) };
  // Shifted (as a 4-fold gain on a logicle axis would) so the old threshold cuts into the
  // negative population.
  const target = mixture(comps(0.15), 4);
  const current = { threshold: 0.4, side: 'hi' };
  const r = adaptGate({ type: 'split', current, exemplars: [exemplar], target });
  assert.equal(r.status, 'adjust');
  assert.ok(r.confidence > 0.85, `confidence ${r.confidence}`);
  assert.ok(r.geometry.threshold > 0.5 && r.geometry.threshold < 0.75, `threshold ${r.geometry.threshold}`);
  assert.ok(f1('split', r.geometry, target, 1) > f1('split', current, target, 1) + 0.03);
  assert.ok(f1('split', r.geometry, target, 1) > 0.97);
});

test('a polygon around a cluster follows the cluster, and probabilities mark its boundary', () => {
  const comps = (dx, dy) => [
    { n: 6000, mean: [0.3, 0.3], sd: [0.06, 0.06], label: 0 },
    { n: 2500, mean: [0.62 + dx, 0.62 + dy], sd: [0.04, 0.04], label: 1 },
    { n: 3000, mean: [0.75, 0.3], sd: [0.05, 0.05], label: 2 },
  ];
  const square = (cx, cy, r) => ({ vertices: [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]] });
  const exemplar = { sampleId: 'a', geometry: square(0.62, 0.62, 0.12), ...mixture(comps(0, 0), 5) };
  const target = mixture(comps(0.08, -0.07), 6);
  const r = adaptGate({ type: 'polygon', current: exemplar.geometry, exemplars: [exemplar], target });
  assert.equal(r.status, 'adjust');
  const before = f1('polygon', exemplar.geometry, target, 1);
  const after = f1('polygon', r.geometry, target, 1);
  assert.ok(after > 0.97 && after > before + 0.03, `${before} → ${after}`);
  // Probabilities: high inside, low far outside.
  const p = r.probabilities;
  let inside = 0; let ni = 0; let far = 0; let nf = 0;
  target.list.forEach((e, k) => {
    if (target.labels[e] === 1) { inside += p[k]; ni += 1; } else if (target.labels[e] === 0) { far += p[k]; nf += 1; }
  });
  assert.ok(inside / ni > 0.9 && far / nf < 0.01, `inside ${inside / ni}, far ${far / nf}`);
});

test('a population that is not there is sent to review, not moved', () => {
  const exemplar = { sampleId: 'a', geometry: { threshold: 0.45, side: 'hi' }, ...mixture([{ n: 5000, mean: [0.2, 0], sd: [0.05, 0.1] }, { n: 3000, mean: [0.7, 0], sd: [0.06, 0.1] }], 7) };
  // One broad population straddling the threshold: nothing to register to.
  const target = mixture([{ n: 8000, mean: [0.45, 0], sd: [0.12, 0.1] }], 8);
  const r = adaptGate({ type: 'split', current: { threshold: 0.45, side: 'hi' }, exemplars: [exemplar], target });
  assert.equal(r.status, 'review');
  assert.ok(r.confidence < 0.8, `confidence ${r.confidence}`);
});

test('the most similar exemplar leads', () => {
  const comps = (shift) => [{ n: 5000, mean: [0.2 + shift, 0], sd: [0.05, 0.1], label: 0 }, { n: 3000, mean: [0.7 + shift, 0], sd: [0.06, 0.1], label: 1 }];
  const far = { sampleId: 'far', geometry: { threshold: 0.45, side: 'hi' }, ...mixture(comps(0), 9) };
  const near = { sampleId: 'near', geometry: { threshold: 0.58, side: 'hi' }, ...mixture(comps(0.13), 10) };
  const target = mixture(comps(0.14), 11);
  const r = adaptGate({ type: 'split', current: { threshold: 0.45, side: 'hi' }, exemplars: [far, near], target });
  assert.equal(r.exemplars[0].sampleId, 'near');
  assert.ok(Math.abs(r.geometry.threshold - 0.59) < 0.04, `threshold ${r.geometry.threshold}`);
});

test('a boundary that still sits in sparse events is kept when a population moves', () => {
  // The positive population moved (as a stimulation moves it), the negative one did not; the
  // threshold between them is still in the valley, so it stays.
  const exemplar = { sampleId: 'a', geometry: { threshold: 0.45, side: 'hi' }, ...mixture([{ n: 5000, mean: [0.2, 0], sd: [0.04, 0.1] }, { n: 3000, mean: [0.75, 0], sd: [0.05, 0.1] }], 12) };
  const target = mixture([{ n: 5000, mean: [0.2, 0], sd: [0.04, 0.1] }, { n: 3000, mean: [0.63, 0], sd: [0.05, 0.1] }], 13);
  const r = adaptGate({ type: 'split', current: { threshold: 0.45, side: 'hi' }, exemplars: [exemplar], target });
  assert.equal(r.status, 'keep', `${r.status}: ${r.reason}`);
  assert.ok(r.sensitivity.current < 0.05);
});
