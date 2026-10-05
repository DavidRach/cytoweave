import assert from 'node:assert/strict';
import test from 'node:test';
import { hdf5Attribute, hdf5Dataset, hdf5Group, writeHDF5 } from './hdf5.js';
import { writeAnnData } from './anndata.js';
import { SampleView } from './engine.js';
import { addGates, createWorkspace } from './workspace.js';

// A reader of the subset the writer writes (superblock 0, version 1 object headers, symbol-table
// groups, contiguous datasets, variable-length strings), written for this test from the format
// specification.
function readHDF5(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (at) => Number(view.getBigUint64(at, true));
  const ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  const cstring = (at) => {
    let end = at;
    while (bytes[end]) end += 1;
    return new TextDecoder().decode(bytes.subarray(at, end));
  };
  assert.equal(ascii(1, 3), 'HDF');
  const heapObject = (collection, index) => {
    assert.equal(ascii(collection, 4), 'GCOL');
    let at = collection + 16;
    for (;;) {
      const id = view.getUint16(at, true);
      const size = u64(at + 8);
      if (id === index) return new TextDecoder().decode(bytes.subarray(at + 16, at + 16 + size));
      assert.ok(id !== 0, `object ${index} not found`);
      at += 16 + Math.ceil(size / 8) * 8;
    }
  };
  const messages = (address) => {
    assert.equal(bytes[address], 1);
    const count = view.getUint16(address + 2, true);
    const out = [];
    let at = address + 16;
    for (let i = 0; i < count; i += 1) {
      const type = view.getUint16(at, true);
      const size = view.getUint16(at + 2, true);
      out.push({ type, at: at + 8, size });
      at += 8 + size;
    }
    return out;
  };
  const decode = (typeAt, shape, dataAt) => {
    const cls = bytes[typeAt] & 0x0f;
    const size = view.getUint32(typeAt + 4, true);
    const n = shape.reduce((a, b) => a * b, 1);
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const at = dataAt + i * size;
      if (cls === 9) out.push(heapObject(u64(at + 4), view.getUint32(at + 12, true)));
      else if (cls === 1) out.push(size === 4 ? view.getFloat32(at, true) : view.getFloat64(at, true));
      else if (cls === 8) out.push(view.getInt8(at) === 1);
      else if (size === 1) out.push((bytes[typeAt + 1] & 8) ? view.getInt8(at) : view.getUint8(at));
      else if (size === 2) out.push(view.getInt16(at, true));
      else if (size === 4) out.push(view.getInt32(at, true));
      else out.push(Number(view.getBigInt64(at, true)));
    }
    return out;
  };
  const space = (at) => Array.from({ length: bytes[at + 1] }, (_, k) => u64(at + 8 + 8 * k));
  const attributes = (list) => Object.fromEntries(list.filter((m) => m.type === 0x0c).map((m) => {
    const nameSize = view.getUint16(m.at + 2, true);
    const typeSize = view.getUint16(m.at + 4, true);
    const spaceSize = view.getUint16(m.at + 6, true);
    const pad = (x) => Math.ceil(x / 8) * 8;
    const typeAt = m.at + 8 + pad(nameSize);
    const spaceAt = typeAt + pad(typeSize);
    const shape = space(spaceAt);
    const values = decode(typeAt, shape, spaceAt + pad(spaceSize));
    return [cstring(m.at + 8), shape.length ? values : values[0]];
  }));
  const object = (address) => {
    const list = messages(address);
    const stab = list.find((m) => m.type === 0x11);
    if (stab) {
      const tree = u64(stab.at);
      const heap = u64(stab.at + 8);
      assert.equal(ascii(tree, 4), 'TREE');
      assert.equal(ascii(heap, 4), 'HEAP');
      const heapData = u64(heap + 24);
      const members = {};
      const children = view.getUint16(tree + 6, true);
      let last = '';
      for (let c = 0; c < children; c += 1) {
        const node = u64(tree + 24 + 8 + c * 16);
        assert.equal(ascii(node, 4), 'SNOD');
        for (let k = 0; k < view.getUint16(node + 6, true); k += 1) {
          const entry = node + 8 + k * 40;
          const name = cstring(heapData + u64(entry));
          assert.ok(name > last || Buffer.compare(Buffer.from(name), Buffer.from(last)) > 0, 'names in order');
          last = name;
          members[name] = object(u64(entry + 8));
        }
      }
      return { kind: 'group', members, attrs: attributes(list) };
    }
    const shape = space(list.find((m) => m.type === 1).at);
    const typeAt = list.find((m) => m.type === 3).at;
    const layout = list.find((m) => m.type === 8).at;
    const values = shape.reduce((a, b) => a * b, 1) ? decode(typeAt, shape, u64(layout + 2)) : [];
    return { kind: 'dataset', shape, values, attrs: attributes(list) };
  };
  return object(u64(64));
}

