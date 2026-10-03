import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateExample } from './examples.js';
import { parseFCS, readSpillover } from './fcs.js';
import { SampleView, countOf, population } from './engine.js';
import { createWorkspace, addGates, addSamples, sampleFromDataset, setChannelTransform, setSampleCompensation, updateGate, removeGate } from './workspace.js';
import { buildProvenance, compareProvenance, embedPNG, embedSVG, pdfAttachment, readFigureProvenance, readPDF, readPNG, readSVG, rebuildWorkspace } from './figure-provenance.js';
import { writePDF } from './pdf.js';
import { crc32 } from './zip.js';

function setup() {
  const { files, workspaceHints } = generateExample('pbmc-immunophenotyping', { samples: ['D01_Unstim.fcs', 'D01_Stim.fcs'], scale: 0.08 });
  let ws = createWorkspace('figure test');
  const datasets = new Map();
  for (const file of files.filter((f) => /^D0/.test(f.name))) {
    const data = parseFCS(file.bytes).datasets[0];
    const record = sampleFromDataset(data, { name: file.name, sha256: `${file.name}`.padEnd(64, '0').slice(0, 64) });
    datasets.set(record.id, data);
    ws = addSamples(ws, [record]);
  }
  ws = addGates(ws, workspaceHints.suggestedGates).ws;
  const id = (name) => ws.gates.find((g) => g.name === name).id;
  const LOGICLE = { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 };
  ws = addGates(ws, ['UL', 'UR', 'LR', 'LL'].map((q) => ({ id: `q-${q}`, name: `Q ${q}`, parentId: id('T cells'), type: 'quadrant', dims: [{ channel: 'Alexa Fluor 700-A', transform: LOGICLE }, { channel: 'APC-A', transform: LOGICLE }], geometry: { center: [0.5, 0.45], quadrant: q }, linkId: 'q' }))).ws;
  const [a, b] = ws.samples;
  const figure = {
    id: 'f1',
    name: 'T cells ]]> test',
    width: 800,
    height: 400,
    items: [
      { id: 'p1', kind: 'plot', x: 0, y: 0, w: 380, h: 380, sampleId: a.id, spec: { populationId: id('Live'), x: 'FSC-A', y: 'SSC-A', type: 'pseudocolor' } },
      { id: 'p2', kind: 'plot', x: 400, y: 0, w: 380, h: 380, sampleId: b.id, spec: { populationId: id('T cells'), x: 'Alexa Fluor 700-A', y: 'APC-A', type: 'pseudocolor' } },
      { id: 't1', kind: 'text', x: 0, y: 385, w: 300, h: 14, text: 'caption' },
    ],
  };
  const viewsOf = (w) => new Map(w.samples.map((s) => {
    const data = datasets.get(s.id);
    const view = new SampleView(s, data);
    if (s.compensationId === 'file') {
      const spill = readSpillover(data.keywords, data.parameters);
      view.setCompensation({ id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) });
    }
    return [s.id, view];
  }));
  return { ws, figure, viewsOf, id };
}

function tinyPNG() {
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array([120, 156, 99, 248, 15, 0, 1, 1, 1, 0])), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

test('the record holds what the plots depend on, and no keywords', () => {
  const { ws, figure, viewsOf, id } = setup();
  const record = buildProvenance(ws, figure, { views: viewsOf(ws), version: 'test' });
  const names = record.gates.map((g) => g.name);
  // Ancestors, the populations plotted, and the quadrants drawn on the second plot.
  // Monocytes is drawn on the first plot (a child of Live on FSC-A × SSC-A).
  for (const name of ['Cells', 'Single cells', 'Live', 'Lymphocytes', 'T cells', 'Monocytes', 'Q UL', 'Q LR']) assert.ok(names.includes(name), name);
  assert.equal(record.gates.length, 10);
  assert.equal(record.samples.length, 2);
  assert.ok(record.samples.every((s) => !('keywords' in s) && s.sha256));
  const p2 = record.plots.find((p) => p.item === 'p2');
  assert.equal(p2.path, 'Cells / Single cells / Live / Lymphocytes / T cells');
  assert.ok(p2.events > 0 && record.samples.find((x) => x.id === p2.sample).applied?.matrix.length > 0);
  assert.equal(p2.transforms['APC-A'].type, 'logicle');
  void id;
});

