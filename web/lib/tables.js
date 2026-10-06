// Tables: batch statistics across samples. A table's columns are population × statistic
// (× channel), its rows the samples of a group. These functions compute what the Tables view
// shows, for the view itself, Compare, spreadsheets, reports and agents: column labels, values,
// each value's detection-limit status, and the rows. viewOf(sampleId) gives a loaded sample's
// view (or null).

import { computeStatistic } from './engine.js';
import { STATISTICS, formatStatistic } from './stats.js';
import { ROOT, channelLabel, gateById, gatePath } from './workspace.js';
import { classifyValue, detectionLimits, eventsNeeded } from './rare-events.js';

export function columnLabel(ws, column) {
  if (column.label) return column.label;
  const population = column.gateId && column.gateId !== ROOT ? gateById(ws, column.gateId)?.name ?? '(deleted)' : 'All events';
  const stat = STATISTICS.find((s) => s.id === column.stat)?.label ?? column.stat;
  const channel = column.channel ? ` ${channelLabel(ws, column.channel, { short: true })}` : '';
  const value = column.value !== undefined && column.value !== null && column.stat === 'percentile' ? ` P${column.value}` : column.stat === 'positive' ? ` ≥ ${column.value}` : '';
  const ancestor = column.stat === 'freqOf' ? ` of ${column.ancestorId && column.ancestorId !== ROOT ? gateById(ws, column.ancestorId)?.name : 'all events'}` : '';
  return `${population}: ${stat}${channel}${value}${ancestor}${controlLabel(ws, column)}${countingLabel(ws, column)}`;
}

// " (beads: Counting beads, 50,000 in 50 µL; dilution ×2)".
function countingLabel(ws, column) {
  const parts = [];
  if (column.counting?.beadGateId) {
    const beads = column.counting.beadGateId === ROOT ? 'all events' : gateById(ws, column.counting.beadGateId)?.name ?? '(deleted)';
    parts.push(`beads: ${beads}, ${Number(column.counting.beads).toLocaleString('en-US')} in ${column.counting.volume} µL`);
  }
  if (typeof column.dilution === 'number' && column.dilution !== 1) parts.push(`dilution ×${column.dilution}`);
  else if (column.dilution?.field) parts.push(`dilution from "${column.dilution.field}"`);
  return parts.length ? ` (${parts.join('; ')})` : '';
}

// " (control: FMO CD25)", or with another population " (control: FMO CD25, Lymphocytes)".
function controlLabel(ws, column) {
  if (!column.control?.sampleId) return '';
  const sample = ws.samples.find((s) => s.id === column.control.sampleId)?.name ?? '(removed sample)';
  const gateId = column.control.gateId;
  const population = gateId && gateId !== column.gateId ? `, ${gateId === ROOT ? 'all events' : gateById(ws, gateId)?.name ?? '(deleted)'}` : '';
  return ` (control: ${sample}${population})`;
}

// A column's definition in words, field by field (for a workbook's column sheet): population (its
// path), statistic, channel, value, relative to, control, counting beads, dilution, limits.
export function columnDefinition(ws, column) {
  const stat = STATISTICS.find((s) => s.id === column.stat);
  const path = (id) => (!id || id === ROOT ? 'All events' : gateById(ws, id) ? gatePath(ws, id) : '(deleted)');
  const control = column.control?.sampleId ? `${ws.samples.find((s) => s.id === column.control.sampleId)?.name ?? '(removed sample)'}${column.control.gateId && column.control.gateId !== column.gateId ? `, ${path(column.control.gateId)}` : ''}` : '';
  const counting = column.counting?.beadGateId ? `${path(column.counting.beadGateId)}: ${column.counting.beads} beads in the tube, ${column.counting.volume} µL of sample` : '';
  const dilution = typeof column.dilution === 'number' ? String(column.dilution) : column.dilution?.field ? `annotation "${column.dilution.field}"` : '';
  const limits = column.limits?.blankIds?.length ? `${column.limits.blankIds.length} blank(s), ${column.limits.lowIds?.length ?? 0} low-level sample(s), ${column.limits.method ?? 'parametric'}, target CV ${column.limits.cvTarget ?? 20}%` : '';
  return {
    population: path(column.gateId),
    statistic: stat?.label ?? column.stat,
    statisticId: column.stat,
    channel: column.channel ? channelLabel(ws, column.channel) : '',
    value: column.value ?? '',
    relativeTo: column.stat === 'freqOf' ? path(column.ancestorId) : '',
    control,
    counting,
    dilution,
    limits,
  };
}

