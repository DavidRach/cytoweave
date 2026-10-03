import assert from 'node:assert/strict';
import test from 'node:test';
import {
  covarianceFromEllipse,
  ellipseFromCovariance,
  exportGatingML,
  importGatingML,
  sameTransformFunction,
  transformFromGatingML,
  transformToGatingML,
} from './gatingml.js';
import { difference, intersect, membership, union } from './gates.js';
import { createTransform } from './transforms.js';
import { createRandom } from './random.js';
import { parseXML } from './xml.js';
import { addCompensation, addDerived, addGates, createWorkspace } from './workspace.js';

const NS = 'xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:transforms="http://www.isac-net.org/std/Gating-ML/v2.0/transformations" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes"';
const doc = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<gating:Gating-ML ${NS}>\n${body}\n</gating:Gating-ML>`;
const dim = (name, { comp = 'uncompensated', t, min, max } = {}) => `<gating:dimension gating:compensation-ref="${comp}"${t ? ` gating:transformation-ref="${t}"` : ''}${min !== undefined ? ` gating:min="${min}"` : ''}${max !== undefined ? ` gating:max="${max}"` : ''}><data-type:fcs-dimension data-type:name="${name}"/></gating:dimension>`;
const vertex = (x, y) => `<gating:vertex><gating:coordinate data-type:value="${x}"/><gating:coordinate data-type:value="${y}"/></gating:vertex>`;
const byName = (gates) => Object.fromEntries(gates.map((g) => [g.meta?.gatingMLId ?? g.name, g]));

function close(actual, expected, tolerance, message = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} vs ${expected}`);
}

function transformElement(xml) {
  return parseXML(`<t ${NS}>${xml}</t>`).children[0];
}

test('Gating-ML transformations map to CytoWeave transforms with the same values', () => {
  // flin(x) = (x + A) / (T + A)
  const flin = transformFromGatingML(transformElement('<transforms:flin transforms:T="1000" transforms:A="100"/>'));
  assert.deepEqual(flin.spec, { type: 'linear', min: -100, max: 1000 });
  close(createTransform(flin.spec).forward(450), 550 / 1100, 1e-15);
  // flog(x) = log10(x / T) / M + 1
  const flog = transformFromGatingML(transformElement('<transforms:flog transforms:T="10000" transforms:M="5"/>'));
  close(createTransform(flog.spec).forward(100), 0.6, 1e-14);
  close(createTransform(flog.spec).forward(0.1), 0, 1e-14);
  // fasinh(x) = (asinh(x sinh(M ln10) / T) + A ln10) / ((M + A) ln10)
  const fasinh = transformFromGatingML(transformElement('<transforms:fasinh transforms:T="1000" transforms:M="4" transforms:A="1"/>'));
  const expected = (Math.asinh((250 * Math.sinh(4 * Math.LN10)) / 1000) + Math.LN10) / (5 * Math.LN10);
  close(createTransform(fasinh.spec).forward(250), expected, 1e-14);
  const logicle = transformFromGatingML(transformElement('<transforms:logicle transforms:T="10000" transforms:W="0.5" transforms:M="4.5" transforms:A="0"/>'));
  assert.deepEqual(logicle.spec, { type: 'logicle', T: 10000, W: 0.5, M: 4.5, A: 0 });
  close(createTransform(logicle.spec).forward(0), 0.5 / 4.5, 1e-14);
  const hyperlog = transformFromGatingML(transformElement('<transforms:hyperlog transforms:T="10000" transforms:W="1" transforms:M="4.5" transforms:A="0"/>'));
  close(createTransform(hyperlog.spec).forward(10000), 1, 1e-12);
  const ratio = transformFromGatingML(transformElement('<transforms:fratio transforms:A="2" transforms:B="1" transforms:C="0"><data-type:fcs-dimension data-type:name="FL1-H"/><data-type:fcs-dimension data-type:name="FL2-H"/></transforms:fratio>'));
  assert.deepEqual(ratio.ratio, { numerator: 'FL1-H', denominator: 'FL2-H', A: 2, B: 1, C: 0 });
  assert.match(transformFromGatingML(transformElement('<transforms:logicle transforms:T="10000" transforms:W="3" transforms:M="4.5" transforms:A="0"/>')).error, /W must be at most/);
  assert.match(transformFromGatingML(transformElement('<transforms:flog transforms:T="10000"/>')).error, /lacks the parameter M/);
  assert.match(transformFromGatingML(transformElement('<transforms:exotic/>')).error, /not part of Gating-ML/);
});

test('CytoWeave transforms export to equivalent Gating-ML functions', () => {
  const cases = [
    { type: 'linear', min: 0, max: 262144 },
    { type: 'linear', min: -500, max: 10000 },
    { type: 'log', min: 1, max: 262144 },
    { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 },
    { type: 'arcsinh', cofactor: 5, max: 10000, min: -5 * Math.sinh(1) },
    { type: 'fasinh', T: 262144, M: 4.5, A: 0.5 },
    { type: 'hyperlog', T: 262144, W: 0.5, M: 4.5, A: 0 },
  ];
  for (const spec of cases) {
    const plan = transformToGatingML(spec);
    const params = Object.entries(plan.params).map(([k, v]) => `transforms:${k}="${v}"`).join(' ');
    const back = transformFromGatingML(transformElement(`<transforms:${plan.local} ${params}/>`));
    assert.ok(back.spec, `${spec.type}: ${back.error}`);
    assert.ok(sameTransformFunction(spec, back.spec), `${spec.type} differs after the round trip`);
  }
  // FlowJo's biex has no Gating-ML form: it is written as the closest logicle, converting coordinates.
  const biex = transformToGatingML({ type: 'biex', maxValue: 262144, widthBasis: -100, positiveDecades: 4.42, extraNegativeDecades: 0 });
  assert.equal(biex.local, 'logicle');
  assert.equal(biex.convert, true);
  assert.deepEqual(transformToGatingML({ type: 'linear', min: 0, max: 1 }), { identity: true });
  // flin needs 0 ≤ A ≤ T: a linear scale starting above zero is written in data units.
  assert.deepEqual(transformToGatingML({ type: 'linear', min: 100, max: 1000 }), { raw: true });
});

