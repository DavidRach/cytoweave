import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChannel, describeAcquisition, detectTechnology, markerFromLabel, parseFCS, parseTextSegment, readSpillover, writeFCS } from './fcs.js';

const encoder = new TextEncoder();

function pad8(value) {
  return String(value).padStart(8, ' ');
}

// Builds an FCS file by hand: keywords (without offsets), integer or float event bytes.
function buildFCS({ version = 'FCS3.0', keywords, data, delimiter = '/', endOffByOne = false, headerZeros = false }) {
  const textFor = (dataStart, dataEnd) => {
    let text = delimiter;
    const all = { ...keywords, $BEGINDATA: String(dataStart), $ENDDATA: String(dataEnd) };
    for (const [k, v] of Object.entries(all)) text += k.split(delimiter).join(delimiter + delimiter) + delimiter + String(v).split(delimiter).join(delimiter + delimiter) + delimiter;
    return encoder.encode(text);
  };
  let text = textFor(0, 0);
  for (let i = 0; i < 4; i += 1) {
    const start = 58 + text.length;
    text = textFor(start, start + data.length - 1);
  }
  const dataStart = 58 + text.length;
  let dataEnd = dataStart + data.length - 1;
  if (endOffByOne) dataEnd += 1;
  const header = version + '    ' + pad8(58) + pad8(58 + text.length - 1) + (headerZeros ? pad8(0) + pad8(0) : pad8(dataStart) + pad8(dataEnd)) + pad8(0) + pad8(0);
  const out = new Uint8Array(dataStart + data.length + (endOffByOne ? 1 : 0));
  out.set(encoder.encode(header), 0);
  out.set(text, 58);
  out.set(data, dataStart);
  return out;
}

test('a written FCS 3.1 file reads back exactly', () => {
  const columns = [Float32Array.from([1, 2.5, -3.25, 1e5]), Float32Array.from([0, 100, 200, 262143]), Float32Array.from([10, 20, 30, 40])];
  const bytes = writeFCS({
    parameters: [
      { name: 'FSC-A', label: '', range: 262144 },
      { name: 'FITC-A', label: 'CD3', range: 262144 },
      { name: 'Time', label: '', range: 262144 },
    ],
    data: columns,
    keywords: { $CYT: 'Test|Cytometer', $DATE: '01-OCT-2026', SPILL: '1,FITC-A,1' },
  });
  const { version, datasets } = parseFCS(bytes);
  assert.equal(version, 'FCS3.1');
  const [dataset] = datasets;
  assert.equal(dataset.eventCount, 4);
  assert.equal(dataset.keywords.$CYT, 'Test|Cytometer');
  assert.deepEqual(dataset.parameters.map((p) => p.name), ['FSC-A', 'FITC-A', 'Time']);
  assert.deepEqual(dataset.parameters.map((p) => p.type), ['scatter', 'fluorescence', 'time']);
  assert.equal(dataset.parameters[1].marker, 'CD3');
  for (let i = 0; i < 3; i += 1) assert.deepEqual(Array.from(dataset.data[i]), Array.from(columns[i]));
  assert.equal(dataset.diagnostics.filter((d) => d.level !== 'info').length, 0);
});

test('a written file with a CRC verifies', () => {
  const bytes = writeFCS({ parameters: [{ name: 'A', range: 1024 }], data: [Float32Array.from([1, 2, 3])] }, { crc: true });
  const { datasets } = parseFCS(bytes);
  assert.ok(datasets[0].crc?.ok);
});

