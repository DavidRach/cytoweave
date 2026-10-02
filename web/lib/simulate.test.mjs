import assert from 'node:assert/strict';
import test from 'node:test';
import { compensate, robustSD } from './compensation.js';
import { parseFCS, readSpillover } from './fcs.js';
import { createRandom } from './random.js';
import {
  INSTRUMENTS,
  acquisitionKeywords,
  allocateCounts,
  buildPanel,
  cholesky,
  compilePopulations,
  createNormal,
  encodeFCS,
  fcsClock,
  fcsDate,
  formatSpilloverKeyword,
  logGamma,
  massSpillover,
  poisson,
  sampleCell,
  shuffledLabels,
  simulateCellCycle,
  simulateEvents,
  simulateMassEvents,
  spectralSignature,
} from './simulate.js';

function median(values) {
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
}

function pick(column, labels, label) {
  const out = [];
  for (let e = 0; e < labels.length; e += 1) if (labels[e] === label) out.push(column[e]);
  return out;
}

test('logGamma matches factorials and Γ(1/2)', () => {
  assert.ok(Math.abs(logGamma(1)) < 1e-12);
  assert.ok(Math.abs(logGamma(5) - Math.log(24)) < 1e-12);
  assert.ok(Math.abs(logGamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-12);
  assert.ok(Math.abs(logGamma(20) - 39.33988418719949) < 1e-10); // ln 19!
});

test('poisson variates have mean and variance λ', () => {
  const random = createRandom(11);
  for (const lambda of [0.5, 7, 10, 55, 900]) {
    const n = 40000;
    let sum = 0;
    let sum2 = 0;
    let zeros = 0;
    for (let i = 0; i < n; i += 1) {
      const k = poisson(random, lambda);
      assert.ok(Number.isInteger(k) && k >= 0);
      sum += k;
      sum2 += k * k;
      if (k === 0) zeros += 1;
    }
    const mean = sum / n;
    const variance = sum2 / n - mean * mean;
    assert.ok(Math.abs(mean - lambda) < 5 * Math.sqrt(lambda / n), `mean ${mean} for λ ${lambda}`);
    assert.ok(Math.abs(variance / lambda - 1) < 0.05, `variance ${variance} for λ ${lambda}`);
    if (lambda === 0.5) assert.ok(Math.abs(zeros / n - Math.exp(-0.5)) < 0.01);
  }
});

test('ziggurat normals have the standard normal moments and tails', () => {
  const normal = createNormal(createRandom(5));
  const n = 200000;
  let sum = 0;
  let sum2 = 0;
  let beyond2 = 0;
  let beyond3 = 0;
  for (let i = 0; i < n; i += 1) {
    const x = normal();
    sum += x;
    sum2 += x * x;
    if (Math.abs(x) > 2) beyond2 += 1;
    if (Math.abs(x) > 3) beyond3 += 1;
  }
  assert.ok(Math.abs(sum / n) < 0.01);
  assert.ok(Math.abs(sum2 / n - 1) < 0.015);
  assert.ok(Math.abs(beyond2 / n - 0.0455) < 0.002);
  assert.ok(Math.abs(beyond3 / n - 0.0027) < 0.0006);
});

test('allocateCounts gives exact largest-remainder counts and shuffledLabels keeps them', () => {
  assert.deepEqual(Array.from(allocateCounts(100, [0.55, 0.3, 0.15])), [55, 30, 15]);
  assert.deepEqual(Array.from(allocateCounts(10, [1, 1, 1])), [4, 3, 3]);
  assert.deepEqual(Array.from(allocateCounts(7, [0, 2, 0])), [0, 7, 0]);
  const labels = shuffledLabels(Int32Array.from([3, 0, 5]), createRandom(2));
  assert.equal(labels.length, 8);
  assert.equal(labels.filter((l) => l === 0).length, 3);
  assert.equal(labels.filter((l) => l === 2).length, 5);
});

test('cholesky factors a positive definite matrix and rejects others', () => {
  const L = cholesky(Float64Array.from([4, 2, 2, 3]), 2);
  assert.deepEqual(Array.from(L).map((v) => +v.toFixed(12)), [2, 0, 1, +Math.SQRT2.toFixed(12)]);
  assert.equal(cholesky(Float64Array.from([1, 2, 2, 1]), 2), null);
});

test('spillover from fluorochrome spectra has the familiar structure', () => {
  const panel = buildPanel(INSTRUMENTS.fortessa, [
    { marker: 'A', fluor: 'BV421', detector: 'BV421-A' },
    { marker: 'B', fluor: 'Aqua', detector: 'BV510-A' },
    { marker: 'C', fluor: 'FITC', detector: 'FITC-A' },
    { marker: 'D', fluor: 'PE', detector: 'PE-A' },
    { marker: 'E', fluor: 'PE-Cy7', detector: 'PE-Cy7-A' },
    { marker: 'F', fluor: 'APC', detector: 'APC-A' },
    { marker: 'G', fluor: 'Alexa Fluor 700', detector: 'Alexa Fluor 700-A' },
  ]);
  const { channels, matrix, n } = panel.spill;
  const S = (from, to) => matrix[channels.indexOf(from) * n + channels.indexOf(to)];
  for (let i = 0; i < n; i += 1) assert.equal(matrix[i * n + i], 1);
  assert.ok(S('BV421-A', 'BV510-A') > 0.1 && S('BV421-A', 'BV510-A') < 0.35, 'BV421 spills into BV510');
  assert.ok(S('FITC-A', 'PE-A') < 0.01, 'FITC barely reaches PE on a separate yellow-green laser');
  assert.ok(S('APC-A', 'Alexa Fluor 700-A') > 0.08 && S('APC-A', 'Alexa Fluor 700-A') < 0.3);
  assert.ok(S('PE-Cy7-A', 'PE-A') > 0.01, 'tandem donor emission');
  assert.ok(S('PE-A', 'PE-Cy7-A') < S('PE-Cy7-A', 'PE-A'));
});

test('spectral signatures are peak-normalized and peak on the right laser', () => {
  const detectors = INSTRUMENTS.aurora.detectors;
  assert.equal(detectors.length, 64);
  const names = detectors.map((d) => d.name);
  for (const [fluor, prefix] of [['PE', 'YG'], ['APC', 'R'], ['BV421', 'V'], ['BUV395', 'UV'], ['FITC', 'B']]) {
    const signature = spectralSignature(fluor, detectors);
    assert.equal(Math.max(...signature), 1);
    assert.ok(names[signature.indexOf(1)].startsWith(prefix), `${fluor} peaks in ${names[signature.indexOf(1)]}`);
  }
});

test('population sampling recovers log-normal medians, spreads and correlations', () => {
  const [pop] = compilePopulations([{ name: 'P', fsc: [60000, 0.1], ssc: [14000, 0.2], markers: { A: [1000, 0.4], B: [5000, 0.2] }, corr: [['A', 'B', 0.5]] }], ['A', 'B', 'C'], { stained: new Set(['A', 'B']) });
  const normal = createNormal(createRandom(9));
  const out = new Float64Array(pop.d);
  const scratch = new Float64Array(pop.d);
  const n = 20000;
  const logA = new Float64Array(n);
  const logB = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    sampleCell(pop, normal, out, scratch);
    logA[i] = Math.log(out[4]);
    logB[i] = Math.log(out[5]);
    assert.equal(out[6], 0, 'an unstained marker has no signal');
  }
  assert.ok(Math.abs(Math.exp(median(logA)) / 1000 - 1) < 0.03);
  const meanA = logA.reduce((a, b) => a + b, 0) / n;
  const meanB = logB.reduce((a, b) => a + b, 0) / n;
  let sa = 0;
  let sb = 0;
  let sab = 0;
  for (let i = 0; i < n; i += 1) {
    sa += (logA[i] - meanA) ** 2;
    sb += (logB[i] - meanB) ** 2;
    sab += (logA[i] - meanA) * (logB[i] - meanB);
  }
  assert.ok(Math.abs(Math.sqrt(sa / n) - 0.4) < 0.015);
  assert.ok(Math.abs(Math.sqrt(sb / n) - 0.2) < 0.008);
  // Correlation = shared size factor (0.25 × 0.25) + the pair's 0.5.
  assert.ok(Math.abs(sab / Math.sqrt(sa * sb) - 0.5625) < 0.03);
});

