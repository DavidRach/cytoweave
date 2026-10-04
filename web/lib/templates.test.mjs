import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOT, addGates, createWorkspace, setBooleanGate } from './workspace.js';
import { applyTemplate, buildTemplate, matchChannels, normalizeMarker, parseTemplate } from './templates.js';

const lin = { type: 'linear', min: 0, max: 262144 };
const logicle = { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 };
const ch = (name, marker = '', type = 'fluorescence', label = marker) => ({ name, marker, type, label, range: 262144 });

function source() {
  let ws = createWorkspace('Panel A');
  ws = {
    ...ws,
    samples: [{ id: 's1', name: 'S1', role: 'sample', compensationId: 'file', channels: [ch('FSC-A', '', 'scatter'), ch('SSC-A', '', 'scatter'), ch('FITC-A', 'CD3'), ch('FITC-H', 'CD3'), ch('PE-A', 'CD4'), ch('APC-A', 'CD8'), ch('BV421-A', 'HLA-DR'), ch('Time', '', 'time')], meta: {} }],
    derived: [{ id: 'd1', kind: 'flowsom', outputs: ['FlowSOM cluster'] }],
    channelSettings: { 'FITC-A': { transform: logicle, label: 'CD3' } },
  };
  let added = addGates(ws, [{ name: 'Cells', parentId: null, type: 'rectangle', dims: [{ channel: 'FSC-A', transform: lin }, { channel: 'SSC-A', transform: lin }], geometry: { min: [0.1, 0], max: [1, 1] } }]);
  ws = added.ws;
  const cells = added.gates[0].id;
  added = addGates(ws, [{ name: 'T cells', parentId: cells, type: 'range', dims: [{ channel: 'FITC-A', transform: logicle }], geometry: { min: 0.5, max: null } }]);
  ws = added.ws;
  const t = added.gates[0].id;
  const quad = [['CD4+ CD8-', [0.5, null], [null, 0.5]], ['CD4- CD8+', [null, 0.5], [0.5, null]]].map(([name, x, y]) => ({ name, parentId: t, linkId: 'l1', type: 'rectangle', dims: [{ channel: 'PE-A', transform: logicle }, { channel: 'APC-A', transform: logicle }], geometry: { min: [x[0], y[0]], max: [x[1], y[1]] } }));
  added = addGates(ws, quad);
  ws = added.ws;
  ws = addGates(ws, [{ name: 'Cluster 3', parentId: t, type: 'category', dims: [{ channel: 'FlowSOM cluster' }], geometry: { values: [3] } }]).ws;
  ws = addGates(ws, [{ name: 'DR+', parentId: cells, type: 'range', dims: [{ channel: 'BV421-A', transform: logicle }], geometry: { min: 0.6, max: null } }]).ws;
  // A Boolean population placed before (in the list) one of the gates it combines.
  ws = setBooleanGate(ws, { op: 'and', operands: [added.gates[0].id, ws.gates.find((g) => g.name === 'DR+').id], parentId: null, name: 'CD4 and DR' }).ws;
  ws = { ...ws, gates: [ws.gates.at(-1), ...ws.gates.slice(0, -1)] };
  ws = { ...ws, plots: [{ id: 'p1', populationId: t, x: 'PE-A', y: 'APC-A', type: 'pseudocolor', options: {} }], tables: [{ id: 't1', name: 'Frequencies', columns: [{ id: 'k1', gateId: t, stat: 'freqParent' }, { id: 'k2', gateId: t, stat: 'median', channel: 'PE-A' }] }] };
  ws = { ...ws, figures: [{ id: 'f1', name: 'Strategy', width: 900, height: 400, background: '#fff', items: [{ id: 'i1', kind: 'plot', sampleId: 's1', spec: { populationId: cells, x: 'FITC-A', y: null, type: 'histogram', options: {} }, highlight: t, x: 0, y: 0, w: 300, h: 300 }, { id: 'i2', kind: 'text', text: 'T', x: 0, y: 0, w: 10, h: 10 }] }] };
  return ws;
}

