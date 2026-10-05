// Analysis templates in the window: save the workspace's analysis (or a population's subtree) as a
// template, kept in the library across workspaces and downloadable as a .cwt file, and apply one
// (or a published gating strategy, lib/strategies.js) to the open experiment with a preview of how
// its channels match (lib/templates.js). A strategy's gates are placed on the current sample's
// events (lib/recipes.js).

import { h, icon, downloadBlob, formatCount } from './dom.js';
import { showDialog, toast } from './overlays.js';
import { applyTemplate, buildTemplate, matchChannels, parseTemplate } from '../lib/templates.js';
import { ROOT, channelCatalog, gateById, gatePath } from '../lib/workspace.js';
import { newId } from '../lib/gates.js';
import { STRATEGIES } from '../lib/strategies.js';
import { placeOnSample } from '../lib/recipes.js';

export const TEMPLATE_RECORDS = 'templates';
const fileName = (name) => `${String(name).replace(/[^\w.+-]+/g, '_').replace(/^_+|_+$/g, '') || 'template'}.cwt`;

export function installTemplateDialogs(app) {
  const { store, library } = app;

  // The templates in the library, newest first: [{ id, name, modified }].
  app.listTemplates = async () => {
    try {
      return (await library.listRecords(TEMPLATE_RECORDS)).sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    } catch {
      return [];
    }
  };

  app.loadTemplate = async (id) => {
    const doc = await library.getRecord(TEMPLATE_RECORDS, id);
    if (!doc) throw new Error('The template is no longer in the library.');
    return parseTemplate(JSON.stringify(doc));
  };

  // Saves a template to the library; returns { id, template }.
  app.storeTemplate = async (template) => {
    const id = newId('tpl');
    await library.putRecord(TEMPLATE_RECORDS, id, { ...template, id, modified: new Date().toISOString() });
    return { id, template };
  };

  app.saveTemplate = async () => {
    const ws = store.ws;
    if (!ws.gates.length) {
      toast('Draw some gates first: a template keeps the gating tree, with its plots, tables and figures.');
      return;
    }
    const selected = store.ui.gateId ? gateById(ws, store.ui.gateId) : null;
    const options = { scope: 'all', name: `${ws.name} template` };
    const nameInput = h('input.input', { value: options.name, oninput: (e) => { options.name = e.target.value; } });
    const content = [
      h('p', 'A template keeps the gates, their scales, plots, tables and figure layouts, and which compensation the samples used. Applied to another experiment, its channels are matched by marker (scatter and time by name), so the panel can be on other detectors.'),
      h('label.field', h('span', 'Name'), nameInput),
      h('div.section-title', { style: { marginTop: '10px' } }, 'Gates'),
      h('label.check', h('input', { type: 'radio', name: 'tpl-scope', checked: true, onchange: () => { options.scope = 'all'; } }), `The whole gating tree (${ws.gates.length} populations)`),
      selected ? h('label.check', { style: { marginTop: '4px' } }, h('input', { type: 'radio', name: 'tpl-scope', onchange: () => { options.scope = 'selected'; } }), `${gatePath(ws, selected.id)} and the populations under it`) : null,
      h('p.muted', { style: { fontSize: '12px', marginTop: '8px' } }, 'Gates on computed channels (QC pass, clusters, unmixed channels) and per-sample adjustments are not kept; the template lists them.'),
    ];
    showDialog({
      title: 'Save as a template',
      content,
      buttons: [
        { label: 'Cancel', ghost: true },
        { label: 'Download (.cwt)', onClick: () => { const template = make(); downloadBlob(new Blob([JSON.stringify(template, null, 1)], { type: 'application/json' }), fileName(template.name)); } },
        { label: 'Save to the library', primary: true, onClick: () => { save(make()); } },
      ],
    });
    const make = () => buildTemplate(store.ws, { name: options.name.trim() || `${ws.name} template`, gateIds: options.scope === 'selected' && selected ? [selected.id] : null, version: app.version });
    async function save(template) {
      try {
        await app.storeTemplate(template);
        toast(`Saved the template “${template.name}” (${template.gates.length} populations) to the library.${template.notes.length ? ` ${template.notes.length} note${template.notes.length === 1 ? '' : 's'}: ${template.notes[0]}` : ''}`, { kind: 'ok', timeout: 7000 });
      } catch (error) {
        toast(`The template could not be saved: ${error.message}`, { kind: 'error' });
      }
    }
  };

  // Opens a template file (.cwt) the user picked or dropped.
  app.openTemplateFile = async (item) => {
    try {
      const text = item.bytes ? new TextDecoder().decode(item.bytes) : await item.file.text();
      app.applyTemplateDialog(parseTemplate(text));
    } catch (error) {
      toast(`${item.name}: ${error.message}`, { kind: 'error' });
    }
  };

  // Chooses a template (library or file), then shows the matching and applies it.
  app.applyTemplateDialog = async (template = null) => {
    if (!store.ws.samples.length) {
      toast('Add the samples first: a template is matched to their channels.');
      return;
    }
    if (template) return showApply(template);
    const list = await app.listTemplates();
    const dialog = showDialog({
      title: 'Apply a template',
      content: [
        h('div.section-title', 'Published gating strategies'),
        h('p.muted', { style: { fontSize: '12px' } }, 'Gating hierarchies from OMIP articles, written for CytoWeave. Their gates are placed on the current sample\'s events, for any panel that measures the markers.'),
        h('table.data', h('tbody', STRATEGIES.map((t) => h('tr',
          h('td', h('div', h('strong', t.name)), h('div.muted', { style: { fontSize: '11.5px' } }, t.description)),
          h('td.r', h('button.btn.small', { type: 'button', onclick: () => { dialog.close(); showApply(t); } }, 'Choose')))))),
        h('div.section-title', { style: { marginTop: '12px' } }, 'In the library'),
        h('p.muted', { style: { fontSize: '12px' } }, 'Templates saved in the library, newest first. A template file (.cwt) can also be opened or dropped on the window.'),
        list.length
          ? h('div', { style: { maxHeight: '320px', overflow: 'auto' } }, h('table.data', h('tbody', list.map((t) => h('tr',
            h('td', t.name || t.id),
            h('td.muted', String(t.modified ?? '').slice(0, 10)),
            h('td.r', h('button.btn.small', { type: 'button', onclick: async () => { dialog.close(); try { showApply(await app.loadTemplate(t.id)); } catch (error) { toast(error.message, { kind: 'error' }); } } }, 'Choose')))))))
          : h('p.muted', 'No templates in the library yet: Workspace → Save as a template keeps one.'),
      ],
      buttons: [
        { label: 'Cancel', ghost: true },
        { label: 'Open a file…', onClick: () => app.pickFiles('.cwt') },
      ],
    });
  };

  async function showApply(template) {
    const ws = store.ws;
    // Recipe gates (published strategies) are placed on one sample's events: the current one, or
    // the first sample.
    let place;
    let placedOn = null;
    if (template.gates.some((g) => g.type === 'recipe')) {
      placedOn = ws.samples.find((x) => x.id === store.ui.sampleId) ?? ws.samples.find((x) => x.role === 'sample') ?? ws.samples[0];
      const view = await app.data.ensure(placedOn.id).catch(() => null);
      if (!view) {
        toast(`The events of ${placedOn.name} could not be read, so the strategy's gates cannot be placed.`, { kind: 'error' });
        return;
      }
      place = placeOnSample(view, placedOn.name);
    }
    const catalog = channelCatalog(ws).filter((c) => !c.derived);
    const overrides = {};
    const options = { parentId: ROOT, scales: 'keep', plots: true, tables: true, figures: true };
    const summary = h('div');
    const rows = h('tbody');
    const describe = (c) => (c.marker ? `${c.marker} · ${c.name}` : c.name);
    const render = () => {
      const match = matchChannels(template, catalog, overrides);
      const preview = applyTemplate(store.ws, template, { ...options, overrides, place });
      rows.replaceChildren(...Object.entries(template.channels).map(([key, wanted]) => {
        const m = match[key];
        // A formula channel is computed from the channels it uses, as they match.
        if (wanted.type === 'formula') {
          const r = preview.report.channels.find((c) => c.key === key);
          return h('tr',
            h('td', h('strong', wanted.name), h('span.muted', ' formula')),
            h('td', h('code', r?.formula ?? '')),
            h('td', r?.channel ? h('span.badge.ok', 'Computed') : h('span.badge.warn', 'Not found')),
            h('td.muted', { style: { fontSize: '11.5px' } }, r?.note ?? (r?.channel && r.channel !== wanted.name ? `added as ${r.channel}` : '')));
        }
        const select = h('select.input.small', { 'aria-label': `Channel for ${wanted.marker || wanted.name}`, onchange: (e) => { if (e.target.value) overrides[key] = e.target.value; else delete overrides[key]; render(); } },
          h('option', { value: '' }, m.channel && !overrides[key] ? `${describe(catalog.find((c) => c.name === m.channel) ?? { name: m.channel })} (${m.how})` : '— none —'),
          ...catalog.map((c) => h('option', { value: c.name, selected: overrides[key] === c.name }, describe(c))));
        return h('tr',
          h('td', wanted.marker ? h('span', h('strong', wanted.marker), h('span.muted', ` ${wanted.name}`)) : wanted.name),
          h('td', select),
          h('td', m.channel ? h('span.badge.ok', m.how === 'chosen' ? 'Chosen' : 'Matched') : h('span.badge.warn', 'Not found')),
          h('td.muted', { style: { fontSize: '11.5px' } }, m.note ?? ''));
      }));
      const { applied, skipped } = preview.report.gates;
      summary.replaceChildren(
        h('p', h('strong', `${applied} of ${template.gates.length} populations`), ` will be added${options.parentId !== ROOT ? ` under ${gateById(store.ws, options.parentId)?.name}` : ' at the top of the tree'}${[[preview.report.plots, 'plot'], [preview.report.tables, 'table'], [preview.report.figures, 'figure']].some(([n]) => n) ? `, with ${[[preview.report.plots, 'plot'], [preview.report.tables, 'table'], [preview.report.figures, 'figure']].filter(([n]) => n).map(([n, word]) => `${n} ${word}${n === 1 ? '' : 's'}`).join(', ')}` : ''}.`),
        skipped.length ? h('div.callout.warn', icon('warning'), h('span', `Not added: ${skipped.slice(0, 8).map((s) => `${s.gate} (${s.reason})`).join('; ')}${skipped.length > 8 ? '…' : ''}`)) : null,
        !template.builtIn && template.compensation?.source && template.compensation.source !== 'none' ? h('p.muted', { style: { fontSize: '12px' } }, `The template's samples used ${template.compensation.source === 'file' ? 'the compensation stored in their files' : `a computed matrix${template.compensation.method ? ` (${template.compensation.method})` : ''}`}; set the compensation of these samples in Compensate.`) : null,
        template.notes?.length ? h('p.muted', { style: { fontSize: '12px' } }, `Template notes: ${template.notes.join(' ')}`) : null,
      );
    };
    const strategyInfo = template.builtIn ? h('div', { style: { fontSize: '12.5px' } },
      h('p', template.description),
      h('p.muted', { style: { fontSize: '12px' } }, template.citation.replace(/\s*doi:\S+$/, ''), ' ', h('a', { href: `https://doi.org/${template.doi}`, target: '_blank', rel: 'noopener' }, `doi:${template.doi}`), '. ', template.license),
      template.substitutions?.length ? h('details', h('summary', `Differences from the article (${template.substitutions.length})`), h('ul', template.substitutions.map((x) => h('li', x)))) : null,
      h('p', `The gates are placed on the events of ${placedOn.name}, each from its parent population, and shared by every sample: review them across samples, or adapt them to each. Populations come with a suggested Cell Ontology term to confirm in the inspector.`)) : null;
    const parentSelect = h('select.input.small', { onchange: (e) => { options.parentId = e.target.value; render(); } },
      h('option', { value: ROOT }, 'The top of the gating tree'),
      ...ws.gates.filter((g) => g.type !== 'boolean').map((g) => h('option', { value: g.id }, gatePath(ws, g.id))));
    const check = (key, label) => h('label.check', h('input', { type: 'checkbox', checked: options[key], onchange: (e) => { options[key] = e.target.checked; render(); } }), label);
    render();
    showDialog({
      title: `Apply “${template.name}”`,
      width: 'wide',
      content: [
        strategyInfo ?? h('p', `Channels are matched by marker (scatter and time by name). Gates keep their position in data values, so on another instrument a gate may need adjusting: review it across samples, or adapt it to each sample.`),
        h('div', { style: { maxHeight: '300px', overflow: 'auto' } }, h('table.data', h('thead', h('tr', h('th', 'In the template'), h('th', 'Channel here'), h('th', ''), h('th', ''))), rows)),
        h('div.row', { style: { marginTop: '10px', gap: '16px', alignItems: 'end' } },
          h('label.field', h('span', 'Add the gates under'), parentSelect),
          h('label.field', h('span', 'Scales'), h('select.input.small', { onchange: (e) => { options.scales = e.target.value; render(); } }, h('option', { value: 'keep' }, 'Keep the scales set here'), h('option', { value: 'replace' }, "Use the template's scales")))),
        h('div.row', { style: { marginTop: '8px', gap: '16px' } }, check('plots', 'Plots'), check('tables', 'Tables'), check('figures', 'Figures')),
        summary,
      ],
      buttons: [
        { label: 'Cancel', ghost: true },
        { label: 'Apply', primary: true, onClick: () => {
          const { ws: next, report } = applyTemplate(store.ws, template, { ...options, overrides, place, sampleId: store.ui.sampleId ?? undefined });
          store.commit(next, `Apply the template ${template.name}`, ['gate', 'plots', 'tables', 'figures']);
          toast(`Applied “${template.name}”: ${formatCount(report.gates.applied)} populations${report.gates.skipped.length ? `, ${report.gates.skipped.length} not added` : ''}. Undo removes them.`, { kind: report.gates.skipped.length ? 'warn' : 'ok', timeout: 7000 });
        } },
      ],
    });
  }
}