function beadSetup(target = 150000) {
  const instrument = INSTRUMENTS.fortessa;
  const panel = buildPanel(instrument, [
    { marker: 'X', fluor: 'BV650', detector: 'BV650-A' },
    { marker: 'Y', fluor: 'BV711', detector: 'BV711-A' },
  ]);
  const base = { fsc: [42000, 0.04], ssc: [9000, 0.06], af: 0.08 };
  const brightness = panel.emitters[2 * 2];
  const populations = compilePopulations([
    { ...base, name: 'neg', markers: { X: 0 } },
    { ...base, name: 'pos', markers: { X: [target / brightness, 0.12] } },
  ], panel.markers, { stained: new Set(['X']) });
  return { instrument, panel, populations };
}

test('simulateEvents is deterministic and samples compositions with counting noise', () => {
  const { instrument, panel, populations } = beadSetup();
  const config = { count: 3000, instrument, panel, populations, weights: Float64Array.from([1, 3]), mix: { debris: 0.1, doublets: 0.05 }, rate: 1000 };
  const a = simulateEvents(config, createRandom(42));
  const b = simulateEvents(config, createRandom(42));
  const c = simulateEvents(config, createRandom(43));
  for (const name of a.order) assert.deepEqual(a.columns[name], b.columns[name]);
  assert.notDeepEqual(a.columns['BV650-A'], c.columns['BV650-A']);
  const counts = a.labelNames.map((_, i) => a.labels.filter((l) => l === i).length);
  // 85 % live split 1:3, 10 % debris, 5 % doublets, each a multinomial draw: within 4 binomial SDs.
  [637.5, 1912.5, 0, 300, 150, 0].forEach((expected, i) => {
    const sd = Math.sqrt(expected * (1 - expected / 3000));
    assert.ok(Math.abs(counts[i] - expected) <= 4 * sd, `${a.labelNames[i]}: ${counts[i]} vs ${expected}`);
  });
  // Two tubes from one donor differ by counting noise, as real tubes do.
  const countsC = c.labelNames.map((_, i) => c.labels.filter((l) => l === i).length);
  assert.notDeepEqual(counts, countsC);
  for (let e = 1; e < 3000; e += 1) assert.ok(a.columns.Time[e] >= a.columns.Time[e - 1]);
});

