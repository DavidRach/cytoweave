// Review reports (R9): an analysis as one self-contained HTML file that a PI, a collaborator or a
// reviewer opens in any browser, without CytoWeave: the samples with their checksums, the gating
// hierarchy, every sample's gates drawn on its own events, the workspace's figures and tables,
// the saved comparisons, the methods, MIFlowCyt and the change log.
//
// Every number in it is traced: click one to see where it comes from (the sample and its file's
// SHA-256, the population and each gate above it, the statistic, the counts behind a percentage,
// the comparison's test). The numbers are computed from the files with the code certificates use
// (certificate.js), so a report and a certificate of the same analysis print the same numbers;
// each carries data-k (its key, as numberItems keys it) and data-v (its exact value) for checking.
//
// The file loads nothing: styles and the trace script are inline, plots are inline SVG with their
// event rasters as PNG data URIs, and links (DOIs) are only followed when clicked.

import { computeNumbers, encodeNumber, jsEngine, miflowcytRecord } from './certificate.js';
import { escapeXML, figureItemScene, figurePageSVG } from './figure-svg.js';
import { encodePNG } from './png.js';
import { exportScene } from './scene.js';
import { sceneToSVG } from './plot.js';
import { expandReport, fillStatistics } from './reports.js';
import { formatPercent, formatStatistic } from './stats.js';
import { columnDefinition, LIMIT_TAGS } from './tables.js';
import { writeMethods } from './methods.js';
import { DESIGN_LABEL, TESTS } from './compare.js';
import { ROOT, channelLabel, gateById, gatePath, verifyLog } from './workspace.js';

export const REVIEW_FORMAT = 'cytoweave-review';
export const REVIEW_VERSION = 1;
const PLOT_W = 250;
const PLOT_H = 230;

