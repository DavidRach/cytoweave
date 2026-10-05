// Writes the report documents (report-cases.mjs buildReports: a PDF by subject, a PowerPoint deck
// by sample, an Excel workbook and a Prism project) to validation/cache/reports/, with
// manifest.json (each file's SHA-256 and content fingerprint), the input of
// reference/read_reports.py (reference/reports.json) and reference/read_pzfx.R
// (reference/pzfx.json), which read them back with the formats' own readers.
//
//   node validation/reference/write_reports.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReports } from '../report-cases.mjs';
import { fingerprint } from '../document-readers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'cache', 'reports');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const { files } = await buildReports();
const manifest = {};
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(out, name), bytes);
  manifest[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), fingerprint: await fingerprint(bytes) };
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${Object.keys(files).length} documents and manifest.json to validation/cache/reports/`);
