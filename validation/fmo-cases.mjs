// Virtual FMOs (C4) against real FMO controls: two simulated panels whose FMO tubes are the same
// donor's cells, and two public data sets with FMO controls, a BD LSRFortessa panel (Zenodo
// 22808501) and a 25-color Cytek Aurora panel (Zenodo 20644656). Each case gives the workspace,
// views prepared as the window prepares them, the spread record fitted to the controls, and the
// FMO controls with the channel each omits.
import { readFileSync, readdirSync } from 'node:fs';
import { compensate, computeSpillover, spilloverSpreading } from '../web/lib/compensation.js';
import { workspaceView } from '../web/lib/engine.js';
import { generateExample } from '../web/lib/examples.js';
import { parseFCS, readSpillover } from '../web/lib/fcs.js';
import { autoGateControl, extractAutofluorescence, isSpectralDetector, referenceSpectrum, spectralSpreading, unmixOLS, unmixWithAutofluorescence } from '../web/lib/spectral.js';
import { unmixedChannel } from '../web/lib/spectral-ui.js';
import { fitNoise, noiseRecord, spreadModel, spreadRecord } from '../web/lib/spread.js';
import { createTransform } from '../web/lib/transforms.js';
import { addGates, createWorkspace, sampleFromDataset } from '../web/lib/workspace.js';

const columnsOf = (d) => Object.fromEntries(d.parameters.map((p, i) => [p.name, d.data[i]]));
export const quantile = (values, p) => {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(p * (sorted.length - 1))];
};
const linear = (max) => ({ type: 'linear', min: 0, max });

// Distance on a channel's display scale (logicle, as the instrument's data are shown), in % of
// the axis: how far apart two thresholds look where a gate is drawn.
export function axisDistance(range) {
  const forward = createTransform({ type: 'logicle', T: range, W: 0.5, M: 4.5, A: 0 }).forward;
  return (a, b) => 100 * (forward(a) - forward(b));
}

// A compensation's spread record from its spillover matrix and the spreading of its controls.
function compensationRecord(detectors, matrix, observations) {
  const n = detectors.length;
  const rows = Array.from({ length: n }, (_, i) => Array.from(matrix.slice(i * n, i * n + n)));
  const model = spreadModel({ names: detectors, detectors, spectra: rows });
  return spreadRecord({ names: detectors, detectors, spectra: rows, channels: detectors, noise: noiseRecord(model, fitNoise(model, observations)) });
}

// --- Simulated ---------------------------------------------------------------------------------

export const SIMULATED_CONVENTIONAL = ['CD25', 'CD127', 'CD45RA', 'CD16', 'CCR7', 'HLA-DR', 'CD56'];

// The PBMC example (a BD LSRFortessa-like panel) with FMO tubes of donor D01's cells: compensation
// computed from the single-stain controls, the spread fitted to them, the suggested gates.
export function simulatedConventional(scale = 0.5) {
  const r = generateExample('pbmc-immunophenotyping', { scale, fmos: SIMULATED_CONVENTIONAL });
  const datasets = new Map(r.files.map((f) => [f.name, parseFCS(f.bytes).datasets[0]]));
  const meta = r.workspaceHints.sampleMeta;
  const detectors = r.workspaceHints.compensation.controls.map((c) => c.channel);
  const pick = (d) => Object.fromEntries(detectors.map((n) => [n, columnsOf(d)[n]]));
  const controls = r.workspaceHints.compensation.controls.map((c) => ({ channel: c.channel, columns: pick(datasets.get(c.file)) }));
  const spill = computeSpillover(controls, detectors, { method: 'median', unstained: { columns: pick(datasets.get('Unstained.fcs')) }, range: 262144 });
  const spreading = spilloverSpreading(controls.map((c) => ({ channel: c.channel, raw: c.columns, columns: compensate(c.columns, { channels: detectors, matrix: spill.matrix }) })), detectors, { range: 262144 });
  const record = compensationRecord(detectors, spill.matrix, spreading.observations);
  let ws = createWorkspace('Simulated FMOs (conventional)');
  ws = {
    ...ws,
    compensations: [{ id: 'comp', name: 'From the controls', channels: detectors, matrix: Array.from(spill.matrix), spread: record }],
    samples: r.files.map((f) => ({ ...sampleFromDataset(datasets.get(f.name), { name: f.name }), id: f.name, role: meta[f.name].role ?? 'sample', stain: meta[f.name].stain ?? null, compensationId: 'comp' })),
  };
  ws = addGates(ws, r.workspaceHints.suggestedGates.map((g) => ({ ...g, overrides: {} }))).ws;
  const view = (id) => workspaceView(ws, ws.samples.find((s) => s.id === id), datasets.get(id));
  const marker = (m) => detectors.find((d) => ws.samples[0].channels.find((c) => c.name === d)?.marker === m);
  return {
    name: 'simulated LSRFortessa-like panel', ws, record, range: 262144, view,
    stained: 'D01_Unstim.fcs', unstained: 'Unstained.fcs',
    populations: [['Lymphocytes', ws.gates.find((g) => g.name === 'Lymphocytes').id], ['T cells', ws.gates.find((g) => g.name === 'T cells').id]],
    fmos: SIMULATED_CONVENTIONAL.map((m) => ({ marker: m, file: `FMO_${m}.fcs`, channel: marker(m) })),
  };
}

