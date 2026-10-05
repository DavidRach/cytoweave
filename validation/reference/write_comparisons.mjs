// Writes the comparison tubes (comparison-cases.mjs) to validation/cache/comparisons/: a negative
// control, a replicate of it, and tests with known positive fractions on FITC-A (CD25), the input
// of reference/generate_flowstats.R (reference/flowstats.json); and comparisons.wsp, the ungated
// tubes as a FlowJo workspace. (FlowJo 11.2 imports it, but has no Population Comparison platform:
// that was a FlowJo 10 feature.)
//
//   node validation/reference/write_comparisons.mjs

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparisonTubes } from '../comparison-cases.mjs';
import { loadSamples } from '../template-cases.mjs';
import { exportFlowJo } from '../../web/lib/flowjo-export.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'cache', 'comparisons');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const tubes = comparisonTubes();
for (const tube of tubes) writeFileSync(join(out, tube.name), tube.bytes);
// A workspace of the ungated tubes, for File > Import FlowJo v10 Workspace.
const { ws } = loadSamples(tubes, 'comparisons for FlowJo');
writeFileSync(join(out, 'comparisons.wsp'), exportFlowJo(ws, { version: 'validation' }).xml);
console.log(`wrote ${tubes.length} FCS files and comparisons.wsp to validation/cache/comparisons/`);
