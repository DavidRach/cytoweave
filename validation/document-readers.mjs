// Readers for the documents CytoWeave writes (PDF, PowerPoint, Excel, Prism), written for the
// validation only: they read the files back as a reader would, independently of the writers (the
// ZIP reader and XML parser are CytoWeave's; the format knowledge here is not shared with the
// writers). And a content fingerprint for each file: a SHA-256 over what it holds with
// compression undone, so that the readback of a file by the formats' own readers (openpyxl,
// python-pptx, pypdf, R pzfx; reference/read_reports.py) can be matched to the file this
// validation writes again, whatever zlib build compressed it.

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readZip } from '../web/lib/zip.js';
import { parseXML, children, child, findAll, attr, textContent } from '../web/lib/xml.js';

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder();

// WinAnsi codes 0x80–0x9F that differ from Latin-1.
const WIN_ANSI = { 0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ' };

// --- PDF ----------------------------------------------------------------------------------------

function pdfObjects(bytes) {
  const text = latin1.decode(bytes);
  const objects = new Map();
  const re = /(\d+) 0 obj\n/g;
  let m;
  while ((m = re.exec(text))) {
    const id = Number(m[1]);
    const start = m.index + m[0].length;
    const end = text.indexOf('\nendobj', start);
    const body = text.slice(start, end);
    const at = body.indexOf('>>\nstream\n');
    let dict = body;
    let data = null;
    if (at >= 0) {
      dict = body.slice(0, at + 2);
      const length = Number(dict.match(/\/Length (\d+)/)[1]);
      const from = start + at + '>>\nstream\n'.length;
      data = bytes.subarray(from, from + length);
      if (/\/Filter \/FlateDecode/.test(dict)) data = new Uint8Array(inflateSync(Buffer.from(data)));
    }
    objects.set(id, { dict, data });
    re.lastIndex = end;
  }
  return objects;
}

function decodeLiteral(literal) {
  let out = '';
  for (let i = 0; i < literal.length; i += 1) {
    let ch = literal[i];
    if (ch === '\\') {
      const next = literal[i + 1];
      if (/[0-7]/.test(next)) {
        const oct = literal.slice(i + 1).match(/^[0-7]{1,3}/)[0];
        ch = String.fromCharCode(Number.parseInt(oct, 8));
        i += oct.length;
      } else {
        ch = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[next] ?? next;
        i += 1;
      }
    }
    const code = ch.charCodeAt(0);
    out += WIN_ANSI[code] ?? ch;
  }
  return out;
}

// The text drawn on each page, one string per text object (BT … ET; runs such as a raised
// exponent joined), in drawing order; and the attached files. Returns { pages: [{ strings }],
// attachments: Map(name → bytes), info }.
export function readPDF(bytes) {
  const objects = pdfObjects(bytes);
  const catalog = [...objects.values()].find((o) => /\/Type \/Catalog/.test(o.dict));
  const pagesId = Number(catalog.dict.match(/\/Pages (\d+) 0 R/)[1]);
  const kids = [...objects.get(pagesId).dict.match(/\/Kids \[([^\]]*)\]/)[1].matchAll(/(\d+) 0 R/g)].map((k) => Number(k[1]));
  const pages = kids.map((id) => {
    const page = objects.get(id).dict;
    const content = objects.get(Number(page.match(/\/Contents (\d+) 0 R/)[1])).data;
    const ops = latin1.decode(content);
    const strings = [];
    // Fill (not halo) text objects only: "0 Tr" marks the fill pass.
    for (const block of ops.matchAll(/BT ([\s\S]*?) ET/g)) {
      if (/(^|\s)1 Tr\b/.test(block[1])) continue;
      const parts = [...block[1].matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((p) => decodeLiteral(p[1]));
      if (parts.length) strings.push(parts.join(''));
    }
    const size = page.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
    return { strings, width: Number(size[1]), height: Number(size[2]) };
  });
  const attachments = new Map();
  for (const o of objects.values()) {
    if (!/\/Type \/Filespec/.test(o.dict)) continue;
    const name = o.dict.match(/\/F \(([^)]*)\)/)[1];
    const file = objects.get(Number(o.dict.match(/\/EF << \/F (\d+) 0 R/)[1]));
    attachments.set(name, file.data);
  }
  return { pages, attachments };
}

// --- Office packages ------------------------------------------------------------------------------

const xmlOf = (files, name) => parseXML(utf8.decode(files.get(name)));
const relsOf = (files, name) => {
  const dir = name.slice(0, name.lastIndexOf('/') + 1);
  const relsName = `${dir}_rels/${name.slice(dir.length)}.rels`;
  if (!files.has(relsName)) return new Map();
  const map = new Map();
  for (const rel of children(xmlOf(files, relsName).root ?? xmlOf(files, relsName), 'Relationship')) {
    const target = attr(rel, 'Target');
    const resolved = target.startsWith('/') ? target.slice(1) : new URL(target, `file:///${dir}`).pathname.slice(1);
    map.set(attr(rel, 'Id'), { type: attr(rel, 'Type'), target: resolved });
  }
  return map;
};
const rootOf = (doc) => doc.root ?? doc;

