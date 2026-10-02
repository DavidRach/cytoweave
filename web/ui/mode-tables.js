// Tables: batch statistics across samples. A table's columns are population × statistic
// (× channel); its rows are the samples of a group. Values update as gates change.

import { h, icon, clear, downloadBlob, formatCount } from './dom.js';
import { showMenu, toast, progressToast, promptDialog } from './overlays.js';
import { computeStatistic } from '../lib/engine.js';
import { STATISTICS, formatStatistic } from '../lib/stats.js';
import { ROOT, channelCatalog, channelLabel, gateById, gatePath, setCollection } from '../lib/workspace.js';
import { newId } from '../lib/gates.js';
import { colormapColor, luminance } from '../lib/colormaps.js';

export function columnLabel(ws, column) {
  if (column.label) return column.label;
  const population = column.gateId && column.gateId !== ROOT ? gateById(ws, column.gateId)?.name ?? '(deleted)' : 'All events';
  const stat = STATISTICS.find((s) => s.id === column.stat)?.label ?? column.stat;
  const channel = column.channel ? ` ${channelLabel(ws, column.channel, { short: true })}` : '';
  const value = column.value !== undefined && column.value !== null && column.stat === 'percentile' ? ` P${column.value}` : column.stat === 'positive' ? ` ≥ ${column.value}` : '';
  const ancestor = column.stat === 'freqOf' ? ` of ${column.ancestorId && column.ancestorId !== ROOT ? gateById(ws, column.ancestorId)?.name : 'all events'}` : '';
  return `${population}: ${stat}${channel}${value}${ancestor}`;
}

// Computes a table's values for the loaded samples: Map(sampleId → values[]).
export function computeTable(app, table, sampleIds) {
  const { store, data } = app;
  const ws = store.ws;
  const out = new Map();
  for (const id of sampleIds) {
    const view = data.view(id);
    if (!view) continue;
    out.set(id, table.columns.map((column) => {
      try {
        return computeStatistic(view, ws, { stat: column.stat, gateId: column.gateId ?? ROOT, channel: column.channel, ancestorId: column.ancestorId, value: column.value });
      } catch {
        return Number.NaN;
      }
    }));
  }
  return out;
}

export function tableRows(app, table) {
  const ws = app.store.ws;
  const group = table.groupId ? ws.groups.find((g) => g.id === table.groupId) : null;
  return ws.samples.filter((s) => (group ? group.sampleIds.includes(s.id) : true) && (table.includeControls || s.role === 'sample' || s.role === 'reference'));
}

