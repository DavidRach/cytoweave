// Small chart toolkit for bespoke statistics charts (dot plots, volcano plots, fitted
// histograms). A chart is a build function (width, height, colors) → { items, hits } where items
// are drawing primitives in CSS pixels; the same items are painted on a canvas (screen, PNG) or
// written as SVG, so exports match the screen. hits ({ x, y, r, data }) drive hover tooltips and
// clicks.
//
// Primitives:
//   { t: 'line', x1, y1, x2, y2, stroke, width, dash }
//   { t: 'path', points: [[x, y], …], stroke, width, dash, fill, close }
//   { t: 'rect', x, y, w, h, fill, stroke, width, radius }
//   { t: 'circle', x, y, r, fill, stroke, width }
//   { t: 'text', x, y, text, fill, size, weight, align: 'start'|'center'|'end',
//     baseline: 'alphabetic'|'middle'|'top'|'bottom', rotate (radians), italic }

import { h, downloadBlob } from './dom.js';

const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const LIGHT = {
  bg: '#ffffff', text: '#171b26', text2: '#4b5468', text3: '#7b8496', line: '#d0d6e2', grid: 'rgba(15,23,42,0.06)',
  accent: '#5b4ce6', ok: '#138a52', warn: '#c27a00', danger: '#d63b4a', muted: '#9aa3b4', font: FONT,
};

function cssVar(style, name, fallback) {
  const v = style.getPropertyValue(name).trim();
  return v || fallback;
}

// Colors of the current theme (from the design system's CSS variables), or the light palette
// for exports (`export: true`).
export function chartColors(options = {}) {
  if (options.export || typeof document === 'undefined') return { ...LIGHT };
  const style = getComputedStyle(document.documentElement);
  return {
    bg: cssVar(style, '--plot-bg', LIGHT.bg),
    text: cssVar(style, '--text', LIGHT.text),
    text2: cssVar(style, '--text-2', LIGHT.text2),
    text3: cssVar(style, '--text-3', LIGHT.text3),
    line: cssVar(style, '--line-strong', LIGHT.line),
    grid: document.documentElement.dataset.theme === 'dark' ? 'rgba(255,255,255,0.06)' : LIGHT.grid,
    accent: cssVar(style, '--accent', LIGHT.accent),
    ok: cssVar(style, '--ok', LIGHT.ok),
    warn: cssVar(style, '--warn', LIGHT.warn),
    danger: cssVar(style, '--danger', LIGHT.danger),
    muted: cssVar(style, '--text-3', LIGHT.muted),
    font: FONT,
  };
}

export function withAlpha(color, alpha) {
  if (typeof color !== 'string' || !color.startsWith('#')) return color;
  let hex = color.slice(1);
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// --- Painting --------------------------------------------------------------------------------

function fontOf(item, colors) {
  return `${item.italic ? 'italic ' : ''}${item.weight ?? 400} ${item.size ?? 11}px ${colors?.font ?? FONT}`;
}

export function paint(ctx, items, colors) {
  for (const item of items) {
    ctx.save();
    switch (item.t) {
      case 'line':
        ctx.strokeStyle = item.stroke;
        ctx.lineWidth = item.width ?? 1;
        if (item.dash) ctx.setLineDash(item.dash);
        ctx.beginPath();
        ctx.moveTo(item.x1, item.y1);
        ctx.lineTo(item.x2, item.y2);
        ctx.stroke();
        break;
      case 'path': {
        if (!item.points.length) break;
        ctx.beginPath();
        ctx.moveTo(item.points[0][0], item.points[0][1]);
        for (let i = 1; i < item.points.length; i += 1) ctx.lineTo(item.points[i][0], item.points[i][1]);
        if (item.close) ctx.closePath();
        if (item.fill) {
          ctx.fillStyle = item.fill;
          ctx.fill();
        }
        if (item.stroke) {
          ctx.strokeStyle = item.stroke;
          ctx.lineWidth = item.width ?? 1;
          ctx.lineJoin = 'round';
          if (item.dash) ctx.setLineDash(item.dash);
          ctx.stroke();
        }
        break;
      }
      case 'rect':
        ctx.beginPath();
        if (item.radius && ctx.roundRect) ctx.roundRect(item.x, item.y, item.w, item.h, item.radius);
        else ctx.rect(item.x, item.y, item.w, item.h);
        if (item.fill) {
          ctx.fillStyle = item.fill;
          ctx.fill();
        }
        if (item.stroke) {
          ctx.strokeStyle = item.stroke;
          ctx.lineWidth = item.width ?? 1;
          ctx.stroke();
        }
        break;
      case 'circle':
        ctx.beginPath();
        ctx.arc(item.x, item.y, item.r, 0, 2 * Math.PI);
        if (item.fill) {
          ctx.fillStyle = item.fill;
          ctx.fill();
        }
        if (item.stroke) {
          ctx.strokeStyle = item.stroke;
          ctx.lineWidth = item.width ?? 1;
          ctx.stroke();
        }
        break;
      case 'text':
        ctx.font = fontOf(item, colors);
        ctx.fillStyle = item.fill;
        ctx.textAlign = item.align === 'center' ? 'center' : item.align === 'end' ? 'right' : 'left';
        ctx.textBaseline = item.baseline ?? 'alphabetic';
        if (item.rotate) {
          ctx.translate(item.x, item.y);
          ctx.rotate(item.rotate);
          ctx.fillText(item.text, 0, 0);
        } else ctx.fillText(item.text, item.x, item.y);
        break;
      default:
        break;
    }
    ctx.restore();
  }
}

const escapeXML = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v) => (Number.isFinite(v) ? +v.toFixed(2) : 0);