test('doublets have a higher FSC-A/FSC-H ratio and a longer pulse', () => {
  const { instrument, panel, populations } = beadSetup();
  const sim = simulateEvents({ count: 4000, instrument, panel, populations, weights: Float64Array.from([1, 1]), mix: { doublets: 0.1 } }, createRandom(3));
  const ratio = (label) => median(pick(sim.columns['FSC-A'], sim.labels, label).map((a, i) => a / pick(sim.columns['FSC-H'], sim.labels, label)[i]));
  const doublet = sim.labelNames.indexOf('Doublets');
  assert.ok(ratio(doublet) > 1.3 * ratio(1));
  assert.ok(median(pick(sim.columns['FSC-W'], sim.labels, doublet)) > 1.3 * median(pick(sim.columns['FSC-W'], sim.labels, 1)));
  assert.ok(Math.abs(median(pick(sim.columns['FSC-A'], sim.labels, doublet)) / median(pick(sim.columns['FSC-A'], sim.labels, 1)) - 2) < 0.15);
});

test('detector physics: baseline noise goes negative, bright events clip, photon noise spreads', () => {
  const { instrument, panel, populations } = beadSetup(150000);
  const sim = simulateEvents({ count: 4000, instrument, panel, populations, weights: Float64Array.from([1, 1]) }, createRandom(8));
  const negatives = sim.columns['BV711-A'].filter((v, e) => v < 0 && sim.labels[e] === 0).length;
  assert.ok(negatives > 300, 'dim events scatter around zero');
  const comp = compensate(sim.columns, panel.spill);
  const pos = pick(comp['BV711-A'], sim.labels, 1);
  const neg = pick(comp['BV711-A'], sim.labels, 0);
  assert.ok(Math.abs(median(pos) - median(neg)) < 200, 'compensation removes the spillover');
  assert.ok(robustSD(pos) > 5 * robustSD(neg), 'but not the photon noise it carried (spreading error)');
  const bright = beadSetup(400000);
  const saturated = simulateEvents({ count: 1000, instrument, panel: bright.panel, populations: bright.populations, weights: Float64Array.from([0, 1]) }, createRandom(1));
  const top = saturated.columns['BV650-A'].filter((v) => v === instrument.range - 1).length;
  assert.ok(top > 900, 'events above the range sit at $PnR − 1');
  assert.ok(Math.max(...saturated.columns['BV650-A']) <= instrument.range - 1);
});

