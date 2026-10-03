// Writes CytoWeave's FlowJo exports of the validation cases (validation/flowjo-export-cases.mjs)
// to validation/cache/exports/, with their FCS files, so that generate_flowkit.py can evaluate
// them with FlowKit. The export is deterministic: validation/run.mjs builds the same workspaces
// and compares FlowKit's counts with CytoWeave's and with FlowKit's on the original workspaces.
//
//   node validation/reference/write_flowjo_exports.mjs

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtCase, bundledCase, flowKitCases } from '../flowjo-export-cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'cache', 'exports');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const manifest = [];
const slug = (name) => name.replace(/[^\w.-]+/g, '_');
for (const c of [bundledCase(), builtCase(), ...flowKitCases()]) {
  const dir = join(out, slug(c.name.replace(/\.wsp$/, '')));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'export.wsp'), c.xml);
  for (const file of c.files) writeFileSync(join(dir, file.name), file.bytes);
  manifest.push({ name: c.name, kind: c.kind, dir: dir.slice(out.length + 1), source: c.source ?? null });
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
console.log(`wrote ${manifest.length} exported workspaces to validation/cache/exports/`);
