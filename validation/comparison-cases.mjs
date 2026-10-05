// Population comparisons and rare-event statistics (wave 6, slice 1): test tubes with a known
// positive fraction against a negative control, for CytoWeave's comparisons and for flowStats
// (reference/flowstats.json); and the simulation of Bagwell (1996) that compares Dmax, enhanced
// Dmax and ENS.

import { encodeFCS } from '../web/lib/simulate.js';
import { createRandom } from '../web/lib/random.js';

// Each tube: events, the share of positive events and how they are drawn. Values are linear, as a
// cytometer writes them: negatives near 300 on FITC-A, with electronic noise that reaches below
// zero; positives a decade and a half above (well separated), half a decade above (overlapping),
// or spread over two decades (skewed). PE-A follows FITC-A with its own background, for formulas.
export const TUBES = [
  { name: 'Control', events: 20000, positive: 0, seed: 101 },
  { name: 'Replicate', events: 20000, positive: 0, seed: 102 },
  { name: 'Positive 5', events: 20000, positive: 0.05, kind: 'bright', seed: 103 },
  { name: 'Positive 20', events: 20000, positive: 0.2, kind: 'bright', seed: 104 },
  { name: 'Positive 40', events: 20000, positive: 0.4, kind: 'bright', seed: 105 },
  { name: 'Overlap 40', events: 20000, positive: 0.4, kind: 'dim', seed: 106 },
  { name: 'Skewed 30', events: 20000, positive: 0.3, kind: 'smear', seed: 107 },
  { name: 'Shifted', events: 20000, positive: 0, scale: 1.6, seed: 108 },
  { name: 'Small 30', events: 3000, positive: 0.3, kind: 'bright', seed: 109 },
  { name: 'Dimmer', events: 20000, positive: 0, scale: 0.5, seed: 110 },
];

const POSITIVE = { bright: [4.0, 0.2], dim: [3.1, 0.25], smear: [3.6, 0.45] };

export const PARAMETERS = [
  { name: 'FSC-A', label: '', range: 262144 },
  { name: 'SSC-A', label: '', range: 262144 },
  { name: 'FITC-A', label: 'CD25', range: 262144 },
  { name: 'PE-A', label: 'CD69', range: 262144 },
];

// One tube's columns and the true positive fraction among its events.
export function tubeColumns(tube) {
  const random = createRandom(tube.seed);
  const n = tube.events;
  const fsc = new Float32Array(n);
  const ssc = new Float32Array(n);
  const fitc = new Float32Array(n);
  const pe = new Float32Array(n);
  const positives = Math.round(n * tube.positive);
  for (let e = 0; e < n; e += 1) {
    const positive = e < positives;
    const [mu, sigma] = positive ? POSITIVE[tube.kind] : [2.5, 0.22];
    const signal = 10 ** (mu + sigma * random.gaussian()) * (tube.scale ?? 1);
    fitc[e] = signal + 25 * random.gaussian();
    pe[e] = 0.5 * signal * 10 ** (0.1 * random.gaussian()) + 10 ** (2.2 + 0.2 * random.gaussian()) + 20 * random.gaussian();
    fsc[e] = 60000 + 8000 * random.gaussian();
    ssc[e] = 20000 + 4000 * random.gaussian();
  }
  // Positive events are mixed among the negatives, as a cytometer acquires them.
  for (let e = n - 1; e > 0; e -= 1) {
    const k = Math.floor(random() * (e + 1));
    for (const column of [fsc, ssc, fitc, pe]) [column[e], column[k]] = [column[k], column[e]];
  }
  return { columns: [fsc, ssc, fitc, pe], truth: positives / n };
}

// The tubes as FCS files: [{ name, bytes, truth }].
export function comparisonTubes() {
  return TUBES.map((tube) => {
    const { columns, truth } = tubeColumns(tube);
    // An identity spillover matrix: the values are as compensated, so compensation leaves them be.
    const bytes = encodeFCS(PARAMETERS, columns, { $FIL: `${tube.name}.fcs`, $CYT: 'CytoWeave simulation', $TOT: String(tube.events), $SPILLOVER: '2,FITC-A,PE-A,1,0,0,1' });
    return { name: `${tube.name}.fcs`, bytes, truth, tube };
  });
}

// Bagwell's (1996) simulation: histograms of 128 channels, negatives and positives drawn from
// Weibull distributions with modes 20–40 and 50–80, widths 10–40 and shapes 2–2.5, a control drawn
// from the negatives' distribution. Bagwell gives peak heights of 200–1000 events per channel,
// read here as heights, so that a population of width w holds about height · w / 0.86 events.
// Returns the relative errors (%) of Dmax, enhanced Dmax and ENS over `count` histograms.
export function bagwellSimulation(sed, count = 2000, seed = 11) {
  const random = createRandom(seed);
  const between = (a, b) => a + (b - a) * random();
  const draw = (n, mode, width, shape) => {
    const offset = ((shape - 1) / shape) ** (1 / shape);
    return Float64Array.from({ length: n }, () => Math.min(127, Math.max(0, Math.round(mode + width * ((-Math.log(1 - random())) ** (1 / shape) - offset)))));
  };
  const errors = { dmax: [], enhancedDmax: [], ens: [] };
  for (let k = 0; k < count; k += 1) {
    const [cn, wn, sn] = [between(20, 40), between(10, 40), between(2, 2.5)];
    const [cp, wp, sp] = [between(50, 80), between(10, 40), between(2, 2.5)];
    const nNeg = Math.round((between(200, 1000) * wn) / 0.858);
    const nPos = Math.round((between(200, 1000) * wp) / 0.858);
    const nCtl = Math.round((between(200, 1000) * wn) / 0.858);
    const control = draw(nCtl, cn, wn, sn);
    const test = Float64Array.from([...draw(nNeg, cn, wn, sn), ...draw(nPos, cp, wp, sp)]);
    const truth = (100 * nPos) / (nNeg + nPos);
    const result = sed(control, test);
    errors.dmax.push((100 * (result.dmax - truth)) / truth);
    errors.enhancedDmax.push((100 * (result.enhancedDmax - truth)) / truth);
    errors.ens.push((100 * (result.percentPositive - truth)) / truth);
  }
  return errors;
}
