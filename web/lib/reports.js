// Batch reports (R7): a figure layout repeated page after page, over samples or over the values
// of an annotation (subject, timepoint…), written as a multi-page PDF or a PowerPoint deck.
//
// Iterating over samples, the plots of the figure's followed sample (the one most of its plots
// are drawn on, unless chosen) are redrawn on each page's sample; plots of other samples (a
// control, say) stay on every page. Iterating over an annotation, each page is one of its values:
// a plot of a sample with that annotation is redrawn on the page's sample that matches it on the
// annotations telling the figure's samples apart (the "stim" tube of subject 2 where the figure
// shows subject 1's; among several, the one sharing most of its annotations), and plots of
// samples without the annotation stay. Text items fill placeholders: {sample}, {value}, {group},
// {page}, {pages}, {workspace}, {date} and any annotation, {subject} for one. Statistics items
// show columns of a Tables table for the page's samples (those its plots are drawn on), or for
// all of the table's rows.
//
// Every number a report prints is traced: each statistics cell to its table and column, each
// gate label of a plot to the gate's % of parent. The trace goes into the report (a PDF
// attachment, a part of the PowerPoint package) beside the figures' provenance.

import { ROOT, META_FIELDS, gatePath } from './workspace.js';
import { tableCells, tableSamples } from './tables.js';
import { PDFPage, ellipsizeText, textWidth } from './pdf.js';
import { sceneToPDF } from './plot.js';

export const REPORT_FORMAT = 'cytoweave-report';
export const REPORT_VERSION = 1;
export const REPORT_ATTACHMENT = 'cytoweave-report.json';
export const MAX_PAGES = 500;

const plotItems = (figure) => figure.items.filter((item) => item.kind === 'plot');

// The sample most of a figure's plots are drawn on (the first such on a tie), or null.
export function followedSample(figure) {
  const counts = new Map();
  for (const item of plotItems(figure)) counts.set(item.sampleId, (counts.get(item.sampleId) ?? 0) + 1);
  let best = null;
  for (const [id, n] of counts) if (best === null || n > counts.get(best)) best = id;
  return best;
}

// Annotation fields with at least one value: the standard ones first, then the rest.
export function reportFields(ws) {
  const present = new Set(ws.samples.flatMap((s) => Object.entries(s.meta ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k]) => k)));
  return [...META_FIELDS.filter((f) => present.has(f)), ...[...present].filter((f) => !META_FIELDS.includes(f)).sort()];
}

// The samples a report iterates over: a group's, or the experiment's samples (not controls).
export function reportSamples(ws, groupId = null) {
  const group = groupId ? ws.groups.find((g) => g.id === groupId) : null;
  return ws.samples.filter((s) => (group ? group.sampleIds.includes(s.id) : s.role === 'sample' || s.role === 'reference' || !s.role));
}

const metaOf = (sample, field) => {
  const value = sample?.meta?.[field];
  return value === undefined || value === null ? '' : String(value);
};

