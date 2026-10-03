// A small namespace-aware XML parser and serializer for the interchange formats CytoWeave reads
// and writes (Gating-ML 2.0, FlowJo workspaces, ACS tables of contents). DOMParser exists in
// neither Node nor workers, so library code parses XML itself.
//
// Tree nodes: { name, prefix, local, ns, attrs: { [qualified name]: value }, children, text }.
// `children` holds elements only; `text` is the element's own character data (text and CDATA,
// entities decoded), or '' when it is only whitespace between child elements. Comments are
// skipped; processing instructions are reported at document level.
//
// The parser is forgiving about what real files contain (mismatched or unclosed tags, undeclared
// prefixes, unknown entities, unquoted attributes) and records each repair as a warning; with
// `strict: true` those throw instead. Structural damage it cannot repair always throws XMLError.

export const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

export class XMLError extends Error {
  constructor(message, source = '', position = -1) {
    const where = position >= 0 ? lineColumn(source, position) : null;
    super(where ? `${message} (line ${where.line}, column ${where.column})` : message);
    this.name = 'XMLError';
    if (where) {
      this.line = where.line;
      this.column = where.column;
    }
  }
}

function lineColumn(source, position) {
  let line = 1;
  let last = -1;
  for (let i = source.indexOf('\n'); i >= 0 && i < position; i = source.indexOf('\n', i + 1)) {
    line += 1;
    last = i;
  }
  return { line, column: position - last };
}

const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z_:][\w.:-]*);/g;

// Decodes character and entity references. Unknown named entities are left as written.
export function decodeEntities(text, entities = PREDEFINED, onUnknown = null) {
  if (text.indexOf('&') < 0) return text;
  return text.replace(ENTITY, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    const value = entities[body];
    if (value !== undefined) return value;
    onUnknown?.(body);
    return match;
  });
}

const NAME = /[^\s/>=<]+/y;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/y;
const ENTITY_DECL = /<!ENTITY\s+([^\s%]+)\s+(?:"([^"]*)"|'([^']*)')\s*>/g;

function isSpace(code) {
  return code === 32 || code === 10 || code === 9 || code === 13;
}

const scopes = new WeakMap();
const ROOT_SCOPE = Object.assign(Object.create(null), { xml: XML_NS, xmlns: XMLNS_NS });

function decodeInput(input) {
  if (typeof input === 'string') return input;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Older workspaces declare (or silently use) ISO-8859-1.
    return new TextDecoder('latin1').decode(bytes);
  }
}