test('ellipses convert between covariance and center/radii/angle', () => {
  assert.deepEqual(ellipseFromCovariance([1, 2], [[4, 0], [0, 1]], 1), { center: [1, 2], radii: [2, 1], angle: 0 });
  const vertical = ellipseFromCovariance([0, 0], [[1, 0], [0, 4]], 9);
  assert.deepEqual(vertical.radii, [6, 3]);
  close(vertical.angle, Math.PI / 2, 1e-15);
  // Σ = [[2, 1], [1, 2]]: eigenvalues 3 and 1, major axis at 45°.
  const diagonal = ellipseFromCovariance([0, 0], [[2, 1], [1, 2]], 1);
  close(diagonal.radii[0], Math.sqrt(3), 1e-14);
  close(diagonal.radii[1], 1, 1e-14);
  close(diagonal.angle, Math.PI / 4, 1e-14);
  const negative = ellipseFromCovariance([0, 0], [[2, -1], [-1, 2]], 1);
  close(negative.angle, -Math.PI / 4, 1e-14);
  for (const angle of [-1.2, -0.3, 0.4, 1.1]) {
    const geometry = { center: [0.3, 0.4], radii: [0.2, 0.05], angle };
    const back = ellipseFromCovariance(geometry.center, covarianceFromEllipse(geometry), 1);
    close(back.radii[0], 0.2, 1e-14);
    close(back.radii[1], 0.05, 1e-14);
    close(back.angle, angle, 1e-12);
  }
  assert.equal(ellipseFromCovariance([0, 0], [[1, 2], [2, 1]], 1), null);
});

// A document in the style of the Gating-ML 2.0 compliance tests: transformed and untransformed
// dimensions, a 2-divider quadrant gate, and boolean gates including use-as-complement.
const COMPLIANCE = doc(`
  <transforms:transformation transforms:id="Logicle_10000_0.5_4.5_0">
    <transforms:logicle transforms:T="10000" transforms:W="0.5" transforms:M="4.5" transforms:A="0"/>
  </transforms:transformation>
  <transforms:transformation transforms:id="Log_10000_5">
    <transforms:flog transforms:T="10000" transforms:M="5"/>
  </transforms:transformation>
  <transforms:transformation transforms:id="Asinh_1000_4_1">
    <transforms:fasinh transforms:T="1000" transforms:M="4" transforms:A="1"/>
  </transforms:transformation>
  <transforms:transformation transforms:id="Lin_1000_100">
    <transforms:flin transforms:T="1000" transforms:A="100"/>
  </transforms:transformation>
  <gating:PolygonGate gating:id="Polygon4">
    ${dim('FL3-H', { t: 'Logicle_10000_0.5_4.5_0' })}
    ${dim('FL4-H', { t: 'Logicle_10000_0.5_4.5_0' })}
    ${vertex(0.12, 0.27)}${vertex(0.85, 0.31)}${vertex(0.92, 0.88)}${vertex(0.42, 0.62)}${vertex(0.2, 0.95)}
  </gating:PolygonGate>
  <gating:RectangleGate gating:id="Range1" gating:parent_id="Polygon4">
    ${dim('FL1-H', { t: 'Log_10000_5', min: 0.4, max: 0.8 })}
  </gating:RectangleGate>
  <gating:RectangleGate gating:id="Rect2D">
    ${dim('FL1-H', { t: 'Lin_1000_100', min: 0.2 })}
    ${dim('FL2-H', { t: 'Asinh_1000_4_1', min: 0.3, max: 0.75 })}
  </gating:RectangleGate>
  <gating:EllipsoidGate gating:id="Ellipse1">
    ${dim('FL1-H')}
    ${dim('FL2-H')}
    <gating:mean><gating:coordinate data-type:value="300"/><gating:coordinate data-type:value="400"/></gating:mean>
    <gating:covarianceMatrix>
      <gating:row><gating:entry data-type:value="10000"/><gating:entry data-type:value="3000"/></gating:row>
      <gating:row><gating:entry data-type:value="3000"/><gating:entry data-type:value="5000"/></gating:row>
    </gating:covarianceMatrix>
    <gating:distanceSquare data-type:value="4"/>
  </gating:EllipsoidGate>
  <gating:QuadrantGate gating:id="Quadrant1">
    <gating:divider gating:id="A" gating:compensation-ref="uncompensated" gating:transformation-ref="Asinh_1000_4_1">
      <data-type:fcs-dimension data-type:name="FL3-H"/>
      <gating:value>0.45</gating:value>
    </gating:divider>
    <gating:divider gating:id="B" gating:compensation-ref="uncompensated">
      <data-type:fcs-dimension data-type:name="FL4-H"/>
      <gating:value>150</gating:value>
    </gating:divider>
    <gating:Quadrant gating:id="FL3P-FL4P"><gating:position gating:divider_ref="A" gating:location="0.9"/><gating:position gating:divider_ref="B" gating:location="1000"/></gating:Quadrant>
    <gating:Quadrant gating:id="FL3N-FL4P"><gating:position gating:divider_ref="A" gating:location="0.1"/><gating:position gating:divider_ref="B" gating:location="1000"/></gating:Quadrant>
    <gating:Quadrant gating:id="FL3N-FL4N"><gating:position gating:divider_ref="A" gating:location="0.1"/><gating:position gating:divider_ref="B" gating:location="10"/></gating:Quadrant>
    <gating:Quadrant gating:id="FL3P-FL4N"><gating:position gating:divider_ref="A" gating:location="0.45"/><gating:position gating:divider_ref="B" gating:location="10"/></gating:Quadrant>
  </gating:QuadrantGate>
  <gating:BooleanGate gating:id="And1">
    <gating:and>
      <gating:gateReference gating:ref="Polygon4"/>
      <gating:gateReference gating:ref="Ellipse1" gating:use-as-complement="true"/>
    </gating:and>
  </gating:BooleanGate>
  <gating:BooleanGate gating:id="Or1">
    <gating:or>
      <gating:gateReference gating:ref="Rect2D"/>
      <gating:gateReference gating:ref="FL3P-FL4P"/>
    </gating:or>
  </gating:BooleanGate>
  <gating:BooleanGate gating:id="Not1" gating:parent_id="Polygon4">
    <gating:not><gating:gateReference gating:ref="Range1"/></gating:not>
  </gating:BooleanGate>`);

