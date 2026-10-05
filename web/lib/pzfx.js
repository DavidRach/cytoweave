// GraphPad Prism tables (.pzfx, Prism's XML project format) for statistics: "column" data tables
// (Prism's one-way layout, a column per group with replicates down it), optionally with row titles.
// The layout follows the files Prism writes (GraphPad's example files; the R package pzfx reads
// and writes the same): an info sheet, then each table's columns as <YColumn> with one
// <Subcolumn> of <d> values, a missing value an empty <d/>.
//
// writePZFX(tables, options) → string. tables: [{ title, rowTitles?: [string], columns: [{ title,
// values: [number | null], decimals }] }]. options: { date, notes, title }.

import { escapeText, escapeAttribute } from './xml.js';

const value = (v) => (typeof v === 'number' && Number.isFinite(v) ? `<d>${String(v)}</d>` : '<d/>');

function localStamp(date) {
  // Prism writes local time with its offset; UTC is written as +00:00.
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

export function writePZFX(tables, options = {}) {
  if (!tables.length) throw new Error('A Prism file needs at least one table.');
  const date = options.date ?? new Date();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<GraphPadPrismFile PrismXMLVersion="5.00">',
    '<Created>',
    `<OriginalVersion CreatedByProgram="CytoWeave" CreatedByVersion="${escapeAttribute(options.version ?? '')}" Login="" DateTime="${localStamp(date)}"></OriginalVersion>`,
    '</Created>',
    '<InfoSequence>',
    '<Ref ID="Info0" Selected="1"></Ref>',
    '</InfoSequence>',
    '<Info ID="Info0">',
    `<Title>${escapeText(options.title ?? 'Project info 1')}</Title>`,
    '<Notes>',
    ...String(options.notes ?? '').split('\n').filter(Boolean).map((line) => `<Font Color="#000000" Face="Helvetica">${escapeText(line)}<BR></BR></Font>`),
    '</Notes>',
    `<Constant><Name>Experiment Date</Name><Value>${date.toISOString().slice(0, 10)}</Value></Constant>`,
    '<Constant><Name>Experiment ID</Name><Value></Value></Constant>',
    '<Constant><Name>Notebook ID</Name><Value></Value></Constant>',
    `<Constant><Name>Project</Name><Value>${escapeText(options.project ?? '')}</Value></Constant>`,
    '<Constant><Name>Experimenter</Name><Value></Value></Constant>',
    '<Constant><Name>Protocol</Name><Value></Value></Constant>',
    '</Info>',
    '<TableSequence Selected="1">',
    ...tables.map((_, i) => `<Ref ID="Table${i}"${i === 0 ? ' Selected="1"' : ''}></Ref>`),
    '</TableSequence>',
  ];
  tables.forEach((table, i) => {
    lines.push(`<Table ID="Table${i}" XFormat="none" YFormat="replicates" Replicates="1" TableType="OneWay" EVFormat="AsteriskAfterNumber">`);
    lines.push(`<Title>${escapeText(table.title)}</Title>`);
    if (table.rowTitles?.length) {
      lines.push('<RowTitlesColumn Width="120">', '<Subcolumn>', ...table.rowTitles.map((t) => `<d>${escapeText(t)}</d>`), '</Subcolumn>', '</RowTitlesColumn>');
    }
    for (const column of table.columns) {
      lines.push(`<YColumn Width="110" Decimals="${column.decimals ?? 2}" Subcolumns="1">`, `<Title>${escapeText(column.title)}</Title>`, '<Subcolumn>', ...column.values.map(value), '</Subcolumn>', '</YColumn>');
    }
    lines.push('</Table>');
  });
  lines.push('</GraphPadPrismFile>', '');
  return lines.join('\n');
}
