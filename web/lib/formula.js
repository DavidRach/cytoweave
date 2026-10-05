// Formula channels: a new channel computed from others, event by event, written as an expression
// such as [CD4] / [CD8], log([FITC-A]) or ([PE-A] - 100) * 2. The expression is parsed into a
// tree and evaluated by walking it (never by eval), on the compensated values.
//
// Grammar (usual precedence; ^ binds tightest and to the right, unary minus below it):
//   expression = term { ("+" | "-") term }
//   term       = unary { ("*" | "/") unary }
//   unary      = "-" unary | power
//   power      = primary [ "^" unary ]
//   primary    = number | "[" channel "]" | name "(" expression { "," expression } ")" | "(" expression ")"
// A channel is named by its detector (FITC-A) or its marker (CD4), in square brackets. Functions:
// log (base 10), ln, exp, sqrt, abs, asinh, min and max (two or more arguments). Arithmetic is
// IEEE: x/0 is ±Infinity, 0/0 and log of a negative value NaN, and such events fall in no gate.

export const FUNCTIONS = {
  log: { arity: 1, fn: Math.log10, label: 'base-10 logarithm' },
  ln: { arity: 1, fn: Math.log, label: 'natural logarithm' },
  exp: { arity: 1, fn: Math.exp, label: 'exponential' },
  sqrt: { arity: 1, fn: Math.sqrt, label: 'square root' },
  abs: { arity: 1, fn: Math.abs, label: 'absolute value' },
  asinh: { arity: 1, fn: Math.asinh, label: 'inverse hyperbolic sine' },
  min: { arity: -2, fn: Math.min, label: 'smallest argument' },
  max: { arity: -2, fn: Math.max, label: 'largest argument' },
};

export class FormulaError extends Error {
  constructor(message, position) {
    super(message);
    this.name = 'FormulaError';
    this.position = position;
  }
}

function tokenize(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const number = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i));
    if (number) {
      tokens.push({ type: 'number', value: Number(number[0]), at: i });
      i += number[0].length;
      continue;
    }
    if (c === '[') {
      const end = text.indexOf(']', i + 1);
      if (end < 0) throw new FormulaError('A channel name opened with [ is not closed with ].', i);
      const name = text.slice(i + 1, end).trim();
      if (!name) throw new FormulaError('Empty channel name: write it between the brackets, as in [CD4].', i);
      tokens.push({ type: 'channel', value: name, at: i });
      i = end + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (word) {
      tokens.push({ type: 'name', value: word[0], at: i });
      i += word[0].length;
      continue;
    }
    if ('+-*/^(),'.includes(c)) {
      tokens.push({ type: c, at: i });
      i += 1;
      continue;
    }
    throw new FormulaError(`Unexpected "${c}".`, i);
  }
  tokens.push({ type: 'end', at: text.length });
  return tokens;
}

// Parses an expression into a tree: { op: 'num', value } | { op: 'ref', name } | { op: 'neg', a }
// | { op: '+'|'-'|'*'|'/'|'^', a, b } | { op: 'call', name, args }. Channel names are kept as
// written; resolveFormula turns them into the sample's channels.
export function parseFormula(text) {
  if (!String(text ?? '').trim()) throw new FormulaError('Write an expression, for example [CD4] / [CD8].', 0);
  // Typographic minus, times and division signs, as pasted from documents.
  const tokens = tokenize(String(text).replace(/[−–]/g, '-').replace(/×/g, '*').replace(/÷/g, '/'));
  let k = 0;
  const peek = () => tokens[k];
  const take = (type) => {
    const token = tokens[k];
    if (token.type !== type) throw new FormulaError(type === ')' ? 'A parenthesis is not closed.' : `Expected "${type}".`, token.at);
    k += 1;
    return token;
  };
  const expression = () => {
    let node = term();
    while (peek().type === '+' || peek().type === '-') {
      const op = tokens[k++].type;
      node = { op, a: node, b: term() };
    }
    return node;
  };
  const term = () => {
    let node = unary();
    while (peek().type === '*' || peek().type === '/') {
      const op = tokens[k++].type;
      node = { op, a: node, b: unary() };
    }
    return node;
  };
  const unary = () => {
    if (peek().type === '-') {
      k += 1;
      return { op: 'neg', a: unary() };
    }
    if (peek().type === '+') {
      k += 1;
      return unary();
    }
    return power();
  };
  const power = () => {
    const base = primary();
    if (peek().type === '^') {
      k += 1;
      return { op: '^', a: base, b: unary() };
    }
    return base;
  };
  const primary = () => {
    const token = peek();
    if (token.type === 'number') {
      k += 1;
      return { op: 'num', value: token.value };
    }
    if (token.type === 'channel') {
      k += 1;
      return { op: 'ref', name: token.value, at: token.at };
    }
    if (token.type === 'name') {
      k += 1;
      const fn = FUNCTIONS[token.value.toLowerCase()];
      if (!fn) {
        if (peek().type !== '(') throw new FormulaError(`"${token.value}" is not a function; write channels in brackets, as in [${token.value}].`, token.at);
        throw new FormulaError(`Unknown function "${token.value}". Functions: ${Object.keys(FUNCTIONS).join(', ')}.`, token.at);
      }
      take('(');
      const args = [expression()];
      while (peek().type === ',') {
        k += 1;
        args.push(expression());
      }
      take(')');
      const name = token.value.toLowerCase();
      if (fn.arity > 0 && args.length !== fn.arity) throw new FormulaError(`${name} takes ${fn.arity} argument${fn.arity === 1 ? '' : 's'}.`, token.at);
      if (fn.arity < 0 && args.length < -fn.arity) throw new FormulaError(`${name} takes two or more arguments.`, token.at);
      return { op: 'call', name, args };
    }
    if (token.type === '(') {
      k += 1;
      const node = expression();
      take(')');
      return node;
    }
    if (token.type === 'end') throw new FormulaError('The expression ends too soon.', token.at);
    throw new FormulaError(`Unexpected "${token.type}".`, token.at);
  };
  const tree = expression();
  if (peek().type !== 'end') throw new FormulaError(`Unexpected ${peek().type === 'number' ? 'number' : `"${peek().value ?? peek().type}"`}: is an operator missing?`, peek().at);
  return tree;
}

