// Plates: samples acquired from the wells of a plate (one file per well), the plate's layout (what
// each well holds: a compound at a dose, a control, a standard) and statistics across its wells.
//
// A sample's well comes from its annotations (meta.well, meta.plate), else its keywords (FCS 3.1's
// $WELLID, $PLATENAME and $PLATEID; BD's WELL ID, PLATE NAME and PLATE ID), else its file name
// ("Plate1_A01.fcs", "…-B7"), which is trusted only when one part of every unplaced name reads as a
// well and no two samples land in the same well. Layouts are CSV: one row per well (a "well"
// column, an optional "plate" column and one column per field) or plate maps, one block per field
// with rows A, B, … and columns 1, 2, … as R's plater reads them (Hughes 2016,
// doi:10.21105/joss.00106).
//
// Z′ (Zhang, Chung & Oldenburg 1999, doi:10.1177/108705719900400206) measures how well a screen
// separates its positive and negative controls: 1 − 3 (σ₊ + σ₋) / |μ₊ − μ₋|; 0.5 or more is an
// excellent assay, below 0 the controls overlap. The robust form uses medians and 1.4826 × MAD.

import { plateFor, wellName } from './indexsort.js';

export { wellName };

export const REFERENCES = {
  zPrime: 'Zhang JH, Chung TDY, Oldenburg KR. A simple statistical parameter for use in evaluation and validation of high throughput screening assays. J Biomol Screen. 1999;4(2):67–73. doi:10.1177/108705719900400206',
  plater: 'Hughes S. plater: Read, Tidy, and Display Data from Microtiter Plates. J Open Source Softw. 2016;1(7):106. doi:10.21105/joss.00106',
};

// Plate formats a flow cytometer's plate loader takes (smallest that holds the wells is used).
const FORMATS = [96, 384, 1536];

function rowIndex(letters) {
  const up = letters.toUpperCase();
  if (up.length === 1) return up.charCodeAt(0) - 65;
  // AA … AF continue after Z (1536-well plates).
  return 26 * (up.charCodeAt(0) - 64) + (up.charCodeAt(1) - 65);
}

// "A1", "A01", "a001", "B-7", "AF48", "R01C01" → { row, column } (0-based), or null.
export function parseWell(text) {
  const s = String(text ?? '').trim();
  let m = /^([A-Za-z]{1,2})[\s_-]?0*(\d{1,3})$/.exec(s);
  if (m) {
    const row = rowIndex(m[1]);
    const column = Number(m[2]) - 1;
    if (row >= 0 && row < 32 && column >= 0 && column < 48) return { row, column };
    return null;
  }
  m = /^r0*(\d{1,2})c0*(\d{1,2})$/i.exec(s);
  if (m) {
    const row = Number(m[1]) - 1;
    const column = Number(m[2]) - 1;
    if (row >= 0 && row < 32 && column >= 0 && column < 48) return { row, column };
  }
  return null;
}

// "A01"-style names, as plate readers and layout files write them.
export function paddedWellName(row, column, width = 2) {
  return wellName(row, 0).replace(/\d+$/, '') + String(column + 1).padStart(width, '0');
}

function keyword(keywords, names) {
  for (const name of names) {
    for (const [key, value] of Object.entries(keywords ?? {})) if (key.toUpperCase() === name && String(value).trim()) return String(value).trim();
  }
  return null;
}

const WELL_KEYWORDS = ['$WELLID', 'WELL ID', 'WELL'];
// Names before IDs: the plate a lab would recognize.
const PLATE_KEYWORDS = ['$PLATENAME', 'PLATE NAME', '$PLATEID', 'PLATE ID'];

function nameTokens(name) {
  return String(name ?? '').replace(/\.(fcs|lmd)$/i, '').split(/[_\-\s.]+/).filter(Boolean);
}

