// The gating workbench: the selected population's lineage (each ancestor gate shown on its
// parent's plot) and the population's own plots, where new gates are drawn.

import { createPlateView } from './plate-view.js';
import { h, icon, clear, iconButton, formatCount } from './dom.js';
import { shownColor } from '../lib/colormaps.js';
import { showMenu } from './overlays.js';
import { createPlotView } from './plot-view.js';
import { ROOT, addPlot, gateAncestors, gateById, gateChildren, plotsOf, removePlot, updatePlot, channelLabel } from '../lib/workspace.js';

const TOOLS = [
  { id: 'pointer', icon: 'pointer', title: 'Select and edit gates (V)', key: 'v' },
  null,
  { id: 'rectangle', icon: 'rectangle', title: 'Rectangle gate (R)', key: 'r' },
  { id: 'polygon', icon: 'polygon', title: 'Polygon gate (P): click vertices, double-click or click the first vertex to close', key: 'p' },
  { id: 'ellipse', icon: 'ellipse', title: 'Ellipse gate (E)', key: 'e' },
  { id: 'lasso', icon: 'lasso', title: 'Freehand gate (L)', key: 'l' },
  { id: 'quadrant', icon: 'quadrant', title: 'Quadrant gate (Q): click the center', key: 'q' },
  { id: 'range', icon: 'range', title: 'Range gate on a histogram (H)', key: 'h' },
  { id: 'split', icon: 'split', title: 'Split gate (S): divides a histogram in two', key: 's' },
  null,
  { id: 'wand', icon: 'wand', title: 'Magic wand (W): click a population to gate its density basin; on a histogram, splits at the valley', key: 'w' },
];

export const GATE_TOOL_KEYS = Object.fromEntries(TOOLS.filter(Boolean).map((tool) => [tool.key, tool.id]));

// Default axes for a new plot of a population: the dimensions of its child gates, else scatter
// for the root, else fluorescence channels its ancestors have not used.
export function defaultPlotsFor(ws, view, populationId) {
  const parentId = populationId === ROOT ? null : populationId;
  const children = gateChildren(ws, parentId).filter((g) => g.type !== 'boolean' && g.type !== 'category');
  const seen = new Set();
  const plots = [];
  for (const gate of children) {
    const key = gate.dims.map((d) => d.channel).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    plots.push(gate.dims.length === 1 ? { x: gate.dims[0].channel, y: null, type: 'histogram' } : { x: gate.dims[0].channel, y: gate.dims[1].channel, type: 'pseudocolor' });
  }
  if (plots.length) return plots;
  if (!view) return [];
  const names = view.parameters.map((p) => p.name);
  const find = (re) => names.find((n) => re.test(n));
  if (populationId === ROOT) {
    const fsc = find(/^FSC-A$/i) ?? find(/^FSC/i) ?? find(/^FS/i);
    const ssc = find(/^SSC-A$/i) ?? find(/^SSC/i) ?? find(/^SS/i);
    if (fsc && ssc) return [{ x: fsc, y: ssc, type: 'pseudocolor' }];
    const fluor = view.parameters.filter((p) => p.type === 'fluorescence').map((p) => p.name);
    if (fluor.length >= 2) return [{ x: fluor[0], y: fluor[1], type: 'pseudocolor' }];
    return [{ x: names[0], y: names[1] ?? null, type: names[1] ? 'pseudocolor' : 'histogram' }];
  }
  const gate = gateById(ws, populationId);
  const used = new Set();
  for (const g of [...gateAncestors(ws, populationId), gate]) for (const d of g?.dims ?? []) used.add(d.channel);
  // After a singlet gate on FSC-A/FSC-H, a viability or fluorescence channel is next.
  const scatterGates = [...used].every((c) => /^(FSC|SSC|FS|SS)/i.test(c));
  const fluor = view.parameters.filter((p) => p.type === 'fluorescence' && !used.has(p.name));
  if (scatterGates) {
    const fsc = find(/^FSC-A$/i);
    const fsch = find(/^FSC-H$/i);
    if (fsc && fsch && !(used.has(fsc) && used.has(fsch))) return [{ x: fsc, y: fsch, type: 'pseudocolor' }];
    const viability = fluor.find((p) => /viab|live|dead|zombie|7-?aad|dapi|sytox|l\/d/i.test(`${p.marker} ${p.name}`));
    const ssc = find(/^SSC-A$/i);
    if (viability && ssc) return [{ x: viability.name, y: ssc, type: 'pseudocolor' }];
  }
  const pair = standardPair(fluor, gate);
  if (pair) return [{ x: pair[0], y: pair[1], type: 'pseudocolor' }];
  if (fluor.length >= 2) return [{ x: fluor[0].name, y: fluor[1].name, type: 'pseudocolor' }];
  if (fluor.length === 1) return [{ x: fluor[0].name, y: null, type: 'histogram' }];
  return [{ x: names[0], y: names[1] ?? null, type: 'pseudocolor' }];
}

