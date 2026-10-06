// Spectral unmixing workbench. Reference spectra come from single-stain controls (gated
// automatically, with quality checks); autofluorescence signatures from the unstained control;
// the panel is checked (similarity, complexity, spreading); samples are unmixed into derived
// channels; and alternative unmixing models, residuals and the raw "spectral ribbon" of any
// population can be inspected. Heavy work runs in workers/spectral-worker.js.
//
// The reference library (spectra, their quality, autofluorescence signatures, the spreading
// matrix and the chosen settings) is kept as one derived record in the workspace,
// { id: 'spectral-setup', kind: 'spectral-setup', … }, so it is saved, undoable and auditable.
// Spectra are also kept across experiments in the library's spectral library of the instrument
// (lib/spectral-library.js): the Library tab compares the controls with it, saves them to it,
// and adds library spectra for fluorochromes without a control (setup.libraryReferences).
// The Diagnose tab runs the unmixing doctor (lib/spectral-doctor.js) on the selected sample and
// applies the fix it proposes to the reference library (a library or estimated spectrum in
// setup.libraryReferences, a control excluded, autofluorescence signatures added).

import { h, icon, clear, formatCount } from './dom.js';
import { showMenu, showDialog, toast, progressToast, promptDialog } from './overlays.js';
import { population } from '../lib/engine.js';
import { ROOT, addDerived, gatePath, updateSample } from '../lib/workspace.js';
import { complexityIndex, similarityMatrix } from '../lib/spectral.js';
import { LIBRARY_TOLERANCE, SPECTRA_RECORDS, compareWithLibrary, latestEntries, libraryEntry, missingFromPanel, spectrumOn, withEntries } from '../lib/spectral-library.js';
import { INSTRUMENT_RECORDS, acquisitionDate, instrumentOf } from '../lib/instrument-record.js';
import { c1FromRuns, noiseOn, predictedSpreading, spreadModel, spreadReceived } from '../lib/spread.js';
import { applyTransform, axisTicks, createTransform, defaultTransform } from '../lib/transforms.js';
import { categoricalColor, colormapLUT, luminance } from '../lib/colormaps.js';
import {
  AF_MODES,
  LASER_LABELS,
  METHODS,
  complexityInterpretation,
  copyColumns,
  detectorTick,
  guessFluorochrome,
  laserBands,
  recommendFromComparison,
  ribbonCounts,
  similarPairs,
  similarityLevel,
  thinIndices,
} from '../lib/spectral-ui.js';
import {
  LIMITS,
  SEED,
  SETUP_ID,
  baseSetup as baseSetupOf,
  buildModel as buildModelOf,
  computeReferences,
  diagnose as diagnoseSample,
  findAutofluorescence,
  spectralState,
  unmixSamples as unmixSamplesOf,
  unstainedColumns as unstainedColumnsOf,
  withChannelSettings,
} from './spectral-run.js';

const AF_COLORS = ['#7d8597', '#b07d4f', '#5f9a7a', '#9d6fa8', '#5f8fa3', '#a3925f'];
const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const TABS = [
  { id: 'spectra', label: 'Spectra', icon: 'spectral' },
  { id: 'quality', label: 'Panel quality', icon: 'qc' },
  { id: 'design', label: 'Panel design', icon: 'layers' },
  { id: 'compare', label: 'Compare models', icon: 'compare' },
  { id: 'residuals', label: 'Residuals', icon: 'target' },
  { id: 'doctor', label: 'Diagnose', icon: 'stethoscope' },
  { id: 'ribbon', label: 'Signature', icon: 'density' },
  { id: 'library', label: 'Library', icon: 'library' },
];

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => document.documentElement.dataset.theme === 'dark';

