// Common fluorochromes for panel design (S9): each dye's relative brightness, its absorption and
// emission maxima, and the dye a tandem is built on. The panel optimizer (panel-optimizer.js)
// takes a dye's brightness from here unless the user gives one, and warns of pairs prone to
// energy transfer from the maxima.
//
// Brightness is the signal per bound antibody relative to the other dyes, in the order of the
// vendors' brightness (stain index) charts; the values of the dyes the simulator knows are its own
// (simulate.js FLUOROCHROMES), so a simulated panel is designed with the brightness it was made
// with. They are approximate: a dye's brightness also depends on the instrument's lasers and
// filters, the antibody's degree of labeling and the lot.
//
// Maxima are the vendors' published absorption (excitation) and emission maxima in nm; a tandem
// absorbs as its donor (PE-Cy7 at PE's 565 nm) and emits as its acceptor.

import { FLUOROCHROMES } from './simulate.js';

// name, absorption max, emission max, brightness (null: the simulator's), donor (a tandem's dye),
// aliases.
const TABLE = [
  ['BUV395', 348, 395, null, null],
  ['BUV496', 348, 496, null, 'BUV395'],
  ['BUV563', 348, 563, null, 'BUV395'],
  ['BUV615', 348, 615, null, 'BUV395'],
  ['BUV661', 348, 661, null, 'BUV395'],
  ['BUV737', 348, 737, null, 'BUV395'],
  ['BUV805', 348, 805, null, 'BUV395'],
  ['BV421', 407, 421, null, null, ['Brilliant Violet 421']],
  ['BV480', 436, 478, null, null, ['Brilliant Violet 480']],
  ['BV510', 405, 510, 0.2, 'BV421', ['Brilliant Violet 510']],
  ['BV570', 407, 570, null, 'BV421', ['Brilliant Violet 570']],
  ['BV605', 407, 603, null, 'BV421', ['Brilliant Violet 605']],
  ['BV650', 407, 645, null, 'BV421', ['Brilliant Violet 650']],
  ['BV711', 407, 711, null, 'BV421', ['Brilliant Violet 711']],
  ['BV750', 407, 750, null, 'BV421', ['Brilliant Violet 750']],
  ['BV786', 407, 786, null, 'BV421', ['Brilliant Violet 785', 'BV785']],
  ['Pacific Blue', 401, 452, 0.12, null, ['PB']],
  ['eFluor 450', 405, 450, 0.12, null, ['eF450']],
  ['Aqua', 367, 526, null, null, ['LIVE/DEAD Aqua', 'Live Dead Aqua']],
  ['Zombie Aqua', 405, 516, 0.2, null],
  ['FVS440UV', 350, 440, 0.3, null, ['Fixable Viability Stain 440UV']],
  ['FVS510', 405, 510, 0.2, null, ['Fixable Viability Stain 510']],
  ['LIVE/DEAD Blue', 350, 450, 0.3, null, ['Live Dead Blue']],
  ['FITC', 494, 519, null, null],
  ['Alexa Fluor 488', 495, 519, null, null, ['AF488', 'A488']],
  ['BB515', 490, 515, null, null],
  ['BB700', 485, 695, 0.3, null],
  ['PerCP', 482, 678, 0.1, null],
  ['PerCP-Cy5.5', 482, 695, null, 'PerCP', ['PerCP-Cy5-5', 'PerCP Cy5.5']],
  ['PerCP-eFluor 710', 482, 710, 0.2, 'PerCP', ['PerCP-eF710']],
  ['PE', 565, 578, null, null, ['R-PE']],
  ['PE-CF594', 565, 612, null, 'PE', ['PE-Dazzle 594', 'PE Dazzle 594', 'PE-Texas Red', 'ECD']],
  ['PE-Cy5', 565, 667, null, 'PE'],
  ['PE-Cy5.5', 565, 695, 0.35, 'PE', ['PE-Cy5-5']],
  ['PE-Cy7', 565, 780, null, 'PE'],
  ['PE-Fire 640', 565, 640, 0.45, 'PE'],
  ['PE-Fire 700', 565, 700, 0.4, 'PE'],
  ['PE-Fire 810', 565, 810, 0.25, 'PE'],
  ['APC', 650, 660, null, null],
  ['Alexa Fluor 647', 650, 668, null, null, ['AF647', 'A647']],
  ['Alexa Fluor 700', 696, 719, null, null, ['AF700', 'A700']],
  ['APC-R700', 652, 704, 0.25, 'APC'],
  ['APC-Cy7', 650, 785, null, 'APC'],
  ['APC-H7', 650, 785, 0.2, 'APC'],
  ['APC-Fire 750', 650, 787, 0.25, 'APC'],
  ['APC-Fire 810', 650, 810, 0.15, 'APC'],
  ['Zombie NIR', 719, 746, null, null],
  ['PI', 535, 617, null, null, ['Propidium iodide']],
  ['7-AAD', 546, 647, 0.4, null],
  ['DAPI', 358, 461, 0.5, null],
];

