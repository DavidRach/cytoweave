// A minimal PowerPoint (PresentationML, ECMA-376) writer for batch reports: one blank layout and
// slides of pictures (PNG), text boxes, arrows, dashed frames and native tables, whose cells stay
// editable numbers in PowerPoint, Keynote and LibreOffice. Positions and sizes are given in CSS
// pixels (96 per inch, 9,525 EMU each) and font sizes in pixels (0.75 pt each). Text is set in
// Arial, which every platform has (and whose widths are Helvetica's, as the PDF measures them).
//
// writePPTX(slides, options) → Uint8Array (a ZIP package). slides: [{ shapes, background }], shapes:
//   { kind: 'picture', x, y, w, h, png, name, description }
//   { kind: 'text', x, y, w, h, paragraphs: [{ text, size, bold, color, align }] }
//   { kind: 'arrow', x, y, w, h, color }
//   { kind: 'frame', x, y, w, h, color, text } (a dashed box with a message)
//   { kind: 'table', x, y, w, columns: [widths], rows: [{ h, cells: [{ text, bold, align, color,
//     size, rule: 'strong' | 'thin' | null }] }] }
// options: { width, height (px), title, creator, date, parts: [{ path, contentType, data,
// relationship }] } (extra parts, related from the package; CytoWeave puts the report's record
// there).

import { createZip } from './zip.js';
import { escapeAttribute, escapeText } from './xml.js';

const EMU = 9525;
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const FONT = 'Arial';

const emu = (px) => Math.round(px * EMU);
const hex = (color, fallback = '171B26') => {
  const m = String(color ?? '').match(/^#([0-9a-f]{6})/i) ?? String(color ?? '').match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (!m) return fallback;
  return (m.length === 4 ? m.slice(1).map((c) => c + c).join('') : m[1]).toUpperCase();
};
const centipoints = (px) => Math.max(100, Math.round(px * 75)); // hundredths of a point

function relationships(list) {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${escapeAttribute(r.target)}"/>`).join('')}</Relationships>`;
}

function xfrm(shape, tag = 'a:xfrm') {
  return `<${tag}><a:off x="${emu(shape.x)}" y="${emu(shape.y)}"/><a:ext cx="${emu(Math.max(1, shape.w))}" cy="${emu(Math.max(0, shape.h))}"/></${tag}>`;
}

function run(text, { size = 14, bold = false, color = '#171b26' } = {}) {
  return `<a:r><a:rPr lang="en-US" sz="${centipoints(size)}"${bold ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill><a:latin typeface="${FONT}"/><a:cs typeface="${FONT}"/></a:rPr><a:t>${escapeText(text)}</a:t></a:r>`;
}

function paragraph(p) {
  const align = p.align === 'center' ? 'ctr' : p.align === 'right' ? 'r' : 'l';
  if (!p.text) return `<a:p><a:pPr algn="${align}"/><a:endParaRPr lang="en-US" sz="${centipoints(p.size ?? 14)}" dirty="0"/></a:p>`;
  return `<a:p><a:pPr algn="${align}"/>${run(p.text, p)}</a:p>`;
}

function textShape(shape, id) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(shape)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/>${shape.paragraphs.map(paragraph).join('')}</p:txBody></p:sp>`;
}

function frameShape(shape, id) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Frame ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(shape)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="${emu(1)}"><a:solidFill><a:srgbClr val="${hex(shape.color, 'C3C9D4')}"/></a:solidFill><a:prstDash val="dash"/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0" anchor="ctr"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraph({ text: shape.text ?? '', size: 11, color: '#8a93a6', align: 'center' })}</p:txBody></p:sp>`;
}

function arrowShape(shape, id) {
  const y = shape.y + shape.h / 2;
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Arrow ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="${emu(shape.x)}" y="${emu(y)}"/><a:ext cx="${emu(shape.w)}" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${emu(2)}"><a:solidFill><a:srgbClr val="${hex(shape.color, '8A93A6')}"/></a:solidFill><a:tailEnd type="triangle" w="med" len="med"/></a:ln></p:spPr></p:cxnSp>`;
}

