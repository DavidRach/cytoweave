// An interactive plot of one population on one sample: draws the events and the child gates,
// and lets the user draw, select, move and reshape gates with live statistics.

import { h, icon, formatPercent, formatCount } from './dom.js';
import { displayColormap, shownColor } from '../lib/colormaps.js';
import { showMenu, toast } from './overlays.js';
import { buildPlotScene, drawScene, drawGates, fromPixel, toPixel, withAlpha, PLOT_TYPES } from '../lib/plot.js';
import { gateOutline, plotPointToGate, simplifyPolyline, pointTest, translateGeometry, quadrantGates, quadrantNames, splitGates, newId } from '../lib/gates.js';
import { channelTransform, computeStatistic, countOf, evaluateGate, populationSet } from '../lib/engine.js';
import { formatStatistic } from '../lib/stats.js';
import { EventSet } from '../lib/eventset.js';
import { interactionEnded, interactionStarted } from './activity.js';
import { proposalOfGate } from '../lib/proposals.js';
import { markedEvents } from './plate-view.js';
import { createTransform, formatNumber } from '../lib/transforms.js';
import { ROOT, addGates, channelLabel, effectiveGeometry, gateAncestors, gateById, gateChildren, setGateGeometry, uniqueGateName } from '../lib/workspace.js';
import { densityGateAt, valleyThreshold } from '../lib/autogate.js';

const TWO_D_TOOLS = new Set(['rectangle', 'polygon', 'ellipse', 'quadrant', 'lasso', 'wand']);
const ONE_D_TOOLS = new Set(['range', 'split', 'wand']);

function imageFromRaster(raster) {
  const canvas = new OffscreenCanvas(raster.width, raster.height);
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(raster.rgba, raster.width, raster.height), 0, 0);
  return canvas;
}

// Names a new gate from where it sits: "Lymphocytes"-style names for scatter gates, marker
// polarity ("CD4+ CD8−") for fluorescence gates.
export function suggestGateName(ws, view, dims, type, geometry) {
  const label = (channel) => {
    const info = view?.channelInfo(channel);
    return info?.marker || channel.replace(/-[AHW]$/, '');
  };
  const isScatter = (channel) => /^(FSC|SSC|FS|SS)/i.test(channel);
  if (dims.length === 2 && isScatter(dims[0].channel) && isScatter(dims[1].channel)) {
    const a = dims[0].channel.toUpperCase();
    const b = dims[1].channel.toUpperCase();
    const same = a.slice(0, 3) === b.slice(0, 3);
    if (same && /-(A|H|W)$/.test(a) && /-(A|H|W)$/.test(b)) return 'Singlets';
    return 'Cells';
  }
  const polarity = (u) => (u > 0.5 ? '+' : '−');
  const center = (() => {
    if (type === 'polygon') {
      const vs = geometry.vertices;
      return [vs.reduce((s, v) => s + v[0], 0) / vs.length, vs.reduce((s, v) => s + v[1], 0) / vs.length];
    }
    if (type === 'rectangle') return [((geometry.min[0] ?? 0) + (geometry.max[0] ?? 1)) / 2, ((geometry.min[1] ?? 0) + (geometry.max[1] ?? 1)) / 2];
    if (type === 'ellipse') return geometry.center;
    if (type === 'range') return [((geometry.min ?? 0) + (geometry.max ?? 1)) / 2];
    return [0.5, 0.5];
  })();
  if (dims.length === 1) {
    const name = label(dims[0].channel);
    if (/viab|live|dead|zombie|7-?aad|dapi|pi\b|sytox|l\/d/i.test(name)) return center[0] > 0.5 ? 'Dead' : 'Live';
    return `${name}${polarity(center[0])}`;
  }
  const xName = label(dims[0].channel);
  const yName = label(dims[1].channel);
  if (isScatter(dims[0].channel) || isScatter(dims[1].channel)) {
    const marker = isScatter(dims[0].channel) ? yName : xName;
    const u = isScatter(dims[0].channel) ? center[1] : center[0];
    if (/viab|live|dead|zombie|7-?aad|dapi|sytox|l\/d/i.test(marker)) return u > 0.5 ? 'Dead' : 'Live';
    return `${marker}${polarity(u)}`;
  }
  return `${xName}${polarity(center[0])} ${yName}${polarity(center[1])}`;
}