// Fills {placeholders} in a text item. Unknown names stay as written.
export function fillPlaceholders(text, values) {
  return String(text ?? '').replace(/\{([^{}]+)\}/g, (match, name) => {
    const key = name.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

// The pages of a report. options: { by: null (the figure once), 'sample' or an annotation field;
// groupId; sampleId (the followed sample when iterating over samples); date (Date) }. Each page:
// { index, label, value, sampleIds (the page's samples), items } with plot items on their page's
// samples (or missing: 'why' when no sample matches), text filled, and statistics items with
// rowIds (the samples they list). Returns { by, groupId, followed, pages, notes }.
export function expandReport(ws, figure, options = {}) {
  const by = options.by === undefined ? figure.batch?.by ?? null : options.by;
  const groupId = options.groupId === undefined ? figure.batch?.groupId ?? null : options.groupId;
  const group = groupId ? ws.groups.find((g) => g.id === groupId) : null;
  const sampleById = new Map(ws.samples.map((s) => [s.id, s]));
  const notes = [];
  const candidates = reportSamples(ws, groupId);
  const plots = plotItems(figure);
  let specs; // [{ label, value, sampleIds, mapping: Map(figure sampleId → page sampleId | null), missing: Map(sampleId → why) }]
  let followed = null;
  if (!by) {
    specs = [{ label: figure.name, value: '', sampleIds: [...new Set(plots.map((p) => p.sampleId))], mapping: new Map(), missing: new Map() }];
  } else if (by === 'sample') {
    followed = options.sampleId ?? figure.batch?.sampleId ?? followedSample(figure);
    if (followed && !plots.some((p) => p.sampleId === followed)) followed = followedSample(figure);
    if (!followed) throw new Error('The figure has no plots to repeat for each sample.');
    if (!candidates.length) throw new Error(group ? `The group ${group.name} has no samples.` : 'The workspace has no samples to repeat the figure for.');
    specs = candidates.map((sample) => ({ label: sample.name, value: sample.name, sampleIds: [sample.id], mapping: new Map([[followed, sample.id]]), missing: new Map() }));
  } else {
    // The figure's samples with the annotation follow the iteration.
    const followers = [...new Set(plots.map((p) => p.sampleId))].filter((id) => metaOf(sampleById.get(id), by) !== '');
    if (!followers.length) throw new Error(`None of the figure's plots is on a sample with a "${by}" annotation.`);
    // The annotations telling the followed samples apart decide which sample takes each one's place.
    const otherFields = [...new Set(followers.flatMap((id) => Object.keys(sampleById.get(id)?.meta ?? {})))].filter((f) => f !== by);
    const telling = otherFields.filter((f) => new Set(followers.map((id) => metaOf(sampleById.get(id), f))).size > 1);
    const signature = (sample) => telling.map((f) => metaOf(sample, f)).join('\u0000');
    const describe = (sample) => telling.map((f) => `${f} = ${metaOf(sample, f) || '(none)'}`).join(', ');
    // Followers with the same signature (replicates) take the matching samples in order.
    const slots = new Map();
    for (const id of followers) {
      const key = signature(sampleById.get(id));
      if (!slots.has(key)) slots.set(key, []);
      slots.get(key).push(id);
    }
    const values = [...new Set(candidates.map((s) => metaOf(s, by)).filter((v) => v !== ''))];
    if (!values.length) throw new Error(`No ${group ? `sample of ${group.name}` : 'sample'} has a "${by}" annotation.`);
    // Among the samples that could take a follower's place, the one sharing the most of its other
    // annotations (the unstimulated tube for an unstimulated one), in workspace order on a tie.
    const shared = (sample, id) => otherFields.filter((f) => metaOf(sample, f) !== '' && metaOf(sample, f) === metaOf(sampleById.get(id), f)).length;
    specs = values.map((value) => {
      const members = candidates.filter((s) => metaOf(s, by) === value);
      const mapping = new Map();
      const missing = new Map();
      for (const [key, ids] of slots) {
        const matches = members.filter((s) => signature(s) === key);
        const ranked = matches.map((s, order) => ({ s, order, score: shared(s, ids[0]) })).sort((a, b) => b.score - a.score || a.order - b.order);
        ids.forEach((id, k) => {
          if (ranked[k]) mapping.set(id, ranked[k].s.id);
          else {
            mapping.set(id, null);
            const what = telling.length ? ` with ${describe(sampleById.get(id))}` : '';
            missing.set(id, `No sample of ${by} ${value}${what}`);
            notes.push(`${by} ${value}: no sample${what}; its plot is left empty.`);
          }
        });
        // A choice the annotations did not decide is reported.
        if (ranked.length > ids.length && ranked[ids.length].score === ranked[ids.length - 1].score) {
          const tied = ranked.filter((r) => r.score === ranked[ids.length - 1].score).map((r) => r.s.name);
          notes.push(`${by} ${value}: ${tied.length} samples (${tied.join(', ')}) could take the place of ${ids.map((id) => sampleById.get(id)?.name).join(', ')}; ${ranked.slice(0, ids.length).map((r) => r.s.name).join(', ')} drawn. Annotate what tells them apart to choose.`);
        }
      }
      return { label: `${by} ${value}`, value, sampleIds: members.map((s) => s.id), mapping, missing };
    });
  }
  if (specs.length > MAX_PAGES) throw new Error(`The report would have ${specs.length} pages; at most ${MAX_PAGES} are written. Choose a group of samples.`);
  const date = options.date ?? new Date();
  const fields = reportFields(ws);
  const pages = specs.map((spec, index) => {
    const items = figure.items.map((item) => {
      if (item.kind !== 'plot' || !spec.mapping.has(item.sampleId)) return { ...item };
      const sampleId = spec.mapping.get(item.sampleId);
      return sampleId ? { ...item, sampleId } : { ...item, sampleId: null, missing: spec.missing.get(item.sampleId) };
    });
    const drawn = [...new Set(items.filter((i) => i.kind === 'plot' && i.sampleId).map((i) => i.sampleId))];
    const pageSamples = by ? spec.sampleIds : drawn;
    const shown = (drawn.length ? drawn : pageSamples).map((id) => sampleById.get(id)).filter(Boolean);
    const joined = (list) => [...new Set(list.filter((v) => v !== ''))].join(', ');
    const values = {
      page: String(index + 1),
      pages: String(specs.length),
      sample: by === 'sample' ? spec.value : joined(shown.map((s) => s.name)),
      value: spec.value,
      group: group?.name ?? 'All samples',
      workspace: ws.name ?? '',
      date: date.toISOString().slice(0, 10),
    };
    // Annotations come from the page's samples (the figure's own when it is not repeated).
    const primary = by ? spec.sampleIds.map((id) => sampleById.get(id)) : shown;
    for (const field of fields) {
      const key = field.toLowerCase();
      if (!(key in values)) values[key] = by === field ? spec.value : joined(primary.map((s) => metaOf(s, field)));
    }
    for (const item of items) {
      if (item.kind === 'text') item.text = fillPlaceholders(item.text, values);
      if (item.kind === 'plot' && item.title) item.title = fillPlaceholders(item.title, values);
      if (item.kind === 'stats') {
        const table = ws.tables.find((t) => t.id === item.tableId);
        // The page's samples; the table's rows when asked, or when the page has no samples (a
        // figure of statistics alone).
        const own = drawn.length ? drawn : pageSamples;
        item.rowIds = !table ? [] : item.rows === 'table' || !own.length ? tableSamples(ws, table).map((s) => s.id) : own;
      }
    }
    return { index, label: spec.label, value: spec.value, sampleIds: pageSamples, items };
  });
  return { by, groupId, followed, pages, notes };
}

// The statistics of a report's pages, as shown, and the trace of every number: each statistics
// item gets content { header, rows: [{ sampleId, name, cells: [{ value, text, tag }] }] }.
// viewOf(sampleId) gives loaded views. Returns the trace entries of the statistics cells.
export function fillStatistics(ws, report, viewOf) {
  const trace = [];
  const cellsOf = new Map();
  const sampleById = new Map(ws.samples.map((s) => [s.id, s]));
  for (const page of report.pages) {
    for (const item of page.items) {
      if (item.kind !== 'stats') continue;
      const table = ws.tables.find((t) => t.id === item.tableId);
      if (!table) {
        item.content = { header: [], rows: [], missing: 'The table was deleted.' };
        continue;
      }
      if (!cellsOf.has(table.id)) cellsOf.set(table.id, tableCells(ws, table, viewOf));
      const { columns, cell } = cellsOf.get(table.id);
      const chosen = columns.map((c, j) => ({ ...c, j })).filter((c) => !item.columnIds?.length || item.columnIds.includes(c.column.id));
      const rows = item.rowIds.map((sampleId) => {
        const sample = sampleById.get(sampleId);
        const cells = chosen.map((c) => {
          const out = cell(c.j, sampleId);
          if (Number.isFinite(out.value)) {
            trace.push({ page: page.index + 1, item: item.id, source: 'table', sample: sample?.name ?? '', sampleId, table: table.name, tableId: table.id, column: c.label, columnId: c.column.id, stat: c.column.stat, value: out.value, text: out.text, ...(out.tag ? { status: out.tag } : {}) });
          }
          return out;
        });
        return { sampleId, name: sample?.name ?? '(removed sample)', cells };
      });
      item.content = { table: table.name, header: chosen.map((c) => c.label), stats: chosen.map((c) => c.column.stat), rows };
    }
  }
  return trace;
}

// The trace entries of a plot's gate labels (each a gate's % of parent, as plots print it).
export function plotTrace(ws, page, item, scene) {
  if (!scene) return [];
  const sample = ws.samples.find((s) => s.id === item.sampleId);
  return scene.gates.filter((g) => g.label && Number.isFinite(g.frequency)).map((g) => ({
    page: page.index + 1, item: item.id, source: 'plot', sample: sample?.name ?? '', sampleId: item.sampleId,
    population: gatePath(ws, g.id), gateId: g.id, parent: item.spec.populationId && item.spec.populationId !== ROOT ? gatePath(ws, item.spec.populationId) : 'All events',
    stat: 'freqParent', value: g.frequency, text: g.label,
  }));
}

// --- Statistics item layout ---------------------------------------------------------------------

// Words of a header wrapped into lines of a width (at most three; the last ellipsized).
function wrap(text, width, size, bold) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size, bold) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 3) {
    const kept = lines.slice(0, 3);
    kept[2] = ellipsizeText(`${lines.slice(2).join(' ')}`, width, size, bold);
    return kept;
  }
  return lines.map((l) => ellipsizeText(l, width, size, bold));
}

