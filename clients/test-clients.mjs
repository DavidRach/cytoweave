// Tests the R and Python clients against a running CytoWeave: builds CytoWeave from source, starts
// it with remote control (its connection file in a temporary data folder), opens the page in
// headless Chrome with the PBMC example and its suggested gates, then runs each client's tests,
// which compare the clients' results with the HTTP API's for the same actions.
//
//   node clients/test-clients.mjs [--python] [--r]     (both when neither is named)
//
// Needs Go, Chrome (CHROME=path), Python 3 for the Python client and R with curl, jsonlite and
// testthat for the R client. Exits with status 1 when a test fails.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../docs/capture/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8796;
const only = ['--python', '--r'].filter((flag) => process.argv.includes(flag));
const run = (name) => !only.length || only.includes(`--${name}`);
const temp = mkdtempSync(join(tmpdir(), 'cytoweave-clients-'));
const library = join(temp, 'library');
const out = join(temp, 'out');
mkdirSync(out);

const exec = (command, args, options = {}) => new Promise((done) => {
  const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  child.on('exit', (code) => done(code ?? 1));
  child.on('error', (error) => { console.error(`${command}: ${error.message}`); done(1); });
});

async function startCytoWeave() {
  const binary = join(temp, process.platform === 'win32' ? 'cytoweave.exe' : 'cytoweave');
  if (await exec('go', ['build', '-o', binary, '.'])) throw new Error('go build failed (is Go installed?)');
  const server = spawn(binary, ['--remote-control', '--window', 'none', '--port', String(PORT), '--data-dir', library], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 300; i += 1) {
    const url = /running at (http:\/\/[\d.]+:\d+)/.exec(output)?.[1];
    const token = /X-CytoWeave-Token: (\S+)/.exec(output)?.[1];
    if (url && token && /connect through/.test(output)) {
      try {
        if ((await fetch(`${url}/api/info`)).ok) return { url, token, stop: () => server.kill() };
      } catch { /* starting */ }
    }
    await sleep(200);
  }
  server.kill();
  throw new Error(`CytoWeave did not start:\n${output}`);
}

let failed = 0;
const server = await startCytoWeave();
let browser;
try {
  browser = await launch({ width: 1400, height: 900 });
  await browser.goto(`${server.url}/`);
  const waitFor = async (expression, timeout = 120000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await browser.eval(expression)) return;
      await sleep(500);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  await waitFor('Boolean(window.cytoweave)', 30000);
  const opened = await fetch(`${server.url}/api/remote/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'open_example', args: { id: 'pbmc-immunophenotyping' }, client: 'test-clients' }) }).then((r) => r.json());
  if (!opened.ok) throw new Error(`open_example: ${opened.message}`);
  await waitFor(`window.cytoweave.store.ws.samples.length > 0 && !document.querySelector('.progress-toast')`);
  await browser.eval(`[...document.querySelectorAll('button')].find((e) => e.offsetParent && /Add suggested gates/.test(e.textContent))?.click()`);
  await waitFor(`window.cytoweave.store.ws.gates.some((g) => g.name === 'T cells')`, 30000);
  const env = { ...process.env, CYTOWEAVE_TEST_URL: server.url, CYTOWEAVE_TEST_TOKEN: server.token, CYTOWEAVE_TEST_DIR: out, CYTOWEAVE_DATA_DIR: library };
  for (const key of ['CYTOWEAVE_URL', 'CYTOWEAVE_TOKEN']) delete env[key];
  if (run('python')) {
    console.log('\n--- Python client ---');
    const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const code = await exec(python, ['-m', 'unittest', 'discover', '-s', 'clients/python/tests', '-v'], { env: { ...env, PYTHONPATH: join(ROOT, 'clients/python/src') } });
    if (code) failed += 1;
  }
  if (run('r')) {
    console.log('\n--- R client ---');
    const rlib = join(temp, 'rlib');
    mkdirSync(rlib);
    let code = await exec('R', ['CMD', 'INSTALL', '--no-test-load', `--library=${rlib}`, 'clients/r'], { env });
    if (!code) {
      const script = `.libPaths(c(${JSON.stringify(rlib)}, .libPaths())); library(testthat); results <- as.data.frame(test_dir("clients/r/tests/testthat", package = "cytoweave", load_package = "installed", reporter = "summary", stop_on_failure = FALSE)); if (sum(results$failed) + sum(results$error) > 0) quit(status = 1)`;
      code = await exec('Rscript', ['-e', script], { env });
    }
    if (code) failed += 1;
  }
} catch (error) {
  console.error(error);
  failed += 1;
} finally {
  await browser?.close?.();
  server.stop();
  rmSync(temp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} client test suite(s) failed.` : '\nThe clients\' tests passed.');
process.exit(failed ? 1 : 0);