export const SIMULATED_SPECTRAL = ['CD25', 'CD4', 'CD8', 'CD27', 'CD38', 'HLA-DR', 'CD28', 'CCR7'];

// The spectral example (a Cytek Aurora-like instrument with laser fluctuations) with FMO tubes of
// donor S1's cells, unmixed by OLS with the controls' spectra, and a lymphocyte scatter gate.
export function simulatedSpectral(scale = 0.5) {
  const laserCV = { UV: 0.03, V: 0.02, B: 0.015, YG: 0.025, R: 0.02 };
  const r = generateExample('spectral-25color', { scale, laserCV, fmos: SIMULATED_SPECTRAL });
  const detectors = r.workspaceHints.spectral.detectors;
  const meta = r.workspaceHints.sampleMeta;
  const datasets = new Map(r.files.map((f) => [f.name, parseFCS(f.bytes).datasets[0]]));
  const controls = r.files.filter((f) => meta[f.name].role === 'single-stain').map((f) => {
    const cols = columnsOf(datasets.get(f.name));
    const gate = autoGateControl(cols, detectors, { range: 4194304 });
    return { name: meta[f.name].stain, marker: meta[f.name].marker, cols, gate, spectrum: referenceSpectrum(cols, detectors, gate.positive, gate.negative, {}).spectrum };
  });
  return spectralCase({
    name: 'simulated Aurora-like panel', controls, detectors, datasets, range: 4194304,
    files: Object.fromEntries(r.files.map((f) => [f.name, f.name])),
    stained: 'Donor_S1.fcs', unstained: 'Unstained.fcs',
    fmos: SIMULATED_SPECTRAL.map((m) => ({ marker: m, file: `FMO_${m}.fcs`, dye: controls.find((c) => c.marker === m).name })),
    scatterFrom: 'Donor_S1.fcs',
  });
}

// A spectral case: references, spreading and noise from the controls, every tube unmixed (OLS, or
// with autofluorescence signatures from the unstained cells), a scatter gate (and a live gate).
function spectralCase({ name, controls, detectors, datasets, range, files, stained, unstained, fmos, scatterFrom, autofluorescence = false, live = null }) {
  const spectra = controls.map((c) => ({ name: c.name, spectrum: c.spectrum, detectors }));
  const unmixedControls = controls.map((c, i) => ({ fluorochrome: i, abundances: unmixOLS(c.cols, spectra, { residuals: false }), positive: c.gate.positive, negative: c.gate.negative }));
  const spreading = spectralSpreading(unmixedControls, controls.map((c) => c.name));
  const model = spreadModel({ names: controls.map((c) => c.name), detectors, spectra: controls.map((c) => c.spectrum) });
  const record = spreadRecord({ names: controls.map((c) => c.name), detectors, spectra: controls.map((c) => Array.from(c.spectrum)), channels: controls.map((c) => unmixedChannel(c.name)), noise: noiseRecord(model, fitNoise(model, spreading.observations)) });
  const afs = autofluorescence ? extractAutofluorescence(columnsOf(datasets.get(unstained)), detectors, {}).signatures : null;
  let ws = createWorkspace(`Virtual FMOs (${name})`);
  ws = { ...ws, samples: Object.keys(files).map((id) => ({ ...sampleFromDataset(datasets.get(id), { name: files[id] }), id })) };
  const sc = columnsOf(datasets.get(scatterFrom));
  const max = quantile(sc['FSC-A'], 0.999) * 1.2;
  const ssMax = quantile(sc['SSC-A'], 0.999) * 1.2;
  ws = addGates(ws, [{ id: 'cells', name: 'Cells', type: 'rectangle', parentId: null, dims: [{ channel: 'FSC-A', transform: linear(max) }, { channel: 'SSC-A', transform: linear(ssMax) }], geometry: { min: [quantile(sc['FSC-A'], 0.2) / max, quantile(sc['SSC-A'], 0.01) / ssMax], max: [null, quantile(sc['SSC-A'], 0.9) / ssMax] }, overrides: {} }]).ws;
  const views = new Map();
  const view = (id) => {
    if (!views.has(id)) {
      const out = afs ? unmixWithAutofluorescence(columnsOf(datasets.get(id)), spectra, afs, { detectors }) : unmixOLS(columnsOf(datasets.get(id)), spectra, { residuals: false });
      const abundances = Array.isArray(out) ? out : out.abundances;
      views.set(id, workspaceView(ws, ws.samples.find((s) => s.id === id), datasets.get(id), controls.map((c, i) => ({ name: unmixedChannel(c.name), column: abundances[i], version: `u${i}` }))));
    }
    return views.get(id);
  };
  const populations = [['Cells', 'cells']];
  if (live) {
    const channel = unmixedChannel(live);
    const limit = quantile(view(unstained).column(channel), 0.995);
    const t = { type: 'linear', min: -1e7, max: 1e7 };
    ws = addGates(ws, [{ id: 'live', name: 'Live', type: 'range', parentId: 'cells', dims: [{ channel, transform: t }], geometry: { min: null, max: createTransform(t).forward(limit) }, overrides: {} }]).ws;
    views.clear();
    populations.push(['Live cells', 'live']);
  }
  return { name, ws, record, range, view, stained, unstained, populations, fmos: fmos.map((f) => ({ ...f, channel: unmixedChannel(f.dye) })) };
}

