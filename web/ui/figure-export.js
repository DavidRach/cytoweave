// Figures and batch reports rendered for export. A figure: SVG (vector), PNG (3×) and PDF
// (vector, its event rasters as images), each carrying the analysis behind its plots
// (figure-provenance.js) unless provenance is off. A batch report (reports.js): the figure
// repeated over samples or an annotation's values, as a multi-page PDF or a PowerPoint deck, with
// the record of every number it prints. The Figures view downloads them; agents write them to a
// file (remote.js).

import { drawScene, sceneToSVG } from '../lib/plot.js';
import { writePDF } from '../lib/pdf.js';
import { REPORT_ATTACHMENT, expandReport, fillStatistics, plotTrace, reportPDFPage, reportRecord, reportSlide, statsLayout, unionFigure } from '../lib/reports.js';

const STATS_FONT = 'Helvetica, Arial, sans-serif';

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

const viewOf = (app) => (id) => app.data.view(id);

async function loadedView(app, sampleId) {
  return app.data.view(sampleId) ?? await app.data.ensure(sampleId).catch(() => null);
}

// Loads the samples a report needs: its plots' samples, its statistics' rows, and the control
// and blank samples of the tables' columns.
async function ensureSamples(app, report) {
  const ws = app.store.ws;
  const ids = new Set();
  for (const page of report.pages) {
    for (const item of page.items) {
      if (item.kind === 'plot' && item.sampleId) ids.add(item.sampleId);
      if (item.kind === 'stats') {
        for (const id of item.rowIds ?? []) ids.add(id);
        const table = ws.tables.find((t) => t.id === item.tableId);
        for (const c of table?.columns ?? []) {
          if (c.control?.sampleId) ids.add(c.control.sampleId);
          for (const id of [...(c.limits?.blankIds ?? []), ...(c.limits?.lowIds ?? [])]) ids.add(id);
        }
      }
    }
  }
  for (const id of ids) await loadedView(app, id);
}

// A figure as a one-page report: text placeholders filled and statistics computed on the samples
// loaded (the Figures view's preview).
export function figurePage(app, fig) {
  const report = expandReport(app.store.ws, fig, { by: null });
  fillStatistics(app.store.ws, report, viewOf(app));
  return report.pages[0];
}

