import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareFlowJoCounts,
  ellipseFromConjugateDiameters,
  flowJoChannel,
  flowJoTransform,
  importFlowJo,
  mergeFlowJoGates,
  remapGeometry,
} from './flowjo.js';
import { createTransform } from './transforms.js';
import { parseXML } from './xml.js';

const NS = 'xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"';

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected}`);
}

// --- Builders for FlowJo v10 workspace XML ------------------------------------------------------

const dim = (name, { min, max } = {}) => `<gating:dimension${min !== undefined ? ` gating:min="${min}"` : ''}${max !== undefined ? ` gating:max="${max}"` : ''}><data-type:fcs-dimension data-type:name="${name}"/></gating:dimension>`;
const vertex = ([x, y]) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`;
let gateCounter = 0;
const nextId = () => `ID${(gateCounter += 1)}`;
function population(name, count, gate, children = '', gateAttrs = '') {
  const id = nextId();
  return `<Population name="${name}" annotation="" owningGroup="" expanded="1" sortPriority="10" count="${count}">
    <Graph smoothing="0" backColor="#ffffff" foreColor="#000000" type="Pseudocolor" fast="0"/>
    <Gate gating:id="${id}"${gateAttrs}>${gate.replace('%ID%', id)}</Gate>
    <Subpopulations>${children}</Subpopulations>
  </Population>`;
}
const polygon = (x, y, vertices, extra = '') => `<gating:PolygonGate eventsInside="1" annoOffsetX="0" annoOffsetY="0" tint="#000000" isTinted="0" lineWeight="Normal" userDefined="1" percentX="0" percentY="0" gating:id="%ID%"${extra}>${dim(x)}${dim(y)}${vertices.map(vertex).join('')}</gating:PolygonGate>`;
const rectangle = (dims, extra = '') => `<gating:RectangleGate eventsInside="1" gating:id="%ID%"${extra}>${dims.join('')}</gating:RectangleGate>`;
const booleanNode = (kind, name, count, dependents, children = '') => `<${kind} name="${name}" annotation="" owningGroup="" expanded="0" sortPriority="10" count="${count}">
    <Graph/>
    <Dependents>${dependents.map((d) => `<Dependent name="${d}"/>`).join('')}</Dependents>
    <Subpopulations>${children}</Subpopulations>
  </${kind}>`;

// FlowJo keeps ellipses in display bins (256 across each axis); center, a and b are given in
// bins here.
function ellipseGate(x, y, center, a, b, theta) {
  const [cx, cy] = center;
  const c = Math.sqrt(a * a - b * b);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const foci = [[cx + c * cos, cy + c * sin], [cx - c * cos, cy - c * sin]];
  const edges = [[cx + a * cos, cy + a * sin], [cx - a * cos, cy - a * sin], [cx - b * sin, cy + b * cos], [cx + b * sin, cy - b * cos]];
  return `<gating:EllipsoidGate eventsInside="1" gating:id="%ID%">${dim(x)}${dim(y)}<gating:foci>${foci.map(vertex).join('')}</gating:foci><gating:edge>${edges.map(vertex).join('')}</gating:edge></gating:EllipsoidGate>`;
}

const KEYWORDS = (file) => `<Keywords>
  <Keyword name="$FIL" value="${file}"/><Keyword name="$TOT" value="10000"/>
  <Keyword name="$P1N" value="FSC-A"/><Keyword name="$P1R" value="262144"/>
  <Keyword name="$P2N" value="SSC-A"/><Keyword name="$P2R" value="262144"/>
  <Keyword name="$P3N" value="FITC-A"/><Keyword name="$P3R" value="262144"/>
  <Keyword name="$P4N" value="PE-A"/><Keyword name="$P4R" value="262144"/>
  <Keyword name="$P5N" value="FSC-H"/><Keyword name="$P5R" value="131072"/>
  <Keyword name="$cyt" value="LSRFortessa"/>
</Keywords>`;

