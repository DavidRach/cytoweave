// FCS 2.0, 3.0, 3.1 and 3.2 reader and an FCS 3.1 writer.
//
// The reader is strict about what the standard says and forgiving about what instruments write:
// every deviation it tolerates (offsets off by one, empty keyword values, a DATA segment named
// only by $BEGINDATA, masked integer bits, a missing $TOT) is recorded as a diagnostic so the
// user can see what was inferred. Events are decoded into one Float32Array per parameter
// (column-major), with $PnE log amplification and $PnG gain undone, i.e. "scale" values.

export const FCS_VERSIONS = ['FCS2.0', 'FCS3.0', 'FCS3.1', 'FCS3.2'];

export class FCSError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'FCSError';
    this.code = code;
  }
}

const textDecoderUTF8 = new TextDecoder('utf-8', { fatal: true });

// ISO-8859-1 maps each byte to the code point of the same value. (TextDecoder's 'latin1' label is
// windows-1252, which remaps 0x80–0x9F.)
function decodeLatin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return out;
}
const textDecoderLatin1 = { decode: decodeLatin1 };

function decodeText(bytes) {
  try {
    return { text: textDecoderUTF8.decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: decodeLatin1(bytes), encoding: 'latin1' };
  }
}

function asciiField(bytes, start, end) {
  let out = '';
  for (let i = start; i < end && i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  return out.trim();
}

// Reads the 58-byte HEADER (and any further segment offsets) at byte `base`.
export function readHeader(bytes, base = 0) {
  if (bytes.length < base + 58) throw new FCSError('The file is too short to be an FCS file.', 'not-fcs');
  const version = asciiField(bytes, base, base + 6);
  if (!/^FCS\d\.\d$/.test(version)) throw new FCSError(`Not an FCS file (starts with "${asciiField(bytes, base, base + 6)}").`, 'not-fcs');
  const field = (start) => {
    const raw = asciiField(bytes, base + start, base + start + 8);
    if (raw === '') return 0;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };
  return {
    version,
    textStart: field(10),
    textEnd: field(18),
    dataStart: field(26),
    dataEnd: field(34),
    analysisStart: field(42),
    analysisEnd: field(50),
  };
}

// Splits a TEXT segment into [key, value] pairs. With `emptyValues`, a doubled delimiter is an
// empty value rather than an escaped delimiter (some instruments write empty values).
export function parseTextSegment(text, options = {}) {
  const pairs = [];
  if (!text.length) return pairs;
  const delimiter = text[0];
  const tokens = [];
  let current = '';
  let i = 1;
  while (i < text.length) {
    // Copy up to the next delimiter in one piece (a long TEXT segment, a character at a time, is slow).
    const next = text.indexOf(delimiter, i);
    if (next < 0) {
      current += text.slice(i);
      break;
    }
    if (next > i) {
      current += text.slice(i, next);
      i = next;
    }
    const ch = text[i];
    if (ch === delimiter) {
      if (!options.emptyValues && text[i + 1] === delimiter && i + 1 < text.length - 1) {
        current += delimiter;
        i += 2;
        continue;
      }
      tokens.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.length) tokens.push(current);
  for (let t = 0; t + 1 < tokens.length; t += 2) pairs.push([tokens[t], tokens[t + 1]]);
  if (tokens.length % 2 === 1 && tokens[tokens.length - 1].trim() !== '') pairs.push([tokens[tokens.length - 1], '']);
  return pairs;
}

// Keyword–value pairs of a supplemental TEXT segment, which uses the primary TEXT's delimiter (some
// writers leave out its leading delimiter); null when it holds something else (instrument settings,
// a ZIP archive), as some writers put there.
function supplementalPairs(extra, delimiter) {
  const text = extra.startsWith(delimiter) ? extra : delimiter + extra;
  const pairs = parseTextSegment(text);
  const plausible = (key) => /^[\x20-\x7e]{1,128}$/.test(key) && key.trim() !== '';
  return pairs.length && pairs.every(([key]) => plausible(key)) ? pairs : null;
}

// Scores a keyword parse: parameter keywords that agree with $PAR, standard keys that look right.
// A keyword name holding the delimiter is suspicious: values may contain an escaped delimiter, but
// a name that does is two keywords run together by an empty value read as an escape.
function scorePairs(pairs, delimiter) {
  const keys = new Map();
  for (const [key, value] of pairs) keys.set(key.trim().toUpperCase(), value);
  const par = Number.parseInt(keys.get('$PAR') ?? '', 10);
  let score = 0;
  if (Number.isFinite(par) && par > 0) {
    score += 5;
    for (let n = 1; n <= Math.min(par, pairs.length); n += 1) {
      if (keys.has(`$P${n}N`)) score += 2;
      if (keys.has(`$P${n}B`)) score += 1;
      if (keys.has(`$P${n}R`)) score += 1;
    }
  }
  for (const key of ['$TOT', '$DATATYPE', '$BYTEORD', '$MODE', '$NEXTDATA', '$BEGINDATA']) if (keys.has(key)) score += 1;
  let suspicious = 0;
  for (const [key] of pairs) {
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > 128 || /[\x00-\x08]/.test(trimmed) || trimmed.includes(delimiter)) suspicious += 1;
  }
  return score - 3 * suspicious;
}

function chooseTextParse(text, diagnostics) {
  const standard = parseTextSegment(text);
  if (!text.length) return standard;
  const delimiter = text[0];
  if (!text.includes(delimiter + delimiter, 1)) return standard;
  const lenient = parseTextSegment(text, { emptyValues: true });
  if (scorePairs(lenient, delimiter) > scorePairs(standard, delimiter)) {
    diagnostics.push({ level: 'warning', code: 'empty-values', message: 'Doubled delimiters were read as empty keyword values (not allowed by the standard, but some instruments write them).' });
    return lenient;
  }
  return standard;
}

function keywordMap(pairs) {
  const map = Object.create(null);
  for (const [key, value] of pairs) {
    const upper = key.trim().toUpperCase();
    if (!(upper in map)) map[upper] = value;
  }
  return map;
}

// A keyword's value for a message: quoted, shortened, or "missing".
function quoted(value) {
  if (value === undefined) return 'missing';
  const text = String(value).trim();
  return `"${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`;
}

function intKeyword(keywords, key) {
  const raw = keywords[key];
  if (raw === undefined) return undefined;
  const value = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(value) ? value : undefined;
}

function floatKeyword(keywords, key) {
  const raw = keywords[key];
  if (raw === undefined) return undefined;
  const value = Number.parseFloat(String(raw).trim());
  return Number.isFinite(value) ? value : undefined;
}

// Byte order as a permutation: "1,2,3,4" little-endian, "4,3,2,1" big-endian, others mixed.
export function parseByteOrder(value) {
  const order = String(value ?? '1,2,3,4').split(/[,\s]+/).filter(Boolean).map((part) => Number.parseInt(part, 10) - 1);
  if (!order.length || order.some((n) => !Number.isInteger(n) || n < 0)) return { order: [0, 1, 2, 3], little: true, big: false };
  const little = order.every((n, i) => n === i);
  const big = order.every((n, i) => n === order.length - 1 - i);
  return { order, little, big };
}

const SCATTER_PATTERN = /^(FSC|SSC|FS|SS|FALS|SALS|LALS|WALS|EV|EXT|SSC-B|VSSC|BSSC|FSC-W|SSC-W|FSC-H|SSC-H)(\b|[-_ ])/i;
const TIME_PATTERN = /^(time|hdr-t|time\s*\(.*\)|time[-_ ]?lsw|time[-_ ]?msw)$/i;
const CYTOF_META = /^(event_length|center|offset|width|residual|beadDist|cell_length|time)$/i;

export function classifyChannel(name, label = '') {
  const trimmed = String(name).trim();
  if (TIME_PATTERN.test(trimmed)) return 'time';
  if (SCATTER_PATTERN.test(trimmed) || /^(FSC|SSC)/i.test(trimmed)) return 'scatter';
  if (CYTOF_META.test(trimmed)) return 'instrument';
  if (/^(event\s*#?|event_?count|eventnumber|sort.?(class|well|index)|index|well|tray|plate)/i.test(trimmed)) return 'instrument';
  if (/^(fsc|ssc)/i.test(String(label))) return 'scatter';
  return 'fluorescence';
}

// A marker name from $PnS (e.g. "CD3", "CD3 BV421", "176Yb_CD56"), or '' when none.
export function markerFromLabel(label, name = '') {
  let text = String(label ?? '').trim();
  if (!text || text === name) return '';
  text = text.replace(/^\d{2,3}[A-Z][a-z]?[_ -]/, ''); // CyTOF isotope prefix, e.g. 176Yb_
  text = text.replace(/^[A-Z][a-z]?\d{2,3}[_ -]/, '');
  return text.trim();
}

function decodeParameters(keywords, par, diagnostics) {
  const parameters = [];
  for (let n = 1; n <= par; n += 1) {
    const name = (keywords[`$P${n}N`] ?? `P${n}`).trim();
    const label = (keywords[`$P${n}S`] ?? '').trim();
    const bitsRaw = (keywords[`$P${n}B`] ?? '').trim();
    const bits = bitsRaw === '*' ? '*' : Number.parseInt(bitsRaw, 10);
    const range = floatKeyword(keywords, `$P${n}R`) ?? 0;
    let amp = [0, 0];
    const ampRaw = keywords[`$P${n}E`];
    if (ampRaw !== undefined) {
      const parts = String(ampRaw).split(',').map((part) => Number.parseFloat(part));
      if (parts.length >= 2 && parts.every(Number.isFinite)) amp = [parts[0], parts[1]];
    }
    if (amp[0] > 0 && amp[1] === 0) {
      diagnostics.push({ level: 'info', code: 'log-offset', message: `$P${n}E is "${ampRaw}": the offset 0 was read as 1, as earlier FCS versions intended.` });
      amp = [amp[0], 1];
    }
    const gain = floatKeyword(keywords, `$P${n}G`) ?? 1;
    const datatype = (keywords[`$P${n}DATATYPE`] ?? '').trim().toUpperCase() || null;
    const display = (keywords[`$P${n}D`] ?? '').trim();
    const type = classifyChannel(name, label);
    parameters.push({
      index: n - 1,
      name,
      label,
      marker: markerFromLabel(label, name),
      bits,
      range,
      amp,
      gain: gain > 0 ? gain : 1,
      datatype,
      display,
      type: (keywords[`$P${n}TYPE`] ?? '').trim() ? normalizeType(keywords[`$P${n}TYPE`], type) : type,
      filter: (keywords[`$P${n}F`] ?? '').trim(),
      wavelength: floatKeyword(keywords, `$P${n}L`) ?? null,
      detector: (keywords[`$P${n}DET`] ?? keywords[`$P${n}T`] ?? '').trim(),
      voltage: floatKeyword(keywords, `$P${n}V`) ?? null,
      analyte: (keywords[`$P${n}ANALYTE`] ?? '').trim(),
      tag: (keywords[`$P${n}TAG`] ?? '').trim(),
      feature: (keywords[`$P${n}FEATURE`] ?? '').trim(),
      calibration: (keywords[`$P${n}CALIBRATION`] ?? '').trim(),
    });
  }
  return parameters;
}

// FCS 3.2 $PnTYPE values mapped onto CytoWeave's channel types.
function normalizeType(value, fallback) {
  const lower = String(value).trim().toLowerCase();
  if (lower.includes('scatter')) return 'scatter';
  if (lower === 'time') return 'time';
  if (lower.includes('fluorescence') || lower.includes('mass') || lower.includes('raw_fluorescence') || lower.includes('unmixed')) return 'fluorescence';
  if (lower.includes('index') || lower.includes('classification') || lower.includes('electronic')) return 'instrument';
  return fallback;
}

function bytesPerValue(datatype, bits) {
  if (datatype === 'F') return 4;
  if (datatype === 'D') return 8;
  if (datatype === 'I') return bits / 8;
  return 0;
}

function readValue(view, offset, datatype, bytes, byteOrder) {
  const little = byteOrder.little;
  if (datatype === 'F') return view.getFloat32(offset, little);
  if (datatype === 'D') return view.getFloat64(offset, little);
  switch (bytes) {
    case 1: return view.getUint8(offset);
    case 2: return view.getUint16(offset, little);
    case 4: return view.getUint32(offset, little);
    case 8: return Number(view.getBigUint64(offset, little));
    case 3: return little
      ? view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
      : (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
    default: {
      let value = 0;
      for (let b = 0; b < bytes; b += 1) {
        const byte = view.getUint8(offset + (little ? bytes - 1 - b : b));
        value = value * 256 + byte;
      }
      return value;
    }
  }
}

// A permuted (mixed-endian) value: reorders the bytes into little-endian, then reads.
function readPermuted(bytes, offset, datatype, width, order) {
  const scratch = new Uint8Array(width);
  for (let b = 0; b < width; b += 1) scratch[order[b] ?? b] = bytes[offset + b];
  const view = new DataView(scratch.buffer);
  return readValue(view, 0, datatype, width, { little: true });
}

// How the events of a DATA segment are laid out: each parameter's type, byte width, offset within
// the event and integer mask. ASCII and packed data have no fixed layout ({ kind } only).
function dataPlan(keywords, parameters) {
  const globalType = (keywords.$DATATYPE ?? 'F').trim().toUpperCase();
  const byteOrder = parseByteOrder(keywords.$BYTEORD);
  const types = parameters.map((p) => p.datatype ?? globalType);
  if (types.some((type) => !['I', 'F', 'D', 'A'].includes(type))) throw new FCSError(`Unsupported $DATATYPE ${globalType}.`, 'unsupported');
  if (types.includes('A')) return { kind: 'ascii', types, byteOrder };
  const widths = parameters.map((p, i) => {
    if (types[i] === 'F') return 4;
    if (types[i] === 'D') return 8;
    const bits = p.bits;
    if (!Number.isInteger(bits) || bits <= 0 || bits > 64) throw new FCSError(`$P${i + 1}B is not a bit width (${quoted(keywords[`$P${i + 1}B`])}): integers take 1 to 64 bits.`);
    if (bits % 8 !== 0) return -bits;
    return bytesPerValue('I', bits);
  });
  if (widths.some((w) => w < 0)) return { kind: 'packed', types, byteOrder };
  // Integer masks: bits above $PnR (rounded up to a power of two) hold flags on some instruments.
  const masks = parameters.map((p, i) => {
    if (types[i] !== 'I' || !(p.range > 0)) return 0;
    const bits = widths[i] * 8;
    const needBits = Math.ceil(Math.log2(p.range));
    if (needBits >= bits || needBits >= 53) return 0;
    return 2 ** needBits - 1;
  });
  const offsets = [];
  let eventBytes = 0;
  for (const w of widths) {
    offsets.push(eventBytes);
    eventBytes += w;
  }
  const permuted = !byteOrder.little && !byteOrder.big;
  // Little-endian float32 events can be read through a Float32Array on this (little-endian) machine.
  const floatLE = byteOrder.little && types.every((t) => t === 'F') && LITTLE_ENDIAN;
  return { kind: 'binary', types, widths, offsets, masks, eventBytes, byteOrder, permuted, floatLE };
}

const LITTLE_ENDIAN = new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;
const ALIGN_BLOCK = 1 << 20;

// Decodes `count` whole events starting at bytes[start] into columns[·][first …]. Returns the number
// of integer values whose bits above $PnR were masked.
function decodeEvents(bytes, start, first, count, columns, plan) {
  const p = columns.length;
  if (plan.floatLE) {
    const absolute = bytes.byteOffset + start;
    if (absolute % 4 === 0) {
      deinterleave(new Float32Array(bytes.buffer, absolute, count * p), first, count, columns);
    } else {
      // Unaligned: copy blocks of whole events to an aligned buffer first.
      const perBlock = Math.max(1, Math.floor(ALIGN_BLOCK / plan.eventBytes));
      const scratch = new Uint8Array(perBlock * plan.eventBytes);
      for (let done = 0; done < count; done += perBlock) {
        const n = Math.min(perBlock, count - done);
        scratch.set(bytes.subarray(start + done * plan.eventBytes, start + (done + n) * plan.eventBytes));
        deinterleave(new Float32Array(scratch.buffer, 0, n * p), first + done, n, columns);
      }
    }
    return 0;
  }
  const { types, widths, offsets, masks, eventBytes, byteOrder, permuted } = plan;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let masked = 0;
  for (let e = 0; e < count; e += 1) {
    const base = start + e * eventBytes;
    for (let i = 0; i < p; i += 1) {
      const offset = base + offsets[i];
      let value = permuted
        ? readPermuted(bytes, offset, types[i], widths[i], byteOrder.order)
        : readValue(view, offset, types[i], widths[i], byteOrder);
      if (masks[i] && value > masks[i]) {
        value = masks[i] <= 0x7fffffff ? value & masks[i] : value % (masks[i] + 1);
        masked += 1;
      }
      columns[i][first + e] = value;
    }
  }
  return masked;
}

function deinterleave(values, first, count, columns) {
  const p = columns.length;
  for (let i = 0; i < p; i += 1) {
    const column = columns[i];
    for (let e = 0, k = i; e < count; e += 1, k += p) column[first + e] = values[k];
  }
}

function maskedDiagnostic(masked) {
  return { level: 'info', code: 'masked-bits', message: `${masked} integer values had bits above $PnR set; they were masked as the standard describes.` };
}

// The most events ASCII or packed data of `length` bytes can hold (binary data is checked in
// parseLayout): fixed-width ASCII and packed events have a known size; free-format ASCII needs at
// least a digit and a separator per value.
function textOrPackedLimit(plan, parameters, length) {
  if (plan.kind === 'packed') return Math.floor((length * 8) / parameters.reduce((sum, p) => sum + p.bits, 0));
  const fixed = parameters.every((p) => Number.isFinite(p.bits) && p.bits > 0);
  if (fixed) return Math.floor(length / parameters.reduce((sum, p) => sum + p.bits, 0));
  return Math.ceil((length + 1) / (2 * parameters.length));
}

function decodeData(bytes, start, end, keywords, parameters, eventCount, diagnostics, allocate = (n) => new Float32Array(n)) {
  const plan = dataPlan(keywords, parameters);
  if (plan.kind !== 'binary') {
    const limit = Math.max(0, textOrPackedLimit(plan, parameters, Math.max(0, Math.min(end, bytes.length - 1) - start + 1)));
    if (eventCount > limit) {
      diagnostics.push({ level: 'error', code: 'truncated', message: `$TOT says ${eventCount} events but the DATA segment can hold at most ${limit}; only those were read.` });
      eventCount = limit;
    }
  }
  const columns = parameters.map(() => allocate(eventCount));
  if (plan.kind === 'ascii') return decodeASCII(bytes, start, end, parameters, eventCount, columns, diagnostics);
  if (plan.kind === 'packed') return decodePacked(bytes, start, parameters, eventCount, columns, plan.byteOrder, diagnostics);
  const available = end - start + 1;
  const needed = plan.eventBytes * eventCount;
  if (available < needed) throw new FCSError(`The DATA segment holds ${available} bytes but ${eventCount} events need ${needed}; the file is truncated.`, 'truncated');
  if (plan.permuted) diagnostics.push({ level: 'info', code: 'byte-order', message: `Mixed byte order ${keywords.$BYTEORD} was decoded.` });
  const masked = decodeEvents(bytes, start, 0, eventCount, columns, plan);
  if (masked) diagnostics.push(maskedDiagnostic(masked));
  return columns;
}

// Bit widths that are not whole bytes (FCS 2.0 packed data): values are packed most-significant bit first.
function decodePacked(bytes, start, parameters, eventCount, columns, byteOrder, diagnostics) {
  diagnostics.push({ level: 'info', code: 'packed', message: 'Packed integer data (bit widths that are not whole bytes) was decoded.' });
  let bitOffset = start * 8;
  for (let e = 0; e < eventCount; e += 1) {
    for (let i = 0; i < parameters.length; i += 1) {
      const bits = parameters[i].bits;
      let value = 0;
      for (let b = 0; b < bits; b += 1) {
        const byte = bytes[(bitOffset >> 3)];
        const bit = (byte >> (7 - (bitOffset & 7))) & 1;
        value = value * 2 + bit;
        bitOffset += 1;
      }
      columns[i][e] = value;
    }
  }
  return columns;
}

function decodeASCII(bytes, start, end, parameters, eventCount, columns, diagnostics) {
  const text = textDecoderLatin1.decode(bytes.subarray(start, end + 1));
  const fixed = parameters.every((p) => Number.isFinite(p.bits) && p.bits > 0);
  if (fixed) {
    let pos = 0;
    for (let e = 0; e < eventCount; e += 1) {
      for (let i = 0; i < parameters.length; i += 1) {
        const width = parameters[i].bits;
        columns[i][e] = Number.parseFloat(text.slice(pos, pos + width));
        pos += width;
      }
    }
  } else {
    const values = text.split(/[\s,]+/).filter(Boolean);
    const p = parameters.length;
    for (let e = 0; e < eventCount; e += 1) {
      for (let i = 0; i < p; i += 1) columns[i][e] = Number.parseFloat(values[e * p + i]);
    }
  }
  diagnostics.push({ level: 'info', code: 'ascii', message: 'ASCII data was decoded.' });
  return columns;
}

// Converts channel values to scale values: $PnE log amplification, then $PnG gain for linear data.
function linearize(columns, parameters, diagnostics, types = []) {
  for (const param of parameters) {
    const column = columns[param.index];
    const [decades, offset] = param.amp;
    if (decades > 0 && (types[param.index] === 'F' || types[param.index] === 'D') && column.every((v) => !(v > decades))) {
      // FCS 3.1 requires $PnE 0,0 for floating-point data, but some instruments (Guava Muse) store
      // log10 of the value with $PnE giving the decades: values within 0–decades, which 10^x
      // restores. Their $PnG is that of the matching linear channel, which they then equal.
      const scale = param.gain > 0 ? offset / param.gain : offset;
      for (let e = 0; e < column.length; e += 1) column[e] = scale * 10 ** column[e];
      param.logAmplified = true;
      param.gainApplied = param.gain !== 1;
      diagnostics.push({ level: 'info', code: 'log-decades', message: `${param.name}: floating-point values with $P${param.index + 1}E "${decades},${offset}" lie within 0–${decades}, so they were read as decades (log10) and converted to linear${param.gain !== 1 ? `, with the gain ${param.gain} applied` : ''}.` });
    } else if (decades > 0) {
      const range = param.range > 0 ? param.range : 2 ** (Number.isFinite(param.bits) ? param.bits : 10);
      const factor = decades / range;
      for (let e = 0; e < column.length; e += 1) column[e] = offset * 10 ** (factor * column[e]);
      param.logAmplified = true;
      diagnostics.push({ level: 'info', code: 'log-amp', message: `${param.name}: log-amplified channel values were converted to linear (${decades} decades).` });
    } else if (param.gain !== 1 && param.type !== 'time') {
      const inv = 1 / param.gain;
      for (let e = 0; e < column.length; e += 1) column[e] *= inv;
      param.gainApplied = true;
    }
  }
}

// CRC-16-CCITT (polynomial 0x1021, initial 0), as FCS 3.1 specifies; `crc` continues a previous
// part.
const CRC_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let n = 0; n < 256; n += 1) {
    let crc = n << 8;
    for (let b = 0; b < 8; b += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    table[n] = crc;
  }
  return table;
})();

function crc16(bytes, start, end, crc = 0) {
  for (let i = start; i < end; i += 1) crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >>> 8) ^ bytes[i]) & 0xff];
  return crc;
}

