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
    return Number.isFinite(value) ? value : 0;
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

// Scores a keyword parse: parameter keywords that agree with $PAR, standard keys that look right.
function scorePairs(pairs) {
  const keys = new Map();
  for (const [key, value] of pairs) keys.set(key.trim().toUpperCase(), value);
  const par = Number.parseInt(keys.get('$PAR') ?? '', 10);
  let score = 0;
  if (Number.isFinite(par) && par > 0) {
    score += 5;
    for (let n = 1; n <= par; n += 1) {
      if (keys.has(`$P${n}N`)) score += 2;
      if (keys.has(`$P${n}B`)) score += 1;
      if (keys.has(`$P${n}R`)) score += 1;
    }
  }
  for (const key of ['$TOT', '$DATATYPE', '$BYTEORD', '$MODE', '$NEXTDATA', '$BEGINDATA']) if (keys.has(key)) score += 1;
  let suspicious = 0;
  for (const [key] of pairs) {
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > 128 || /[\x00-\x08]/.test(trimmed)) suspicious += 1;
  }
  return score - 3 * suspicious;
}

function chooseTextParse(text, diagnostics) {
  const standard = parseTextSegment(text);
  if (!text.length) return standard;
  const delimiter = text[0];
  if (!text.includes(delimiter + delimiter, 1)) return standard;
  const lenient = parseTextSegment(text, { emptyValues: true });
  if (scorePairs(lenient) > scorePairs(standard)) {
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

function decodeData(bytes, start, end, keywords, parameters, eventCount, diagnostics) {
  const globalType = (keywords.$DATATYPE ?? 'F').trim().toUpperCase();
  const byteOrder = parseByteOrder(keywords.$BYTEORD);
  const columns = parameters.map(() => new Float32Array(eventCount));
  const types = parameters.map((p) => p.datatype ?? globalType);
  if (types.some((type) => !['I', 'F', 'D', 'A'].includes(type))) throw new FCSError(`Unsupported $DATATYPE ${globalType}.`, 'unsupported');
  if (types.includes('A')) return decodeASCII(bytes, start, end, parameters, eventCount, columns, diagnostics);

  const widths = parameters.map((p, i) => {
    if (types[i] === 'F') return 4;
    if (types[i] === 'D') return 8;
    const bits = p.bits;
    if (!Number.isFinite(bits) || bits <= 0) throw new FCSError(`$P${i + 1}B is not a bit width ("${p.bits}").`);
    if (bits % 8 !== 0) return -bits;
    return bytesPerValue('I', bits);
  });
  if (widths.some((w) => w < 0)) return decodePacked(bytes, start, parameters, eventCount, columns, byteOrder, diagnostics);
  const eventBytes = widths.reduce((sum, w) => sum + w, 0);
  const available = end - start + 1;
  const needed = eventBytes * eventCount;
  if (available < needed) throw new FCSError(`The DATA segment holds ${available} bytes but ${eventCount} events need ${needed}; the file is truncated.`, 'truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const permuted = !byteOrder.little && !byteOrder.big;
  if (permuted) diagnostics.push({ level: 'info', code: 'byte-order', message: `Mixed byte order ${keywords.$BYTEORD} was decoded.` });
  // Integer masks: bits above $PnR (rounded up to a power of two) hold flags on some instruments.
  const masks = parameters.map((p, i) => {
    if (types[i] !== 'I' || !(p.range > 0)) return 0;
    const bits = widths[i] * 8;
    const needBits = Math.ceil(Math.log2(p.range));
    if (needBits >= bits || needBits >= 53) return 0;
    return 2 ** needBits - 1;
  });
  let masked = 0;
  const offsets = [];
  let acc = 0;
  for (const w of widths) {
    offsets.push(acc);
    acc += w;
  }
  const p = parameters.length;
  for (let e = 0; e < eventCount; e += 1) {
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
      columns[i][e] = value;
    }
  }
  if (masked) diagnostics.push({ level: 'info', code: 'masked-bits', message: `${masked} integer values had bits above $PnR set; they were masked as the standard describes.` });
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

function crc16(bytes, start, end) {
  // CRC-16-CCITT (polynomial 0x1021, initial 0), as FCS 3.1 specifies.
  let crc = 0;
  for (let i = start; i < end; i += 1) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function resolveDataOffsets(header, keywords, eventBytes, eventCount, base, fileLength, diagnostics) {
  let start = header.dataStart;
  let end = header.dataEnd;
  const kStart = intKeyword(keywords, '$BEGINDATA');
  const kEnd = intKeyword(keywords, '$ENDDATA');
  if ((start === 0 || end === 0) && kStart !== undefined && kEnd !== undefined) {
    start = kStart;
    end = kEnd;
  } else if (kStart !== undefined && kEnd !== undefined && (kStart !== start || kEnd !== end) && kEnd > 0) {
    diagnostics.push({ level: 'warning', code: 'offset-mismatch', message: `The HEADER gives DATA at ${start}–${end} but $BEGINDATA/$ENDDATA give ${kStart}–${kEnd}; the keywords were used.` });
    start = kStart;
    end = kEnd;
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
  return { start: base + start, end: base + end };
}

function parseDataset(bytes, base, options, version) {
  const diagnostics = [];
  const header = readHeader(bytes, base);
  if (header.textStart <= 0 || header.textEnd <= header.textStart) throw new FCSError('The HEADER does not locate a TEXT segment.');
  const textBytes = bytes.subarray(base + header.textStart, base + header.textEnd + 1);
  const { text, encoding } = decodeText(textBytes);
  if (encoding === 'latin1') diagnostics.push({ level: 'info', code: 'encoding', message: 'The TEXT segment is not valid UTF-8; it was read as Latin-1.' });
  let pairs = chooseTextParse(text, diagnostics);
  let keywords = keywordMap(pairs);

  // Supplemental TEXT (FCS 3.x), when it lies outside the primary TEXT segment.
  const sStart = intKeyword(keywords, '$BEGINSTEXT');
  const sEnd = intKeyword(keywords, '$ENDSTEXT');
  if (sStart && sEnd && sEnd > sStart && (sStart > header.textEnd || sEnd < header.textStart)) {
    const extra = decodeText(bytes.subarray(base + sStart, base + sEnd + 1)).text;
    const extraPairs = parseTextSegment(extra);
    pairs = pairs.concat(extraPairs);
    keywords = keywordMap(pairs);
  }

  const mode = (keywords.$MODE ?? 'L').trim().toUpperCase();
  if (mode !== 'L') throw new FCSError(`Only list-mode data ($MODE L) is supported; this file has $MODE ${mode}.`, 'unsupported');
  const par = intKeyword(keywords, '$PAR');
  if (!par || par <= 0) throw new FCSError('The file does not say how many parameters it has ($PAR).');
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
  const offsets = resolveDataOffsets(header, keywords, eventBytes, eventCount ?? 0, base, bytes.length, diagnostics);
  if (offsets.start >= bytes.length && (eventCount ?? 1) > 0) {
    // Only the HEADER and TEXT are present (a truncated copy, or a file saved as keywords only).
    const message = `The file ends at byte ${bytes.length}, before its DATA segment (bytes ${offsets.start}–${offsets.end}): it holds only the keywords.`;
    if (!options.headerOnly) throw new FCSError(message, 'truncated');
    diagnostics.push({ level: 'error', code: 'no-data', message });
  } else if (offsets.end >= bytes.length) {
    diagnostics.push({ level: 'warning', code: 'truncated', message: `The DATA segment should end at byte ${offsets.end} but the file has ${bytes.length} bytes.` });
    offsets.end = bytes.length - 1;
  }
  if (eventCount === undefined) {
    if (!(eventBytes > 0)) throw new FCSError('$TOT is missing and cannot be inferred for this data type.');
    eventCount = Math.floor((offsets.end - offsets.start + 1) / eventBytes);
    diagnostics.push({ level: 'warning', code: 'no-tot', message: `$TOT is missing; ${eventCount} events were inferred from the DATA length.` });
  } else if (eventBytes > 0 && Number.isInteger(eventBytes) && offsets.start < bytes.length) {
    const fits = Math.max(0, Math.floor((offsets.end - offsets.start + 1) / eventBytes));
    if (fits < eventCount) {
      diagnostics.push({ level: 'error', code: 'truncated', message: `$TOT says ${eventCount} events but the DATA segment holds ${fits}; only those were read.` });
      eventCount = fits;
    }
  }
  if (options.maxEvents !== undefined && eventCount > options.maxEvents) eventCount = options.maxEvents;
  const columns = options.headerOnly ? parameters.map(() => new Float32Array(0)) : decodeData(bytes, offsets.start, offsets.end, keywords, parameters, eventCount, diagnostics);
  if (!options.headerOnly && options.linearize !== false) linearize(columns, parameters, diagnostics, types);

  // CRC: eight ASCII characters after the last segment (FCS 3.1); 00000000 means not computed.
  let crc = null;
  const nextData = intKeyword(keywords, '$NEXTDATA') ?? 0;
  if (!nextData && base === 0) {
    const lastEnd = Math.max(header.textEnd, offsets.end - base, header.analysisEnd, sEnd ?? 0);
    const crcText = asciiField(bytes, lastEnd + 1, lastEnd + 9);
    if (/^[0-9A-Fa-f]{1,8}$/.test(crcText) && Number.parseInt(crcText, 16) !== 0 && options.checkCRC !== false && bytes.length - (lastEnd + 1) <= 16) {
      const computed = crc16(bytes, 0, lastEnd + 1);
      // Writers disagree on hexadecimal or decimal; either matching counts.
      const ok = Number.parseInt(crcText, 16) === computed || Number.parseInt(crcText, 10) === computed;
      crc = { stored: crcText, computed, ok };
      if (!ok) diagnostics.push({ level: 'info', code: 'crc', message: `The stored CRC (${crcText}) could not be verified against the file's content.` });
    }
  }

  for (const p of parameters) {
    if (p.type !== 'fluorescence' || !(p.range > 0)) continue;
    const column = columns[p.index];
    let saturated = 0;
    const limit = p.range - 1;
    for (let e = 0; e < column.length; e += 1) if (column[e] >= limit) saturated += 1;
    p.saturated = saturated;
  }

  return {
    version,
    keywords,
    pairs,
    parameters,
    eventCount,
    data: columns,
    diagnostics,
    offsets: { text: [base + header.textStart, base + header.textEnd], data: [offsets.start, offsets.end], analysis: [header.analysisStart, header.analysisEnd] },
    crc,
    nextData: nextData ? base + nextData : 0,
  };
}

// Parses every data set in an FCS file. Options: maxEvents, headerOnly, linearize (default true),
// checkCRC (default true). Returns { version, datasets: [...] }.
export function parseFCS(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const header = readHeader(bytes, 0);
  if (!FCS_VERSIONS.includes(header.version)) {
    // Read anyway with the closest rules; the version is reported.
  }
  const datasets = [];
  let base = 0;
  const seen = new Set();
  while (true) {
    const dataset = parseDataset(bytes, base, options, readHeader(bytes, base).version);
    datasets.push(dataset);
    if (!dataset.nextData || seen.has(dataset.nextData) || dataset.nextData >= bytes.length || options.firstOnly) break;
    seen.add(dataset.nextData);
    base = dataset.nextData;
  }
  if (datasets.length > 1) datasets[0].diagnostics.push({ level: 'info', code: 'datasets', message: `The file holds ${datasets.length} data sets ($NEXTDATA).` });
  return { version: header.version, datasets };
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