// Where each piece of a statistics item goes in its box (w × h): a header row of column labels
// (wrapped), a row per sample (name, then values right-aligned, ND and < LLOQ after them), and
// rules. The font shrinks (to 7 px) to fit the rows; rows that still do not fit are left out and
// counted. Measured in Helvetica, which the PDF writes and the canvas and SVG ask for.
export function statsLayout(content, w, h, preferred = 11) {
  const cols = content.header.length;
  const out = { size: preferred, cells: [], rules: [], hidden: 0, height: 0, lineHeight: 0 };
  if (!content.rows) return out;
  let size = preferred;
  let fit;
  for (; size >= 7; size -= 0.5) {
    fit = measure(size);
    if (fit.height <= h) break;
  }
  if (size < 7) {
    size = 7;
    fit = measure(size);
  }
  out.size = size;
  out.lineHeight = size * 1.3;
  // Rows that do not fit are left out.
  const rowH = size * 1.55;
  let rowsShown = content.rows.length;
  while (rowsShown > 0 && fit.headerH + rowsShown * rowH + (rowsShown < content.rows.length ? rowH : 0) > h) rowsShown -= 1;
  out.hidden = content.rows.length - rowsShown;
  const { nameW, colW, headerLines, headerH } = fit;
  // Header
  out.cells.push({ x: 0, y: headerH - size * 0.45, w: nameW, lines: ['Sample'], align: 'left', bold: true, baseline: 'bottom' });
  headerLines.forEach((lines, j) => {
    out.cells.push({ x: nameW + j * colW, y: headerH - size * 0.45 - (lines.length - 1) * out.lineHeight, w: colW, lines, align: 'right', bold: true, baseline: 'bottom' });
  });
  out.rules.push({ x0: 0, y: headerH, x1: w, strong: true });
  content.rows.slice(0, rowsShown).forEach((row, i) => {
    const y = headerH + i * rowH;
    out.cells.push({ x: 0, y: y + rowH / 2, w: nameW - 6, lines: [ellipsizeText(row.name, nameW - 6, size, false)], align: 'left', baseline: 'middle' });
    row.cells.forEach((cell, j) => {
      const text = cell.tag ? `${cell.text} ${cell.tag}` : cell.text;
      out.cells.push({ x: nameW + j * colW, y: y + rowH / 2, w: colW, lines: [ellipsizeText(text, colW - 4, size, false)], align: 'right', baseline: 'middle', muted: !Number.isFinite(cell.value) });
    });
    out.rules.push({ x0: 0, y: y + rowH, x1: w, strong: false });
  });
  if (out.hidden) out.cells.push({ x: 0, y: headerH + rowsShown * rowH + rowH / 2, w, lines: [`+ ${out.hidden} more row${out.hidden === 1 ? '' : 's'}`], align: 'left', baseline: 'middle', muted: true });
  out.height = headerH + (rowsShown + (out.hidden ? 1 : 0)) * rowH;
  Object.assign(out, { nameW, colW, headerH, rowH, rowsShown });
  return out;

  function measure(s) {
    const longest = Math.max(textWidth('Sample', s, true), ...content.rows.map((r) => textWidth(r.name, s, false)));
    const nameW = Math.min(longest + 20, cols ? w * 0.38 : w);
    const colW = cols ? (w - nameW) / cols : 0;
    const headerLines = content.header.map((label) => wrap(label, colW - 4, s, true));
    const headerH = Math.max(1, ...headerLines.map((l) => l.length)) * s * 1.3 + s * 0.6;
    return { nameW, colW, headerLines, headerH, height: headerH + content.rows.length * s * 1.55 };
  }
}

