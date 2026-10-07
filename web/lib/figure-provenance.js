// Provenance in figures (R5): an exported figure carries what it shows, so it can be traced to,
// checked against, and rebuilt from its analysis.
//
// The record: the figure's layout; each plotted sample (name, file name, SHA-256 checksum, event
// count, channels, the compensation applied; no keywords); every gate the plots depend on (each population's ancestors, the
// gates drawn on the plot, Boolean operands) with their per-sample adjustments and the groups that
// scope them; the compensation matrices and scales; and, per plot, the transforms and event
// count it was drawn with. It is embedded as SVG <metadata>, a PNG iTXt chunk, or a PDF
// attachment ("cytoweave-provenance.json", which PDF readers list as an attached file).
//
// compareProvenance says what changed since in a workspace; rebuildWorkspace makes a workspace
// that redraws the figure from the same files (found in the library by checksum).

import { channelTransform, countOf, population } from './engine.js';
import { transformKey } from './transforms.js';
import { appendLog, createWorkspace, effectiveGeometry, gateAncestors, gateById, gatePath, ROOT } from './workspace.js';
import { crc32 } from './zip.js';

export const PROVENANCE_FORMAT = 'cytoweave-figure-provenance';
export const PROVENANCE_VERSION = 1;
const PNG_KEYWORD = 'CytoWeave provenance';
const PDF_ATTACHMENT = 'cytoweave-provenance.json';

const plotItems = (figure) => (figure?.items ?? []).filter((item) => item.kind === 'plot');
const popId = (id) => (!id || id === ROOT ? ROOT : id);

// The gates a plot depends on: the population's ancestors and itself, the gates drawn on its axes
// (children of the population on those channels), and Boolean operands (with their ancestors).
function gatesFor(ws, item) {
  const ids = new Set();
  const addWithAncestors = (id) => {
    const gate = gateById(ws, id);
    if (!gate || ids.has(gate.id)) return;
    for (const a of gateAncestors(ws, gate.id)) addWithAncestors(a.id);
    ids.add(gate.id);
    if (gate.type === 'boolean') for (const operand of gate.geometry?.operands ?? []) addWithAncestors(operand);
  };
  const pop = popId(item.spec?.populationId);
  if (pop !== ROOT) addWithAncestors(pop);
  const axes = new Set([item.spec?.x, item.spec?.y].filter(Boolean));
  for (const gate of ws.gates) {
    if ((gate.parentId ?? ROOT) !== pop || gate.type === 'boolean') continue;
    if (gate.dims?.length && gate.dims.every((d) => axes.has(d.channel))) addWithAncestors(gate.id);
  }
  return ids;
}

