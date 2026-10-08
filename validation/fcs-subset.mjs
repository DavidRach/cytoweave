// The first events of an FCS file, as a valid FCS file of its own: for validation data that are
// large files inside a larger archive (fetch.mjs reads only the start of a ZIP entry). The TEXT
// segment keeps every keyword but those that place segments and count events ($TOT, $BEGINDATA,
// $ENDDATA, $NEXTDATA, analysis and supplemental TEXT), which are rewritten, and gains
// CYTOWEAVE_SUBSET saying which events these are. List mode only.

const PLACED = new Set(['$TOT', '$BEGINDATA', '$ENDDATA', '$NEXTDATA', '$BEGINANALYSIS', '$ENDANALYSIS', '$BEGINSTEXT', '$ENDSTEXT', 'CYTOWEAVE_SUBSET']);

// Keyword pairs of a TEXT segment, kept as written (a doubled delimiter is an escaped one).
function textPairs(text) {
  const delimiter = text[0];
  const pairs = [];
  let current = '';
  const fields = [];
  for (let i = 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === delimiter) {
      if (text[i + 1] === delimiter) {
        current += delimiter + delimiter;
        i += 1;
        continue;
      }
      fields.push(current);
      current = '';
    } else current += c;
  }
  if (current) fields.push(current);
  for (let i = 0; i + 1 < fields.length; i += 2) pairs.push([fields[i], fields[i + 1]]);
  return { delimiter, pairs };
}

// bytes: the start of an FCS file (at least its TEXT and the events wanted). Returns the subset
// as a Buffer, or throws when fewer events are present.
export function subsetFCS(bytes, events) {
  const ascii = (a, b) => bytes.subarray(a, b).toString('latin1');
  const version = ascii(0, 6);
  if (!/^FCS\d\.\d/.test(version)) throw new Error('not an FCS file');
  const textStart = Number(ascii(10, 18));
  const textEnd = Number(ascii(18, 26));
  const { delimiter, pairs } = textPairs(ascii(textStart, textEnd + 1));
  const get = (key) => pairs.find(([k]) => k.toUpperCase() === key)?.[1];
  if ((get('$MODE') ?? 'L').toUpperCase() !== 'L') throw new Error('only list-mode files can be subset');
  const par = Number(get('$PAR'));
  let bits = 0;
  for (let p = 1; p <= par; p += 1) bits += Number(get(`$P${p}B`));
  if (bits % 8) throw new Error('parameters that do not fill whole bytes are not supported');
  const perEvent = bits / 8;
  const total = Number(get('$TOT'));
  const dataStart = Number(ascii(26, 34).trim()) || Number(get('$BEGINDATA'));
  const n = Math.min(events, total);
  if (bytes.length < dataStart + n * perEvent) throw new Error(`only ${Math.floor((bytes.length - dataStart) / perEvent)} of the ${n} events wanted are present`);
  const kept = pairs.filter(([k]) => !PLACED.has(k.toUpperCase()));
  const escape = (v) => String(v).split(delimiter).join(delimiter + delimiter);
  // Segment offsets as 20-digit numbers, so the TEXT length does not depend on them.
  const pad = (v) => String(v).padStart(20, '0');
  const build = (begin, end) => {
    const all = [...kept, ['$TOT', String(n)], ['$BEGINDATA', pad(begin)], ['$ENDDATA', pad(end)], ['$NEXTDATA', '0'], ['$BEGINANALYSIS', '0'], ['$ENDANALYSIS', '0'], ['$BEGINSTEXT', '0'], ['$ENDSTEXT', '0'], ['CYTOWEAVE_SUBSET', `the first ${n} of ${total} events`]];
    return delimiter + all.map(([k, v]) => `${k}${delimiter}${escape(v)}`).join(delimiter) + delimiter;
  };
  const length = Buffer.byteLength(build(0, 0), 'latin1');
  const begin = 58 + length;
  const end = begin + n * perEvent - 1;
  const text = Buffer.from(build(begin, end), 'latin1');
  const field = (v) => (v <= 99999999 ? String(v).padStart(8, ' ') : '       0');
  const header = Buffer.from(`${version}    ${field(58)}${field(58 + text.length - 1)}${field(begin)}${field(end)}${field(0)}${field(0)}`, 'latin1');
  return Buffer.concat([header, text, bytes.subarray(dataStart, dataStart + n * perEvent)]);
}
