import assert from 'node:assert/strict';
import test from 'node:test';
import { FormulaError, asRatio, evaluateColumns, evaluateFormula, formulaText, parseFormula, resolveFormula } from './formula.js';

const CHANNELS = [
  { name: 'FITC-A', marker: 'CD4' },
  { name: 'PE-A', marker: 'CD8' },
  { name: 'APC-A', marker: 'HLA-DR' },
  { name: 'FSC-A', marker: '' },
];

const at = (text, values) => evaluateFormula(resolveFormula(text, CHANNELS).tree, (name) => values[name]);

test('precedence, associativity and unary minus', () => {
  const v = { 'FITC-A': 2, 'PE-A': 3 };
  assert.equal(at('1 + 2 * 3', v), 7);
  assert.equal(at('(1 + 2) * 3', v), 9);
  assert.equal(at('10 - 4 - 3', v), 3);
  assert.equal(at('24 / 4 / 3', v), 2);
  assert.equal(at('2 ^ 3 ^ 2', v), 512, '^ is right-associative');
  assert.equal(at('-2 ^ 2', v), -4, 'unary minus below ^');
  assert.equal(at('2 ^ -1', v), 0.5);
  assert.equal(at('[CD4] * [CD8] - -1', v), 7);
  assert.equal(at('1.5e2 + .5', v), 150.5);
  assert.equal(at('[CD4] − 1 × 2 ÷ 4', v), 1.5, 'typographic signs');
});

test('channels by detector or marker, functions, IEEE results', () => {
  const v = { 'FITC-A': 100, 'PE-A': -4, 'APC-A': 0, 'FSC-A': 5e4 };
  assert.equal(at('log([FITC-A])', v), 2);
  assert.equal(at('[cd4] / [HLADR]', v), Infinity);
  assert.ok(Number.isNaN(at('log([CD8])', v)));
  assert.equal(at('max([CD4], [CD8], 7)', v), 100);
  assert.equal(at('min([CD4], [CD8])', v), -4);
  assert.equal(at('sqrt(abs([CD8]))', v), 2);
  assert.equal(at('asinh([CD4] / 150)', v), Math.asinh(100 / 150));
  assert.ok(Math.abs(at('exp(ln([FSC-A]))', v) - 5e4) < 1e-9);
  const r = resolveFormula('[CD4]/[cd8] + [FSC-A]', CHANNELS);
  assert.deepEqual(r.inputs, ['FITC-A', 'PE-A', 'FSC-A']);
  assert.equal(r.text, '[FITC-A] / [PE-A] + [FSC-A]');
});

test('errors say what is wrong and where', () => {
  const error = (text) => {
    try {
      resolveFormula(text, CHANNELS);
    } catch (e) {
      assert.ok(e instanceof FormulaError, e.message);
      return e;
    }
    return assert.fail(`no error for ${text}`);
  };
  assert.match(error('[CD4] / ').message, /ends too soon/);
  assert.match(error('[CD4] [CD8]').message, /operator missing/);
  assert.match(error('(1 + [CD4]').message, /not closed/);
  assert.match(error('CD4 / 2').message, /in brackets/);
  assert.match(error('foo([CD4])').message, /Unknown function/);
  assert.match(error('[CD45]').message, /No channel "CD45"/);
  assert.equal(error('[CD4] / [CD45]').position, 8);
  assert.match(error('log([CD4], 2)').message, /takes 1 argument/);
  assert.match(error('min([CD4])').message, /two or more/);
  assert.match(error('[CD4] $ 2').message, /Unexpected "\$"/);
  assert.match(error('').message, /Write an expression/);
  const twice = [{ name: 'FITC-A', marker: 'CD4' }, { name: 'BV421-A', marker: 'CD4' }];
  assert.throws(() => resolveFormula('[CD4]', twice), /2 channels measure CD4/);
});

test('text round trips with only the parentheses it needs', () => {
  for (const text of ['[a] - ([b] - [c])', '[a] - [b] - [c]', '[a] / ([b] * [c])', '([a] + [b]) * [c]', '[a] ^ [b] ^ [c]', '([a] ^ [b]) ^ [c]', '(-[a]) ^ 2', '-[a] ^ 2', 'log([a] + 1) / 2', 'max([a], [b], 3)']) {
    assert.equal(formulaText(parseFormula(text)), text);
  }
  assert.equal(formulaText(parseFormula('((([a])))*2')), '[a] * 2');
  assert.equal(formulaText(parseFormula('([a] - [b]) - [c]')), '[a] - [b] - [c]');
});

test('column evaluation equals event-by-event evaluation', () => {
  const columns = { 'FITC-A': Float32Array.from([1, 10, 100, -5]), 'PE-A': Float32Array.from([2, 0, 50, 3]) };
  const { tree } = resolveFormula('log(abs([CD4]) + 1) * [CD8] / ([CD4] - 1) ^ 2', CHANNELS);
  const out = evaluateColumns(tree, (name) => columns[name], 4);
  for (let i = 0; i < 4; i += 1) {
    const expected = evaluateFormula(tree, (name) => columns[name][i]);
    assert.ok(Object.is(out[i], expected) || Math.abs(out[i] - expected) < 1e-12, `${i}: ${out[i]} vs ${expected}`);
  }
});

test('the Gating-ML fratio form of ratios', () => {
  const ratio = (text) => asRatio(resolveFormula(text, CHANNELS).tree);
  assert.deepEqual(ratio('[CD4] / [CD8]'), { numerator: 'FITC-A', denominator: 'PE-A', A: 1, B: 0, C: 0 });
  assert.deepEqual(ratio('2 * ([CD4] - 10) / ([CD8] + 5)'), { numerator: 'FITC-A', denominator: 'PE-A', A: 2, B: 10, C: -5 });
  assert.deepEqual(ratio('([CD4] - 10) / ([CD8] - 5) * 3'), { numerator: 'FITC-A', denominator: 'PE-A', A: 3, B: 10, C: 5 });
  assert.deepEqual(ratio('[CD4] / [CD8] / 4'), { numerator: 'FITC-A', denominator: 'PE-A', A: 0.25, B: 0, C: 0 });
  assert.equal(ratio('log([CD4] / [CD8])'), null);
  assert.equal(ratio('[CD4] / [CD8] + 1'), null);
  assert.equal(ratio('[CD4] * [CD8]'), null);
});