test('a compliance-style document imports into CytoWeave gates', () => {
  const result = importGatingML(COMPLIANCE);
  assert.deepEqual(result.warnings, []);
  const gates = byName(result.gates);
  const polygon = gates.Polygon4;
  assert.equal(polygon.type, 'polygon');
  assert.equal(polygon.name, 'Polygon4');
  assert.equal(polygon.parentId, null);
  // Dimensions keep the compensation the document names (here none).
  assert.deepEqual(polygon.dims, [
    { channel: 'FL3-H', transform: { type: 'logicle', T: 10000, W: 0.5, M: 4.5, A: 0 }, compensation: 'uncompensated' },
    { channel: 'FL4-H', transform: { type: 'logicle', T: 10000, W: 0.5, M: 4.5, A: 0 }, compensation: 'uncompensated' },
  ]);
  assert.deepEqual(polygon.geometry.vertices[0], [0.12, 0.27]);
  assert.equal(gates.Range1.type, 'range');
  assert.equal(gates.Range1.parentId, polygon.id);
  assert.deepEqual(gates.Range1.geometry, { min: 0.4, max: 0.8 });
  assert.deepEqual(gates.Rect2D.geometry, { min: [0.2, 0.3], max: [null, 0.75] });
  assert.deepEqual(gates.Ellipse1.dims[0].transform, { type: 'linear', min: 0, max: 1 });
  assert.equal(gates.Ellipse1.type, 'ellipse');
  const quadrants = ['FL3P-FL4P', 'FL3N-FL4P', 'FL3N-FL4N', 'FL3P-FL4N'].map((id) => gates[id]);
  assert.deepEqual(quadrants.map((q) => q.geometry.quadrant), ['UR', 'UL', 'LL', 'LR']);
  assert.ok(quadrants.every((q) => q.type === 'quadrant' && q.linkId === quadrants[0].linkId));
  assert.deepEqual(quadrants[0].geometry.center, [0.45, 150]);
  assert.deepEqual(quadrants[0].dims.map((d) => d.channel), ['FL3-H', 'FL4-H']);
  assert.equal(gates.And1.type, 'boolean');
  assert.equal(gates.And1.geometry.op, 'and');
  const helper = result.gates.find((g) => g.meta.helper);
  assert.deepEqual(helper.geometry, { op: 'not', operands: [gates.Ellipse1.id] });
  assert.deepEqual(gates.And1.geometry.operands, [polygon.id, helper.id]);
  assert.deepEqual(gates.Or1.geometry.operands, [gates.Rect2D.id, gates['FL3P-FL4P'].id]);
  assert.deepEqual(gates.Not1.geometry, { op: 'not', operands: [gates.Range1.id] });
  // Parents and operands come before the gates that use them.
  const order = result.gates.map((g) => g.id);
  for (const gate of result.gates) {
    if (gate.parentId) assert.ok(order.indexOf(gate.parentId) < order.indexOf(gate.id));
    for (const op of gate.geometry.operands ?? []) assert.ok(order.indexOf(op) < order.indexOf(gate.id));
  }
  // Ids are fresh CytoWeave ids.
  assert.ok(result.gates.every((g) => /^g/.test(g.id) && !['Polygon4', 'Range1'].includes(g.id)));
});

// A small evaluator with CytoWeave's semantics (the engine's: not = parent − operands).
function evaluate(gates, columns, count) {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const memo = new Map();
  const scaled = (d) => {
    const t = createTransform(d.transform);
    return Float64Array.from(columns[d.channel], (v) => t.forward(v));
  };
  const population = (id) => {
    if (!id) return null;
    if (memo.has(id)) return memo.get(id);
    const gate = byId.get(id);
    const parent = population(gate.parentId);
    let result;
    if (gate.type === 'boolean') {
      const ops = gate.geometry.operands.map(population);
      let combined;
      if (gate.geometry.op === 'and') combined = ops.reduce((a, b) => intersect(a, b));
      else if (gate.geometry.op === 'or') combined = ops.reduce((a, b) => union(a, b, count));
      else combined = difference(parent, ops.reduce((a, b) => union(a, b, count)), count);
      result = intersect(parent, combined);
    } else {
      result = membership(gate.type, gate.geometry, scaled(gate.dims[0]), gate.dims[1] ? scaled(gate.dims[1]) : null, parent, count);
    }
    memo.set(id, result);
    return result;
  };
  return population;
}

function insidePolygon(x, y, vertices) {
  // Crossing-number test written independently of gates.js.
  let crossings = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const [x1, y1] = vertices[i];
    const [x2, y2] = vertices[(i + 1) % vertices.length];
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
      const t = (y - y1) / (y2 - y1);
      if (x < x1 + t * (x2 - x1)) crossings += 1;
    }
  }
  return crossings % 2 === 1;
}

test('imported gates select the same events as the Gating-ML definitions', () => {
  const random = createRandom(7);
  const count = 6000;
  const columns = {};
  for (const name of ['FL1-H', 'FL2-H', 'FL3-H', 'FL4-H']) {
    const column = new Float64Array(count);
    for (let e = 0; e < count; e += 1) {
      const mode = random();
      column[e] = mode < 0.3 ? 40 * random.gaussian() : mode < 0.6 ? 350 + 120 * random.gaussian() : 10 ** (1 + 3 * random());
    }
    columns[name] = column;
  }
  const { gates } = importGatingML(COMPLIANCE);
  const named = byName(gates);
  const population = evaluate(gates, columns, count);
  const members = (id) => {
    const pop = population(id);
    const set = new Uint8Array(count);
    if (pop === null) set.fill(1);
    else for (const e of pop) set[e] = 1;
    return set;
  };
  // Independent definitions, in data units where the transformation has a closed form.
  const logicle = createTransform({ type: 'logicle', T: 10000, W: 0.5, M: 4.5, A: 0 });
  const polygonVertices = [[0.12, 0.27], [0.85, 0.31], [0.92, 0.88], [0.42, 0.62], [0.2, 0.95]];
  const fasinh = (x) => (Math.asinh((x * Math.sinh(4 * Math.LN10)) / 1000) + Math.LN10) / (5 * Math.LN10);
  const expected = {
    Polygon4: (e) => insidePolygon(logicle.forward(columns['FL3-H'][e]), logicle.forward(columns['FL4-H'][e]), polygonVertices),
    // flog: log10(x / 10⁴) / 5 + 1 in [0.4, 0.8)  ⇔  x in [10⁴·10^−3, 10⁴·10^−1)
    Range1: (e) => expected.Polygon4(e) && columns['FL1-H'][e] >= 10 && columns['FL1-H'][e] < 1000,
    // flin: (x + 100) / 1100 ≥ 0.2 ⇔ x ≥ 120
    Rect2D: (e) => columns['FL1-H'][e] >= 120 && fasinh(columns['FL2-H'][e]) >= 0.3 && fasinh(columns['FL2-H'][e]) < 0.75,
    Ellipse1: (e) => {
      const dx = columns['FL1-H'][e] - 300;
      const dy = columns['FL2-H'][e] - 400;
      const det = 10000 * 5000 - 3000 * 3000;
      return (5000 * dx * dx - 2 * 3000 * dx * dy + 10000 * dy * dy) / det <= 4;
    },
    'FL3P-FL4P': (e) => fasinh(columns['FL3-H'][e]) >= 0.45 && columns['FL4-H'][e] >= 150,
    'FL3N-FL4P': (e) => fasinh(columns['FL3-H'][e]) < 0.45 && columns['FL4-H'][e] >= 150,
    'FL3N-FL4N': (e) => fasinh(columns['FL3-H'][e]) < 0.45 && columns['FL4-H'][e] < 150,
    'FL3P-FL4N': (e) => fasinh(columns['FL3-H'][e]) >= 0.45 && columns['FL4-H'][e] < 150,
    And1: (e) => expected.Polygon4(e) && !expected.Ellipse1(e),
    Or1: (e) => expected.Rect2D(e) || expected['FL3P-FL4P'](e),
    Not1: (e) => expected.Polygon4(e) && !expected.Range1(e),
  };
  for (const [id, predicate] of Object.entries(expected)) {
    const got = members(named[id].id);
    let n = 0;
    for (let e = 0; e < count; e += 1) {
      assert.equal(Boolean(got[e]), predicate(e), `${id}, event ${e}`);
      n += got[e];
    }
    assert.ok(n > 20 && n < count - 20, `${id} selects ${n} events, too few to be a meaningful check`);
  }
});