// Marker pairs immunologists plot next, roughly in gating order; the first pair whose markers
// are both present and not yet used wins. A population named after one lineage prefers the
// pairs that subdivide it.
const STANDARD_PAIRS = [
  ['CD3', 'CD19'], ['CD3', 'CD20'], ['CD4', 'CD8'], ['CD45RA', 'CCR7'], ['CD45RA', 'CD27'], ['CD25', 'CD127'],
  ['CD14', 'CD16'], ['CD56', 'CD16'], ['CD19', 'CD27'], ['IgD', 'CD27'], ['CD27', 'CD38'], ['HLA-DR', 'CD11c'],
  ['CD123', 'HLA-DR'], ['CD38', 'HLA-DR'], ['CD69', 'CD25'], ['CD33', 'CD34'], ['CD45', 'CD34'], ['CD11b', 'Ly6G'],
];
const LINEAGE_PREFERENCES = [
  [/\bT\b|CD3\+|T cells?/i, [['CD4', 'CD8'], ['CD45RA', 'CCR7'], ['CD25', 'CD127']]],
  [/CD4\b/i, [['CD45RA', 'CCR7'], ['CD25', 'CD127']]],
  [/CD8\b/i, [['CD45RA', 'CCR7'], ['CD27', 'CD28']]],
  [/\bB\b|CD19\+|B cells?/i, [['IgD', 'CD27'], ['CD27', 'CD38']]],
  [/NK|CD56/i, [['CD56', 'CD16']]],
  [/mono|myeloid|CD14/i, [['CD14', 'CD16'], ['HLA-DR', 'CD11c']]],
  [/lymph/i, [['CD3', 'CD19'], ['CD3', 'CD56']]],
];

function standardPair(fluor, gate) {
  const byMarker = new Map();
  for (const p of fluor) {
    const marker = (p.marker || '').trim();
    if (marker) byMarker.set(marker.toUpperCase().replace(/\s+/g, ''), p.name);
  }
  const lookup = (marker) => byMarker.get(marker.toUpperCase());
  const preferred = [];
  for (const [pattern, pairs] of LINEAGE_PREFERENCES) if (gate && pattern.test(gate.name)) preferred.push(...pairs);
  for (const [a, b] of [...preferred, ...STANDARD_PAIRS]) {
    const x = lookup(a);
    const y = lookup(b);
    if (x && y && x !== y) return [x, y];
  }
  return null;
}

