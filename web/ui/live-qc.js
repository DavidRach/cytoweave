// QC as files are acquired (Q4): the CytoWeave program watches a folder (watch.go; `cytoweave
// --watch <folder>` or QC → Live) and hands over each FCS file once it is complete. Each one is
// added to the workspace and checked at once: acquisition QC (qc-run.js) for samples and
// controls, Q and B for bead files (qb.js), added to the instrument's record so its
// Levey–Jennings charts flag a problem on the day it appears. The watch, its queue and its polling
// live on the app, so they go on in any view; QC → Live shows them.

import { h, icon, clear, formatCount } from './dom.js';
import { toast } from './overlays.js';
import { addDerived } from '../lib/workspace.js';
import { BEAD_PRODUCTS } from '../lib/qb.js';
import { INSTRUMENT_RECORDS, beadRun, fluorescenceChannels, instrumentOf, mergeRuns, runFlags, withRun } from '../lib/instrument-record.js';
import { DEFAULT_SETTINGS, runQC, saveQCResults } from './qc-run.js';
import { prefs } from './storage.js';

const POLL_MS = 1500;

export function installLiveQC(app, info) {
  const live = {
    available: Boolean(info),
    status: null,
    // The last file handled, remembered per program session and folder, so a reload goes on
    // where it stopped (and picks up files that landed while the window was closed).
    after: null,
    queue: [],
    options: { qc: true, beads: true },
    results: new Map(),
    busy: false,
    error: null,
    listeners: new Set(),
  };
  app.live = live;
  let timer = null;

  const changed = () => {
    for (const listener of live.listeners) listener();
    app.refreshStatus?.();
  };

  async function call(method, path, body) {
    const response = await fetch(path, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error ?? `The program answered ${response.status}.`);
    return json;
  }

  function schedule() {
    clearTimeout(timer);
    if (live.status?.watching) timer = setTimeout(poll, POLL_MS);
  }

  const handledKey = (folder) => `live:${info?.session}:${folder}`;

  async function poll() {
    try {
      if (live.after === null) {
        const first = await call('GET', 'api/watch?after=0');
        live.after = first.watching ? prefs.get(handledKey(first.folder), 0) : 0;
      }
      const status = await call('GET', `api/watch?after=${live.after}`);
      live.status = status;
      live.error = null;
      for (const file of status.files) {
        live.after = Math.max(live.after, file.seq);
        if (!live.queue.some((q) => q.seq === file.seq)) live.queue.push({ ...file, state: 'waiting' });
      }
      if (status.files.length) process();
    } catch (error) {
      live.error = error.message;
    }
    changed();
    schedule();
  }

  live.start = async (path) => {
    live.status = await call('POST', 'api/watch', { path });
    live.after = live.status.last;
    prefs.set(handledKey(live.status.folder), live.after);
    live.queue = [];
    changed();
    schedule();
  };

  live.stop = async () => {
    clearTimeout(timer);
    live.status = await call('DELETE', 'api/watch');
    changed();
  };

  live.handOverExisting = async () => {
    await call('POST', 'api/watch/existing');
    await poll();
  };

  // A replay: an example's files handed over one at a time, as if an instrument were writing them
  // to a watched folder, so live QC can be tried without one (and in the browser).
  let replayTimer = null;
  let replaySeq = 0;
  live.replay = async (exampleId, { interval = 3000 } = {}) => {
    live.stopReplay();
    const { EXAMPLES } = await import('../lib/examples.js');
    const example = EXAMPLES.find((e) => e.id === exampleId);
    if (!example) throw new Error(`There is no example called "${exampleId}".`);
    live.replaying = { title: example.title, total: 0, added: 0, generating: true };
    changed();
    const result = await app.worker('simulate').call('generateExample', { id: exampleId, options: {} });
    const files = result.files;
    Object.assign(live.replaying, { total: files.length, generating: false });
    changed();
    let index = 0;
    const land = () => {
      if (!live.replaying || index >= files.length) {
        live.stopReplay();
        return;
      }
      const file = files[index];
      index += 1;
      replaySeq -= 1;
      live.queue.push({ seq: replaySeq, name: file.name, size: file.bytes.byteLength, bytes: new Uint8Array(file.bytes), landed: Date.now(), state: 'waiting', replay: true });
      live.replaying.added = index;
      changed();
      process();
      replayTimer = setTimeout(land, interval);
    };
    land();
  };
  live.stopReplay = () => {
    clearTimeout(replayTimer);
    replayTimer = null;
    if (live.replaying) {
      live.replaying = null;
      changed();
    }
  };

  live.subscribe = (listener) => {
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  };

  // Files are added and checked one at a time, in the order they landed.
  async function process() {
    if (live.busy) return;
    live.busy = true;
    try {
      for (let item = next(); item; item = next()) {
        try {
          await handle(item);
        } catch (error) {
          item.state = 'error';
          item.error = error.message;
          toast(`${item.name}: ${error.message}`, { kind: 'error' });
        }
        if (!item.replay) prefs.set(handledKey(live.status?.folder), Math.max(prefs.get(handledKey(live.status?.folder), 0), item.seq));
        changed();
      }
    } finally {
      live.busy = false;
    }
  }

  const next = () => live.queue.find((q) => q.state === 'waiting');

  async function handle(item) {
    item.state = 'opening';
    changed();
    const records = await app.importFCSItems([item.bytes ? { name: item.name, bytes: item.bytes, order: 0 } : { name: item.name, size: item.size, localUrl: item.url, folder: item.folder, order: 0 }], { select: false });
    item.bytes = null;
    const record = records?.[0];
    if (!record) throw new Error('The file could not be read.');
    const sample = app.store.ws.samples.find((s) => s.id === record.id);
    item.sampleId = sample.id;
    item.events = sample.eventCount;
    if (sample.role === 'bead' && live.options.beads) {
      item.state = 'checking';
      changed();
      await measureBeads(item, sample);
      return;
    }
    if (!live.options.qc) {
      item.state = 'added';
      return;
    }
    item.state = 'checking';
    changed();
    const settings = structuredClone(app.qcState?.settings ?? DEFAULT_SETTINGS);
    const result = await runQC(app, sample, settings, { onProgress: (fraction) => { item.progress = fraction; changed(); } });
    live.results.set(sample.id, result);
    app.qcState?.results?.set(sample.id, result);
    await saveQCResults(app, live.results, [sample.id], settings);
    const s = result.persisted;
    // The first specific finding (the summary only restates the score); "and n more" for the rest.
    const specific = s.findings.filter((f) => f.method !== 'summary' && f.severity !== 'info');
    const finding = specific.length ? `${specific[0].text}${specific.length > 1 ? ` (and ${specific.length - 1} more)` : ''}` : null;
    Object.assign(item, { state: 'checked', score: s.score, grade: s.grade, percentRemoved: s.percentRemoved, finding, parallel: result.parallel });
    if (s.score < 70) toast(`${item.name}: QC score ${s.score}, ${s.percentRemoved.toFixed(1)}% of events removed. ${item.finding ?? ''}`, { kind: 'warn' });
  }

  // Q and B of a bead file, added to the workspace's and the library's record of the instrument;
  // the Levey–Jennings rules are applied to the new run against all of them.
  async function measureBeads(item, sample) {
    const settings = app.qcState?.instrument ?? { product: 'spherotech-8', peaks: 8, heights: false };
    const product = BEAD_PRODUCTS.find((p) => p.id === settings.product);
    const view = await app.data.ensure(sample.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const run = beadRun(view, sample, { peaks: settings.peaks, product: product?.label ?? null, channels: fluorescenceChannels(sample, { heights: settings.heights }) });
    const instrument = instrumentOf(sample.keywords);
    const id = `instrument-qc-${instrument.id}`;
    let record = app.store.ws.derived.find((d) => d.id === id) ?? { id, kind: 'instrument-qc', name: `Q and B of ${instrument.name}`, instrument, method: 'Parks 2017 weighted quadratic fit (flowQB)', runs: [] };
    record = withRun(record, run);
    app.store.commit(addDerived(app.store.ws, record).ws, `Measure Q and B (${sample.name})`, ['derived']);
    let doc = null;
    if (app.library?.putRecord) {
      doc = (await app.library.getRecord(INSTRUMENT_RECORDS, instrument.id)) ?? { name: instrument.name, instrument, runs: [] };
      doc = withRun(doc, { ...run, workspace: app.store.ws.name });
      await app.library.putRecord(INSTRUMENT_RECORDS, instrument.id, doc);
      app.qcState?.instrument?.library?.set(instrument.id, doc);
    }
    const runs = mergeRuns({ runs: record.runs, source: 'workspace' }, { runs: doc?.runs ?? [], source: 'library' });
    const index = runs.findIndex((r) => r.id === run.id);
    const flags = runFlags(runs, index);
    const rejected = flags.filter((f) => f.rules.some((rule) => rule !== '1-2s'));
    Object.assign(item, { state: 'beads', runs: runs.length, flags, rejected: rejected.length, instrument: instrument.name });
    if (rejected.length) {
      const worst = rejected.sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0];
      toast(`${item.name}: ${rejected.length} detector${rejected.length === 1 ? '' : 's'} out of control on ${instrument.name} (${worst.channel} ${worst.metric}, ${worst.rules.join(', ')}).`, { kind: 'warn' });
    }
  }

  // Started with --watch: pick up the watch at once.
  if (info?.watching) poll();
  return live;
}

