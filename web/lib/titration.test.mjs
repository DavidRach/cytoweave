import assert from 'node:assert/strict';
import test from 'node:test';
import { createTransform } from './transforms.js';
import { analyzeTitration, analyzeVoltageWalk, fitSaturation, parseAmount, parseVoltage, separationIndex, stainIndex, titrationSeries } from './titration.js';

function normals(seed = 11) {
  let state = seed;
  const uniform = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state + 0.5) / 2 ** 32;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

const logicle = createTransform({ type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 });

// Negative cells N(negMean, negSD) and positive cells N(posMean, posSD), clipped at the range.
function step(n, share, [negMean, negSD], [posMean, posSD], g, range = 262144) {
  const linear = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = i < n * share ? posMean + posSD * g() : negMean + negSD * g();
    linear[i] = Math.min(v, range - 1);
  }
  return { linear, scaled: Float64Array.from(linear, (v) => logicle.forward(v)), range };
}

test('amounts and voltages are read from names', () => {
  assert.deepEqual(parseAmount('CD4-PE 125 ng'), { kind: 'mass', value: 125, label: '125 ng' });
  assert.equal(parseAmount('CD8 FITC 0.5ug per test').value, 500);
  assert.equal(parseAmount('CD8_FITC_1-200').label, '1:200');
  assert.equal(parseAmount('tube 1:50').value, 1 / 50);
  assert.equal(parseAmount('CD3 2.5 uL').kind, 'volume');
  assert.equal(parseAmount('CD4-PE'), null);
  assert.equal(parseVoltage('Voltage walk 450 V'), 450);
  assert.equal(parseVoltage('PE_V500'), 500);
  assert.equal(parseVoltage('Tube 3'), null);
  const series = titrationSeries([{ name: 'Unstained' }, { name: 'CD4 1-100' }, { name: 'CD4 1-25' }, { name: 'CD4 1-400' }, { name: 'Notes' }].map((s, i) => ({ id: String(i), meta: {}, ...s })));
  assert.deepEqual(series.steps.map((s) => s.amount.label), ['1:400', '1:100', '1:25']);
  assert.equal(series.unstained.length, 1);
  assert.equal(series.kind, 'dilution');
});

test('stain and separation indices as published', () => {
  const negative = { median: 100, rsd: 50, p84: 150 };
  const positive = { median: 10100 };
  assert.equal(stainIndex(positive, negative), 100);
  assert.ok(Math.abs(separationIndex(positive, negative) - 199) < 1e-9);
});

test('a saturation curve is recovered', () => {
  const xs = [1, 2, 4, 8, 16, 32, 64];
  const fit = fitSaturation(xs, xs.map((x) => (300 * x) / (6 + x)));
  assert.ok(Math.abs(fit.k - 6) < 0.01 && Math.abs(fit.top - 300) < 0.5, JSON.stringify(fit));
});

test('a titration: saturation, excess antibody and the recommended amount', () => {
  const g = normals();
  const k = 5;
  const amounts = [2, 4, 8, 16, 31, 62, 125, 250, 500, 1000];
  // Positive median follows occupancy; the negative cells' background and spread grow with excess.
  const steps = amounts.map((c) => ({ label: `${c} ng`, amount: { kind: 'mass', value: c, label: `${c} ng` }, ...step(20000, 0.45, [10 + 0.08 * c, 25 + 0.06 * c], [20000 * (c / (c + k)), 4000 * (c / (c + k))], g) }));
  const result = analyzeTitration(steps);
  assert.ok(result.rows.every((r) => r.resolved));
  assert.ok(result.rows.every((r) => Math.abs(r.fraction - 0.45) < 0.01));
  // 90% of saturation near 9k = 45 ng; twice that, 90 ng, is first reached at 125 ng.
  assert.ok(result.c90 > 30 && result.c90 < 60, String(result.c90));
  assert.equal(result.recommended.row.label, '125 ng');
  assert.ok(result.best.row.amount.value >= 31 && result.best.row.amount.value <= 125);
});

test('steps whose populations overlap take the series\' shares', () => {
  const g = normals(3);
  const amounts = [0.004, 0.1, 1, 4, 16];
  const steps = amounts.map((c) => ({ label: `${c} ng`, amount: { kind: 'mass', value: c, label: `${c} ng` }, ...step(20000, 0.3, [10, 30], [3000 * c, 600 * c], g) }));
  const result = analyzeTitration(steps);
  assert.equal(result.rows[0].resolved, false);
  assert.equal(result.rows[0].estimated, true);
  assert.ok(result.rows.slice(2).every((r) => r.resolved));
  assert.ok(result.notes.some((n) => /overlap/.test(n)));
});

test('a voltage walk: gain exponent, electronic noise, minimum and maximum voltage', () => {
  const g = normals(5);
  const n = 7.4;
  const sigma = 25;
  const voltages = [300, 350, 400, 450, 500, 550, 600, 650];
  // At 430 V the negative cells' own spread is 17 and the positive median 20,000.
  const steps = voltages.map((v) => {
    const gain = (v / 430) ** n;
    return { label: `${v} V`, voltage: v, ...step(20000, 0.45, [10 * gain, Math.hypot(sigma, 17 * gain)], [20000 * gain, 3500 * gain], g) };
  });
  const result = analyzeVoltageWalk(steps);
  assert.ok(Math.abs(result.exponent - n) < 0.1, String(result.exponent));
  assert.equal(result.noise.source, 'estimated');
  assert.ok(Math.abs(result.noise.rsdEN - sigma) < 2, String(result.noise.rsdEN));
  // 2.5 σ = hypot(σ, 17 G) where G = sqrt(5.25) × 25 / 17; V = 430 × G^(1/n).
  const truth = 430 * ((Math.sqrt(5.25) * sigma) / 17) ** (1 / n);
  assert.ok(Math.abs(result.minimum.voltage - truth) < 8, `${result.minimum.voltage} vs ${truth}`);
  // The 99th percentile of the positive cells (mean + 2.33 SD) reaches 90% of the range at:
  const maxTruth = 430 * ((0.9 * 262144) / (20000 + 2.326 * 3500)) ** (1 / n);
  assert.ok(Math.abs(result.maximum.voltage - maxTruth) < 8, `${result.maximum.voltage} vs ${maxTruth}`);
  assert.equal(result.recommended.voltage, Math.ceil(result.minimum.voltage / 5) * 5);
  // Given the noise, the same minimum.
  const given = analyzeVoltageWalk(steps, { rsdEN: sigma });
  assert.ok(Math.abs(given.minimum.voltage - truth) < 8);
  // A walk that starts too high to see the noise says so.
  const high = analyzeVoltageWalk(steps.slice(4));
  assert.equal(high.noise, null);
  assert.ok(high.notes.some((x) => /baseline report/.test(x)));
});