async function scenesFor(app, page) {
  const out = new Map();
  for (const item of page.items) {
    if (item.kind !== 'plot' || !item.sampleId) continue;
    const view = await loadedView(app, item.sampleId);
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

const CANVAS_BASELINE = { top: 'top', middle: 'middle', bottom: 'bottom', alphabetic: 'alphabetic' };

// A statistics item drawn on a canvas at its origin (the Figures view and PNG exports).
export function drawStats(ctx, item) {
  const content = item.content;
  ctx.save();
  if (!content || content.missing || !content.rows?.length) {
    ctx.fillStyle = '#8a93a6';
    ctx.font = `11px ${STATS_FONT}`;
    ctx.textBaseline = 'top';
    ctx.fillText(content?.missing ?? (content ? 'No samples to list.' : 'Statistics'), 4, 4);
    ctx.restore();
    return;
  }
  const layout = statsLayout(content, item.w, item.h, item.size ?? 11);
  for (const rule of layout.rules) {
    ctx.strokeStyle = rule.strong ? '#3b4252' : '#d5dae3';
    ctx.lineWidth = rule.strong ? 1 : 0.6;
    ctx.beginPath();
    ctx.moveTo(rule.x0, rule.y);
    ctx.lineTo(rule.x1, rule.y);
    ctx.stroke();
  }
  for (const cell of layout.cells) {
    ctx.font = `${cell.bold ? 700 : 400} ${layout.size}px ${STATS_FONT}`;
    ctx.fillStyle = cell.muted ? '#8a93a6' : '#171b26';
    ctx.textAlign = cell.align;
    ctx.textBaseline = CANVAS_BASELINE[cell.baseline] ?? 'alphabetic';
    const x = cell.align === 'right' ? cell.x + cell.w - 2 : cell.x + 2;
    cell.lines.forEach((line, k) => ctx.fillText(line, x, cell.y + k * layout.lineHeight));
  }
  ctx.restore();
}

function statsSVG(item) {
  const content = item.content;
  if (!content || content.missing || !content.rows?.length) return `<text x="${item.x + 4}" y="${item.y + 14}" font-family="${STATS_FONT}" font-size="11" fill="#8a93a6">${esc(content?.missing ?? 'No samples to list.')}</text>`;
  const layout = statsLayout(content, item.w, item.h, item.size ?? 11);
  const parts = [`<g transform="translate(${item.x},${item.y})" font-family="${STATS_FONT}" font-size="${layout.size}">`];
  for (const rule of layout.rules) parts.push(`<path d="M${rule.x0} ${rule.y}H${rule.x1}" stroke="${rule.strong ? '#3b4252' : '#d5dae3'}" stroke-width="${rule.strong ? 1 : 0.6}"/>`);
  const shift = { top: 0.8, middle: 0.33, bottom: -0.2, alphabetic: 0 };
  for (const cell of layout.cells) {
    const x = cell.align === 'right' ? cell.x + cell.w - 2 : cell.x + 2;
    cell.lines.forEach((line, k) => parts.push(`<text x="${+x.toFixed(2)}" y="${+(cell.y + k * layout.lineHeight + (shift[cell.baseline] ?? 0) * layout.size).toFixed(2)}" text-anchor="${cell.align === 'right' ? 'end' : 'start'}"${cell.bold ? ' font-weight="700"' : ''} fill="${cell.muted ? '#8a93a6' : '#171b26'}">${esc(line)}</text>`));
  }
  parts.push('</g>');
  return parts.join('');
}

function drawMissing(ctx, item) {
  ctx.strokeStyle = '#c3c9d4';
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(0.5, 0.5, item.w - 1, item.h - 1);
  ctx.setLineDash([]);
  ctx.fillStyle = '#8a93a6';
  ctx.font = `11px ${STATS_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(item.missing ?? 'The sample is not available', item.w / 2, item.h / 2, item.w - 16);
}

async function renderToCanvas(app, fig, page, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(fig.width * scale);
  canvas.height = Math.round(fig.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = fig.background ?? '#ffffff';
  ctx.fillRect(0, 0, fig.width, fig.height);
  const scenes = await scenesFor(app, page);
  for (const item of page.items) {
    ctx.save();
    ctx.translate(item.x, item.y);
    if (item.kind === 'plot') {
      if (scenes.get(item.id)) drawScene(ctx, scenes.get(item.id), rasterImage);
      else if (item.missing) drawMissing(ctx, item);
    } else if (item.kind === 'text') {
      ctx.fillStyle = item.color ?? '#171b26';
      ctx.font = `${item.weight ?? 400} ${item.size ?? 14}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.textAlign = item.align ?? 'left';
      const x = item.align === 'center' ? item.w / 2 : item.align === 'right' ? item.w : 0;
      String(item.text).split('\n').forEach((line, i) => ctx.fillText(line, x, i * (item.size ?? 14) * 1.25));
    } else if (item.kind === 'arrow') {
      drawArrow(ctx, item);
    } else if (item.kind === 'stats') {
      drawStats(ctx, item);
    }
    ctx.restore();
  }
  return canvas;
}

// The analysis behind a figure (or a report's pages), to embed in its exports.
async function provenanceFor(app, fig) {
  const { buildProvenance } = await import('../lib/figure-provenance.js');
  const views = new Map();
  for (const item of fig.items) {
    if (item.kind !== 'plot' || !item.sampleId || views.has(item.sampleId)) continue;
    const view = await loadedView(app, item.sampleId);
    if (view) views.set(item.sampleId, view);
  }
  return buildProvenance(app.store.ws, fig, { views, version: app.version });
}

export async function figureSVG(app, fig, { provenance = true } = {}) {
  const page = (await prepareReport(app, fig, { by: null })).report.pages[0];
  const scenes = await scenesFor(app, page);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${fig.width}" height="${fig.height}" viewBox="0 0 ${fig.width} ${fig.height}">`, `<rect width="${fig.width}" height="${fig.height}" fill="${fig.background ?? '#ffffff'}"/>`];
  for (const item of page.items) {
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
    } else if (item.kind === 'stats') {
      parts.push(statsSVG(item));
    }
  }
  parts.push('</svg>');
  let svg = parts.join('');
  if (provenance) svg = (await import('../lib/figure-provenance.js')).embedSVG(svg, await provenanceFor(app, fig));
  return svg;
}

export async function figurePNG(app, fig, { provenance = true, scale = 3 } = {}) {
  const page = (await prepareReport(app, fig, { by: null })).report.pages[0];
  const canvas = await renderToCanvas(app, fig, page, scale);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return provenance ? (await import('../lib/figure-provenance.js')).embedPNG(bytes, await provenanceFor(app, fig)) : bytes;
}