test('a clog lowers the event rate and the signal inside its window; drift dims late events', () => {
  const { instrument, panel, populations } = beadSetup();
  const sim = simulateEvents({ count: 6000, instrument, panel, populations, weights: Float64Array.from([0, 1]), rate: 1000, anomalies: [{ kind: 'clog', at: 0.4, length: 0.15, rate: 0.1, signal: 0.6 }] }, createRandom(4));
  const [w] = sim.windows;
  const inside = Array.from(sim.times).filter((t) => t >= w.start && t < w.end).length;
  const insideRate = inside / (w.end - w.start);
  const outsideRate = (6000 - inside) / (sim.duration - (w.end - w.start));
  assert.ok(insideRate < 0.25 * outsideRate, `rate ${insideRate} vs ${outsideRate}`);
  const signalIn = median(pick(sim.columns['BV650-A'], sim.anomaly, 1));
  const signalOut = median(pick(sim.columns['BV650-A'], sim.anomaly, 0));
  assert.ok(Math.abs(signalIn / signalOut - 0.6) < 0.05);
  const drift = simulateEvents({ count: 5000, instrument, panel, populations, weights: Float64Array.from([0, 1]), rate: 1000, drift: { fluorescence: -0.4 } }, createRandom(4));
  const column = drift.columns['BV650-A'];
  assert.ok(median(column.slice(4000)) / median(column.slice(0, 1000)) < 0.75);
});

test('cell cycle: exact phase fractions, G2/G1 ratio, CV and pulse-width doublet discrimination', () => {
  const sim = simulateCellCycle({ count: 20000, instrument: INSTRUMENTS.canto, phases: { G1: 0.55, S: 0.3, G2M: 0.15 } }, createRandom(6));
  const [g1, s, g2] = [0, 1, 2].map((label) => sim.labels.filter((l) => l === label).length);
  const singlets = g1 + s + g2;
  assert.ok(Math.abs(g1 / singlets - 0.55) < 0.001 && Math.abs(s / singlets - 0.3) < 0.001 && Math.abs(g2 / singlets - 0.15) < 0.001);
  const piA = sim.columns['PI-A'];
  const g1Values = pick(piA, sim.labels, 0);
  assert.ok(Math.abs(median(pick(piA, sim.labels, 2)) / median(g1Values) - 1.97) < 0.03);
  const cv = robustSD(g1Values) / median(g1Values);
  assert.ok(cv > 0.035 && cv < 0.048, `G1 CV ${cv}`);
  const doublets = sim.labelNames.indexOf('Doublets');
  assert.ok(median(pick(sim.columns['PI-W'], sim.labels, doublets)) > 1.25 * median(pick(sim.columns['PI-W'], sim.labels, 2)));
});

