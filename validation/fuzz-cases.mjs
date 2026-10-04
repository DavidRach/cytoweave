// Fuzzing the FCS reader: seed files in every layout the reader supports, and mutations of them
// (HEADER offsets, keyword values, deleted and duplicated keywords, delimiters, flipped bytes,
// truncation, $NEXTDATA chains). Each case is replayable from its seed.
//
// The rule a case is held to: the file opens, with data that agree with its own description, or is
// refused with an FCSError and a message for the user. Any other exception, a hang or an outsized
// allocation is a failure. Used by the `fuzz` suite of run.mjs and by fuzz.mjs for long runs.

import { FCSError, bytesSource, parseFCS, parseFCSAsync, parseTextSegment, readHeader } from '../web/lib/fcs.js';
import { sampleFromDataset } from '../web/lib/workspace.js';
import { deidentifyFCS } from '../web/lib/deidentify.js';
import { createRandom } from '../web/lib/random.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const encoder = new TextEncoder();
const pad8 = (n) => {
  const text = String(n);
  return text.length > 8 ? '       0' : text.padStart(8, ' ');
};

// --- Seed files ---------------------------------------------------------------------------------

// Writes one data set. spec: { version, delimiter, params: [{ name, label, type ('I','F','D','A'),
// bits }], datatype (global), byteord, events (array of rows), keywords (extra), ascii ('fixed' |
// 'free'), stext (keywords placed in a supplemental TEXT), headerOffsets (false: zeros, the
// keywords locate DATA) }.
function encodeData(spec) {
  const { params, events } = spec;
  const datatype = spec.datatype;
  if (datatype === 'A') {
    if (spec.ascii === 'free') return encoder.encode(events.map((row) => row.join(' ')).join('\n') + '\n');
    let text = '';
    for (const row of events) row.forEach((v, i) => { text += String(Math.round(v)).padStart(params[i].bits, ' ').slice(-params[i].bits); });
    return encoder.encode(text);
  }
  const packed = params.some((p) => (p.type ?? datatype) === 'I' && p.bits % 8 !== 0);
  if (packed) {
    const bitsPerEvent = params.reduce((sum, p) => sum + p.bits, 0);
    const out = new Uint8Array(Math.ceil((bitsPerEvent * events.length) / 8));
    let bit = 0;
    for (const row of events) {
      row.forEach((v, i) => {
        const bits = params[i].bits;
        const value = Math.max(0, Math.min(2 ** bits - 1, Math.round(v)));
        for (let b = bits - 1; b >= 0; b -= 1) {
          if (Math.floor(value / 2 ** b) % 2) out[bit >> 3] |= 1 << (7 - (bit & 7));
          bit += 1;
        }
      });
    }
    return out;
  }
  const order = spec.byteord.split(',').map((s) => Number(s) - 1);
  const widths = params.map((p) => {
    const t = p.type ?? datatype;
    return t === 'F' ? 4 : t === 'D' ? 8 : p.bits / 8;
  });
  const eventBytes = widths.reduce((a, b) => a + b, 0);
  const out = new Uint8Array(eventBytes * events.length);
  const scratch = new DataView(new ArrayBuffer(8));
  let at = 0;
  for (const row of events) {
    row.forEach((v, i) => {
      const t = params[i].type ?? datatype;
      const w = widths[i];
      if (t === 'F') scratch.setFloat32(0, v, true);
      else if (t === 'D') scratch.setFloat64(0, v, true);
      else if (w === 8) scratch.setBigUint64(0, BigInt(Math.max(0, Math.round(v))), true);
      else {
        let value = Math.max(0, Math.min(2 ** (8 * w) - 1, Math.round(v)));
        for (let b = 0; b < w; b += 1) { scratch.setUint8(b, value % 256); value = Math.floor(value / 256); }
      }
      // Little-endian bytes in scratch; byte b of the stored value is little-endian byte order[b]
      // for 4-byte orders, and simply reversed for big-endian of other widths.
      const big = order[0] === order.length - 1 && order.length > 1 && order.every((n, k) => n === order.length - 1 - k);
      for (let b = 0; b < w; b += 1) {
        let source = b;
        if (w === order.length && !big) source = order[b];
        else if (big) source = w - 1 - b;
        out[at + b] = scratch.getUint8(source);
      }
      at += w;
    });
  }
  return out;
}