// --- Public data -------------------------------------------------------------------------------

// The LSRFortessa panel: FACSDiva's matrix from the files, the spread fitted to the 15 bead
// controls (bead singlets, as the fortessa suite gates them), and the FMO tubes. The record does
// not say which dye each tube omits: a tube omits a channel when its 99.5th percentile there is
// under 15% of the median over the tubes while every other channel stays above 25% of it; the
// other tubes (two dyes dim at once, or none clearly) are reported and left out.
export function skull(data, fmoData) {
  const read = (set, f) => parseFCS(set.read(f)).datasets[0];
  const full = read(data, 'Skull BM Broad_Tube_017.fcs');
  const spill = readSpillover(full.keywords, full.parameters);
  const detectors = spill.channels;
  const controls = data.files.filter((f) => f.startsWith('Compensation Controls_')).map((f) => {
    const d = read(data, f);
    const [laser, filter] = f.replace('Compensation Controls_', '').split(' ');
    const [wavelength, , width] = filter.split(',');
    const c = columnsOf(d);
    const center = (values) => [quantile(values, 0.5), (quantile(values, 0.75) - quantile(values, 0.25)) / 1.349];
    const [fm, fs] = center(c['FSC-A']);
    const [sm, ss] = center(c['SSC-A']);
    const keep = [];
    for (let e = 0; e < d.eventCount; e += 1) if (Math.abs(c['FSC-A'][e] - fm) < 4 * fs && Math.abs(c['SSC-A'][e] - sm) < 4 * ss) keep.push(e);
    const raw = Object.fromEntries(detectors.map((n) => [n, Float32Array.from(keep, (e) => c[n][e])]));
    return { channel: detectors.find((x) => x.startsWith(`${laser} ${wavelength}/${width}`)), raw, columns: compensate(raw, spill) };
  });
  const record = compensationRecord(detectors, spill.matrix, spilloverSpreading(controls, detectors, { range: 262144 }).observations);
  const tubes = fmoData.files.filter((f) => /Tube_\d+\.fcs$/.test(f)).sort();
  const datasets = new Map([['unstained', read(fmoData, 'FMO broad panel_Unstained.fcs')], ...tubes.map((f) => [f, read(fmoData, f)])]);
  let ws = createWorkspace('Virtual FMOs (LSRFortessa)');
  ws = { ...ws, compensations: [{ id: 'comp', name: 'FACSDiva', channels: detectors, matrix: Array.from(spill.matrix), spread: record }], samples: [...datasets.keys()].map((id) => ({ ...sampleFromDataset(datasets.get(id), { name: id }), id, compensationId: 'comp' })) };
  const cut = quantile(columnsOf(full)['FSC-A'], 0.15);
  ws = addGates(ws, [{ id: 'cells', name: 'Cells', type: 'rectangle', parentId: null, dims: [{ channel: 'FSC-A', transform: linear(262144) }, { channel: 'SSC-A', transform: linear(262144) }], geometry: { min: [cut / 262144, null], max: [null, null] }, overrides: {} }]).ws;
  const views = new Map();
  const view = (id) => {
    if (!views.has(id)) views.set(id, workspaceView(ws, ws.samples.find((s) => s.id === id), datasets.get(id)));
    return views.get(id);
  };
  const marker = Object.fromEntries(full.parameters.map((p) => [p.name, p.label || p.marker || '']));
  const p995 = Object.fromEntries(tubes.map((f) => [f, Object.fromEntries(detectors.map((d) => [d, quantile(view(f).column(d), 0.995)]))]));
  const median = Object.fromEntries(detectors.map((d) => [d, quantile(tubes.map((f) => p995[f][d]), 0.5)]));
  const fmos = [];
  const excluded = [];
  for (const f of tubes) {
    const ratios = detectors.map((d) => [d, p995[f][d] / median[d]]).sort((a, b) => a[1] - b[1]);
    if (ratios[0][1] < 0.15 && ratios[1][1] > 0.25) fmos.push({ marker: marker[ratios[0][0]], file: f, channel: ratios[0][0] });
    else excluded.push(`${f.replace('FMO broad panel_', '').replace('.fcs', '')} (${ratios.slice(0, 2).map(([d, r]) => `${marker[d]} ${r.toFixed(2)}`).join(', ')})`);
  }
  return { name: 'BD LSRFortessa (Zenodo 22808501)', ws, record, range: 262144, view, unstained: 'unstained', populations: [['Cells', 'cells']], fmos, excluded, self: true };
}

