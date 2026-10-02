// A minimal PDF writer for figures: one page per image, each image an RGB raster compressed
// with Flate (zlib), placed to fill a page of the given size in points (1/72 inch). Metadata
// (title, creator) goes in the document information dictionary.

const encoder = new TextEncoder();

function pdfString(text) {
  return `(${String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7e]/g, '?')})`;
}

// zlib-wrapped deflate, as FlateDecode expects.
export async function zlibDeflate(bytes) {
  if (typeof CompressionStream === 'undefined') throw new Error('Compression is not available in this browser.');
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// RGBA (as from canvas getImageData) to packed RGB on white (PDF images here have no alpha).
export function rgbaToRgb(rgba) {
  const n = rgba.length / 4;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const a = rgba[i * 4 + 3] / 255;
    out[i * 3] = Math.round(rgba[i * 4] * a + 255 * (1 - a));
    out[i * 3 + 1] = Math.round(rgba[i * 4 + 1] * a + 255 * (1 - a));
    out[i * 3 + 2] = Math.round(rgba[i * 4 + 2] * a + 255 * (1 - a));
  }
  return out;
}

// pages: [{ width, height (points), image: { width, height, rgb (Uint8Array) } }]
export async function writePDF(pages, info = {}) {
  const objects = []; // [number, bytes]
  const add = (content) => {
    objects.push(content);
    return objects.length;
  };
  const catalogId = 1;
  const pagesId = 2;
  objects.push(null, null); // reserved for catalog and pages
  const pageIds = [];
  for (const page of pages) {
    const data = await zlibDeflate(page.image.rgb);
    const imageHeader = encoder.encode(`<< /Type /XObject /Subtype /Image /Width ${page.image.width} /Height ${page.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`);
    const imageId = add(concat([imageHeader, data, encoder.encode('\nendstream')]));
    const content = encoder.encode(`q ${page.width.toFixed(3)} 0 0 ${page.height.toFixed(3)} 0 0 cm /Im0 Do Q`);
    const contentId = add(concat([encoder.encode(`<< /Length ${content.length} >>\nstream\n`), content, encoder.encode('\nendstream')]));
    const pageId = add(encoder.encode(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.width.toFixed(3)} ${page.height.toFixed(3)}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = encoder.encode(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  objects[pagesId - 1] = encoder.encode(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  const date = new Date();
  const stamp = `D:${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`;
  const infoId = add(encoder.encode(`<< /Title ${pdfString(info.title ?? 'CytoWeave figure')} /Creator ${pdfString(info.creator ?? 'CytoWeave')} /Producer ${pdfString('CytoWeave')} /CreationDate ${pdfString(stamp)} >>`));

  const parts = [encoder.encode('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let offset = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = concat([encoder.encode(`${i + 1} 0 obj\n`), body, encoder.encode('\nendobj\n')]);
    parts.push(chunk);
    offset += chunk.length;
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(encoder.encode(xref));
  return concat(parts);
}

function concat(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