function resolveDataOffsets(header, keywords, eventBytes, eventCount, base, fileLength, diagnostics) {
  let start = header.dataStart;
  let end = header.dataEnd;
  let kStart = intKeyword(keywords, '$BEGINDATA');
  let kEnd = intKeyword(keywords, '$ENDDATA');
  // Offsets that cannot be right (negative, or an end before the start) are ignored.
  if (kStart !== undefined && (kStart < 0 || kEnd === undefined || kEnd < kStart)) {
    diagnostics.push({ level: 'warning', code: 'offset-invalid', message: `$BEGINDATA and $ENDDATA (${quoted(keywords.$BEGINDATA)}, ${quoted(keywords.$ENDDATA)}) are not a valid range; the HEADER's offsets were used.` });
    kStart = undefined;
    kEnd = undefined;
  }
  if ((start === 0 || end === 0) && kStart !== undefined && kEnd !== undefined) {
    start = kStart;
    end = kEnd;
  } else if (kStart !== undefined && kEnd !== undefined && (kStart !== start || kEnd !== end) && kEnd > 0) {
    // The HEADER and the keywords disagree. A range is possible if it lies outside the primary TEXT,
    // within the file and holds the events (allowing the common off-by-one). When only one is
    // possible it is used; when both are, the keywords, unless only the HEADER's puts DATA directly
    // after the TEXT, as writers do (keywords written before the TEXT grew: BD Accuri C6, Beckman
    // Coulter CyAn).
    const needed = eventBytes > 0 && eventCount > 0 ? eventBytes * eventCount : 0;
    const possible = (s, e) => s > 0 && e >= s && (s > header.textEnd || e < header.textStart) && base + e <= fileLength && e - s + 2 >= needed;
    const headerOk = possible(start, end);
    const keywordsOk = possible(kStart, kEnd);
    const useHeader = headerOk && (!keywordsOk || (start === header.textEnd + 1 && kStart !== header.textEnd + 1));
    diagnostics.push({ level: 'warning', code: 'offset-mismatch', message: `The HEADER gives DATA at ${start}–${end} but $BEGINDATA/$ENDDATA give ${kStart}–${kEnd}; ${useHeader ? `the HEADER's offsets were used${keywordsOk ? ', which place DATA directly after the TEXT segment' : ', since the keywords\' range cannot hold the data'}` : 'the keywords were used'}.` });
    if (!useHeader) {
      start = kStart;
      end = kEnd;
    }
  }
  if (eventBytes > 0 && eventCount > 0) {
    const needed = eventBytes * eventCount;
    const length = end - start + 1;
    if (length === needed + 1) {
      diagnostics.push({ level: 'info', code: 'end-offset', message: 'The DATA end offset points one byte past the data (a common off-by-one); it was corrected.' });
      end -= 1;
    } else if (length === needed - 1 && base + end + 1 < fileLength) {
      diagnostics.push({ level: 'info', code: 'end-offset', message: 'The DATA end offset stops one byte short of the data (a common off-by-one); it was corrected.' });
      end += 1;
    }
  }
  if (!(start >= 0) || !(end >= 0) || (end < start && eventCount > 0)) throw new FCSError(`The file does not locate its DATA segment: the HEADER and keywords give no valid byte range (${start}–${end}).`);
  return { start: base + start, end: base + end };
}

