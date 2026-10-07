// The panel optimizer (S9) against simulated panels: every assignment of dyes to markers can be
// stained in the simulator (simulate.js, the same physics the spread model was validated on),
// unmixed or compensated as the panel would be, and each marker's resolution measured on cells
// that carry its co-expressed markers. So the best assignment is known by measurement, not by the
// optimizer's model, and the model's ranking of assignments can be checked against it. The
// public 25-color Aurora panel (Zenodo 20644656) checks the spread a design predicts against a
// run's controls on a real instrument.
import { compensate } from '../web/lib/compensation.js';
import { dyeInfo } from '../web/lib/dyes.js';
import { backgroundCovariance } from '../web/lib/panel-optimizer.js';
import { createRandom } from '../web/lib/random.js';
import { FLUOROCHROMES, INSTRUMENTS, buildPanel, compilePopulations, simulateEvents, spectralSignature, spilloverMatrix } from '../web/lib/simulate.js';
import { parseFCS } from '../web/lib/fcs.js';
import { autoGateControl, isSpectralDetector, referenceSpectrum, spectralSpreading, unmixOLS } from '../web/lib/spectral.js';

// The detector each dye is read in on the simulated LSRFortessa.
export const FORTESSA_DETECTOR = {
  BUV395: 'BUV395-A', BUV496: 'BUV496-A', BUV737: 'BUV737-A', BV421: 'BV421-A', Aqua: 'BV510-A', BV605: 'BV605-A', BV650: 'BV650-A', BV711: 'BV711-A', BV786: 'BV786-A',
  FITC: 'FITC-A', 'PerCP-Cy5.5': 'PerCP-Cy5-5-A', PE: 'PE-A', 'PE-CF594': 'PE-CF594-A', 'PE-Cy5': 'PE-Cy5-A', 'PE-Cy7': 'PE-Cy7-A', APC: 'APC-A', 'Alexa Fluor 700': 'Alexa Fluor 700-A', 'APC-Cy7': 'APC-Cy7-A',
};

export const LASER_CV = { UV: 0.03, V: 0.02, B: 0.015, YG: 0.025, R: 0.02 };

const LYMPH = { fsc: [55000, 0.1], ssc: [11000, 0.2], af: 1 };

// An 8-marker T-cell panel: four bright lineage markers and four activation and memory markers,
// three of them dim, on CD4 and CD8 T cells; ten candidate dyes on each instrument.
export const T_PANEL = {
  markers: [['CD3', 'high'], ['CD4', 'high'], ['CD8', 'high'], ['CD45RA', 'high'], ['CCR7', 'low'], ['CD25', 'low'], ['CD127', 'medium'], ['PD-1', 'low']].map(([name, level]) => ({ name, level })),
  groups: [{ name: 'CD4 T', markers: ['CD3', 'CD4', 'CD45RA', 'CCR7', 'CD25', 'CD127', 'PD-1'] }, { name: 'CD8 T', markers: ['CD3', 'CD8', 'CD45RA', 'CCR7', 'CD127', 'PD-1'] }],
  spectral: ['BUV395', 'BUV737', 'BV421', 'BV605', 'BV711', 'FITC', 'PE', 'PE-Cy7', 'APC', 'APC-Cy7'],
  conventional: ['BUV395', 'BV421', 'BV605', 'BV711', 'FITC', 'PE', 'PE-CF594', 'PE-Cy7', 'APC', 'Alexa Fluor 700'],
};

// The 25 markers of the spectral example (examples.js) with their expression on PBMC and four
// groups of co-expressed markers, for a 25-color design.
export const PBMC_25 = {
  markers: Object.entries({
    CD45RA: 'high', CD16: 'high', CD123: 'medium', CD161: 'low', CD38: 'medium', CD56: 'medium', CD8: 'high', CCR7: 'low', CD19: 'medium', Viability: 'high', CD57: 'medium', CD27: 'medium', 'HLA-DR': 'high',
    CD95: 'medium', 'PD-1': 'low', CD14: 'high', TCRgd: 'medium', CD127: 'medium', CD25: 'low', CD28: 'medium', CD11c: 'medium', CD45: 'high', CD11b: 'high', CD3: 'high', CD4: 'high',
  }).map(([name, level]) => ({ name, level })),
  groups: [
    { name: 'T cells', markers: ['CD3', 'CD4', 'CD8', 'TCRgd', 'CD45RA', 'CCR7', 'CD27', 'CD28', 'CD95', 'PD-1', 'CD127', 'CD25', 'CD57', 'CD38', 'HLA-DR', 'CD161', 'CD45', 'Viability'] },
    { name: 'NK cells', markers: ['CD45', 'CD56', 'CD16', 'CD57', 'CD161', 'CD38', 'CD11b', 'CD45RA', 'Viability'] },
    { name: 'B cells', markers: ['CD45', 'CD19', 'HLA-DR', 'CD27', 'CD38', 'CD45RA', 'CD95', 'Viability'] },
    { name: 'Myeloid cells', markers: ['CD45', 'CD14', 'CD16', 'CD11c', 'CD11b', 'HLA-DR', 'CD123', 'CD38', 'Viability'] },
  ],
};