// Vector: text and lines as PDF text and paths, event rasters as images.
export async function figurePDF(app, fig, { provenance = true } = {}) {
  return (await reportPDF(app, fig, { by: null, provenance })).bytes;
}

// --- Batch reports ------------------------------------------------------------------------------

// Expands a report, loads what it needs and computes its numbers. options: { by, groupId,
// sampleId }. Returns { report, trace }.
export async function prepareReport(app, fig, options = {}) {
  const ws = app.store.ws;
  const report = expandReport(ws, fig, { ...options, date: new Date() });
  await ensureSamples(app, report);
  const trace = fillStatistics(app.store.ws, report, viewOf(app));
  return { report, trace };
}

async function attachments(app, fig, report, trace, provenance) {
  if (!provenance) return [];
  const { pdfAttachment } = await import('../lib/figure-provenance.js');
  const record = reportRecord(app.store.ws, fig, report, trace, { version: app.version });
  // A figure's own layout; a batch report's plots of every page.
  const out = [pdfAttachment(await provenanceFor(app, report.by ? unionFigure(fig, report) : fig))];
  if (report.by || trace.length) out.push({ name: REPORT_ATTACHMENT, mime: 'application/json', description: 'The CytoWeave report: its pages and where every number comes from', data: new TextEncoder().encode(JSON.stringify(record)) });
  return out;
}

// A multi-page PDF. Returns { bytes, report, trace }.
export async function reportPDF(app, fig, options = {}) {
  const { provenance = true, onProgress } = options;
  const { report, trace } = await prepareReport(app, fig, options);
  const pages = [];
  for (const page of report.pages) {
    const scenes = await scenesFor(app, page);
    for (const item of page.items) if (item.kind === 'plot' && scenes.get(item.id)) trace.push(...plotTrace(app.store.ws, page, item, scenes.get(item.id)));
    pages.push(reportPDFPage(fig, page, (item) => scenes.get(item.id) ?? null));
    onProgress?.(pages.length / report.pages.length);
  }
  const bytes = await writePDF(pages, { title: fig.name, subject: report.by ? `${fig.name}: ${report.pages.length} pages` : undefined, attachments: await attachments(app, fig, report, trace, provenance) });
  return { bytes, report, trace };
}

// A PowerPoint deck: plots as pictures (3×), statistics as native tables. Returns { bytes,
// report, trace }.
export async function reportPPTX(app, fig, options = {}) {
  const { provenance = true, onProgress } = options;
  const { writePPTX } = await import('../lib/pptx.js');
  const { report, trace } = await prepareReport(app, fig, options);
  const ws = app.store.ws;
  const slides = [];
  for (const page of report.pages) {
    const scenes = await scenesFor(app, page);
    slides.push(await reportSlide(fig, page, async (item) => {
      const scene = scenes.get(item.id);
      if (!scene) return null;
      trace.push(...plotTrace(ws, page, item, scene));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(item.w * 3);
      canvas.height = Math.round(item.h * 3);
      const ctx = canvas.getContext('2d');
      ctx.scale(3, 3);
      drawScene(ctx, scene, rasterImage);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const sample = ws.samples.find((s) => s.id === item.sampleId)?.name ?? '';
      const oneD = !item.spec.y || item.spec.type === 'histogram' || item.spec.type === 'cdf';
      return { png: new Uint8Array(await blob.arrayBuffer()), description: `${oneD ? `${item.spec.type === 'cdf' ? 'Cumulative distribution' : 'Histogram'} of ${scene.axes.x.label}` : `${scene.axes.y.label} against ${scene.axes.x.label}`}${item.title ? `, ${item.title}` : ''}; ${sample}` };
    }));
    onProgress?.(slides.length / report.pages.length);
  }
  const parts = [];
  if (provenance) {
    const { buildProvenance } = await import('../lib/figure-provenance.js');
    const union = unionFigure(fig, report);
    const views = new Map([...new Set(union.items.map((i) => i.sampleId))].map((id) => [id, app.data.view(id)]).filter(([, v]) => v));
    const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
    parts.push({ path: 'cytoweave/report.json', contentType: 'application/json', relationship: 'https://cytoweave.org/relationships/report', data: encode(reportRecord(ws, fig, report, trace, { version: app.version })) });
    parts.push({ path: 'cytoweave/provenance.json', contentType: 'application/json', relationship: 'https://cytoweave.org/relationships/provenance', data: encode(buildProvenance(ws, union, { views, version: app.version })) });
  }
  const bytes = await writePPTX(slides, { width: fig.width, height: fig.height, title: fig.name, parts });
  return { bytes, report, trace };
}
