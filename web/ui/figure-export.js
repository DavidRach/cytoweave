// A figure page rendered for export: SVG (vector), PNG (3×) and PDF (300 dpi), each carrying the
// analysis behind its plots (figure-provenance.js) unless provenance is off. The Figures view
// downloads them; agents write them to a file (remote.js).

import { drawScene, sceneToSVG } from '../lib/plot.js';
import { rgbaToRgb, writePDF } from '../lib/pdf.js';

function rasterImage(raster) {
  const canvas = new OffscreenCanvas(raster.width, raster.height);
  canvas.getContext('2d').putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
  return canvas;
}

function rasterDataURL(raster) {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  canvas.getContext('2d').putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
  return canvas.toDataURL('image/png');
}

function esc(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The plot scene of a figure item (null when it cannot be drawn); a highlighted gate keeps its
// color and the others are grayed.
export function figureScene(app, item, view, dotSize = 1) {
  try {
    const spec = { ...item.spec, options: { ...(item.spec.options ?? {}), dotSize: item.spec.options?.dotSize ?? dotSize } };
    const scene = app.buildExportScene(app.store.ws, view, spec, { width: item.w, height: item.h, theme: 'light', title: item.title ?? '' });
    if (item.highlight) {
      for (const gate of scene.gates) {
        if (gate.id !== item.highlight) gate.color = '#9aa3b2';
      }
    }
    return scene;
  } catch {
    return null;
  }
}

async function scenesFor(app, fig) {
  const out = new Map();
  for (const item of fig.items) {
    if (item.kind !== 'plot') continue;
    const view = app.data.view(item.sampleId) ?? await app.data.ensure(item.sampleId).catch(() => null);
    if (view) out.set(item.id, figureScene(app, item, view));
  }
  return out;
}

function drawArrow(ctx, item) {
  ctx.strokeStyle = '#8a93a6';
  ctx.fillStyle = '#8a93a6';
  ctx.lineWidth = 2;
  const y = item.h / 2;
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(item.w - 8, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(item.w, y);
  ctx.lineTo(item.w - 10, y - 6);
  ctx.lineTo(item.w - 10, y + 6);
  ctx.closePath();
  ctx.fill();
}

async function renderToCanvas(app, fig, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(fig.width * scale);
  canvas.height = Math.round(fig.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = fig.background ?? '#ffffff';
  ctx.fillRect(0, 0, fig.width, fig.height);
  const scenes = await scenesFor(app, fig);
  for (const item of fig.items) {
    ctx.save();
    ctx.translate(item.x, item.y);
    if (item.kind === 'plot' && scenes.get(item.id)) drawScene(ctx, scenes.get(item.id), rasterImage);
    else if (item.kind === 'text') {
      ctx.fillStyle = item.color ?? '#171b26';
      ctx.font = `${item.weight ?? 400} ${item.size ?? 14}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = item.align ?? 'left';
      const x = item.align === 'center' ? item.w / 2 : item.align === 'right' ? item.w : 0;
      String(item.text).split('\n').forEach((line, i) => ctx.fillText(line, x, i * (item.size ?? 14) * 1.25));
    } else if (item.kind === 'arrow') {
      drawArrow(ctx, item);
    }
    ctx.restore();
  }
  return canvas;
}

// The analysis behind a figure, to embed in its exports.
async function provenanceFor(app, fig) {
  const { buildProvenance } = await import('../lib/figure-provenance.js');
  const views = new Map();
  for (const item of fig.items) {
    if (item.kind !== 'plot' || views.has(item.sampleId)) continue;
    const view = app.data.view(item.sampleId) ?? await app.data.ensure(item.sampleId).catch(() => null);
    if (view) views.set(item.sampleId, view);
  }
  return buildProvenance(app.store.ws, fig, { views, version: app.version });
}

export async function figureSVG(app, fig, { provenance = true } = {}) {
  const scenes = await scenesFor(app, fig);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${fig.width}" height="${fig.height}" viewBox="0 0 ${fig.width} ${fig.height}">`, `<rect width="${fig.width}" height="${fig.height}" fill="${fig.background ?? '#ffffff'}"/>`];
  for (const item of fig.items) {
    if (item.kind === 'plot' && scenes.get(item.id)) {
      const scene = scenes.get(item.id);
      parts.push(sceneToSVG(scene, { embedded: true, x: item.x, y: item.y, rasterHref: scene.raster ? rasterDataURL(scene.raster) : null }));
    } else if (item.kind === 'text') {
      const anchor = item.align === 'center' ? 'middle' : item.align === 'right' ? 'end' : 'start';
      const x = item.x + (item.align === 'center' ? item.w / 2 : item.align === 'right' ? item.w : 0);
      String(item.text).split('\n').forEach((line, i) => parts.push(`<text x="${x}" y="${item.y + (item.size ?? 14) * (0.9 + 1.25 * i)}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${item.size ?? 14}" font-weight="${item.weight ?? 400}" fill="${item.color ?? '#171b26'}" text-anchor="${anchor}">${esc(line)}</text>`));
    } else if (item.kind === 'arrow') {
      const y = item.y + item.h / 2;
      parts.push(`<path d="M${item.x} ${y}H${item.x + item.w - 8}" stroke="#8a93a6" stroke-width="2"/><path d="M${item.x + item.w} ${y}l-10 -6v12z" fill="#8a93a6"/>`);
    }
  }
  parts.push('</svg>');
  let svg = parts.join('');
  if (provenance) svg = (await import('../lib/figure-provenance.js')).embedSVG(svg, await provenanceFor(app, fig));
  return svg;
}

export async function figurePNG(app, fig, { provenance = true, scale = 3 } = {}) {
  const canvas = await renderToCanvas(app, fig, scale);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return provenance ? (await import('../lib/figure-provenance.js')).embedPNG(bytes, await provenanceFor(app, fig)) : bytes;
}

// 300 dots per inch at 96 CSS pixels per inch.
export async function figurePDF(app, fig, { provenance = true } = {}) {
  const canvas = await renderToCanvas(app, fig, 300 / 96);
  const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const attachments = provenance ? [(await import('../lib/figure-provenance.js')).pdfAttachment(await provenanceFor(app, fig))] : [];
  return writePDF([{ width: fig.width * 0.75, height: fig.height * 0.75, image: { width: canvas.width, height: canvas.height, rgb: rgbaToRgb(rgba) } }], { title: fig.name, attachments });
}