// The channel references of a tree, in order of first appearance.
export function formulaReferences(tree) {
  const out = [];
  const walk = (node) => {
    if (node.op === 'ref') {
      if (!out.includes(node.name)) out.push(node.name);
    } else if (node.op === 'call') node.args.forEach(walk);
    else {
      if (node.a) walk(node.a);
      if (node.b) walk(node.b);
    }
  };
  walk(tree);
  return out;
}

// A copy of the tree with every reference renamed by rename(name) (which may throw).
export function mapReferences(tree, rename) {
  const walk = (node) => {
    if (node.op === 'ref') return { op: 'ref', name: rename(node.name), at: node.at };
    if (node.op === 'call') return { ...node, args: node.args.map(walk) };
    return { ...node, ...(node.a ? { a: walk(node.a) } : {}), ...(node.b ? { b: walk(node.b) } : {}) };
  };
  return walk(tree);
}

// Resolves a formula's references against channels ([{ name, marker }]): a detector name exactly,
// else a marker (ignoring case, spaces and hyphens) that names one channel only. Returns
// { tree (references renamed to channel names), inputs, text (canonical, with detector names) }.
export function resolveFormula(text, channels) {
  const tree = parseFormula(text);
  const plain = (s) => String(s ?? '').toUpperCase().replace(/[\s_\-]+/g, '');
  const resolved = mapReferences(tree, (name) => {
    const exact = channels.find((c) => c.name === name);
    if (exact) return exact.name;
    const byMarker = channels.filter((c) => c.marker && plain(c.marker) === plain(name));
    if (byMarker.length === 1) return byMarker[0].name;
    const byName = channels.filter((c) => plain(c.name) === plain(name));
    if (byName.length === 1) return byName[0].name;
    const at = findRef(tree, name)?.at ?? 0;
    if (byMarker.length > 1) throw new FormulaError(`${byMarker.length} channels measure ${name} (${byMarker.map((c) => c.name).join(', ')}); name the detector instead.`, at);
    throw new FormulaError(`No channel "${name}".`, at);
  });
  return { tree: resolved, inputs: formulaReferences(resolved), text: formulaText(resolved) };
}

function findRef(tree, name) {
  if (tree.op === 'ref') return tree.name === name ? tree : null;
  for (const child of tree.op === 'call' ? tree.args : [tree.a, tree.b].filter(Boolean)) {
    const found = findRef(child, name);
    if (found) return found;
  }
  return null;
}

const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2, neg: 3, '^': 4 };

// The expression of a tree, with only the parentheses it needs. nameOf(name) writes a reference
// (default: the name itself).
export function formulaText(tree, nameOf = (name) => name) {
  const write = (node, parent = 0, right = false) => {
    switch (node.op) {
      case 'num': return Number.isInteger(node.value) || Math.abs(node.value) >= 1e-4 ? String(+node.value.toPrecision(15)) : node.value.toExponential();
      case 'ref': return `[${nameOf(node.name)}]`;
      case 'call': return `${node.name}(${node.args.map((a) => write(a)).join(', ')})`;
      case 'neg': {
        const text = `-${write(node.a, PRECEDENCE.neg)}`;
        return parent > PRECEDENCE.neg ? `(${text})` : text;
      }
      default: {
        const p = PRECEDENCE[node.op];
        // Left-associative operators need parentheses around a right operand of equal precedence
        // (a − (b − c)); ^ is right-associative, so the other way round.
        const text = node.op === '^'
          ? `${write(node.a, p + 1)} ^ ${write(node.b, p)}`
          : `${write(node.a, p)} ${node.op} ${write(node.b, p + 1, true)}`;
        return p < parent || (right && p === parent) ? `(${text})` : text;
      }
    }
  };
  return write(tree);
}