// SVG paint with explicit opacity attributes (rgba() is not understood everywhere).
function svgPaint(attr, color) {
  if (!color) return `${attr}="none"`;
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(color);
  if (m) return `${attr}="rgb(${m[1]},${m[2]},${m[3]})" ${attr}-opacity="${m[4]}"`;
  return `${attr}="${escapeXML(color)}"`;
}

export function toSVG(items, width, height, colors) {
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family='${FONT}'>`];
  out.push(`<rect x="0" y="0" width="${width}" height="${height}" ${svgPaint('fill', colors.bg)}/>`);
  for (const item of items) {
    const dash = item.dash ? ` stroke-dasharray="${item.dash.join(' ')}"` : '';
    switch (item.t) {
      case 'line':
        out.push(`<line x1="${num(item.x1)}" y1="${num(item.y1)}" x2="${num(item.x2)}" y2="${num(item.y2)}" ${svgPaint('stroke', item.stroke)} stroke-width="${item.width ?? 1}"${dash}/>`);
        break;
      case 'path':
        if (!item.points.length) break;
        out.push(`<path d="M${item.points.map(([x, y]) => `${num(x)},${num(y)}`).join('L')}${item.close ? 'Z' : ''}" ${svgPaint('fill', item.fill)} ${svgPaint('stroke', item.stroke)} stroke-width="${item.width ?? 1}" stroke-linejoin="round"${dash}/>`);
        break;
      case 'rect':
        out.push(`<rect x="${num(item.x)}" y="${num(item.y)}" width="${num(item.w)}" height="${num(item.h)}" rx="${item.radius ?? 0}" ${svgPaint('fill', item.fill)} ${svgPaint('stroke', item.stroke)} stroke-width="${item.width ?? 1}"/>`);
        break;
      case 'circle':
        out.push(`<circle cx="${num(item.x)}" cy="${num(item.y)}" r="${num(item.r)}" ${svgPaint('fill', item.fill)} ${svgPaint('stroke', item.stroke)} stroke-width="${item.width ?? 1}"/>`);
        break;
      case 'text': {
        const anchor = item.align === 'center' ? 'middle' : item.align === 'end' ? 'end' : 'start';
        const baseline = { middle: 'central', top: 'hanging', bottom: 'text-after-edge' }[item.baseline] ?? 'auto';
        const transform = item.rotate ? ` transform="rotate(${(item.rotate * 180) / Math.PI} ${num(item.x)} ${num(item.y)})"` : '';
        out.push(`<text x="${num(item.x)}" y="${num(item.y)}" font-size="${item.size ?? 11}" font-weight="${item.weight ?? 400}"${item.italic ? ' font-style="italic"' : ''} text-anchor="${anchor}" dominant-baseline="${baseline}" ${svgPaint('fill', item.fill)}${transform}>${escapeXML(item.text)}</text>`);
        break;
      }
      default:
        break;
    }
  }
  out.push('</svg>');
  return out.join('\n');
}

// --- Axes ----------------------------------------------------------------------------------------

function niceStep(span, target) {
  const raw = span / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(raw));
  const f = raw / power;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * power;
}

export function formatTick(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-3) return v.toExponential(a >= 1e6 ? 1 : 0).replace('e+', 'e');
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}K`;
  return String(+v.toPrecision(4));
}

