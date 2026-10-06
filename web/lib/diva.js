// BD FACSDiva experiment import (an experiment exported from FACSDiva as XML), with the
// same result and fidelity report as the FlowJo workspace import (flowjo.js), so the migration
// dialog, sample matching and count comparison work unchanged.
//
// An experiment holds specimens; each specimen holds tubes, and each tube names its FCS file
// (data_filename), its cytometer settings (parameters with their scales and compensation) and its
// gates, with the number of events Diva counted in each (num_events). A gate's region stores its
// coordinates in the units of the plot it was drawn on:
//   - a linear axis: data values;
//   - a log axis: log10 of the data value;
//   - a biexponential ("scaled") axis: Diva's display bins, 0 … 4096 across the axis, whose
//     scale is the logicle with T = 262144, M = 4.5, A = 0 and W = (M − log10(T / |r|)) / 2
//     (0 when r = 0) for the axis' biexponential scale value r (as CytoML and GateLab read it).
// CytoWeave keeps each gate on the same scale, so a coordinate maps to scale space without
// changing the shape: polygons stay straight on the axes they were drawn on.
//
// Compensation: each fluorescence parameter lists the coefficients that make its compensated
// value from the raw ones (a column of the compensation matrix, the inverse of the spillover
// matrix), and the tube says whether compensation is on.
//
// Diva names its populations P1, P2, … under "All Events"; paths here leave out "All Events".

import { attr, child, children, findAll, parseXMLDocument, textContent } from './xml.js';
import { createTransform } from './transforms.js';
import { inverse } from './linalg.js';
import { newId } from './gates.js';

const T = 262144;
const M = 4.5;
const BINS = 4096;

const text = (node, name) => {
  const el = child(node, name);
  return el ? textContent(el).trim() : null;
};
const num = (value, fallback = null) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value) => String(value ?? '').trim().toLowerCase() === 'true';

// The logicle Diva draws a biexponential axis with, for its scale value r.
export function divaLogicle(r) {
  const value = Math.abs(Number(r) || 0);
  const W = value > 0 ? Math.max(0, (M - Math.log10(T / value)) / 2) : 0;
  return { type: 'logicle', T, W: Math.min(W, M / 2 - 1e-9), M, A: 0 };
}

// Parameter settings of a tube (or its specimen, or the experiment): name → { log, min, max,
// scale, compensable, coefficients }, plus whether compensation is on.
function readSettings(settings) {
  if (!settings) return null;
  const parameters = new Map();
  for (const p of children(settings, 'parameter')) {
    const name = attr(p, 'name');
    if (!name) continue;
    const comp = child(p, 'compensation');
    parameters.set(name, {
      name,
      log: bool(text(p, 'is_log')),
      min: num(text(p, 'min'), 0),
      max: num(text(p, 'max'), T - 1),
      biexpScale: num(text(p, 'biexp_scale')),
      compBiexpScale: num(text(p, 'comp_biexp_scale')),
      manualBiexpScale: num(text(p, 'manual_biexp_scale')),
      compensable: bool(text(p, 'can_be_compensated')),
      coefficients: comp ? children(comp, 'compensation_coefficient').map((c) => num(textContent(c))) : [],
    });
  }
  return {
    parameters,
    compensation: bool(text(settings, 'compensation_enabled')),
    autoBiexp: text(settings, 'use_auto_biexp_scale') === null ? true : bool(text(settings, 'use_auto_biexp_scale')),
  };
}

// The compensation of a tube: the spillover matrix over the compensable parameters, from the
// coefficients (column p holds the coefficients of parameter p, so spillover = C⁻¹).
function compensationOf(settings, where, warnings) {
  if (!settings?.compensation) return null;
  const channels = [...settings.parameters.values()].filter((p) => p.compensable && p.coefficients.length);
  const n = channels.length;
  if (!n) return null;
  if (channels.some((p) => p.coefficients.length !== n || p.coefficients.some((c) => !Number.isFinite(c)))) {
    warnings.push(`${where}: the compensation coefficients do not form a square matrix; the FCS file's own spillover matrix should be used.`);
    return null;
  }
  const C = new Float64Array(n * n);
  channels.forEach((p, col) => p.coefficients.forEach((c, row) => { C[row * n + col] = c; }));
  let spill;
  try {
    spill = inverse(C, n);
  } catch {
    warnings.push(`${where}: the compensation matrix cannot be inverted; the FCS file's own spillover matrix should be used.`);
    return null;
  }
  // Tidy rounding noise (the coefficients carry about 8 digits).
  const matrix = Array.from(spill, (v) => (Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e9) / 1e9));
  return { id: newId('c'), name: 'FACSDiva compensation', channels: channels.map((p) => p.name), matrix, source: 'imported', prefix: '', suffix: '' };
}