// Builds the provenance record of a figure. context: { views: Map(sampleId → SampleView), version,
// date }. Without a view, a plot's transforms and count are those the workspace states, if any.
export function buildProvenance(ws, figure, context = {}) {
  const items = plotItems(figure);
  const sampleIds = [...new Set(items.map((item) => item.sampleId))];
  const gateIds = new Set();
  for (const item of items) for (const id of gatesFor(ws, item)) gateIds.add(id);
  const gates = ws.gates.filter((g) => gateIds.has(g.id)).map((g) => {
    const overrides = Object.fromEntries(Object.entries(g.overrides ?? {}).filter(([id]) => sampleIds.includes(id)));
    return { ...g, overrides };
  });
  const groupIds = new Set(gates.map((g) => g.scope?.groupId).filter(Boolean));
  const groups = (ws.groups ?? []).filter((g) => groupIds.has(g.id)).map((g) => ({ ...g, sampleIds: g.sampleIds.filter((id) => sampleIds.includes(id)) }));
  const samples = ws.samples.filter((s) => sampleIds.includes(s.id)).map((s) => ({
    id: s.id, name: s.name, fileName: s.fileName, sha256: s.sha256 ?? null, eventCount: s.eventCount,
    datasetIndex: s.datasetIndex ?? 0, channels: s.channels, technology: s.technology, role: s.role,
    meta: s.meta ?? {}, compensationId: s.compensationId ?? 'none',
    // The matrix the plots were drawn with (the file's own, a workspace matrix, or none).
    applied: (() => {
      const comp = context.views?.get(s.id)?.compensation;
      return comp ? { id: comp.id, channels: comp.channels, matrix: Array.from(comp.matrix) } : null;
    })(),
  }));
  const compIds = new Set([
    ...samples.map((s) => s.compensationId),
    ...gates.flatMap((g) => (g.dims ?? []).map((d) => d.compensation)),
  ].filter((id) => id && id !== 'none' && id !== 'file' && id !== 'uncompensated'));
  const compensations = ws.compensations.filter((c) => compIds.has(c.id)).map((c) => ({ id: c.id, name: c.name, channels: c.channels, matrix: Array.from(c.matrix), source: c.source }));
  const channels = new Set(items.flatMap((item) => [item.spec?.x, item.spec?.y]).filter(Boolean));
  for (const g of gates) for (const d of g.dims ?? []) channels.add(d.channel);
  const channelSettings = Object.fromEntries([...channels].filter((c) => ws.channelSettings?.[c]).map((c) => [c, ws.channelSettings[c]]));
  const plots = items.map((item) => {
    const view = context.views?.get(item.sampleId) ?? null;
    const axes = [item.spec?.x, item.spec?.y].filter(Boolean);
    const transforms = Object.fromEntries(axes.map((c) => [c, view ? channelTransform(ws, view, c) : ws.channelSettings?.[c]?.transform ?? null]));
    let events = null;
    if (view) {
      try {
        const members = population(view, ws, popId(item.spec?.populationId));
        events = members === undefined ? null : countOf(members, view);
      } catch { /* left unknown */ }
    }
    const pop = popId(item.spec?.populationId);
    return {
      item: item.id,
      sample: item.sampleId,
      population: pop,
      path: pop === ROOT ? 'All events' : gatePath(ws, pop),
      x: item.spec?.x ?? null,
      y: item.spec?.y ?? null,
      type: item.spec?.type ?? null,
      transforms,
      events,
    };
  });
  return {
    format: PROVENANCE_FORMAT,
    version: PROVENANCE_VERSION,
    software: `CytoWeave${context.version ? ` ${context.version}` : ''}`,
    created: (context.date ?? new Date()).toISOString(),
    workspace: { id: ws.id, name: ws.name },
    figure: { id: figure.id ?? null, name: figure.name ?? 'Figure', width: figure.width, height: figure.height, background: figure.background ?? '#ffffff', items: figure.items ?? [] },
    samples,
    gates,
    groups,
    compensations,
    channelSettings,
    plots,
  };
}

export function isProvenance(record) {
  return record?.format === PROVENANCE_FORMAT && Number.isInteger(record.version) && Array.isArray(record.plots);
}

// --- Embedding --------------------------------------------------------------------------------

// SVG: a <metadata> element right after the opening <svg> tag, holding the JSON in CDATA.
export function embedSVG(svg, record) {
  const json = JSON.stringify(record).replace(/]]>/g, ']]]]><![CDATA[>');
  const open = svg.indexOf('<svg');
  const end = open < 0 ? -1 : svg.indexOf('>', open);
  if (end < 0) throw new Error('Not an SVG document.');
  const block = `<metadata id="cytoweave-provenance"><![CDATA[${json}]]></metadata>`;
  return svg.slice(0, end + 1) + block + svg.slice(end + 1);
}