// Samples to offer as a comparison's control, the controls (FMO, isotype, unstained) first.
export function controlSampleOptions(ws) {
  const rank = { fmo: 0, isotype: 1, unstained: 2 };
  return ws.samples.slice().sort((a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3)).map((s) => ({ value: s.id, label: s.role && s.role !== 'sample' ? `${s.name} (${s.role === 'fmo' ? 'FMO' : s.role})` : s.name }));
}

export function statisticSpec(column) {
  return { stat: column.stat, gateId: column.gateId ?? ROOT, channel: column.channel, ancestorId: column.ancestorId, value: column.value, control: column.control, counting: column.counting, dilution: column.dilution };
}

// A column's value in a loaded sample (NaN where it cannot be computed).
export function columnValue(ws, column, view, viewOf) {
  if (!view) return Number.NaN;
  try {
    return computeStatistic(view, ws, statisticSpec(column), { viewOf });
  } catch {
    return Number.NaN;
  }
}

// Columns that can carry detection limits: counts and frequencies.
export const LIMIT_STATISTICS = new Set(['count', 'freqParent', 'freqGrandparent', 'freqTotal', 'freqOf']);
export const LIMIT_STATUS = { 'not-detected': 'not detected', detected: 'below LLOQ', quantifiable: 'quantifiable' };
export const LIMIT_TAGS = { 'not-detected': 'ND', detected: '< LLOQ' };