test('compensation matrices, references and ratio dimensions import', () => {
  const result = importGatingML(doc(`
    <transforms:transformation transforms:id="Ratio1">
      <transforms:fratio transforms:A="1" transforms:B="0" transforms:C="0">
        <data-type:fcs-dimension data-type:name="FL1-H"/><data-type:fcs-dimension data-type:name="FL2-H"/>
      </transforms:fratio>
    </transforms:transformation>
    <transforms:spectrumMatrix transforms:id="Spill1" transforms:matrix-inverted-already="false">
      <transforms:fluorochromes><data-type:fcs-dimension data-type:name="FITC"/><data-type:fcs-dimension data-type:name="PE"/></transforms:fluorochromes>
      <transforms:detectors><data-type:fcs-dimension data-type:name="FL1-H"/><data-type:fcs-dimension data-type:name="FL2-H"/></transforms:detectors>
      <transforms:spectrum><transforms:coefficient transforms:value="1"/><transforms:coefficient transforms:value="0.25"/></transforms:spectrum>
      <transforms:spectrum><transforms:coefficient transforms:value="0.05"/><transforms:coefficient transforms:value="1"/></transforms:spectrum>
    </transforms:spectrumMatrix>
    <transforms:spectrumMatrix transforms:id="Inverse1" transforms:matrix-inverted-already="true">
      <transforms:fluorochromes><data-type:fcs-dimension data-type:name="A"/><data-type:fcs-dimension data-type:name="B"/></transforms:fluorochromes>
      <transforms:detectors><data-type:fcs-dimension data-type:name="A"/><data-type:fcs-dimension data-type:name="B"/></transforms:detectors>
      <transforms:spectrum><transforms:coefficient transforms:value="1"/><transforms:coefficient transforms:value="-0.5"/></transforms:spectrum>
      <transforms:spectrum><transforms:coefficient transforms:value="0"/><transforms:coefficient transforms:value="1"/></transforms:spectrum>
    </transforms:spectrumMatrix>
    <gating:RectangleGate gating:id="Comp1">
      ${dim('FITC', { comp: 'Spill1', min: 100 })}
      ${dim('FL3-H', { comp: 'FCS', max: 900 })}
    </gating:RectangleGate>
    <gating:RectangleGate gating:id="RatioGate">
      <gating:dimension gating:compensation-ref="uncompensated" gating:min="0.5" gating:max="2"><gating:new-dimension gating:transformation-ref="Ratio1"/></gating:dimension>
    </gating:RectangleGate>`), { now: '2025-01-01T00:00:00Z' });
  assert.deepEqual(result.warnings, []);
  const [spill, inverse] = result.compensations;
  assert.deepEqual(spill.channels, ['FL1-H', 'FL2-H']);
  assert.deepEqual(spill.matrix, [1, 0.25, 0.05, 1]);
  assert.deepEqual(spill.fluorochromes, ['FITC', 'PE']);
  assert.equal(spill.source, 'imported');
  // The inverse of [[1, −0.5], [0, 1]] is [[1, 0.5], [0, 1]].
  assert.deepEqual(inverse.matrix, [1, 0.5, 0, 1]);
  const gates = byName(result.gates);
  assert.deepEqual(gates.Comp1.dims.map((d) => d.channel), ['FL1-H', 'FL3-H']);
  assert.deepEqual(gates.Comp1.meta.compensation, ['Spill1', 'FCS']);
  assert.deepEqual(gates.Comp1.dims.map((d) => d.compensation), [spill.id, 'file']);
  assert.deepEqual(gates.Comp1.geometry, { min: [100, null], max: [null, 900] });
  assert.deepEqual(result.derived.map((d) => [d.kind, d.inputs, d.outputs, d.params]), [['ratio', ['FL1-H', 'FL2-H'], ['Ratio1'], { A: 1, B: 0, C: 0 }]]);
  assert.deepEqual(gates.RatioGate.dims, [{ channel: 'Ratio1', transform: { type: 'linear', min: 0, max: 1 }, compensation: 'uncompensated' }]);
  assert.equal(result.transforms.find((t) => t.id === 'Ratio1').type, 'ratio');
});