export function readSVG(text) {
  const match = /<metadata[^>]*id="cytoweave-provenance"[^>]*>([\s\S]*?)<\/metadata>/.exec(text);
  // The JSON may span several CDATA sections (to escape "]]>").
  return match ? parseRecord(match[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : null;
}

function parseRecord(json) {
  try {
    const record = JSON.parse(json);
    return isProvenance(record) ? record : null;
  } catch {
    return null;
  }
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function u32(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

// PNG: an uncompressed iTXt chunk ("CytoWeave provenance", UTF-8 JSON) before IEND.
export function embedPNG(bytes, record) {
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('Not a PNG image.');
  const encoder = new TextEncoder();
  const keyword = encoder.encode(PNG_KEYWORD);
  const text = encoder.encode(JSON.stringify(record));
  // keyword \0 compression flag (0) compression method (0) language \0 translated keyword \0 text
  const data = new Uint8Array(keyword.length + 5 + text.length);
  data.set(keyword, 0);
  data.set(text, keyword.length + 5);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(encoder.encode('iTXt'), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  // Find IEND.
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'IEND') break;
    at += 12 + length;
  }
  if (at + 8 > bytes.length) throw new Error('The PNG image has no IEND chunk.');
  const out = new Uint8Array(bytes.length + chunk.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(bytes.subarray(at), at + chunk.length);
  return out;
}

export function readPNG(bytes) {
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  const decoder = new TextDecoder();
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = u32(bytes, at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'iTXt') {
      const data = bytes.subarray(at + 8, at + 8 + length);
      const nul = data.indexOf(0);
      if (decoder.decode(data.subarray(0, nul)) === PNG_KEYWORD && data[nul + 1] === 0) {
        // Skip compression flag and method, then the language tag and translated keyword.
        let p = nul + 3;
        p = data.indexOf(0, p) + 1;
        p = data.indexOf(0, p) + 1;
        return parseRecord(decoder.decode(data.subarray(p)));
      }
    }
    if (type === 'IEND') break;
    at += 12 + length;
  }
  return null;
}

// PDF: the attachment written by pdf.js (an uncompressed EmbeddedFile stream).
export function pdfAttachment(record) {
  return { name: PDF_ATTACHMENT, mime: 'application/json', description: 'The CytoWeave analysis behind this figure', data: new TextEncoder().encode(JSON.stringify(record)) };
}

export function readPDF(bytes) {
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') return null;
  const text = new TextDecoder('latin1').decode(bytes);
  // The stream dictionary may hold nested dictionaries (/Params << … >>) before "stream".
  const re = /\/Type\s*\/EmbeddedFile\b[\s\S]{0,400}?\/Length\s+(\d+)[\s\S]{0,400}?>>\s*stream\r?\n/g;
  let match;
  while ((match = re.exec(text))) {
    const start = match.index + match[0].length;
    const length = Number(match[1]);
    const record = parseRecord(new TextDecoder().decode(bytes.subarray(start, start + length)));
    if (record) return record;
  }
  return null;
}

// Reads the provenance of an exported figure (SVG text or bytes, PNG or PDF bytes), or null.
export function readFigureProvenance(input) {
  if (typeof input === 'string') return readSVG(input);
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return readPNG(bytes) ?? readPDF(bytes) ?? readSVG(new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024 * 1024))));
}

// --- Checking and rebuilding ------------------------------------------------------------------

const sameNumbers = (a, b, tolerance = 1e-9) => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameNumbers(v, b[i], tolerance));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => sameNumbers(a[k], b[k], tolerance));
  }
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
  return (a ?? null) === (b ?? null);
};

const scaleName = (spec) => (spec ? spec.type : 'none');

