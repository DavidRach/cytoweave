// Teaching mode in the window: the list of exercises, and the exercise panel of a workspace made
// for one (lib/exercises.js).
//
// An exercise opens its example as a new workspace without the simulator's truth (no truth
// channel, no annotation naming a planted fault, a neutral name), and the workspace keeps only
// ws.exercise: { id, seed, version, started, answers, hints, checks, revealed }. The truth stays
// in this session's memory; after a reload it is computed again by generating the attempt's data
// again, whose files must be the workspace's own (their SHA-256), so a changed or replaced file
// cannot be graded against another attempt's truth. Undo and redo keep ws.exercise as it is
// (store.js): it is the learner's progress, not an edit of the analysis.
//
// Nothing here shows unless the workspace open is an exercise's: the panel takes a column at the
// right of the window (styles.css .with-exercise) and folds into a small tab, and exercises are
// listed from the Start page, the workspace menu and the command search.

import { h, icon, clear } from './dom.js';
import { showDialog, confirmDialog, toast, progressToast } from './overlays.js';
import { prefs } from './storage.js';
import { WorkspaceChangedError } from './store.js';
import { channelCatalog, gatePath } from '../lib/workspace.js';

const LEVELS = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
const MISSED = '#f59e0b';
const EXTRA = '#d946ef';
const lib = () => import('../lib/exercises.js');
const stripFCS = (name) => String(name ?? '').replace(/\.fcs$/i, '');

