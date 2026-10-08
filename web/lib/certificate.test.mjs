import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCertificate, certificateFingerprint, encodeNumber, jsEngine, readCertificate, shortFingerprint, verifyCertificate } from './certificate.js';
import { generateExample } from './examples.js';
import { parseFCS } from './fcs.js';
import { sha256 } from './sha256.js';
import { ROOT, addDerived, addGates, annotateSamples, createWorkspace, sampleFromDataset, setCollection } from './workspace.js';

// The PBMC example at a small scale, with its suggested gates, a table and a stored channel.
function example() {
  const result = generateExample('pbmc-immunophenotyping', { scale: 0.05 });
  const files = new Map();
  const samples = result.files.map((file) => {
    const digest = sha256(file.bytes);
    files.set(digest, file.bytes);
    return sampleFromDataset(parseFCS(file.bytes).datasets[0], { name: file.name, size: file.bytes.length, sha256: digest });
  });
  let ws = { ...createWorkspace('Certified'), samples };
  const changes = {};
  for (const s of samples) changes[s.id] = Object.fromEntries(Object.entries(result.workspaceHints.sampleMeta?.[s.fileName] ?? {}).filter(([k, v]) => !['role', 'stain'].includes(k) && typeof v !== 'object'));
  ws = annotateSamples(ws, changes, 'example');
  ws = addGates(ws, result.workspaceHints.suggestedGates.map((g) => ({ ...g, overrides: {} }))).ws;
  // A stored channel (as clustering stores its labels): event index mod 3 in the first donor sample.
  const donor = samples.find((s) => s.role === 'sample');
  const column = Float32Array.from({ length: donor.eventCount }, (_, i) => i % 3);
  const bytes = new Uint8Array(column.buffer);
  const digest = sha256(bytes);
  const derived = new Map([[digest, bytes]]);
  ws = addDerived(ws, { kind: 'kmeans', method: 'k-means', seed: 7, params: { k: 3 }, files: { [donor.id]: { Cluster: { sha256: digest, length: column.length } } } }).ws;
  ws = setCollection(ws, 'tables', [{
    id: 't1',
    name: 'Frequencies',
    columns: [
      ...ws.gates.slice(0, 3).map((g, i) => ({ id: `c${i}`, gateId: g.id, stat: 'freqParent' })),
      { id: 'cm', gateId: ROOT, stat: 'mean', channel: 'Cluster' },
    ],
  }], 'add-table');
  const source = { fcs: (s) => files.get(s.sha256) ?? null, derived: (sha) => derived.get(sha) ?? null };
  return { ws, files, source };
}

test('numbers keep their exact value, and NaN and infinities as text', () => {
  assert.equal(encodeNumber(0.1 + 0.2), 0.30000000000000004);
  assert.equal(JSON.parse(JSON.stringify(encodeNumber(1 / 3))), 1 / 3);
  assert.equal(encodeNumber(Number.NaN), 'NaN');
  assert.equal(encodeNumber(-Infinity), '-Infinity');
  assert.equal(Object.is(encodeNumber(-0), 0), true);
  assert.equal(encodeNumber(undefined), null);
});