function pictureShape(shape, id, relId) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escapeAttribute(shape.name ?? `Picture ${id}`)}" descr="${escapeAttribute(shape.description ?? '')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(shape)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function border(tag, rule) {
  if (!rule) return `<a:${tag} w="0"><a:noFill/></a:${tag}>`;
  return `<a:${tag} w="${emu(rule === 'strong' ? 1 : 0.6)}"><a:solidFill><a:srgbClr val="${rule === 'strong' ? '3B4252' : 'D5DAE3'}"/></a:solidFill></a:${tag}>`;
}

function tableShape(shape, id) {
  const height = shape.rows.reduce((sum, r) => sum + r.h, 0);
  const grid = shape.columns.map((w) => `<a:gridCol w="${emu(w)}"/>`).join('');
  const rows = shape.rows.map((row) => `<a:tr h="${emu(row.h)}">${row.cells.map((cell) => {
    const align = cell.align === 'right' ? 'r' : cell.align === 'center' ? 'ctr' : 'l';
    const lines = String(cell.text ?? '').split('\n');
    const body = lines.map((line) => (line ? `<a:p><a:pPr algn="${align}"/>${run(line, { size: cell.size ?? 11, bold: cell.bold, color: cell.color ?? '#171b26' })}</a:p>` : `<a:p><a:pPr algn="${align}"/><a:endParaRPr lang="en-US" sz="${centipoints(cell.size ?? 11)}" dirty="0"/></a:p>`)).join('');
    return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${body}</a:txBody><a:tcPr marL="${emu(3)}" marR="${emu(3)}" marT="${emu(1.5)}" marB="${emu(1.5)}" anchor="${cell.anchor ?? 'ctr'}">${border('lnL', null)}${border('lnR', null)}${border('lnT', null)}${border('lnB', cell.rule)}<a:noFill/></a:tcPr></a:tc>`;
  }).join('')}</a:tr>`).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${escapeAttribute(shape.name ?? `Table ${id}`)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>${xfrm({ ...shape, h: height }, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const THEME = `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="CytoWeave"><a:themeElements><a:clrScheme name="CytoWeave"><a:dk1><a:srgbClr val="171B26"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="3B4252"/></a:dk2><a:lt2><a:srgbClr val="EEF1F6"/></a:lt2><a:accent1><a:srgbClr val="4C78E0"/></a:accent1><a:accent2><a:srgbClr val="E0574C"/></a:accent2><a:accent3><a:srgbClr val="3AA76D"/></a:accent3><a:accent4><a:srgbClr val="E0A43A"/></a:accent4><a:accent5><a:srgbClr val="8A5CD6"/></a:accent5><a:accent6><a:srgbClr val="2BA3B8"/></a:accent6><a:hlink><a:srgbClr val="2F5FD0"/></a:hlink><a:folHlink><a:srgbClr val="7A4FC2"/></a:folHlink></a:clrScheme><a:fontScheme name="CytoWeave"><a:majorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${FONT}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="CytoWeave"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;

const LEVEL = (tag) => `<${tag}><a:lvl1pPr marL="0" indent="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:spcBef><a:spcPts val="0"/></a:spcBef><a:buNone/><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></${tag}>`;

const MASTER = `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles>${LEVEL('p:titleStyle')}${LEVEL('p:bodyStyle')}${LEVEL('p:otherStyle')}</p:txStyles></p:sldMaster>`;