// The optimizer's inputs for a simulated instrument: the candidate dyes' spectra (peak-normalized
// over every detector, or for a conventional instrument the spillover rows on the candidates'
// own detectors), the true noise (photon noise k per detector, the lasers' CVs) and the unstained
// control's background (its detector covariance, from simulated lymphocytes without any stain).
export function instrumentInputs({ conventional = false, dyes, seed = 7 }) {
  const instrument = conventional ? INSTRUMENTS.fortessa : INSTRUMENTS.aurora;
  const detectorNames = conventional ? dyes.map((d) => FORTESSA_DETECTOR[d]) : instrument.detectors.map((d) => d.name);
  const detectors = detectorNames.map((n) => instrument.detectors.find((d) => d.name === n));
  const spectra = conventional
    ? Array.from(spilloverMatrix(dyes, detectors).matrix).reduce((rows, v, k) => {
      if (k % dyes.length === 0) rows.push([]);
      rows[rows.length - 1].push(v);
      return rows;
    }, [])
    : dyes.map((d) => Array.from(spectralSignature(d, instrument.detectors)));
  const lasers = [...new Set(detectors.map((d) => d.laser))];
  const noise = { detectors: detectorNames, c1: detectors.map((d) => d.k), lasers, laserCV: lasers.map((l) => LASER_CV[l]) };
  // An unstained control: lymphocytes with autofluorescence and nothing else.
  const panel = buildPanel(instrument, [], detectorNames);
  const populations = compilePopulations([{ name: 'Unstained', ...LYMPH, markers: {} }], [], {});
  const sim = simulateEvents({ count: 10000, instrument, panel, populations, weights: Float64Array.of(1), mix: {}, viability: null, rate: 5000, scatterWidth: false, laserCV: LASER_CV }, createRandom(seed));
  const background = backgroundCovariance(detectorNames.map((n) => sim.columns[n]));
  return {
    instrument,
    detectors: detectorNames,
    dyes: dyes.map((name, k) => ({ name, spectrum: spectra[k], detector: conventional ? detectorNames[k] : undefined, brightness: FLUOROCHROMES[name].brightness })),
    noise,
    background,
    signalScale: instrument.fluorScale,
    square: conventional,
  };
}

const median = (values) => {
  const s = Float64Array.from(values).sort();
  return s[Math.floor(s.length / 2)];
};
const robustSD = (values) => {
  const s = Float64Array.from(values).sort();
  return (s[Math.floor(0.8413 * (s.length - 1))] - s[Math.floor(0.1587 * (s.length - 1))]) / 2;
};

// Stains the panel with an assignment ({ marker: dye }) in the simulator and measures each
// marker's resolution: for every co-expression group holding it, cells with all of the group's
// markers (positive) and cells with all but this one (negative), unmixed (OLS with the true
// spectra) or compensated (the true spillover of the dyes used). Returns { cost (Σ w σ²/ΔF² over
// each marker's worst group, the optimizer's measure), markers: [{ marker, dye, signal, sd,
// stainIndex, group }] }.
export function measureAssignment({ markers, groups, assignment, conventional = false, events = 3000, seed = 11, logSD = 0.2 }) {
  const instrument = conventional ? INSTRUMENTS.fortessa : INSTRUMENTS.aurora;
  const names = markers.map((m) => m.name);
  const level = Object.fromEntries(markers.map((m) => [m.name, m.value]));
  const weight = Object.fromEntries(markers.map((m) => [m.name, m.weight ?? 1]));
  const spec = names.map((marker) => ({ marker, fluor: assignment[marker], detector: conventional ? FORTESSA_DETECTOR[assignment[marker]] : null }));
  const detectorNames = conventional ? spec.map((a) => a.detector) : instrument.detectors.map((d) => d.name);
  const panel = buildPanel(instrument, spec, detectorNames);
  const specs = [];
  for (const g of groups) {
    specs.push({ name: `${g.name}|all`, ...LYMPH, markers: Object.fromEntries(g.markers.map((m) => [m, [level[m], logSD]])) });
    for (const b of g.markers) specs.push({ name: `${g.name}|-${b}`, ...LYMPH, markers: Object.fromEntries(g.markers.filter((m) => m !== b).map((m) => [m, [level[m], logSD]])) });
  }
  const populations = compilePopulations(specs, names, { background: [0, 0] });
  const sim = simulateEvents({ count: events * specs.length, instrument, panel, populations, weights: new Float64Array(specs.length).fill(1), mix: {}, viability: null, rate: 5000, scatterWidth: false, laserCV: LASER_CV }, createRandom(seed));
  const raw = detectorNames.map((n) => sim.columns[n]);
  let channel;
  if (conventional) {
    const spill = spilloverMatrix(spec.map((a) => a.fluor), panel.detectors);
    const comp = compensate(Object.fromEntries(detectorNames.map((n, k) => [n, raw[k]])), { channels: detectorNames, matrix: spill.matrix });
    channel = (m) => comp[detectorNames[m]];
  } else {
    const spectra = spec.map((a) => ({ name: a.fluor, spectrum: spectralSignature(a.fluor, instrument.detectors) }));
    const unmixed = unmixOLS(raw, spectra, { residuals: false });
    channel = (m) => unmixed.abundances[m];
  }
  const byPopulation = new Map(specs.map((s) => [s.name, []]));
  sim.labels.forEach((label, e) => {
    const name = sim.labelNames[label];
    if (byPopulation.has(name)) byPopulation.get(name).push(e);
  });
  let cost = 0;
  const rows = names.map((marker, m) => {
    const values = channel(m);
    let worst = null;
    for (const g of groups) {
      if (!g.markers.includes(marker)) continue;
      const pos = byPopulation.get(`${g.name}|all`).map((e) => values[e]);
      const neg = byPopulation.get(`${g.name}|-${marker}`).map((e) => values[e]);
      const signal = median(pos) - median(neg);
      const sd = robustSD(neg);
      const ratio = (sd * sd) / (signal * signal);
      if (!worst || ratio > worst.ratio) worst = { ratio, signal, sd, group: g.name };
    }
    cost += weight[marker] * worst.ratio;
    return { marker, dye: assignment[marker], signal: worst.signal, sd: worst.sd, stainIndex: worst.signal / (2 * worst.sd), group: worst.group };
  });
  return { cost, markers: rows };
}

