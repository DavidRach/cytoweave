// The benchmark harness: CytoWeave as an agent meets it, and the agent under test.
//
// For each run, the harness starts "cytoweave mcp" itself (built from this checkout) with an
// empty library, opens its window in a headless Chrome, prepares the task's workspace there (an
// example generated with the task's seed), and serves the MCP conversation on a local socket.
// The agent is then started as a separate program whose only MCP server is benchmark/mcp-relay.mjs
// on that socket: it works through CytoWeave's tools in the window the harness watches, from an
// empty working folder, and the harness grades the window's state and the agent's answer when it
// is done.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../docs/capture/cdp.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_TIMEOUT = 10 * 60 * 1000;

// A promise that rejects after ms (the browser's work is not stopped; the run is).
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([promise, new Promise((_, fail) => { timer = setTimeout(() => fail(new Error(`${what} within ${Math.round(ms / 1000)} s.`)), ms); })]).finally(() => clearTimeout(timer));
}
const RELAY = join(ROOT, 'benchmark', 'mcp-relay.mjs');

// CytoWeave built from this checkout into a folder: the binary's path.
export async function buildCytoWeave(folder) {
  const binary = join(folder, process.platform === 'win32' ? 'cytoweave.exe' : 'cytoweave');
  await new Promise((done, fail) => spawn('go', ['build', '-o', binary, '.'], { cwd: ROOT, stdio: 'inherit' })
    .on('exit', (code) => (code ? fail(new Error('go build failed (is Go installed?)')) : done())));
  return binary;
}