export function createPlotView(app, initial) {
  const { store, data } = app;
  let spec = { ...initial.spec };
  let sampleId = initial.sampleId;
  let compact = initial.compact ?? false;
  let scene = null;
  let draft = null; // gate being drawn: { tool, points, ... }
  let drag = null; // gate being edited
  let hoverPoint = null;
  let renderToken = 0;
  let destroyed = false;
  let lastSize = [0, 0];

  const base = h('canvas.base', { role: 'img' });
  const overlay = h('canvas.overlay', { 'aria-hidden': 'true' });
  const readout = h('div.plot-readout');
  const loading = h('div.plot-loading', 'Loading…');
  const wrap = h('div.plot-canvas-wrap', base, overlay, readout, loading);
  const xButton = h('button.axis-button.x', { type: 'button', title: 'Change the x axis', onclick: (e) => chooseChannel(e.currentTarget, 'x') });
  const yButton = h('button.axis-button.y', { type: 'button', title: 'Change the y axis', onclick: (e) => chooseChannel(e.currentTarget, 'y') });
  wrap.append(xButton, yButton);
  const titleEl = h('span.title');
  const metaEl = h('span.meta');
  const typeButton = h('button.icon-button.small', { type: 'button', title: 'Plot type', onclick: (e) => chooseType(e.currentTarget) });
  const actions = h('div.plot-card-actions',
    typeButton,
    h('button.icon-button.small', { type: 'button', title: 'Swap axes', onclick: () => swapAxes() }, icon('swap')),
    h('button.icon-button.small', { type: 'button', title: 'More', onclick: (e) => moreMenu(e.currentTarget) }, icon('more')));
  const head = h('div.plot-card-head', titleEl, metaEl, initial.hideActions ? null : actions);
  // Under a histogram with overlaid samples: this sample's population compared with each overlay's.
  const compareEl = h('div.plot-compare', { hidden: true });
  const el = h(`div.plot-card${compact ? '.compact' : ''}`, { tabIndex: 0, role: 'group', 'aria-label': 'Plot' }, head, wrap, compareEl);
  if (initial.height) wrap.style.height = `${initial.height}px`;

  const ws = () => store.ws;
  const ui = () => store.ui;
  const is1D = () => !spec.y || spec.type === 'histogram' || spec.type === 'cdf';

  function plotDims(view) {
    const dims = [{ channel: spec.x, transform: channelTransform(ws(), view, spec.x) }];
    dims.push(is1D() ? null : { channel: spec.y, transform: channelTransform(ws(), view, spec.y) });
    return dims;
  }

  // Gates drawn on this plot: children of its population on these axes (either order).
  function visibleGates(view, dims) {
    const parentId = spec.populationId === ROOT ? null : spec.populationId;
    const list = [];
    for (const gate of gateChildren(ws(), parentId)) {
      if (gate.type === 'boolean' || gate.type === 'category') continue;
      const geometry = draftGeometryFor(gate) ?? effectiveGeometry(gate, sampleId);
      const outline = gateOutline(gate, geometry, dims);
      if (!outline) continue;
      list.push({ gate, geometry, outline });
    }
    return list;
  }

  function draftGeometryFor(gate) {
    if (!drag || !drag.geometry) return null;
    if (drag.gateId === gate.id) return drag.geometry;
    if (drag.linkId && gate.linkId === drag.linkId) {
      const own = effectiveGeometry(gate, sampleId);
      if (gate.type === 'quadrant') return { ...own, center: drag.geometry.center };
      if (gate.type === 'split') return { ...own, threshold: drag.geometry.threshold };
    }
    return null;
  }

  function gateLabel(view, gate, geometry, parentIndices) {
    const parentCount = countOf(parentIndices, view);
    if (drag && (drag.gateId === gate.id || (drag.linkId && gate.linkId === drag.linkId))) {
      // While a gate moves, a large parent is sampled (evenly, so the same events each time):
      // the label is an estimate until the gate is dropped.
      const sample = dragSample(view, parentIndices, parentCount);
      const members = evaluateGate(view, ws(), gate, geometry, sample ?? parentIndices);
      if (members === undefined || !parentCount) return '';
      const fraction = countOf(members, view) / (sample ? sample.count : parentCount);
      return `${sample ? '≈ ' : ''}${formatPercent(100 * fraction)}`;
    }
    const indices = populationSet(view, ws(), gate.id);
    if (indices === undefined) return '';
    return parentCount ? formatPercent((100 * countOf(indices, view)) / parentCount) : '';
  }

  // Every k-th event of a parent of more than DRAG_SAMPLE events, kept while it is the same parent.
  const DRAG_SAMPLE = 200000;
  let dragSampleCache = null;
  function dragSample(view, parent, parentCount) {
    if (parentCount <= 2 * DRAG_SAMPLE) return null;
    if (dragSampleCache?.parent === parent && dragSampleCache.view === view) return dragSampleCache.sample;
    const step = parentCount / DRAG_SAMPLE;
    const indices = new Uint32Array(DRAG_SAMPLE);
    if (parent === null) {
      for (let k = 0; k < DRAG_SAMPLE; k += 1) indices[k] = Math.floor(k * step);
    } else {
      const all = view.indicesOf(parent);
      for (let k = 0; k < DRAG_SAMPLE; k += 1) indices[k] = all[Math.floor(k * step)];
    }
    const sample = EventSet.fromIndices(indices, view.eventCount);
    dragSampleCache = { view, parent, sample };
    return sample;
  }

  function sizeCanvas(canvas, width, height) {
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function theme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  async function render() {
    if (destroyed) return;
    const token = ++renderToken;
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    if (!width || !height) return;
    lastSize = [width, height];
    let view = data.view(sampleId);
    if (!view) {
      loading.textContent = data.statusOf(sampleId) === 'missing' ? 'Data not in the library' : 'Loading…';
      loading.hidden = false;
      try {
        view = await data.ensure(sampleId);
      } catch (error) {
        loading.textContent = error.message;
        return;
      }
      if (token !== renderToken || destroyed) return;
    }
    if (!view.hasChannel(spec.x) || (!is1D() && !view.hasChannel(spec.y))) {
      loading.hidden = false;
      loading.textContent = `This sample has no ${!view.hasChannel(spec.x) ? spec.x : spec.y} channel.`;
      updateHeader(view, null);
      return;
    }
    const indices = populationSet(view, ws(), spec.populationId);
    if (indices === undefined) {
      loading.hidden = false;
      loading.textContent = 'This population does not apply to this sample.';
      updateHeader(view, null);
      return;
    }
    loading.hidden = true;
    const dims = plotDims(view);
    const xs = view.scaled(spec.x, dims[0].transform);
    const ys = dims[1] ? view.scaled(spec.y, dims[1].transform) : null;
    const overlays = [];
    // Backgating: show a selected descendant population in color within this plot.
    const selected = ui().gateId;
    if (ui().backgate && selected && selected !== spec.populationId) {
      const ancestors = gateAncestors(ws(), selected).map((g) => g.id);
      const isDescendant = spec.populationId === ROOT || ancestors.includes(spec.populationId);
      if (isDescendant) {
        const sub = populationSet(view, ws(), selected);
        const gate = gateById(ws(), selected);
        if (sub !== undefined && gate) overlays.push({ xs, ys, indices: sub, color: shownColor(ws(), gate), label: gate.name });
      }
    }
    for (const extra of spec.overlays ?? []) {
      const other = data.view(extra.sampleId);
      if (!other) {
        data.ensure(extra.sampleId).then(() => schedule(), () => {});
        continue;
      }
      const otherIndices = populationSet(other, ws(), extra.populationId ?? spec.populationId);
      if (otherIndices === undefined || !other.hasChannel(spec.x)) continue;
      overlays.push({ xs: other.scaled(spec.x, dims[0].transform), ys: dims[1] && other.hasChannel(spec.y) ? other.scaled(spec.y, dims[1].transform) : null, indices: otherIndices, color: extra.color, label: extra.label });
    }
    const options = {
      ...(spec.options ?? {}),
      theme: theme(),
      colormap: spec.options?.colormap ?? ui().colormap,
      compact,
    };
    scene = buildPlotScene({
      width,
      height,
      type: is1D() ? (spec.type === 'cdf' ? 'cdf' : 'histogram') : spec.type,
      x: { channel: spec.x, transform: dims[0].transform, label: channelLabel(ws(), spec.x) },
      y: dims[1] ? { channel: spec.y, transform: dims[1].transform, label: channelLabel(ws(), spec.y) } : undefined,
      xs,
      ys,
      indices,
      overlays: is1D() ? overlays.map((o) => ({ ...o, ys: null })) : overlays,
      // With other samples overlaid, the legend names this one too.
      label: is1D() && spec.overlays?.length ? ws().samples.find((s) => s.id === sampleId)?.name : undefined,
      options: { ...options, color: spec.options?.color ?? populationColor() },
    });
    const ctx = sizeCanvas(base, width, height);
    ctx.clearRect(0, 0, width, height);
    drawScene(ctx, scene, imageFromRaster, { gates: false });
    view.lastRender = { xs, ys, indices, dims };
    updateHeader(view, indices);
    updateComparison(view);
    positionAxisButtons();
    renderOverlay();
    describe();
  }

  // What the plot shows, for screen readers (the canvas is a picture): its type, axes, population,
  // events and the gates drawn on it with their frequencies.
  let lastCount = Number.NaN;
  function describe() {
    const kind = spec.type === 'histogram' || !spec.y ? 'Histogram' : spec.type === 'cdf' ? 'Cumulative distribution' : `${spec.type[0].toUpperCase()}${spec.type.slice(1)} plot`;
    const axes = spec.y && spec.type !== 'histogram' && spec.type !== 'cdf' ? `${channelLabel(ws(), spec.x)} against ${channelLabel(ws(), spec.y)}` : `of ${channelLabel(ws(), spec.x)}`;
    const shown = scene?.gates?.map((g) => `${g.name}${g.label ? ` ${g.label}` : ''}`).filter(Boolean) ?? [];
    base.setAttribute('aria-label', `${kind} ${axes}: ${titleEl.textContent}${Number.isFinite(lastCount) ? `, ${formatCount(lastCount)} events` : ''}${shown.length ? `. Gates: ${shown.join('; ')}` : ''}.`);
    el.setAttribute('aria-label', `Plot of ${titleEl.textContent}`);
  }

  // % positive (SED and Overton) and probability binning's T(χ) of this sample against each
  // overlaid sample taken as the control, as Tables columns compute them.
  function updateComparison(view) {
    const extras = is1D() && !compact ? (spec.overlays ?? []).filter((o) => data.view(o.sampleId)) : [];
    compareEl.hidden = !extras.length;
    if (!extras.length) return;
    const context = { viewOf: (id) => data.view(id) };
    const value = (stat, extra) => {
      try {
        return computeStatistic(view, ws(), { stat, gateId: spec.populationId, channel: spec.x, control: { sampleId: extra.sampleId, gateId: extra.populationId ?? spec.populationId } }, context);
      } catch {
        return Number.NaN;
      }
    };
    compareEl.replaceChildren(...extras.map((extra) => {
      const [sed, overton, t] = ['sed', 'overton', 'pbT'].map((stat) => value(stat, extra));
      return h('div', { title: 'This sample against the overlaid one as its control: % positive by SED (Bagwell\'s enhanced normalized subtraction) and Overton\'s cumulative subtraction, and probability binning\'s T(χ) (above 4: the distributions differ, p < 0.01).' },
        h('span.swatch', { style: { background: extra.color } }), `vs ${extra.label}: `,
        h('b', `${formatStatistic('sed', sed)}%`), ' positive (SED), ', `${formatStatistic('overton', overton)}% (Overton), T(χ) ${formatStatistic('pbT', t)}`);
    }));
  }

  function populationColor() {
    if (spec.populationId === ROOT) return '#4c78e0';
    return shownColor(ws(), gateById(ws(), spec.populationId)) ?? '#4c78e0';
  }

  function updateHeader(view, indices) {
    const gate = spec.populationId === ROOT ? null : gateById(ws(), spec.populationId);
    titleEl.textContent = spec.title ?? (gate ? gate.name : 'All events');
    const count = view && indices !== undefined ? countOf(indices, view) : view?.eventCount;
    metaEl.textContent = view && indices !== undefined ? `${formatCount(count)} events` : '';
    lastCount = count;
    typeButton.replaceChildren(icon(spec.type === 'histogram' || spec.type === 'cdf' || !spec.y ? 'histogram' : spec.type === 'contour' || spec.type === 'zebra' ? 'contour' : spec.type === 'density' ? 'density' : 'dots'));
  }

  function positionAxisButtons() {
    if (!scene) return;
    xButton.textContent = channelLabel(ws(), spec.x);
    xButton.style.bottom = '0px';
    xButton.style.left = `${scene.plotRect.x + scene.plotRect.w / 2}px`;
    if (is1D()) {
      yButton.hidden = true;
    } else {
      yButton.hidden = false;
      yButton.textContent = channelLabel(ws(), spec.y);
      yButton.style.top = `${scene.plotRect.y + scene.plotRect.h / 2}px`;
      yButton.style.left = `${scene.margins.compact ? 9 : 13}px`;
    }
    // The canvas draws the axis titles too; the buttons sit over them to make them clickable.
    xButton.style.color = 'transparent';
    yButton.style.color = 'transparent';
  }

  function renderOverlay() {
    if (!scene) return;
    const [width, height] = lastSize;
    const ctx = sizeCanvas(overlay, width, height);
    ctx.clearRect(0, 0, width, height);
    const view = data.view(sampleId);
    if (!view) return;
    const dims = plotDims(view);
    const parentIndices = populationSet(view, ws(), spec.populationId);
    const items = visibleGates(view, dims);
    const selectedId = ui().gateId;
    scene.gates = items.map(({ gate, geometry, outline }) => ({
      id: gate.id,
      outline,
      name: compact && items.length > 2 ? '' : proposalOfGate(ws(), gate) ? `${gate.name} (proposed)` : gate.name,
      proposed: Boolean(proposalOfGate(ws(), gate)),
      label: parentIndices === undefined ? '' : gateLabel(view, gate, geometry, parentIndices),
      color: shownColor(ws(), gate),
      selected: gate.id === selectedId || (gate.linkId && gateById(ws(), selectedId)?.linkId === gate.linkId),
      dashed: Boolean(gate.overrides?.[sampleId]),
      level: 0.55,
    }));
    drawGates(ctx, scene, { handles: !compact });
    drawMarked(ctx, view, dims);
    if (draft) drawDraft(ctx);
    if (hoverPoint && !draft && !drag && scene) {
      const [u, v] = hoverPoint;
      const tx = createTransform(dims[0].transform);
      const parts = [`x ${formatNumber(tx.inverse(u))}`];
      if (dims[1]) parts.push(`y ${formatNumber(createTransform(dims[1].transform).inverse(v))}`);
      readout.textContent = parts.join('  ');
    }
  }

  // Cells marked from the index-sort plate: a ring (a line on a histogram) with the well's name.
  function drawMarked(ctx, view, dims) {
    const marked = app.store.ui.marked;
    if (!marked || marked.sampleId !== sampleId) return;
    const events = markedEvents(app.store, sampleId, spec.populationId, view, ws());
    if (!events.length) return;
    const xs = view.scaled(spec.x, dims[0].transform);
    const ys = dims[1] ? view.scaled(spec.y, dims[1].transform) : null;
    const r = scene.plotRect;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    ctx.save();
    for (const e of events) {
      const [px, py] = toPixel(scene, xs[e], ys ? ys[e] : 0.5);
      const x = clamp(px, r.x, r.x + r.w);
      const y = clamp(py, r.y, r.y + r.h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      if (ys) {
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#e8590c';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.strokeStyle = '#e8590c';
        ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke();
      }
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      ctx.fillStyle = '#e8590c';
      ctx.fillText(marked.well, Math.min(x + 10, r.x + r.w - 28), Math.max(y - 9, r.y + 11));
    }
    ctx.restore();
  }

  function drawDraft(ctx) {
    const r = scene.plotRect;
    ctx.save();
    ctx.strokeStyle = '#5b4ce6';
    ctx.fillStyle = 'rgba(91,76,230,0.10)';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([6, 4]);
    const P = ([u, v]) => toPixel(scene, u, v);
    const pts = draft.points;
    if (draft.tool === 'rectangle' && pts.length === 2) {
      const [a, b] = [P(pts[0]), P(pts[1])];
      ctx.beginPath();
      ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      ctx.fill();
      ctx.stroke();
    } else if (draft.tool === 'ellipse' && pts.length === 2) {
      const [a, b] = [P(pts[0]), P(pts[1])];
      ctx.beginPath();
      ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if ((draft.tool === 'polygon' || draft.tool === 'lasso') && pts.length) {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const [x, y] = P(p);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      if (draft.tool === 'polygon' && draft.cursor) ctx.lineTo(...P(draft.cursor));
      if (draft.tool === 'lasso') ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      if (draft.tool === 'polygon') {
        pts.forEach((p, i) => {
          const [x, y] = P(p);
          ctx.fillStyle = i === 0 ? '#5b4ce6' : '#ffffff';
          ctx.beginPath();
          ctx.arc(x, y, i === 0 ? 4.5 : 3.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        });
      }
    } else if (draft.tool === 'range' && pts.length === 2) {
      const [a, b] = [P(pts[0]), P(pts[1])];
      ctx.fillRect(Math.min(a[0], b[0]), r.y, Math.abs(b[0] - a[0]), r.h);
      ctx.strokeRect(Math.min(a[0], b[0]), r.y, Math.abs(b[0] - a[0]), r.h);
    }
    ctx.restore();
  }

  function schedule() {
    if (destroyed) return;
    cancelAnimationFrame(schedule.frame);
    schedule.frame = requestAnimationFrame(() => render());
  }

  function scheduleOverlay() {
    cancelAnimationFrame(scheduleOverlay.frame);
    scheduleOverlay.frame = requestAnimationFrame(() => renderOverlay());
  }

  // --- Pointer interaction ----------------------------------------------------------------------

  function eventPoint(event) {
    const rect = overlay.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    return { px, py, uv: scene ? fromPixel(scene, px, py) : [0, 0] };
  }

  function insidePlot(px, py) {
    if (!scene) return false;
    const r = scene.plotRect;
    return px >= r.x - 4 && px <= r.x + r.w + 4 && py >= r.y - 4 && py <= r.y + r.h + 4;
  }

  function hitTest(px, py) {
    if (!scene) return null;
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 7;
    // Handles of the selected gate first.
    for (const item of scene.gates) {
      if (!item.selected) continue;
      const o = item.outline;
      if (o.kind === 'polygon' && o.vertices && !o.ellipse) {
        for (let i = 0; i < o.vertices.length; i += 1) {
          if (near(toPixel(scene, ...o.vertices[i]), [px, py])) return { id: item.id, part: 'vertex', index: i, rect: o.rect };
        }
      }
      if (o.kind === 'quadrant' && near(toPixel(scene, ...o.center), [px, py])) return { id: item.id, part: 'center' };
    }
    const [u, v] = fromPixel(scene, px, py);
    for (let k = scene.gates.length - 1; k >= 0; k -= 1) {
      const item = scene.gates[k];
      const o = item.outline;
      if (o.kind === 'polygon' && pointTest('polygon', { vertices: o.points })(u, v)) return { id: item.id, part: 'body' };
      if (o.kind === 'quadrant') {
        const [cu, cv] = o.center;
        if (Math.abs(toPixel(scene, cu, cv)[0] - px) < 5 || Math.abs(toPixel(scene, cu, cv)[1] - py) < 5) return { id: item.id, part: 'center' };
      }
      if (o.kind === 'split' && Math.abs(toPixel(scene, o.threshold, 0)[0] - px) < 6) return { id: item.id, part: 'threshold' };
      if (o.kind === 'range') {
        const [x0] = toPixel(scene, o.min ?? 0, 0);
        const [x1] = toPixel(scene, o.max ?? 1, 0);
        if (Math.abs(px - x0) < 6) return { id: item.id, part: 'min' };
        if (Math.abs(px - x1) < 6) return { id: item.id, part: 'max' };
        if (px > x0 && px < x1) return { id: item.id, part: 'body' };
      }
    }
    return null;
  }

  function currentTool() {
    const tool = ui().tool;
    if (is1D() && !ONE_D_TOOLS.has(tool)) return tool === 'pointer' ? 'pointer' : 'range';
    if (!is1D() && !TWO_D_TOOLS.has(tool)) return 'pointer';
    return tool;
  }

  overlay.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !scene) return;
    el.focus({ preventScroll: true });
    app.focusPlot?.(api);
    const { px, py, uv } = eventPoint(event);
    if (!insidePlot(px, py)) return;
    const tool = currentTool();
    const view = data.view(sampleId);
    if (!view) return;
    if (tool === 'pointer') {
      const hit = hitTest(px, py);
      if (!hit) {
        if (ui().gateId && gateById(ws(), ui().gateId)?.parentId === (spec.populationId === ROOT ? null : spec.populationId)) app.selectGate(spec.populationId === ROOT ? null : spec.populationId, { keepPlots: true });
        return;
      }
      const gate = gateById(ws(), hit.id);
      if (!gate) return;
      if (ui().gateId !== gate.id) app.selectGate(gate.id, { keepPlots: true });
      drag = { gateId: gate.id, linkId: gate.linkId, part: hit.part, index: hit.index, rect: hit.rect, start: uv, original: effectiveGeometry(gate, sampleId), geometry: null, gate, dims: plotDims(view), moved: false };
      interactionStarted();
      overlay.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === 'quadrant') {
      createGates('quadrant', { center: uv });
      return;
    }
    if (tool === 'split') {
      createGates('split', { threshold: uv[0] });
      return;
    }
    if (tool === 'wand') {
      magicWand(uv);
      return;
    }
    if (tool === 'polygon') {
      if (!draft) draft = { tool, points: [uv] };
      else {
        const first = toPixel(scene, ...draft.points[0]);
        if (draft.points.length >= 3 && Math.hypot(first[0] - px, first[1] - py) < 8) {
          finishPolygon();
          return;
        }
        draft.points.push(uv);
      }
      scheduleOverlay();
      return;
    }
    draft = { tool, points: [uv, uv] };
    interactionStarted();
    overlay.setPointerCapture(event.pointerId);
    scheduleOverlay();
  });

  overlay.addEventListener('pointermove', (event) => {
    if (!scene) return;
    const { px, py, uv } = eventPoint(event);
    hoverPoint = insidePlot(px, py) ? uv : null;
    if (draft) {
      if (draft.tool === 'polygon') draft.cursor = uv;
      else if (draft.tool === 'lasso') {
        const last = draft.points[draft.points.length - 1];
        if (Math.hypot(last[0] - uv[0], last[1] - uv[1]) > 0.004) draft.points.push(uv);
      } else draft.points[1] = uv;
      scheduleOverlay();
      return;
    }
    if (drag) {
      drag.moved = true;
      drag.geometry = dragGeometry(drag, uv);
      scheduleOverlay();
      return;
    }
    const tool = currentTool();
    if (tool === 'pointer') {
      const hit = hitTest(px, py);
      overlay.style.cursor = hit ? (hit.part === 'body' ? 'move' : 'grab') : 'default';
    } else {
      overlay.style.cursor = tool === 'wand' ? 'cell' : 'crosshair';
    }
    scheduleOverlay();
  });

  // The system took the pointer away (a gesture, a dialog): drop what was being drawn or moved.
  overlay.addEventListener('pointercancel', () => {
    if ((draft && draft.tool !== 'polygon') || drag) interactionEnded();
    if (draft?.tool !== 'polygon') draft = null;
    drag = null;
    scheduleOverlay();
  });

  overlay.addEventListener('pointerleave', () => {
    hoverPoint = null;
    readout.textContent = '';
  });

  overlay.addEventListener('pointerup', (event) => {
    if (draft && draft.tool !== 'polygon') {
      const d = draft;
      draft = null;
      interactionEnded();
      finishDrag(d);
      return;
    }
    if (drag) {
      const d = drag;
      drag = null;
      interactionEnded();
      if (d.moved && d.geometry) commitGeometry(d.gate, d.geometry);
      else scheduleOverlay();
    }
    try { overlay.releasePointerCapture(event.pointerId); } catch { /* not captured */ }
  });

  overlay.addEventListener('dblclick', (event) => {
    if (draft?.tool === 'polygon') {
      draft.points.pop();
      finishPolygon();
      return;
    }
    const { px, py } = eventPoint(event);
    const hit = hitTest(px, py);
    if (hit) app.openPopulation(hit.id);
  });

  overlay.addEventListener('contextmenu', (event) => {
    const { px, py } = eventPoint(event);
    const hit = hitTest(px, py);
    if (!hit) return;
    event.preventDefault();
    app.gateMenu(hit.id, { x: event.clientX, y: event.clientY }, sampleId);
  });

  // Converts a drag in plot space into the gate's new geometry (in the gate's own space).
  function dragGeometry(d, uv) {
    const gate = d.gate;
    const toGate = (p) => plotPointToGate(p, gate, d.dims);
    const g0 = toGate(d.start);
    const g1 = toGate(uv);
    const delta = [g1[0] - g0[0], (g1[1] ?? 0) - (g0[1] ?? 0)];
    const orig = d.original;
    switch (gate.type) {
      case 'polygon':
        if (d.part === 'vertex') {
          const vertices = orig.vertices.map((v) => v.slice());
          vertices[d.index] = toGate(uv);
          return { vertices };
        }
        return translateGeometry('polygon', orig, delta[0], delta[1]);
      case 'rectangle':
        if (d.part === 'vertex') {
          // Corners in outline order: (min,min) (max,min) (max,max) (min,max).
          const min = orig.min.slice();
          const max = orig.max.slice();
          const p = toGate(uv);
          if (d.index === 0 || d.index === 3) min[0] = p[0]; else max[0] = p[0];
          if (d.index === 0 || d.index === 1) min[1] = p[1]; else max[1] = p[1];
          return { min: [Math.min(min[0], max[0]), Math.min(min[1], max[1])], max: [Math.max(min[0], max[0]), Math.max(min[1], max[1])] };
        }
        return translateGeometry('rectangle', orig, delta[0], delta[1]);
      case 'ellipse':
        return translateGeometry('ellipse', orig, delta[0], delta[1]);
      case 'quadrant':
        return { ...orig, center: toGate(uv) };
      case 'split':
        return { ...orig, threshold: g1[0] };
      case 'range':
        if (d.part === 'min') return { min: Math.min(g1[0], orig.max ?? Infinity), max: orig.max };
        if (d.part === 'max') return { min: orig.min, max: Math.max(g1[0], orig.min ?? -Infinity) };
        return translateGeometry('range', orig, delta[0]);
      default:
        return orig;
    }
  }

  function commitGeometry(gate, geometry) {
    const scope = ui().editScope === 'sample' ? { sampleId } : { editedOn: sampleId };
    store.commit(setGateGeometry(ws(), gate.id, geometry, scope), scope.sampleId ? `Adjust ${gate.name} for this sample` : `Move ${gate.name}`);
  }

  function finishDrag(d) {
    const [a, b] = d.points;
    const tiny = Math.abs(a[0] - b[0]) < 0.004 && Math.abs(a[1] - b[1]) < 0.004;
    if (d.tool === 'rectangle' && !tiny) {
      createGates('rectangle', { min: [Math.min(a[0], b[0]), Math.min(a[1], b[1])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
    } else if (d.tool === 'ellipse' && !tiny) {
      createGates('ellipse', { center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], radii: [Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2], angle: 0 });
    } else if (d.tool === 'range' && Math.abs(a[0] - b[0]) > 0.004) {
      createGates('range', { min: Math.min(a[0], b[0]), max: Math.max(a[0], b[0]) });
    } else if (d.tool === 'lasso' && d.points.length > 4) {
      const vertices = simplifyPolyline(d.points, 0.004);
      if (vertices.length >= 3) createGates('polygon', { vertices });
    }
    scheduleOverlay();
  }

  function finishPolygon() {
    const points = draft?.points ?? [];
    draft = null;
    if (points.length >= 3) createGates('polygon', { vertices: points });
    scheduleOverlay();
  }

  function magicWand(uv) {
    const view = data.view(sampleId);
    const last = view?.lastRender;
    if (!last) return;
    const indices = last.indices ? view.indicesOf(last.indices) : last.indices;
    if (is1D()) {
      const result = valleyThreshold(last.xs, indices);
      createGates('split', { threshold: result.threshold }, { method: 'valley', explanation: result.explanation });
      return;
    }
    const proposal = densityGateAt(last.xs, last.ys, indices, uv[0], uv[1]);
    if (!proposal) {
      toast('No population found there.');
      return;
    }
    createGates('polygon', proposal.geometry, { method: 'density basin', explanation: proposal.explanation });
  }

  // Creates gate(s) from geometry drawn on this plot, in the plot's own transforms.
  function createGates(type, geometry, auto = null) {
    const view = data.view(sampleId);
    if (!view) return;
    const dims = plotDims(view).filter(Boolean).map((d) => ({ channel: d.channel, transform: { ...d.transform } }));
    const parentId = spec.populationId === ROOT ? null : spec.populationId;
    const meta = auto ? { origin: 'auto', method: auto.method, note: auto.explanation, created: new Date().toISOString() } : undefined;
    let gates;
    if (type === 'quadrant') {
      const names = quadrantNames(view.channelInfo(spec.x)?.marker || spec.x.replace(/-[AHW]$/, ''), view.channelInfo(spec.y)?.marker || spec.y.replace(/-[AHW]$/, ''));
      gates = quadrantGates({ parentId, dims, center: geometry.center, names });
    } else if (type === 'split') {
      const name = view.channelInfo(spec.x)?.marker || spec.x.replace(/-[AHW]$/, '');
      gates = splitGates({ parentId, dims: dims.slice(0, 1), threshold: geometry.threshold, xName: name });
    } else {
      const gateDims = type === 'range' ? dims.slice(0, 1) : dims;
      const name = uniqueGateName(ws(), parentId, suggestGateName(ws(), view, gateDims, type, geometry));
      gates = [{ id: newId('g'), parentId, name, type, dims: gateDims, geometry }];
    }
    // Which sample the gate was drawn on: autogating's reference for the shared geometry.
    gates = gates.map((g) => ({ ...g, meta: { origin: 'manual', created: new Date().toISOString(), ...(meta ?? {}), drawnOn: sampleId } }));
    gates = gates.map((g) => ({ ...g, name: uniqueGateName(ws(), parentId, g.name) }));
    const result = addGates(ws(), gates);
    store.commit(result.ws, gates.length > 1 ? `Add ${type} gates` : `Add gate ${gates[0].name}`);
    const created = result.gates[type === 'quadrant' ? 1 : type === 'split' ? 1 : 0];
    if (!ui().stickyTool) store.setUI({ tool: 'pointer' }, ['tool']);
    app.selectGate(created.id, { keepPlots: true, created: true });
    if (gates.length === 1) app.renameGateInline?.(created.id, el);
  }

  // --- Menus -----------------------------------------------------------------------------------

  function chooseChannel(anchor, axis) {
    const view = data.view(sampleId);
    const channels = view ? [...view.parameters.map((p) => p.name), ...view.derived.keys(), ...[...view.computed.keys()].filter((c) => view.hasChannel(c))] : [];
    const items = [];
    if (axis === 'y') items.push({ label: 'Histogram (no y axis)', icon: 'histogram', checked: is1D(), onSelect: () => setSpec({ y: null, type: 'histogram' }) }, '-');
    const groups = [['scatter', 'Scatter'], ['fluorescence', 'Fluorescence'], ['derived', 'Derived'], ['time', 'Time'], ['instrument', 'Instrument']];
    for (const [type, title] of groups) {
      const list = channels.filter((c) => (view.channelInfo(c)?.type ?? 'derived') === type);
      if (!list.length) continue;
      items.push({ section: title });
      for (const channel of list) {
        const info = view.channelInfo(channel);
        items.push({
          label: info?.marker ? `${info.marker}${info.unit ? ` (${info.unit})` : ''}` : channel,
          hint: info?.marker ? channel : '',
          keywords: `${channel} ${info?.label ?? ''}`,
          checked: (axis === 'x' ? spec.x : spec.y) === channel,
          onSelect: () => setSpec(axis === 'x' ? { x: channel } : { y: channel, type: is1D() ? (ui().plotType ?? 'pseudocolor') : spec.type }),
        });
      }
    }
    items.push('-', { label: 'New formula channel…', icon: 'plus', keywords: 'formula ratio derived parameter', onSelect: () => app.formulaDialog?.() });
    showMenu(anchor, items, { search: true, searchPlaceholder: 'Find a channel or marker…' });
  }

  function chooseType(anchor) {
    const items = PLOT_TYPES.map((type) => ({
      label: type.label,
      icon: type.dims === 1 ? 'histogram' : type.id === 'contour' || type.id === 'zebra' ? 'contour' : type.id === 'density' ? 'density' : 'dots',
      checked: spec.type === type.id || (type.id === 'histogram' && is1D() && spec.type !== 'cdf'),
      onSelect: () => {
        if (type.dims === 1) setSpec({ type: type.id, y: null, lastY: spec.y ?? spec.lastY });
        else setSpec({ type: type.id, y: spec.y ?? spec.lastY ?? defaultY() });
      },
    }));
    showMenu(anchor, items);
  }

  function defaultY() {
    const view = data.view(sampleId);
    return view?.parameters.find((p) => p.name !== spec.x && p.type !== 'time')?.name ?? spec.x;
  }

  function swapAxes() {
    if (is1D()) return;
    setSpec({ x: spec.y, y: spec.x });
  }

  function moreMenu(anchor) {
    const items = [
      { label: 'Export as SVG', icon: 'download', onSelect: () => app.exportPlot(api, 'svg') },
      { label: 'Export as PNG', icon: 'download', onSelect: () => app.exportPlot(api, 'png') },
      { label: 'Copy to clipboard', icon: 'copy', onSelect: () => app.exportPlot(api, 'clipboard') },
      '-',
      { label: 'Overlay other samples…', icon: 'layers', onSelect: () => app.chooseOverlays(api) },
      { label: 'Edit axis scales…', icon: 'settings', onSelect: () => app.editScales(spec, sampleId) },
      { label: 'Add to figure', icon: 'figure', onSelect: () => app.addToFigure(spec, sampleId) },
      '-',
      { section: 'Color map' },
      ...['classic', 'viridis', 'magma', 'turbo', 'blues'].map((name) => ({ label: `${name[0].toUpperCase()}${name.slice(1)}${displayColormap(name) !== name ? ' (drawn as Viridis: color-vision-friendly colors)' : ''}`, checked: (spec.options?.colormap ?? ui().colormap) === name, onSelect: () => setSpec({ options: { ...(spec.options ?? {}), colormap: name } }) })),
      { section: 'Dot size' },
      ...[1, 2, 3].map((size) => ({ label: `${size} px`, checked: (spec.options?.dotSize ?? 1) === size, onSelect: () => setSpec({ options: { ...(spec.options ?? {}), dotSize: size } }) })),
      '-',
      { label: 'Duplicate plot', icon: 'copy', onSelect: () => app.duplicatePlot?.(spec) },
      { label: 'Remove plot', icon: 'trash', danger: true, onSelect: () => app.removePlot?.(spec) },
    ];
    showMenu(anchor, items, { align: 'right' });
  }

  function setSpec(patch) {
    spec = { ...spec, ...patch };
    initial.onChange?.(spec);
    schedule();
  }

  // Keyboard: Delete removes the selected gate, arrows nudge it, Escape cancels drawing.
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && draft) {
      draft = null;
      scheduleOverlay();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Enter' && draft?.tool === 'polygon') {
      finishPolygon();
      return;
    }
    if (event.key === 'Backspace' && draft?.tool === 'polygon') {
      draft.points.pop();
      if (!draft.points.length) draft = null;
      scheduleOverlay();
      event.preventDefault();
      return;
    }
    const gate = gateById(ws(), ui().gateId);
    if (!gate || !scene?.gates.some((g) => g.id === gate.id)) return;
    if (event.key.startsWith('Arrow')) {
      const step = event.shiftKey ? 0.02 : 0.004;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowDown' ? -step : event.key === 'ArrowUp' ? step : 0;
      const geometry = effectiveGeometry(gate, sampleId);
      const moved = gate.type === 'quadrant' ? { ...geometry, center: [geometry.center[0] + dx, geometry.center[1] + dy] }
        : gate.type === 'split' ? { ...geometry, threshold: geometry.threshold + dx }
          : translateGeometry(gate.type, geometry, dx, dy);
      commitGeometry(gate, moved);
      event.preventDefault();
    }
  });

  const resize = new ResizeObserver(() => {
    if (wrap.clientWidth !== lastSize[0] || wrap.clientHeight !== lastSize[1]) schedule();
  });
  resize.observe(wrap);

  const api = {
    el,
    get spec() { return spec; },
    get sampleId() { return sampleId; },
    get scene() { return scene; },
    update(next = {}) {
      if (next.spec) spec = { ...spec, ...next.spec };
      if (next.sampleId !== undefined) sampleId = next.sampleId;
      schedule();
    },
    redrawGates: scheduleOverlay,
    render: schedule,
    setSpec,
    canvas: () => [base, overlay],
    refreshOverlay: () => scheduleOverlay(),
    destroy() {
      destroyed = true;
      // A plot removed while a gate was being moved or drawn (the view changed) ends that.
      if (drag || (draft && draft.tool !== 'polygon')) interactionEnded();
      drag = null;
      draft = null;
      resize.disconnect();
      cancelAnimationFrame(schedule.frame);
      el.remove();
    },
    focus() { el.focus(); },
  };
  schedule();
  return api;
}

export { withAlpha };
