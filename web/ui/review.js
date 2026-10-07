// Review reports in the window: the Report view's Review report tab (lib/review-report.js).

import { h, icon, clear, downloadBlob, formatBytes } from './dom.js';
import { progressToast } from './overlays.js';
import { buildReviewReport } from '../lib/review-report.js';
import { certificateSource } from './certificates.js';

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const safeName = (name) => String(name || 'analysis').replace(/[^\w.-]+/g, '_');

// Makes the review report of the current workspace: { html, model, warnings, fileName }.
export async function makeReviewReport(app, options = {}) {
  const ws = app.store.ws;
  const out = await buildReviewReport(ws, certificateSource(app), {
    version: app.version,
    plots: options.plots ?? 'all',
    includeControls: Boolean(options.includeControls),
    colormap: app.store.ui.colormap,
    onProgress: async (fraction, text) => {
      options.onProgress?.(fraction, text);
      await pause();
    },
  });
  return { ...out, fileName: `${safeName(ws.name)}.review.html` };
}

export function reviewPane(app, state) {
  const ws = app.store.ws;
  const samples = ws.samples.filter((s) => s.role === 'sample' || s.role === 'reference').length;
  const plotsBox = h('input', { type: 'checkbox', checked: state.plots !== 'none', onchange: (e) => { state.plots = e.target.checked ? 'all' : 'none'; } });
  const controlsBox = h('input', { type: 'checkbox', checked: Boolean(state.includeControls), onchange: (e) => { state.includeControls = e.target.checked; } });
  const result = h('div');
  const showResult = () => {
    clear(result);
    if (!state.last) return;
    const { size, numbers, url, fileName, warnings } = state.last;
    result.append(h('div.callout.ok', { style: { marginTop: '12px', display: 'block' } },
      h('div', h('strong', fileName), ` · ${formatBytes(size)} · ${numbers.toLocaleString('en-US')} numbers, each traced`),
      h('div.row', { style: { gap: '8px', marginTop: '8px' } },
        h('a.btn.small', { href: url, target: '_blank', rel: 'noopener', style: { textDecoration: 'none' } }, icon('eye'), 'Open in a new tab'))),
    ...warnings.map((w) => h('div.callout.warn', { style: { marginTop: '6px' } }, icon('warning'), h('span', w))));
  };
  const make = async () => {
    const progress = progressToast('Computing every number and drawing every sample…');
    try {
      const out = await makeReviewReport(app, { plots: plotsBox.checked ? 'all' : 'none', includeControls: controlsBox.checked, onProgress: (f, text) => progress.update(f, text) });
      const blob = new Blob([out.html], { type: 'text/html' });
      downloadBlob(blob, out.fileName);
      if (state.last?.url) URL.revokeObjectURL(state.last.url);
      state.last = { size: blob.size, numbers: (out.html.match(/<button type="button" class="n/g) ?? []).length, url: URL.createObjectURL(blob), fileName: out.fileName, warnings: out.warnings };
      progress.done(`Review report: ${formatBytes(blob.size)}.`);
      showResult();
    } catch (error) {
      progress.fail(`The review report could not be made: ${error.message}`);
    }
  };
  showResult();
  return h('div.pane',
    h('h3', 'Review report'),
    h('p.muted', { style: { marginTop: 0, maxWidth: '78ch' } },
      'One HTML file of this analysis for a PI, a collaborator or a reviewer, who opens it in any browser without CytoWeave: the samples with their checksums, the gating hierarchy, every sample\'s gates on its own events, the figures and tables, the saved comparisons, the methods, MIFlowCyt and the change log. Every number in it is traced: a click shows where it comes from. The file loads nothing from the network.'),
    h('label.check', plotsBox, `Draw every sample's gates (${samples} sample${samples === 1 ? '' : 's'})`),
    h('label.check', controlsBox, 'Draw the controls\' gates too'),
    h('div.row', { style: { gap: '8px', marginTop: '10px' } },
      h('button.btn.primary', { type: 'button', onclick: make, disabled: !ws.samples.length }, icon('download'), 'Make a review report')),
    result);
}