function textOf(pairs, delimiter) {
  let text = delimiter;
  for (const [key, value] of pairs) {
    const escape = (s) => String(s).split(delimiter).join(delimiter + delimiter);
    text += escape(key) + delimiter + escape(value) + delimiter;
  }
  return text;
}

// With `chained`, $NEXTDATA points just past this data set, where the next one starts.
function buildDataset(spec, chained = false) {
  const delimiter = spec.delimiter ?? '/';
  const data = encodeData(spec);
  const keywords = [];
  const add = (k, v) => keywords.push([k, String(v)]);
  add('$BYTEORD', spec.byteord ?? '1,2,3,4');
  add('$DATATYPE', spec.datatype);
  add('$MODE', 'L');
  add('$PAR', spec.params.length);
  add('$TOT', spec.events.length);
  add('$NEXTDATA', '0');
  spec.params.forEach((p, i) => {
    const n = i + 1;
    add(`$P${n}N`, p.name);
    if (p.label) add(`$P${n}S`, p.label);
    add(`$P${n}B`, p.bits);
    add(`$P${n}E`, p.amp ?? '0,0');
    add(`$P${n}R`, p.range ?? 1024);
    if (p.type && p.type !== spec.datatype) add(`$P${n}DATATYPE`, p.type);
    if (p.gain) add(`$P${n}G`, p.gain);
  });
  for (const [k, v] of Object.entries(spec.keywords ?? {})) add(k, v);
  const stext = spec.stext ? textOf(Object.entries(spec.stext), delimiter) : '';
  // Offsets change the TEXT length: iterate to a fixed point.
  let primary = '';
  let layout = null;
  for (let pass = 0; pass < 6; pass += 1) {
    const textStart = 58;
    const textEnd = textStart + primary.length - 1;
    const stextStart = stext ? textEnd + 1 : 0;
    const stextEnd = stext ? stextStart + stext.length - 1 : 0;
    const dataStart = (stext ? stextEnd : textEnd) + 1;
    const dataEnd = data.length ? dataStart + data.length - 1 : 0;
    const total = dataStart + data.length;
    const fixed = [['$BEGINDATA', data.length ? dataStart : 0], ['$ENDDATA', dataEnd], ['$BEGINSTEXT', stextStart], ['$ENDSTEXT', stextEnd], ['$BEGINANALYSIS', 0], ['$ENDANALYSIS', 0]];
    const pairs = [...fixed, ...keywords.map(([k, v]) => (k === '$NEXTDATA' && chained ? [k, String(layout?.total ?? 0)] : [k, v]))];
    const next = textOf(pairs, delimiter);
    const same = next === primary;
    layout = { textStart, textEnd, stextStart, stextEnd, dataStart, dataEnd, total };
    primary = next;
    if (same) break;
  }
  const head = spec.version + '    ' + pad8(layout.textStart) + pad8(layout.textEnd)
    + (spec.headerOffsets === false || !data.length ? pad8(0) + pad8(0) : pad8(layout.dataStart) + pad8(layout.dataEnd)) + pad8(0) + pad8(0);
  const out = new Uint8Array(layout.total);
  out.set(encoder.encode(head), 0);
  out.set(encoder.encode(primary), layout.textStart);
  if (stext) out.set(encoder.encode(stext), layout.stextStart);
  out.set(data, layout.dataStart);
  return out;
}

