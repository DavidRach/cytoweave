// Application state: the workspace (with undo/redo history) and UI state, with change topics so
// components re-render only what changed.

const MAX_HISTORY = 300;

// Work that started in one workspace and finished after another was opened (a run, an agent's
// action, files still being read) must not write into the workspace now open.
export class WorkspaceChangedError extends Error {
  constructor(message = 'Another workspace was opened while this was running, so its result was not added.') {
    super(message);
    this.name = 'WorkspaceChangedError';
  }
}

// A result's per-sample columns for the samples of the workspace now open. Samples removed while
// it ran are left out; when none is left, the result belongs to another workspace opened
// meanwhile, and is refused.
export function presentSamples(ws, perSample) {
  const ids = new Set(ws.samples.map((s) => s.id));
  const kept = new Map([...perSample].filter(([id]) => ids.has(id)));
  if (perSample.size && !kept.size) throw new WorkspaceChangedError();
  return kept;
}

export function createStore(initialWorkspace) {
  const listeners = new Set();
  const state = {
    ws: initialWorkspace,
    past: [],
    future: [],
    labels: { past: [], future: [] },
    ui: {
      mode: 'welcome',
      sampleId: null,
      gateId: null, // selected population (null = all events)
      selectedSamples: new Set(),
      groupFilter: null,
      theme: 'system',
      editScope: 'all', // 'all' samples or 'sample' (this sample's override)
      tool: 'pointer',
      tileSize: 330,
      plotType: 'pseudocolor',
      colormap: 'classic',
      showInspector: true,
      showSidebar: true,
      expanded: new Set(),
      backgate: false,
    },
    saved: initialWorkspace,
    busy: new Map(),
    // Counts workspaces loaded (reset): views keep state for one workspace and start afresh when
    // it changes, even if they were not shown when it did.
    generation: 0,
  };

  let pending = new Set();
  let scheduled = false;
  const notify = (topics) => {
    for (const topic of topics) pending.add(topic);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const topics = pending;
      pending = new Set();
      for (const listener of listeners) {
        try {
          listener(topics, state);
        } catch (error) {
          console.error(error);
        }
      }
    });
  };

  return {
    state,
    get ws() {
      return state.ws;
    },
    get ui() {
      return state.ui;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify,
    // Replaces the workspace with an edited one, recording it for undo.
    commit(next, label = 'Edit', topics = ['ws']) {
      if (!next || next === state.ws) return;
      // A workspace built from another one (captured before that one was replaced).
      if (next.id !== state.ws.id) throw new WorkspaceChangedError();
      state.past.push(state.ws);
      state.labels.past.push(label);
      if (state.past.length > MAX_HISTORY) {
        state.past.shift();
        state.labels.past.shift();
      }
      state.future = [];
      state.labels.future = [];
      state.ws = next;
      notify(['ws', 'history', ...topics]);
    },
    // Replaces the workspace without an undo step (loading, background results).
    replace(next, topics = ['ws']) {
      if (next.id !== state.ws.id) throw new WorkspaceChangedError();
      state.ws = next;
      notify(['ws', ...topics]);
    },
    // A check that the workspace open now is still open later: () => true until another is loaded.
    sameWorkspace() {
      const generation = state.generation;
      return () => state.generation === generation;
    },
    reset(next) {
      state.generation += 1;
      state.ws = next;
      state.past = [];
      state.future = [];
      state.labels = { past: [], future: [] };
      state.saved = next;
      notify(['ws', 'history', 'workspace-loaded']);
    },
    canUndo: () => state.past.length > 0,
    canRedo: () => state.future.length > 0,
    undoLabel: () => state.labels.past[state.labels.past.length - 1] ?? '',
    redoLabel: () => state.labels.future[state.labels.future.length - 1] ?? '',
    undo() {
      if (!state.past.length) return null;
      state.future.push(state.ws);
      const label = state.labels.past.pop();
      state.labels.future.push(label);
      state.ws = state.past.pop();
      notify(['ws', 'history']);
      return label;
    },
    redo() {
      if (!state.future.length) return null;
      state.past.push(state.ws);
      const label = state.labels.future.pop();
      state.labels.past.push(label);
      state.ws = state.future.pop();
      notify(['ws', 'history']);
      return label;
    },
    setUI(patch, topics = ['ui']) {
      Object.assign(state.ui, patch);
      notify(topics);
    },
    markSaved(ws = state.ws) {
      state.saved = ws;
      notify(['saved']);
    },
    isDirty: () => state.saved !== state.ws,
    setBusy(key, message) {
      if (message) state.busy.set(key, message);
      else state.busy.delete(key);
      notify(['busy']);
    },
  };
}
