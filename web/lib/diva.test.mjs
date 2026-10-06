import assert from 'node:assert/strict';
import test from 'node:test';
import { divaLogicle, importDiva } from './diva.js';

const param = (name, { log = false, max = 262143, comp = null, scale = 0 } = {}) => `
  <parameter name="${name}" type="30"><is_log>${log}</is_log><min>0.0</min><max>${max}</max>
    <biexp_scale>${scale}</biexp_scale><comp_biexp_scale>${scale}</comp_biexp_scale><manual_biexp_scale>0</manual_biexp_scale>
    <can_be_compensated>${Boolean(comp)}</can_be_compensated>
    ${comp ? `<compensation>${comp.map((c) => `<compensation_coefficient>${c}</compensation_coefficient>`).join('')}</compensation>` : ''}
  </parameter>`;

const axes = (x, y) => `<is_x_parameter_scaled>${x.scaled}</is_x_parameter_scaled><is_y_parameter_scaled>${y.scaled}</is_y_parameter_scaled>
  <is_x_parameter_log>${x.log}</is_x_parameter_log><is_y_parameter_log>${y.log}</is_y_parameter_log>
  <x_parameter_scale_value>${x.r ?? 0}</x_parameter_scale_value><y_parameter_scale_value>${y.r ?? 0}</y_parameter_scale_value>`;
const LIN = { scaled: false, log: false };
const BIEX = { scaled: true, log: true, r: 162 };

// Compensation matrix C (columns: coefficients of each parameter) for spillover [[1, 0.1], [0.2, 1]].
const det = 1 - 0.1 * 0.2;
const C = [[1 / det, -0.1 / det], [-0.2 / det, 1 / det]];

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<bdfacs version="Version 6.1.3"><experiment name="Demo"><log_decades>5</log_decades>
<specimen name="Blood">
  <tube name="_001"><data_filename>A.fcs</data_filename>
    <instrument_settings name="Cytometer Settings"><compensation_enabled>true</compensation_enabled><use_auto_biexp_scale>true</use_auto_biexp_scale>
      ${param('FSC-A')}${param('SSC-A')}
      ${param('FITC-A', { log: true, max: 5.4185, comp: [C[0][0], C[1][0]], scale: 162 })}
      ${param('PE-A', { log: true, max: 5.4185, comp: [C[0][1], C[1][1]], scale: 162 })}
    </instrument_settings>
    <gates>
      <gate fullname="All Events" type="EventSource_Classifier"><name>All Events</name><num_events>1000</num_events></gate>
      <gate fullname="All Events\\P1" type="Region_Classifier"><name>P1</name><num_events>900</num_events><parent>All Events</parent>
        <region xparm="FSC-A" yparm="SSC-A" type="RECTANGLE_REGION"><points><point x="10000" y="0"/><point x="200000" y="0"/><point x="200000" y="100000"/><point x="10000" y="100000"/></points></region>${axes(LIN, LIN)}</gate>
      <gate fullname="All Events\\P1\\P2" type="Region_Classifier"><name>P2</name><num_events>300</num_events><parent>All Events\\P1</parent>
        <region xparm="FITC-A" yparm="PE-A" type="POLYGON_REGION"><points><point x="2048" y="0"/><point x="4095" y="0"/><point x="4095" y="2048"/></points></region>${axes(BIEX, BIEX)}</gate>
      <gate fullname="All Events\\P1\\P3" type="Region_Classifier"><name>P3</name><num_events>200</num_events><parent>All Events\\P1</parent>
        <region xparm="PE-A" type="INTERVAL_REGION"><points><point x="2.0" y="40"/><point x="4.0" y="40"/></points></region>${axes({ scaled: false, log: true }, LIN)}</gate>
      <gate fullname="All Events\\P1\\$123" type="Composite_Classifier"><name>$123</name><num_events>0</num_events><parent>All Events\\P1</parent>
        <region name="$123" xparm="FITC-A" yparm="PE-A" type="BINNER_REGION"><points><point x="1024" y="2048"/></points></region>${axes(BIEX, BIEX)}
        <bin>All Events\\P1\\Q1</bin><bin>All Events\\P1\\Q2</bin><bin>All Events\\P1\\Q3</bin><bin>All Events\\P1\\Q4</bin><input>All Events\\P1</input></gate>
      ${[['Q1', '0', '4095'], ['Q2', '4095', '4095'], ['Q3', '0', '0'], ['Q4', '4095', '0']].map(([q, x, y]) => `
      <gate fullname="All Events\\P1\\${q}" type="Region_Classifier"><name>${q}</name><num_events>10</num_events><parent>All Events\\P1</parent>
        <region name="${q}" xparm="FITC-A" yparm="PE-A" type="POLYGON_REGION"><points><point x="1024" y="2048"/><point x="${x}" y="2048"/><point x="${x}" y="${y}"/><point x="1024" y="${y}"/></points></region>${axes(BIEX, BIEX)}</gate>`).join('')}
      <gate fullname="All Events\\Rest of All Events" type="RestOf_Classifier"><name>Rest of All Events</name><num_events>100</num_events><parent>All Events</parent><input>All Events\\P1</input></gate>
    </gates>
  </tube>
