// Large-sample benchmark: times each stage of the pipeline on one sample of N events, the way the
// app runs it, and reports the memory each stage holds. The sample is the PBMC example's D01_Unstim
// (14 colors, with its suggested gates) repeated to N events with a little jitter: fine for
// timing, not for judging QC results.
//
//   node --expose-gc validation/bench.mjs [events, default 10000000] [--json]

import { generateExample } from '../web/lib/examples.js';
import { blobSource, parseFCS, parseFCSAsync, readSpillover, writeFCS } from '../web/lib/fcs.js';
import { SHA256 } from '../web/lib/sha256.js';
import { SampleView, describePopulation, populationSet, populationSummary } from '../web/lib/engine.js';
import { addGates, createWorkspace, updateGate } from '../web/lib/workspace.js';
import { bin2d } from '../web/lib/density.js';
import { createRandom } from '../web/lib/random.js';
import { peacoQC, peacoQCLayout } from '../web/lib/qc.js';
import { Worker } from 'node:worker_threads';

const args = process.argv.slice(2);
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 10_000_000);
const json = args.includes('--json');
const MB = 1024 ** 2;
const rows = [];

const gc = () => globalThis.gc?.();
const memory = () => { gc(); return process.memoryUsage().arrayBuffers; };
function time(stage, fn, note = '') {
  const before = memory();
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  const held = memory() - before;
  rows.push({ stage, ms, heldMB: held / MB, note: typeof note === 'function' ? note(result) : note });
  if (!json) console.log(`${stage.padEnd(52)} ${ms.toFixed(0).padStart(7)} ms ${(held / MB).toFixed(0).padStart(7)} MB  ${rows.at(-1).note}`);
  return result;
}

// The sample, repeated to N events.
const { files, workspaceHints } = generateExample('pbmc-immunophenotyping', { samples: ['D01_Unstim.fcs'] });
const source = parseFCS(files.find((f) => f.name === 'D01_Unstim.fcs').bytes).datasets[0];
const bytes = time(`write a ${(N / 1e6).toFixed(1)}M-event FCS file (${source.parameters.length} parameters)`, () => {
  const random = createRandom(7);
  const n0 = source.eventCount;
  const data = source.data.map((column, p) => {
    const out = new Float32Array(N);
    const time = source.parameters[p].type === 'time';
    for (let e = 0; e < N; e += 1) {
      const v = column[e % n0];
      out[e] = time ? v + Math.floor(e / n0) * column[n0 - 1] : v * (1 + 0.01 * (random() - 0.5));
    }
    return out;
  });
  return writeFCS({ parameters: source.parameters, data, keywords: source.keywords });
}, (b) => `${(b.byteLength / MB).toFixed(0)} MB file`);

const dataset = time('parse (file in memory)', () => parseFCS(bytes).datasets[0], (d) => `${d.eventCount} events`);
// As the app reads a dropped file: from a Blob in 16 MB parts, hashing it on the way (browser-only
// mode; with the desktop program, the program hashes it).
const blob = new Blob([bytes]);
{
  const before = memory();
  const t0 = performance.now();
  const hash = new SHA256();
  const streamed = await parseFCSAsync(blobSource(blob), { observe: (part) => hash.update(part) });
  const ms = performance.now() - t0;
  rows.push({ stage: 'parse from a Blob in parts, with SHA-256', ms, heldMB: (memory() - before) / MB, note: `${streamed.datasets[0].eventCount} events` });
  if (!json) console.log(`${'parse from a Blob in parts, with SHA-256'.padEnd(52)} ${ms.toFixed(0).padStart(7)} ms ${((memory() - before) / MB).toFixed(0).padStart(7)} MB  ${hash.hex().slice(0, 12)}…`);
  const t1 = performance.now();
  await parseFCSAsync(blobSource(blob));
  const ms2 = performance.now() - t1;
  rows.push({ stage: 'parse from a Blob in parts', ms: ms2, heldMB: 0, note: '' });
  if (!json) console.log(`${'parse from a Blob in parts'.padEnd(52)} ${ms2.toFixed(0).padStart(7)} ms`);
}
let ws = addGates(createWorkspace('bench'), workspaceHints.suggestedGates).ws;
const view = new SampleView({ id: 's', name: 'D01_Unstim.fcs', keywords: dataset.keywords, technology: 'conventional' }, dataset);
const spill = readSpillover(dataset.keywords, dataset.parameters);
time('compensate', () => view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) }), `${spill.channels.length} channels`);
time(`evaluate all ${ws.gates.length} gates (cold)`, () => populationSummary(view, ws), (s) => `largest ${Math.max(...Object.values(s).map((x) => x.count || 0))} events`);
const populationBytes = () => {
  let total = 0;
  return view.populationCache.bytes;
};
const scaledBytes = () => view.scaledCache.bytes;
rows.push({ stage: 'held: populations', ms: 0, heldMB: populationBytes() / MB, note: `${view.populationCache.size} cached` });
rows.push({ stage: 'held: scaled columns', ms: 0, heldMB: scaledBytes() / MB, note: `${view.scaledCache.size} cached` });
if (!json) console.log(`  populations ${(populationBytes() / MB).toFixed(0)} MB in ${view.populationCache.size}; scaled columns ${(scaledBytes() / MB).toFixed(0)} MB in ${view.scaledCache.size}`);

