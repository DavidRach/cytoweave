// The batch report dialog of the Figures view: repeat a figure for each sample or for each value of
// an annotation, see the pages and any notes before writing them, and export a multi-page PDF or
// a PowerPoint deck. The choices are kept with the figure (figure.batch), so templates and agents
// repeat it the same way.

import { h, clear, downloadBlob } from './dom.js';
import { showDialog, progressToast, toast } from './overlays.js';
import { expandReport, followedSample, reportFields } from '../lib/reports.js';
import { setCollection } from '../lib/workspace.js';
import { prefs } from './storage.js';

export function batchReportDialog(app, fig) {
  const { store } = app;
  const ws = store.ws;
  const batch = fig.batch ?? {};
  const fields = reportFields(ws);
  const plotSamples = [...new Set(fig.items.filter((i) => i.kind === 'plot').map((i) => i.sampleId))].map((id) => ws.samples.find((s) => s.id === id)).filter(Boolean);
  if (!plotSamples.length) {
    toast('Add plots to the figure first: a report repeats them for each sample.', { kind: 'error' });
    return;
  }
  const by = h('select.input.small', h('option', { value: 'sample', selected: !batch.by || batch.by === 'sample' }, 'Each sample'),
    ...fields.map((f) => h('option', { value: f, selected: batch.by === f }, `Each ${f}`)));
  const group = h('select.input.small', h('option', { value: '' }, 'The samples (not controls)'), ...ws.groups.map((g) => h('option', { value: g.id, selected: batch.groupId === g.id }, `Group: ${g.name}`)));
  const followed = h('select.input.small', ...plotSamples.map((s) => h('option', { value: s.id, selected: (batch.sampleId ?? followedSample(fig)) === s.id }, s.name)));
  const followedField = h('label.field', h('span', 'Plots that follow the sample'), followed);
  const format = h('select.input.small', h('option', { value: 'pdf' }, 'PDF'), h('option', { value: 'pptx', selected: batch.format === 'pptx' }, 'PowerPoint'));
  const embed = h('input', { type: 'checkbox', checked: prefs.get('figureProvenance', true) !== false });
  const summary = h('div', { style: { marginTop: '10px' } });
  const choices = () => ({ by: by.value, groupId: group.value || null, ...(by.value === 'sample' ? { sampleId: followed.value } : {}) });
  let report = null;
  const update = () => {
    clear(summary);
    followedField.hidden = by.value !== 'sample';
    try {
      report = expandReport(store.ws, fig, choices());
    } catch (error) {
      report = null;
      summary.append(h('div.callout.warn', error.message));
      return;
    }
    const pages = report.pages;
    const explain = by.value === 'sample'
      ? `The plots of ${ws.samples.find((s) => s.id === followed.value)?.name} are redrawn on each page's sample; plots of other samples stay on every page.`
      : `Each page is one ${by.value}: a plot of a sample with a ${by.value} is redrawn on that ${by.value}'s sample matching it on the annotations that tell the figure's samples apart; plots of samples without one stay.`;
    summary.append(
      h('p', { style: { margin: '0 0 6px' } }, h('b', `${pages.length} page${pages.length === 1 ? '' : 's'}`), ': ', pages.slice(0, 8).map((p) => p.label).join(', '), pages.length > 8 ? `, … ${pages.at(-1).label}` : ''),
      h('p.muted', { style: { margin: '0 0 6px', fontSize: '12px' } }, explain),
      report.notes.length ? h('div.callout.warn', { style: { fontSize: '12px' } }, h('ul', { style: { margin: 0, paddingLeft: '18px' } }, ...report.notes.slice(0, 12).map((n) => h('li', n)), report.notes.length > 12 ? h('li', `${report.notes.length - 12} more`) : null)) : null);
  };
  for (const input of [by, group, followed]) input.addEventListener('change', update);
  showDialog({
    title: `Batch report: ${fig.name}`,
    width: 'wide',
    content: [
      h('p.muted', { style: { marginTop: 0 } }, 'The figure repeated page after page. Text such as {sample}, {subject} or {page} is filled on each page, and statistics items list each page\'s samples. Every number the report prints is recorded with the table column or gate it comes from.'),
      h('div.row', { style: { gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end' } },
        h('label.field', h('span', 'Repeat for'), by),
        h('label.field', h('span', 'From'), group),
        followedField,
        h('label.field', h('span', 'Format'), format)),
      h('label.check', { title: 'The report carries the gates, scales, compensation, sample names and file checksums behind its plots, and the record of where each number comes from.' }, embed, 'Embed the analysis and the record of every number'),
      summary,
    ],
    buttons: [
      { label: 'Cancel', ghost: true },
      {
        label: 'Export',
        primary: true,
        onClick: async () => {
          if (!report) return false;
          const next = { ...choices(), format: format.value };
          if (JSON.stringify(next) !== JSON.stringify(fig.batch ?? {})) {
            store.commit(setCollection(store.ws, 'figures', store.ws.figures.map((f) => (f.id === fig.id ? { ...f, batch: next } : f)), 'edit-figure'), 'Batch report settings', ['figures']);
          }
          prefs.set('figureProvenance', embed.checked);
          exportReport(app, store.ws.figures.find((f) => f.id === fig.id) ?? fig, next, embed.checked);
          return true;
        },
      },
    ],
  });
  update();
}

async function exportReport(app, fig, choices, provenance) {
  const progress = progressToast(`Writing ${fig.name}…`);
  try {
    const exporter = await import('./figure-export.js');
    const write = choices.format === 'pptx' ? exporter.reportPPTX : exporter.reportPDF;
    const out = await write(app, fig, { ...choices, provenance, onProgress: (f) => progress.update(f, `Writing ${fig.name}: ${Math.round(f * 100)}%`) });
    const name = `${fig.name.replace(/[^\w.-]+/g, '_')}.${choices.format === 'pptx' ? 'pptx' : 'pdf'}`;
    downloadBlob(new Blob([out.bytes], { type: choices.format === 'pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/pdf' }), name);
    progress.done(`${out.report.pages.length} page${out.report.pages.length === 1 ? '' : 's'}, ${out.trace.length} numbers traced to their tables and gates.`);
  } catch (error) {
    progress.fail(`The report failed: ${error.message}`);
  }
}

