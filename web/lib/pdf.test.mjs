import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { rgbaToRgb, writePDF } from './pdf.js';

test('a one-page PDF has a valid structure and the image data inflates', async () => {
  const width = 4;
  const height = 3;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = 255;
    rgba[i * 4 + 3] = i % 2 ? 255 : 0;
  }
  const rgb = rgbaToRgb(rgba);
  assert.deepEqual(Array.from(rgb.slice(0, 6)), [255, 255, 255, 255, 0, 0]);
  const bytes = await writePDF([{ width: 72, height: 54, image: { width, height, rgb } }], { title: 'Test (1)' });
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Title \(Test \\\(1\\\)\)/);
  // The xref offset points at the xref table.
  const startxref = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  // Every object offset in the table points at "n 0 obj".
  const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  entries.forEach((offset, i) => assert.equal(text.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`));
  // The image stream decompresses to the RGB bytes.
  const start = text.indexOf('stream\n') + 'stream\n'.length;
  const length = Number(text.match(/\/Length (\d+) >>\nstream/)[1]);
  const inflated = inflateSync(Buffer.from(bytes.slice(start, start + length)));
  assert.deepEqual(Array.from(inflated), Array.from(rgb));
});