// Evaluates a resolved tree over whole columns: columns(name) gives a channel's values; returns a
// Float64Array of n values.
export function evaluateColumns(tree, columns, n) {
  const walk = (node) => {
    const out = new Float64Array(n);
    switch (node.op) {
      case 'num': out.fill(node.value); return out;
      case 'ref': {
        const column = columns(node.name);
        for (let i = 0; i < n; i += 1) out[i] = column[i];
        return out;
      }
      case 'neg': {
        const a = walk(node.a);
        for (let i = 0; i < n; i += 1) out[i] = -a[i];
        return out;
      }
      case 'call': {
        const args = node.args.map(walk);
        const { fn } = FUNCTIONS[node.name];
        if (args.length === 1) {
          const [a] = args;
          for (let i = 0; i < n; i += 1) out[i] = fn(a[i]);
        } else {
          for (let i = 0; i < n; i += 1) {
            let v = args[0][i];
            for (let j = 1; j < args.length; j += 1) v = fn(v, args[j][i]);
            out[i] = v;
          }
        }
        return out;
      }
      default: {
        const a = walk(node.a);
        const b = walk(node.b);
        switch (node.op) {
          case '+': for (let i = 0; i < n; i += 1) out[i] = a[i] + b[i]; break;
          case '-': for (let i = 0; i < n; i += 1) out[i] = a[i] - b[i]; break;
          case '*': for (let i = 0; i < n; i += 1) out[i] = a[i] * b[i]; break;
          case '/': for (let i = 0; i < n; i += 1) out[i] = a[i] / b[i]; break;
          default: for (let i = 0; i < n; i += 1) out[i] = a[i] ** b[i];
        }
        return out;
      }
    }
  };
  return walk(tree);
}

// Evaluates a resolved tree for one event: value(name) gives a channel's value.
export function evaluateFormula(tree, value) {
  switch (tree.op) {
    case 'num': return tree.value;
    case 'ref': return value(tree.name);
    case 'neg': return -evaluateFormula(tree.a, value);
    case 'call': {
      const args = tree.args.map((a) => evaluateFormula(a, value));
      return args.length === 1 ? FUNCTIONS[tree.name].fn(args[0]) : args.reduce((v, x) => FUNCTIONS[tree.name].fn(v, x));
    }
    default: {
      const a = evaluateFormula(tree.a, value);
      const b = evaluateFormula(tree.b, value);
      switch (tree.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        default: return a ** b;
      }
    }
  }
}

// The Gating-ML 2.0 fratio form A·(x − B)/(y − C) of a resolved tree, when it has one:
// { numerator, denominator, A, B, C } or null. Recognized: x / y, (x ± B) / (y ± C), and these
// multiplied or divided by a number (on either side of the multiplication).
export function asRatio(tree) {
  const constant = (node) => (node.op === 'num' ? node.value : node.op === 'neg' && node.a.op === 'num' ? -node.a.value : null);
  // x, x − B, x + B, B + x as [channel, offset subtracted].
  const shifted = (node) => {
    if (node.op === 'ref') return [node.name, 0];
    if ((node.op === '-' || node.op === '+') && node.a.op === 'ref' && constant(node.b) !== null) return [node.a.name, node.op === '-' ? constant(node.b) : -constant(node.b)];
    if (node.op === '+' && node.b.op === 'ref' && constant(node.a) !== null) return [node.b.name, -constant(node.a)];
    return null;
  };
  const ratio = (node) => {
    if (node.op !== '/') return null;
    const top = shifted(node.a);
    const bottom = shifted(node.b);
    if (!top || !bottom) return null;
    return { numerator: top[0], denominator: bottom[0], A: 1, B: top[1], C: bottom[1] };
  };
  const scaled = (node) => {
    const direct = ratio(node);
    if (direct) return direct;
    if (node.op === '*') {
      const [k, rest] = constant(node.a) !== null ? [constant(node.a), node.b] : constant(node.b) !== null ? [constant(node.b), node.a] : [null, null];
      const inner = k !== null ? ratio(rest) : null;
      return inner ? { ...inner, A: inner.A * k } : null;
    }
    if (node.op === '/' && constant(node.b) !== null) {
      const inner = ratio(node.a);
      return inner ? { ...inner, A: inner.A / constant(node.b) } : null;
    }
    // (k · (x − B)) / (y − C)
    if (node.op === '/' && node.a.op === '*') {
      const k = constant(node.a.a) ?? constant(node.a.b);
      const rest = constant(node.a.a) !== null ? node.a.b : node.a.a;
      const inner = k !== null ? ratio({ op: '/', a: rest, b: node.b }) : null;
      return inner ? { ...inner, A: inner.A * k } : null;
    }
    return null;
  };
  return scaled(tree);
}
