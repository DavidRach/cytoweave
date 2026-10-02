// Writes CytoWeave's simulated QC wells (the qc-showcase example: clogs, bubbles, drift and clean
// wells) to validation/cache/simulated/, so that generate_r.R can run R's PeacoQC on them. The
// simulation is deterministic: validation/run.mjs regenerates the same files to compare.
//
//   node validation/reference/write_simulated.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateExample } from '../../web/lib/examples.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = `${here}/../cache/simulated`;
mkdirSync(out, { recursive: true });
const { files } = generateExample('qc-showcase', {});
for (const file of files) writeFileSync(`${out}/${file.name}`, file.bytes);
console.log(`wrote ${files.length} files to validation/cache/simulated/: ${files.map((f) => f.name).join(', ')}`);