// A data set's HEADER and TEXT: its keywords, parameters, DATA offsets and event count. `get(start,
// end)` returns the file's bytes start … end − 1 (only HEADER and TEXT ranges are asked for);
// `length` is the file's size.
function parseLayout(get, length, base, options, version) {
  const diagnostics = [];
  const header = readHeader(get(base, base + 58), 0);
  if (header.textStart <= 0 || header.textEnd <= header.textStart) throw new FCSError('The HEADER does not locate a TEXT segment.');
  const textBytes = get(base + header.textStart, base + header.textEnd + 1);
  const { text, encoding } = decodeText(textBytes);
  if (encoding === 'latin1') diagnostics.push({ level: 'info', code: 'encoding', message: 'The TEXT segment is not valid UTF-8; it was read as Latin-1.' });
  let pairs = chooseTextParse(text, diagnostics);
  let keywords = keywordMap(pairs);

  // Supplemental TEXT (FCS 3.x), when it lies outside the primary TEXT segment.
  const sStart = intKeyword(keywords, '$BEGINSTEXT');
  const sEnd = intKeyword(keywords, '$ENDSTEXT');
  const stextValid = sStart > 0 && sEnd > sStart && base + sEnd < length;
  if (stextValid && (sStart > header.textEnd || sEnd < header.textStart)) {
    const extra = decodeText(get(base + sStart, base + sEnd + 1)).text;
    const extraPairs = supplementalPairs(extra, text[0]);
    if (extraPairs) {
      pairs = pairs.concat(extraPairs);
      keywords = keywordMap(pairs);
    } else {
      diagnostics.push({ level: 'info', code: 'stext-ignored', message: `The supplemental TEXT segment (${sEnd - sStart + 1} bytes) does not hold keywords (it starts "${extra.slice(0, 24).replace(/[^\x20-\x7e]/g, '?')}"); it was ignored.` });
    }
  }

  const mode = (keywords.$MODE ?? 'L').trim().toUpperCase();
  if (mode !== 'L') throw new FCSError(`Only list-mode data ($MODE L) is supported; this file has $MODE ${mode}.`, 'unsupported');
  const par = intKeyword(keywords, '$PAR');
  if (!par || par <= 0) throw new FCSError('The file does not say how many parameters it has ($PAR).');
  // Each parameter needs at least its $PnB keyword, so $PAR cannot exceed the number of keywords.
  if (par > pairs.length) throw new FCSError(`$PAR says the file has ${par} parameters, but its TEXT segment holds only ${pairs.length} keywords.`);
  const parameters = decodeParameters(keywords, par, diagnostics);
  const datatype = (keywords.$DATATYPE ?? 'F').trim().toUpperCase();
  const types = parameters.map((p) => p.datatype ?? datatype);
  let eventBytes = 0;
  if (!types.includes('A')) {
    for (let i = 0; i < parameters.length; i += 1) {
      const t = types[i];
      eventBytes += t === 'F' ? 4 : t === 'D' ? 8 : (Number.isFinite(parameters[i].bits) ? parameters[i].bits / 8 : 0);
    }
  }
  let eventCount = intKeyword(keywords, '$TOT');
  if (eventCount !== undefined && eventCount < 0) {
    diagnostics.push({ level: 'warning', code: 'no-tot', message: `$TOT (${quoted(keywords.$TOT)}) is not an event count; it was ignored.` });
    eventCount = undefined;
  }
  const offsets = resolveDataOffsets(header, keywords, eventBytes, eventCount ?? 0, base, length, diagnostics);
  let hasData = true;
  if (offsets.start >= length && (eventCount ?? 1) > 0) {
    // Only the HEADER and TEXT are present (a truncated copy, or a file saved as keywords only).
    const message = `The file ends at byte ${length}, before its DATA segment (bytes ${offsets.start}–${offsets.end}): it holds only the keywords.`;
    if (!options.headerOnly) throw new FCSError(message, 'truncated');
    diagnostics.push({ level: 'error', code: 'no-data', message });
    hasData = false;
  } else if (offsets.end >= length) {
    diagnostics.push({ level: 'warning', code: 'truncated', message: `The DATA segment should end at byte ${offsets.end} but the file has ${length} bytes.` });
    offsets.end = length - 1;
  }
  if (eventCount === undefined) {
    if (!(eventBytes > 0)) throw new FCSError('$TOT is missing and cannot be inferred for this data type.');
    if (offsets.end < offsets.start) throw new FCSError('$TOT is missing, and the file does not say where its DATA segment ends, so the number of events cannot be inferred.');
    eventCount = Math.floor((offsets.end - offsets.start + 1) / eventBytes);
    diagnostics.push({ level: 'warning', code: 'no-tot', message: `$TOT is missing; ${eventCount} events were inferred from the DATA length.` });
  } else if (eventBytes > 0 && Number.isInteger(eventBytes) && offsets.start < length) {
    const fits = Math.max(0, Math.floor((offsets.end - offsets.start + 1) / eventBytes));
    if (fits < eventCount) {
      diagnostics.push({ level: 'error', code: 'truncated', message: `$TOT says ${eventCount} events but the DATA segment holds ${fits}; only those were read.` });
      eventCount = fits;
    }
  }
  if (options.maxEvents !== undefined && eventCount > options.maxEvents) eventCount = options.maxEvents;
  const nextData = intKeyword(keywords, '$NEXTDATA') ?? 0;
  // The last byte of the data set's segments; an FCS 3.1 CRC may follow it.
  const lastEnd = Math.max(header.textEnd, offsets.end - base, header.analysisEnd, stextValid ? sEnd : 0);
  return { version, base, header, keywords, pairs, parameters, types, eventBytes, eventCount, offsets, diagnostics, nextData, lastEnd, hasData };
}