</specimen></experiment></bdfacs>`;

test('the logicle of a Diva biexponential axis', () => {
  assert.deepEqual(divaLogicle(0), { type: 'logicle', T: 262144, W: 0, M: 4.5, A: 0 });
  const w = divaLogicle(162).W;
  assert.ok(Math.abs(w - (4.5 - Math.log10(262144 / 162)) / 2) < 1e-12);
});

test('tubes, counts, compensation, every region type and quadrants', () => {
  const result = importDiva(XML);
  assert.equal(result.format, 'diva');
  assert.deepEqual(result.groups.map((g) => g.name), ['Blood']);
  const [tube] = result.samples;
  assert.equal(tube.name, 'Blood _001');
  assert.equal(tube.fileName, 'A.fcs');
  assert.equal(tube.eventCount, 1000);
  assert.equal(tube.populationCounts['P1/P2'], 300);
  assert.equal(tube.populationCounts['P1/$123'], undefined, 'the hidden quadrant center is not a population');
  // Spillover = C⁻¹.
  assert.deepEqual(tube.compensation.channels, ['FITC-A', 'PE-A']);
  [1, 0.1, 0.2, 1].forEach((v, i) => assert.ok(Math.abs(tube.compensation.matrix[i] - v) < 1e-9, `matrix ${i}`));
  const gate = (name) => tube.gates.find((g) => g.name === name);
  assert.deepEqual(gate('P1').geometry, { min: [10000 / 262144, 0], max: [200000 / 262144, 100000 / 262144] });
  // Biexponential: bins over 4096 on the axis' logicle.
  assert.deepEqual(gate('P2').geometry.vertices[1], [4095 / 4096, 0]);
  assert.equal(gate('P2').dims[0].transform.type, 'logicle');
  assert.deepEqual(gate('P2').meta.compensated, [true, true]);
  // Log: decades over the axis' range.
  assert.equal(gate('P3').type, 'range');
  assert.ok(Math.abs(gate('P3').geometry.min - 2 / 5.4185) < 1e-12);
  // Quadrants: one linked set around the binner's center.
  const quads = ['Q1', 'Q2', 'Q3', 'Q4'].map(gate);
  assert.deepEqual(quads.map((q) => q.geometry.quadrant), ['UL', 'UR', 'LL', 'LR']);
  assert.deepEqual(quads[0].geometry.center, [0.25, 0.5]);
  assert.equal(new Set(quads.map((q) => q.linkId)).size, 1);
  // "Rest of All Events": events in no listed gate.
  assert.deepEqual(gate('Rest of All Events').geometry, { op: 'not', operands: [gate('P1').id] });
  assert.ok(result.fidelity.every((f) => f.status === 'imported'), JSON.stringify(result.fidelity.filter((f) => f.status !== 'imported')));
  // Gates of a specimen are keyed by specimen and shape, so tubes can share them.
  assert.match(gate('P1').meta.flowJo.key, /^Blood\|\|P1\|RECTANGLE_REGION:FSC-A:SSC-A$/);
});

test('not a Diva experiment', () => {
  assert.throws(() => importDiva('<Workspace/>'), /not a FACSDiva experiment/);
});
