// Statistics for spreadsheets (R7): an Excel workbook of the workspace's tables with sheets that
// say where the numbers come from, and GraphPad Prism tables (column tables per group).
//
// Workbook: a sheet per table (sample, file, annotations, then each column's values at full
// precision; a column with detection limits followed by each value's status), then Columns (each
// column's definition: population path, statistic, channel, control, counting beads, dilution,
// limits and the limits found), Samples (file, SHA-256 checksum, events, role, compensation,
// instrument, acquisition date, annotations), Populations (the gating hierarchy) and About (the
// workspace, the export, and the methods paragraph).
//
// Prism: the table as one Prism table (a row per sample, a column per statistic), and with a
// grouping annotation, a column table per statistic with a column per group (its samples down it),
// the layout Prism's t tests and ANOVA take.

import { columnDefinition, columnLabel, columnLimits, LIMIT_STATUS, tableSamples, tableValues } from './tables.js';
import { ROOT, channelLabel, gatePath } from './workspace.js';
import { writeMethods } from './methods.js';

const header = (values) => values.map((value) => ({ value, style: 'header' }));

// The annotation fields some of the samples have, in first-seen order.
function annotationFields(samples) {
  return [...new Set(samples.flatMap((s) => Object.entries(s.meta ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k]) => k)))];
}

// The sheet of one table, and the values it holds (for tracing): { sheet, values: Map }.
export function tableSheet(ws, table, viewOf) {
  const rows = tableSamples(ws, table);
  const values = tableValues(ws, table, rows.map((s) => s.id), viewOf);
  const fields = annotationFields(rows);
  const limitsOf = table.columns.map((column) => (column.limits ? columnLimits(ws, column, viewOf) : null));
  const labels = table.columns.flatMap((c, j) => (limitsOf[j] ? [columnLabel(ws, c), `${columnLabel(ws, c)}: status`] : [columnLabel(ws, c)]));
  const out = [header(['Sample', 'File', ...fields, ...labels])];
  for (const sample of rows) {
    const row = values.get(sample.id);
    out.push([sample.name, sample.fileName ?? '', ...fields.map((f) => sample.meta?.[f] ?? ''), ...table.columns.flatMap((_, j) => {
      const v = row ? row[j] : Number.NaN;
      const cell = Number.isFinite(v) ? v : null;
      return limitsOf[j] ? [cell, Number.isFinite(v) ? LIMIT_STATUS[limitsOf[j].status(sample.id, v)] ?? '' : ''] : [cell];
    })]);
  }
  const unloaded = rows.filter((s) => !values.has(s.id)).length;
  return {
    sheet: { name: table.name, rows: out, widths: [28, 26, ...fields.map(() => 14), ...labels.map(() => 18)], freeze: { rows: 1, columns: 1 } },
    values,
    unloaded,
    limitsOf,
  };
}

