// FlowJo v10 workspace (.wsp) import, best effort with an explicit fidelity report.
//
// FlowJo embeds Gating-ML 2.0 gate elements in its own workspace structure (SampleList → Sample
// → SampleNode → Subpopulations → Population → Gate), but stores gate coordinates in data units
// (compensated, untransformed), while CytoWeave stores them in the scale space of the transform
// the gate was drawn on. Every coordinate is therefore mapped through the sample's transform for
// the gate's channel (as FlowKit does when it converts FlowJo gates). FlowJo draws polygon edges
// straight on its display axes, which are those transforms, so mapped vertices reproduce a gate
// exactly whenever CytoWeave evaluates the same transform; axis-aligned gates (rectangles,
// ranges, quadrants) are exact under any monotone transform.
//
// Everything that is not reproduced exactly is reported: each population gets a fidelity entry
// ('imported' | 'approximated' | 'unsupported'), and FlowJo's own population counts are kept so
// CytoWeave's recomputed counts can be checked against them (compareFlowJoCounts).

import { attr, child, children, find, numberAttr, parseXMLDocument } from './xml.js';
import { createTransform } from './transforms.js';
import { newId, remapScale } from './gates.js';
import { ellipseFromCovariance } from './gatingml.js';

const POPULATION_NODES = ['Population', 'NotNode', 'OrNode', 'AndNode'];
const BOOLEAN_OPS = { AndNode: 'and', OrNode: 'or', NotNode: 'not' };
// FlowJo writes "no bound" as a missing attribute, but some versions write huge sentinels.
const OPEN_BOUND = 1e30;
// FlowJo numbers quadrants clockwise from the upper left.
const FLOWJO_QUADRANTS = { Q1: 'UL', Q2: 'UR', Q3: 'LR', Q4: 'LL' };

function isGateElement(el) {
  return el.local !== 'Gate' && (/Gate$/.test(el.local) || el.local === 'CurlyQuad');
}