// --- PDF ----------------------------------------------------------------------------------------

function drawArrowPDF(page, item) {
  const y = item.y + item.h / 2;
  page.line(item.x, y, item.x + item.w - 8, y, '#8a93a6', 2);
  page.moveTo(item.x + item.w, y);
  page.lineTo(item.x + item.w - 10, y - 6);
  page.lineTo(item.x + item.w - 10, y + 6);
  page.closePath();
  page.draw({ fill: '#8a93a6' });
}

export function drawStatsPDF(page, item) {
  const content = item.content;
  if (!content || content.missing || !content.rows?.length) {
    page.text(content?.missing ?? 'No samples to list.', item.x + 4, item.y + 4, { size: 11, color: '#8a93a6', baseline: 'top' });
    return;
  }
  const layout = statsLayout(content, item.w, item.h, item.size ?? 11);
  for (const rule of layout.rules) page.line(item.x + rule.x0, item.y + rule.y, item.x + rule.x1, item.y + rule.y, rule.strong ? '#3b4252' : '#d5dae3', rule.strong ? 1 : 0.6);
  for (const cell of layout.cells) {
    cell.lines.forEach((line, k) => {
      const x = cell.align === 'right' ? item.x + cell.x + cell.w - 2 : item.x + cell.x + 2;
      page.text(line, x, item.y + cell.y + k * layout.lineHeight, { size: layout.size, bold: Boolean(cell.bold), color: cell.muted ? '#8a93a6' : '#171b26', align: cell.align, baseline: cell.baseline });
    });
  }
}

