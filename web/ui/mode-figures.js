// Figures: a page layout editor for publication figures. Plots stay live (they follow gate edits),
// and two builders make the figures most papers need: the gating strategy of a population and a
// grid of the same plot across samples. Statistics items show columns of a Tables table. Exports
// SVG (vector), PNG and PDF, and batch reports: the figure repeated for each sample or each value
// of an annotation, as a multi-page PDF or a PowerPoint deck (report-dialog.js).

import { h, icon, clear, downloadBlob } from './dom.js';
import { showMenu, toast, promptDialog, progressToast } from './overlays.js';
import { drawScene } from '../lib/plot.js';
import { newId } from '../lib/gates.js';
import { ROOT, channelLabel, gateById, gatePath, plotsOf, setCollection } from '../lib/workspace.js';
import { gatingStrategyFigure, samplesGridFigure } from '../lib/figures.js';
import { drawStats, figurePDF, figurePNG, figurePage, figureSVG, figureScene } from './figure-export.js';
import { batchReportDialog } from './report-dialog.js';
import { columnLabel } from '../lib/tables.js';
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

export function mountFiguresMode(app, container) {
  const { store, data } = app;
  let figureId = store.ws.figures[0]?.id ?? null;
  let selectedItem = null;
  let zoom = 1;

  const listHost = h('div');
  const propsHost = h('div');
  const page = h('div.figure-page');
  const stage = h('div.figure-stage', { tabIndex: 0, role: 'region', 'aria-label': 'Figure page' }, page);
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
    const gateId = store.ui.gateId;
    const sampleId = store.ui.sampleId;
    if (!gateId || !sampleId) {
      toast('Select a population (and a sample) in the Gate view first.');
      return;
    }
    let fig;
    try {
      fig = gatingStrategyFigure(store.ws, gateId, sampleId);
    } catch (error) {
      toast(error.message, { kind: 'error' });
      return;
    }
    newFigure(fig.items, fig.name, { width: fig.width, height: fig.height });
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
    const samples = ws.samples.filter((s) => (group ? group.sampleIds.includes(s.id) : s.role === 'sample'));
    const fig = samplesGridFigure(ws, pop, plots, samples, group?.name ?? null);
    newFigure(fig.items, fig.name, { width: fig.width, height: fig.height });
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
    return figureScene(app, item, view, preview ? Math.max(1, Math.round(1 / Math.max(zoom, 0.25))) : 1);
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
    // Text placeholders filled and statistics computed, as exports show them.
    const resolved = new Map(figurePage(app, fig).items.map((item) => [item.id, item]));
    const wanted = new Set();
    for (const item of fig.items) {
      const shown = resolved.get(item.id) ?? item;
      const el = h(`div.figure-item.${item.kind}${item.id === selectedItem ? '.selected' : ''}`, { style: { left: `${item.x}px`, top: `${item.y}px`, width: `${item.w}px`, height: `${item.h}px` }, dataset: { id: item.id } });
      if (item.kind === 'text') {
        el.append(h('div', { style: { fontSize: `${item.size ?? 14}px`, fontWeight: String(item.weight ?? 400), textAlign: item.align ?? 'left', color: item.color ?? '#171b26', whiteSpace: 'pre-wrap', lineHeight: 1.25 } }, shown.text));
      } else if (item.kind === 'arrow') {
        el.append(h('div.figure-arrow'));
      } else if (item.kind === 'stats') {
        renderStatsItem(shown, el);
        for (const id of shown.rowIds ?? []) if (!data.view(id)) wanted.add(id);
      } else {
        renderPlotItem(shown, el);
      }
      el.append(h('div.figure-handle'));
      attachDrag(el, item);
      page.append(el);
    }
    // The samples statistics items list are loaded (the page redraws when they are).
    for (const id of wanted) data.ensure(id).catch(() => {});
  }

  function renderStatsItem(item, el) {
    const canvas = h('canvas');
    el.append(canvas);
    const dpr = (window.devicePixelRatio || 1) * Math.min(2, Math.max(1, zoom));
    canvas.width = Math.round(item.w * dpr);
    canvas.height = Math.round(item.h * dpr);
    canvas.style.width = `${item.w}px`;
    canvas.style.height = `${item.h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStats(ctx, item);
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
          h('button.btn.small', { type: 'button', onclick: () => addItem('arrow') }, icon('plus'), 'Arrow'),
          h('button.btn.small', { type: 'button', title: 'Columns of a Tables table for the samples on the page', onclick: () => addItem('stats') }, icon('plus'), 'Statistics')),
        h('p.muted', { style: { marginTop: '10px', fontSize: '11.5px' } }, 'Click an item to edit it; drag to move (snaps to 5 px); drag its corner to resize. Delete removes the selected item.'));
      return;
    }
    propsHost.append(h('h3', { plot: 'Plot', text: 'Text', stats: 'Statistics', arrow: 'Arrow' }[item.kind] ?? 'Item', h('span.spacer'),
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
        h('label.field', h('span', 'Color'), h('input', { type: 'color', value: item.color ?? '#171b26', onchange: (event) => updateItem({ color: event.target.value }) })),
        h('p.muted', { style: { fontSize: '11.5px' } }, 'Placeholders are filled from the figure\'s samples, and on each page of a batch report: {sample}, {page}, {pages}, {group}, {date}, {workspace} and annotations such as {subject} or {condition}.'));
      return;
    }
    if (item.kind === 'stats') {
      const table = ws.tables.find((t) => t.id === item.tableId);
      const tableSelect = h('select.input.small', { onchange: (event) => updateItem({ tableId: event.target.value, columnIds: null }) }, ...ws.tables.map((t) => h('option', { value: t.id, selected: t.id === item.tableId }, t.name)));
      const rowsSelect = h('select.input.small', { onchange: (event) => updateItem({ rows: event.target.value }) },
        h('option', { value: 'page', selected: item.rows !== 'table' }, 'The samples on the page'),
        h('option', { value: 'table', selected: item.rows === 'table' }, 'All of the table\'s rows'));
      const chosen = new Set(item.columnIds?.length ? item.columnIds : table?.columns.map((c) => c.id) ?? []);
      const columns = h('div', { style: { maxHeight: '220px', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '8px', padding: '4px 8px' } },
        ...(table?.columns ?? []).map((column) => h('label.check', h('input', {
          type: 'checkbox',
          checked: chosen.has(column.id),
          onchange: (event) => {
            if (event.target.checked) chosen.add(column.id);
            else chosen.delete(column.id);
            const ids = table.columns.map((c) => c.id).filter((id) => chosen.has(id));
            updateItem({ columnIds: ids.length === table.columns.length ? null : ids });
          },
        }), columnLabel(ws, column))));
      propsHost.append(
        h('label.field', h('span', 'Table'), tableSelect),
        h('label.field', h('span', 'Rows'), rowsSelect),
        h('div.section-title', 'Columns'), table ? columns : h('p.muted', 'The table was deleted.'),
        h('label.field', h('span', 'Text size'), h('input.input.small', { type: 'number', min: 7, max: 24, value: item.size ?? 11, onchange: (event) => updateItem({ size: Number(event.target.value) || 11 }) })),
        h('p.muted', { style: { fontSize: '11.5px' } }, 'Values as Tables computes them, with ND and < LLOQ where a column has detection limits. The text shrinks to fit the box; rows that still do not fit are counted below the table.'));
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
    if (kind === 'stats') {
      const table = store.ws.tables[0];
      if (!table) {
        toast('Make a table in Tables first: a statistics item shows its columns.');
        return;
      }
      const item = { id: newId('i'), kind: 'stats', x: 40, y: Math.max(40, fig.height - 260), w: Math.min(900, fig.width - 80), h: 200, tableId: table.id, rows: 'page', size: 11 };
      selectedItem = item.id;
      save({ ...fig, items: [...fig.items, item] }, 'Add statistics');
      return;
    }
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

  // The analysis behind a figure is embedded in its exports (figure-provenance.js), unless turned off.
  const embedding = () => prefs.get('figureProvenance', true) !== false;
  const fileName = (fig, extension) => `${fig.name.replace(/[^\w.-]+/g, '_')}.${extension}`;

  async function exportSVG(fig) {
    const svg = await figureSVG(app, fig, { provenance: embedding() });
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), fileName(fig, 'svg'));
  }

  async function exportRaster(fig, format) {
    const progress = progressToast(`Rendering ${fig.name}…`);
    try {
      if (format === 'png') downloadBlob(new Blob([await figurePNG(app, fig, { provenance: embedding() })], { type: 'image/png' }), fileName(fig, 'png'));
      else downloadBlob(new Blob([await figurePDF(app, fig, { provenance: embedding() })], { type: 'application/pdf' }), fileName(fig, 'pdf'));
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
      h('button.btn.small', { type: 'button', onclick: () => exportRaster(fig, 'pdf') }, icon('download'), 'PDF'),
      h('button.btn.small', { type: 'button', title: 'Repeat the figure for each sample or each value of an annotation, as a multi-page PDF or a PowerPoint deck', onclick: () => batchReportDialog(app, fig) }, icon('layers'), 'Batch report…'),
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
