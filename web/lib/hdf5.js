// A minimal HDF5 writer, for AnnData files (.h5ad): groups, datasets and attributes in HDF5's
// original file format (superblock version 0, version 1 object headers, groups as symbol tables
// with a local heap and a version 1 B-tree), which every HDF5 library reads. Datasets are stored
// contiguously and uncompressed. Types: little-endian floats (4, 8 bytes) and integers (1, 2, 4, 8
// bytes, signed or not), booleans as h5py writes them (an enum of int8 FALSE = 0, TRUE = 1), and
// variable-length UTF-8 strings (in global heap collections). Offsets and lengths are 8 bytes.
//
// const root = hdf5Group(); const obs = hdf5Group(root, 'obs');
// hdf5Dataset(obs, 'x', { type: 'float32', shape: [n], data: Float32Array });
// hdf5Attribute(obs, 'encoding-type', { type: 'string', data: 'dataframe' });
// writeHDF5(root) → Uint8Array.
//
// A group holds at most 256 members (one B-tree node of 32 symbol table nodes of 8 entries; the
// default sizes of HDF5's original format).

const encoder = new TextEncoder();
const UNDEF = 0xffffffffffffffffn;
const LEAF_K = 4; // symbol table node: 2K = 8 entries
const INTERNAL_K = 16; // B-tree node: 2K = 32 children
const SNOD_SIZE = 8 + 2 * LEAF_K * 40;
const TREE_SIZE = 24 + 2 * INTERNAL_K * 8 + (2 * INTERNAL_K + 1) * 8;
const MAX_MEMBERS = 2 * INTERNAL_K * 2 * LEAF_K;
const GCOL_MIN = 4096;
const GCOL_MAX_OBJECTS = 65535;

export const HDF5_TYPES = {
  float32: { cls: 'float', size: 4 }, float64: { cls: 'float', size: 8 },
  int8: { cls: 'int', size: 1, signed: true }, int16: { cls: 'int', size: 2, signed: true }, int32: { cls: 'int', size: 4, signed: true }, int64: { cls: 'int', size: 8, signed: true },
  uint8: { cls: 'int', size: 1, signed: false }, uint16: { cls: 'int', size: 2, signed: false }, uint32: { cls: 'int', size: 4, signed: false },
  bool: { cls: 'bool', size: 1 }, string: { cls: 'vlen-string', size: 16 },
};

export function hdf5Group(parent = null, name = null) {
  const group = { kind: 'group', members: new Map(), attrs: [] };
  if (parent) addMember(parent, name, group);
  return group;
}

// spec: { type (an HDF5_TYPES key), shape ([] for a scalar), data (a typed array or, for strings
// and booleans, an array; a string or boolean for a scalar) }.
export function hdf5Dataset(parent, name, spec) {
  const dataset = { kind: 'dataset', ...normalize(spec), attrs: [] };
  addMember(parent, name, dataset);
  return dataset;
}

export function hdf5Attribute(node, name, spec) {
  if (node.attrs.some((a) => a.name === name)) throw new Error(`The attribute ${name} is set twice.`);
  node.attrs.push({ name, ...normalize(spec) });
  return node;
}

function addMember(parent, name, node) {
  if (!name || name.includes('/') || name === '.') throw new Error(`"${name}" is not a valid HDF5 name.`);
  if (parent.members.has(name)) throw new Error(`The group already holds "${name}".`);
  if (parent.members.size >= MAX_MEMBERS) throw new Error(`A group holds at most ${MAX_MEMBERS} members in this writer.`);
  parent.members.set(name, node);
}

function normalize(spec) {
  const type = HDF5_TYPES[spec.type];
  if (!type) throw new Error(`Unknown HDF5 type ${spec.type}.`);
  const scalar = !spec.shape || spec.shape.length === 0;
  const shape = scalar ? [] : spec.shape.map(Number);
  const data = scalar && !ArrayBuffer.isView(spec.data) && !Array.isArray(spec.data) ? [spec.data] : spec.data;
  const count = shape.reduce((a, b) => a * b, 1);
  if (data.length !== count) throw new Error(`The data hold ${data.length} values for a shape of ${shape.join(' × ') || 'a scalar'} (${count}).`);
  return { type: spec.type, shape, data };
}

