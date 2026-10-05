// A minimal Excel workbook (SpreadsheetML, ECMA-376) writer: sheets of numbers and text, a bold
// header style, column widths and frozen header rows. Numbers are written in full (the shortest
// decimal that reads back as the same double), so a workbook holds the values exactly; Excel shows
// them in its General format.
//
// writeXLSX(sheets, options) → Uint8Array (a ZIP package). sheets: [{ name, rows: [[cell]],
// widths: [characters], freeze: { rows, columns } }], a cell null, a number, a string, a boolean or
// { value, style: 'header' | 'bold' | 'wrap' | 'muted' }. options: { title, creator, date }.

import { createZip } from './zip.js';
import { escapeAttribute, escapeText } from './xml.js';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STYLES = { header: 1, bold: 2, wrap: 3, muted: 4 };

// "A", "B", … "Z", "AA", …
export function columnName(index) {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// Sheet names: at most 31 characters, none of []:*?/\, unique regardless of case.
export function sheetNames(names) {
  const used = new Set();
  return names.map((raw) => {
    let base = String(raw ?? '').replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
    if (base.toLowerCase() === 'history') base = 'History (table)';
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k += 1) name = `${base.slice(0, 31 - ` (${k})`.length)} (${k})`;
    used.add(name.toLowerCase());
    return name;
  });
}

function relationships(list) {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${escapeAttribute(r.target)}"/>`).join('')}</Relationships>`;
}

const STYLESHEET = `${XML_HEAD}<styleSheet xmlns="${MAIN}"><fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><sz val="11"/><color rgb="FF5B6475"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="bottom" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function isoDate(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export async function writeXLSX(sheets, options = {}) {
  if (!sheets.length) throw new Error('A workbook needs at least one sheet.');
  const date = options.date ?? new Date();
  const names = sheetNames(sheets.map((s) => s.name));
  const strings = [];
  const stringIndex = new Map();
  const shared = (text) => {
    if (!stringIndex.has(text)) {
      stringIndex.set(text, strings.length);
      strings.push(text);
    }
    return stringIndex.get(text);
  };
  const files = [];
  sheets.forEach((sheet, k) => {
    const rows = sheet.rows ?? [];
    const width = Math.max(1, ...rows.map((r) => r.length));
    const body = rows.map((row, i) => {
      const cells = row.map((raw, j) => {
        const cell = raw !== null && typeof raw === 'object' ? raw : { value: raw };
        const ref = `${columnName(j)}${i + 1}`;
        const style = cell.style ? ` s="${STYLES[cell.style] ?? 0}"` : '';
        const value = cell.value;
        if (value === null || value === undefined || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return style ? `<c r="${ref}"${style}/>` : '';
        if (typeof value === 'number') return `<c r="${ref}"${style}><v>${String(value)}</v></c>`;
        if (typeof value === 'boolean') return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
        return `<c r="${ref}"${style} t="s"><v>${shared(String(value))}</v></c>`;
      }).join('');
      return `<row r="${i + 1}">${cells}</row>`;
    }).join('');
    const freeze = sheet.freeze;
    let views = '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    if (freeze && (freeze.rows || freeze.columns)) {
      const xs = freeze.columns ?? 0;
      const ys = freeze.rows ?? 0;
      const pane = xs && ys ? 'bottomRight' : ys ? 'bottomLeft' : 'topRight';
      views = `<sheetViews><sheetView workbookViewId="0"${k === 0 ? ' tabSelected="1"' : ''}><pane${xs ? ` xSplit="${xs}"` : ''}${ys ? ` ySplit="${ys}"` : ''} topLeftCell="${columnName(xs)}${ys + 1}" activePane="${pane}" state="frozen"/><selection pane="${pane}"/></sheetView></sheetViews>`;
    }
    const cols = sheet.widths?.length ? `<cols>${sheet.widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${Math.max(4, Math.min(120, w))}" customWidth="1"/>`).join('')}</cols>` : '';
    const dimension = rows.length ? `<dimension ref="A1:${columnName(width - 1)}${rows.length}"/>` : '';
    files.push({ name: `xl/worksheets/sheet${k + 1}.xml`, data: `${XML_HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${REL}">${dimension}${views}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${body}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>` });
  });
  const n = sheets.length;
  files.unshift(
    { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: relationships([
      { id: 'rId1', type: `${REL}/officeDocument`, target: 'xl/workbook.xml' },
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
      { id: 'rId3', type: `${REL}/extended-properties`, target: 'docProps/app.xml' },
    ]) },
    { name: 'docProps/core.xml', data: `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeText(options.title ?? 'CytoWeave tables')}</dc:title><dc:creator>${escapeText(options.creator ?? 'CytoWeave')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${isoDate(date)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${isoDate(date)}</dcterms:modified></cp:coreProperties>` },
    { name: 'docProps/app.xml', data: `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>CytoWeave</Application></Properties>` },
    { name: 'xl/workbook.xml', data: `${XML_HEAD}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${names.map((name, k) => `<sheet name="${escapeAttribute(name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: relationships([
      ...sheets.map((_, k) => ({ id: `rId${k + 1}`, type: `${REL}/worksheet`, target: `worksheets/sheet${k + 1}.xml` })),
      { id: `rId${n + 1}`, type: `${REL}/styles`, target: 'styles.xml' },
      { id: `rId${n + 2}`, type: `${REL}/sharedStrings`, target: 'sharedStrings.xml' },
    ]) },
    { name: 'xl/styles.xml', data: STYLESHEET },
  );
  files.push({ name: 'xl/sharedStrings.xml', data: `${XML_HEAD}<sst xmlns="${MAIN}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t${/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : ''}>${escapeText(s)}</t></si>`).join('')}</sst>` });
  return createZip(files, { date });
}
