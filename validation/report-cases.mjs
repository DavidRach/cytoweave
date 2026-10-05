// Batch reports and spreadsheets (wave 6, slice 3): a small activation experiment whose layout
// exercises every rule of a report. Subjects S1–S4, each with an unstimulated and a stimulated
// tube (CD69 rises on stimulation), except that S2 has two stimulated tubes (replicates) and S4 no
// stimulated tube; and two FMO controls (no CD69 stain, no subject). Gates: Lymphocytes (FSC ×
// SSC) → CD69+ (FITC). A table of the populations' frequencies, counts and medians, CD69+ with
// detection limits from the FMOs as blanks; a figure drawn on S1's two tubes and the first FMO,
// with a statistics item and text placeholders.

import { SampleView } from '../web/lib/engine.js';
import { createRandom } from '../web/lib/random.js';
import { createTransform } from '../web/lib/transforms.js';
import { addGates, createWorkspace } from '../web/lib/workspace.js';

export const REPORT_DATE = new Date('2026-10-04T12:00:00Z');
const LIN = { type: 'linear', min: 0, max: 262144 };
const LOGICLE = { type: 'logicle', T: 262144, W: 0.5, M: 4.5, A: 0 };

const TUBES = [
  { name: 'S1 unstim', subject: 'S1', condition: 'unstim', positive: 0.03 },
  { name: 'S1 stim', subject: 'S1', condition: 'stim', positive: 0.28 },
  { name: 'S2 unstim', subject: 'S2', condition: 'unstim', positive: 0.04 },
  { name: 'S2 stim', subject: 'S2', condition: 'stim', positive: 0.35 },
  { name: 'S2 stim repeat', subject: 'S2', condition: 'stim', positive: 0.34 },
  { name: 'S3 unstim', subject: 'S3', condition: 'unstim', positive: 0.02 },
  { name: 'S3 stim', subject: 'S3', condition: 'stim', positive: 0.19 },
  { name: 'S4 unstim', subject: 'S4', condition: 'unstim', positive: 0.05 },
  { name: 'FMO CD69', role: 'fmo', positive: 0 },
  { name: 'FMO CD69 repeat', role: 'fmo', positive: 0 },
];

