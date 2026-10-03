import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandom } from './random.js';
import {
  bandwidthNrd0,
  boxSmooth,
  findEventsPerBin,
  findPeaks,
  flowRateCheck,
  generalizedESD,
  isolationForest,
  isolationTreeSD,
  isolationTreeSDClassic,
  smoothSpline,
  makeBins,
  marginEvents,
  peacoQC,
  qcSummary,
  runningMedian,
  signalDrift,
  studentTQuantile,
} from './qc.js';

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected} (tolerance ${tolerance})`);
}

const CHANNELS = [
  { name: 'FSC-A', type: 'scatter', range: 262144 },
  { name: 'SSC-A', type: 'scatter', range: 262144 },
  { name: 'FL1-A', type: 'fluorescence', range: 262144 },
  { name: 'FL2-A', type: 'fluorescence', range: 262144 },
  { name: 'Time', type: 'time', range: 262144 },
];

// 100 s at 1000 events/s ($TIMESTEP 0.01) with: a gap at 30–32 s, a clog at 41–44 s (every signal
// × 0.3; kind 1) and a burst of 2000 debris events at 70.0–70.2 s (kind 2).
function simulateRun(seed, { anomalies = true } = {}) {
  const random = createRandom(seed);
  const g = random.gaussian;
  const rows = [];
  let t = 0;
  for (;;) {
    t += -Math.log(1 - random()) / 1000;
    if (anomalies && t >= 30 && t < 32) t += 2;
    if (t >= 100) break;
    rows.push({ t, kind: anomalies && t >= 41 && t < 44 ? 1 : 0 });
  }
  if (anomalies) for (let i = 0; i < 2000; i += 1) rows.push({ t: 70 + 0.2 * random(), kind: 2 });
  rows.sort((a, b) => a.t - b.t);
  const n = rows.length;
  const columns = {};
  for (const c of CHANNELS) columns[c.name] = new Float32Array(n);
  const kind = new Uint8Array(n);
  rows.forEach((row, i) => {
    kind[i] = row.kind;
    columns.Time[i] = row.t / 0.01;
    if (row.kind === 2) {
      columns['FSC-A'][i] = Math.max(0, 9000 + 3000 * g());
      columns['SSC-A'][i] = 3000 * Math.exp(0.5 * g());
      columns['FL1-A'][i] = 80 * g();
      columns['FL2-A'][i] = 80 * g() + 300 * Math.exp(0.5 * g());
      return;
    }
    const f = row.kind === 1 ? 0.3 : 1;
    columns['FSC-A'][i] = f * Math.max(0, 70000 + 9000 * g());
    columns['SSC-A'][i] = f * 20000 * Math.exp(0.3 * g());
    columns['FL1-A'][i] = random() < 0.6 ? 80 * g() : f * 6000 * Math.exp(0.5 * g());
    columns['FL2-A'][i] = f * 2000 * Math.exp(0.4 * g()) + 50 * g();
  });
  return { sample: { eventCount: n, channels: CHANNELS, columns, keywords: { $TIMESTEP: '0.01' } }, kind };
}

const RUN = simulateRun(7);
const PEACO = peacoQC(RUN.sample);
const FLOW = flowRateCheck(RUN.sample);

function removalByKind(mask, kind) {
  const removed = [0, 0, 0];
  const total = [0, 0, 0];
  for (let i = 0; i < kind.length; i += 1) {
    total[kind[i]] += 1;
    if (!mask[i]) removed[kind[i]] += 1;
  }
  return removed.map((r, k) => (total[k] ? r / total[k] : 0));
}

test('FindEventsPerBin and overlapping bins follow PeacoQC', () => {
  // max(150, ⌈2N/500⌉ rounded down to a multiple of 500, plus 500).
  assert.equal(findEventsPerBin(100000), 500);
  assert.equal(findEventsPerBin(10000), 500);
  assert.equal(findEventsPerBin(300000), 1500);
  assert.equal(findEventsPerBin(1000000), 4500);
  assert.equal(findEventsPerBin(1000, { step: 50 }), 150); // 50 < min_cells
  assert.equal(findEventsPerBin(100000, { step: 50 }), 450);
  assert.deepEqual(makeBins(1000, 500), [{ start: 0, end: 500 }, { start: 250, end: 750 }, { start: 500, end: 1000 }, { start: 750, end: 1000 }]);
});

test('bw.nrd0 and box smoothing match R by hand', () => {
  // sd(1:5) = 1.5811, IQR/1.34 = 2/1.34 = 1.4925 → 0.9 × 1.4925 × 5^−0.2.
  close(bandwidthNrd0(Float64Array.of(1, 2, 3, 4, 5)), 0.9 * (2 / 1.34) * 5 ** -0.2, 1e-12);
  // ksmooth(1:10, 1:10, 'box', bandwidth = 4): the mean of points within ±2.
  const smooth = boxSmooth(Float64Array.from({ length: 10 }, (_, i) => i + 1), 4);
  close(smooth[0], 2, 1e-12);
  close(smooth[5], 6, 1e-12);
  close(smooth[9], 9, 1e-12);
});

test('FindThemPeaks finds both modes and drops peaks lower than a third of the highest', () => {
  const random = createRandom(3);
  const values = new Float64Array(4000);
  for (let i = 0; i < 4000; i += 1) values[i] = (i < 2000 ? 0 : 6) + random.gaussian();
  const peaks = findPeaks(values.slice().sort());
  assert.equal(peaks.length, 2);
  close(peaks[0], 0, 0.25, 'first mode');
  close(peaks[1], 6, 0.25, 'second mode');
  // A 10% shoulder is below peak_removal = 1/3 of the main peak.
  const skewed = new Float64Array(4000);
  for (let i = 0; i < 4000; i += 1) skewed[i] = (i < 3600 ? 0 : 6) + random.gaussian();
  assert.equal(findPeaks(skewed.slice().sort()).length, 1);
});

test('runningMedian matches R runmed by hand, ends included', () => {
  const values = Float64Array.of(1, 5, 2, 8, 3, 9, 4);
  assert.deepEqual(Array.from(runningMedian(values, 3, { endrule: 'constant' })), [2, 2, 5, 3, 8, 4, 4]);
  // Tukey's end-point rule: median(y1, s2, 3 s2 − 2 s3).
  assert.deepEqual(Array.from(runningMedian(values, 3)), [1, 2, 5, 3, 8, 4, 4]);
  const line = Float64Array.from({ length: 100 }, (_, i) => i);
  assert.deepEqual(Array.from(runningMedian(line, 21)), Array.from(line));
});

test('Student t quantiles match published tables', () => {
  close(studentTQuantile(0.975, 10), 2.228139, 1e-6);
  close(studentTQuantile(0.995, 5), 4.032143, 1e-6);
  close(studentTQuantile(0.95, 1), 6.313752, 1e-6);
  close(studentTQuantile(0.999, 30), 3.385185, 1e-6);
  close(studentTQuantile(0.025, 10), -2.228139, 1e-6);
});

test('generalized ESD finds exactly the planted outliers', () => {
  const random = createRandom(11);
  const values = Float64Array.from({ length: 200 }, () => 50 + 5 * random.gaussian());
  values[17] = 120;
  values[90] = -30;
  values[150] = 110;
  for (const robust of [true, false]) {
    const { outliers } = generalizedESD(values, { alpha: 0.01, maxOutliers: 20, robust });
    assert.deepEqual(Array.from(outliers).sort((a, b) => a - b), [17, 90, 150], `robust=${robust}`);
  }
});

test('the isolation tree (PeacoQC) and the isolation forest isolate obvious outliers', () => {
  const random = createRandom(5);
  const n = 300;
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    a[i] = random.gaussian();
    b[i] = random.gaussian();
  }
  const outliers = [10, 50, 120, 200, 280];
  for (const i of outliers) {
    a[i] = 9 + random.gaussian() * 0.1;
    b[i] = 9 + random.gaussian() * 0.1;
  }
  const tree = isolationTreeSD([a, b], { gainLimit: 0.6 });
  for (const i of outliers) assert.equal(tree.good[i], 0, `tree keeps outlier ${i}`);
  let keptNormal = 0;
  for (let i = 0; i < n; i += 1) if (!outliers.includes(i) && tree.good[i]) keptNormal += 1;
  assert.ok(keptNormal / (n - outliers.length) >= 0.97, `tree keeps ${keptNormal}`);

  const { scores } = isolationForest([a, b], { seed: 9 });
  const again = isolationForest([a, b], { seed: 9 }).scores;
  assert.deepEqual(Array.from(again), Array.from(scores), 'deterministic for a seed');
  const normal = [];
  for (let i = 0; i < n; i += 1) if (!outliers.includes(i)) normal.push(scores[i]);
  normal.sort((x, y) => x - y);
  const p99 = normal[Math.floor(0.99 * (normal.length - 1))];
  const meanNormal = normal.reduce((s, v) => s + v, 0) / normal.length;
  for (const i of outliers) {
    assert.ok(scores[i] > 0.6, `outlier score ${scores[i]}`);
    assert.ok(scores[i] > p99, `outlier ${scores[i]} vs 99th percentile ${p99}`);
  }
  assert.ok(meanNormal < 0.5, `mean inlier score ${meanNormal}`);
});

test('PeacoQC removes the injected clog and burst and spares clean events', () => {
  const [clean, clog, burst] = removalByKind(PEACO.mask, RUN.kind);
  assert.ok(clog >= 0.9, `clog removed ${clog}`);
  assert.ok(burst >= 0.9, `burst removed ${burst}`);
  assert.ok(clean <= 0.03, `clean removed ${clean}`);
  assert.equal(PEACO.eventsPerBin, 500);
  assert.ok(PEACO.itPerformed);
  // Every removed bin says why; the episodes sit on the anomalies.
  for (const bin of PEACO.bins) {
    let removed = false;
    for (let i = bin.start; i < bin.end && !removed; i += 1) removed = PEACO.mask[i] === 0;
    if (bin.removedBy.length) assert.ok(removed);
  }
  const episodes = PEACO.episodes.map((e) => [e.startTime, e.endTime]);
  assert.ok(episodes.some(([s, e]) => s <= 41.2 && e >= 43.8), JSON.stringify(episodes));
  assert.ok(episodes.some(([s, e]) => s <= 70.05 && e >= 70.15), JSON.stringify(episodes));
  assert.ok(episodes.every(([s, e]) => (s >= 40 && e <= 45) || (s >= 69 && e <= 71)), JSON.stringify(episodes));
  // FL1-A is bimodal: two peak trajectories.
  assert.equal(PEACO.channelTracks['FL1-A'].peaks.length, 2);
  assert.equal(PEACO.channelTracks['FSC-A'].peaks[0].length, PEACO.bins.length);
});

test('PeacoQC removes almost nothing from a clean acquisition', () => {
  const { sample } = simulateRun(8, { anomalies: false });
  const result = peacoQC(sample);
  assert.ok(result.percentRemoved <= 3, `removed ${result.percentRemoved}%`);
});

test('the flow-rate check flags the gap and the burst, and nothing else', () => {
  assert.equal(FLOW.sliceSeconds, 0.1);
  assert.equal(FLOW.timestepAssumed, false);
  const gap = FLOW.episodes.find((e) => e.direction === 'gap');
  assert.ok(gap, JSON.stringify(FLOW.episodes));
  close(gap.startTime, 30, 0.11);
  close(gap.endTime, 32, 0.11);
  const burst = FLOW.episodes.find((e) => e.direction === 'high');
  assert.ok(burst && burst.startTime >= 69.9 && burst.endTime <= 70.3, JSON.stringify(FLOW.episodes));
  for (const e of FLOW.episodes) assert.ok((e.startTime >= 29.8 && e.endTime <= 32.2) || (e.startTime >= 69.8 && e.endTime <= 70.4), JSON.stringify(e));
  const [, , debris] = removalByKind(FLOW.mask, RUN.kind);
  assert.ok(debris >= 0.9, `burst events removed ${debris}`);
});

test('margin events are counted exactly', () => {
  const n = 1000;
  const random = createRandom(2);
  const fsc = new Float32Array(n);
  const fl = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    fsc[i] = 1000 + 200000 * random();
    fl[i] = 10 + 5000 * random();
  }
  for (const i of [3, 77, 150, 151, 600, 601, 999]) fsc[i] = 262143; // saturated at $PnR − 1
  for (const i of [5, 6, 7, 8, 9]) fsc[i] = 0; // piled at the lowest value
  for (const i of [150, 400, 401, 402]) fl[i] = 9000; // piled at the observed maximum (no $PnR)
  fl[20] = 1; // a single lowest value is not a pile
  const sample = {
    eventCount: n,
    channels: [{ name: 'FSC-A', type: 'scatter', range: 262144 }, { name: 'FL1-A', type: 'fluorescence', range: 0 }],
    columns: { 'FSC-A': fsc, 'FL1-A': fl },
  };
  const result = marginEvents(sample);
  assert.equal(result.counts['FSC-A'].upper, 7);
  assert.equal(result.counts['FSC-A'].lower, 5);
  assert.equal(result.counts['FL1-A'].upper, 4);
  assert.equal(result.counts['FL1-A'].lower, 0);
  assert.equal(result.removed, 7 + 5 + 3); // event 150 is in both channels
  assert.equal(result.mask[150], 0);
  assert.equal(result.mask[20], 1);
});

test('signal drift reports the fold change of a linear drift', () => {
  const n = 40000;
  const random = createRandom(4);
  const time = new Float32Array(n);
  const drifting = new Float32Array(n);
  const stable = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = (100 * i) / n;
    time[i] = t / 0.01;
    drifting[i] = 1000 * (1 - 0.003 * t) * Math.exp(0.2 * random.gaussian());
    stable[i] = 1000 * Math.exp(0.2 * random.gaussian());
  }
  const sample = {
    eventCount: n,
    channels: [{ name: 'A', type: 'fluorescence', range: 262144 }, { name: 'B', type: 'fluorescence', range: 262144 }, { name: 'Time', type: 'time', range: 262144 }],
    columns: { A: drifting, B: stable, Time: time },
    keywords: { $TIMESTEP: '0.01' },
  };
  const drift = signalDrift(sample, ['A', 'B'], { bins: 20 });
  // Trend at 5% and 95% of the run: (1 − 0.285) / (1 − 0.015).
  close(drift.channels.A.foldChange, 0.715 / 0.985, 0.015);
  close(drift.channels.B.foldChange, 1, 0.015);
  assert.deepEqual(drift.drifted, ['A']);
});

test('qcSummary combines masks, counts unique removals and explains the findings', () => {
  const margins = marginEvents(RUN.sample);
  const drift = signalDrift(RUN.sample);
  const summary = qcSummary({ peacoQC: PEACO, flowRate: FLOW, margins, drift });
  let expected = 0;
  for (let i = 0; i < PEACO.mask.length; i += 1) if (!PEACO.mask[i] || !FLOW.mask[i] || !margins.mask[i]) expected += 1;
  assert.equal(summary.removed, expected);
  let onlyFlow = 0;
  for (let i = 0; i < PEACO.mask.length; i += 1) if (PEACO.mask[i] && !FLOW.mask[i] && margins.mask[i]) onlyFlow += 1;
  assert.equal(summary.byMethod.flowRate.unique, onlyFlow);
  const expectedScore = Math.round(100 - Math.min(60, 2 * summary.percentRemoved) - Math.min(15, 3 * FLOW.episodes.length) - Math.min(20, 5 * drift.drifted.length));
  assert.equal(summary.score, expectedScore);
  const text = summary.findings.map((f) => f.text).join('\n');
  assert.match(text, /signal drop \(possible clog\) in [\w-]+ at 41–44 s removed \d\.\d% of events/);
  assert.match(text, /No events were acquired at 30–32 s/);
  assert.match(text, /A burst of events at 70\.0–70\.2 s/);
});

// CytoWeave's refinements (peak-tracking tolerance, localized MAD, time-coherent isolation-tree
// splits) on the simulator's QC plate: clean wells keep their events, anomalies are caught.
test('refined PeacoQC keeps clean wells and catches the planted anomalies', async () => {
  const { generateExample } = await import('./examples.js');
  const { parseFCS, readSpillover } = await import('./fcs.js');
  const { compensate } = await import('./compensation.js');
  const { files, workspaceHints } = generateExample('qc-showcase', {});
  const scales = Object.fromEntries(Object.entries(workspaceHints.channelSettings).map(([name, setting]) => [name, setting.transform]));
  // Raw, and compensated on the workspace's scales (as the QC view runs it). Compensated, the
  // drifting well A03 once lost its first bins: a steady drift sat more than 4 noise SDs from the
  // track's median at the start, and a track pinned near the bottom of the scale had a noise
  // estimate of ~0.
  for (const [file, compensated] of files.flatMap((f) => [[f, false], [f, true]])) {
    const d = parseFCS(file.bytes).datasets[0];
    const time = d.data[d.parameters.findIndex((p) => p.type === 'time')];
    const inWindow = new Uint8Array(d.eventCount);
    for (const w of file.meta.truth.anomalies ?? []) for (let i = 0; i < d.eventCount; i += 1) if (time[i] >= w.startTime && time[i] <= w.endTime) inWindow[i] = 1;
    const sample = { eventCount: d.eventCount, channels: d.parameters.map((p) => ({ name: p.name, type: p.type, range: p.range })), columns: Object.fromEntries(d.parameters.map((p) => [p.name, d.data[p.index]])) };
    if (compensated) sample.columns = { ...sample.columns, ...compensate(sample.columns, readSpillover(d.keywords, d.parameters)) };
    const channels = d.parameters.filter((p) => p.type === 'scatter' || p.type === 'fluorescence').map((p) => p.name);
    const { mask } = peacoQC(sample, { channels, transforms: compensated ? scales : undefined });
    let anomalous = 0; let caught = 0; let falseRemoved = 0;
    for (let i = 0; i < mask.length; i += 1) {
      if (inWindow[i]) { anomalous += 1; if (!mask[i]) caught += 1; } else if (!mask[i]) falseRemoved += 1;
    }
    const falseRate = falseRemoved / (mask.length - anomalous);
    assert.ok(falseRate < 0.06, `${file.name}: ${(100 * falseRate).toFixed(2)}% of clean events removed`);
    if (anomalous) assert.ok(caught / anomalous > 0.95, `${file.name}: caught ${(100 * caught / anomalous).toFixed(1)}%`);
    else assert.ok(falseRate < 0.01, `${file.name}: clean well lost ${(100 * falseRate).toFixed(2)}%`);
  }
});

test("smoothSpline reproduces R's smooth.spline(spar = 0.5)", () => {
  // R 4.6: smooth.spline(seq_along(y), y, spar = 0.5)$y.
  const y = [0.2, 0.5, 0.1, 0.9, 1.4, 1.1, 2.0, 1.7, 2.6, 3.1, 2.8, 3.9];
  const r = [0.153745636365074, 0.328097075885929, 0.530042015925485, 0.803095405945159, 1.10145583658306, 1.3950990061936, 1.71529568190042, 2.05648086225473, 2.44317789215264, 2.83928260031081, 3.24140022139063, 3.69282776509244];
  smoothSpline(y, 0.5).forEach((v, i) => assert.ok(Math.abs(v - r[i]) < 1e-12, `${i}: ${v} vs ${r[i]}`));
  // 60 points: knots at a subset of the x values (.nknots.smspl).
  const y2 = [-0.026, 0.269, 0.531, 0.388, 0.779, 0.847, 0.937, 1.195, 0.754, 1.249, 0.817, 0.683, 0.684, 0.774, 0.629, 0.396, 0.113, 0.011, 0.22, -0.151, -0.466, -0.69, -0.679, -1.09, -0.952, -1.077, -0.745, -0.797, -1.007, -1.186, -0.718, -0.643, -0.56, -0.431, -0.505, -0.138, 0.144, 0.058, 0.019, 0.533, 0.68, 0.595, 1.113, 0.709, 1.008, 0.529, 0.967, 1.216, 0.86, 0.707, 0.944, 0.526, 0.611, 0.065, -0.027, 0.001, -0.282, 0.033, -0.214, -0.701];
  const fit = smoothSpline(y2, 0.5);
  [[0, 0.0409215487038666], [16, 0.258384969819398], [29, -0.901059788750828], [44, 0.87841377943683], [59, -0.527079961261864]].forEach(([i, v]) => assert.ok(Math.abs(fit[i] - v) < 1e-12, `${i}`));
});

test("the classic isolation tree raises its gain limit after each split, as PeacoQC's does", () => {
  // Bin 0 is far off and bin 1 less so: the first split isolates bin 0; splitting off bin 1 would
  // gain less than that first split, so PeacoQC's tree stops, keeping bin 1.
  const column = Float64Array.from({ length: 40 }, (_, i) => (i === 0 ? 10 : i === 1 ? 3 : (i % 5) * 0.1));
  const classic = isolationTreeSDClassic([column], { gainLimit: 0.3 });
  assert.equal(classic.good[0], 0);
  assert.equal(classic.good[1], 1);
  const free = isolationTreeSD([column], { gainLimit: 0.3 });
  assert.equal(free.good[0], 0);
  assert.equal(free.good[1], 0);
});
