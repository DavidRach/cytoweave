// The complete scene of a plot for export, figures and reports: the population's events on the
// workspace's scales, and its child gates with their names and % of parent (formatted as plots
// label them). The UI adds its colormap; reports and validation call it directly.

import { buildPlotScene } from './plot.js';
import { gateOutline } from './gates.js';
import { channelTransform, countOf, populationSet } from './engine.js';
import { formatPercent } from './stats.js';
import { shownColor } from './colormaps.js';
import { ROOT, channelLabel, effectiveGeometry, gateById, gateChildren } from './workspace.js';

// spec: { populationId, x, y, type, options }; options: { width, height, theme, title, colormap }.
// Each gate in the scene carries its frequency (gate.frequency, % of parent) as well as its label.
export function exportScene(ws, view, spec, options) {
  const dims = [{ channel: spec.x, transform: channelTransform(ws, view, spec.x) }];
  const oneD = !spec.y || spec.type === 'histogram' || spec.type === 'cdf';
  dims.push(oneD ? null : { channel: spec.y, transform: channelTransform(ws, view, spec.y) });
  const indices = populationSet(view, ws, spec.populationId ?? ROOT);
  const xs = view.scaled(spec.x, dims[0].transform);
  const ys = dims[1] ? view.scaled(spec.y, dims[1].transform) : null;
  const parentId = !spec.populationId || spec.populationId === ROOT ? null : spec.populationId;
  const parentCount = countOf(indices, view);
  const gates = [];
  for (const gate of gateChildren(ws, parentId)) {
    if (gate.type === 'boolean' || gate.type === 'category') continue;
    const outline = gateOutline(gate, effectiveGeometry(gate, view.id), dims);
    if (!outline) continue;
    const members = populationSet(view, ws, gate.id);
    const frequency = members === undefined ? Number.NaN : (100 * countOf(members, view)) / (parentCount || 1);
    gates.push({ id: gate.id, outline, name: gate.name, label: members === undefined ? '' : formatPercent(frequency), frequency, color: shownColor(ws, gate), level: 0.55 });
  }
  const popName = gateById(ws, spec.populationId)?.name ?? 'All events';
  return buildPlotScene({
    width: options.width,
    height: options.height,
    type: oneD ? (spec.type === 'cdf' ? 'cdf' : 'histogram') : spec.type,
    x: { channel: spec.x, transform: dims[0].transform, label: channelLabel(ws, spec.x) },
    y: dims[1] ? { channel: spec.y, transform: dims[1].transform, label: channelLabel(ws, spec.y) } : undefined,
    xs,
    ys,
    indices: indices ?? null,
    gates,
    options: { ...(spec.options ?? {}), theme: options.theme, title: options.title ?? popName, colormap: spec.options?.colormap ?? options.colormap, color: shownColor(ws, gateById(ws, spec.populationId)) ?? '#4c78e0' },
  });
}
