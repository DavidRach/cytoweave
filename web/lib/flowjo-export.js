// FlowJo v10 workspace (.wsp) export, the inverse of flowjo.js, with an explicit fidelity report.
//
// FlowJo keeps one gating tree per sample, with gate coordinates in data units (compensated,
// untransformed) except ellipses, which it keeps in its 256 × 256 display space. CytoWeave keeps
// shared gates in the scale space of the transform each was drawn on, with per-sample overrides
// and group scopes. So each sample gets its own tree: the gates that apply to it, with its own
// geometry, mapped back to data units through each gate's own transform.
//
// FlowJo draws polygon edges and ellipses on its display axes, which are the transforms this
// export writes for the sample: logicle and arcsinh scales are written as the closest FlowJo
// biex, since FlowJo 11 misreads the others (flowJoScale). Where a gate was drawn on the same
// transform, it is reproduced exactly; where not, its outline is traced in its own scale with
// enough vertices that FlowJo's straight edges follow it (reported as approximated).
// Rectangles, ranges, quadrants and splits are exact under any monotone transform.
//
// Populations FlowJo cannot evaluate are left out and reported: gates on channels the FCS file
// does not have (QC pass, clusters, unmixed or normalized channels, ratios), category gates, and
// gates of three or more dimensions.

import { readSpillover } from './fcs.js';
import { createTransform, defaultTransform, logicleToBiex, transformKey } from './transforms.js';
import { gateApplies, effectiveGeometry, gateById } from './workspace.js';
import { sameTransformFunction } from './gatingml.js';

const LN10 = Math.LN10;
const PREFIX = 'Comp-';
// Vertices per edge when an outline is traced on a different transform, and for an ellipse.
const TRACE_STEPS = 24;
const ELLIPSE_VERTICES = 96;
// The open side of a rectangle, in data units: beyond any FCS range.
const UNBOUNDED = 1e9;

const esc = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const num = (value) => (Number.isFinite(value) ? String(+value.toPrecision(12)) : '0');

// A node's plot as FlowJo writes it. FlowJo 11 crashes importing a population whose Graph lacks
// GraphSettings and GraphEnvironment (FlowJo 10 and FlowKit do not need them), so every node
// carries the full element, with empty axis names where the node has no plot of its own.
const TEXT_TRAITS = [['Labels', 11], ['LayoutGates', 11], ['Numbers', 9], ['Legend', 9]]
  .map(([name, size]) => `<TextTraits font="SansSerif" size="${size}" name="${name}" style="plain" color="#000000" background="#00ffffff" just="left"/>`).join('');
function flowJoGraph(type = 'Pseudocolor', x = '', y = '') {
  return `<Graph smoothing="0" backColor="#ffffff" foreColor="#000000" type="${type}" fast="1">`
    + `<Axis dimension="x" name="${esc(x)}" label="" auto="auto"/><Axis dimension="y" name="${esc(y)}" label="" auto="auto"/>`
    + '<GraphSettings level="5%" smoothingHighResolution="1" contourHighResolution="1" histogramSmoothingCount="0" graphResolution="256" showOutliers="0" drawLargeDots="0" dotsToDraw="0" tint="le.chartfill.tinted.40" lineWeight="le.lineweight.normal" lineStyle="le.linestyle.solid"/>'
    + `<GraphEnvironment showGrid="0" showAxes="tnlTNL" showGates="1" showFreqOnPlots="1" showGateNameOnPlots="1" showMedians="0" showUncomped="0" addEventParam="0" lastYAxisName="">${TEXT_TRAITS}</GraphEnvironment>`
    + '</Graph>';
}

