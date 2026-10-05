// Events from CSV files (I6): a row per event, a column per channel, as FlowJo ("Export CSV",
// "FSC-A, Comp-FITC-A :: CD3, …"), FCS Express, R, Python and instruments write them. The file is
// read with its delimiter (comma, semicolon or tab) and decimal mark found, every column checked
// (values that are not numbers, empty cells, constant columns, an event number, labels such as
// cluster or sample numbers), and each column's kind (scatter, fluorescence, time, other) and scale
// guessed: logicle for intensities, arcsinh (cofactor 5) for mass cytometry counts, a linear scale
// for scatter and time and for values that are already transformed (arcsinh or log values, small
// and often negative). The events become an FCS file (32-bit floats, as FCS files hold them), so
// they are stored, checksummed and analyzed like any sample.

import { classifyChannel } from './fcs.js';
import { defaultTransform } from './transforms.js';

const MISSING = new Set(['', 'na', 'nan', 'null', 'none', 'n/a', '#n/a']);

// Splits a line on a delimiter, honoring double quotes ("" inside quotes is a quote).
function splitLine(line, delimiter) {
  if (!line.includes('"')) return line.split(delimiter);
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { out.push(cell); cell = ''; } else cell += ch;
  }
  out.push(cell);
  return out;
}

// The delimiter that splits the first lines most consistently, and whether decimals use commas.
export function detectFormat(lines) {
  const sample = lines.slice(0, 20);
  let best = { delimiter: ',', score: -1 };
  for (const delimiter of [',', ';', '\t']) {
    const counts = sample.map((l) => splitLine(l, delimiter).length);
    const consistent = counts.every((c) => c === counts[0]);
    const score = counts[0] > 1 ? (consistent ? 1000 : 0) + counts[0] : -1;
    if (score > best.score) best = { delimiter, score };
  }
  const delimiter = best.delimiter;
  // Decimal commas: with semicolons or tabs, numbers such as "1,5" in the body.
  const body = sample.slice(1).flatMap((l) => splitLine(l, delimiter));
  const decimalComma = delimiter !== ',' && body.some((c) => /^\s*-?\d+,\d+(e[+-]?\d+)?\s*$/i.test(c)) && !body.some((c) => /^\s*-?\d+\.\d+\s*$/.test(c));
  return { delimiter, decimalComma };
}

const toNumber = (cell, decimalComma) => {
  const text = cell.trim();
  if (MISSING.has(text.toLowerCase())) return { missing: true };
  const value = Number(decimalComma ? text.replace(',', '.') : text);
  return Number.isFinite(value) ? { value } : { bad: true };
};

// A header cell: "Comp-FITC-A :: CD3" (FlowJo) → name and marker; quotes and spaces trimmed.
export function headerName(cell) {
  const text = String(cell).trim().replace(/^"|"$/g, '');
  const parts = text.split(/\s+::\s+/);
  return parts.length === 2 ? { name: parts[0].trim(), marker: parts[1].trim() } : { name: text, marker: '' };
}

// Does the text look like events (numbers in every column, including the first) rather than a
// table of sample annotations (sample names in the first column)?
export function looksLikeEvents(text) {
  const lines = text.split(/\r?\n/, 60).filter((l) => l.trim());
  if (lines.length < 6) return false;
  const { delimiter, decimalComma } = detectFormat(lines);
  const rows = lines.slice(1).map((l) => splitLine(l, delimiter));
  if (rows[0].length < 2) return false;
  let cells = 0;
  let numeric = 0;
  let firstNumeric = 0;
  for (const row of rows) {
    row.forEach((cell, j) => {
      cells += 1;
      const n = toNumber(cell, decimalComma);
      if (n.value !== undefined) {
        numeric += 1;
        if (j === 0) firstNumeric += 1;
      }
    });
  }
  return numeric / cells > 0.9 && firstNumeric / rows.length > 0.9;
}