function uriBaseName(uri) {
  if (!uri) return '';
  const last = uri.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// --- Transforms ---------------------------------------------------------------------------------

// A FlowJo transform element (transforms:linear, log, biex, logicle, fasinh, hyperlog) as
// { parameter, spec, status, detail }. Unsupported transforms fall back to a linear scale.
export function flowJoTransform(el, fallbackMax = 262144) {
  const n = (name, fallback) => numberAttr(el, name, null, undefined, { ignoreCase: true }) ?? fallback;
  const parameter = attr(child(el, 'parameter'), 'name') ?? attr(child(el, 'fcs-dimension'), 'name') ?? null;
  const maxRange = n('maxRange', fallbackMax);
  let spec;
  let status = 'imported';
  let detail = '';
  let unit = 1;
  switch (el.local) {
    case 'linear': {
      // FlowJo shows (and gates) gain × the stored value; importSample converts the coordinates.
      spec = { type: 'linear', min: n('minRange', 0), max: maxRange };
      const gain = n('gain', 1);
      if (gain > 0 && gain !== 1) unit = 1 / gain;
      break;
    }
    case 'log': {
      const offset = n('offset', 1);
      const decades = n('decades', Math.log10(maxRange));
      spec = offset > 0 && decades > 0 ? { type: 'log', min: offset, max: offset * 10 ** decades } : null;
      break;
    }
    case 'biex':
      // Reproduced exactly: CytoWeave builds FlowJo's own biex table (validation/README.md).
      spec = { type: 'biex', maxValue: maxRange, widthBasis: n('width', n('widthBasis', -10)), positiveDecades: n('pos', 4.42), extraNegativeDecades: n('neg', 0) };
      break;
    case 'logicle':
      // BD's published FlowJo logicle tables depart from the Moore–Parks reference at W > 0.4, but
      // FlowJo's own counts on real workspaces follow the reference more closely (an ellipse,
      // drawn in display space, is within 2% with the reference and 14% off with the tables'
      // curve; cytoweave-spec/research.md §3A.2), so the reference logicle is used.
      spec = { type: 'logicle', T: n('T', maxRange), W: n('W', 0.5), M: n('M', 4.5), A: n('A', 0) };
      break;
    case 'fasinh':
    case 'arcsinh':
      if (n('cofactor') !== undefined) spec = { type: 'arcsinh', cofactor: n('cofactor'), max: maxRange };
      else spec = { type: 'fasinh', T: n('T', maxRange), M: n('M', 4.5), A: n('A', 0) };
      break;
    case 'hyperlog':
      spec = { type: 'hyperlog', T: n('T', maxRange), W: n('W', 0.5), M: n('M', 4.5), A: n('A', 0) };
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
  if (!spec) {
    return {
      parameter,
      spec: { type: 'linear', min: 0, max: maxRange },
      status: 'unsupported',
      detail: `the FlowJo transform "${el.local}" ${detail || 'is not supported'}; a linear scale was used`,
    };
  }
  const out = { parameter, spec, status, detail };
  // Stored values per FlowJo unit (a linear axis with a gain); importSample converts to them.
  if (unit !== 1) out.unit = unit;
  return out;
}


// --- Compensation -------------------------------------------------------------------------------

// transforms:spilloverMatrix (FlowJo 10) or CompensationMatrix (older) as a CytoWeave compensation,
// plus FlowJo's naming of compensated parameters (prefix "Comp-" by default).
function parseCompensation(el, warnings, where) {
  const prefix = attr(el, 'prefix') ?? 'Comp-';
  const suffix = attr(el, 'suffix') ?? '';
  const name = attr(el, 'name') ?? 'FlowJo compensation';
  const rows = [...children(el, 'spillover'), ...children(el, 'Channel')].map((row) => ({
    from: attr(row, 'parameter') ?? attr(row, 'name'),
    values: [...children(row, 'coefficient'), ...children(row, 'ChannelValue')].map((c) => ({
      to: attr(c, 'parameter') ?? attr(c, 'name'),
      value: numberAttr(c, 'value'),
    })),
  }));
  let channels = children(child(el, 'parameters'), 'parameter').map((p) => attr(p, 'name')).filter(Boolean);
  if (!channels.length) channels = rows.map((r) => r.from).filter(Boolean);
  if (!channels.length || !rows.length) return null;
  const n = channels.length;
  const matrix = new Array(n * n).fill(0);
  for (let i = 0; i < n; i += 1) matrix[i * n + i] = 1;
  const missing = channels.filter((c) => !rows.some((r) => r.from === c));
  if (missing.length) warnings.push(`${where}: the compensation matrix "${name}" has no spillover row for ${missing.join(', ')} (no spillover assumed).`);
  for (const row of rows) {
    const i = channels.indexOf(row.from);
    if (i < 0) continue;
    for (const { to, value } of row.values) {
      const j = channels.indexOf(to);
      if (j < 0 || value === undefined) continue;
      matrix[i * n + j] = value;
    }
  }
  return {
    id: newId('c'),
    name,
    channels,
    matrix,
    source: 'imported',
    prefix,
    suffix,
    flowJoId: attr(el, 'id') ?? null,
  };
}

// FlowJo's name for a parameter → { channel, compensated }. FlowJo 10 prefixes compensated
// parameters ("Comp-FITC-A"); FlowJo 9 wrapped them in angle brackets ("<FITC-A>").
export function flowJoChannel(name, compensation = null) {
  const prefix = compensation?.prefix ?? 'Comp-';
  const suffix = compensation?.suffix ?? '';
  if ((prefix || suffix) && name.length > prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix)) {
    return { channel: name.slice(prefix.length, name.length - suffix.length), compensated: true };
  }
  if (name.startsWith('Comp-') && name.length > 5) return { channel: name.slice(5), compensated: true };
  const bracketed = /^<(.+)>$/.exec(name);
  if (bracketed) return { channel: bracketed[1], compensated: true };
  return { channel: name, compensated: false };
}

// --- Ellipses -----------------------------------------------------------------------------------

// The ellipse through four points that are the ends of two conjugate diameters (FlowJo's "edge"
// vertices are the ends of the major and minor axes). With conjugate semi-diameters u and v about
// the center c, the ellipse is { c + u cos t + v sin t }, whose shape matrix is u uᵀ + v vᵀ. An
// affine map of the axes keeps conjugate diameters conjugate, so this is exact for linear axes;
// `mismatch` (distance between the two diameters' midpoints over the major radius) measures how
// far a nonlinear axis transform bent the figure.
export function ellipseFromConjugateDiameters(points) {
  if (points.length !== 4) return null;
  const pairings = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
  let best = null;
  for (const [[a, b], [c, d]] of pairings) {
    const m1 = [(points[a][0] + points[b][0]) / 2, (points[a][1] + points[b][1]) / 2];
    const m2 = [(points[c][0] + points[d][0]) / 2, (points[c][1] + points[d][1]) / 2];
    const gap = Math.hypot(m1[0] - m2[0], m1[1] - m2[1]);
    if (!best || gap < best.gap) best = { gap, m1, m2, a, b, c, d };
  }
  const { gap, m1, m2, a, b, c, d } = best;
  const center = [(m1[0] + m2[0]) / 2, (m1[1] + m2[1]) / 2];
  const u = [(points[a][0] - points[b][0]) / 2, (points[a][1] - points[b][1]) / 2];
  const v = [(points[c][0] - points[d][0]) / 2, (points[c][1] - points[d][1]) / 2];
  const covariance = [
    [u[0] * u[0] + v[0] * v[0], u[0] * u[1] + v[0] * v[1]],
    [u[0] * u[1] + v[0] * v[1], u[1] * u[1] + v[1] * v[1]],
  ];
  const ellipse = ellipseFromCovariance(center, covariance, 1);
  if (!ellipse) return null;
  return { ellipse, mismatch: gap / ellipse.radii[0] };
}

// The ends of an ellipse's axes, for remapping it into another scale.
// A FlowJo ellipse from its foci and edge points (in scale space): the center between the foci,
// the major radius from the edge point farthest along the major axis, the minor radius from
// a² = b² + c² with c the focal distance.
export function ellipseFromFlowJo(foci, edges) {
  const center = [(foci[0][0] + foci[1][0]) / 2, (foci[0][1] + foci[1][1]) / 2];
  // The major axis' direction, in (−π/2, π/2] (the ellipse is the same turned by π).
  let angle = Math.atan2(foci[1][1] - foci[0][1], foci[1][0] - foci[0][0]);
  if (angle > Math.PI / 2) angle -= Math.PI;
  else if (angle <= -Math.PI / 2) angle += Math.PI;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const along = ([x, y]) => Math.abs((x - center[0]) * cos + (y - center[1]) * sin);
  const across = ([x, y]) => Math.abs(-(x - center[0]) * sin + (y - center[1]) * cos);
  const c = Math.hypot(foci[1][0] - foci[0][0], foci[1][1] - foci[0][1]) / 2;
  const a = Math.max(...edges.map((p) => Math.max(along(p), across(p))));
  const b = Math.sqrt(Math.abs(a * a - c * c));
  if (!(a > 0) || !(b > 0)) return null;
  return { center, radii: [a, b], angle };
}

function ellipseAxisEnds({ center, radii, angle = 0 }) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [
    [center[0] + radii[0] * cos, center[1] + radii[0] * sin],
    [center[0] - radii[0] * cos, center[1] - radii[0] * sin],
    [center[0] - radii[1] * sin, center[1] + radii[1] * cos],
    [center[0] + radii[1] * sin, center[1] - radii[1] * cos],
  ];
}

// --- Import -------------------------------------------------------------------------------------

