// De-identification of FCS files (D7): keep the keywords needed to read and analyze the data,
// remove the rest. Identifying information hides in many places (operator, specimen and patient
// fields, free-text comments, file names, dates, instrument serial numbers, vendor keywords), and
// vendors add new keywords all the time, so this is an allowlist: a keyword is kept only if it is
// known to be technical. Everything removed is reported.
//
// deidentifyFCS rewrites only the TEXT segment of each data set and copies its DATA bytes
// unchanged, so the events are bit-for-bit the original ones, whatever their data type. ANALYSIS
// and supplemental TEXT segments are dropped (their keywords are moved into TEXT and filtered).

import { describeAcquisition, parseFCS } from './fcs.js';

// Keywords managed by the writer (offsets), not copied.
const LAYOUT = /^\$(BEGINDATA|ENDDATA|BEGINANALYSIS|ENDANALYSIS|BEGINSTEXT|ENDSTEXT|NEXTDATA)$/;

// Technical keywords that are kept.
const KEEP = [
  /^\$P\d+[A-Z]+$/, // every parameter keyword: name, marker, range, bits, amplification, voltage, …
  /^\$(BYTEORD|DATATYPE|MODE|PAR|TOT|TIMESTEP|VOL|CYT|TR|ABRT|LOST|CSMODE|CSVBITS|UNICODE)$/,
  /^\$(SPILLOVER|SPILL|COMP)$/,
  /^SPILL(OVER)?$/,
  /^\$G\d+[A-Z]+$/, /^\$GATE$/, /^\$R\d+[IW]$/, /^\$PK\d+$/, /^\$PKN\d+$/, /^\$CSV\d+FLAG$/,
  /^\$WELLID$/,
  /^TIMESTEP$/,
  /^INDEX SORTING (LOCATIONS|DEVICE TYPE|SORTED LOCATION COUNT)$/,
  /^LASER\d+(NAME|DELAY|ASF|WAVELENGTH|POWER)$/,
  /^(FSC ASF|THRESHOLD|WINDOW EXTENSION|APPLY COMPENSATION|AUTOBS|SPECTRAL)$/,
  /^P\d+(DISPLAY|BS|MS)$/, // BD's per-parameter display and binning settings
  /^(CREATOR|APPLICATION|\$SYS)$/, // the acquisition software and system, which the methods cite
  /^CYTOWEAVE /,
];
// Dates and times, kept only when asked for.
const DATES = /^\$(DATE|BTIM|ETIM|LAST_MODIFIED)$/;

// Filters keywords. `keywords` is { key: value } or [[key, value], …]; returns { keywords (same
// shape), removed: [{ key, value }] }. Options: keepDates (false), fileName (written as $FIL).
export function deidentifyKeywords(keywords, options = {}) {
  const pairs = Array.isArray(keywords) ? keywords : Object.entries(keywords ?? {});
  const kept = [];
  const removed = [];
  for (const [key, value] of pairs) {
    const upper = String(key).trim().toUpperCase();
    if (upper === '$FIL' || upper === '$ORIGINALITY') continue;
    if (KEEP.some((re) => re.test(upper)) || (options.keepDates && DATES.test(upper)) || LAYOUT.test(upper)) kept.push([key, value]);
    else removed.push({ key, value: String(value ?? '') });
  }
  if (options.fileName) kept.push(['$FIL', options.fileName]);
  kept.push(['$ORIGINALITY', 'DataModified']);
  return { keywords: Array.isArray(keywords) ? kept : Object.fromEntries(kept), removed };
}

function escapeValue(value, delimiter) {
  return String(value).split(delimiter).join(delimiter + delimiter);
}

const pad = (value) => String(value).padStart(8, ' ');

// Rewrites an FCS file without identifying keywords. Options: keepDates, fileName. Returns
// { bytes, removed: [{ key, value }] (of every data set, without repeats), datasets }.
export function deidentifyFCS(bytes, options = {}) {
  const parsed = parseFCS(bytes, { headerOnly: true, checkCRC: false });
  const encoder = new TextEncoder();
  const blocks = [];
  const removed = new Map();
  parsed.datasets.forEach((dataset, index) => {
    const [dataStart, dataEnd] = dataset.offsets.data;
    const data = bytes.subarray(dataStart, Math.min(bytes.length, dataEnd + 1));
    const { keywords, removed: gone } = deidentifyKeywords(dataset.pairs.filter(([key]) => !LAYOUT.test(String(key).trim().toUpperCase())), options);
    for (const item of gone) if (!removed.has(item.key.toUpperCase())) removed.set(item.key.toUpperCase(), item);
    const last = index === parsed.datasets.length - 1;
    const version = /^FCS2/.test(dataset.version) ? 'FCS3.0' : dataset.version;
    blocks.push({ keywords, data, last, version, eventCount: dataset.eventCount });
  });
  // Lay out each data set: HEADER, TEXT, DATA, then (in the last) an empty CRC.
  const parts = [];
  for (const block of blocks) {
    const delimiter = '|';
    const text = (dataBegin, dataEndAt, next) => {
      const fields = [['$BEGINANALYSIS', '0'], ['$ENDANALYSIS', '0'], ['$BEGINSTEXT', '0'], ['$ENDSTEXT', '0'], ['$BEGINDATA', String(dataBegin)], ['$ENDDATA', String(dataEndAt)], ['$NEXTDATA', String(next)], ...block.keywords.filter(([, v]) => String(v ?? '') !== '')];
      let out = delimiter;
      for (const [k, v] of fields) out += escapeValue(k, delimiter) + delimiter + escapeValue(v, delimiter) + delimiter;
      return encoder.encode(out);
    };
    const textStart = 58;
    let textBytes = text(0, 0, 0);
    let dataBegin = 0;
    let dataEndAt = 0;
    let next = 0;
    for (let i = 0; i < 6; i += 1) {
      dataBegin = textStart + textBytes.length;
      dataEndAt = block.data.length ? dataBegin + block.data.length - 1 : 0;
      next = block.last ? 0 : dataBegin + block.data.length;
      const again = text(dataBegin, dataEndAt, next);
      if (again.length === textBytes.length) {
        textBytes = again;
        break;
      }
      textBytes = again;
    }
    const header = `${block.version}    ${pad(textStart)}${pad(textStart + textBytes.length - 1)}${dataEndAt <= 99999999 ? pad(dataBegin) + pad(dataEndAt) : pad(0) + pad(0)}${pad(0)}${pad(0)}`;
    parts.push(encoder.encode(header), textBytes, block.data);
    if (block.last) parts.push(encoder.encode('00000000'));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return { bytes: out, removed: [...removed.values()], datasets: blocks.length };
}

// A copy of a workspace that refers to de-identified copies of its files: each sample gets the
// new file's name and checksum, only the kept keywords, and an acquisition summary rebuilt from
// them; imported FlowJo records (which hold file paths) are dropped. Sample names, gates and the
// change log are kept. options: { fileNames: Map(sampleId → name), hashes: Map(sampleId →
// sha256), keepDates }.
export function deidentifyWorkspace(ws, options = {}) {
  return {
    ...ws,
    migrations: [],
    samples: ws.samples.map((sample) => {
      const fileName = options.fileNames?.get(sample.id) ?? `${sample.name}.fcs`;
      const { keywords } = deidentifyKeywords(sample.keywords ?? {}, { keepDates: options.keepDates, fileName });
      return { ...sample, fileName, sha256: options.hashes?.get(sample.id) ?? sample.sha256, keywords, acquisition: describeAcquisition(keywords) };
    }),
  };
}
