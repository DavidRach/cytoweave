import assert from 'node:assert/strict';
import test from 'node:test';
import { ACS_MIME, ACS_TOC_NAME, ACS_TOC_NS, archivePath, createACS, readACS } from './acs.js';
import { createZip, listZip, readZip } from './zip.js';
import { attr, findAll, parseXML } from './xml.js';

const DATE = new Date(Date.UTC(2025, 0, 2, 3, 4, 5));
const fakeFCS = (n, seed) => {
  const bytes = new Uint8Array(n);
  bytes.set(new TextEncoder().encode('FCS3.1'));
  for (let i = 6; i < n; i += 1) bytes[i] = (i * seed) & 0xff;
  return bytes;
};

test('an ACS container round-trips its files and table of contents', async () => {
  const a = fakeFCS(5000, 7);
  const b = fakeFCS(3000, 11);
  const workspace = { format: 'cytoweave-workspace', version: 1, name: 'Study 7' };
  const zip = await createACS({
    fcsFiles: [{ name: 'A1 unstim.fcs', bytes: a }, { name: 'plate/B2.fcs', bytes: b }],
    workspaceJSON: workspace,
    gatingML: '<gating:Gating-ML xmlns:gating="http://www.isac-net.org/std/Gating-ML/v2.0/gating"/>',
    extra: [{ name: 'results/clusters.clr', text: 'A,B\n1,0\n', description: 'FlowSOM metaclusters' }],
  }, { date: DATE, description: 'Archive for the paper' });
  assert.deepEqual(listZip(zip).map((e) => e.name), [ACS_TOC_NAME, 'A1 unstim.fcs', 'plate/B2.fcs', 'cytoweave-workspace.json', 'gating-ml.xml', 'results/clusters.clr']);
  const tocRoot = parseXML((await readZip(zip)).get(ACS_TOC_NAME));
  assert.equal(tocRoot.ns, ACS_TOC_NS);
  assert.equal(findAll(tocRoot, 'file').length, 5);
  assert.equal(attr(findAll(tocRoot, 'file')[0], 'href', 'http://www.w3.org/1999/xlink'), 'file:A1%20unstim.fcs');

  const result = await readACS(zip);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.toc.version, '1.0');
  assert.equal(result.toc.creator, 'CytoWeave');
  assert.equal(result.toc.created, '2025-01-02T03:04:05.000Z');
  assert.equal(result.toc.description, 'Archive for the paper');
  assert.deepEqual(result.toc.files.map((f) => [f.path, f.mimeType]), [
    ['A1 unstim.fcs', ACS_MIME.fcs],
    ['plate/B2.fcs', ACS_MIME.fcs],
    ['cytoweave-workspace.json', 'application/json'],
    ['gating-ml.xml', 'application/xml'],
    ['results/clusters.clr', 'text/csv'],
  ]);
  assert.match(result.toc.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.fcsFiles.map((f) => f.name), ['A1 unstim.fcs', 'plate/B2.fcs']);
  assert.deepEqual(result.fcsFiles[0].bytes, a);
  assert.deepEqual(result.fcsFiles[1].bytes, b);
  assert.deepEqual(JSON.parse(result.workspaceJSON), workspace);
  assert.match(result.gatingML, /Gating-ML/);
  assert.equal(result.files.find((f) => f.name === 'results/clusters.clr').description, 'FlowSOM metaclusters');
});

test('damage, missing entries and foreign archives are reported', async () => {
  const zip = await createACS({ fcsFiles: [{ name: 'x.fcs', bytes: fakeFCS(400, 3) }] }, { date: DATE });
  const files = await readZip(zip);
  // Rebuild with a modified FCS file, an unlisted file and without one listed file.
  const toc = new TextDecoder().decode(files.get(ACS_TOC_NAME)).replace('</acs:toc>', '<acs:file xlink:href="file:gone.fcs" acs:mimeType="application/vnd.isac.fcs"/></acs:toc>');
  const tampered = fakeFCS(400, 3);
  tampered[100] ^= 1;
  const rebuilt = await createZip([
    { name: ACS_TOC_NAME, data: toc },
    { name: 'x.fcs', data: tampered },
    { name: 'notes.txt', data: 'hello' },
  ], { date: DATE });
  const result = await readACS(rebuilt);
  const text = result.warnings.join('\n');
  assert.match(text, /"x.fcs" does not match its SHA-256 digest/);
  assert.match(text, /"notes.txt" is in the archive but not in its table of contents/);
  assert.match(text, /"gone.fcs" is listed in the table of contents but missing/);
  assert.equal(result.files.find((f) => f.name === 'notes.txt').mimeType, 'text/plain');

  // A container from another tool: a toc.xml with a default namespace and plain attributes.
  const other = await createZip([
    { name: 'toc.xml', data: `<toc xmlns="${ACS_TOC_NS}" version="1.0"><file href="./data/s1.fcs" mimetype="application/vnd.isac.fcs" description="sample"/></toc>` },
    { name: 'data/s1.fcs', data: fakeFCS(100, 5) },
  ], { date: DATE });
  const read = await readACS(other);
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(read.fcsFiles.map((f) => f.name), ['data/s1.fcs']);
  assert.equal(read.files[0].description, 'sample');

  const bare = await readACS(await createZip([{ name: 'a.fcs', data: fakeFCS(50, 1) }], { date: DATE }));
  assert.match(bare.warnings[0], /no ACS table of contents/);
  assert.equal(bare.fcsFiles.length, 1);
  await assert.rejects(() => readACS(new TextEncoder().encode('FCS3.1')), /not an ACS container/);
});

test('archive paths are made safe', async () => {
  assert.equal(archivePath('../../etc/passwd'), 'etc/passwd');
  assert.equal(archivePath('C:\\data\\x.fcs'), 'C:/data/x.fcs');
  assert.equal(archivePath('/abs/./y.fcs'), 'abs/y.fcs');
  assert.throws(() => archivePath('..'), /not a usable file name/);
  await assert.rejects(() => createACS({ fcsFiles: [{ name: 'a.fcs', bytes: new Uint8Array(1) }, { name: './a.fcs', bytes: new Uint8Array(1) }] }), /twice/);
});
