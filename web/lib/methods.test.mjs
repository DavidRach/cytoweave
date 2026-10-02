import assert from 'node:assert/strict';
import test from 'node:test';
import { miflowcytChecklist, toBibTeX, writeMethods } from './methods.js';
import { analysisSnapshot, diffAnalyses, geometryShift } from './diff.js';
import { addCompensation, addGates, createWorkspace, setGateGeometry, setChannelTransform, updateGate } from './workspace.js';

const linear = { type: 'linear', min: 0, max: 1000 };

function workspace() {
  let ws = createWorkspace('Methods');
  ws = { ...ws, samples: [
    { id: 's1', name: 'A', role: 'sample', fcsVersion: 'FCS3.1', technology: 'conventional', compensationId: 'file', acquisition: { cytometer: 'LSRFortessa' }, channels: [{ name: 'FITC-A', marker: 'CD3', type: 'fluorescence' }], keywords: { $CYT: 'LSRFortessa', $DATE: '01-OCT-2026' }, meta: { condition: 'ctrl' } },
    { id: 's2', name: 'B', role: 'single-stain', fcsVersion: 'FCS3.1', technology: 'conventional', compensationId: 'file', acquisition: { cytometer: 'LSRFortessa' }, channels: [], keywords: {}, meta: {} },
  ] };
  ws = addGates(ws, [{ id: 'g1', name: 'Lymphocytes', parentId: null, type: 'polygon', dims: [{ channel: 'FSC-A', transform: linear }, { channel: 'SSC-A', transform: linear }], geometry: { vertices: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5]] } }]).ws;
  ws = addGates(ws, [{ id: 'g2', name: 'T cells', parentId: 'g1', type: 'range', dims: [{ channel: 'FITC-A', transform: linear }], geometry: { min: 0.5, max: null } }]).ws;
  ws = setChannelTransform(ws, 'FITC-A', { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 });
  return ws;
}

test('the methods paragraph cites what the workspace used, in order', () => {
  const { paragraphs, references } = writeMethods(workspace(), { version: '0.1.0' });
  const text = paragraphs.join(' ');
  assert.match(text, /1 sample and 1 control, acquired on LSRFortessa/);
  assert.match(text, /\$SPILLOVER/);
  assert.match(text, /logicle \(T = 262144, M = 4.5, A = 0, W = 0.5\) for 1 channel/);
  assert.match(text, /Lymphocytes → T cells/);
  assert.equal(references[0].key, 'fcs31');
  assert.ok(references.some((r) => r.key === 'logicle'));
  assert.ok(references.some((r) => r.key === 'miflowcyt'));
  // The notes lack a contact, so MIFlowCyt is not claimed, only counted.
  assert.match(text, /documents 9 of the 10 MIFlowCyt items/);
  assert.doesNotMatch(text, /Reporting follows MIFlowCyt/);
  const complete = writeMethods({ ...workspace(), notes: 'Lab of Cytometry, contact: lab@example.org' }, { version: '0.1.0' }).paragraphs.join(' ');
  assert.match(complete, /Reporting follows MIFlowCyt/);
  // Citation numbers in the text match the reference list.
  const cited = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  assert.equal(Math.max(...cited), references.length);
  assert.match(toBibTeX(references), /doi = \{10.1002\/cyto.a.20825\}/);
});

test('the MIFlowCyt checklist reflects the workspace', () => {
  const items = miflowcytChecklist(workspace());
  assert.ok(items.find((i) => i.item.startsWith('Controls')).ok);
  assert.ok(items.find((i) => i.item.startsWith('Gating')).ok);
  assert.ok(items.find((i) => i.item.startsWith('Cytometer')).ok);
});

test('analysis diffs describe gate, compensation and scale changes', () => {
  const before = workspace();
  let after = setGateGeometry(before, 'g1', { vertices: [[0.12, 0.1], [0.5, 0.1], [0.5, 0.5]] });
  after = updateGate(after, 'g2', { name: 'CD3+' });
  after = setGateGeometry(after, 'g2', { min: 0.55, max: null }, { sampleId: 's1' });
  after = addCompensation(after, { name: 'Computed', channels: ['FITC-A', 'PE-A'], matrix: [1, 0.1, 0, 1], source: 'computed' }).ws;
  after = setChannelTransform(after, 'FITC-A', { type: 'arcsinh', cofactor: 150 });
  const { changes, summary } = diffAnalyses(analysisSnapshot(before), analysisSnapshot(after));
  const g1 = changes.find((c) => c.id === 'g1');
  assert.match(g1.detail, /boundary moved by up to 2.0% of the axis/);
  const g2 = changes.find((c) => c.id === 'g2');
  assert.match(g2.detail, /renamed from "T cells"/);
  assert.match(g2.detail, /adjusted for 1 more sample/);
  assert.ok(changes.some((c) => c.kind === 'compensation' && c.action === 'added'));
  assert.ok(changes.some((c) => c.kind === 'scale' && c.detail.startsWith('arcsinh')));
  assert.match(summary, /2 gate change/);
  assert.equal(diffAnalyses(analysisSnapshot(before), analysisSnapshot(before)).changes.length, 0);
  assert.equal(geometryShift('split', { threshold: 0.2 }, { threshold: 0.25 }).toFixed(2), '0.05');
});
