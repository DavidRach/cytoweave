// Index sorting: which well of a plate each sorted event went to.
//
// Sorters record it in one of two ways, both read here:
//   - BD FACSDiva (FACSAria, FACSMelody): the keyword INDEX SORTING LOCATIONS lists "row,column;"
//     pairs, 0-based, one per event in event order; INDEX SORTING DEVICE TYPE names the plate
//     ("96 Well - U bottom").
//   - Event parameters for the column and row (for example "Index X" and "Index Y", or "Well
//     Column" and "Well Row"), 1-based unless a value is 0.
// readIndexSort returns { rows, columns, wells (Int32Array: row × columns + column per event, −1
// for none), source, plate, notes }, or null when the file has no index-sort data.

const PLATES = [
  { wells: 6, rows: 2, columns: 3 },
  { wells: 12, rows: 3, columns: 4 },
  { wells: 24, rows: 4, columns: 6 },
  { wells: 48, rows: 6, columns: 8 },
  { wells: 96, rows: 8, columns: 12 },
  { wells: 384, rows: 16, columns: 24 },
  { wells: 1536, rows: 32, columns: 48 },
];

const COLUMN_NAME = /^(index[\s_-]*(x|col(umn)?)|(well|sort)[\s_-]*col(umn)?|col(umn)?)$/i;
const ROW_NAME = /^(index[\s_-]*(y|row)|(well|sort)[\s_-]*row|row)$/i;

function keyword(keywords, name) {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(keywords ?? {})) if (key.toUpperCase() === wanted) return value;
  return undefined;
}

// The smallest standard plate holding the positions (or named by the sorter's device type).
export function plateFor(maxRow, maxColumn, deviceType = '') {
  const named = /(\d+)\s*-?\s*well/i.exec(deviceType ?? '');
  const byName = named && PLATES.find((p) => p.wells === Number(named[1]));
  if (byName && maxRow < byName.rows && maxColumn < byName.columns) return byName;
  return PLATES.find((p) => maxRow < p.rows && maxColumn < p.columns) ?? { wells: (maxRow + 1) * (maxColumn + 1), rows: maxRow + 1, columns: maxColumn + 1 };
}

// "A1" … "H12"; rows past Z continue AA, AB, … (1536-well plates).
export function wellName(row, column) {
  const letters = row < 26 ? String.fromCharCode(65 + row) : String.fromCharCode(64 + Math.floor(row / 26)) + String.fromCharCode(65 + (row % 26));
  return `${letters}${column + 1}`;
}

// dataset: { eventCount, keywords, parameters: [{ name, index }], data: [columns] } (as parseFCS gives).
export function readIndexSort(dataset) {
  const n = dataset.eventCount;
  const notes = [];
  const deviceType = String(keyword(dataset.keywords, 'INDEX SORTING DEVICE TYPE') ?? '');
  const locations = keyword(dataset.keywords, 'INDEX SORTING LOCATIONS');
  let positions = null;
  let source = null;
  if (locations !== undefined && String(locations).trim()) {
    const pairs = String(locations).split(';').map((s) => s.trim()).filter(Boolean).map((pair) => pair.split(',').map((v) => Number.parseInt(v, 10)));
    if (pairs.every((p) => p.length === 2 && p.every((v) => Number.isInteger(v) && v >= 0))) {
      positions = pairs;
      source = 'INDEX SORTING LOCATIONS';
      if (pairs.length !== n) notes.push(`INDEX SORTING LOCATIONS lists ${pairs.length} wells for ${n} events; ${pairs.length < n ? `the last ${n - pairs.length} events have no well` : `the extra ${pairs.length - n} wells were ignored`}.`);
    } else {
      notes.push('INDEX SORTING LOCATIONS could not be read as "row,column;" pairs.');
    }
  }
  if (!positions) {
    const column = dataset.parameters.find((p) => COLUMN_NAME.test(p.name.trim()));
    const row = dataset.parameters.find((p) => ROW_NAME.test(p.name.trim()));
    if (!column || !row) return null;
    const cs = dataset.data[column.index];
    const rs = dataset.data[row.index];
    let zero = false;
    for (let e = 0; e < n; e += 1) if (cs[e] === 0 || rs[e] === 0) zero = true;
    const offset = zero ? 0 : 1;
    positions = [];
    for (let e = 0; e < n; e += 1) {
      const r = Math.round(rs[e]) - offset;
      const c = Math.round(cs[e]) - offset;
      positions.push(Number.isFinite(r) && Number.isFinite(c) && r >= 0 && c >= 0 ? [r, c] : null);
    }
    source = `${column.name} and ${row.name}`;
    if (zero) notes.push(`${column.name} and ${row.name} contain 0, so they were read as 0-based.`);
  }
  let maxRow = 0;
  let maxColumn = 0;
  for (const p of positions) {
    if (!p) continue;
    maxRow = Math.max(maxRow, p[0]);
    maxColumn = Math.max(maxColumn, p[1]);
  }
  const plate = plateFor(maxRow, maxColumn, deviceType);
  const wells = new Int32Array(n).fill(-1);
  for (let e = 0; e < Math.min(n, positions.length); e += 1) {
    const p = positions[e];
    if (p) wells[e] = p[0] * plate.columns + p[1];
  }
  // Wells that received more than one event.
  const counts = new Map();
  for (const w of wells) if (w >= 0) counts.set(w, (counts.get(w) ?? 0) + 1);
  const shared = [...counts].filter(([, c]) => c > 1).map(([w]) => wellName(Math.floor(w / plate.columns), w % plate.columns));
  if (shared.length) notes.push(`${shared.length} well${shared.length === 1 ? '' : 's'} received more than one event: ${shared.slice(0, 8).join(', ')}${shared.length > 8 ? '…' : ''}.`);
  return { rows: plate.rows, columns: plate.columns, wells, source, plate: deviceType || `${plate.wells}-well plate`, notes };
}

// Events by well: an array of rows × columns lists of event indices.
export function eventsByWell(sort) {
  const out = Array.from({ length: sort.rows * sort.columns }, () => []);
  sort.wells.forEach((w, e) => { if (w >= 0 && w < out.length) out[w].push(e); });
  return out;
}