test('one-divider quadrants become splits, multi-value dividers boxes, unsupported gates warn', () => {
  const result = importGatingML(doc(`
    <gating:QuadrantGate gating:id="Q1">
      <gating:divider gating:id="D" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FL1-H"/><gating:value>100</gating:value></gating:divider>
      <gating:Quadrant gating:id="Low"><gating:position gating:divider_ref="D" gating:location="1"/></gating:Quadrant>
      <gating:Quadrant gating:id="High"><gating:position gating:divider_ref="D" gating:location="100"/></gating:Quadrant>
    </gating:QuadrantGate>
    <gating:QuadrantGate gating:id="Q2">
      <gating:divider gating:id="E" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FL2-H"/><gating:value>500</gating:value><gating:value>50</gating:value></gating:divider>
      <gating:divider gating:id="F" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FL3-H"/><gating:value>7</gating:value></gating:divider>
      <gating:Quadrant gating:id="Mid"><gating:position gating:divider_ref="E" gating:location="60"/><gating:position gating:divider_ref="F" gating:location="0"/></gating:Quadrant>
      <gating:Quadrant gating:id="MidAnyF"><gating:position gating:divider_ref="E" gating:location="60"/></gating:Quadrant>
    </gating:QuadrantGate>
    <gating:QuadrantGate gating:id="Q3">
      <gating:divider gating:id="G" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FL1-H"/><gating:value>1</gating:value></gating:divider>
      <gating:divider gating:id="H" gating:compensation-ref="uncompensated"><data-type:fcs-dimension data-type:name="FL2-H"/><gating:value>1</gating:value></gating:divider>
      <gating:Quadrant gating:id="RightOnly"><gating:position gating:divider_ref="G" gating:location="5"/></gating:Quadrant>
    </gating:QuadrantGate>
    <gating:RectangleGate gating:id="Cube">
      ${dim('FL1-H', { min: 1 })}${dim('FL2-H', { min: 1 })}${dim('FL3-H', { min: 1 })}
    </gating:RectangleGate>
    <gating:PolygonGate gating:id="ChildOfCube" gating:parent_id="Cube">
      ${dim('FL1-H')}${dim('FL2-H')}${vertex(0, 0)}${vertex(1, 0)}${vertex(1, 1)}
    </gating:PolygonGate>
    <gating:BooleanGate gating:id="UsesChild"><gating:or><gating:gateReference gating:ref="ChildOfCube"/><gating:gateReference gating:ref="Low"/></gating:or></gating:BooleanGate>
    <gating:PolygonGate gating:id="BadTransform">
      ${dim('FL1-H', { t: 'Nope' })}${dim('FL2-H')}${vertex(0, 0)}${vertex(1, 0)}${vertex(1, 1)}
    </gating:PolygonGate>
    <gating:RectangleGate gating:id="Orphan" gating:parent_id="Missing">${dim('FL1-H', { min: 0 })}</gating:RectangleGate>`));
  const gates = byName(result.gates);
  assert.equal(gates.Low.type, 'split');
  assert.deepEqual(gates.Low.geometry, { threshold: 100, side: 'lo' });
  assert.deepEqual(gates.High.geometry, { threshold: 100, side: 'hi' });
  assert.equal(gates.Low.linkId, gates.High.linkId);
  assert.equal(gates.Mid.type, 'rectangle');
  assert.deepEqual(gates.Mid.geometry, { min: [50, null], max: [500, 7] });
  assert.equal(gates.MidAnyF.type, 'range');
  assert.deepEqual(gates.MidAnyF.geometry, { min: 50, max: 500 });
  assert.equal(gates.RightOnly.type, 'split');
  assert.deepEqual(gates.Mid.dims.map((d) => d.compensation), ['uncompensated', 'uncompensated']);
  assert.deepEqual(gates.RightOnly.dims.map((d) => d.channel), ['FL1-H']);
  assert.deepEqual(gates.RightOnly.geometry, { threshold: 1, side: 'hi' });
  // A three-dimensional rectangle imports whole, with its children.
  assert.equal(gates.Cube.type, 'rectangle');
  assert.deepEqual(gates.Cube.geometry, { min: [1, 1, 1], max: [null, null, null] });
  assert.equal(gates.ChildOfCube.parentId, gates.Cube.id);
  assert.equal(gates.UsesChild.type, 'boolean');
  assert.equal(gates.BadTransform, undefined);
  assert.equal(gates.Orphan.parentId, null);
  const text = result.warnings.join('\n');
  assert.doesNotMatch(text, /Cube/);
  assert.match(text, /unknown transformation "Nope"/);
  assert.match(text, /unknown parent "Missing"/);
});

test('N-dimensional ellipsoids, multi-divider quadrants, bounds and non-square spectra import', () => {
  const result = importGatingML(doc(`
    <transforms:transformation transforms:id="Bounded" transforms:boundMin="0.4" transforms:boundMax="0.9">
      <transforms:logicle transforms:T="10000" transforms:W="0.5" transforms:M="4.5" transforms:A="0"/>
    </transforms:transformation>
    <transforms:spectrumMatrix transforms:id="Unmix">
      <transforms:fluorochromes><data-type:fcs-dimension data-type:name="P1"/><data-type:fcs-dimension data-type:name="P2"/></transforms:fluorochromes>
      <transforms:detectors><data-type:fcs-dimension data-type:name="D1"/><data-type:fcs-dimension data-type:name="D2"/><data-type:fcs-dimension data-type:name="D3"/></transforms:detectors>
      <transforms:spectrum><transforms:coefficient transforms:value="1"/><transforms:coefficient transforms:value="0.5"/><transforms:coefficient transforms:value="0"/></transforms:spectrum>
      <transforms:spectrum><transforms:coefficient transforms:value="0"/><transforms:coefficient transforms:value="0.5"/><transforms:coefficient transforms:value="1"/></transforms:spectrum>
    </transforms:spectrumMatrix>
    <gating:EllipsoidGate gating:id="Ball">
      ${dim('FL1-H')}${dim('FL2-H')}${dim('FL3-H', { t: 'Bounded' })}
      <gating:mean><gating:coordinate data-type:value="1"/><gating:coordinate data-type:value="2"/><gating:coordinate data-type:value="0.5"/></gating:mean>
      <gating:covarianceMatrix>
        <gating:row><gating:entry data-type:value="4"/><gating:entry data-type:value="0"/><gating:entry data-type:value="0"/></gating:row>
        <gating:row><gating:entry data-type:value="0"/><gating:entry data-type:value="1"/><gating:entry data-type:value="0"/></gating:row>
        <gating:row><gating:entry data-type:value="0"/><gating:entry data-type:value="0"/><gating:entry data-type:value="0.01"/></gating:row>
      </gating:covarianceMatrix>
      <gating:distanceSquare data-type:value="1"/>
    </gating:EllipsoidGate>
    <gating:QuadrantGate gating:id="Q3D">
      <gating:divider gating:id="A" gating:compensation-ref="FCS"><data-type:fcs-dimension data-type:name="FL1-H"/><gating:value>10</gating:value></gating:divider>
      <gating:divider gating:id="B" gating:compensation-ref="FCS"><data-type:fcs-dimension data-type:name="FL2-H"/><gating:value>20</gating:value></gating:divider>
      <gating:divider gating:id="C" gating:compensation-ref="FCS"><data-type:fcs-dimension data-type:name="FL3-H"/><gating:value>30</gating:value></gating:divider>
      <gating:Quadrant gating:id="PPN"><gating:position gating:divider_ref="A" gating:location="11"/><gating:position gating:divider_ref="B" gating:location="21"/><gating:position gating:divider_ref="C" gating:location="0"/></gating:Quadrant>
    </gating:QuadrantGate>
    <gating:PolygonGate gating:id="OnUnmixed">
      ${dim('P1', { comp: 'Unmix' })}${dim('P2', { comp: 'Unmix' })}${vertex(0, 0)}${vertex(1, 0)}${vertex(1, 1)}
    </gating:PolygonGate>`));
  assert.deepEqual(result.warnings, []);
  const gates = byName(result.gates);
  assert.equal(gates.Ball.type, 'ellipsoid');
  assert.deepEqual(gates.Ball.geometry.mean, [1, 2, 0.5]);
  assert.equal(gates.Ball.geometry.distanceSquare, 1);
  assert.deepEqual(gates.Ball.dims[2].transform, { type: 'logicle', T: 10000, W: 0.5, M: 4.5, A: 0, boundMin: 0.4, boundMax: 0.9 });
  assert.equal(gates.PPN.type, 'rectangle');
  assert.deepEqual(gates.PPN.geometry, { min: [10, 20, null], max: [null, null, 30] });
  assert.deepEqual(gates.PPN.dims.map((d) => d.compensation), ['file', 'file', 'file']);
  // A non-square spectrum matrix becomes channels unmixed from the raw detectors by least squares.
  const unmix = result.derived.find((d) => d.kind === 'unmix');
  assert.deepEqual([unmix.inputs, unmix.outputs], [['D1', 'D2', 'D3'], ['P1', 'P2']]);
  // S = [[1, .5, 0], [0, .5, 1]]: W = Sᵀ(SSᵀ)⁻¹ unmixes every combination of the two spectra.
  const W = unmix.params.matrix;
  for (const [a, b] of [[1, 0], [0, 1], [3, -2]]) {
    const detectors = [a, 0.5 * a + 0.5 * b, b];
    for (let j = 0; j < 2; j += 1) close(detectors.reduce((sum, v, i) => sum + v * W[i * 2 + j], 0), [a, b][j], 1e-12);
  }
  assert.deepEqual(gates.OnUnmixed.dims.map((d) => [d.channel, d.compensation]), [['P1', 'uncompensated'], ['P2', 'uncompensated']]);
});

