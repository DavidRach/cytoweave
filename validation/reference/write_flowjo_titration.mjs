// Writes the titration example's eleven titration tubes and a FlowJo workspace for them to
// validation/cache/flowjo-titration/, for the comparison with FlowJo's statistics
// (reference/flowjo11-titration.json): each sample compensated with its file's matrix, and two
// populations on PE-A split at 1,000, in the empty valley between the CD4-negative and CD4-positive
// cells, so that FlowJo and CytoWeave count the same events. In FlowJo, the median and robust SD
// of Comp-PE-A are added to each sample and to both populations.
//
//   node validation/reference/write_flowjo_titration.mjs

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { titrationTubes } from '../titration-cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'cache', 'flowjo-titration');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const { files, xml } = titrationTubes();
for (const file of files) writeFileSync(join(out, file.name), file.bytes);
writeFileSync(join(out, 'titration.wsp'), xml);
console.log(`wrote ${files.length} FCS files and titration.wsp to validation/cache/flowjo-titration/`);
