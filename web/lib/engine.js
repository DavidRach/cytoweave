// The analysis engine: evaluates a workspace's gates on a sample's events and computes statistics.
//
// A SampleView wraps one decoded data set with the sample's compensation and caches what plots and
// gates ask for repeatedly: compensated columns, transformed (scaled) columns and populations.
// Populations are memoized under a content hash of the gate chain (type, dimensions, effective
// geometry, parents), so editing one gate recomputes only that gate and its descendants.

import { compensator } from './compensation.js';
import { float32 } from './memory.js';
import { applyTransform, createTransform, defaultTransform } from './transforms.js';
import { boundaryTest, boundaryTestN, membershipNSet, membershipSet, offsetGeometry, pointTest, pointTestN } from './gates.js';
import { EventSet, differenceSets, intersectSets, unionSets } from './eventset.js';
import { describe, gather, summarize } from './stats.js';
import { ksTest, overtonSubtraction, probabilityBinning, sedSubtraction } from './distribution.js';
import { binomialInterval, countPrecision, poissonInterval } from './rare-events.js';
import { evaluateColumns, evaluateFormula, parseFormula } from './formula.js';
import { standardCurve } from './calibration.js';
import { readSpillover } from './fcs.js';
import { ROOT, effectiveGeometry, gateApplies, gateById } from './workspace.js';

