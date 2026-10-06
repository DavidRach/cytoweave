// FlowJo 11 workbench (.flowjo) import, with the same result and fidelity report as the FlowJo 10
// workspace import (flowjo.js), so the migration dialog, sample matching and count comparison
// work unchanged.
//
// A .flowjo file is a ZIP of JSON: workbench.json names the analyses, and each
// analyses/analysis-<uuid>/analysis-<uuid>.json holds one analysis as maps from UUID to node
// ({ definition, parents, children, results }) in sections: dataSources (the FCS files, with
// their keywords), populationDefinitions (gates, shared by samples), populations (one per sample
// and gate, with FlowJo's count), platforms (compensation), cytometers and groups.
//
// Gate coordinates are FlowJo display coordinates: 0 … gateResolution (or the transform's
// vectorLength, else 256) across each axis of the gate's own transform. CytoWeave's scale space
// is the same axis as 0 … 1, so a coordinate maps to scale space by one division, and every gate
// type is reproduced exactly whenever CytoWeave evaluates the same transform (linear, log and
// FlowJo's biexponential, which CytoWeave builds from FlowJo's own table). The format was read
// from workbenches FlowJo 11.2 saved (validation/reference/flowjo11-workbenches), checked against
// the counts FlowJo stored in them:
//   - an ellipse is its axis-aligned box [x1, x2] × [y1, y2] turned by rotationAngle (degrees,
//     counterclockwise) about its center;
//   - a quadrant gate is one definition with four populations (populationNumber 0–3: lower left,
//     lower right, upper left, upper right) and five vertices: the center and the ends of the
//     lower, right, upper and left arms; an arm moved sideways offsets that half's divider;
//   - a per-sample change to a shared gate is kept in its definition's desyncTable, by sample;
//   - Boolean populations name their operands as parents, and FlowJo counts them within the
//     operands' parent wherever the tree shows them.

import { listZip, readZipEntry } from './zip.js';
import { createTransform } from './transforms.js';
import { newId } from './gates.js';
import { flowJoChannel } from './flowjo.js';

// FlowJo writes an open bound as a coordinate far outside the axis.
const OPEN = 1e5;
const QUADRANT_LABELS = ['LL', 'LR', 'UL', 'UR'];

// --- Reading the archive ------------------------------------------------------------------------

// The analyses of a .flowjo file: [{ uuid, name, analysis }] (name from workbench.json).
export async function readFlowJo11(bytes) {
  let entries;
  try {
    entries = listZip(bytes);
  } catch {
    throw new Error('This is not a FlowJo 11 workbench (.flowjo files are ZIP archives).');
  }
  // FlowJo for Windows writes some entry names with backslashes.
  const named = entries.map((entry) => ({ entry, path: entry.name.replace(/\\/g, '/') }));
  const decoder = new TextDecoder();
  const json = async (item) => JSON.parse(decoder.decode(await readZipEntry(bytes, item.entry)));
  const workbenchEntry = named.find((n) => n.path === 'workbench.json');
  const workbench = workbenchEntry ? await json(workbenchEntry) : null;
  const analyses = [];
  for (const item of named) {
    const m = /^analyses\/analysis-([^/]+)\/analysis-\1\.json$/.exec(item.path);
    if (!m) continue;
    analyses.push({ uuid: m[1], name: workbench?.name ?? null, analysis: await json(item) });
  }
  if (!analyses.length) throw new Error('This FlowJo 11 workbench holds no analysis.');
  return analyses;
}

// --- Transforms ---------------------------------------------------------------------------------