// The CRC check, given the eight characters after the last segment and a way to compute the CRC
// of bytes 0 … lastEnd. Null when there is no CRC to check.
function checkCRC(layout, length, crcText, compute, options) {
  if (layout.nextData || layout.base !== 0) return null;
  if (!(/^[0-9A-Fa-f]{1,8}$/.test(crcText) && Number.parseInt(crcText, 16) !== 0 && options.checkCRC !== false && length - (layout.lastEnd + 1) <= 16)) return null;
  const computed = compute();
  // Writers disagree on hexadecimal or decimal; either matching counts.
  const ok = Number.parseInt(crcText, 16) === computed || Number.parseInt(crcText, 10) === computed;
  if (!ok) layout.diagnostics.push({ level: 'info', code: 'crc', message: `The stored CRC (${crcText}) could not be verified against the file's content.` });
  return { stored: crcText, computed, ok };
}

// Linear values, saturation counts and the data set's description.
function finishDataset(layout, columns, crc, options) {
  const { parameters, diagnostics, types, header, offsets, base } = layout;
  if (!options.headerOnly && options.linearize !== false) linearize(columns, parameters, diagnostics, types);
  for (const p of parameters) {
    if (p.type !== 'fluorescence' || !(p.range > 0)) continue;
    const column = columns[p.index];
    let saturated = 0;
    const limit = p.range - 1;
    for (let e = 0; e < column.length; e += 1) if (column[e] >= limit) saturated += 1;
    p.saturated = saturated;
  }
  return {
    version: layout.version,
    keywords: layout.keywords,
    pairs: layout.pairs,
    parameters,
    eventCount: layout.eventCount,
    data: columns,
    diagnostics,
    offsets: { text: [base + header.textStart, base + header.textEnd], data: [offsets.start, offsets.end], analysis: [header.analysisStart, header.analysisEnd] },
    crc,
    nextData: layout.nextData ? base + layout.nextData : 0,
  };
}