// cyrb53: a fast 53-bit string hash (public domain, bryc), for cache keys.
export function hash53(text, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// A compensation's state on one sample: its compensated float32 columns, each computed when first
// asked for (a large sample's first plots, on scatter, need none), and, for exact boundary
// decisions, the inverse matrix.
class CompensatedColumns {
  constructor(compensated = null) {
    this.compensated = compensated;
  }

  has(name) {
    return Boolean(this.compensated?.channels.includes(name));
  }

  get(name) {
    return this.compensated?.column(name);
  }

  // The columns computed so far.
  values() {
    return this.compensated?.computed() ?? [];
  }
}

function compensationContext(raw, comp) {
  const context = { key: comp ? `${comp.id}:${hash53(Array.from(comp.matrix).join(','))}` : 'none', comp, columns: new CompensatedColumns(), exact: null, note: null };
  if (!comp) return context;
  const present = comp.channels.filter((c) => raw.has(c));
  if (!present.length) return context;
  let channels = comp.channels;
  let matrix = comp.matrix;
  if (present.length < comp.channels.length) {
    const idx = present.map((c) => comp.channels.indexOf(c));
    const n = comp.channels.length;
    matrix = [];
    for (const i of idx) for (const j of idx) matrix.push(comp.matrix[i * n + j]);
    channels = present;
    context.note = `Compensation channels missing from this sample were left out: ${comp.channels.filter((c) => !raw.has(c)).join(', ')}.`;
  }
  const columns = {};
  for (const c of channels) columns[c] = raw.get(c);
  const compensated = compensator(columns, { channels, matrix }, float32);
  context.columns = new CompensatedColumns(compensated);
  context.exact = { channels, inverse: compensated.inverse, index: new Map(channels.map((c, i) => [c, i])) };
  return context;
}

// What a sample view may keep in its caches, in bytes. A ten-million-event sample has 40 MB per
// scaled column and up to 1.25 MB per population (a bitset), so the caches are bounded by size,
// least recently used first, rather than by entry count.
export const CACHE_LIMITS = { scaled: 384 * 1024 ** 2, populations: 128 * 1024 ** 2, indices: 128 * 1024 ** 2 };
const MISSING = Symbol('missing');

// A least-recently-used map bounded by the bytes of its values (and an entry count).
class SizedCache {
  constructor(limit, maxEntries = 4096) {
    this.limit = limit;
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.bytes = 0;
  }

  get size() {
    return this.map.size;
  }

  has(key) {
    return this.map.has(key);
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.delete(key);
    this.map.set(key, value);
    this.bytes += value?.byteLength ?? 0;
    for (const [oldest, old] of this.map) {
      if ((this.bytes <= this.limit && this.map.size <= this.maxEntries) || oldest === key) break;
      this.map.delete(oldest);
      this.bytes -= old?.byteLength ?? 0;
    }
  }

  delete(key) {
    if (!this.map.has(key)) return false;
    this.bytes -= this.map.get(key)?.byteLength ?? 0;
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  keys() {
    return this.map.keys();
  }

  values() {
    return this.map.values();
  }
}

// Compensation references (gate dimensions may name one; Gating-ML's compensation-ref):
//   undefined / null   the sample's own compensation
//   'uncompensated'    none
//   'file'             the file's $SPILLOVER
//   a compensation id  that workspace compensation
export class SampleView {
  constructor(record, dataset) {
    this.id = record.id;
    this.record = record;
    this.dataset = dataset;
    this.eventCount = dataset.eventCount;
    this.raw = new Map(dataset.parameters.map((p) => [p.name, dataset.data[p.index]]));
    this.parameters = dataset.parameters;
    this.compensation = null;
    this.own = compensationContext(this.raw, null);
    this.compensated = this.own.columns;
    // Other compensations that gate dimensions name: reference → context.
    this.contexts = new Map();
    this.compensations = [];
    this.derived = new Map();
    this.derivedVersion = new Map();
    // Channels computed on demand from other channels, from the workspace's derived records
    // (Gating-ML fratio, and non-square spectrum matrices): name → { kind, inputs, params, key }.
    this.computed = new Map();
    this.computedSource = null;
    this.computedColumns = new Map();
    this.scaledCache = new SizedCache(CACHE_LIMITS.scaled, 256);
    this.populationCache = new SizedCache(CACHE_LIMITS.populations);
    // Bitset populations expanded into indices for code that needs them (population()).
    this.indexCache = new SizedCache(CACHE_LIMITS.indices, 256);
    this.statCache = new Map();
    this.version = 'none';
  }

  get bytes() {
    let total = 0;
    for (const column of this.raw.values()) total += column.byteLength;
    for (const column of this.compensated.values()) total += column.byteLength;
    for (const context of this.contexts.values()) for (const column of context?.columns.values() ?? []) total += column.byteLength;
    for (const column of this.derived.values()) total += column.byteLength;
    for (const column of this.computedColumns.values()) total += column.byteLength;
    return total + this.scaledCache.bytes + this.populationCache.bytes + this.indexCache.bytes;
  }

  get compensationKey() {
    return this.own.key;
  }

  get compensationNote() {
    return this.own.note;
  }

  // Applies a compensation ({ id, channels, matrix }) or null. Channels the data lack are
  // ignored with a note rather than failing, as controls often omit unused detectors.
  setCompensation(comp) {
    const key = comp ? `${comp.id}:${hash53(Array.from(comp.matrix).join(','))}` : 'none';
    if (key === this.own.key) return;
    this.compensation = comp;
    this.own = compensationContext(this.raw, comp);
    this.compensated = this.own.columns;
    this.bumpVersion();
  }

  bumpVersion() {
    const derived = [...this.derivedVersion.entries()].map(([k, v]) => `${k}=${v}`).join(',');
    const computed = [...this.computed.entries()].map(([k, v]) => `${k}=${v.key}`).join(',');
    const contexts = [...this.contexts.entries()].map(([k, v]) => `${k}=${v?.key}`).join(',');
    this.computedColumns.clear();
    this.version = hash53(`${this.own.key}|${derived}|${computed}|${contexts}`);
    this.scaledCache.clear();
    this.populationCache.clear();
    this.indexCache.clear();
    this.statCache.clear();
  }

  // Adds or replaces a derived channel (cluster labels, embedding coordinates, QC masks).
  setDerived(name, column, version = hash53(`${name}:${column.length}:${column[0]}:${column[column.length - 1]}`)) {
    if (column.length !== this.eventCount) throw new Error(`Derived channel ${name} has ${column.length} values for ${this.eventCount} events.`);
    this.derived.set(name, column);
    this.derivedVersion.set(name, version);
    this.bumpVersion();
  }

  // Follows the workspace: its compensations (for gate dimensions that name one) and the computed
  // channels of its derived records.
  syncWorkspace(ws) {
    if (ws.compensations !== this.compensations) {
      this.compensations = ws.compensations ?? [];
      if (this.contexts.size) {
        this.contexts.clear();
        this.bumpVersion();
      }
    }
    this.syncComputed(ws.derived);
  }

  // Defines the computed channels of derived records without stored columns: ratios
  // ({ kind: 'ratio', inputs: [x, y], outputs: [name], params: { A, B, C } }), unmixing
  // ({ kind: 'unmix', inputs: detectors, outputs: fluorochromes, params: { matrix } }, matrix
  // detectors × fluorochromes, row-major), formulas ({ kind: 'formula', inputs, outputs: [name],
  // params: { expression } }, formula.js) and bead calibrations ({ kind: 'calibration',
  // inputs: [channel], outputs: [name], params: { m, b, unit }, samples }, calibration.js). A
  // record with `samples` applies to those samples only (a calibration to the samples acquired
  // with its beads).
  syncComputed(records = []) {
    if (records === this.computedSource) return;
    this.computedSource = records;
    let changed = false;
    const seen = new Set();
    const define = (name, entry) => {
      seen.add(name);
      if (this.computed.get(name)?.key !== entry.key) {
        this.computed.set(name, entry);
        changed = true;
      }
    };
    for (const record of records) {
      if (record.files) continue;
      if (record.samples && !record.samples.includes(this.id)) continue;
      if (record.kind === 'formula' && record.outputs?.[0] && record.inputs?.length && record.params?.expression) {
        let tree = null;
        try {
          tree = parseFormula(record.params.expression);
        } catch {
          continue;
        }
        define(record.outputs[0], { kind: 'formula', inputs: record.inputs, params: { tree }, key: JSON.stringify(['formula', record.params.expression]) });
      } else if (record.kind === 'calibration' && record.outputs?.[0] && record.inputs?.length === 1) {
        const { m, b, unit } = record.params ?? {};
        define(record.outputs[0], { kind: 'calibration', inputs: record.inputs, params: { m, b, unit }, key: JSON.stringify(['calibration', record.inputs, m, b, unit]) });
      } else if (record.kind === 'ratio' && record.outputs?.[0] && record.inputs?.length === 2) {
        define(record.outputs[0], { kind: 'ratio', inputs: record.inputs, params: record.params ?? {}, key: JSON.stringify(['ratio', record.inputs, record.params]) });
      } else if (record.kind === 'unmix' && record.inputs?.length && record.outputs?.length && record.params?.matrix?.length === record.inputs.length * record.outputs.length) {
        const key = hash53(JSON.stringify(['unmix', record.inputs, record.outputs, record.params.matrix]));
        record.outputs.forEach((name, j) => define(name, { kind: 'unmix', inputs: record.inputs, params: { matrix: record.params.matrix, j, f: record.outputs.length }, key: `${key}:${j}` }));
      }
    }
    for (const name of [...this.computed.keys()]) {
      if (!seen.has(name)) {
        this.computed.delete(name);
        changed = true;
      }
    }
    if (changed) this.bumpVersion();
  }

  removeDerived(name) {
    if (this.derived.delete(name)) {
      this.derivedVersion.delete(name);
      this.bumpVersion();
    }
  }

  // The compensation context of a reference (see above); null when it cannot be resolved.
  context(ref) {
    if (ref === undefined || ref === null) return this.own;
    if (this.contexts.has(ref)) return this.contexts.get(ref);
    let comp = null;
    if (ref === 'file') {
      const spill = readSpillover(this.dataset.keywords ?? {}, this.parameters);
      comp = spill && !spill.identity ? { id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) } : null;
    } else if (ref !== 'uncompensated') {
      const found = this.compensations.find((c) => c.id === ref);
      if (!found) return null;
      comp = { id: found.id, channels: found.channels, matrix: found.matrix };
    }
    const key = comp ? `${comp.id}:${hash53(Array.from(comp.matrix).join(','))}` : 'none';
    let context;
    try {
      context = key === this.own.key ? this.own : compensationContext(this.raw, comp);
    } catch {
      context = null;
    }
    this.contexts.set(ref, context);
    return context;
  }

  hasChannel(name, ref) {
    if (ref !== undefined && ref !== null && !this.context(ref)) return false;
    if (this.raw.has(name) || this.derived.has(name)) return true;
    const entry = this.computed.get(name);
    return Boolean(entry && entry.inputs.every((input) => this.raw.has(input) || this.derived.has(input)));
  }

  // Linear values of a channel: compensated when the compensation covers it.
  column(name, ref) {
    const context = this.context(ref);
    const column = context?.columns.get(name) ?? this.derived.get(name) ?? this.raw.get(name) ?? (this.hasChannel(name, ref) ? this.computedColumn(name, ref) : undefined);
    if (!column) throw new Error(`The sample "${this.record.name}" has no channel "${name}"${context ? '' : ` (compensation "${ref}" is not available)`}.`);
    return column;
  }

  // fratio (Gating-ML 2.0 §5.3.1): A·(x − B) / (y − C) of the (compensated) inputs, in IEEE
  // arithmetic: ±Infinity where y = C (in no gate's upper half-open interval), NaN for 0/0.
  // Unmixing: Σᵢ detectorᵢ · W[i][j].
  computedColumn(name, ref) {
    const entry = this.computed.get(name);
    if (!entry) return undefined;
    const cacheKey = `${name}|${ref ?? ''}`;
    let column = this.computedColumns.get(cacheKey);
    if (column) return column;
    column = float32(this.eventCount);
    const inputs = entry.inputs.map((input) => this.column(input, ref));
    if (entry.kind === 'ratio') {
      const [x, y] = inputs;
      const { A = 1, B = 0, C = 0 } = entry.params;
      for (let i = 0; i < column.length; i += 1) column[i] = (A * (x[i] - B)) / (y[i] - C);
    } else if (entry.kind === 'formula') {
      const values = evaluateColumns(entry.params.tree, (input) => inputs[entry.inputs.indexOf(input)], column.length);
      column.set(values);
    } else if (entry.kind === 'calibration') {
      const curve = standardCurve(entry.params);
      const [x] = inputs;
      for (let i = 0; i < column.length; i += 1) column[i] = curve(x[i]);
    } else {
      const { matrix, j, f } = entry.params;
      const weights = inputs.map((_, i) => matrix[i * f + j]);
      for (let e = 0; e < column.length; e += 1) {
        let sum = 0;
        for (let i = 0; i < inputs.length; i += 1) sum += inputs[i][e] * weights[i];
        column[e] = sum;
      }
    }
    this.computedColumns.set(cacheKey, column);
    return column;
  }

  // A channel's value for one event in double precision: the stored columns are float32, so
  // compensated values and computed channels are recomputed from the raw data, as reference
  // tools do.
  exactValue(name, e, ref) {
    const context = this.context(ref);
    const exact = context?.exact;
    const j = exact?.index.get(name);
    if (j !== undefined) {
      const n = exact.channels.length;
      let sum = 0;
      for (let i = 0; i < n; i += 1) {
        const w = exact.inverse[i * n + j];
        if (w !== 0) sum += this.raw.get(exact.channels[i])[e] * w;
      }
      return sum;
    }
    const entry = !this.raw.has(name) && !this.derived.has(name) ? this.computed.get(name) : null;
    if (entry?.kind === 'ratio') {
      const { A = 1, B = 0, C = 0 } = entry.params;
      return (A * (this.exactValue(entry.inputs[0], e, ref) - B)) / (this.exactValue(entry.inputs[1], e, ref) - C);
    }
    if (entry?.kind === 'formula') return evaluateFormula(entry.params.tree, (input) => this.exactValue(input, e, ref));
    if (entry?.kind === 'calibration') return standardCurve(entry.params)(this.exactValue(entry.inputs[0], e, ref));
    if (entry?.kind === 'unmix') {
      const { matrix, j: k, f } = entry.params;
      let sum = 0;
      entry.inputs.forEach((input, i) => { sum += this.exactValue(input, e, ref) * matrix[i * f + k]; });
      return sum;
    }
    return this.column(name, ref)[e];
  }

  isCompensated(name) {
    return this.compensated.has(name);
  }

  // A channel's values in a transform's scale space, cached.
  scaled(name, spec, ref) {
    const transform = createTransform(spec);
    const key = `${name}|${transform.key}|${ref ?? ''}`;
    let column = this.scaledCache.get(key);
    if (!column) {
      const source = this.column(name, ref);
      column = applyTransform(source, transform, float32(source.length));
      this.scaledCache.set(key, column);
    }
    return column;
  }

  // Drops what is quick to recompute (scaled columns, populations expanded into indices) and
  // returns the bytes freed.
  trimCaches() {
    const freed = this.scaledCache.bytes + this.indexCache.bytes;
    this.scaledCache.clear();
    this.indexCache.clear();
    return freed;
  }

  // A cached population (an EventSet, or undefined when the gate does not apply), else MISSING.
  cachedPopulation(key) {
    return this.populationCache.has(key) ? this.populationCache.get(key) : MISSING;
  }

  cachePopulation(key, set) {
    this.populationCache.set(key, set);
  }

  // A population's sorted indices; a bitset's are expanded once and kept while there is room.
  indicesOf(set) {
    if (set.indices) return set.indices;
    let indices = this.indexCache.get(set);
    if (!indices) {
      indices = set.toIndices();
      this.indexCache.set(set, indices);
    }
    return indices;
  }

  channelInfo(name) {
    const p = this.parameters.find((param) => param.name === name);
    if (p) return p;
    const entry = this.computed.get(name);
    // A calibrated channel is the fluorescence channel it calibrates, in other units.
    if (entry?.kind === 'calibration') {
      const input = this.parameters.find((param) => param.name === entry.inputs[0]);
      if (input) return { ...input, index: undefined, name, range: standardCurve(entry.params)(input.range), label: input.label, marker: input.marker, unit: entry.params.unit };
    }
    if (this.derived.has(name) || entry) return { name, type: 'derived', range: 1, label: '', marker: '' };
    return null;
  }
}

// --- Gate signatures --------------------------------------------------------------------------

const ownSignatures = new WeakMap();

function ownSignature(gate, geometry) {
  let bySample = ownSignatures.get(gate);
  if (!bySample) {
    bySample = new Map();
    ownSignatures.set(gate, bySample);
  }
  let sig = bySample.get(geometry);
  if (!sig) {
    sig = hash53(JSON.stringify([gate.type, gate.dims, geometry]));
    bySample.set(geometry, sig);
  }
  return sig;
}

// The cache key of a gate's population on a sample: its own content and its parent chain.
export function gateSignature(ws, gate, sampleId, depth = 0) {
  if (depth > 256) throw new Error('The gate hierarchy has a cycle.');
  const geometry = effectiveGeometry(gate, sampleId);
  let sig = ownSignature(gate, geometry);
  if (gate.type === 'boolean') {
    const operands = geometry.operands.map((id) => {
      const operand = gateById(ws, id);
      return operand ? gateSignature(ws, operand, sampleId, depth + 1) : 'missing';
    });
    sig = hash53(`${sig}|${operands.join(',')}`);
  }
  const parent = gate.parentId ? gateById(ws, gate.parentId) : null;
  return parent ? hash53(`${gateSignature(ws, parent, sampleId, depth + 1)}>${sig}`) : sig;
}

// --- Populations ------------------------------------------------------------------------------

export class GateError extends Error {}

// Events of a gate's population on a sample, as an EventSet (eventset.js: a bitset when large,
// indices when small), or null for every event. Returns undefined when the gate does not apply to
// the sample or a channel is missing.
export function populationSet(view, ws, gateId) {
  if (!gateId || gateId === ROOT) return null;
  const gate = gateById(ws, gateId);
  if (!gate) throw new GateError(`No gate ${gateId}.`);
  view.syncWorkspace?.(ws);
  if (!gateApplies(ws, gate, view.id)) return undefined;
  const key = `${view.version}|${gateSignature(ws, gate, view.id)}`;
  const cached = view.cachedPopulation(key);
  if (cached !== MISSING) return cached;
  const parent = gate.parentId ? populationSet(view, ws, gate.parentId) : null;
  if (parent === undefined) return undefined;
  const result = evaluateGate(view, ws, gate, effectiveGeometry(gate, view.id), parent);
  view.cachePopulation(key, result);
  return result;
}

// The same population as sorted event indices (a Uint32Array), or null for every event; undefined
// as above. Code that only counts, plots or summarizes a population should use populationSet,
// which does not expand a bitset into indices.
export function population(view, ws, gateId) {
  const set = populationSet(view, ws, gateId);
  return set ? view.indicesOf(set) : set;
}

// A population's size; NaN when the gate does not apply.
export function populationSize(view, ws, gateId) {
  return countOf(populationSet(view, ws, gateId), view);
}

// The members of a gate's geometry among `parent` (an EventSet, indices or null), as an EventSet.
export function evaluateGate(view, ws, gate, geometry, parent) {
  const size = view.eventCount;
  if (gate.type === 'boolean') {
    const operands = (geometry.operands ?? []).map((id) => populationSet(view, ws, id));
    if (operands.some((op) => op === undefined)) return undefined;
    if (!operands.length) return geometry.op === 'not' ? asEventSet(parent, size) : EventSet.empty(size);
    let result;
    switch (geometry.op) {
      case 'and': result = operands.reduce((acc, op) => intersectSets(acc, op, size)); break;
      case 'or': result = operands.reduce((acc, op) => unionSets(acc, op, size)); break;
      case 'not': {
        const combined = operands.reduce((acc, op) => unionSets(acc, op, size));
        result = differenceSets(parent, combined, size);
        break;
      }
      default: throw new GateError(`Unknown boolean operator ${geometry.op}.`);
    }
    return asEventSet(intersectSets(parent, result ?? null, size), size);
  }
  for (const dim of gate.dims) if (!view.hasChannel(dim.channel, dim.compensation)) return undefined;
  if (gate.type === 'category') {
    const column = view.column(gate.dims[0].channel, gate.dims[0].compensation);
    return membershipSet('category', geometry, column, null, parent, size);
  }
  const columns = gate.dims.map((d) => view.scaled(d.channel, d.transform, d.compensation));
  if (isMultidimensional(gate)) return membershipNSet(gate.type, geometry, columns, parent, size, exactRefinement(view, gate, geometry));
  return membershipSet(gate.type, geometry, columns[0], columns[1] ?? null, parent, size, exactRefinement(view, gate, geometry));
}

// A gate's population is always a set, even when it holds every event (null is the root's).
function asEventSet(set, size) {
  if (set === null) return EventSet.fromIndices(Uint32Array.from({ length: size }, (_, i) => i), size);
  return set instanceof EventSet ? set : EventSet.fromIndices(set, size);
}

// Gates evaluated point by point in any number of dimensions (see gates.js membershipN).
export function isMultidimensional(gate) {
  return gate.type === 'ellipsoid' || (gate.type === 'rectangle' && gate.dims.length !== 2);
}

// Decides events at a gate's boundary from double-precision values (see membership).
function exactRefinement(view, gate, geometry) {
  const multi = isMultidimensional(gate);
  const near = multi ? boundaryTestN(gate.type, geometry) : boundaryTest(gate.type, geometry);
  if (!near) return null;
  const forward = gate.dims.map((d) => createTransform(d.transform).forward);
  const exactPoint = (e) => gate.dims.map((d, i) => forward[i](view.exactValue(d.channel, e, d.compensation)));
  if (multi) {
    const test = pointTestN(gate.type, geometry);
    return { near, exact: (e) => test(exactPoint(e)) };
  }
  const test = pointTest(gate.type, geometry);
  return { near, exact: (e) => { const [x, y = 0] = exactPoint(e); return test(x, y); } };
}

// The size of a population: an EventSet, indices, null (every event) or undefined (NaN).
export function countOf(members, view) {
  if (members === null) return view.eventCount;
  if (members === undefined) return Number.NaN;
  return members instanceof EventSet ? members.count : members.length;
}

// Counts and frequencies of every gate on a sample: { [gateId]: { count, freqParent, freqTotal } }.
export function populationSummary(view, ws) {
  const out = {};
  for (const gate of ws.gates) {
    const indices = populationSet(view, ws, gate.id);
    if (indices === undefined) {
      out[gate.id] = { count: Number.NaN, applies: false };
      continue;
    }
    const count = countOf(indices, view);
    const parent = gate.parentId ? populationSet(view, ws, gate.parentId) : null;
    const parentCount = countOf(parent, view);
    out[gate.id] = {
      count,
      freqParent: parentCount ? (100 * count) / parentCount : Number.NaN,
      freqTotal: view.eventCount ? (100 * count) / view.eventCount : Number.NaN,
      applies: true,
    };
  }
  return out;
}

// --- Statistics -------------------------------------------------------------------------------

// Statistics compared with a control sample's population (stats.js `needsControl`).
export const COMPARISONS = new Set(['overton', 'sed', 'pbPositive', 'pbT', 'ksD']);

// A statistic spec: { stat, gateId, channel?, ancestorId?, value?, control? }. A comparison's
// control is { sampleId, gateId? } (the same population when gateId is omitted), and its events
// come from context.viewOf(sampleId); without them the statistic is NaN.
export function computeStatistic(view, ws, spec, context = {}) {
  const signature = (v, gateId) => (gateId && gateId !== ROOT ? gateSignature(ws, gateById(ws, gateId) ?? { id: '', type: 'x', dims: [], geometry: {} }, v.id) : 'root');
  let controlView = null;
  let controlKey = '';
  if (COMPARISONS.has(spec.stat)) {
    controlView = spec.control?.sampleId ? context.viewOf?.(spec.control.sampleId) ?? null : null;
    if (!controlView) return Number.NaN;
    controlKey = `|${controlView.version}|${signature(controlView, spec.control.gateId ?? spec.gateId)}`;
  }
  const key = `${view.version}|${JSON.stringify(spec)}|${signature(view, spec.gateId)}${controlKey}`;
  if (view.statCache.has(key)) return view.statCache.get(key);
  const value = controlView ? computeComparison(view, controlView, ws, spec) : computeStatisticUncached(view, ws, spec);
  view.statCache.set(key, value);
  if (view.statCache.size > 8192) view.statCache.delete(view.statCache.keys().next().value);
  return value;
}

function computeStatisticUncached(view, ws, spec) {
  const indices = populationSet(view, ws, spec.gateId ?? ROOT);
  if (indices === undefined) return Number.NaN;
  const count = countOf(indices, view);
  const gate = spec.gateId && spec.gateId !== ROOT ? gateById(ws, spec.gateId) : null;
  const freqOf = (ancestorId) => {
    const base = populationSet(view, ws, ancestorId ?? ROOT);
    const total = countOf(base, view);
    return total ? (100 * count) / total : Number.NaN;
  };
  switch (spec.stat) {
    case 'count': return count;
    case 'freqParent': return freqOf(gate?.parentId ?? ROOT);
    case 'freqGrandparent': {
      const parent = gate?.parentId ? gateById(ws, gate.parentId) : null;
      return freqOf(parent?.parentId ?? ROOT);
    }
    case 'freqTotal': return freqOf(ROOT);
    case 'freqOf': return freqOf(spec.ancestorId ?? ROOT);
    case 'countLow': return poissonInterval(count)[0];
    case 'countHigh': return poissonInterval(count)[1];
    case 'countCV': return countPrecision(count);
    case 'freqLow':
    case 'freqHigh': {
      const parentCount = countOf(populationSet(view, ws, gate?.parentId ?? ROOT), view);
      return parentCount > 0 ? 100 * binomialInterval(count, parentCount)[spec.stat === 'freqLow' ? 0 : 1] : Number.NaN;
    }
    case 'concentration': {
      // Events per µL from the acquired volume ($VOL in nL), when the instrument records it, times
      // the sample's dilution.
      const volume = Number.parseFloat(view.record.keywords?.$VOL ?? '');
      return volume > 0 ? (count / (volume / 1000)) * dilutionOf(ws, view, spec.dilution) : Number.NaN;
    }
    case 'absoluteCount': {
      // Cells per µL of the sample from counting beads: (cell events / bead events) × (beads in the
      // tube / µL of sample in the tube) × the dilution.
      const { beadGateId, beads, volume } = spec.counting ?? {};
      if (!beadGateId || !(beads > 0) || !(volume > 0)) return Number.NaN;
      const beadEvents = countOf(populationSet(view, ws, beadGateId), view);
      return beadEvents > 0 ? (count / beadEvents) * (beads / volume) * dilutionOf(ws, view, spec.dilution) : Number.NaN;
    }
    default: {
      if (!spec.channel || !view.hasChannel(spec.channel)) return Number.NaN;
      const options = {};
      if (spec.stat === 'percentile') options.percentile = spec.value ?? 50;
      if (spec.stat === 'positive') options.threshold = spec.value ?? 0;
      const result = describe(view.column(spec.channel), indices, options);
      return result[spec.stat] ?? Number.NaN;
    }
  }
}

// A sample's dilution factor: a number, or { field } naming a sample annotation that holds it
// (1 when absent).
function dilutionOf(ws, view, dilution) {
  if (dilution === undefined || dilution === null || dilution === '') return 1;
  if (typeof dilution === 'number') return dilution > 0 ? dilution : Number.NaN;
  const sample = ws.samples.find((s) => s.id === view.id);
  const value = Number.parseFloat(String(sample?.meta?.[dilution.field] ?? '').replace(/^1:/, ''));
  return value > 0 ? value : Number.NaN;
}

// A population's channel values in a test sample against a control sample's population (the same
// one unless spec.control.gateId names another), compared with distribution.js. All five are
// computed from ranks, so they do not depend on the channel's display transform.
function computeComparison(view, controlView, ws, spec) {
  const testSet = populationSet(view, ws, spec.gateId ?? ROOT);
  const controlSet = populationSet(controlView, ws, spec.control.gateId ?? spec.gateId ?? ROOT);
  if (testSet === undefined || controlSet === undefined || !spec.channel) return Number.NaN;
  if (!view.hasChannel(spec.channel) || !controlView.hasChannel(spec.channel)) return Number.NaN;
  const test = gather(view.column(spec.channel), testSet);
  const control = gather(controlView.column(spec.channel), controlSet);
  if (control.length < 2 || !test.length) return Number.NaN;
  switch (spec.stat) {
    case 'overton': return overtonSubtraction(control, test).percentPositive;
    case 'sed': return sedSubtraction(control, test).percentPositive;
    case 'pbPositive': return probabilityBinning(control, test).percentPositive;
    case 'pbT': return probabilityBinning(control, test).T;
    case 'ksD': return ksTest(control, test).D;
    default: return Number.NaN;
  }
}

// A population's values on several channels, aligned event by event (events with a non-finite
// value on any of them left out), each on its display scale (channelTransform), or as measured
// with { raw: true }. Null when the population does not apply to the sample.
export function populationColumns(view, ws, gateId, channels, options = {}) {
  const set = populationSet(view, ws, gateId ?? ROOT);
  if (set === undefined) return null;
  const indices = set === null ? null : set instanceof EventSet ? set.toIndices() : set;
  const sources = channels.map((channel) => (options.raw ? view.column(channel) : view.scaled(channel, channelTransform(ws, view, channel))));
  const n = indices ? indices.length : view.eventCount;
  const out = channels.map(() => new Float64Array(n));
  let k = 0;
  for (let i = 0; i < n; i += 1) {
    const e = indices ? indices[i] : i;
    let finite = true;
    for (const source of sources) if (!Number.isFinite(source[e])) finite = false;
    if (!finite) continue;
    for (let d = 0; d < sources.length; d += 1) out[d][k] = sources[d][e];
    k += 1;
  }
  return out.map((column) => (k === n ? column : column.slice(0, k)));
}

// Every channel's description for a population. With { basic: true }, only n, median, mean and
// robust SD (stats.js summarize), as the inspector's table shows.
export function describePopulation(view, ws, gateId, channels, options = {}) {
  const indices = populationSet(view, ws, gateId);
  if (indices === undefined) return null;
  const out = {};
  for (const channel of channels) {
    if (!view.hasChannel(channel)) continue;
    out[channel] = options.basic ? summarize(view.column(channel), indices) : describe(view.column(channel), indices);
  }
  return out;
}

// --- Gate robustness (sensitivity) analysis ----------------------------------------------------
//
// How much does a population's frequency depend on exactly where the gate boundary was drawn?
// The boundary is moved outward and inward by small distances in the gate's scale space (as a
// different analyst might draw it) and the frequency is recomputed. A population whose frequency
// barely changes sits in a density valley; one whose frequency changes a lot was cut through a
// dense region and deserves review.

export function gateRobustness(view, ws, gateId, options = {}) {
  const gate = gateById(ws, gateId);
  if (!gate || gate.type === 'boolean' || gate.type === 'category' || isMultidimensional(gate)) return null;
  const parent = gate.parentId ? populationSet(view, ws, gate.parentId) : null;
  if (parent === undefined) return null;
  const parentCount = countOf(parent, view);
  if (!parentCount) return null;
  const geometry = effectiveGeometry(gate, view.id);
  const distances = options.distances ?? [-0.02, -0.01, -0.005, 0, 0.005, 0.01, 0.02];
  const points = distances.map((distance) => {
    const moved = distance === 0 ? geometry : offsetGeometry(gate.type, geometry, distance);
    const members = evaluateGate(view, ws, gate, moved, parent);
    return { distance, frequency: (100 * countOf(members, view)) / parentCount };
  });
  const base = points.find((p) => p.distance === 0).frequency;
  // Sensitivity: change in frequency (percentage points) per 0.01 of scale (1% of the axis).
  const outer = points[points.length - 1];
  const inner = points[0];
  const slope = (outer.frequency - inner.frequency) / ((outer.distance - inner.distance) / 0.01);
  const relative = base > 0 ? Math.abs(slope) / base : Infinity;
  let rating = 'robust';
  if (relative > 0.15 || Math.abs(slope) > 5) rating = 'sensitive';
  else if (relative > 0.05 || Math.abs(slope) > 2) rating = 'moderate';
  return { gateId, frequency: base, points, sensitivity: slope, relativeSensitivity: relative, rating };
}

// --- Defaults ---------------------------------------------------------------------------------

// The transform to use for a channel: the workspace's setting, else a default for its type.
export function channelTransform(ws, view, channel) {
  const configured = ws.channelSettings?.[channel]?.transform;
  if (configured) return configured;
  const info = view?.channelInfo(channel);
  if (!info) return { type: 'linear', min: 0, max: 1 };
  view.defaultTransforms ??= new Map();
  const cached = view.defaultTransforms.get(channel);
  if (cached && cached.version === view.version) return cached.spec;
  const spec = defaultFor(view, channel, info);
  view.defaultTransforms.set(channel, { version: view.version, spec });
  return spec;
}

function defaultFor(view, channel, info) {
  if (info.type === 'derived') {
    const column = view.column(channel);
    let lo = Infinity; let hi = -Infinity;
    for (let i = 0; i < column.length; i += 1) {
      const v = column[i];
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) return { type: 'linear', min: 0, max: 1 };
    const pad = (hi - lo) * 0.04 || 1;
    return { type: 'linear', min: lo - pad, max: hi + pad };
  }
  return defaultTransform(info, view.record.technology, view.column(channel));
}