// Parses a document. Returns { root, declaration, instructions, warnings }.
export function parseXMLDocument(input, options = {}) {
  let s = decodeInput(input);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (s.indexOf('\r') >= 0) s = s.replace(/\r\n?/g, '\n');
  const n = s.length;
  const strict = Boolean(options.strict);
  const warnings = [];
  const warn = (message, at) => {
    if (strict) throw new XMLError(message, s, at);
    if (warnings.length < (options.maxWarnings ?? 200)) {
      const where = lineColumn(s, at);
      warnings.push(`${message} (line ${where.line}, column ${where.column})`);
    }
  };
  const entities = { ...PREDEFINED };
  const instructions = [];
  let declaration = null;
  let root = null;
  const stack = [];
  let pos = 0;

  const appendText = (text, at) => {
    if (stack.length) {
      stack[stack.length - 1].text += text;
    } else if (/\S/.test(text)) {
      warn('Text outside the root element was ignored', at);
    }
  };

  const finish = (node) => {
    if (node.children.length && !/\S/.test(node.text)) node.text = '';
  };

  const openTag = (lt) => {
    NAME.lastIndex = lt + 1;
    const match = NAME.exec(s);
    if (!match) {
      warn('A "<" that does not start a tag was treated as text', lt);
      appendText('<', lt);
      return lt + 1;
    }
    const qname = match[0];
    let p = NAME.lastIndex;
    const attrs = {};
    let declared = null;
    let selfClosing = false;
    for (;;) {
      while (p < n && isSpace(s.charCodeAt(p))) p += 1;
      if (p >= n) throw new XMLError(`The tag <${qname}> is not terminated`, s, lt);
      const code = s.charCodeAt(p);
      if (code === 62) { // >
        p += 1;
        break;
      }
      if (code === 47) { // /
        if (s.charCodeAt(p + 1) === 62) {
          selfClosing = true;
          p += 2;
          break;
        }
        warn(`Stray "/" in <${qname}>`, p);
        p += 1;
        continue;
      }
      if (code === 60) { // < : a tag that was never closed
        warn(`The tag <${qname}> is missing its ">"`, p);
        break;
      }
      ATTRIBUTE.lastIndex = p;
      const a = ATTRIBUTE.exec(s);
      if (!a) {
        warn(`Malformed attribute in <${qname}>`, p);
        p += 1;
        continue;
      }
      p = ATTRIBUTE.lastIndex;
      const name = a[1];
      let value = a[2] ?? a[3] ?? a[4];
      if (value === undefined) {
        warn(`Attribute "${name}" of <${qname}> has no value`, p);
        value = '';
      } else if (a[4] !== undefined) {
        warn(`Attribute "${name}" of <${qname}> is not quoted`, p);
      }
      // Attribute-value normalization: literal whitespace characters become spaces; character
      // references (&#10;) survive as written.
      if (/[\n\t]/.test(value)) value = value.replace(/[\n\t]/g, ' ');
      value = decodeEntities(value, entities, (entity) => warn(`Unknown entity &${entity};`, p));
      if (Object.prototype.hasOwnProperty.call(attrs, name)) warn(`Duplicate attribute "${name}" in <${qname}>`, p);
      attrs[name] = value;
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        declared ??= {};
        declared[name === 'xmlns' ? '' : name.slice(6)] = value;
      }
    }
    const parentScope = stack.length ? scopes.get(stack[stack.length - 1]) : ROOT_SCOPE;
    const scope = declared ? Object.assign(Object.create(parentScope), declared) : parentScope;
    const colon = qname.indexOf(':');
    const prefix = colon > 0 ? qname.slice(0, colon) : '';
    const local = colon > 0 ? qname.slice(colon + 1) : qname;
    let ns = scope[prefix];
    if (ns === undefined) {
      if (prefix) warn(`Undeclared namespace prefix "${prefix}"`, lt);
      ns = null;
    }
    if (ns === '') ns = null;
    const node = { name: qname, prefix, local, ns, attrs, children: [], text: '' };
    scopes.set(node, scope);
    if (stack.length) {
      stack[stack.length - 1].children.push(node);
    } else if (root) {
      warn(`A second root element <${qname}> was ignored`, lt);
    } else {
      root = node;
    }
    if (!selfClosing) stack.push(node);
    return p;
  };

  const closeTag = (lt) => {
    const gt = s.indexOf('>', lt + 2);
    if (gt < 0) throw new XMLError('An end tag is not terminated', s, lt);
    const qname = s.slice(lt + 2, gt).trim();
    if (!stack.length) {
      warn(`Unexpected end tag </${qname}>`, lt);
      return gt + 1;
    }
    const top = stack[stack.length - 1];
    if (top.name === qname) {
      finish(stack.pop());
      return gt + 1;
    }
    let k = stack.length - 1;
    while (k >= 0 && stack[k].name !== qname) k -= 1;
    if (k < 0) {
      warn(`End tag </${qname}> does not match <${top.name}> and was ignored`, lt);
      return gt + 1;
    }
    warn(`<${top.name}> was not closed before </${qname}>`, lt);
    while (stack.length > k) finish(stack.pop());
    return gt + 1;
  };

  // <!DOCTYPE …> with an optional internal subset; simple internal entities are honored.
  const skipDeclaration = (lt) => {
    let p = lt + 2;
    let depth = 0;
    let quote = 0;
    for (; p < n; p += 1) {
      const code = s.charCodeAt(p);
      if (quote) {
        if (code === quote) quote = 0;
      } else if (code === 34 || code === 39) {
        quote = code;
      } else if (code === 91) {
        depth += 1;
      } else if (code === 93) {
        depth -= 1;
      } else if (code === 62 && depth <= 0) {
        break;
      } else if (code === 60 && s.startsWith('<!--', p)) {
        const end = s.indexOf('-->', p + 4);
        if (end < 0) break;
        p = end + 2;
      }
    }
    if (p >= n) throw new XMLError('A <!DOCTYPE> declaration is not terminated', s, lt);
    const body = s.slice(lt, p + 1);
    ENTITY_DECL.lastIndex = 0;
    for (let m = ENTITY_DECL.exec(body); m; m = ENTITY_DECL.exec(body)) {
      entities[m[1]] = decodeEntities(m[2] ?? m[3], entities);
    }
    return p + 1;
  };

  while (pos < n) {
    const lt = s.indexOf('<', pos);
    if (lt < 0) {
      appendText(decodeEntities(s.slice(pos), entities, (e) => warn(`Unknown entity &${e};`, pos)), pos);
      break;
    }
    if (lt > pos) {
      const raw = s.slice(pos, lt);
      appendText(decodeEntities(raw, entities, (e) => warn(`Unknown entity &${e};`, pos)), pos);
    }
    const next = s.charCodeAt(lt + 1);
    if (next === 47) { // </
      pos = closeTag(lt);
    } else if (next === 33) { // <!
      if (s.startsWith('<!--', lt)) {
        const end = s.indexOf('-->', lt + 4);
        if (end < 0) throw new XMLError('A comment is not terminated', s, lt);
        pos = end + 3;
      } else if (s.startsWith('<![CDATA[', lt)) {
        const end = s.indexOf(']]>', lt + 9);
        if (end < 0) throw new XMLError('A CDATA section is not terminated', s, lt);
        appendText(s.slice(lt + 9, end), lt);
        pos = end + 3;
      } else {
        pos = skipDeclaration(lt);
      }
    } else if (next === 63) { // <?
      const end = s.indexOf('?>', lt + 2);
      if (end < 0) throw new XMLError('A processing instruction is not terminated', s, lt);
      const body = s.slice(lt + 2, end);
      const space = body.search(/\s/);
      const target = space < 0 ? body : body.slice(0, space);
      const data = space < 0 ? '' : body.slice(space + 1).trim();
      if (target === 'xml') {
        declaration = {};
        for (const m of data.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) declaration[m[1]] = m[2] ?? m[3];
      } else {
        instructions.push({ target, data });
      }
      pos = end + 2;
    } else {
      pos = openTag(lt);
    }
  }
  if (stack.length) {
    warn(`The document ended with <${stack[stack.length - 1].name}> still open`, n);
    while (stack.length) finish(stack.pop());
  }
  if (!root) throw new XMLError('The document has no root element.');
  return { root, declaration, instructions, warnings };
}