// The scale a FlowJo workspace is written with. FlowJo 11 reads neither logicle nor arcsinh scales
// (it misplaces gates on them, in FlowJo 10's own workspaces too) but reads FlowJo's biex, the
// default scale of FlowJo 10 and 11, so those are written as the closest biex. Gates drawn on
// them are then traced, like any gate drawn on another scale than the one written; rectangles,
// ranges and quadrants stay exact. An arcsinh is a logicle of width 0 (Parks et al. 2006).
export function flowJoScale(spec) {
  let biex = null;
  if (spec?.type === 'logicle') biex = logicleToBiex(spec);
  else if (spec?.type === 'arcsinh') {
    const c = spec.cofactor ?? 150;
    const T = spec.max ?? 262144;
    const min = spec.min ?? -c * Math.sinh(1);
    biex = logicleToBiex({ T, W: 0, M: Math.log10((2 * T) / c), A: Math.asinh(-min / c) / LN10 });
  } else if (spec?.type === 'fasinh') {
    biex = logicleToBiex({ T: spec.T ?? 262144, W: 0, M: spec.M ?? 4.5, A: spec.A ?? 0 });
  }
  if (!biex) return spec;
  try {
    createTransform(biex);
    return biex;
  } catch {
    return spec;
  }
}

// A CytoWeave transform as a FlowJo transform element: { local, attrs } (attrs without prefix),
// or { error }. `gain` is FlowJo units per stored unit (the time channel in seconds).
export function flowJoTransformXML(spec, gain = 1) {
  const type = spec?.type ?? 'linear';
  if (Number.isFinite(spec?.boundMin) || Number.isFinite(spec?.boundMax)) {
    return { error: 'FlowJo transforms have no bounds' };
  }
  switch (type) {
    case 'linear':
      return { local: 'linear', attrs: { minRange: (spec.min ?? 0) * gain, maxRange: (spec.max ?? 262144) * gain }, gain };
    case 'log': {
      const min = spec.min ?? 1;
      const max = spec.max ?? 262144;
      return { local: 'log', attrs: { offset: min, decades: Math.log10(max / min) } };
    }
    case 'logicle':
      return { local: 'logicle', attrs: { length: 256, T: spec.T, A: spec.A ?? 0, W: spec.W, M: spec.M } };
    case 'biex':
      return { local: 'biex', attrs: { length: 256, maxRange: spec.maxValue ?? 262144, neg: spec.extraNegativeDecades ?? 0, width: spec.widthBasis ?? -10, pos: spec.positiveDecades ?? 4.5 } };
    case 'arcsinh': {
      // asinh(x / c) rescaled to [min, max] is fasinh with T = max, M = asinh(max / c) / ln 10 and
      // A = −asinh(min / c) / ln 10: the same function, as in the Gating-ML export.
      const c = spec.cofactor ?? 150;
      const max = spec.max ?? 262144;
      const min = spec.min ?? -c * Math.sinh(1);
      return { local: 'fasinh', attrs: { length: 256, maxRange: max, T: max, M: Math.asinh(max / c) / LN10, A: -Math.asinh(min / c) / LN10 } };
    }
    case 'fasinh':
      return { local: 'fasinh', attrs: { length: 256, maxRange: spec.T ?? 262144, T: spec.T ?? 262144, M: spec.M ?? 4.5, A: spec.A ?? 0 } };
    case 'hyperlog':
      return { local: 'hyperlog', attrs: { length: 256, T: spec.T ?? 262144, W: spec.W ?? 0.5, M: spec.M ?? 4.5, A: spec.A ?? 0 } };
    default:
      return { error: `FlowJo has no "${type}" transform` };
  }
}

function transformElement(spec, parameter, gain) {
  const t = flowJoTransformXML(spec, gain);
  if (t.error) return null;
  const attrs = Object.entries(t.attrs).map(([k, v]) => `transforms:${k}="${num(v)}"`).join(' ');
  const extra = t.local === 'linear' ? ` gain="${num(t.gain ?? 1)}"` : '';
  return `<transforms:${t.local} ${attrs}${extra}><data-type:parameter data-type:name="${esc(parameter)}"/></transforms:${t.local}>`;
}

// The matrix a sample uses: the file's spillover, a workspace matrix, or none.
function sampleMatrix(ws, sample) {
  const id = sample.compensationId;
  if (!id || id === 'none') return null;
  if (id === 'file') {
    const spill = readSpillover(sample.keywords ?? {}, (sample.channels ?? []).map((c) => ({ name: c.name })));
    return spill && !spill.identity ? { name: 'Acquisition-defined', channels: spill.channels, matrix: Array.from(spill.matrix), file: true } : null;
  }
  const comp = ws.compensations.find((c) => c.id === id);
  return comp ? { name: comp.name, channels: comp.channels, matrix: Array.from(comp.matrix) } : null;
}