const LAYOUT = `${XML_HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

function isoDate(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export async function writePPTX(slides, options = {}) {
  const width = options.width ?? 1600;
  const height = options.height ?? 900;
  // PowerPoint's slides are 1–56 inches on a side.
  const cx = Math.min(51206400, Math.max(914400, emu(width)));
  const cy = Math.min(51206400, Math.max(914400, emu(height)));
  const date = options.date ?? new Date();
  const files = [];
  const extra = options.parts ?? [];
  const overrides = [
    ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
    ['/ppt/slideMasters/slideMaster1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'],
    ['/ppt/slideLayouts/slideLayout1.xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'],
    ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ['/ppt/presProps.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml'],
    ['/ppt/viewProps.xml', 'application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml'],
    ['/ppt/tableStyles.xml', 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml'],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
    ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
    ...slides.map((_, i) => [`/ppt/slides/slide${i + 1}.xml`, 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml']),
    ...extra.map((part) => [`/${part.path}`, part.contentType]),
  ];
  files.push({ name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${overrides.map(([part, type]) => `<Override PartName="${escapeAttribute(part)}" ContentType="${type}"/>`).join('')}</Types>` });
  files.push({ name: '_rels/.rels', data: relationships([
    { id: 'rId1', type: `${REL}/officeDocument`, target: 'ppt/presentation.xml' },
    { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' },
    { id: 'rId3', type: `${REL}/extended-properties`, target: 'docProps/app.xml' },
    ...extra.map((part, i) => ({ id: `rId${4 + i}`, type: part.relationship, target: part.path })),
  ]) });
  files.push({ name: 'docProps/core.xml', data: `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeText(options.title ?? 'CytoWeave report')}</dc:title><dc:creator>${escapeText(options.creator ?? 'CytoWeave')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${isoDate(date)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${isoDate(date)}</dcterms:modified></cp:coreProperties>` });
  files.push({ name: 'docProps/app.xml', data: `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>CytoWeave</Application><Slides>${slides.length}</Slides></Properties>` });
  files.push({ name: 'ppt/presentation.xml', data: `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${2 + i}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>` });
  const n = slides.length;
  files.push({ name: 'ppt/_rels/presentation.xml.rels', data: relationships([
    { id: 'rId1', type: `${REL}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
    ...slides.map((_, i) => ({ id: `rId${2 + i}`, type: `${REL}/slide`, target: `slides/slide${i + 1}.xml` })),
    { id: `rId${2 + n}`, type: `${REL}/presProps`, target: 'presProps.xml' },
    { id: `rId${3 + n}`, type: `${REL}/viewProps`, target: 'viewProps.xml' },
    { id: `rId${4 + n}`, type: `${REL}/theme`, target: 'theme/theme1.xml' },
    { id: `rId${5 + n}`, type: `${REL}/tableStyles`, target: 'tableStyles.xml' },
  ]) });
  files.push({ name: 'ppt/presProps.xml', data: `${XML_HEAD}<p:presentationPr ${NS}/>` });
  files.push({ name: 'ppt/viewProps.xml', data: `${XML_HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>` });
  files.push({ name: 'ppt/tableStyles.xml', data: `${XML_HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` });
  files.push({ name: 'ppt/theme/theme1.xml', data: THEME });
  files.push({ name: 'ppt/slideMasters/slideMaster1.xml', data: MASTER });
  files.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: relationships([
    { id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', type: `${REL}/theme`, target: '../theme/theme1.xml' },
  ]) });
  files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: LAYOUT });
  files.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: relationships([{ id: 'rId1', type: `${REL}/slideMaster`, target: '../slideMasters/slideMaster1.xml' }]) });
  let media = 0;
  slides.forEach((slide, i) => {
    const rels = [{ id: 'rId1', type: `${REL}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' }];
    let id = 2;
    const shapes = slide.shapes.map((shape) => {
      const shapeId = id;
      id += 1;
      if (shape.kind === 'picture') {
        media += 1;
        const relId = `rId${rels.length + 1}`;
        rels.push({ id: relId, type: `${REL}/image`, target: `../media/image${media}.png` });
        files.push({ name: `ppt/media/image${media}.png`, data: shape.png, compress: false });
        return pictureShape(shape, shapeId, relId);
      }
      if (shape.kind === 'text') return textShape(shape, shapeId);
      if (shape.kind === 'arrow') return arrowShape(shape, shapeId);
      if (shape.kind === 'frame') return frameShape(shape, shapeId);
      if (shape.kind === 'table') return tableShape(shape, shapeId);
      throw new Error(`Unknown slide shape ${shape.kind}.`);
    }).join('');
    const background = slide.background && hex(slide.background, 'FFFFFF') !== 'FFFFFF' ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(slide.background)}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` : '';
    files.push({ name: `ppt/slides/slide${i + 1}.xml`, data: `${XML_HEAD}<p:sld ${NS}><p:cSld>${background}<p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>` });
    files.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: relationships(rels) });
  });
  for (const part of extra) files.push({ name: part.path, data: part.data });
  return createZip(files, { date });
}