// One page of a report as a PDFPage. sceneOf(item) gives a plot item's scene (or null).
export function reportPDFPage(figure, page, sceneOf) {
  const pdf = new PDFPage(figure.width, figure.height);
  pdf.fillRect(0, 0, figure.width, figure.height, figure.background ?? '#ffffff');
  for (const item of page.items) {
    if (item.kind === 'plot') {
      const scene = item.sampleId ? sceneOf(item) : null;
      if (scene) sceneToPDF(pdf, scene, item.x, item.y);
      else {
        pdf.rect(item.x + 0.5, item.y + 0.5, item.w - 1, item.h - 1);
        pdf.draw({ stroke: '#c3c9d4', width: 1, dash: [4, 4] });
        pdf.text(ellipsizeText(item.missing ?? 'The sample is not available', item.w - 16, 11), item.x + item.w / 2, item.y + item.h / 2, { size: 11, color: '#8a93a6', align: 'center', baseline: 'middle' });
      }
    } else if (item.kind === 'text') {
      const size = item.size ?? 14;
      const x = item.x + (item.align === 'center' ? item.w / 2 : item.align === 'right' ? item.w : 0);
      String(item.text).split('\n').forEach((line, i) => pdf.text(line, x, item.y + i * size * 1.25, { size, bold: (item.weight ?? 400) >= 600, color: item.color ?? '#171b26', align: item.align ?? 'left', baseline: 'top' }));
    } else if (item.kind === 'arrow') {
      drawArrowPDF(pdf, item);
    } else if (item.kind === 'stats') {
      drawStatsPDF(pdf, item);
    }
  }
  return pdf;
}

