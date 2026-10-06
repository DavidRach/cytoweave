import assert from 'node:assert/strict';
import test from 'node:test';
import { chorusGates, importChorus } from './chorus.js';

const param = (name, scale = 'Linear') => ({ Name: name, MeasurementId: name, Scale: scale });
const gate = (id, kind, name, parent, params, vertices) => ({ GateId: id, GateKind: kind, Name: name, ParentPopulationId: parent, InputPopulationIds: null, Parameters: params, Vertices: vertices.map(([X, Y]) => ({ X, Y })), Children: [{ Name: name, Color: '206,218,74', PopulationId: `${id}-1` }] });
const RECORD = {
  RecordingConfiguration: {
    AnalysisModel: {
      Gates: [
        gate('5', 'Unsaturated', 'Unsaturated', '0-1', [], []),
        gate('1', 'Polygon', 'Cells', '5-1', [param('FSC-A'), param('SSC-A')], [[100, 100], [900, 100], [500, 900]]),
        gate('2', 'Rectangle', 'CD3+', '1-1', [param('CD3-A', 'Biexponential'), param('SSC-A')], [[1000, 0], [50000, 0], [50000, 800], [1000, 800]]),
        gate('3', 'Polygon', 'CD4 CD8', '1-1', [param('CD4-A', 'Biexponential'), param('CD8-A', 'Log')], [[10, 10], [100, 10], [100, 100]]),
        gate('4', 'Ellipse', 'Odd', '1-1', [param('FSC-A'), param('SSC-A')], [[1, 1]]),
        gate('6', 'Polygon', 'Under odd', '4-1', [param('FSC-A'), param('SSC-A')], [[1, 1], [2, 1], [2, 2]]),
      ],
    },
  },
};
const keywords = { BDCHORUSDATARECORD: JSON.stringify(RECORD), CREATOR: 'BD FACSChorus 6.1.0', $CYT: 'FACSDiscover S8' };
const channels = ['FSC-A', 'SSC-A', 'CD3-A', 'CD4-A', 'CD8-A'].map((name) => ({ name, range: 1000 }));
channels.find((c) => c.name === 'CD3-A').range = 100000;

test('the compact record of a file\'s FACSChorus gates', () => {
  const record = chorusGates(keywords);
  assert.equal(record.version, '6.1.0');
  assert.equal(record.cytometer, 'FACSDiscover S8');
  assert.equal(record.gates.length, 6);
  assert.deepEqual(record.gates[1].vertices[1], [900, 100]);
  assert.equal(chorusGates({}), null);
  assert.equal(chorusGates({ BDCHORUSDATARECORD: 'not json' }), null);
});

test('gates, scales, the automatic saturation gate and what is not imported', () => {
  const result = importChorus([{ id: 's1', name: 'A', fileName: 'A.fcs', eventCount: 10, channels, acquisitionGates: chorusGates(keywords) }]);
  assert.equal(result.format, 'chorus');
  const [sample] = result.samples;
  assert.deepEqual(sample.populationCounts, {});
  const byName = (n) => sample.gates.find((g) => g.name === n);
  // Under the Unsaturated gate, attached to its parent (all events).
  assert.equal(byName('Cells').parentId, null);
  assert.deepEqual(byName('Cells').geometry.vertices[1], [0.9, 0.1]);
  assert.equal(byName('Cells').color, '#ceda4a');
  // Rectangles are exact on any axis; the biexponential polygon is approximated.
  assert.deepEqual(byName('CD3+').geometry, { min: [0.01, 0], max: [0.5, 0.8] });
  assert.equal(byName('CD4 CD8').dims[1].transform.type, 'log');
  const status = Object.fromEntries(result.fidelity.map((f) => [f.path, f.status]));
  assert.equal(status['Cells/CD3+'], 'approximated', 'under the Unsaturated gate');
  assert.equal(status['Cells/CD4 CD8'], 'approximated');
  assert.equal(status['Cells/Odd'], 'unsupported');
  assert.equal(status['Cells/Odd/Under odd'], 'unsupported');
  assert.match(result.warnings[0], /Unsaturated/);
});