function matrixXML(matrix, id) {
  const n = matrix.channels.length;
  const params = matrix.channels.map((c) => `<data-type:parameter data-type:name="${esc(c)}" userProvidedCompInfix="${esc(PREFIX + c)}"/>`).join('');
  const rows = matrix.channels.map((from, i) => `<transforms:spillover data-type:parameter="${esc(from)}" userProvidedCompInfix="${esc(PREFIX + from)}">${matrix.channels.map((to, j) => `<transforms:coefficient data-type:parameter="${esc(to)}" transforms:value="${num(matrix.matrix[i * n + j])}"/>`).join('')}</transforms:spillover>`).join('');
  return `<transforms:spilloverMatrix spectral="0" prefix="${PREFIX}" name="${esc(matrix.name)}" editable="${matrix.file ? 0 : 1}" color="#c0c0c0" version="FlowJo-10.10.0" status="FINALIZED" transforms:id="${esc(id)}" suffix=""><data-type:parameters>${params}</data-type:parameters>${rows}</transforms:spilloverMatrix>`;
}

// Same scale: the same spec, or (for specs written differently) the same function. FlowJo's biex
// clamps beyond its ends, so identical biex specs are recognized by their key.
const sameScale = (a, b) => transformKey(a ?? {}) === transformKey(b ?? {}) || sameTransformFunction(a ?? {}, b ?? {});

const isTimeChannel = (channel) => channel?.type === 'time' || /^time$/i.test(channel?.name ?? '');