// A value axis: linear (nice ticks) or log10 (decades). Returns { map(v) → pixel, ticks, lo, hi }.
export function valueScale(lo, hi, p0, p1, options = {}) {
  const log = options.log && lo > 0;
  if (!(hi > lo)) {
    const pad = Math.abs(lo || 1) * 0.1;
    lo -= pad;
    hi += pad;
  }
  if (log) {
    const a = Math.log10(lo);
    const b = Math.log10(hi);
    const map = (v) => p0 + ((Math.log10(Math.max(v, 1e-300)) - a) / (b - a || 1)) * (p1 - p0);
    const ticks = [];
    for (let e = Math.floor(a); e <= Math.ceil(b); e += 1) {
      for (const m of [1, 2, 5]) {
        const v = m * 10 ** e;
        if (v >= lo * 0.999 && v <= hi * 1.001) ticks.push({ value: v, label: formatTick(v), major: m === 1 });
      }
    }
    return { map, ticks, lo, hi, log: true };
  }
  const step = niceStep(hi - lo, options.target ?? 5);
  if (options.nice !== false) {
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
  }
  const map = (v) => p0 + ((v - lo) / (hi - lo || 1)) * (p1 - p0);
  const ticks = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push({ value: Math.abs(v) < step * 1e-9 ? 0 : v, label: formatTick(Math.abs(v) < step * 1e-9 ? 0 : v), major: true });
  return { map, ticks, lo, hi, log: false };
}

// Left axis with grid lines and a rotated title.
export function leftAxis(items, scale, rect, colors, title) {
  for (const tick of scale.ticks) {
    const y = scale.map(tick.value);
    if (y < rect.y - 0.5 || y > rect.y + rect.h + 0.5) continue;
    items.push({ t: 'line', x1: rect.x, y1: y, x2: rect.x + rect.w, y2: y, stroke: colors.grid, width: 1 });
    items.push({ t: 'line', x1: rect.x - 4, y1: y, x2: rect.x, y2: y, stroke: colors.line, width: 1 });
    if (tick.major !== false || !scale.log) items.push({ t: 'text', x: rect.x - 7, y, text: tick.label, fill: colors.text3, size: 10.5, align: 'end', baseline: 'middle' });
  }
  items.push({ t: 'line', x1: rect.x, y1: rect.y, x2: rect.x, y2: rect.y + rect.h, stroke: colors.line, width: 1 });
  if (title) items.push({ t: 'text', x: rect.x - 44, y: rect.y + rect.h / 2, text: title, fill: colors.text2, size: 11.5, weight: 600, align: 'center', baseline: 'middle', rotate: -Math.PI / 2 });
}

export function bottomAxis(items, scale, rect, colors, title) {
  for (const tick of scale.ticks) {
    const x = scale.map(tick.value);
    if (x < rect.x - 0.5 || x > rect.x + rect.w + 0.5) continue;
    items.push({ t: 'line', x1: x, y1: rect.y, x2: x, y2: rect.y + rect.h, stroke: colors.grid, width: 1 });
    items.push({ t: 'line', x1: x, y1: rect.y + rect.h, x2: x, y2: rect.y + rect.h + 4, stroke: colors.line, width: 1 });
    if (tick.label) items.push({ t: 'text', x, y: rect.y + rect.h + 16, text: tick.label, fill: colors.text3, size: 10.5, align: 'center' });
  }
  items.push({ t: 'line', x1: rect.x, y1: rect.y + rect.h, x2: rect.x + rect.w, y2: rect.y + rect.h, stroke: colors.line, width: 1 });
  if (title) items.push({ t: 'text', x: rect.x + rect.w / 2, y: rect.y + rect.h + 34, text: title, fill: colors.text2, size: 11.5, weight: 600, align: 'center' });
}

