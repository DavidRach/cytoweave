// Figures: a page layout editor for publication figures. Plots stay live (they follow gate edits),
// and two builders make the figures most papers need: the gating strategy of a population and a
// grid of the same plot across samples. Exports SVG (vector), PNG and PDF.

import { h, icon, clear, downloadBlob } from './dom.js';
import { showMenu, toast, promptDialog, progressToast } from './overlays.js';
import { drawScene, sceneToSVG } from '../lib/plot.js';
import { newId } from '../lib/gates.js';
import { ROOT, channelLabel, gateAncestors, gateById, gatePath, plotsOf, setCollection } from '../lib/workspace.js';
import { rgbaToRgb, writePDF } from '../lib/pdf.js';
import { prefs } from './storage.js';

const PAGES = [
  { id: 'slide', label: 'Slide 16:9', width: 1600, height: 900 },
  { id: 'letter', label: 'Letter portrait', width: 816, height: 1056 },
  { id: 'a4', label: 'A4 portrait', width: 794, height: 1123 },
  { id: 'letter-l', label: 'Letter landscape', width: 1056, height: 816 },
  { id: 'square', label: 'Square', width: 1000, height: 1000 },
];

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

export function mountFiguresMode(app, container) {
  const { store, data } = app;
  let figureId = store.ws.figures[0]?.id ?? null;
  let selectedItem = null;
  let zoom = 1;

  const listHost = h('div');
  const propsHost = h('div');
  const page = h('div.figure-page');
  const stage = h('div.figure-stage', page);
  const headActions = h('div.btn-row');
  const root = h('div.view',
    h('div.workbench-head', h('h1', icon('figure'), 'Figures'), h('span.spacer'), headActions),
    h('div.figure-layout',
      h('div.figure-side', h('div.pane', h('h3', 'Figures'), listHost), h('div.pane', h('h3', 'Build'), builders())),
      stage,
      h('div.figure-side', h('div.pane', propsHost))));
  container.append(root);

  function figure() {
    return store.ws.figures.find((f) => f.id === figureId) ?? null;
  }

  function save(next, label = 'Edit figure') {
    const figures = store.ws.figures.some((f) => f.id === next.id) ? store.ws.figures.map((f) => (f.id === next.id ? next : f)) : [...store.ws.figures, next];
    store.commit(setCollection(store.ws, 'figures', figures, 'edit-figure'), label, ['figures']);
  }

  function newFigure(items = [], name, preset = PAGES[0]) {
    const fig = { id: newId('f'), name: name ?? `Figure ${store.ws.figures.length + 1}`, width: preset.width, height: preset.height, background: '#ffffff', items };
    figureId = fig.id;
    selectedItem = null;
    save(fig, 'New figure');
    return fig;
  }

  // --- Builders -----------------------------------------------------------------------------------

  function builders() {
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      h('button.btn.block', { type: 'button', onclick: () => gatingStrategy() }, icon('gate'), 'Gating strategy of the selected population'),
      h('button.btn.block', { type: 'button', onclick: () => sampleGrid() }, icon('grid'), 'The current plots across samples'),
      h('button.btn.block', { type: 'button', onclick: () => newFigure() }, icon('plus'), 'Blank page'),
      h('p.muted', { style: { margin: '4px 0 0', fontSize: '11.5px' } }, 'Plots in figures stay live: they follow gate edits and compensation changes until you export.'));
  }

  function gatingStrategy() {
    const ws = store.ws;
    const gateId = store.ui.gateId;
    const sampleId = store.ui.sampleId;
    if (!gateId || !sampleId) {
      toast('Select a population (and a sample) in the Gate view first.');
      return;
    }
    const path = [...gateAncestors(ws, gateId), gateById(ws, gateId)].filter((g) => g && g.type !== 'boolean' && g.type !== 'category');
    const perRow = Math.min(4, path.length);
    const w = 330;
    const hgt = 300;
    const gap = 50;
    const rows = Math.ceil(path.length / perRow);
    const width = Math.max(900, 40 + perRow * w + (perRow - 1) * gap + 40);
    const height = 110 + rows * (hgt + 40) + 30;
    const sample = ws.samples.find((s) => s.id === sampleId);
    const items = [
      { id: newId('i'), kind: 'text', x: 40, y: 28, w: width - 80, h: 34, text: `Gating strategy: ${gatePath(ws, gateId)}`, size: 22, weight: 700 },
      { id: newId('i'), kind: 'text', x: 40, y: 64, w: width - 80, h: 24, text: `${sample?.name ?? ''} · ${sample?.acquisition?.cytometer ?? ''}`.replace(/ · $/, ''), size: 13, weight: 400, color: '#5b6475' },
    ];
    path.forEach((gate, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const x = 40 + col * (w + gap);
      const y = 110 + row * (hgt + 40);
      items.push({
        id: newId('i'),
        kind: 'plot',
        x, y, w, h: hgt,
        sampleId,
        spec: { populationId: gate.parentId ?? ROOT, x: gate.dims[0].channel, y: gate.dims[1]?.channel ?? null, type: gate.dims.length === 1 ? 'histogram' : 'pseudocolor', options: {} },
        title: gate.parentId ? gateById(ws, gate.parentId)?.name : 'All events',
        highlight: gate.id,
      });
      if (col < perRow - 1 && i < path.length - 1) items.push({ id: newId('i'), kind: 'arrow', x: x + w + 8, y: y + hgt / 2 - 10, w: gap - 16, h: 20 });
    });
    newFigure(items, `Gating strategy – ${gateById(ws, gateId).name}`, { width, height });
    toast('Built the gating strategy figure. Drag plots to arrange them; export as SVG for editing in Illustrator or Inkscape.', { kind: 'ok' });
  }

  function sampleGrid() {
    const ws = store.ws;
    const pop = store.ui.gateId ?? ROOT;
    const plots = plotsOf(ws, pop);
    if (!plots.length) {
      toast('Show at least one plot of the population in the Gate view first.');
      return;
    }
    const group = store.ui.groupFilter && !store.ui.groupFilter.startsWith('role:') ? ws.groups.find((g) => g.id === store.ui.groupFilter) : null;
    const samples = ws.samples.filter((s) => (group ? group.sampleIds.includes(s.id) : s.role === 'sample')).slice(0, 24);
    const cell = 240;
    const width = 160 + plots.length * (cell + 16) + 40;
    const height = 80 + samples.length * (cell + 16) + 20;
    const items = [{ id: newId('i'), kind: 'text', x: 40, y: 24, w: width - 80, h: 34, text: `${pop === ROOT ? 'All events' : gateById(ws, pop)?.name} across ${group ? group.name : 'samples'}`, size: 20, weight: 700 }];
    samples.forEach((sample, r) => {
      items.push({ id: newId('i'), kind: 'text', x: 20, y: 80 + r * (cell + 16) + cell / 2 - 12, w: 130, h: 24, text: sample.name, size: 13, weight: 600, align: 'right' });
      plots.forEach((plot, c) => {
        items.push({ id: newId('i'), kind: 'plot', x: 160 + c * (cell + 16), y: 80 + r * (cell + 16), w: cell, h: cell, sampleId: sample.id, spec: { populationId: pop, x: plot.x, y: plot.y, type: plot.type, options: plot.options ?? {} }, title: '' });
      });
    });
    newFigure(items, `${pop === ROOT ? 'All events' : gateById(ws, pop)?.name} across samples`, { width, height });
  }

  // --- Page rendering -----------------------------------------------------------------------------

  async function renderPlotItem(item, el) {
    const canvas = el.querySelector('canvas') ?? h('canvas');
    if (!canvas.parentNode) el.append(canvas);
    const view = data.view(item.sampleId) ?? await data.ensure(item.sampleId).catch(() => null);
    if (!view) {
      el.dataset.missing = 'Sample not available';
      return;
    }
    const scene = sceneFor(item, view, true);
    if (!scene) return;
    const dpr = (window.devicePixelRatio || 1) * Math.min(2, Math.max(1, zoom));
    canvas.width = Math.round(item.w * dpr);
    canvas.height = Math.round(item.h * dpr);
    canvas.style.width = `${item.w}px`;
    canvas.style.height = `${item.h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawScene(ctx, scene, rasterImage);
  }

  // In the scaled-down preview, dots are drawn larger so sparse populations stay visible.
  function sceneFor(item, view, preview = false) {
    try {
      const dotSize = item.spec.options?.dotSize ?? (preview ? Math.max(1, Math.round(1 / Math.max(zoom, 0.25))) : 1);
      const spec = { ...item.spec, options: { ...(item.spec.options ?? {}), dotSize } };
      const scene = app.buildExportScene(store.ws, view, spec, { width: item.w, height: item.h, theme: 'light', title: item.title ?? '' });
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

  function renderPage() {
    clear(page);
    const fig = figure();
    if (!fig) {
      page.style.width = '640px';
      page.style.height = '420px';
      page.append(h('div.empty', { style: { height: '100%' } }, icon('figure'), h('h3', 'Publication figures'), h('p', 'Build the gating strategy of a population in one click, or a grid of plots across samples. Figures stay live until you export them as SVG, PNG or PDF.')));
      return;
    }
    const available = stage.clientWidth - 40;
    zoom = Math.min(1.4, Math.max(0.2, available / fig.width));
    page.style.width = `${fig.width}px`;
    page.style.height = `${fig.height}px`;
    page.style.background = fig.background ?? '#fff';
    page.style.transform = `scale(${zoom})`;
    page.parentElement.style.height = `${fig.height * zoom + 40}px`;
    for (const item of fig.items) {
      const el = h(`div.figure-item.${item.kind}${item.id === selectedItem ? '.selected' : ''}`, { style: { left: `${item.x}px`, top: `${item.y}px`, width: `${item.w}px`, height: `${item.h}px` }, dataset: { id: item.id } });
      if (item.kind === 'text') {
        el.append(h('div', { style: { fontSize: `${item.size ?? 14}px`, fontWeight: String(item.weight ?? 400), textAlign: item.align ?? 'left', color: item.color ?? '#171b26', whiteSpace: 'pre-wrap', lineHeight: 1.25 } }, item.text));
      } else if (item.kind === 'arrow') {
        el.append(h('div.figure-arrow'));
      } else {
        renderPlotItem(item, el);
      }
      el.append(h('div.figure-handle'));
      attachDrag(el, item);
      page.append(el);
    }
  }

  function attachDrag(el, item) {
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      selectedItem = item.id;
      for (const other of page.querySelectorAll('.figure-item.selected')) other.classList.remove('selected');
      el.classList.add('selected');
      renderProps();
      const resizing = event.target.classList.contains('figure-handle');
      const start = { x: event.clientX, y: event.clientY, item: { ...item } };
      el.setPointerCapture(event.pointerId);
      let moved = false;
      const move = (e) => {
        const dx = (e.clientX - start.x) / zoom;
        const dy = (e.clientY - start.y) / zoom;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        const snap = (v) => Math.round(v / 5) * 5;
        if (resizing) {
          el.style.width = `${Math.max(40, snap(start.item.w + dx))}px`;
          el.style.height = `${Math.max(20, snap(start.item.h + dy))}px`;
        } else {
          el.style.left = `${snap(start.item.x + dx)}px`;
          el.style.top = `${snap(start.item.y + dy)}px`;
        }
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        if (!moved) return;
        const fig = figure();
        const patch = resizing ? { w: Number.parseFloat(el.style.width), h: Number.parseFloat(el.style.height) } : { x: Number.parseFloat(el.style.left), y: Number.parseFloat(el.style.top) };
        save({ ...fig, items: fig.items.map((it) => (it.id === item.id ? { ...it, ...patch } : it)) }, resizing ? 'Resize item' : 'Move item');
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }

  stage.addEventListener('pointerdown', (event) => {
    if (event.target === stage || event.target === page) {
      selectedItem = null;
      for (const other of page.querySelectorAll('.figure-item.selected')) other.classList.remove('selected');
      renderProps();
    }
  });

  // --- Properties ---------------------------------------------------------------------------------

  function updateItem(patch, label = 'Edit item') {
    const fig = figure();
    save({ ...fig, items: fig.items.map((it) => (it.id === selectedItem ? { ...it, ...patch } : it)) }, label);
  }

  function renderProps() {
    clear(propsHost);
    const fig = figure();
    const ws = store.ws;
    if (!fig) {
      propsHost.append(h('h3', 'Properties'), h('p.muted', 'Create a figure to edit its layout.'));
      return;
    }
    const item = fig.items.find((it) => it.id === selectedItem);
    if (!item) {
      const pageSelect = h('select.input.small', { onchange: (event) => { const preset = PAGES.find((p) => p.id === event.target.value); if (preset) save({ ...fig, width: preset.width, height: preset.height }, 'Page size'); } },
        h('option', { value: '' }, `${fig.width} × ${fig.height}`), ...PAGES.map((p) => h('option', { value: p.id }, `${p.label} (${p.width} × ${p.height})`)));
      propsHost.append(h('h3', 'Page'),
        h('label.field', h('span', 'Name'), h('input.input.small', { value: fig.name, onchange: (event) => save({ ...fig, name: event.target.value }, 'Rename figure') })),
        h('label.field', h('span', 'Size'), pageSelect),
        h('div.row',
          h('label.field', h('span', 'Width'), h('input.input.small', { type: 'number', value: fig.width, onchange: (event) => save({ ...fig, width: Number(event.target.value) || fig.width }, 'Page size') })),
          h('label.field', h('span', 'Height'), h('input.input.small', { type: 'number', value: fig.height, onchange: (event) => save({ ...fig, height: Number(event.target.value) || fig.height }, 'Page size') }))),
        h('div.btn-row', { style: { marginTop: '8px' } },
          h('button.btn.small', { type: 'button', onclick: () => addItem('text') }, icon('plus'), 'Text'),
          h('button.btn.small', { type: 'button', onclick: () => addItem('plot') }, icon('plus'), 'Plot of the current population'),
          h('button.btn.small', { type: 'button', onclick: () => addItem('arrow') }, icon('plus'), 'Arrow')),
        h('p.muted', { style: { marginTop: '10px', fontSize: '11.5px' } }, 'Click an item to edit it; drag to move (snaps to 5 px); drag its corner to resize. Delete removes the selected item.'));
      return;
    }
    propsHost.append(h('h3', item.kind === 'plot' ? 'Plot' : item.kind === 'text' ? 'Text' : 'Arrow', h('span.spacer'),
      h('button.icon-button.small', { type: 'button', title: 'Duplicate', onclick: () => duplicateItem(item) }, icon('copy')),
      h('button.icon-button.small', { type: 'button', title: 'Delete', onclick: () => removeItem(item) }, icon('trash'))));
    if (item.kind === 'text') {
      const area = h('textarea.input', { rows: 4, value: item.text });
      area.addEventListener('change', () => updateItem({ text: area.value }));
      propsHost.append(h('label.field', h('span', 'Text'), area),
        h('div.row',
          h('label.field', h('span', 'Size'), h('input.input.small', { type: 'number', value: item.size ?? 14, onchange: (event) => updateItem({ size: Number(event.target.value) }) })),
          h('label.field', h('span', 'Weight'), h('select.input.small', { onchange: (event) => updateItem({ weight: Number(event.target.value) }) }, ...[400, 500, 600, 700].map((w) => h('option', { value: w, selected: (item.weight ?? 400) === w }, String(w))))),
          h('label.field', h('span', 'Align'), h('select.input.small', { onchange: (event) => updateItem({ align: event.target.value }) }, ...['left', 'center', 'right'].map((a) => h('option', { value: a, selected: (item.align ?? 'left') === a }, a))))),
        h('label.field', h('span', 'Color'), h('input', { type: 'color', value: item.color ?? '#171b26', onchange: (event) => updateItem({ color: event.target.value }) })));
      return;
    }
    if (item.kind === 'plot') {
      const sampleSelect = h('select.input.small', { onchange: (event) => updateItem({ sampleId: event.target.value }) }, ...ws.samples.map((s) => h('option', { value: s.id, selected: s.id === item.sampleId }, s.name)));
      const popSelect = h('select.input.small', { onchange: (event) => updateItem({ spec: { ...item.spec, populationId: event.target.value } }) }, h('option', { value: ROOT }, 'All events'), ...ws.gates.map((g) => h('option', { value: g.id, selected: g.id === item.spec.populationId }, gatePath(ws, g.id))));
      const sample = ws.samples.find((s) => s.id === item.sampleId);
      const channels = sample?.channels ?? [];
      const xSelect = h('select.input.small', { onchange: (event) => updateItem({ spec: { ...item.spec, x: event.target.value } }) }, ...channels.map((c) => h('option', { value: c.name, selected: c.name === item.spec.x }, channelLabel(ws, c.name))));
      const ySelect = h('select.input.small', { onchange: (event) => updateItem({ spec: { ...item.spec, y: event.target.value || null, type: event.target.value ? (item.spec.type === 'histogram' ? 'pseudocolor' : item.spec.type) : 'histogram' } }) }, h('option', { value: '' }, '(histogram)'), ...channels.map((c) => h('option', { value: c.name, selected: c.name === item.spec.y }, channelLabel(ws, c.name))));
      const typeSelect = h('select.input.small', { onchange: (event) => updateItem({ spec: { ...item.spec, type: event.target.value } }) }, ...['pseudocolor', 'dot', 'density', 'contour', 'zebra', 'histogram', 'cdf'].map((t) => h('option', { value: t, selected: t === item.spec.type }, t)));
      propsHost.append(
        h('label.field', h('span', 'Title'), h('input.input.small', { value: item.title ?? '', onchange: (event) => updateItem({ title: event.target.value }) })),
        h('label.field', h('span', 'Sample'), sampleSelect),
        h('label.field', h('span', 'Population'), popSelect),
        h('label.field', h('span', 'X axis'), xSelect),
        h('label.field', h('span', 'Y axis'), ySelect),
        h('label.field', h('span', 'Type'), typeSelect));
    }
  }

  function addItem(kind) {
    const fig = figure();
    if (!fig) return;
    const sampleId = store.ui.sampleId ?? store.ws.samples[0]?.id;
    const pop = store.ui.gateId ?? ROOT;
    const plot = plotsOf(store.ws, pop)[0];
    const item = kind === 'text'
      ? { id: newId('i'), kind, x: 40, y: 40, w: 400, h: 40, text: 'Text', size: 18, weight: 600 }
      : kind === 'arrow'
        ? { id: newId('i'), kind, x: 60, y: 60, w: 50, h: 20 }
        : { id: newId('i'), kind: 'plot', x: 60, y: 100, w: 320, h: 300, sampleId, spec: { populationId: pop, x: plot?.x ?? store.ws.samples[0]?.channels[0]?.name, y: plot?.y ?? null, type: plot?.type ?? 'pseudocolor', options: {} }, title: pop === ROOT ? 'All events' : gateById(store.ws, pop)?.name };
    selectedItem = item.id;
    save({ ...fig, items: [...fig.items, item] }, `Add ${kind}`);
  }

  function duplicateItem(item) {
    const fig = figure();
    const copy = { ...item, id: newId('i'), x: item.x + 20, y: item.y + 20 };
    selectedItem = copy.id;
    save({ ...fig, items: [...fig.items, copy] }, 'Duplicate item');
  }

  function removeItem(item) {
    const fig = figure();
    selectedItem = null;
    save({ ...fig, items: fig.items.filter((it) => it.id !== item.id) }, 'Remove item');
  }

  // --- Export -------------------------------------------------------------------------------------

  async function scenesFor(fig) {
    const out = new Map();
    for (const item of fig.items) {
      if (item.kind !== 'plot') continue;
      const view = data.view(item.sampleId) ?? await data.ensure(item.sampleId).catch(() => null);
      if (view) out.set(item.id, sceneFor(item, view));
    }
    return out;
  }

  async function renderToCanvas(fig, scale) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(fig.width * scale);
    canvas.height = Math.round(fig.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = fig.background ?? '#ffffff';
    ctx.fillRect(0, 0, fig.width, fig.height);
    const scenes = await scenesFor(fig);
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

  // The analysis behind a figure, embedded in its exports (figure-provenance.js), unless turned off.
  const embedding = () => prefs.get('figureProvenance', true) !== false;
  async function provenanceFor(fig) {
    if (!embedding()) return null;
    const { buildProvenance } = await import('../lib/figure-provenance.js');
    const views = new Map();
    for (const item of fig.items) {
      if (item.kind !== 'plot' || views.has(item.sampleId)) continue;
      const view = data.view(item.sampleId) ?? await data.ensure(item.sampleId).catch(() => null);
      if (view) views.set(item.sampleId, view);
    }
    return buildProvenance(store.ws, fig, { views, version: app.version });
  }

  async function exportSVG(fig) {
    const scenes = await scenesFor(fig);
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
    const record = await provenanceFor(fig);
    if (record) svg = (await import('../lib/figure-provenance.js')).embedSVG(svg, record);
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${fig.name.replace(/[^\w.-]+/g, '_')}.svg`);
  }

  async function exportRaster(fig, format) {
    const progress = progressToast(`Rendering ${fig.name}…`);
    try {
      if (format === 'png') {
        const canvas = await renderToCanvas(fig, 3);
        let blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const record = await provenanceFor(fig);
        if (record) blob = new Blob([(await import('../lib/figure-provenance.js')).embedPNG(new Uint8Array(await blob.arrayBuffer()), record)], { type: 'image/png' });
        downloadBlob(blob, `${fig.name.replace(/[^\w.-]+/g, '_')}.png`);
      } else {
        // 300 dots per inch at 96 CSS pixels per inch.
        const scale = 300 / 96;
        const canvas = await renderToCanvas(fig, scale);
        const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const record = await provenanceFor(fig);
        const attachments = record ? [(await import('../lib/figure-provenance.js')).pdfAttachment(record)] : [];
        const pdf = await writePDF([{ width: fig.width * 0.75, height: fig.height * 0.75, image: { width: canvas.width, height: canvas.height, rgb: rgbaToRgb(rgba) } }], { title: fig.name, attachments });
        downloadBlob(new Blob([pdf], { type: 'application/pdf' }), `${fig.name.replace(/[^\w.-]+/g, '_')}.pdf`);
      }
      progress.done();
    } catch (error) {
      progress.fail(`Export failed: ${error.message}`);
    }
  }

  function renderHead() {
    clear(headActions);
    const fig = figure();
    if (!fig) return;
    headActions.append(
      h('button.btn.small', { type: 'button', onclick: () => exportSVG(fig) }, icon('download'), 'SVG'),
      h('button.btn.small', { type: 'button', onclick: () => exportRaster(fig, 'png') }, icon('download'), 'PNG'),
      h('button.btn.small', { type: 'button', onclick: () => exportRaster(fig, 'pdf') }, icon('download'), 'PDF (300 dpi)'),
      h('label.check', { title: 'Exports carry the gates, scales, compensation, sample names and file checksums behind each plot, so the figure can be traced to its analysis and rebuilt. Open an exported figure in CytoWeave to check it.' },
        h('input', { type: 'checkbox', checked: embedding(), onchange: (event) => prefs.set('figureProvenance', event.target.checked) }), 'Embed the analysis'));
  }

  function renderList() {
    clear(listHost);
    const figures = store.ws.figures;
    if (!figures.length) {
      listHost.append(h('p.muted', 'No figures yet.'));
      return;
    }
    for (const fig of figures) {
      listHost.append(h(`div.tree-row${fig.id === figureId ? '.selected' : ''}`, { style: { gridTemplateColumns: '18px 1fr auto' }, onclick: () => { figureId = fig.id; selectedItem = null; renderAll(); } },
        icon('figure'), h('span.label', fig.name), h('button.icon-button.small', { type: 'button', title: 'Delete figure', onclick: (event) => { event.stopPropagation(); store.commit(setCollection(store.ws, 'figures', store.ws.figures.filter((f) => f.id !== fig.id)), 'Delete figure', ['figures']); if (figureId === fig.id) figureId = store.ws.figures[0]?.id ?? null; } }, icon('trash'))));
    }
  }

  const keys = (event) => {
    if (!selectedItem || store.ui.mode !== 'figures') return;
    if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    const fig = figure();
    const item = fig?.items.find((it) => it.id === selectedItem);
    if (!item) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      removeItem(item);
    } else if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 20 : 2;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      updateItem({ x: item.x + dx, y: item.y + dy }, 'Nudge item');
    }
  };
  document.addEventListener('keydown', keys, true);

  function renderAll() {
    renderList();
    renderHead();
    renderPage();
    renderProps();
  }

  const resize = new ResizeObserver(() => renderPage());
  resize.observe(stage);
  renderAll();
  return {
    update(topics) {
      if (topics.has('ws') || topics.has('figures') || topics.has('data') || topics.has('derived')) {
        if (!figure() && store.ws.figures.length) figureId = store.ws.figures[0].id;
        renderAll();
      }
    },
    destroy() {
      resize.disconnect();
      document.removeEventListener('keydown', keys, true);
      root.remove();
    },
  };
}