// The limits of blank, detection and quantification of a count or frequency column from its blank
// and low-level samples (column.limits: { blankIds, lowIds, lowGroupBy, method, cvTarget }), and
// each sample's lower limit of quantification: the largest of the limit of detection, the
// precision profile's limit and the value that (100/cv)² events of the population take in that
// sample (Poisson counting). Null without limits or when none of the blanks is loaded.
export function columnLimits(ws, column, viewOf) {
  const spec = column.limits;
  if (!spec?.blankIds?.length || !LIMIT_STATISTICS.has(column.stat)) return null;
  const valueOf = (sampleId) => columnValue(ws, column, viewOf(sampleId), viewOf);
  const blanks = spec.blankIds.map(valueOf).filter(Number.isFinite);
  if (!blanks.length) return null;
  const groups = new Map();
  let lowCount = 0;
  for (const id of spec.lowIds ?? []) {
    const value = valueOf(id);
    if (!Number.isFinite(value)) continue;
    lowCount += 1;
    const sample = ws.samples.find((s) => s.id === id);
    const key = spec.lowGroupBy ? String(sample?.meta?.[spec.lowGroupBy] ?? '') : 'low';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  const limits = detectionLimits(blanks, [...groups.values()], { method: spec.method ?? 'parametric', cvTarget: spec.cvTarget ?? 20 });
  const counted = eventsNeeded(limits.cvTarget).events;
  const loqOf = (sampleId) => {
    const candidates = [limits.loq, limits.lod];
    const view = viewOf(sampleId);
    if (view && column.stat === 'count') candidates.push(counted);
    else if (view) {
      const count = computeStatistic(view, ws, { stat: 'count', gateId: column.gateId ?? ROOT });
      const value = valueOf(sampleId);
      if (count > 0 && value > 0) candidates.push((value * counted) / count);
    }
    const finite = candidates.filter(Number.isFinite);
    return finite.length ? Math.max(...finite) : Number.NaN;
  };
  const missing = spec.blankIds.length + (spec.lowIds?.length ?? 0) - blanks.length - lowCount;
  return { limits, counted, loqOf, status: (sampleId, value) => classifyValue(value, { lob: limits.lob, loq: loqOf(sampleId) }), missing };
}

// A table's values for the loaded samples: Map(sampleId → values[]).
export function tableValues(ws, table, sampleIds, viewOf) {
  const out = new Map();
  for (const id of sampleIds) {
    const view = viewOf(id);
    if (!view) continue;
    out.set(id, table.columns.map((column) => columnValue(ws, column, view, viewOf)));
  }
  return out;
}

// A table's rows: the samples of its group (all samples without one), controls only when asked.
export function tableSamples(ws, table) {
  const group = table.groupId ? ws.groups.find((g) => g.id === table.groupId) : null;
  return ws.samples.filter((s) => (group ? group.sampleIds.includes(s.id) : true) && (table.includeControls || s.role === 'sample' || s.role === 'reference'));
}

// The samples a table's comparison columns need as controls, beyond its rows.
export function tableControlSamples(ws, table) {
  const ids = new Set(table.columns.map((c) => c.control?.sampleId).filter(Boolean));
  return ws.samples.filter((s) => ids.has(s.id));
}

// A table's cells as shown: { value, text (formatted), status (limits) } per sample and column,
// with the limits found once per column. Returns { columns: [{ column, label, limits }], cell }.
export function tableCells(ws, table, viewOf) {
  const columns = table.columns.map((column) => ({ column, label: columnLabel(ws, column), limits: column.limits ? columnLimits(ws, column, viewOf) : null }));
  const cell = (columnIndex, sampleId) => {
    const { column, limits } = columns[columnIndex];
    const value = columnValue(ws, column, viewOf(sampleId), viewOf);
    const status = limits && Number.isFinite(value) ? limits.status(sampleId, value) : null;
    return { value, text: formatStatistic(column.stat, value), status, tag: status ? LIMIT_TAGS[status] ?? '' : '' };
  };
  return { columns, cell };
}

// Rows of strings as delimited text: CSV (quoted where a cell holds a comma, quote or line break)
// or TSV; the Tables view's CSV export and agents' and runs' export_table write the same bytes.
export function delimitedText(rows, separator = ',') {
  const special = separator === '\t' ? /[\t"\n]/ : /[",\n]/;
  return rows.map((row) => row.map((cell) => {
    const text = cell === null || cell === undefined ? '' : String(cell);
    return special.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(separator)).join('\n');
}

// The table as rows of strings for CSV and the clipboard: sample, file, annotations, then each
// column (full precision, 8 significant digits), a column with limits followed by its status.
export function tableMatrix(ws, table, rows, viewOf) {
  const values = tableValues(ws, table, rows.map((s) => s.id), viewOf);
  const metaFields = [...new Set(rows.flatMap((s) => Object.keys(s.meta ?? {})))];
  const limitsOf = table.columns.map((column) => (column.limits ? columnLimits(ws, column, viewOf) : null));
  const header = ['Sample', 'File', ...metaFields, ...table.columns.flatMap((c, j) => (limitsOf[j] ? [columnLabel(ws, c), `${columnLabel(ws, c)}: status`] : [columnLabel(ws, c)]))];
  const lines = [header];
  for (const sample of rows) {
    const row = values.get(sample.id);
    lines.push([sample.name, sample.fileName, ...metaFields.map((f) => sample.meta?.[f] ?? ''), ...table.columns.flatMap((_, j) => {
      const finite = row && Number.isFinite(row[j]);
      const cell = finite ? String(+row[j].toPrecision(8)) : '';
      return limitsOf[j] ? [cell, finite ? LIMIT_STATUS[limitsOf[j].status(sample.id, row[j])] ?? '' : ''] : [cell];
    })]);
  }
  return lines;
}