export function reportExperiment(seed = 41) {
  const random = createRandom(seed);
  const views = new Map();
  const samples = TUBES.map((tube, k) => {
    const n = 6000;
    const fsc = new Float32Array(n);
    const ssc = new Float32Array(n);
    const fitc = new Float32Array(n);
    const pe = new Float32Array(n);
    for (let e = 0; e < n; e += 1) {
      const lymph = random() < 0.7;
      fsc[e] = lymph ? 95000 + 11000 * random.gaussian() : 30000 + 9000 * random.gaussian();
      ssc[e] = lymph ? 32000 + 6000 * random.gaussian() : 90000 + 25000 * random.gaussian();
      const positive = lymph && random() < tube.positive;
      fitc[e] = positive ? 9000 * 10 ** (0.2 * random.gaussian()) : 250 + 180 * random.gaussian();
      pe[e] = 400 * 10 ** (0.3 * random.gaussian());
    }
    const id = `r${k}`;
    const channels = [
      { name: 'FSC-A', type: 'scatter', range: 262144 },
      { name: 'SSC-A', type: 'scatter', range: 262144 },
      { name: 'FITC-A', marker: 'CD69', type: 'fluorescence', range: 262144 },
      { name: 'PE-A', marker: 'CD25', type: 'fluorescence', range: 262144 },
    ];
    const record = { id, name: tube.name, fileName: `${tube.name.replace(/ /g, '_')}.fcs`, sha256: `${String(k).padStart(2, '0')}${'ab'.repeat(31)}`, eventCount: n, keywords: {}, technology: 'conventional', channels, role: tube.role ?? 'sample', meta: tube.subject ? { subject: tube.subject, condition: tube.condition } : {}, compensationId: 'none', acquisition: { cytometer: 'Simulated', date: '04-OCT-2026' } };
    const dataset = { eventCount: n, parameters: channels.map((c, index) => ({ index, ...c })), data: [fsc, ssc, fitc, pe], keywords: {} };
    views.set(id, new SampleView(record, dataset));
    return record;
  });
  let ws = { ...createWorkspace('Activation'), samples };
  const cut = createTransform(LOGICLE).forward(1500);
  ws = addGates(ws, [
    { id: 'lymph', name: 'Lymphocytes', parentId: null, type: 'polygon', dims: [{ channel: 'FSC-A', transform: LIN }, { channel: 'SSC-A', transform: LIN }], geometry: { vertices: [[0.24, 0.05], [0.5, 0.05], [0.5, 0.22], [0.24, 0.22]] } },
    { id: 'cd69', name: 'CD69+', parentId: 'lymph', type: 'range', dims: [{ channel: 'FITC-A', transform: LOGICLE }], geometry: { min: cut, max: null } },
  ]).ws;
  ws = { ...ws, channelSettings: { 'FSC-A': { transform: LIN }, 'SSC-A': { transform: LIN }, 'FITC-A': { transform: LOGICLE }, 'PE-A': { transform: LOGICLE } } };
  const fmo = samples.find((s) => s.role === 'fmo').id;
  const blanks = samples.filter((s) => s.role === 'fmo').map((s) => s.id);
  const table = {
    id: 'tbl', name: 'Activation', heatmap: true, groupId: null,
    columns: [
      { id: 'c1', gateId: 'lymph', stat: 'freqParent' },
      { id: 'c2', gateId: 'cd69', stat: 'freqParent', limits: { blankIds: blanks, lowIds: [], method: 'parametric', cvTarget: 20 } },
      { id: 'c3', gateId: 'cd69', stat: 'count' },
      { id: 'c4', gateId: 'cd69', stat: 'median', channel: 'FITC-A' },
    ],
  };
  const s1 = samples.find((s) => s.name === 'S1 unstim').id;
  const s1stim = samples.find((s) => s.name === 'S1 stim').id;
  const plot = (id, sampleId, spec, x, y, title) => ({ id, kind: 'plot', x, y, w: 300, h: 280, sampleId, spec: { options: {}, ...spec }, title });
  const figure = {
    id: 'fig', name: 'Activation per subject', width: 1600, height: 900, background: '#ffffff',
    items: [
      { id: 't1', kind: 'text', x: 40, y: 24, w: 1200, h: 34, text: 'Subject {subject}: CD69 on stimulation', size: 24, weight: 700 },
      { id: 't2', kind: 'text', x: 40, y: 62, w: 1200, h: 22, text: '{sample} · page {page} of {pages} · {date}', size: 13, color: '#5b6475' },
      plot('p1', s1, { populationId: 'root', x: 'FSC-A', y: 'SSC-A', type: 'pseudocolor' }, 40, 110, 'All events'),
      plot('p2', s1, { populationId: 'lymph', x: 'FITC-A', y: null, type: 'histogram' }, 360, 110, 'Unstimulated'),
      plot('p3', s1stim, { populationId: 'lymph', x: 'FITC-A', y: null, type: 'histogram' }, 680, 110, 'Stimulated'),
      plot('p4', fmo, { populationId: 'lymph', x: 'FITC-A', y: null, type: 'histogram' }, 1000, 110, 'FMO'),
      { id: 'a1', kind: 'arrow', x: 345, y: 240, w: 12, h: 20 },
      { id: 's1', kind: 'stats', x: 40, y: 430, w: 900, h: 200, tableId: 'tbl', rows: 'page', size: 12 },
    ],
  };
  ws = { ...ws, tables: [table], figures: [figure] };
  return { ws, views, viewOf: (id) => views.get(id) ?? null, ids: { s1, s1stim, fmo } };
}

