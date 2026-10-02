// Downloads the external data of the validation suites into validation/cache/ and checks every
// file against the SHA-256 recorded in validation/sources.json. Files already present and
// intact are not downloaded again.
//
//   node validation/fetch.mjs [dataset …] [--list]
//
// The data are not part of the repository or of the CytoWeave program; sources.json records where
// each data set comes from and its licence.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(`${here}/sources.json`, 'utf8'));
const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith('--'));

if (args.includes('--list')) {
  for (const [name, set] of Object.entries(manifest.datasets)) {
    const bytes = set.files.reduce((sum, f) => sum + f.size, 0);
    console.log(`${name}: ${set.title}, ${set.files.length} files, ${(bytes / 1e6).toFixed(1)} MB\n  ${set.source}\n  ${set.licence}`);
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

async function download(url, file, path) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
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
        await download(set.base + file.path.split('/').map(encodeURIComponent).join('/'), file, path);
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
