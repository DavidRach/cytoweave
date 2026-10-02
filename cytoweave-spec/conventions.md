# CytoWeave engineering conventions

CytoWeave is a flow cytometry analysis workbench. A Go program (stdlib only) serves an embedded
web app; all parsing, computation and rendering run in the browser. The web app must also work
when served as static files by any web server (no Go backend), so nothing in `web/` may assume
the backend exists. License: Apache-2.0. No third-party dependencies, in Go or JavaScript.

## Layout

```
main.go, security.go, local.go, store.go, window.go   Go host (embeds web/)
web/index.html, web/styles.css, web/app.js            app shell
web/lib/*.js          pure modules: no DOM, no globals, importable by Node and by workers
web/lib/*.test.mjs    node:test unit tests, one file per module
web/ui/*.js           DOM components (only these touch document/window)
web/workers/*.js      module workers wrapping heavy lib functions
validation/           comparisons against reference tools (numbers only)
cytoweave-spec/       requirements, design, roadmap, research, these conventions
```

## Code style

- Plain ES modules (`export function …`), modern JavaScript, no build step, no TypeScript.
- Two-space indent, single quotes, semicolons, trailing commas in multi-line literals.
- Comments explain *why* and cite the method (author, year, DOI or tool) where an algorithm
  reimplements a published one. Keep them brief and factual.
- Numerical code uses typed arrays (`Float32Array` for event data, `Float64Array` for
  accumulators and small matrices, `Uint32Array` for event indices, `Int32Array` for labels).
  Avoid per-event object allocation in hot loops.
- Every stochastic function takes `options.seed` (default a fixed number) and uses
  `createRandom(seed)` from `web/lib/random.js`. Results must be deterministic for a seed.
- Long-running functions accept `options.onProgress(fraction, message)` and
  `options.signal` (an AbortSignal-like `{ aborted }`) and check it periodically.
- Errors that a user can fix throw an `Error` with a plain-language message.
- No `console.log` in library code.
- Tests: `node --test "web/lib/*.test.mjs"` must pass; tests are deterministic, run in well
  under a few seconds per file, and check numbers against independently known values
  (hand-computed, published, or reference-tool output) wherever possible, not just "runs".

## Data model

### Event data (from `parseFCS` in `web/lib/fcs.js`)

```js
dataset = {
  version: 'FCS3.1',
  keywords: { '$CYT': 'LSRFortessa', ... },        // upper-cased keys
  parameters: [{ index, name /* $PnN */, label /* $PnS */, marker, type /* 'scatter' |
     'fluorescence' | 'time' | 'instrument' */, range /* $PnR */, bits, amp, gain, ... }],
  eventCount: 123456,
  data: [Float32Array, ...],     // one column per parameter, linear "scale" values
  diagnostics: [{ level: 'info'|'warning'|'error', code, message }],
}
```

Columns are column-major: `dataset.data[p][e]` is parameter `p` of event `e`.

### Populations

A population is a sorted `Uint32Array` of event indices, or `null` meaning every event. Set
operations are in `web/lib/gates.js` (`intersect`, `union`, `difference`).

### Transforms (`web/lib/transforms.js`)

Plain objects: `{ type: 'logicle', T, W, M, A }`, `{ type: 'linear', min, max }`,
`{ type: 'log', min, max }`, `{ type: 'arcsinh', cofactor, max, min }`,
`{ type: 'biex', maxValue, widthBasis, positiveDecades, extraNegativeDecades }`,
`{ type: 'fasinh', T, M, A }`, `{ type: 'hyperlog', T, W, M, A }`. `createTransform(spec)`
returns `{ forward(x) → scale ≈ [0,1], inverse(y), ticks(), key, label }`.

### Compensation

`{ id, name, channels: ['FITC-A', ...], matrix: number[] /* n×n row-major spillover, rows =
fluorochromes, columns = detectors */, source: 'file' | 'computed' | 'manual' | 'imported' }`.
Compensated = raw × S⁻¹ (`web/lib/compensation.js`).

### Gates (`web/lib/gates.js`)

```js
gate = {
  id: 'g…', name: 'Lymphocytes', parentId: null /* root */ | 'g…',
  type: 'rectangle'|'range'|'polygon'|'ellipse'|'quadrant'|'split'|'category'|'boolean',
  dims: [{ channel: 'FSC-A', transform: { type: 'linear', min: 0, max: 262144 } }, ...],
  geometry: { ... },          // in the dims' scale space (transform output), see gates.js
  linkId: 'q…',               // quadrant and split gates that move together
  scope: null | { groupId },  // which samples the gate applies to (null = all)
  overrides: { [sampleId]: geometry },  // sample-specific adjustments
  color: '#3b82f6',
  meta: { origin: 'manual'|'imported'|'auto', method?, note? },
}
// boolean: geometry = { op: 'and'|'or'|'not', operands: [gateId, ...] }
// category: dims = [{ channel: '<derived channel>' }], geometry = { values: [3, 5] }
```

Geometry lives in the gate's own scale space (as Gating-ML 2.0 gates on transformed dimensions),
so a gate keeps its meaning when a plot's axis transform changes.

### Workspace document (JSON, saved as `.cwz` = JSON, optionally gzip)

```js
workspace = {
  format: 'cytoweave-workspace', version: 1,
  id, name, created, modified,             // ISO 8601 timestamps
  samples: [{ id, name, fileName, sha256, size, eventCount, fcsVersion,
              channels: [{ name, label, marker, type, range }], technology,
              keywords: {...}, meta: { condition, subject, batch, timepoint, ... },
              role: 'sample'|'unstained'|'single-stain'|'fmo'|'bead'|'reference',
              stain: 'FITC-A' /* single-stain controls */,
              compensationId: 'none' | '<id>' }],
  groups: [{ id, name, color, sampleIds: [...] }],
  compensations: [ compensation, ... ],
  channelSettings: { [channel]: { transform: spec } },
  gates: [ gate, ... ],
  derived: [{ id, kind, params, seed, inputs, outputs: [channel names], created }],
  figures: [...], tables: [...],
  provenance: [{ time, action, detail }],
}
```

## Workers

Module workers in `web/workers/` import from `../lib/`. Protocol: the page posts
`{ id, type, payload }`; the worker replies `{ id, progress: [fraction, message] }` zero or more
times, then `{ id, result }` or `{ id, error }`. Transfer typed-array buffers instead of copying.

## Performance targets

- Parse a 1 M-event, 30-parameter FCS file in < 1.5 s.
- Gate 1 M events (polygon) in < 30 ms; recompute a 20-gate tree on one sample in < 200 ms.
- Render a 1 M-event pseudocolor plot in < 50 ms.
- UMAP of 50 k events × 30 markers in < 60 s in a worker; FlowSOM of 1 M events in < 30 s.