// A run of a designed panel's single-stain controls (beads-like: a bright and a negative
// population of each dye, with the instrument's photon noise and laser fluctuations), unmixed
// with the panel's own spectra (OLS), and its spreading matrix (spectral.js spectralSpreading),
// as the run gives it for comparison with the design. dyes: names.
export function simulatedControls(dyes, { events = 4000, seed = 13, signal = 1.2e6 } = {}) {
  const instrument = INSTRUMENTS.aurora;
  const panel = buildPanel(instrument, dyes.map((fluor) => ({ marker: fluor, fluor, detector: null })), instrument.detectors.map((d) => d.name));
  const spectra = dyes.map((name) => ({ name, spectrum: spectralSignature(name, instrument.detectors) }));
  const controls = dyes.map((dye, i) => {
    const amount = signal / (FLUOROCHROMES[dye].brightness * instrument.fluorScale);
    const specs = [{ name: 'positive', fsc: [60000, 0.05], ssc: [12000, 0.05], af: 0.1, markers: { [dye]: [amount, 0.08] } }, { name: 'negative', fsc: [60000, 0.05], ssc: [12000, 0.05], af: 0.1, markers: {} }];
    const populations = compilePopulations(specs, dyes, { background: [0, 0] });
    const sim = simulateEvents({ count: events, instrument, panel, populations, weights: Float64Array.of(1, 1), mix: {}, viability: null, rate: 3000, scatterWidth: false, laserCV: LASER_CV }, createRandom(seed + i));
    const unmixed = unmixOLS(instrument.detectors.map((d) => sim.columns[d.name]), spectra, { residuals: false });
    const positive = [];
    const negative = [];
    sim.labels.forEach((label, e) => (sim.labelNames[label] === 'positive' ? positive : negative).push(e));
    return { fluorochrome: i, abundances: unmixed.abundances, positive: Int32Array.from(positive), negative: Int32Array.from(negative) };
  });
  return spectralSpreading(controls, dyes);
}

// The 25 bead reference controls of the OMIP Aurora panel (Zenodo 20644656): each control's
// events, gate and reference spectrum, named by its dye.
export function omipControls(data) {
  const read = (f) => parseFCS(data.read(f)).datasets[0];
  const files = data.files.filter((f) => f.startsWith('reference/') && /\(Beads\)\.fcs$/.test(f) && !/Negative/.test(f));
  const first = read(files[0]);
  const detectors = first.parameters.map((p) => p.name).filter((n) => isSpectralDetector(n));
  const controls = files.map((f) => {
    const d = read(f);
    const cols = detectors.map((n) => d.data[d.parameters.findIndex((p) => p.name === n)]);
    const range = Math.max(...d.parameters.filter((p) => detectors.includes(p.name)).map((p) => p.range));
    const gate = autoGateControl(cols, detectors, { range });
    const label = f.replace('reference/OMIP-Reference Group-', '').replace(/ \(Beads\)\.fcs$/, '');
    const name = dyeInfo(label)?.name ?? label.split(' ').pop();
    return { name, marker: label.slice(0, label.length - name.length).trim(), cols, gate, spectrum: referenceSpectrum(cols, detectors, gate.positive, gate.negative, {}).spectrum };
  });
  return { detectors, controls };
}