test('tolerates default namespaces, missing compensation-ref and foreign custom_info names', () => {
  const result = importGatingML(`<Gating-ML xmlns="http://www.isac-net.org/std/Gating-ML/v2.0/gating" xmlns:data-type="http://www.isac-net.org/std/Gating-ML/v2.0/datatypes">
    <RectangleGate id="r1">
      <data-type:custom_info><cytobank><name>CD3+ T cells</name></cytobank></data-type:custom_info>
      <dimension min="5"><data-type:fcs-dimension data-type:name="CD3"/></dimension>
    </RectangleGate>
  </Gating-ML>`);
  assert.equal(result.gates[0].name, 'CD3+ T cells');
  assert.deepEqual(result.gates[0].geometry, { min: 5, max: null });
  assert.match(result.warnings.join('\n'), /no compensation-ref/);
  assert.throws(() => importGatingML('<Workspace/>'), /not a Gating-ML document/);
});

function sampleWorkspace() {
  const logicle = { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 };
  const biex = { type: 'biex', maxValue: 262144, widthBasis: -100, positiveDecades: 4.42, extraNegativeDecades: 0 };
  const scatter = { type: 'linear', min: 0, max: 262144 };
  const asinh = { type: 'arcsinh', cofactor: 150, max: 262144, min: -150 * Math.sinh(1) };
  return {
    format: 'cytoweave-workspace',
    name: 'Round trip',
    samples: [{ id: 's1', name: 'a.fcs', compensationId: 'c1', channels: [] }, { id: 's2', name: 'b.fcs', compensationId: 'c1', channels: [] }],
    compensations: [{ id: 'c1', name: 'Manual 1', channels: ['FITC-A', 'PE-A'], matrix: [1, 0.1, 0.02, 1], source: 'manual' }],
    derived: [{ id: 'd1', kind: 'ratio', params: { A: 1, B: 0, C: 0 }, inputs: ['FITC-A', 'PE-A'], outputs: ['FITC/PE'] }, { id: 'd2', kind: 'umap', inputs: [], outputs: ['UMAP1', 'UMAP2'] }],
    gates: [
      { id: 'gCells', name: 'Cells', parentId: null, type: 'polygon', dims: [{ channel: 'FSC-A', transform: scatter }, { channel: 'SSC-A', transform: scatter }], geometry: { vertices: [[0.1, 0.05], [0.8, 0.1], [0.7, 0.7], [0.15, 0.5]] }, color: '#3b82f6', overrides: { s2: { vertices: [[0.12, 0.05], [0.8, 0.1], [0.7, 0.7], [0.15, 0.5]] } } },
      { id: 'gSing', name: 'Singlets', parentId: 'gCells', type: 'rectangle', dims: [{ channel: 'FSC-A', transform: scatter }, { channel: 'FSC-H', transform: { type: 'linear', min: 1000, max: 200000 } }], geometry: { min: [0.1, 0.2], max: [0.9, null] } },
      { id: 'gLive', name: 'Live', parentId: 'gSing', type: 'range', dims: [{ channel: 'Viability', transform: biex }], geometry: { min: null, max: 0.4 } },
      { id: 'gBlob', name: 'Blob', parentId: 'gLive', type: 'ellipse', dims: [{ channel: 'FITC-A', transform: asinh }, { channel: 'PE-A', transform: logicle }], geometry: { center: [0.5, 0.6], radii: [0.2, 0.08], angle: 0.6 } },
      { id: 'gLinEllipse', name: 'Scatter blob', parentId: null, type: 'ellipse', dims: [{ channel: 'FSC-A', transform: { type: 'linear', min: 5000, max: 250000 } }, { channel: 'SSC-A', transform: scatter }], geometry: { center: [0.4, 0.3], radii: [0.1, 0.05], angle: -0.4 } },
      ...['UL', 'UR', 'LR', 'LL'].map((quadrant) => ({ id: `gQ${quadrant}`, name: `Q ${quadrant}`, parentId: 'gLive', type: 'quadrant', linkId: 'q1', dims: [{ channel: 'FITC-A', transform: logicle }, { channel: 'PE-A', transform: logicle }], geometry: { center: [0.45, 0.5], quadrant } })),
      { id: 'gLo', name: 'CD3−', parentId: 'gLive', type: 'split', linkId: 's1', dims: [{ channel: 'PE-A', transform: { type: 'log', min: 1, max: 262144 } }], geometry: { threshold: 0.6, side: 'lo' } },
      { id: 'gHi', name: 'CD3+', parentId: 'gLive', type: 'split', linkId: 's1', dims: [{ channel: 'PE-A', transform: { type: 'log', min: 1, max: 262144 } }], geometry: { threshold: 0.6, side: 'hi' } },
      { id: 'gRatio', name: 'High ratio', parentId: 'gLive', type: 'range', dims: [{ channel: 'FITC/PE', transform: { type: 'linear', min: 0, max: 1 } }], geometry: { min: 2, max: null } },
      { id: 'gAnd', name: 'Both', parentId: 'gLive', type: 'boolean', dims: [], geometry: { op: 'and', operands: ['gQUR', 'gHi'] } },
      { id: 'gOr', name: 'Either', parentId: null, type: 'boolean', dims: [], geometry: { op: 'or', operands: ['gBlob'] } },
      { id: 'gNot', name: 'Neither', parentId: 'gLive', type: 'boolean', dims: [], geometry: { op: 'not', operands: ['gQUR', 'gQLL'] } },
      { id: 'gClusters', name: 'Clusters 3+5', parentId: 'gLive', type: 'category', dims: [{ channel: 'FlowSOM' }], geometry: { values: [3, 5] } },
      { id: 'gUnderClusters', name: 'Under clusters', parentId: 'gClusters', type: 'range', dims: [{ channel: 'FITC-A', transform: logicle }], geometry: { min: 0.5, max: null } },
      { id: 'gUmap', name: 'UMAP island', parentId: null, type: 'rectangle', dims: [{ channel: 'UMAP1', transform: { type: 'linear', min: -10, max: 10 } }, { channel: 'UMAP2', transform: { type: 'linear', min: -10, max: 10 } }], geometry: { min: [0.1, 0.1], max: [0.3, 0.3] } },
    ],
  };
}