test('big-endian 16-bit integers with log amplification and masked bits (FCS 2.0)', () => {
  const values = [[0, 512], [1023, 256], [1024 + 100, 0]]; // event 3 parameter 1 has a flag bit above $P1R
  const data = new Uint8Array(values.length * 4);
  const view = new DataView(data.buffer);
  values.forEach(([a, b], i) => {
    view.setUint16(i * 4, a, false);
    view.setUint16(i * 4 + 2, b, false);
  });
  const bytes = buildFCS({
    version: 'FCS2.0',
    keywords: { $BYTEORD: '4,3,2,1', $DATATYPE: 'I', $MODE: 'L', $NEXTDATA: '0', $PAR: '2', $TOT: '3', $P1N: 'FL1-H', $P1B: '16', $P1R: '1024', $P1E: '4,0', $P2N: 'FSC-H', $P2B: '16', $P2R: '1024', $P2E: '0,0' },
    data,
  });
  const [dataset] = parseFCS(bytes).datasets;
  assert.equal(dataset.eventCount, 3);
  // 4 decades over 1024 channels with offset 1: 10^(4·c/1024).
  assert.ok(Math.abs(dataset.data[0][0] - 1) < 1e-6);
  assert.ok(Math.abs(dataset.data[0][1] - 10 ** (4 * 1023 / 1024)) / 10 ** (4 * 1023 / 1024) < 1e-5);
  assert.ok(Math.abs(dataset.data[0][2] - 10 ** (4 * 100 / 1024)) < 1e-3, 'flag bit masked');
  assert.deepEqual(Array.from(dataset.data[1]), [512, 256, 0]);
  assert.ok(dataset.diagnostics.some((d) => d.code === 'masked-bits'));
  assert.ok(dataset.diagnostics.some((d) => d.code === 'log-offset'));
});

test('DATA offsets that are zero in the HEADER come from the keywords, and off-by-one ends are fixed', () => {
  const data = new Uint8Array(8);
  new DataView(data.buffer).setFloat32(0, 7.5, true);
  new DataView(data.buffer).setFloat32(4, -2, true);
  const keywords = { $BYTEORD: '1,2,3,4', $DATATYPE: 'F', $MODE: 'L', $NEXTDATA: '0', $PAR: '1', $TOT: '2', $P1N: 'X', $P1B: '32', $P1R: '1024', $P1E: '0,0' };
  for (const options of [{ headerZeros: true }, { endOffByOne: true }]) {
    const [dataset] = parseFCS(buildFCS({ keywords, data, ...options })).datasets;
    assert.deepEqual(Array.from(dataset.data[0]), [7.5, -2]);
  }
});

test('escaped delimiters and empty keyword values', () => {
  assert.deepEqual(parseTextSegment('/A/x//y/B/2/'), [['A', 'x/y'], ['B', '2']]);
  const data = new Uint8Array(4);
  new DataView(data.buffer).setFloat32(0, 3, true);
  // An instrument that writes an empty $P1S value ("//") between keywords.
  const raw = '/$BYTEORD/1,2,3,4/$DATATYPE/F/$MODE/L/$PAR/1/$TOT/1/$P1N/X/$P1S//$P1B/32/$P1R/1024/$P1E/0,0/';
  const textBytes = encoder.encode(raw);
  const bytesFor = (text) => {
    const header = 'FCS3.0    ' + pad8(58) + pad8(58 + text.length - 1) + pad8(58 + text.length) + pad8(58 + text.length + 3) + pad8(0) + pad8(0);
    const out = new Uint8Array(58 + text.length + 4);
    out.set(encoder.encode(header), 0);
    out.set(text, 58);
    out.set(data, 58 + text.length);
    return out;
  };
  const [dataset] = parseFCS(bytesFor(textBytes)).datasets;
  assert.equal(dataset.parameters[0].name, 'X');
  assert.equal(dataset.parameters[0].label, '');
  assert.equal(dataset.data[0][0], 3);
  assert.ok(dataset.diagnostics.some((d) => d.code === 'empty-values'));
});