test('SVG, PNG and PDF carry the record and give it back', async () => {
  const { ws, figure, viewsOf } = setup();
  const record = buildProvenance(ws, figure, { views: viewsOf(ws) });
  const svg = embedSVG('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', record);
  assert.deepEqual(readSVG(svg), record);
  assert.match(svg, /^<svg[^>]*><metadata id="cytoweave-provenance">/);
  const png = embedPNG(tinyPNG(), record);
  assert.deepEqual(readPNG(png), record);
  assert.equal(readPNG(tinyPNG()), null);
  const pdf = await writePDF([{ width: 100, height: 50, image: { width: 2, height: 1, rgb: new Uint8Array(6) } }], { title: 'x', attachments: [pdfAttachment(record)] });
  assert.deepEqual(readPDF(pdf), record);
  assert.match(new TextDecoder('latin1').decode(pdf), /\/EmbeddedFiles << \/Names \[\(cytoweave-provenance\.json\) \d+ 0 R\]/);
  for (const file of [svg, png, pdf]) assert.equal(readFigureProvenance(typeof file === 'string' ? new TextEncoder().encode(file) : file).figure.name, 'T cells ]]> test');
});

test('a rebuilt workspace redraws every plot from the same events', () => {
  const { ws, figure, viewsOf } = setup();
  const record = buildProvenance(ws, figure, { views: viewsOf(ws) });
  const rebuilt = rebuildWorkspace(record);
  const views = viewsOf(rebuilt);
  for (const plot of record.plots) {
    const members = population(views.get(plot.sample), rebuilt, plot.population);
    assert.equal(countOf(members, views.get(plot.sample)), plot.events, plot.path);
  }
  assert.equal(rebuilt.figures[0].items.length, 3);
  const check = compareProvenance(record, rebuilt, { views });
  assert.ok(check.plots.every((p) => p.status === 'unchanged'), JSON.stringify(check.plots));
});

test('changes since the figure are found and described', () => {
  const { ws, figure, viewsOf, id } = setup();
  const record = buildProvenance(ws, figure, { views: viewsOf(ws) });
  const same = compareProvenance(record, ws, { views: viewsOf(ws) });
  assert.ok(same.sameWorkspace && same.plots.every((p) => p.status === 'unchanged'));

  const live = ws.gates.find((g) => g.name === 'Live');
  let changed = updateGate(ws, live.id, { geometry: { vertices: live.geometry.vertices.map(([x, y]) => [x + 0.05, y]) } });
  let report = compareProvenance(record, changed, { views: viewsOf(changed) });
  const p1 = report.plots.find((p) => p.item === 'p1');
  assert.equal(p1.status, 'changed');
  assert.ok(p1.changes.some((c) => /"Live" changed/.test(c)));
  assert.ok(p1.changes.some((c) => /events now/.test(c)));

  changed = setChannelTransform(ws, 'APC-A', { type: 'arcsinh', cofactor: 150, max: 262144 });
  report = compareProvenance(record, changed, { views: viewsOf(changed) });
  assert.ok(report.plots.find((p) => p.item === 'p2').changes.some((c) => /scale of APC-A changed \(logicle → arcsinh\)/.test(c)));

  changed = setSampleCompensation(ws, [ws.samples[1].id], 'none');
  report = compareProvenance(record, changed, { views: viewsOf(changed) });
  assert.ok(report.plots.find((p) => p.item === 'p2').changes.includes('the sample is no longer compensated'));

  changed = removeGate(ws, 'q-UR');
  report = compareProvenance(record, changed, {});
  assert.ok(report.plots.find((p) => p.item === 'p2').changes.includes('"Q UR" was deleted'));

  // Another workspace with the same files: matched by checksum, gates by path.
  const other = { ...rebuildWorkspace(record), id: 'w-other' };
  report = compareProvenance(record, other, {});
  assert.equal(report.sameWorkspace, false);
  assert.ok(report.plots.every((p) => p.status === 'unchanged'));
  void id;
});