// What changed since the figure, plot by plot. context: { views: Map(sampleId → SampleView) } to
// check scales, compensation and event counts too. Returns { sameWorkspace, plots: [{ item,
// sample, path, status: 'unchanged' | 'changed' | 'missing', changes: [text], sampleId and
// populationId (their matches in the workspace) }] }.
export function compareProvenance(record, ws, context = {}) {
  const recordGates = new Map(record.gates.map((g) => [g.id, g]));
  const recordPath = (id) => {
    const names = [];
    let gate = recordGates.get(id);
    const seen = new Set();
    while (gate && !seen.has(gate.id)) {
      seen.add(gate.id);
      names.unshift(gate.name);
      gate = recordGates.get(gate.parentId);
    }
    return names.join(' / ');
  };
  const byPath = new Map(ws.gates.map((g) => [gatePath(ws, g.id), g]));
  const findGate = (id) => gateById(ws, id) ?? byPath.get(recordPath(id)) ?? null;
  const plots = record.plots.map((plot) => {
    const sampleRecord = record.samples.find((s) => s.id === plot.sample);
    const sample = ws.samples.find((s) => s.id === plot.sample && (!sampleRecord?.sha256 || s.sha256 === sampleRecord.sha256))
      ?? (sampleRecord?.sha256 ? ws.samples.find((s) => s.sha256 === sampleRecord.sha256) : null);
    const base = { item: plot.item, sample: sampleRecord?.name ?? plot.sample, path: plot.path };
    if (!sample) return { ...base, status: 'missing', sampleId: null, changes: [`${sampleRecord?.name ?? 'The sample'} is not in this workspace`] };
    const changes = [];
    // The gates behind the plot.
    const relevant = plot.population === ROOT ? [] : [plot.population];
    const deps = new Set();
    const collect = (id) => {
      const g = recordGates.get(id);
      if (!g || deps.has(id)) return;
      deps.add(id);
      if (g.parentId) collect(g.parentId);
      if (g.type === 'boolean') for (const o of g.geometry?.operands ?? []) collect(o);
    };
    relevant.forEach(collect);
    for (const g of record.gates) if ((g.parentId ?? ROOT) === plot.population && g.type !== 'boolean') deps.add(g.id);
    for (const id of deps) {
      const was = recordGates.get(id);
      const now = findGate(id);
      if (!now) {
        changes.push(`"${was.name}" was deleted`);
        continue;
      }
      if (now.name !== was.name) changes.push(`"${was.name}" is now called "${now.name}"`);
      if (!sameNumbers(effectiveGeometry(was, plot.sample), effectiveGeometry(now, sample.id))) changes.push(`"${now.name}" changed${now.overrides?.[sample.id] && !was.overrides?.[plot.sample] ? ' (adjusted for this sample)' : ''}`);
      else if (!sameNumbers(was.dims, now.dims)) changes.push(`the axes or scale of "${now.name}" changed`);
    }
    // Scales, compensation and events, when the sample is loaded.
    const view = context.views?.get(sample.id) ?? null;
    for (const [channel, spec] of Object.entries(plot.transforms ?? {})) {
      const current = view ? channelTransform(ws, view, channel) : ws.channelSettings?.[channel]?.transform ?? null;
      if (spec && current && transformKey(spec) !== transformKey(current)) changes.push(`the scale of ${channel} changed (${scaleName(spec)} → ${scaleName(current)})`);
    }
    if (view) {
      const comp = view.compensation;
      const was = sampleRecord?.applied ?? null;
      if (Boolean(comp) !== Boolean(was) || (comp && was && (!sameNumbers(comp.channels, was.channels) || !sameNumbers(Array.from(comp.matrix), was.matrix, 1e-7)))) changes.push(was && comp ? 'the compensation matrix changed' : comp ? 'the sample is now compensated' : 'the sample is no longer compensated');
      if (plot.events !== null && plot.events !== undefined) {
        const now = findGate(plot.population);
        const members = plot.population === ROOT ? null : now ? population(view, ws, now.id) : undefined;
        const n = members === undefined ? null : countOf(members, view);
        if (n !== null && n !== plot.events) changes.push(`${n.toLocaleString('en-US')} events now, ${plot.events.toLocaleString('en-US')} in the figure`);
      }
    }
    const target = plot.population === ROOT ? ROOT : findGate(plot.population)?.id ?? null;
    return { ...base, status: changes.length ? 'changed' : 'unchanged', sampleId: sample.id, populationId: target, changes };
  });
  return { sameWorkspace: record.workspace?.id === ws.id, plots };
}

// A workspace that redraws the figure: its samples (the files are found in the library by their
// checksums), the gates, groups, matrices and scales the plots depend on, and the figure itself.
export function rebuildWorkspace(record, options = {}) {
  const base = createWorkspace(options.name ?? `${record.figure.name} (rebuilt)`);
  const time = new Date().toISOString();
  return {
    ...base,
    samples: record.samples.map((s) => ({ ...s, keywords: {}, acquisition: {}, diagnostics: [], added: time, hasFileSpillover: s.compensationId === 'file' })),
    groups: record.groups,
    compensations: record.compensations,
    gates: record.gates.map((g) => ({ ...g, meta: { ...(g.meta ?? {}), rebuiltFrom: record.figure.name } })),
    channelSettings: record.channelSettings,
    figures: [{ ...record.figure, id: record.figure.id ?? 'f-rebuilt' }],
    ...appendLog({ provenance: [] }, 'rebuild-figure', `Rebuilt from the figure "${record.figure.name}" exported by ${record.software} on ${record.created}`, time),
  };
}

// The figure placed in a workspace whose samples and populations match the record (the
// comparison's matches), or null when a plot has no match.
export function figureForWorkspace(record, comparison, newId) {
  const byItem = new Map(comparison.plots.map((p) => [p.item, p]));
  if (comparison.plots.some((p) => !p.sampleId || !p.populationId)) return null;
  return {
    ...record.figure,
    id: newId(),
    items: record.figure.items.map((item) => {
      if (item.kind !== 'plot') return { ...item };
      const match = byItem.get(item.id);
      return { ...item, sampleId: match.sampleId, spec: { ...item.spec, populationId: match.populationId } };
    }),
  };
}