// Reads and checks a CSV of events. Returns { format, rows, columns: [{ index, header, name,
// marker, values (Float64Array, NaN where missing or not a number), missing, bad, min, max,
// negatives, integers, distinct (up to 65, as a Set), constant, eventNumber, labels, kind, scale,
// include, note }], notes, problems }.
export function analyzeCSV(text, fileName = 'events.csv') {
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) throw new Error(`${fileName} is empty.`);
  const body = lines.slice(first);
  const format = detectFormat(body);
  const headerCells = splitLine(body[0], format.delimiter);
  const hasHeader = headerCells.some((c) => { const n = toNumber(c, format.decimalComma); return n.bad; });
  const width = headerCells.length;
  const dataLines = hasHeader ? body.slice(1) : body;
  const n = dataLines.length;
  if (!n) throw new Error(`${fileName} has a header but no events.`);
  const problems = [];
  const notes = [];
  const columns = Array.from({ length: width }, (_, j) => {
    const { name, marker } = hasHeader ? headerName(headerCells[j]) : { name: `Column ${j + 1}`, marker: '' };
    return { index: j, header: hasHeader ? String(headerCells[j]).trim() : '', name: name || `Column ${j + 1}`, marker, values: new Float64Array(n), missing: 0, bad: 0, firstBad: null };
  });
  let ragged = 0;
  for (let i = 0; i < n; i += 1) {
    const cells = splitLine(dataLines[i], format.delimiter);
    if (cells.length !== width) ragged += 1;
    for (let j = 0; j < width; j += 1) {
      const column = columns[j];
      const cell = cells[j];
      if (cell === undefined) { column.values[i] = Number.NaN; column.missing += 1; continue; }
      const parsed = toNumber(cell, format.decimalComma);
      if (parsed.value !== undefined) column.values[i] = parsed.value;
      else {
        column.values[i] = Number.NaN;
        if (parsed.missing) column.missing += 1;
        else {
          column.bad += 1;
          if (column.firstBad === null) column.firstBad = { row: i + (hasHeader ? 2 : 1), cell: cell.trim().slice(0, 30) };
        }
      }
    }
  }
  if (ragged) problems.push(`${ragged.toLocaleString('en-US')} row${ragged === 1 ? ' has' : 's have'} a different number of cells than the header (${width}); missing cells are empty.`);
  // Duplicate names get " (2)".
  const seen = new Map();
  for (const c of columns) {
    const k = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, k);
    if (k > 1) {
      notes.push(`Two columns are named "${c.name}"; the second is called "${c.name} (${k})".`);
      c.name = `${c.name} (${k})`;
    }
  }
  for (const c of columns) describeColumn(c, n);
  return { fileName, format: { ...format, header: hasHeader }, rows: n, columns, notes, problems };
}