test('multiple data sets follow $NEXTDATA', async () => {
  const floatBytes = (values) => {
    const out = new Uint8Array(values.length * 4);
    values.forEach((v, i) => new DataView(out.buffer).setFloat32(i * 4, v, true));
    return out;
  };
  const base = { $BYTEORD: '1,2,3,4', $DATATYPE: 'F', $MODE: 'L', $PAR: '1', $P1B: '32', $P1R: '1024', $P1E: '0,0' };
  const second = buildFCS({ keywords: { ...base, $NEXTDATA: '0', $TOT: '1', $P1N: 'B' }, data: floatBytes([5]) });
  const placeholder = buildFCS({ keywords: { ...base, $NEXTDATA: '000000', $TOT: '2', $P1N: 'A' }, data: floatBytes([1, 2]) });
  const first = buildFCS({ keywords: { ...base, $NEXTDATA: String(placeholder.length).padStart(6, '0'), $TOT: '2', $P1N: 'A' }, data: floatBytes([1, 2]) });
  assert.equal(first.length, placeholder.length);
  const all = new Uint8Array(first.length + second.length);
  all.set(first, 0);
  all.set(second, first.length);
  const { datasets } = parseFCS(all);
  assert.equal(datasets.length, 2);
  assert.deepEqual(Array.from(datasets[0].data[0]), [1, 2]);
  assert.equal(datasets[1].parameters[0].name, 'B');
  assert.equal(datasets[1].data[0][0], 5);
  // Read in parts, a file with several data sets is read whole and gives the same.
  const { parseFCSAsync, blobSource } = await import('./fcs.js');
  const parts = await parseFCSAsync(blobSource(new Blob([all])), { chunkSize: 16 });
  assert.equal(parts.datasets.length, 2);
  assert.equal(parts.datasets[1].data[0][0], 5);
});

test('spillover keywords resolve channel names, including $PnS references', () => {
  const parameters = [
    { name: 'FL1-A', label: 'FITC', type: 'fluorescence' },
    { name: 'FL2-A', label: 'PE', type: 'fluorescence' },
  ];
  const spill = readSpillover({ SPILL: '2,FITC,PE,1,0.12,0.03,1' }, parameters);
  assert.deepEqual(spill.channels, ['FL1-A', 'FL2-A']);
  assert.deepEqual(Array.from(spill.matrix), [1, 0.12, 0.03, 1]);
  assert.equal(spill.identity, false);
  assert.equal(readSpillover({}, parameters), null);
});

test('channel classification and markers', () => {
  assert.equal(classifyChannel('FSC-A'), 'scatter');
  assert.equal(classifyChannel('SSC-B-H'), 'scatter');
  assert.equal(classifyChannel('Time'), 'time');
  assert.equal(classifyChannel('BV421-A'), 'fluorescence');
  assert.equal(classifyChannel('Event_length'), 'instrument');
  assert.equal(markerFromLabel('176Yb_CD56', 'Yb176Di'), 'CD56');
  assert.equal(markerFromLabel('CD3', 'FITC-A'), 'CD3');
  assert.equal(markerFromLabel('FITC-A', 'FITC-A'), '');
});

test('technology detection and acquisition summary', () => {
  const mass = Array.from({ length: 8 }, (_, i) => ({ name: `Yb${170 + i}Di`, type: 'fluorescence' }));
  assert.equal(detectTechnology({ $CYT: 'Helios' }, mass), 'mass');
  assert.equal(detectTechnology({ $CYT: 'Aurora' }, []), 'spectral');
  assert.equal(detectTechnology({ $CYT: 'LSRFortessa' }, [{ name: 'FITC-A', type: 'fluorescence' }]), 'conventional');
  const info = describeAcquisition({ $CYT: 'LSRFortessa', $DATE: '01-OCT-2026', 'EXPORT USER NAME': 'core' });
  assert.equal(info.cytometer, 'LSRFortessa');
  assert.equal(info.operator, 'core');
});

test('non-FCS input is rejected clearly', () => {
  assert.throws(() => parseFCS(encoder.encode('hello world, this is not an FCS file at all, not even close to it')), /Not an FCS file/);
});

