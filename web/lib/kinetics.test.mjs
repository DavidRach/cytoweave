import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import { alignedCurves, analyzeKinetics, autoBinWidth, findPause, kineticsMeasure } from './kinetics.js';

// Events at `rate` per second for `duration` s, optionally pausing; value(t, i, random) per event.
function events({ rate = 400, duration = 240, pause = null, value, seed = 3 }) {
  const random = createRandom(seed);
  const times = [];
  let t = 0;
  while (t < duration) {
    t += -Math.log(1 - random()) / rate;
    times.push(pause && t >= pause.at ? t + pause.length : t);
  }
  const values = Float64Array.from(times, (time, i) => value(time, i, random));
  return { times: Float64Array.from(times), values };
}

// A response: baseline 1, then 1 + 2·(1 − e^(−s/5)) for s seconds after 60 s, for responders.
const rise = (t) => (t > 60 ? 2 * (1 - Math.exp(-(t - 60) / 5)) : 0);

test('a pause in acquisition, and none', () => {
  const paused = events({ pause: { at: 60, length: 8 }, value: () => 1 });
  const found = findPause(paused.times);
  assert.ok(Math.abs(found.start - 60) < 0.05 && Math.abs(found.end - 68) < 0.05, JSON.stringify(found));
  assert.equal(findPause(events({ value: () => 1 }).times), null);
});

test('automatic bin widths: about 150 bins, at least 50 events each, rounded', () => {
  assert.equal(autoBinWidth(240, 100000), 2);
  assert.equal(autoBinWidth(240, 2000), 10);
  assert.equal(autoBinWidth(30, 1e6), 0.2);
});

test('a ratio leaves out events where either channel is not positive', () => {
  const { values, excluded } = kineticsMeasure({ a: Float32Array.of(2, 0, 3, -1), b: Float32Array.of(1, 1, 0, 2) }, { numerator: 'a', denominator: 'b' });
  assert.equal(values[0], 2);
  assert.equal(excluded, 3);
});

test('baseline, peak, time to half max and area of a known response', () => {
  const { times, values } = events({ pause: { at: 60, length: 8 }, value: (t, i, random) => 1 + rise(t) + 0.02 * (random() - 0.5) });
  const r = analyzeKinetics(times, values, { binWidth: 1, smoothing: 1 });
  assert.equal(r.stimulus.source, 'pause');
  assert.ok(Math.abs(r.stimulus.time - 60) < 0.05);
  assert.ok(Math.abs(r.baseline - 1) < 0.005, String(r.baseline));
  assert.ok(Math.abs(r.peak - 3) < 0.01, String(r.peak));
  // Half the amplitude at 5·ln 2 = 3.5 s after the stimulus, which the pause hides: the curve
  // is first measured above it when acquisition resumes, 8 s after.
  assert.ok(r.halfMaxTime >= 8 && r.halfMaxTime < 9, String(r.halfMaxTime));
  // Area from 68 s to the end (the pause moved the last events to 248 s): ∫ 2(1 − e^(−s/5)) ds
  // over s = 8…188.
  const exact = 2 * (188 - 8) - 10 * (Math.exp(-8 / 5) - Math.exp(-188 / 5));
  assert.ok(Math.abs(r.area - exact) / exact < 0.01, `${r.area} vs ${exact}`);
  assert.equal(r.responded, true);
});

test('without a pause, the onset of the response', () => {
  const { times, values } = events({ value: (t, i, random) => 1 + rise(t) + 0.05 * (random() - 0.5) });
  const r = analyzeKinetics(times, values, { binWidth: 1 });
  assert.equal(r.stimulus.source, 'onset');
  assert.ok(Math.abs(r.stimulus.time - 60) <= 2, String(r.stimulus.time));
  assert.match(r.warnings[0], /No pause in acquisition/);
  // A given stimulus is used as it is.
  assert.equal(analyzeKinetics(times, values, { stimulus: 59 }).stimulus.time, 59);
});

test('the responding fraction: half the cells respond', () => {
  const { times, values } = events({ pause: { at: 60, length: 8 }, value: (t, i, random) => (1 + 0.1 * (random() - 0.5)) * (i % 2 ? 1 + rise(t) : 1) });
  const r = analyzeKinetics(times, values, {});
  assert.ok(Math.abs(r.respondingNet - 50) < 3, String(r.respondingNet));
  assert.ok(Math.abs(r.baselineAbove - 1) < 0.5, String(r.baselineAbove));
});

test('no response: flagged, and curves aligned at their stimulus', () => {
  const flat = events({ pause: { at: 60, length: 8 }, value: (t, i, random) => 1 + 0.05 * (random() - 0.5) });
  const r = analyzeKinetics(flat.times, flat.values, {});
  assert.equal(r.responded, false);
  assert.ok(r.respondingNet < 2);
  const [aligned] = alignedCurves([{ name: 'flat', result: r }]);
  assert.ok(Math.abs(aligned.centers[0] + r.stimulus.time - r.curve.centers[0]) < 1e-9);
});