// A file of several data sets chained by $NEXTDATA (each offset relative to its data set's start).
function buildChain(specs) {
  const parts = specs.map((spec, i) => buildDataset(spec, i < specs.length - 1));
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function rows(random, events, params) {
  return Array.from({ length: events }, () => params.map((p) => {
    const max = (p.type === 'I' || !p.type) && p.bits ? Math.min(2 ** Math.min(p.bits, 20) - 1, p.range ?? 1023) : 1000;
    return p.type === 'F' || p.type === 'D' ? random() * 1000 - 50 : Math.floor(random() * max);
  }));
}

// The seed files: every layout the reader decodes.
export function seedFiles() {
  const random = createRandom(20261003);
  const files = [];
  // Each seed keeps the values it holds as the reader should return them (scale values: $PnE and
  // $PnG undone, in float32), to check the seeds themselves.
  const expectedOf = (spec, events) => [spec.params.map((p, i) => events.map((row) => {
    const type = p.type ?? spec.datatype;
    const stored = type === 'F' || type === 'D' ? row[i] : Math.round(row[i]);
    const [decades, offset] = String(p.amp ?? '0,0').split(',').map(Number);
    if (decades > 0) return Math.fround(offset * 10 ** ((decades * stored) / (p.range ?? 1024)));
    return Math.fround(stored / (p.gain ?? 1));
  }))];
  const make = (name, spec) => {
    const params = spec.params;
    const events = rows(random, spec.events ?? 64, params.map((p) => ({ ...p, type: p.type ?? spec.datatype })));
    files.push({ name, bytes: buildDataset({ ...spec, events }), expected: expectedOf(spec, events) });
  };
  const named = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ name: ['FSC-A', 'SSC-A', 'FL1-A', 'FL2-A', 'FL3-A', 'Time'][i] ?? `P${i + 1}`, label: i === 2 ? 'CD3' : '', ...extra }));
  make('float-le', { version: 'FCS3.1', datatype: 'F', byteord: '1,2,3,4', params: named(4, { bits: 32, range: 262144 }) });
  make('float-be', { version: 'FCS3.0', datatype: 'F', byteord: '4,3,2,1', params: named(4, { bits: 32, range: 262144 }) });
  make('double', { version: 'FCS3.1', datatype: 'D', byteord: '1,2,3,4', params: named(3, { bits: 64, range: 262144 }) });
  make('int16-le', { version: 'FCS3.0', datatype: 'I', byteord: '1,2', params: named(5, { bits: 16, range: 1024 }) });
  make('int16-be', { version: 'FCS2.0', datatype: 'I', byteord: '2,1', params: named(4, { bits: 16, range: 4096 }) });
  make('int32-mixed', { version: 'FCS3.0', datatype: 'I', byteord: '3,4,1,2', params: named(3, { bits: 32, range: 262144 }) });
  make('int24', { version: 'FCS3.1', datatype: 'I', byteord: '1,2,3,4', params: named(3, { bits: 24, range: 262144 }) });
  make('int8', { version: 'FCS2.0', datatype: 'I', byteord: '1,2,3,4', params: named(3, { bits: 8, range: 256 }) });
  make('int64', { version: 'FCS3.2', datatype: 'I', byteord: '1,2,3,4', params: named(2, { bits: 64, range: 262144 }) });
  make('packed10', { version: 'FCS2.0', datatype: 'I', byteord: '1,2,3,4', params: named(3, { bits: 10, range: 1024 }) });
  make('ascii-fixed', { version: 'FCS2.0', datatype: 'A', byteord: '1,2,3,4', params: named(3, { bits: 5, range: 1024 }) });
  make('ascii-free', { version: 'FCS3.0', datatype: 'A', byteord: '1,2,3,4', ascii: 'free', params: named(3, { bits: '*', range: 1024 }) });
  make('mixed-types', { version: 'FCS3.2', datatype: 'I', byteord: '1,2,3,4', params: [{ name: 'FSC-A', bits: 32, type: 'I', range: 262144 }, { name: 'FL1-A', bits: 32, type: 'F', range: 262144 }, { name: 'FL2-A', bits: 64, type: 'D', range: 262144 }] });
  make('log-amp', { version: 'FCS2.0', datatype: 'I', byteord: '1,2', params: named(3, { bits: 16, range: 1024, amp: '4,1' }) });
  make('gain', { version: 'FCS3.1', datatype: 'F', byteord: '1,2,3,4', params: named(3, { bits: 32, range: 262144, gain: 2 }) });
  make('stext', { version: 'FCS3.1', datatype: 'F', byteord: '1,2,3,4', params: named(3, { bits: 32, range: 262144 }), stext: { '$CYT': 'Fuzz', 'EXTRA': 'value' } });
  make('keyword-offsets', { version: 'FCS3.1', datatype: 'F', byteord: '1,2,3,4', headerOffsets: false, params: named(3, { bits: 32, range: 262144 }) });
  make('spillover', { version: 'FCS3.1', datatype: 'F', byteord: '1,2,3,4', params: named(4, { bits: 32, range: 262144 }), keywords: { $SPILLOVER: '2,FL1-A,FL2-A,1,0.1,0.05,1', $CYT: 'LSRFortessa' } });
  make('pipe-delimiter', { version: 'FCS3.1', datatype: 'F', byteord: '1,2,3,4', delimiter: '|', params: named(3, { bits: 32, range: 262144 }), keywords: { $FIL: 'a/b.fcs' } });
  make('no-events', { version: 'FCS3.1', datatype: 'F', byteord: '1,2,3,4', events: 0, params: named(3, { bits: 32, range: 262144 }) });
  const chainSpec = (datatype, bits) => ({ version: 'FCS3.0', datatype, byteord: '1,2,3,4', params: named(3, { bits, range: 1024 }) });
  const chain = [chainSpec('F', 32), chainSpec('I', 16), chainSpec('F', 32)].map((spec) => ({ ...spec, events: rows(random, 40, spec.params.map((p) => ({ ...p, type: spec.datatype }))) }));
  files.push({ name: 'chain', bytes: buildChain(chain), expected: chain.flatMap((spec) => expectedOf(spec, spec.events)) });
  return files;
}