export function mountSpectralMode(app, container) {
  const { store, data } = app;
  const worker = app.worker('spectral');
  const jobs = new Set();
  const boxes = new Set();
  const unstainedCache = new Map();
  const ui = {
    tab: 'spectra',
    logY: false,
    showAF: true,
    hidden: new Set(),
    hover: null,
    expanded: new Set(),
    target: 'current',
    compareModels: new Set(['ols', 'nnls', 'ols+af']),
    compareNegatives: 'sample',
    compare: null,
    residual: null,
    doctor: null,
    ribbon: null,
    busy: null,
    library: undefined, // the instrument's spectral library record (null: none; undefined: not read)
    libraryFor: null,
    libraryChosen: null,
  };

  const headTitle = h('h1');
  const sampleSelect = h('select.input.small', { title: 'Sample shown in Residuals, Signature and Compare', style: { maxWidth: '240px' }, onchange: () => app.selectSample(sampleSelect.value) });
  const headActions = h('div.btn-row');
  const stepsHost = h('div.spectral-steps');
  const controlsHost = h('div');
  const afHost = h('div');
  const unmixHost = h('div');
  const tabBar = h('div.segmented.spectral-tabs', { role: 'tablist' });
  const tabHost = h('div');
  const leftColumn = h('div',
    h('div.pane', stepsHost),
    h('div.pane', h('h3', icon('flask'), 'Reference controls', h('span.spacer'), h('button.btn.small.ghost', { type: 'button', title: 'Choose which files are controls and name their fluorochromes', onclick: () => assignControls() }, icon('tag'), 'Assign')), controlsHost),
    h('div.pane', h('h3', icon('cell'), 'Autofluorescence'), afHost),
    h('div.pane', h('h3', icon('play'), 'Unmix'), unmixHost));
  const body = h('div.view-body');
  const root = h('div.view.spectral-view',
    h('div.workbench-head', headTitle, h('span.spacer'), sampleSelect, headActions),
    body);
  container.append(root);

  // --- Workspace state (spectral-run.js) ------------------------------------------------------

  const ws = () => store.ws;
  const state = () => spectralState(ws());
  const setup = () => state().setup;
  const controls = () => state().controls;
  const unstainedList = () => state().unstainedList;
  const unstainedSample = () => state().unstainedSample;
  const controlSettings = (id) => state().controlSettings(id);
  const panelDetectors = () => state().panelDetectors();
  const detectorRange = (detectors) => state().detectorRange(detectors);
  const references = () => state().references();
  const activeRefs = () => state().activeRefs();
  const afSignatures = () => state().afSignatures();
  const settings = () => state().settings();
  const panelSpectra = () => state().panelSpectra();
  const duplicateNames = () => state().duplicateNames();
  const unmixProblems = () => state().unmixProblems();
  const panelComplexity = () => state().panelComplexity();
  const baseSetup = () => baseSetupOf(state(), app.version);

  function saveSetup(patch, label) {
    const current = setup() ?? baseSetup();
    const record = { ...current, ...patch, id: SETUP_ID, kind: 'spectral-setup', modified: new Date().toISOString() };
    store.commit(addDerived(ws(), record).ws, label, ['derived']);
  }

  function setControlSetting(sampleId, patch, label) {
    const all = { ...(setup()?.controlSettings ?? {}) };
    all[sampleId] = { ...(all[sampleId] ?? {}), ...patch };
    saveSetup({ controlSettings: all, spreading: null }, label);
  }

  function referencesKey() {
    return activeRefs().map((r) => `${r.sample.id}:${r.ref.computed}`).join('|');
  }

  // --- Data access ---------------------------------------------------------------------------

  function detectorColumns(view, detectors) {
    return detectors.map((name) => {
      const column = view.raw.get(name);
      if (!column) throw new Error(`"${view.record.name}" has no detector ${name}.`);
      return column;
    });
  }

  const unstainedColumns = (detectors) => unstainedColumnsOf(app, state(), detectors, unstainedCache);
  const buildModel = (method, afMode, name) => buildModelOf(app, state(), method, afMode, name, unstainedCache);

  // The current sample's population: { view, indices (null = all), label, note }.
  async function currentPopulation() {
    const id = store.ui.sampleId;
    if (!id) return null;
    const view = await data.ensure(id);
    const gateId = store.ui.gateId ?? ROOT;
    let indices = null;
    let note = '';
    try {
      const pop = population(view, ws(), gateId);
      if (pop === undefined) note = 'The selected gate does not apply to this sample; all events are used.';
      else indices = pop;
    } catch {
      note = 'The selected population could not be evaluated; all events are used.';
    }
    const label = gateId === ROOT || note ? 'All events' : gatePath(ws(), gateId);
    return { view, indices, label, note, count: indices ? indices.length : view.eventCount };
  }

  // Runs a worker job with a progress toast; resolves to the result or null when canceled.
  async function runJob(type, payload, { message, transfer, quiet = false } = {}) {
    let job = null;
    const progress = quiet ? null : progressToast(message, () => job?.cancel());
    job = worker.run(type, payload, { transfer, onProgress: (fraction, note) => progress?.update(fraction, note) });
    jobs.add(job);
    try {
      const result = await job.promise;
      progress?.done();
      return result;
    } catch (error) {
      if (error.canceled) {
        progress?.done('Canceled.', 'info');
        return null;
      }
      progress?.fail(error.message);
      throw error;
    } finally {
      jobs.delete(job);
    }
  }

  // Follows a worker job of spectral-run.js, so closing the view cancels it.
  const track = (job) => {
    jobs.add(job);
    job.promise.finally(() => jobs.delete(job)).catch(() => {});
    return job;
  };

  // --- Actions -------------------------------------------------------------------------------

  async function gateControls(only = null) {
    if (!panelDetectors().length) {
      toast('The controls have no raw spectral detectors in common.', { kind: 'error' });
      return;
    }
    const list = controls().filter((s) => !only || only.includes(s.id));
    if (!list.length) return;
    ui.busy = 'controls';
    renderLeft();
    let canceled = false;
    const progress = progressToast(`Gating ${list.length} control${list.length > 1 ? 's' : ''}…`, () => { canceled = true; for (const job of jobs) job.cancel(); });
    try {
      const run = await computeReferences(app, { only, track, isCanceled: () => canceled, onProgress: (f, message) => progress.update(f, message), cache: unstainedCache });
      if (run.canceled || canceled) {
        progress.done('Gating canceled; no spectra were changed.', 'info');
        return;
      }
      saveSetup({ references: run.references, params: run.params, spreading: null }, list.length > 1 ? `Reference spectra from ${list.length} controls` : `Reference spectrum of ${run.computed[0]?.fluorochrome}`);
      const failed = run.computed.filter((r) => r.error).length;
      progress.done(failed ? `${list.length - failed} spectra computed; ${failed} control(s) failed.` : `${list.length} reference spectra computed.`, failed ? 'error' : 'ok');
    } catch (error) {
      progress.fail(error.message);
    } finally {
      ui.busy = null;
      renderAll();
    }
  }

  async function extractAF() {
    const sample = unstainedSample();
    if (!sample || !panelDetectors().length) return;
    ui.busy = 'af';
    renderLeft();
    // A gate on the unstained control (e.g. live single cells) is used when one is selected.
    let job = null;
    const progress = progressToast(`Finding autofluorescence signatures in ${sample.name}…`, () => job?.cancel());
    try {
      const run = await findAutofluorescence(app, { gateId: store.ui.gateId, onProgress: (f, note) => progress.update(f, note), track: (j) => { job = track(j); return job; } });
      if (!run) {
        progress.done('Canceled.', 'info');
        return;
      }
      progress.done();
      saveSetup({ autofluorescence: run.autofluorescence, settings: { ...(setup()?.settings ?? {}), afMode: run.afMode } }, `Autofluorescence: ${run.autofluorescence.k} signature${run.autofluorescence.k > 1 ? 's' : ''}`);
      toast(`Found ${run.autofluorescence.k} autofluorescence signature${run.autofluorescence.k > 1 ? 's' : ''} in ${sample.name}.`, { kind: 'ok' });
    } catch (error) {
      progress.fail(error.message);
    } finally {
      ui.busy = null;
      renderAll();
    }
  }

  function targetSamples() {
    const all = ws().samples;
    if (ui.target === 'current') return all.filter((s) => s.id === store.ui.sampleId);
    if (ui.target === 'all') return all.filter((s) => s.role === 'sample');
    if (ui.target === 'everything') return all;
    const group = ws().groups.find((g) => g.id === ui.target);
    return group ? all.filter((s) => group.sampleIds.includes(s.id)) : [];
  }

  async function unmixSamples() {
    const problems = unmixProblems();
    if (problems.length) {
      toast(problems[0], { kind: 'error' });
      return;
    }
    const samples = targetSamples();
    if (!samples.length) {
      toast('Choose the samples to unmix.', { kind: 'error' });
      return;
    }
    ui.busy = 'unmix';
    renderLeft();
    let canceled = false;
    const progress = progressToast(`Unmixing ${samples.length} sample${samples.length > 1 ? 's' : ''}…`, () => { canceled = true; for (const job of jobs) job.cancel(); });
    try {
      const run = await unmixSamplesOf(app, samples, { track, isCanceled: () => canceled, onProgress: (f, message) => progress.update(f, message), cache: unstainedCache });
      if (run.canceled || canceled) {
        progress.done('Unmixing canceled; nothing was saved.', 'info');
        return;
      }
      const { result, outputs, skipped } = run;
      progress.update(0.98, 'Saving the unmixed channels…');
      await app.saveDerived(result, `Unmix ${result.perSample.size} sample${result.perSample.size > 1 ? 's' : ''} (${run.methodLabel})`);
      if (run.channelSettings) store.commit(withChannelSettings(ws(), run.channelSettings, outputs.length), 'Scales for unmixed channels', ['ws']);
      progress.done();
      toast(`Unmixed ${result.perSample.size} sample${result.perSample.size > 1 ? 's' : ''} into ${outputs.length} channels${skipped.length ? `; ${skipped.length} skipped` : ''}.`, { kind: skipped.length ? 'error' : 'ok', action: { label: 'Gate them', onClick: () => app.setMode('gate') }, timeout: 7000 });
      for (const problem of skipped.slice(0, 2)) toast(problem, { kind: 'error' });
    } catch (error) {
      progress.fail(error.message);
    } finally {
      ui.busy = null;
      renderAll();
    }
  }

  // One worker job per control (its row of the matrix), so only one control is in memory at once.
  async function computeSpreading() {
    const refs = activeRefs();
    const detectors = setup()?.params?.detectors ?? panelDetectors();
    if (refs.length < 2 || unmixProblems().length) return;
    ui.busy = 'spreading';
    renderTab();
    let canceled = false;
    let current = null;
    const progress = progressToast('Unmixing the controls for the spreading matrix…', () => { canceled = true; current?.cancel(); });
    try {
      const needUnstained = refs.some((r) => !r.sample.library && controlSettings(r.sample.id).negative === 'unstained');
      const unstained = needUnstained ? await unstainedColumns(detectors) : null;
      const names = refs.map((r) => r.name);
      const F = names.length;
      const spectra = panelSpectra();
      const matrix = new Array(F * F).fill(null);
      const observations = [];
      for (let i = 0; i < F && !canceled; i += 1) {
        const r = refs[i];
        // A library spectrum has no control events to unmix: its row stays empty.
        if (r.sample.library) continue;
        progress.update(i / F, `Unmixing the ${r.name} control (${i + 1}/${F})`);
        const view = await data.ensure(r.sample.id);
        const columns = copyColumns(detectorColumns(view, detectors), thinIndices(null, view.eventCount, LIMITS.control));
        const negative = controlSettings(r.sample.id).negative ?? 'internal';
        current = worker.run('spreadingFromControls', {
          controls: [{ fluorochrome: r.name, columns, peakDetector: r.ref.peakDetector, negative }],
          unstained: negative === 'unstained' ? unstained : null,
          detectors,
          spectra,
          options: { seed: SEED },
        }, { transfer: columns.map((c) => c.buffer) });
        jobs.add(current);
        let result;
        try {
          result = await current.promise;
        } catch (error) {
          if (error.canceled) break;
          throw error;
        } finally {
          jobs.delete(current);
        }
        for (let j = 0; j < F; j += 1) {
          const v = result.matrix[i * F + j];
          matrix[i * F + j] = Number.isFinite(v) ? +v.toFixed(4) : null;
        }
        // The variance differences behind the row, for fitting the instrument's noise (spread.js).
        for (const o of result.observations ?? []) {
          observations.push({ i: o.i, deltaF: +o.deltaF.toPrecision(6), positiveEvents: o.positiveEvents, rows: o.rows.map((r) => ({ j: r.j, variance: +r.variance.toPrecision(5), se: +r.se.toPrecision(4) })) });
        }
      }
      if (canceled) {
        progress.done('Canceled; the spreading matrix was not changed.', 'info');
        return;
      }
      // The instrument's photon and laser noise, fitted to the controls' spread, and each
      // control's spread predicted from the others as a check.
      let noise = null;
      let check = null;
      if (observations.length >= 3) {
        progress.update(0.98, 'Fitting the instrument\'s noise to the spread');
        try {
          current = worker.run('spreadNoise', { names, detectors, spectra: spectra.map((sp) => Array.from(sp.spectrum)), observations });
          jobs.add(current);
          const fitted = await current.promise;
          noise = fitted.noise;
          check = { measurable: fitted.check.measurable, medianRatio: fitted.check.medianRatio, within2x: fitted.check.within2x, correlation: fitted.check.correlation };
        } catch (error) {
          if (!error.canceled) toast(`The noise of the instrument could not be fitted: ${error.message}`, { kind: 'warn' });
        } finally {
          jobs.delete(current);
        }
      }
      saveSetup({
        spreading: {
          key: referencesKey(),
          names,
          matrix,
          method: 'Spillover spreading matrix of the OLS-unmixed controls (Nguyen et al. 2013): SS = √(σ²pos − σ²neg) / √ΔF, σ the robust SD; controls gated as for their reference spectra.',
          computed: new Date().toISOString(),
          observations,
          noise,
          check,
        },
      }, 'Spectral spreading matrix');
      progress.done('Spreading matrix computed.', 'ok');
    } catch (error) {
      progress.fail(error.message);
    } finally {
      ui.busy = null;
      renderAll();
    }
  }

  const MODEL_CHOICES = [
    { id: 'ols', label: 'OLS', method: 'ols', af: 'none' },
    { id: 'wls-fixed', label: 'WLS (fixed)', method: 'wls-fixed', af: 'none' },
    { id: 'wls', label: 'WLS (per event)', method: 'wls', af: 'none' },
    { id: 'nnls', label: 'NNLS', method: 'nnls', af: 'none' },
    { id: 'ols+af1', label: 'OLS + 1 AF', method: 'ols', af: 'single', needsAF: 1 },
    { id: 'ols+af', label: 'OLS + per-event AF', method: 'ols', af: 'perEvent', needsAF: 2 },
    { id: 'nnls+af', label: 'NNLS + per-event AF', method: 'nnls', af: 'perEvent', needsAF: 2 },
  ];

  async function runComparison() {
    const problems = unmixProblems();
    if (problems.length) {
      toast(problems[0], { kind: 'error' });
      return;
    }
    const afCount = afSignatures().length;
    const choices = MODEL_CHOICES.filter((c) => ui.compareModels.has(c.id) && (c.needsAF ?? 0) <= afCount);
    if (choices.length < 2) {
      toast('Choose at least two models to compare.', { kind: 'error' });
      return;
    }
    const detectors = setup()?.params?.detectors ?? panelDetectors();
    ui.busy = 'compare';
    renderTab();
    try {
      const pop = await currentPopulation();
      if (!pop) throw new Error('Select a sample first.');
      const columns = copyColumns(detectorColumns(pop.view, detectors), thinIndices(pop.indices, pop.view.eventCount, LIMITS.compare));
      const models = [];
      for (const c of choices) models.push(await buildModel(c.method, c.af, c.label));
      const options = { seed: SEED, maxEvents: LIMITS.compare };
      if (ui.compareNegatives === 'unstained') {
        const unstained = await unstainedColumns(detectors);
        if (unstained) options.unstainedColumns = unstained;
      }
      const result = await runJob('compareUnmixing', { columns, models, options }, { message: `Comparing ${models.length} unmixing models…`, transfer: columns.map((c) => c.buffer) });
      if (!result) return;
      ui.compare = { result, sample: pop.view.record.name, population: pop.label, note: pop.note, key: compareKey() };
    } catch (error) {
      toast(error.message, { kind: 'error' });
    } finally {
      ui.busy = null;
      renderTab();
    }
  }

  function compareKey() {
    return `${store.ui.sampleId}|${store.ui.gateId ?? ROOT}|${referencesKey()}|${setup()?.autofluorescence?.computed ?? ''}`;
  }

  function residualKey() {
    const s = settings();
    return `${store.ui.sampleId}|${store.ui.gateId ?? ROOT}|${referencesKey()}|${setup()?.autofluorescence?.computed ?? ''}|${s.method}|${s.afMode}`;
  }

  async function runResidualCheck() {
    if (unmixProblems().length || !store.ui.sampleId) return;
    const key = residualKey();
    if (ui.residual?.key === key && (ui.residual.report || ui.residual.running)) return;
    ui.residual = { key, running: true };
    renderTab();
    try {
      const detectors = setup()?.params?.detectors ?? panelDetectors();
      const pop = await currentPopulation();
      const columns = copyColumns(detectorColumns(pop.view, detectors), thinIndices(pop.indices, pop.view.eventCount, LIMITS.check));
      const { method, afMode } = settings();
      const model = await buildModel(method, afMode, 'current settings');
      const result = await runJob('residualCheck', { columns, model, options: { seed: SEED, bins: 24, maxEvents: 20000 } }, { quiet: true, transfer: columns.map((c) => c.buffer) });
      if (ui.residual?.key !== key) return;
      ui.residual = { key, report: result?.report ?? null, sample: pop.view.record.name, population: pop.label, note: pop.note, events: columns[0].length, detectors, method, afMode };
    } catch (error) {
      if (ui.residual?.key === key) ui.residual = { key, error: error.message };
    } finally {
      if (ui.residual?.key === key) ui.residual.running = false;
      if (ui.tab === 'residuals') renderTab();
    }
  }

  // --- Dialogs and menus ---------------------------------------------------------------------

  function assignControls() {
    const detectors = panelDetectors();
    const rows = ws().samples.map((sample) => {
      const role = h('select.input.small', ...['sample', 'unstained', 'single-stain', 'fmo', 'bead', 'reference'].map((r) => h('option', { value: r, selected: sample.role === r }, r === 'single-stain' ? 'single-stain control' : r === 'unstained' ? 'unstained control' : r)));
      const fluor = h('input.input.small', { value: sample.role === 'single-stain' ? guessFluorochrome(sample, detectors) : (sample.meta?.fluorochrome ?? ''), placeholder: 'e.g. BV421' });
      const marker = h('input.input.small', { value: sample.meta?.marker ?? '', placeholder: 'e.g. CD3' });
      const sync = () => {
        const on = role.value === 'single-stain';
        fluor.disabled = !on;
        marker.disabled = !on;
        if (on && !fluor.value) fluor.value = guessFluorochrome({ ...sample, role: 'single-stain' }, detectors);
      };
      role.addEventListener('change', sync);
      sync();
      return { sample, role, fluor, marker, row: h('tr', h('td', { style: { maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: sample.fileName }, sample.name), h('td', role), h('td', fluor), h('td', marker)) };
    });
    showDialog({
      title: 'Assign reference controls',
      width: 'wide',
      content: [
        h('p.muted', 'Mark each single-stain reference control and the unstained control, and name the fluorochrome each control carries (the name of its unmixed channel). Markers are optional and label the unmixed channels.'),
        h('div', { style: { maxHeight: '60vh', overflow: 'auto' } }, h('table.data', h('thead', h('tr', h('th', 'Sample'), h('th', 'Role'), h('th', 'Fluorochrome'), h('th', 'Marker'))), h('tbody', rows.map((r) => r.row)))),
      ],
      buttons: [
        { label: 'Cancel', ghost: true },
        {
          label: 'Save',
          primary: true,
          onClick: () => {
            let next = ws();
            let changed = 0;
            for (const r of rows) {
              const patch = {};
              if (r.role.value !== r.sample.role) patch.role = r.role.value;
              if (r.role.value === 'single-stain') {
                const fluorochrome = r.fluor.value.trim();
                const markerName = r.marker.value.trim();
                if (fluorochrome !== (r.sample.meta?.fluorochrome ?? '') || markerName !== (r.sample.meta?.marker ?? '')) patch.meta = { ...r.sample.meta, fluorochrome: fluorochrome || undefined, marker: markerName || undefined };
              }
              if (Object.keys(patch).length) {
                next = updateSample(next, r.sample.id, patch);
                changed += 1;
              }
            }
            if (changed) store.commit(next, `Assign ${changed} control${changed > 1 ? 's' : ''}`, ['samples']);
            return true;
          },
        },
      ],
    });
  }

  async function renameControl(entry) {
    const fluorochrome = await promptDialog({ title: `Fluorochrome of ${entry.sample.name}`, label: 'Fluorochrome (names the unmixed channel)', value: entry.name });
    if (fluorochrome === null || fluorochrome === '') return;
    const marker = await promptDialog({ title: `Marker stained with ${fluorochrome}`, label: 'Marker (optional, labels the unmixed channel)', value: entry.marker, hint: 'Leave empty if unknown.' });
    let next = updateSample(ws(), entry.sample.id, { meta: { ...entry.sample.meta, fluorochrome, marker: marker || undefined } });
    const current = next.derived.find((d) => d.id === SETUP_ID);
    if (current) {
      const refs = current.references.map((r) => (r.sampleId === entry.sample.id ? { ...r, fluorochrome, marker: marker || '' } : r));
      next = addDerived(next, { ...current, references: refs, spreading: null }).ws;
    }
    store.commit(next, `Name control ${fluorochrome}`, ['samples', 'derived']);
  }

  function controlMenu(anchor, entry) {
    const detectors = setup()?.params?.detectors ?? panelDetectors();
    const cs = controlSettings(entry.sample.id);
    if (entry.sample.library) {
      showMenu(anchor, [
        { label: entry.excluded ? 'Include in the panel' : 'Exclude from the panel', icon: entry.excluded ? 'plus' : 'minus', onSelect: () => setControlSetting(entry.sample.id, { excluded: !entry.excluded }, entry.excluded ? `Include ${entry.name}` : `Exclude ${entry.name}`) },
        { label: 'Remove the library spectrum', icon: 'close', danger: true, onSelect: () => saveSetup({ libraryReferences: (setup()?.libraryReferences ?? []).filter((e) => `lib:${e.id}` !== entry.sample.id), spreading: null }, `Remove the library spectrum of ${entry.name}`) },
      ]);
      return;
    }
    showMenu(anchor, [
      { label: 'Name fluorochrome and marker…', icon: 'edit', onSelect: () => renameControl(entry) },
      { label: 'Gate this control again', icon: 'play', onSelect: () => gateControls([entry.sample.id]) },
      { label: 'Show in Gate view', icon: 'gate', onSelect: () => { app.selectSample(entry.sample.id); app.setMode('gate'); } },
      '-',
      { section: 'Negative population' },
      { label: 'Internal (unstained events in this tube)', checked: (cs.negative ?? 'internal') === 'internal', onSelect: () => { setControlSetting(entry.sample.id, { negative: 'internal' }, 'Control negative: internal'); gateControls([entry.sample.id]); } },
      { label: 'Unstained control (universal negative; cell controls only)', title: 'For controls stained on cells. Bead controls need their own negative beads: unstained cells are more autofluorescent and would leave a negative autofluorescence imprint in the spectrum.', checked: cs.negative === 'unstained', disabled: !unstainedSample(), onSelect: () => { setControlSetting(entry.sample.id, { negative: 'unstained' }, 'Control negative: unstained control'); gateControls([entry.sample.id]); } },
      '-',
      { label: 'Peak detector…', icon: 'target', hint: cs.peakDetector ?? 'automatic', onSelect: () => choosePeak(anchor, entry, detectors) },
      { label: entry.excluded ? 'Include in the panel' : 'Exclude from the panel', icon: entry.excluded ? 'plus' : 'minus', onSelect: () => setControlSetting(entry.sample.id, { excluded: !entry.excluded }, entry.excluded ? `Include ${entry.name}` : `Exclude ${entry.name}`) },
      { label: 'Not a control (mark as sample)', icon: 'close', danger: true, onSelect: () => store.commit(updateSample(ws(), entry.sample.id, { role: 'sample' }), `${entry.sample.name} is a sample`, ['samples']) },
    ]);
  }

  function choosePeak(anchor, entry, detectors) {
    const cs = controlSettings(entry.sample.id);
    showMenu(anchor, [
      { label: 'Automatic', checked: !cs.peakDetector, onSelect: () => { setControlSetting(entry.sample.id, { peakDetector: null }, 'Peak detector: automatic'); gateControls([entry.sample.id]); } },
      '-',
      ...detectors.map((d) => ({ label: d, checked: cs.peakDetector === d, onSelect: () => { setControlSetting(entry.sample.id, { peakDetector: d }, `Peak detector of ${entry.name}: ${d}`); gateControls([entry.sample.id]); } })),
    ], { search: true, searchPlaceholder: 'Detector…' });
  }

  // --- Rendering: head and left column ---------------------------------------------------------

  function renderHead() {
    clear(headTitle);
    const sample = ws().samples.find((s) => s.id === store.ui.sampleId);
    headTitle.append(icon('spectral'), 'Spectral unmixing', sample ? h('span.crumbs', `· ${sample.name}${store.ui.gateId && store.ui.gateId !== ROOT ? ` · ${gatePath(ws(), store.ui.gateId)}` : ''}`) : null);
    clear(sampleSelect);
    sampleSelect.hidden = !ws().samples.length;
    const roleTag = { 'single-stain': ' (control)', unstained: ' (unstained)' };
    for (const s of ws().samples) sampleSelect.append(h('option', { value: s.id, selected: s.id === store.ui.sampleId }, `${s.name}${roleTag[s.role] ?? ''}`));
    clear(headActions);
    const refs = references();
    if (controls().length) {
      const missing = refs.filter((r) => !r.ref).length;
      headActions.append(h(`button.btn.small${missing ? '.primary' : ''}`, { type: 'button', disabled: Boolean(ui.busy), onclick: () => gateControls() }, icon('sparkles'), missing ? `Gate ${missing === refs.length ? 'all' : missing} control${missing > 1 ? 's' : ''}` : 'Re-gate controls'));
    }
  }

  function stepItem(done, active, title, detail) {
    return h(`div.spectral-step${done ? '.done' : ''}${active ? '.active' : ''}`, h('span.dot', done ? icon('check') : null), h('div', h('b', title), h('span', detail)));
  }

  function renderSteps() {
    clear(stepsHost);
    const refs = references();
    const active = activeRefs();
    const af = afSignatures();
    const unmixed = ws().derived.filter((d) => d.kind === 'unmixing');
    const ci = panelComplexity();
    const step1 = refs.length > 0 && active.length === refs.filter((r) => !r.excluded).length && active.length > 0;
    stepsHost.append(
      h('div.section-title', 'Workflow'),
      stepItem(refs.length > 0, !refs.length, '1 · Mark controls', refs.length ? `${refs.length} single-stain control${refs.length > 1 ? 's' : ''}${unstainedSample() ? ', 1 unstained' : ', no unstained control'}` : 'Single-stain controls and an unstained control'),
      stepItem(step1, refs.length > 0 && !step1, '2 · Reference spectra', active.length ? `${active.length} spectra · ${refs.reduce((n, r) => n + (r.ref?.warnings?.length ?? 0), 0)} warnings` : 'Gate the controls automatically'),
      stepItem(af.length > 0, step1 && !af.length && Boolean(unstainedSample()), '3 · Autofluorescence', af.length ? `${af.length} signature${af.length > 1 ? 's' : ''}` : unstainedSample() ? 'Optional: extract from the unstained control' : 'Optional; needs an unstained control'),
      stepItem(step1 && Number.isFinite(ci), false, '4 · Check the panel', Number.isFinite(ci) ? `Complexity index ${ci.toFixed(1)}` : 'Similarity, complexity, spreading'),
      stepItem(unmixed.length > 0, step1 && !unmixed.length, '5 · Unmix', unmixed.length ? `${Object.keys(unmixed[unmixed.length - 1].files ?? {}).length} sample(s) unmixed` : 'Writes “(unmixed)” channels you can gate'));
  }

  function renderControls() {
    clear(controlsHost);
    const refs = references();
    if (!refs.length) {
      controlsHost.append(h('p.muted', { style: { margin: '0 0 8px' } }, 'No single-stain controls are marked. Mark the reference controls (one fluorochrome each, beads or cells) and the unstained control.'),
        h('button.btn.small.primary', { type: 'button', onclick: () => assignControls() }, icon('tag'), 'Assign controls…'));
      return;
    }
    const dups = new Set(duplicateNames());
    const list = h('div.spectral-controls');
    const colorIndex = new Map(activeRefs().map((r, i) => [r.sample.id, i]));
    for (const entry of refs) {
      const { ref } = entry;
      const color = colorIndex.has(entry.sample.id) ? categoricalColor(colorIndex.get(entry.sample.id)) : 'var(--line-strong)';
      const warnings = ref?.warnings ?? [];
      const badges = [];
      if (entry.excluded) badges.push(h('span.badge', 'excluded'));
      const changed = libraryChanges().get(entry.sample.id);
      if (entry.sample.library) badges.push(h('span.badge.accent', { title: `From the spectral library: ${ref.entry.file ?? ''}${ref.entry.workspace ? ` (${ref.entry.workspace})` : ''}, acquired ${(ref.entry.date ?? '').slice(0, 10)}. No control events: not in the spreading matrix.` }, 'library'), h('span.badge.accent', { title: 'Peak detector' }, ref.peakDetector));
      else if (!ref) badges.push(h('span.badge', 'not gated'));
      else if (ref.error) badges.push(h('span.badge.danger', { title: ref.error }, 'failed'));
      else {
        if (changed) badges.push(h('span.badge.danger', { title: `Differs from the library's ${changed.entry.fluorochrome} of ${(changed.entry.date ?? '').slice(0, 10)} by ${changed.maxDiff.toFixed(3)} at ${changed.detector} (peak = 1): a degraded tandem, a new lot or a changed instrument? See the Library tab.` }, 'differs from library'));
        badges.push(h('span.badge', { title: `Positive events (of ${formatCount(ref.eventsUsed)} used)` }, `+${formatCount(ref.positiveEvents)}`));
        badges.push(h('span.badge', { title: `Negative events (${ref.negativeSource === 'unstained' ? 'unstained control' : 'internal'}${ref.matchedNegatives ? ', matched in autofluorescence' : ''})` }, `−${formatCount(ref.negativeEvents)}`));
        badges.push(h('span.badge.accent', { title: 'Peak detector' }, ref.peakDetector));
      }
      if (warnings.length) badges.push(h('span.badge.warn', { title: warnings.join('\n') }, icon('warning'), warnings.length));
      if (dups.has(entry.name)) badges.push(h('span.badge.danger', 'duplicate name'));
      const expanded = ui.expanded.has(entry.sample.id);
      const row = h(`div.spectral-control${store.ui.sampleId === entry.sample.id ? '.selected' : ''}${entry.excluded ? '.excluded' : ''}`, {
        onclick: () => {
          if (expanded) ui.expanded.delete(entry.sample.id);
          else ui.expanded.add(entry.sample.id);
          ui.hover = entry.name;
          if (!entry.sample.library) app.selectSample(entry.sample.id);
          renderControls();
          redrawBoxes();
        },
        onmouseenter: () => { ui.hover = entry.name; redrawBoxes(); },
        onmouseleave: () => { ui.hover = null; redrawBoxes(); },
      },
      h('span.swatch', { style: { background: color } }),
      h('div.name', h('b', entry.name), entry.marker ? h('span.muted', ` ${entry.marker}`) : null, h('div.file', entry.sample.name)),
      h('div.badges', badges),
      h('button.icon-button.small', { type: 'button', title: 'Control options', onclick: (event) => { event.stopPropagation(); controlMenu(event.currentTarget, entry); } }, icon('more')));
      list.append(row);
      if (expanded && ref && !entry.sample.library) {
        const facts = h('dl.kv',
          h('dt', 'Separation at peak'), h('dd', ref.separation ? `${ref.separation.toFixed(1)} × rSD` : '—'),
          h('dt', 'Stain index'), h('dd', ref.stainIndex ? ref.stainIndex.toFixed(1) : '—'),
          h('dt', 'Dim vs bright similarity'), h('dd', ref.heterogeneity ? ref.heterogeneity.toFixed(4) : '—'),
          h('dt', 'Negative'), h('dd', ref.negativeSource === 'unstained' ? 'unstained control' : 'internal', ref.matchedNegatives ? ' (AF-matched)' : ''));
        list.append(h('div.spectral-control-detail', facts,
          ref.error ? h('div.callout.danger', icon('warning'), h('span', ref.error)) : null,
          ...warnings.map((w) => h('div.callout.warn', icon('warning'), h('span', w))),
          !warnings.length && !ref.error ? h('div.callout.ok', icon('check'), h('span', 'No quality problems found.')) : null));
      }
    }
    controlsHost.append(list);
    const unstained = unstainedList();
    if (!unstained.length) controlsHost.append(h('div.callout', { style: { marginTop: '8px' } }, icon('info'), h('span', 'No unstained control is marked. It is needed for autofluorescence signatures and as a universal negative for controls without negative events.')));
    if (refs.some((r) => !r.ref)) controlsHost.append(h('button.btn.small.primary', { type: 'button', style: { marginTop: '8px' }, disabled: Boolean(ui.busy), onclick: () => gateControls(refs.filter((r) => !r.ref).map((r) => r.sample.id)) }, icon('sparkles'), `Gate ${refs.filter((r) => !r.ref).length} control(s)`));
  }

  function renderAF() {
    clear(afHost);
    const list = unstainedList();
    const sample = unstainedSample();
    if (!sample) {
      afHost.append(h('p.muted', { style: { margin: 0 } }, 'Mark an unstained control (same cells, no dyes) to extract autofluorescence signatures. Cells often carry several distinct ones (lymphoid, myeloid, dead cells); modeling them removes background from violet and UV dyes.'));
      return;
    }
    if (list.length > 1) {
      afHost.append(h('label.field', h('span', 'Unstained control'), h('select.input.small', {
        onchange: (event) => saveSetup({ params: { ...(setup()?.params ?? baseSetup().params), unstainedId: event.target.value }, autofluorescence: null }, 'Choose the unstained control'),
      }, list.map((s) => h('option', { value: s.id, selected: s.id === sample.id }, s.name)))));
    }
    const af = setup()?.autofluorescence;
    if (af && af.sampleId === sample.id) {
      const rows = af.signatures.map((s, k) => h('div.spectral-af-row',
        h('span.swatch.dashed', { style: { color: AF_COLORS[k % AF_COLORS.length] } }),
        h('b', s.name),
        h('span.muted', `${(100 * s.fraction).toFixed(0)}% of events`),
        h('span.grow'),
        h('span.muted', { title: 'Median spectral norm of its events' }, formatCount(s.brightness))));
      afHost.append(h('div', rows),
        h('p.muted.small-print', `From ${af.population === 'All events' ? 'all events' : af.population} of ${af.sampleName} (${formatCount(af.eventsUsed)} events clustered). Signal left unexplained beyond detector noise, by number of signatures: ${(af.misfitByK ?? af.residualByK).map((v, k) => `${k + 1}: ${(100 * v).toFixed(1)}%`).join(', ')}${af.misfitByK && af.misfitByK.length > af.k ? ' (the last did not help enough)' : ''}.`));
    } else {
      afHost.append(h('p.muted', { style: { margin: '0 0 8px' } }, `Cluster the event spectra of ${sample.name} into one or more autofluorescence signatures. Select a population (e.g. live single cells) in the Gate view first to restrict it.`));
    }
    afHost.append(h('div.btn-row', h(`button.btn.small${af ? '' : '.primary'}`, { type: 'button', disabled: Boolean(ui.busy) || !panelDetectors().length, onclick: () => extractAF() }, icon('sparkles'), af ? 'Extract again' : 'Extract signatures')));
  }

  function renderUnmix() {
    clear(unmixHost);
    const s = settings();
    const af = afSignatures();
    const methodSelect = h('select.input.small', { onchange: (event) => saveSetup({ settings: { ...(setup()?.settings ?? {}), method: event.target.value } }, `Unmixing method: ${event.target.value}`) },
      METHODS.map((m) => h('option', { value: m.id, selected: m.id === s.method }, m.long)));
    const afSeg = h('div.segmented', AF_MODES.map((m) => h(`button${m.id === s.afMode ? '.active' : ''}`, {
      type: 'button',
      disabled: m.id !== 'none' && !af.length || (m.id === 'perEvent' && af.length < 2),
      title: m.text,
      onclick: () => saveSetup({ settings: { ...(setup()?.settings ?? {}), afMode: m.id } }, `Autofluorescence: ${m.label}`),
    }, m.label)));
    const groups = ws().groups;
    const sampleCount = ws().samples.filter((x) => x.role === 'sample').length;
    const targetSelect = h('select.input.small', { onchange: (event) => { ui.target = event.target.value; renderUnmix(); } },
      h('option', { value: 'current', selected: ui.target === 'current' }, 'The current sample'),
      h('option', { value: 'all', selected: ui.target === 'all' }, `All samples (${sampleCount}, controls excluded)`),
      h('option', { value: 'everything', selected: ui.target === 'everything' }, `Every file, controls included (${ws().samples.length})`),
      groups.map((g) => h('option', { value: g.id, selected: ui.target === g.id }, `Group: ${g.name} (${g.sampleIds.length})`)));
    const targets = targetSamples();
    const problems = unmixProblems();
    unmixHost.append(
      h('label.field', h('span', 'Method'), methodSelect),
      h('p.muted.small-print', METHODS.find((m) => m.id === s.method)?.text),
      h('div.field', h('span', 'Autofluorescence'), afSeg),
      h('p.muted.small-print', AF_MODES.find((m) => m.id === s.afMode)?.text, s.method === 'wls' && s.afMode === 'perEvent' && af.length > 1 ? ' With per-event autofluorescence, weighted unmixing uses fixed weights.' : ''),
      h('label.field', h('span', 'Samples'), targetSelect),
      ...problems.map((p) => h('div.callout.warn', { style: { marginBottom: '8px' } }, icon('warning'), h('span', p))),
      h('button.btn.primary.block', { type: 'button', disabled: Boolean(ui.busy) || problems.length > 0 || !targets.length, onclick: () => unmixSamples() }, icon('play'), targets.length ? `Unmix ${targets.length} sample${targets.length > 1 ? 's' : ''}` : 'No samples selected'));
    const last = [...ws().derived].reverse().find((d) => d.kind === 'unmixing');
    if (last) {
      const count = Object.keys(last.files ?? {}).length;
      unmixHost.append(h('div.callout.ok', { style: { marginTop: '10px' } }, icon('check'), h('div',
        h('div', h('b', last.name)),
        h('div', `${count} sample${count === 1 ? '' : 's'} · ${last.outputs.length} channels · ${new Date(last.created).toLocaleString()}`),
        h('div', { style: { marginTop: '4px' } }, h('button.btn.small', { type: 'button', onclick: () => app.setMode('gate') }, icon('gate'), 'Gate the unmixed channels')))));
    }
  }

  function renderLeft() {
    renderHead();
    renderSteps();
    renderControls();
    renderAF();
    renderUnmix();
  }

  // --- Rendering: tabs -----------------------------------------------------------------------------

  function renderTabBar() {
    clear(tabBar);
    for (const tab of TABS) {
      tabBar.append(h(`button${ui.tab === tab.id ? '.active' : ''}`, { type: 'button', role: 'tab', onclick: () => { ui.tab = tab.id; renderTabBar(); renderTab(); } }, icon(tab.icon), tab.label));
    }
  }

  function renderTab() {
    disposeBoxes(tabHost);
    clear(tabHost);
    const renderers = { spectra: renderSpectraTab, quality: renderQualityTab, design: renderDesignTab, compare: renderCompareTab, residuals: renderResidualTab, doctor: renderDoctorTab, ribbon: renderRibbonTab, library: renderLibraryTab };
    try {
      renderers[ui.tab]();
    } catch (error) {
      tabHost.append(h('div.callout.danger', icon('warning'), h('span', error.message)));
    }
  }

  function emptyState(iconName, title, text, ...actions) {
    return h('div.empty', icon(iconName), h('h3', title), h('p', text), actions.length ? h('div.btn-row', { style: { justifyContent: 'center' } }, actions) : null);
  }

  function needReferences() {
    if (activeRefs().length) return null;
    if (!controls().length) {
      return emptyState('flask', 'Start with your reference controls', 'Load a single-stain control for every fluorochrome, an unstained control and your samples (raw spectral files, with detectors such as UV1-A … R8-A). Then mark the controls, gate them automatically, check the panel and unmix.',
        h('button.btn.primary', { type: 'button', onclick: () => assignControls() }, icon('tag'), 'Assign controls…'));
    }
    return emptyState('sparkles', 'Compute the reference spectra', `${controls().length} control${controls().length > 1 ? 's are' : ' is'} marked. Gating finds each control's positive events (the brightest on its peak detector) and negative events without scatter gates, then takes median(positive) − median(negative) per detector.`,
      h('button.btn.primary', { type: 'button', disabled: Boolean(ui.busy), onclick: () => gateControls() }, icon('sparkles'), 'Gate all controls'));
  }

  function renderSpectraTab() {
    const empty = needReferences();
    const detectors = setup()?.params?.detectors ?? panelDetectors();
    if (empty) {
      tabHost.append(empty);
      return;
    }
    const refs = activeRefs();
    const af = afSignatures();
    const series = [
      ...refs.map((r, i) => ({ name: r.name, values: r.ref.spectrum, color: categoricalColor(i), sampleId: r.sample.id })),
      ...(ui.showAF ? af.map((s, k) => ({ name: s.name, values: s.spectrum, color: AF_COLORS[k % AF_COLORS.length], dashed: true })) : []),
    ];
    const box = spectraBox(detectors, series);
    const legend = h('div.spectral-legend', series.map((s) => h(`button.chip${ui.hidden.has(s.name) ? '.off' : ''}${ui.hover === s.name ? '.active' : ''}`, {
      type: 'button',
      'aria-pressed': String(!ui.hidden.has(s.name)),
      title: ui.hidden.has(s.name) ? 'Show' : 'Hide',
      onclick: () => { if (ui.hidden.has(s.name)) ui.hidden.delete(s.name); else ui.hidden.add(s.name); renderTab(); },
      onmouseenter: () => { ui.hover = s.name; box.redraw(); },
      onmouseleave: () => { ui.hover = null; box.redraw(); },
    }, h(`span.swatch${s.dashed ? '.dashed' : ''}`, { style: s.dashed ? { color: s.color } : { background: s.color } }), s.name)));
    tabHost.append(h('div.pane',
      h('h3', 'Reference spectra', h('span.muted', { style: { fontWeight: 500 } }, `${refs.length} dyes · ${detectors.length} detectors`), h('span.spacer'),
        af.length ? h('label.check', h('input', { type: 'checkbox', checked: ui.showAF, onchange: (event) => { ui.showAF = event.target.checked; renderTab(); } }), 'Autofluorescence') : null,
        h('div.segmented', h(`button${ui.logY ? '' : '.active'}`, { type: 'button', onclick: () => { ui.logY = false; renderTab(); } }, 'Linear'), h(`button${ui.logY ? '.active' : ''}`, { type: 'button', onclick: () => { ui.logY = true; renderTab(); } }, 'Log'))),
      box, legend,
      h('p.muted.small-print', 'Each line is a control\'s median positive minus median negative signal per detector, scaled so its brightest detector is 1. Dashed lines are autofluorescence signatures. Hover a line or a control to highlight it; click a chip to hide it. The log scale shows the low tails, where most spreading comes from.')));
    tabHost.append(h('div.pane', h('h3', 'Control quality'), qualityTable(refs)));
  }

  function qualityTable(refs) {
    const body = h('tbody');
    refs.forEach((r, i) => {
      const ref = r.ref;
      body.append(h('tr', { onmouseenter: () => { ui.hover = r.name; redrawBoxes(); }, onmouseleave: () => { ui.hover = null; redrawBoxes(); } },
        h('td', h('span.swatch', { style: { background: categoricalColor(i), marginRight: '6px' } }), r.name, r.marker ? h('span.muted', ` ${r.marker}`) : null),
        h('td', ref.peakDetector),
        h('td.r', ref.positiveEvents != null ? formatCount(ref.positiveEvents) : 'library'),
        h('td.r', ref.negativeEvents != null ? formatCount(ref.negativeEvents) : '—'),
        h('td.r', h(`span.badge.${ref.separation >= 10 ? 'ok' : ref.separation >= 5 ? 'warn' : 'danger'}`, ref.separation ? `${ref.separation.toFixed(0)}×` : '—')),
        h('td.r', ref.heterogeneity ? h(`span.badge.${ref.heterogeneity >= 0.98 ? 'ok' : 'warn'}`, ref.heterogeneity.toFixed(3)) : '—'),
        h('td', { style: { maxWidth: '320px', whiteSpace: 'normal' } }, ref.warnings?.length ? ref.warnings.map((w) => h('div.muted', { style: { fontSize: '11.5px' } }, '⚠ ', w)) : h('span.muted', '—'))));
    });
    return h('div', { style: { overflow: 'auto' } }, h('table.data',
      h('thead', h('tr', h('th', 'Fluorochrome'), h('th', 'Peak'), h('th.r', 'Positive'), h('th.r', 'Negative'), h('th.r', { title: 'Peak signal over the negative\'s robust SD; aim for 10× or more' }, 'Separation'), h('th.r', { title: 'Cosine similarity of the dimmest and brightest thirds of the positives; below 0.98 suggests a mixture' }, 'Dim/bright'), h('th', 'Warnings'))),
      body));
  }

  function renderQualityTab() {
    const empty = needReferences();
    if (empty) {
      tabHost.append(empty);
      return;
    }
    const refs = activeRefs();
    const spectra = panelSpectra();
    const sim = similarityMatrix(spectra);
    const ci = panelComplexity();
    const reading = complexityInterpretation(ci, spectra.length);
    const flagged = similarPairs(sim, 0.9);
    const top = sim.pairs[0];
    tabHost.append(h('div.pane',
      h('h3', 'Panel complexity'),
      h('div.stat-grid',
        h('div.stat-tile', h('div.k', 'Complexity index'), h('div.v', Number.isFinite(ci) ? ci.toFixed(1) : '∞', ' ', h(`span.badge.${reading.level}`, reading.label))),
        h('div.stat-tile', h('div.k', 'Signatures'), h('div.v', String(spectra.length))),
        h('div.stat-tile', h('div.k', 'Most similar pair'), h('div.v', top ? `${top.similarity.toFixed(2)}` : '—', top ? h('span.muted', { style: { fontSize: '11px', fontWeight: 500 } }, ` ${top.a} / ${top.b}`) : null))),
      h(`div.callout.${reading.level === 'ok' ? 'ok' : reading.level}`, { style: { marginTop: '10px' } }, icon(reading.level === 'ok' ? 'check' : 'warning'), h('span', reading.text)),
      h('p.muted.small-print', 'The complexity index is the condition number of the reference matrix (Cytek\'s definition): how much unmixing can amplify measurement noise. It grows as spectra overlap. Autofluorescence signatures added to the model raise it further.')));
    const simBox = matrixBox({
      names: sim.names,
      matrix: sim.matrix,
      format: (v) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2).replace(/^(-?)0\./, '$1.'),
      color: (v, i, j) => (i === j ? null : simColor(v)),
      flag: (v, i, j) => (i !== j && v >= 0.9 ? (v >= 0.98 ? css('--danger') : css('--warn')) : null),
      tip: (v, i, j) => `${sim.names[i]} vs ${sim.names[j]}: similarity ${v.toFixed(3)}`,
    });
    tabHost.append(h('div.pane',
      h('h3', 'Similarity matrix', h('span.muted', { style: { fontWeight: 500 } }, 'cosine of each pair of spectra')),
      simBox,
      flagged.length ? h('div.spectral-pairs', h('span.muted', 'Similar pairs (≥ 0.90): '), flagged.slice(0, 16).map((p) => h(`span.badge.${similarityLevel(p.similarity)}`, `${p.a} / ${p.b} ${p.similarity.toFixed(2)}`))) : h('div.callout.ok', icon('check'), h('span', 'No pair of spectra is more than 0.90 similar.')),
      h('p.muted.small-print', 'Pairs above about 0.90 resolve less cleanly, and above 0.98 they are hard to separate at all; put markers that are co-expressed on dissimilar dyes.')));
    const spreading = setup()?.spreading;
    const fresh = spreading && spreading.key === referencesKey();
    const ssmPane = h('div.pane', h('h3', 'Spreading matrix', h('span.muted', { style: { fontWeight: 500 } }, 'of the unmixed controls'), h('span.spacer'),
      h('button.btn.small', { type: 'button', disabled: Boolean(ui.busy) || refs.length < 2, onclick: () => computeSpreading() }, icon('play'), fresh ? 'Recompute' : 'Compute')));
    if (ui.busy === 'spreading') ssmPane.append(h('p.muted', 'Unmixing the controls…'));
    else if (!spreading) ssmPane.append(h('p.muted', { style: { margin: 0 } }, 'Unmixes every control with the reference set and measures how much each bright dye spreads into every other unmixed channel (Nguyen et al. 2013). Rows are the stained dye; columns the channel receiving spread.'));
    else {
      const n = spreading.names.length;
      const values = spreading.matrix.map((v) => (v === null ? Number.NaN : v));
      let max = 0;
      for (const v of values) if (Number.isFinite(v)) max = Math.max(max, v);
      if (!fresh) ssmPane.append(h('div.callout.warn', { style: { marginBottom: '8px' } }, icon('warning'), h('span', 'The reference spectra changed since this matrix was computed; recompute it.')));
      ssmPane.append(matrixBox({
        names: spreading.names,
        matrix: values,
        format: (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1)),
        color: (v, i, j) => (i === j || !Number.isFinite(v) ? null : seqColor('magma', max ? Math.sqrt(v / max) : 0, true)),
        tip: (v, i, j) => `${spreading.names[i]} spreads into ${spreading.names[j]}: ${Number.isFinite(v) ? v.toFixed(2) : '—'}`,
      }));
      const worst = [];
      for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) if (i !== j && Number.isFinite(values[i * n + j])) worst.push([values[i * n + j], spreading.names[i], spreading.names[j]]);
      worst.sort((a, b) => b[0] - a[0]);
      ssmPane.append(h('div.spectral-pairs', h('span.muted', 'Largest spreading: '), worst.slice(0, 8).map(([v, a, b]) => h('span.badge', `${a} → ${b} ${v.toFixed(1)}`))),
        h('p.muted.small-print', `SS = √(σ²pos − σ²neg) / √ΔF with σ the robust SD, in √(peak-detector units). A dim marker on a channel that receives much spread from a bright, co-expressed dye will be hard to resolve. Computed ${new Date(spreading.computed).toLocaleString()}.`));
    }
    tabHost.append(ssmPane);
  }

  // --- Panel design: predicted spread (lib/spread.js) -----------------------------------------
  //
  // The panel's spreading predicted from its spectra and the instrument's noise (photon noise per
  // detector, intensity fluctuations per laser), fitted to this experiment's controls, kept for
  // the instrument in the library, or taken from its bead runs. Dyes can be left out and library
  // spectra added, to see what a changed panel would do before it is run. Without samples, a
  // panel is designed from an instrument's spectral library alone (renderLibraryDesign).

  function designState() {
    ui.design ??= { drop: new Set(), add: [], source: null };
    return ui.design;
  }

  // Bead runs of the instrument (QC → Instrument), read once.
  function loadInstrumentRuns(id, onLoad) {
    if (!id || !app.library?.getRecord || ui.runsFor === id) return;
    ui.runsFor = id;
    ui.instrumentRuns = null;
    app.library.getRecord(INSTRUMENT_RECORDS, id).then((record) => {
      if (ui.runsFor !== id) return;
      ui.instrumentRuns = record?.runs ?? [];
      onLoad();
    }).catch(() => { ui.instrumentRuns = []; });
  }

  // Library entries as design dyes, on the given detectors.
  function libraryDyes(entries, detectors) {
    return entries.map((e) => ({ name: e.fluorochrome, spectrum: Array.from(spectrumOn(e, detectors) ?? []), brightness: e.quality?.brightness ?? null, source: 'library', entry: e.id }))
      .filter((d) => d.spectrum.length === detectors.length);
  }

  // The noise sources available for a model: [{ id, label, noise, note }]. ctx.fitted: the noise
  // fitted to this experiment's controls ({ record, check, computed }), ctx.library: the
  // instrument's spectral library record (its kept noise), ctx.runs: its bead runs.
  function noiseSources(model, ctx) {
    const out = [];
    const fromControls = noiseOn(model, ctx.fitted?.record);
    if (fromControls) {
      const c = ctx.fitted.check;
      out.push({
        id: 'controls',
        label: 'This experiment\'s controls',
        noise: fromControls,
        note: `Fitted to the spread of ${ctx.fitted.record.controls ?? '?'} controls (${new Date(ctx.fitted.computed).toLocaleDateString()}).${c && c.measurable ? ` Check: each control's spread predicted from the others is within a factor ${c.medianRatio.toFixed(2)} of the observed (median), and within 2× for ${Math.round(100 * c.within2x)}% of ${c.measurable} clearly measured pairs.` : ''}`,
      });
    }
    const kept = ctx.library?.noise;
    const saved = noiseOn(model, kept);
    if (saved) out.push({ id: 'library', label: `Kept for ${ctx.instrumentName ?? 'the instrument'}`, noise: saved, note: `Fitted ${new Date(kept.fitted).toLocaleDateString()}${kept.workspace ? ` in ${kept.workspace}` : ''} and kept in the library for this instrument.` });
    const beads = c1FromRuns(model, ctx.runs ?? []);
    if (beads) {
      const lasers = (fromControls ?? saved)?.laserCV ?? new Float64Array(model.lasers.length);
      const found = beads.found.reduce((a, b) => a + b, 0);
      out.push({ id: 'beads', label: 'Bead runs', noise: { c1: beads.c1, laserCV: lasers, source: 'beads' }, note: `Photon noise (1/Q) of ${found} of ${model.D} detectors from the instrument's bead runs (median of ${(ctx.runs ?? []).length}); the others take the median. ${fromControls || saved ? 'Laser fluctuations from the controls.' : 'Without controls, laser fluctuations are left out, so dyes excited by several lasers are predicted to spread less than they will.'} Q depends on detector gains: use runs at this experiment's settings.` });
    }
    return out;
  }

  async function keepNoise(record) {
    const inst = instrument();
    try {
      let doc = (await app.library.getRecord(SPECTRA_RECORDS, inst.id)) ?? { name: inst.name, instrument: inst, entries: [] };
      doc = { ...doc, noise: { ...record, workspace: ws().name, kept: new Date().toISOString() }, modified: new Date().toISOString() };
      await app.library.putRecord(SPECTRA_RECORDS, inst.id, doc);
      ui.library = doc;
      toast(`Kept the noise model for ${inst.name}: panels designed later on this instrument can use it without controls.`, { kind: 'ok' });
      renderTab();
    } catch (error) {
      toast(`The noise model could not be kept: ${error.message}`, { kind: 'error' });
    }
  }

  function renderDesignTab() {
    const empty = needReferences();
    if (empty) {
      tabHost.append(empty);
      return;
    }
    loadLibrary();
    const inst = instrument();
    loadInstrumentRuns(inst?.id, () => { if (ui.tab === 'design') renderTab(); });
    const detectors = setup()?.params?.detectors ?? panelDetectors();
    const spreading = setup()?.spreading;
    const observed = new Map((spreading?.observations ?? []).map((o) => [spreading.names[o.i], o.deltaF]));
    const current = activeRefs().map((r) => ({
      name: r.name,
      spectrum: Array.from(r.ref.spectrum),
      brightness: observed.get(r.name) ?? r.ref.brightness ?? null,
      source: r.sample.library ? 'library' : 'control',
    }));
    renderDesign(tabHost, {
      detectors,
      current,
      state: designState(),
      library: ui.library,
      runs: ui.instrumentRuns ?? [],
      fitted: spreading?.noise ? { record: spreading.noise, check: spreading.check, computed: spreading.computed } : null,
      instrumentName: inst?.name,
      keep: app.library?.putRecord && inst && spreading?.noise ? () => keepNoise(spreading.noise) : null,
      observedAt: (a, b) => {
        if (!spreading) return null;
        const i = spreading.names.indexOf(a);
        const j = spreading.names.indexOf(b);
        const v = i >= 0 && j >= 0 ? spreading.matrix[i * spreading.names.length + j] : null;
        return Number.isFinite(v) ? v : null;
      },
      reference: { label: 'Back to this experiment\'s panel', complexity: panelComplexity() },
      noNoise: 'No noise model yet. Compute the spreading matrix in Panel quality (it unmixes the controls and fits the photon noise of every detector and the intensity fluctuations of every laser to their spread), or characterize the instrument with multi-level beads in QC → Instrument.',
      rerender: () => renderTab(),
    });
  }

  // Without samples: design a panel from an instrument's spectral library, with the noise kept for
  // it (or its bead runs). Every library dye starts left out; click to add.
  async function renderLibraryDesign(host) {
    const lib = ui.libraryDesign;
    if (!lib.records) {
      host.append(h('p.muted', 'Reading the spectral library…'));
      try {
        lib.records = (await app.library.listRecords(SPECTRA_RECORDS)) ?? [];
      } catch {
        lib.records = [];
      }
      renderBody();
      return;
    }
    if (!lib.records.length) {
      host.append(emptyState('library', 'The spectral library is empty', 'Spectra are added to the library from an experiment\'s reference controls (Spectral → Library). Open one, or the 25-color example, first.'));
      return;
    }
    lib.id ??= lib.records[0].id;
    if (lib.recordFor !== lib.id) {
      lib.recordFor = lib.id;
      lib.record = undefined;
      app.library.getRecord(SPECTRA_RECORDS, lib.id).then((record) => {
        lib.record = record;
        lib.state = { drop: new Set((record?.entries ?? []).map((e) => e.fluorochrome)), add: [], source: null };
        renderBody();
      });
    }
    loadInstrumentRuns(lib.id, () => renderBody());
    host.append(h('div.pane',
      h('h3', 'Design a panel', h('span.muted', { style: { fontWeight: 500 } }, 'from the spectral library'), h('span.spacer'),
        h('button.btn.small.ghost', { type: 'button', onclick: () => { ui.libraryDesign = null; renderBody(); } }, icon('close'), 'Close')),
      h('label.check', 'Instrument ',
        h('select', { 'aria-label': 'Instrument', onchange: (e) => { lib.id = e.target.value; renderBody(); } },
          lib.records.map((r) => h('option', { value: r.id, selected: r.id === lib.id }, r.name || r.id)))),
      h('p.muted.small-print', 'Pick the dyes of a planned panel: the spreading is predicted from their library spectra and the noise kept for the instrument (Panel design → Keep, in an experiment with controls) or its bead runs, before any control is run.')));
    if (lib.record === undefined) return;
    const entries = [...latestEntries(lib.record, null).values()];
    const detectors = commonDetectorsOf(entries);
    renderDesign(host, {
      detectors,
      current: libraryDyes(entries, detectors),
      state: lib.state,
      library: lib.record,
      runs: ui.instrumentRuns ?? [],
      fitted: null,
      instrumentName: lib.record?.name,
      keep: null,
      observedAt: () => null,
      reference: null,
      noNoise: 'No noise is kept for this instrument yet. In an experiment with reference controls, compute the spreading matrix (Panel quality) and keep its noise model (Panel design), or characterize the instrument with multi-level beads (QC → Instrument).',
      rerender: () => renderBody(),
    });
  }

  // The detectors most library entries share (all of them on one instrument, normally).
  function commonDetectorsOf(entries) {
    const counts = new Map();
    for (const e of entries) {
      const key = e.detectors.join('\u0000');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0].split('\u0000') : [];
  }

  // The design view: noise source, panel editor, predicted matrix and spread per channel.
  // ctx: { detectors, current (dyes), state, library, runs, fitted, instrumentName, keep,
  // observedAt, reference: { label, complexity } | null, noNoise, rerender }.
  function renderDesign(host, ctx) {
    const { state, detectors, current } = ctx;
    const added = libraryDyes(state.add.map((id) => (ctx.library?.entries ?? []).find((e) => e.id === id)).filter(Boolean), detectors).map((d) => ({ ...d, added: d.entry }));
    const design = [...current.filter((d) => !state.drop.has(d.name)), ...added];
    let model = null;
    let modelError = null;
    try {
      if (design.length >= 2) model = spreadModel({ names: design.map((d) => d.name), detectors, spectra: design.map((d) => d.spectrum) });
    } catch (error) {
      modelError = error.message;
    }
    const sources = model ? noiseSources(model, ctx) : [];
    const chosen = sources.find((x) => x.id === state.source) ?? sources[0] ?? null;

    // Noise of the instrument.
    if (model) {
      const noisePane = h('div.pane', h('h3', 'Noise of the instrument'));
      if (!sources.length) noisePane.append(h('div.callout.warn', icon('info'), h('span', ctx.noNoise)));
      else {
        noisePane.append(h('div.segmented', { role: 'group', 'aria-label': 'Noise source' }, sources.map((x) => h(`button${x === chosen ? '.active' : ''}`, { type: 'button', 'aria-pressed': String(x === chosen), onclick: () => { state.source = x.id; ctx.rerender(); } }, x.label))),
          h('p.muted', { style: { margin: '8px 0 0' } }, chosen.note));
        if (chosen.id === 'controls' && ctx.keep) noisePane.append(h('div', { style: { marginTop: '8px' } }, h('button.btn.small', { type: 'button', onclick: ctx.keep }, icon('library'), `Keep for ${ctx.instrumentName}`)));
      }
      host.append(noisePane);
    }

    // The panel being designed.
    const libraryChoices = [...latestEntries(ctx.library, detectors).values()].filter((e) => !design.some((d) => d.name.toLowerCase() === e.fluorochrome.toLowerCase()) && !current.some((d) => d.name.toLowerCase() === e.fluorochrome.toLowerCase()));
    const edited = ctx.reference && (state.drop.size || state.add.length);
    host.append(h('div.pane',
      h('h3', 'Panel', h('span.muted', { style: { fontWeight: 500 } }, `${design.length} dyes`), h('span.spacer'),
        edited ? h('button.btn.small.ghost', { type: 'button', onclick: () => { state.drop.clear(); state.add = []; ctx.rerender(); } }, icon('undo'), ctx.reference.label) : null),
      h('div.spectral-legend', { role: 'group', 'aria-label': 'Dyes in the designed panel' },
        current.map((d) => {
          const off = state.drop.has(d.name);
          return h(`button.chip${off ? '.off' : ''}`, {
            type: 'button',
            'aria-pressed': String(!off),
            title: `${off ? 'Left out: click to include' : 'Click to leave out'}. Brightness ${d.brightness ? formatCount(Math.round(d.brightness)) : 'unknown'}${d.source === 'library' ? ' (library spectrum)' : ''}.`,
            onclick: () => { if (off) state.drop.delete(d.name); else state.drop.add(d.name); ctx.rerender(); },
          }, d.name);
        }),
        added.map((d) => h('button.chip.active', { type: 'button', title: 'From the library: click to remove', onclick: () => { state.add = state.add.filter((id) => id !== d.added); ctx.rerender(); } }, icon('plus'), d.name))),
      libraryChoices.length
        ? h('label.check', { style: { marginTop: '8px' } }, 'Add from the library ',
          h('select', { 'aria-label': 'Add a fluorochrome from the spectral library', onchange: (e) => { if (e.target.value) { state.add.push(e.target.value); ctx.rerender(); } } },
            h('option', { value: '' }, 'Choose a fluorochrome…'),
            libraryChoices.map((e) => h('option', { value: e.id }, `${e.fluorochrome}${e.date ? ` (${e.date.slice(0, 10)})` : ''}`))))
        : ctx.reference ? h('p.muted.small-print', ctx.library?.entries?.length ? 'Every library spectrum of this instrument is in the panel.' : 'Spectra saved to the library (Library tab) can be added here to try them in the panel.') : null));
    if (modelError) {
      host.append(h('div.callout.danger', icon('warning'), h('span', modelError)));
      return;
    }
    if (!model) {
      host.append(h('div.pane', h('div.empty', icon('layers'), h('h3', 'Two or more dyes are needed'), h('p', 'Include dyes, or add spectra from the library, to predict their spread.'))));
      return;
    }
    if (!chosen) return;

    // Brightness: each dye's control (or library entry), else the median of the others.
    const known = design.map((d) => d.brightness).filter((v) => v > 0).sort((a, b) => a - b);
    const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
    const brightness = design.map((d) => (d.brightness > 0 ? d.brightness : fallback));
    const predicted = predictedSpreading(model, chosen.noise, brightness);
    const ci = complexityIndex(design.map((d) => ({ name: d.name, spectrum: d.spectrum })));
    const n = predicted.n;
    const pairs = [];
    for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) if (i !== j) pairs.push([predicted.matrix[i * n + j], design[i].name, design[j].name]);
    pairs.sort((a, b) => b[0] - a[0]);
    let max = 0;
    for (const v of predicted.matrix) if (Number.isFinite(v)) max = Math.max(max, v);
    const missingBrightness = design.filter((d) => !(d.brightness > 0)).map((d) => d.name);
    const now = ctx.reference?.complexity;
    host.append(h('div.pane',
      h('h3', 'Predicted spreading matrix', h('span.muted', { style: { fontWeight: 500 } }, 'at each dye\'s brightness')),
      h('div.stat-grid',
        h('div.stat-tile', h('div.k', 'Complexity index'), h('div.v', Number.isFinite(ci) ? ci.toFixed(1) : '∞', edited && Number.isFinite(now) ? h('span.muted', { style: { fontSize: '11px', fontWeight: 500 } }, ` now ${now.toFixed(1)}`) : null)),
        h('div.stat-tile', h('div.k', 'Largest spread'), h('div.v', pairs[0] ? pairs[0][0].toFixed(1) : '—', pairs[0] ? h('span.muted', { style: { fontSize: '11px', fontWeight: 500 } }, ` ${pairs[0][1]} → ${pairs[0][2]}`) : null)),
        h('div.stat-tile', h('div.k', 'Noise'), h('div.v', { style: { fontSize: '13px' } }, chosen.label))),
      matrixBox({
        names: model.names,
        matrix: predicted.matrix,
        format: (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(1)),
        color: (v, i, j) => (i === j || !Number.isFinite(v) ? null : seqColor('magma', max ? Math.sqrt(v / max) : 0, true)),
        tip: (v, i, j) => {
          const seen = ctx.observedAt(model.names[i], model.names[j]);
          return `${model.names[i]} spreads into ${model.names[j]}: ${Number.isFinite(v) ? v.toFixed(2) : '—'} predicted${seen !== null ? `, ${seen.toFixed(2)} observed` : ''}`;
        },
      }),
      h('div.spectral-pairs', h('span.muted', 'Largest predicted spreading: '), pairs.slice(0, 8).map(([v, a, b]) => h('span.badge', `${a} → ${b} ${v.toFixed(1)}`))),
      missingBrightness.length ? h('div.callout.warn', { style: { marginTop: '8px' } }, icon('info'), h('span', `No brightness is known for ${missingBrightness.join(', ')}; the median of the other dyes is used.`)) : null,
      h('p.muted.small-print', 'SS = √(Δσ²/ΔF) as in Panel quality, predicted rather than measured: photon noise in every detector the dye reaches, carried into each channel by the unmixing, plus the intensity fluctuations of the lasers for dyes excited by more than one (this part grows with brightness, so the matrix is stated at each dye\'s control brightness). Spread from heterogeneous dyes (degraded tandems) and from autofluorescence differences between positive and negative cells is not predicted.')));

    // Spread received by each channel.
    const received = spreadReceived(predicted);
    const order = received.map((v, j) => j).sort((a, b) => received[a] - received[b]);
    const top = Math.max(...received, 1e-12);
    host.append(h('div.pane',
      h('h3', 'Spread received by each channel', h('span.muted', { style: { fontWeight: 500 } }, 'if every other dye is on the same cell')),
      h('div', { style: { overflow: 'auto', maxHeight: '420px' } }, h('table.data.spectral-bars',
        h('thead', h('tr', h('th', 'Channel'), h('th', 'Spread received'), h('th', 'From (largest)'))),
        h('tbody', order.map((j) => {
          let from = -1;
          let most = 0;
          for (let i = 0; i < n; i += 1) {
            const v = i === j ? 0 : predicted.matrix[i * n + j] ** 2 * brightness[i];
            if (v > most) { most = v; from = i; }
          }
          return h('tr',
            h('td', model.names[j]),
            h('td', h('div.spectral-bar', h('span', { style: { width: `${Math.max(2, (100 * received[j]) / top)}%`, background: css('--accent') } })), h('div.spectral-bar-label', formatCount(Math.round(received[j])))),
            h('td.muted', from >= 0 ? model.names[from] : '—'));
        })))),
      h('p.muted.small-print', 'The SD added to each channel\'s negative population when every other dye is on the cell at its brightness: √(Σ SS² · ΔF). Channels at the top receive the least spread and suit dim or critical markers; markers co-expressed with the dye in "From" are hardest to resolve in that channel.')));
  }

  function renderCompareTab() {
    const empty = needReferences();
    if (empty) {
      tabHost.append(empty);
      return;
    }
    const afCount = afSignatures().length;
    if (afCount === 1 && ui.compareModels.has('ols+af')) {
      ui.compareModels.delete('ols+af');
      ui.compareModels.add('ols+af1');
    }
    const sample = ws().samples.find((s) => s.id === store.ui.sampleId);
    const choices = h('div.spectral-choices', MODEL_CHOICES.map((c) => {
      const unavailable = (c.needsAF ?? 0) > afCount;
      return h(`label.check${unavailable ? '.disabled' : ''}`, { title: unavailable ? (c.needsAF > 1 ? 'Needs two or more autofluorescence signatures' : 'Needs an autofluorescence signature') : '' },
        h('input', { type: 'checkbox', disabled: unavailable, checked: ui.compareModels.has(c.id) && !unavailable, onchange: (event) => { if (event.target.checked) ui.compareModels.add(c.id); else ui.compareModels.delete(c.id); } }), c.label);
    }));
    const negatives = h('div.segmented',
      h(`button${ui.compareNegatives === 'sample' ? '.active' : ''}`, { type: 'button', title: 'Per dye, the dimmest half of this population at the dye\'s peak detector', onclick: () => { ui.compareNegatives = 'sample'; renderTab(); } }, 'This population'),
      h(`button${ui.compareNegatives === 'unstained' ? '.active' : ''}`, { type: 'button', disabled: !unstainedSample(), title: 'Every event of the unstained control is negative for every dye', onclick: () => { ui.compareNegatives = 'unstained'; renderTab(); } }, 'Unstained control'));
    tabHost.append(h('div.pane',
      h('h3', 'Counterfactual unmixing', h('span.muted', { style: { fontWeight: 500 } }, sample ? `${sample.name} · ${store.ui.gateId && store.ui.gateId !== ROOT ? gatePath(ws(), store.ui.gateId) : 'all events'}` : 'select a sample')),
      h('p.muted', { style: { marginTop: 0 } }, 'Unmixes the same events several ways and measures, for every dye, how wide its negative population is and how much signal each model leaves unexplained. Narrower negatives mean dim positives resolve better.'),
      h('div.field', h('span', 'Models'), choices),
      h('div.field', h('span', 'Negatives'), negatives),
      h('button.btn.primary', { type: 'button', disabled: Boolean(ui.busy) || !sample, onclick: () => runComparison() }, icon('play'), ui.busy === 'compare' ? 'Comparing…' : 'Compare models')));
    const state = ui.compare;
    if (!state) return;
    const { result } = state;
    const rec = recommendFromComparison(result);
    const stale = state.key !== compareKey();
    const pane = h('div.pane', h('h3', 'Result', h('span.muted', { style: { fontWeight: 500 } }, `${state.sample} · ${state.population} · ${formatCount(result.events)} events`)));
    if (stale) pane.append(h('div.callout.warn', { style: { marginBottom: '8px' } }, icon('warning'), h('span', 'The sample, population or references changed since this comparison; run it again.')));
    if (state.note) pane.append(h('div.callout', { style: { marginBottom: '8px' } }, icon('info'), h('span', state.note)));
    pane.append(h('div.callout.accent', icon('sparkles'), h('div', h('b', rec.sentence), h('ul.spectral-caveats', rec.caveats.map((c) => h('li', c))))));
    const modelBody = h('tbody');
    result.models.forEach((m, k) => {
      const rank = result.ranking.find((r) => r.name === m.name);
      modelBody.append(h('tr',
        h('td', h('span.swatch', { style: { background: categoricalColor(k), marginRight: '6px' } }), m.name, m.autofluorescence ? h('span.badge', { style: { marginLeft: '6px' } }, 'AF') : null),
        h('td.r', `${(m.timeMs / 1000).toFixed(2)} s`),
        h('td.r', m.medianResidual.toFixed(3)),
        h('td.r', Number.isFinite(m.brightResidual) ? m.brightResidual.toFixed(3) : '—'),
        h('td.r', rank && Number.isFinite(rank.relativeSpread) ? `${(100 * rank.relativeSpread).toFixed(0)}%` : '—'),
        h('td', rank?.clipped ? h('span.badge.warn', 'clips at 0') : m.name === rec.model ? h('span.badge.ok', 'recommended') : '')));
    });
    pane.append(h('div', { style: { overflow: 'auto', marginTop: '10px' } }, h('table.data',
      h('thead', h('tr', h('th', 'Model'), h('th.r', 'Time'), h('th.r', { title: 'Median of ‖r − âS‖/‖r‖ over all events' }, 'Residual'), h('th.r', { title: 'Median residual of the brighter half of events, where misfit dominates noise' }, 'Bright residual'), h('th.r', { title: `Geometric mean over dyes of negative rSD relative to ${result.models[0].name}` }, 'Spread'), h('th', ''))),
      modelBody)));
    // Per-fluorochrome bars: negative rSD per model, scaled to the row's largest.
    const names = result.models[0].fluorochromes.map((f) => f.name);
    const head = h('tr', h('th', 'Fluorochrome'), result.models.map((m, k) => h('th', h('span.swatch', { style: { background: categoricalColor(k), marginRight: '4px' } }), m.name)));
    const rows = h('tbody');
    for (const name of names) {
      const cells = result.models.map((m) => m.fluorochromes.find((f) => f.name === name));
      const max = Math.max(...cells.map((c) => c?.negativeRSD ?? 0)) || 1;
      const best = Math.min(...cells.filter((c) => c && c.zeroFraction <= 0.05).map((c) => c.negativeRSD));
      rows.append(h('tr', h('td', name), cells.map((c, k) => {
        if (!c) return h('td.muted', '—');
        return h('td', { title: `negative median ${c.negativeMedian.toFixed(1)}, rSD ${c.negativeRSD.toFixed(1)}, ${(100 * c.zeroFraction).toFixed(0)}% at zero (${c.count} events)` },
          h('div.spectral-bar', h('span', { style: { width: `${Math.max(2, (100 * c.negativeRSD) / max)}%`, background: categoricalColor(k), opacity: c.negativeRSD === best ? 1 : 0.55 } })),
          h('div.spectral-bar-label', c.negativeRSD >= 100 ? c.negativeRSD.toFixed(0) : c.negativeRSD.toFixed(1), c.zeroFraction > 0.05 ? h('span.badge.warn', { style: { marginLeft: '4px' } }, `${(100 * c.zeroFraction).toFixed(0)}% at 0`) : null));
      })));
    }
    pane.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Negative spread per fluorochrome (robust SD)'),
      h('div', { style: { overflow: 'auto', maxHeight: '520px' } }, h('table.data.spectral-bars', h('thead', head), rows)),
      h('p.muted.small-print', `Negatives: ${result.negativeSource === 'unstained' ? 'every event of the unstained control' : 'per dye, the dimmest half of events at its peak detector'}. Solid bars are the narrowest unclipped model for that dye. Shorter is better only when the model does not clip at zero and its residual is not higher.`));
    tabHost.append(pane);
  }

  function renderResidualTab() {
    const empty = needReferences();
    if (empty) {
      tabHost.append(empty);
      return;
    }
    const problems = unmixProblems();
    if (problems.length) {
      problems.forEach((p) => tabHost.append(h('div.callout.warn', { style: { marginBottom: '8px' } }, icon('warning'), h('span', p))));
      return;
    }
    if (!store.ui.sampleId) {
      tabHost.append(emptyState('target', 'Choose a sample', 'Residuals show what the reference spectra fail to explain in a population: select a sample (and a population in the Gate view).'));
      return;
    }
    const state = ui.residual;
    if (!state || state.key !== residualKey()) {
      tabHost.append(h('div.pane', h('p.muted', 'Checking the residuals…')));
      runResidualCheck();
      return;
    }
    if (state.running) {
      tabHost.append(h('div.pane', h('p.muted', 'Checking the residuals…')));
      return;
    }
    if (state.error || !state.report) {
      tabHost.append(h('div.callout.danger', icon('warning'), h('span', state.error ?? 'The residual check failed.')));
      return;
    }
    const { report } = state;
    const detectors = report.detectors;
    const rel = Array.from(report.relativeResidual);
    const maxAbs = Math.max(...rel.map(Math.abs));
    const systematic = maxAbs > 0.02;
    const pane = h('div.pane', h('h3', 'Residual check', h('span.muted', { style: { fontWeight: 500 } }, `${state.sample} · ${state.population} · ${formatCount(report.events)} events · ${METHODS.find((m) => m.id === state.method)?.label}${state.afMode !== 'none' ? ' + AF' : ''}`)));
    if (state.note) pane.append(h('div.callout', { style: { marginBottom: '8px' } }, icon('info'), h('span', state.note)));
    pane.append(h('div.stat-grid',
      h('div.stat-tile', h('div.k', 'Median relative residual'), h('div.v', report.medianRelativeResidual.toFixed(3))),
      h('div.stat-tile', h('div.k', 'Largest systematic misfit'), h('div.v', `${(100 * maxAbs).toFixed(1)}%`)),
      h('div.stat-tile', h('div.k', 'Worst detector'), h('div.v', report.worst[0]?.detector ?? '—'))));
    pane.append(systematic
      ? h('div.callout.warn', { style: { marginTop: '10px' } }, icon('warning'), h('span', `Events in this population leave a systematic signal in ${report.worst.filter((w) => Math.abs(w.relativeResidual) > 0.01).map((w) => w.detector).slice(0, 4).join(', ')} that no reference explains. Typical causes: a dye missing from the reference set, a reference from a degraded tandem or mismatched control, or autofluorescence not modeled (try per-event AF).`))
      : h('div.callout.ok', { style: { marginTop: '10px' } }, icon('check'), h('span', 'The residuals scatter around zero in every detector: the references explain this population well.')));
    const bands = laserBands(detectors);
    pane.append(h('div.section-title', { style: { marginTop: '14px' } }, 'Median residual per detector (relative to the median signal)'),
      residualBarsBox(detectors, bands, rel),
      h('div.section-title', { style: { marginTop: '14px' } }, 'Residual heat strip: events binned by signal (bottom dim, top bright)'),
      heatStripBox(detectors, bands, report.strip),
      h('p.muted.small-print', 'Each row is an equal-count bin of events, from the dimmest (bottom) to the brightest (top); each cell is the bin\'s median residual in a detector divided by its median signal. Red is signal the model under-explains, blue over-explains. A misfit that grows with brightness points to a wrong reference for a bright dye; one present in all bins points to autofluorescence or background.'));
    tabHost.append(pane);
  }

  // --- The unmixing doctor ----------------------------------------------------------------------

  const KIND_LABELS = {
    'missing-reference': 'Missing reference',
    'wrong-reference': 'Wrong reference',
    'degraded-tandem': 'Degraded tandem',
    'bead-control': 'Bead control',
    'control-autofluorescence': 'Autofluorescent control',
    autofluorescence: 'Autofluorescence',
    'library-change': 'Changed control',
  };

  function doctorKey() {
    const s = settings();
    return `${store.ui.sampleId}|${store.ui.gateId ?? ROOT}|${referencesKey()}|${setup()?.autofluorescence?.computed ?? ''}|${(setup()?.autofluorescence?.signatures ?? []).length}|${s.afMode}`;
  }

  async function runDiagnosis() {
    if (unmixProblems().length || !store.ui.sampleId) return;
    const key = doctorKey();
    ui.busy = 'doctor';
    ui.doctor = { key, running: true };
    renderTab();
    let job = null;
    const progress = progressToast('Diagnosing the unmixing…', () => job?.cancel());
    try {
      // The doctor names spectra from the library: read it first.
      const inst = instrument();
      const library = inst && app.library?.getRecord ? ((await app.library.getRecord(SPECTRA_RECORDS, inst.id).catch(() => null)) ?? null) : null;
      const run = await diagnoseSample(app, store.ui.sampleId, {
        gateId: store.ui.gateId ?? ROOT,
        library,
        onProgress: (f, note) => progress.update(f, note),
        track: (j) => { job = j; return track(j); },
      });
      if (!run) {
        progress.done('Canceled.', 'info');
        ui.doctor = null;
        return;
      }
      ui.doctor = { key, ...run, libraryEntries: library?.entries ?? [] };
      const n = run.result.findings.filter((f) => f.severity !== 'low').length;
      progress.done(run.result.healthy ? 'No fault found.' : `${n} likely cause${n === 1 ? '' : 's'} found.`, run.result.healthy ? 'ok' : 'info');
    } catch (error) {
      progress.fail(error.message);
      ui.doctor = { key, error: error.message };
    } finally {
      ui.busy = null;
      if (ui.doctor) ui.doctor.running = false;
      if (ui.tab === 'doctor') renderTab();
    }
  }

  // A spectrum estimated from a sample, kept beside library spectra (setup.libraryReferences).
  function estimatedEntry(name, spectrum, detectors, sampleName) {
    const added = new Date().toISOString();
    return { id: `sample-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`, fluorochrome: name, marker: '', detectors: [...detectors], spectrum: Array.from(spectrum, (v) => +v.toFixed(6)), peakDetector: detectors[spectrum.indexOf(Math.max(...spectrum))] ?? null, date: added.slice(0, 10), file: `estimated from ${sampleName}`, origin: 'sample', added };
  }

  function applyFix(finding, fix) {
    const detectors = setup()?.params?.detectors ?? panelDetectors();
    const current = setup() ?? baseSetup();
    const references = current.libraryReferences ?? [];
    const control = activeRefs().find((r) => !r.sample.library && r.name === (fix.fluorochrome ?? finding.subject));
    const excluded = (patch) => {
      if (!control) return patch;
      const all = { ...(current.controlSettings ?? {}) };
      all[control.sample.id] = { ...(all[control.sample.id] ?? {}), excluded: true };
      return { ...patch, controlSettings: all };
    };
    const withReference = (entry) => [...references.filter((e) => e.fluorochrome.toLowerCase() !== entry.fluorochrome.toLowerCase()), entry];
    const sampleName = ui.doctor?.sample ?? 'the sample';
    let patch = null;
    let label = '';
    switch (fix.action) {
      case 'add-library':
      case 'use-library': {
        const entry = (ui.doctor?.libraryEntries ?? []).find((e) => e.id === fix.entryId);
        const spectrum = entry ? spectrumOn(entry, detectors) : null;
        if (!spectrum) {
          toast('That library spectrum is no longer in the library.', { kind: 'error' });
          return;
        }
        patch = { libraryReferences: withReference({ ...entry, detectors: [...detectors], spectrum: Array.from(spectrum) }) };
        if (fix.action === 'use-library') patch = excluded(patch);
        label = fix.action === 'use-library' ? `Use the library's ${entry.fluorochrome} instead of its control` : `Add ${entry.fluorochrome} from the spectral library`;
        break;
      }
      case 'add-spectrum':
      case 'replace-spectrum': {
        patch = { libraryReferences: withReference(estimatedEntry(fix.name, fix.spectrum, detectors, sampleName)) };
        if (fix.action === 'replace-spectrum') patch = excluded(patch);
        label = fix.action === 'replace-spectrum' ? `Use the ${fix.name} spectrum estimated from ${sampleName}` : `Add a spectrum estimated from ${sampleName}`;
        break;
      }
      case 'add-autofluorescence': {
        const af = current.autofluorescence ?? { method: 'Autofluorescence signatures added by the unmixing doctor.', signatures: [], computed: new Date().toISOString() };
        const signatures = [...af.signatures, ...fix.signatures.map((x) => ({ name: x.name, spectrum: x.spectrum.map((v) => +v.toFixed(6)), fraction: null, count: null, brightness: null, source: sampleName }))];
        patch = { autofluorescence: { ...af, signatures, modified: new Date().toISOString() }, settings: { ...(current.settings ?? {}), afMode: 'perEvent' } };
        label = `Add ${fix.signatures.length} autofluorescence signature${fix.signatures.length > 1 ? 's' : ''} from ${sampleName}`;
        break;
      }
      case 'per-event-af':
        patch = { settings: { ...(current.settings ?? {}), afMode: 'perEvent' } };
        label = 'Unmix with every autofluorescence signature';
        break;
      default:
        return;
    }
    saveSetup({ ...patch, params: { ...(current.params ?? {}), detectors }, spreading: null }, label);
    toast(`${label}. Diagnose again to check the fix, and unmix the samples again to update their channels.`, { kind: 'ok' });
  }

  function renderDoctorTab() {
    const empty = needReferences();
    if (empty) {
      tabHost.append(empty);
      return;
    }
    const problems = unmixProblems();
    if (problems.length) {
      problems.forEach((p) => tabHost.append(h('div.callout.warn', { style: { marginBottom: '8px' } }, icon('warning'), h('span', p))));
      return;
    }
    const sample = ws().samples.find((s) => s.id === store.ui.sampleId);
    const where = sample ? `${sample.name} · ${store.ui.gateId && store.ui.gateId !== ROOT ? gatePath(ws(), store.ui.gateId) : 'all events'}` : 'select a sample';
    tabHost.append(h('div.pane',
      h('h3', icon('stethoscope'), 'Unmixing doctor', h('span.muted', { style: { fontWeight: 500 } }, where)),
      h('p.muted', { style: { marginTop: 0 } }, 'Names the likely cause of a poor unmixing and tries its fix on the same events: a dye without a reference, a reference that does not match the dye in the sample (a wrong control, a bead control for a stain on cells), a tandem that degraded, a cell control carrying autofluorescence, or autofluorescence the unstained control does not represent. Diagnose a stained sample, ideally its live single cells (select the population in the Gate view).'),
      h('button.btn.primary', { type: 'button', disabled: Boolean(ui.busy) || !sample, onclick: () => runDiagnosis() }, icon('stethoscope'), ui.busy === 'doctor' ? 'Diagnosing…' : 'Diagnose')));
    const state = ui.doctor;
    if (!state || state.running) return;
    if (state.error) {
      tabHost.append(h('div.callout.danger', icon('warning'), h('span', state.error)));
      return;
    }
    const { result } = state;
    const stale = state.key !== doctorKey();
    const head = h('div.pane', h('h3', 'Diagnosis', h('span.muted', { style: { fontWeight: 500 } }, `${state.sample} · ${state.population} · ${formatCount(result.events)} events`)));
    if (stale) head.append(h('div.callout.warn', { style: { marginBottom: '8px' } }, icon('warning'), h('span', 'The sample, population, references or autofluorescence changed since this diagnosis; diagnose again.')));
    const notable = result.findings.filter((f) => f.severity !== 'low');
    head.append(result.healthy && !notable.length
      ? h('div.callout.ok', icon('check'), h('span', `No fault found: the references and autofluorescence explain this population (bright events' median residual ${result.baseline.brightResidual.toFixed(3)}).`))
      : h('div.callout.accent', icon('sparkles'), h('span', `${notable.length || result.findings.length} likely cause${(notable.length || result.findings.length) === 1 ? '' : 's'}, the most likely first. Each fix was tried on these events; its effect is shown.`)));
    head.append(h('details', { style: { marginTop: '8px' } }, h('summary', 'What was checked'),
      h('table.data', h('tbody', result.checks.map((c) => h('tr', h('td', c.check), h('td.muted', c.result)))))));
    tabHost.append(head);
    const detectors = result.detectors;
    result.findings.forEach((f, k) => {
      const card = h('div.pane.doctor-finding',
        h('div.doctor-head',
          h('span.badge', KIND_LABELS[f.kind] ?? f.kind),
          h(`span.badge${f.severity === 'high' ? '.danger' : f.severity === 'medium' ? '.warn' : ''}`, `${f.severity} impact`),
          h('span.muted.small-print', `${f.confidence} confidence${f.fromControls ? ' · from the controls alone' : ''}`)),
        h('h3', { style: { marginTop: '6px' } }, `${k + 1}. ${f.title}`),
        h('ul.spectral-caveats', f.evidence.map((e) => h('li', e))));
      if (f.spectrum) {
        const series = [{ name: f.kind === 'degraded-tandem' || f.kind === 'wrong-reference' || f.kind === 'bead-control' ? `${f.subject} in the sample` : f.kind === 'control-autofluorescence' ? 'Dim minus bright positives' : 'Unexplained signature', values: f.spectrum, color: categoricalColor(0) }];
        if (f.compare) series.push({ name: f.compare.name, values: f.compare.spectrum, color: categoricalColor(3), dashed: true });
        card.append(spectraBox(detectors, series),
          h('div.spectral-legend', series.map((x) => h('span.chip', h('span.swatch', { style: { background: x.color, opacity: x.dashed ? 0.6 : 1 } }), `${x.name}${x.dashed ? ' (dashed)' : ''}`))));
      }
      if (f.effect) card.append(h('p.small-print', h('b', 'Trying the fix: '), effectText(f.effect)));
      const fixes = [f.fix, ...(f.alternatives ?? [])].filter(Boolean);
      if (fixes.length) {
        card.append(h('div.doctor-fixes', fixes.map((fix, j) => h('div.doctor-fix',
          fix.action === 'advice'
            ? h('span.badge', 'Advice')
            : h(`button.btn${j === 0 ? '.primary' : ''}.small`, { type: 'button', disabled: stale, title: stale ? 'Diagnose again first' : '', onclick: () => applyFix(f, fix) }, icon(j === 0 ? 'check' : 'plus'), fix.label),
          h('span', fix.action === 'advice' ? h('b', `${fix.label}. `) : null, fix.text)))));
      }
      tabHost.append(card);
    });
  }

  function effectText(effect) {
    const parts = [];
    const pair = (label, a, b, digits = 3) => {
      if (a === undefined || a === null || b === undefined || b === null) return;
      parts.push(`${label} ${Number(a).toFixed(digits)} → ${Number(b).toFixed(digits)}`);
    };
    if (effect.before.unexplained !== undefined) parts.push(`unexplained events ${formatCount(effect.before.unexplained)} → ${formatCount(Math.max(0, effect.after.unexplained ?? 0))}`);
    pair('leak into the donor', effect.before.leak, effect.after.leak);
    pair('departure from the reference', effect.before.mismatch, effect.after.mismatch);
    pair('autofluorescent cells\' residual', effect.before.afDominatedResidual, effect.after.afDominatedResidual);
    pair('bright events\' residual', effect.before.brightResidual, effect.after.brightResidual);
    return `${parts.join('; ')}.`;
  }

  function renderRibbonTab() {
    const detectors = setup()?.params?.detectors ?? panelDetectors();
    if (!detectors.length) {
      tabHost.append(emptyState('spectral', 'No raw spectral detectors', 'The signature plot needs raw detector data (for example UV1-A … R8-A on a Cytek Aurora). Files exported after unmixing contain fluorochrome channels only.'));
      return;
    }
    const view = store.ui.sampleId ? data.view(store.ui.sampleId) : null;
    if (!view) {
      tabHost.append(emptyState('density', 'Choose a sample', store.ui.sampleId ? 'Loading the sample…' : 'The signature plot shows the raw spectrum of every event in the selected population as a density across detectors.'));
      if (store.ui.sampleId) data.ensure(store.ui.sampleId).catch(() => {});
      return;
    }
    const gateId = store.ui.gateId ?? ROOT;
    const key = `${view.id}|${view.version}|${gateId}|${ws().channelSettings?.[detectors[0]]?.transform ? JSON.stringify(ws().channelSettings[detectors[0]].transform) : ''}`;
    if (!ui.ribbon || ui.ribbon.key !== key) ui.ribbon = { key, ...computeRibbon(view, detectors, gateId) };
    const r = ui.ribbon;
    if (r.error) {
      tabHost.append(h('div.callout.danger', icon('warning'), h('span', r.error)));
      return;
    }
    tabHost.append(h('div.pane',
      h('h3', 'Spectral signature', h('span.muted', { style: { fontWeight: 500 } }, `${view.record.name} · ${r.label} · ${formatCount(r.count)} events${r.count > r.used ? ` (${formatCount(r.used)} shown)` : ''}`)),
      r.note ? h('div.callout', { style: { marginBottom: '8px' } }, icon('info'), h('span', r.note)) : null,
      ribbonBox(detectors, laserBands(detectors), r),
      h('p.muted.small-print', `Every event's raw signal on every detector, as a density (the "spectral ribbon"); the line is the median. All detectors share the scale of ${detectors[0]} (${createTransform(r.transform).label}). A population stained with one dye shows that dye's spectrum; mixtures and autofluorescence show as extra ridges.`)));
  }

  function computeRibbon(view, detectors, gateId) {
    let indices = null;
    let note = '';
    try {
      const pop = population(view, ws(), gateId);
      if (pop === undefined) note = 'The selected gate does not apply to this sample; all events are shown.';
      else indices = pop;
    } catch {
      note = 'The selected population could not be evaluated; all events are shown.';
    }
    let columns;
    try {
      columns = detectorColumns(view, detectors);
    } catch (error) {
      return { error: error.message };
    }
    const configured = ws().channelSettings?.[detectors[0]]?.transform;
    const info = view.channelInfo(detectors[0]) ?? { type: 'fluorescence', range: detectorRange(detectors) };
    const transform = configured ?? defaultTransform(info, 'spectral', columns[Math.floor(columns.length / 2)]);
    const thin = thinIndices(indices, view.eventCount, LIMITS.ribbon);
    const subset = copyColumns(columns, thin);
    const t = createTransform(transform);
    const scaled = subset.map((c) => applyTransform(c, t));
    const bins = 160;
    const grid = ribbonCounts(scaled, null, bins);
    const medians = scaled.map((c) => {
      const sorted = Float32Array.from(c).sort();
      return sorted.length ? sorted[Math.floor(sorted.length / 2)] : Number.NaN;
    });
    const count = indices ? indices.length : view.eventCount;
    return { grid, bins, medians, transform, count, used: subset[0]?.length ?? 0, label: note || gateId === ROOT ? 'All events' : gatePath(ws(), gateId), note };
  }

  // --- Canvas boxes ---------------------------------------------------------------------------

  // A responsive canvas with a tooltip: draw(ctx, width, height) and onMove(x, y) → { tip } | null.
  function canvasBox({ height, draw, onMove, onLeave }) {
    const canvas = h('canvas');
    const tip = h('div.spectral-tip', { hidden: true });
    const box = h('div.spectral-canvas', canvas, tip);
    let width = 0;
    box.redraw = () => {
      width = box.clientWidth;
      if (!width) return;
      const hh = typeof height === 'function' ? height(width) : height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(hh * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${hh}px`;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, hh);
      draw(ctx, width, hh);
    };
    const observer = new ResizeObserver(() => {
      if (box.clientWidth !== width) box.redraw();
    });
    observer.observe(box);
    canvas.addEventListener('mousemove', (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const result = onMove?.(x, y);
      if (result?.tip) {
        tip.textContent = result.tip;
        tip.hidden = false;
        const left = Math.min(x + 14, rect.width - tip.offsetWidth - 4);
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = `${Math.max(4, y - 30)}px`;
      } else tip.hidden = true;
    });
    canvas.addEventListener('mouseleave', () => {
      tip.hidden = true;
      onLeave?.();
    });
    box.dispose = () => observer.disconnect();
    boxes.add(box);
    return box;
  }

  function disposeBoxes(host) {
    for (const box of [...boxes]) {
      if (host.contains(box)) {
        box.dispose();
        boxes.delete(box);
      }
    }
  }

  function redrawBoxes() {
    for (const box of boxes) if (box.isConnected) box.redraw();
  }

  // --- The spectral library --------------------------------------------------------------------

  function instrument() {
    const sample = controls()[0] ?? ws().samples[0];
    return sample ? instrumentOf(sample.keywords) : null;
  }

  // Reads the instrument's library record once (and again after saving).
  function loadLibrary(force = false) {
    const inst = instrument();
    if (!inst || !app.library?.getRecord) return;
    if (!force && ui.libraryFor === inst.id) return;
    ui.libraryFor = inst.id;
    ui.library = undefined;
    app.library.getRecord(SPECTRA_RECORDS, inst.id).then((record) => {
      if (ui.libraryFor !== inst.id) return;
      ui.library = record ?? null;
      renderControls();
      if (ui.tab === 'library') renderTab();
    }).catch(() => { ui.library = null; });
  }

  // Controls whose spectrum differs from the library's latest: Map sample id → comparison.
  function libraryChanges() {
    loadLibrary();
    const out = new Map();
    if (!ui.library) return out;
    const detectors = setup()?.params?.detectors ?? panelDetectors();
    const refs = activeRefs().filter((r) => !r.sample.library && !r.ref.error);
    const rows = compareWithLibrary(refs.map((r) => ({ name: r.name, spectrum: r.ref.spectrum })), ui.library, detectors);
    rows.forEach((row, i) => { if (row.status === 'changed') out.set(refs[i].sample.id, row); });
    return out;
  }

  async function saveToLibrary(refs) {
    const inst = instrument();
    const detectors = setup()?.params?.detectors ?? panelDetectors();
    try {
      let record = (await app.library.getRecord(SPECTRA_RECORDS, inst.id)) ?? { name: inst.name, instrument: inst, entries: [] };
      const entries = refs.map((r) => libraryEntry({
        fluorochrome: r.name,
        marker: r.marker,
        spectrum: r.ref.spectrum,
        detectors,
        peakDetector: r.ref.peakDetector,
        date: acquisitionDate(r.sample.keywords),
        file: r.sample.fileName ?? r.sample.name,
        sha256: r.sample.sha256,
        workspace: ws().name,
        carrier: r.sample.meta?.carrier ?? null,
        quality: { separation: r.ref.separation, stainIndex: r.ref.stainIndex, heterogeneity: r.ref.heterogeneity, brightness: r.ref.brightness ?? null },
      }));
      record = withEntries(record, entries);
      await app.library.putRecord(SPECTRA_RECORDS, inst.id, record);
      ui.library = record;
      toast(`Saved ${entries.length} spectra to the spectral library of ${inst.name} (${record.entries.length} in all).`, { kind: 'ok' });
      renderControls();
      renderTab();
    } catch (error) {
      toast(`The spectral library could not be saved: ${error.message}`, { kind: 'error' });
    }
  }

  function addFromLibrary(entry) {
    const detectors = setup()?.params?.detectors ?? panelDetectors();
    const spectrum = spectrumOn(entry, detectors);
    if (!spectrum) return;
    const existing = (setup()?.libraryReferences ?? []).filter((e) => e.fluorochrome.toLowerCase() !== entry.fluorochrome.toLowerCase());
    saveSetup({ libraryReferences: [...existing, { ...entry, detectors: [...detectors], spectrum: Array.from(spectrum) }], params: { ...(setup()?.params ?? {}), detectors }, spreading: null }, `Add ${entry.fluorochrome} from the spectral library`);
  }

  function renderLibraryTab() {
    loadLibrary();
    const inst = instrument();
    const detectors = setup()?.params?.detectors ?? panelDetectors();
    const pane = h('div.pane', h('h3', icon('library'), 'Spectral library', h('span.muted', { style: { fontWeight: 500 } }, inst ? inst.name : '')));
    tabHost.append(pane);
    pane.append(h('p.muted', 'Reference spectra kept across experiments for this instrument. Compare today\'s controls with them to catch a dye that changed (a tandem that degraded, a new lot, a realigned laser), and unmix a fluorochrome you have no control for with its spectrum from an earlier experiment.'));
    if (!app.library?.getRecord) {
      pane.append(h('div.callout', icon('info'), h('span', 'This library cannot keep records.')));
      return;
    }
    if (ui.library === undefined) {
      pane.append(h('p.muted', 'Reading the library…'));
      return;
    }
    const own = activeRefs().filter((r) => !r.sample.library && !r.ref.error);
    // Changed dyes first, then those new to the library, then the matching ones.
    const order = { changed: 0, new: 1, match: 2 };
    const rows = (ui.library ? compareWithLibrary(own.map((r) => ({ name: r.name, spectrum: r.ref.spectrum })), ui.library, detectors) : own.map((r) => ({ name: r.name, status: 'new' })))
      .map((row, i) => ({ row, i })).sort((a, b) => order[a.row.status] - order[b.row.status] || a.i - b.i).map(({ row }) => row);
    const entries = ui.library?.entries?.length ?? 0;
    pane.append(h('p', ui.library ? `${entries} spectra in the library, of ${new Set(ui.library.entries.map((e) => e.fluorochrome.toLowerCase())).size} fluorochromes.` : 'The library has no spectra of this instrument yet.'));
    if (own.length) {
      const changed = rows.filter((r) => r.status === 'changed');
      if (!ui.libraryChosen || !rows.some((r) => r.name === ui.libraryChosen)) ui.libraryChosen = changed[0]?.name ?? rows.find((r) => r.entry)?.name ?? null;
      const body = h('tbody', rows.map((row) => h(`tr${row.name === ui.libraryChosen ? '.selected' : ''}`, { style: { cursor: row.entry ? 'pointer' : 'default' }, onclick: () => { if (row.entry) { ui.libraryChosen = row.name; renderTab(); } } },
        h('td', row.name),
        h('td', row.entry ? `${(row.entry.date ?? row.entry.added ?? '').slice(0, 10)} · ${row.entry.file ?? ''}` : h('span.muted', 'not in the library')),
        h('td.r', !row.entry ? '—' : row.maxDiff < 0.0005 ? '< 0.001' : `${row.maxDiff.toFixed(3)} at ${row.detector}`),
        h('td', row.status === 'changed' ? h('span.badge.danger', 'changed') : row.status === 'match' ? h('span.badge.ok', 'matches') : h('span.badge', 'new')))));
      pane.append(h('div', { style: { overflow: 'auto', maxHeight: '320px' } }, h('table.data', h('thead', h('tr', h('th', 'Fluorochrome'), h('th', 'Latest in the library'), h('th.r', { title: 'Largest difference in any detector, each spectrum scaled to a peak of 1' }, 'Largest difference'), h('th', 'Status'))), body)),
        h('p.muted.small-print', `A spectrum differing by more than ${LIBRARY_TOLERANCE} in any detector (each scaled to a peak of 1) is marked changed. Controls of one instrument usually agree within ~0.01; a tandem that lost 5% of its emission to its donor differs by ~0.05 where the donor emits.`),
        h('div.btn-row', h('button.btn', { type: 'button', onclick: () => saveToLibrary(own) }, icon('library'), `Save ${own.length} spectra to the library`)));
      const chosen = rows.find((r) => r.name === ui.libraryChosen && r.entry);
      if (chosen) {
        const current = own.find((r) => r.name === chosen.name);
        const box = spectraBox(detectors, [
          { name: `${chosen.name} (this experiment)`, values: current.ref.spectrum, color: categoricalColor(0) },
          { name: `${chosen.name} (library, ${(chosen.entry.date ?? '').slice(0, 10)})`, values: Array.from(spectrumOn(chosen.entry, detectors)), color: categoricalColor(3), dashed: true },
        ]);
        tabHost.append(h('div.pane', h('h3', `${chosen.name}: this experiment against the library`), box));
      }
    } else {
      pane.append(h('div.callout', icon('info'), h('span', 'Gate the controls to compare them with the library or save them to it.')));
    }
    if (ui.library) {
      const names = activeRefs().map((r) => r.name);
      const missing = missingFromPanel(ui.library, detectors, names);
      if (missing.length) {
        tabHost.append(h('div.pane', h('h3', 'In the library, not in this panel'),
          h('p.muted', 'Add a fluorochrome you have no control for: its library spectrum joins the panel (it has no control events, so it is left out of the spreading matrix). The spectrum must come from this instrument with the same detectors and settings.'),
          h('div', { style: { overflow: 'auto', maxHeight: '260px' } }, h('table.data', h('thead', h('tr', h('th', 'Fluorochrome'), h('th', 'Acquired'), h('th', 'From'), h('th'))),
            h('tbody', missing.map((e) => h('tr', h('td', e.fluorochrome, e.marker ? h('span.muted', ` ${e.marker}`) : null), h('td', (e.date ?? e.added ?? '').slice(0, 10)), h('td.muted', `${e.file ?? ''}${e.workspace ? ` · ${e.workspace}` : ''}`),
              h('td', h('button.btn.small', { type: 'button', onclick: () => addFromLibrary(e) }, icon('plus'), 'Add to the panel')))))))));
      }
    }
  }

  function spectraBox(detectors, series) {
    let layout = null;
    let hoverLocal = null;
    const box = canvasBox({
      height: 340,
      draw: (ctx, width, height) => {
        layout = drawSpectra(ctx, width, height, { detectors, series: series.filter((s) => !ui.hidden.has(s.name)), logY: ui.logY, highlight: hoverLocal ?? ui.hover });
      },
      onMove: (x, y) => {
        if (!layout) return null;
        const hit = layout.hit(x, y);
        const name = hit?.name ?? null;
        if (name !== hoverLocal) {
          hoverLocal = name;
          box.redraw();
        }
        return hit ? { tip: `${hit.name} · ${hit.detector}: ${hit.value.toFixed(3)}` } : null;
      },
      onLeave: () => {
        hoverLocal = null;
        box.redraw();
      },
    });
    return box;
  }

  function matrixBox(spec) {
    let layout = null;
    return canvasBox({
      height: (width) => matrixLayout(width, spec.names).height,
      draw: (ctx, width) => { layout = drawMatrix(ctx, width, spec); },
      onMove: (x, y) => {
        const cell = layout?.hit(x, y);
        if (!cell) return null;
        const v = spec.matrix[cell.i * spec.names.length + cell.j];
        return { tip: spec.tip(v, cell.i, cell.j) };
      },
    });
  }

  function residualBarsBox(detectors, bands, values) {
    let layout = null;
    return canvasBox({
      height: 170,
      draw: (ctx, width, height) => { layout = drawResidualBars(ctx, width, height, detectors, bands, values); },
      onMove: (x) => {
        const i = layout?.index(x);
        return i === null || i === undefined ? null : { tip: `${detectors[i]}: ${(100 * values[i]).toFixed(2)}% of the median signal` };
      },
    });
  }

  function heatStripBox(detectors, bands, strip) {
    let layout = null;
    return canvasBox({
      height: 230,
      draw: (ctx, width, height) => { layout = drawHeatStrip(ctx, width, height, detectors, bands, strip); },
      onMove: (x, y) => {
        const cell = layout?.hit(x, y);
        if (!cell) return null;
        const v = strip.matrix[cell.b * detectors.length + cell.d];
        return { tip: `${detectors[cell.d]}, bin ${cell.b + 1} of ${strip.bins} (${formatCount(strip.counts[cell.b])} events): ${(100 * v).toFixed(2)}%` };
      },
    });
  }

  function ribbonBox(detectors, bands, ribbon) {
    let layout = null;
    const t = createTransform(ribbon.transform);
    return canvasBox({
      height: 360,
      draw: (ctx, width, height) => { layout = drawRibbon(ctx, width, height, detectors, bands, ribbon, t); },
      onMove: (x, y) => {
        const hit = layout?.hit(x, y);
        if (!hit) return null;
        return { tip: `${detectors[hit.d]} · ${formatSignal(t.inverse(hit.v))} · median ${formatSignal(t.inverse(ribbon.medians[hit.d]))}` };
      },
    });
  }

  // --- Update and teardown ---------------------------------------------------------------------

  function renderBody() {
    disposeBoxes(body);
    clear(body);
    const samples = ws().samples;
    if (!samples.length && ui.libraryDesign) {
      const host = h('div.spectral-library-design');
      body.append(host);
      renderLibraryDesign(host);
      return;
    }
    if (!samples.length) {
      body.append(emptyState('spectral', 'Spectral unmixing', 'Load raw spectral files (with detectors such as UV1-A … R8-A): a single-stain reference control for each fluorochrome, an unstained control and your samples. CytoWeave computes reference spectra with quality checks, finds autofluorescence signatures, checks the panel and unmixes into channels you can gate.',
        h('button.btn.primary', { type: 'button', onclick: () => (app.openExample ? app.openExample('spectral-25color') : app.showExamples?.()) }, icon('sparkles'), 'Open the 25-color spectral example'),
        app.showExamples ? h('button.btn', { type: 'button', onclick: () => app.showExamples() }, 'All examples') : null,
        app.library?.listRecords ? h('button.btn', { type: 'button', onclick: () => { ui.libraryDesign = {}; renderBody(); } }, icon('layers'), 'Design a panel from the spectral library') : null));
      return;
    }
    if (!panelDetectors().length) {
      body.append(emptyState('spectral', 'No raw spectral detectors', 'None of these files has raw spectral detector channels (UV1-A … R8-A on a Cytek Aurora, or the detector arrays of Sony and BD spectral instruments). Files exported after unmixing contain fluorochrome channels only: analyze those in the Gate view, or load the raw files to unmix here.'));
      return;
    }
    body.append(h('div.split.spectral-split', leftColumn, h('div', { style: { minWidth: 0 } }, h('div.spectral-tabbar', tabBar), tabHost)));
    renderTabBar();
  }

  let lastShape = '';
  function renderAll() {
    const shape = `${ws().samples.length > 0}|${panelDetectors().length > 0}`;
    if (shape !== lastShape || !body.firstChild) {
      lastShape = shape;
      renderBody();
    }
    renderLeft();
    if (body.contains(tabHost)) renderTab();
  }

  renderAll();

  return {
    update(topics) {
      if (topics.has('ws') || topics.has('derived') || topics.has('samples') || topics.has('mode')) {
        renderAll();
        return;
      }
      if (topics.has('sample') || topics.has('gate')) {
        renderHead();
        renderControls();
        renderUnmix();
        if (ui.tab !== 'spectra' && ui.tab !== 'quality') renderTab();
        return;
      }
      if (topics.has('data')) {
        if (ui.tab === 'ribbon' || ui.tab === 'residuals') renderTab();
        renderUnmix();
      }
      if (topics.has('theme')) redrawBoxes();
    },
    destroy() {
      for (const job of jobs) job.cancel();
      jobs.clear();
      for (const box of boxes) box.dispose();
      boxes.clear();
      unstainedCache.clear();
      root.remove();
    },
  };
}

// --- Drawing (canvas, theme-aware) ----------------------------------------------------------

function themeColors() {
  return {
    text: css('--text') || '#171b26',
    text2: css('--text-2') || '#4b5468',
    text3: css('--text-3') || '#7b8496',
    line: css('--line') || '#e3e7ef',
    lineStrong: css('--line-strong') || '#d0d6e2',
    band: isDark() ? 'rgba(255,255,255,0.035)' : 'rgba(15,23,42,0.035)',
    plot: css('--plot-bg') || '#ffffff',
  };
}

function formatSignal(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

// Laser bands (alternate shading and names above) and detector numbers below a plot area.
function drawDetectorAxis(ctx, area, detectors, bands, colors, options = {}) {
  const cell = area.w / detectors.length;
  ctx.save();
  bands.forEach((band, k) => {
    const x0 = area.x + band.start * cell;
    const w = (band.end - band.start) * cell;
    if (k % 2 === 0) {
      ctx.fillStyle = colors.band;
      ctx.fillRect(x0, area.y, w, area.h);
    }
    if (options.labels !== false) {
      ctx.fillStyle = colors.text3;
      ctx.font = `600 10.5px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const label = LASER_LABELS[band.laser] ?? band.laser;
      const text = ctx.measureText(label).width < w - 4 ? label : band.laser;
      ctx.fillText(text, x0 + w / 2, area.y - 4);
    }
  });
  if (options.ticks !== false) {
    ctx.fillStyle = colors.text3;
    ctx.font = `9.5px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const every = cell >= 13 ? 1 : cell >= 7 ? 2 : 4;
    detectors.forEach((name, i) => {
      const label = detectorTick(name);
      const n = Number(label);
      if (Number.isFinite(n) ? (n - 1) % every !== 0 : i % every !== 0) return;
      ctx.fillText(label, area.x + (i + 0.5) * cell, area.y + area.h + 4);
    });
  }
  ctx.restore();
  return cell;
}

function drawSpectra(ctx, width, height, { detectors, series, logY, highlight }) {
  const colors = themeColors();
  const area = { x: 44, y: 20, w: width - 44 - 10, h: height - 20 - 22 };
  const cell = drawDetectorAxis(ctx, area, detectors, laserBands(detectors), colors);
  const lo = -3;
  const hi = Math.log10(1.15);
  const yOf = logY
    ? (v) => area.y + (1 - (Math.log10(Math.max(v, 1e-3)) - lo) / (hi - lo)) * area.h
    : (v) => area.y + (1 - (Math.max(-0.05, Math.min(1.1, v)) + 0.05) / 1.15) * area.h;
  const xOf = (i) => area.x + (i + 0.5) * cell;
  // Grid and y labels.
  ctx.font = `10px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const ticks = logY ? [[1e-3, '0.001'], [1e-2, '0.01'], [1e-1, '0.1'], [1, '1']] : [[0, '0'], [0.25, '0.25'], [0.5, '0.5'], [0.75, '0.75'], [1, '1']];
  for (const [v, label] of ticks) {
    const y = yOf(v);
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(area.x, Math.round(y) + 0.5);
    ctx.lineTo(area.x + area.w, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillStyle = colors.text3;
    ctx.fillText(label, area.x - 6, y);
  }
  ctx.save();
  ctx.translate(11, area.y + area.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = colors.text2;
  ctx.font = `600 10.5px ${FONT}`;
  ctx.fillText('Normalized intensity', 0, 0);
  ctx.restore();
  // Lines: the highlighted one last and thick, the others faded while one is highlighted.
  const ordered = [...series].sort((a, b) => (a.name === highlight) - (b.name === highlight));
  ctx.lineJoin = 'round';
  for (const s of ordered) {
    const active = !highlight || s.name === highlight;
    ctx.globalAlpha = active ? 1 : 0.18;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.name === highlight ? 2.8 : 1.6;
    ctx.setLineDash(s.dashed ? [5, 4] : []);
    ctx.beginPath();
    s.values.forEach((v, i) => {
      const x = xOf(i);
      const y = yOf(v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    if (s.name === highlight) {
      let peak = 0;
      s.values.forEach((v, i) => { if (v > s.values[peak]) peak = i; });
      ctx.setLineDash([]);
      ctx.fillStyle = s.color;
      ctx.font = `700 11px ${FONT}`;
      ctx.textAlign = xOf(peak) > area.x + area.w - 60 ? 'right' : 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(s.name, xOf(peak) + (ctx.textAlign === 'left' ? 5 : -5), yOf(s.values[peak]) - 3);
    }
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  return {
    hit(x, y) {
      const i = Math.floor((x - area.x) / cell);
      if (i < 0 || i >= detectors.length || y < area.y - 4 || y > area.y + area.h + 4) return null;
      let best = null;
      let bestDy = 14;
      for (const s of series) {
        const dy = Math.abs(yOf(s.values[i]) - y);
        if (dy < bestDy) {
          bestDy = dy;
          best = { name: s.name, detector: detectors[i], value: s.values[i] };
        }
      }
      return best;
    },
  };
}

function matrixLayout(width, names) {
  const n = names.length;
  const longest = Math.max(...names.map((s) => s.length));
  const labelW = Math.min(130, 12 + longest * 6.4);
  const cell = Math.max(9, Math.min(30, (width - labelW - 12) / n));
  const labelH = Math.min(110, labelW * 0.72);
  return { n, labelW, labelH, cell, height: Math.ceil(labelH + n * cell + 8) };
}

function drawMatrix(ctx, width, spec) {
  const colors = themeColors();
  const { names, matrix } = spec;
  const L = matrixLayout(width, names);
  const { n, labelW, labelH, cell } = L;
  const x0 = labelW;
  const y0 = labelH;
  ctx.font = `${cell >= 16 ? 11 : 9.5}px ${FONT}`;
  ctx.fillStyle = colors.text2;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  names.forEach((name, i) => ctx.fillText(name, x0 - 6, y0 + (i + 0.5) * cell));
  ctx.textAlign = 'left';
  names.forEach((name, j) => {
    ctx.save();
    ctx.translate(x0 + (j + 0.5) * cell, y0 - 5);
    ctx.rotate(-Math.PI / 4);
    ctx.fillText(name, 0, 0);
    ctx.restore();
  });
  const showText = cell >= 21;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const v = matrix[i * n + j];
      const x = x0 + j * cell;
      const y = y0 + i * cell;
      const fill = Number.isFinite(v) ? spec.color(v, i, j) : null;
      ctx.fillStyle = fill ?? (i === j ? colors.lineStrong : colors.line);
      ctx.fillRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
      const flag = spec.flag && Number.isFinite(v) ? spec.flag(v, i, j) : null;
      if (flag) {
        ctx.strokeStyle = flag;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1.5, y + 1.5, cell - 3, cell - 3);
      }
      if (showText && Number.isFinite(v) && i !== j) {
        ctx.fillStyle = fill && luminance(fill.startsWith('#') ? fill : '#ffffff') < 0.4 ? '#ffffff' : '#1f2430';
        ctx.font = `9.5px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText(spec.format(v), x + cell / 2, y + cell / 2 + 0.5);
      }
    }
  }
  return {
    hit(x, y) {
      const j = Math.floor((x - x0) / cell);
      const i = Math.floor((y - y0) / cell);
      return i >= 0 && i < n && j >= 0 && j < n ? { i, j } : null;
    },
  };
}

function simColor(v) {
  // A sequential ramp that starts at the background: white→navy (light), navy→mint (dark).
  return seqColor(isDark() ? 'ocean' : 'blues', Math.max(0, Math.min(1, v)) ** 1.6, false);
}

function seqColor(name, t, avoidBlack) {
  const lut = colormapLUT(name);
  const u = avoidBlack ? 0.15 + 0.85 * t : t;
  const k = Math.max(0, Math.min(255, Math.round(u * 255))) * 3;
  return `#${[lut[k], lut[k + 1], lut[k + 2]].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// Red where the model under-explains the signal, blue where it over-explains; fades into the
// plot background (not white) so the dark theme stays calm.
function divergingColor(v, scale) {
  const base = isDark() ? [17, 22, 30] : [247, 247, 247];
  const end = v > 0 ? [214, 72, 62] : [52, 120, 200];
  const f = Number.isFinite(v) ? Math.min(1, Math.abs(v) / scale) : 0;
  return base.map((c, i) => Math.round(c + (end[i] - c) * f));
}

function drawResidualBars(ctx, width, height, detectors, bands, values) {
  const colors = themeColors();
  const area = { x: 52, y: 18, w: width - 52 - 10, h: height - 18 - 20 };
  const cell = drawDetectorAxis(ctx, area, detectors, bands, colors);
  let scale = 0.01;
  for (const v of values) scale = Math.max(scale, Math.abs(v));
  scale *= 1.1;
  const yOf = (v) => area.y + area.h / 2 - (v / scale) * (area.h / 2);
  ctx.strokeStyle = colors.lineStrong;
  ctx.beginPath();
  ctx.moveTo(area.x, Math.round(yOf(0)) + 0.5);
  ctx.lineTo(area.x + area.w, Math.round(yOf(0)) + 0.5);
  ctx.stroke();
  ctx.fillStyle = colors.text3;
  ctx.font = `10px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [-scale / 1.1, 0, scale / 1.1]) ctx.fillText(`${(100 * v).toFixed(1)}%`, area.x - 6, yOf(v));
  values.forEach((v, i) => {
    const [r, g, b] = divergingColor(v, scale);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    const y = yOf(Math.max(v, 0));
    const hgt = Math.max(1, Math.abs(yOf(v) - yOf(0)));
    ctx.fillRect(area.x + i * cell + cell * 0.15, y, cell * 0.7, hgt);
  });
  return { index: (x) => { const i = Math.floor((x - area.x) / cell); return i >= 0 && i < detectors.length ? i : null; } };
}

function drawHeatStrip(ctx, width, height, detectors, bands, strip) {
  const colors = themeColors();
  const area = { x: 52, y: 18, w: width - 52 - 10, h: height - 18 - 20 };
  const D = detectors.length;
  const cell = area.w / D;
  const rowH = area.h / strip.bins;
  const values = Array.from(strip.matrix).filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  const scale = Math.max(0.005, values[Math.floor(values.length * 0.98)] ?? 0.01);
  for (let b = 0; b < strip.bins; b += 1) {
    for (let d = 0; d < D; d += 1) {
      const v = strip.matrix[b * D + d];
      const [r, g, bl] = Number.isFinite(v) ? divergingColor(v, scale) : [128, 128, 128];
      ctx.fillStyle = `rgb(${r},${g},${bl})`;
      ctx.fillRect(area.x + d * cell, area.y + area.h - (b + 1) * rowH, Math.ceil(cell), Math.ceil(rowH));
    }
  }
  drawDetectorAxis(ctx, area, detectors, bands, { ...colors, band: 'transparent' });
  // Laser separators.
  ctx.strokeStyle = colors.plot;
  ctx.lineWidth = 2;
  for (const band of bands.slice(1)) {
    const x = Math.round(area.x + band.start * cell);
    ctx.beginPath();
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, area.y + area.h);
    ctx.stroke();
  }
  ctx.fillStyle = colors.text3;
  ctx.font = `10px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('bright', area.x - 6, area.y + 6);
  ctx.fillText('dim', area.x - 6, area.y + area.h - 6);
  return {
    hit(x, y) {
      const d = Math.floor((x - area.x) / cell);
      const b = Math.floor((area.y + area.h - y) / rowH);
      return d >= 0 && d < D && b >= 0 && b < strip.bins ? { d, b } : null;
    },
  };
}

function drawRibbon(ctx, width, height, detectors, bands, ribbon, transform) {
  const colors = themeColors();
  const area = { x: 56, y: 20, w: width - 56 - 10, h: height - 20 - 22 };
  const D = detectors.length;
  const { grid, bins } = ribbon;
  ctx.fillStyle = colors.plot;
  ctx.fillRect(area.x, area.y, area.w, area.h);
  let max = 0;
  for (let i = 0; i < grid.length; i += 1) if (grid[i] > max) max = grid[i];
  const lut = colormapLUT('classic');
  const image = new ImageData(D, bins);
  const logMax = Math.log1p(max);
  for (let b = 0; b < bins; b += 1) {
    for (let d = 0; d < D; d += 1) {
      const c = grid[b * D + d];
      const p = ((bins - 1 - b) * D + d) * 4;
      if (c <= 0) continue;
      const t = 0.12 + 0.88 * (Math.log1p(c) / logMax);
      const k = Math.round(t * 255) * 3;
      image.data[p] = lut[k];
      image.data[p + 1] = lut[k + 1];
      image.data[p + 2] = lut[k + 2];
      image.data[p + 3] = 255;
    }
  }
  const off = new OffscreenCanvas(D, bins);
  off.getContext('2d').putImageData(image, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, area.x, area.y, area.w, area.h);
  ctx.restore();
  const cell = drawDetectorAxis(ctx, area, detectors, bands, { ...colors, band: 'transparent' });
  // Laser separators and the median trace.
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1;
  for (const band of bands.slice(1)) {
    const x = Math.round(area.x + band.start * cell) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, area.y + area.h);
    ctx.stroke();
  }
  const yOf = (u) => area.y + (1 - Math.max(0, Math.min(1, u))) * area.h;
  ctx.strokeStyle = isDark() ? '#ffffff' : '#111827';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ribbon.medians.forEach((u, d) => {
    const x = area.x + (d + 0.5) * cell;
    if (d === 0) ctx.moveTo(x, yOf(u));
    else ctx.lineTo(x, yOf(u));
  });
  ctx.stroke();
  // Y axis from the transform's ticks.
  ctx.fillStyle = colors.text3;
  ctx.strokeStyle = colors.lineStrong;
  ctx.font = `10px ${FONT}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tick of axisTicks(transform)) {
    const y = yOf(tick.position);
    ctx.beginPath();
    ctx.moveTo(area.x - (tick.major ? 5 : 2), Math.round(y) + 0.5);
    ctx.lineTo(area.x, Math.round(y) + 0.5);
    ctx.stroke();
    if (tick.label) ctx.fillText(tick.label, area.x - 7, y);
  }
  return {
    hit(x, y) {
      const d = Math.floor((x - area.x) / cell);
      if (d < 0 || d >= D || y < area.y || y > area.y + area.h) return null;
      return { d, v: 1 - (y - area.y) / area.h };
    },
  };
}