// One run's CytoWeave: "cytoweave mcp" with its window in a headless Chrome. Returns { url, page
// (code run in the window with app bound), waitFor, mcpConfig (the agent's MCP configuration
// file), workdir (the agent's empty working folder), outputs (a folder the task may name), stop }.
export async function startCytoWeave(binary, options = {}) {
  const temp = mkdtempSync(join(tmpdir(), 'cytoweave-bench-'));
  const workdir = join(temp, 'work');
  const outputs = join(temp, 'outputs');
  mkdirSync(workdir);
  mkdirSync(outputs);
  const mcp = spawn(binary, ['mcp', '--window', 'none', '--data-dir', join(temp, 'library')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let log = '';
  mcp.stderr.on('data', (chunk) => { log += chunk; });
  // The agent's MCP conversation: one connection, relayed to and from cytoweave mcp.
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\cytoweave-bench-${process.pid}-${Date.now()}` : join(temp, 'mcp.sock');
  let connected = false;
  const server = createServer((socket) => {
    if (connected) {
      socket.destroy();
      return;
    }
    connected = true;
    socket.pipe(mcp.stdin, { end: false });
    mcp.stdout.pipe(socket);
    socket.on('error', () => {});
  });
  await new Promise((done) => server.listen(socketPath, done));
  const mcpConfig = join(temp, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { cytoweave: { command: process.execPath, args: [RELAY, socketPath] } } }, null, 1));

  let url = null;
  for (let i = 0; i < 300 && !url; i += 1) {
    url = /(http:\/\/127\.0\.0\.1:\d+)/.exec(log)?.[1] ?? null;
    if (!url) await sleep(100);
  }
  if (!url) {
    mcp.kill();
    throw new Error(`cytoweave mcp did not start: ${log.trim()}`);
  }
  const browser = await launch({ width: options.width ?? 1400, height: options.height ?? 900 });
  await withTimeout(browser.goto(`${url}/`), 60000, 'The CytoWeave window did not open');
  // Every call into the window has a deadline: a browser that hangs must fail the run, not stall
  // the benchmark.
  const page = (code, timeout = PAGE_TIMEOUT) => withTimeout(browser.eval(`(async () => { const app = window.cytoweave; ${code} })()`), timeout, 'The CytoWeave window did not answer');
  const waitFor = async (expression, timeout = 240000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await withTimeout(browser.eval(expression), Math.max(1000, timeout - (Date.now() - start)), 'The CytoWeave window did not answer')) return;
      await sleep(300);
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  await waitFor('Boolean(window.cytoweave?.remote)', 60000);
  const stop = async () => {
    await browser.close().catch(() => {});
    server.close();
    mcp.stdin.end();
    mcp.kill();
    rmSync(temp, { recursive: true, force: true });
  };
  return { url, page, waitFor, mcpConfig, socketPath, workdir, outputs, log: () => log, stop };
}

// An example opened in the window as the task prepares it: generated with the task's options
// (its seed among them), its suggested gates added when asked, and the first stained sample
// selected. Waits until every file is read.
export async function prepareExample(session, { id, options = {}, gates = false }) {
  await session.page(`await app.openExample(${JSON.stringify(id)}, ${JSON.stringify(options)}); return true;`);
  await session.waitFor(`window.cytoweave.store.ws.samples.length > 0 && !document.querySelector('.toast .progress')`);
  if (gates) {
    await session.page(`const { generateExample } = await import('/lib/examples.js');
      const { addGates } = await import('/lib/workspace.js');
      // The suggested gates do not depend on the events: a tiny copy of the example gives them.
      const hints = generateExample(${JSON.stringify(id)}, { ...${JSON.stringify(options)}, scale: 0.01 }).workspaceHints;
      app.store.commit(addGates(app.store.ws, hints.suggestedGates.map((g) => ({ ...g, overrides: {} })), 'add-suggested-gates').ws, 'Add the suggested gates');
      return true;`);
  }
  await sleep(500);
}

// A scripted MCP client on the session's socket, as an agent's program would be (the expert
// reference solutions): call(name, args) resolves with { message, data } or rejects with the
// tool's error.
export async function mcpClient(session, clientName = 'Benchmark expert') {
  const socket = connect(session.socketPath);
  await new Promise((done, fail) => { socket.once('connect', done); socket.once('error', fail); });
  let buffer = '';
  let next = 1;
  const pending = new Map();
  socket.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiting = pending.get(message.id);
      if (!waiting) continue;
      pending.delete(message.id);
      if (message.error) waiting.fail(new Error(message.error.message));
      else waiting.done(message.result);
    }
  });
  const request = (method, params) => new Promise((done, fail) => {
    const id = next++;
    pending.set(id, { done, fail });
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '1' } });
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    async call(name, args = {}) {
      const result = await request('tools/call', { name, arguments: args });
      if (result.isError) throw new Error(`${name}: ${result.content?.[0]?.text ?? 'failed'}`);
      return result.structuredContent ?? { message: result.content?.[0]?.text ?? '' };
    },
    close: () => socket.end(),
  };
}

// The environment of the agent's program: this program's, without what marks a Claude Code session
// (the agent runs as a session of its own, not one nested in another).
function agentEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^CLAUDE_?CODE|^CLAUDECODE$/.test(key)) delete env[key];
  return env;
}

// Agents the harness can run: each turns a run's settings into a command, and its output into
// { answer, turns, toolCalls: [{ name, ok }], usage, costUSD, durationMs, error }.
export const AGENTS = {
  'claude-code': {
    label: 'Claude Code',
    command({ prompt, model, effort, mcpConfig, maxTurns }) {
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json', '--verbose',
        '--mcp-config', mcpConfig, '--strict-mcp-config',
        // No built-in tools (no files, shell or web): CytoWeave's tools only.
        '--tools', '',
        '--allowedTools', 'mcp__cytoweave',
        '--permission-mode', 'dontAsk',
        // Settings of this folder only (an empty one): not the user's hooks, plugins or defaults.
        '--setting-sources', 'project',
        '--disable-slash-commands',
        '--no-session-persistence',
      ];
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      if (maxTurns) args.push('--max-turns', String(maxTurns));
      return { command: 'claude', args };
    },
    parse(stdout) {
      const events = stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);
      const calls = new Map();
      for (const e of events) {
        for (const part of e.message?.content ?? []) {
          if (e.type === 'assistant' && part.type === 'tool_use') calls.set(part.id, { name: part.name.replace(/^mcp__cytoweave__/, ''), input: part.input ?? null, ok: null });
          if (e.type === 'user' && part.type === 'tool_result' && calls.has(part.tool_use_id)) calls.get(part.tool_use_id).ok = !part.is_error;
        }
      }
      const result = events.findLast((e) => e.type === 'result');
      const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
      return {
        answer: result?.result ?? '',
        turns: result?.num_turns ?? null,
        toolCalls: [...calls.values()],
        usage: result?.usage ?? null,
        costUSD: result?.total_cost_usd ?? null,
        durationMs: result?.duration_ms ?? null,
        model: init?.model ?? null,
        tools: init?.tools?.length ?? null,
        mcp: init?.mcp_servers ?? null,
        error: result?.is_error ? result.subtype : null,
        events,
      };
    },
  },
};

// Runs an agent on a prompt against a session; resolves with its parsed output and exit code.
export function runAgent(session, { agent = 'claude-code', prompt, model, effort, maxTurns = 60, timeoutMs = 20 * 60 * 1000 }) {
  const adapter = AGENTS[agent];
  if (!adapter) throw new Error(`Unknown agent ${agent}: ${Object.keys(AGENTS).join(', ')}`);
  const { command, args } = adapter.command({ prompt, model, effort, mcpConfig: session.mcpConfig, maxTurns });
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd: session.workdir, env: agentEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const parsed = adapter.parse(stdout);
      done({ ...parsed, exitCode: code, timedOut: signal === 'SIGTERM' && Date.now() - started >= timeoutMs, wallMs: Date.now() - started, stderr: stderr.slice(-4000) });
    });
  });
}