// The scale an axis was drawn on, as a CytoWeave transform, and the map from the region's stored
// coordinates to that scale's 0 … 1.
function axisOf(gate, axis, parameter, settings, details) {
  const scaled = bool(text(gate, `is_${axis}_parameter_scaled`));
  const log = bool(text(gate, `is_${axis}_parameter_log`));
  const p = settings?.parameters.get(parameter);
  if (scaled) {
    const stored = num(text(gate, `${axis}_parameter_scale_value`));
    const fallback = settings?.autoBiexp === false ? p?.manualBiexpScale : (settings?.compensation ? p?.compBiexpScale : p?.biexpScale);
    const r = stored ?? fallback ?? 0;
    const spec = divaLogicle(r);
    return { spec, map: (v) => v / BINS };
  }
  if (log) {
    // Diva's log axis runs from its minimum to its maximum in decades (FCS 3 data: 0 to 5.42).
    const top = p?.log && p.max > 0 ? p.max : Math.log10(T);
    const bottom = p?.log && p.min < top ? p.min : top - 5;
    const spec = { type: 'log', min: 10 ** bottom, max: 10 ** top };
    return { spec, map: (v) => (v - bottom) / (top - bottom) };
  }
  if (p?.log) details.push('a gate drawn on a linear plot of a parameter shown on a log scale; its coordinates were read as data values');
  const top = p && !p.log && p.max > 0 ? p.max + 1 : T;
  const spec = { type: 'linear', min: 0, max: top };
  return { spec, map: (v) => v / top };
}

// Imports a FACSDiva experiment (XML text or bytes). Returns importFlowJo's shape: { version,
// flowJoVersion: null, format: 'diva', samples, groups, warnings, fidelity }.
export function importDiva(input) {
  const doc = parseXMLDocument(input);
  const warnings = doc.warnings.map((w) => `XML: ${w}`);
  const { root } = doc;
  if (root.local !== 'bdfacs') throw new Error(`This is not a FACSDiva experiment (its root element is <${root.name}>).`);
  const experiment = child(root, 'experiment');
  if (!experiment) throw new Error('The FACSDiva file holds no experiment.');
  const version = attr(root, 'version') ?? null;
  const fidelity = [];
  const experimentSettings = readSettings(child(experiment, 'instrument_settings'));
  // Gates on the experiment's global worksheets apply to every tube without its own copy.
  const globalGates = children(child(child(child(experiment, 'acquisition_worksheets'), 'worksheet_template'), 'gates'), 'gate');
  const samples = [];
  const groups = [];
  for (const specimen of children(experiment, 'specimen')) {
    const specimenName = attr(specimen, 'name') ?? 'Specimen';
    const specimenSettings = readSettings(child(specimen, 'instrument_settings'));
    const group = { name: specimenName, sampleIds: [], builtIn: false };
    groups.push(group);
    for (const tube of children(specimen, 'tube')) {
      const tubeName = attr(tube, 'name') ?? 'Tube';
      const fileName = text(tube, 'data_filename') ?? '';
      const sampleId = `${specimenName}/${tubeName}`;
      const name = `${specimenName} ${tubeName}`;
      group.sampleIds.push(sampleId);
      const settings = readSettings(child(tube, 'instrument_settings')) ?? specimenSettings ?? experimentSettings;
      const where = `Tube "${name}"`;
      const compensation = compensationOf(settings, where, warnings);
      let gateEls = children(child(tube, 'gates'), 'gate');
      if (!gateEls.length && globalGates.length) gateEls = globalGates;
      const sample = importTube({ gateEls, settings, compensation, name, sampleId, fileName, fidelity, warnings, where, specimen: specimenName });
      sample.groupNames = [specimenName];
      samples.push(sample);
    }
  }
  if (!samples.length) warnings.push('The experiment lists no tubes.');
  return { version, flowJoVersion: null, format: 'diva', samples, groups: groups.filter((g) => g.sampleIds.length), warnings, fidelity };
}

