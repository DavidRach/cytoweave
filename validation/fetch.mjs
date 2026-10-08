// Downloads the external data of the validation suites into validation/cache/ and checks every
// file against the SHA-256 recorded in validation/sources.json. Files already present and
// intact are not downloaded again.
//
//   node validation/fetch.mjs [dataset …] [--list]
//
// The data are not part of the repository or of the CytoWeave program; sources.json records where
// each data set comes from and its license.
//
// A file can be part of a larger download: "range": [first, last] fetches those bytes only (the
// TEXT segment of a 900 MB FCS file), and with "zipEntry": true the bytes are one entry of a ZIP
// archive (its local header and compressed data), which is inflated (a file of a 2 GB archive).
// With "events": n as well, the range holds only the start of the entry's compressed data, and
// the file kept is the first n events of the FCS file it starts (fcs-subset.mjs).

import { createHash } from 'node:crypto';
import { constants as zlibConstants, inflateRawSync } from 'node:zlib';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { subsetFCS } from './fcs-subset.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(`${here}/sources.json`, 'utf8'));
const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith('--'));

if (args.includes('--list')) {
  for (const [name, set] of Object.entries(manifest.datasets)) {
    const bytes = set.files.reduce((sum, f) => sum + f.size, 0);
    console.log(`${name}: ${set.title}, ${set.files.length} files, ${(bytes / 1e6).toFixed(1)} MB\n  ${set.source}\n  ${set.license}`);
  }
  process.exit(0);
}

for (const name of names) {
  if (!manifest.datasets[name]) {
    console.error(`Unknown data set ${name}. Data sets: ${Object.keys(manifest.datasets).join(', ')}`);
    process.exit(2);
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function intact(path, file) {
  try {
    const bytes = await readFile(path);
    return bytes.length === file.size && sha256(bytes) === file.sha256;
  } catch {
    return false;
  }
}

// The data of the ZIP entry whose local header starts `bytes` (stored or deflated); with partial,
// as much as the bytes given hold (the start of a large entry).
function zipEntry(bytes, partial = false) {
  if (bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('the range does not start with a ZIP entry');
  const method = bytes.readUInt16LE(8);
  const compressed = bytes.readUInt32LE(18);
  const start = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  // A size of 0 or 0xFFFFFFFF in the local header means it is given elsewhere (a data descriptor
  // after the data, or ZIP64): the range then ends where the entry does.
  const sized = compressed !== 0 && compressed !== 0xffffffff;
  const data = partial || !sized ? bytes.subarray(start) : bytes.subarray(start, start + compressed);
  if (!partial && sized && data.length !== compressed) throw new Error('the range ends before the ZIP entry does');
  if (method === 0) return Buffer.from(data);
  if (method === 8) return partial ? inflateRawSync(data, { finishFlush: zlibConstants.Z_SYNC_FLUSH }) : inflateRawSync(data);
  throw new Error(`ZIP compression method ${method} is not supported`);
}

async function download(url, file, path) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // Some hosts (Zenodo) refuse requests without an identifying user agent.
      const headers = { 'User-Agent': 'CytoWeave-validation (+https://github.com/robert-mcdermott/cytoweave)' };
      if (file.range) headers.Range = `bytes=${file.range[0]}-${file.range[1]}`;
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let bytes = Buffer.from(await response.arrayBuffer());
      if (file.range && bytes.length !== file.range[1] - file.range[0] + 1) throw new Error(`the server did not return bytes ${file.range[0]}–${file.range[1]} (got ${bytes.length} bytes)`);
      if (file.zipEntry) bytes = zipEntry(bytes, Boolean(file.events));
      if (file.events) bytes = subsetFCS(bytes, file.events);
      const digest = sha256(bytes);
      if (bytes.length !== file.size || digest !== file.sha256) throw new Error(`checksum mismatch (got ${bytes.length} bytes, SHA-256 ${digest})`);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.part`, bytes);
      await rename(`${path}.part`, path);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${url}: ${lastError.message}`);
}

let failures = 0;
for (const [name, set] of Object.entries(manifest.datasets)) {
  if (names.length && !names.includes(name)) continue;
  const root = `${here}/cache/${name}`;
  const queue = [...set.files];
  let fetched = 0;
  let present = 0;
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const path = `${root}/${file.path}`;
      if (await intact(path, file)) {
        present += 1;
        continue;
      }
      try {
        // A file's own url, or the data set's base followed by its path.
        await download(file.url ?? set.base + file.path.split('/').map(encodeURIComponent).join('/'), file, path);
        fetched += 1;
      } catch (error) {
        failures += 1;
        console.error(`✗ ${name}: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`${failures ? '✗' : '✓'} ${name}: ${fetched} downloaded, ${present} already present (${set.title})`);
}
if (failures) process.exit(1);