// --- Byte building ------------------------------------------------------------------------------

class Bytes {
  constructor(size) {
    this.buffer = new Uint8Array(size);
    this.view = new DataView(this.buffer.buffer);
    this.at = 0;
  }

  u8(v) { this.view.setUint8(this.at, v); this.at += 1; return this; }
  u16(v) { this.view.setUint16(this.at, v, true); this.at += 2; return this; }
  u32(v) { this.view.setUint32(this.at, v, true); this.at += 4; return this; }
  u64(v) { this.view.setBigUint64(this.at, BigInt(v), true); this.at += 8; return this; }
  bytes(b) { this.buffer.set(b, this.at); this.at += b.length; return this; }
  skip(n) { this.at += n; return this; }
}

const pad8 = (n) => Math.ceil(n / 8) * 8;

// --- Datatypes, dataspaces, data ----------------------------------------------------------------

function integerType(size, signed) {
  return new Bytes(12).u8(0x10).u8(signed ? 0x08 : 0).u8(0).u8(0).u32(size).u16(0).u16(size * 8).buffer;
}

function datatypeMessage(name) {
  const t = HDF5_TYPES[name];
  if (t.cls === 'int') return integerType(t.size, t.signed);
  if (t.cls === 'float') {
    const b = new Bytes(20).u8(0x11).u8(0x20).u8(t.size === 4 ? 31 : 63).u8(0).u32(t.size).u16(0).u16(t.size * 8);
    return (t.size === 4 ? b.u8(23).u8(8).u8(0).u8(23).u32(127) : b.u8(52).u8(11).u8(0).u8(52).u32(1023)).buffer;
  }
  if (t.cls === 'bool') {
    // An enum of int8, as h5py writes numpy booleans: FALSE = 0, TRUE = 1.
    const base = integerType(1, true);
    const b = new Bytes(8 + base.length + 16 + 2).u8(0x18).u16(2).u8(0).u32(1).bytes(base);
    b.bytes(encoder.encode('FALSE')).skip(3).bytes(encoder.encode('TRUE')).skip(4);
    return b.u8(0).u8(1).buffer;
  }
  // Variable-length string, UTF-8, null-terminated padding; its base type an unsigned byte.
  const base = integerType(1, false);
  return new Bytes(8 + base.length).u8(0x19).u8(0x01).u8(0x01).u8(0).u32(16).bytes(base).buffer;
}

function dataspaceMessage(shape) {
  const b = new Bytes(8 + 8 * shape.length).u8(1).u8(shape.length).u8(0).u8(0).u32(0);
  for (const d of shape) b.u64(d);
  return b.buffer;
}

// Values as stored: numbers in their type, strings as global heap references.
function encodeData(item, heapRef) {
  const t = HDF5_TYPES[item.type];
  const n = item.data.length;
  const b = new Bytes(n * t.size);
  if (t.cls === 'vlen-string') {
    for (let i = 0; i < n; i += 1) {
      const ref = heapRef(item, i);
      b.u32(ref.length).u64(ref.collection).u32(ref.index);
    }
    return b.buffer;
  }
  if (t.cls === 'bool') {
    for (let i = 0; i < n; i += 1) b.u8(item.data[i] ? 1 : 0);
    return b.buffer;
  }
  if (t.cls === 'float') {
    if (t.size === 4 && item.data instanceof Float32Array) return new Uint8Array(item.data.buffer.slice(item.data.byteOffset, item.data.byteOffset + item.data.byteLength));
    for (let i = 0; i < n; i += 1) {
      if (t.size === 4) b.view.setFloat32(i * 4, item.data[i], true);
      else b.view.setFloat64(i * 8, item.data[i], true);
    }
    return b.buffer;
  }
  for (let i = 0; i < n; i += 1) {
    const v = item.data[i];
    if (t.size === 1) t.signed ? b.view.setInt8(i, v) : b.view.setUint8(i, v);
    else if (t.size === 2) t.signed ? b.view.setInt16(i * 2, v, true) : b.view.setUint16(i * 2, v, true);
    else if (t.size === 4) t.signed ? b.view.setInt32(i * 4, v, true) : b.view.setUint32(i * 4, v, true);
    else b.view.setBigInt64(i * 8, BigInt(v), true);
  }
  return b.buffer;
}