function parseDataset(bytes, base, options, version) {
  const layout = parseLayout((a, b) => bytes.subarray(a, b), bytes.length, base, options, version);
  const { keywords, parameters, eventCount, offsets, diagnostics } = layout;
  const columns = options.headerOnly ? parameters.map(() => new Float32Array(0)) : decodeData(bytes, offsets.start, offsets.end, keywords, parameters, eventCount, diagnostics, options.allocate);
  // ASCII and packed data may hold fewer events than $TOT says.
  if (!options.headerOnly && columns.length) layout.eventCount = columns[0].length;
  const crcText = asciiField(bytes, layout.lastEnd + 1, layout.lastEnd + 9);
  const crc = checkCRC(layout, bytes.length, crcText, () => crc16(bytes, 0, layout.lastEnd + 1), options);
  return finishDataset(layout, columns, crc, options);
}

// Parses every data set in an FCS file. Options: maxEvents, headerOnly, linearize (default true),
// checkCRC (default true), allocate(n) (a Float32Array for a column; memory.js float32 shares it
// with workers). Returns { version, datasets: [...] }.
export function parseFCS(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = readHeader(bytes, 0);
  const datasets = [];
  let base = 0;
  const seen = new Set();
  while (true) {
    let dataset;
    try {
      dataset = parseDataset(bytes, base, options, readHeader(bytes, base).version);
    } catch (error) {
      // A later data set that cannot be read leaves the earlier ones usable.
      if (!datasets.length || !(error instanceof FCSError)) throw error;
      datasets[0].diagnostics.push({ level: 'warning', code: 'dataset-unreadable', message: `Data set ${datasets.length + 1} (at byte ${base}) could not be read and was left out: ${error.message}` });
      break;
    }
    datasets.push(dataset);
    if (!dataset.nextData || seen.has(dataset.nextData) || dataset.nextData >= bytes.length || options.firstOnly) break;
    seen.add(dataset.nextData);
    base = dataset.nextData;
  }
  if (datasets.length > 1) datasets[0].diagnostics.push({ level: 'info', code: 'datasets', message: `The file holds ${datasets.length} data sets ($NEXTDATA).` });
  return { version: header.version, datasets };
}