// Where each sample sits: { sampleId, plate, row, column, well, source } for every sample with a
// well. Annotations first, keywords next, names last (see the header).
export function sampleWells(samples) {
  const out = new Map();
  const unplaced = [];
  for (const s of samples) {
    const metaWell = parseWell(s.meta?.well);
    const keyWell = metaWell ? null : parseWell(keyword(s.keywords, WELL_KEYWORDS) ?? s.acquisition?.well);
    const plate = s.meta?.plate ?? keyword(s.keywords, PLATE_KEYWORDS) ?? s.acquisition?.plate ?? null;
    const at = metaWell ?? keyWell;
    if (at) out.set(s.id, { sampleId: s.id, plate: plate ? String(plate) : null, ...at, well: wellName(at.row, at.column), source: metaWell ? 'annotation' : 'keyword' });
    else unplaced.push(s);
  }
  // Names: the position (counted from the end, where wells usually are) at which every unplaced
  // name reads as a well; the parts before it (when they differ) name the plate.
  if (unplaced.length) {
    const tokens = unplaced.map((s) => nameTokens(s.name));
    const width = Math.min(...tokens.map((t) => t.length));
    for (let back = 1; back <= width; back += 1) {
      const wells = tokens.map((t) => parseWell(t[t.length - back]));
      if (!wells.every(Boolean)) continue;
      const plates = tokens.map((t) => t.slice(0, t.length - back).join('_'));
      const plateOf = (i) => unplaced[i].meta?.plate ?? keyword(unplaced[i].keywords, PLATE_KEYWORDS) ?? (new Set(plates).size > 1 ? plates[i] : null);
      const seen = new Set();
      let unique = true;
      wells.forEach((w, i) => {
        const key = `${plateOf(i)}|${w.row}|${w.column}`;
        if (seen.has(key)) unique = false;
        seen.add(key);
      });
      if (!unique) continue;
      wells.forEach((w, i) => {
        const p = plateOf(i);
        out.set(unplaced[i].id, { sampleId: unplaced[i].id, plate: p ? String(p) : null, ...w, well: wellName(w.row, w.column), source: 'name' });
      });
      break;
    }
  }
  return out;
}

// The plates of a workspace's samples: [{ name, rows, columns, format, wells: [[sampleIds] per
// row × column], placed: [{ sampleId, row, column, well, source }], duplicates: [well names] }],
// by name. Samples without a plate share one called "Plate".
export function platesOf(samples, options = {}) {
  const wells = sampleWells(samples);
  const groups = new Map();
  for (const placed of wells.values()) {
    const name = placed.plate ?? 'Plate';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(placed);
  }
  const plates = [];
  for (const [name, placed] of groups) {
    const maxRow = Math.max(...placed.map((p) => p.row));
    const maxColumn = Math.max(...placed.map((p) => p.column));
    const wanted = options.formats?.[name];
    const format = FORMATS.map((w) => plateFor(0, 0, `${w}-well`)).find((f) => (!wanted || f.wells >= wanted) && maxRow < f.rows && maxColumn < f.columns) ?? plateFor(maxRow, maxColumn);
    const grid = Array.from({ length: format.rows * format.columns }, () => []);
    for (const p of placed) grid[p.row * format.columns + p.column].push(p.sampleId);
    const duplicates = grid.map((ids, i) => (ids.length > 1 ? wellName(Math.floor(i / format.columns), i % format.columns) : null)).filter(Boolean);
    plates.push({ name, rows: format.rows, columns: format.columns, format: format.wells, wells: grid, placed: placed.sort((a, b) => a.row - b.row || a.column - b.column), duplicates });
  }
  return plates.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// --- Layouts ----------------------------------------------------------------------------------------

function splitLine(line, delimiter) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(field.trim());
      field = '';
    } else field += ch;
  }
  out.push(field.trim());
  return out;
}

function rowsOf(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const sample = lines.filter((l) => l.trim()).slice(0, 5).join('\n');
  const counts = [',', ';', '\t'].map((d) => [d, sample.split(d).length]);
  const delimiter = counts.sort((a, b) => b[1] - a[1])[0][0];
  return lines.map((l) => (l.trim() ? splitLine(l, delimiter) : null));
}

const WELL_HEADER = /^(well|wells|well ?id|wellid|well name|position)$/i;
const PLATE_HEADER = /^(plate|plate ?id|plate ?name|plateid|platename)$/i;

// Field names as annotations: lower-case words ("Compound", "Dose (nM)" → "compound", "dose (nM)").
export function fieldName(header) {
  const text = String(header).trim();
  return text.length && text === text.toUpperCase() && text !== text.toLowerCase() ? text.toLowerCase() : text.charAt(0).toLowerCase() + text.slice(1);
}