const SPILLOVER = `<transforms:spilloverMatrix prefix="Comp-" name="Acquisition-defined" editable="0" color="#c0c0c0" version="FlowJo-10.8.1" status="FINALIZED" transforms:id="SPILL1" suffix="">
  <data-type:parameters>
    <data-type:parameter data-type:name="FITC-A" userProvidedCompInfix="Comp-FITC-A"/>
    <data-type:parameter data-type:name="PE-A" userProvidedCompInfix="Comp-PE-A"/>
  </data-type:parameters>
  <transforms:spillover data-type:parameter="FITC-A" userProvidedCompInfix="Comp-FITC-A">
    <transforms:coefficient data-type:parameter="FITC-A" transforms:value="1.0"/>
    <transforms:coefficient data-type:parameter="PE-A" transforms:value="0.12"/>
  </transforms:spillover>
  <transforms:spillover data-type:parameter="PE-A" userProvidedCompInfix="Comp-PE-A">
    <transforms:coefficient data-type:parameter="FITC-A" transforms:value="0.03"/>
    <transforms:coefficient data-type:parameter="PE-A" transforms:value="1.0"/>
  </transforms:spillover>
</transforms:spilloverMatrix>`;

const transformsXML = (biexWidth) => `<Transformations>
  <transforms:linear transforms:minRange="0" transforms:maxRange="262144" gain="1"><data-type:parameter data-type:name="FSC-A"/></transforms:linear>
  <transforms:linear transforms:minRange="0" transforms:maxRange="262144" gain="1"><data-type:parameter data-type:name="SSC-A"/></transforms:linear>
  <transforms:biex transforms:length="256" transforms:maxRange="262144" transforms:neg="0" transforms:width="${biexWidth}" transforms:pos="4.5"><data-type:parameter data-type:name="Comp-FITC-A"/></transforms:biex>
  <transforms:logicle transforms:length="256" transforms:T="262144" transforms:w="0.5" transforms:m="4.5" transforms:a="0"><data-type:parameter data-type:name="Comp-PE-A"/></transforms:logicle>
  <transforms:miltenyi transforms:length="256" transforms:maxRange="262144"><data-type:parameter data-type:name="PerCP-A"/></transforms:miltenyi>
</Transformations>`;

const LYMPH_1 = [[20000, 10000], [120000, 15000], [110000, 80000], [30000, 60000]];
const LYMPH_2 = [[22000, 10000], [120000, 15000], [110000, 80000], [30000, 60000]];
const BLOB = { center: [100000, 50000], a: 30000, b: 10000, theta: 0.5 };

function sampleXML({ id, file, biexWidth, lymph, extra = true }) {
  const quads = [
    ['Q1: FITC- , PE+', [dim('Comp-FITC-A', { max: 500 }), dim('Comp-PE-A', { min: 2000 })]],
    ['Q2: FITC+ , PE+', [dim('Comp-FITC-A', { min: 500 }), dim('Comp-PE-A', { min: 2000 })]],
    ['Q3: FITC+ , PE-', [dim('Comp-FITC-A', { min: 500 }), dim('Comp-PE-A', { max: 2000 })]],
    ['Q4: FITC- , PE-', [dim('Comp-FITC-A', { max: 500 }), dim('Comp-PE-A', { max: 2000 })]],
  ].map(([name, dims], i) => population(name, 100 + i, rectangle(dims), '', ` quadId="QUAD${id}"`)).join('');
  const cd3Children = [
    quads,
    population('Blob', 40, ellipseGate('FSC-A', 'SSC-A', BLOB.center.map((v) => v / 1024), BLOB.a / 1024, BLOB.b / 1024, BLOB.theta)),
    population('Not big', 900, polygon('FSC-A', 'SSC-A', [[0, 0], [50000, 0], [50000, 50000]], '').replace('eventsInside="1"', 'eventsInside="0"')),
  ].join('');
  const singletsChildren = [
    population('CD3+', 3000, rectangle([dim('Comp-FITC-A', { min: 1000 })]), cd3Children),
    population('FITC any', 5000, rectangle([dim('Comp-FITC-A', { min: 0, max: 262144 })])),
    population('PE above zero', 4000, rectangle([dim('Comp-PE-A', { min: 0 })])),
    booleanNode('OrNode', 'Q1 or Q2', 201, ['Lymphocytes/Singlets/CD3+/Q1: FITC- , PE+', 'Q2: FITC+ , PE+']),
    booleanNode('NotNode', 'CD3-', 2500, ['../CD3+']),
    extra ? booleanNode('AndNode', 'Broken', 1, ['Nowhere/Missing', 'CD3+'], population('Under broken', 1, rectangle([dim('FSC-A', { min: 1 })]))) : '',
  ].join('');
  const rootChildren = [
    population('Lymphocytes', 6000, polygon('FSC-A', 'SSC-A', lymph), population('Singlets', 5500, rectangle([dim('FSC-A', { min: 10000, max: 200000 }), dim('FSC-H', { min: 5000 })]), singletsChildren)),
    extra ? population('Biex polygon', 700, polygon('Comp-FITC-A', 'Comp-PE-A', [[-200, -100], [5000, 0], [100000, 50000], [0, 20000]])) : '',
    extra ? population('Raw FITC', 650, polygon('FITC-A', 'SSC-A', [[100, 0], [5000, 0], [5000, 50000]])) : '',
    extra ? population('PerCP odd', 10, polygon('Comp-PE-A', 'PerCP-A', [[0, 0], [1000, 0], [1000, 1000]])) : '',
  ].join('');
  return `<Sample>
    <DataSet uri="file:/Users/lab/data/${encodeURIComponent(file)}" sampleID="${id}"/>
    ${SPILLOVER}
    ${transformsXML(biexWidth)}
    ${KEYWORDS(file)}
    <SampleNode name="${file}" annotation="" owningGroup="" expanded="1" sortPriority="10" count="10000" sampleID="${id}">
      <Graph/>
      <Subpopulations>${rootChildren}</Subpopulations>
    </SampleNode>
  </Sample>`;
}