// The workbook's sheets for tables (all of the workspace's by default). context: { version, date }.
// Returns { sheets, traced: [{ sheet, sample, column, value }], unloaded }.
export function tablesWorkbook(ws, tables, viewOf, context = {}) {
  const sheets = [];
  const traced = [];
  const definitions = [header(['Sheet', 'Column', 'Population', 'Statistic', 'Channel', 'Value', 'Relative to', 'Control', 'Counting beads', 'Dilution', 'Detection limits', 'Limit of blank', 'Limit of detection', 'Limit of quantification'])];
  let unloaded = 0;
  for (const table of tables) {
    const built = tableSheet(ws, table, viewOf);
    sheets.push(built.sheet);
    unloaded = Math.max(unloaded, built.unloaded);
    table.columns.forEach((column, j) => {
      const d = columnDefinition(ws, column);
      const limits = built.limitsOf[j]?.limits;
      definitions.push([table.name, columnLabel(ws, column), d.population, d.statistic, d.channel, d.value, d.relativeTo, d.control, d.counting, d.dilution, d.limits, limits?.lob ?? null, limits?.lod ?? null, limits?.loq ?? null]);
      for (const [sampleId, values] of built.values) {
        if (Number.isFinite(values[j])) traced.push({ sheet: table.name, sampleId, sample: ws.samples.find((s) => s.id === sampleId)?.name, column: columnLabel(ws, column), columnId: column.id, value: values[j] });
      }
    });
  }
  sheets.push({ name: 'Columns', rows: definitions, widths: [18, 34, 34, 22, 18, 8, 18, 22, 30, 12, 34, 12, 12, 12], freeze: { rows: 1 } });
  const used = new Set(tables.flatMap((t) => tableSamples(ws, t).map((s) => s.id)));
  for (const t of tables) for (const c of t.columns) if (c.control?.sampleId) used.add(c.control.sampleId);
  const samples = ws.samples.filter((s) => used.has(s.id));
  const fields = annotationFields(samples);
  const compensationName = (id) => (id === 'file' ? 'the file\'s own' : id === 'none' || !id ? 'none' : ws.compensations.find((c) => c.id === id)?.name ?? id);
  sheets.push({
    name: 'Samples',
    rows: [header(['Sample', 'File', 'SHA-256', 'Events', 'Role', 'Compensation', 'Cytometer', 'Acquired', ...fields]),
      ...samples.map((s) => [s.name, s.fileName ?? '', s.sha256 ?? '', s.eventCount ?? null, s.role ?? '', compensationName(s.compensationId), s.acquisition?.cytometer ?? '', s.acquisition?.dateTimeBegin || s.acquisition?.date || '', ...fields.map((f) => s.meta?.[f] ?? '')])],
    widths: [28, 26, 66, 10, 12, 18, 18, 20, ...fields.map(() => 14)],
    freeze: { rows: 1, columns: 1 },
  });
  sheets.push({
    name: 'Populations',
    rows: [header(['Population', 'Gate', 'Channels', 'Parent', 'Applies to']),
      ...ws.gates.map((g) => [gatePath(ws, g.id), g.type, (g.dims ?? []).map((d) => channelLabel(ws, d.channel)).join(' × '), g.parentId && g.parentId !== ROOT ? gatePath(ws, g.parentId) : 'All events', g.scope?.groupId ? ws.groups.find((x) => x.id === g.scope.groupId)?.name ?? '' : 'all samples'])],
    widths: [44, 12, 30, 34, 16],
    freeze: { rows: 1 },
  });
  const { paragraphs, references } = writeMethods(ws, { version: context.version });
  sheets.push({
    name: 'About',
    rows: [
      [{ value: 'CytoWeave tables', style: 'bold' }],
      ['Workspace', ws.name ?? ''],
      ['Exported', (context.date ?? new Date()).toISOString()],
      ['CytoWeave', context.version ?? ''],
      ['Tables', tables.map((t) => t.name).join(', ')],
      ['Values', { value: 'Each value is written in full, as CytoWeave computed it; Tables shows it rounded. Empty cells are values that could not be computed (an empty population, a sample not loaded).', style: 'wrap' }],
      ['Sheets', { value: 'One per table, then Columns (what each column is), Samples (files and their checksums), Populations (the gating hierarchy) and this sheet.', style: 'wrap' }],
      [],
      [{ value: 'Methods', style: 'bold' }],
      ...paragraphs.map((p) => ['', { value: p, style: 'wrap' }]),
      [],
      [{ value: 'References', style: 'bold' }],
      ...references.map((r, i) => [String(i + 1), { value: `${r.text}${r.doi ? ` doi:${r.doi}` : ''}`, style: 'wrap' }]),
    ],
    widths: [16, 110],
  });
  return { sheets, traced, unloaded };
}

// Prism decimals for a statistic: counts whole, the rest two places (display only; values stay full).
const decimalsOf = (stat) => (stat === 'count' || stat === 'countLow' || stat === 'countHigh' ? 0 : stat === 'ksD' ? 3 : 2);

// Prism tables of a Tables table. options: { groupBy }. Returns { tables, notes, traced }.
export function prismTables(ws, table, viewOf, options = {}) {
  const rows = tableSamples(ws, table);
  const values = tableValues(ws, table, rows.map((s) => s.id), viewOf);
  const loaded = rows.filter((s) => values.has(s.id));
  const notes = [];
  const traced = [];
  if (loaded.length < rows.length) notes.push(`${rows.length - loaded.length} sample(s) not loaded are left out.`);
  const title = (text) => String(text).slice(0, 100);
  const out = [{
    title: title(table.name),
    rowTitles: loaded.map((s) => s.name),
    columns: table.columns.map((column, j) => ({ title: title(columnLabel(ws, column)), decimals: decimalsOf(column.stat), values: loaded.map((s) => values.get(s.id)[j]) })),
  }];
  table.columns.forEach((column, j) => loaded.forEach((s) => {
    const v = values.get(s.id)[j];
    if (Number.isFinite(v)) traced.push({ table: out[0].title, sample: s.name, column: columnLabel(ws, column), value: v });
  }));
  if (options.groupBy) {
    const field = options.groupBy;
    const grouped = loaded.filter((s) => (s.meta?.[field] ?? '') !== '');
    if (grouped.length < loaded.length) notes.push(`${loaded.length - grouped.length} sample(s) without a "${field}" annotation are left out of the grouped tables.`);
    const groups = [...new Set(grouped.map((s) => String(s.meta[field])))];
    table.columns.forEach((column, j) => {
      const label = columnLabel(ws, column);
      out.push({
        title: title(label),
        columns: groups.map((g) => {
          const members = grouped.filter((s) => String(s.meta[field]) === g);
          for (const s of members) if (Number.isFinite(values.get(s.id)[j])) traced.push({ table: title(label), group: g, sample: s.name, column: label, value: values.get(s.id)[j] });
          return { title: title(g), decimals: decimalsOf(column.stat), values: members.map((s) => values.get(s.id)[j]) };
        }),
      });
    });
  }
  return { tables: out, notes, traced };
}