export function installExercises(app) {
  const { store, data } = app;
  // Workspace id → { truth, labels: Map(file name → { labels, names }) } for this session.
  const session = new Map();
  const panel = h('aside#exercise-panel.exercise-panel', { 'aria-label': 'Exercise', hidden: true });
  document.getElementById('app').append(panel);
  let signature = '';
  // Answers being typed, kept until they are saved with the workspace (on change).
  let draft = {};
  let result = null;
  let busy = false;

  const exercise = () => store.ws.exercise ?? null;

  // --- Starting -----------------------------------------------------------------------------------

  app.startExercise = async (id, { seed } = {}) => {
    const { exerciseById, exerciseAttempt, exerciseTruth, newExerciseSeed, EXERCISES_VERSION } = await lib();
    const ex = exerciseById(id);
    if (!ex) throw new Error(`There is no exercise called "${id}".`);
    const attemptSeed = Number.isInteger(seed) && seed > 0 ? seed : newExerciseSeed();
    const { options, setup } = exerciseAttempt(ex, attemptSeed);
    await app.openExample(ex.example.id, options, {
      name: `Exercise: ${ex.title}`,
      hideTruth: true,
      gates: Boolean(ex.example.gates),
      onOpened: async (generated) => {
        const truth = exerciseTruth(ex, attemptSeed, generated);
        const labels = new Map();
        for (const file of generated.files) if (file.meta?.truth?.labels) labels.set(file.name, { labels: file.meta.truth.labels, names: file.meta.truth.names });
        session.set(store.ws.id, { truth, labels, setup });
        store.replace({ ...store.ws, exercise: { id, seed: attemptSeed, version: EXERCISES_VERSION, started: new Date().toISOString(), answers: {}, hints: 0, checks: [], revealed: false } }, ['exercise']);
        prefs.set('exercisePanelOpen', true);
        draft = {};
        result = null;
      },
    });
  };

  app.showExercises = async () => {
    const { EXERCISES } = await lib();
    const code = h('input.input.small', { type: 'text', inputMode: 'numeric', placeholder: 'optional', style: { width: '110px' }, 'aria-label': 'Class code' });
    const start = (id) => {
      const value = Number.parseInt(code.value.replace(/\D/g, ''), 10);
      dialog.close();
      app.startExercise(id, { seed: Number.isFinite(value) && value > 0 ? value : undefined }).catch((error) => toast(error.message, { kind: 'error' }));
    };
    const byLevel = Object.keys(LEVELS).map((level) => [level, EXERCISES.filter((e) => e.level === level)]);
    const dialog = showDialog({
      title: 'Exercises',
      width: 'wide',
      content: [
        h('p', 'Each exercise opens simulated data as a new workspace, with a question to answer using CytoWeave\'s views. Check your answers against the simulator\'s truth, then reveal it to see what was planted. Every attempt gets new data.'),
        h('div.row', { style: { gap: '8px', alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 10px' } },
          h('label.field.inline', h('span', 'Class code'), code),
          h('span.muted', { style: { fontSize: '12px' } }, 'Everyone who enters the same code gets the same data, so a class can compare answers.')),
        ...byLevel.flatMap(([level, list]) => [
          h('div.section-title', { style: { marginTop: '10px' } }, LEVELS[level]),
          h('div.welcome-grid', ...list.map((e) => h('div.card.clickable', { role: 'button', tabIndex: 0, onclick: () => start(e.id), onkeydown: (event) => { if (event.key === 'Enter') start(e.id); } },
            h('h4', icon('school'), e.title),
            h('p', `${e.topic} · about ${e.minutes} minutes`),
            h('div.tags', ...e.views.map((v) => h('span.badge', v)))))),
        ]),
      ],
    });
  };

  // --- Truth ---------------------------------------------------------------------------------------

  // The attempt's truth: kept since it started, or computed again from its data, generated again
  // and checked against the workspace's files.
  async function truthOf() {
    const ws = store.ws;
    const kept = session.get(ws.id);
    if (kept) return kept;
    const state = ws.exercise;
    const { exerciseById, exerciseAttempt, exerciseTruth } = await lib();
    const ex = exerciseById(state.id);
    const { options, setup } = exerciseAttempt(ex, state.seed);
    const files = ex.truthSamples(setup);
    let generated = null;
    const labels = new Map();
    // A truth that needs no data is still given only to the seed's own files: one is checked.
    const checked = files ?? [ws.samples.find((s) => s.role === 'sample')?.fileName ?? ws.samples[0]?.fileName].filter(Boolean);
    if (checked.length) {
      const progress = progressToast('Making the answer key: generating this attempt\'s data again…');
      try {
        generated = await app.worker('simulate').call('generateExample', { id: ex.example.id, options: { ...options, ...(checked === 'all' ? {} : { samples: checked }) } }, { onProgress: (f) => progress.update(f) });
      } finally {
        progress.done();
      }
      const { sha256 } = await import('../lib/sha256.js');
      for (const file of generated.files) {
        const sample = ws.samples.find((s) => s.fileName === file.name || s.name === stripFCS(file.name));
        if (!sample || (sample.sha256 && sample.sha256 !== sha256(new Uint8Array(file.bytes)))) {
          throw new Error(`${file.name} in this workspace is not the file this exercise made, so it cannot be checked against its answer key.`);
        }
        if (file.meta?.truth?.labels) labels.set(file.name, { labels: file.meta.truth.labels, names: file.meta.truth.names });
      }
    }
    const entry = { truth: exerciseTruth(ex, state.seed, files === null ? null : generated), labels, setup };
    if (store.ws.id !== ws.id) throw new WorkspaceChangedError();
    session.set(ws.id, entry);
    return entry;
  }

  const sampleOfFile = (ws, file) => ws.samples.find((s) => s.fileName === file || s.name === stripFCS(file));

  // Each population question's answer against the true events: measurePopulation's result, with
  // the sets of missed and extra events for the plots.
  async function measures(ex, setup, answers, truth) {
    const { measurePopulation } = await lib();
    const { populationSet } = await import('../lib/engine.js');
    const { EventSet, differenceSets } = await import('../lib/eventset.js');
    const out = {};
    for (const q of ex.questions(setup)) {
      if (q.kind !== 'population' || !answers[q.id]) continue;
      const ws = store.ws;
      const sample = sampleOfFile(ws, truth.events[q.id].sample);
      if (!sample || !ws.gates.some((g) => g.id === answers[q.id])) continue;
      const view = await data.ensure(sample.id);
      const set = populationSet(view, ws, answers[q.id]);
      if (set === undefined) continue;
      const n = view.eventCount;
      const members = set === null ? EventSet.fromIndices(Uint32Array.from({ length: n }, (_, i) => i), n) : set;
      const indices = truth.events[q.id].indices;
      const trueSet = EventSet.fromIndices(Uint32Array.from(indices), n);
      out[q.id] = { ...measurePopulation(members, indices), sampleId: sample.id, gateId: answers[q.id], missed: differenceSets(trueSet, members, n), extra: differenceSets(members, trueSet, n) };
    }
    return out;
  }

  // --- Checking and revealing --------------------------------------------------------------------

  function saveExercise(patch) {
    const state = exercise();
    if (!state) return;
    store.replace({ ...store.ws, exercise: { ...state, ...patch } }, ['exercise']);
  }

  async function check() {
    if (busy) return;
    busy = true;
    render(true);
    const same = store.sameWorkspace();
    try {
      saveDraft();
      const state = exercise();
      const { exerciseById, gradeExercise } = await lib();
      const ex = exerciseById(state.id);
      const { truth, setup } = await truthOf();
      const answers = state.answers;
      const measured = await measures(ex, setup, answers, truth);
      if (!same()) throw new WorkspaceChangedError();
      const graded = gradeExercise(ex, state.seed, answers, truth, measured);
      result = { ...graded, measures: measured };
      saveExercise({ checks: [...state.checks, { at: new Date().toISOString(), score: graded.score, revealed: state.revealed, parts: graded.parts.map((p) => ({ name: p.name, score: p.score })) }] });
    } catch (error) {
      if (!(error instanceof WorkspaceChangedError)) toast(error.message, { kind: 'error' });
    } finally {
      busy = false;
      render(true);
    }
  }

  async function reveal() {
    const state = exercise();
    if (!state.revealed && !(await confirmDialog({ title: 'Reveal the truth?', message: 'The answers and what the simulator planted will show. You can still change your answers and check them, and your checks will say they came after the truth was revealed.', confirm: 'Reveal' }))) return;
    const same = store.sameWorkspace();
    try {
      const { labels } = await truthOf();
      if (!same()) return;
      // The simulator's population of every event, as when an example is opened outside an exercise.
      for (const [file, { labels: column }] of labels) {
        const sample = sampleOfFile(store.ws, file);
        if (sample && column.length === sample.eventCount) data.setDerived(sample.id, 'Truth (simulated)', Float32Array.from(column));
      }
      if (!state.revealed) saveExercise({ revealed: true });
      if (!result) await check();
      else render(true);
    } catch (error) {
      toast(error.message, { kind: 'error' });
    }
  }

  // Missed and extra events of the answered populations, on the plots of their sample once the
  // truth is revealed: [{ indices, color, label }] for plot-view.js.
  app.exerciseOverlays = (sampleId) => {
    if (!exercise()?.revealed || !result?.measures || prefs.get('exerciseOverlays', true) === false) return [];
    const out = [];
    for (const m of Object.values(result.measures)) {
      if (m.sampleId !== sampleId) continue;
      if (m.missed.count) out.push({ indices: m.missed, color: MISSED, label: 'Missed (true, not in your gate)' });
      if (m.extra.count) out.push({ indices: m.extra, color: EXTRA, label: 'Extra (in your gate, not true)' });
    }
    return out;
  };

  // --- The panel ----------------------------------------------------------------------------------

  function saveDraft() {
    const state = exercise();
    if (!state || !Object.keys(draft).length) return;
    saveExercise({ answers: { ...state.answers, ...draft } });
    draft = {};
  }

  function answerOf(id) {
    return id in draft ? draft[id] : exercise()?.answers?.[id];
  }

  function setAnswer(id, value) {
    draft[id] = value;
    saveDraft();
  }

  function input(q) {
    const ws = store.ws;
    const value = answerOf(q.id);
    const label = `${q.label}${q.unit ? ` (${q.unit})` : ''}`;
    const select = (options) => h('select.input.small', { 'aria-label': label, dataset: { question: q.id }, onchange: (e) => setAnswer(q.id, e.target.value || undefined) },
      h('option', { value: '' }, 'Choose…'),
      ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
    let control;
    if (q.kind === 'population') {
      control = select(ws.gates.filter((g) => !g.meta?.helper).map((g) => ({ value: g.id, label: gatePath(ws, g.id) })));
    } else if (q.kind === 'sample') {
      control = select([...ws.samples].sort((a, b) => (a.role === 'sample' ? 0 : 1) - (b.role === 'sample' ? 0 : 1)).map((s) => ({ value: s.name, label: s.name })));
    } else if (q.kind === 'channel') {
      control = select(channelCatalog(ws).filter((c) => c.type === 'fluorescence' && !c.derived).map((c) => ({ value: c.name, label: c.marker ? `${c.name} (${c.marker})` : c.name })));
    } else if (q.kind === 'choice') {
      control = select(q.options);
    } else if (q.kind === 'choices') {
      const chosen = new Set(Array.isArray(value) ? value : []);
      control = h('div.exercise-choices', { role: 'group', 'aria-label': label, dataset: { question: q.id } }, ...q.options.map((o) => h('label.check', h('input', { type: 'checkbox', value: o.value, checked: chosen.has(o.value), onchange: (e) => {
        if (e.target.checked) chosen.add(o.value);
        else chosen.delete(o.value);
        setAnswer(q.id, [...chosen]);
      } }), o.label)));
    } else {
      control = h('input.input.small', { type: 'text', inputMode: 'decimal', value: value ?? '', 'aria-label': label, dataset: { question: q.id }, style: { width: '120px' }, onchange: (e) => setAnswer(q.id, e.target.value.trim() || undefined) });
    }
    return h('label.exercise-question', h('span', label), control);
  }

  function partRow(p) {
    const kind = p.score >= 0.999 ? 'ok' : p.score > 0 ? 'warn' : 'danger';
    return h('li.exercise-part', h(`span.badge.${kind}`, `${Math.round(100 * p.score)}%`), h('div', h('div', p.name), h('div.muted', p.detail)));
  }

  async function render(force = false) {
    const state = exercise();
    if (!state) {
      panel.hidden = true;
      document.getElementById('app').classList.remove('with-exercise');
      signature = '';
      return;
    }
    // The panel is drawn again when the exercise, its progress or what can be chosen changes, not
    // on every edit of the analysis (answers being typed would lose focus).
    const ws = store.ws;
    const sig = [ws.id, state.id, state.seed, state.hints, state.revealed, state.checks.length, busy, prefs.get('exercisePanelOpen', true), ws.gates.map((g) => `${g.id}:${g.name}:${g.parentId}`).join(','), ws.samples.length, ws.derived.length].join('|');
    if (!force && sig === signature) return;
    signature = sig;
    const { exerciseById, exerciseAttempt, EXERCISES_VERSION } = await lib();
    const ex = exerciseById(state.id);
    if (!ex || exercise() !== state) return;
    const { setup } = exerciseAttempt(ex, state.seed);
    const open = prefs.get('exercisePanelOpen', true);
    panel.hidden = false;
    panel.classList.toggle('folded', !open);
    document.getElementById('app').classList.toggle('with-exercise', open);
    clear(panel);
    const toggle = (value) => {
      prefs.set('exercisePanelOpen', value);
      render(true);
    };
    if (!open) {
      panel.append(h('button.exercise-tab', { type: 'button', onclick: () => toggle(true), title: 'Show the exercise' }, icon('school'), h('span', ex.title), state.checks.length ? h('span.badge', `${Math.round(100 * state.checks[state.checks.length - 1].score)}%`) : null));
      return;
    }
    const hints = ex.hints(setup);
    const last = state.checks[state.checks.length - 1];
    panel.append(
      h('div.exercise-head',
        icon('school'),
        h('div', { style: { flex: 1, minWidth: 0 } }, h('div.exercise-kicker', `Exercise · ${LEVELS[ex.level]} · ${ex.topic}`), h('h3', ex.title)),
        h('button.icon-button', { type: 'button', title: 'Fold the exercise away', 'aria-label': 'Fold the exercise away', onclick: () => toggle(false) }, icon('chevronDown'))),
      h('div.exercise-body',
        h('p', ex.brief(setup)),
        state.version !== EXERCISES_VERSION ? h('div.callout.warn', icon('warning'), h('span', 'This exercise was made by another version of CytoWeave; it is checked against its answer key only if its data are unchanged.')) : null,
        hints.slice(0, state.hints).length ? h('ol.exercise-hints', ...hints.slice(0, state.hints).map((text) => h('li', text))) : null,
        state.hints < hints.length ? h('button.btn.small.ghost', { type: 'button', onclick: () => saveExercise({ hints: state.hints + 1 }) }, icon('lightbulb'), `Show a hint (${state.hints + 1} of ${hints.length})`) : null,
        h('div.exercise-questions', ...ex.questions(setup).map(input)),
        h('div.btn-row', { style: { marginTop: '10px' } },
          h('button.btn.small.primary', { type: 'button', disabled: busy, dataset: { action: 'check' }, onclick: () => check() }, icon('check'), busy ? 'Checking…' : 'Check my answers'),
          h('button.btn.small', { type: 'button', disabled: busy, dataset: { action: 'reveal' }, onclick: () => reveal() }, icon('eye'), state.revealed ? 'Show the truth' : 'Reveal the truth')),
        result ? h('div.exercise-result',
          h('div.exercise-score', `${Math.round(100 * result.score)}%`, h('span.muted', last?.revealed ? ' (after the truth was revealed)' : '')),
          h('ul.exercise-parts', ...result.parts.map(partRow))) : last ? h('p.muted', `Last checked: ${Math.round(100 * last.score)}%${last.revealed ? ', after the truth was revealed' : ''}.`) : null,
        state.revealed && result ? truthSection(ex, setup) : null,
        h('div.exercise-foot',
          h('button.btn.small.ghost', { type: 'button', onclick: async () => {
            if (await confirmDialog({ title: 'New data for this exercise?', message: 'A new workspace opens with new data; this one stays in your library with its answers.', confirm: 'New data' })) app.startExercise(state.id).catch((error) => toast(error.message, { kind: 'error' }));
          } }, icon('sparkles'), 'New data'),
          h('button.btn.small.ghost', { type: 'button', onclick: () => app.showExercises() }, icon('school'), 'Other exercises'),
          h('span.muted', { title: 'The class code: the same exercise with this code gives the same data.' }, `Code ${state.seed}`))));
  }

  function truthSection(ex, setup) {
    const kept = session.get(store.ws.id);
    if (!kept) return null;
    const lines = ex.explain(kept.truth, setup);
    const populations = Object.keys(result.measures ?? {}).length;
    return h('div.exercise-truth',
      h('div.section-title', 'What the simulator planted'),
      ...lines.map((line) => h('p', line)),
      populations ? h('label.check', { style: { fontSize: '12px' } },
        h('input', { type: 'checkbox', checked: prefs.get('exerciseOverlays', true) !== false, onchange: (e) => { prefs.set('exerciseOverlays', e.target.checked); store.notify(['exercise', 'overlays']); } }),
        h('span', 'On the plots, color the cells your gate missed ', h('span.exercise-swatch', { style: { background: MISSED } }), ' and those it took in wrongly ', h('span.exercise-swatch', { style: { background: EXTRA } }))) : null,
      h('p.muted', { style: { fontSize: '12px' } }, 'The truth channel, "Truth (simulated)", now holds every event\'s true population: plot it, or color by it in Explore.'));
  }

  store.subscribe((topics) => {
    if (topics.has('workspace-loaded')) {
      draft = {};
      result = null;
      signature = '';
    }
    if (topics.has('ws') || topics.has('exercise') || topics.has('workspace-loaded')) render();
  });
  render();
}