const STATES = {
  waiting: ['Waiting', ''],
  opening: ['Reading', ''],
  checking: ['Checking', ''],
  added: ['Added', ''],
  error: ['Failed', 'danger'],
};

// QC → Live. ctx: { app, rerender, open (sample id, section) }.
export function createLiveSection(ctx) {
  const { app } = ctx;
  const live = app.live;
  let unsubscribe = null;
  let pathDraft = '';

  function resultCell(item) {
    if (item.state === 'checked') {
      const kind = item.score >= 90 ? 'ok' : item.score >= 70 ? 'warn' : 'danger';
      return h('td', h(`span.badge.${kind}`, `QC ${item.score}`), ' ', h('span.muted', `${item.percentRemoved.toFixed(1)}% removed`));
    }
    if (item.state === 'beads') {
      return h('td', item.rejected ? h('span.badge.danger', `${item.rejected} detector${item.rejected === 1 ? '' : 's'} out of control`) : h('span.badge.ok', 'In control'), ' ', h('span.muted', `Q and B, run ${item.runs}`));
    }
    const [label, kind] = STATES[item.state] ?? [item.state, ''];
    return h('td', h(`span.badge${kind ? `.${kind}` : ''}`, item.state === 'checking' && item.progress ? `${label} ${Math.round(100 * item.progress)}%` : label));
  }

  function noteCell(item) {
    if (item.error) return h('td.muted', item.error);
    if (item.state === 'beads') {
      const worst = item.flags.filter((f) => f.rules.some((r) => r !== '1-2s')).sort((a, b) => Math.abs(b.z) - Math.abs(a.z))[0];
      // 1-2s warnings alone are expected now and then (about 5% of runs per detector and metric).
      const warnings = item.flags.length ? `${item.flags.length} 1-2s warning${item.flags.length === 1 ? '' : 's'}: ${item.flags.slice(0, 6).map((f) => `${f.channel} ${f.metric}`).join(', ')}` : '';
      return h('td.muted', { title: warnings }, worst ? `${worst.channel}: ${worst.metric} ${worst.rules.join(', ')} (z = ${worst.z.toFixed(1)})` : '');
    }
    return h('td.muted', item.finding ?? '');
  }

  // Replaying an example as an acquisition (no instrument or folder needed).
  function replayPane() {
    const r = live.replaying;
    const choice = h('select.input.small', { 'aria-label': 'Example to replay' },
      h('option', { value: 'qc-showcase' }, 'Four wells with acquisition problems (acquisition QC)'),
      h('option', { value: 'bead-qc' }, 'Thirty days of rainbow beads (Q, B and Levey–Jennings)'));
    return h('div.pane',
      h('h3', icon('play'), 'Try it with an example', h('span.spacer'),
        r ? h('button.btn.small', { type: 'button', onclick: () => live.stopReplay() }, icon('stop'), 'Stop') : null),
      r
        ? h('p', { style: { margin: 0 } }, r.generating ? `Generating ${r.title}…` : `Replaying ${r.title}: ${r.added} of ${r.total} files have landed, one every few seconds.`)
        : h('div.btn-row', choice, h('button.btn', { type: 'button', onclick: () => live.replay(choice.value).catch((error) => toast(error.message, { kind: 'error' })) }, icon('play'), 'Replay as an acquisition')),
      r ? null : h('p.muted.small-print', 'An example\'s files land in this workspace one at a time, as an instrument would write them to a watched folder, and each is checked as it lands.'));
  }

  function render(host) {
    unsubscribe?.();
    unsubscribe = live?.subscribe(() => ctx.rerender());
    clear(host);
    if (!live?.available) {
      host.append(h('div.pane', h('div.empty', icon('play'), h('h3', 'QC as files are acquired'),
        h('p', 'Watching a folder needs the CytoWeave program, which reads the folder on this computer: start it with cytoweave --watch <folder>, or open it and choose a folder here.'))));
      host.append(replayPane());
      if (live?.queue.length) host.append(filesPane());
      return;
    }
    const status = live.status;
    const watching = status?.watching;
    const optionsRow = h('div.spectral-choices', { style: { marginTop: '10px' } },
      h('label.check', h('input', { type: 'checkbox', checked: live.options.qc, onchange: (e) => { live.options.qc = e.target.checked; } }), 'Acquisition QC of each file'),
      h('label.check', { title: 'Files named "beads" (as QC → Instrument recognizes them), with the bead product and levels chosen there' },
        h('input', { type: 'checkbox', checked: live.options.beads, onchange: (e) => { live.options.beads = e.target.checked; } }), 'Q and B of bead files, added to the instrument\'s record'));
    if (!watching) {
      const watchButton = h('button.btn.primary', { type: 'button', disabled: !pathDraft.trim(), onclick: () => start() }, icon('play'), 'Watch');
      const input = h('input.input', { type: 'text', placeholder: 'Folder the instrument exports to, e.g. D:\\Exports or /Volumes/Cytometer/Exports', value: pathDraft, style: { flex: '1', minWidth: '240px' }, 'aria-label': 'Folder to watch', oninput: (e) => { pathDraft = e.target.value; watchButton.disabled = !pathDraft.trim(); } });
      const start = async () => {
        try {
          await live.start(pathDraft.trim());
        } catch (error) {
          toast(error.message, { kind: 'error' });
        }
        ctx.rerender();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
      host.append(h('div.pane',
        h('h3', 'Watch a folder'),
        h('p.muted', { style: { marginTop: 0 } }, 'Each FCS file that appears in the folder (or its subfolders) is added to this workspace once the instrument has finished writing it, and checked at once. The folder is only read: nothing is written there. Files already in it are listed, not opened, unless you ask.'),
        h('div.btn-row', input, watchButton),
        optionsRow,
        h('p.muted.small-print', 'Or start CytoWeave watching: cytoweave --watch <folder>. Bead settings (product, levels) are those of QC → Instrument; acquisition QC uses the settings of QC → Clean.')));
    } else {
      const pending = status.pending ?? [];
      host.append(h('div.pane',
        h('h3', icon('play'), `Watching ${status.name}`, h('span.spacer'),
          h('button.btn.small', { type: 'button', onclick: async () => { try { await live.stop(); } catch (error) { toast(error.message, { kind: 'error' }); } ctx.rerender(); } }, icon('stop'), 'Stop')),
        h('p.muted', { style: { margin: 0 } }, status.folder),
        pending.length ? h('p', { style: { margin: '6px 0 0' } }, h('span.badge.accent', 'Being written'), ' ', pending.slice(0, 6).join(', '), pending.length > 6 ? ` and ${pending.length - 6} more` : '') : null,
        status.existing ? h('div.btn-row', { style: { marginTop: '8px' } }, h('button.btn.small', { type: 'button', onclick: () => live.handOverExisting().catch((error) => toast(error.message, { kind: 'error' })) }, icon('plus'), `Check the ${formatCount(status.existing)} file${status.existing === 1 ? '' : 's'} already there`)) : null,
        live.error ? h('div.callout.danger', { style: { marginTop: '8px' } }, icon('warning'), h('span', `The program does not answer: ${live.error}`)) : null,
        status.problem ? h('div.callout.warn', { style: { marginTop: '8px' } }, icon('warning'), h('span', status.problem)) : null,
        optionsRow));
    }
    if (!watching) host.append(replayPane());
    host.append(filesPane());
  }

  function filesPane() {
    const watching = live.status?.watching;
    const rows = [...live.queue].reverse();
    return h('div.pane',
      h('h3', 'Files', h('span.muted', { style: { fontWeight: 500 } }, rows.length ? `${rows.length}, newest first` : 'none yet')),
      rows.length
        ? h('div', { style: { overflow: 'auto', maxHeight: '560px' } }, h('table.data',
          h('thead', h('tr', h('th', 'Landed'), h('th', 'File'), h('th.r', 'Events'), h('th', 'Result'), h('th', 'Finding'))),
          h('tbody', rows.map((item) => h(`tr${item.sampleId ? '.clickable' : ''}`, {
            title: item.sampleId ? (item.state === 'beads' ? 'Open in QC → Instrument' : 'Open in QC → Clean') : '',
            onclick: () => item.sampleId && ctx.open(item.sampleId, item.state === 'beads' ? 'instrument' : 'clean'),
          },
          h('td.muted', new Date(item.landed).toLocaleTimeString()),
          h('td', item.name, item.existing ? h('span.muted', ' (was there)') : null),
          h('td.r', item.events ? formatCount(item.events) : '—'),
          resultCell(item),
          noteCell(item))))))
        : h('p.muted', { style: { margin: 0 } }, watching || live.replaying ? 'Waiting for the first file.' : 'Start watching a folder to check files as they arrive.'));
  }

  return { render, dispose: () => unsubscribe?.() };
}
