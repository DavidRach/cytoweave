# CytoWeave UI conventions (for building views)

Read `conventions.md` first. This document describes how the browser UI is put together so a new
view ("mode") fits in. Study these files before writing one:

- `web/app.js` — bootstrap, the `MODES` list (each mode is lazily imported), shortcuts, import.
- `web/ui/mode-tables.js` — a complete, mid-sized mode: the best template to copy.
- `web/ui/mode-gate.js` and `web/ui/plot-view.js` — the gating workbench and interactive plots.
- `web/ui/actions.js` — shared actions (`app.saveDerived`, `app.exportPlot`, dialogs).
- `web/ui/dom.js`, `web/ui/overlays.js`, `web/ui/icons.js` — helpers you must use.
- `web/styles.css` — the design system; reuse its classes, add new rules sparingly at the end of
  the file under a comment naming your mode (light and dark both come from the CSS variables).

## The mode contract

`web/ui/mode-<name>.js` exports `mount<Name>Mode(app, container)`, which appends its root element
to `container` and returns `{ update(topics), destroy() }`. `update` receives a `Set` of change
topics after any state change; re-render only what those topics affect:

| Topic | Meaning |
| --- | --- |
| `ws` | the workspace changed (any edit, undo, redo) |
| `data` | a sample finished loading, or derived channels were attached |
| `sample` / `gate` | the selected sample / population changed (`store.ui.sampleId`, `store.ui.gateId`) |
| `selection` | sample multi-selection or group filter changed |
| `theme` | light/dark switched: redraw canvases |
| `derived`, `tables`, `plots`, … | narrower topics some actions add |

`destroy` must remove the root element and stop timers, observers and pending worker jobs.

Typical layout (copy from mode-tables.js):

```js
const root = h('div.view',
  h('div.workbench-head', h('h1', icon('qc'), 'Quality control'), h('span.spacer'), ...actions),
  h('div.view-body', h('div.split', leftPanes, rightPanes)));
container.append(root);
```

Panes are `h('div.pane', h('h3', 'Title'), content)`. Use `.btn`, `.btn.primary`, `.btn.small`,
`.icon-button`, `.input`, `select.input`, `.field` (label + control), `.check`, `.segmented`,
`.badge(.ok|.warn|.danger|.accent)`, `.callout(.warn|.danger|.ok|.accent)`, `table.data`,
`.kv` (definition list), `.stat-grid/.stat-tile`, `.empty` (empty state with icon, h3, p),
`.section-title`, `.welcome-grid` + `.card` for galleries, `.progress`.

## The app object

- `app.store`: `store.ws` (the immutable workspace), `store.ui` (UI state), `store.commit(nextWs,
  label, topics)` records an undoable edit; `store.replace(nextWs)` changes without undo;
  `store.setUI(patch, topics)`; `store.notify(topics)`; `store.subscribe`.
- `app.data`: `data.view(sampleId)` → a loaded `SampleView` (see `web/lib/engine.js`) or null;
  `await data.ensure(sampleId)` loads it; `view.column(channel)` gives linear (compensated)
  values; `view.scaled(channel, transformSpec)` gives display-scale values (cached);
  `view.parameters`, `view.eventCount`, `view.channelInfo(name)`, `view.derived` (Map).
- Populations: `population(view, ws, gateId)` from `web/lib/engine.js` → sorted `Uint32Array`,
  `null` (all events) or `undefined` (does not apply). `ROOT` (`'root'`) is all events.
- Channel scales: `channelTransform(ws, view, channel)` → the transform spec to plot it with;
  `channelLabel(ws, channel, { short })` → "CD3 · FITC-A" or "CD3".
- Workers: `app.worker('<name>')` returns a client for `web/workers/<name>-worker.js`;
  `const job = client.run(type, payload, { transfer, onProgress })` → `{ promise, cancel }`;
  `client.call(...)` returns just the promise. Wrap long jobs in
  `progressToast(message, onCancel)` from overlays.js (`update(fraction, note)`, `done(note)`,
  `fail(note)`).
- Results: `await app.saveDerived({ kind, name, method, params, seed, outputs: [channels],
  perSample: Map(sampleId → { channel: Float32Array }), summary })` attaches per-event derived
  channels (cluster labels, embedding coordinates, QC masks, unmixed abundances), persists them
  and records the method, parameters and seed in `ws.derived`. Derived channels then work like
  any channel: plots, gates (a `category` gate selects cluster labels; QC masks are 0/1), tables.
- Navigation: `app.setMode(id)`, `app.selectSample(id)`, `app.selectGate(id)`.
- Plots: for an interactive gating plot use `createPlotView(app, { spec: { id, populationId, x, y,
  type, options }, sampleId, compact, hideActions, height, onChange })` (`web/ui/plot-view.js`).
  For static plots build a scene with `buildPlotScene` and draw it with `drawScene` (see
  `web/lib/plot.js`; raster images come from `new ImageData(raster.rgba, w, h)` on an
  OffscreenCanvas, as plot-view.js's `imageFromRaster`). For bespoke charts (heatmaps, bar/dot
  plots, line tracks) draw on a `<canvas>` scaled by `devicePixelRatio`, reading colors from CSS
  variables via `getComputedStyle(document.documentElement).getPropertyValue('--text')`, and
  redraw on the `theme` topic. Colormaps: `web/lib/colormaps.js` (`colormapLUT`,
  `colormapColor`, `categoricalColor`, `CATEGORICAL`).
- Overlays: `showMenu(anchor, items)`, `showDialog({ title, content, buttons, width })`,
  `confirmDialog`, `promptDialog`, `toast(message, { kind })`.

## Principles

- The analysis runs in workers; the page stays responsive. Show progress and allow cancelling.
- Nothing is destructive or silent: algorithms propose, the user accepts. Explain each result in
  plain language next to it (what was done, with which parameters, what it means, caveats).
- Every computed result records method, parameters, seed and software version (via
  `saveDerived` or the workspace's provenance).
- Empty states teach: say what the view does and what to do first.
- Keep text plain and specific; no marketing language.
- Do not edit other modules' files except to add your mode's CSS at the end of `styles.css`. If
  you need a change elsewhere, describe it in your final report.