// --- Interactive chart ---------------------------------------------------------------------------

// Mounts a chart: build(width, height, colors) → { items, hits }. Options: height, tooltip(data)
// → string | Node, onClick(data), name (export file name). Returns { el, redraw, exportSVG,
// exportPNG, destroy }.
export function mountChart(options) {
  const canvas = h('canvas.chart-canvas');
  const tip = h('div.chart-tip', { hidden: true });
  const el = h('div.chart-wrap', { style: { height: `${options.height ?? 320}px` } }, canvas, tip);
  let hits = [];
  let width = 0;
  const height = () => options.height ?? 320;
  const redraw = () => {
    width = Math.max(120, el.clientWidth);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height() * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height()}px`;
    const colors = chartColors();
    const scene = options.build(width, height(), colors) ?? { items: [] };
    hits = scene.hits ?? [];
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height());
    paint(ctx, scene.items, colors);
  };
  const nearest = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best = null;
    let bestD = Infinity;
    for (const hit of hits) {
      const d = Math.hypot(hit.x - x, hit.y - y);
      if (d <= (hit.r ?? 6) + 3 && d < bestD) {
        best = hit;
        bestD = d;
      }
    }
    return { hit: best, x, y };
  };
  canvas.addEventListener('pointermove', (event) => {
    const { hit, x, y } = nearest(event);
    canvas.style.cursor = hit && options.onClick ? 'pointer' : 'default';
    if (!hit || !options.tooltip) {
      tip.hidden = true;
      return;
    }
    const content = options.tooltip(hit.data);
    tip.replaceChildren(...(Array.isArray(content) ? content : [content]).map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
    tip.hidden = false;
    const left = Math.min(x + 14, width - tip.offsetWidth - 4);
    const top = y + 14 + tip.offsetHeight > height() ? y - tip.offsetHeight - 10 : y + 14;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  });
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; });
  canvas.addEventListener('click', (event) => {
    const { hit } = nearest(event);
    if (hit && options.onClick) options.onClick(hit.data);
  });
  const observer = new ResizeObserver(() => {
    if (Math.abs(el.clientWidth - width) > 1) redraw();
  });
  observer.observe(el);
  const fileBase = () => (options.name?.() ?? 'chart').replace(/[^\w.+-]+/g, '_');
  return {
    el,
    redraw,
    exportSVG() {
      const colors = chartColors({ export: true });
      const w = Math.max(width, 480);
      const scene = options.build(w, height(), colors);
      downloadBlob(new Blob([toSVG(scene.items, w, height(), colors)], { type: 'image/svg+xml' }), `${fileBase()}.svg`);
    },
    async exportPNG(scale = 3) {
      const colors = chartColors({ export: true });
      const w = Math.max(width, 480);
      const scene = options.build(w, height(), colors);
      const out = document.createElement('canvas');
      out.width = w * scale;
      out.height = height() * scale;
      const ctx = out.getContext('2d');
      ctx.scale(scale, scale);
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, w, height());
      paint(ctx, scene.items, colors);
      const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
      downloadBlob(blob, `${fileBase()}.png`);
    },
    destroy() {
      observer.disconnect();
      el.remove();
    },
  };
}

// CSV text from rows of cells (quoted where needed).
export function toCSV(rows) {
  return rows.map((row) => row.map((cell) => {
    const text = cell === null || cell === undefined || (typeof cell === 'number' && !Number.isFinite(cell)) ? '' : typeof cell === 'number' ? String(+cell.toPrecision(10)) : String(cell);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',')).join('\n');
}

export function downloadCSV(rows, name) {
  downloadBlob(new Blob([toCSV(rows)], { type: 'text/csv' }), `${name.replace(/[^\w.+-]+/g, '_')}.csv`);
}

// p-value formatting for tables and charts.
export function formatP(p) {
  if (!Number.isFinite(p)) return '—';
  if (p < 1e-4) return p.toExponential(1).replace('e-', '×10⁻').replace(/⁻(\d+)/, (_, d) => `⁻${d.split('').map((c) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[c]).join('')}`);
  if (p < 0.001) return p.toFixed(4);
  if (p < 0.01) return p.toFixed(3);
  return p.toFixed(p < 0.1 ? 3 : 2);
}

export function formatValue(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e5) return v.toExponential(2);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}