// --- Mutations ----------------------------------------------------------------------------------

const NUMERIC_KEYS = /^\$(PAR|TOT|NEXTDATA|BEGINDATA|ENDDATA|BEGINSTEXT|ENDSTEXT|BEGINANALYSIS|ENDANALYSIS|P\d+B|P\d+R|P\d+E|P\d+G|BYTEORD|TIMESTEP)$/;

function primaryText(bytes) {
  try {
    const header = readHeader(bytes, 0);
    if (header.textStart > 0 && header.textEnd > header.textStart && header.textEnd < bytes.length) return header;
  } catch { /* not readable */ }
  return null;
}

function replaceText(bytes, header, text, keepOffsets) {
  const encoded = encoder.encode(text);
  const before = bytes.subarray(0, header.textStart);
  const after = bytes.subarray(header.textEnd + 1);
  const out = new Uint8Array(before.length + encoded.length + after.length);
  out.set(before, 0);
  out.set(encoded, before.length);
  out.set(after, before.length + encoded.length);
  if (!keepOffsets) {
    // Shift HEADER offsets after TEXT by the change in length (keywords are left stale on purpose:
    // the reader must cope with HEADER and keywords that disagree).
    const delta = encoded.length - (header.textEnd - header.textStart + 1);
    const setField = (start, value) => out.set(encoder.encode(pad8(value)), start);
    setField(18, header.textStart + encoded.length - 1);
    if (header.dataStart) setField(26, header.dataStart + delta);
    if (header.dataEnd) setField(34, header.dataEnd + delta);
  }
  return out;
}

const pick = (random, list) => list[Math.floor(random() * list.length)];
const int = (random, n) => Math.floor(random() * n);

function numericVariant(random, value) {
  const n = Number.parseInt(value, 10);
  return String(pick(random, [
    0, -1, 1, n + 1, n - 1, 2 * n, Math.floor(n / 2), 2 ** 31, 2 ** 32 + 7, 2 ** 53, 1e15, -(2 ** 31),
    'abc', '', ' ', '1e3', '0x10', 'NaN', '3.5', `${n},${n}`, '9'.repeat(40),
  ]));
}

