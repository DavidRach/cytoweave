// ISAC Classification Results (CLR) files (Spidlen et al. 2014, ISAC Classification Results File
// Format): a CSV table whose header row names the classes (populations, clusters) and whose rows
// are the events of the FCS file, in order. Each value is 1/0 for a crisp assignment or a
// probability in [0, 1] for a soft one.

function csvField(text) {
  const value = String(text);
  return /[",\n\r\t;]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Six decimals are well below any classifier's resolution; trailing zeros are dropped and
// exponent notation is never written.
function formatProbability(p) {
  if (p === 0) return '0';
  if (p === 1) return '1';
  return p.toFixed(6).replace(/\.?0+$/, '') || '0';
}

// Writes a CLR table. classes: [{ name, members: Uint32Array (event indices) } |
// { name, probabilities: Float32Array (one per event) }]. Returns the CSV text.
// options: { newline = '\n' }.
export function writeCLR(eventCount, classes, options = {}) {
  const newline = options.newline ?? '\n';
  if (!Number.isInteger(eventCount) || eventCount < 0) throw new Error('The event count must be a non-negative integer.');
  if (!classes?.length) throw new Error('A CLR file needs at least one class.');
  const names = new Set();
  const columns = classes.map((c, k) => {
    const name = String(c.name ?? '').trim();
    if (!name) throw new Error(`Class ${k + 1} has no name.`);
    if (names.has(name)) throw new Error(`Two classes are named "${name}".`);
    names.add(name);
    if (c.probabilities) {
      if (c.probabilities.length !== eventCount) throw new Error(`Class "${name}" has ${c.probabilities.length} probabilities for ${eventCount} events.`);
      for (let e = 0; e < eventCount; e += 1) {
        const p = c.probabilities[e];
        if (!(p >= 0 && p <= 1)) throw new Error(`Class "${name}", event ${e + 1}: ${p} is not a probability.`);
      }
      return { name, probabilities: c.probabilities };
    }
    const flags = new Uint8Array(eventCount);
    for (const e of c.members ?? []) {
      if (!(e >= 0 && e < eventCount) || !Number.isInteger(e)) throw new Error(`Class "${name}" lists event index ${e}, outside 0–${eventCount - 1}.`);
      flags[e] = 1;
    }
    return { name, flags };
  });
  const header = columns.map((c) => csvField(c.name)).join(',') + newline;
  const k = columns.length;
  if (columns.every((c) => c.flags)) {
    // Crisp classes only: write the digits straight into a byte buffer.
    const nl = new TextEncoder().encode(newline);
    const rowLength = 2 * k - 1 + nl.length;
    const bytes = new Uint8Array(rowLength * eventCount);
    for (let e = 0; e < eventCount; e += 1) {
      let p = e * rowLength;
      for (let j = 0; j < k; j += 1) {
        if (j) bytes[p++] = 44; // ,
        bytes[p++] = columns[j].flags[e] ? 49 : 48;
      }
      for (let i = 0; i < nl.length; i += 1) bytes[p++] = nl[i];
    }
    return header + new TextDecoder().decode(bytes);
  }
  const rows = new Array(eventCount);
  const fields = new Array(k);
  for (let e = 0; e < eventCount; e += 1) {
    for (let j = 0; j < k; j += 1) {
      const c = columns[j];
      fields[j] = c.flags ? (c.flags[e] ? '1' : '0') : formatProbability(c.probabilities[e]);
    }
    rows[e] = fields.join(',');
  }
  return header + rows.join(newline) + (eventCount ? newline : '');
}

function splitCSVLine(line, delimiter) {
  if (line.indexOf('"') < 0) return line.split(delimiter);
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

// Reads a CLR table. Returns { names, eventCount, classes: [{ name, members, probabilities }] }:
// members are the events assigned to the class (value 1, or probability ≥ options.threshold,
// default 0.5); probabilities is a Float32Array for soft classes and null for crisp ones.
// Comma, tab or semicolon delimiters, quoted names, CRLF and '#' comment lines are accepted.
export function readCLR(input, options = {}) {
  let text = typeof input === 'string' ? input : new TextDecoder().decode(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const threshold = options.threshold ?? 0.5;
  const lines = text.split(/\r\n|\n|\r/);
  let index = 0;
  const skip = () => {
    while (index < lines.length && (lines[index].trim() === '' || lines[index].trimStart().startsWith('#'))) index += 1;
  };
  skip();
  if (index >= lines.length) throw new Error('The CLR file is empty.');
  const headerLine = lines[index];
  index += 1;
  const delimiter = headerLine.includes(',') ? ',' : headerLine.includes('\t') ? '\t' : headerLine.includes(';') ? ';' : ',';
  const names = splitCSVLine(headerLine, delimiter).map((n) => n.trim());
  if (names.some((n) => !n)) throw new Error('The CLR header has an empty class name.');
  const k = names.length;
  const values = names.map(() => []);
  let row = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const fields = splitCSVLine(line, delimiter);
    if (fields.length !== k) throw new Error(`Line ${index + 1} has ${fields.length} values for ${k} classes.`);
    for (let j = 0; j < k; j += 1) {
      const value = Number(fields[j].trim());
      if (!(value >= 0 && value <= 1) || fields[j].trim() === '') throw new Error(`Line ${index + 1}, class "${names[j]}": "${fields[j]}" is not a value between 0 and 1.`);
      values[j].push(value);
    }
    row += 1;
  }
  const classes = names.map((name, j) => {
    const column = values[j];
    const crisp = column.every((v) => v === 0 || v === 1);
    const members = [];
    for (let e = 0; e < column.length; e += 1) if (crisp ? column[e] === 1 : column[e] >= threshold) members.push(e);
    return { name, members: Uint32Array.from(members), probabilities: crisp ? null : Float32Array.from(column) };
  });
  return { names, eventCount: row, classes };
}