function pathOf(gates, gate) {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const names = [];
  for (let g = gate; g; g = g.parentId ? byId.get(g.parentId) : null) names.unshift(g.name);
  return names.join('/');
}

test('export and import round-trip a workspace gate tree', () => {
  const ws = sampleWorkspace();
  const { xml, warnings } = exportGatingML(ws, { now: '2025-01-01T00:00:00Z' });
  const text = warnings.join('\n');
  assert.match(text, /"Clusters 3\+5" was not exported: category gates/);
  assert.match(text, /"Under clusters" was not exported: its parent "Clusters 3\+5" was not exported/);
  assert.match(text, /"Cells" has sample-specific adjustments/);
  assert.match(text, /"UMAP1" is derived \(umap\)/);
  assert.match(xml, /<transforms:spectrumMatrix transforms:id="c1"/);
  assert.match(xml, /gating:compensation-ref="c1"/);
  assert.match(xml, /<transforms:fratio/);
  assert.match(text, /Biexponential \(width -100, 4\.42 decades\) \(FlowJo\) has no Gating-ML equivalent/);
  const result = importGatingML(xml);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /was a FlowJo biexponential/);
  const original = ws.gates.filter((g) => !['gClusters', 'gUnderClusters'].includes(g.id));
  const imported = result.gates.filter((g) => !g.meta.helper && !/union of excluded/.test(g.name));
  assert.equal(imported.length, original.length);
  for (const gate of original) {
    const path = pathOf(ws.gates, gate);
    const back = imported.find((g) => pathOf(result.gates, g) === path);
    assert.ok(back, `missing ${path}`);
    assert.equal(back.type, gate.type, path);
    if (gate.color) assert.equal(back.color, gate.color);
    if (gate.type === 'boolean') {
      assert.equal(back.geometry.op, gate.geometry.op, path);
      continue;
    }
    assert.deepEqual(back.dims.map((d) => d.channel), gate.dims.map((d) => d.channel), path);
    if (gate.id === 'gLive') {
      // The biex axis comes back as its closest logicle, with the bound converted in data units.
      assert.equal(back.dims[0].transform.type, 'logicle');
      close(createTransform(back.dims[0].transform).inverse(back.geometry.max), createTransform(gate.dims[0].transform).inverse(0.4), 1e-6);
      assert.equal(back.geometry.min, null);
      continue;
    }
    gate.dims.forEach((d, k) => {
      // Linear scales starting above zero (flin cannot express them) come back as data units.
      const raw = d.transform.type === 'linear' && d.transform.min > 0;
      const expected = raw ? { type: 'linear', min: 0, max: 1 } : d.transform;
      assert.ok(sameTransformFunction(expected, back.dims[k].transform), `${path} dim ${k}`);
    });
    const flat = (g) => JSON.stringify(g.geometry, (key, value) => (typeof value === 'number' ? +value.toPrecision(10) : value));
    // The linear scale starting at 1000 (FSC-H) and at 5000 are written in data units and come
    // back with the identity transform; compare those in data units.
    if (gate.id === 'gSing') {
      assert.deepEqual(back.geometry.min[0], 0.1);
      close(back.geometry.min[1], 1000 + 0.2 * 199000, 1e-9);
      assert.equal(back.geometry.max[1], null);
      continue;
    }
    if (gate.id === 'gLinEllipse') {
      // Only FSC-A (linear from 5000) is written in data units, x = 5000 + 245000 u; SSC-A
      // (linear from 0) is written through flin and keeps its scale coordinates.
      const t = { x: (u) => 5000 + 245000 * u, y: (v) => v };
      close(back.geometry.center[0], t.x(0.4), 1e-6);
      close(back.geometry.center[1], t.y(0.3), 1e-6);
      // A boundary point of the original maps onto the imported boundary.
      const [cx, cy] = gate.geometry.center;
      const p = [cx + 0.1 * Math.cos(-0.4), cy + 0.1 * Math.sin(-0.4)];
      const q = [t.x(p[0]) - back.geometry.center[0], t.y(p[1]) - back.geometry.center[1]];
      const cos = Math.cos(back.geometry.angle);
      const sin = Math.sin(back.geometry.angle);
      const u = q[0] * cos + q[1] * sin;
      const v = -q[0] * sin + q[1] * cos;
      close((u / back.geometry.radii[0]) ** 2 + (v / back.geometry.radii[1]) ** 2, 1, 1e-9);
      continue;
    }
    assert.equal(flat(back), flat(gate), path);
  }
  // Transform specs are restored exactly from CytoWeave's custom_info.
  const blob = imported.find((g) => g.name === 'Blob');
  assert.deepEqual(blob.dims.map((d) => d.transform), ws.gates.find((g) => g.id === 'gBlob').dims.map((d) => d.transform));
  // Linked gates stay linked; the multi-operand not keeps its meaning through an OR helper.
  const quads = imported.filter((g) => g.type === 'quadrant');
  assert.equal(new Set(quads.map((g) => g.linkId)).size, 1);
  const neither = imported.find((g) => g.name === 'Neither');
  const unionGate = result.gates.find((g) => g.id === neither.geometry.operands[0]);
  assert.equal(unionGate.geometry.op, 'or');
  assert.deepEqual(unionGate.geometry.operands.map((id) => result.gates.find((g) => g.id === id).name).sort(), ['Q LL', 'Q UR']);
  const either = imported.find((g) => g.name === 'Either');
  assert.deepEqual(either.geometry.operands.map((id) => result.gates.find((g) => g.id === id).name), ['Blob', 'Blob']);
  assert.deepEqual(result.compensations.map((c) => [c.name, c.channels, c.matrix]), [['c1', ['FITC-A', 'PE-A'], [1, 0.1, 0.02, 1]]]);
  assert.deepEqual(result.derived.map((d) => [d.inputs, d.outputs]), [[['FITC-A', 'PE-A'], ['FITC/PE']]]);
  // Gates that follow each sample's compensation come back unpinned.
  assert.ok(imported.every((g) => g.dims.every((d) => d.compensation === undefined)));
});