// Sheets of an Excel workbook as rows of values (numbers as numbers, text as text, empty null).
export async function readXLSX(bytes) {
  const files = await readZip(bytes);
  const book = rootOf(xmlOf(files, 'xl/workbook.xml'));
  const rels = relsOf(files, 'xl/workbook.xml');
  const shared = files.has('xl/sharedStrings.xml') ? findAll(rootOf(xmlOf(files, 'xl/sharedStrings.xml')), 'si').map((si) => findAll(si, 't').map(textContent).join('')) : [];
  const sheets = [];
  for (const sheet of findAll(book, 'sheet')) {
    const target = rels.get(attr(sheet, 'id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')).target;
    const rows = [];
    for (const row of findAll(rootOf(xmlOf(files, target)), 'row')) {
      const values = [];
      for (const cell of children(row, 'c')) {
        const ref = attr(cell, 'r');
        const col = [...ref.match(/^[A-Z]+/)[0]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
        const v = child(cell, 'v');
        const type = attr(cell, 't');
        let value = null;
        if (v) value = type === 's' ? shared[Number(textContent(v))] : type === 'b' ? textContent(v) === '1' : type === 'str' ? textContent(v) : Number(textContent(v));
        values[col] = value;
      }
      rows[Number(attr(row, 'r')) - 1] = Array.from(values, (x) => (x === undefined ? null : x));
    }
    sheets.push({ name: attr(sheet, 'name'), rows: Array.from(rows, (r) => r ?? []) });
  }
  return { sheets, parts: [...files.keys()] };
}

// Slides of a PowerPoint deck: text boxes' paragraphs, tables' cells (rows of cell text), the
// pictures (with their image part present or not) and dashed frames.
export async function readPPTX(bytes) {
  const files = await readZip(bytes);
  const pres = rootOf(xmlOf(files, 'ppt/presentation.xml'));
  const rels = relsOf(files, 'ppt/presentation.xml');
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const slides = [];
  for (const id of findAll(pres, 'sldId')) {
    const target = rels.get(attr(id, 'id', R)).target;
    const slide = rootOf(xmlOf(files, target));
    const slideRels = relsOf(files, target);
    const texts = [];
    const tables = [];
    const pictures = [];
    for (const sp of findAll(slide, 'sp')) texts.push(findAll(sp, 'p').map((p) => findAll(p, 't').map(textContent).join('')).join('\n'));
    for (const tbl of findAll(slide, 'tbl')) tables.push(findAll(tbl, 'tr').map((tr) => children(tr, 'tc').map((tc) => findAll(tc, 'p').map((p) => findAll(p, 't').map(textContent).join('')).join('\n'))));
    for (const pic of findAll(slide, 'pic')) {
      const embed = attr(findAll(pic, 'blip')[0], 'embed', R);
      const part = slideRels.get(embed)?.target;
      pictures.push({ name: attr(findAll(pic, 'cNvPr')[0], 'name'), description: attr(findAll(pic, 'cNvPr')[0], 'descr'), present: Boolean(part && files.has(part)) });
    }
    slides.push({ texts, tables, pictures });
  }
  const size = findAll(pres, 'sldSz')[0];
  return { slides, width: Number(attr(size, 'cx')), height: Number(attr(size, 'cy')), parts: [...files.keys()], files };
}

// Tables of a Prism project: { title, rowTitles, columns: [{ title, values (null for empty) }] }.
export function readPZFX(text) {
  const root = rootOf(parseXML(text));
  return children(root, 'Table').map((table) => {
    const rowTitles = child(table, 'RowTitlesColumn');
    const values = (subcolumn) => children(subcolumn, 'd').map((d) => {
      const raw = textContent(d).trim();
      return raw === '' ? null : Number(raw);
    });
    return {
      title: textContent(child(table, 'Title')),
      type: attr(table, 'TableType'),
      rowTitles: rowTitles ? children(child(rowTitles, 'Subcolumn'), 'd').map(textContent) : null,
      columns: children(table, 'YColumn').map((col) => ({ title: textContent(child(col, 'Title')), values: values(child(col, 'Subcolumn')) })),
    };
  });
}

// --- Fingerprints ---------------------------------------------------------------------------------

// A SHA-256 over a file's content with compression undone: a ZIP package's entries (by name), or a
// PDF's objects with streams inflated and their compressed lengths left out.
export async function fingerprint(bytes) {
  const hash = createHash('sha256');
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = await readZip(bytes);
    for (const name of [...files.keys()].sort()) {
      hash.update(name);
      hash.update(files.get(name));
    }
  } else if (latin1.decode(bytes.subarray(0, 5)) === '%PDF-') {
    for (const [id, o] of [...pdfObjects(bytes)].sort((a, b) => a[0] - b[0])) {
      hash.update(`${id}:${o.dict.replace(/\/Length \d+/g, '')}`);
      if (o.data) hash.update(o.data);
    }
  } else {
    hash.update(bytes);
  }
  return hash.digest('hex');
}
