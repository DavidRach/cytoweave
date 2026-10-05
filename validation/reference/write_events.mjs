// Writes the events documents (event-cases.mjs buildEventDocuments: concatenated and downsampled
// FCS files, a ZIP of FCS files and two AnnData files) to validation/cache/events/ with
// manifest.json (each file's SHA-256), the input of reference/read_events.py
// (reference/events.json), which reads them back with anndata, h5py, pyfive, fcsparser and FlowIO.
//
//   node validation/reference/write_events.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEventDocuments } from '../event-cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'cache', 'events');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const { files } = await buildEventDocuments();
const manifest = {};
for (const [name, bytes] of Object.entries(files)) {
  writeFileSync(join(out, name), bytes);
  manifest[name] = { sha256: createHash('sha256').update(bytes).digest('hex') };
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${Object.keys(files).length} documents and manifest.json to validation/cache/events/`);
