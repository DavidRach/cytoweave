import assert from 'node:assert/strict';
import test from 'node:test';
import {
  XMLError,
  attr,
  child,
  children,
  decodeEntities,
  element,
  escapeAttribute,
  find,
  findAll,
  lookupNamespace,
  numberAttr,
  parseXML,
  parseXMLDocument,
  serializeXML,
  textContent,
} from './xml.js';

const G = 'http://www.isac-net.org/std/Gating-ML/v2.0/gating';
const D = 'http://www.isac-net.org/std/Gating-ML/v2.0/datatypes';

test('parses elements, attributes, namespaces and text', () => {
  const doc = parseXMLDocument(`<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<gating:Gating-ML xmlns:gating="${G}" xmlns:data-type="${D}">
  <gating:PolygonGate gating:id="P1" eventsInside='1'>
    <gating:dimension><data-type:fcs-dimension data-type:name="FSC-A"/></gating:dimension>
    <gating:vertex><gating:coordinate data-type:value="1.5"/></gating:vertex>
  </gating:PolygonGate>
  <?app hint?>
</gating:Gating-ML>`);
  assert.deepEqual(doc.declaration, { version: '1.0', encoding: 'UTF-8' });
  assert.deepEqual(doc.instructions, [{ target: 'app', data: 'hint' }]);
  assert.deepEqual(doc.warnings, []);
  const { root } = doc;
  assert.equal(root.name, 'gating:Gating-ML');
  assert.equal(root.prefix, 'gating');
  assert.equal(root.local, 'Gating-ML');
  assert.equal(root.ns, G);
  assert.equal(root.text, '');
  const polygon = child(root, 'PolygonGate', G);
  assert.equal(attr(polygon, 'id', G), 'P1');
  assert.equal(attr(polygon, 'id'), 'P1');
  assert.equal(attr(polygon, 'eventsInside'), '1');
  assert.equal(attr(polygon, 'id', G, { strictNamespace: true }), 'P1');
  assert.equal(attr(polygon, 'eventsInside', G, { strictNamespace: true }), undefined);
  const dim = find(root, 'fcs-dimension', D);
  assert.equal(dim.ns, D);
  assert.equal(attr(dim, 'name', D), 'FSC-A');
  assert.equal(numberAttr(find(root, 'coordinate'), 'value', D), 1.5);
  assert.equal(lookupNamespace(dim, 'gating'), G);
  assert.equal(lookupNamespace(dim, 'nope'), null);
  assert.equal(children(polygon).length, 2);
  assert.equal(findAll(root, 'coordinate').length, 1);
  assert.equal(find(root, 'PolygonGate', 'urn:other'), null);
});

test('default namespaces, undeclaration and unprefixed attributes', () => {
  const root = parseXML(`<Gating-ML xmlns="${G}"><PolygonGate id="x"><inner xmlns=""/></PolygonGate></Gating-ML>`);
  assert.equal(root.ns, G);
  const polygon = child(root, 'PolygonGate', G);
  assert.equal(polygon.ns, G);
  // Unprefixed attributes are in no namespace, but the tolerant lookup still finds them.
  assert.equal(attr(polygon, 'id', G), 'x');
  assert.equal(attr(polygon, 'id', G, { strictNamespace: true }), undefined);
  assert.equal(child(polygon, 'inner').ns, null);
});

test('decodes predefined, numeric and DOCTYPE entities, CDATA and line endings', () => {
  const root = parseXML('<!DOCTYPE r [ <!ENTITY who "CytoWeave"> ]>\r\n<r a="x &amp; y &#x3C; &#60;&quot;" b="tab\there">A &lt;b&gt; &#x1F600; &who; <![CDATA[<raw & text>]]>\r\nend</r>');
  assert.equal(root.attrs.a, 'x & y < <"');
  assert.equal(root.attrs.b, 'tab here');
  assert.equal(root.text, 'A <b> \u{1F600} CytoWeave <raw & text>\nend');
  assert.equal(decodeEntities('&unknown; &amp;'), '&unknown; &');
});

test('ignores comments and keeps text of nested elements', () => {
  const root = parseXML('<a>one<!-- skip <b> -->two<b>three</b>four</a>');
  assert.equal(root.text, 'onetwofour');
  assert.equal(textContent(root), 'onetwofourthree');
});