function describeColumn(c, n) {
  let min = Infinity;
  let max = -Infinity;
  let negatives = 0;
  let integers = true;
  let zeros = 0;
  let stepOne = true;
  const distinct = new Set();
  let previous = null;
  for (let i = 0; i < n; i += 1) {
    const v = c.values[i];
    if (!Number.isFinite(v)) { stepOne = false; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
    if (v < 0) negatives += 1;
    if (v === 0) zeros += 1;
    if (integers && !Number.isInteger(v)) integers = false;
    if (distinct.size <= 64) distinct.add(v);
    if (previous !== null && v !== previous + 1) stepOne = false;
    previous = v;
  }
  const finite = n - c.missing - c.bad;
  Object.assign(c, { min, max, negatives, integers, zeros, distinct, finite });
  c.constant = finite > 0 && min === max;
  c.eventNumber = finite === n && integers && stepOne && (c.values[0] === 0 || c.values[0] === 1);
  c.labels = !c.eventNumber && finite >= 0.99 * n && integers && distinct.size <= 64 && distinct.size > 1 && n >= 20 * distinct.size && min >= -1;
  const kind = classifyChannel(c.name, c.marker);
  c.kind = c.eventNumber || c.labels ? 'other' : kind === 'instrument' ? 'other' : kind;
  // Scales: linear for scatter, time and others; values already transformed (small, often
  // negative or fractional) linear over their range; counts with many zeros (mass cytometry)
  // arcsinh; other intensities logicle.
  if (c.kind === 'scatter' || c.kind === 'time' || c.kind === 'other') c.scale = 'linear';
  else if (max <= 20 && (negatives > 0 || !integers)) c.scale = 'transformed';
  else if (integers && zeros / Math.max(1, finite) > 0.2) c.scale = 'arcsinh';
  else c.scale = 'logicle';
  c.include = finite > 0 && !c.eventNumber;
  c.note = c.bad ? `${c.bad.toLocaleString('en-US')} value${c.bad === 1 ? ' is' : 's are'} not a number (row ${c.firstBad.row}: "${c.firstBad.cell}")`
    : c.eventNumber ? 'an event number (1, 2, 3 …): left out'
      : c.labels ? `${distinct.size} whole numbers: labels such as clusters or samples`
        : c.constant ? `the same value in every row (${min})`
          : c.scale === 'transformed' ? `already transformed (${+min.toPrecision(3)} to ${+max.toPrecision(3)}): a linear scale`
            : c.missing ? `${c.missing.toLocaleString('en-US')} empty`
              : '';
}

// $PnR for a column: the next whole number above transformed values and small numbers; for
// intensities the usual ranges, 1,024 (10-bit) or 262,144 (18-bit), or a power of two above them.
export function rangeFor(column) {
  if (!Number.isFinite(column.max)) return 1;
  if (column.scale === 'transformed' || column.max <= 64) return Math.max(1, Math.ceil(column.max + 1));
  if (column.max < 1024) return 1024;
  if (column.max < 262144) return 262144;
  return 2 ** Math.ceil(Math.log2(column.max + 1));
}

// The scale a column is shown on.
export function scaleFor(column, technology = 'conventional') {
  const range = rangeFor(column);
  if (column.scale === 'linear' || column.scale === 'transformed') {
    const lo = Math.min(0, column.min);
    const hi = column.max > lo ? column.max : lo + 1;
    return column.scale === 'transformed' ? { type: 'linear', min: +column.min.toPrecision(6), max: +hi.toPrecision(6) } : { type: 'linear', min: lo, max: hi };
  }
  if (column.scale === 'arcsinh') return { type: 'arcsinh', cofactor: 5, min: -5 * Math.sinh(1), max: Math.max(1000, column.max * 1.2) };
  return defaultTransform({ type: 'fluorescence', range }, technology, column.values);
}

// The events as FCS data (writeFCS), one dataset per sample: all rows, or with splitBy (a column
// index) one per value of that column, named "<file> <column> <value>". Rows with a value missing
// in an included column are left out (counted). Returns { datasets: [{ name, parameters, data,
// keywords, scales }], dropped }.
export function csvDatasets(analysis, options = {}) {
  const included = analysis.columns.filter((c) => c.include && (options.splitBy === undefined || c.index !== options.splitBy));
  if (!included.length) throw new Error('Choose at least one column to import.');
  const n = analysis.rows;
  const keep = new Uint8Array(n).fill(1);
  let dropped = 0;
  for (let i = 0; i < n; i += 1) {
    if (included.some((c) => !Number.isFinite(c.values[i]))) {
      keep[i] = 0;
      dropped += 1;
    }
  }
  const base = analysis.fileName.replace(/\.(csv|tsv|txt)$/i, '');
  const groups = new Map();
  const split = options.splitBy === undefined ? null : analysis.columns[options.splitBy];
  for (let i = 0; i < n; i += 1) {
    if (!keep[i]) continue;
    const key = split ? split.values[i] : 'all';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const keys = [...groups.keys()];
  if (split) keys.sort((a, b) => a - b);
  const datasets = keys.map((key) => {
    const rows = groups.get(key);
    const name = split ? `${base} ${split.name} ${key}` : base;
    const parameters = included.map((c) => ({ name: c.name, label: c.marker || '', range: rangeFor(c) }));
    const data = included.map((c) => Float32Array.from(rows, (i) => c.values[i]));
    const keywords = {
      $FIL: `${name}.fcs`,
      $SRC: analysis.fileName,
      $COM: `Converted by CytoWeave from ${analysis.fileName}${split ? ` (rows with ${split.name} = ${key})` : ''}.`,
      CYTOWEAVE_CSV: analysis.fileName,
    };
    return { name, parameters, data, keywords, scales: Object.fromEntries(included.map((c) => [c.name, c.scale])), rows: rows.length };
  });
  return { datasets, dropped, columns: included.map((c) => c.name) };
}