export function mountGateMode(app, container) {
  const { store, data } = app;
  const views = new Map(); // plot id → plot view
  const lineageViews = [];
  let renderedFor = null;

  const titleEl = h('h1');
  const sampleSelect = h('select.input.small', { title: 'Sample (↑ ↓ to switch)', onchange: () => app.selectSample(sampleSelect.value) });
  const scope = h('div.segmented', { title: 'Where gate edits apply' },
    h('button', { type: 'button', dataset: { scope: 'all' }, onclick: () => store.setUI({ editScope: 'all' }, ['scope']) }, 'All samples'),
    h('button', { type: 'button', dataset: { scope: 'sample' }, onclick: () => store.setUI({ editScope: 'sample' }, ['scope']) }, 'This sample'));
  const toolbar = h('div.toolbar', { role: 'toolbar', 'aria-label': 'Gate tools' });
  for (const tool of TOOLS) {
    if (!tool) {
      toolbar.append(h('span.tool-sep'));
      continue;
    }
    // A click arms a tool for one gate; a double-click (or Shift with its key) keeps it armed.
    const title = tool.id === 'pointer' ? tool.title : `${tool.title}. Double-click to keep it for several gates`;
    toolbar.append(h('button.tool', {
      type: 'button',
      title,
      dataset: { tool: tool.id },
      onclick: (event) => {
        if (event.detail > 1) return;
        store.setUI({ tool: store.ui.tool === tool.id && tool.id !== 'pointer' ? 'pointer' : tool.id, stickyTool: false }, ['tool']);
      },
      ondblclick: () => { if (tool.id !== 'pointer') store.setUI({ tool: tool.id, stickyTool: true }, ['tool']); },
    }, icon(tool.icon)));
  }
  const head = h('div.workbench-head',
    titleEl,
    h('span.spacer'),
    h('div.sample-nav',
      iconButton('chevronLeft', 'Previous sample (↑)', () => app.stepSample(-1), { class: 'small' }),
      sampleSelect,
      iconButton('chevronRight', 'Next sample (↓)', () => app.stepSample(1), { class: 'small' })),
    scope,
    toolbar,
    iconButton('grid', 'Plot size', (e) => sizeMenu(e.currentTarget)));
  const lineage = h('div.lineage');
  const lineageTitle = h('div.section-title', 'Gating path');
  const plotsTitle = h('div.section-title');
  const grid = h('div.plot-grid');
  // An index-sorted sample's plate, linked to the plots (hidden for other samples).
  const plate = createPlateView(app);
  const scroll = h('div.workbench-scroll', lineageTitle, lineage, plotsTitle, grid, plate.el);
  const root = h('div.view', head, scroll);
  container.append(root);

  function sizeMenu(anchor) {
    showMenu(anchor, [260, 330, 420, 540].map((size) => ({
      label: { 260: 'Small', 330: 'Medium', 420: 'Large', 540: 'Extra large' }[size],
      checked: store.ui.tileSize === size,
      onSelect: () => {
        store.setUI({ tileSize: size }, ['tiles']);
        grid.style.setProperty('--tile', `${size}px`);
      },
    })));
  }

  function populationId() {
    return store.ui.gateId ?? ROOT;
  }

  function renderHead() {
    const ws = store.ws;
    const gate = store.ui.gateId ? gateById(ws, store.ui.gateId) : null;
    const crumbs = gate ? gateAncestors(ws, gate.id).map((g) => g.name).join(' / ') : '';
    clear(titleEl);
    titleEl.append(...[h('span.swatch', { style: { background: shownColor(ws, gate) ?? '#94a3b8', width: '12px', height: '12px' } }), h('span', gate ? gate.name : 'All events'), crumbs ? h('span.crumbs', `in ${crumbs}`) : null].filter(Boolean));
    clear(sampleSelect);
    for (const sample of app.sidebar.visibleSamples()) sampleSelect.append(h('option', { value: sample.id, selected: sample.id === store.ui.sampleId }, sample.name));
    if (!sampleSelect.value && store.ui.sampleId) {
      const sample = ws.samples.find((s) => s.id === store.ui.sampleId);
      if (sample) sampleSelect.append(h('option', { value: sample.id, selected: true }, sample.name));
    }
    for (const button of scope.querySelectorAll('button')) button.classList.toggle('active', button.dataset.scope === store.ui.editScope);
    for (const button of toolbar.querySelectorAll('.tool')) {
      button.classList.toggle('active', button.dataset.tool === store.ui.tool);
      button.classList.toggle('sticky', button.dataset.tool === store.ui.tool && Boolean(store.ui.stickyTool));
    }
    grid.style.setProperty('--tile', `${store.ui.tileSize}px`);
  }

  // Lineage: one compact plot per gate on the path from the root to the selected population.
  function renderLineage() {
    for (const view of lineageViews.splice(0)) view.destroy();
    clear(lineage);
    const ws = store.ws;
    const id = store.ui.gateId;
    const sampleId = store.ui.sampleId;
    if (!id || !sampleId) {
      lineage.hidden = true;
      lineageTitle.hidden = true;
      return;
    }
    const path = [...gateAncestors(ws, id), gateById(ws, id)].filter((g) => g && g.type !== 'boolean' && g.type !== 'category');
    lineage.hidden = !path.length;
    lineageTitle.hidden = !path.length;
    path.forEach((gate, i) => {
      const spec = {
        id: `lineage-${gate.id}`,
        populationId: gate.parentId ?? ROOT,
        x: gate.dims[0].channel,
        y: gate.dims[1]?.channel ?? null,
        type: gate.dims.length === 1 ? 'histogram' : 'pseudocolor',
        title: `${gateById(ws, gate.parentId)?.name ?? 'All events'} → ${gate.name}`,
      };
      const view = createPlotView(app, { spec, sampleId, compact: true, hideActions: true, height: 190 });
      view.el.addEventListener('click', () => {
        if (store.ui.gateId !== gate.id) app.selectGate(gate.id);
      });
      lineageViews.push(view);
      const step = h('div.lineage-step', view.el);
      if (i < path.length - 1) step.append(h('span.lineage-arrow', icon('chevronRight')));
      lineage.append(step);
    });
  }

  function ensurePlots() {
    const ws = store.ws;
    const pop = populationId();
    let plots = plotsOf(ws, pop);
    if (plots.length || !store.ui.sampleId) return plots;
    const view = data.view(store.ui.sampleId);
    if (!view) return plots;
    const defaults = defaultPlotsFor(ws, view, pop);
    let next = ws;
    for (const plot of defaults) next = addPlot(next, { ...plot, populationId: pop, type: plot.y ? store.ui.plotType ?? plot.type : 'histogram' }).ws;
    if (next !== ws) store.replace(next, ['plots']);
    return plotsOf(next, pop);
  }

  function renderPlots() {
    const ws = store.ws;
    const sampleId = store.ui.sampleId;
    const pop = populationId();
    const gate = pop === ROOT ? null : gateById(ws, pop);
    clear(plotsTitle);
    plotsTitle.append(`Plots of ${gate ? gate.name : 'all events'}`);
    if (!sampleId) {
      for (const view of views.values()) view.destroy();
      views.clear();
      clear(grid);
      grid.append(h('div.empty', h('h3', 'No sample selected'), h('p', 'Add FCS files or open an example to start gating.')));
      return;
    }
    const plots = ensurePlots();
    const wanted = new Set(plots.map((p) => p.id));
    for (const [id, view] of views) {
      if (!wanted.has(id)) {
        view.destroy();
        views.delete(id);
      }
    }
    clear(grid);
    for (const plot of plots) {
      let view = views.get(plot.id);
      if (!view) {
        view = createPlotView(app, {
          spec: plot,
          sampleId,
          onChange: (spec) => store.commit(updatePlot(store.ws, plot.id, { x: spec.x, y: spec.y, type: spec.type, options: spec.options, overlays: spec.overlays, lastY: spec.lastY }), 'Change plot', ['plots']),
        });
        views.set(plot.id, view);
      } else {
        view.update({ spec: plot, sampleId });
      }
      grid.append(view.el);
    }
    grid.append(h('button.add-plot', { type: 'button', onclick: () => addAnotherPlot() }, icon('plus'), 'Add a plot', h('span.muted', { style: { fontWeight: 500 } }, 'then pick its axes')));
  }

  function addAnotherPlot() {
    const ws = store.ws;
    const view = data.view(store.ui.sampleId);
    if (!view) return;
    const pop = populationId();
    const existing = plotsOf(ws, pop);
    const used = new Set(existing.flatMap((p) => [p.x, p.y]));
    const fluor = view.parameters.filter((p) => p.type === 'fluorescence' && !used.has(p.name));
    const x = fluor[0]?.name ?? view.parameters[0].name;
    const y = fluor[1]?.name ?? view.parameters.find((p) => p.name !== x)?.name ?? null;
    store.commit(addPlot(ws, { populationId: pop, x, y, type: y ? store.ui.plotType : 'histogram' }).ws, 'Add plot', ['plots']);
  }

  app.removePlot = (spec) => store.commit(removePlot(store.ws, spec.id), 'Remove plot', ['plots']);
  app.duplicatePlot = (spec) => store.commit(addPlot(store.ws, { ...spec, id: undefined }).ws, 'Duplicate plot', ['plots']);

  function redrawAll() {
    for (const view of views.values()) view.render();
    for (const view of lineageViews) view.render();
  }

  return {
    update(topics) {
      const key = `${store.ui.sampleId}|${store.ui.gateId}`;
      const structural = key !== renderedFor;
      if (structural || topics.has('ws') || topics.has('selection') || topics.has('scope') || topics.has('tool') || topics.has('tiles') || topics.has('colors')) renderHead();
      if (structural || topics.has('plots') || (topics.has('ws') && !plotsOf(store.ws, populationId()).every((p) => views.has(p.id)))) {
        renderPlots();
      }
      if (structural || topics.has('lineage')) renderLineage();
      if (structural || topics.has('ws') || topics.has('data') || topics.has('gate') || topics.has('marked') || topics.has('theme')) plate.render();
      if (topics.has('marked')) {
        for (const view of views.values()) view.refreshOverlay();
        for (const view of lineageViews) view.refreshOverlay();
      }
      renderedFor = key;
      if (!structural && (topics.has('ws') || topics.has('data') || topics.has('theme') || topics.has('backgate') || topics.has('gate'))) {
        // Same population and sample: refresh gates and data in place.
        for (const plot of plotsOf(store.ws, populationId())) views.get(plot.id)?.update({ spec: plot });
        for (const view of lineageViews) view.render();
        if (topics.has('data') && !plotsOf(store.ws, populationId()).length) renderPlots();
      }
      if (topics.has('theme')) redrawAll();
    },
    destroy() {
      for (const view of views.values()) view.destroy();
      for (const view of lineageViews) view.destroy();
      root.remove();
    },
    plotViews: () => [...views.values()],
  };
}