// --- Reading without holding the file in memory --------------------------------------------------
//
// A byte source is { size, read(start, end) → Promise<Uint8Array> } (bytes start … end − 1): an array
// in memory, a Blob or File (read by slices), or a URL (read by HTTP range requests). parseFCSAsync
// reads the HEADER and TEXT first, then the file once from start to end in chunks, decoding the
// DATA segment's events as they arrive, so it holds the columns and one chunk rather than the file.

const READ_CHUNK = 16 * 1024 * 1024;

export function bytesSource(bytes) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { size: array.length, read: async (a, b) => array.subarray(a, Math.min(b, array.length)), bytes: array };
}

export function blobSource(blob) {
  return { size: blob.size, read: async (a, b) => new Uint8Array(await blob.slice(a, Math.min(b, blob.size)).arrayBuffer()), blob };
}

// A file served over HTTP with range requests (the CytoWeave program's library and local files).
export async function urlSource(url, options = {}) {
  const fetcher = options.fetch ?? fetch;
  let size = options.size;
  if (!(size >= 0)) {
    const head = await fetcher(url, { method: 'HEAD' });
    if (!head.ok) throw new FCSError(`The file could not be read (HTTP ${head.status}).`, 'unavailable');
    size = Number(head.headers.get('Content-Length'));
  }
  const read = async (a, b) => {
    const end = Math.min(b, size);
    if (end <= a) return new Uint8Array(0);
    const response = await fetcher(url, { headers: { Range: `bytes=${a}-${end - 1}` } });
    if (response.status === 200 && a === 0 && end === size) return new Uint8Array(await response.arrayBuffer());
    if (response.status !== 206) throw new FCSError(`The file could not be read in parts (HTTP ${response.status}).`, 'unavailable');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - a) throw new FCSError(`Asked for ${end - a} bytes, received ${bytes.length}.`, 'unavailable');
    return bytes;
  };
  return { size, read, url };
}