// Reads a layout CSV. Returns { format: 'wells' | 'map', fields, entries: [{ plate, row, column,
// well, values: { field: value } }], warnings }. Blank cells are left out.
export function parseLayout(text) {
  const rows = rowsOf(text);
  const warnings = [];
  const first = rows.find(Boolean);
  if (!first) throw new Error('The layout is empty.');
  const wellAt = first.findIndex((c) => WELL_HEADER.test(c));
  if (wellAt >= 0) {
    const plateAt = first.findIndex((c) => PLATE_HEADER.test(c));
    const fields = first.map((c, i) => (i === wellAt || i === plateAt || !c ? null : fieldName(c)));
    const entries = [];
    for (const row of rows.slice(rows.indexOf(first) + 1)) {
      if (!row || !row[wellAt]) continue;
      const at = parseWell(row[wellAt]);
      if (!at) {
        warnings.push(`"${row[wellAt]}" is not a well.`);
        continue;
      }
      const values = {};
      fields.forEach((f, i) => { if (f && row[i] !== undefined && row[i] !== '') values[f] = row[i]; });
      entries.push({ plate: plateAt >= 0 && row[plateAt] ? row[plateAt] : null, ...at, well: wellName(at.row, at.column), values });
    }
    return { format: 'wells', fields: fields.filter(Boolean), entries, warnings };
  }
  // Plate maps: a header row (field name, then 1, 2, …), then rows starting A, B, ….
  const byWell = new Map();
  const fields = [];
  let field = null;
  let columns = null;
  for (const row of rows) {
    if (!row) {
      field = null;
      continue;
    }
    const numbers = row.slice(1).map((c) => (c === '' ? null : Number(c)));
    if (!field && row.slice(1).some((c) => c !== '') && numbers.every((v, i) => v === null || v === i + 1)) {
      field = fieldName(row[0] || `field ${fields.length + 1}`);
      if (!fields.includes(field)) fields.push(field);
      columns = numbers;
      continue;
    }
    if (!field) continue;
    const letters = /^[A-Za-z]{1,2}$/.test(row[0]) ? row[0] : null;
    if (!letters) {
      warnings.push(`A row starting "${row[0]}" in the map of ${field} was skipped.`);
      continue;
    }
    const r = rowIndex(letters);
    row.slice(1).forEach((value, k) => {
      if (value === '' || !columns[k]) return;
      const key = `${r}|${columns[k] - 1}`;
      if (!byWell.has(key)) byWell.set(key, { plate: null, row: r, column: columns[k] - 1, well: wellName(r, columns[k] - 1), values: {} });
      byWell.get(key).values[field] = value;
    });
  }
  if (!fields.length) throw new Error('No "well" column and no plate map (a row of column numbers 1, 2, 3, … under a field name) was found.');
  return { format: 'map', fields, entries: [...byWell.values()].sort((a, b) => a.row - b.row || a.column - b.column), warnings };
}

// Annotation changes a layout makes on a plate's samples: { changes: { sampleId: { field: value } },
// matched, unmatched (layout wells without a sample), otherPlates }. Entries naming another plate
// are left for that plate; the well (and plate) are recorded too, so the samples keep their place.
export function layoutChanges(layout, plate, samplesById = null) {
  const changes = {};
  let matched = 0;
  const unmatched = [];
  let otherPlates = 0;
  for (const entry of layout.entries) {
    if (entry.plate && plate.name !== 'Plate' && entry.plate !== plate.name) {
      otherPlates += 1;
      continue;
    }
    if (entry.row >= plate.rows || entry.column >= plate.columns) {
      unmatched.push(entry.well);
      continue;
    }
    const ids = plate.wells[entry.row * plate.columns + entry.column];
    if (!ids.length) {
      unmatched.push(entry.well);
      continue;
    }
    for (const id of ids) {
      const sample = samplesById?.get(id);
      // The well is recorded unless the sample's annotation already names it (as "A01", say).
      const current = parseWell(sample?.meta?.well);
      const named = current && current.row === entry.row && current.column === entry.column;
      changes[id] = { ...entry.values, ...(named ? {} : { well: entry.well }), ...(plate.name !== 'Plate' && !sample?.meta?.plate ? { plate: plate.name } : {}) };
    }
    matched += 1;
  }
  return { changes, matched, unmatched, otherPlates };
}