// The same panel on another instrument: other detectors, the markers in another order and case.
function target(channels) {
  return { ...createWorkspace('Panel B'), samples: [{ id: 'x1', name: 'X1', role: 'sample', channels, meta: {} }] };
}

test('markers compare across spellings', () => {
  assert.equal(normalizeMarker('HLA-DR'), normalizeMarker('hla dr'));
  assert.equal(normalizeMarker('TCRγδ'), normalizeMarker('TCRgd'));
  assert.notEqual(normalizeMarker('CD45RA'), normalizeMarker('CD45'));
});

test('a template keeps gates, plots, tables, figures and scales, by channel, and leaves out computed channels', () => {
  const template = buildTemplate(source(), { name: 'T cells' });
  assert.deepEqual(template.gates.map((g) => g.name).sort(), ['CD4 and DR', 'CD4+ CD8-', 'CD4- CD8+', 'Cells', 'DR+', 'T cells']);
  assert.match(template.notes.join(' '), /Cluster 3 is on a computed channel/);
  assert.deepEqual(Object.values(template.channels).map((c) => c.marker || c.name).sort(), ['CD3', 'CD4', 'CD8', 'FSC-A', 'HLA-DR', 'SSC-A']);
  assert.equal(template.compensation.source, 'file');
  assert.equal(template.figures[0].items[0].sampleId, undefined);
  assert.ok(Object.values(template.scales)[0].transform);
  assert.deepEqual(parseTemplate(JSON.stringify(template)).name, 'T cells');
  assert.throws(() => parseTemplate('{"format":"other"}'), /not a CytoWeave template/);
});

test('applied to another panel, channels match by marker and every gate, plot, table and figure follows', () => {
  const template = buildTemplate(source(), { name: 'T cells' });
  const ws = target([ch('FSC-A', '', 'scatter'), ch('SSC-A', '', 'scatter'), ch('BV605-A', 'cd3'), ch('BV605-H', 'cd3'), ch('PE-Cy7-A', 'CD8'), ch('BUV395-A', 'CD4'), ch('APC-A', '', 'fluorescence', 'HLA DR APC'), ch('Time', '', 'time')]);
  const { ws: next, report } = applyTemplate(ws, template);
  const how = Object.fromEntries(report.channels.map((c) => [c.template, `${c.channel} by ${c.how}`]));
  assert.equal(how['CD3 (FITC-A)'], 'BV605-A by marker', 'the area channel, not the height');
  assert.equal(how['CD4 (PE-A)'], 'BUV395-A by marker');
  assert.equal(how['HLA-DR (BV421-A)'], 'APC-A by marker in the label');
  assert.equal(how['FSC-A'], 'FSC-A by name');
  assert.equal(report.gates.applied, 6);
  assert.deepEqual(report.gates.skipped, []);
  const t = next.gates.find((g) => g.name === 'T cells');
  assert.equal(t.dims[0].channel, 'BV605-A');
  assert.equal(next.gates.find((g) => g.name === 'CD4+ CD8-').dims[1].channel, 'PE-Cy7-A');
  const quad = next.gates.filter((g) => g.linkId);
  assert.equal(new Set(quad.map((g) => g.linkId)).size, 1, 'the quadrant stays linked');
  const and = next.gates.find((g) => g.type === 'boolean');
  assert.ok(and.geometry.operands.every((id) => next.gates.some((g) => g.id === id)));
  assert.equal(next.plots[0].x, 'BUV395-A');
  assert.equal(next.tables[0].columns[1].channel, 'BUV395-A');
  assert.equal(next.figures[0].items[0].sampleId, 'x1');
  assert.equal(next.figures[0].items[0].highlight, t.id);
  assert.ok(next.channelSettings['BV605-A'].transform);
  assert.equal(t.meta.origin, 'template');
});