// Parses a document and returns its root element.
export function parseXML(input, options = {}) {
  const doc = parseXMLDocument(input, options);
  if (options.warnings) options.warnings.push(...doc.warnings);
  return doc.root;
}

// --- Queries -----------------------------------------------------------------------------------

// The namespace URI bound to `prefix` ('' = default) where the node was parsed, or null.
export function lookupNamespace(node, prefix = '') {
  const scope = scopes.get(node);
  if (!scope) return prefix === 'xml' ? XML_NS : null;
  const ns = scope[prefix];
  return ns === undefined || ns === '' ? null : ns;
}

// Does the element have this local name (or one of several) and, when given, namespace?
export function matches(node, local, ns = null) {
  if (!node) return false;
  if (local !== '*' && local !== undefined && local !== null) {
    if (Array.isArray(local) ? !local.includes(node.local) : node.local !== local) return false;
  }
  return !ns || node.ns === ns;
}

export function children(node, local = '*', ns = null) {
  if (!node) return [];
  return node.children.filter((c) => matches(c, local, ns));
}

export function child(node, local = '*', ns = null) {
  if (!node) return null;
  for (const c of node.children) if (matches(c, local, ns)) return c;
  return null;
}

// First descendant (depth-first, document order, excluding the node itself) that matches.
export function find(node, local, ns = null) {
  if (!node) return null;
  const stack = node.children.slice().reverse();
  while (stack.length) {
    const current = stack.pop();
    if (matches(current, local, ns)) return current;
    for (let i = current.children.length - 1; i >= 0; i -= 1) stack.push(current.children[i]);
  }
  return null;
}