const MUTATORS = {
  // One keyword's value changed: numbers to boundary and nonsense values, text to odd text.
  keywordValue(random, bytes) {
    const header = primaryText(bytes);
    if (!header) return null;
    const text = new TextDecoder('latin1').decode(bytes.subarray(header.textStart, header.textEnd + 1));
    const pairs = parseTextSegment(text);
    if (!pairs.length) return null;
    const numeric = pairs.filter(([k]) => NUMERIC_KEYS.test(k.toUpperCase()));
    const target = numeric.length && random() < 0.8 ? pick(random, numeric) : pick(random, pairs);
    const value = NUMERIC_KEYS.test(target[0].toUpperCase())
      ? numericVariant(random, target[1])
      : pick(random, ['', ' ', 'x'.repeat(5000), 'éè', '\u0000', 'I', 'A', 'F', 'D', 'Z', '1,2', '4,3,2,1', '2,1,4,3', '0,0', '5,0', '*']);
    const mutated = pairs.map((p) => (p === target ? [p[0], value] : p));
    return replaceText(bytes, header, textOf(mutated, text[0]), random() < 0.3);
  },
  // A keyword removed, or duplicated with another value.
  keywordSet(random, bytes) {
    const header = primaryText(bytes);
    if (!header) return null;
    const text = new TextDecoder('latin1').decode(bytes.subarray(header.textStart, header.textEnd + 1));
    const pairs = parseTextSegment(text);
    if (!pairs.length) return null;
    const i = int(random, pairs.length);
    const mutated = random() < 0.5 ? pairs.filter((_, k) => k !== i) : [...pairs.slice(0, i), [pairs[i][0], numericVariant(random, pairs[i][1])], ...pairs.slice(i)];
    return replaceText(bytes, header, textOf(mutated, text[0]), random() < 0.3);
  },
  // TEXT punctuation broken: the delimiter changed, doubled, dropped or inserted.
  delimiter(random, bytes) {
    const header = primaryText(bytes);
    if (!header) return null;
    const out = bytes.slice();
    const at = header.textStart + int(random, header.textEnd - header.textStart + 1);
    out[at] = pick(random, [out[header.textStart], 0x00, 0x0c, 0x2f, 0x7c, 0x20, 0xff]);
    return out;
  },
  // A HEADER offset rewritten: zero, past the end, swapped, nonsense.
  headerOffset(random, bytes) {
    if (bytes.length < 58) return null;
    const out = bytes.slice();
    const field = pick(random, [10, 18, 26, 34, 42, 50]);
    const current = Number.parseInt(new TextDecoder().decode(out.subarray(field, field + 8)), 10) || 0;
    const value = pick(random, [0, 1, 57, 58, current + 1, current - 1, bytes.length, bytes.length + 100, 99999999, '-1', 'abcdefgh', '   1e3  ', current * 2]);
    out.set(encoder.encode(typeof value === 'number' ? pad8(value) : String(value).padStart(8, ' ').slice(0, 8)), field);
    return out;
  },
  // Random bytes flipped, anywhere.
  flip(random, bytes) {
    if (!bytes.length) return null;
    const out = bytes.slice();
    const n = 1 + int(random, 8);
    for (let k = 0; k < n; k += 1) out[int(random, out.length)] = int(random, 256);
    return out;
  },
  // The version line changed.
  version(random, bytes) {
    if (bytes.length < 6) return null;
    const out = bytes.slice();
    out.set(encoder.encode(pick(random, ['FCS1.0', 'FCS2.0', 'FCS3.0', 'FCS3.1', 'FCS3.2', 'FCS4.0', 'FCS9.9', 'fcs3.1', 'FCS3,1'])), 0);
    return out;
  },
  // Cut short anywhere, or extended with junk.
  truncate(random, bytes) {
    if (random() < 0.8) return bytes.slice(0, int(random, bytes.length));
    const extra = new Uint8Array(1 + int(random, 64));
    for (let k = 0; k < extra.length; k += 1) extra[k] = int(random, 256);
    const out = new Uint8Array(bytes.length + extra.length);
    out.set(bytes);
    out.set(extra, bytes.length);
    return out;
  },
};

const MUTATOR_NAMES = Object.keys(MUTATORS);

// A mutated file: one to three mutations of a seed, chosen by `seed`.
export function mutate(seedBytes, seed) {
  const random = createRandom(seed);
  let bytes = seedBytes;
  const applied = [];
  const n = 1 + int(random, 3);
  for (let k = 0; k < n; k += 1) {
    const name = pick(random, MUTATOR_NAMES);
    const next = MUTATORS[name](random, bytes);
    if (next) {
      bytes = next;
      applied.push(name);
    }
  }
  return { bytes, applied };
}

// --- The oracle ---------------------------------------------------------------------------------

class Outsized extends Error {}