// A FlowJo 11 transform ({ transformType, … }) as { spec, length, status, detail }. `length` is
// the axis' display length (the default coordinate range of gates drawn on it).
export function flowJo11Transform(t, fallbackMax = 262144) {
  const type = String(t?.transformType ?? 'Linear');
  const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback);
  let spec = null;
  let status = 'imported';
  let detail = '';
  const length = num(t?.vectorLength, 256);
  switch (type.toLowerCase()) {
    case 'linear': {
      const max = num(t.maxRange, 0);
      const min = num(t.minRange, 0);
      if (max > min) spec = { type: 'linear', min, max };
      else {
        // FlowJo writes 0 … 0 for an axis whose scale it did not record.
        spec = { type: 'linear', min: 0, max: fallbackMax };
        status = 'approximated';
        detail = 'FlowJo stored no range for this linear axis; the parameter\'s range was used';
      }
      break;
    }
    case 'log': {
      // Display d of L: value = 10^(d / L · numberDecades + decadesOffset − 1) − shift.
      const decades = num(t.numberDecades, 4);
      const offset = num(t.decadesOffset, 1);
      const bottom = 10 ** (offset - 1);
      spec = { type: 'log', min: bottom, max: bottom * 10 ** decades };
      if (num(t.shift, 0) !== 0) {
        status = 'approximated';
        detail = `the log axis is shifted by ${t.shift}, which CytoWeave's log scale does not do`;
      }
      break;
    }
    case 'biex':
      // FlowJo 10's biex with T = maxRange, A = neg, M = pos, W = width.
      spec = { type: 'biex', maxValue: num(t.T, fallbackMax), widthBasis: num(t.W, -10), positiveDecades: num(t.M, 4.5), extraNegativeDecades: num(t.A, 0) };
      break;
    case 'logicle':
      spec = { type: 'logicle', T: num(t.T, fallbackMax), W: num(t.W, 0.5), M: num(t.M, 4.5), A: num(t.A, 0) };
      status = 'approximated';
      detail = 'a FlowJo 11 logicle axis, read as the reference logicle (not yet checked against FlowJo 11\'s counts)';
      break;
    case 'arcsinh':
    case 'fasinh':
      if (t.T !== undefined || t.M !== undefined) spec = { type: 'fasinh', T: num(t.T, fallbackMax), M: num(t.M, 4.5), A: num(t.A, 0) };
      else if (t.cofactor !== undefined || t.b !== undefined) spec = { type: 'arcsinh', cofactor: t.cofactor !== undefined ? num(t.cofactor, 150) : 1 / num(t.b, 1 / 150), max: fallbackMax };
      status = 'approximated';
      detail = 'a FlowJo 11 arcsinh axis (not yet checked against FlowJo 11\'s counts)';
      break;
    default:
      spec = null;
  }
  if (spec) {
    try {
      createTransform(spec);
    } catch (error) {
      detail = `its parameters are invalid (${error.message})`;
      spec = null;
    }
  }
  if (!spec) return { spec: { type: 'linear', min: 0, max: fallbackMax }, length, status: 'unsupported', detail: `the FlowJo 11 transform "${type}" ${detail || 'is not supported'}; a linear scale was used` };
  return { spec, length, status, detail };
}

// --- Compensation -------------------------------------------------------------------------------

// A spilloverMatrix platform as a CytoWeave compensation (spillover rows by detector).
function compensationOf(platform, warnings) {
  const def = platform?.definition;
  if (!def || def.platformType !== 'spilloverMatrix') return null;
  const spill = def.spillover;
  const spec = def.compSpec?.CompensationSpec;
  const toDetector = def.fluorToPrimaryDetector ?? {};
  let rows = spill?.rows;
  let columns = spill?.columns;
  let values = spill?.values;
  if (!rows?.length && spec) {
    rows = (spec.parameters ?? []).map((p) => p.name ?? p);
    columns = (spec.detectors ?? []).map((d) => d.name ?? d);
    values = spec.coefficients;
  }
  if (!rows?.length || !columns?.length || !Array.isArray(values)) return null;
  if (def.isSpectral || spec?.spectral) {
    warnings.push(`The matrix "${def.name}" is a spectral unmixing matrix; CytoWeave imports conventional compensation from FlowJo 11 workbenches, so its unmixed parameters are not computed.`);
    return null;
  }
  const channels = columns.slice();
  const n = channels.length;
  const matrix = new Array(n * n).fill(0);
  for (let i = 0; i < n; i += 1) matrix[i * n + i] = 1;
  rows.forEach((row, r) => {
    const detector = toDetector[row] ?? flowJoChannel(row).channel;
    const i = channels.indexOf(detector);
    if (i < 0) return;
    for (let j = 0; j < n; j += 1) {
      const v = Number(values[r]?.[j]);
      if (Number.isFinite(v)) matrix[i * n + j] = v;
    }
  });
  // CyFj11 reports matrices written with a diagonal of 100 (percentages).
  const diagonal = channels.map((_, i) => matrix[i * n + i]);
  if (diagonal.every((d) => d > 50)) {
    for (let k = 0; k < matrix.length; k += 1) matrix[k] /= 100;
  }
  return { id: newId('c'), name: def.name ?? 'FlowJo compensation', channels, matrix, source: 'imported', prefix: 'Comp-', suffix: '', flowJoId: platform.uuid };
}

