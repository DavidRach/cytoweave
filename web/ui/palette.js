// The command palette (⌘K): one search over samples, populations, channels and commands.

import { h, icon, clear } from './dom.js';
import { gatePath } from '../lib/workspace.js';

function score(text, query) {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 60;
  const index = t.indexOf(q);
  if (index >= 0) return 40 - Math.min(index, 30) / 2;
  // Subsequence match ("cd4cd8" finds "CD4+ CD8−").
  let j = 0;
  for (let i = 0; i < t.length && j < q.length; i += 1) if (t[i] === q[j]) j += 1;
  return j === q.length ? 10 : 0;
}

export function openPalette(app) {
  const { store } = app;
  const ws = store.ws;
  const entries = [];
  for (const command of app.commands()) entries.push({ kind: 'Command', title: command.label, hint: command.hint ?? '', icon: command.icon ?? 'terminal', run: command.run, keywords: command.keywords ?? '' });
  for (const sample of ws.samples) entries.push({ kind: 'Sample', title: sample.name, hint: sample.meta?.condition ?? '', icon: 'file', run: () => app.selectSample(sample.id) });
  for (const gate of ws.gates) entries.push({ kind: 'Population', title: gate.name, hint: gatePath(ws, gate.id), icon: 'gate', run: () => { app.setMode('gate'); app.selectGate(gate.id); } });
  const channels = new Map();
  for (const sample of ws.samples) for (const c of sample.channels) if (!channels.has(c.name)) channels.set(c.name, c);
  for (const channel of channels.values()) entries.push({ kind: 'Channel', title: channel.marker ? `${channel.marker} (${channel.name})` : channel.name, hint: 'Show in a new plot', icon: 'histogram', run: () => app.plotChannel?.(channel.name) });

  const input = h('input.palette-input', { placeholder: 'Search samples, populations, channels, or type a command…', autofocus: true });
  const results = h('div.palette-results');
  const scrim = h('div.scrim', { style: { placeItems: 'start center' } });
  const box = h('div.dialog.palette', input, results);
  scrim.append(box);
  let active = 0;
  let shown = [];

  const close = () => {
    scrim.remove();
    document.removeEventListener('keydown', keys, true);
  };
  const run = (entry) => {
    close();
    entry?.run();
  };
  const render = () => {
    const q = input.value;
    shown = entries
      .map((entry) => ({ entry, s: Math.max(score(entry.title, q), score(entry.keywords ?? '', q) * 0.8, score(entry.hint, q) * 0.5) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.entry.kind.localeCompare(b.entry.kind))
      .slice(0, 60)
      .map((x) => x.entry);
    active = Math.min(active, Math.max(0, shown.length - 1));
    clear(results);
    shown.forEach((entry, i) => {
      results.append(h(`div.palette-item${i === active ? '.active' : ''}`, { onclick: () => run(entry), onmousemove: () => { if (active !== i) { active = i; render(); } } },
        icon(entry.icon), h('span.kind', entry.kind), h('span.title', entry.title), h('span.hint', entry.hint)));
    });
    if (!shown.length) results.append(h('div.empty', 'Nothing matches.'));
    results.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const keys = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = Math.min(shown.length - 1, active + 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = Math.max(0, active - 1);
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(shown[active]);
    }
  };
  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  scrim.addEventListener('pointerdown', (event) => {
    if (event.target === scrim) close();
  });
  document.addEventListener('keydown', keys, true);
  document.getElementById('overlay-root').append(scrim);
  render();
  setTimeout(() => input.focus(), 10);
}