// Moving the first gate re-evaluates every population.
const top = ws.gates.find((g) => !g.parentId);
const moved = structuredClone(top.geometry);
const shift = (g) => { if (g.vertices) g.vertices = g.vertices.map(([x, y]) => [x + 0.002, y]); else if (g.min) g.min = g.min.map((v) => (v === null ? v : v + 0.002)); return g; };
ws = updateGate(ws, top.id, { geometry: shift(moved) });
time(`move the top gate (${top.name}): re-evaluate all`, () => populationSummary(view, ws));

// One plot per gate: its parent population on the gate's axes, binned on a 300 × 300 grid.
time(`bin ${ws.gates.length} plots (300 × 300)`, () => {
  for (const gate of ws.gates.filter((g) => g.dims?.length === 2)) {
    const parent = gate.parentId ? populationSet(view, ws, gate.parentId) : null;
    bin2d(view.scaled(gate.dims[0].channel, gate.dims[0].transform), view.scaled(gate.dims[1].channel, gate.dims[1].transform), parent, 300, 300);
  }
});
const allEvents = time('bin one plot of all events', () => bin2d(view.scaled('FSC-A', { type: 'linear', min: 0, max: 262144 }), view.scaled('SSC-A', { type: 'linear', min: 0, max: 262144 }), null, 300, 300));
void allEvents;
const lymph = ws.gates.find((g) => g.name === 'Lymphocytes') ?? ws.gates[1];
const channels = dataset.parameters.filter((p) => p.type === 'fluorescence').map((p) => p.name);
time(`compensate the other ${channels.length - 2} fluorescence channels`, () => channels.forEach((c) => view.column(c)));
time(`statistics table: ${channels.length} channels of ${lymph.name} (median, mean, rSD)`, () => describePopulation(view, ws, lymph.id, channels, { basic: true }), () => `${populationSet(view, ws, lymph.id)?.count} events`);
time(`full description of one channel of ${lymph.name}`, () => describePopulation(view, ws, lymph.id, channels.slice(0, 1)));

// Acquisition QC's PeacoQC on the compensated channels, serially and with its per-channel work
// on 4 worker threads reading the columns from shared memory (as the browser's QC pool does);
// the two must remove the same events.
{
  const qcChannels = dataset.parameters.filter((p) => p.type === 'scatter' || p.type === 'fluorescence').map((p) => p.name);
  const columns = {};
  for (const name of qcChannels) {
    const source = view.column(name);
    const shared = new Float32Array(new SharedArrayBuffer(source.length * 4));
    shared.set(source);
    columns[name] = shared;
  }
  const sample = { eventCount: view.eventCount, channels: dataset.parameters.filter((p) => columns[p.name]).map((p) => ({ name: p.name, type: p.type, range: p.range })), columns };
  const options = { channels: qcChannels };
  const serial = time(`PeacoQC, ${qcChannels.length} channels, 1 thread`, () => peacoQC(sample, options), (r) => `${r.percentRemoved.toFixed(1)}% removed`);
  const workers = Array.from({ length: 4 }, () => new Worker(new URL('./bench-peaks-worker.mjs', import.meta.url)));
  const { channels: names, eventsPerBin } = peacoQCLayout(sample, options);
  const groups = workers.map((_, g) => names.filter((_, c) => c % workers.length === g));
  const t0 = performance.now();
  const results = await Promise.all(workers.map((worker, g) => new Promise((resolve) => {
    worker.once('message', resolve);
    worker.postMessage({ sample: { ...sample, columns: Object.fromEntries(groups[g].map((n) => [n, columns[n]])) }, names: groups[g], options: { ...options, eventsPerBin } });
  })));
  const byName = new Map();
  groups.forEach((group, g) => group.forEach((name, k) => byName.set(name, results[g][k])));
  const parallel = peacoQC(sample, { ...options, eventsPerBin, channelResults: names.map((n) => byName.get(n)) });
  const ms = performance.now() - t0;
  let same = serial.mask.length === parallel.mask.length;
  for (let i = 0; same && i < serial.mask.length; i += 1) same = serial.mask[i] === parallel.mask[i];
  const stage = `PeacoQC, ${qcChannels.length} channels, 4 threads`;
  rows.push({ stage, ms, heldMB: 0, note: `×${(rows.at(-1).ms / ms).toFixed(1)}; ${same ? 'same mask' : 'MASKS DIFFER'}` });
  if (!json) console.log(`${stage.padEnd(52)} ${ms.toFixed(0).padStart(7)} ms          ${rows.at(-1).note}`);
  await Promise.all(workers.map((w) => w.terminate()));
}

rows.push({ stage: 'held: whole sample view', ms: 0, heldMB: view.bytes / MB, note: 'raw, compensated, scaled and populations' });
if (!json) console.log(`  sample view holds ${(view.bytes / MB).toFixed(0)} MB`);
if (json) console.log(JSON.stringify({ events: N, rows }, null, 1));