// Imports a FlowJo workspace (text or bytes). Returns { version, flowJoVersion, samples, groups,
// warnings, fidelity }. Each sample: { name, uri, fileName, sampleId, keywords, groupNames,
// eventCount, compensation, transforms: { channel: spec }, gates, populationCounts: { path: n } }.
// Gates are CytoWeave gates in the sample's own scale spaces, with meta.flowJo = { path, … }.
export function importFlowJo(input, options = {}) {
  const doc = parseXMLDocument(input);
  const warnings = doc.warnings.map((w) => `XML: ${w}`);
  const { root } = doc;
  const sampleList = root.local === 'Workspace' ? child(root, 'SampleList') : find(root, 'SampleList');
  if (root.local !== 'Workspace' && !sampleList) throw new Error(`This is not a FlowJo workspace (its root element is <${root.name}>).`);
  const version = attr(root, 'version') ?? null;
  const flowJoVersion = attr(root, 'flowJoVersion') ?? null;
  if (version && Number.parseFloat(version) < 20) {
    warnings.push(`This workspace is in an older FlowJo format (version ${version}); CytoWeave reads FlowJo 10 workspaces, so gates may be missing.`);
  }
  const fidelity = [];
  const groups = [];
  for (const node of children(child(root, 'Groups'), 'GroupNode')) {
    const group = child(node, 'Group');
    const sampleIds = [...children(child(group, 'SampleRefs'), 'SampleRef'), ...children(child(node, 'SampleRefs'), 'SampleRef')]
      .map((ref) => attr(ref, 'sampleID'))
      .filter(Boolean);
    groups.push({ name: attr(node, 'name') ?? attr(group, 'name') ?? 'Group', sampleIds, builtIn: attr(group, 'builtIn') === '1' });
    if (children(child(node, 'Subpopulations'), POPULATION_NODES).length) {
      warnings.push(`Group "${attr(node, 'name')}" has template gates; CytoWeave reads each sample's own copy of them, and copies that agree become one shared gate (with sample-specific adjustments where they differ).`);
    }
  }
  const samples = children(sampleList, 'Sample').map((el, index) => importSample(el, index, { warnings, fidelity, options }));
  for (const sample of samples) {
    sample.groupNames = groups.filter((g) => g.sampleIds.includes(sample.sampleId)).map((g) => g.name);
  }
  if (!samples.length) warnings.push('The workspace lists no samples.');
  return { version, flowJoVersion, samples, groups, warnings, fidelity };
}