// Every matching descendant in document order.
export function findAll(node, local, ns = null) {
  const out = [];
  if (!node) return out;
  const stack = node.children.slice().reverse();
  while (stack.length) {
    const current = stack.pop();
    if (matches(current, local, ns)) out.push(current);
    for (let i = current.children.length - 1; i >= 0; i -= 1) stack.push(current.children[i]);
  }
  return out;
}

// An attribute by local name. With `ns`, an attribute in that namespace wins; otherwise (unless
// options.strictNamespace) any attribute with the local name is accepted, because real files mix
// `gating:id`, `id` and prefixes bound to other URIs. options.ignoreCase matches T/t, W/w, ….
export function attr(node, local, ns = null, options = {}) {
  if (!node) return undefined;
  const { attrs } = node;
  if (!ns && !options.ignoreCase && Object.prototype.hasOwnProperty.call(attrs, local)) return attrs[local];
  const want = options.ignoreCase ? local.toLowerCase() : local;
  let fallback;
  for (const key in attrs) {
    if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
    const colon = key.indexOf(':');
    const name = colon >= 0 ? key.slice(colon + 1) : key;
    if ((options.ignoreCase ? name.toLowerCase() : name) !== want) continue;
    if (!ns) return attrs[key];
    const attrNs = colon >= 0 ? lookupNamespace(node, key.slice(0, colon)) : null;
    if (attrNs === ns) return attrs[key];
    if (fallback === undefined) fallback = attrs[key];
  }
  return options.strictNamespace ? undefined : fallback;
}

// A numeric attribute, or `fallback` when it is missing or not a number.
export function numberAttr(node, local, ns = null, fallback = undefined, options = {}) {
  const raw = attr(node, local, ns, options);
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(String(raw).trim());
  return Number.isFinite(value) ? value : fallback;
}

// The concatenated character data of the node and its descendants.
export function textContent(node) {
  if (!node) return '';
  if (!node.children.length) return node.text;
  return node.text + node.children.map(textContent).join('');
}

// --- Building and serializing ------------------------------------------------------------------

// Builds an element for serialization. Namespace declarations are ordinary attributes.
export function element(name, attrs = {}, kids = [], text = '') {
  const colon = name.indexOf(':');
  const clean = {};
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null) clean[key] = String(value);
  return {
    name,
    prefix: colon > 0 ? name.slice(0, colon) : '',
    local: colon > 0 ? name.slice(colon + 1) : name,
    ns: null,
    attrs: clean,
    children: kids.filter(Boolean),
    text: text === undefined || text === null ? '' : String(text),
  };
}

// Characters XML 1.0 cannot carry even as references are dropped (FCS keywords sometimes hold
// control characters).
const INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g; // eslint-disable-line no-control-regex

export function escapeText(value) {
  return String(value).replace(INVALID_CHARS, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttribute(value) {
  return String(value)
    .replace(INVALID_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

// Serializes an element tree. options: { pretty = true, indent = '  ', declaration = true }.
// Pretty printing indents element-only content; an element with text is written on one line.
export function serializeXML(node, options = {}) {
  const pretty = options.pretty ?? true;
  const indent = options.indent ?? '  ';
  const newline = pretty ? '\n' : '';
  const out = [];
  if (options.declaration ?? true) out.push(`<?xml version="1.0" encoding="UTF-8"?>${newline}`);
  const write = (el, depth) => {
    const pad = pretty ? indent.repeat(depth) : '';
    let open = `<${el.name}`;
    for (const [key, value] of Object.entries(el.attrs ?? {})) {
      if (value === undefined || value === null) continue;
      open += ` ${key}="${escapeAttribute(value)}"`;
    }
    const kids = el.children ?? [];
    const text = el.text ?? '';
    if (!kids.length) {
      out.push(text === '' ? `${pad}${open}/>${newline}` : `${pad}${open}>${escapeText(text)}</${el.name}>${newline}`);
      return;
    }
    out.push(`${pad}${open}>${text && /\S/.test(text) ? escapeText(text) : ''}${newline}`);
    for (const kid of kids) write(kid, depth + 1);
    out.push(`${pad}</${el.name}>${newline}`);
  };
  write(node, 0);
  return out.join('');
}
