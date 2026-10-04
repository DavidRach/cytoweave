// Titration and voltage-walk validation cases (the `titration` suite of run.mjs). The example
// "titration-voltage" knows every event's cell type, the antibody's binding constant, the PE
// detector's electronic noise and its gain at every voltage. The analysis (lib/titration.js) is
// run as the app runs it, within the example's lymphocyte gate, and compared with:
//   - the stain index of each step computed from the true CD4 T cells (positive) and the true
//     CD4-negative lymphocytes, on the same events;
//   - the binding: 90% of CD4 bound at 9 K, so the recommended amount is the first tested at or
//     above 18 K;
//   - the voltages at which the true negative cells' rSD reaches 2.5 times the electronic noise,
//     and the true CD4 T cells' 99th percentile reaches 90% of the range, found by bisection on
//     large simulated samples of the same cells.

import { generateExample, TITRATION, titrationPopulations, walkGains } from '../web/lib/examples.js';
import { INSTRUMENTS, buildPanel, compilePopulations, createRandom, getDetector, simulateEvents } from '../web/lib/simulate.js';
import { addGates, gatePath } from '../web/lib/workspace.js';
import { population } from '../web/lib/engine.js';
import { quantileSorted } from '../web/lib/stats.js';
import { analyzeTitration, analyzeVoltageWalk, stepsFrom, titrationSeries, voltageSeries } from '../web/lib/titration.js';
import { loadSamples } from './template-cases.mjs';

const NEGATIVE = new Set(['CD8 T', 'B cells', 'NK cells']);
const PANEL = [
  { marker: 'CD3', fluor: 'FITC', detector: 'FITC-A' },
  { marker: 'CD4', fluor: 'PE', detector: 'PE-A' },
  { marker: 'CD8', fluor: 'APC', detector: 'APC-A' },
];

// The example loaded as the app loads it, with its suggested gates: { ws, views, files, lymphocytes }.
export function titrationExample(scale = 1) {
  const { files, workspaceHints } = generateExample('titration-voltage', { scale });
  const loaded = loadSamples(files, 'titration');
  const ws = addGates(loaded.ws, workspaceHints.suggestedGates).ws;
  const lymphocytes = ws.gates.find((g) => g.name === 'Lymphocytes').id;
  return { ws, views: loaded.views, files, lymphocytes };
}

const rsd = (sorted) => (quantileSorted(sorted, 0.8413) - quantileSorted(sorted, 0.1587)) / 2;

// The true stain index of a sample within the gate: CD4 T cells against CD4-negative lymphocytes.
export function trueStainIndex(example, sample) {
  const view = example.views.get(sample.id);
  const file = example.files.find((f) => f.name === sample.fileName || f.name.replace(/\.fcs$/i, '') === sample.name);
  const { labels, names } = file.meta.truth;
  const column = view.column(TITRATION.detector);
  const pos = [];
  const neg = [];
  for (const e of population(view, example.ws, example.lymphocytes)) {
    const name = names[labels[e]];
    if (name === 'CD4 T') pos.push(column[e]);
    else if (NEGATIVE.has(name)) neg.push(column[e]);
  }
  const p = Float64Array.from(pos).sort();
  const n = Float64Array.from(neg).sort();
  return (quantileSorted(p, 0.5) - quantileSorted(n, 0.5)) / (2 * rsd(n));
}

export function runTitration(example) {
  const series = titrationSeries(example.ws.samples);
  const items = series.steps.map(({ sample, amount }) => ({ sample, view: example.views.get(sample.id), label: amount.label, amount }));
  const steps = stepsFrom(example.ws, items, { channel: TITRATION.detector, populationId: example.lymphocytes });
  return { series, analysis: analyzeTitration(steps), truth: series.steps.map(({ sample }) => trueStainIndex(example, sample)), population: gatePath(example.ws, example.lymphocytes) };
}

export function runWalk(example, options = {}) {
  const walkSamples = example.ws.samples.filter((s) => /Voltage walk/.test(s.name));
  const series = voltageSeries(walkSamples, example.views, TITRATION.detector);
  const items = series.map(({ sample, voltage }) => ({ sample, view: example.views.get(sample.id), label: `${voltage} V`, voltage }));
  const steps = stepsFrom(example.ws, items, { channel: TITRATION.detector, populationId: example.lymphocytes });
  return { series, analysis: analyzeVoltageWalk(steps, options) };
}

// The true voltage limits: bisection on simulated samples of 200,000 cells of the walk's stain,
// with true labels (lymphocytes only, no debris or doublets).
export function trueVoltageLimits() {
  const instrument = INSTRUMENTS.fortessa;
  const panel = buildPanel(instrument, PANEL);
  const { specs, weights, options } = titrationPopulations(TITRATION.walkAmount);
  const lymphoid = [0, 1, 2, 3];
  const populations = compilePopulations(lymphoid.map((i) => specs[i]), panel.markers, options);
  const sigma = getDetector(instrument, TITRATION.detector).sigma;
  const pe = panel.detectors.findIndex((d) => d.name === TITRATION.detector);
  const measure = (voltage) => {
    const sim = simulateEvents({ count: 200000, instrument, panel, populations, weights: lymphoid.map((i) => weights[i]), mix: {}, rate: 1500, detectorGains: walkGains(voltage, instrument) }, createRandom(97));
    const column = sim.columns[panel.detectors[pe].name];
    const pos = [];
    const neg = [];
    for (let e = 0; e < column.length; e += 1) {
      if (sim.labelNames[sim.labels[e]] === 'CD4 T') pos.push(column[e]);
      else neg.push(column[e]);
    }
    return { negRSD: rsd(Float64Array.from(neg).sort()), posP99: quantileSorted(Float64Array.from(pos).sort(), 0.99) };
  };
  const bisect = (f, lo, hi) => {
    for (let i = 0; i < 14; i += 1) {
      const mid = (lo + hi) / 2;
      if (f(mid)) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  return {
    rsdEN: sigma,
    minimum: bisect((v) => measure(v).negRSD >= 2.5 * sigma, 300, 750),
    maximum: bisect((v) => measure(v).posP99 >= 0.9 * instrument.range, 300, 750),
  };
}
