// Formula channels, calibrated units and absolute counts (wave 6, slice 2): simulated beads from a
// detector of known response, simulated tubes with counting beads at known concentrations, and the
// FlowCal comparison's inputs (reference/flowcal.json; data set flowcal-mef).

import { SampleView } from '../web/lib/engine.js';
import { createRandom } from '../web/lib/random.js';
import { poisson } from '../web/lib/simulate.js';
import { addGates, createWorkspace } from '../web/lib/workspace.js';

// An 8-level bead sample and cells on a detector whose response is known: a level of v MEF (with
// the beads' own fluorescence `auto`) reads x = ((v + auto)/e^b)^(1/m), with a 3% intensity CV,
// electronic noise of SD 5, and values clipped at the top of a 14-bit range (16,383), where the
// brightest level saturates. Cells of known MEF read ((MEF)/e^b)^(1/m) (their own fluorescence is
// part of their MEF). Returns { beads: { FSC-A, SSC-A, FL1-A, FL2-A }, mef, truth, cells: [{ mef,
// values }], top }.
export const BEAD_TRUTH = { m: 1.05, b: 2.0, auto: 1500 };
export const BEAD_MEF = [0, 792, 2079, 6588, 16471, 47497, 137049, 271647];

export function simulatedBeads(seed = 21) {
  const random = createRandom(seed);
  const { m, b, auto } = BEAD_TRUTH;
  const top = 16383;
  const read = (v) => Math.min(top, ((v / Math.exp(b)) ** (1 / m)) * 10 ** (0.0128 * random.gaussian()) + 5 * random.gaussian());
  const n = 8 * 1500;
  const columns = { 'FSC-A': new Float32Array(n), 'SSC-A': new Float32Array(n), 'FL1-A': new Float32Array(n), 'FL2-A': new Float32Array(n) };
  for (let e = 0; e < n; e += 1) {
    const level = e % 8;
    columns['FSC-A'][e] = 40000 + 1500 * random.gaussian();
    columns['SSC-A'][e] = 12000 + 600 * random.gaussian();
    columns['FL1-A'][e] = read(BEAD_MEF[level] + auto);
    columns['FL2-A'][e] = read(2.5 * (BEAD_MEF[level] + auto));
  }
  // Three cell samples of 5,000 events, lognormal around a known MEF.
  const cells = [800, 12000, 90000].map((center) => {
    const truth = Float64Array.from({ length: 5000 }, () => center * 10 ** (0.15 * random.gaussian()));
    return { mef: center, truth, values: Float32Array.from(truth, (v) => Math.min(top, (v / Math.exp(b)) ** (1 / m))) };
  });
  return { beads: columns, mef: BEAD_MEF, cells, top };
}

// Tubes with counting beads: cells at a known concentration (cells/µL of the sample, before a
// dilution), 50 µL of the diluted sample with 50,000 beads, and 10% of the tube acquired. Cells and
// beads are counted as Poisson draws; beads are small on FSC and bright on FITC. Returns
// [{ name, dilution, truth (cells/µL), view, ws }] sharing one workspace with "Beads" and "Cells"
// gates.
export const COUNTING = { beads: 50000, volume: 50, acquired: 0.1 };

export function countingTubes(count = 40, seed = 31) {
  const random = createRandom(seed);
  let ws = createWorkspace('counting beads');
  const lin = { type: 'linear', min: 0, max: 262144 };
  ws = addGates(ws, [
    { id: 'beads', name: 'Beads', parentId: null, type: 'rectangle', dims: [{ channel: 'FSC-A', transform: lin }, { channel: 'FITC-A', transform: lin }], geometry: { min: [0, 0.4], max: [0.1, 1] } },
    { id: 'cells', name: 'Cells', parentId: null, type: 'rectangle', dims: [{ channel: 'FSC-A', transform: lin }, { channel: 'FITC-A', transform: lin }], geometry: { min: [0.15, null], max: [0.6, 0.2] } },
  ]).ws;
  const tubes = [];
  const samples = [];
  for (let k = 0; k < count; k += 1) {
    const truth = 200 * 1.1 ** k; // 200 to about 8,000 cells/µL
    const dilution = k % 3 === 0 ? 4 : 1;
    const cellEvents = poisson(random, (truth / dilution) * COUNTING.volume * COUNTING.acquired);
    const beadEvents = poisson(random, COUNTING.beads * COUNTING.acquired);
    const n = cellEvents + beadEvents;
    const fsc = new Float32Array(n);
    const fitc = new Float32Array(n);
    for (let e = 0; e < n; e += 1) {
      const bead = e < beadEvents;
      fsc[e] = bead ? 9000 + 1000 * random.gaussian() : 80000 + 12000 * random.gaussian();
      fitc[e] = bead ? 180000 + 8000 * random.gaussian() : 300 + 200 * random.gaussian();
    }
    const id = `t${k}`;
    const record = { id, name: `Tube ${k + 1}`, keywords: {}, technology: 'conventional', channels: [], meta: { dilution: String(dilution) } };
    const dataset = { eventCount: n, parameters: [{ index: 0, name: 'FSC-A', type: 'scatter', range: 262144 }, { index: 1, name: 'FITC-A', type: 'fluorescence', range: 262144 }], data: [fsc, fitc], keywords: {} };
    tubes.push({ name: record.name, dilution, truth, cellEvents, beadEvents, view: new SampleView(record, dataset) });
    samples.push(record);
  }
  ws = { ...ws, samples };
  return { ws, tubes };
}
