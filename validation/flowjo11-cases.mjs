// FlowJo 11 workbench (.flowjo) cases of the validation suite. validation/reference/
// flowjo11-workbenches holds workbenches FlowJo 11.2.0 (build 11.2.0.210156) saved on 2026-10-05
// during a trial: CytoWeave's FlowJo exports of the export cases (flowjo-export-cases.mjs) opened
// with File > Import FlowJo v10 Workspace and saved with File > Save Workbench As, and one with
// gates drawn in FlowJo 11 itself (an ellipse, a polygon, a rectangle and a quadrant gate with an
// offset arm, on the bundled example). FlowJo stores its count of every population in the file;
// file paths were rewritten to /data/<case>/ and nothing else was changed.
//
// Each case is read with importFlowJo11 and checked twice:
//   - the imported gates, evaluated the way FlowJo 11 evaluates them (flowJo11Counts), give
//     FlowJo's own counts: this checks the reading of the format (geometry, transforms,
//     compensation, per-sample gates, quadrants), independent of CytoWeave's engine;
//   - the workbench imported as the app imports it (sample matching, merged gate tree, FlowJo's
//     scales and compensation) and recomputed by the engine, which evaluates the exact geometry,
//     against FlowJo's counts (the migration report).
//
// FlowJo 11's evaluation, found from these files (every count reproduced): event coordinates
// are taken on the gate's display grid (0 … gateResolution, else the axis length, 256);
// a polygon contains an event whose grid point (the coordinate rounded down) is inside or on its
// edge; an ellipse, one whose grid cell's center is inside or on it; rectangles, ranges and
// quadrants compare the coordinate itself, half-open (lower bound included, upper excluded).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { importFlowJo11 } from '../web/lib/flowjo11.js';
import { generateExample } from '../web/lib/examples.js';
import { parseFCS, readSpillover } from '../web/lib/fcs.js';
import { SampleView, countOf, population } from '../web/lib/engine.js';
import { buildFlowJoMigration, matchFlowJoSamples, migrationCountRows, migrationGates } from '../web/lib/flowjo-match.js';
import { createWorkspace, addSamples, sampleFromDataset } from '../web/lib/workspace.js';

const CACHE = new URL('./cache/', import.meta.url).pathname;
const REFERENCE = new URL('./reference/flowjo11-workbenches/', import.meta.url).pathname;

// Each workbench and where its FCS files come from (generated examples, or FlowKit's test data
// in the "flowkit" data set).
export const FLOWJO11_WORKBENCHES = [
  { file: 'fj11_bundled.flowjo', name: 'bundled FlowJo example', source: 'bundled' },
  { file: 'fj11_native_gates.flowjo', name: 'gates drawn in FlowJo 11', source: 'bundled', native: true },
  { file: 'fj11_built.flowjo', name: 'workspace built in CytoWeave', source: 'built' },
  { file: 'fj11_8_color_ICS.flowjo', name: '8_color_ICS', source: '8_color_data_set/fcs_files' },
  { file: 'fj11_8_color_ICS_with_ellipse.flowjo', name: '8_color_ICS_with_ellipse', source: '8_color_data_set/fcs_files' },
  { file: 'fj11_8_color_ICS_boolean_gate_testing.flowjo', name: '8_color_ICS_boolean_gate_testing', source: '8_color_data_set/fcs_files' },
  { file: 'fj11_reused_quad_gate_with_child.flowjo', name: 'reused_quad_gate_with_child', source: '8_color_data_set/fcs_files' },
  { file: 'fj11_simple_diamond_example_quad_gate.flowjo', name: 'simple_diamond_example_quad_gate', source: 'simple_diamond_example' },
  { file: 'fj11_test_data_diamond_biex_rect.flowjo', name: 'test_data_diamond_biex_rect', source: 'simple_diamond_example' },
  { file: 'fj11_test_data_diamond_asinh_rect.flowjo', name: 'test_data_diamond_asinh_rect', source: 'simple_diamond_example' },
  { file: 'fj11_simple_poly_and_rect.flowjo', name: 'simple_poly_and_rect', source: 'simple_line_example' },
  { file: 'fj11_single_ellipse_51_events.flowjo', name: 'single_ellipse_51_events', source: 'simple_line_example' },
];

