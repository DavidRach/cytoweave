// Archival Cytometry Standard (ACS) containers (Spidlen et al., ISAC ACS 1.0): a ZIP archive
// holding data files, analyses and a table of contents (TOC) XML document that lists each file
// with its MIME type and a description. CytoWeave writes its FCS files, the workspace (JSON) and
// the gates as Gating-ML 2.0, and records a SHA-256 digest of every file so an archive can be
// checked for damage years later.

import { createZip, isZip, readZip } from './zip.js';
import { attr, child, element, findAll, parseXMLDocument, serializeXML, textContent } from './xml.js';

export const ACS_TOC_NS = 'http://www.isac-net.org/std/ACS/1.0/toc/';
export const ACS_TOC_NAME = 'acs-toc.xml';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export const ACS_MIME = {
  fcs: 'application/vnd.isac.fcs',
  gatingML: 'application/xml',
  workspace: 'application/json',
  clr: 'text/csv',
};

const EXTENSION_MIME = {
  fcs: ACS_MIME.fcs,
  lmd: ACS_MIME.fcs,
  xml: 'application/xml',
  json: 'application/json',
  cwz: 'application/json',
  csv: 'text/csv',
  clr: 'text/csv',
  txt: 'text/plain',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  wsp: 'application/xml',
};

export function mimeTypeFor(name) {
  const extension = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase();
  return EXTENSION_MIME[extension] ?? 'application/octet-stream';
}

// A safe relative path inside the archive (no absolute paths, no "..", forward slashes).
export function archivePath(name) {
  const parts = String(name).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
  if (!parts.length) throw new Error(`"${name}" is not a usable file name.`);
  return parts.join('/');
}

async function sha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

const encoder = new TextEncoder();
const toBytes = (data) => (typeof data === 'string' ? encoder.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data));

// Builds an ACS container. Returns the ZIP bytes.
// contents: { fcsFiles: [{ name, bytes, description? }], workspaceJSON (string or object),
//   gatingML (string), extra: [{ name, bytes | text, mimeType?, description? }] }
// options: { date, creator, description, compress }.
export async function createACS(contents, options = {}) {
  const { fcsFiles = [], workspaceJSON = null, gatingML = null, extra = [] } = contents ?? {};
  const date = options.date ?? new Date();
  const entries = [];
  for (const file of fcsFiles) {
    entries.push({ name: archivePath(file.name), data: toBytes(file.bytes), mimeType: ACS_MIME.fcs, description: file.description ?? 'Flow cytometry data (FCS)' });
  }
  if (workspaceJSON !== null && workspaceJSON !== undefined) {
    const text = typeof workspaceJSON === 'string' ? workspaceJSON : JSON.stringify(workspaceJSON);
    entries.push({ name: 'cytoweave-workspace.json', data: encoder.encode(text), mimeType: ACS_MIME.workspace, description: 'CytoWeave workspace (samples, compensation, transforms, gates, analyses)' });
  }
  if (gatingML) entries.push({ name: 'gating-ml.xml', data: encoder.encode(gatingML), mimeType: ACS_MIME.gatingML, description: 'Gates as ISAC Gating-ML 2.0' });
  for (const file of extra) {
    const name = archivePath(file.name);
    const data = toBytes(file.bytes ?? file.text ?? file.data ?? '');
    entries.push({ name, data, mimeType: file.mimeType ?? mimeTypeFor(name), description: file.description ?? '' });
  }
  const seen = new Set();
  for (const e of entries) {
    if (e.name === ACS_TOC_NAME) throw new Error(`"${ACS_TOC_NAME}" is reserved for the table of contents.`);
    if (seen.has(e.name)) throw new Error(`The archive would contain "${e.name}" twice.`);
    seen.add(e.name);
  }
  const fileElements = [];
  for (const e of entries) {
    const digest = await sha256(e.data);
    fileElements.push(element('acs:file', {
      'xlink:type': 'simple',
      'xlink:href': `file:${encodeURI(e.name)}`,
      'acs:mimeType': e.mimeType,
      'acs:description': e.description || undefined,
      'acs:size': e.data.length,
      'acs:sha256': digest ?? undefined,
    }));
  }
  const toc = element('acs:toc', { 'xmlns:acs': ACS_TOC_NS, 'xmlns:xlink': XLINK_NS, 'acs:version': '1.0' }, [
    element('acs:creator', {}, [], options.creator ?? 'CytoWeave'),
    element('acs:created', {}, [], date.toISOString()),
    options.description ? element('acs:description', {}, [], options.description) : null,
    ...fileElements,
  ]);
  const files = [
    { name: ACS_TOC_NAME, data: serializeXML(toc) },
    // FCS data rarely shrinks under deflate; storing it keeps archives quick to write and read.
    ...entries.map((e) => ({ name: e.name, data: e.data, compress: e.mimeType === ACS_MIME.fcs ? false : undefined })),
  ];
  return createZip(files, { date, compress: options.compress });
}