function quote(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A plate's layout as CSV, one row per well with a sample: plate, well, then the fields.
export function layoutCSV(plate, samplesById, fields) {
  const lines = [['plate', 'well', 'sample', ...fields].map(quote).join(',')];
  for (const p of plate.placed) {
    const s = samplesById.get(p.sampleId);
    lines.push([plate.name, paddedWellName(p.row, p.column), s?.name ?? '', ...fields.map((f) => s?.meta?.[f] ?? '')].map(quote).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// --- Doses -------------------------------------------------------------------------------------------

const PREFIX = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, μ: 1e-6, m: 1e-3, '': 1 };
const DIMENSIONS = [
  { re: /^([pnuµμm]?)M$/, base: 'M' },
  { re: /^([pnuµμm]?)g\/m[lL]$/, base: 'g/mL' },
  { re: /^([pnuµμm]?)g\/[lL]$/, base: 'g/L' },
  { re: /^([pnuµμm]?)[lL]$/, base: 'L' },
  { re: /^(%)$/, base: '%' },
  { re: /^(U\/m[lL])$/, base: 'U/mL' },
];

// "10 nM", "1e-6 M", "0.5 µg/mL", "3" → { value, unit, base: value in the dimension's base unit,
// dimension }, or null. Units are kept as written; base values let mixed units be compared.
export function parseQuantity(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? { value: text, unit: '', base: text, dimension: '' } : null;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(\S*)\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const value = Number(m[1]);
  const unit = m[2] ?? '';
  if (!unit) return { value, unit: '', base: value, dimension: '' };
  for (const d of DIMENSIONS) {
    const u = d.re.exec(unit);
    if (u) {
      const factor = d.base === '%' || d.base === 'U/mL' ? 1 : PREFIX[u[1]] ?? 1;
      return { value, unit, base: value * factor, dimension: d.base };
    }
  }
  return { value, unit, base: value, dimension: unit };
}

// Doses of several wells on one scale: the unit most wells use (values in other units of the same
// dimension converted). Returns { unit, values (per input, NaN when unreadable or of another
// dimension) }.
export function commonDoses(texts) {
  const parsed = texts.map(parseQuantity);
  const units = new Map();
  for (const p of parsed) if (p) units.set(`${p.dimension}|${p.unit}`, (units.get(`${p.dimension}|${p.unit}`) ?? 0) + 1);
  const top = [...units].sort((a, b) => b[1] - a[1])[0];
  if (!top) return { unit: '', values: texts.map(() => Number.NaN) };
  const [dimension, unit] = top[0].split('|');
  const reference = parsed.find((p) => p && p.unit === unit && p.dimension === dimension);
  const factor = reference && reference.value !== 0 ? reference.base / reference.value : 1;
  return { unit, values: parsed.map((p) => (p && p.dimension === dimension ? p.base / factor : Number.NaN)) };
}

// --- Screens -----------------------------------------------------------------------------------------

function meanSD(values) {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : Number.NaN;
  return { mean, sd };
}

function medianMAD(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const median = (arr) => (arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2);
  const m = median(sorted);
  const mad = median(sorted.map((v) => Math.abs(v - m)).sort((a, b) => a - b));
  return { mean: m, sd: 1.4826 * mad };
}

// Z′ of positive and negative control values. options.robust: medians and 1.4826 × MAD. Returns
// { z, positive { n, mean, sd }, negative { n, mean, sd }, window: |μ₊ − μ₋|, robust, rating }.
export function zPrime(positive, negative, options = {}) {
  const p = positive.filter(Number.isFinite);
  const n = negative.filter(Number.isFinite);
  if (p.length < 2 || n.length < 2) return null;
  const summary = options.robust ? medianMAD : meanSD;
  const sp = summary(p);
  const sn = summary(n);
  const window = Math.abs(sp.mean - sn.mean);
  const z = window > 0 ? 1 - (3 * (sp.sd + sn.sd)) / window : Number.NEGATIVE_INFINITY;
  const rating = z >= 0.5 ? 'excellent' : z > 0 ? 'marginal' : 'controls overlap';
  return { z, positive: { n: p.length, ...sp }, negative: { n: n.length, ...sn }, window, robust: Boolean(options.robust), rating };
}

// A well's control role from an annotation value: positive ("pos", "positive", "+", "max", "high
// control") or negative ("neg", "negative", "-", "min", "low control"), or null. Words such as
// "vehicle" or "DMSO" are not guessed (vehicle is the positive control of an inhibition screen and
// the negative one of an activation screen): name them with options { positive: [...],
// negative: [...] }, which replace the defaults.
export function controlRole(value, options = {}) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (options.positive?.length) {
    if (options.positive.map((s) => s.toLowerCase()).includes(v)) return 'positive';
    if (options.negative?.map((s) => s.toLowerCase()).includes(v)) return 'negative';
    return null;
  }
  if (/^(pos|positive|\+|max|maximum|high|high control|positive control|pc)$/.test(v)) return 'positive';
  if (/^(neg|negative|-|min|minimum|low|low control|negative control|nc)$/.test(v)) return 'negative';
  return null;
}
