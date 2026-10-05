// Computed channels in the window: formula channels (lib/formula.js), written as an expression of
// other channels and computed for every sample, and the list of every computed channel (formulas,
// bead calibrations, ratios read from Gating-ML) with what defines it.

import { h, icon, clear, debounce } from './dom.js';
import { showDialog, confirmDialog, toast } from './overlays.js';
import { FUNCTIONS, FormulaError, evaluateColumns, resolveFormula } from '../lib/formula.js';
import { addDerived, channelCatalog, gatePath, removeDerived } from '../lib/workspace.js';
import { newId } from '../lib/gates.js';
import { quantileSorted } from '../lib/stats.js';

// Gates, plots and table columns that use a channel.
export function channelUses(ws, channel) {
  return {
    gates: ws.gates.filter((g) => g.dims?.some((d) => d.channel === channel)),
    plots: ws.plots.filter((p) => p.x === channel || p.y === channel),
    columns: ws.tables.flatMap((t) => t.columns.filter((c) => c.channel === channel)),
  };
}

export function installChannelDialogs(app) {
  const { store, data } = app;

  // A formula channel, new or (with `id`) edited.
  app.formulaDialog = (id = null) => {
    const ws = store.ws;
    const editing = id ? ws.derived.find((d) => d.id === id && d.kind === 'formula') : null;
    const used = editing ? channelUses(ws, editing.outputs[0]) : null;
    const locked = used && used.gates.length > 0;
    const catalog = channelCatalog(ws).filter((c) => c.type !== 'time' && c.name !== editing?.outputs[0]);
    const name = h('input.input', { type: 'text', value: editing?.outputs[0] ?? '', placeholder: 'For example CD4/CD8 ratio', disabled: locked, 'aria-label': 'Channel name' });
    const expression = h('textarea.input', { rows: 3, spellcheck: false, style: { fontFamily: 'var(--mono)', width: '100%' }, 'aria-label': 'Expression', placeholder: '[CD4] / [CD8]' }, editing?.params.source ?? editing?.params.expression ?? '');
    const status = h('div', { style: { minHeight: '58px', marginTop: '8px', fontSize: '12.5px' }, role: 'status' });
    const insert = (text) => {
      const { selectionStart: a, selectionEnd: b, value } = expression;
      expression.value = `${value.slice(0, a)}${text}${value.slice(b)}`;
      expression.focus();
      expression.selectionStart = expression.selectionEnd = a + text.length;
      check();
    };
    const chips = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', maxHeight: '96px', overflow: 'auto', marginTop: '6px' } },
      ...catalog.map((c) => h('button.btn.small', { type: 'button', title: `Insert ${c.marker ? `${c.marker} (${c.name})` : c.name}`, onclick: () => insert(`[${c.marker && catalog.filter((x) => x.marker === c.marker).length === 1 ? c.marker : c.name}]`) }, c.marker ? `${c.marker}` : c.name)));
    let resolved = null;

    function check() {
      clear(status);
      resolved = null;
      if (!expression.value.trim()) {
        status.append(h('p.muted', { style: { margin: 0 } }, 'Click a channel to insert it, or type an expression.'));
        return;
      }
      try {
        resolved = resolveFormula(expression.value, catalog);
      } catch (error) {
        if (!(error instanceof FormulaError)) throw error;
        const at = error.position ?? 0;
        status.append(h('div.callout.danger', { style: { margin: 0 } }, h('b', 'Not yet a formula: '), error.message,
          h('div', { style: { fontFamily: 'var(--mono)', marginTop: '4px', whiteSpace: 'pre' } }, `${expression.value}\n${' '.repeat(at)}^`)));
        return;
      }
      const view = data.view(store.ui.sampleId);
      const parts = [h('div', h('b', 'Computes '), h('code', resolved.text))];
      if (view && resolved.inputs.every((input) => view.hasChannel(input))) {
        const values = evaluateColumns(resolved.tree, (input) => view.column(input), view.eventCount);
        const finite = Float64Array.from(values.filter(Number.isFinite)).sort();
        const missing = values.length - finite.length;
        const fmt = (v) => (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : +v.toPrecision(4));
        parts.push(h('div.muted', `On ${view.record.name}: median ${finite.length ? fmt(quantileSorted(finite, 0.5)) : '—'}, 1st–99th percentile ${finite.length ? `${fmt(quantileSorted(finite, 0.01))} to ${fmt(quantileSorted(finite, 0.99))}` : '—'}${missing ? `; ${missing.toLocaleString('en-US')} event${missing === 1 ? '' : 's'} (${((100 * missing) / values.length).toFixed(1)}%) with no value (a division by zero or the log of a value ≤ 0), in no gate` : ''}.`));
      }
      status.append(...parts);
      if (!name.value.trim() && !editing) name.placeholder = defaultName(resolved.text);
    }
    const defaultName = (text) => text.replace(/[[\]]/g, '').slice(0, 40);
    expression.addEventListener('input', debounce(check, 150));

    const save = () => {
      if (!resolved) {
        check();
        toast('Correct the expression first.', { kind: 'error' });
        return false;
      }
      const output = (name.value.trim() || defaultName(resolved.text)).trim();
      const taken = channelCatalog(store.ws).some((c) => c.name === output && c.name !== editing?.outputs[0]);
      if (taken) {
        toast(`A channel is already called "${output}".`, { kind: 'error' });
        return false;
      }
      const record = { id: editing?.id ?? newId('d'), kind: 'formula', name: output, inputs: resolved.inputs, outputs: [output], params: { expression: resolved.text, source: expression.value.trim() } };
      let next = store.ws;
      // A renamed channel takes its plots and table columns with it.
      if (editing && editing.outputs[0] !== output) {
        const old = editing.outputs[0];
        next = { ...next, plots: next.plots.map((p) => ({ ...p, x: p.x === old ? output : p.x, y: p.y === old ? output : p.y })), tables: next.tables.map((t) => ({ ...t, columns: t.columns.map((c) => (c.channel === old ? { ...c, channel: output } : c)) })) };
      }
      store.commit(addDerived(next, record).ws, editing ? `Edit formula channel ${output}` : `Add formula channel ${output}`);
      toast(`${output} = ${resolved.text}`, { kind: 'ok' });
      return true;
    };

    showDialog({
      title: editing ? `Formula channel ${editing.outputs[0]}` : 'New formula channel',
      width: 'wide',
      content: [
        h('p.muted', { style: { marginTop: 0 } }, 'A channel computed for every event of every sample from other channels, after compensation: a ratio, a sum, a logarithm. Gate on it, plot it and put its statistics in tables like any other channel.'),
        h('label.field', h('span', 'Name'), name),
        locked ? h('p.muted', { style: { fontSize: '11.5px', marginTop: '-4px' } }, `Gates use this channel (${used.gates.map((g) => g.name).join(', ')}), so its name stays.`) : null,
        h('label.field', h('span', 'Expression'), expression),
        h('div.muted', { style: { fontSize: '11.5px' } }, 'Channels in square brackets, by marker or detector: [CD4], [FITC-A]. Operators + - * / ^ and parentheses. Functions: ', Object.entries(FUNCTIONS).map(([fn, f]) => `${fn} (${f.label})`).join(', '), '.'),
        chips,
        status,
      ],
      buttons: [
        ...(editing ? [{ label: 'Remove…', ghost: true, danger: true, onClick: async () => { await removeChannel(editing); } }] : []),
        { label: 'Cancel', ghost: true },
        { label: editing ? 'Save' : 'Add channel', primary: true, onClick: save },
      ],
    });
    check();
  };

  async function removeChannel(record) {
    const output = record.outputs[0];
    const uses = channelUses(store.ws, output);
    const list = [...uses.gates.map((g) => `gate ${gatePath(store.ws, g.id)}`), ...(uses.plots.length ? [`${uses.plots.length} plot(s)`] : []), ...(uses.columns.length ? [`${uses.columns.length} table column(s)`] : [])];
    const ok = await confirmDialog({ title: `Remove ${output}?`, message: list.length ? `It is used by ${list.join(', ')}; they will no longer apply. Undo brings it back.` : 'Undo brings it back.', confirm: 'Remove', danger: true });
    if (!ok) return;
    store.commit(removeDerived(store.ws, record.id), `Remove channel ${output}`);
  }

  // Every computed channel and what defines it.
  app.computedChannelsDialog = () => {
    const body = h('div');
    const render = () => {
      clear(body);
      const ws = store.ws;
      const records = ws.derived.filter((d) => ['formula', 'calibration', 'ratio'].includes(d.kind));
      if (!records.length) {
        body.append(h('div.empty', icon('plus'), h('h3', 'No computed channels'), h('p', 'Add a formula channel (a ratio, a sum, a logarithm of other channels), or calibrate fluorescence in MEF units with beads (QC → Calibration).')));
        return;
      }
      const describe = (d) => {
        if (d.kind === 'formula') return h('code', d.params.expression);
        if (d.kind === 'ratio') return h('code', `${d.params.A ?? 1} × ([${d.inputs[0]}] − ${d.params.B ?? 0}) / ([${d.inputs[1]}] − ${d.params.C ?? 0})`);
        return h('span', `${d.inputs[0]} in ${d.params.unit} from the beads of ${d.params.beads ?? 'a bead sample'} (slope ${d.params.m.toFixed(3)}); ${d.samples ? `${d.samples.length} sample${d.samples.length === 1 ? '' : 's'}` : 'every sample'}`);
      };
      body.append(h('table.data', h('thead', h('tr', h('th', 'Channel'), h('th', 'Defined as'), h('th', 'Used by'), h('th'))),
        h('tbody', ...records.map((d) => {
          const uses = channelUses(ws, d.outputs[0]);
          return h('tr',
            h('td', h('b', d.outputs[0])),
            h('td', describe(d)),
            h('td.muted', [uses.gates.length ? `${uses.gates.length} gate(s)` : '', uses.plots.length ? `${uses.plots.length} plot(s)` : '', uses.columns.length ? `${uses.columns.length} column(s)` : ''].filter(Boolean).join(', ') || '—'),
            h('td', { style: { whiteSpace: 'nowrap' } },
              d.kind === 'formula' ? h('button.btn.small', { type: 'button', onclick: () => { dialog.close(); app.formulaDialog(d.id); } }, icon('edit'), 'Edit') : null,
              h('button.icon-button.small', { type: 'button', title: `Remove ${d.outputs[0]}`, 'aria-label': `Remove ${d.outputs[0]}`, onclick: async () => { await removeChannel(d); render(); } }, icon('trash'))));
        }))));
    };
    const dialog = showDialog({
      title: 'Computed channels',
      width: 'wide',
      content: [body],
      buttons: [
        { label: 'Calibrate with beads…', ghost: true, onClick: () => { app.openCalibration?.(); } },
        { label: 'New formula channel…', onClick: () => { app.formulaDialog(); } },
        { label: 'Close', primary: true },
      ],
    });
    render();
  };
}