function importSample(el, index, { warnings, fidelity }) {
  const dataSet = child(el, 'DataSet');
  const sampleNode = child(el, 'SampleNode');
  const uri = attr(dataSet, 'uri') ?? '';
  const sampleId = attr(dataSet, 'sampleID') ?? attr(sampleNode, 'sampleID') ?? String(index + 1);
  const keywords = {};
  for (const keyword of children(child(el, 'Keywords'), 'Keyword')) {
    const key = attr(keyword, 'name');
    if (key) keywords[key.toUpperCase()] = attr(keyword, 'value') ?? '';
  }
  const fileName = uriBaseName(uri) || keywords.$FIL || '';
  const name = attr(sampleNode, 'name') ?? (keywords.$FIL || fileName || `Sample ${index + 1}`);
  const where = `Sample "${name}"`;
  const eventCount = numberAttr(sampleNode, 'count') ?? (Number.isFinite(Number(keywords.$TOT)) && keywords.$TOT !== '' ? Number(keywords.$TOT) : null);
  const record = (path, status, detail) => fidelity.push({ sample: name, sampleId, path, status, detail });

  // Compensation: a spilloverMatrix or CompensationMatrix outside the gating tree.
  let compensation = null;
  const outside = el.children.filter((c) => !['SampleNode', 'Keywords', 'Transformations', 'DataSet'].includes(c.local));
  for (const candidate of outside) {
    const matrixEl = ['spilloverMatrix', 'CompensationMatrix'].includes(candidate.local) ? candidate : find(candidate, ['spilloverMatrix', 'CompensationMatrix']);
    if (!matrixEl) continue;
    compensation = parseCompensation(matrixEl, warnings, where);
    if (compensation) break;
  }

  // Transforms by FlowJo parameter name.
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
  // FlowJo shows and gates a linear axis in gain × the stored value (the transform's gain), and
  // the time parameter in seconds: gain or, without one, $TIMESTEP × the stored value. CytoWeave
  // keeps stored values, so these scales and gate coordinates are converted by `unit` (stored
  // values per FlowJo unit). FlowJo's own counts confirm this on BD and FlowKit workspaces.
  const timestep = Number.parseFloat(keywords.$TIMESTEP);
  const timeChannels = new Set(Object.entries(keywords)
    .filter(([key, value]) => /^\$P\d+N$/.test(key) && (/^time$/i.test(value) || /^time$/i.test(keywords[key.replace(/N$/, 'TYPE')] ?? '')))
    .map(([, value]) => value));
  const unitOf = (channel, converted) => converted?.unit ?? (timestep > 0 && timestep !== 1 && timeChannels.has(channel) ? 1 / timestep : 1);
  const inStoredUnits = (channel, converted) => {
    const unit = unitOf(channel, converted);
    if (unit === 1) return converted;
    const { spec } = converted;
    if (spec.type === 'linear') return { ...converted, spec: { ...spec, min: (spec.min ?? 0) * unit, max: (spec.max ?? 262144) * unit }, unit };
    return { ...converted, unit, status: converted.status === 'unsupported' ? 'unsupported' : 'approximated', detail: [converted.detail, `the ${spec.type} time scale is drawn on stored time values rather than FlowJo's seconds`].filter(Boolean).join('; ') };
  };
  const byParameter = new Map();
  for (const t of child(el, 'Transformations')?.children ?? []) {
    const parameter = attr(child(t, 'parameter'), 'name') ?? attr(child(t, 'fcs-dimension'), 'name');
    if (!parameter) continue;
    const channelName = flowJoChannel(parameter, compensation).channel;
    const converted = inStoredUnits(channelName, flowJoTransform(t, rangeOf(channelName)));
    byParameter.set(parameter, converted);
    if (converted.status === 'unsupported') record(`transform:${parameter}`, 'unsupported', converted.detail);
  }
  const transforms = {};
  for (const [parameter, t] of byParameter) {
    const { channel, compensated } = flowJoChannel(parameter, compensation);
    if (compensated || !transforms[channel]) transforms[channel] = t.spec;
  }
  const transformFor = (parameter) => {
    const { channel, compensated } = flowJoChannel(parameter, compensation);
    const found = byParameter.get(parameter)
      ?? (compensated ? byParameter.get(`${compensation?.prefix ?? 'Comp-'}${channel}${compensation?.suffix ?? ''}`) : null)
      ?? byParameter.get(channel)
      ?? byParameter.get(`Comp-${channel}`);
    return found ?? { spec: { type: 'linear', min: 0, max: rangeOf(channel) }, status: 'imported', detail: '', unit: unitOf(channel) };
  };

  const gates = [];
  const populationCounts = {};
  const pathToGate = new Map();
  const gmlIdToPath = new Map();
  const pending = [];
  const linkGroups = new Map();
  const statusOf = new Map();

  const note = (path, status, detail) => {
    const current = statusOf.get(path);
    const rank = { imported: 0, approximated: 1, unsupported: 2 };
    if (!current) statusOf.set(path, { status, details: detail ? [detail] : [] });
    else {
      if (rank[status] > rank[current.status]) current.status = status;
      if (detail && !current.details.includes(detail)) current.details.push(detail);
    }
  };

  const convertGate = (gateEl, path) => {
    const details = [];
    let status = 'imported';
    const approximate = (detail) => {
      status = 'approximated';
      details.push(detail);
    };
    const dims = children(gateEl, 'dimension').map((d) => {
      const parameter = attr(child(d, 'fcs-dimension'), 'name') ?? attr(child(d, 'parameter'), 'name') ?? attr(d, 'name');
      if (!parameter) throw new Error('a gate dimension names no parameter');
      const { channel, compensated } = flowJoChannel(parameter, compensation);
      const t = transformFor(parameter);
      const transform = createTransform(t.spec);
      const unit = t.unit ?? 1;
      const forward = unit === 1 ? transform.forward : (v) => transform.forward(v * unit);
      return { parameter, channel, compensated, spec: { ...t.spec }, forward, t, bounds: [numberAttr(d, 'min', null, null), numberAttr(d, 'max', null, null)] };
    });
    if (!dims.length) throw new Error(`the ${gateEl.local} has no dimensions`);
    const axisAligned = gateEl.local === 'RectangleGate';
    for (const d of dims) {
      if (d.t.status === 'unsupported') {
        if (axisAligned) details.push(`${d.t.detail} (exact for this axis-aligned gate)`);
        else approximate(d.t.detail);
      } else if (d.t.status === 'approximated' && !axisAligned) {
        approximate(`${d.parameter}: ${d.t.detail}`);
      }
      if (d.compensated && !compensation) approximate(`"${d.parameter}" is compensated in FlowJo but the workspace holds no compensation matrix for this sample; assign the file's spillover matrix in CytoWeave`);
      // A gate FlowJo drew on uncompensated values keeps them (an uncompensated dimension).
      if (!d.compensated && compensation?.channels.includes(d.channel)) {
        d.uncompensated = true;
        details.push(`drawn on uncompensated ${d.channel}, which the gate keeps`);
      }
    }
    const toScale = (k, value, kind) => {
      const y = dims[k].forward(value);
      if (Number.isFinite(y)) return y;
      approximate(`${dims[k].parameter} = ${value} has no position on its ${dims[k].spec.type} scale; it was placed below the axis`);
      return kind === 'max' ? -1 : y > 0 ? 2 : -1;
    };
    const coordinates = (vertex) => children(vertex, 'coordinate').map((c) => numberAttr(c, 'value', null, Number.NaN));
    const out = { dims: dims.map((d) => (d.uncompensated ? { channel: d.channel, transform: d.spec, compensation: 'uncompensated' } : { channel: d.channel, transform: d.spec })), compensated: dims.map((d) => d.compensated) };
    switch (gateEl.local) {
      case 'PolygonGate': {
        if (dims.length !== 2) throw new Error(`a polygon needs 2 dimensions, not ${dims.length}`);
        const raw = children(gateEl, 'vertex').map(coordinates);
        if (raw.length < 3 || raw.some((v) => v.length < 2 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]))) throw new Error('the polygon has fewer than 3 valid vertices');
        out.type = 'polygon';
        out.geometry = { vertices: raw.map(([x, y]) => [toScale(0, x), toScale(1, y)]) };
        break;
      }
      case 'RectangleGate': {
        if (dims.length > 2) throw new Error(`a ${dims.length}-dimensional rectangle cannot be represented`);
        const bound = (k, which) => {
          const value = dims[k].bounds[which === 'min' ? 0 : 1];
          if (value === null || Math.abs(value) >= OPEN_BOUND) return null;
          const y = dims[k].forward(value);
          if (which === 'min' && y === -Infinity) return null; // below the scale: every event qualifies
          return Number.isFinite(y) ? y : toScale(k, value, which);
        };
        if (dims.length === 1) {
          out.type = 'range';
          out.geometry = { min: bound(0, 'min'), max: bound(0, 'max') };
        } else {
          out.type = 'rectangle';
          out.geometry = { min: [bound(0, 'min'), bound(1, 'min')], max: [bound(0, 'max'), bound(1, 'max')] };
        }
        break;
      }
      case 'EllipsoidGate': {
        if (dims.length !== 2) throw new Error(`an ellipse needs 2 dimensions, not ${dims.length}`);
        const edges = children(child(gateEl, 'edge'), 'vertex').map(coordinates);
        const foci = children(child(gateEl, 'foci'), 'vertex').map(coordinates);
        const mean = children(child(gateEl, 'mean'), 'coordinate').map((c) => numberAttr(c, 'value', null, Number.NaN));
        const valid = (points, n) => points.length === n && points.every((v) => v.length >= 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]));
        if (valid(edges, 4) && valid(foci, 2)) {
          // FlowJo keeps ellipses in its 256 × 256 display space, which is CytoWeave's scale space
          // times 256. The edge points' first pair ends the major axis; the minor radius follows
          // from the foci (as in FlowKit, which reproduces FlowJo's counts on its test ellipses).
          out.type = 'ellipse';
          out.geometry = ellipseFromFlowJo(foci.map(([x, y]) => [x / 256, y / 256]), edges.map(([x, y]) => [x / 256, y / 256]));
          if (!out.geometry) throw new Error('the ellipse foci and edge points do not define an ellipse');
        } else if (mean.length === 2) {
          // A Gating-ML style ellipsoid in data units: map its axis ends into scale space.
          const covariance = children(child(gateEl, 'covarianceMatrix'), 'row').map((row) => children(row, 'entry').map((c) => numberAttr(c, 'value', null, Number.NaN)));
          const d2 = numberAttr(child(gateEl, 'distanceSquare'), 'value', null, 1);
          const rawEllipse = covariance.length === 2 ? ellipseFromCovariance(mean, covariance, d2) : null;
          if (!rawEllipse) throw new Error('the ellipse has no usable edge points or covariance');
          const result = ellipseFromConjugateDiameters(ellipseAxisEnds(rawEllipse).map(([x, y]) => [toScale(0, x), toScale(1, y)]));
          if (!result) throw new Error('the ellipse could not be mapped to scale space');
          out.type = 'ellipse';
          out.geometry = result.ellipse;
          const linear = dims.every((d) => d.spec.type === 'linear');
          if (!linear) approximate('an ellipse defined in data units was mapped to the closest ellipse on its transformed axes');
        } else {
          throw new Error('the ellipse has neither edge points nor a mean and covariance');
        }
        break;
      }
      case 'CurlyQuad': {
        // Curly quadrants have curved dividers that CytoWeave cannot represent; straight bounds
        // (or the stored vertices) are the closest CytoWeave gate.
        if (dims.length !== 2) throw new Error('the curly quadrant does not have 2 dimensions');
        const raw = children(gateEl, 'vertex').map(coordinates).filter((v) => v.length >= 2 && v.every(Number.isFinite));
        if (raw.length >= 3) {
          out.type = 'polygon';
          out.geometry = { vertices: raw.map(([x, y]) => [toScale(0, x), toScale(1, y)]) };
        } else if (dims.some((d) => d.bounds[0] !== null || d.bounds[1] !== null)) {
          const b = (k, i) => (dims[k].bounds[i] === null || Math.abs(dims[k].bounds[i]) >= OPEN_BOUND ? null : dims[k].forward(dims[k].bounds[i]));
          out.type = 'rectangle';
          out.geometry = { min: [b(0, 0), b(1, 0)], max: [b(0, 1), b(1, 1)] };
        } else {
          throw new Error('FlowJo curly quadrants are not supported; redraw it as a quadrant gate');
        }
        approximate('a FlowJo curly quadrant (curved dividers) was imported with straight boundaries');
        break;
      }
      default:
        throw new Error(`the FlowJo gate type "${gateEl.local}" is not supported`);
    }
    out.status = status;
    out.details = details;
    return out;
  };

  const register = (gate, path, extra = {}) => {
    gate.meta.flowJo = { path, ...gate.meta.flowJo, ...extra };
    gates.push(gate);
  };

  const importPopulation = (node, path, name, parentId, parentPath) => {
    const wrapper = child(node, 'Gate');
    const gateEl = wrapper?.children.find(isGateElement) ?? node.children.find(isGateElement);
    if (!gateEl) {
      note(path, 'unsupported', 'the population has no gate definition');
      return null;
    }
    for (const id of [attr(wrapper, 'id'), attr(gateEl, 'id')]) if (id) gmlIdToPath.set(id, path);
    if (gateEl.local === 'BooleanGate') return importBoolean(node, path, name, parentId, parentPath, gateEl);
    if (gateEl.ns === null && (child(gateEl, 'Polygon') || attr(gateEl, 'xAxisName'))) {
      note(path, 'unsupported', 'this is a FlowJo 9 gate, which CytoWeave does not read; re-save the workspace in FlowJo 10');
      return null;
    }
    let converted;
    try {
      converted = convertGate(gateEl, path);
    } catch (error) {
      note(path, 'unsupported', error.message);
      return null;
    }
    const gate = {
      id: newId('g'),
      name,
      parentId,
      type: converted.type,
      dims: converted.dims,
      geometry: converted.geometry,
      scope: null,
      overrides: {},
      meta: { origin: 'imported', source: 'flowjo', compensated: converted.compensated },
    };
    const tint = attr(gateEl, 'tint');
    if (tint && attr(gateEl, 'isTinted') === '1') gate.color = tint;
    note(path, converted.status, converted.details.join('; '));
    // Linked quadrants (quadId) and bisectors, resolved once the sample is read.
    const quadId = attr(wrapper, 'quadId') ?? attr(gateEl, 'quadId');
    const bisectorKey = [wrapper, gateEl].flatMap((e) => Object.keys(e?.attrs ?? {})).find((k) => /bisect/i.test(k));
    const bisectorId = bisectorKey ? (attr(wrapper, bisectorKey) ?? attr(gateEl, bisectorKey)) : null;
    if (quadId && gate.type === 'rectangle') {
      const key = `quad|${parentPath}|${quadId}`;
      if (!linkGroups.has(key)) linkGroups.set(key, []);
      linkGroups.get(key).push(gate);
      gate.meta.flowJo = { linkKey: key };
    } else if (bisectorId && gate.type === 'range') {
      const key = `bisector|${parentPath}|${bisectorId}`;
      if (!linkGroups.has(key)) linkGroups.set(key, []);
      linkGroups.get(key).push(gate);
      gate.meta.flowJo = { linkKey: key };
    }
    const eventsInside = attr(gateEl, 'eventsInside');
    if (eventsInside === '0' || eventsInside === 'false') {
      // The population is the events outside the shape: the shape becomes a hidden helper and
      // the population a "not" of it (CytoWeave's not = parent − operand).
      gate.name = `${name} (outside of)`;
      gate.meta.helper = true;
      register(gate, path, { key: `helper:${path}` });
      const outsideGate = {
        id: newId('g'),
        name,
        parentId,
        type: 'boolean',
        dims: [],
        geometry: { op: 'not', operands: [gate.id] },
        scope: null,
        overrides: {},
        meta: { origin: 'imported', source: 'flowjo' },
      };
      register(outsideGate, path, { key: path });
      note(path, 'imported', 'events outside the gate (eventsInside="0"), expressed as NOT of the gate shape');
      return outsideGate.id;
    }
    register(gate, path, { key: path });
    return gate.id;
  };

  const importBoolean = (node, path, name, parentId, parentPath, booleanEl = null) => {
    let op = BOOLEAN_OPS[node.local] ?? null;
    let refs = [];
    const dependents = children(child(node, 'Dependents'), 'Dependent').map((d) => attr(d, 'name')).filter(Boolean);
    const gateEl = booleanEl ?? find(child(node, 'Gate'), 'BooleanGate');
    if (gateEl) {
      const opEl = gateEl.children.find((c) => ['and', 'or', 'not'].includes(c.local));
      if (opEl) {
        op = opEl.local;
        refs = children(opEl, 'gateReference').map((r) => ({ ref: attr(r, 'ref'), complement: String(attr(r, 'use-as-complement') ?? '').toLowerCase() === 'true' }));
      }
    }
    if (!op) {
      note(path, 'unsupported', 'the boolean population has no operator');
      return null;
    }
    if (!dependents.length && !refs.length) {
      note(path, 'unsupported', 'the boolean population names no gates');
      return null;
    }
    const gate = {
      id: newId('g'),
      name,
      parentId,
      type: 'boolean',
      dims: [],
      geometry: { op, operands: [] },
      scope: null,
      overrides: {},
      meta: { origin: 'imported', source: 'flowjo' },
    };
    register(gate, path, { key: path });
    pending.push({ gate, path, parentPath, dependents, refs });
    note(path, 'imported', '');
    return gate.id;
  };

  const walk = (subpopulations, parentPath, parentId, parentLost) => {
    for (const node of subpopulations?.children ?? []) {
      if (!POPULATION_NODES.includes(node.local)) continue;
      const name = attr(node, 'name') ?? '(unnamed)';
      let path = parentPath ? `${parentPath}/${name}` : name;
      if (statusOf.has(path)) {
        let k = 2;
        while (statusOf.has(`${path} #${k}`)) k += 1;
        warnings.push(`${where}: two populations are both called "${path}"; the second is "${path} #${k}".`);
        path = `${path} #${k}`;
      }
      const count = numberAttr(node, 'count');
      if (count !== undefined) populationCounts[path] = count;
      let id = null;
      if (parentLost) note(path, 'unsupported', 'its parent population could not be imported');
      else if (node.local === 'Population') id = importPopulation(node, path, name, parentId, parentPath);
      else id = importBoolean(node, path, name, parentId, parentPath);
      if (id) pathToGate.set(path, id);
      walk(child(node, 'Subpopulations'), path, id, parentLost || !id);
    }
  };
  walk(child(sampleNode, 'Subpopulations'), '', null, false);

  // Quadrant groups: four rectangles, each open on its outer sides, that share a corner.
  for (const [key, members] of linkGroups) {
    const linkId = newId(key.startsWith('quad') ? 'q' : 's');
    if (key.startsWith('quad')) {
      const sameDims = members.every((g) => JSON.stringify(g.dims) === JSON.stringify(members[0].dims));
      let center = null;
      const labels = [];
      let ok = sameDims;
      for (const g of members) {
        if (!ok) break;
        const { min, max } = g.geometry;
        const sides = [0, 1].map((k) => ((min[k] === null) === (max[k] === null) ? null : min[k] !== null ? 'hi' : 'lo'));
        if (sides.includes(null)) {
          ok = false;
          break;
        }
        const corner = [0, 1].map((k) => (sides[k] === 'hi' ? min[k] : max[k]));
        if (center && (Math.abs(center[0] - corner[0]) > 1e-12 || Math.abs(center[1] - corner[1]) > 1e-12)) ok = false;
        center ??= corner;
        labels.push(`${sides[1] === 'hi' ? 'U' : 'L'}${sides[0] === 'hi' ? 'R' : 'L'}`);
      }
      if (ok && new Set(labels).size === labels.length) {
        // FlowJo's quadId differs between samples; the parent and member names identify the set.
        const stable = `quad|${key.split('|')[1]}|${members.map((g) => g.name).sort().join('|')}`;
        members.forEach((g, i) => {
          g.type = 'quadrant';
          g.geometry = { center: center.slice(), quadrant: labels[i] };
          g.linkId = linkId;
          g.meta.flowJo.linkKey = stable;
        });
      } else {
        for (const g of members) note(g.meta.flowJo.path, 'imported', 'a FlowJo quadrant whose parts do not share one corner was kept as separate rectangles');
      }
    } else {
      const thresholds = members.map((g) => ((g.geometry.min === null) === (g.geometry.max === null) ? null : g.geometry.min ?? g.geometry.max));
      const sameDims = members.every((g) => JSON.stringify(g.dims) === JSON.stringify(members[0].dims));
      if (sameDims && thresholds.every((t) => t !== null && Math.abs(t - thresholds[0]) < 1e-12)) {
        const stable = `bisector|${key.split('|')[1]}|${members.map((g) => g.name).sort().join('|')}`;
        for (const g of members) {
          g.geometry = g.geometry.min === null ? { threshold: thresholds[0], side: 'lo' } : { threshold: thresholds[0], side: 'hi' };
          g.type = 'split';
          g.linkId = linkId;
          g.meta.flowJo.linkKey = stable;
        }
      }
    }
  }
  // Quadrants named Q1–Q4 by FlowJo: check the naming agrees with the geometry.
  for (const g of gates) {
    const label = /^(Q[1-4])\b/.exec(g.name)?.[1];
    if (g.type === 'quadrant' && label && FLOWJO_QUADRANTS[label] !== g.geometry.quadrant) {
      note(g.meta.flowJo.path, 'imported', `named ${label} by FlowJo but it is the ${g.geometry.quadrant} quadrant of its axes`);
    }
  }

  // Boolean operands, by population path (FlowJo's Dependents) or gate id (BooleanGate refs).
  const resolve = (dependent, parentPath, ownPath) => {
    let target = dependent.trim();
    if (target.startsWith('/')) target = target.slice(1);
    // Some versions spell out the sample node as the first path element.
    if (target.startsWith(`${name}/`) && !pathToGate.has(target)) target = target.slice(name.length + 1);
    if (target.startsWith('../') || target.startsWith('./')) {
      // Relative to the boolean population itself ("../CD3+" is a sibling), else to its parent.
      for (const from of [ownPath, parentPath]) {
        const parts = from ? from.split('/') : [];
        for (const part of target.split('/')) {
          if (part === '..') parts.pop();
          else if (part !== '.' && part !== '') parts.push(part);
        }
        if (pathToGate.has(parts.join('/'))) return { path: parts.join('/') };
      }
      return null;
    }
    if (pathToGate.has(target)) return { path: target };
    const relative = parentPath ? `${parentPath}/${target}` : target;
    if (pathToGate.has(relative)) return { path: relative };
    const matches = [...pathToGate.keys()].filter((p) => p === target || p.endsWith(`/${target}`));
    if (matches.length === 1) return { path: matches[0] };
    if (matches.length > 1) {
      // Prefer the match closest to the boolean gate in the tree.
      matches.sort((a, b) => sharedDepth(b, parentPath) - sharedDepth(a, parentPath) || a.length - b.length);
      return { path: matches[0], ambiguous: matches.length };
    }
    return null;
  };
  const failed = new Set();
  const helpers = new Map();
  for (const item of pending) {
    const operands = [];
    const operandPaths = [];
    for (const dependent of item.dependents) {
      const found = resolve(dependent, item.parentPath, item.path);
      if (!found) {
        note(item.path, 'unsupported', `the boolean gate refers to "${dependent}", which is not in this sample's gating tree`);
        failed.add(item.gate.id);
        continue;
      }
      if (found.ambiguous) note(item.path, 'approximated', `"${dependent}" matches ${found.ambiguous} populations; "${found.path}" was used`);
      operands.push(pathToGate.get(found.path));
      operandPaths.push(found.path);
    }
    for (const { ref, complement } of item.refs) {
      const path = gmlIdToPath.get(ref);
      if (!path || !pathToGate.has(path)) {
        note(item.path, 'unsupported', `the boolean gate refers to the unknown gate id "${ref}"`);
        failed.add(item.gate.id);
        continue;
      }
      let id = pathToGate.get(path);
      if (complement) {
        let helper = helpers.get(id);
        if (!helper) {
          helper = {
            id: newId('g'),
            name: `NOT ${path.split('/').pop()}`,
            parentId: null,
            type: 'boolean',
            dims: [],
            geometry: { op: 'not', operands: [id] },
            scope: null,
            overrides: {},
            meta: { origin: 'imported', source: 'flowjo', helper: true, flowJo: { path, key: `complement:${path}` } },
          };
          helpers.set(id, helper);
          gates.push(helper);
        }
        id = helper.id;
      }
      operands.push(id);
      operandPaths.push(complement ? `NOT ${path}` : path);
    }
    if (item.gate.geometry.op === 'not' && operands.length > 1) note(item.path, 'imported', 'NOT of several populations excludes all of them');
    item.gate.geometry.operands = operands;
    item.gate.meta.flowJo.operandPaths = operandPaths;
  }

  // Drop booleans that could not be resolved, and everything that depends on them.
  let changed = failed.size > 0;
  while (changed) {
    changed = false;
    for (const g of gates) {
      if (failed.has(g.id)) continue;
      const deps = [g.parentId, ...(g.type === 'boolean' ? g.geometry.operands : [])];
      if (deps.some((d) => d && failed.has(d))) {
        failed.add(g.id);
        if (!g.meta.helper) note(g.meta.flowJo.path, 'unsupported', 'it depends on a population that could not be imported');
        changed = true;
      }
    }
  }
  const kept = gates.filter((g) => !failed.has(g.id));

  for (const [path, { status, details }] of statusOf) {
    record(path, status, details.length ? details.join('; ') : status === 'imported' ? 'exact' : '');
  }
  return {
    name,
    uri,
    fileName,
    sampleId,
    keywords,
    groupNames: [],
    eventCount,
    compensation,
    transforms,
    gates: kept,
    populationCounts,
  };
}