test('mass cytometry: Poisson counts with randomization, zero inflation, oxides and bead drift', () => {
  const channels = [
    { name: 'Ce140Di', label: '140Ce', mass: 140, role: 'bead' },
    { name: 'Nd144Di', label: '144Nd_CD19', mass: 144, marker: 'CD19', role: 'marker' },
    { name: 'Gd160Di', label: '160Gd_CD14', mass: 160, marker: 'CD14', role: 'marker' },
    { name: 'Ir191Di', label: '191Ir_DNA1', mass: 191, role: 'dna1' },
    { name: 'Ir193Di', label: '193Ir_DNA2', mass: 193, role: 'dna2' },
  ];
  const markers = ['CD19', 'CD14'];
  const populations = compilePopulations([{ name: 'B', markers: { CD19: [2e4, 0.3] } }, { name: 'Mono', markers: { CD14: [1e5, 0.3] } }], markers);
  const sim = simulateMassEvents({ count: 6000, channels, populations, weights: Float64Array.from([1, 1]), markers, drift: 0.3, beadLevels: { Ce140Di: 1500 } }, createRandom(12));
  const cd19 = sim.channels[1];
  let zeros = 0;
  for (const v of cd19) {
    if (v === 0) zeros += 1;
    else assert.ok(v > Math.ceil(v) - 1 && v <= Math.ceil(v), 'randomized counts lie in (n − 1, n]');
  }
  assert.ok(zeros / cd19.length > 0.3, 'CD19-negative cells give mostly zero counts');
  const B = sim.labelNames.indexOf('B');
  const ratio = median(pick(sim.channels[3], sim.labels, B).map((v, i) => pick(sim.channels[4], sim.labels, B)[i] / v));
  assert.ok(Math.abs(ratio - 437 / 260) < 0.15, '193Ir/191Ir follows isotopic abundance');
  const beads = pick(sim.channels[0], sim.labels, sim.labelNames.indexOf('Beads'));
  const third = Math.floor(beads.length / 3);
  const decline = 1 - median(beads.slice(-third)) / median(beads.slice(0, third));
  assert.ok(decline > 0.1 && decline < 0.35, `bead signal declines over the run (${decline})`);
  const oxide = massSpillover([144, 160]);
  assert.equal(oxide[1], 0.022);
  assert.equal(oxide[2], 0);
});

test('FCS helpers: dates, clock times and $SPILLOVER text', () => {
  assert.equal(fcsDate('2026-03-12'), '12-MAR-2026');
  assert.equal(fcsClock(3723), '01:02:03');
  const text = formatSpilloverKeyword({ channels: ['FITC-A', 'PE-A'], matrix: Float64Array.from([1, 0.2125, 0.01, 1]) });
  assert.equal(text, '2,FITC-A,PE-A,1,0.2125,0.01,1');
  const spill = readSpillover({ $SPILLOVER: text });
  assert.deepEqual(spill.channels, ['FITC-A', 'PE-A']);
  assert.deepEqual(Array.from(spill.matrix), [1, 0.2125, 0.01, 1]);
});

test('simulated samples write FCS 3.1 files that parse without warnings', () => {
  const { instrument, panel, populations } = beadSetup();
  const sim = simulateEvents({ count: 500, instrument, panel, populations, weights: Float64Array.from([1, 1]), rate: 500 }, createRandom(2));
  const parameters = sim.order.map((name) => ({ name, label: name === 'BV650-A' ? 'CD3' : '', range: instrument.range, voltage: name === 'BV650-A' ? 500 : null }));
  const keywords = acquisitionKeywords({ instrument, date: '2026-03-12', start: 36000, duration: sim.duration, fileName: 'test.fcs', spill: panel.spill });
  const bytes = encodeFCS(parameters, sim.order.map((name) => sim.columns[name]), keywords);
  const [dataset] = parseFCS(bytes).datasets;
  assert.equal(dataset.diagnostics.filter((d) => d.level !== 'info').length, 0);
  assert.equal(dataset.version, 'FCS3.1');
  assert.deepEqual(dataset.parameters.map((p) => p.name), sim.order);
  assert.equal(dataset.parameters.find((p) => p.name === 'BV650-A').voltage, 500);
  assert.equal(dataset.keywords.$TIMESTEP, '0.01');
  assert.equal(dataset.keywords.$BTIM, '10:00:00');
  assert.equal(readSpillover(dataset.keywords, dataset.parameters).n, 2);
  assert.ok(Number(dataset.keywords.$VOL) > 0);
});