const fileCache = new Map();
function filesOf(source) {
  if (fileCache.has(source)) return fileCache.get(source);
  let files = null;
  if (source === 'bundled') files = generateExample('flowjo-workspace', { scale: 0.25 }).files;
  else if (source === 'built') files = generateExample('pbmc-immunophenotyping', { samples: ['D01_Unstim.fcs', 'D01_Stim.fcs', 'D02_Stim.fcs'], scale: 0.2 }).files.filter((f) => /^D0/.test(f.name));
  else {
    const dir = join(CACHE, 'flowkit', source);
    if (existsSync(dir)) files = readdirSync(dir).filter((n) => /\.fcs$/.test(n)).map((n) => ({ name: n, bytes: new Uint8Array(readFileSync(join(dir, n))) }));
  }
  fileCache.set(source, files);
  return files;
}

function onSegment(x, y, x1, y1, x2, y2) {
  const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
  return Math.abs(cross) < 1e-7 && x >= Math.min(x1, x2) - 1e-9 && x <= Math.max(x1, x2) + 1e-9 && y >= Math.min(y1, y2) - 1e-9 && y <= Math.max(y1, y2) + 1e-9;
}

export function inPolygon(x, y, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const [xi, yi] = vertices[i];
    const [xj, yj] = vertices[j];
    if (onSegment(x, y, xj, yj, xi, yi)) return true;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// FlowJo 11's count of every population of an imported sample (importFlowJo11's per-sample gates),
// evaluated as FlowJo 11 evaluates gates (see the top of this file). `ref` is the compensation the
// view holds for compensated dimensions.
export function flowJo11Counts(view, sample, ref) {
  const n = view.eventCount;
  const byId = new Map(sample.gates.map((g) => [g.id, g]));
  const sets = new Map();
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
      const grid = g.meta.flowJo?.grid ?? g.dims.map(() => 256);
      const columns = g.dims.map((d, k) => view.scaled(d.channel, d.transform, d.compensation ?? (g.meta.compensated?.[k] ? ref : 'uncompensated')));
      const G = g.geometry;
      const at = (k, e) => columns[k][e] * grid[k];
      for (let e = 0; e < n; e += 1) {
        if (parent && !parent[e]) continue;
        let inside = false;
        switch (g.type) {
          case 'polygon': {
            const x = Math.floor(at(0, e) + 1e-9);
            const y = Math.floor(at(1, e) + 1e-9);
            inside = inPolygon(x, y, G.vertices.map(([a, b]) => [a * grid[0], b * grid[1]]));
            break;
          }
          case 'ellipse': {
            const x = Math.floor(at(0, e)) + 0.5;
            const y = Math.floor(at(1, e)) + 0.5;
            const dx = x - G.center[0] * grid[0];
            const dy = y - G.center[1] * grid[1];
            const c = Math.cos(G.angle);
            const s = Math.sin(G.angle);
            const u = (dx * c + dy * s) / (G.radii[0] * grid[0]);
            const w = (-dx * s + dy * c) / (G.radii[1] * grid[1]);
            inside = u * u + w * w <= 1 + 1e-9;
            break;
          }
          case 'rectangle': {
            const within = (k, v) => (G.min[k] === null || v >= G.min[k] * grid[k] - 1e-9) && (G.max[k] === null || v < G.max[k] * grid[k] - 1e-9);
            inside = within(0, at(0, e)) && within(1, at(1, e));
            break;
          }
          case 'range': {
            const v = at(0, e);
            inside = (G.min === null || v >= G.min * grid[0] - 1e-9) && (G.max === null || v < G.max * grid[0] - 1e-9);
            break;
          }
          case 'quadrant': {
            const right = at(0, e) >= G.center[0] * grid[0];
            const up = at(1, e) >= G.center[1] * grid[1];
            inside = (G.quadrant[0] === 'U') === up && (G.quadrant[1] === 'R') === right;
            break;
          }
          default:
            throw new Error(`no FlowJo 11 evaluation for ${g.type} gates`);
        }
        if (inside) members[e] = 1;
      }
    }
    sets.set(g.id, members);
    return members;
  };
  const counts = {};
  for (const g of sample.gates) {
    if (g.meta.helper) continue;
    const members = evaluate(g);
    let c = 0;
    for (let e = 0; e < n; e += 1) c += members[e];
    counts[g.meta.flowJo.path] = c;
  }
  return counts;
}