function hrefPath(href) {
  let path = String(href ?? '').trim();
  if (path.startsWith('file:')) path = path.slice(5);
  try {
    path = decodeURI(path);
  } catch {
    // keep as written
  }
  return path.replace(/^(\.\/|\/)+/, '');
}

// Reads an ACS container. Returns { toc: { version, creator, created, description, files:
// [{ path, mimeType, description, size, sha256 }] } | null, files: [{ name, bytes, mimeType,
// description }], fcsFiles: [{ name, bytes }], workspaceJSON, gatingML, warnings }.
export async function readACS(bytes) {
  const data = toBytes(bytes);
  if (!isZip(data)) throw new Error('This is not an ACS container (ACS files are ZIP archives).');
  const archive = await readZip(data);
  const warnings = [];
  const decoder = new TextDecoder();
  let tocName = [ACS_TOC_NAME, 'toc.xml', 'TOC.xml'].find((n) => archive.has(n)) ?? null;
  let tocRoot = null;
  const tryToc = (name) => {
    try {
      const doc = parseXMLDocument(archive.get(name));
      return doc.root.local.toLowerCase() === 'toc' ? doc.root : null;
    } catch {
      return null;
    }
  };
  if (tocName) tocRoot = tryToc(tocName);
  if (!tocRoot) {
    tocName = [...archive.keys()].find((n) => /\.xml$/i.test(n) && !n.includes('/') && tryToc(n)) ?? null;
    if (tocName) tocRoot = tryToc(tocName);
  }
  let toc = null;
  const described = new Map();
  if (tocRoot) {
    if (tocRoot.ns && tocRoot.ns !== ACS_TOC_NS) warnings.push(`The table of contents uses the namespace "${tocRoot.ns}" rather than ACS 1.0's.`);
    const text = (local) => {
      const el = child(tocRoot, local);
      return el ? textContent(el).trim() : null;
    };
    const files = findAll(tocRoot, 'file').map((el) => {
      const rawSize = attr(el, 'size');
      return {
        path: hrefPath(attr(el, 'href', XLINK_NS) ?? attr(el, 'name') ?? attr(el, 'path')),
        mimeType: attr(el, 'mimeType', null, { ignoreCase: true }) ?? attr(el, 'mime-type') ?? null,
        description: attr(el, 'description') ?? (child(el, 'description') ? textContent(child(el, 'description')).trim() : ''),
        size: rawSize === undefined ? null : Number(rawSize),
        sha256: attr(el, 'sha256') ?? null,
      };
    }).filter((f) => f.path);
    toc = { name: tocName, version: attr(tocRoot, 'version') ?? null, creator: text('creator'), created: text('created'), description: text('description'), files };
    for (const f of files) described.set(f.path, f);
  } else {
    warnings.push('The archive has no ACS table of contents; file types were inferred from their names.');
  }
  const files = [];
  for (const [name, content] of archive) {
    if (name === tocName) continue;
    const entry = described.get(name);
    if (toc && !entry) warnings.push(`"${name}" is in the archive but not in its table of contents.`);
    if (entry?.size !== null && entry?.size !== undefined && entry.size !== content.length) warnings.push(`"${name}" is ${content.length} bytes but the table of contents says ${entry.size}.`);
    if (entry?.sha256) {
      const digest = await sha256(content);
      if (digest && digest !== entry.sha256.toLowerCase()) warnings.push(`"${name}" does not match its SHA-256 digest; the file is damaged.`);
    }
    files.push({ name, bytes: content, mimeType: entry?.mimeType ?? mimeTypeFor(name), description: entry?.description ?? '' });
  }
  for (const path of described.keys()) if (!archive.has(path)) warnings.push(`"${path}" is listed in the table of contents but missing from the archive.`);
  const isFCS = (f) => f.mimeType === ACS_MIME.fcs || /\.(fcs|lmd)$/i.test(f.name);
  const workspace = files.find((f) => f.name === 'cytoweave-workspace.json') ?? files.find((f) => /\.json$/i.test(f.name) && /workspace/i.test(f.name));
  const gating = files.find((f) => f.name === 'gating-ml.xml') ?? files.find((f) => /\.xml$/i.test(f.name) && /gating-?ml/i.test(`${f.name} ${f.description}`));
  return {
    toc,
    files,
    fcsFiles: files.filter(isFCS).map((f) => ({ name: f.name, bytes: f.bytes })),
    workspaceJSON: workspace ? decoder.decode(workspace.bytes) : null,
    gatingML: gating ? decoder.decode(gating.bytes) : null,
    warnings,
  };
}