// --- Import -------------------------------------------------------------------------------------

// Whether a quadrant gate's arms are offset (FlowJo stores the center in double and the arm ends
// in single precision, so a difference below a thousandth of a display unit is not one).
function quadIsOffset(gd) {
  const xs = (gd?.xVertices ?? []).map(Number);
  const ys = (gd?.yVertices ?? []).map(Number);
  if (xs.length < 5 || ys.length < 5) return false;
  const apart = (a, b) => Math.abs(a - b) > 1e-3;
  return apart(xs[1], xs[0]) || apart(xs[3], xs[0]) || apart(ys[2], ys[0]) || apart(ys[4], ys[0]);
}

// Imports a FlowJo 11 workbench (bytes). Returns importFlowJo's shape: { version, flowJoVersion,
// format: 'flowjo11', samples, groups, warnings, fidelity }.
export async function importFlowJo11(bytes, options = {}) {
  const analyses = await readFlowJo11(bytes);
  const warnings = [];
  if (analyses.length > 1) warnings.push(`The workbench holds ${analyses.length} analyses; CytoWeave imports the first.`);
  const { analysis } = analyses[0];
  return importFlowJo11Analysis(analysis, { ...options, warnings });
}

export function importFlowJo11Analysis(a, options = {}) {
  const warnings = options.warnings ?? [];
  const fidelity = [];
  const section = (name) => a?.[name] ?? {};
  const definitions = section('populationDefinitions');
  const populations = section('populations');
  const dataSources = section('dataSources');
  const platforms = Object.fromEntries(Object.values(section('platforms')).flatMap((byId) => Object.entries(byId ?? {})));
  const groupsById = section('groups');
  if (!a || typeof a !== 'object' || !a.populationDefinitions) throw new Error('This is not a FlowJo 11 analysis.');
  const parentsOf = (node, key) => node?.parents?.[key] ?? [];
  const childrenOf = (node, key) => node?.children?.[key] ?? [];
  const definitionOf = (pop) => definitions[parentsOf(pop, 'populationDefinitions')[0]];

  // Quadrant gates with an offset arm in any sample: CytoWeave's quadrants share one center, so
  // these are imported as rectangles in every sample (a gate keeps one type across samples, and
  // a sample's own arrangement becomes its adjustment of them).
  const offsetQuads = new Set();
  for (const [id, d] of Object.entries(definitions)) {
    if (d.definition?.type !== 'quad') continue;
    const versions = [d.definition.gateDefinition, ...Object.values(d.definition.desyncTable ?? {})].filter(Boolean);
    if (versions.some(quadIsOffset)) offsetQuads.add(id);
  }

  const groups = Object.values(groupsById).map((g) => ({
    name: g.definition?.name ?? 'Group',
    sampleIds: parentsOf(g, 'dataSources'),
    builtIn: ['Acquired Data', 'Compensation Data', 'Experiment Data', 'All Samples'].includes(g.definition?.name),
  }));

  const samples = Object.entries(dataSources).map(([uuid, ds], index) => {
    const def = ds.definition ?? {};
    const results = ds.results ?? {};
    const keywords = {};
    for (const [k, v] of Object.entries(results.keywords ?? {})) keywords[k.toUpperCase()] = String(v ?? '');
    const uri = def.uri ?? '';
    const fileName = decodeURIComponent(uri.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '') || keywords.$FIL || '';
    const name = fileName || def.customKeywords?.['File Name'] || `Sample ${index + 1}`;
    const record = (path, status, detail) => fidelity.push({ sample: name, sampleId: uuid, path, status, detail });
    const where = `Sample "${name}"`;

    // Compensation: the spilloverMatrix platform this sample uses.
    let compensation = null;
    for (const id of parentsOf(ds, 'platforms')) {
      compensation = compensationOf(platforms[id], warnings);
      if (compensation) break;
    }

    // Parameter ranges and time units, from the FCS keywords.
    const rangeOf = (channel) => {
      for (const [key, value] of Object.entries(keywords)) {
        const m = /^\$P(\d+)N$/.exec(key);
        if (m && value === channel) {
          const range = Number(keywords[`$P${m[1]}R`]);
          if (range > 0) return range;
        }
      }
      return 262144;
    };
    // FlowJo shows time in seconds ($TIMESTEP × the stored value); CytoWeave keeps stored values.
    const timestep = Number.parseFloat(keywords.$TIMESTEP);
    const isTime = (channel) => /^time$/i.test(channel);

    const transforms = {};
    // The gate's axis as a CytoWeave dimension, with its display length.
    const axisOf = (axis, resolution, details) => {
      const parameter = axis?.parameterSpec?.name;
      if (!parameter) throw new Error('a gate axis names no parameter');
      const { channel, compensated } = flowJoChannel(parameter, compensation);
      const t = flowJo11Transform(axis.transform, rangeOf(channel));
      let { spec } = t;
      if (isTime(channel) && timestep > 0 && timestep !== 1 && spec.type === 'linear') spec = { ...spec, min: spec.min / timestep, max: spec.max / timestep };
      if (t.status !== 'imported') details.push({ status: t.status === 'unsupported' ? 'approximated' : t.status, detail: `${parameter}: ${t.detail}` });
      if (compensated && !compensation) details.push({ status: 'approximated', detail: `"${parameter}" is compensated in FlowJo but the workbench holds no matrix for this sample; assign the file's spillover matrix in CytoWeave` });
      if (compensated || !transforms[channel]) transforms[channel] = spec;
      const dim = { channel, transform: spec };
      if (!compensated && compensation?.channels.includes(channel)) {
        dim.compensation = 'uncompensated';
        details.push({ status: 'imported', detail: `drawn on uncompensated ${channel}, which the gate keeps` });
      }
      return { dim, compensated, length: resolution ?? t.length ?? 256 };
    };

    const gates = [];
    const populationCounts = {};
    const gateOfPopulation = new Map();
    const pathOfPopulation = new Map();
    const quadSets = new Map();
    const pendingBooleans = [];
    const usedPaths = new Set();

    const base = (name, parentId) => ({ id: newId('g'), name, parentId, scope: null, overrides: {}, meta: { origin: 'imported', source: 'flowjo11' } });

    // The gate definition this sample uses (its own copy when it was changed for this sample).
    const effective = (definition) => definition?.definition?.desyncTable?.[uuid] ?? definition?.definition?.gateDefinition ?? null;

    const convert = (gd, label) => {
      const details = [];
      const resolution = Number(gd.gateResolution) > 0 ? Number(gd.gateResolution) : null;
      const x = axisOf(gd.xAxis, resolution, details);
      const y = gd.yAxis?.parameterSpec?.name && gd.type !== 'range' ? axisOf(gd.yAxis, resolution, details) : null;
      const xs = (gd.xVertices ?? []).map(Number);
      const ys = (gd.yVertices ?? []).map(Number);
      const sx = (v) => (Math.abs(v) >= OPEN ? null : v / x.length);
      const sy = (v) => (Math.abs(v) >= OPEN ? null : v / y.length);
      const dims = y ? [x.dim, y.dim] : [x.dim];
      const compensated = y ? [x.compensated, y.compensated] : [x.compensated];
      if (gd.approximateGeometry) details.push({ status: 'imported', detail: 'FlowJo 11 converted this gate from a FlowJo 10 workspace and marked its geometry approximate; FlowJo\'s own counts use it as stored' });
      switch (gd.type) {
        case 'polygon': {
          if (!y || xs.length < 3 || xs.length !== ys.length || xs.some((v) => !Number.isFinite(v)) || ys.some((v) => !Number.isFinite(v))) throw new Error('the polygon has fewer than 3 valid vertices');
          return { type: 'polygon', dims, compensated, grid: y ? [x.length, y.length] : [x.length], geometry: { vertices: xs.map((v, i) => [v / x.length, ys[i] / y.length]) }, details };
        }
        case 'rectangle': {
          if (!y || xs.length < 2 || ys.length < 2) throw new Error('the rectangle needs two corners');
          const [x1, x2] = [Math.min(xs[0], xs[1]), Math.max(xs[0], xs[1])];
          const [y1, y2] = [Math.min(ys[0], ys[1]), Math.max(ys[0], ys[1])];
          return { type: 'rectangle', dims, compensated, grid: y ? [x.length, y.length] : [x.length], geometry: { min: [sx(x1), sy(y1)], max: [sx(x2), sy(y2)] }, details };
        }
        case 'range': {
          if (xs.length < 2) throw new Error('the range needs two ends');
          const [lo, hi] = [Math.min(xs[0], xs[1]), Math.max(xs[0], xs[1])];
          return { type: 'range', dims: [x.dim], compensated: [x.compensated], grid: [x.length], geometry: { min: sx(lo), max: sx(hi) }, details };
        }
        case 'ellipse': {
          if (!y || xs.length < 2 || ys.length < 2) throw new Error('the ellipse needs its two box corners');
          if (x.length !== y.length) details.push({ status: 'approximated', detail: 'the ellipse\'s axes have different display lengths; its rotation was kept in scale space' });
          const center = [(xs[0] + xs[1]) / 2 / x.length, (ys[0] + ys[1]) / 2 / y.length];
          const radii = [Math.abs(xs[1] - xs[0]) / 2 / x.length, Math.abs(ys[1] - ys[0]) / 2 / y.length];
          if (!(radii[0] > 0 && radii[1] > 0)) throw new Error('the ellipse has no area');
          return { type: 'ellipse', dims, compensated, grid: y ? [x.length, y.length] : [x.length], geometry: { center, radii, angle: (Number(gd.rotationAngle) || 0) * Math.PI / 180 }, details };
        }
        default:
          throw new Error(`the FlowJo 11 gate type "${gd.type}" (${label}) is not supported`);
      }
    };

    const summarize = (details) => {
      const rank = { imported: 0, approximated: 1, unsupported: 2 };
      let status = 'imported';
      for (const d of details) if (rank[d.status] > rank[status]) status = d.status;
      return { status, detail: details.map((d) => d.detail).filter(Boolean).join('; ') || 'exact' };
    };

    const uniquePath = (path) => {
      if (!usedPaths.has(path)) {
        usedPaths.add(path);
        return path;
      }
      let k = 2;
      while (usedPaths.has(`${path} #${k}`)) k += 1;
      warnings.push(`${where}: two populations are both called "${path}"; the second is "${path} #${k}".`);
      usedPaths.add(`${path} #${k}`);
      return `${path} #${k}`;
    };

    // Quadrant populations: one gate definition, four populations told apart by populationNumber.
    const quadrant = (pop, definition, gd, path, name, parentId) => {
      const number = Number(pop.definition?.populationNumber ?? 0);
      const label = QUADRANT_LABELS[number];
      if (!label) throw new Error(`a quadrant population is numbered ${number}`);
      const key = `${definition.uuid}|${parentId}`;
      let set = quadSets.get(key);
      if (!set) {
        const details = [];
        const resolution = Number(gd.gateResolution) > 0 ? Number(gd.gateResolution) : null;
        const x = axisOf(gd.xAxis, resolution, details);
        const y = axisOf(gd.yAxis, resolution, details);
        const xs = (gd.xVertices ?? []).map(Number);
        const ys = (gd.yVertices ?? []).map(Number);
        if (xs.length < 5 || ys.length < 5 || [...xs, ...ys].some((v) => !Number.isFinite(v))) throw new Error('the quadrant gate does not have its five vertices');
        // Center, then the ends of the lower, right, upper and left arms.
        const center = [xs[0] / x.length, ys[0] / y.length];
        // An arm end within a thousandth of a display unit of the center is on it (FlowJo stores
        // the center in double and the arm ends in single precision).
        const snap = (v, c, length) => (Math.abs(v - c) > 1e-3 ? v / length : c / length);
        const lowerX = snap(xs[1], xs[0], x.length);
        const upperX = snap(xs[3], xs[0], x.length);
        const rightY = snap(ys[2], ys[0], y.length);
        const leftY = snap(ys[4], ys[0], y.length);
        const offset = offsetQuads.has(definition.uuid ?? parentsOf(pop, 'populationDefinitions')[0]);
        // Each arm ends on its own side of the center; otherwise FlowJo divides the plot in a way
        // the center and the arms' positions do not describe.
        if (!(ys[1] < ys[0] && xs[2] > xs[0] && ys[3] > ys[0] && xs[4] < xs[0])) {
          details.push({ status: 'approximated', detail: 'an arm of this FlowJo quadrant gate ends on the wrong side of its center; the quadrants were read from the center and the arms\' positions, and may not be the ones FlowJo shows' });
        }
        set = { x, y, center, lowerX, upperX, rightY, leftY, offset, linkId: newId('q'), details };
        quadSets.set(key, set);
      }
      const gate = base(name, parentId);
      gate.dims = [set.x.dim, set.y.dim];
      gate.meta.compensated = [set.x.compensated, set.y.compensated];
      const details = [...set.details];
      if (!set.offset) {
        gate.type = 'quadrant';
        gate.geometry = { center: set.center.slice(), quadrant: label };
        gate.linkId = set.linkId;
        gate.meta.flowJo = { path, key: path, linkKey: `quad|${parentId}|${definition.uuid}`, grid: [set.x.length, set.y.length] };
        gates.push(gate);
      } else {
        // Offset arms: the quadrant is the union of up to two rectangles (CytoWeave quadrants
        // share one center), joined by an OR of hidden helper gates.
        const { center, lowerX, upperX, rightY, leftY } = set;
        const upper = label[0] === 'U';
        const right = label[1] === 'R';
        const pieces = [];
        // Split by the side of the center each piece lies on: the vertical divider is lowerX
        // below the center and upperX above it; the horizontal one is leftY left of the center
        // and rightY right of it.
        for (const [xLo, xHi, yDiv] of [[null, center[0], leftY], [center[0], null, rightY]]) {
          for (const [yLo, yHi, xDiv] of [[null, center[1], lowerX], [center[1], null, upperX]]) {
            // Cell [xLo, xHi] × [yLo, yHi]; within it the quadrant is bounded by xDiv and yDiv.
            const min = [right ? Math.max(xLo ?? -Infinity, xDiv) : xLo, upper ? Math.max(yLo ?? -Infinity, yDiv) : yLo];
            const max = [right ? xHi : Math.min(xHi ?? Infinity, xDiv), upper ? yHi : Math.min(yHi ?? Infinity, yDiv)];
            const lo = min.map((v) => (v === -Infinity ? null : v));
            const hi = max.map((v) => (v === Infinity ? null : v));
            if ((lo[0] !== null && hi[0] !== null && hi[0] <= lo[0]) || (lo[1] !== null && hi[1] !== null && hi[1] <= lo[1])) continue;
            pieces.push({ min: lo, max: hi });
          }
        }
        // Neighboring pieces with the same extent across become one.
        const join = (p, q) => {
          for (const k of [0, 1]) {
            const o = 1 - k;
            if (p.min[o] !== q.min[o] || p.max[o] !== q.max[o]) continue;
            const [first, second] = p.max[k] !== null && p.max[k] === q.min[k] ? [p, q] : q.max[k] !== null && q.max[k] === p.min[k] ? [q, p] : [null, null];
            if (!first) continue;
            const min = first.min.slice();
            const max = first.max.slice();
            max[k] = second.max[k];
            return { min, max };
          }
          return null;
        };
        for (let i = 0; i < pieces.length; i += 1) {
          for (let j = i + 1; j < pieces.length; j += 1) {
            const joined = join(pieces[i], pieces[j]);
            if (!joined) continue;
            pieces[i] = joined;
            pieces.splice(j, 1);
            j = i;
          }
        }
        details.push({ status: 'imported', detail: 'a FlowJo quadrant gate with an offset arm (in this or another sample), imported as the rectangles each quadrant covers' });
        if (pieces.length === 1) {
          gate.type = 'rectangle';
          gate.geometry = pieces[0];
          gate.meta.flowJo = { path, key: path, grid: [set.x.length, set.y.length] };
          gates.push(gate);
        } else {
          const operands = pieces.map((piece, i) => {
            const helper = base(`${name} (part ${i + 1})`, parentId);
            Object.assign(helper, { type: 'rectangle', dims: gate.dims.map((d) => ({ ...d })), geometry: piece });
            helper.meta.helper = true;
            helper.meta.flowJo = { path, key: `helper:${path}:${i}`, grid: [set.x.length, set.y.length] };
            gates.push(helper);
            return helper.id;
          });
          Object.assign(gate, { type: 'boolean', dims: [], geometry: { op: 'or', operands } });
          gate.meta.flowJo = { path, key: path };
          gates.push(gate);
        }
      }
      return { gate, details };
    };

    const visit = (pop, parentPath, parentId, parentLost) => {
      const definition = definitionOf(pop);
      const def = definition?.definition ?? {};
      const names = def.name ?? [];
      const number = Number(pop.definition?.populationNumber ?? 0);
      const rawName = String((def.type === 'quad' ? names[number] : names[0]) ?? '(unnamed)');
      // FlowJo 11 names quadrants "Q1:CD4-,CD8+"; FlowJo 10 imports keep "Q1: CD4- , CD8+".
      const name = rawName.replace(/\//g, '∕');
      const path = uniquePath(parentPath ? `${parentPath}/${name}` : name);
      const count = Number(pop.results?.count);
      if (Number.isFinite(count) && pop.results?.status !== 'invalid') populationCounts[path] = count;
      pathOfPopulation.set(pop.uuid, path);
      let id = null;
      if (parentLost) {
        record(path, 'unsupported', 'its parent population could not be imported');
      } else if (['and', 'or', 'not'].includes(def.type)) {
        const gate = base(name, parentId);
        Object.assign(gate, { type: 'boolean', dims: [], geometry: { op: def.type, operands: [] } });
        gate.meta.flowJo = { path, key: path };
        gates.push(gate);
        pendingBooleans.push({ gate, pop, path, parentId });
        id = gate.id;
      } else {
        try {
          const gd = effective(definition);
          if (!gd) throw new Error('the population has no gate definition');
          let gate;
          let details;
          if (def.type === 'quad' || gd.type === 'quad') {
            ({ gate, details } = quadrant(pop, definition, gd, path, name, parentId));
          } else {
            const converted = convert(gd, name);
            gate = base(name, parentId);
            Object.assign(gate, { type: converted.type, dims: converted.dims, geometry: converted.geometry });
            gate.meta.compensated = converted.compensated;
            gate.meta.flowJo = { path, key: path, grid: converted.grid };
            gates.push(gate);
            details = converted.details;
          }
          if (def.desyncTable?.[uuid]) details.push({ status: 'imported', detail: 'this sample has its own adjustment of the gate in FlowJo' });
          const { status, detail } = summarize(details);
          record(path, status, detail);
          id = gate.id;
        } catch (error) {
          record(path, 'unsupported', error.message);
        }
      }
      if (id) gateOfPopulation.set(pop.uuid, id);
      for (const childId of childrenOf(pop, 'populations')) {
        const childPop = populations[childId];
        if (childPop) visit({ uuid: childId, ...childPop }, path, id, parentLost || !id);
      }
    };

    const roots = Object.entries(populations)
      .filter(([, p]) => parentsOf(p, '_dataSource').includes(uuid) || parentsOf(p, 'dataSources').includes(uuid))
      .filter(([, p]) => definitionOf(p)?.definition?.type === 'root');
    if (!roots.length) warnings.push(`${where} has no gating tree in the workbench.`);
    const root = roots[0];
    const eventCount = root ? Number(root[1].results?.count) : (Number(keywords.$TOT) || null);
    if (root) {
      for (const childId of childrenOf(root[1], 'populations')) {
        const childPop = populations[childId];
        if (childPop) visit({ uuid: childId, ...childPop }, '', null, false);
      }
    }

    // Booleans: operands are the populations named as parents; FlowJo counts the result within
    // the operands' common parent, which is where CytoWeave puts it.
    const gateById = new Map(gates.map((g) => [g.id, g]));
    const failed = new Set();
    for (const item of pendingBooleans) {
      const operandPops = parentsOf(item.pop, 'populations');
      const operands = operandPops.map((p) => gateOfPopulation.get(p)).filter(Boolean);
      if (!operandPops.length || operands.length !== operandPops.length) {
        record(item.path, 'unsupported', 'the Boolean population refers to populations that could not be imported');
        failed.add(item.gate.id);
        continue;
      }
      item.gate.geometry.operands = operands;
      item.gate.meta.flowJo.operandPaths = operandPops.map((p) => pathOfPopulation.get(p));
      const parents = new Set(operands.map((o) => gateById.get(o)?.parentId ?? null));
      let detail = 'exact';
      if (parents.size === 1) {
        const common = [...parents][0];
        if (common !== item.parentId) {
          item.gate.parentId = common;
          detail = 'FlowJo shows it under one of its operands but counts it within their parent, as CytoWeave does';
        }
      } else {
        detail = 'its operands have different parents; it is counted within the population FlowJo shows it under';
      }
      record(item.path, 'imported', detail);
    }
    let changed = failed.size > 0;
    while (changed) {
      changed = false;
      for (const g of gates) {
        if (failed.has(g.id)) continue;
        const deps = [g.parentId, ...(g.type === 'boolean' ? g.geometry.operands : [])];
        if (deps.some((d) => d && failed.has(d))) {
          failed.add(g.id);
          if (!g.meta.helper) record(g.meta.flowJo.path, 'unsupported', 'it depends on a population that could not be imported');
          changed = true;
        }
      }
    }
    return {
      name,
      uri,
      fileName,
      sampleId: uuid,
      keywords,
      groupNames: groups.filter((g) => !g.builtIn && g.sampleIds.includes(uuid)).map((g) => g.name),
      eventCount: Number.isFinite(eventCount) ? eventCount : null,
      compensation,
      transforms,
      gates: gates.filter((g) => !failed.has(g.id)),
      populationCounts,
    };
  });
  if (!samples.length) warnings.push('The workbench lists no samples.');
  return { version: a.schemaVersion ?? null, flowJoVersion: '11', format: 'flowjo11', samples, groups, warnings, fidelity };
}