test('floating-point log channels stored as decades are read as 10^x', () => {
  // Guava Muse writes log10 of the value as floats with $PnE "4.0,1.0" (FCS 3.1 asks for 0,0).
  // The writer emits $P1E 0,0; patch it in place to 4,1 (same length, so offsets hold).
  const withAmp = (bytes) => {
    const text = new TextDecoder('latin1').decode(bytes);
    const at = text.indexOf('$P1E|0,0|');
    const out = bytes.slice();
    out.set(new TextEncoder().encode('$P1E|4,1|'), at);
    return out;
  };
  const d = parseFCS(withAmp(writeFCS({ parameters: [{ name: 'FSC-HLog', label: '', range: 10000 }], data: [Float32Array.from([2, 0.5, 3.25])], keywords: {} }))).datasets[0];
  [100, Math.sqrt(10), 10 ** 3.25].forEach((v, e) => assert.ok(Math.abs(d.data[0][e] - v) < 1e-4 * v, `event ${e}`));
  assert.ok(d.diagnostics.some((x) => x.code === 'log-decades'));
  // Values beyond the decades are channel values: the FCS formula applies, 10^(4·512/1024) = 100.
  const channels = parseFCS(withAmp(writeFCS({ parameters: [{ name: 'L', label: '', range: 1024 }], data: [Float32Array.from([512, 1024])], keywords: {} }))).datasets[0];
  assert.ok(Math.abs(channels.data[0][0] - 100) < 1e-3);
  assert.ok(!channels.diagnostics.some((x) => x.code === 'log-decades'));
});

test('a file cut off before its DATA segment is reported, and its keywords still read', () => {
  const bytes = writeFCS({ parameters: [{ name: 'FSC-A', label: '', range: 1024 }], data: [Float32Array.from([1, 2, 3])], keywords: {} });
  const dataStart = Number(new TextDecoder().decode(bytes.subarray(26, 34)).trim());
  const cut = bytes.subarray(0, dataStart);
  assert.throws(() => parseFCS(cut), /before its DATA segment.*only the keywords/);
  const keywords = parseFCS(cut, { headerOnly: true }).datasets[0];
  assert.equal(keywords.eventCount, 3);
  assert.deepEqual(keywords.diagnostics.map((d) => d.code), ['no-data']);
});

test('reading in parts (parseFCSAsync) gives exactly what reading the whole file gives', async () => {
  const { parseFCSAsync, bytesSource, blobSource } = await import('./fcs.js');
  const { createHash } = await import('node:crypto');
  const n = 5000;
  const float = writeFCS({ parameters: [{ name: 'FSC-A', range: 262144 }, { name: 'FL1-A', range: 262144 }, { name: 'Time', range: 1024 }], data: [Float32Array.from({ length: n }, (_, i) => i * 1.5), Float32Array.from({ length: n }, (_, i) => Math.sin(i) * 1e4), Float32Array.from({ length: n }, (_, i) => i / 10)] }, { crc: true });
  // Big-endian 16-bit integers with flag bits (masked), at an unaligned DATA offset.
  const ints = new Uint8Array(n * 4);
  const view = new DataView(ints.buffer);
  for (let e = 0; e < n; e += 1) {
    view.setUint16(e * 4, (e * 7) % 1024 + (e % 13 === 0 ? 1024 : 0), false);
    view.setUint16(e * 4 + 2, e % 1024, false);
  }
  const integer = buildFCS({ version: 'FCS3.0', keywords: { $BYTEORD: '4,3,2,1', $DATATYPE: 'I', $MODE: 'L', $NEXTDATA: '0', $PAR: '2', $TOT: String(n), $P1N: 'FL1-H', $P1B: '16', $P1R: '1024', $P1E: '0,0', $P2N: 'FSC-H', $P2B: '16', $P2R: '1024', $P2E: '0,0', $PAD: 'x' }, data: ints });
  const permuted = buildFCS({ keywords: { $BYTEORD: '2,1,4,3', $DATATYPE: 'F', $MODE: 'L', $NEXTDATA: '0', $PAR: '1', $TOT: '3', $P1N: 'X', $P1B: '32', $P1R: '1024', $P1E: '0,0' }, data: Uint8Array.from([0, 0, 0x80, 0x3f, 0, 0, 0, 0x40, 0, 0, 0x40, 0x40].map((_, i, a) => a[i ^ 1])) });
  for (const [name, bytes] of [['float32 with a CRC', float], ['masked big-endian integers', integer], ['mixed byte order', permuted]]) {
    const whole = parseFCS(bytes);
    for (const chunkSize of [7, 1000, 1 << 20]) {
      let hashed = createHash('sha256');
      let at = 0;
      const parts = await parseFCSAsync(blobSource(new Blob([bytes])), { chunkSize, observe: (part, start) => { assert.equal(start, at); at += part.length; hashed.update(part); } });
      assert.equal(at, bytes.length, `${name}: every byte observed`);
      assert.equal(hashed.digest('hex'), createHash('sha256').update(bytes).digest('hex'));
      const [a] = whole.datasets;
      const [b] = parts.datasets;
      assert.deepEqual(b.keywords, a.keywords, name);
      assert.deepEqual(b.diagnostics, a.diagnostics, `${name}: diagnostics`);
      assert.deepEqual(b.crc, a.crc, `${name}: CRC`);
      a.data.forEach((column, i) => assert.deepEqual(Array.from(b.data[i]), Array.from(column), `${name}: column ${i}, chunks of ${chunkSize}`));
      hashed = null;
    }
  }
  assert.ok(parseFCS(float).datasets[0].crc.ok, 'the CRC was checked');
  assert.ok(parseFCS(integer).datasets[0].diagnostics.some((d) => d.code === 'masked-bits'));
  // Bytes in memory are read without copying them.
  const inMemory = await parseFCSAsync(bytesSource(float));
  assert.deepEqual(Array.from(inMemory.datasets[0].data[1]), Array.from(parseFCS(float).datasets[0].data[1]));
});