export function mountTablesMode(app, container) {
  const { store, data } = app;
  let tableId = store.ws.tables[0]?.id ?? null;
  let computing = false;

  const list = h('div');
  const builder = h('div');
  const tableHost = h('div', { style: { overflow: 'auto', maxHeight: 'calc(100vh - 230px)' } });
  const tableHead = h('h3');
  const toolbar = h('div.btn-row');
  const root = h('div.view',
    h('div.workbench-head', h('h1', icon('table'), 'Tables'), h('span.spacer'),
      h('button.btn.small', { type: 'button', onclick: () => newTable() }, icon('plus'), 'New table')),
    h('div.view-body', h('div.split',
      h('div', h('div.pane', h('h3', 'Tables'), list), h('div.pane', h('h3', 'Add a column'), builder)),
      h('div.pane', { style: { minWidth: 0 } }, h('div.row', { style: { marginBottom: '10px' } }, tableHead, h('span.grow'), toolbar), tableHost))));
  container.append(root);

  function current() {
    return store.ws.tables.find((t) => t.id === tableId) ?? null;
  }

  function saveTable(table, label = 'Edit table') {
    const tables = store.ws.tables.some((t) => t.id === table.id) ? store.ws.tables.map((t) => (t.id === table.id ? table : t)) : [...store.ws.tables, table];
    store.commit(setCollection(store.ws, 'tables', tables, 'edit-table'), label, ['tables']);
  }

  function newTable(columns) {
    const ws = store.ws;
    const table = {
      id: newId('t'),
      name: `Table ${ws.tables.length + 1}`,
      groupId: store.ui.groupFilter && !store.ui.groupFilter.startsWith('role:') ? store.ui.groupFilter : null,
      columns: columns ?? ws.gates.filter((g) => g.type !== 'category').map((g) => ({ id: newId('col'), gateId: g.id, stat: 'freqParent' })),
      heatmap: true,
    };
    tableId = table.id;
    saveTable(table, 'New table');
  }

  // A one-click column set from the gating tree.
  app.addPopulationToTable = (gateId) => {
    app.setMode('tables');
    const table = current();
    const column = { id: newId('col'), gateId: gateId ?? ROOT, stat: gateId ? 'freqParent' : 'count' };
    if (!table) newTable([column]);
    else saveTable({ ...table, columns: [...table.columns, column] }, 'Add column');
  };

  function renderList() {
    clear(list);
    const ws = store.ws;
    if (!ws.tables.length) {
      list.append(h('p.muted', 'No tables yet.'), h('button.btn.primary.small', { type: 'button', onclick: () => newTable() }, icon('sparkles'), 'Table of every population (% of parent)'));
      return;
    }
    for (const table of ws.tables) {
      list.append(h(`div.tree-row${table.id === tableId ? '.selected' : ''}`, { style: { gridTemplateColumns: '18px 1fr auto' }, onclick: () => { tableId = table.id; renderAll(); } },
        icon('table'), h('span.label', table.name), h('span.count', `${table.columns.length} col`)));
    }
  }

  function renderBuilder() {
    clear(builder);
    const ws = store.ws;
    const table = current();
    if (!table) {
      builder.append(h('p.muted', 'Create a table first.'));
      return;
    }
    const popSelect = h('select.input.small', h('option', { value: ROOT }, 'All events'), ...ws.gates.map((g) => h('option', { value: g.id, selected: g.id === store.ui.gateId }, gatePath(ws, g.id))));
    const statSelect = h('select.input.small', ...STATISTICS.map((s) => h('option', { value: s.id }, s.label)));
    const channels = channelCatalog(ws).filter((c) => c.type !== 'time');
    const channelSelect = h('select.input.small', ...channels.map((c) => h('option', { value: c.name }, c.marker ? `${c.marker} (${c.name})` : c.name)));
    const ancestorSelect = h('select.input.small', h('option', { value: ROOT }, 'All events'), ...ws.gates.map((g) => h('option', { value: g.id }, gatePath(ws, g.id))));
    const valueInput = h('input.input.small', { type: 'number', value: 50, step: 'any' });
    const channelField = h('label.field', h('span', 'Channel'), channelSelect);
    const ancestorField = h('label.field', h('span', 'Relative to'), ancestorSelect);
    const valueField = h('label.field', h('span', 'Value (percentile or threshold)'), valueInput);
    const sync = () => {
      const stat = STATISTICS.find((s) => s.id === statSelect.value);
      channelField.hidden = !stat?.needsChannel;
      ancestorField.hidden = !stat?.needsAncestor;
      valueField.hidden = !stat?.needsValue;
    };
    statSelect.addEventListener('change', sync);
    sync();
    const add = (columns) => saveTable({ ...table, columns: [...table.columns, ...columns] }, 'Add column');
    builder.append(
      h('label.field', h('span', 'Population'), popSelect),
      h('label.field', h('span', 'Statistic'), statSelect),
      channelField, ancestorField, valueField,
      h('div.btn-row',
        h('button.btn.primary.small', {
          type: 'button',
          onclick: () => {
            const stat = STATISTICS.find((s) => s.id === statSelect.value);
            add([{ id: newId('col'), gateId: popSelect.value, stat: statSelect.value, channel: stat.needsChannel ? channelSelect.value : undefined, ancestorId: stat.needsAncestor ? ancestorSelect.value : undefined, value: stat.needsValue ? Number.parseFloat(valueInput.value) : undefined }]);
          },
        }, icon('plus'), 'Add column'),
        h('button.btn.small', {
          type: 'button',
          title: 'Median of every fluorescence channel for this population',
          onclick: () => add(channels.filter((c) => c.type === 'fluorescence').map((c) => ({ id: newId('col'), gateId: popSelect.value, stat: 'median', channel: c.name }))),
        }, 'All medians')),
      h('div.section-title', { style: { marginTop: '14px' } }, 'Rows'),
      h('label.field', h('span', 'Samples'), h('select.input.small', {
        onchange: (event) => saveTable({ ...table, groupId: event.target.value || null }, 'Table rows'),
      }, h('option', { value: '' }, 'All samples'), ...ws.groups.map((g) => h('option', { value: g.id, selected: g.id === table.groupId }, g.name)))),
      h('label.check', h('input', { type: 'checkbox', checked: Boolean(table.includeControls), onchange: (event) => saveTable({ ...table, includeControls: event.target.checked }, 'Table rows') }), 'Include controls'));
  }

  function renderTable() {
    clear(tableHost);
    clear(toolbar);
    clear(tableHead);
    const ws = store.ws;
    const table = current();
    if (!table) {
      tableHost.append(h('div.empty', icon('table'), h('h3', 'Batch statistics'), h('p', 'A table lists statistics of populations for every sample: frequencies, counts, medians and more. Values update as you adjust gates.'), h('button.btn.primary', { type: 'button', onclick: () => newTable() }, 'Create a table of every population')));
      return;
    }
    tableHead.append(h('span', { style: { cursor: 'text' }, title: 'Rename', onclick: async () => { const name = await promptDialog({ title: 'Rename table', label: 'Name', value: table.name }); if (name) saveTable({ ...table, name }, 'Rename table'); } }, table.name));
    const rows = tableRows(app, table);
    const unloaded = rows.filter((s) => !data.view(s.id));
    toolbar.append(
      unloaded.length ? h('button.btn.small.primary', { type: 'button', disabled: computing, onclick: () => computeAll(rows) }, icon('play'), `Compute all ${rows.length} samples`) : null,
      h('label.check', h('input', { type: 'checkbox', checked: table.heatmap !== false, onchange: (event) => saveTable({ ...table, heatmap: event.target.checked }, 'Table format') }), 'Heat map'),
      h('button.btn.small', { type: 'button', onclick: () => copyTSV(table, rows) }, icon('copy'), 'Copy'),
      h('button.btn.small', { type: 'button', onclick: () => exportCSV(table, rows) }, icon('download'), 'CSV'),
      h('button.icon-button.small', { type: 'button', title: 'Delete table', onclick: () => { store.commit(setCollection(store.ws, 'tables', store.ws.tables.filter((t) => t.id !== table.id)), 'Delete table', ['tables']); tableId = store.ws.tables[0]?.id ?? null; } }, icon('trash')));
    const values = computeTable(app, table, rows.map((s) => s.id));
    // Column ranges for heat-map shading.
    const ranges = table.columns.map((_, j) => {
      let lo = Infinity; let hi = -Infinity;
      for (const row of values.values()) {
        const v = row[j];
        if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      return [lo, hi];
    });
    const metaFields = [...new Set(rows.flatMap((s) => Object.keys(s.meta ?? {})))].slice(0, 3);
    const head = h('tr', h('th', 'Sample'), ...metaFields.map((f) => h('th', f)),
      ...table.columns.map((column) => h('th.r', { title: columnLabel(ws, column), style: { maxWidth: '180px' } },
        h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center', justifyContent: 'flex-end' } },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '150px' } }, columnLabel(ws, column)),
          h('button.icon-button.small', { type: 'button', title: 'Column options', onclick: (event) => columnMenu(event.currentTarget, table, column) }, icon('chevronDown'))))));
    const body = h('tbody');
    for (const sample of rows) {
      const row = values.get(sample.id);
      body.append(h(`tr${sample.id === store.ui.sampleId ? '.selected' : ''}`, { onclick: () => app.selectSample(sample.id), style: { cursor: 'pointer' } },
        h('td', { style: { whiteSpace: 'nowrap' } }, sample.name),
        ...metaFields.map((f) => h('td.muted', sample.meta?.[f] ?? '')),
        ...table.columns.map((column, j) => {
          if (!row) return h('td.r.muted', '…');
          const v = row[j];
          const cell = h('td.r', formatStatistic(column.stat, v));
          if (table.heatmap !== false && Number.isFinite(v) && ranges[j][1] > ranges[j][0]) {
            const t = (v - ranges[j][0]) / (ranges[j][1] - ranges[j][0]);
            const color = colormapColor('viridis', 0.15 + 0.8 * t);
            cell.style.background = `${color}${document.documentElement.dataset.theme === 'dark' ? '88' : '55'}`;
          }
          return cell;
        })));
    }
    // Summary rows: mean and SD across samples.
    const summary = (label, fn) => h('tr', h('td', h('b', label)), ...metaFields.map(() => h('td')), ...table.columns.map((column, j) => {
      const vs = [...values.values()].map((row) => row[j]).filter(Number.isFinite);
      return h('td.r', h('b', vs.length ? formatStatistic(column.stat, fn(vs)) : '—'));
    }));
    const mean = (vs) => vs.reduce((a, b) => a + b, 0) / vs.length;
    const sd = (vs) => {
      const m = mean(vs);
      return Math.sqrt(vs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, vs.length - 1));
    };
    body.append(summary('Mean', mean), summary('SD', sd));
    tableHost.append(h('table.data', h('thead', head), body));
    if (unloaded.length) tableHost.append(h('p.muted', { style: { marginTop: '8px' } }, `${unloaded.length} sample(s) are not loaded yet (…); compute them to fill the table.`));
  }

  function columnMenu(anchor, table, column) {
    showMenu(anchor, [
      { label: 'Rename column…', icon: 'edit', onSelect: async () => { const label = await promptDialog({ title: 'Column name', label: 'Name', value: columnLabel(store.ws, column) }); if (label) saveTable({ ...table, columns: table.columns.map((c) => (c.id === column.id ? { ...c, label } : c)) }); } },
      { label: 'Compare between groups', icon: 'compare', onSelect: () => app.compareColumn?.(table, column) },
      { label: 'Move left', icon: 'chevronLeft', onSelect: () => move(table, column, -1) },
      { label: 'Move right', icon: 'chevronRight', onSelect: () => move(table, column, 1) },
      '-',
      { label: 'Remove column', icon: 'trash', danger: true, onSelect: () => saveTable({ ...table, columns: table.columns.filter((c) => c.id !== column.id) }, 'Remove column') },
    ]);
  }

  function move(table, column, delta) {
    const columns = table.columns.slice();
    const i = columns.findIndex((c) => c.id === column.id);
    const j = i + delta;
    if (j < 0 || j >= columns.length) return;
    [columns[i], columns[j]] = [columns[j], columns[i]];
    saveTable({ ...table, columns }, 'Reorder columns');
  }

  async function computeAll(rows) {
    computing = true;
    const progress = progressToast(`Computing ${rows.length} samples…`);
    let done = 0;
    for (const sample of rows) {
      await data.ensure(sample.id).catch(() => {});
      done += 1;
      progress.update(done / rows.length, `Computing ${sample.name} (${done}/${rows.length})`);
      if (done % 4 === 0) renderTable();
    }
    computing = false;
    progress.done(`Computed ${rows.length} samples.`);
    renderTable();
  }

  function matrix(table, rows) {
    const ws = store.ws;
    const values = computeTable(app, table, rows.map((s) => s.id));
    const metaFields = [...new Set(rows.flatMap((s) => Object.keys(s.meta ?? {})))];
    const header = ['Sample', 'File', ...metaFields, ...table.columns.map((c) => columnLabel(ws, c))];
    const lines = [header];
    for (const sample of rows) {
      const row = values.get(sample.id);
      lines.push([sample.name, sample.fileName, ...metaFields.map((f) => sample.meta?.[f] ?? ''), ...table.columns.map((_, j) => (row && Number.isFinite(row[j]) ? String(+row[j].toPrecision(8)) : ''))]);
    }
    return lines;
  }

  function exportCSV(table, rows) {
    const lines = matrix(table, rows).map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','));
    downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), `${table.name.replace(/[^\w.-]+/g, '_')}.csv`);
  }

  async function copyTSV(table, rows) {
    const text = matrix(table, rows).map((row) => row.join('\t')).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Table copied; paste it into a spreadsheet.', { kind: 'ok' });
    } catch {
      toast('The browser did not allow copying.', { kind: 'error' });
    }
  }

  function renderAll() {
    renderList();
    renderBuilder();
    renderTable();
  }

  renderAll();
  return {
    update(topics) {
      if (topics.has('ws') || topics.has('data') || topics.has('tables') || topics.has('theme') || topics.has('sample')) {
        if (!current() && store.ws.tables.length) tableId = store.ws.tables[0].id;
        renderAll();
      }
    },
    destroy() {
      root.remove();
    },
  };
}