function importTube({ gateEls, settings, compensation, name, sampleId, fileName, fidelity, warnings, where, specimen }) {
  const record = (path, status, detail) => fidelity.push({ sample: name, sampleId, path, status, detail });
  const failedPaths = new Set();
  const keyOfPath = new Map();
  const pathOf = (fullname) => String(fullname ?? '').split('\\').filter((part, i) => !(i === 0 && /^all events$/i.test(part))).join('/');
  const gates = [];
  const populationCounts = {};
  const transforms = {};
  const idOfPath = new Map();
  let eventCount = null;
  const pending = [];
  // Quadrant gates: a hidden "binner" holds the center; its bins are the four quadrants, stored as
  // polygons drawn to the ends of the axes (where Diva shows off-scale events). They become one
  // linked set of CytoWeave quadrants, which extend beyond the axes.
  const binOf = new Map();
  for (const g of gateEls) {
    const region = child(g, 'region');
    if (!region || !/BINNER/i.test(attr(region, 'type') ?? '')) continue;
    const point = findAll(child(region, 'points'), 'point')[0];
    const binner = { g, region, center: point ? [num(attr(point, 'x')), num(attr(point, 'y'))] : null, linkId: newId('q') };
    for (const bin of children(g, 'bin')) binOf.set(pathOf(textContent(bin).trim()), binner);
  }
  for (const g of gateEls) {
    const type = attr(g, 'type') ?? text(g, 'type') ?? '';
    const fullname = attr(g, 'fullname') ?? text(g, 'name');
    const count = num(text(g, 'num_events'));
    if (/EventSource/i.test(type)) {
      if (count !== null) eventCount = count;
      continue;
    }
    if (/BINNER/i.test(attr(child(g, 'region'), 'type') ?? '')) continue;
    const path = pathOf(fullname);
    if (!path) continue;
    if (count !== null) populationCounts[path] = count;
    pending.push({ g, type, path, gateName: text(g, 'name') ?? path.split('/').pop(), parentPath: pathOf(text(g, 'parent')) });
  }
  // Parents before children (Diva lists them that way, but Boolean inputs may come later).
  const remaining = [...pending];
  let progress = true;
  while (remaining.length && progress) {
    progress = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const item = remaining[i];
      const inputs = children(item.g, 'input').map((el) => pathOf(textContent(el).trim())).filter((p) => p && p !== item.parentPath);
      const waits = [item.parentPath, ...(/^(AND|OR|NOT|RestOf)_/i.test(item.type) ? inputs : [])].filter((p) => p && pending.some((x) => x.path === p) && !idOfPath.has(p) && !failedPaths.has(p));
      if (waits.length) continue;
      remaining.splice(i, 1);
      i -= 1;
      progress = true;
      convert(item, inputs);
    }
  }
  for (const item of remaining) record(item.path, 'unsupported', 'its parent or inputs could not be resolved');

  function convert({ g, type, path, gateName, parentPath }, inputs) {
    const parentId = parentPath ? idOfPath.get(parentPath) ?? null : null;
    if (parentPath && !parentId) {
      record(path, 'unsupported', 'its parent population could not be imported');
      failedPaths.add(path);
      return;
    }
    // Diva's gates belong to their tubes: tubes of a specimen whose gate of the same name has the
    // same kind on the same parameters share one gate (each with its own position); others get
    // their own.
    const region = child(g, 'region');
    const signature = region ? `${attr(region, 'type') ?? ''}:${attr(region, 'xparm') ?? ''}:${attr(region, 'yparm') ?? ''}` : type;
    const parentKey = parentPath ? keyOfPath.get(parentPath) ?? parentPath : '';
    const key = `${specimen}|${parentKey}|${path.split('/').pop()}|${signature}`;
    keyOfPath.set(path, key);
    const base = { id: newId('g'), name: gateName, parentId, scope: null, overrides: {}, meta: { origin: 'imported', source: 'diva', flowJo: { path, key } } };
    // "Rest of" a population: its events in none of the gates it names.
    const booleanOp = /^AND_/i.test(type) ? 'and' : /^OR_/i.test(type) ? 'or' : /^(NOT|RestOf)_/i.test(type) ? 'not' : null;
    if (booleanOp) {
      const operands = inputs.map((p) => idOfPath.get(p));
      if (!operands.length || operands.some((id) => !id)) {
        record(path, 'unsupported', 'the Boolean gate refers to populations that could not be imported');
        failedPaths.add(path);
        return;
      }
      gates.push({ ...base, type: 'boolean', dims: [], geometry: { op: booleanOp, operands } });
      idOfPath.set(path, base.id);
      record(path, 'imported', 'exact');
      return;
    }
    const binner = binOf.get(path);
    if (binner && region && binner.center?.every((v) => v !== null)) {
      try {
        const xparm = attr(binner.region, 'xparm');
        const yparm = attr(binner.region, 'yparm');
        const x = axisOf(binner.g, 'x', xparm, settings, []);
        const y = axisOf(binner.g, 'y', yparm, settings, []);
        const center = [x.map(binner.center[0]), y.map(binner.center[1])];
        // The quadrant this bin covers: where its polygon lies relative to the center.
        const pts = findAll(child(region, 'points'), 'point').map((p) => [x.map(num(attr(p, 'x'))), y.map(num(attr(p, 'y')))]);
        const mean = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
        const quadrant = `${mean[1] >= center[1] ? 'U' : 'L'}${mean[0] >= center[0] ? 'R' : 'L'}`;
        const dims = [{ channel: xparm, transform: x.spec }, { channel: yparm, transform: y.spec }];
        const compensated = dims.map((d) => Boolean(compensation?.channels.includes(d.channel)));
        gates.push({ ...base, type: 'quadrant', dims, geometry: { center, quadrant }, linkId: binner.linkId, meta: { ...base.meta, compensated, flowJo: { ...base.meta.flowJo, linkKey: `quad|${specimen}|${parentKey}|${attr(binner.region, 'name') ?? ''}` } } });
        for (const d of dims) if (!transforms[d.channel]) transforms[d.channel] = d.transform;
        idOfPath.set(path, base.id);
        record(path, 'imported', 'a FACSDiva quadrant, as a CytoWeave quadrant gate (which extends beyond the axes, as Diva\'s does)');
      } catch (error) {
        record(path, 'unsupported', error.message);
        failedPaths.add(path);
      }
      return;
    }
    if (!region) {
      record(path, 'unsupported', `the ${type || 'gate'} has no region`);
      failedPaths.add(path);
      return;
    }
    const details = [];
    let status = 'imported';
    const kind = attr(region, 'type') ?? '';
    const xparm = attr(region, 'xparm');
    const yparm = attr(region, 'yparm');
    const points = findAll(child(region, 'points'), 'point').map((p) => [num(attr(p, 'x')), num(attr(p, 'y'))]);
    try {
      if (!xparm) throw new Error('the region names no parameter');
      if (!points.length || points.some(([x]) => x === null)) throw new Error('the region has no valid points');
      const x = axisOf(g, 'x', xparm, settings, details);
      const dims = [{ channel: xparm, transform: x.spec }];
      const compensated = [Boolean(compensation?.channels.includes(xparm))];
      if (/INTERVAL/i.test(kind) || !yparm) {
        const xs = points.map(([v]) => x.map(v));
        gates.push({ ...base, type: 'range', dims, geometry: { min: Math.min(...xs), max: Math.max(...xs) }, meta: { ...base.meta, compensated } });
      } else {
        const y = axisOf(g, 'y', yparm, settings, details);
        dims.push({ channel: yparm, transform: y.spec });
        compensated.push(Boolean(compensation?.channels.includes(yparm)));
        if (points.some(([, v]) => v === null)) throw new Error('the region has points without a y coordinate');
        const vertices = points.map(([a, b]) => [x.map(a), y.map(b)]);
        if (/RECTANGLE/i.test(kind)) {
          const xs = vertices.map((v) => v[0]);
          const ys = vertices.map((v) => v[1]);
          gates.push({ ...base, type: 'rectangle', dims, geometry: { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] }, meta: { ...base.meta, compensated } });
        } else if (/POLYGON|SNAP|ELLIPSE/i.test(kind)) {
          if (vertices.length < 3) throw new Error('the polygon has fewer than 3 points');
          if (/ELLIPSE/i.test(kind)) {
            status = 'approximated';
            details.push('a FACSDiva ellipse, imported as the polygon through its stored points');
          }
          gates.push({ ...base, type: 'polygon', dims, geometry: { vertices }, meta: { ...base.meta, compensated } });
        } else {
          throw new Error(`the FACSDiva region type "${kind}" is not supported`);
        }
      }
      for (const d of dims) {
        if (!transforms[d.channel]) transforms[d.channel] = d.transform;
        createTransform(d.transform);
      }
      idOfPath.set(path, base.id);
      record(path, details.length && status === 'imported' ? 'approximated' : status, details.join('; ') || 'exact');
    } catch (error) {
      record(path, 'unsupported', error.message);
      failedPaths.add(path);
    }
  }
  if (eventCount === null) warnings.push(`${where}: Diva's event count ("All Events") is missing.`);
  return { name, uri: fileName, fileName, sampleId, keywords: {}, groupNames: [], eventCount, compensation, transforms, gates, populationCounts };
}