test('the keywords alone are read without the events', async () => {
  const { parseFCSAsync } = await import('./fcs.js');
  const bytes = writeFCS({ parameters: [{ name: 'A', range: 1024 }], data: [Float32Array.from({ length: 100000 }, (_, i) => i)] });
  let read = 0;
  const source = { size: bytes.length, read: async (a, b) => { read += b - a; return bytes.subarray(a, b); } };
  const { datasets } = await parseFCSAsync(source, { headerOnly: true });
  assert.equal(datasets[0].eventCount, 100000);
  assert.equal(datasets[0].data[0].length, 0);
  assert.ok(read < 10000, `read ${read} bytes of ${bytes.length}`);
});

test('a URL source reads by range requests', async () => {
  const { parseFCSAsync, urlSource } = await import('./fcs.js');
  const bytes = writeFCS({ parameters: [{ name: 'A', range: 1024 }, { name: 'B', range: 1024 }], data: [Float32Array.from({ length: 3000 }, (_, i) => i), Float32Array.from({ length: 3000 }, (_, i) => -i)] });
  const ranges = [];
  const fakeFetch = async (url, init = {}) => {
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Length': String(bytes.length) } });
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    ranges.push([Number(a), Number(b)]);
    return new Response(bytes.slice(Number(a), Number(b) + 1), { status: 206 });
  };
  const source = await urlSource('http://127.0.0.1/api/library/files/x', { fetch: fakeFetch });
  assert.equal(source.size, bytes.length);
  const { datasets } = await parseFCSAsync(source, { chunkSize: 4096 });
  assert.deepEqual(Array.from(datasets[0].data[1]), Array.from(parseFCS(bytes).datasets[0].data[1]));
  assert.ok(ranges.length > 3, 'read in several ranges');
  const refused = await urlSource('http://x/f', { size: bytes.length, fetch: async () => new Response('no', { status: 404 }) });
  await assert.rejects(parseFCSAsync(refused), /HTTP 404/);
});

test('columns can be allocated on shared memory (for workers), with the same values', async () => {
  const { parseFCSAsync, bytesSource } = await import('./fcs.js');
  const bytes = writeFCS({ parameters: [{ name: 'A', range: 1024 }, { name: 'B', range: 1024 }], data: [Float32Array.of(1, 2, 3), Float32Array.of(-4, 5, 6)] });
  const allocate = (n) => new Float32Array(new SharedArrayBuffer(n * 4));
  for (const parsed of [parseFCS(bytes, { allocate }), await parseFCSAsync(bytesSource(bytes), { allocate })]) {
    const [d] = parsed.datasets;
    assert.ok(d.data.every((c) => c.buffer instanceof SharedArrayBuffer));
    assert.deepEqual(Array.from(d.data[1]), [-4, 5, 6]);
  }
});