test('repairs messy markup with warnings, and throws in strict mode', () => {
  const doc = parseXMLDocument('<a><b x=1 y><c></b><d attr="&bogus;"/></a>');
  assert.equal(doc.root.local, 'a');
  assert.equal(doc.root.children[0].attrs.x, '1');
  assert.equal(doc.root.children[0].attrs.y, '');
  assert.equal(doc.root.children[0].children[0].local, 'c');
  assert.equal(doc.root.children[1].local, 'd');
  assert.equal(doc.root.children[1].attrs.attr, '&bogus;');
  assert.ok(doc.warnings.some((w) => /not quoted/.test(w)));
  assert.ok(doc.warnings.some((w) => /<c> was not closed/.test(w)));
  assert.ok(doc.warnings.some((w) => /Unknown entity/.test(w)));
  assert.throws(() => parseXMLDocument('<a><b></a>', { strict: true }), XMLError);
  const unclosed = parseXMLDocument('<a><b>text');
  assert.equal(unclosed.root.children[0].text, 'text');
  assert.ok(unclosed.warnings.some((w) => /still open/.test(w)));
  const undeclared = parseXMLDocument('<p:a/>');
  assert.equal(undeclared.root.ns, null);
  assert.ok(undeclared.warnings.some((w) => /Undeclared namespace prefix "p"/.test(w)));
});

test('reports unrecoverable errors with a position', () => {
  assert.throws(() => parseXML('<a><!-- never ends'), (error) => error instanceof XMLError && error.line === 1);
  assert.throws(() => parseXML('   '), XMLError);
  assert.throws(() => parseXML('<a>\n<b attr="x"'), /not terminated/);
});

test('case-insensitive attribute lookup for vendor variants', () => {
  const root = parseXML('<t xmlns:transforms="urn:t"><transforms:logicle transforms:T="262144" transforms:w="0.5"/></t>');
  const logicle = child(root, 'logicle');
  assert.equal(attr(logicle, 'W', 'urn:t'), undefined);
  assert.equal(attr(logicle, 'W', 'urn:t', { ignoreCase: true }), '0.5');
  assert.equal(numberAttr(logicle, 'T', 'urn:t'), 262144);
  assert.equal(numberAttr(logicle, 'M', 'urn:t', 4.5), 4.5);
});

test('serializes with escaping and pretty printing, and round-trips', () => {
  const tree = element('gating:Gating-ML', { 'xmlns:gating': G, note: 'a "quoted" <tag> & \n line' }, [
    element('gating:PolygonGate', { 'gating:id': 'P1', skipped: undefined }, [
      element('gating:value', {}, [], '12 < 13 & "ok"'),
    ]),
    element('empty'),
  ]);
  const xml = serializeXML(tree);
  assert.equal(xml, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gating:Gating-ML xmlns:gating="${G}" note="a &quot;quoted&quot; &lt;tag&gt; &amp; &#10; line">`,
    '  <gating:PolygonGate gating:id="P1">',
    '    <gating:value>12 &lt; 13 &amp; "ok"</gating:value>',
    '  </gating:PolygonGate>',
    '  <empty/>',
    '</gating:Gating-ML>',
    '',
  ].join('\n'));
  const back = parseXML(xml);
  assert.equal(back.attrs.note, 'a "quoted" <tag> & \n line');
  assert.equal(find(back, 'value', G).text, '12 < 13 & "ok"');
  assert.equal(serializeXML(back), xml);
  assert.equal(serializeXML(element('a', {}, [element('b')]), { pretty: false, declaration: false }), '<a><b/></a>');
  assert.equal(escapeAttribute('a\u0001b'), 'ab');
});

test('accepts bytes, a BOM and Latin-1', () => {
  const utf8 = new TextEncoder().encode('﻿<r>é</r>');
  assert.equal(parseXML(utf8).text, 'é');
  const latin1 = Uint8Array.from([0x3c, 0x72, 0x3e, 0xe9, 0x3c, 0x2f, 0x72, 0x3e]);
  assert.equal(parseXML(latin1).text, 'é');
});

test('parses a large document quickly', () => {
  const parts = ['<root>'];
  for (let i = 0; i < 50000; i += 1) parts.push(`<gating:vertex xmlns:gating="${G}"><gating:coordinate data-type:value="${i}" xmlns:data-type="${D}"/></gating:vertex>`);
  parts.push('</root>');
  const start = performance.now();
  const root = parseXML(parts.join('\n'));
  const elapsed = performance.now() - start;
  assert.equal(root.children.length, 50000);
  assert.equal(attr(root.children[49999].children[0], 'value', D), '49999');
  assert.ok(elapsed < 2000, `took ${elapsed} ms`);
});