function sharedDepth(a, b) {
  const x = a.split('/');
  const y = (b ?? '').split('/');
  let k = 0;
  while (k < x.length && k < y.length && x[k] === y[k]) k += 1;
  return k;
}

// --- Merging samples into one gate tree ---------------------------------------------------------

function roundedJSON(value) {
  return JSON.stringify(value, (key, v) => (typeof v === 'number' ? +v.toPrecision(12) : v));
}

// Re-expresses a geometry from one set of dimension transforms in another. Axis-aligned shapes
// map exactly (their edges are level sets of one coordinate); polygon edges and ellipses are
// straight or elliptic in only one of the two spaces, so those are approximations.
export function remapGeometry(type, geometry, fromDims, toDims) {
  // A biex scale clamps the data beyond its ends to them, so an end stands for everything beyond
  // it and maps to the same end of another biex scale.
  const atEnd = (k, v) => fromDims[k].transform.type === 'biex' && toDims[k].transform.type === 'biex' && (v <= 0 || v >= 1);
  const map = (k, v) => (v === null || v === undefined ? v : atEnd(k, v) ? v : remapScale(v, fromDims[k].transform, toDims[k].transform));
  switch (type) {
    case 'polygon': return { geometry: { vertices: geometry.vertices.map(([x, y]) => [map(0, x), map(1, y)]) }, exact: false };
    case 'rectangle': return { geometry: { min: [map(0, geometry.min[0]), map(1, geometry.min[1])], max: [map(0, geometry.max[0]), map(1, geometry.max[1])] }, exact: true };
    case 'range': return { geometry: { min: map(0, geometry.min), max: map(0, geometry.max) }, exact: true };
    case 'split': return { geometry: { ...geometry, threshold: map(0, geometry.threshold) }, exact: true };
    case 'quadrant': return { geometry: { ...geometry, center: [map(0, geometry.center[0]), map(1, geometry.center[1])] }, exact: true };
    case 'ellipse': {
      const result = ellipseFromConjugateDiameters(ellipseAxisEnds(geometry).map(([x, y]) => [map(0, x), map(1, y)]));
      return { geometry: result ? result.ellipse : geometry, exact: false };
    }
    default: return { geometry, exact: true };
  }
}

