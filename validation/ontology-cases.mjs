// Cell Ontology suggestions against populations an expert named (the `ontology` suite of run.mjs).
// The suggestions come from each population's marker phenotype and its gates' geometry
// (ontology.js); the names are used only here, as the truth: each name says which terms are right
// for it. Populations defined by a cytokine or degranulation marker, for which the curated terms
// have no entry, are right with their parent T-cell term; quality-control gates (singlets, time,
// viability, cleanup) with their parent's term, or with none at the top of the tree.

import { gateAncestors } from '../web/lib/workspace.js';
import { suggestForPopulation } from '../web/lib/ontology.js';
import { population } from '../web/lib/engine.js';

const T = ['CL:0000084', 'CL:0002419'];
const CD4 = ['CL:0000624'];
const CD8 = ['CL:0000625'];
const TRUTH = [
  [/^lymphocytes$/i, ['CL:0000542']],
  [/^(t cells|cd3\+?)$/i, T],
  [/^(cd4\+|cd4 single positive|q3: cd4\+ , cd8-|cd4 t cells)$/i, CD4],
  [/^(cd8\+|cd8 single positive|q1: cd4- , cd8\+|cd8 t cells)$/i, CD8],
  [/^b cells$/i, ['CL:0000236', 'CL:0001201']],
  [/^nk cells$/i, ['CL:0000623']],
  [/^monocytes$/i, ['CL:0000576', 'CL:0001054', 'CL:0000860', 'CL:0002057']],
  [/^tregs$/i, ['CL:0000792', 'CL:0000815']],
  [/^ab t cells$/i, ['CL:0000789']],
  [/^gd t cells$/i, ['CL:0000798']],
  [/^nk t cells$/i, ['CL:0000814', 'CL:4052055']],
  // The Cell Ontology has no term for peripheral double-positive or double-negative T cells.
  [/^(dp|dn) t cells$/i, [...T, 'CL:0000789']],
  [/^(q2: cd4\+ , cd8\+|q4: cd4- , cd8-)$/i, T],
];
// Gates that select events for quality, not a cell type.
const QC = /^(time|singlets?\d*|single cells( \d)?|cells|live|aamine-|fsc-a, time subset|comp-live_dead aqua-a, ssc-a subset)$/i;
// Function markers: right with the parent T-cell term.
const FUNCTION = /^(ifn[gy]|tnfa|il-?\d+|cd107a)/i;

// The terms right for a population of this name: an array of term ids, [] for none (a QC gate),
// or undefined when the name says nothing a term could match (left out).
export function expectedTerms(ws, gate) {
  const name = gate.name.trim();
  for (const [re, ids] of TRUTH) if (re.test(name)) return ids;
  // A quality gate keeps its parent's cell type (singlet lymphocytes are lymphocytes); at the top
  // of the tree, none.
  if (QC.test(name)) {
    const parent = gateAncestors(ws, gate.id).at(-1);
    return parent ? expectedTerms(ws, parent) ?? [] : [];
  }
  if (FUNCTION.test(name)) {
    for (const ancestor of gateAncestors(ws, gate.id).reverse()) {
      const ids = expectedTerms(ws, ancestor);
      if (ids?.length) return ids;
    }
  }
  return undefined;
}

// Each named population's top suggestion against its expected terms, on the first sample the
// population applies to: rows { workspace, population, expected, suggested, confidence, ok }.
export function evaluate(label, ws, views) {
  const rows = [];
  const seen = new Set();
  for (const gate of ws.gates) {
    const expected = expectedTerms(ws, gate);
    if (expected === undefined) continue;
    const key = `${gate.parentId ?? ''}/${gate.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sample = ws.samples.find((s) => views.has(s.id) && population(views.get(s.id), ws, gate.id) !== undefined);
    if (!sample) continue;
    const { suggestions } = suggestForPopulation(views.get(sample.id), ws, gate.id);
    const top = suggestions[0] ?? null;
    const ok = expected.length ? Boolean(top && expected.includes(top.id)) : !top;
    rows.push({ workspace: label, population: gate.name, expected, suggested: top ? `${top.label} (${top.id})` : 'none', confidence: top?.confidence ?? null, ok });
  }
  return rows;
}
