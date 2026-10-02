// Plot scenes: a plot described once (raster layer, contours, curves, axes, gates and labels) and
// drawn either to a canvas (on screen, PNG) or as SVG (vector figures). Scene coordinates for data
// are plot units: 0–1 across the plot area, y up.

import { createTransform } from './transforms.js';
import { bin2d, contours, dotRaster, densityRaster, histogram, outlierRaster, overlayRaster, pseudocolorRaster } from './density.js';
import { gateCenter } from './gates.js';

export const PLOT_TYPES = [
  { id: 'pseudocolor', label: 'Pseudocolor', dims: 2 },
  { id: 'dot', label: 'Dot', dims: 2 },
  { id: 'density', label: 'Density', dims: 2 },
  { id: 'contour', label: 'Contour', dims: 2 },
  { id: 'zebra', label: 'Zebra', dims: 2 },
  { id: 'histogram', label: 'Histogram', dims: 1 },
  { id: 'cdf', label: 'Cumulative', dims: 1 },
];

export const THEMES = {
  light: { background: '#ffffff', plot: '#ffffff', axis: '#3b4252', tick: '#5b6475', text: '#1f2430', grid: 'rgba(15,23,42,0.06)', dots: '#1f2937', font: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
  dark: { background: '#11151c', plot: '#0c1016', axis: '#9aa4b5', tick: '#8892a4', text: '#e6e9ef', grid: 'rgba(255,255,255,0.05)', dots: '#d6dbe4', font: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' },
};

export function plotMargins(width, height, options = {}) {
  const compact = options.compact ?? (width < 220 || height < 200);
  if (options.bare) return { left: 4, right: 4, top: 4, bottom: 4, compact: true };
  return compact
    ? { left: 30, right: 8, top: options.title ? 18 : 8, bottom: 26, compact }
    : { left: 56, right: 14, top: options.title ? 30 : 14, bottom: 46, compact };
}

// Builds a scene. input:
//   width, height                CSS pixels of the whole plot (axes included)
//   type                         a PLOT_TYPES id
//   x, y                         { channel, transform, label } (y absent for histograms)
//   xs, ys, indices              scaled columns and the population (null = all events)
//   overlays                     [{ xs, ys, indices, color, label, alpha }]
//   gates                        [{ outline, name, label, color, selected, id }]
//   options                      { colormap, dotSize, smoothing, densityScale, histogramMode,
//                                  offset (ridgeline overlays), title, subtitle, theme, bare,
//                                  showAxes, contourFractions, fill }
export function buildPlotScene(input) {
  const options = input.options ?? {};
  const theme = THEMES[options.theme ?? 'light'] ?? THEMES.light;
  const margins = plotMargins(input.width, input.height, options);
  const plotRect = {
    x: margins.left,
    y: margins.top,
    w: Math.max(10, input.width - margins.left - margins.right),
    h: Math.max(10, input.height - margins.top - margins.bottom),
  };
  const scene = {
    width: input.width,
    height: input.height,
    margins,
    plotRect,
    theme,
    type: input.type,
    raster: null,
    contours: [],
    curves: [],
    gates: input.gates ?? [],
    axes: {},
    title: options.title ?? '',
    subtitle: options.subtitle ?? '',
    legend: input.legend ?? null,
    eventsShown: 0,
  };
  const xTransform = createTransform(input.x.transform);
  scene.axes.x = { label: input.x.label ?? input.x.channel, ticks: xTransform.ticks(), transform: input.x.transform };
  if (input.y) {
    const yTransform = createTransform(input.y.transform);
    scene.axes.y = { label: input.y.label ?? input.y.channel, ticks: yTransform.ticks(), transform: input.y.transform };
  }
  const dotSize = Math.max(1, options.dotSize ?? 1);
  const gridW = Math.max(16, Math.round(plotRect.w * (options.resolution ?? 1) / dotSize));
  const gridH = Math.max(16, Math.round(plotRect.h * (options.resolution ?? 1) / dotSize));
  const count = input.indices ? input.indices.length : input.xs?.length ?? 0;
  scene.eventsShown = count;

  if (input.type === 'histogram' || input.type === 'cdf') {
    buildHistogram(scene, input, options, theme);
    return scene;
  }

  const layers = input.overlays?.length ? input.overlays : null;
  const counts = bin2d(input.xs, input.ys, input.indices, gridW, gridH);
  let rgba;
  switch (input.type) {
    case 'dot': rgba = dotRaster(counts, gridW, gridH, { color: options.dotColor ?? theme.dots }); break;
    case 'density': rgba = densityRaster(counts, gridW, gridH, { colormap: options.colormap ?? 'viridis', scale: options.densityScale, sigma: options.smoothing }); break;
    case 'contour':
    case 'zebra': {
      const result = contours(counts, gridW, gridH, { fractions: options.contourFractions, sigma: options.smoothing });
      scene.contours = result.lines.map((line, i) => ({ segments: line.segments, color: options.contourColor ?? theme.axis, width: i === 0 ? 1.1 : 0.8, fraction: line.fraction }));
      if (input.type === 'zebra' || options.outliers !== false) rgba = outlierRaster(counts, result.smooth, gridW, gridH, result.outlierLevel, { color: options.dotColor ?? theme.dots, alpha: 0.85 });
      break;
    }
    default: rgba = pseudocolorRaster(counts, gridW, gridH, { colormap: options.colormap ?? 'classic', scale: options.densityScale ?? 'log', sigma: options.smoothing });
  }
  if (layers) {
    // Backgating: the base population in gray, overlays in color on top.
    const base = { counts, color: options.baseColor ?? '#b8bec9', alpha: 1 };
    const over = layers.map((layer) => ({ counts: bin2d(layer.xs, layer.ys, layer.indices, gridW, gridH), color: layer.color, alpha: layer.alpha ?? 1 }));
    rgba = overlayRaster([base, ...over], gridW, gridH);
    scene.legend = layers.map((layer) => ({ label: layer.label, color: layer.color }));
  }
  if (rgba) scene.raster = { width: gridW, height: gridH, rgba };
  return scene;
}

function buildHistogram(scene, input, options, theme) {
  const bins = options.bins ?? Math.min(512, Math.max(64, Math.round(scene.plotRect.w / 2)));
  const series = [];
  if (input.xs) series.push({ xs: input.xs, indices: input.indices, color: options.color ?? '#4c78e0', label: input.label ?? '' });
  for (const overlay of input.overlays ?? []) series.push(overlay);
  const mode = options.histogramMode ?? (series.length > 1 ? 'modal' : 'count');
  const offset = options.offset ?? 0;
  const histos = series.map((s) => histogram(s.xs, s.indices, { bins, smooth: options.smooth !== false, sigma: options.smoothing }));
  const globalMax = Math.max(...histos.map((h) => (mode === 'percent' ? (h.total ? h.max / h.total : 0) : h.max)), 1e-12);
  const stacked = offset > 0 && series.length > 1;
  const rowHeight = stacked ? 1 / (1 + (series.length - 1) * offset) : 1;
  histos.forEach((h, k) => {
    const s = series[k];
    const points = new Float64Array((bins + 2) * 2);
    let norm;
    if (scene.type === 'cdf') {
      let acc = 0;
      const cumulative = new Float64Array(bins);
      for (let i = 0; i < bins; i += 1) {
        acc += h.counts[i];
        cumulative[i] = h.total ? acc / h.total : 0;
      }
      for (let i = 0; i < bins; i += 1) {
        points[(i + 1) * 2] = (i + 0.5) / bins;
        points[(i + 1) * 2 + 1] = cumulative[i];
      }
    } else {
      if (mode === 'modal') norm = h.max || 1;
      else if (mode === 'percent') norm = (h.total || 1) * globalMax;
      else norm = globalMax;
      const base = stacked ? k * offset * rowHeight : 0;
      const scale = stacked ? rowHeight * 0.95 : 0.95;
      for (let i = 0; i < bins; i += 1) {
        points[(i + 1) * 2] = (i + 0.5) / bins;
        points[(i + 1) * 2 + 1] = base + (h.smoothed[i] / norm) * scale;
      }
      points[1] = base;
      points[(bins + 1) * 2 + 1] = base;
    }
    points[0] = 0;
    points[(bins + 1) * 2] = 1;
    if (scene.type === 'cdf') {
      points[1] = 0;
      points[(bins + 1) * 2 + 1] = 1;
    }
    scene.curves.push({
      points,
      stroke: s.color,
      fill: scene.type === 'cdf' ? null : (options.fill ?? true) ? hexAlpha(s.color, series.length > 1 ? 0.18 : 0.32) : null,
      label: s.label,
      baseline: stacked ? k * offset * rowHeight : 0,
    });
  });
  scene.axes.y = {
    label: scene.type === 'cdf' ? 'Cumulative fraction' : mode === 'modal' ? 'Normalized to mode' : mode === 'percent' ? 'Frequency' : 'Count',
    ticks: stacked ? [] : scene.type === 'cdf' ? [0, 0.25, 0.5, 0.75, 1].map((v) => ({ position: v, label: String(v), major: true })) : countTicks(globalMax / 0.95, mode),
    transform: null,
  };
  scene.eventsShown = histos.reduce((sum, h) => sum + h.total, 0);
  if (series.length > 1) scene.legend = series.map((s) => ({ label: s.label, color: s.color }));
  scene.histogramMode = mode;
  scene.theme = theme;
}

function countTicks(max, mode) {
  if (mode === 'modal') return [0, 0.25, 0.5, 0.75, 1].map((v) => ({ position: v * 0.95, label: `${Math.round(v * 100)}`, major: true }));
  const top = mode === 'percent' ? max * 100 : max;
  const raw = top / 4;
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  const unit = raw / power;
  const step = (unit < 1.5 ? 1 : unit < 3 ? 2 : unit < 7 ? 5 : 10) * power;
  const ticks = [];
  for (let v = 0; v <= top * 1.0001; v += step) ticks.push({ position: v / top, label: formatCount(v, mode), major: true });
  return ticks;
}

function formatCount(v, mode) {
  if (mode === 'percent') return `${+v.toFixed(2)}%`;
  if (v >= 1000) return `${+(v / 1000).toFixed(1)}K`;
  return String(Math.round(v));
}

function hexAlpha(hex, alpha) {
  const value = hex.replace('#', '');
  const n = Number.parseInt(value.length === 3 ? value.split('').map((c) => c + c).join('') : value, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// --- Coordinates ------------------------------------------------------------------------------

export function toPixel(scene, u, v) {
  const r = scene.plotRect;
  return [r.x + u * r.w, r.y + (1 - v) * r.h];
}

export function fromPixel(scene, px, py) {
  const r = scene.plotRect;
  return [(px - r.x) / r.w, 1 - (py - r.y) / r.h];
}

// --- Canvas drawing ---------------------------------------------------------------------------

// Draws the scene. ctx is a CanvasRenderingContext2D (or OffscreenCanvas context) already scaled
// for the device pixel ratio; `makeImage(raster)` returns a drawable for the raster layer.
export function drawScene(ctx, scene, makeImage, options = {}) {
  const { theme, plotRect: r } = scene;
  ctx.save();
  if (options.background !== false) {
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, scene.width, scene.height);
  }
  ctx.fillStyle = theme.plot;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  if (scene.raster) {
    const image = makeImage(scene.raster);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, r.x, r.y, r.w, r.h);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  for (const contour of scene.contours) {
    ctx.strokeStyle = contour.color;
    ctx.lineWidth = contour.width;
    ctx.beginPath();
    const s = contour.segments;
    for (let i = 0; i < s.length; i += 4) {
      ctx.moveTo(r.x + s[i] * r.w, r.y + (1 - s[i + 1]) * r.h);
      ctx.lineTo(r.x + s[i + 2] * r.w, r.y + (1 - s[i + 3]) * r.h);
    }
    ctx.stroke();
  }
  for (const curve of scene.curves) {
    const p = curve.points;
    ctx.beginPath();
    ctx.moveTo(r.x + p[0] * r.w, r.y + (1 - p[1]) * r.h);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(r.x + p[i] * r.w, r.y + (1 - p[i + 1]) * r.h);
    if (curve.fill) {
      ctx.fillStyle = curve.fill;
      ctx.fill();
    }
    ctx.strokeStyle = curve.stroke;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  if (options.gates !== false) drawGates(ctx, scene, options);
  ctx.restore();
  if (scene.margins.left > 6) drawAxes(ctx, scene);
  if (scene.legend && options.legend !== false) drawLegend(ctx, scene);
  if (scene.title) {
    ctx.fillStyle = theme.text;
    ctx.font = `600 ${scene.margins.compact ? 10 : 12}px ${theme.font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(ellipsize(ctx, scene.title, scene.width - 12), r.x, scene.margins.compact ? 13 : 19);
  }
  ctx.restore();
}

function ellipsize(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t}…`;
}

export function drawGates(ctx, scene, options = {}) {
  const r = scene.plotRect;
  const px = (u) => r.x + u * r.w;
  const py = (v) => r.y + (1 - v) * r.h;
  for (const gate of scene.gates) {
    const outline = gate.outline;
    if (!outline) continue;
    const color = gate.color ?? '#111827';
    ctx.strokeStyle = color;
    ctx.lineWidth = gate.selected ? 2.2 : 1.5;
    ctx.setLineDash(gate.dashed ? [5, 4] : []);
    if (outline.kind === 'polygon') {
      ctx.beginPath();
      outline.points.forEach(([u, v], i) => (i ? ctx.lineTo(px(u), py(v)) : ctx.moveTo(px(u), py(v))));
      ctx.closePath();
      if (gate.selected) {
        ctx.fillStyle = withAlpha(color, 0.08);
        ctx.fill();
      }
      ctx.stroke();
      if (gate.selected && outline.vertices && options.handles !== false) drawHandles(ctx, outline.vertices.map(([u, v]) => [px(u), py(v)]), color);
    } else if (outline.kind === 'range') {
      const lo = outline.min ?? -0.02;
      const hi = outline.max ?? 1.02;
      const level = gate.level ?? 0.5;
      if (outline.axis === 'x') {
        const y = py(level);
        ctx.beginPath();
        ctx.moveTo(px(lo), y); ctx.lineTo(px(hi), y);
        if (outline.min !== null) { ctx.moveTo(px(lo), y - 7); ctx.lineTo(px(lo), y + 7); }
        if (outline.max !== null) { ctx.moveTo(px(hi), y - 7); ctx.lineTo(px(hi), y + 7); }
        ctx.stroke();
      } else {
        const x = px(level);
        ctx.beginPath();
        ctx.moveTo(x, py(lo)); ctx.lineTo(x, py(hi));
        ctx.stroke();
      }
    } else if (outline.kind === 'split') {
      ctx.beginPath();
      if (outline.axis === 'x') { ctx.moveTo(px(outline.threshold), r.y); ctx.lineTo(px(outline.threshold), r.y + r.h); } else { ctx.moveTo(r.x, py(outline.threshold)); ctx.lineTo(r.x + r.w, py(outline.threshold)); }
      ctx.stroke();
    } else if (outline.kind === 'quadrant') {
      const [cu, cv] = outline.center;
      ctx.beginPath();
      ctx.moveTo(px(cu), r.y); ctx.lineTo(px(cu), r.y + r.h);
      ctx.moveTo(r.x, py(cv)); ctx.lineTo(r.x + r.w, py(cv));
      ctx.stroke();
      if (gate.selected) drawHandles(ctx, [[px(cu), py(cv)]], color);
    }
    ctx.setLineDash([]);
  }
  if (options.labels !== false) drawGateLabels(ctx, scene);
}

function drawHandles(ctx, points, color) {
  for (const [x, y] of points) {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(x - 3.5, y - 3.5, 7, 7);
    ctx.fill();
    ctx.stroke();
  }
}

// Gate labels: name and frequency in a small rounded box at the gate's center.
export function gateLabelPosition(scene, gate) {
  const outline = gate.outline;
  if (!outline) return null;
  if (gate.labelAt) return gate.labelAt;
  if (outline.kind === 'quadrant') {
    const [cu, cv] = outline.center;
    const q = outline.quadrant;
    const right = q === 'UR' || q === 'LR';
    const up = q === 'UR' || q === 'UL';
    return [right ? 0.97 : 0.03, up ? 0.96 : 0.04, right ? 'right' : 'left', up ? 'top' : 'bottom'];
  }
  if (outline.kind === 'range') return [((outline.min ?? 0) + (outline.max ?? 1)) / 2, (gate.level ?? 0.5) + 0.05, 'center', 'bottom'];
  if (outline.kind === 'split') return [outline.side === 'hi' ? Math.min(0.97, outline.threshold + 0.03) : Math.max(0.03, outline.threshold - 0.03), 0.92, outline.side === 'hi' ? 'left' : 'right', 'top'];
  const pts = outline.vertices ?? outline.points;
  const [cu, cv] = gateCenter('polygon', { vertices: pts });
  return [Math.min(0.95, Math.max(0.05, cu)), Math.min(0.95, Math.max(0.05, cv)), 'center', 'middle'];
}

function drawGateLabels(ctx, scene) {
  const r = scene.plotRect;
  const font = scene.theme.font;
  for (const gate of scene.gates) {
    if (!gate.outline || gate.hideLabel) continue;
    const pos = gateLabelPosition(scene, gate);
    if (!pos) continue;
    const [u, v, align = 'center', baseline = 'middle'] = pos;
    const lines = [gate.name, gate.label].filter(Boolean);
    if (!lines.length) continue;
    const size = scene.margins.compact ? 9 : 11;
    ctx.font = `600 ${size}px ${font}`;
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width)) + 8;
    const height = lines.length * (size + 2) + 4;
    let x = r.x + u * r.w;
    let y = r.y + (1 - v) * r.h;
    if (align === 'center') x -= width / 2;
    else if (align === 'right') x -= width;
    if (baseline === 'middle') y -= height / 2;
    else if (baseline === 'bottom') y -= height;
    x = Math.min(Math.max(x, r.x + 1), r.x + r.w - width - 1);
    y = Math.min(Math.max(y, r.y + 1), r.y + r.h - height - 1);
    ctx.fillStyle = 'rgba(255,255,255,0.86)';
    roundRect(ctx, x, y, width, height, 3);
    ctx.fill();
    ctx.strokeStyle = withAlpha(gate.color ?? '#111827', 0.6);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? '#111827' : withAlpha(gate.color ?? '#111827', 1);
      ctx.font = `${i === 0 ? 600 : 700} ${size}px ${font}`;
      ctx.fillText(line, x + 4, y + 2 + i * (size + 2));
    });
  }
}

function roundRect(ctx, x, y, w, h, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

export function withAlpha(color, alpha) {
  if (!color.startsWith('#')) return color;
  return hexAlpha(color, alpha);
}

function drawAxes(ctx, scene) {
  const { theme, plotRect: r, margins } = scene;
  const compact = margins.compact;
  ctx.strokeStyle = theme.axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(r.x, r.y);
  ctx.lineTo(r.x, r.y + r.h);
  ctx.lineTo(r.x + r.w, r.y + r.h);
  ctx.stroke();
  const tickFont = `${compact ? 8.5 : 10.5}px ${theme.font}`;
  const labelFont = `600 ${compact ? 9.5 : 11.5}px ${theme.font}`;
  ctx.font = tickFont;
  ctx.fillStyle = theme.tick;
  // x ticks
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const tick of scene.axes.x.ticks) {
    const x = r.x + tick.position * r.w;
    ctx.beginPath();
    ctx.moveTo(x, r.y + r.h);
    ctx.lineTo(x, r.y + r.h + (tick.major ? 4 : 2));
    ctx.stroke();
    if (tick.label && !compact) ctx.fillText(tick.label, x, r.y + r.h + 6);
    else if (tick.label && compact && tick.major) ctx.fillText(tick.label, x, r.y + r.h + 4);
  }
  // y ticks
  if (scene.axes.y) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tick of scene.axes.y.ticks) {
      const y = r.y + (1 - tick.position) * r.h;
      ctx.beginPath();
      ctx.moveTo(r.x, y);
      ctx.lineTo(r.x - (tick.major ? 4 : 2), y);
      ctx.stroke();
      if (tick.label) ctx.fillText(tick.label, r.x - 6, y);
    }
  }
  ctx.fillStyle = theme.text;
  ctx.font = labelFont;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(ellipsize(ctx, scene.axes.x.label ?? '', r.w), r.x + r.w / 2, scene.height - (compact ? 2 : 6));
  if (scene.axes.y?.label) {
    ctx.save();
    ctx.translate(compact ? 9 : 13, r.y + r.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, scene.axes.y.label, r.h), 0, 0);
    ctx.restore();
  }
}