const key = (name) => String(name ?? '').trim().toLowerCase().replace(/[\s_]+/g, '').replace(/[‐–—]/g, '-');

export const DYES = TABLE.map(([name, absorption, emission, brightness, donor, aliases = []]) => ({
  name,
  absorption,
  emission,
  brightness: brightness ?? FLUOROCHROMES[name]?.brightness ?? null,
  donor,
  aliases,
}));

const BY_KEY = new Map();
for (const dye of DYES) for (const n of [dye.name, ...dye.aliases]) BY_KEY.set(key(n), dye);

// The table's entry of a dye name (as written in a panel, a library entry or a control's name,
// e.g. "CD8 BV480"), or null.
export function dyeInfo(name) {
  const text = String(name ?? '');
  const direct = BY_KEY.get(key(text));
  if (direct) return direct;
  // A control named "<marker> <dye>": the longest table name it ends with.
  let best = null;
  for (const [k, dye] of BY_KEY) if (key(text).endsWith(k) && (!best || k.length > best.k.length)) best = { k, dye };
  return best?.dye ?? null;
}

// The relative brightness of a dye, or null when the table does not know it.
export function dyeBrightness(name) {
  return dyeInfo(name)?.brightness ?? null;
}

// Donor emission within this window of the acceptor's absorption maximum (nm): from 75 nm bluer
// (absorption bands extend to the blue of their maximum) to 20 nm redder.
const OVERLAP = { blue: 75, red: 20 };

// Pairs of dyes on the same cells that can pass energy between them, for a list of [dyeA, dyeB]
// pairs of co-expressed markers: [{ a, b, kind: 'tandem' | 'transfer', donor, acceptor, gap
// (nm, emission − absorption), note }].
// - tandem: a tandem dye and the dye it is built on. A tandem that breaks down (light, fixation,
//   cellular metabolism) emits as its donor, into the donor dye's channel, on the cells that carry
//   both.
// - transfer: the donor's emission falls where the acceptor absorbs (its emission maximum within
//   75 nm bluer to 20 nm redder than the acceptor's absorption maximum), so on molecules within
//   about 10 nm of each other (the same protein or complex) the acceptor can quench the donor and
//   gain its signal (Förster transfer).
export function energyTransferPairs(pairs) {
  const out = [];
  const seen = new Set();
  for (const [x, y] of pairs) {
    const a = dyeInfo(x);
    const b = dyeInfo(y);
    if (!a || !b || a === b) continue;
    const id = [a.name, b.name].sort().join('|');
    if (seen.has(id)) continue;
    seen.add(id);
    const tandem = a.donor === b.name ? [a, b] : b.donor === a.name ? [b, a] : null;
    if (tandem) {
      out.push({ a: x, b: y, kind: 'tandem', donor: tandem[1].name, acceptor: tandem[0].name, gap: null, note: `${tandem[0].name} is a tandem of ${tandem[1].name}: where it degrades it emits as ${tandem[1].name}, into ${tandem[1].name}'s channel on the cells that carry both.` });
      continue;
    }
    for (const [donor, acceptor, dx, dy] of [[a, b, x, y], [b, a, y, x]]) {
      const gap = donor.emission - acceptor.absorption;
      if (acceptor.emission <= donor.emission + 10 || gap < -OVERLAP.blue || gap > OVERLAP.red) continue;
      out.push({ a: dx, b: dy, kind: 'transfer', donor: donor.name, acceptor: acceptor.name, gap, note: `${donor.name} emits at ${donor.emission} nm, where ${acceptor.name} absorbs (maximum ${acceptor.absorption} nm).` });
      break;
    }
  }
  return out.sort((p, q) => (p.kind === q.kind ? Math.abs(p.gap ?? 0) - Math.abs(q.gap ?? 0) : p.kind === 'tandem' ? -1 : 1));
}