const html = (text) => escapeXML(text).replace(/"/g, '&quot;');
const count = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
const plural = (n, word, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;
const asNumber = (v) => (typeof v === 'number' ? v : v === 'NaN' ? Number.NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : null);

function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

async function rasterHref(raster) {
  return `data:image/png;base64,${base64(await encodePNG(raster.rgba, raster.width, raster.height))}`;
}

// A traced number: a button (keyboard-reachable) whose text is the number as shown.
function num(key, value, text, extra = '') {
  return `<button type="button" class="n${extra ? ` ${extra}` : ''}" data-k="${html(key)}" data-v="${html(JSON.stringify(encodeNumber(value)))}">${html(text)}</button>`;
}

// The gates in tree order (depth first), without Boolean and category gates (not drawn).
function treeOrder(ws) {
  const out = [];
  const walk = (parentId) => {
    for (const gate of ws.gates.filter((g) => (g.parentId ?? null) === parentId)) {
      out.push(gate);
      walk(gate.id);
    }
  };
  walk(null);
  return out;
}

// One plot per parent population and pair of channels, with every gate drawn on them.
export function gatePlots(ws) {
  const groups = new Map();
  for (const gate of treeOrder(ws)) {
    if (gate.type === 'boolean' || gate.type === 'category' || !gate.dims?.length) continue;
    const x = gate.dims[0].channel;
    const y = gate.dims[1]?.channel ?? null;
    const key = `${gate.parentId ?? ROOT}|${x}|${y}`;
    if (!groups.has(key)) groups.set(key, { parentId: gate.parentId ?? ROOT, x, y, type: y ? 'pseudocolor' : 'histogram', gateIds: [] });
    groups.get(key).gateIds.push(gate.id);
  }
  return [...groups.values()];
}

// The samples whose gates are drawn: options.plots 'all' (default) or 'none'; controls only with
// options.includeControls.
function plottedSamples(ws, options) {
  if (options.plots === 'none') return [];
  return ws.samples.filter((s) => options.includeControls || s.role === 'sample' || s.role === 'reference').map((s) => s.id);
}

// Cells of a table as tableCells gives them, from the numbers computed (for figures' statistics).
function cellsFromNumbers(ws, numbers) {
  return (table) => {
    const t = numbers.tables.find((x) => x.id === table.id);
    const bySample = new Map((t?.samples ?? []).map((s) => [s.id, s]));
    return {
      columns: table.columns.map((column, j) => ({ column, label: t?.columns[j] ?? '', limits: null })),
      cell: (j, sampleId) => {
        const row = bySample.get(sampleId);
        const value = row ? asNumber(row.values[j]) ?? Number.NaN : Number.NaN;
        const status = row?.status[j] ?? null;
        return { value, text: formatStatistic(table.columns[j].stat, value), status, tag: status ? LIMIT_TAGS[status] ?? '' : '' };
      },
    };
  };
}

// --- Building ------------------------------------------------------------------------------------

// Builds the review report of a workspace. source: as for buildCertificate ({ fcs(sample),
// derived(sha256) }). options: { version, date, engine, plots ('all' or 'none'), includeControls,
// colormap, onProgress }. Returns { html, model, warnings }.
export async function buildReviewReport(ws, source, options = {}) {
  const version = options.version ?? 'unknown';
  const date = options.date ?? new Date();
  const plotted = new Set(plottedSamples(ws, options));
  const groups = gatePlots(ws);
  const plots = new Map();
  const figures = (ws.figures ?? []).map((fig) => ({ fig, page: expandReport(ws, fig, { by: null }).pages[0], scenes: new Map() }));
  const rasters = new Map();
  const computed = await computeNumbers(ws, source, {
    onProgress: options.onProgress,
    onView: async (sample, view) => {
      if (plotted.has(sample.id)) {
        const drawn = [];
        for (const group of groups) {
          const parentName = group.parentId === ROOT ? 'All events' : gateById(ws, group.parentId)?.name ?? '';
          let scene;
          try {
            scene = exportScene(ws, view, { populationId: group.parentId, x: group.x, y: group.y, type: group.type, options: {} }, { width: PLOT_W, height: PLOT_H, theme: 'light', title: parentName, colormap: options.colormap });
          } catch {
            continue;
          }
          const href = scene.raster ? await rasterHref(scene.raster) : null;
          drawn.push({ group, svg: sceneToSVG(scene, { rasterHref: href }), gates: scene.gates.filter((g) => group.gateIds.includes(g.id)).map((g) => ({ id: g.id, frequency: g.frequency, label: g.label })) });
        }
        plots.set(sample.id, drawn);
      }
      for (const f of figures) {
        for (const item of f.page.items) {
          if (item.kind !== 'plot' || item.sampleId !== sample.id) continue;
          const scene = figureItemScene(ws, item, view, { colormap: options.colormap });
          if (!scene) continue;
          if (scene.raster) rasters.set(scene, await rasterHref(scene.raster));
          f.scenes.set(item.id, scene);
        }
      }
    },
  });
  if (computed.problems.length) throw new Error(`Some numbers cannot be computed: ${computed.problems.slice(0, 4).map((p) => `${p.name}: ${p.message}`).join('; ')}${computed.problems.length > 4 ? ` and ${computed.problems.length - 4} more` : ''}.`);
  const { numbers } = computed;
  const cells = cellsFromNumbers(ws, numbers);
  const figureSVGs = figures.map((f) => {
    fillStatistics(ws, { pages: [f.page] }, () => null, { cells });
    return { name: f.fig.name, svg: figurePageSVG(f.fig, f.page, f.scenes, (scene) => rasters.get(scene) ?? null) };
  });
  const model = reviewModel(ws, numbers, { version, date, engine: options.engine ?? jsEngine() });
  const warnings = [];
  if (!verifyLog(ws).ok) warnings.push('The change log\'s chain is broken; the report says so.');
  const page = composeHTML(ws, numbers, model, { plots, figureSVGs, version, date, notChecked: computed.notChecked, plotted: plotted.size, plotsOption: options.plots ?? 'all' });
  return { html: page, model, warnings };
}

// What the report's trace script needs, and what a program reading the report finds in it: the
// samples, the gates, the tables' columns and the counts.
function reviewModel(ws, numbers, meta) {
  return {
    format: REVIEW_FORMAT,
    version: REVIEW_VERSION,
    created: meta.date.toISOString(),
    software: { name: 'CytoWeave', version: meta.version, engine: meta.engine },
    workspace: { id: ws.id, name: ws.name },
    samples: ws.samples.map((s) => ({ id: s.id, name: s.name, fileName: s.fileName, sha256: s.sha256, events: s.eventCount, role: s.role, compensation: compensationName(ws, s) })),
    gates: ws.gates.map((g) => ({ id: g.id, name: g.name, path: gatePath(ws, g.id), parentId: g.parentId ?? null, type: g.type, channels: (g.dims ?? []).map((d) => channelLabel(ws, d.channel)), operands: g.type === 'boolean' ? (g.geometry?.operands ?? []).map((id) => gatePath(ws, id)) : undefined, op: g.type === 'boolean' ? g.geometry?.op : undefined, adjusted: Object.keys(g.overrides ?? {}).length })),
    tables: (ws.tables ?? []).map((t) => ({ id: t.id, name: t.name, columns: t.columns.map((c) => ({ ...columnDefinition(ws, c), gateId: c.gateId ?? ROOT, ancestorId: c.ancestorId ?? null })) })),
    counts: numbers.counts,
    comparisons: (numbers.comparisons ?? []).map((c) => {
      const record = (ws.comparisons ?? []).find((r) => r.id === c.id);
      return { id: c.id, name: c.name, measure: record?.measure?.label ?? null, grouping: record?.grouping ?? null, pairing: record?.pairing ?? null, methods: record?.methods ?? null };
    }),
  };
}

function compensationName(ws, s) {
  if (s.compensationId === 'none' || !s.compensationId) return 'none';
  if (s.compensationId === 'file') return 'the file\'s $SPILLOVER';
  return ws.compensations.find((c) => c.id === s.compensationId)?.name ?? s.compensationId;
}

// --- The page ------------------------------------------------------------------------------------

const CSS = `
:root{--bg:#f6f7f9;--panel:#fff;--text:#171b26;--text2:#3d4556;--text3:#5b6475;--line:#d9dee7;--accent:#4b3fd1;--accent-soft:#ecebff;--ok:#0f7a48;--ok-soft:#e5f5ec;--warn:#8a5a00;--warn-soft:#fdf3dc;--danger:#b4232f;--danger-soft:#fde8ea;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#12141a;--panel:#1b1e26;--text:#eceef3;--text2:#c5cad6;--text3:#9aa3b5;--line:#2e333f;--accent:#a9a1ff;--accent-soft:#2a2850;--ok:#5fd59a;--ok-soft:#173326;--warn:#f2c66d;--warn-soft:#3a2f14;--danger:#ff8a94;--danger-soft:#3d1c21}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 Inter,system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
a{color:var(--accent)}
header.top{background:var(--panel);border-bottom:1px solid var(--line);padding:20px 24px}
header.top h1{margin:0 0 4px;font-size:22px;letter-spacing:-.01em}
header.top p{margin:0;color:var(--text3)}
.layout{display:grid;grid-template-columns:220px minmax(0,1fr);gap:24px;max-width:1500px;margin:0 auto;padding:20px 24px 80px}
nav.toc{position:sticky;top:16px;align-self:start;font-size:13px}
nav.toc a{display:block;padding:4px 8px;border-radius:6px;color:var(--text2);text-decoration:none}
nav.toc a:hover,nav.toc a:focus{background:var(--accent-soft);color:var(--text)}
main section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:18px}
main h2{margin:0 0 10px;font-size:18px}main h3{margin:18px 0 8px;font-size:15px}
.muted{color:var(--text3)}.mono{font-family:var(--mono);font-size:12px}
.callout{border-radius:8px;padding:8px 12px;margin:10px 0;border:1px solid var(--line)}
.callout.ok{background:var(--ok-soft);color:var(--text)}.callout.warn{background:var(--warn-soft)}.callout.danger{background:var(--danger-soft)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}.kv dt{color:var(--text3)}.kv dd{margin:0}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:12.5px;font-variant-numeric:tabular-nums}
th,td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--text3);font-weight:650;font-size:11.5px}td.r,th.r{text-align:right}
.badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:650}
.badge.ok{background:var(--ok-soft);color:var(--ok)}.badge.warn{background:var(--warn-soft);color:var(--warn)}.badge.danger{background:var(--danger-soft);color:var(--danger)}
button.n{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;border-bottom:1px dotted var(--text3);font-variant-numeric:tabular-nums}
button.n:hover,button.n:focus-visible{color:var(--accent);border-bottom-color:var(--accent);outline:none}
button.n.on{background:var(--accent-soft);color:var(--text);border-radius:3px}
.tag{font-size:10.5px;font-weight:700;color:var(--warn);margin-left:4px}
.tree{list-style:none;padding-left:18px;margin:4px 0}.tree li{margin:2px 0}
.sample{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}
.plots{display:flex;flex-wrap:wrap;gap:10px}
figure.plot{margin:0;background:#fff;border:1px solid var(--line);border-radius:8px;padding:4px;width:${PLOT_W + 10}px}
figure.plot svg{display:block;width:100%;height:auto}
figure.plot figcaption{font-size:12px;padding:4px 4px 2px;color:#171b26}
figure.page{margin:0 0 14px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:6px;overflow-x:auto}
figure.page svg{display:block;max-width:100%;height:auto}
.dots{background:#fff;border:1px solid var(--line);border-radius:8px;max-width:520px}
#trace{position:fixed;right:16px;bottom:16px;width:min(440px,calc(100vw - 32px));max-height:60vh;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:14px 16px;display:none;font-size:13px;z-index:10}
#trace.open{display:block}#trace .mono{word-break:break-all}#trace h2{font-size:14px;margin:0 28px 6px 0}#trace ul{margin:6px 0 0;padding-left:18px}
#trace .close{position:absolute;top:8px;right:8px;border:0;background:none;color:var(--text3);font-size:18px;cursor:pointer;line-height:1}
@media (max-width:860px){.layout{grid-template-columns:1fr}nav.toc{position:static}}
@media print{nav.toc,#trace{display:none!important}.layout{display:block;padding:0}main section{break-inside:avoid-page;border:0}button.n{border:0}body{background:#fff}}
`;

// The trace panel: what a clicked number is, from the model and the number's key.
const SCRIPT = `
(() => {
  const model = JSON.parse(document.getElementById('cytoweave-review').textContent);
  const sample = (id) => model.samples.find((s) => s.id === id);
  const gate = (id) => model.gates.find((g) => g.id === id);
  const path = (id) => (!id || id === 'root' ? 'All events' : gate(id)?.path ?? '(removed)');
  const countOf = (sid, gid) => {
    const row = model.counts.samples.find((s) => s.id === sid);
    const j = model.counts.populations.findIndex((p) => p.id === (gid || 'root'));
    return row && row.values && j >= 0 ? row.values[j] : null;
  };
  const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 15 }) : String(v));
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const sampleLines = (s) => s ? [\`Sample: \${s.name} (\${s.fileName}, \${s.events.toLocaleString('en-US')} events)\`, \`File SHA-256: <span class="mono">\${s.sha256}</span>\`, \`Compensation: \${s.compensation}\`] : [];
  const gateLines = (gid) => {
    const lines = [];
    let g = gate(gid);
    while (g) {
      lines.unshift(\`\${g.name}: \${g.type}\${g.channels.length ? \` on \${g.channels.join(' × ')}\` : ''}\${g.op ? \` (\${g.op} of \${g.operands.join(', ')})\` : ''}\${g.adjusted ? \`, adjusted in \${g.adjusted} sample(s)\` : ''}\`);
      g = g.parentId ? gate(g.parentId) : null;
    }
    return lines.length ? ['Gates, from the top:', ...lines.map((l) => '&nbsp;&nbsp;' + esc(l))] : ['All events (no gate)'];
  };
  function explain(key, value) {
    const [kind, a, b, c] = key.split('|');
    if (kind === 'count') {
      return { title: \`Count: \${path(b)}\`, lines: [\`\${fmt(value)} events of \${path(b)}\`, ...sampleLines(sample(a)), ...gateLines(b)] };
    }
    if (kind === 'plot') {
      const g = gate(b);
      const n = countOf(a, b);
      const parent = countOf(a, g?.parentId);
      return { title: \`% of parent: \${path(b)}\`, lines: [\`\${fmt(value)}% = 100 × \${fmt(n)} / \${fmt(parent)} events (\${path(b)} of \${path(g?.parentId)})\`, ...sampleLines(sample(a)), ...gateLines(b)] };
    }
    if (kind === 'table' || kind === 'table-status') {
      const t = model.tables.find((x) => x.id === a);
      const col = t?.columns[Number(c)];
      if (!col) return { title: 'Table cell', lines: [fmt(value)] };
      const lines = [\`\${col.statistic}\${col.channel ? \` of \${col.channel}\` : ''}\${col.value !== '' ? \` (\${col.value})\` : ''} of \${col.population}\${col.relativeTo ? \`, relative to \${col.relativeTo}\` : ''}\`, \`Value: \${fmt(value)}\`];
      const n = countOf(b, col.gateId);
      if (typeof n === 'number') lines.push(\`\${col.population}: \${fmt(n)} events\`);
      if (/^freq/.test(col.statisticId)) {
        const g = gate(col.gateId);
        const ref = col.statisticId === 'freqParent' ? g?.parentId : col.statisticId === 'freqOf' ? col.ancestorId : col.statisticId === 'freqTotal' ? 'root' : g?.parentId ? gate(g.parentId)?.parentId : null;
        const d = countOf(b, ref);
        if (typeof d === 'number') lines.push(\`Out of \${path(ref)}: \${fmt(d)} events\`);
      }
      for (const [label, text] of [['Control', col.control], ['Counting beads', col.counting], ['Dilution', col.dilution], ['Detection limits', col.limits]]) if (text) lines.push(\`\${label}: \${text}\`);
      return { title: \`\${t.name}: \${kind === 'table-status' ? 'detection status' : 'cell'}\`, lines: [...lines, ...sampleLines(sample(b)), ...gateLines(col.gateId)] };
    }
    if (kind === 'comparison') {
      const cmp = model.comparisons.find((x) => x.id === a);
      const lines = [\`\${b === 'value' ? 'The sample\\'s value of the measure' : \`Result: \${b.replace(/^results\\./, '')}\`}: \${fmt(value)}\`];
      if (cmp?.measure) lines.push(\`Measure: \${cmp.measure}\`);
      if (cmp?.grouping) lines.push(\`Groups: \${cmp.grouping.levels.join(' vs ')} (by \${String(cmp.grouping.by).replace(/^meta:/, '')})\${cmp.pairing ? \`, paired by \${cmp.pairing}\` : ''}\`);
      if (b === 'value') lines.push(...sampleLines(sample(c)));
      if (cmp?.methods) lines.push(cmp.methods);
      return { title: cmp?.name ?? 'Comparison', lines };
    }
    return { title: 'Number', lines: [fmt(value)] };
  }
  const panel = document.getElementById('trace');
  let current = null;
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button.n');
    if (event.target.closest('#trace .close')) { panel.classList.remove('open'); current?.classList.remove('on'); current?.focus(); return; }
    if (!button) return;
    current?.classList.remove('on');
    current = button;
    button.classList.add('on');
    const { title, lines } = explain(button.dataset.k, JSON.parse(button.dataset.v));
    panel.innerHTML = '<button type="button" class="close" aria-label="Close">×</button><h2>' + esc(title) + '</h2><ul>' + lines.map((l) => '<li>' + l + '</li>').join('') + '</ul>';
    panel.classList.add('open');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panel.classList.contains('open')) { panel.classList.remove('open'); current?.classList.remove('on'); current?.focus(); }
  });
})();
`;

function composeHTML(ws, numbers, model, parts) {
  const { plots, figureSVGs, version, date, notChecked } = parts;
  const sampleById = new Map(ws.samples.map((s) => [s.id, s]));
  const countRow = new Map(numbers.counts.samples.map((s) => [s.id, s.values]));
  const popIndex = new Map(numbers.counts.populations.map((p, j) => [p.id, j]));
  const log = verifyLog(ws);
  const certificates = (ws.provenance ?? []).filter((e) => e.action === 'certify').reverse();
  const sections = [];
  const toc = [];
  const section = (id, title, body) => {
    toc.push(`<a href="#${id}">${html(title)}</a>`);
    sections.push(`<section id="${id}" aria-labelledby="${id}-h"><h2 id="${id}-h">${html(title)}</h2>${body}</section>`);
  };

  // Overview.
  section('overview', 'Overview', [
    '<dl class="kv">',
    `<dt>Analysis</dt><dd>${html(ws.name)}</dd>`,
    `<dt>Report made</dt><dd>${html(date.toISOString().replace('T', ' ').slice(0, 16))} UTC with CytoWeave ${html(version)} (${html(model.software.engine)})</dd>`,
    `<dt>Samples</dt><dd>${plural(ws.samples.length, 'file')}: ${plural(ws.samples.filter((s) => s.role === 'sample' || s.role === 'reference').length, 'sample')}, ${plural(ws.samples.filter((s) => s.role !== 'sample' && s.role !== 'reference').length, 'control')}</dd>`,
    `<dt>Populations</dt><dd>${ws.gates.length}</dd>`,
    `<dt>Tables, figures</dt><dd>${(ws.tables ?? []).length} tables, ${(ws.figures ?? []).length} figures, ${(numbers.comparisons ?? []).length} saved comparisons</dd>`,
    `<dt>Change log</dt><dd>${plural(log.entries, 'entry', 'entries')}, ${log.ok ? 'hash chain intact' : '<strong>hash chain broken</strong>'}; head <span class="mono">${html((log.head ?? '').slice(0, 16))}</span></dd>`,
    certificates.length ? `<dt>Certificates</dt><dd>${certificates.slice(0, 5).map((e) => html(`${e.detail} (${e.time.slice(0, 10)})`)).join('<br>')}</dd>` : '',
    '</dl>',
    ws.notes?.trim() ? `<h3>Notes</h3><p>${html(ws.notes.trim()).replace(/\n/g, '<br>')}</p>` : '',
    '<p class="muted">Every underlined number is traced: click it to see where it comes from. The numbers were computed from the FCS files by CytoWeave as this report was made; a reproducibility certificate of the analysis prints the same numbers.</p>',
  ].join(''));

  // Samples.
  const fields = [...new Set(ws.samples.flatMap((s) => Object.keys(s.meta ?? {})))];
  section('samples', 'Samples', `<div class="scroll"><table><thead><tr><th>Sample</th><th>File</th><th>SHA-256</th><th class="r">Events</th><th>Role</th>${fields.map((f) => `<th>${html(f)}</th>`).join('')}<th>Compensation</th></tr></thead><tbody>${ws.samples.map((s) => {
    const values = countRow.get(s.id);
    return `<tr><td>${html(s.name)}</td><td>${html(s.fileName)}</td><td class="mono" title="${html(s.sha256)}">${html((s.sha256 ?? '').slice(0, 12))}…</td><td class="r">${values ? num(`count|${s.id}|${ROOT}`, asNumber(values[popIndex.get(ROOT)]), count(asNumber(values[popIndex.get(ROOT)]))) : count(s.eventCount)}</td><td>${html(s.role)}</td>${fields.map((f) => `<td>${html(s.meta?.[f] ?? '')}</td>`).join('')}<td>${html(compensationName(ws, s))}</td></tr>`;
  }).join('')}</tbody></table></div>`);

  // Gating hierarchy, with each population's count in every sample.
  const children = (parentId) => ws.gates.filter((g) => (g.parentId ?? null) === parentId);
  const tree = (parentId) => {
    const list = children(parentId);
    if (!list.length) return '';
    return `<ul class="tree">${list.map((g) => `<li><strong>${html(g.name)}</strong> <span class="muted">${html(g.type)}${g.dims?.length ? ` on ${html(g.dims.map((d) => channelLabel(ws, d.channel)).join(' × '))}` : ''}${Object.keys(g.overrides ?? {}).length ? `, adjusted in ${Object.keys(g.overrides).length} sample(s)` : ''}</span>${tree(g.id)}</li>`).join('')}</ul>`;
  };
  const transforms = Object.entries(ws.channelSettings ?? {}).filter(([, v]) => v?.transform).map(([channel, v]) => `${channelLabel(ws, channel)}: ${v.transform.type ?? 'custom'}`);
  const countsTable = `<div class="scroll"><table><thead><tr><th>Sample</th>${numbers.counts.populations.map((p) => `<th class="r">${html(p.path)}</th>`).join('')}</tr></thead><tbody>${numbers.counts.samples.map((s) => `<tr><td>${html(s.name)}</td>${(s.values ?? []).map((v, j) => `<td class="r">${num(`count|${s.id}|${numbers.counts.populations[j].id}`, asNumber(v), Number.isFinite(asNumber(v)) ? count(asNumber(v)) : '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  section('gating', 'Gating', `${ws.gates.length ? tree(null) : '<p class="muted">No gates.</p>'}${transforms.length ? `<h3>Scales</h3><p class="muted">${html(transforms.join('; '))}</p>` : ''}<h3>Events in each population</h3>${countsTable}`);

  // Every sample's gates.
  if (parts.plotsOption !== 'none') {
    const blocks = ws.samples.filter((s) => plots.has(s.id)).map((s) => {
      const drawn = plots.get(s.id);
      return `<div class="sample"><h3>${html(s.name)} <span class="muted">${html(s.fileName)}</span></h3><div class="plots">${drawn.map((p) => `<figure class="plot">${p.svg}<figcaption>${p.gates.map((g) => `${html(gateById(ws, g.id)?.name ?? '')}: ${Number.isFinite(g.frequency) ? num(`plot|${s.id}|${g.id}`, g.frequency, g.label || formatPercent(g.frequency)) : '—'}`).join(' · ')}</figcaption></figure>`).join('')}</div></div>`;
    });
    section('plots', 'Gates in each sample', blocks.length ? `<p class="muted">Each plot shows a population's events on the channels of the gates drawn on it, with each gate's % of that population.</p>${blocks.join('')}` : '<p class="muted">No samples to draw.</p>');
  }

  // Figures.
  if (figureSVGs.length) section('figures', 'Figures', figureSVGs.map((f) => `<h3>${html(f.name)}</h3><figure class="page">${f.svg}</figure>`).join(''));

  // Tables.
  if (numbers.tables.length) {
    section('tables', 'Tables', numbers.tables.map((t) => {
      const table = ws.tables.find((x) => x.id === t.id);
      return `<h3>${html(t.name)}</h3><div class="scroll"><table><thead><tr><th>Sample</th>${t.columns.map((label) => `<th class="r">${html(label)}</th>`).join('')}</tr></thead><tbody>${t.samples.map((s) => `<tr><td>${html(s.name)}</td>${s.values.map((v, j) => {
        const value = asNumber(v);
        const status = s.status[j];
        const text = formatStatistic(table?.columns[j]?.stat, value);
        return `<td class="r">${Number.isFinite(value) ? num(`table|${t.id}|${s.id}|${j}`, value, text) : html(text || '—')}${status && LIMIT_TAGS[status] ? `<span class="tag">${num(`table-status|${t.id}|${s.id}|${j}`, status, LIMIT_TAGS[status], 'status')}</span>` : ''}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table></div>`;
    }).join(''));
  }

  // Comparisons.
  if (numbers.comparisons.length) section('comparisons', 'Comparisons', numbers.comparisons.map((c) => comparisonHTML(ws, c, sampleById)).join(''));

  // Methods and MIFlowCyt.
  const methods = writeMethods(ws, { version });
  section('methods', 'Methods', `${methods.paragraphs.map((p) => `<p>${html(p)}</p>`).join('')}<h3>References</h3><ol>${methods.references.map((r) => `<li>${html(r.text)}${r.doi ? ` <a href="https://doi.org/${html(r.doi)}" rel="noopener">doi:${html(r.doi)}</a>` : ''}</li>`).join('')}</ol>`);
  const mif = miflowcytRecord(ws);
  section('miflowcyt', 'MIFlowCyt', `<p class="muted">${mif.filter((m) => m.ok).length} of ${mif.length} items documented.</p><div class="scroll"><table><tbody>${mif.map((m) => `<tr><td><span class="badge ${m.ok ? 'ok' : 'warn'}">${m.ok ? 'documented' : 'missing'}</span></td><td>${html(m.section)}: ${html(m.item)}</td><td class="muted">${html(m.value || '—')}</td></tr>`).join('')}</tbody></table></div>`);

  // Change log.
  const entries = [...(ws.provenance ?? [])].reverse();
  section('log', 'Change log', `<div class="callout ${log.ok ? 'ok' : 'danger'}">${log.ok ? `Hash-chained and intact: ${plural(log.entries, 'entry', 'entries')}, each covering the one before it.` : `The chain is broken at ${plural(log.broken.length, 'entry', 'entries')}: the log was changed outside CytoWeave.`}</div><div class="scroll"><table><thead><tr><th>When (UTC)</th><th>Action</th><th>Detail</th></tr></thead><tbody>${entries.slice(0, 500).map((e) => `<tr><td class="mono">${html(String(e.time).replace('T', ' ').slice(0, 19))}</td><td>${html(e.action)}</td><td>${html(String(e.detail ?? '').slice(0, 200))}</td></tr>`).join('')}</tbody></table></div>${entries.length > 500 ? `<p class="muted">The ${entries.length - 500} oldest entries are in the workspace.</p>` : ''}`);

  // About.
  section('about', 'About this report', `<p>Made by CytoWeave ${html(version)} from ${plural(ws.samples.length, 'FCS file')}, each identified by its SHA-256 above. Every number was computed from the files as the report was made, with the code CytoWeave uses in its window and in reproducibility certificates.</p>${notChecked.length ? `<p class="muted">Recorded but not computed again: ${html(notChecked.map((n) => n.what).join('; '))}.</p>` : ''}<p class="muted">This file is self-contained: it loads nothing from the network. Its data are also in the JSON block <code>cytoweave-review</code> inside it.</p>`);

  const modelJSON = JSON.stringify(model).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="CytoWeave ${html(version)}">
<title>${html(ws.name)}: review report</title>
<style>${CSS}</style>
</head>
<body>
<header class="top"><h1>${html(ws.name)}</h1><p>Review report · CytoWeave ${html(version)} · ${html(date.toISOString().slice(0, 10))}</p></header>
<div class="layout">
<nav class="toc" aria-label="Sections">${toc.join('')}</nav>
<main>
${sections.join('\n')}
</main>
</div>
<aside id="trace" aria-live="polite" aria-label="Where this number comes from"></aside>
<script type="application/json" id="cytoweave-review">${modelJSON}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// A saved comparison: its result, groups, effects, post-hoc tests and every sample's value, with
// a dot plot.
function comparisonHTML(ws, c, sampleById) {
  const record = (ws.comparisons ?? []).find((r) => r.id === c.id);
  const r = c.results;
  const key = (path) => `comparison|${c.id}|${path}`;
  const v = (path, value, digits = 4) => {
    const x = asNumber(value);
    return x === null ? html(String(value ?? '—')) : Number.isFinite(x) ? num(key(path), x, formatNumber(x, digits)) : '—';
  };
  const out = [`<h3>${html(c.name)}</h3>`];
  if (!r.design) {
    out.push('<p class="muted">Fewer than two groups with values.</p>');
    return out.join('');
  }
  const df = Array.isArray(r.test.df) ? r.test.df.map((d, i) => v(`results.test.df[${i}]`, d, 3)).join(', ') : r.test.df !== null ? v('results.test.df', r.test.df, 3) : '';
  const testName = (id) => TESTS[id]?.label ?? id;
  out.push(`<p><strong>${html(testName(r.test.id))}</strong>: statistic ${v('results.test.statistic', r.test.statistic)}${df ? `, df ${df}` : ''}, p = ${v('results.test.p', r.test.p, 3)}${r.secondary ? `; ${html(testName(r.secondary.id))}: p = ${v('results.secondary.p', r.secondary.p, 3)}` : ''} <span class="muted">(${html(DESIGN_LABEL[r.design] ?? r.design)})</span></p>`);
  out.push(dotPlot(c, record));
  out.push(`<div class="scroll"><table><thead><tr><th>Group</th><th class="r">n</th><th class="r">Mean</th><th class="r">SD</th><th class="r">Median</th><th class="r">Q1</th><th class="r">Q3</th></tr></thead><tbody>${r.groups.map((g, i) => `<tr><td>${html(g.label)}</td><td class="r">${v(`results.groups[${i}].n`, g.n, 6)}</td><td class="r">${v(`results.groups[${i}].mean`, g.mean)}</td><td class="r">${v(`results.groups[${i}].sd`, g.sd)}</td><td class="r">${v(`results.groups[${i}].median`, g.median)}</td><td class="r">${v(`results.groups[${i}].q1`, g.q1)}</td><td class="r">${v(`results.groups[${i}].q3`, g.q3)}</td></tr>`).join('')}</tbody></table></div>`);
  if (r.effects?.length) out.push(`<div class="scroll"><table><thead><tr><th>Effect</th><th class="r">Estimate</th><th class="r">95% CI</th></tr></thead><tbody>${r.effects.map((e, i) => `<tr><td>${html(e.label)}</td><td class="r">${v(`results.effects[${i}].estimate`, e.estimate)}</td><td class="r">${e.ci ? `${v(`results.effects[${i}].ci[0]`, e.ci[0])} to ${v(`results.effects[${i}].ci[1]`, e.ci[1])}` : '—'}</td></tr>`).join('')}</tbody></table></div>`);
  if (r.posthoc?.length) out.push(`<div class="scroll"><table><thead><tr><th>Group vs reference</th><th class="r">Difference</th><th class="r">Ratio</th><th class="r">p</th><th class="r">p (Holm)</th></tr></thead><tbody>${r.posthoc.map((row, i) => `<tr><td>${html(row.group)}</td><td class="r">${v(`results.posthoc[${i}].difference`, row.difference)}</td><td class="r">${v(`results.posthoc[${i}].ratio`, row.ratio)}</td><td class="r">${v(`results.posthoc[${i}].p`, row.p, 3)}</td><td class="r">${v(`results.posthoc[${i}].q`, row.q, 3)}</td></tr>`).join('')}</tbody></table></div>`);
  const groupOf = new Map((record?.results?.values ?? []).map((x) => [x.sampleId, x]));
  out.push(`<details><summary>Every sample's value (${c.values.length})</summary><div class="scroll"><table><thead><tr><th>Sample</th><th>Group</th><th>Pair</th><th class="r">Value</th></tr></thead><tbody>${c.values.map((x) => `<tr><td>${html(sampleById.get(x.sampleId)?.name ?? x.name)}</td><td>${html(groupOf.get(x.sampleId)?.group ?? '')}</td><td>${html(groupOf.get(x.sampleId)?.pair ?? '')}</td><td class="r">${Number.isFinite(asNumber(x.value)) ? num(`comparison|${c.id}|value|${x.sampleId}`, asNumber(x.value), formatNumber(asNumber(x.value), 5)) : '—'}</td></tr>`).join('')}</tbody></table></div></details>`);
  if (record?.methods) out.push(`<p class="muted">${html(record.methods)}</p>`);
  return out.join('');
}

function formatNumber(x, digits) {
  if (!Number.isFinite(x)) return '—';
  if (x !== 0 && Math.abs(x) < 1e-3) return x.toExponential(digits - 1);
  return Number.isInteger(x) ? x.toLocaleString('en-US') : (+x.toPrecision(digits)).toLocaleString('en-US', { maximumFractionDigits: 12 });
}

// A dot plot of a comparison's values by group, with each group's mean.
function dotPlot(c, record) {
  const groups = c.results.groups.map((g) => g.label);
  const byGroup = new Map(groups.map((g) => [g, []]));
  const groupOf = new Map((record?.results?.values ?? []).map((x) => [x.sampleId, x.group]));
  for (const x of c.values) {
    const value = asNumber(x.value);
    const group = groupOf.get(x.sampleId);
    if (Number.isFinite(value) && byGroup.has(group)) byGroup.get(group).push(value);
  }
  const all = [...byGroup.values()].flat();
  if (!all.length) return '';
  const w = 520;
  const h = 240;
  const left = 56;
  const bottom = 40;
  const top = 16;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const y = (v) => top + (h - top - bottom) * (1 - (v - lo) / (hi - lo));
  const band = (w - left - 16) / groups.length;
  const parts = [`<svg class="dots" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${html(`${c.name}: values by group`)}"><rect width="${w}" height="${h}" fill="#fff"/>`];
  for (let k = 0; k <= 4; k += 1) {
    const value = lo + ((hi - lo) * k) / 4;
    parts.push(`<path d="M${left} ${y(value).toFixed(1)}H${w - 16}" stroke="#e3e7ee"/><text x="${left - 6}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#5b6475">${html(formatNumber(value, 3))}</text>`);
  }
  groups.forEach((g, i) => {
    const cx = left + band * (i + 0.5);
    const values = byGroup.get(g);
    values.forEach((value, k) => {
      const jitter = ((k * 0.618034) % 1 - 0.5) * band * 0.4;
      parts.push(`<circle cx="${(cx + jitter).toFixed(1)}" cy="${y(value).toFixed(1)}" r="4" fill="#4b3fd1" fill-opacity="0.75"/>`);
    });
    const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    if (values.length) parts.push(`<path d="M${(cx - band * 0.28).toFixed(1)} ${y(mean).toFixed(1)}H${(cx + band * 0.28).toFixed(1)}" stroke="#171b26" stroke-width="2"/>`);
    parts.push(`<text x="${cx.toFixed(1)}" y="${h - 16}" text-anchor="middle" font-size="12" fill="#171b26">${html(g)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

