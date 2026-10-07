// A minimal Chrome DevTools Protocol driver for the documentation screenshots: starts headless
// Chrome (or Chromium, Edge, Brave; set CHROME to choose), and evaluates scripts, emulates the
// color scheme and captures the page. No dependencies beyond Node 22.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

export function findChrome() {
  const found = process.env.CHROME ?? CANDIDATES.find((path) => existsSync(path));
  if (!found) throw new Error('No Chrome, Chromium, Edge or Brave found; set CHROME to its executable.');
  return found;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// width × height CSS pixels, captured at `scale` device pixels per CSS pixel.
export async function launch({ width = 1600, height = 1000, scale = 1.25, port = 9333 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'cytoweave-capture-'));
  const chrome = spawn(findChrome(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  let page = null;
  for (let i = 0; i < 100 && !page; i += 1) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch { /* not up yet */ }
    if (!page) await sleep(200);
  }
  if (!page) throw new Error('Chrome did not start.');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let next = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method) for (const listener of listeners.get(message.method) ?? []) listener(message.params);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await send('Page.enable');
  await send('Runtime.enable');
  return {
    send,
    // Events of the DevTools protocol (Network.requestWillBeSent, Runtime.exceptionThrown…).
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(listener);
    },
    async goto(url, wait = 2500) {
      await send('Page.navigate', { url });
      await sleep(wait);
    },
    async eval(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async theme(dark) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
    },
    // format: 'jpeg', 'webp' or 'png'; quality for the first two.
    async capture(file, { format = 'jpeg', quality = 86 } = {}) {
      const { data } = await send('Page.captureScreenshot', { format, ...(format === 'png' ? {} : { quality }), captureBeyondViewport: false });
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async close() {
      const exited = new Promise((resolve) => chrome.once('exit', resolve));
      try { await send('Browser.close'); } catch { /* closing */ }
      await Promise.race([exited, sleep(5000)]);
      chrome.kill();
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a temporary folder */ }
    },
  };
}
