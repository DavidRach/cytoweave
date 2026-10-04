import assert from 'node:assert/strict';
import test from 'node:test';
import { suggestTerms } from './ontology.js';

const top = (markers, options) => suggestTerms(markers, options)[0]?.label;

test('a more specific term that fits on its own evidence comes before its ancestors', () => {
  // CD45+ says leukocyte; CD3+ says T cell, which is a leukocyte.
  assert.equal(top({ CD45: '+', CD3: '+' }), 'T cell');
  const all = suggestTerms({ CD45: '+', CD3: '+' }, { limit: 20 }).map((s) => s.label);
  assert.ok(all.includes('leukocyte'), 'the ancestor stays listed');
});

test('the scatter class counts as evidence, and rules out terms of another class', () => {
  assert.equal(top({ CD45: '+' }, { scatter: 'lymphoid' }), 'lymphocyte');
  const monocytic = suggestTerms({ CD45: '+' }, { scatter: 'monocytic', limit: 20 }).map((s) => s.label);
  assert.ok(!monocytic.includes('lymphocyte'));
});

test('a term keeps its ancestors\' phenotype: double-positive T cells are no CD4-positive memory T cells', () => {
  const labels = suggestTerms({ CD3: '+', CD4: '+', CD8: '+', CD45RA: '-' }, { limit: 20 }).map((s) => s.label);
  assert.ok(!labels.some((l) => /CD4-positive/.test(l)), labels.join('; '));
});

test('but not an ancestor phenotype its own contradicts: NK cells are ILCs in CL without being CD56−', () => {
  assert.equal(top({ CD3: '-', CD19: '-', CD56: '+' }, { scatter: 'lymphoid' }), 'natural killer cell');
});
