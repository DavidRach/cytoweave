// The plate of an index-sorted sample: one well per sorted event, colored by the population its
// cell falls in (the deepest one, or a chosen one) or by a channel's value. Hovering a well
// describes its cell; clicking marks the cell on every plot of the sample; selecting a population
// in the tree colors its wells.

import { h, icon, downloadBlob } from './dom.js';
import { channelTransform, populationSet } from '../lib/engine.js';
import { createTransform, formatNumber } from '../lib/transforms.js';
import { colormapColor, shownColor } from '../lib/colormaps.js';
import { eventsByWell, readIndexSort, wellName } from '../lib/indexsort.js';
import { ROOT, channelLabel, gateAncestors, gateById, gatePath } from '../lib/workspace.js';

const sorts = new WeakMap();

// The index-sort data of a loaded sample (cached), or null.
export function indexSortOf(view) {
  if (!view) return null;
  if (!sorts.has(view)) sorts.set(view, readIndexSort({ eventCount: view.eventCount, keywords: view.dataset.keywords, parameters: view.parameters, data: view.dataset.data }));
  return sorts.get(view);
}

export function createPlateView(app) {
  const { store, data } = app;
  const el = h('section.plate-section');
  let colorBy = 'deepest';
  let hovered = null;

  function members(view, ws, events) {
    // For each sorted event, the populations it is in (deepest first).
    const out = new Map(events.map((e) => [e, []]));
    for (const gate of ws.gates) {
      if (gate.meta?.helper) continue;
      let set;
      try {
        set = populationSet(view, ws, gate.id);
      } catch {
        continue;
      }
      if (!set) continue;
      for (const e of events) if (set.has(e)) out.get(e).push(gate);
    }
    for (const list of out.values()) list.sort((a, b) => gateAncestors(ws, b.id).length - gateAncestors(ws, a.id).length);
    return out;
  }

  // What the plate shows depends on these; anything else (other data loading, say) leaves it as
  // it is, so a well being clicked is not replaced under the pointer.
  let shownKey = null;
  const keyOf = (view, ws) => [view?.id, view?.version, ws.gates, ws.channelSettings, store.ui.gateId, colorBy, store.ui.marked?.sampleId, store.ui.marked?.well, document.documentElement.dataset.theme];

  function render(force = false) {
    const ws = store.ws;
    const view = store.ui.sampleId ? data.view(store.ui.sampleId) : null;
    const key = keyOf(view, ws);
    if (!force && shownKey && key.every((v, i) => v === shownKey[i])) return;
    shownKey = key;
    const sort = indexSortOf(view);
    el.replaceChildren();
    el.hidden = !sort;
    if (!sort) return;
    const byWell = eventsByWell(sort);
    const sorted = byWell.flat();
    const memberships = members(view, ws, sorted);
    const selectedGate = store.ui.gateId ? gateById(ws, store.ui.gateId) : null;
    const marked = store.ui.marked?.sampleId === view.id ? store.ui.marked : null;
    const channels = view.parameters.filter((p) => p.type === 'fluorescence' || p.type === 'scatter');
    // Colors: the selected population highlights its wells; otherwise the chosen coloring.
    let colorOf;
    let legend = [];
    if (colorBy.startsWith('channel:')) {
      const channel = colorBy.slice(8);
      const spec = channelTransform(ws, view, channel);
      const transform = createTransform(spec);
      const column = view.column(channel);
      const values = sorted.map((e) => transform.forward(column[e]));
      const lo = Math.min(...values);
      const hi = Math.max(...values);
      colorOf = (e) => colormapColor('viridis', hi > lo ? (transform.forward(column[e]) - lo) / (hi - lo) : 0.5);
      legend = [h('span.plate-scale', { style: { background: `linear-gradient(90deg, ${[0, 0.25, 0.5, 0.75, 1].map((t) => colormapColor('viridis', t)).join(', ')})` } }), h('span.muted', `${channelLabel(ws, channel, { short: true })}: ${formatNumber(transform.inverse(lo))} → ${formatNumber(transform.inverse(hi))}`)];
    } else if (selectedGate || colorBy.startsWith('gate:')) {
      const gate = selectedGate ?? gateById(ws, colorBy.slice(5));
      colorOf = (e) => (memberships.get(e).some((g) => g.id === gate?.id) ? shownColor(ws, gate) : null);
      const inside = sorted.filter((e) => memberships.get(e).some((g) => g.id === gate?.id)).length;
      legend = gate ? [h('span.swatch', { style: { background: shownColor(ws, gate) } }), h('span', `${gate.name}: ${inside} of ${sorted.length} wells${selectedGate ? ' (the selected population)' : ''}`)] : [];
    } else {
      colorOf = (e) => shownColor(ws, memberships.get(e)[0]) ?? null;
      const shown = new Map();
      for (const e of sorted) {
        const gate = memberships.get(e)[0];
        if (gate) shown.set(gate.id, { gate, n: (shown.get(gate.id)?.n ?? 0) + 1 });
      }
      legend = [...shown.values()].map(({ gate, n }) => h('span.plate-legend-item', h('span.swatch', { style: { background: shownColor(ws, gate) } }), `${gate.name} ${n}`));
    }

    const select = h('select.input.small', { 'aria-label': 'Color wells by' },
      h('option', { value: 'deepest', selected: colorBy === 'deepest' }, 'Deepest population'),
      h('optgroup', { label: 'Population' }, ...ws.gates.filter((g) => !g.meta?.helper).map((g) => h('option', { value: `gate:${g.id}`, selected: colorBy === `gate:${g.id}` }, gatePath(ws, g.id)))),
      h('optgroup', { label: 'Channel' }, ...channels.map((p) => h('option', { value: `channel:${p.name}`, selected: colorBy === `channel:${p.name}` }, channelLabel(ws, p.name)))));
    select.addEventListener('change', () => {
      colorBy = select.value;
      if (store.ui.gateId && !colorBy.startsWith('channel:')) app.selectGate(null);
      render(true);
    });

    const grid = h('div.plate-grid', { style: { gridTemplateColumns: `20px repeat(${sort.columns}, minmax(0, 1fr))` }, role: 'group', 'aria-label': `${sort.plate}, ${sorted.length} sorted cells` });
    grid.append(h('span'), ...Array.from({ length: sort.columns }, (_, c) => h('span.plate-head', String(c + 1))));
    for (let r = 0; r < sort.rows; r += 1) {
      grid.append(h('span.plate-head', wellName(r, 0).replace(/\d+$/, '')));
      for (let c = 0; c < sort.columns; c += 1) {
        const w = r * sort.columns + c;
        const events = byWell[w];
        const color = events.length ? colorOf(events[0]) : null;
        const name = wellName(r, c);
        const isMarked = marked?.well === name;
        const well = h(`button.plate-well${events.length ? '' : '.empty'}${events.length > 1 ? '.multiple' : ''}${isMarked ? '.marked' : ''}`, {
          type: 'button',
          title: events.length ? `${name}: ${events.length > 1 ? `${events.length} events` : `event ${events[0] + 1}`}` : `${name}: empty`,
          style: color ? { background: color, borderColor: color } : {},
          disabled: !events.length,
          onmouseenter: () => { hovered = { name, events }; describe(); },
          onfocus: () => { hovered = { name, events }; describe(); },
          onclick: () => {
            hovered = { name, events };
            store.setUI({ marked: isMarked ? null : { sampleId: view.id, events: events.slice(), well: name } }, ['marked']);
          },
        });
        grid.append(well);
      }
    }
    const info = h('div.plate-info');
    function describe() {
      const target = hovered ?? (marked ? { name: marked.well, events: marked.events } : null);
      if (!target || !target.events.length) {
        info.replaceChildren(h('span.muted', 'Point at a well to see its cell; click it to mark the cell on the plots.'));
        return;
      }
      const e = target.events[0];
      const gates = memberships.get(e) ?? [];
      const values = channels.filter((p) => p.type === 'fluorescence').slice(0, 8).map((p) => h('span.plate-value', h('span.muted', channelLabel(ws, p.name, { short: true })), ` ${formatNumber(view.column(p.name)[e])}`));
      info.replaceChildren(
        h('div', h('strong', target.name), ` · event ${e + 1}${target.events.length > 1 ? ` (and ${target.events.length - 1} more in this well)` : ''}`),
        h('div', gates.length ? gatePath(ws, gates[0].id) : 'In no gated population'),
        h('div.plate-values', ...values));
    }
    describe();

    el.append(
      h('div.section-title', icon('plate'), `Index-sorted plate · ${sort.plate} · ${sorted.length} sorted cell${sorted.length === 1 ? '' : 's'}`),
      h('div.plate-controls', h('label.field', h('span', 'Color wells by'), select),
        h('button.btn.small', { type: 'button', onclick: () => exportCSV(view, sort, byWell, memberships, ws) }, icon('download'), 'Export wells (CSV)'),
        marked ? h('button.btn.small.ghost', { type: 'button', onclick: () => store.setUI({ marked: null }, ['marked']) }, `Unmark ${marked.well}`) : null),
      ...sort.notes.map((note) => h('div.callout.warn', icon('warning'), h('span', note))),
      h('div.plate-body', grid, info),
      h('div.plate-legend', ...legend),
      h('div.muted', { style: { fontSize: '11px' } }, `Wells from ${sort.source}.`));
  }

  function exportCSV(view, sort, byWell, memberships, ws) {
    const channels = view.parameters.filter((p) => p.type === 'fluorescence' || p.type === 'scatter').map((p) => p.name);
    const quote = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [['well', 'row', 'column', 'event', 'population', ...channels.map((c) => channelLabel(ws, c))].map(quote).join(',')];
    byWell.forEach((events, w) => {
      for (const e of events) {
        const gate = memberships.get(e)[0];
        lines.push([wellName(Math.floor(w / sort.columns), w % sort.columns), Math.floor(w / sort.columns) + 1, (w % sort.columns) + 1, e + 1, gate ? gatePath(ws, gate.id) : '', ...channels.map((c) => view.column(c)[e])].map(quote).join(','));
      }
    });
    const sample = ws.samples.find((s) => s.id === view.id);
    downloadBlob(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' }), `${(sample?.name ?? 'plate').replace(/[^\w.+-]+/g, '_')}_wells.csv`);
  }

  return { el, render };
}

// The events of a marked well that lie in a plot's population, for the plot to draw.
export function markedEvents(store, sampleId, populationId, view, ws) {
  const marked = store.ui.marked;
  if (!marked || marked.sampleId !== sampleId) return [];
  if (!populationId || populationId === ROOT) return marked.events;
  const set = populationSet(view, ws, populationId);
  return set ? marked.events.filter((e) => set.has(e)) : [];
}