// The documents the validation checks, written as CytoWeave writes them (fixed date, so that the
// same inputs give the same files): the figure by subject as PDF, by sample as PowerPoint (plots
// as their event rasters: Node has no canvas to draw axes on), the table as an Excel workbook and
// as a Prism project grouped by condition. Returns { experiment, files: { name: bytes }, reports:
// { name: { report, trace } }, workbook, prism }.
export async function buildReports() {
  const { expandReport, fillStatistics, plotTrace, reportPDFPage, reportRecord, reportSlide, REPORT_ATTACHMENT } = await import('../web/lib/reports.js');
  const { exportScene } = await import('../web/lib/scene.js');
  const { writePDF } = await import('../web/lib/pdf.js');
  const { writePPTX } = await import('../web/lib/pptx.js');
  const { writeXLSX } = await import('../web/lib/xlsx.js');
  const { writePZFX } = await import('../web/lib/pzfx.js');
  const { encodePNG } = await import('../web/lib/png.js');
  const { tablesWorkbook, prismTables } = await import('../web/lib/spreadsheets.js');
  const experiment = reportExperiment();
  const { ws, viewOf } = experiment;
  const figure = ws.figures[0];
  const sceneOf = (item) => exportScene(ws, viewOf(item.sampleId), item.spec, { width: item.w, height: item.h, theme: 'light', title: item.title });
  const encoder = new TextEncoder();
  const files = {};
  const reports = {};
  {
    const report = expandReport(ws, figure, { by: 'subject', date: REPORT_DATE });
    const trace = fillStatistics(ws, report, viewOf);
    const scenes = new Map();
    const pages = report.pages.map((page) => {
      for (const item of page.items) {
        if (item.kind !== 'plot' || !item.sampleId) continue;
        const scene = sceneOf(item);
        scenes.set(`${page.index}:${item.id}`, scene);
        trace.push(...plotTrace(ws, page, item, scene));
      }
      return reportPDFPage(figure, page, (item) => scenes.get(`${page.index}:${item.id}`));
    });
    const record = reportRecord(ws, figure, report, trace, { date: REPORT_DATE, version: 'validation' });
    files['report-subject.pdf'] = await writePDF(pages, { title: figure.name, date: REPORT_DATE, attachments: [{ name: REPORT_ATTACHMENT, mime: 'application/json', description: 'record', data: encoder.encode(JSON.stringify(record)) }] });
    reports['report-subject.pdf'] = { report, trace, scenes };
  }
  {
    const report = expandReport(ws, figure, { by: 'sample', date: REPORT_DATE });
    const trace = fillStatistics(ws, report, viewOf);
    const blank = await encodePNG(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const slides = [];
    for (const page of report.pages) {
      slides.push(await reportSlide(figure, page, async (item) => {
        const scene = sceneOf(item);
        trace.push(...plotTrace(ws, page, item, scene));
        return { png: scene.raster ? await encodePNG(scene.raster.rgba, scene.raster.width, scene.raster.height) : blank, description: item.title };
      }));
    }
    const record = reportRecord(ws, figure, report, trace, { date: REPORT_DATE, version: 'validation' });
    files['report-sample.pptx'] = await writePPTX(slides, { width: figure.width, height: figure.height, title: figure.name, date: REPORT_DATE, parts: [{ path: 'cytoweave/report.json', contentType: 'application/json', relationship: 'https://cytoweave.org/relationships/report', data: encoder.encode(JSON.stringify(record)) }] });
    reports['report-sample.pptx'] = { report, trace };
  }
  const workbook = tablesWorkbook(ws, ws.tables, viewOf, { version: 'validation', date: REPORT_DATE });
  files['tables.xlsx'] = await writeXLSX(workbook.sheets, { title: 'Activation tables', date: REPORT_DATE });
  const prism = prismTables(ws, ws.tables[0], viewOf, { groupBy: 'condition' });
  files['activation.pzfx'] = encoder.encode(writePZFX(prism.tables, { date: REPORT_DATE, version: 'validation', project: ws.name }));
  return { experiment, files, reports, workbook, prism };
}