// The report's record embedded with it: what was iterated, each page's samples, the notes and
// the trace of every number.
export function reportRecord(ws, figure, report, trace, context = {}) {
  const name = (id) => ws.samples.find((s) => s.id === id)?.name ?? null;
  return {
    format: REPORT_FORMAT,
    version: REPORT_VERSION,
    created: (context.date ?? new Date()).toISOString(),
    cytoweave: context.version ?? null,
    workspace: ws.name ?? '',
    figure: figure.name,
    by: report.by,
    group: report.groupId ? ws.groups.find((g) => g.id === report.groupId)?.name ?? null : null,
    followed: report.followed ? name(report.followed) : null,
    pages: report.pages.map((p) => ({ page: p.index + 1, label: p.label, samples: p.sampleIds.map(name) })),
    notes: report.notes,
    trace,
  };
}

// A figure with every plot of every page, for the provenance of the report's plots.
export function unionFigure(figure, report) {
  return { ...figure, items: report.pages.flatMap((p) => p.items.filter((i) => i.kind === 'plot' && i.sampleId).map((i) => ({ ...i, id: `${i.id}@${p.index + 1}` }))) };
}

// --- PowerPoint ---------------------------------------------------------------------------------

// One page as slide shapes (pptx.js). pictureOf(item) renders a plot item: { png } or null.
export async function reportSlide(figure, page, pictureOf) {
  const shapes = [];
  for (const item of page.items) {
    if (item.kind === 'plot') {
      const picture = item.sampleId ? await pictureOf(item) : null;
      if (picture) shapes.push({ kind: 'picture', x: item.x, y: item.y, w: item.w, h: item.h, png: picture.png, name: item.title || 'Plot', description: picture.description ?? '' });
      else shapes.push({ kind: 'frame', x: item.x, y: item.y, w: item.w, h: item.h, text: item.missing ?? 'The sample is not available' });
    } else if (item.kind === 'text') {
      const size = item.size ?? 14;
      shapes.push({ kind: 'text', x: item.x, y: item.y, w: item.w, h: Math.max(item.h, size * 1.25 * String(item.text).split('\n').length), paragraphs: String(item.text).split('\n').map((text) => ({ text, size, bold: (item.weight ?? 400) >= 600, color: item.color ?? '#171b26', align: item.align ?? 'left' })) });
    } else if (item.kind === 'arrow') {
      shapes.push({ kind: 'arrow', x: item.x, y: item.y, w: item.w, h: item.h, color: '#8a93a6' });
    } else if (item.kind === 'stats') {
      const content = item.content;
      if (!content || content.missing || !content.rows?.length) {
        shapes.push({ kind: 'text', x: item.x, y: item.y, w: item.w, h: 20, paragraphs: [{ text: content?.missing ?? 'No samples to list.', size: 11, color: '#8a93a6' }] });
        continue;
      }
      const layout = statsLayout(content, item.w, item.h, item.size ?? 11);
      const size = layout.size;
      const rows = [{ h: layout.headerH, cells: [{ text: 'Sample', bold: true, size, rule: 'strong', anchor: 'b' }, ...content.header.map((label) => ({ text: label, bold: true, size, align: 'right', rule: 'strong', anchor: 'b' }))] }];
      for (const row of content.rows.slice(0, layout.rowsShown)) {
        rows.push({ h: layout.rowH, cells: [{ text: row.name, size, rule: 'thin' }, ...row.cells.map((cell) => ({ text: cell.tag ? `${cell.text} ${cell.tag}` : cell.text, size, align: 'right', rule: 'thin', color: Number.isFinite(cell.value) ? '#171b26' : '#8a93a6' }))] });
      }
      shapes.push({ kind: 'table', name: content.table, x: item.x, y: item.y, w: item.w, columns: [layout.nameW, ...content.header.map(() => layout.colW)], rows });
      if (layout.hidden) shapes.push({ kind: 'text', x: item.x, y: item.y + layout.headerH + layout.rowsShown * layout.rowH + 2, w: item.w, h: layout.rowH, paragraphs: [{ text: `+ ${layout.hidden} more row${layout.hidden === 1 ? '' : 's'}`, size, color: '#8a93a6' }] });
    }
  }
  return { shapes, background: figure.background ?? '#ffffff' };
}