// As parseFCS, from a byte source. options as parseFCS, and observe(bytes, start): called with
// every part of the file in order, start to end, as it is read (to hash it on the way);
// onProgress(fraction); chunkSize (bytes per read, 16 MB). Files with
// several data sets, ASCII or packed data are read whole and parsed by parseFCS.
export async function parseFCSAsync(source, options = {}) {
  const { size } = source;
  const whole = async () => {
    const bytes = await readAll(source, options.observe);
    return parseFCS(bytes, options);
  };
  if (size < 58) return whole();
  const head = await source.read(0, Math.min(size, 58));
  const header = readHeader(head, 0);
  // The HEADER and TEXT ranges, fetched before the layout is parsed from them.
  const pieces = [{ start: 0, bytes: head }];
  const fetchRange = async (a, b) => {
    const end = Math.min(b, size);
    if (pieces.some((p) => p.start <= a && p.start + p.bytes.length >= end)) return;
    pieces.push({ start: a, bytes: await source.read(a, end) });
  };
  if (header.textStart > 0 && header.textEnd > header.textStart) await fetchRange(header.textStart, header.textEnd + 1);
  const get = (a, b) => {
    const end = Math.min(b, size);
    const piece = pieces.find((p) => p.start <= a && p.start + p.bytes.length >= end);
    if (!piece) throw new NeedBytes(a, end);
    return piece.bytes.subarray(a - piece.start, end - piece.start);
  };
  let layout;
  for (let attempt = 0; ; attempt += 1) {
    try {
      layout = parseLayout(get, size, 0, options, header.version);
      break;
    } catch (error) {
      if (!(error instanceof NeedBytes)) throw error;
      if (attempt > 4 || error.start < 0 || error.start >= size) throw new FCSError(`The file's offsets point outside it (bytes ${error.start}–${error.end} of ${size}).`);
      await fetchRange(error.start, error.end);
    }
  }
  if (layout.nextData) return whole();
  const plan = dataPlan(layout.keywords, layout.parameters);
  if (plan.kind !== 'binary') return whole();
  const { offsets, eventCount, parameters, diagnostics, keywords } = layout;
  if (options.headerOnly || !layout.hasData) {
    return { version: header.version, datasets: [finishDataset(layout, parameters.map(() => new Float32Array(0)), null, options)] };
  }
  const available = offsets.end - offsets.start + 1;
  const needed = plan.eventBytes * eventCount;
  if (available < needed) throw new FCSError(`The DATA segment holds ${available} bytes but ${eventCount} events need ${needed}; the file is truncated.`, 'truncated');
  if (plan.permuted) diagnostics.push({ level: 'info', code: 'byte-order', message: `Mixed byte order ${keywords.$BYTEORD} was decoded.` });

  // The CRC's eight characters follow the last segment; its check needs every byte before them.
  const tail = await source.read(layout.lastEnd + 1, Math.min(size, layout.lastEnd + 9));
  let crcText = '';
  for (const byte of tail) crcText += String.fromCharCode(byte);
  crcText = crcText.trim();
  const wantCRC = checkCRC({ ...layout, diagnostics: [] }, size, crcText, () => 0, options) !== null;

  const columns = parameters.map(() => (options.allocate ? options.allocate(eventCount) : new Float32Array(eventCount)));
  const dataStart = offsets.start;
  const dataEnd = dataStart + needed;
  let decoded = 0;
  let masked = 0;
  let carry = new Uint8Array(0);
  let crc = 0;
  const readEnd = options.observe ? size : wantCRC ? Math.max(dataEnd, layout.lastEnd + 1) : dataEnd;
  const firstRead = options.observe || wantCRC ? 0 : dataStart;
  const chunk = options.chunkSize ?? READ_CHUNK;
  let next = source.read(firstRead, Math.min(readEnd, firstRead + chunk));
  for (let at = firstRead; at < readEnd;) {
    const bytes = await next;
    if (!bytes.length) throw new FCSError(`The file ended at byte ${at} while reading it.`, 'truncated');
    const end = at + bytes.length;
    // Read ahead while this part is decoded.
    if (end < readEnd) next = source.read(end, Math.min(readEnd, end + chunk));
    options.observe?.(bytes, at);
    if (wantCRC && at < layout.lastEnd + 1) crc = crc16(bytes, 0, Math.min(bytes.length, layout.lastEnd + 1 - at), crc);
    // The DATA bytes in this part, after any partial event left from the last part.
    const from = Math.max(at, dataStart);
    const to = Math.min(end, dataEnd);
    if (from < to) {
      let part = bytes.subarray(from - at, to - at);
      if (carry.length) {
        const joined = new Uint8Array(carry.length + part.length);
        joined.set(carry);
        joined.set(part, carry.length);
        part = joined;
      }
      const events = Math.min(eventCount - decoded, Math.floor(part.length / plan.eventBytes));
      if (events > 0) masked += decodeEvents(part, 0, decoded, events, columns, plan);
      decoded += events;
      carry = part.slice(events * plan.eventBytes);
    }
    at = end;
    options.onProgress?.(at / readEnd);
  }
  if (decoded < eventCount) throw new FCSError(`Only ${decoded} of ${eventCount} events could be read.`, 'truncated');
  if (masked) diagnostics.push(maskedDiagnostic(masked));
  const crcResult = wantCRC ? checkCRC(layout, size, crcText, () => crc, options) : null;
  return { version: header.version, datasets: [finishDataset(layout, columns, crcResult, options)] };
}

class NeedBytes extends Error {
  constructor(start, end) {
    super(`bytes ${start}–${end}`);
    this.start = start;
    this.end = end;
  }
}