test('a marker the panel lacks skips its gates and those under them, with the reason', () => {
  const template = buildTemplate(source(), { name: 'T cells' });
  const ws = target([ch('FSC-A', '', 'scatter'), ch('SSC-A', '', 'scatter'), ch('FL1-A', 'CD3'), ch('FL2-A', 'CD4'), ch('FL3-A', 'CD19')]);
  const { ws: next, report } = applyTemplate(ws, template);
  assert.deepEqual(report.gates.skipped.map((s) => s.gate).sort(), ['CD4 and DR', 'CD4+ CD8-', 'CD4- CD8+', 'DR+']);
  assert.match(report.gates.skipped.find((s) => s.gate === 'CD4+ CD8-').reason, /no channel for CD8/);
  assert.match(report.gates.skipped.find((s) => s.gate === 'CD4 and DR').reason, /combines/);
  assert.equal(next.gates.length, 2);
  assert.equal(report.plots, 0);
  // A detector that measures another marker is not taken by name.
  const match = matchChannels({ channels: { c1: { name: 'FL3-A', marker: 'CD8', type: 'fluorescence' } } }, [ch('FL3-A', 'CD19')]);
  assert.equal(match.c1.channel, null);
  assert.match(match.c1.note, /measures CD19 here, not CD8/);
  // The user can choose the channel.
  assert.equal(matchChannels({ channels: { c1: { name: 'X', marker: 'CD8', type: 'fluorescence' } } }, [ch('FL9-A', '')], { c1: 'FL9-A' }).c1.how, 'chosen');
});

test('a template goes under a chosen parent, with names kept unique', () => {
  const original = source();
  const template = buildTemplate(original, { gateIds: [original.gates.find((g) => g.name === 'T cells').id] });
  let ws = target([ch('FSC-A', '', 'scatter'), ch('SSC-A', '', 'scatter'), ch('B1-A', 'CD3'), ch('B2-A', 'CD4'), ch('B3-A', 'CD8')]);
  const added = addGates(ws, [{ name: 'Lymphocytes', parentId: null, type: 'rectangle', dims: [{ channel: 'FSC-A', transform: lin }, { channel: 'SSC-A', transform: lin }], geometry: { min: [0, 0], max: [1, 1] } }]);
  ws = added.ws;
  const first = applyTemplate(ws, template, { parentId: added.gates[0].id });
  assert.equal(first.ws.gates.find((g) => g.name === 'T cells').parentId, added.gates[0].id);
  const second = applyTemplate(first.ws, template, { parentId: added.gates[0].id });
  assert.ok(second.ws.gates.some((g) => g.name === 'T cells (2)'));
  assert.equal(applyTemplate(ws, template, { parentId: ROOT }).ws.gates.find((g) => g.name === 'T cells').parentId, null);
});

test('a "QC pass" gate is left out of a template and the populations under it are kept', async () => {
  const { insertRootGate } = await import('./workspace.js');
  let ws = { ...source(), derived: [{ id: 'q', kind: 'qc', outputs: ['QC pass'] }] };
  ws = insertRootGate(ws, { name: 'QC pass', type: 'category', dims: [{ channel: 'QC pass' }], geometry: { values: [1] } }).ws;
  ws = { ...ws, plots: [...ws.plots, { id: 'p2', populationId: ws.gates.find((g) => g.name === 'QC pass').id, x: 'FSC-A', y: 'SSC-A', type: 'dot', options: {} }] };
  const template = buildTemplate(ws, {});
  assert.ok(!template.gates.some((g) => g.name === 'QC pass'));
  assert.equal(template.gates.find((g) => g.name === 'Cells').parentId, null);
  assert.ok(template.gates.some((g) => g.name === 'T cells'));
  assert.match(template.notes.join(' '), /QC pass.*left out and the populations under it are kept/);
  assert.ok(template.plots.some((p) => p.populationId === ROOT && p.type === 'dot'), 'a plot of QC pass becomes a plot of all events');
});
