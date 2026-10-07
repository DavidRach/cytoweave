// A figure page as SVG: its plots (each a scene, with its event raster as an embedded PNG), text,
// arrows and statistics tables. The Figures view exports figures with it (ui/figure-export.js);
// review reports (review-report.js) draw the workspace's figures with it, in the window and in
// Node.

import { exportScene } from './scene.js';
import { sceneToSVG } from './plot.js';
import { statsLayout } from './reports.js';

export const STATS_FONT = 'Helvetica, Arial, sans-serif';

export function escapeXML(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The plot scene of a figure item (null when it cannot be drawn); a highlighted gate keeps its
// color and the others are grayed. options: { colormap, dotSize }.
export function figureItemScene(ws, item, view, options = {}) {
  try {
    const spec = { ...item.spec, options: { ...(item.spec.options ?? {}), dotSize: item.spec.options?.dotSize ?? options.dotSize ?? 1 } };
    const scene = exportScene(ws, view, spec, { width: item.w, height: item.h, theme: 'light', title: item.title ?? '', colormap: options.colormap });
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

// A statistics item (its content filled by fillStatistics) as SVG.
export function statsSVG(item) {
  const content = item.content;
  if (!content || content.missing || !content.rows?.length) return `<text x="${item.x + 4}" y="${item.y + 14}" font-family="${STATS_FONT}" font-size="11" fill="#8a93a6">${escapeXML(content?.missing ?? 'No samples to list.')}</text>`;
  const layout = statsLayout(content, item.w, item.h, item.size ?? 11);
  const parts = [`<g transform="translate(${item.x},${item.y})" font-family="${STATS_FONT}" font-size="${layout.size}">`];
  for (const rule of layout.rules) parts.push(`<path d="M${rule.x0} ${rule.y}H${rule.x1}" stroke="${rule.strong ? '#3b4252' : '#d5dae3'}" stroke-width="${rule.strong ? 1 : 0.6}"/>`);
  const shift = { top: 0.8, middle: 0.33, bottom: -0.2, alphabetic: 0 };
  for (const cell of layout.cells) {
    const x = cell.align === 'right' ? cell.x + cell.w - 2 : cell.x + 2;
    cell.lines.forEach((line, k) => parts.push(`<text x="${+x.toFixed(2)}" y="${+(cell.y + k * layout.lineHeight + (shift[cell.baseline] ?? 0) * layout.size).toFixed(2)}" text-anchor="${cell.align === 'right' ? 'end' : 'start'}"${cell.bold ? ' font-weight="700"' : ''} fill="${cell.muted ? '#8a93a6' : '#171b26'}">${escapeXML(line)}</text>`));
  }
  parts.push('</g>');
  return parts.join('');
}

// A figure page (as expandReport makes it) as SVG. scenes: Map(item id → scene);
// rasterHref(scene): the data URL of a scene's raster (a PNG), or null.
export function figurePageSVG(fig, page, scenes, rasterHref) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${fig.width}" height="${fig.height}" viewBox="0 0 ${fig.width} ${fig.height}">`, `<rect width="${fig.width}" height="${fig.height}" fill="${fig.background ?? '#ffffff'}"/>`];
  for (const item of page.items) {
    if (item.kind === 'plot' && scenes.get(item.id)) {
      const scene = scenes.get(item.id);
      parts.push(sceneToSVG(scene, { embedded: true, x: item.x, y: item.y, rasterHref: scene.raster ? rasterHref(scene) : null }));
    } else if (item.kind === 'text') {
      const anchor = item.align === 'center' ? 'middle' : item.align === 'right' ? 'end' : 'start';
      const x = item.x + (item.align === 'center' ? item.w / 2 : item.align === 'right' ? item.w : 0);
      String(item.text).split('\n').forEach((line, i) => parts.push(`<text x="${x}" y="${item.y + (item.size ?? 14) * (0.9 + 1.25 * i)}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="${item.size ?? 14}" font-weight="${item.weight ?? 400}" fill="${item.color ?? '#171b26'}" text-anchor="${anchor}">${escapeXML(line)}</text>`));
    } else if (item.kind === 'arrow') {
      const y = item.y + item.h / 2;
      parts.push(`<path d="M${item.x} ${y}H${item.x + item.w - 8}" stroke="#8a93a6" stroke-width="2"/><path d="M${item.x + item.w} ${y}l-10 -6v12z" fill="#8a93a6"/>`);
    } else if (item.kind === 'stats') {
      parts.push(statsSVG(item));
    }
  }
  parts.push('</svg>');
  return parts.join('');
}
