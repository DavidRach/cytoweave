import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyTransform,
  axisTicks,
  biexTable,
  biexToLogicle,
  createLogicle,
  createTransform,
  defaultTransform,
  estimateLogicleW,
  powerLabel,
  validateLogicle,
} from './transforms.js';

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected} (tolerance ${tolerance})`);
}

test('logicle maps zero to x1 = (W + A) / (M + A) and T to 1', () => {
  for (const params of [
    { T: 262144, W: 0.5, M: 4.5, A: 0 },
    { T: 1000, W: 1, M: 4, A: 0 },
    { T: 4194304, W: 1.2, M: 5.6, A: 0.5 },
    { T: 10000, W: 0, M: 4, A: 1 },
  ]) {
    const logicle = createLogicle(params);
    close(logicle.forward(0), (params.W + params.A) / (params.M + params.A), 1e-14, 'zero');
    close(logicle.forward(params.T), 1, 1e-12, 'top');
  }
});

test('logicle round-trips across the whole range, both signs', () => {
  const logicle = createLogicle({ T: 262144, W: 0.75, M: 4.5, A: 0 });
  for (const x of [-5000, -1000, -100, -10, -1, -0.01, 0.001, 0.5, 3, 47, 999, 12345, 100000, 262144, 1e6]) {
    const y = logicle.forward(x);
    close(logicle.inverse(y), x, Math.max(1e-9, Math.abs(x) * 1e-10), `x=${x}`);
  }
});

test('logicle is monotone and odd-symmetric about data zero', () => {
  const logicle = createLogicle({ T: 262144, W: 0.5, M: 4.5, A: 0 });
  let last = -Infinity;
  for (let x = -2000; x <= 262144; x += 37.3) {
    const y = logicle.forward(x);
    assert.ok(y > last, `monotone at ${x}`);
    last = y;
  }
  for (const x of [1, 10, 100, 1000]) close(logicle.forward(x) - logicle.x1, logicle.x1 - logicle.forward(-x), 1e-12, `symmetry ${x}`);
});

test('logicle approaches a logarithm in the upper decades', () => {
  const logicle = createLogicle({ T: 262144, W: 0.5, M: 4.5, A: 0 });
  // One decade below the top is about 1/M of the scale below 1.
  close(logicle.forward(26214.4), 1 - 1 / 4.5, 2e-3);
  close(logicle.forward(2621.44), 1 - 2 / 4.5, 2e-2);
});

test('logicle with W = 0 and A = 0 equals Gating-ML fasinh', () => {
  const logicle = createTransform({ type: 'logicle', T: 262144, W: 0, M: 4.5, A: 0 });
  const fasinh = createTransform({ type: 'fasinh', T: 262144, M: 4.5, A: 0 });
  for (const x of [-1000, -10, 0, 1, 50, 1000, 100000, 262144]) close(logicle.forward(x), fasinh.forward(x), 1e-12, `x=${x}`);
});

test('logicle rejects parameters outside the constraints', () => {
  assert.throws(() => validateLogicle({ T: 0, W: 0.5, M: 4.5, A: 0 }));
  assert.throws(() => validateLogicle({ T: 100, W: 3, M: 4.5, A: 0 }));
  assert.throws(() => validateLogicle({ T: 100, W: 0.5, M: 4.5, A: -1 }));
});

test('the lookup-table path agrees with the exact logicle', () => {
  const transform = createTransform({ type: 'logicle', T: 262144, W: 0.6, M: 4.5, A: 0 });
  const column = new Float32Array(20000);
  for (let i = 0; i < column.length; i += 1) column[i] = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 300000 - 20000;
  const fast = applyTransform(column, transform);
  let worst = 0;
  for (let i = 0; i < column.length; i += 1) worst = Math.max(worst, Math.abs(fast[i] - transform.forward(column[i])));
  assert.ok(worst < 2e-6, `worst ${worst}`);
});

test('linear, log, arcsinh and hyperlog round-trip', () => {
  const specs = [
    { type: 'linear', min: -100, max: 262144 },
    { type: 'log', min: 1, max: 262144 },
    { type: 'arcsinh', cofactor: 5, max: 10000 },
    { type: 'fasinh', T: 262144, M: 4.5, A: 1 },
    { type: 'hyperlog', T: 262144, W: 0.5, M: 4.5, A: 0 },
  ];
  for (const spec of specs) {
    const transform = createTransform(spec);
    for (const x of [2, 10, 100, 5000, 100000]) {
      if (spec.type === 'arcsinh' && x > 10000) continue;
      close(transform.inverse(transform.forward(x)), x, Math.abs(x) * 1e-8 + 1e-8, `${spec.type} ${x}`);
    }
  }
  const log = createTransform({ type: 'log', min: 10, max: 1e5 });
  close(log.forward(10), 0, 1e-12);
  close(log.forward(1e5), 1, 1e-12);
  close(log.forward(1000), 0.5, 1e-12);
});

test('hyperlog is odd-symmetric and reaches the top at T', () => {
  const hyperlog = createTransform({ type: 'hyperlog', T: 262144, W: 0.5, M: 4.5, A: 0 });
  close(hyperlog.forward(262144), 1, 1e-9);
  const zero = hyperlog.forward(0);
  close(zero, 0.5 / 4.5, 1e-9);
  close(hyperlog.forward(500) - zero, zero - hyperlog.forward(-500), 1e-9);
});

test('FlowJo biex maps onto a valid logicle', () => {
  const params = biexToLogicle({ maxValue: 262144, widthBasis: -10, positiveDecades: 4.5, extraNegativeDecades: 0 });
  assert.equal(params.T, 262144);
  close(params.W, 0.5, 1e-12);
  validateLogicle(params);
  const wide = biexToLogicle({ maxValue: 262144, widthBasis: -1000, positiveDecades: 4.5, extraNegativeDecades: 0 });
  validateLogicle(wide);
});

test('FlowJo biex: its table, zero channel, width clamp and inverse', () => {
  const spec = { type: 'biex', maxValue: 262144.000029, widthBasis: -10, positiveDecades: 4.41854, extraNegativeDecades: 0 };
  const table = biexTable(spec);
  assert.equal(table.length, 4097);
  // BD's published table: channel 0 → −132.287, 2048 → 1711.34, 4095 → 260973.
  close(table[0], -132.287, 1e-3);
  close(table[2048], 1711.34, 1e-2);
  close(table[4095], 260973, 1);
  const biex = createTransform(spec);
  // Zero sits at channel trunc(4096 · 0.5 / 4.41854) = 463.
  close(biex.forward(0), 463 / 4096, 1e-12);
  for (const x of [-5000, -100, 0, 37, 1e3, 1e5, 3e5]) close(biex.inverse(biex.forward(x)), x, 1e-9 * Math.max(1, Math.abs(x)));
  // FlowJo treats width bases between −1 and −√10 as −√10.
  assert.deepEqual(Array.from(biexTable({ ...spec, widthBasis: -1 })), Array.from(biexTable({ ...spec, widthBasis: -Math.sqrt(10) })));
  // The event path (table interpolation) agrees with forward().
  const column = Float32Array.from([-300, -10, 0, 55, 2000, 150000]);
  const out = applyTransform(column, biex);
  column.forEach((v, i) => close(out[i], biex.forward(v), 1e-6));
});

test('W is estimated from the negative tail', () => {
  const values = new Float32Array(10000);
  for (let i = 0; i < values.length; i += 1) values[i] = i < 1000 ? -200 + (i % 100) : 100 + i * 10;
  const W = estimateLogicleW(values, 262144, 4.5);
  // r ≈ −200 + something: W = (4.5 − log10(262144 / |r|)) / 2 ≈ 0.81.
  assert.ok(W > 0.6 && W < 1.0, `W ${W}`);
  const positive = Float32Array.from({ length: 1000 }, (_, i) => i + 1);
  assert.equal(estimateLogicleW(positive, 262144, 4.5), 0.25);
});

test('logicle axis ticks label decades and zero without crowding', () => {
  const transform = createTransform({ type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 });
  const ticks = axisTicks(transform);
  const labels = ticks.filter((t) => t.label).map((t) => t.label);
  assert.ok(labels.includes('0'));
  assert.ok(labels.includes(powerLabel(3)));
  assert.ok(labels.includes(powerLabel(5)));
  for (let i = 1; i < ticks.length; i += 1) assert.ok(ticks[i].position >= ticks[i - 1].position);
});

test('linear ticks use readable steps', () => {
  const ticks = axisTicks(createTransform({ type: 'linear', min: 0, max: 262144 }));
  const labels = ticks.filter((t) => t.major).map((t) => t.label);
  assert.deepEqual(labels.slice(0, 3), ['0', '50K', '100K']);
});

test('default transforms follow the channel type and technology', () => {
  assert.equal(defaultTransform({ type: 'scatter', range: 262144 }).type, 'linear');
  assert.equal(defaultTransform({ type: 'fluorescence', range: 262144 }).type, 'logicle');
  assert.equal(defaultTransform({ type: 'fluorescence', range: 262144 }, 'mass').type, 'arcsinh');
  assert.equal(defaultTransform({ type: 'time', range: 262144 }).type, 'linear');
});