const WORKSPACE = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" modDate="Mon Jan 01 00:00:00 PST 2024" flowJoVersion="10.8.1" curGroup="All Samples" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ${NS}>
  <Groups>
    <GroupNode name="All Samples" annotation="" owningGroup="All Samples" expanded="0" sortPriority="10" count="2">
      <Group name="All Samples" builtIn="1"><Criteria/><SampleRefs><SampleRef sampleID="1"/><SampleRef sampleID="2"/></SampleRefs></Group>
    </GroupNode>
    <GroupNode name="Stim" annotation="" owningGroup="Stim" expanded="0" sortPriority="10" count="1">
      <Group name="Stim"><SampleRefs><SampleRef sampleID="2"/></SampleRefs></Group>
    </GroupNode>
  </Groups>
  <SampleList>
    ${sampleXML({ id: 1, file: 'A1 unstim.fcs', biexWidth: -100, lymph: LYMPH_1 })}
    ${sampleXML({ id: 2, file: 'A2 stim.fcs', biexWidth: -10, lymph: LYMPH_2, extra: false })}
  </SampleList>
</Workspace>`;

const gateAt = (sample, path) => sample.gates.find((g) => g.meta.flowJo.path === path && !g.meta.helper);
const fidelityOf = (result, sample, path) => result.fidelity.find((f) => f.sample === sample && f.path === path);

test('reads samples, keywords, groups, compensation and transforms', () => {
  const result = importFlowJo(WORKSPACE);
  assert.equal(result.flowJoVersion, '10.8.1');
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.groups.map((g) => [g.name, g.sampleIds]), [['All Samples', ['1', '2']], ['Stim', ['2']]]);
  const [s1, s2] = result.samples;
  assert.equal(s1.name, 'A1 unstim.fcs');
  assert.equal(s1.fileName, 'A1 unstim.fcs');
  assert.equal(s1.uri, 'file:/Users/lab/data/A1%20unstim.fcs');
  assert.equal(s1.sampleId, '1');
  assert.equal(s1.eventCount, 10000);
  assert.equal(s1.keywords.$CYT, 'LSRFortessa');
  assert.deepEqual(s1.groupNames, ['All Samples']);
  assert.deepEqual(s2.groupNames, ['All Samples', 'Stim']);
  assert.deepEqual(s1.compensation.channels, ['FITC-A', 'PE-A']);
  assert.deepEqual(s1.compensation.matrix, [1, 0.12, 0.03, 1]);
  assert.equal(s1.compensation.name, 'Acquisition-defined');
  assert.equal(s1.compensation.source, 'imported');
  assert.deepEqual(s1.transforms['FSC-A'], { type: 'linear', min: 0, max: 262144 });
  assert.deepEqual(s1.transforms['FITC-A'], { type: 'biex', maxValue: 262144, widthBasis: -100, positiveDecades: 4.5, extraNegativeDecades: 0 });
  assert.deepEqual(s1.transforms['PE-A'], { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 });
  assert.deepEqual(s1.transforms['PerCP-A'], { type: 'linear', min: 0, max: 262144 });
  assert.equal(fidelityOf(result, s1.name, 'transform:PerCP-A').status, 'unsupported');
  assert.equal(s1.populationCounts.Lymphocytes, 6000);
  assert.equal(s1.populationCounts['Lymphocytes/Singlets/CD3+/Q2: FITC+ , PE+'], 101);
  assert.equal(s1.populationCounts['Lymphocytes/Singlets/Broken/Under broken'], 1);
});

test('gate coordinates are mapped from data units into scale space', () => {
  const result = importFlowJo(WORKSPACE);
  const [s1, s2] = result.samples;
  const lymph = gateAt(s1, 'Lymphocytes');
  assert.equal(lymph.type, 'polygon');
  assert.equal(lymph.parentId, null);
  assert.deepEqual(lymph.dims.map((d) => d.channel), ['FSC-A', 'SSC-A']);
  // Linear 0–262144: scale = value / 262144.
  assert.deepEqual(lymph.geometry.vertices, LYMPH_1.map(([x, y]) => [x / 262144, y / 262144]));
  const singlets = gateAt(s1, 'Lymphocytes/Singlets');
  assert.equal(singlets.parentId, lymph.id);
  // FSC-H has no FlowJo transform: linear over its $P5R range (131072).
  assert.deepEqual(singlets.dims[1].transform, { type: 'linear', min: 0, max: 131072 });
  assert.deepEqual(singlets.geometry, { min: [10000 / 262144, 5000 / 131072], max: [200000 / 262144, null] });
  // FlowJo's biex puts zero at channel trunc(4096 · extra / (extra + decades)): with width basis
  // −100 (width 2) and 4.5 decades, extra = 1 and decades = 3.5, so channel 910 of 4096.
  const fitcAny = gateAt(s1, 'Lymphocytes/Singlets/FITC any');
  assert.equal(fitcAny.type, 'range');
  assert.deepEqual(fitcAny.dims, [{ channel: 'FITC-A', transform: s1.transforms['FITC-A'] }]);
  close(fitcAny.geometry.min, 910 / 4096, 1e-12);
  close(fitcAny.geometry.max, createTransform(s1.transforms['FITC-A']).forward(262144), 1e-12);
  // Sample 2's biex has width basis −10 (width 1): channel trunc(4096 · 0.5 / 4.5) = 455.
  close(gateAt(s2, 'Lymphocytes/Singlets/FITC any').geometry.min, 455 / 4096, 1e-12);
  // Logicle (T 262144, W 0.5, M 4.5): zero at W / M.
  close(gateAt(s1, 'Lymphocytes/Singlets/PE above zero').geometry.min, 0.5 / 4.5, 1e-12);
  const cd3 = gateAt(s1, 'Lymphocytes/Singlets/CD3+');
  close(cd3.geometry.min, createTransform(s1.transforms['FITC-A']).forward(1000), 1e-15);
  assert.equal(cd3.geometry.max, null);
  assert.deepEqual(cd3.meta.compensated, [true]);
  // Biex polygon: each vertex through its axis' transform.
  const biexPolygon = gateAt(s1, 'Biex polygon');
  const fx = createTransform(s1.transforms['FITC-A']).forward;
  const fy = createTransform(s1.transforms['PE-A']).forward;
  biexPolygon.geometry.vertices.forEach(([x, y], i) => {
    const raw = [[-200, -100], [5000, 0], [100000, 50000], [0, 20000]][i];
    close(x, fx(raw[0]), 1e-15);
    close(y, fy(raw[1]), 1e-15);
  });
  assert.ok(biexPolygon.geometry.vertices[0][0] < 1 / 4.5, 'negative data values sit below zero on the biex scale');
});

test('quadrants, ellipses, outside-gates and boolean populations', () => {
  const result = importFlowJo(WORKSPACE);
  const [s1] = result.samples;
  const base = 'Lymphocytes/Singlets/CD3+';
  const quads = ['Q1: FITC- , PE+', 'Q2: FITC+ , PE+', 'Q3: FITC+ , PE-', 'Q4: FITC- , PE-'].map((n) => gateAt(s1, `${base}/${n}`));
  assert.deepEqual(quads.map((q) => q.type), ['quadrant', 'quadrant', 'quadrant', 'quadrant']);
  // FlowJo numbers quadrants clockwise from the upper left.
  assert.deepEqual(quads.map((q) => q.geometry.quadrant), ['UL', 'UR', 'LR', 'LL']);
  assert.equal(new Set(quads.map((q) => q.linkId)).size, 1);
  const center = [createTransform(s1.transforms['FITC-A']).forward(500), createTransform(s1.transforms['PE-A']).forward(2000)];
  for (const q of quads) assert.deepEqual(q.geometry.center, center);
  assert.ok(quads.every((q) => q.parentId === gateAt(s1, base).id));

  const blob = gateAt(s1, `${base}/Blob`);
  assert.equal(blob.type, 'ellipse');
  close(blob.geometry.center[0], BLOB.center[0] / 262144, 1e-12);
  close(blob.geometry.center[1], BLOB.center[1] / 262144, 1e-12);
  close(blob.geometry.radii[0], BLOB.a / 262144, 1e-12);
  close(blob.geometry.radii[1], BLOB.b / 262144, 1e-12);
  close(blob.geometry.angle, BLOB.theta, 1e-12);
  assert.equal(fidelityOf(result, s1.name, `${base}/Blob`).status, 'imported');

  const notBig = gateAt(s1, `${base}/Not big`);
  assert.equal(notBig.type, 'boolean');
  assert.equal(notBig.geometry.op, 'not');
  const shape = s1.gates.find((g) => g.id === notBig.geometry.operands[0]);
  assert.equal(shape.type, 'polygon');
  assert.ok(shape.meta.helper);
  assert.equal(shape.parentId, notBig.parentId);

  const or = gateAt(s1, 'Lymphocytes/Singlets/Q1 or Q2');
  assert.deepEqual(or.geometry, { op: 'or', operands: [quads[0].id, quads[1].id] });
  assert.equal(or.parentId, gateAt(s1, 'Lymphocytes/Singlets').id);
  const not = gateAt(s1, 'Lymphocytes/Singlets/CD3-');
  assert.deepEqual(not.geometry, { op: 'not', operands: [gateAt(s1, base).id] });
  assert.equal(gateAt(s1, 'Lymphocytes/Singlets/Broken'), undefined);
  assert.equal(gateAt(s1, 'Lymphocytes/Singlets/Broken/Under broken'), undefined);
  assert.match(fidelityOf(result, s1.name, 'Lymphocytes/Singlets/Broken').detail, /"Nowhere\/Missing"/);
  assert.equal(fidelityOf(result, s1.name, 'Lymphocytes/Singlets/Broken/Under broken').status, 'unsupported');
});

test('the fidelity report flags every approximation', () => {
  const result = importFlowJo(WORKSPACE);
  const name = 'A1 unstim.fcs';
  assert.equal(fidelityOf(result, name, 'Lymphocytes').status, 'imported');
  assert.equal(fidelityOf(result, name, 'Lymphocytes').detail, 'exact');
  // Axis-aligned gates are exact on any monotone transform, biex included.
  assert.equal(fidelityOf(result, name, 'Lymphocytes/Singlets/CD3+').status, 'imported');
  assert.equal(fidelityOf(result, name, 'Lymphocytes/Singlets/CD3+/Q2: FITC+ , PE+').status, 'imported');
  // FlowJo's biex is reproduced exactly, so a polygon on it is exact too.
  assert.equal(fidelityOf(result, name, 'Biex polygon').status, 'imported');
  // A gate on uncompensated FITC-A keeps uncompensated values, so it is exact.
  const raw = fidelityOf(result, name, 'Raw FITC');
  assert.equal(raw.status, 'imported');
  assert.match(raw.detail, /uncompensated FITC-A, which the gate keeps/);
  const rawGate = gateAt(result.samples.find((s) => s.name === name), 'Raw FITC');
  assert.deepEqual(rawGate.dims.map((d) => [d.channel, d.compensation]), [['FITC-A', 'uncompensated'], ['SSC-A', undefined]]);
  const odd = fidelityOf(result, name, 'PerCP odd');
  assert.equal(odd.status, 'approximated');
  assert.match(odd.detail, /miltenyi/);
  // Every population of both samples has exactly one entry.
  for (const sample of result.samples) {
    for (const path of Object.keys(sample.populationCounts)) {
      assert.equal(result.fidelity.filter((f) => f.sample === sample.name && f.path === path).length, 1, path);
    }
  }
});

test('ellipses on unequal and nonlinear axes', () => {
  // Unequal linear spans scale the axes differently: the foci no longer map to foci, but the axis
  // ends still map to conjugate diameters, so boundary points stay on the boundary.
  const points = [[10, 40], [70, 40], [40, 50], [40, 30]].map(([x, y]) => [x / 100, y / 1000]);
  const { ellipse, mismatch } = ellipseFromConjugateDiameters(points);
  assert.ok(mismatch < 1e-12);
  const onBoundary = ([x, y]) => {
    const dx = x - ellipse.center[0];
    const dy = y - ellipse.center[1];
    const cos = Math.cos(ellipse.angle);
    const sin = Math.sin(ellipse.angle);
    return ((dx * cos + dy * sin) / ellipse.radii[0]) ** 2 + ((-dx * sin + dy * cos) / ellipse.radii[1]) ** 2;
  };
  for (const t of [0.3, 1.1, 2.5, 4]) close(onBoundary([(40 + 30 * Math.cos(t)) / 100, (40 + 10 * Math.sin(t)) / 1000]), 1, 1e-12);

  // FlowJo's ellipse lives in display space, so on a log axis it is still an ellipse in scale space,
  // exactly: center, radii and angle are its display coordinates over 256.
  const xml = `<Workspace version="20.0" ${NS}><SampleList><Sample>
    <DataSet uri="x.fcs" sampleID="7"/>
    <Transformations>
      <transforms:linear transforms:minRange="0" transforms:maxRange="1000"><data-type:parameter data-type:name="A"/></transforms:linear>
      <transforms:log transforms:offset="1" transforms:decades="4"><data-type:parameter data-type:name="B"/></transforms:log>
    </Transformations>
    <SampleNode name="x.fcs" count="10" sampleID="7"><Subpopulations>
      ${population('Log ellipse', 5, ellipseGate('A', 'B', [128, 100], 60, 20, 0.2))}
    </Subpopulations></SampleNode>
  </Sample></SampleList></Workspace>`;
  const result = importFlowJo(xml);
  const gate = result.samples[0].gates[0];
  assert.equal(gate.type, 'ellipse');
  assert.deepEqual(gate.dims[1].transform, { type: 'log', min: 1, max: 10000 });
  close(gate.geometry.center[0], 0.5, 1e-12);
  close(gate.geometry.center[1], 100 / 256, 1e-12);
  close(gate.geometry.radii[0], 60 / 256, 1e-12);
  close(gate.geometry.radii[1], 20 / 256, 1e-12);
  close(gate.geometry.angle, 0.2, 1e-12);
  assert.equal(result.fidelity.find((f) => f.path === 'Log ellipse').status, 'imported');
});

test('merging a group builds one tree with per-sample overrides', () => {
  const result = importFlowJo(WORKSPACE);
  const { gates, fidelity } = mergeFlowJoGates(result.samples, { scope: { groupId: 'grp1' } });
  const byPath = (path) => gates.find((g) => g.meta.flowJoPath === path && !g.meta.helper);
  const lymph = byPath('Lymphocytes');
  assert.deepEqual(lymph.geometry.vertices, LYMPH_1.map(([x, y]) => [x / 262144, y / 262144]));
  assert.deepEqual(Object.keys(lymph.overrides), ['2']);
  assert.deepEqual(lymph.overrides['2'].vertices[0], [22000 / 262144, 10000 / 262144]);
  assert.deepEqual(lymph.scope, { groupId: 'grp1' });
  // CD3+ uses different biex widths in the two samples; the same data threshold maps to the
  // same position on the shared transform, so no override is needed.
  const cd3 = byPath('Lymphocytes/Singlets/CD3+');
  assert.deepEqual(cd3.overrides, {});
  assert.equal(cd3.dims[0].transform.widthBasis, -100);
  close(cd3.geometry.min, createTransform(cd3.dims[0].transform).forward(1000), 1e-12);
  assert.ok(fidelity.some((f) => f.path === 'Lymphocytes/Singlets/CD3+' && /re-expressed/.test(f.detail) && f.status === 'imported'));
  // Parents and links are remapped onto the merged ids.
  assert.equal(byPath('Lymphocytes/Singlets').parentId, lymph.id);
  const quads = gates.filter((g) => g.type === 'quadrant');
  assert.equal(quads.length, 4);
  assert.equal(new Set(quads.map((q) => q.linkId)).size, 1);
  assert.ok(quads.every((q) => q.parentId === cd3.id));
  const or = byPath('Lymphocytes/Singlets/Q1 or Q2');
  assert.deepEqual(or.geometry.operands, quads.slice(0, 2).map((q) => q.id));
  const notBig = byPath('Lymphocytes/Singlets/CD3+/Not big');
  const helper = gates.find((g) => g.id === notBig.geometry.operands[0]);
  assert.ok(helper.meta.helper);
  // Populations only in sample 1 are reported.
  assert.ok(fidelity.some((f) => f.path === 'Biex polygon' && f.status === 'approximated' && /absent from 1 sample/.test(f.detail)));
  // Sample 2's FITC any (0 to 262144) differs through its transform: its lower bound re-expressed
  // matches, but 262144 lies beyond the end of sample 2's biex table, where FlowJo clamps data to
  // the top edge, while sample 1's table reaches past it; sample 2 keeps its top-edge bound.
  const fitcAny = byPath('Lymphocytes/Singlets/FITC any');
  assert.deepEqual(Object.keys(fitcAny.overrides), ['2']);
  close(fitcAny.overrides['2'].min, fitcAny.geometry.min, 1e-12);
  assert.equal(fitcAny.overrides['2'].max, 1);
  assert.ok(fitcAny.geometry.max < 1);
  // Keys can follow CytoWeave's sample ids.
  const keyed = mergeFlowJoGates(result.samples, { keyOf: (s) => `cw-${s.sampleId}` });
  assert.deepEqual(Object.keys(keyed.gates.find((g) => g.meta.flowJoPath === 'Lymphocytes').overrides), ['cw-2']);
});

test('remapping geometry between transforms', () => {
  const from = [{ transform: { type: 'linear', min: 0, max: 1000 } }, { transform: { type: 'linear', min: 0, max: 1000 } }];
  const to = [{ transform: { type: 'linear', min: 0, max: 2000 } }, { transform: { type: 'log', min: 1, max: 1000 } }];
  const rect = remapGeometry('rectangle', { min: [0.1, 0.01], max: [null, 0.1] }, from, to);
  assert.equal(rect.exact, true);
  assert.deepEqual(rect.geometry.min, [0.05, 1 / 3]);
  close(rect.geometry.max[1], 2 / 3, 1e-15);
  assert.equal(rect.geometry.max[0], null);
  assert.equal(remapGeometry('polygon', { vertices: [[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]] }, from, to).exact, false);
});

test('transform, channel and compensation variants', () => {
  const el = (xml) => parseXML(`<t ${NS}>${xml}</t>`).children[0];
  assert.deepEqual(flowJoTransform(el('<transforms:log transforms:offset="10" transforms:decades="4"><data-type:parameter data-type:name="X"/></transforms:log>')), {
    parameter: 'X', spec: { type: 'log', min: 10, max: 100000 }, status: 'imported', detail: '',
  });
  const logicle = flowJoTransform(el('<transforms:logicle transforms:T="1000" transforms:W="3" transforms:M="4.5" transforms:A="0"/>'));
  assert.equal(logicle.status, 'unsupported');
  assert.match(logicle.detail, /invalid/);
  // A logicle of any width imports as the reference logicle, exactly.
  assert.deepEqual(flowJoTransform(el('<transforms:logicle transforms:T="262144" transforms:W="1" transforms:M="4.5" transforms:A="0"/>')), { parameter: null, spec: { type: 'logicle', T: 262144, W: 1, M: 4.5, A: 0 }, status: 'imported', detail: '' });
  // A linear axis with a gain: FlowJo's coordinates are gain × the stored values.
  assert.deepEqual(flowJoTransform(el('<transforms:linear transforms:minRange="1" transforms:maxRange="65" gain="0.01"/>')), { parameter: null, spec: { type: 'linear', min: 1, max: 65 }, status: 'imported', detail: '', unit: 100 });
  assert.deepEqual(flowJoTransform(el('<transforms:fasinh transforms:length="256" transforms:maxRange="262144" transforms:T="262144" transforms:M="4.5" transforms:A="0.5"/>')).spec, { type: 'fasinh', T: 262144, M: 4.5, A: 0.5 });
  assert.equal(flowJoTransform(el('<transforms:linear transforms:minRange="0" transforms:maxRange="1024" gain="2"/>')).unit, 0.5);
  assert.deepEqual(flowJoChannel('Comp-FITC-A'), { channel: 'FITC-A', compensated: true });
  assert.deepEqual(flowJoChannel('<PE-A>'), { channel: 'PE-A', compensated: true });
  assert.deepEqual(flowJoChannel('FSC-A'), { channel: 'FSC-A', compensated: false });
  assert.deepEqual(flowJoChannel('[FITC-A]c', { prefix: '[', suffix: ']c' }), { channel: 'FITC-A', compensated: true });

  // An older CompensationMatrix and a BooleanGate with gate references inside a population.
  const xml = `<Workspace version="20.0" ${NS}><SampleList><Sample>
    <DataSet uri="y.fcs" sampleID="3"/>
    <CompensationMatrix name="Manual" prefix="Comp-" suffix="">
      <Channel name="FITC-A"><ChannelValue name="FITC-A" value="1"/><ChannelValue name="PE-A" value="0.2"/></Channel>
      <Channel name="PE-A"><ChannelValue name="FITC-A" value="0"/><ChannelValue name="PE-A" value="1"/></Channel>
    </CompensationMatrix>
    <SampleNode name="y.fcs" count="10" sampleID="3"><Subpopulations>
      ${population('A', 5, rectangle([dim('FSC-A', { min: 10 })]))}
      ${population('B', 5, rectangle([dim('SSC-A', { min: 10 })]))}
      <Population name="A not B" count="3"><Gate gating:id="ID900"><gating:BooleanGate gating:id="ID900"><gating:and>
        <gating:gateReference gating:ref="ID${gateCounter - 1}"/><gating:gateReference gating:ref="ID${gateCounter}" gating:use-as-complement="true"/>
      </gating:and></gating:BooleanGate></Gate></Population>
    </Subpopulations></SampleNode>
  </Sample></SampleList></Workspace>`;
  const result = importFlowJo(xml);
  const sample = result.samples[0];
  assert.deepEqual(sample.compensation.matrix, [1, 0.2, 0, 1]);
  const a = sample.gates.find((g) => g.name === 'A');
  const b = sample.gates.find((g) => g.name === 'B');
  const and = sample.gates.find((g) => g.name === 'A not B');
  assert.equal(and.geometry.op, 'and');
  assert.equal(and.geometry.operands[0], a.id);
  const complement = sample.gates.find((g) => g.id === and.geometry.operands[1]);
  assert.deepEqual(complement.geometry, { op: 'not', operands: [b.id] });
  assert.throws(() => importFlowJo('<Gating-ML/>'), /not a FlowJo workspace/);
  const old = importFlowJo('<Workspace version="1.61"><SampleList/></Workspace>');
  assert.match(old.warnings.join('\n'), /older FlowJo format/);
});

test('count comparison against FlowJo', () => {
  const rows = compareFlowJoCounts({ A: 1000, B: 10, C: 0, D: 50 }, { A: 1004, B: 12, C: 0 });
  assert.deepEqual(rows.map((r) => [r.path, r.agree]), [['A', true], ['B', false], ['C', true], ['D', false]]);
  assert.equal(rows[0].difference, 4);
  close(rows[0].relative, 0.004, 1e-15);
  assert.equal(rows[3].cytoweave, null);
});