// Builds one CytoWeave gate tree from several imported samples (typically a FlowJo group). A
// population whose gate is the same in every sample becomes one gate; where samples differ, the
// most common geometry is the gate's and the others become per-sample `overrides`, keyed by
// options.keyOf(sample) (default: FlowJo's sampleID; a null key means the sample has no
// CytoWeave counterpart, so its adjustment is not kept). Geometry drawn under a different
// transform is re-expressed in the shared gate's transform. A population present in only some of
// its parent's samples asks options.scopeFor(presentSamples) for a { scope, name } (a group with
// exactly those samples); otherwise it is reported. Returns { gates, warnings, fidelity }; each
// merged gate's meta has flowJoPath, flowJoKey and the number of samples that define it.
export function mergeFlowJoGates(samples, options = {}) {
  const keyOf = options.keyOf ?? ((s) => s.sampleId ?? s.name);
  const warnings = [];
  const fidelity = [];
  const order = [];
  const definitions = new Map();
  for (const sample of samples) {
    const byId = new Map(sample.gates.map((g) => [g.id, g]));
    for (const gate of sample.gates) {
      const key = gate.meta?.flowJo?.key ?? gate.meta?.flowJo?.path ?? gate.name;
      if (!definitions.has(key)) {
        definitions.set(key, []);
        order.push(key);
      }
      definitions.get(key).push({ sample, gate, byId });
    }
  }
  const keyOfGate = (entry, id) => {
    const g = entry.byId.get(id);
    return g ? (g.meta?.flowJo?.key ?? g.meta?.flowJo?.path ?? g.name) : null;
  };
  const mergedIds = new Map(order.map((key) => [key, newId('g')]));
  const linkIds = new Map();
  const gates = [];
  for (const key of order) {
    const entries = definitions.get(key);
    const path = entries[0].gate.meta?.flowJo?.path ?? key;
    const report = (status, detail) => fidelity.push({ path, status, detail });
    const structure = (e) => roundedJSON([
      e.gate.type,
      e.gate.dims.map((d) => d.channel),
      e.gate.type === 'boolean' ? [e.gate.geometry.op, e.gate.geometry.operands.map((id) => keyOfGate(e, id))] : null,
      e.gate.type === 'quadrant' ? e.gate.geometry.quadrant : e.gate.type === 'split' ? e.gate.geometry.side : null,
      e.gate.parentId ? keyOfGate(e, e.gate.parentId) : null,
    ]);
    const tally = (values) => {
      const counts = new Map();
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };
    const majority = tally(entries.map(structure));
    const agreeing = entries.filter((e) => structure(e) === majority);
    for (const e of entries) {
      if (structure(e) !== majority) report('approximated', `sample "${e.sample.name}" defines this population differently (${e.gate.type} on ${e.gate.dims.map((d) => d.channel).join(' × ') || 'other populations'}); the shared definition is used for it`);
    }
    const dimsKey = (e) => roundedJSON(e.gate.dims);
    const baseDimsKey = tally(agreeing.map(dimsKey));
    const base = agreeing.find((e) => dimsKey(e) === baseDimsKey);
    const geometries = agreeing.map((e) => {
      if (dimsKey(e) === baseDimsKey || e.gate.type === 'boolean') return { e, geometry: e.gate.geometry };
      const { geometry, exact } = remapGeometry(e.gate.type, e.gate.geometry, e.gate.dims, base.gate.dims);
      report(exact ? 'imported' : 'approximated', `sample "${e.sample.name}" draws this gate on different transforms; its geometry was re-expressed on the shared ones${exact ? ' (exact for this gate type)' : ' (edges may shift slightly)'}`);
      return { e, geometry };
    });
    const shared = tally(geometries.map((g) => roundedJSON(g.geometry)));
    const sharedGeometry = geometries.find((g) => roundedJSON(g.geometry) === shared).geometry;
    const overrides = {};
    if (base.gate.type !== 'boolean') {
      const unkeyed = [];
      for (const { e, geometry } of geometries) {
        if (roundedJSON(geometry) === shared) continue;
        const sampleKey = keyOf(e.sample);
        if (sampleKey === null || sampleKey === undefined) unkeyed.push(e.sample.name);
        else overrides[sampleKey] = geometry;
      }
      if (unkeyed.length) report('imported', `the adjustment for ${unkeyed.join(', ')} was not kept (no matching CytoWeave sample)`);
    }
    const g = base.gate;
    const parentKey = g.parentId ? keyOfGate(base, g.parentId) : null;
    // Populations missing from some of their parent's samples (FlowJo group-specific gates).
    let scoped = null;
    const parentSamples = parentKey && definitions.has(parentKey) ? new Set(definitions.get(parentKey).map((e) => e.sample)) : new Set(samples);
    const present = new Set(entries.map((e) => e.sample));
    const absent = [...parentSamples].filter((s) => !present.has(s));
    if (absent.length) {
      scoped = options.scopeFor?.(entries.map((e) => e.sample)) ?? null;
      if (scoped) report('imported', `applies to the group "${scoped.name}" only, as in FlowJo`);
      else report('approximated', `absent from ${absent.length} sample(s) (${absent.map((s) => s.name).join(', ')}); the merged gate applies to them too`);
    }
    const merged = {
      id: mergedIds.get(key),
      name: g.name,
      parentId: parentKey ? mergedIds.get(parentKey) ?? null : null,
      type: g.type,
      dims: g.dims.map((d) => ({ channel: d.channel, transform: { ...d.transform } })),
      geometry: g.type === 'boolean'
        ? { op: g.geometry.op, operands: g.geometry.operands.map((id) => mergedIds.get(keyOfGate(base, id))).filter(Boolean) }
        : sharedGeometry,
      scope: scoped?.scope ?? options.scope ?? null,
      overrides,
      meta: { origin: 'imported', source: 'flowjo', flowJoPath: path, flowJoKey: key, samples: entries.length },
    };
    if (g.meta?.helper) merged.meta.helper = true;
    if (g.color) merged.color = g.color;
    if (g.linkId) {
      const linkKey = g.meta?.flowJo?.linkKey ?? g.linkId;
      if (!linkIds.has(linkKey)) linkIds.set(linkKey, newId(g.type === 'quadrant' ? 'q' : 's'));
      merged.linkId = linkIds.get(linkKey);
    }
    if (Object.keys(overrides).length) report('imported', `${Object.keys(overrides).length} sample(s) have their own adjustment of this gate`);
    gates.push(merged);
  }
  return { gates, warnings, fidelity };
}

// Compares FlowJo's population counts with CytoWeave's ({ path: count } both). A count agrees
// when it differs by at most max(absolute, relative × FlowJo count) events (defaults 1 and 0.5%),
// which allows for boundary events and FlowJo's display-resolution gate rasterization.
export function compareFlowJoCounts(flowJoCounts, counts, options = {}) {
  const absolute = options.absolute ?? 1;
  const relative = options.relative ?? 0.005;
  return Object.entries(flowJoCounts).map(([path, flowjo]) => {
    const cytoweave = counts[path];
    if (cytoweave === undefined || !Number.isFinite(cytoweave)) return { path, flowjo, cytoweave: null, difference: null, relative: null, agree: false };
    const difference = cytoweave - flowjo;
    return {
      path,
      flowjo,
      cytoweave,
      difference,
      relative: flowjo ? difference / flowjo : (difference ? Infinity : 0),
      agree: Math.abs(difference) <= Math.max(absolute, relative * flowjo),
    };
  });
}