// The Aurora panel: reference spectra from the 25 bead controls and the viability dye's cell
// control, unmixed with autofluorescence signatures from the unstained cells, live cells gated.
// An FMO tube is used when its named dye is absent: its 99.5th percentile under 10% of the full
// stain's (the CD4 and CX3CR1 tubes hold their dyes and are left out).
export function omip(data) {
  const read = (f) => parseFCS(data.read(f)).datasets[0];
  const mix = read('OMIP-TDLN 4-Mix.fcs');
  const detectors = mix.parameters.map((p) => p.name).filter((n) => isSpectralDetector(n));
  const refs = data.files.filter((f) => f.startsWith('reference/') && /\((Beads|Cells)\)\.fcs$/.test(f) && !/Negative|Unstained/.test(f));
  const controls = refs.map((f) => {
    const cols = columnsOf(read(f));
    // Positive events off scale in any detector are left out, as the app does.
    const gate = autoGateControl(cols, detectors, { range: 4194304 });
    return { name: f.replace('reference/OMIP-Reference Group-', '').replace(/ \((Beads|Cells)\)\.fcs$/, ''), cols, gate, spectrum: referenceSpectrum(cols, detectors, gate.positive, gate.negative, {}).spectrum };
  });
  const named = { CD4: 'CD4 BUV805', CD8: 'CD8 BV480', CD11b: 'CD11b PerCP-Cy5.5', Ly6C: 'Ly6C PE-CF594', MHCII: 'MHCII Pacific Blue', CX3CR1: 'CX3CR1 APC-Fire 750' };
  const files = { mix: 'OMIP-TDLN 4-Mix.fcs', unstained: 'reference/OMIP-Reference Group-Unstained (Cells).fcs', ...Object.fromEntries(Object.keys(named).map((m) => [m, `OMIP-TDLN pool-FMO ${m}.fcs`])) };
  const datasets = new Map(Object.entries(files).map(([id, f]) => [id, read(f)]));
  const c = spectralCase({ name: 'Cytek Aurora (Zenodo 20644656)', controls, detectors, datasets, range: 4194304, files, stained: 'mix', unstained: 'unstained', fmos: Object.entries(named).map(([m, dye]) => ({ marker: m, file: m, dye })), scatterFrom: 'mix', autofluorescence: true, live: controls.find((x) => /FVS440UV/.test(x.name)).name });
  const mixView = c.view('mix');
  const fmos = [];
  const excluded = [];
  for (const f of c.fmos) {
    const ratio = quantile(c.view(f.file).column(f.channel), 0.995) / Math.max(quantile(mixView.column(f.channel), 0.995), 1);
    if (ratio < 0.1) fmos.push(f);
    else excluded.push(`${f.marker} (its tube holds ${f.dye}: ${(100 * ratio).toFixed(0)}% of the full stain's 99.5th percentile)`);
  }
  return { ...c, populations: [['Live cells', 'live']], fmos, excluded, self: true };
}
