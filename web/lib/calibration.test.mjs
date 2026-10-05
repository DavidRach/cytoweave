import assert from 'node:assert/strict';
import test from 'node:test';
import { calibrateBeads, channelBounds, fitBeadModel, selectLevels, standardCurve } from './calibration.js';
import { createRandom } from './random.js';

const close = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg} ${a} vs ${b}`);

test('the bead model fit recovers known parameters, as FlowCal fits them', () => {
  // ln(MEF + 2000) = 1.07·ln(x) + 2.3 for levels of known MEF: x = ((MEF + 2000)/e^2.3)^(1/1.07).
  const mef = [0, 792, 2079, 6588, 16471, 47497, 137049];
  const rfi = mef.map((y) => ((y + 2000) / Math.exp(2.3)) ** (1 / 1.07));
  const fit = fitBeadModel(rfi, mef);
  close(fit.m, 1.07, 1e-8, 'm');
  close(fit.b, 2.3, 1e-8, 'b');
  close(fit.autofluorescence, 2000, 1e-6, 'autofluorescence');
  assert.ok(fit.rss < 1e-18);
  // FlowCal's own fit on its example's selected levels (reference/flowcal.json): m 1.0753075.
  const flowcal = fitBeadModel([154.0216, 198.1312, 278.7695, 532.8343, 1159.971, 2763.244, 7041.382], [0, 792, 2079, 6588, 16471, 47497, 137049]);
  close(flowcal.m, 1.0753, 1e-3);
  assert.throws(() => fitBeadModel([1, 2], [1, 2]), /three or more/);
});

test('the standard curve leaves out the beads\' autofluorescence and is odd', () => {
  const curve = standardCurve({ m: 1.07, b: 2.3 });
  close(curve(1000), Math.exp(2.3) * 1000 ** 1.07, 1e-12);
  assert.equal(curve(-1000), -curve(1000));
  assert.equal(curve(0), 0);
});

test('channel ranges and the selection of levels near the ends', () => {
  // A 4-decade log channel of 1024 steps: 1 to 10^(4 × 1023/1024).
  const bounds = channelBounds({ $P4E: '4.0,1.0', $P4R: '1024' }, 3, 1024);
  close(bounds[0], 1, 1e-12);
  close(bounds[1], 10 ** (4 * 1023 / 1024), 1e-12);
  assert.deepEqual(channelBounds({ $P1E: '0,0', $P1R: '262144' }, 0, 262144), [0, 262143]);
  const random = createRandom(3);
  const level = (center, n = 500) => Array.from({ length: n }, () => center * 10 ** (0.02 * random.gaussian()));
  const rows = selectLevels([level(1.05), level(200), level(2000), level(9800)], bounds);
  assert.deepEqual(rows.map((r) => r.used), [false, true, true, false]);
  assert.match(rows[0].why, /bottom/);
  assert.match(rows[3].why, /top/);
});

test('beads calibrated from events: levels found, values matched, curve fitted', () => {
  // Eight levels on two channels, a linear detector (x = MEF/40 + 30 background).
  const random = createRandom(5);
  const mef = [0, 792, 2079, 6588, 16471, 47497, 137049, 271647];
  const n = 8 * 600;
  const fl1 = new Float32Array(n);
  const fl2 = new Float32Array(n);
  for (let e = 0; e < n; e += 1) {
    const level = e % 8;
    const signal = (mef[level] + 1500) / 40;
    fl1[e] = signal * 10 ** (0.03 * random.gaussian());
    fl2[e] = signal * 2 * 10 ** (0.03 * random.gaussian());
  }
  const result = calibrateBeads({ FL1: fl1, FL2: fl2 }, { channels: ['FL1'], clustering: ['FL1', 'FL2'], values: { FL1: mef }, bounds: { FL1: [0, 262143] }, unit: 'MEFL' });
  const c = result.channels.FL1;
  assert.equal(c.levels.length, 8);
  assert.ok(c.levels.every((l) => l.used));
  for (let i = 0; i < 8; i += 1) close(c.levels[i].median, (mef[i] + 1500) / 40, 0.02, `level ${i + 1}`);
  close(c.fit.m, 1, 0.02, 'slope');
  close(c.fit.autofluorescence, 1500, 0.15, 'beads\' fluorescence');
  close(standardCurve(c.fit)(1000), 40000, 0.03, '1000 units in MEFL');
  assert.throws(() => calibrateBeads({ FL1: fl1 }, { channels: ['FL1'], values: { FL1: [1, 2] } }), /three or more/);
});