// --- Writing -------------------------------------------------------------------------------------

export function writeHDF5(root) {
  if (root.kind !== 'group') throw new Error('The root must be a group.');
  // 1. Every string goes into global heap collections, laid out first (after the superblock), so
  //    that the data referring to them can be encoded with their addresses.
  const collections = [];
  const refs = new Map(); // item → [{ collection index, object index, length }]
  let current = null;
  const place = (bytes) => {
    if (!current || current.objects.length >= GCOL_MAX_OBJECTS) {
      current = { objects: [], used: 16 };
      collections.push(current);
    }
    current.objects.push(bytes);
    current.used += 16 + pad8(bytes.length);
    return { collection: collections.length - 1, index: current.objects.length, length: bytes.length };
  };
  const visit = (node) => {
    for (const attr of node.attrs) if (attr.type === 'string') refs.set(attr, attr.data.map((s) => place(encoder.encode(String(s ?? '')))));
    if (node.kind === 'dataset' && node.type === 'string') refs.set(node, Array.from(node.data, (s) => place(encoder.encode(String(s ?? '')))));
    if (node.kind === 'group') for (const name of sortedNames(node)) visit(node.members.get(name));
  };
  visit(root);
  const superblockSize = 96;
  let cursor = superblockSize;
  const collectionAt = [];
  for (const c of collections) {
    // At least 4096 bytes (HDF5 reads a collection's first 4096 at once); the rest a free-space
    // object, which needs room for its 16-byte header.
    c.size = Math.max(GCOL_MIN, c.used);
    if (c.size > c.used && c.size - c.used < 16) c.size = c.used + 16;
    collectionAt.push(cursor);
    cursor += c.size;
  }
  const heapRef = (item, i) => {
    const r = refs.get(item)[i];
    return { length: r.length, collection: collectionAt[r.collection], index: r.index };
  };

  // 2. Everything else, children before their parents (a parent's header names its children's
  //    addresses), into chunks at known offsets.
  const chunks = [];
  const emit = (bytes) => {
    const at = cursor;
    chunks.push({ at, bytes });
    cursor += bytes.length;
    return at;
  };
  for (let k = 0; k < collections.length; k += 1) {
    const c = collections[k];
    const b = new Bytes(c.size);
    b.bytes(encoder.encode('GCOL')).u8(1).skip(3).u64(c.size);
    c.objects.forEach((obj, i) => {
      b.u16(i + 1).u16(0).u32(0).u64(obj.length).bytes(obj);
      b.at = pad8(b.at);
    });
    if (c.size > c.used) b.u16(0).u16(0).u32(0).u64(c.size - c.used); // free space
    chunks.push({ at: collectionAt[k], bytes: b.buffer });
  }

  const header = (messages) => {
    const size = messages.reduce((sum, m) => sum + 8 + pad8(m.data.length), 0);
    const b = new Bytes(16 + size).u8(1).u8(0).u16(messages.length).u32(1).u32(size).skip(4);
    for (const m of messages) {
      b.u16(m.type).u16(pad8(m.data.length)).u8(0).skip(3).bytes(m.data);
      b.at = pad8(b.at);
    }
    return emit(b.buffer);
  };
  const attributeMessages = (node) => node.attrs.map((attr) => {
    const name = encoder.encode(attr.name);
    const type = datatypeMessage(attr.type);
    const space = dataspaceMessage(attr.shape);
    const data = encodeData(attr, heapRef);
    const b = new Bytes(8 + pad8(name.length + 1) + pad8(type.length) + pad8(space.length) + data.length);
    b.u8(1).u8(0).u16(name.length + 1).u16(type.length).u16(space.length);
    b.bytes(name).skip(1);
    b.at = 8 + pad8(name.length + 1);
    b.bytes(type);
    b.at = 8 + pad8(name.length + 1) + pad8(type.length);
    b.bytes(space);
    b.at = 8 + pad8(name.length + 1) + pad8(type.length) + pad8(space.length);
    b.bytes(data);
    return { type: 0x000c, data: b.buffer };
  });

  const writeDataset = (node) => {
    const data = encodeData(node, heapRef);
    const address = data.length ? emit(data) : null;
    const layout = new Bytes(18).u8(3).u8(1).u64(address === null ? UNDEF : address).u64(data.length).buffer;
    return header([
      { type: 0x0001, data: dataspaceMessage(node.shape) },
      { type: 0x0003, data: datatypeMessage(node.type) },
      { type: 0x0005, data: new Uint8Array([2, 1, 2, 0]) },
      { type: 0x0008, data: layout },
      ...attributeMessages(node),
    ]);
  };

  // A group: its members, a local heap of their names, symbol table nodes of up to 8 entries
  // (names in byte order) and one B-tree node over them.
  const writeGroup = (node) => {
    const names = sortedNames(node);
    const addresses = names.map((name) => {
      const child = node.members.get(name);
      return child.kind === 'group' ? writeGroup(child).header : writeDataset(child);
    });
    const encoded = names.map((name) => encoder.encode(name));
    const offsets = [];
    let heapSize = 8; // offset 0: the empty string
    for (const e of encoded) {
      offsets.push(heapSize);
      heapSize += pad8(e.length + 1);
    }
    const heapData = new Uint8Array(heapSize);
    encoded.forEach((e, i) => heapData.set(e, offsets[i]));
    const heapDataAt = emit(heapData);
    const heapAt = emit(new Bytes(32).bytes(encoder.encode('HEAP')).u8(0).skip(3).u64(heapSize).u64(1).u64(heapDataAt).buffer);
    const nodes = [];
    for (let i = 0; i < names.length; i += 2 * LEAF_K) {
      const slice = names.slice(i, i + 2 * LEAF_K);
      const b = new Bytes(SNOD_SIZE).bytes(encoder.encode('SNOD')).u8(1).u8(0).u16(slice.length);
      slice.forEach((_, j) => b.u64(offsets[i + j]).u64(addresses[i + j]).u32(0).u32(0).skip(16));
      nodes.push({ at: emit(b.buffer), last: offsets[i + slice.length - 1] });
    }
    if (nodes.length > 2 * INTERNAL_K) throw new Error('A group has too many members for this writer.');
    const tree = new Bytes(TREE_SIZE).bytes(encoder.encode('TREE')).u8(0).u8(0).u16(nodes.length).u64(UNDEF).u64(UNDEF);
    tree.u64(0);
    for (const n of nodes) tree.u64(n.at).u64(n.last);
    const treeAt = emit(tree.buffer);
    const stab = new Bytes(16).u64(treeAt).u64(heapAt).buffer;
    return { header: header([{ type: 0x0011, data: stab }, ...attributeMessages(node)]), tree: treeAt, heap: heapAt };
  };
  const rootInfo = writeGroup(root);

  const out = new Uint8Array(cursor);
  for (const c of chunks) out.set(c.bytes, c.at);
  const sb = new Bytes(superblockSize);
  sb.bytes(new Uint8Array([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]));
  sb.u8(0).u8(0).u8(0).u8(0).u8(0).u8(8).u8(8).u8(0).u16(LEAF_K).u16(INTERNAL_K).u32(0);
  sb.u64(0).u64(UNDEF).u64(cursor).u64(UNDEF);
  sb.u64(0).u64(rootInfo.header).u32(1).u32(0).u64(rootInfo.tree).u64(rootInfo.heap);
  out.set(sb.buffer, 0);
  return out;
}

// Member names in byte order (UTF-8), as HDF5 compares them.
function sortedNames(group) {
  return [...group.members.keys()].sort((a, b) => {
    const x = encoder.encode(a);
    const y = encoder.encode(b);
    for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
}
