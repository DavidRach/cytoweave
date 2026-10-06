// Writes the input of reference/generate_curves.R to validation/cache/curves/: synthetic curves
// (cases.json: four- and five-parameter, rising and falling, replicates, zero doses, weights and
// fixed asymptotes), the drug-screen example's % CD69+ per compound (screen.json) and the
// bead-immunoassay example's standards and sera MFIs per analyte (beads.json), as CytoWeave
// measures them, each with CytoWeave's fit. generate_curves.R fits them with drc (and beadplexr),
// from drc's own starting values and from CytoWeave's estimate, and adds beadplexr's own LEGENDplex
// analysis of its package data.
//
//   node validation/reference/write_curves.mjs
//   Rscript -e 'install.packages(c("drc", "beadplexr"))'
//   Rscript validation/reference/generate_curves.R

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beadInput, curveCases, screenInput, startOf } from '../curve-cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'cache', 'curves');
mkdirSync(out, { recursive: true });
const finite = (key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value);
// With CytoWeave's own fits, from which drc is also started (to compare the same optimum).
const cases = curveCases().map((k) => ({ ...k, start: startOf(k.x, k.y, k.model, k.weighting, k.fixed) }));
const screen = screenInput();
for (const c of screen.compounds) c.start = startOf(c.x, c.y, 'LL.4');
screen.normalized.start = startOf(screen.normalized.x, screen.normalized.y, 'LL.4', 'none', { c: 0, d: 100 });
const beads = beadInput();
for (const list of Object.values(beads)) {
  for (const a of list) {
    const x = a.standards.map((s) => s.concentration);
    const y = a.standards.map((s) => s.mfi);
    a.start = startOf(x, y, 'LL.5');
    a.startWeighted = startOf(x, y, 'LL.5', '1/y2');
  }
}
writeFileSync(join(out, 'cases.json'), JSON.stringify(cases, finite));
writeFileSync(join(out, 'screen.json'), JSON.stringify(screen, finite));
writeFileSync(join(out, 'beads.json'), JSON.stringify(beads, finite));
console.log(`Wrote the curve inputs to ${out}.`);