// Runs one file through the reader as the app does (parseFCSAsync, then the sample record and the
// de-identification's header pass), and through parseFCS. Returns { outcome: 'read' | 'refused',
// problem: string | null, ms }.
export async function examine(bytes) {
  const started = performance.now();
  // No column may be larger than the file could hold, with room for ASCII and packed data.
  const limit = Math.max(4096, bytes.length * 8 + 1024);
  const allocate = (n) => {
    if (!(n >= 0) || n > limit) throw new Outsized(`asked for a column of ${n} values from a ${bytes.length}-byte file`);
    return new Float32Array(n);
  };
  const outcome = {};
  for (const [label, run] of [
    ['parseFCS', async () => parseFCS(bytes, { allocate })],
    ['parseFCSAsync', async () => parseFCSAsync(bytesSource(bytes), { allocate, chunkSize: 4096 })],
  ]) {
    try {
      const result = await run();
      const problem = consistency(result);
      if (problem) return { outcome: 'read', problem: `${label}: ${problem}`, ms: performance.now() - started };
      for (const [k, dataset] of result.datasets.entries()) sampleFromDataset(dataset, { name: 'fuzz.fcs', datasetIndex: k });
      outcome[label] = { read: true, events: result.datasets.map((d) => d.eventCount).join(',') };
    } catch (error) {
      if (error instanceof Outsized) return { outcome: 'error', problem: `${label}: ${error.message}`, ms: performance.now() - started };
      if (!(error instanceof FCSError)) return { outcome: 'error', problem: `${label}: ${error.constructor.name}: ${error.message}`, ms: performance.now() - started };
      // Values quoted from the file may say anything; the message's own words must not.
      if (!error.message || /undefined|NaN|\[object/.test(error.message.replace(/"[^"]*"/g, ''))) return { outcome: 'refused', problem: `${label}: unclear message "${error.message}"`, ms: performance.now() - started };
      outcome[label] = { read: false, message: error.message };
    }
  }
  try {
    deidentifyFCS(bytes);
  } catch (error) {
    if (!(error instanceof FCSError)) return { outcome: 'error', problem: `deidentifyFCS: ${error.constructor.name}: ${error.message}`, ms: performance.now() - started };
  }
  const a = outcome.parseFCS;
  const b = outcome.parseFCSAsync;
  // The two paths must agree on whether the file opens and on how many events each data set has.
  // (The streaming path reads only the first data set when it reads in parts; parseFCS reads all.)
  if (a.read !== b.read) return { outcome: a.read ? 'read' : 'refused', problem: `parseFCS ${a.read ? 'reads' : `refuses ("${a.message}")`} but parseFCSAsync ${b.read ? 'reads' : `refuses ("${b.message}")`}`, ms: performance.now() - started };
  if (a.read && a.events.split(',')[0] !== b.events.split(',')[0]) return { outcome: 'read', problem: `parseFCS reads ${a.events} events, parseFCSAsync ${b.events}`, ms: performance.now() - started };
  return { outcome: a.read ? 'read' : 'refused', problem: null, ms: performance.now() - started };
}

function consistency(result) {
  if (!result || !Array.isArray(result.datasets) || !result.datasets.length) return 'no data sets';
  for (const [k, d] of result.datasets.entries()) {
    if (!Number.isInteger(d.eventCount) || d.eventCount < 0) return `data set ${k}: event count ${d.eventCount}`;
    if (d.data.length !== d.parameters.length) return `data set ${k}: ${d.data.length} columns for ${d.parameters.length} parameters`;
    for (const column of d.data) if (column.length !== d.eventCount) return `data set ${k}: a column of ${column.length} values for ${d.eventCount} events`;
    for (const x of d.diagnostics) if (!x || typeof x.message !== 'string' || !x.level) return `data set ${k}: a malformed diagnostic`;
  }
  return null;
}

// The FCS and LMD files of downloaded validation data sets, up to `maxBytes` each, as { name, path };
// data sets not downloaded are skipped.
export const CORPUS = ['fcsparser', 'flowkit', 'rpackages', 'cytoflow-instruments', 'flowio', 'flowcal', 'zenodo-instruments', 'zenodo-nanofcm', 'rosettax'];

export function corpusFiles(ids = CORPUS, maxBytes = 4 * 1024 * 1024) {
  const sources = JSON.parse(readFileSync(new URL('./sources.json', import.meta.url), 'utf8'));
  const out = [];
  for (const id of ids) {
    const set = sources.datasets[id];
    if (!set) continue;
    for (const f of set.files) {
      if (!/\.(fcs|lmd)$/i.test(f.path) || f.size > maxBytes) continue;
      const path = join(fileURLToPath(new URL('./cache/', import.meta.url)), id, f.path);
      if (existsSync(path) && statSync(path).size === f.size) out.push({ name: `${id}/${f.path}`, path });
    }
  }
  return out;
}

// Corpus files (real instruments' files from the validation data) as further seeds, as
// { name, path }: read in the worker, so only paths cross over.
function loadFiles(corpus) {
  return [...seedFiles(), ...corpus.map((c) => ({ name: c.name, bytes: new Uint8Array(readFileSync(c.path)) }))];
}

// The worker: examines the cases it is sent, one at a time.
if (!isMainThread && workerData?.fuzzWorker) {
  const files = loadFiles(workerData.corpus);
  parentPort.on('message', async ({ index, seed }) => {
    const file = files[index % files.length];
    const { bytes, applied } = mutate(file.bytes, seed);
    parentPort.postMessage({ file: file.name, applied, ...(await examine(bytes)) });
  });
}

// The seed of case `index` of a run seeded with `seed`.
export const caseSeed = (seed, index) => (seed * 1000003 + index) >>> 0;

// Runs `count` cases from `seed` over the seed files and the corpus files, each in a worker that is
// replaced when a case takes longer than `timeoutMs` (a hang). Returns a summary with the failures,
// each replayable from its file and case seed (fuzz.mjs --replay).
export async function fuzz({ seed = 1, count = 2000, corpus = [], timeoutMs = 5000, slowMs = 1000 } = {}) {
  const files = loadFiles(corpus);
  const failures = [];
  // The generated seeds must read cleanly (some corpus files are malformed on purpose).
  for (const file of files.slice(0, seedFiles().length)) {
    const result = await examine(file.bytes);
    if (result.problem || result.outcome !== 'read') failures.push({ file: file.name, seed: null, applied: [], problem: result.problem ?? 'the seed file is refused' });
  }
  let worker = null;
  const spawn = () => { worker = new Worker(new URL(import.meta.url), { workerData: { fuzzWorker: true, corpus } }); };
  spawn();
  let read = 0;
  let refused = 0;
  let slowest = 0;
  let slowestCase = '';
  try {
    for (let index = 0; index < count; index += 1) {
      const s = caseSeed(seed, index);
      const file = files[index % files.length];
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.removeAllListeners();
          worker.terminate();
          spawn();
          resolve({ file: file.name, applied: mutate(file.bytes, s).applied, outcome: 'hang', problem: `no answer within ${timeoutMs / 1000} s (a hang)`, ms: timeoutMs });
        }, timeoutMs);
        worker.once('message', (message) => { clearTimeout(timer); worker.removeAllListeners('error'); resolve(message); });
        worker.once('error', (error) => { clearTimeout(timer); reject(error); });
        worker.postMessage({ index, seed: s });
      });
      if (result.outcome === 'read') read += 1;
      else if (result.outcome === 'refused') refused += 1;
      if (result.ms > slowest) { slowest = result.ms; slowestCase = `${result.file} #${s}`; }
      if (result.problem) failures.push({ file: result.file, seed: s, applied: result.applied, problem: result.problem });
      else if (result.ms > slowMs) failures.push({ file: result.file, seed: s, applied: result.applied, problem: `took ${result.ms.toFixed(0)} ms` });
    }
  } finally {
    await worker.terminate();
  }
  return { count, files: files.length, read, refused, failures, slowest, slowestCase };
}

// One case again, for a failure's file and case seed.
export async function replay(fileName, seed, corpus = []) {
  const file = loadFiles(corpus).find((f) => f.name === fileName);
  if (!file) throw new Error(`No seed file ${fileName}.`);
  const { bytes, applied } = mutate(file.bytes, seed);
  return { bytes, applied, result: await examine(bytes) };
}
