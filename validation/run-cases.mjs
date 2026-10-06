// Headless-run cases (the run suite of headless-run.mjs): the PBMC example's samples written to a
// folder, an annotations table, and the analysis of templates-cases.mjs saved as a template file.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTemplate } from '../web/lib/templates.js';
import { pbmcFiles, sourceAnalysis } from './template-cases.mjs';

// Writes <dir>/fcs/*.fcs, <dir>/annotations.csv and <dir>/panel.cwt. Returns their paths and the
// files and template.
export function writeRunInputs(dir, { scale = 0.1 } = {}) {
  const pbmc = pbmcFiles(scale);
  const { ws } = sourceAnalysis(pbmc);
  const template = buildTemplate(ws, { name: 'PBMC panel', version: 'validation' });
  const fcs = join(dir, 'fcs');
  mkdirSync(fcs, { recursive: true });
  for (const file of pbmc.files) writeFileSync(join(fcs, file.name), file.bytes);
  const annotations = join(dir, 'annotations.csv');
  writeFileSync(annotations, `sample,subject,condition\n${pbmc.files.map((f) => { const [subject, condition] = f.name.replace(/\.fcs$/, '').split('_'); return `${f.name.replace(/\.fcs$/, '')},${subject},${condition}`; }).join('\n')}\n`);
  const templatePath = join(dir, 'panel.cwt');
  writeFileSync(templatePath, JSON.stringify(template, null, 1));
  return { fcs, annotations, template: templatePath, files: pbmc.files, templateValue: template };
}
