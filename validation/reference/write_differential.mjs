// Writes the input of reference/generate_diffcyt.R to validation/cache/differential/: the limma
// cases (differential-cases.mjs) as limma-cases.json, and for each mass cytometry experiment its
// cells as FCS files (with the true population as a "cluster" channel), experiment_info.csv,
// marker_info.csv (the markers CytoWeave proposes, as state markers) and design.json.
//
//   node validation/reference/write_differential.mjs
//   Rscript validation/reference/generate_diffcyt.R

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeExperiment, limmaCases, stateExperiments } from '../differential-cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'cache', 'differential');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const finite = (key, value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value);
writeFileSync(join(out, 'limma-cases.json'), JSON.stringify(limmaCases(), finite));
const csv = (rows) => `${rows.map((r) => r.map((v) => (/[",]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n')}\n`;
for (const experiment of stateExperiments()) {
  const folder = join(out, experiment.name);
  mkdirSync(folder);
  for (const file of experiment.files) writeFileSync(join(folder, file.name), file.bytes);
  const { markers, views } = analyzeExperiment(experiment);
  writeFileSync(join(folder, 'experiment_info.csv'), csv([['sample_id', 'group_id', 'subject_id', 'batch_id', 'file'], ...experiment.samples.map((s) => [s.name.replace(/\.fcs$/, ''), s.group, s.subject, s.batch, s.name])]));
  const marker = new Set(markers);
  writeFileSync(join(folder, 'marker_info.csv'), csv([['channel_name', 'marker_name', 'marker_class'], ...views[0].parameters.map((p) => [p.name, p.name, marker.has(p.name) ? 'state' : 'none'])]));
  writeFileSync(join(folder, 'design.json'), JSON.stringify({ levels: experiment.levels, contrast: experiment.contrast, design: [experiment.pairField ? 'subject_id' : null, ...experiment.covariates.map((c) => `${c}_id`)].filter(Boolean), clusters: experiment.clusters.length }));
}
console.log('wrote validation/cache/differential/');
