// Fuzzes the FCS reader beyond what the validation suite runs (fuzz-cases.mjs describes the cases
// and the rule they are held to).
//
//   node validation/fuzz.mjs                       20,000 cases, seed 1, with the corpus if downloaded
//   node validation/fuzz.mjs --cases 200000 --seed 7
//   node validation/fuzz.mjs --no-corpus
//   node validation/fuzz.mjs --replay int16-le 1000510 [--out case.fcs]
//
// Exits with status 1 when a case fails; each failure prints the command that replays it.

import { writeFileSync } from 'node:fs';
import { corpusFiles, fuzz, replay } from './fuzz-cases.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const corpus = args.includes('--no-corpus') ? [] : corpusFiles();

if (args.includes('--replay')) {
  const i = args.indexOf('--replay');
  const { bytes, applied, result } = await replay(args[i + 1], Number(args[i + 2]), corpus);
  console.log(`${args[i + 1]} #${args[i + 2]}: ${applied.join(' + ')} → ${result.outcome}${result.problem ? `: ${result.problem}` : ''} (${result.ms.toFixed(1)} ms)`);
  const out = option('--out');
  if (out) {
    writeFileSync(out, bytes);
    console.log(`Wrote the mutated file to ${out}.`);
  }
  process.exit(result.problem ? 1 : 0);
}

const seed = Number(option('--seed', 1));
const count = Number(option('--cases', 20000));
const started = performance.now();
const summary = await fuzz({ seed, count, corpus });
console.log(`${summary.count} cases over ${summary.files} files (${corpus.length} from the corpus), seed ${seed}: ${summary.read} read, ${summary.refused} refused, ${summary.failures.length} failed, in ${((performance.now() - started) / 1000).toFixed(1)} s; slowest ${summary.slowest.toFixed(0)} ms (${summary.slowestCase}).`);
for (const f of summary.failures.slice(0, 50)) {
  console.log(`FAIL ${f.file}${f.seed === null ? '' : ` #${f.seed}`} (${f.applied.join(' + ') || 'unmutated'}): ${f.problem}`);
  if (f.seed !== null) console.log(`     node validation/fuzz.mjs --replay ${f.file} ${f.seed}${corpus.length ? '' : ' --no-corpus'}`);
}
process.exit(summary.failures.length ? 1 : 0);