function drawLegend(ctx, scene) {
  const r = scene.plotRect;
  const size = scene.margins.compact ? 9 : 10.5;
  ctx.font = `500 ${size}px ${scene.theme.font}`;
  const items = scene.legend.slice(0, 12);
  const width = Math.max(...items.map((item) => ctx.measureText(item.label ?? '').width)) + 22;
  let y = r.y + 6;
  const x = r.x + r.w - width - 6;
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  roundRect(ctx, x - 4, y - 3, width + 8, items.length * (size + 5) + 4, 4);
  ctx.fill();
  for (const item of items) {
    ctx.fillStyle = item.color;
    ctx.fillRect(x, y + 2, 10, size - 2);
    ctx.fillStyle = '#1f2430';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(item.label ?? '', x + 15, y);
    y += size + 5;
  }
}

// --- SVG --------------------------------------------------------------------------------------

function esc(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The scene as SVG markup. The raster layer (if any) is embedded as rasterHref (a PNG data URL
// made by the caller); everything else is vector.
export function sceneToSVG(scene, options = {}) {
  const { theme, plotRect: r, margins } = scene;
  const compact = margins.compact;
  const parts = [];
  const f = (v) => +v.toFixed(2);
  const ox = options.x ?? 0;
  const oy = options.y ?? 0;
  if (!options.embedded) parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" font-family="${esc(theme.font)}">`);
  else parts.push(`<g transform="translate(${f(ox)},${f(oy)})" font-family="${esc(theme.font)}">`);
  if (options.background !== false) parts.push(`<rect width="${scene.width}" height="${scene.height}" fill="${theme.background}"/>`);
  parts.push(`<rect x="${r.x}" y="${r.y}" width="${f(r.w)}" height="${f(r.h)}" fill="${theme.plot}"/>`);
  const clipId = `clip${Math.random().toString(36).slice(2, 8)}`;
  parts.push(`<clipPath id="${clipId}"><rect x="${r.x}" y="${r.y}" width="${f(r.w)}" height="${f(r.h)}"/></clipPath>`);
  parts.push(`<g clip-path="url(#${clipId})">`);
  if (scene.raster && options.rasterHref) parts.push(`<image x="${r.x}" y="${r.y}" width="${f(r.w)}" height="${f(r.h)}" preserveAspectRatio="none" style="image-rendering:pixelated" href="${options.rasterHref}"/>`);
  for (const contour of scene.contours) {
    const s = contour.segments;
    let d = '';
    for (let i = 0; i < s.length; i += 4) d += `M${f(r.x + s[i] * r.w)} ${f(r.y + (1 - s[i + 1]) * r.h)}L${f(r.x + s[i + 2] * r.w)} ${f(r.y + (1 - s[i + 3]) * r.h)}`;
    parts.push(`<path d="${d}" fill="none" stroke="${contour.color}" stroke-width="${contour.width}"/>`);
  }
  for (const curve of scene.curves) {
    const p = curve.points;
    let d = `M${f(r.x + p[0] * r.w)} ${f(r.y + (1 - p[1]) * r.h)}`;
    for (let i = 2; i < p.length; i += 2) d += `L${f(r.x + p[i] * r.w)} ${f(r.y + (1 - p[i + 1]) * r.h)}`;
    parts.push(`<path d="${d}" fill="${curve.fill ?? 'none'}" stroke="${curve.stroke}" stroke-width="1.4"/>`);
  }
  for (const gate of scene.gates) {
    const o = gate.outline;
    if (!o) continue;
    const color = gate.color ?? '#111827';
    if (o.kind === 'polygon') {
      const d = o.points.map(([u, v], i) => `${i ? 'L' : 'M'}${f(r.x + u * r.w)} ${f(r.y + (1 - v) * r.h)}`).join('') + 'Z';
      parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/>`);
    } else if (o.kind === 'quadrant') {
      const x = r.x + o.center[0] * r.w;
      const y = r.y + (1 - o.center[1]) * r.h;
      parts.push(`<path d="M${f(x)} ${r.y}V${f(r.y + r.h)}M${r.x} ${f(y)}H${f(r.x + r.w)}" stroke="${color}" stroke-width="1.5"/>`);
    } else if (o.kind === 'split') {
      const x = r.x + o.threshold * r.w;
      parts.push(`<path d="M${f(x)} ${r.y}V${f(r.y + r.h)}" stroke="${color}" stroke-width="1.5"/>`);
    } else if (o.kind === 'range') {
      const y = r.y + (1 - (gate.level ?? 0.5)) * r.h;
      const x0 = r.x + (o.min ?? 0) * r.w;
      const x1 = r.x + (o.max ?? 1) * r.w;
      parts.push(`<path d="M${f(x0)} ${f(y)}H${f(x1)}M${f(x0)} ${f(y - 7)}V${f(y + 7)}M${f(x1)} ${f(y - 7)}V${f(y + 7)}" stroke="${color}" stroke-width="1.5" fill="none"/>`);
    }
  }
  // Labels
  const size = compact ? 9 : 11;
  for (const gate of scene.gates) {
    if (!gate.outline || gate.hideLabel) continue;
    const pos = gateLabelPosition(scene, gate);
    if (!pos) continue;
    const [u, v, align = 'center'] = pos;
    const x = r.x + u * r.w;
    const y = r.y + (1 - v) * r.h;
    const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
    const lines = [gate.name, gate.label].filter(Boolean);
    lines.forEach((line, i) => {
      parts.push(`<text x="${f(x)}" y="${f(y + (i - (lines.length - 1) / 2) * (size + 2))}" font-size="${size}" font-weight="${i ? 700 : 600}" text-anchor="${anchor}" dominant-baseline="middle" fill="${i ? gate.color ?? '#111827' : '#111827'}" paint-order="stroke" stroke="#ffffff" stroke-width="3" stroke-linejoin="round">${esc(line)}</text>`);
    });
  }
  parts.push('</g>');
  // Axes
  parts.push(`<path d="M${r.x} ${r.y}V${f(r.y + r.h)}H${f(r.x + r.w)}" fill="none" stroke="${theme.axis}"/>`);
  const tickSize = compact ? 8.5 : 10.5;
  for (const tick of scene.axes.x.ticks) {
    const x = r.x + tick.position * r.w;
    parts.push(`<path d="M${f(x)} ${f(r.y + r.h)}v${tick.major ? 4 : 2}" stroke="${theme.axis}"/>`);
    if (tick.label) parts.push(`<text x="${f(x)}" y="${f(r.y + r.h + 6 + tickSize * 0.8)}" font-size="${tickSize}" text-anchor="middle" fill="${theme.tick}">${esc(tick.label)}</text>`);
  }
  if (scene.axes.y) {
    for (const tick of scene.axes.y.ticks) {
      const y = r.y + (1 - tick.position) * r.h;
      parts.push(`<path d="M${r.x} ${f(y)}h${tick.major ? -4 : -2}" stroke="${theme.axis}"/>`);
      if (tick.label) parts.push(`<text x="${r.x - 6}" y="${f(y)}" font-size="${tickSize}" text-anchor="end" dominant-baseline="middle" fill="${theme.tick}">${esc(tick.label)}</text>`);
    }
  }
  const labelSize = compact ? 9.5 : 11.5;
  parts.push(`<text x="${f(r.x + r.w / 2)}" y="${scene.height - (compact ? 3 : 7)}" font-size="${labelSize}" font-weight="600" text-anchor="middle" fill="${theme.text}">${esc(scene.axes.x.label)}</text>`);
  if (scene.axes.y?.label) parts.push(`<text transform="translate(${compact ? 9 : 13},${f(r.y + r.h / 2)}) rotate(-90)" font-size="${labelSize}" font-weight="600" text-anchor="middle" dominant-baseline="middle" fill="${theme.text}">${esc(scene.axes.y.label)}</text>`);
  if (scene.title) parts.push(`<text x="${r.x}" y="${compact ? 13 : 19}" font-size="${compact ? 10 : 12}" font-weight="600" fill="${theme.text}">${esc(scene.title)}</text>`);
  if (scene.legend) {
    let y = r.y + 8;
    const x = r.x + r.w - 110;
    for (const item of scene.legend.slice(0, 12)) {
      parts.push(`<rect x="${f(x)}" y="${f(y)}" width="10" height="8" fill="${item.color}"/><text x="${f(x + 14)}" y="${f(y + 7)}" font-size="10" fill="${theme.text}">${esc(item.label)}</text>`);
      y += 14;
    }
  }
  parts.push(options.embedded ? '</g>' : '</svg>');
  return parts.join('');
}
