import assert from 'node:assert/strict';
import test from 'node:test';
import { binomialInterval, classifyValue, countPrecision, detectionLimits, eventsNeeded, poissonInterval } from './rare-events.js';

function close(actual, expected, relative, message = '') {
  assert.ok(Math.abs(actual - expected) <= relative * Math.max(1, Math.abs(expected)), `${message} ${actual} vs ${expected}`);
}

test('exact Poisson intervals equal R poisson.test', () => {
  // R 4.6.1: poisson.test(n)$conf.int
  const R = [[0, 0, 3.68887945411394], [1, 0.0253178079842899, 5.5716433909389], [5, 1.62348639011842, 11.6683320793227], [25, 16.1786818478293, 36.9049316975304], [1000, 938.973018407695, 1063.9521360163]];
  for (const [n, lo, hi] of R) {
    const [a, b] = poissonInterval(n);
    close(a, lo, 1e-12, `lower ${n}`);
    close(b, hi, 1e-12, `upper ${n}`);
  }
});

test('exact binomial intervals equal R binom.test', () => {
  // R 4.6.1: binom.test(x, n)$conf.int
  const R = [[0, 50, 0, 0.0711217364641976], [3, 100000, 6.18676395892204e-06, 8.7670202566362e-05], [17, 40, 0.270429031268863, 0.591099419573037], [40, 40, 0.911902697121198, 1]];
  for (const [x, n, lo, hi] of R) {
    const [a, b] = binomialInterval(x, n);
    assert.ok(Math.abs(a - lo) <= 1e-12 * Math.max(lo, 1e-6), `lower ${x}/${n}: ${a} vs ${lo}`);
    assert.ok(Math.abs(b - hi) <= 1e-12, `upper ${x}/${n}: ${b} vs ${hi}`);
  }
});

test('events needed and counting precision', () => {
  // Roederer 2008: 100 events give a 10% CV, 400 events 5%.
  assert.equal(eventsNeeded(10).events, 100);
  assert.equal(eventsNeeded(5).events, 400);
  assert.equal(eventsNeeded(20).events, 25);
  // A 0.01% population at 10% CV: (1 − 10⁻⁴)/(10⁻⁴ · 0.01) = 999,900 parent events.
  assert.equal(eventsNeeded(10, 0.01).parentEvents, 999900);
  close(countPrecision(100), 10, 1e-12);
  close(countPrecision(100, 200), 100 * Math.sqrt(0.5 / 100), 1e-12, 'binomial');
});

test('limits of blank, detection and quantification (CLSI EP17)', () => {
  const blanks = [0, 0.001, 0.002, 0.001, 0.003, 0, 0.002, 0.001, 0.004, 0.002];
  const mean = blanks.reduce((a, b) => a + b, 0) / blanks.length;
  const sd = Math.sqrt(blanks.reduce((a, b) => a + (b - mean) ** 2, 0) / (blanks.length - 1));
  const low = [[0.010, 0.012, 0.008, 0.011], [0.050, 0.047, 0.052, 0.049]];
  const pooled = Math.sqrt(low.reduce((acc, g) => {
    const m = g.reduce((a, b) => a + b, 0) / g.length;
    return acc + g.reduce((a, b) => a + (b - m) ** 2, 0);
  }, 0) / (low[0].length - 1 + low[1].length - 1));
  const limits = detectionLimits(blanks, low, { cvTarget: 10 });
  close(limits.lob, mean + 1.6448536269514722 * sd, 1e-12, 'LoB');
  close(limits.lod, limits.lob + 1.6448536269514722 * pooled, 1e-12, 'LoD');
  // The first group's CV is 17%, the second's 4%: the LoQ is the second's mean.
  close(limits.loq, 0.0495, 1e-12, 'LoQ');
  assert.ok(limits.notes.some((n) => /EP17 asks for 20/.test(n)));

  // Nonparametric: the value at rank 0.5 + 0.95 × 10 = 10 of the sorted blanks.
  assert.equal(detectionLimits(blanks, [], { method: 'nonparametric' }).lob, 0.004);
  // Rank 0.5 + 0.95 × 30 = 29: the 29th of 30; with 20 blanks rank 19.5, halfway to the 20th.
  const thirty = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.equal(detectionLimits(thirty, [], { method: 'nonparametric' }).lob, 29);
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  close(detectionLimits(twenty, [], { method: 'nonparametric' }).lob, 19.5, 1e-12, 'rank 19.5');

  assert.equal(classifyValue(0.003, limits), 'not-detected');
  assert.equal(classifyValue(0.02, limits), 'detected');
  assert.equal(classifyValue(0.06, limits), 'quantifiable');
});
