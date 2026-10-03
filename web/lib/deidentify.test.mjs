import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFCS, writeFCS, parseTextSegment } from './fcs.js';
import { deidentifyFCS, deidentifyKeywords } from './deidentify.js';

const IDENTIFYING = {
  $OP: 'Dr. Jane Doe',
  $SRC: 'Patient 4711 peripheral blood',
  $SMNO: 'MRN-0012345',
  $INST: 'General Hospital',
  $PROJ: 'Leukemia study',
  $COM: 'collected from J. Smith',
  $CELLS: 'PBMC of donor 17',
  $CYTSN: 'R12345678',
  $DATE: '02-OCT-2026',
  $BTIM: '09:12:00',
  'PATIENT ID': 'P-4711',
  'TUBE NAME': 'J Smith tube 1',
  'EXPERIMENT NAME': 'Smith 2026-10-02',
  USER: 'jdoe',
  $FIL: 'smith_john_1970-01-01.fcs',
};
const TECHNICAL = { $CYT: 'LSRFortessa', $TIMESTEP: '0.01', $SPILLOVER: '2,FITC-A,PE-A,1,0.1,0.02,1', 'LASER1NAME': 'Blue', 'INDEX SORTING LOCATIONS': '0,0;0,1;' };

function sampleFile() {
  const n = 500;
  const columns = [0, 1, 2].map((p) => Float32Array.from({ length: n }, (_, e) => Math.sin(e * (p + 1)) * 1000 + p));
  return writeFCS({
    parameters: [{ name: 'FSC-A', range: 262144 }, { name: 'FITC-A', label: 'CD3', range: 262144 }, { name: 'PE-A', label: 'CD4', range: 262144 }],
    data: columns,
    keywords: { ...IDENTIFYING, ...TECHNICAL, '$P2V': '450' },
  });
}

test('identifying keywords are removed, technical ones kept', () => {
  const { keywords, removed } = deidentifyKeywords({ ...IDENTIFYING, ...TECHNICAL, $P1N: 'FSC-A', $P1S: 'CD3' }, { fileName: 'sample_01.fcs' });
  for (const key of Object.keys(IDENTIFYING)) assert.ok(!(key in keywords) || key === '$FIL', key);
  assert.equal(keywords.$FIL, 'sample_01.fcs');
  assert.equal(keywords.$ORIGINALITY, 'DataModified');
  for (const key of Object.keys(TECHNICAL)) assert.equal(keywords[key], TECHNICAL[key]);
  assert.equal(keywords.$P1S, 'CD3');
  assert.ok(removed.some((r) => r.key === 'PATIENT ID' && r.value === 'P-4711'));
  // Dates only on request.
  assert.equal(deidentifyKeywords({ $DATE: '02-OCT-2026' }, { keepDates: true }).keywords.$DATE, '02-OCT-2026');
});

test('a de-identified file has the same events and none of the identifying text', () => {
  const original = sampleFile();
  const { bytes, removed } = deidentifyFCS(original, { fileName: 'sample_01.fcs' });
  const a = parseFCS(original).datasets[0];
  const b = parseFCS(bytes).datasets[0];
  assert.equal(b.eventCount, a.eventCount);
  for (let p = 0; p < a.data.length; p += 1) {
    for (let e = 0; e < a.eventCount; e += 1) assert.ok(Object.is(a.data[p][e], b.data[p][e]));
  }
  assert.deepEqual(b.diagnostics.filter((d) => d.level !== 'info'), []);
  // Not a trace of the identifying values anywhere in the file.
  const text = new TextDecoder('latin1').decode(bytes);
  for (const value of Object.values(IDENTIFYING)) assert.ok(!text.includes(value), value);
  assert.equal(b.keywords.$FIL, 'sample_01.fcs');
  assert.equal(b.keywords.$P2V, '450');
  assert.equal(b.keywords.$SPILLOVER, TECHNICAL.$SPILLOVER);
  assert.ok(removed.length >= Object.keys(IDENTIFYING).length - 1);
});

test('integer data are copied byte for byte', () => {
  // A 16-bit integer file, which a float writer would not reproduce byte for byte.
  const n = 64;
  const text = `/$BEGINANALYSIS/0/$ENDANALYSIS/0/$BEGINSTEXT/0/$ENDSTEXT/0/$BEGINDATA/0/$ENDDATA/0/$BYTEORD/4,3,2,1/$DATATYPE/I/$MODE/L/$NEXTDATA/0/$PAR/2/$TOT/${n}/$P1N/FSC-H/$P1B/16/$P1E/0,0/$P1R/1024/$P2N/FL1-H/$P2B/16/$P2E/4,1/$P2R/1024/$OP/someone/`;
  const enc = new TextEncoder();
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 37) % 251;
  // Offsets: fix the text length first.
  let body = text;
  let textBytes = enc.encode(body);
  for (let k = 0; k < 4; k += 1) {
    const start = 58 + textBytes.length;
    body = text.replace('$BEGINDATA/0', `$BEGINDATA/${start}`).replace('$ENDDATA/0', `$ENDDATA/${start + data.length - 1}`);
    textBytes = enc.encode(body);
  }
  const start = 58 + textBytes.length;
  const p = (v) => String(v).padStart(8, ' ');
  const header = enc.encode(`FCS3.0    ${p(58)}${p(57 + textBytes.length)}${p(start)}${p(start + data.length - 1)}${p(0)}${p(0)}`);
  const file = new Uint8Array(start + data.length);
  file.set(header, 0);
  file.set(textBytes, 58);
  file.set(data, start);
  const { bytes } = deidentifyFCS(file);
  const out = parseFCS(bytes, { headerOnly: true }).datasets[0];
  const [s, e] = out.offsets.data;
  assert.deepEqual(Array.from(bytes.subarray(s, e + 1)), Array.from(data));
  const pairs = parseTextSegment(new TextDecoder().decode(bytes.subarray(58, s)));
  assert.ok(!pairs.some(([k]) => k === '$OP'));
  assert.ok(pairs.some(([k, v]) => k === '$P2E' && v === '4,1'));
});

test('a de-identified workspace keeps nothing that was removed from its files', async () => {
  const { sampleFromDataset, createWorkspace, addSamples } = await import('./workspace.js');
  const { deidentifyWorkspace } = await import('./deidentify.js');
  const dataset = parseFCS(sampleFile()).datasets[0];
  const record = sampleFromDataset(dataset, { name: 'smith_john_1970-01-01.fcs', sha256: 'a'.repeat(64) });
  record.name = 'Donor 01';
  const ws = { ...addSamples(createWorkspace('study'), [record]), migrations: [{ source: '/Users/jdoe/Patients/smith.wsp' }] };
  const out = deidentifyWorkspace(ws, { fileNames: new Map([[record.id, 'Donor_01.fcs']]), hashes: new Map([[record.id, 'b'.repeat(64)]]) });
  const text = JSON.stringify(out.samples) + JSON.stringify(out.migrations);
  for (const value of Object.values(IDENTIFYING)) assert.ok(!text.includes(value), value);
  assert.equal(out.samples[0].fileName, 'Donor_01.fcs');
  assert.equal(out.samples[0].sha256, 'b'.repeat(64));
  assert.equal(out.samples[0].acquisition.cytometer, 'LSRFortessa');
  assert.deepEqual(out.migrations, []);
});