function compensatedView(record, data, compensation) {
  const view = new SampleView(record, data);
  if (compensation) {
    const comp = { id: 'flowjo11', channels: compensation.channels, matrix: compensation.matrix };
    view.compensations = [comp];
    view.setCompensation(comp);
  }
  return view;
}

// One workbench: { name, native, missing, rows: [{ sample, path, flowjo, grid, cytoweave }],
// fidelity, warnings }. `missing` names the FCS source when its files are not available.
export async function flowJo11Case(entry) {
  const files = filesOf(entry.source);
  if (!files) return { ...entry, missing: entry.source, rows: [], fidelity: [], warnings: [] };
  const result = await importFlowJo11(new Uint8Array(readFileSync(join(REFERENCE, entry.file))));
  const byName = new Map(files.map((f) => [f.name, f]));
  const datasets = new Map();

  // Format: FlowJo's own evaluation of the imported gates.
  const grid = new Map();
  for (const sample of result.samples) {
    const file = byName.get(sample.fileName);
    if (!file) continue;
    const data = parseFCS(file.bytes).datasets[0];
    datasets.set(sample.fileName, data);
    const view = compensatedView(sampleFromDataset(data, { name: file.name }), data, sample.compensation);
    grid.set(sample.sampleId, flowJo11Counts(view, sample, 'flowjo11'));
  }

  // The app: matched samples, merged gates, the engine's exact geometry.
  let ws = createWorkspace('FlowJo 11 import');
  const byRecord = new Map();
  for (const file of files) {
    const data = datasets.get(file.name) ?? parseFCS(file.bytes).datasets[0];
    const record = sampleFromDataset(data, { name: file.name });
    byRecord.set(record.id, data);
    ws = addSamples(ws, [record]);
  }
  const plan = buildFlowJoMigration(ws, result, matchFlowJoSamples(result.samples, ws.samples), { scales: true, compensation: true });
  ws = plan.ws;
  const counts = {};
  for (const target of plan.migration.samples) {
    if (!target.sampleId) continue;
    const record = ws.samples.find((s) => s.id === target.sampleId);
    const data = byRecord.get(record.id);
    const view = new SampleView(record, data);
    const id = record.compensationId ?? 'none';
    if (id === 'file') {
      const spill = readSpillover(data.keywords, data.parameters);
      if (spill && !spill.identity) view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
    } else if (id !== 'none') {
      const comp = ws.compensations.find((c) => c.id === id);
      view.setCompensation({ id: comp.id, channels: comp.channels, matrix: comp.matrix });
    }
    const out = {};
    for (const [path, gateId] of Object.entries(migrationGates(plan.migration, target.flowJoSampleId))) {
      const members = population(view, ws, gateId);
      out[path] = members === undefined ? null : countOf(members, view);
    }
    counts[target.sampleId] = out;
  }
  const appRows = migrationCountRows(plan.migration, counts);
  const appCount = new Map(appRows.map((r) => [`${r.sampleName}|${r.path}`, r.cytoweave]));
  const rows = [];
  for (const sample of result.samples) {
    for (const [path, flowjo] of Object.entries(sample.populationCounts)) {
      const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
      const parent = parentPath === null ? sample.eventCount : sample.populationCounts[parentPath];
      const appParent = parentPath === null ? sample.eventCount : appCount.get(`${sample.name}|${parentPath}`);
      rows.push({ sample: sample.name, path, flowjo, parent, grid: grid.get(sample.sampleId)?.[path] ?? null, cytoweave: appCount.get(`${sample.name}|${path}`) ?? null, appParent });
    }
  }
  return { ...entry, rows, fidelity: result.fidelity, warnings: result.warnings, migrationWarnings: plan.migration.warnings ?? [] };
}
