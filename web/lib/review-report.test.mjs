import assert from 'node:assert/strict';
import test from 'node:test';
import { computeNumbers, numberItems } from './certificate.js';
import { generateExample } from './examples.js';
import { parseFCS } from './fcs.js';
import { gatingStrategyFigure } from './figures.js';
import { buildReviewReport, gatePlots } from './review-report.js';
import { sha256 } from './sha256.js';
import { ROOT, addGates, annotateSamples, createWorkspace, sampleFromDataset, setCollection } from './workspace.js';

function example(name = 'Review') {
  const result = generateExample('pbmc-immunophenotyping', { scale: 0.03 });
  const files = new Map();
  const samples = result.files.map((file) => {
    const digest = sha256(file.bytes);
    files.set(digest, file.bytes);
    return sampleFromDataset(parseFCS(file.bytes).datasets[0], { name: file.name, size: file.bytes.length, sha256: digest });
  });
  let ws = { ...createWorkspace(name), samples };
  const changes = {};
  for (const s of samples) changes[s.id] = Object.fromEntries(Object.entries(result.workspaceHints.sampleMeta?.[s.fileName] ?? {}).filter(([k, v]) => !['role', 'stain'].includes(k) && typeof v !== 'object'));
  ws = annotateSamples(ws, changes, 'example');
  ws = addGates(ws, result.workspaceHints.suggestedGates.map((g) => ({ ...g, overrides: {} }))).ws;
  ws = setCollection(ws, 'tables', [{ id: 't', name: 'Frequencies', columns: ws.gates.map((g, i) => ({ id: `c${i}`, gateId: g.id, stat: 'freqParent' })) }], 'add-table');
  const donor = ws.samples.find((s) => s.role === 'sample');
  ws = setCollection(ws, 'figures', [gatingStrategyFigure(ws, ws.gates.at(-1).id, donor.id)], 'add-figure');
  return { ws, source: { fcs: (s) => files.get(s.sha256) ?? null, derived: () => null } };
}

// The traced numbers of a page: [{ key, value, text }].
function traced(page) {
  return [...page.matchAll(/<button type="button" class="n[^"]*" data-k="([^"]+)" data-v="([^"]*)">([^<]*)<\/button>/g)].map((m) => ({
    key: m[1].replace(/&amp;/g, '&'),
    value: JSON.parse(m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&')),
    text: m[3],
  }));
}

test('every number in a review report is one the analysis computes, and its plots\' percentages are their counts\' ratios', async () => {
  const { ws, source } = example();
  const report = await buildReviewReport(ws, source, { version: 'test', date: new Date('2026-10-07T00:00:00Z') });
  const numbers = traced(report.html);
  const { numbers: computed } = await computeNumbers(ws, source);
  const expected = new Map(numberItems(computed).map((i) => [i.key, i.value]));
  const plotted = numbers.filter((n) => n.key.startsWith('plot|'));
  const others = numbers.filter((n) => !n.key.startsWith('plot|'));
  assert.ok(others.length > 200, `${others.length} numbers`);
  for (const n of others) assert.deepEqual(n.value, expected.get(n.key), n.key);
  // Every count and table cell of the analysis is in the report.
  for (const [key] of expected) if (key.startsWith('count|') || key.startsWith('table|')) assert.ok(others.some((n) => n.key === key), `${key} missing`);
  // A plot's % of parent: 100 × count / the parent's count.
  const index = new Map(computed.counts.populations.map((p, j) => [p.id, j]));
  const rows = new Map(computed.counts.samples.map((s) => [s.id, s.values]));
  const samplesDrawn = ws.samples.filter((s) => s.role === 'sample').length;
  assert.equal(plotted.length, samplesDrawn * ws.gates.length);
  for (const n of plotted) {
    const [, sampleId, gateId] = n.key.split('|');
    const gate = ws.gates.find((g) => g.id === gateId);
    const values = rows.get(sampleId);
    assert.equal(n.value, (100 * values[index.get(gateId)]) / (values[index.get(gate.parentId ?? ROOT)] || 1), n.key);
  }
  // Gates on the same population and channels share a plot (Lymphocytes and Monocytes on Live).
  const shared = gatePlots(ws).find((p) => p.gateIds.length > 1);
  assert.deepEqual(shared.gateIds.map((id) => ws.gates.find((g) => g.id === id).name), ['Lymphocytes', 'Monocytes']);
  assert.equal(gatePlots(ws).length, ws.gates.length - 1);
  assert.deepEqual(report.warnings, []);
});

test('a review report loads nothing: no external scripts, styles, images or fonts', async () => {
  const { ws, source } = example();
  const { html } = await buildReviewReport(ws, source, { version: 'test' });
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /@import|url\((?!#)/i, 'url() only for references inside the page (clip paths)');
  assert.doesNotMatch(html, /<iframe|<object|<embed/i);
  const sources = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
  const external = sources.filter((s) => !s.startsWith('data:') && !s.startsWith('#'));
  // Only links a reader may follow (DOIs), in anchors.
  assert.ok(external.every((s) => s.startsWith('https://doi.org/')), external.filter((s) => !s.startsWith('https://doi.org/')).join(', '));
  const images = [...html.matchAll(/<image [^>]*href="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(images.length > 0 && images.every((s) => s.startsWith('data:image/png;base64,')));
});

test('names with markup stay text, in the page and in its embedded data', async () => {
  const name = 'Lab </script><img src=x onerror=alert(1)> & "co"';
  const { ws, source } = example(name);
  const renamed = { ...ws, samples: ws.samples.map((s, i) => (i === 0 ? { ...s, name: '<b>first</b>' } : s)) };
  const { html, model } = await buildReviewReport(renamed, source, { version: 'test', plots: 'none' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>first<\/b>/);
  assert.match(html, /&lt;b&gt;first&lt;\/b&gt;/);
  const json = /<script type="application\/json" id="cytoweave-review">([\s\S]*?)<\/script>/.exec(html)[1];
  assert.equal(JSON.parse(json).workspace.name, name);
  assert.equal(model.samples[0].name, '<b>first</b>');
  assert.doesNotMatch(html, /id="plots"/, 'no plots asked for');
});