test('pinned compensations, N-dimensional gates, bounds and unmixing round-trip', () => {
  const source = doc(`
    <transforms:transformation transforms:id="Bounded" transforms:boundMin="0.4">
      <transforms:logicle transforms:T="10000" transforms:W="0.5" transforms:M="4.5" transforms:A="0"/>
    </transforms:transformation>
    <transforms:spectrumMatrix transforms:id="Spill">
      <transforms:fluorochromes><data-type:fcs-dimension data-type:name="FL1-H"/><data-type:fcs-dimension data-type:name="FL2-H"/></transforms:fluorochromes>
      <transforms:detectors><data-type:fcs-dimension data-type:name="FL1-H"/><data-type:fcs-dimension data-type:name="FL2-H"/></transforms:detectors>
      <transforms:spectrum><transforms:coefficient transforms:value="1"/><transforms:coefficient transforms:value="0.2"/></transforms:spectrum>
      <transforms:spectrum><transforms:coefficient transforms:value="0.1"/><transforms:coefficient transforms:value="1"/></transforms:spectrum>
    </transforms:spectrumMatrix>
    <transforms:spectrumMatrix transforms:id="Unmix">
      <transforms:fluorochromes><data-type:fcs-dimension data-type:name="P1"/><data-type:fcs-dimension data-type:name="P2"/></transforms:fluorochromes>
      <transforms:detectors><data-type:fcs-dimension data-type:name="D1"/><data-type:fcs-dimension data-type:name="D2"/><data-type:fcs-dimension data-type:name="D3"/></transforms:detectors>
      <transforms:spectrum><transforms:coefficient transforms:value="1"/><transforms:coefficient transforms:value="0.5"/><transforms:coefficient transforms:value="0"/></transforms:spectrum>
      <transforms:spectrum><transforms:coefficient transforms:value="0"/><transforms:coefficient transforms:value="0.5"/><transforms:coefficient transforms:value="1"/></transforms:spectrum>
    </transforms:spectrumMatrix>
    <gating:RectangleGate gating:id="Box">
      ${dim('FL1-H', { comp: 'Spill', min: 1, max: 9 })}${dim('FL2-H', { comp: 'FCS', min: 2 })}${dim('FL3-H', { t: 'Bounded', max: 0.7 })}
    </gating:RectangleGate>
    <gating:EllipsoidGate gating:id="Ball" gating:parent_id="Box">
      ${dim('FL1-H', { comp: 'Spill' })}${dim('FL2-H', { comp: 'Spill' })}${dim('FL3-H')}
      <gating:mean><gating:coordinate data-type:value="1"/><gating:coordinate data-type:value="2"/><gating:coordinate data-type:value="3"/></gating:mean>
      <gating:covarianceMatrix>
        <gating:row><gating:entry data-type:value="4"/><gating:entry data-type:value="1"/><gating:entry data-type:value="0"/></gating:row>
        <gating:row><gating:entry data-type:value="1"/><gating:entry data-type:value="2"/><gating:entry data-type:value="0"/></gating:row>
        <gating:row><gating:entry data-type:value="0"/><gating:entry data-type:value="0"/><gating:entry data-type:value="1"/></gating:row>
      </gating:covarianceMatrix>
      <gating:distanceSquare data-type:value="2.5"/>
    </gating:EllipsoidGate>
    <gating:PolygonGate gating:id="OnUnmixed">
      ${dim('P1', { comp: 'Unmix' })}${dim('P2', { comp: 'Unmix' })}${vertex(0, 0)}${vertex(1, 0)}${vertex(1, 1)}
    </gating:PolygonGate>`);
  const first = importGatingML(source);
  assert.deepEqual(first.warnings, []);
  let ws = createWorkspace('Round trip');
  for (const c of first.compensations) ws = addCompensation(ws, c).ws;
  for (const d of first.derived) ws = addDerived(ws, d).ws;
  ws = addGates(ws, first.gates).ws;
  const { xml, warnings } = exportGatingML(ws);
  assert.deepEqual(warnings, []);
  assert.match(xml, /transforms:boundMin="0.4"/);
  assert.match(xml, /transforms:matrix-inverted-already="true"/);
  const second = importGatingML(xml);
  assert.deepEqual(second.warnings, []);
  const [a, b] = [first, second].map((r) => Object.fromEntries(r.gates.map((g) => [g.name, g])));
  const spillOf = (r) => r.compensations.find((c) => c.name === 'Spill' || c.name === first.compensations[0].id)?.id;
  for (const id of ['Box', 'Ball', 'OnUnmixed']) {
    assert.equal(b[id].type, a[id].type, id);
    assert.deepEqual(b[id].geometry, a[id].geometry, id);
    assert.deepEqual(b[id].dims.map((d) => d.transform), a[id].dims.map((d) => d.transform), id);
    // References keep their meaning: the matrix, the file's matrix, or none.
    const meaning = (r, dims) => dims.map((d) => (d.compensation === spillOf(r) ? 'Spill' : d.compensation));
    assert.deepEqual(meaning(second, b[id].dims), meaning(first, a[id].dims), id);
  }
  assert.equal(b.Ball.parentId, b.Box.id);
  const unmix = second.derived.find((d) => d.kind === 'unmix');
  assert.deepEqual(unmix.outputs, ['P1', 'P2']);
  first.derived.find((d) => d.kind === 'unmix').params.matrix.forEach((v, i) => close(unmix.params.matrix[i], v, 1e-9));
});

test('export honors a sample, the file compensation and plain output', () => {
  const ws = sampleWorkspace();
  ws.compensations[0].source = 'file';
  const { xml, warnings } = exportGatingML(ws, { sampleId: 's2', customInfo: false, gateIds: ['gSing'] });
  assert.ok(!warnings.some((w) => /sample-specific/.test(w)));
  assert.doesNotMatch(xml, /custom_info|cytoweave/);
  const result = importGatingML(xml);
  assert.equal(result.gates.length, 2); // Singlets and its parent
  const cells = result.gates.find((g) => g.type === 'polygon');
  assert.deepEqual(cells.geometry.vertices[0], [0.12, 0.05]);
  assert.match(xml, /gating:compensation-ref="uncompensated"/);
  const blob = exportGatingML(ws, { gateIds: ['gBlob'], customInfo: false });
  assert.match(blob.xml, /gating:compensation-ref="FCS"/);
  const none = exportGatingML({ ...ws, samples: [{ id: 's1', compensationId: 'none' }] }, { gateIds: ['gBlob'] });
  assert.doesNotMatch(none.xml, /compensation-ref="(FCS|c1)"/);
});
