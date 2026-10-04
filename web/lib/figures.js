// The two figures most papers need, as figure pages ({ id, name, width, height, background, items })
// for the Figures view: the gating strategy of a population, and a grid of the same plots across
// samples. Plots in them stay live (they follow gate and compensation changes).

import { newId } from './gates.js';
import { ROOT, gateAncestors, gateById, gatePath } from './workspace.js';

// The gating strategy of a population in one sample: one plot per gate on the path, each showing
// the gate on its parent population, with arrows between them, four to a row.
export function gatingStrategyFigure(ws, gateId, sampleId) {
  const path = [...gateAncestors(ws, gateId), gateById(ws, gateId)].filter((g) => g && g.type !== 'boolean' && g.type !== 'category');
  if (!path.length) throw new Error('The population has no gates to show (Boolean and category gates are not drawn).');
  const perRow = Math.min(4, path.length);
  const w = 330;
  const hgt = 300;
  const gap = 50;
  const rows = Math.ceil(path.length / perRow);
  const width = Math.max(900, 40 + perRow * w + (perRow - 1) * gap + 40);
  const height = 110 + rows * (hgt + 40) + 30;
  const sample = ws.samples.find((s) => s.id === sampleId);
  const items = [
    { id: newId('i'), kind: 'text', x: 40, y: 28, w: width - 80, h: 34, text: `Gating strategy: ${gatePath(ws, gateId)}`, size: 22, weight: 700 },
    { id: newId('i'), kind: 'text', x: 40, y: 64, w: width - 80, h: 24, text: `${sample?.name ?? ''} · ${sample?.acquisition?.cytometer ?? ''}`.replace(/ · $/, ''), size: 13, weight: 400, color: '#5b6475' },
  ];
  path.forEach((gate, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const x = 40 + col * (w + gap);
    const y = 110 + row * (hgt + 40);
    items.push({
      id: newId('i'),
      kind: 'plot',
      x, y, w, h: hgt,
      sampleId,
      spec: { populationId: gate.parentId ?? ROOT, x: gate.dims[0].channel, y: gate.dims[1]?.channel ?? null, type: gate.dims.length === 1 ? 'histogram' : 'pseudocolor', options: {} },
      title: gate.parentId ? gateById(ws, gate.parentId)?.name : 'All events',
      highlight: gate.id,
    });
    if (col < perRow - 1 && i < path.length - 1) items.push({ id: newId('i'), kind: 'arrow', x: x + w + 8, y: y + hgt / 2 - 10, w: gap - 16, h: 20 });
  });
  return { id: newId('f'), name: `Gating strategy – ${gateById(ws, gateId).name}`, width, height, background: '#ffffff', items };
}

// A grid of plots ({ x, y, type, options }) of a population across samples (at most 24), a row
// per sample. groupName labels the title.
export function samplesGridFigure(ws, populationId, plots, samples, groupName = null) {
  if (!plots.length) throw new Error('No plots to lay out.');
  const pop = populationId ?? ROOT;
  const shown = samples.slice(0, 24);
  const cell = 240;
  const width = 160 + plots.length * (cell + 16) + 40;
  const height = 80 + shown.length * (cell + 16) + 20;
  const name = pop === ROOT ? 'All events' : gateById(ws, pop)?.name;
  const items = [{ id: newId('i'), kind: 'text', x: 40, y: 24, w: width - 80, h: 34, text: `${name} across ${groupName ?? 'samples'}`, size: 20, weight: 700 }];
  shown.forEach((sample, r) => {
    items.push({ id: newId('i'), kind: 'text', x: 20, y: 80 + r * (cell + 16) + cell / 2 - 12, w: 130, h: 24, text: sample.name, size: 13, weight: 600, align: 'right' });
    plots.forEach((plot, c) => {
      items.push({ id: newId('i'), kind: 'plot', x: 160 + c * (cell + 16), y: 80 + r * (cell + 16), w: cell, h: cell, sampleId: sample.id, spec: { populationId: pop, x: plot.x, y: plot.y ?? null, type: plot.type ?? (plot.y ? 'pseudocolor' : 'histogram'), options: plot.options ?? {} }, title: '' });
    });
  });
  return { id: newId('f'), name: `${name} across samples`, width, height, background: '#ffffff', items };
}