test('groups, datasets and attributes read back, names in byte order across symbol table nodes', () => {
  const root = hdf5Group();
  hdf5Attribute(root, 'encoding-type', { type: 'string', data: 'anndata' });
  const obs = hdf5Group(root, 'obs');
  hdf5Attribute(obs, 'column-order', { type: 'string', shape: [2], data: ['b', 'µ'] });
  hdf5Attribute(obs, 'ordered', { type: 'bool', data: false });
  hdf5Dataset(obs, 'x', { type: 'float32', shape: [2, 2], data: Float32Array.from([1, 2.5, -3, 4]) });
  hdf5Dataset(obs, 'names', { type: 'string', shape: [3], data: ['', 'CD4+ T', 'é'] });
  hdf5Dataset(obs, 'flags', { type: 'bool', shape: [2], data: [true, false] });
  hdf5Dataset(obs, 'codes', { type: 'int8', shape: [3], data: Int8Array.from([-1, 0, 5]) });
  for (let k = 0; k < 12; k += 1) hdf5Dataset(obs, `c${k}`, { type: 'int32', shape: [1], data: [k] });
  hdf5Group(root, 'empty');
  const file = readHDF5(writeHDF5(root));
  assert.equal(file.attrs['encoding-type'], 'anndata');
  const g = file.members.obs;
  assert.deepEqual(g.attrs, { 'column-order': ['b', 'µ'], ordered: false });
  assert.deepEqual(g.members.x.values, [1, 2.5, -3, 4]);
  assert.deepEqual(g.members.x.shape, [2, 2]);
  assert.deepEqual(g.members.names.values, ['', 'CD4+ T', 'é']);
  assert.deepEqual(g.members.flags.values, [true, false]);
  assert.deepEqual(g.members.codes.values, [-1, 0, 5]);
  assert.equal(Object.keys(g.members).length, 16);
  assert.deepEqual(Object.keys(g.members).slice(0, 4), ['c0', 'c1', 'c10', 'c11']);
  assert.deepEqual(file.members.empty.members, {});
});

test('the writer refuses what it cannot write', () => {
  const root = hdf5Group();
  assert.throws(() => hdf5Dataset(root, 'a/b', { type: 'float32', shape: [1], data: [1] }), /not a valid HDF5 name/);
  assert.throws(() => hdf5Dataset(root, 'x', { type: 'float32', shape: [2, 2], data: [1, 2, 3] }), /3 values for a shape of 2 × 2/);
  assert.throws(() => hdf5Dataset(root, 'x', { type: 'complex', data: 1 }), /Unknown HDF5 type/);
  const big = hdf5Group();
  for (let k = 0; k < 256; k += 1) hdf5Dataset(big, `m${k}`, { type: 'int8', shape: [1], data: [0] });
  assert.throws(() => hdf5Dataset(big, 'one more', { type: 'int8', shape: [1], data: [0] }), /at most 256/);
});

test('an AnnData file of two samples: X, obs and var as AnnData lays them out', () => {
  const lin = { type: 'linear', min: 0, max: 100 };
  const samples = [0, 1].map((k) => ({ id: `s${k}`, name: `S${k}`, role: 'sample', meta: { condition: k ? 'stim' : 'unstim' }, technology: 'conventional', channels: [{ name: 'FSC-A', type: 'scatter' }, { name: 'FL1', type: 'fluorescence', marker: 'CD3' }] }));
  const views = new Map(samples.map((s, k) => [s.id, new SampleView(s, { eventCount: 3, parameters: [{ index: 0, name: 'FSC-A', type: 'scatter', range: 100 }, { index: 1, name: 'FL1', type: 'fluorescence', marker: 'CD3', range: 100 }], data: [Float32Array.from([10, 20, 30]), Float32Array.from([1, 50 + k, 90])], keywords: {} })]));
  let ws = { ...createWorkspace('t'), samples };
  ws = addGates(ws, [{ id: 'pos', name: 'CD3+', parentId: null, type: 'range', dims: [{ channel: 'FL1', transform: lin }], geometry: { min: 0.4, max: null } }]).ws;
  const items = samples.map((s) => ({ sample: s, view: views.get(s.id), total: 3, indices: Uint32Array.from([0, 2]) }));
  const { bytes, report } = writeAnnData(ws, items, { values: 'compensated', version: 'test', date: new Date('2026-10-04T00:00:00Z') });
  const file = readHDF5(bytes);
  assert.deepEqual(report.X, ['CD3']);
  assert.deepEqual(file.members.X.shape, [4, 1]);
  assert.deepEqual(file.members.X.values, [1, 90, 1, 90]);
  const obs = file.members.obs;
  assert.deepEqual(obs.attrs['column-order'], ['sample', 'condition', 'event', 'population', 'CD3+', 'FSC-A']);
  assert.deepEqual(obs.members._index.values, ['S0:0', 'S0:2', 'S1:0', 'S1:2']);
  assert.deepEqual(obs.members.sample.members.codes.values, [0, 0, 1, 1]);
  assert.deepEqual(obs.members.condition.members.categories.values, ['unstim', 'stim']);
  assert.deepEqual(obs.members.population.members.categories.values, ['All events', 'CD3+']);
  assert.deepEqual(obs.members.population.members.codes.values, [0, 1, 0, 1]);
  assert.deepEqual(obs.members['CD3+'].values, [false, true, false, true]);
  assert.deepEqual(obs.members['FSC-A'].values, [10, 30, 10, 30]);
  assert.equal(obs.members.sample.attrs['encoding-type'], 'categorical');
  assert.deepEqual(file.members.var.members._index.values, ['CD3']);
  assert.equal(file.members.uns.members.cytoweave.members.values.values[0], 'compensated values');
  assert.deepEqual(Object.keys(file.members), ['X', 'layers', 'obs', 'obsm', 'obsp', 'uns', 'var', 'varm', 'varp']);
});