async function readAll(source, observe) {
  if (source.bytes) {
    observe?.(source.bytes, 0);
    return source.bytes;
  }
  const out = new Uint8Array(source.size);
  for (let at = 0; at < source.size;) {
    const part = await source.read(at, Math.min(source.size, at + READ_CHUNK));
    if (!part.length) throw new FCSError(`The file ended at byte ${at} while reading it.`, 'truncated');
    observe?.(part, at);
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// Spillover keywords: $SPILLOVER (FCS 3.1), SPILL and $SPILL (BD, FlowJo), $COMP (FCS 3.0),
// "SPILLOVER" (Cytek). Returns { keyword, channels, matrix (row-major Float64Array), n } or null.
export function readSpillover(keywords, parameters = []) {
  for (const key of ['$SPILLOVER', 'SPILL', '$SPILL', 'SPILLOVER', '$COMP', 'COMP']) {
    const raw = keywords[key];
    if (!raw) continue;
    const parts = String(raw).split(',').map((part) => part.trim());
    const n = Number.parseInt(parts[0], 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    let channels;
    let values;
    if (parts.length >= 1 + n + n * n) {
      channels = parts.slice(1, 1 + n);
      values = parts.slice(1 + n, 1 + n + n * n).map(Number);
    } else if (parts.length >= 1 + n * n) {
      // $COMP without names: the first n fluorescence parameters, in order.
      channels = parameters.filter((p) => p.type === 'fluorescence').slice(0, n).map((p) => p.name);
      values = parts.slice(1, 1 + n * n).map(Number);
    } else {
      continue;
    }
    if (values.some((v) => !Number.isFinite(v))) continue;
    // Names may refer to $PnS rather than $PnN; resolve to $PnN.
    const resolved = channels.map((channel) => {
      const byName = parameters.find((p) => p.name === channel);
      if (byName) return byName.name;
      const byLabel = parameters.find((p) => p.label === channel);
      return byLabel ? byLabel.name : channel;
    });
    const matrix = Float64Array.from(values);
    const identity = matrix.every((v, i) => (Math.floor(i / n) === i % n ? Math.abs(v - 1) < 1e-12 : Math.abs(v) < 1e-12));
    return { keyword: key, channels: resolved, matrix, n, identity };
  }
  return null;
}

// Instrument and acquisition facts worth showing, from standard and common vendor keywords.
export function describeAcquisition(keywords) {
  const pick = (...keys) => {
    for (const key of keys) {
      const value = keywords[key];
      if (value !== undefined && String(value).trim() !== '') return String(value).trim();
    }
    return '';
  };
  return {
    cytometer: pick('$CYT', 'CYTOMETER CONFIG NAME'),
    serial: pick('$CYTSN', 'CYTOMETER SERIAL NUMBER'),
    date: pick('$DATE'),
    begin: pick('$BTIM'),
    end: pick('$ETIM'),
    dateTimeBegin: pick('$BEGINDATETIME'),
    dateTimeEnd: pick('$ENDDATETIME'),
    operator: pick('$OP', 'EXPORT USER NAME'),
    software: pick('CREATOR', 'APPLICATION', '$SRC'),
    specimen: pick('$SMNO', '$SRC', 'SAMPLE ID'),
    experiment: pick('$PROJ', 'EXPERIMENT NAME', 'GUID'),
    tube: pick('TUBE NAME', '$SMNO'),
    plate: pick('$PLATEID', '$PLATENAME', 'PLATE NAME', 'PLATE ID'),
    well: pick('$WELLID', 'WELL ID'),
    volume: pick('$VOL'),
    timestep: pick('$TIMESTEP'),
    originality: pick('$ORIGINALITY'),
    lost: pick('$LOST'),
    aborted: pick('$ABRT'),
    file: pick('$FIL'),
  };
}

// Instrument family, which picks sensible default transforms.
export function detectTechnology(keywords, parameters) {
  const cyt = String(keywords.$CYT ?? '').toLowerCase();
  const names = parameters.map((p) => p.name);
  const massChannels = names.filter((name) => /^[A-Z][a-z]?\d{2,3}(Di|Dd)$/.test(name) || /^\(?[A-Z][a-z]?\d{2,3}\)?Di/.test(name)).length;
  if (cyt.includes('cytof') || cyt.includes('helios') || cyt.includes('xt') && massChannels > 3 || massChannels >= 5) return 'mass';
  if (cyt.includes('aurora') || cyt.includes('northern lights') || cyt.includes('id7000') || cyt.includes('sp6800') || cyt.includes('symphony a5 se') || cyt.includes('discover s8') || cyt.includes('fortessa x-50 spectral')) return 'spectral';
  const fluor = parameters.filter((p) => p.type === 'fluorescence').length;
  if (fluor >= 40) return 'spectral';
  return 'conventional';
}

// --- Writer -----------------------------------------------------------------------------------

function escapeValue(value, delimiter) {
  const text = String(value ?? '');
  return text.split(delimiter).join(delimiter + delimiter);
}

function padOffset(value, width = 8) {
  const text = String(value);
  return text.length > width ? '0'.repeat(width) : ' '.repeat(width - text.length) + text;
}

// Writes an FCS 3.1 file with 32-bit float list-mode data, little-endian.
// sample: { parameters: [{ name, label, range }], data: Float32Array[] (columns),
//           keywords: { key: value } (extra keywords; standard ones are computed) }.
export function writeFCS(sample, options = {}) {
  const delimiter = options.delimiter ?? '|';
  const parameters = sample.parameters;
  const p = parameters.length;
  const eventCount = sample.data[0]?.length ?? 0;
  for (const column of sample.data) if (column.length !== eventCount) throw new FCSError('All columns must have the same number of events.');
  const encoder = new TextEncoder();

  const reserved = /^\$(BEGINDATA|ENDDATA|BEGINANALYSIS|ENDANALYSIS|BEGINSTEXT|ENDSTEXT|BYTEORD|DATATYPE|MODE|NEXTDATA|PAR|TOT|P\d+[BENRSG]|P\d+DATATYPE)$/i;
  const fixed = [
    ['$BYTEORD', '1,2,3,4'],
    ['$DATATYPE', 'F'],
    ['$MODE', 'L'],
    ['$NEXTDATA', '0'],
    ['$PAR', String(p)],
    ['$TOT', String(eventCount)],
  ];
  parameters.forEach((param, i) => {
    const n = i + 1;
    fixed.push([`$P${n}N`, param.name]);
    if (param.label) fixed.push([`$P${n}S`, param.label]);
    fixed.push([`$P${n}B`, '32']);
    fixed.push([`$P${n}E`, '0,0']);
    fixed.push([`$P${n}R`, String(Math.max(1, Math.round(param.range || 262144)))]);
  });
  const extra = [];
  for (const [key, value] of Object.entries(sample.keywords ?? {})) {
    if (reserved.test(key)) continue;
    if (value === undefined || value === null || String(value) === '') continue;
    extra.push([key, String(value)]);
  }
  const body = (dataStart, dataEnd) => {
    const parts = [['$BEGINANALYSIS', '0'], ['$ENDANALYSIS', '0'], ['$BEGINSTEXT', '0'], ['$ENDSTEXT', '0'], ['$BEGINDATA', String(dataStart)], ['$ENDDATA', String(dataEnd)], ...fixed, ...extra];
    let text = delimiter;
    for (const [key, value] of parts) text += escapeValue(key, delimiter) + delimiter + escapeValue(value, delimiter) + delimiter;
    return encoder.encode(text);
  };
  const dataBytes = eventCount * p * 4;
  const textStart = 58;
  // Offsets change the TEXT length, which changes the offsets: iterate to a fixed point.
  let textBytes = body(0, 0);
  let dataStart = 0;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    dataStart = textStart + textBytes.length;
    const dataEnd = dataBytes ? dataStart + dataBytes - 1 : dataStart;
    const next = body(dataStart, dataEnd);
    if (next.length === textBytes.length) {
      textBytes = next;
      break;
    }
    textBytes = next;
  }
  dataStart = textStart + textBytes.length;
  const dataEnd = dataBytes ? dataStart + dataBytes - 1 : 0;
  const textEnd = textStart + textBytes.length - 1;
  const total = dataStart + dataBytes + 8;
  const out = new Uint8Array(total);
  const headerText = 'FCS3.1    ' + padOffset(textStart) + padOffset(textEnd)
    + (dataEnd <= 99999999 ? padOffset(dataStart) + padOffset(dataEnd) : padOffset(0) + padOffset(0))
    + padOffset(0) + padOffset(0);
  out.set(encoder.encode(headerText), 0);
  out.set(textBytes, textStart);
  const view = new DataView(out.buffer);
  let offset = dataStart;
  for (let e = 0; e < eventCount; e += 1) {
    for (let i = 0; i < p; i += 1) {
      view.setFloat32(offset, sample.data[i][e], true);
      offset += 4;
    }
  }
  // 00000000 says no CRC was computed, which every reader accepts.
  const crc = options.crc ? crc16(out, 0, dataStart + dataBytes) : 0;
  out.set(encoder.encode(crc.toString(16).toUpperCase().padStart(8, '0')), dataStart + dataBytes);
  return out;
}

export { crc16 };