test('a certificate is confirmed bit for bit, its stored channel included, and names what it did not compute again', async () => {
  const { ws, source } = example();
  const built = await buildCertificate(ws, source, { version: 'test' });
  const { certificate } = built;
  assert.deepEqual(built.warnings, []);
  assert.equal(certificate.fingerprint, certificateFingerprint(certificate));
  assert.match(shortFingerprint(certificate.fingerprint), /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  assert.equal(certificate.inputs.length, ws.samples.length);
  assert.equal(certificate.derivedInputs.length, 1);
  assert.equal(certificate.analyses[0].seed, 7);
  assert.equal(certificate.log.ok, true);
  assert.equal(certificate.miflowcyt.length, 10);
  const donor = certificate.numbers.tables[0].samples[0];
  const n = ws.samples.find((s) => s.id === donor.id).eventCount;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += i % 3;
  assert.ok(Math.abs(donor.values[3] - sum / n) < 1e-9, 'the mean of 0, 1, 2, 0, … from the stored channel');
  assert.equal(certificate.notChecked.length, 1, 'the clustering is not run again');
  const report = await verifyCertificate(await readCertificate(built.bytes), { version: 'test' });
  assert.equal(report.verdict, 'confirmed', report.summary);
  assert.equal(report.numbers.same, certificate.total);
  assert.equal(report.derived[0].status, 'ok');
});

test('a changed file, gate, log entry, stored channel or certified number is found', async () => {
  const { ws, source } = example();
  const { bytes } = await buildCertificate(ws, source, { version: 'test' });
  const verify = async (change) => {
    const read = await readCertificate(bytes);
    change(read);
    return verifyCertificate(read, { version: 'test' });
  };
  const file = await verify((read) => {
    const path = read.certificate.inputs.at(-1).path;
    const copy = read.files.get(path).slice();
    copy[copy.length - 1] ^= 1;
    read.files.set(path, copy);
  });
  assert.equal(file.verdict, 'differs');
  assert.equal(file.inputs.at(-1).status, 'changed');
  const gate = await verify((read) => {
    const g = read.ws.gates.find((x) => x.geometry?.vertices);
    read.ws = { ...read.ws, gates: read.ws.gates.map((x) => (x === g ? { ...x, geometry: { ...g.geometry, vertices: g.geometry.vertices.map(([a, b]) => [a * 1.05, b]) } } : x)) };
  });
  assert.equal(gate.verdict, 'differs');
  assert.ok(gate.numbers.differ.length > 0);
  const log = await verify((read) => {
    read.ws = { ...read.ws, provenance: read.ws.provenance.map((e, i) => (i === 1 ? { ...e, detail: 'rewritten' } : e)) };
  });
  assert.equal(log.verdict, 'differs');
  assert.equal(log.log.broken[0].index, 1);
  const channel = await verify((read) => {
    const path = read.certificate.derivedInputs[0].path;
    const copy = read.files.get(path).slice();
    copy[5] ^= 1;
    read.files.set(path, copy);
  });
  assert.equal(channel.verdict, 'differs');
  assert.equal(channel.derived[0].status, 'changed');
  const number = await verify((read) => {
    read.certificate.numbers.counts.samples[0].values[0] += 1;
  });
  assert.equal(number.verdict, 'differs');
  assert.equal(number.fingerprint.ok, false);
  assert.match(number.summary, /fingerprint does not match/);
});

test('without the data a certificate is incomplete until the files are supplied', async () => {
  const { ws, source, files } = example();
  const lean = await buildCertificate(ws, source, { version: 'test', includeData: false });
  assert.equal(lean.certificate.inputs.every((i) => i.path === null), true);
  const missing = await verifyCertificate(await readCertificate(lean.bytes), { version: 'test' });
  assert.equal(missing.verdict, 'incomplete');
  const supplied = await verifyCertificate(await readCertificate(lean.bytes), { version: 'test', data: files });
  assert.equal(supplied.verdict, 'confirmed', supplied.summary);
  const other = await verifyCertificate(await readCertificate(lean.bytes), { version: 'other', data: files });
  assert.equal(other.verdict, 'confirmed');
  assert.match(other.summary, /Certified with CytoWeave test and verified with other/);
});

test('a saved comparison is computed again from its values; one that no longer matches is reported', async () => {
  const { ws, source } = example();
  const gate = ws.gates.at(-1);
  const donors = ws.samples.filter((s) => s.role === 'sample');
  const record = (values, p) => ({ id: 'cmp', name: `${gate.name} by condition`, kind: 'single', measure: { stat: 'freqParent', gateId: gate.id }, grouping: { by: 'meta:condition', levels: ['Unstimulated', 'Stimulated'], reference: 'Unstimulated' }, pairing: 'subject', test: { id: 'pairedt', p }, results: { values } });
  const stale = setCollection(ws, 'comparisons', [record(donors.map((s) => ({ sampleId: s.id, sample: s.name, group: s.meta.condition, pair: s.meta.subject, value: 0 })), 0.5)], 'save-comparison');
  const first = await buildCertificate(stale, source, { version: 'test' });
  assert.equal(first.warnings.length, 1);
  assert.match(first.warnings[0], /no longer matches/);
  const computed = first.certificate.numbers.comparisons[0];
  assert.equal(computed.results.design, 'paired-two');
  assert.equal(computed.results.test.id, 'pairedt');
  assert.equal(computed.results.secondary.id, 'wilcoxon');
  const saved = setCollection(ws, 'comparisons', [record(computed.values.map((v) => {
    const s = donors.find((d) => d.id === v.sampleId);
    return { sampleId: s.id, sample: s.name, group: s.meta.condition, pair: s.meta.subject, value: v.value };
  }), computed.results.test.p)], 'save-comparison');
  const second = await buildCertificate(saved, source, { version: 'test' });
  assert.deepEqual(second.warnings, []);
  const report = await verifyCertificate(await readCertificate(second.bytes), { version: 'test' });
  assert.equal(report.verdict, 'confirmed', report.summary);
});

test('a number another engine computes with its last bit different is confirmed as equal to 12 digits, and says why', async () => {
  const { ws, source } = example();
  const { bytes } = await buildCertificate(ws, source, { version: 'test', engine: 'Chrome 152.0' });
  const read = await readCertificate(bytes);
  assert.equal(read.certificate.software.engine, 'Chrome 152.0');
  assert.match(jsEngine(), /^Node \d+/);
  // One recorded frequency one bit away, the fingerprint made again so that only the number differs.
  const sample = read.certificate.numbers.tables[0].samples.find((s) => typeof s.values[0] === 'number' && s.values[0] > 0);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, sample.values[0]);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  sample.values[0] = view.getFloat64(0);
  read.certificate.fingerprint = certificateFingerprint(read.certificate);
  const report = await verifyCertificate(read, { version: 'test' });
  assert.equal(report.verdict, 'confirmed', report.summary);
  assert.equal(report.numbers.close, 1);
  assert.match(report.summary, /1 number equal to 12 significant digits \(their last digits differ because another JavaScript engine computed them \(certified in Chrome 152.0, verified in Node/);
  // Beyond 12 digits it differs.
  sample.values[0] *= 1 + 1e-9;
  read.certificate.fingerprint = certificateFingerprint(read.certificate);
  assert.equal((await verifyCertificate(read, { version: 'test' })).verdict, 'differs');
});
