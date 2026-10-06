// The FACSDiva experiment case of the validation suite: PE_2 from flowWorkspaceData (the "diva"
// data set; CytoML's test file), whose tube _001 has its FCS file published. The experiment is
// read with importDiva and checked against Diva's own counts (in the XML) and CytoML's
// (reference/cytoml-diva.json).
//
// Diva's evaluation, found from its counts: event coordinates are taken on a 256-step display grid
// (rounded down) and a gate contains the events whose grid point is inside it or on its edge.
// With that, gates on linear axes reproduce Diva's counts exactly; on biexponential and log axes
// they stay within a few events, as CytoML's do: Diva's biexponential is close to, but not
// exactly, the logicle CytoWeave and CytoML read it as.

import { parseFCS, readSpillover } from '../web/lib/fcs.js';
import { importDiva } from '../web/lib/diva.js';
import { SampleView, countOf, population } from '../web/lib/engine.js';
import { buildFlowJoMigration, matchFlowJoSamples, migrationCountRows, migrationGates } from '../web/lib/flowjo-match.js';
import { createWorkspace, addSamples, sampleFromDataset } from '../web/lib/workspace.js';
import { inPolygon } from './flowjo11-cases.mjs';

// Diva's counts of a tube's gates: { path: count }.
export function divaGridCounts(view, sample, ref) {
  const n = view.eventCount;
  const byId = new Map(sample.gates.map((g) => [g.id, g]));
  const sets = new Map();
  const at = (v) => Math.floor(v * 256 + 1e-9) / 256;
  const evaluate = (g) => {
    if (sets.has(g.id)) return sets.get(g.id);
    const parent = g.parentId ? evaluate(byId.get(g.parentId)) : null;
    const members = new Uint8Array(n);
    if (g.type === 'boolean') {
      const operands = g.geometry.operands.map((id) => evaluate(byId.get(id)));
      for (let e = 0; e < n; e += 1) {
        if (parent && !parent[e]) continue;
        const v = g.geometry.op === 'and' ? operands.every((o) => o[e]) : g.geometry.op === 'or' ? operands.some((o) => o[e]) : !operands.some((o) => o[e]);
        if (v) members[e] = 1;
      }
    } else {
      const columns = g.dims.map((d, k) => view.scaled(d.channel, d.transform, g.meta.compensated?.[k] ? ref : 'uncompensated'));
      const G = g.geometry;
      for (let e = 0; e < n; e += 1) {
        if (parent && !parent[e]) continue;
        const x = at(columns[0][e]);
        const y = columns[1] ? at(columns[1][e]) : 0;
        let inside;
        if (g.type === 'rectangle') inside = x >= G.min[0] && x <= G.max[0] && y >= G.min[1] && y <= G.max[1];
        else if (g.type === 'range') inside = x >= G.min && x <= G.max;
        else if (g.type === 'quadrant') inside = (G.quadrant[0] === 'U') === (y >= G.center[1]) && (G.quadrant[1] === 'R') === (x >= G.center[0]);
        else inside = inPolygon(x, y, G.vertices);
        if (inside) members[e] = 1;
      }
    }
    sets.set(g.id, members);
    return members;
  };
  const counts = {};
  for (const g of sample.gates) {
    const members = evaluate(g);
    let c = 0;
    for (let e = 0; e < n; e += 1) c += members[e];
    counts[g.meta.flowJo.path] = c;
  }
  return counts;
}

// The case: { result, sample (tube _001), spill: largest difference between the XML's compensation
// and the FCS file's $SPILLOVER, rows: [{ path, diva, grid, cytoweave, linear }] }.
export function divaCase(xml, fcsBytes) {
  const result = importDiva(xml);
  const sample = result.samples.find((s) => s.fileName === '124500.fcs');
  const data = parseFCS(fcsBytes).datasets[0];
  const spill = readSpillover(data.keywords, data.parameters);
  const comp = sample.compensation;
  let worstSpill = 0;
  comp.channels.forEach((a, i) => comp.channels.forEach((b, j) => {
    const fi = spill.channels.indexOf(a);
    const fj = spill.channels.indexOf(b);
    worstSpill = Math.max(worstSpill, Math.abs(comp.matrix[i * comp.channels.length + j] - spill.matrix[fi * spill.channels.length + fj]));
  }));

  // Diva's evaluation of the imported gates.
  const view = new SampleView(sampleFromDataset(data, { name: '124500.fcs' }), data);
  const own = { id: 'diva', channels: comp.channels, matrix: comp.matrix };
  view.compensations = [own];
  view.setCompensation(own);
  const grid = divaGridCounts(view, sample, 'diva');

  // The app: the whole experiment imported against this one file.
  let ws = createWorkspace('FACSDiva import');
  const record = sampleFromDataset(data, { name: '124500.fcs' });
  ws = addSamples(ws, [record]);
  const plan = buildFlowJoMigration(ws, result, matchFlowJoSamples(result.samples, ws.samples), { scales: true, compensation: true });
  const counts = {};
  for (const target of plan.migration.samples) {
    if (!target.sampleId) continue;
    const rec = plan.ws.samples.find((s) => s.id === target.sampleId);
    const v = new SampleView(rec, data);
    const id = rec.compensationId ?? 'none';
    const c = id === 'none' ? null : id === 'file' ? { id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) } : plan.ws.compensations.find((x) => x.id === id);
    if (c) v.setCompensation({ id: c.id, channels: c.channels, matrix: c.matrix });
    const out = {};
    for (const [path, gateId] of Object.entries(migrationGates(plan.migration, target.flowJoSampleId))) {
      const members = population(v, plan.ws, gateId);
      out[path] = members === undefined ? null : countOf(members, v);
    }
    counts[target.sampleId] = out;
  }
  const app = new Map(migrationCountRows(plan.migration, counts).map((r) => [r.path, r.cytoweave]));
  const rows = Object.entries(sample.populationCounts).map(([path, diva]) => {
    const gate = sample.gates.find((g) => g.meta.flowJo.path === path);
    return { path, diva, grid: grid[path] ?? null, cytoweave: app.get(path) ?? null, linear: Boolean(gate?.dims.length && gate.dims.every((d) => d.transform.type === 'linear')) };
  });
  return { result, sample, worstSpill, rows, matched: plan.migration.samples.filter((s) => s.sampleId).length };
}
