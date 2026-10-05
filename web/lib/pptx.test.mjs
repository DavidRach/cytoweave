import assert from 'node:assert/strict';
import test from 'node:test';
import { writePPTX } from './pptx.js';
import { readZip } from './zip.js';
import { parseXML, findAll, attr, textContent } from './xml.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

test('a deck has every part it names, slides of the given size, pictures, text and native tables', async () => {
  const slides = [
    { shapes: [
      { kind: 'text', x: 10, y: 10, w: 300, h: 30, paragraphs: [{ text: 'Subject S1 & <2>', size: 24, bold: true }, { text: '' }] },
      { kind: 'picture', x: 10, y: 50, w: 200, h: 200, png: PNG, name: 'Plot', description: 'CD4 against CD8' },
      { kind: 'arrow', x: 220, y: 140, w: 30, h: 20 },
      { kind: 'table', x: 10, y: 260, w: 400, columns: [100, 150, 150], rows: [{ h: 20, cells: [{ text: 'Sample', bold: true }, { text: 'Freq', bold: true, align: 'right' }, { text: 'Count', align: 'right' }] }, { h: 18, cells: [{ text: 'S1' }, { text: '12.5' }, { text: '1,153' }] }] },
    ] },
    { shapes: [{ kind: 'frame', x: 10, y: 10, w: 200, h: 200, text: 'No sample' }, { kind: 'picture', x: 220, y: 10, w: 100, h: 100, png: PNG }], background: '#f0f0f0' },
  ];
  const bytes = await writePPTX(slides, { width: 1600, height: 900, title: 'Report', date: new Date('2026-10-04T00:00:00Z'), parts: [{ path: 'cytoweave/report.json', contentType: 'application/json', relationship: 'https://cytoweave.org/relationships/report', data: new TextEncoder().encode('{}') }] });
  const files = await readZip(bytes);
  const xml = (name) => parseXML(new TextDecoder().decode(files.get(name)));
  // Every relationship points at a part in the package, and every XML part parses.
  for (const name of [...files.keys()].filter((n) => n.endsWith('.rels'))) {
    const base = name.replace(/(^|\/)_rels\/[^/]*\.rels$/, '$1');
    for (const rel of findAll(xml(name), 'Relationship')) {
      const target = new URL(attr(rel, 'Target'), `file:///${base}`).pathname.slice(1);
      assert.ok(files.has(target), `${name} → ${target}`);
    }
  }
  for (const name of [...files.keys()].filter((n) => n.endsWith('.xml'))) assert.ok(xml(name), name);
  // Content types cover every part that is not a Default extension.
  const types = xml('[Content_Types].xml');
  const overrides = new Set(findAll(types, 'Override').map((o) => attr(o, 'PartName').slice(1)));
  for (const name of files.keys()) if (!/\.(rels|png)$/.test(name) && name !== '[Content_Types].xml') assert.ok(overrides.has(name), `content type of ${name}`);
  assert.equal(attr(findAll(xml('ppt/presentation.xml'), 'sldSz')[0], 'cx'), String(1600 * 9525));
  assert.equal(findAll(xml('ppt/presentation.xml'), 'sldId').length, 2);
  const slide1 = xml('ppt/slides/slide1.xml');
  assert.deepEqual(findAll(slide1, 't').map(textContent), ['Subject S1 & <2>', 'Sample', 'Freq', 'Count', 'S1', '12.5', '1,153']);
  assert.equal(attr(findAll(slide1, 'cNvPr').find((c) => attr(c, 'name') === 'Plot'), 'descr'), 'CD4 against CD8');
  assert.equal(findAll(slide1, 'gridCol').length, 3);
  assert.equal(findAll(slide1, 'tailEnd').length, 1);
  assert.ok(files.has('ppt/media/image1.png') && files.has('ppt/media/image2.png'));
  assert.equal(findAll(xml('ppt/slides/slide2.xml'), 'prstDash').length, 1);
  assert.equal(attr(findAll(xml('ppt/slides/slide2.xml'), 'srgbClr')[0], 'val'), 'F0F0F0');
});