// Exports a workspace as FlowJo 10 XML.
// options: {
//   sampleIds: which samples (default all),
//   counts: (sample) => Map(gateId → count) | null, to fill FlowJo's count attributes,
//   keywords: (sample) => keywords to write (default: the sample's own; for de-identification),
//   fileName: (sample) => the FCS file name the DataSet refers to (default sample.fileName),
//   version: the CytoWeave version, date: a Date,
// }
// Returns { xml, report: { populations: [{ sample, path, status, detail }], warnings, summary } }.
export function exportFlowJo(ws, options = {}) {
  const samples = ws.samples.filter((s) => !options.sampleIds || options.sampleIds.includes(s.id));
  const populations = [];
  const warnings = [];
  let gateNumber = 0;
  const sampleIdOf = new Map(samples.map((s, i) => [s.id, String(i + 1)]));
  const matrices = new Map();

  const sampleXML = samples.map((sample) => {
    const channels = new Map((sample.channels ?? []).map((c) => [c.name, c]));
    const matrix = sampleMatrix(ws, sample);
    if (matrix) {
      const missing = matrix.channels.filter((c) => !channels.has(c));
      if (missing.length) warnings.push(`${sample.name}: the matrix "${matrix.name}" names channels the file does not have (${missing.join(', ')}).`);
    }
    const compensated = new Set(matrix?.channels ?? []);
    // FlowJo 11 evaluates a one-dimensional gate as empty, so ranges and splits are written as
    // rectangles whose second dimension is unbounded, on a scatter channel when there is one.
    const companionOf = (channel) => {
      const names = (sample.channels ?? []).filter((c) => c.name !== channel && !isTimeChannel(c)).map((c) => c.name);
      const pick = ['SSC-A', 'FSC-A'].find((n) => names.includes(n)) ?? names[0] ?? null;
      return pick && compensated.has(pick) ? `${PREFIX}${pick}` : pick;
    };
    const matrixId = matrix ? `${matrix.file ? 'file' : sample.compensationId}` : null;
    if (matrix && !matrices.has(matrixId)) matrices.set(matrixId, matrix);
    const timestep = Number.parseFloat(sample.keywords?.$TIMESTEP);
    const gainOf = (name) => (isTimeChannel(channels.get(name)) && timestep > 0 ? timestep : 1);
    const record = (path, status, detail) => populations.push({ sample: sample.name, sampleId: sample.id, path, status, detail });

    // The gates in this sample's tree, parents first.
    const applies = ws.gates.filter((g) => gateApplies(ws, g, sample.id));
    const byParent = new Map();
    for (const g of applies) {
      const key = g.parentId ?? null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(g);
    }

    // The FlowJo parameter of a gate dimension, or an error.
    const parameterOf = (dim) => {
      if (!channels.has(dim.channel)) {
        const d = (ws.derived ?? []).find((r) => r.outputs?.includes(dim.channel));
        if (d?.kind === 'formula' || d?.kind === 'ratio') return { error: `${dim.channel} is a formula channel, which this export does not write as a FlowJo derived parameter` };
        if (d?.kind === 'calibration') return { error: `${dim.channel} is a calibrated channel (${d.params.unit}), which this export does not write` };
        return { error: `${dim.channel} is a channel CytoWeave computed (FlowJo does not have it)` };
      }
      const comp = dim.compensation;
      let approx = null;
      if (comp && comp !== 'uncompensated' && comp !== sample.compensationId && !(comp === 'file' && matrix?.file)) {
        approx = `${dim.channel} uses its own compensation in CytoWeave; FlowJo uses the sample's`;
      }
      const isComp = compensated.has(dim.channel) && comp !== 'uncompensated';
      return { name: isComp ? `${PREFIX}${dim.channel}` : dim.channel, channel: dim.channel, approx };
    };

    // Pass 1: decide what is exported and how, and the transform each parameter is drawn on.
    const plan = new Map();
    const usage = new Map();
    const visit = (parentId, parentExported) => {
      for (const gate of byParent.get(parentId) ?? []) {
        let reason = null;
        if (!parentExported) reason = 'its parent population is not exported';
        else if (gate.type === 'category') reason = 'category gates (QC pass, barcodes, clusters) use channels FlowJo does not have';
        else if (gate.type === 'ellipsoid' || (gate.type === 'rectangle' && gate.dims.length !== 2)) reason = 'FlowJo has no gates of three or more dimensions';
        else if (gate.type !== 'boolean') {
          for (const dim of gate.dims) {
            const p = parameterOf(dim);
            if (p.error) {
              reason = p.error;
              break;
            }
          }
        }
        plan.set(gate.id, { gate, exported: !reason, reason });
        if (!reason && gate.type !== 'boolean') {
          for (const dim of gate.dims) {
            const p = parameterOf(dim);
            const key = JSON.stringify(dim.transform ?? {});
            if (!usage.has(p.name)) usage.set(p.name, new Map());
            const counts = usage.get(p.name);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
        visit(gate.id, !reason);
      }
    };
    visit(null, true);
    // Booleans need their operands exported in this sample's tree.
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of plan.values()) {
        if (!entry.exported) continue;
        const { gate } = entry;
        const deps = gate.type === 'boolean' ? gate.geometry.operands : [];
        const missing = deps.find((id) => !plan.get(id)?.exported);
        const parentLost = gate.parentId && !plan.get(gate.parentId)?.exported;
        if (missing || parentLost) {
          entry.exported = false;
          entry.reason = parentLost ? 'its parent population is not exported' : `it combines "${gateById(ws, missing)?.name ?? missing}", which is not exported`;
          changed = true;
        }
      }
    }

    // The transform of each FlowJo parameter: the one most of its gates were drawn on, else the
    // workspace's scale for the channel, else CytoWeave's default.
    const transformOf = new Map();
    const parameterNames = [];
    for (const [name, channel] of channels) {
      const variants = compensated.has(name) ? [name, `${PREFIX}${name}`] : [name];
      for (const parameter of variants) {
        const used = usage.get(parameter);
        let spec = null;
        if (used?.size) spec = JSON.parse([...used.entries()].sort((a, b) => b[1] - a[1])[0][0]);
        spec ??= ws.channelSettings?.[name]?.transform ?? defaultTransform(channel, sample.technology);
        spec = flowJoScale(spec);
        if (flowJoTransformXML(spec).error) {
          warnings.push(`${sample.name}: ${parameter} is shown on a scale FlowJo does not have (${flowJoTransformXML(spec).error}); it is written as linear.`);
          spec = { type: 'linear', min: 0, max: channel.range || 262144 };
        }
        transformOf.set(parameter, spec);
        parameterNames.push(parameter);
      }
    }

    // Pass 2: write the tree.
    const pathOf = new Map();
    const siblingNames = new Map();
    const nameFor = (gate, parentPath) => {
      let name = gate.name.replace(/\//g, '-');
      const key = parentPath;
      if (!siblingNames.has(key)) siblingNames.set(key, new Set());
      const used = siblingNames.get(key);
      if (used.has(name)) {
        let k = 2;
        while (used.has(`${name} (${k})`)) k += 1;
        name = `${name} (${k})`;
      }
      used.add(name);
      return name;
    };
    const counts = options.counts?.(sample) ?? null;
    const quadIds = new Map();

    // A rectangle's dimension. FlowJo writes both bounds, and FlowJo 11 evaluates a side left
    // open as selecting nothing (or does not import the gate): open sides are written far beyond
    // any data, which selects the same events. Polygon and ellipse dimensions have no bounds.
    const dimXML = (parameter, bounds = null) => {
      const side = (v, open) => ` gating:${open > 0 ? 'max' : 'min'}="${num(v === undefined || v === null ? open * UNBOUNDED : v)}"`;
      const attrs = bounds ? `${side(bounds.min, -1)}${side(bounds.max, 1)}` : '';
      return `<gating:dimension${attrs}><data-type:fcs-dimension data-type:name="${esc(parameter)}"/></gating:dimension>`;
    };
    const vertexXML = (coords) => `<gating:vertex>${coords.map((c) => `<gating:coordinate data-type:value="${num(c)}"/>`).join('')}</gating:vertex>`;

    // A gate element, its status and detail. Coordinates go from the gate's own scale to data
    // units (× the FlowJo gain of time channels).
    const gateElement = (gate, gid, eventsInside = 1) => {
      const geometry = effectiveGeometry(gate, sample.id);
      const dims = gate.dims.map((dim) => {
        const p = parameterOf(dim);
        const own = createTransform(dim.transform ?? { type: 'linear', min: 0, max: 1 });
        const shown = transformOf.get(p.name);
        const gain = gainOf(dim.channel);
        return { ...p, own, gain, same: sameScale(dim.transform, shown), toData: (s) => own.inverse(s) * gain };
      });
      const notes = dims.map((d) => d.approx).filter(Boolean);
      let status = notes.length ? 'approximated' : 'exact';
      const attrs = `eventsInside="${eventsInside}" annoOffsetX="0" annoOffsetY="0" tint="${esc(gate.color ?? '#000000')}" isTinted="${gate.color ? 1 : 0}" lineWeight="Normal" userDefined="1" percentX="0" percentY="0" gating:id="${gid}"`;
      const bound = (k, s) => (s === null || s === undefined ? null : dims[k].toData(s));
      let xml;
      switch (gate.type) {
        case 'rectangle':
          xml = `<gating:RectangleGate ${attrs}>${dimXML(dims[0].name, { min: bound(0, geometry.min?.[0]), max: bound(0, geometry.max?.[0]) })}${dimXML(dims[1].name, { min: bound(1, geometry.min?.[1]), max: bound(1, geometry.max?.[1]) })}</gating:RectangleGate>`;
          break;
        case 'range': {
          const other = companionOf(dims[0].channel);
          xml = `<gating:RectangleGate ${attrs}>${dimXML(dims[0].name, { min: bound(0, geometry.min), max: bound(0, geometry.max) })}${other ? dimXML(other, {}) : ''}</gating:RectangleGate>`;
          break;
        }
        case 'split': {
          const t = dims[0].toData(geometry.threshold);
          const other = companionOf(dims[0].channel);
          xml = `<gating:RectangleGate ${attrs}>${dimXML(dims[0].name, geometry.side === 'hi' ? { min: t } : { max: t })}${other ? dimXML(other, {}) : ''}</gating:RectangleGate>`;
          break;
        }
        case 'quadrant': {
          const [cx, cy] = geometry.center.map((c, k) => dims[k].toData(c));
          const q = geometry.quadrant;
          const x = q[1] === 'R' ? { min: cx } : { max: cx };
          const y = q[0] === 'U' ? { min: cy } : { max: cy };
          xml = `<gating:RectangleGate ${attrs}>${dimXML(dims[0].name, x)}${dimXML(dims[1].name, y)}</gating:RectangleGate>`;
          break;
        }
        case 'polygon': {
          let vertices = geometry.vertices;
          if (!dims[0].same || !dims[1].same) {
            // FlowJo draws straight edges on its own axes: trace each edge in the gate's scale.
            vertices = vertices.flatMap((a, i) => {
              const b = vertices[(i + 1) % vertices.length];
              return Array.from({ length: TRACE_STEPS }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / TRACE_STEPS, a[1] + ((b[1] - a[1]) * k) / TRACE_STEPS]);
            });
            status = 'approximated';
            notes.push(`drawn on a different scale than FlowJo will show; its edges are traced with ${vertices.length} vertices`);
          }
          xml = `<gating:PolygonGate ${attrs}>${dimXML(dims[0].name)}${dimXML(dims[1].name)}${vertices.map(([vx, vy]) => vertexXML([dims[0].toData(vx), dims[1].toData(vy)])).join('')}</gating:PolygonGate>`;
          break;
        }
        case 'ellipse': {
          const { center, radii, angle = 0 } = geometry;
          if (dims[0].same && dims[1].same && dims.every((d) => d.gain === 1)) {
            // FlowJo's display space is the scale space × 256: foci and the ends of both axes.
            let [a, b] = radii;
            let theta = angle;
            if (b > a) {
              [a, b] = [b, a];
              theta += Math.PI / 2;
            }
            const cos = Math.cos(theta);
            const sin = Math.sin(theta);
            const f = Math.sqrt(Math.max(0, a * a - b * b));
            const at = (u, v) => [256 * (center[0] + u * cos - v * sin), 256 * (center[1] + u * sin + v * cos)];
            const foci = [at(-f, 0), at(f, 0)];
            const edges = [at(a, 0), at(-a, 0), at(0, b), at(0, -b)];
            xml = `<gating:EllipsoidGate ${attrs}>${dimXML(dims[0].name)}${dimXML(dims[1].name)}<gating:foci>${foci.map(vertexXML).join('')}</gating:foci><gating:edge>${edges.map(vertexXML).join('')}</gating:edge></gating:EllipsoidGate>`;
          } else {
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const outline = Array.from({ length: ELLIPSE_VERTICES }, (_, k) => {
              const t = (2 * Math.PI * k) / ELLIPSE_VERTICES;
              const u = radii[0] * Math.cos(t);
              const v = radii[1] * Math.sin(t);
              return [center[0] + u * cos - v * sin, center[1] + u * sin + v * cos];
            });
            status = 'approximated';
            notes.push(`an ellipse on a different scale than FlowJo will show, written as a polygon of ${ELLIPSE_VERTICES} vertices`);
            xml = `<gating:PolygonGate ${attrs}>${dimXML(dims[0].name)}${dimXML(dims[1].name)}${outline.map(([vx, vy]) => vertexXML([dims[0].toData(vx), dims[1].toData(vy)])).join('')}</gating:PolygonGate>`;
          }
          break;
        }
        default:
          throw new Error(`${gate.type} gates cannot be exported`);
      }
      return { xml, status, detail: notes.join('; ') };
    };

    const graphXML = (gate) => {
      if (!gate || gate.type === 'boolean') return flowJoGraph();
      const axis = (k) => {
        const dim = gate.dims[k];
        return dim ? parameterOf(dim).name : '';
      };
      if (gate.dims.length === 1) return flowJoGraph('Pseudocolor', axis(0), companionOf(gate.dims[0].channel) ?? '');
      return flowJoGraph('Pseudocolor', axis(0), axis(1));
    };

    const countAttr = (gateId) => {
      const n = counts?.get(gateId);
      return Number.isFinite(n) ? ` count="${n}"` : '';
    };

    const writeChildren = (parentId, parentPath) => (byParent.get(parentId) ?? []).map((gate) => {
      const entry = plan.get(gate.id);
      const pathLabel = parentPath ? `${parentPath}/${gate.name}` : gate.name;
      if (gate.meta?.helper) {
        // Hidden helpers of imported "outside of" gates are written with the population that
        // uses them (eventsInside="0"); others become ordinary populations.
        const user = applies.find((g) => g.type === 'boolean' && g.geometry.op === 'not' && g.geometry.operands.length === 1 && g.geometry.operands[0] === gate.id && g.parentId === gate.parentId);
        if (user) return '';
      }
      if (!entry?.exported) {
        record(pathLabel, 'omitted', entry?.reason ?? 'not exported');
        return '';
      }
      const name = nameFor(gate, parentPath);
      const path = parentPath ? `${parentPath}/${name}` : name;
      pathOf.set(gate.id, path);
      const renamed = name !== gate.name ? `renamed "${name}" (FlowJo needs unique names without "/")` : '';
      gateNumber += 1;
      const gid = `ID${gateNumber}`;
      // A confirmed Cell Ontology term goes in FlowJo's annotation field.
      const annotation = gate.ontology?.status === 'confirmed' ? `${gate.ontology.id} ${gate.ontology.label}` : '';
      const common = `name="${esc(name)}" annotation="${esc(annotation)}" owningGroup="" expanded="1" sortPriority="10"${countAttr(gate.id)}`;
      let body;
      let status = 'exact';
      let detail = '';
      if (gate.type === 'boolean') {
        const op = gate.geometry.op;
        const helper = op === 'not' && gate.geometry.operands.length === 1 ? gateById(ws, gate.geometry.operands[0]) : null;
        if (helper?.meta?.helper && helper.parentId === gate.parentId && helper.type !== 'boolean') {
          // NOT of a hidden shape in the same parent: the events outside that shape.
          const el = gateElement(helper, gid, 0);
          status = el.status;
          detail = el.detail;
          body = `<Population ${common}>${graphXML(helper)}<Gate gating:id="${gid}">${el.xml}</Gate><Subpopulations>${writeChildren(gate.id, path)}</Subpopulations></Population>`;
        } else {
          const node = { and: 'AndNode', or: 'OrNode', not: 'NotNode' }[op];
          const dependents = gate.geometry.operands.map((id) => `<Dependent name="${esc(pathOf.get(id) ?? '')}"/>`).join('');
          if (gate.geometry.operands.some((id) => !pathOf.has(id))) {
            // An operand later in the tree than the Boolean: resolved after the walk.
            body = { deferred: true, gate, node, common, path };
          } else {
            body = `<${node} ${common}>${graphXML(null)}<Dependents>${dependents}</Dependents><Subpopulations>${writeChildren(gate.id, path)}</Subpopulations></${node}>`;
          }
        }
      } else {
        const el = gateElement(gate, gid);
        status = el.status;
        detail = el.detail;
        let wrapperAttrs = '';
        if (gate.type === 'quadrant' && gate.linkId) {
          if (!quadIds.has(gate.linkId)) quadIds.set(gate.linkId, `QUAD${quadIds.size + 1}`);
          wrapperAttrs = ` quadId="${quadIds.get(gate.linkId)}"`;
        }
        body = `<Population ${common}>${graphXML(gate)}<Gate gating:id="${gid}"${wrapperAttrs}>${el.xml}</Gate><Subpopulations>${writeChildren(gate.id, path)}</Subpopulations></Population>`;
      }
      record(pathLabel, status, [detail, renamed].filter(Boolean).join('; ') || (status === 'exact' ? 'exact' : ''));
      if (body?.deferred) {
        deferred.push(body);
        return `<!--deferred:${deferred.length - 1}-->`;
      }
      return body;
    }).join('');
    const deferred = [];
    let tree = writeChildren(null, '');
    // Booleans whose operands come later in the tree, now that every path is known (their own
    // children may hold more of them).
    for (let round = 0; round < 64 && /<!--deferred:\d+-->/.test(tree); round += 1) {
      tree = tree.replace(/<!--deferred:(\d+)-->/g, (_, i) => {
        const { gate, node, common, path } = deferred[Number(i)];
        const dependents = gate.geometry.operands.map((id) => `<Dependent name="${esc(pathOf.get(id) ?? '')}"/>`).join('');
        return `<${node} ${common}>${graphXML(null)}<Dependents>${dependents}</Dependents><Subpopulations>${writeChildren(gate.id, path)}</Subpopulations></${node}>`;
      });
    }

    const transforms = parameterNames.map((p) => transformElement(transformOf.get(p), p, gainOf(p.startsWith(PREFIX) ? p.slice(PREFIX.length) : p))).filter(Boolean).join('');
    const keywords = { ...(options.keywords ? options.keywords(sample) : sample.keywords ?? {}) };
    const fileName = options.fileName ? options.fileName(sample) : sample.fileName ?? `${sample.name}.fcs`;
    keywords.$FIL = fileName;
    keywords.$TOT = String(sample.eventCount ?? '');
    keywords.$PAR = String(sample.channels?.length ?? 0);
    (sample.channels ?? []).forEach((c, i) => {
      keywords[`$P${i + 1}N`] = c.name;
      keywords[`$P${i + 1}R`] = String(c.range ?? 262144);
      if (c.label) keywords[`$P${i + 1}S`] = c.label;
    });
    const keywordXML = Object.entries(keywords).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `<Keyword name="${esc(k)}" value="${esc(v)}"/>`).join('');
    // The sample's own plot shows its first gate, as FlowJo writes it (otherwise FlowJo 11 opens
    // the sample on its first channel against itself, with no gate drawn).
    const firstGate = (byParent.get(null) ?? []).find((g) => g.type !== 'boolean' && plan.get(g.id)?.exported);
    const sid = sampleIdOf.get(sample.id);
    // FlowJo names a sample after its file (as FlowKit expects); a renamed sample keeps its name.
    const stem = fileName.replace(/\.(fcs|lmd)$/i, '');
    const nodeName = sample.name === stem ? fileName : sample.name;
    return `<Sample>
    <DataSet uri="file:${esc(encodeURIComponent(fileName))}" sampleID="${sid}"/>
    ${matrix ? matrixXML(matrix, matrixId) : ''}
    <Transformations>${transforms}</Transformations>
    <Keywords>${keywordXML}</Keywords>
    <SampleNode name="${esc(nodeName)}" annotation="" owningGroup="" expanded="1" sortPriority="10" count="${sample.eventCount ?? 0}" sampleID="${sid}">${graphXML(firstGate)}<Subpopulations>${tree}</Subpopulations></SampleNode>
  </Sample>`;
  }).join('\n  ');

  const groupXML = (name, ids, builtIn = false) => `<GroupNode name="${esc(name)}" annotation="" owningGroup="${esc(name)}" expanded="0" sortPriority="10" count="-1">${flowJoGraph()}<Group name="${esc(name)}"${builtIn ? ' builtIn="1"' : ''}><Criteria/><SampleRefs>${ids.map((id) => `<SampleRef sampleID="${id}"/>`).join('')}</SampleRefs></Group><Subpopulations/></GroupNode>`;
  const groups = [groupXML('All Samples', samples.map((s) => sampleIdOf.get(s.id)), true)];
  for (const group of ws.groups ?? []) {
    const ids = group.sampleIds.map((id) => sampleIdOf.get(id)).filter(Boolean);
    if (ids.length) groups.push(groupXML(group.name, ids));
  }
  const date = options.date ?? new Date();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by CytoWeave${options.version ? ` ${esc(options.version)}` : ''} from the workspace "${esc(ws.name ?? '')}". -->
<Workspace version="20.0" modDate="${esc(date.toString())}" flowJoVersion="10.10.0" curGroup="All Samples" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
  <Matrices>${[...matrices.entries()].map(([id, m]) => matrixXML(m, id)).join('')}</Matrices>
  <Groups>
    ${groups.join('\n    ')}
  </Groups>
  <SampleList>
  ${sampleXML}
  </SampleList>
</Workspace>
`;
  const summary = { exact: 0, approximated: 0, omitted: 0 };
  for (const p of populations) summary[p.status] += 1;
  return { xml, report: { populations, warnings, summary } };
}
