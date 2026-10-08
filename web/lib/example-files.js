// Files other programs would have written for the simulated examples: a FACSDiva experiment
// (XML), a SpectroFlo experiment (.Expt), a FlowJo 11 workbench (.flowjo) and events as CSV. They
// come with an example (examples.js, result.attachments) so that each import can be tried on data
// whose truth is known. Each holds what CytoWeave's importer reads (diva.js, spectroflo.js,
// flowjo11.js, csv-events.js), in the form those programs write it, with the counts the program
// would report computed here from the files by its own rules, independently of CytoWeave's gates.

import { createTransform } from './transforms.js';
import { inverse } from './linalg.js';
import { divaLogicle } from './diva.js';

const xml = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const T = 262144;

// Whether (x, y) is inside a polygon or on its edge.
function inPolygon(x, y, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i, i += 1) {
    const [xi, yi] = vertices[i];
    const [xj, yj] = vertices[j];
    const cross = (x - xj) * (yi - yj) - (y - yj) * (xi - xj);
    if (Math.abs(cross) < 1e-12 && x >= Math.min(xi, xj) && x <= Math.max(xi, xj) && y >= Math.min(yi, yj) && y <= Math.max(yi, yj)) return true;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// --- FACSDiva ---------------------------------------------------------------------------------
//
// gates: [{ name, parent (a name, or null for All Events), kind: 'polygon' | 'rectangle' |
// 'interval', x, y, points: [[x, y]] in data values }], drawn on linear axes for scatter and on
// Diva's biexponential axes (scale value scales[channel]) for fluorescence, on compensated values.
// tubes: [{ specimen, name, fileName, columns ({ channel: Float32Array }, uncompensated),
// eventCount }]. Diva counts on its 256-step display grid, an event in when its grid point is
// inside the region or on its edge (validation/diva-cases.mjs), clamping values beyond an axis'
// ends to them.
export function divaExperiment({ name, version = '9.0.1', spill, scales, parameters, tubes, gates }) {
  const n = spill.channels.length;
  // Each compensated parameter's coefficients: its column of the inverse of the spillover matrix.
  const C = inverse(Float64Array.from(spill.matrix), n);
  const fluorescent = new Set(spill.channels);
  const axis = (channel) => (fluorescent.has(channel)
    ? { scaled: true, value: scales[channel], t: createTransform(divaLogicle(scales[channel])), toStored: (s) => s * 4096 }
    : { scaled: false, t: createTransform({ type: 'linear', min: 0, max: T }), toStored: (s) => s * T });
  const settingsXML = `<instrument_settings name="Cytometer Settings"><compensation_enabled>true</compensation_enabled><use_auto_biexp_scale>false</use_auto_biexp_scale>${parameters.map((p) => {
    const i = spill.channels.indexOf(p);
    const coefficients = i >= 0 ? `<compensation>${spill.channels.map((_, row) => `<compensation_coefficient>${+C[row * n + i].toPrecision(9)}</compensation_coefficient>`).join('')}</compensation>` : '';
    return `<parameter name="${xml(p)}"><is_log>false</is_log><min>0</min><max>262143</max><can_be_compensated>${i >= 0}</can_be_compensated>${i >= 0 ? `<manual_biexp_scale>${scales[p]}</manual_biexp_scale>` : ''}${coefficients}</parameter>`;
  }).join('')}</instrument_settings>`;
  const fullname = new Map();
  for (const g of gates) fullname.set(g.name, `${g.parent ? fullname.get(g.parent) : 'All Events'}\\${g.name}`);
  const regionType = { polygon: 'POLYGON_REGION', rectangle: 'RECTANGLE_REGION', interval: 'INTERVAL_REGION' };
  // Each gate's region in stored units (grid-free, as Diva stores it) and in scale space.
  const regions = gates.map((g) => {
    const ax = axis(g.x);
    const ay = g.y ? axis(g.y) : null;
    const scaled = g.points.map(([x, y]) => [ax.t.forward(x), ay ? ay.t.forward(y) : 0]);
    return { g, ax, ay, scaled, stored: scaled.map(([x, y]) => [ax.toStored(x), ay ? ay.toStored(y) : 0]) };
  });
  const tubeXML = tubes.map((tube) => {
    const counts = divaCounts(tube, spill, regions);
    const gatesXML = [`<gate type="EventSource_Classifier" fullname="All Events"><name>All Events</name><num_events>${tube.eventCount}</num_events></gate>`,
      ...regions.map(({ g, ax, ay, stored }) => `<gate type="Region_Classifier" fullname="${xml(fullname.get(g.name))}"><name>${xml(g.name)}</name><parent>${xml(g.parent ? fullname.get(g.parent) : 'All Events')}</parent><num_events>${counts.get(g.name)}</num_events><region name="R_${xml(g.name)}" type="${regionType[g.kind]}" xparm="${xml(g.x)}"${g.y ? ` yparm="${xml(g.y)}"` : ''}><points>${stored.map(([x, y]) => `<point x="${+x.toFixed(4)}" y="${+y.toFixed(4)}"/>`).join('')}</points></region><is_x_parameter_scaled>${ax.scaled}</is_x_parameter_scaled>${ax.scaled ? `<x_parameter_scale_value>${ax.value}</x_parameter_scale_value>` : ''}<is_x_parameter_log>false</is_x_parameter_log>${ay ? `<is_y_parameter_scaled>${ay.scaled}</is_y_parameter_scaled>${ay.scaled ? `<y_parameter_scale_value>${ay.value}</y_parameter_scale_value>` : ''}<is_y_parameter_log>false</is_y_parameter_log>` : ''}</gate>`)].join('');
    return { specimen: tube.specimen, xml: `<tube name="${xml(tube.name)}"><data_filename>${xml(tube.fileName)}</data_filename>${settingsXML}<gates>${gatesXML}</gates></tube>` };
  });
  const specimens = [...new Set(tubes.map((t) => t.specimen))];
  return `<?xml version="1.0" encoding="UTF-8"?>
<bdfacs version="${xml(version)}" release_version="${xml(version)}"><experiment name="${xml(name)}">${settingsXML.replace('instrument_settings name="Cytometer Settings"', 'instrument_settings name="Experiment Settings"')}${specimens.map((s) => `<specimen name="${xml(s)}">${tubeXML.filter((t) => t.specimen === s).map((t) => t.xml).join('')}</specimen>`).join('')}</experiment></bdfacs>
`;
}

// Diva's count of every gate of a tube: name → count.
function divaCounts(tube, spill, regions) {
  const nEvents = tube.eventCount;
  const n = spill.channels.length;
  // Compensated values: raw × inverse(spillover).
  const C = inverse(Float64Array.from(spill.matrix), n);
  const compensated = {};
  for (let i = 0; i < n; i += 1) compensated[spill.channels[i]] = new Float64Array(nEvents);
  for (let e = 0; e < nEvents; e += 1) {
    for (let i = 0; i < n; i += 1) {
      let v = 0;
      for (let j = 0; j < n; j += 1) v += tube.columns[spill.channels[j]][e] * C[j * n + i];
      compensated[spill.channels[i]][e] = v;
    }
  }
  const value = (channel) => compensated[channel] ?? tube.columns[channel];
  const grid = (s) => Math.floor(Math.max(0, Math.min(1, s)) * 256 + 1e-9) / 256;
  const members = new Map();
  const counts = new Map();
  for (const { g, ax, ay, scaled } of regions) {
    const parent = g.parent ? members.get(g.parent) : null;
    const xs = value(g.x);
    const ys = g.y ? value(g.y) : null;
    const lo = scaled.reduce((m, p) => [Math.min(m[0], p[0]), Math.min(m[1], p[1])], [Infinity, Infinity]);
    const hi = scaled.reduce((m, p) => [Math.max(m[0], p[0]), Math.max(m[1], p[1])], [-Infinity, -Infinity]);
    const inside = new Uint8Array(nEvents);
    let count = 0;
    for (let e = 0; e < nEvents; e += 1) {
      if (parent && !parent[e]) continue;
      const x = grid(ax.t.forward(xs[e]));
      const y = ys ? grid(ay.t.forward(ys[e])) : 0;
      const ok = g.kind === 'interval' ? x >= lo[0] && x <= hi[0] : g.kind === 'rectangle' ? x >= lo[0] && x <= hi[0] && y >= lo[1] && y <= hi[1] : inPolygon(x, y, scaled);
      if (ok) {
        inside[e] = 1;
        count += 1;
      }
    }
    members.set(g.name, inside);
    counts.set(g.name, count);
  }
  return counts;
}

// --- SpectroFlo -------------------------------------------------------------------------------
//
// references: [{ fluorochrome, marker, file, vector (one value per detector, 1 at its peak) }],
// unstained: { file, vector }. File paths are SpectroFlo's (its Raw folder on the acquisition PC).
export function spectroFloExperiment({ name, date, references, unstained }) {
  const ns = 'xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:z="http://schemas.microsoft.com/2003/10/Serialization/" xmlns="http://schemas.datacontract.org/2004/07/Rainbow.DataPersistence.Experiment"';
  const d4 = 'http://schemas.datacontract.org/2004/07/Rainbow.DataPersistence.Experiment';
  const vector = (values) => `<d4p1:_SpilloverVectorArea z:Size="${values.length}">${values.map((v) => `<d5p1:float xmlns:d5p1="http://schemas.microsoft.com/2003/10/Serialization/Arrays">${+v.toPrecision(7)}</d5p1:float>`).join('')}</d4p1:_SpilloverVectorArea>`;
  const url = (file) => `C:\\Cytek\\Raw\\${xml(name)}\\Reference Group\\${xml(file)}`;
  let id = 10;
  const columns = references.map((r) => {
    id += 10;
    const unstainedRef = id === 20 ? `<d4p1:NameOfSeparateUnstained z:Id="9">Unstained</d4p1:NameOfSeparateUnstained>` : '<d4p1:NameOfSeparateUnstained z:Ref="9" i:nil="true" />';
    return `<d4p1:SpilloverColumn z:Id="${id}">${vector(r.vector)}<d4p1:_DateTimeCreated>${date}</d4p1:_DateTimeCreated><d4p1:_RefControlDesc z:Id="${id + 1}"><d4p1:Fluorochrome z:Id="${id + 2}">${xml(r.fluorochrome)}</d4p1:Fluorochrome><d4p1:Label z:Id="${id + 3}">${xml(r.marker)}</d4p1:Label>${unstainedRef}</d4p1:_RefControlDesc><d4p1:_Url>${url(r.file)}</d4p1:_Url></d4p1:SpilloverColumn>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?><Experiment ${ns} z:Id="1"><Version>3300</Version><Info z:Id="2"><Name z:Id="3">${xml(name)}</Name><ExperimentDesc z:Id="4" xmlns:d4p1="${d4}"><d4p1:_UnmixingScheme>AutofluorescenceAsFluorescentTag</d4p1:_UnmixingScheme><d4p1:_RefSetupResult z:Id="5"><d4p1:SpilloverColumnList z:Size="${columns.length}">${columns.join('')}</d4p1:SpilloverColumnList><d4p1:UnstainedMfiColumn z:Id="6">${vector(unstained.vector)}<d4p1:_DateTimeCreated>${date}</d4p1:_DateTimeCreated><d4p1:_RefControlDesc z:Id="7"><d4p1:Fluorochrome i:nil="true" /></d4p1:_RefControlDesc><d4p1:_Url>${url(unstained.file)}</d4p1:_Url></d4p1:UnstainedMfiColumn></d4p1:_RefSetupResult></ExperimentDesc></Info></Experiment>
`;
}

// --- FlowJo 11 --------------------------------------------------------------------------------
//
// The gating tree of the FlowJo 10 example (examples.js FLOWJO_TREE: polygons and an ellipse in
// data values, rectangles as { channel, min, max } bounds, a quadrant's four populations marked
// quad, an OR population) as a FlowJo 11 analysis: shared population definitions on 256-unit
// display axes, a population per sample and gate with the count `counts` gives it, the matrix as
// a spilloverMatrix platform, and the groups. Returns the workbench's ZIP entries
// ([{ name, text }]); FlowJo zips them into the .flowjo file.
export function flowJo11Workbench({ name, entries, tree, spill, biex, groups }) {
  let next = 0;
  const uuid = (kind) => {
    next += 1;
    return `0000${kind}-0000-4000-8000-${String(next).padStart(12, '0')}`;
  };
  const axisOf = (channel) => {
    const compensated = channel.startsWith('Comp-');
    const transform = compensated
      ? { transformType: 'Biex', T: biex.maxValue, W: biex.widthBasis, M: biex.positiveDecades, A: biex.extraNegativeDecades, vectorLength: 256 }
      : { transformType: 'Linear', minRange: 0, maxRange: T, vectorLength: 256 };
    const t = createTransform(compensated ? { type: 'biex', ...biex } : { type: 'linear', min: 0, max: T });
    return { axis: { parameterSpec: { name: channel }, transform }, display: (v) => +(256 * t.forward(v)).toFixed(6) };
  };
  const OPEN = 1e6;
  const definitions = {};
  const define = (definition) => {
    const id = uuid('d');
    definitions[id] = { definition };
    return id;
  };
  // One definition per gate of the tree, shared by the samples; a quadrant's four populations
  // share one definition.
  const defOf = new Map();
  const quadOf = new Map();
  const QUADS = ['LL', 'LR', 'UL', 'UR'];
  const walkDefs = (nodes) => {
    const quads = nodes.filter((node) => node.quad);
    if (quads.length) {
      const [xDim, yDim] = quads[0].gate.dims;
      const x = axisOf(xDim.channel);
      const y = axisOf(yDim.channel);
      const cx = x.display(xDim.min ?? xDim.max);
      const cy = y.display(yDim.min ?? yDim.max);
      const names = QUADS.map((q) => quads.find((node) => node.quad === q)?.name ?? q);
      const id = define({ type: 'quad', name: names, gateDefinition: { type: 'quad', xAxis: x.axis, yAxis: y.axis, xVertices: [cx, cx, 256, cx, 0], yVertices: [cy, 0, cy, 256, cy] } });
      for (const node of quads) quadOf.set(node, { id, number: QUADS.indexOf(node.quad) });
    }
    for (const node of nodes) {
      if (node.children) walkDefs(node.children);
      if (node.quad) continue;
      if (node.or) {
        defOf.set(node, define({ type: 'or', name: [node.name] }));
        continue;
      }
      const g = node.gate;
      let gd;
      if (g.type === 'polygon') {
        const x = axisOf(g.x);
        const y = axisOf(g.y);
        gd = { type: 'polygon', xAxis: x.axis, yAxis: y.axis, xVertices: g.vertices.map(([v]) => x.display(v)), yVertices: g.vertices.map(([, v]) => y.display(v)) };
      } else if (g.type === 'ellipse') {
        // FlowJo 11: the axis-aligned box [x1, x2] × [y1, y2], turned by rotationAngle about its center.
        const x = axisOf(g.x);
        const y = axisOf(g.y);
        const [cx, cy] = [x.display(g.center[0]), y.display(g.center[1])];
        const [a, b] = [x.display(g.a), y.display(g.b)];
        gd = { type: 'ellipse', xAxis: x.axis, yAxis: y.axis, xVertices: [cx - a, cx + a], yVertices: [cy - b, cy + b], rotationAngle: (g.theta * 180) / Math.PI };
      } else if (g.dims.length === 1) {
        const d = g.dims[0];
        const x = axisOf(d.channel);
        gd = { type: 'range', xAxis: x.axis, xVertices: [d.min === undefined ? -OPEN : x.display(d.min), d.max === undefined ? OPEN : x.display(d.max)] };
      } else {
        const [dx, dy] = g.dims;
        const x = axisOf(dx.channel);
        const y = axisOf(dy.channel);
        gd = { type: 'rectangle', xAxis: x.axis, yAxis: y.axis, xVertices: [dx.min === undefined ? -OPEN : x.display(dx.min), dx.max === undefined ? OPEN : x.display(dx.max)], yVertices: [dy.min === undefined ? -OPEN : y.display(dy.min), dy.max === undefined ? OPEN : y.display(dy.max)] };
      }
      defOf.set(node, define({ type: gd.type, name: [node.name], gateDefinition: gd }));
    }
  };
  walkDefs(tree);
  const rootDef = define({ type: 'root', name: ['All Events'] });

  const platformId = uuid('p');
  const platforms = { spilloverMatrix: { [platformId]: { definition: { platformType: 'spilloverMatrix', name: 'Corrected matrix', spillover: { rows: spill.channels.slice(), columns: spill.channels.slice(), values: spill.channels.map((_, i) => spill.channels.map((__, j) => +spill.matrix[i * spill.channels.length + j].toPrecision(6))) } } } } };
  const dataSources = {};
  const populations = {};
  const dataSourceIds = [];
  for (const entry of entries) {
    const ds = uuid('s');
    dataSourceIds.push(ds);
    const keywords = { $FIL: entry.name, $TOT: String(entry.dataset.eventCount), $CYT: entry.dataset.keywords.$CYT ?? '', $DATE: entry.dataset.keywords.$DATE ?? '', $TIMESTEP: entry.dataset.keywords.$TIMESTEP ?? '' };
    entry.dataset.parameters.forEach((p, k) => {
      keywords[`$P${k + 1}N`] = p.name;
      keywords[`$P${k + 1}R`] = String(p.range);
      if (p.label) keywords[`$P${k + 1}S`] = p.label;
    });
    dataSources[ds] = { definition: { uri: `file:///Users/lab/FlowJo/PBMC/${encodeURIComponent(entry.name)}` }, results: { keywords }, parents: { platforms: [platformId] } };
    const root = uuid('r');
    const make = (nodes, parentPop, path) => {
      const ids = [];
      const byName = new Map();
      for (const node of nodes) {
        const own = path ? `${path}/${node.name}` : node.name;
        const id = uuid('q');
        ids.push(id);
        byName.set(node.name, id);
        const quad = quadOf.get(node);
        populations[id] = {
          definition: quad ? { populationNumber: quad.number } : {},
          parents: { populationDefinitions: [quad ? quad.id : defOf.get(node)], populations: [parentPop] },
          children: { populations: [] },
          results: { count: entry.counts[own] ?? 0 },
        };
        if (node.children) populations[id].children.populations = make(node.children, id, own);
      }
      // A Boolean population names its operands as its parents.
      for (const node of nodes) if (node.or) populations[byName.get(node.name)].parents.populations = node.or.map((operand) => byName.get(operand));
      return ids;
    };
    populations[root] = { definition: {}, parents: { populationDefinitions: [rootDef], dataSources: [ds] }, children: { populations: [] }, results: { count: entry.dataset.eventCount } };
    populations[root].children.populations = make(tree, root, '');
  }
  const groupNodes = {};
  for (const group of [{ name: 'All Samples', test: () => true }, ...groups]) {
    groupNodes[uuid('g')] = { definition: { name: group.name }, parents: { dataSources: entries.map((entry, i) => (group.test(entry.name) ? dataSourceIds[i] : null)).filter(Boolean) } };
  }
  const analysisId = uuid('a');
  const analysis = { schemaVersion: '1.0', populationDefinitions: definitions, populations, dataSources, platforms, groups: groupNodes };
  return [
    { name: 'workbench.json', text: JSON.stringify({ name, flowJoVersion: '11.2.0', analyses: [analysisId] }, null, 1) },
    { name: `analyses/analysis-${analysisId}/analysis-${analysisId}.json`, text: JSON.stringify(analysis) },
  ];
}

// --- CSV events -------------------------------------------------------------------------------

// Events as a CSV table with a header row (an instrument's or another program's export).
export function eventsCSV(columns, names, count, digits = 1) {
  const rows = [names.join(',')];
  for (let e = 0; e < count; e += 1) rows.push(names.map((name) => +columns[name][e].toFixed(digits)).join(','));
  return `${rows.join('\n')}\n`;
}
