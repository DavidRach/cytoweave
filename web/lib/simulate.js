// Simulated cytometry: the building blocks of CytoWeave's example experiments.
//
// The model follows how an instrument turns cells into numbers, so that simulated files behave
// like real ones under every analysis step:
//   cells    a mixture of populations, each a multivariate log-normal in "true" space (scatter,
//            autofluorescence and marker amounts), correlated through a shared cell-size factor
//            and optional marker pairs;
//   optics   fluorochrome emission spectra seen through each detector's laser and filter, which
//            gives both conventional spillover matrices and full spectral signatures;
//   noise    photon counting noise with variance proportional to the signal (Poisson
//            photoelectron statistics, the source of spillover spreading error; Nguyen et al.
//            2013) plus Gaussian electronic noise around a subtracted baseline, so dim events
//            go negative as on BD FACSDiva; values clip at $PnR − 1; optionally, each laser's
//            intensity fluctuates from event to event (config.laserCV), which spreads a dye
//            excited by several lasers into other channels in proportion to its brightness;
//   pulses   scatter area/height/width from a pulse-width model: singlets have H ≈ A / w,
//            doublets add areas and lengthen the pulse, so A/H rises;
//   events   debris, dead cells, doublets, an acquisition clock with Poisson arrivals, and
//            fluidic anomalies (clogs, bursts, drift) that QC methods should find;
//   mass     ion counts for mass cytometry: Poisson counting, oxide and isotopic spillover,
//            zero inflation, Helios-style randomization and Gaussian discrimination parameters.
//
// Everything is deterministic for a seed (web/lib/random.js) and allocation-free per event.

import { writeFCS } from './fcs.js';
import { createRandom, hashString, shuffle } from './random.js';

export const SIMULATOR_VERSION = '1.0';

// --- Random variates ----------------------------------------------------------------------------

export function exponential(random, mean = 1) {
  return -Math.log(1 - random()) * mean;
}

// Standard normal variates by the ziggurat method (Marsaglia & Tsang 2000, J Stat Softw 5(8)),
// driven by the seeded generator's 32-bit output: about four times faster than the polar
// method, which matters at tens of normals per event and millions of events.
const ZIGGURAT = (() => {
  const kn = new Float64Array(128);
  const wn = new Float64Array(128);
  const fn = new Float64Array(128);
  const m1 = 2147483648;
  let dn = 3.442619855899;
  let tn = dn;
  const vn = 9.91256303526217e-3;
  const q = vn / Math.exp(-0.5 * dn * dn);
  kn[0] = Math.floor((dn / q) * m1);
  kn[1] = 0;
  wn[0] = q / m1;
  wn[127] = dn / m1;
  fn[0] = 1;
  fn[127] = Math.exp(-0.5 * dn * dn);
  for (let i = 126; i >= 1; i -= 1) {
    dn = Math.sqrt(-2 * Math.log(vn / dn + Math.exp(-0.5 * dn * dn)));
    kn[i + 1] = Math.floor((dn / tn) * m1);
    tn = dn;
    fn[i] = Math.exp(-0.5 * dn * dn);
    wn[i] = dn / m1;
  }
  return { kn, wn, fn };
})();

export function createNormal(random) {
  const { kn, wn, fn } = ZIGGURAT;
  const next = random.uint32;
  const uniform = () => (next() + 0.5) / 4294967296;
  const tail = (hz, iz) => {
    for (;;) {
      let x = hz * wn[iz];
      if (iz === 0) {
        let y;
        do {
          x = -Math.log(uniform()) * 0.2904764;
          y = -Math.log(uniform());
        } while (y + y < x * x);
        return hz > 0 ? 3.44262 + x : -3.44262 - x;
      }
      if (fn[iz] + uniform() * (fn[iz - 1] - fn[iz]) < Math.exp(-0.5 * x * x)) return x;
      hz = next() | 0;
      iz = hz & 127;
      if (Math.abs(hz) < kn[iz]) return hz * wn[iz];
    }
  };
  return () => {
    const hz = next() | 0;
    const iz = hz & 127;
    return Math.abs(hz) < kn[iz] ? hz * wn[iz] : tail(hz, iz);
  };
}

// ln Γ(x) for x > 0: Stirling's series after shifting x ≥ 10 (error < 1e-12).
export function logGamma(x) {
  let shift = 0;
  let y = x;
  while (y < 10) {
    shift += Math.log(y);
    y += 1;
  }
  const y2 = 1 / (y * y);
  const series = (1 / 12 - y2 * (1 / 360 - y2 * (1 / 1260 - y2 / 1680))) / y;
  return (y - 0.5) * Math.log(y) - y + 0.9189385332046728 + series - shift;
}

// Poisson variate: sequential inversion for small λ, PTRS transformed rejection (Hörmann 1993,
// as in NumPy) for λ ≥ 10.
export function poisson(random, lambda) {
  if (!(lambda > 0)) return 0;
  if (lambda < 10) {
    let x = 0;
    let p = Math.exp(-lambda);
    let s = p;
    const u = random();
    while (u > s && x < 200) {
      x += 1;
      p *= lambda / x;
      s += p;
    }
    return x;
  }
  const slam = Math.sqrt(lambda);
  const loglam = Math.log(lambda);
  const b = 0.931 + 2.53 * slam;
  const a = -0.059 + 0.02483 * b;
  const invalpha = 1.1239 + 1.1328 / (b - 3.4);
  const vr = 0.9277 - 3.6224 / (b - 2);
  for (;;) {
    const U = random() - 0.5;
    const V = random();
    const us = 0.5 - Math.abs(U);
    const k = Math.floor((2 * a / us + b) * U + lambda + 0.43);
    if (us >= 0.07 && V <= vr) return k;
    if (k < 0 || (us < 0.013 && V > us)) continue;
    if (Math.log(V) + Math.log(invalpha) - Math.log(a / (us * us) + b) <= -lambda + k * loglam - logGamma(k + 1)) return k;
  }
}

// Exact integer counts proportional to weights (largest remainder), so a population specified
// at 7% is 7% of the events, not 7% ± sampling error.
export function allocateCounts(total, weights) {
  const n = weights.length;
  const counts = new Int32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += Math.max(0, weights[i]);
  if (!(sum > 0) || total <= 0) return counts;
  const remainders = new Float64Array(n);
  let assigned = 0;
  for (let i = 0; i < n; i += 1) {
    const exact = (total * Math.max(0, weights[i])) / sum;
    counts[i] = Math.floor(exact);
    remainders[i] = exact - counts[i];
    assigned += counts[i];
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => remainders[y] - remainders[x] || x - y);
  for (let k = 0; assigned < total; k += 1) {
    counts[order[k % n]] += 1;
    assigned += 1;
  }
  return counts;
}

// Labels 0…k−1 repeated counts[i] times, in random order.
// Each of `count` events independently takes kind i with probability weights[i] / Σ weights: the
// multinomial counting noise of a real tube, which exact allocation would remove (two tubes of
// one donor would then have identical population counts).
export function sampledLabels(count, weights, random) {
  const pick = createPicker(weights, random);
  const labels = new Int32Array(count);
  for (let e = 0; e < count; e += 1) labels[e] = pick();
  return labels;
}

export function shuffledLabels(counts, random) {
  let total = 0;
  for (let i = 0; i < counts.length; i += 1) total += counts[i];
  const labels = new Int32Array(total);
  let pos = 0;
  for (let i = 0; i < counts.length; i += 1) {
    labels.fill(i, pos, pos + counts[i]);
    pos += counts[i];
  }
  return shuffle(labels, random);
}

// Lower-triangular Cholesky factor of a symmetric matrix (row-major), or null if not positive
// definite.
export function cholesky(matrix, n) {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = matrix[i * n + j];
      for (let k = 0; k < j; k += 1) sum -= L[i * n + k] * L[j * n + k];
      if (i === j) {
        if (!(sum > 1e-10)) return null;
        L[i * n + i] = Math.sqrt(sum);
      } else {
        L[i * n + j] = sum / L[j * n + j];
      }
    }
  }
  return L;
}

// A per-file seed from a base seed and names, so any one file regenerates identically on its own.
export function deriveSeed(seed, ...parts) {
  return hashString(`${seed >>> 0}|${parts.join('|')}`) || 1;
}

// --- Optics: lasers, fluorochromes, detectors ---------------------------------------------------

export const LASERS = { UV: 355, V: 405, B: 488, YG: 561, R: 640 };

// Emission component: a skewed Gaussian (left/right widths in nm) with an optional exponential
// red tail, which real dyes have and which drives most spillover into longer-wavelength detectors.
function band(peak, left, right, weight = 1, tail = 0, tau = 60) {
  return { peak, left, right, weight, tail, tau };
}

// Approximate excitation efficiencies per laser and emission spectra of common fluorochromes,
// shaped after published spectra (tandems carry a small donor peak). `brightness` is the
// signal per bound antibody on a BD-class instrument at its primary detector (stain index
// ordering as in vendor brightness charts). AF/AFM are cellular autofluorescence (NAD(P)H and
// flavins; lymphoid and the brighter, red-shifted myeloid type).
export const FLUOROCHROMES = {
  BUV395: { ex: { UV: 1, V: 0.02 }, em: [band(395, 10, 22, 1, 0.15, 60)], brightness: 0.25 },
  BUV496: { ex: { UV: 1, V: 0.08, B: 0.02 }, em: [band(496, 14, 26, 1, 0.15, 60)], brightness: 0.35 },
  BUV563: { ex: { UV: 1, V: 0.04, B: 0.03, YG: 0.08 }, em: [band(563, 10, 22, 1, 0.15, 60), band(395, 10, 18, 0.06)], brightness: 0.5 },
  BUV615: { ex: { UV: 1, V: 0.05, B: 0.02, YG: 0.06 }, em: [band(615, 12, 26, 1, 0.15, 60), band(395, 10, 18, 0.05)], brightness: 0.45 },
  BUV661: { ex: { UV: 1, V: 0.05, YG: 0.02, R: 0.12 }, em: [band(661, 12, 26, 1, 0.12, 60), band(395, 10, 18, 0.03)], brightness: 0.4 },
  BUV737: { ex: { UV: 1, V: 0.06, YG: 0.02, R: 0.1 }, em: [band(737, 15, 30, 1, 0.1, 60), band(395, 10, 18, 0.03)], brightness: 0.3 },
  BUV805: { ex: { UV: 1, V: 0.05, R: 0.05 }, em: [band(805, 15, 30, 1), band(395, 10, 18, 0.04)], brightness: 0.2 },
  BV421: { ex: { UV: 0.35, V: 1, B: 0.01 }, em: [band(421, 10, 24, 1, 0.35, 90)], brightness: 0.6 },
  BV480: { ex: { UV: 0.3, V: 1, B: 0.03 }, em: [band(478, 14, 28, 1, 0.25, 80)], brightness: 0.35 },
  Aqua: { ex: { UV: 0.25, V: 1, B: 0.04 }, em: [band(516, 18, 36, 1, 0.25, 80)], brightness: 0.2 },
  BV570: { ex: { UV: 0.3, V: 1, B: 0.04, YG: 0.02 }, em: [band(570, 14, 30, 1, 0.25, 70), band(421, 10, 22, 0.08)], brightness: 0.15 },
  BV605: { ex: { UV: 0.3, V: 1, B: 0.04, YG: 0.03 }, em: [band(603, 13, 34, 1, 0.3, 80), band(421, 10, 22, 0.05)], brightness: 0.45 },
  BV650: { ex: { UV: 0.3, V: 1, B: 0.02, YG: 0.03, R: 0.05 }, em: [band(645, 12, 34, 1, 0.3, 80), band(421, 10, 22, 0.04)], brightness: 0.3 },
  BV711: { ex: { UV: 0.3, V: 1, B: 0.02, YG: 0.02, R: 0.08 }, em: [band(711, 14, 34, 1, 0.25, 80), band(421, 10, 22, 0.03)], brightness: 0.35 },
  BV750: { ex: { UV: 0.3, V: 1, R: 0.1 }, em: [band(750, 15, 32, 1, 0.2, 80), band(421, 10, 22, 0.03)], brightness: 0.25 },
  BV786: { ex: { UV: 0.3, V: 1, B: 0.02, YG: 0.03, R: 0.06 }, em: [band(786, 15, 32, 1, 0.2, 80), band(421, 10, 22, 0.03)], brightness: 0.25 },
  FITC: { ex: { UV: 0.05, V: 0.08, B: 1 }, em: [band(520, 10, 24, 1, 0.25, 70)], brightness: 0.12 },
  // Blue-laser dyes read in FITC's detectors, with narrower emission (a control stained with one
  // of them for a FITC stain is a wrong reference).
  'Alexa Fluor 488': { ex: { UV: 0.03, V: 0.05, B: 1 }, em: [band(519, 9, 20, 1, 0.15, 60)], brightness: 0.3 },
  BB515: { ex: { UV: 0.05, V: 0.1, B: 1 }, em: [band(515, 8, 17, 1, 0.1, 50)], brightness: 0.5 },
  'PerCP-Cy5.5': { ex: { UV: 0.1, V: 0.15, B: 1, YG: 0.08, R: 0.04 }, em: [band(695, 15, 28, 1, 0.15, 60), band(678, 8, 8, 0.15)], brightness: 0.15 },
  PE: { ex: { UV: 0.06, V: 0.03, B: 0.45, YG: 1 }, em: [band(575, 9, 22, 1, 0.25, 70)], brightness: 0.5 },
  'PE-CF594': { ex: { UV: 0.05, V: 0.02, B: 0.45, YG: 1 }, em: [band(612, 12, 28, 1, 0.2, 70), band(575, 9, 15, 0.12)], brightness: 0.4 },
  'PE-Cy5': { ex: { UV: 0.05, V: 0.02, B: 0.45, YG: 1, R: 0.35 }, em: [band(667, 12, 28, 1, 0.2, 70), band(575, 9, 15, 0.05)], brightness: 0.55 },
  'PE-Cy7': { ex: { UV: 0.05, V: 0.02, B: 0.45, YG: 1, R: 0.04 }, em: [band(780, 16, 32, 1), band(575, 9, 15, 0.04)], brightness: 0.35 },
  APC: { ex: { UV: 0.04, V: 0.03, B: 0.01, YG: 0.12, R: 1 }, em: [band(660, 10, 30, 1, 0.3, 70)], brightness: 0.45 },
  // Read in APC's detectors, but narrower and red-shifted (an APC control for an Alexa Fluor 647
  // stain is a wrong reference).
  'Alexa Fluor 647': { ex: { UV: 0.02, V: 0.02, YG: 0.08, R: 1 }, em: [band(668, 10, 22, 1, 0.2, 60)], brightness: 0.4 },
  'Alexa Fluor 700': { ex: { UV: 0.03, V: 0.01, YG: 0.04, R: 1 }, em: [band(719, 12, 28, 1, 0.15, 60)], brightness: 0.18 },
  'APC-Cy7': { ex: { UV: 0.04, V: 0.02, YG: 0.1, R: 1 }, em: [band(780, 15, 32, 1), band(660, 10, 20, 0.08)], brightness: 0.2 },
  'Zombie NIR': { ex: { YG: 0.05, R: 1 }, em: [band(746, 15, 32, 1, 0.15, 60)], brightness: 0.25 },
  CTV: { ex: { UV: 0.6, V: 1 }, em: [band(450, 15, 30, 1, 0.25, 80)], brightness: 1 },
  // Indo-1, a ratiometric calcium dye excited by UV: emission peaks near 400 nm bound to calcium
  // and near 480 nm free; the violet/blue ratio rises with intracellular calcium.
  'Indo-1 (Ca-bound)': { ex: { UV: 1 }, em: [band(400, 14, 28, 1, 0.12, 60)], brightness: 1 },
  'Indo-1 (free)': { ex: { UV: 1 }, em: [band(482, 20, 34, 1, 0.12, 70)], brightness: 1 },
  PI: { ex: { UV: 0.2, V: 0.1, B: 0.6, YG: 1 }, em: [band(617, 20, 36, 1, 0.15, 70)], brightness: 1 },
  AF: { ex: { UV: 1, V: 0.7, B: 0.35, YG: 0.08, R: 0.02 }, em: [band(460, 30, 60, 1, 0.3, 120), band(530, 25, 50, 0.6)], brightness: 1 },
  AFM: { ex: { UV: 1, V: 0.9, B: 0.6, YG: 0.15, R: 0.04 }, em: [band(505, 40, 80, 1, 0.35, 140)], brightness: 1 },
};

// A fluorochrome whose emission is shifted by `nm` (a dye whose emission differs on capture beads
// from on cells, where its environment differs).
export function shiftedFluorochrome(name, nm) {
  const fluor = FLUOROCHROMES[name];
  if (!fluor) throw new Error(`Unknown fluorochrome "${name}".`);
  return { ...fluor, em: fluor.em.map((c) => ({ ...c, peak: c.peak + nm })) };
}

export function emissionAt(fluor, wavelength) {
  let sum = 0;
  for (const c of fluor.em) {
    const d = wavelength - c.peak;
    let g;
    if (d <= 0) {
      g = Math.exp(-(d * d) / (2 * c.left * c.left));
    } else {
      g = Math.exp(-(d * d) / (2 * c.right * c.right));
      if (c.tail) g = Math.max(g, c.tail * Math.exp(-d / c.tau));
    }
    sum += c.weight * g;
  }
  return sum;
}

// Light a detector collects from one unit of a fluorochrome: excitation by the detector's laser
// times the emission averaged over the filter band, times the detector's efficiency.
export function detectorResponse(fluor, detector) {
  const f = typeof fluor === 'string' ? FLUOROCHROMES[fluor] : fluor;
  if (!f) throw new Error(`Unknown fluorochrome "${fluor}".`);
  const ex = f.ex[detector.laser] ?? 0;
  if (!ex) return 0;
  const steps = 7;
  let sum = 0;
  for (let s = 0; s < steps; s += 1) {
    const wl = detector.center - detector.width / 2 + (detector.width * s) / (steps - 1);
    sum += emissionAt(f, wl);
  }
  return ex * (sum / steps) * (detector.efficiency ?? 1);
}

// A fluorochrome's signature across detectors, normalized to its brightest detector (as spectral
// cytometry software shows reference spectra).
export function spectralSignature(fluor, detectors) {
  const out = new Float64Array(detectors.length);
  let max = 0;
  for (let j = 0; j < detectors.length; j += 1) {
    out[j] = detectorResponse(fluor, detectors[j]);
    if (out[j] > max) max = out[j];
  }
  if (max > 0) for (let j = 0; j < out.length; j += 1) out[j] /= max;
  return out;
}

// Conventional spillover matrix: fluorochrome i's signal in detector j relative to its own
// primary detector (detectors[i]). Rows fluorochromes, columns detectors, as $SPILLOVER.
export function spilloverMatrix(fluors, detectors) {
  const n = detectors.length;
  if (fluors.length !== n) throw new Error('Spillover needs one fluorochrome per detector.');
  const matrix = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    const primary = detectorResponse(fluors[i], detectors[i]);
    if (!(primary > 0)) throw new Error(`${fluors[i]} gives no signal in ${detectors[i].name}.`);
    for (let j = 0; j < n; j += 1) {
      const v = i === j ? 1 : detectorResponse(fluors[i], detectors[j]) / primary;
      matrix[i * n + j] = v < 5e-4 ? 0 : +v.toPrecision(4);
    }
  }
  return { channels: detectors.map((d) => d.name), matrix, n };
}

// --- Instruments ---------------------------------------------------------------------------------

// k: detector units per photoelectron (photon noise variance = k × signal); sigma: electronic
// noise SD after baseline subtraction (both in the instrument's own units); voltage: $PnV.
function det(name, laser, center, width, k, sigma, voltage) {
  return { name, laser, center, width, k, sigma, voltage };
}

const BD_SCATTER = [
  { base: 'FSC', source: 0, scale: 1, sigma: 60, voltage: 380 },
  { base: 'SSC', source: 1, scale: 1, sigma: 40, voltage: 260 },
];

function auroraDetectors() {
  const lasers = [
    ['UV', [372, 387, 427, 443, 458, 473, 514, 582, 600, 617, 660, 692, 720, 750, 780, 812]],
    ['V', [428, 443, 458, 473, 508, 525, 542, 581, 598, 615, 664, 692, 720, 750, 780, 812]],
    ['B', [508, 525, 542, 581, 598, 615, 660, 678, 697, 717, 738, 760, 783, 812]],
    ['YG', [577, 598, 615, 660, 678, 697, 720, 760, 783, 812]],
    ['R', [660, 678, 697, 717, 738, 760, 783, 812]],
  ];
  const out = [];
  for (const [laser, centers] of lasers) {
    centers.forEach((center, i) => {
      const d = det(`${laser}${i + 1}-A`, laser, center, center > 740 ? 28 : 18, 1200, laser === 'UV' ? 1000 : 800, null);
      // Avalanche photodiodes are more sensitive in the red.
      d.efficiency = 0.8 + (0.4 * (center - 370)) / 450;
      out.push(d);
    });
  }
  return out;
}

export const INSTRUMENTS = {
  fortessa: {
    id: 'fortessa',
    cyt: 'LSRFortessa X-20 (CytoWeave simulation)',
    serial: 'SIM-R658800001',
    range: 262144,
    timestep: 0.01,
    fluorScale: 1,
    afScale: 320,
    flowRate: 35,
    scatter: BD_SCATTER,
    widthScale: 65536,
    detectors: [
      det('BUV395-A', 'UV', 379, 28, 30, 40, 510),
      det('BUV496-A', 'UV', 515, 30, 25, 35, 480),
      det('BUV737-A', 'UV', 740, 35, 35, 45, 600),
      det('BV421-A', 'V', 450, 50, 20, 35, 420),
      det('BV510-A', 'V', 525, 50, 20, 35, 450),
      det('BV605-A', 'V', 610, 20, 20, 30, 480),
      det('BV650-A', 'V', 670, 30, 22, 30, 500),
      det('BV711-A', 'V', 710, 50, 22, 30, 520),
      det('BV786-A', 'V', 780, 60, 25, 35, 560),
      det('FITC-A', 'B', 530, 30, 15, 30, 470),
      det('PerCP-Cy5-5-A', 'B', 695, 40, 20, 30, 560),
      det('PE-A', 'YG', 586, 15, 10, 25, 430),
      det('PE-CF594-A', 'YG', 610, 20, 12, 25, 480),
      det('PE-Cy5-A', 'YG', 670, 30, 14, 25, 500),
      det('PE-Cy7-A', 'YG', 780, 60, 15, 30, 550),
      det('APC-A', 'R', 670, 30, 18, 30, 520),
      det('Alexa Fluor 700-A', 'R', 730, 45, 22, 35, 560),
      det('APC-Cy7-A', 'R', 780, 60, 25, 35, 580),
    ],
  },
  aria: {
    id: 'aria',
    cyt: 'FACSAria Fusion (CytoWeave simulation)',
    serial: 'SIM-R656700002',
    range: 262144,
    timestep: 0.01,
    fluorScale: 1,
    afScale: 300,
    flowRate: 20,
    scatter: BD_SCATTER,
    widthScale: 65536,
    detectors: [
      det('BV421-A', 'V', 450, 50, 20, 35, 430),
      det('BV510-A', 'V', 525, 50, 20, 35, 450),
      det('BV605-A', 'V', 610, 20, 20, 30, 480),
      det('FITC-A', 'B', 530, 30, 15, 30, 480),
      det('PerCP-Cy5-5-A', 'B', 695, 40, 20, 30, 560),
      det('PE-A', 'YG', 582, 15, 10, 25, 440),
      det('PE-Cy7-A', 'YG', 780, 60, 15, 30, 550),
      det('APC-A', 'R', 670, 30, 18, 30, 520),
      det('APC-Cy7-A', 'R', 780, 60, 25, 35, 580),
    ],
  },
  canto: {
    id: 'canto',
    cyt: 'FACSCanto II (CytoWeave simulation)',
    serial: 'SIM-V964000003',
    range: 262144,
    timestep: 0.01,
    fluorScale: 1,
    afScale: 250,
    flowRate: 12,
    scatter: BD_SCATTER,
    widthScale: 65536,
    detectors: [det('PI-A', 'B', 585, 42, 6, 25, 380)],
  },
  aurora: {
    id: 'aurora',
    cyt: 'Aurora (CytoWeave simulation)',
    serial: 'SIM-U0000004',
    range: 4194304,
    timestep: 0.0001,
    fluorScale: 12,
    afScale: 4200,
    flowRate: 30,
    widthScale: null,
    scatter: [
      { base: 'FSC', source: 0, scale: 14, sigma: 900, voltage: null },
      { base: 'SSC', source: 1, scale: 10, sigma: 600, voltage: null },
      { base: 'SSC-B', source: 1, scale: 22, sigma: 900, voltage: null, jitter: 0.06 },
    ],
    detectors: auroraDetectors(),
  },
};

export function getDetector(instrument, name) {
  const found = instrument.detectors.find((d) => d.name === name);
  if (!found) throw new Error(`${instrument.id} has no detector "${name}".`);
  return found;
}

// --- Populations ----------------------------------------------------------------------------------

// Dimensions of a cell in true space: scatter, two autofluorescence types, then markers.
export const CELL_DIMS = ['FSC', 'SSC', 'AF', 'AFM'];

function pair(value, sd = 0.3) {
  if (Array.isArray(value)) return [value[0], value[1] ?? sd];
  return [value, sd];
}

// Compiles population specs into samplers over [FSC, SSC, AF, AFM, ...markers].
// spec: { name, label?, state?, fsc: [median, logSD], ssc: [median, logSD], afType: 'L'|'M',
//         af: median (lymphocyte AF = 1), markers: { CD3: median | [median, logSD] },
//         corr: [[markerA, markerB, rho]] }
// options: { background: [median, logSD] for unlisted markers (non-specific binding),
//            stained: Set of stained markers (others have no reagent: amount 0),
//            loading: marker correlation with cell size (default 0.25) }
export function compilePopulations(specs, markers, options = {}) {
  const background = options.background ?? [150, 0.6];
  const stained = options.stained ?? null;
  const markerLoading = options.loading ?? 0.25;
  const d = CELL_DIMS.length + markers.length;
  // Median non-specific signal per marker for debris and dead cells (0 when not stained).
  const bg = Float64Array.from(markers, (marker) => (stained && !stained.has(marker) ? 0 : pair(background)[0]));
  return specs.map((spec) => {
    const mu = new Float64Array(d);
    const sd = new Float64Array(d);
    const load = new Float64Array(d);
    const set = (k, [median, s], l) => {
      mu[k] = median > 0 ? Math.log(median) : -Infinity;
      sd[k] = s;
      load[k] = l;
    };
    set(0, pair(spec.fsc ?? [60000, 0.1], 0.1), 0.8);
    set(1, pair(spec.ssc ?? [14000, 0.2], 0.2), 0.4);
    const afLevel = spec.af ?? 1;
    const afSD = spec.afSD ?? 0.3;
    if ((spec.afType ?? 'L') === 'M') {
      set(2, [afLevel * 0.25, 0.4], 0.5);
      set(3, [afLevel, afSD], 0.5);
    } else {
      set(2, [afLevel, afSD], 0.5);
      set(3, [afLevel * 0.03, 0.5], 0.5);
    }
    markers.forEach((marker, m) => {
      const k = CELL_DIMS.length + m;
      const given = spec.markers?.[marker];
      if (stained && !stained.has(marker)) set(k, [0, 0], 0);
      else if (given !== undefined) set(k, pair(given), spec.loading?.[marker] ?? markerLoading);
      else set(k, pair(background), markerLoading * 0.5);
    });
    let chol = null;
    if (spec.corr?.length) {
      const C = new Float64Array(d * d);
      for (let i = 0; i < d; i += 1) for (let j = 0; j < d; j += 1) C[i * d + j] = i === j ? 1 : load[i] * load[j];
      let scale = 1;
      for (let attempt = 0; attempt < 6 && !chol; attempt += 1) {
        const M = Float64Array.from(C);
        for (const [a, b, rho] of spec.corr) {
          const i = markers.indexOf(a);
          const j = markers.indexOf(b);
          if (i < 0 || j < 0) continue;
          const p = CELL_DIMS.length + i;
          const q = CELL_DIMS.length + j;
          M[p * d + q] += rho * scale;
          M[q * d + p] += rho * scale;
        }
        chol = cholesky(M, d);
        scale /= 2;
      }
    }
    const rest = new Float64Array(d);
    for (let k = 0; k < d; k += 1) rest[k] = Math.sqrt(1 - load[k] * load[k]);
    return { name: spec.name, label: spec.label ?? spec.name, state: spec.state ?? 0, d, mu, sd, load, rest, chol, bg };
  });
}

// Draws one cell into out (length d); normal is a standard-normal generator (createNormal),
// scratch a Float64Array(d).
export function sampleCell(pop, normal, out, scratch) {
  const { d, mu, sd } = pop;
  if (pop.chol) {
    const L = pop.chol;
    for (let k = 0; k < d; k += 1) scratch[k] = normal();
    for (let i = 0; i < d; i += 1) {
      let z = 0;
      const base = i * d;
      for (let j = 0; j <= i; j += 1) z += L[base + j] * scratch[j];
      out[i] = Math.exp(mu[i] + sd[i] * z);
    }
    return out;
  }
  const s = normal();
  const { load, rest } = pop;
  for (let k = 0; k < d; k += 1) {
    if (mu[k] === -Infinity) {
      out[k] = 0;
      continue;
    }
    out[k] = Math.exp(mu[k] + sd[k] * (load[k] * s + rest[k] * normal()));
  }
  return out;
}

// --- Panels ---------------------------------------------------------------------------------------

// Builds the emitter → detector matrix for a panel on an instrument.
// assignments: [{ marker, fluor, detector, dye? }] (detector names, one marker per detector; dye:
// the fluorochrome's definition when it differs from FLUOROCHROMES[fluor], as shiftedFluorochrome
// gives); detectorNames: the recorded fluorescence detectors (default: the assigned ones, in
// order). Returns { detectors, markers, fluors, emitters (Float64Array (2 + m) × nDet), spill }.
export function buildPanel(instrument, assignments, detectorNames = null) {
  const names = detectorNames ?? assignments.map((a) => a.detector);
  const detectors = names.map((name) => getDetector(instrument, name));
  const markers = assignments.map((a) => a.marker);
  const fluors = assignments.map((a) => a.fluor);
  const nDet = detectors.length;
  const rows = 2 + markers.length;
  const emitters = new Float64Array(rows * nDet);
  // Autofluorescence: one unit is the signal in the instrument's brightest AF detector.
  ['AF', 'AFM'].forEach((af, r) => {
    let max = 0;
    for (const d of instrument.detectors) max = Math.max(max, detectorResponse(af, d));
    for (let j = 0; j < nDet; j += 1) emitters[r * nDet + j] = (instrument.afScale * detectorResponse(af, detectors[j])) / max;
  });
  assignments.forEach((a, m) => {
    const fluor = a.dye ?? FLUOROCHROMES[a.fluor];
    if (!fluor) throw new Error(`Unknown fluorochrome "${a.fluor}".`);
    const primaryDetector = a.detector ? getDetector(instrument, a.detector) : null;
    let primary = primaryDetector ? detectorResponse(fluor, primaryDetector) : 0;
    if (!primaryDetector) for (const d of instrument.detectors) primary = Math.max(primary, detectorResponse(fluor, d));
    const gain = (a.brightness ?? fluor.brightness) * instrument.fluorScale;
    for (let j = 0; j < nDet; j += 1) {
      const ratio = detectorResponse(fluor, detectors[j]) / primary;
      emitters[(2 + m) * nDet + j] = gain * (ratio < 5e-4 ? 0 : +ratio.toPrecision(4));
    }
  });
  let spill = null;
  if (assignments.every((a) => a.detector) && names.length === assignments.length && names.every((n, i) => n === assignments[i].detector)) {
    spill = spilloverMatrix(fluors, detectors);
  }
  return { instrument, detectors, markers, fluors, emitters, spill };
}

// A tandem dye whose acceptor has partly broken down: a fraction of its emission comes from its
// donor instead (degraded PE-Cy7 emits partly like PE). Mixes the donor's emission, scaled to the
// tandem's peak, into the marker's row of the panel's emitters, in place.
export function degradeTandem(panel, marker, donor, fraction) {
  const m = panel.markers.indexOf(marker);
  const fluor = FLUOROCHROMES[donor];
  if (m < 0 || !fluor) throw new Error(`Cannot degrade ${marker}: no such marker or donor "${donor}".`);
  const nDet = panel.detectors.length;
  const row = (2 + m) * nDet;
  let peak = 0;
  for (let j = 0; j < nDet; j += 1) peak = Math.max(peak, panel.emitters[row + j]);
  let donorPeak = 0;
  for (const d of panel.instrument.detectors) donorPeak = Math.max(donorPeak, detectorResponse(fluor, d));
  for (let j = 0; j < nDet; j += 1) {
    panel.emitters[row + j] = (1 - fraction) * panel.emitters[row + j] + fraction * peak * (detectorResponse(fluor, panel.detectors[j]) / donorPeak);
  }
  return panel;
}

// --- Acquisition clock ----------------------------------------------------------------------------

// Anomaly windows: [{ kind, start, end (s), rate (arrival-rate factor), signal, scatter
// (multiplicative), cv (extra log-SD), junk, debris (probability an event is replaced) }].
export function resolveWindows(anomalies, nominalDuration) {
  return (anomalies ?? [])
    .map((a) => ({
      kind: a.kind ?? 'anomaly',
      start: (a.at ?? 0) * nominalDuration,
      end: ((a.at ?? 0) + (a.length ?? 0.05)) * nominalDuration,
      rate: a.rate ?? 1,
      signal: a.signal ?? 1,
      scatter: a.scatter ?? 1,
      cv: a.cv ?? 0,
      junk: a.junk ?? 0,
      debris: a.debris ?? 0,
    }))
    .sort((x, y) => x.start - y.start);
}

// Poisson arrivals at `rate` events/s, modulated inside windows. Returns seconds.
export function acquisitionTimes(count, rate, windows, random) {
  const times = new Float64Array(count);
  let t = 0;
  let w = 0;
  for (let e = 0; e < count; e += 1) {
    while (w < windows.length && t >= windows[w].end) w += 1;
    const factor = w < windows.length && t >= windows[w].start ? windows[w].rate : 1;
    t += exponential(random, 1 / (rate * factor));
    times[e] = t;
  }
  return times;
}

// Draws an index with probability proportional to weights (binary search on the CDF).
export function createPicker(weights, random) {
  const n = weights.length;
  const cumulative = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += Math.max(0, weights[i]);
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    acc += Math.max(0, weights[i]) / sum;
    cumulative[i] = acc;
  }
  return () => {
    const u = random();
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

// --- Flow events ----------------------------------------------------------------------------------

export const DEFAULT_DEAD = { fsc: 0.62, ssc: 1.3, af: 2.2, markers: 0.55, sticky: 3, viability: [8e4, 0.35] };
export const DEFAULT_DEBRIS = { fscMin: 4000, fscMean: 9000, ssc: [6000, 0.9], af: [0.35, 0.7], viabilityBright: 0.5, viability: [2e4, 0.9] };

// Relative pulse width from forward-scatter area (BD units): the laser beam (~10 µm) plus a
// cell diameter ∝ sqrt(area); a 60 000-area lymphocyte has width 1.
function pulseWidth(fscArea) {
  return 0.5 * (1 + Math.sqrt(Math.max(fscArea, 0) / 60000));
}

const SPECIAL = ['Dead cells', 'Debris', 'Doublets', 'Junk'];

// Simulates one flow (conventional or spectral) sample. Returns columns by name, truth labels
// and the acquisition record. config:
//   count, instrument, panel (buildPanel), populations (compilePopulations), weights (live),
//   mix: { dead, debris, doublets }, viability: marker name or null,
//   dead, debris (overrides of DEFAULT_DEAD/DEBRIS), rate (events/s), anomalies, drift:
//   { fluorescence, scatter } (relative change by the end), markerFactors: { marker: factor },
//   detectorOffsets: Float64Array, scatterWidth (record -W), keepAbundances, recordState,
//   laserCV: a coefficient of variation of every laser's intensity from event to event (a
//   number, or { [laser]: cv }), lognormal and independent between lasers (default none),
//   detectorGains: { detector: PMT gain relative to its own voltage } (default 1),
//   pauses: [{ at, duration } in seconds] (no events while the tube is out, e.g. to add a
//   stimulus), modulate(event, time, kind ('live' | 'dead' | 'doublet' | 'debris' | 'junk'),
//   population (index, or −1), amounts (emitter amounts: AF, AFM, then the markers; changed in
//   place), normal, random) (a cell state that changes during acquisition, as calcium in a flux
//   assay).
export function simulateEvents(config, random, options = {}) {
  const { count, instrument, panel, populations } = config;
  const nPop = populations.length;
  const nDet = panel.detectors.length;
  const nMarkers = panel.markers.length;
  const nEmit = 2 + nMarkers;
  const d = CELL_DIMS.length + nMarkers;
  const mix = { dead: 0, debris: 0, doublets: 0, ...config.mix };
  const dead = { ...DEFAULT_DEAD, ...config.dead };
  const debris = { ...DEFAULT_DEBRIS, ...config.debris };
  const viability = config.viability ? panel.markers.indexOf(config.viability) : -1;
  const rate = config.rate ?? 2000;
  const signal = options.signal;

  // Emitter matrix with per-sample marker factors (staining batch effects, reagent lots).
  const E = Float64Array.from(panel.emitters);
  if (config.markerFactors) {
    panel.markers.forEach((marker, m) => {
      const f = config.markerFactors[marker];
      if (f === undefined) return;
      for (let j = 0; j < nDet; j += 1) E[(2 + m) * nDet + j] *= f;
    });
  }
  const kq = new Float64Array(nDet);
  const sig = new Float64Array(nDet);
  for (let j = 0; j < nDet; j += 1) {
    kq[j] = panel.detectors[j].k;
    sig[j] = panel.detectors[j].sigma;
  }
  // Laser intensity fluctuations: one lognormal factor per laser and event.
  let laserOf = null;
  let laserCVs = null;
  let laserFactor = null;
  if (config.laserCV) {
    const lasers = [...new Set(panel.detectors.map((dt) => dt.laser))];
    laserOf = Int32Array.from(panel.detectors, (dt) => lasers.indexOf(dt.laser));
    laserCVs = Float64Array.from(lasers, (l) => (typeof config.laserCV === 'number' ? config.laserCV : config.laserCV[l] ?? 0));
    laserFactor = new Float64Array(lasers.length);
  }
  // Truth abundances are reported in signal units at each emitter's brightest detector, which is
  // what unmixing with peak-normalized signatures should recover.
  const abundanceScale = new Float64Array(nEmit);
  for (let k = 0; k < nEmit; k += 1) for (let j = 0; j < nDet; j += 1) abundanceScale[k] = Math.max(abundanceScale[k], E[k * nDet + j]);
  const offsets = config.detectorOffsets ?? new Float64Array(nDet);
  // PMT gains relative to the detectors' own voltages (a voltage walk): the signal and its photon
  // noise SD scale with the gain, the electronic noise does not.
  const gains = Float64Array.from(panel.detectors, (dt) => config.detectorGains?.[dt.name] ?? 1);
  const maxValue = instrument.range - 1;

  // Event kinds: live populations, then dead, debris, doublets (multinomial counts).
  const live = config.weights;
  let liveSum = 0;
  for (let p = 0; p < nPop; p += 1) liveSum += live[p];
  const liveFraction = Math.max(0, 1 - mix.dead - mix.debris - mix.doublets);
  const kindWeights = new Float64Array(nPop + 3);
  for (let p = 0; p < nPop; p += 1) kindWeights[p] = (live[p] / liveSum) * liveFraction;
  kindWeights[nPop] = mix.dead;
  kindWeights[nPop + 1] = mix.debris;
  kindWeights[nPop + 2] = mix.doublets;
  const kinds = sampledLabels(count, kindWeights, random);
  const DEAD = nPop;
  const DEBRIS = nPop + 1;
  const DOUBLET = nPop + 2;
  const JUNK = nPop + 3;
  const pickPopulation = createPicker(live, random);

  // Truth label names: population labels (deduplicated) then the special kinds.
  const labelNames = [];
  const popLabel = new Int32Array(nPop);
  populations.forEach((pop, p) => {
    let index = labelNames.indexOf(pop.label);
    if (index < 0) {
      index = labelNames.length;
      labelNames.push(pop.label);
    }
    popLabel[p] = index;
  });
  const specialBase = labelNames.length;
  labelNames.push(...SPECIAL);

  const nominal = count / rate;
  const windows = resolveWindows(config.anomalies, nominal);
  const times = acquisitionTimes(count, rate, windows, random);
  // Pauses in acquisition (the tube taken out to add a stimulus): no events for their duration.
  for (const pause of [...(config.pauses ?? [])].sort((a, b) => a.at - b.at)) {
    for (let e = 0; e < count; e += 1) if (times[e] >= pause.at) times[e] += pause.duration;
  }
  const duration = count ? times[count - 1] : 0;
  const drift = config.drift ?? null;

  // Output columns.
  const scatter = instrument.scatter;
  const withWidth = config.scatterWidth !== false && instrument.widthScale;
  const columns = {};
  const order = [];
  const scatterCols = scatter.map((s) => {
    const a = new Float32Array(count);
    const h = new Float32Array(count);
    const w = withWidth ? new Float32Array(count) : null;
    columns[`${s.base}-A`] = a;
    columns[`${s.base}-H`] = h;
    order.push(`${s.base}-A`, `${s.base}-H`);
    if (w) {
      columns[`${s.base}-W`] = w;
      order.push(`${s.base}-W`);
    }
    return { a, h, w };
  });
  const fluor = panel.detectors.map((detector) => {
    const column = new Float32Array(count);
    columns[detector.name] = column;
    order.push(detector.name);
    return column;
  });
  const timeColumn = new Float32Array(count);
  columns.Time = timeColumn;
  order.push('Time');
  const labels = new Int32Array(count);
  const anomaly = new Uint8Array(count);
  const state = config.recordState ? new Uint8Array(count) : null;
  const abundances = config.keepAbundances ? Array.from({ length: nEmit }, () => new Float32Array(count)) : null;

  const cell = new Float64Array(d);
  const other = new Float64Array(d);
  const scratch = new Float64Array(d);
  const amt = new Float64Array(nEmit);
  const raw = new Float64Array(nDet);
  const g = createNormal(random);
  // Sparse emitter rows: most fluorochromes reach only a few detectors.
  const rowStart = new Int32Array(nEmit + 1);
  const rowCols = [];
  const rowVals = [];
  for (let k = 0; k < nEmit; k += 1) {
    rowStart[k] = rowCols.length;
    for (let j = 0; j < nDet; j += 1) {
      if (E[k * nDet + j] !== 0) {
        rowCols.push(j);
        rowVals.push(E[k * nDet + j]);
      }
    }
  }
  rowStart[nEmit] = rowCols.length;
  const cols = Int32Array.from(rowCols);
  const vals = Float64Array.from(rowVals);
  const bgMedian = populations[0]?.bg ?? new Float64Array(nMarkers);

  const sampleDead = (out, p) => {
    sampleCell(populations[p], g, out, scratch);
    out[0] *= dead.fsc * Math.exp(0.12 * g());
    out[1] *= dead.ssc * Math.exp(0.15 * g());
    out[2] *= dead.af;
    out[3] *= dead.af;
    for (let m = 0; m < nMarkers; m += 1) out[4 + m] = out[4 + m] * dead.markers + bgMedian[m] * dead.sticky * Math.exp(0.5 * g());
    if (viability >= 0) out[4 + viability] = dead.viability[0] * Math.exp(dead.viability[1] * g());
  };

  let w = 0;
  const checkEvery = 16384;
  for (let e = 0; e < count; e += 1) {
    if ((e & (checkEvery - 1)) === 0 && e) {
      if (signal?.aborted) throw new Error('Simulation was canceled.');
    }
    const t = times[e];
    while (w < windows.length && t >= windows[w].end) w += 1;
    const win = w < windows.length && t >= windows[w].start ? windows[w] : null;
    let fluorGain = 1;
    let scatterGain = 1;
    if (drift) {
      const progress = Math.min(1.2, t / nominal);
      fluorGain *= 1 + (drift.fluorescence ?? 0) * progress;
      scatterGain *= 1 + (drift.scatter ?? 0) * progress;
    }
    let kind = kinds[e];
    if (win) {
      anomaly[e] = 1;
      fluorGain *= win.signal;
      scatterGain *= win.scatter;
      if (win.cv) fluorGain *= Math.exp(win.cv * g());
      if (win.junk && random() < win.junk) kind = JUNK;
      else if (win.debris && random() < win.debris && kind !== DEBRIS) kind = DEBRIS;
    }

    let fscA;
    let sscA;
    let wp;
    if (kind < nPop) {
      sampleCell(populations[kind], g, cell, scratch);
      fscA = cell[0];
      sscA = cell[1];
      wp = pulseWidth(fscA) * Math.exp(0.03 * g());
      for (let k = 0; k < nEmit; k += 1) amt[k] = cell[2 + k];
      labels[e] = popLabel[kind];
      if (state) state[e] = populations[kind].state;
    } else if (kind === DEAD) {
      sampleDead(cell, pickPopulation());
      fscA = cell[0];
      sscA = cell[1];
      wp = pulseWidth(fscA) * Math.exp(0.04 * g());
      for (let k = 0; k < nEmit; k += 1) amt[k] = cell[2 + k];
      labels[e] = specialBase;
    } else if (kind === DOUBLET) {
      const deadShare = mix.dead / (mix.dead + liveFraction);
      if (random() < deadShare) sampleDead(cell, pickPopulation());
      else sampleCell(populations[pickPopulation()], g, cell, scratch);
      if (random() < deadShare) sampleDead(other, pickPopulation());
      else sampleCell(populations[pickPopulation()], g, other, scratch);
      const w1 = pulseWidth(cell[0]);
      const w2 = pulseWidth(other[0]);
      // Most doublets travel end to end (longer pulse); some side by side (indistinguishable).
      const u = random();
      const delta = u < 0.08 ? 0.15 * random() : 0.35 + 0.65 * random();
      wp = (Math.max(w1, w2) + delta * Math.min(w1, w2) * 0.9) * Math.exp(0.03 * g());
      fscA = cell[0] + other[0];
      sscA = cell[1] + other[1];
      for (let k = 0; k < nEmit; k += 1) amt[k] = cell[2 + k] + other[2 + k];
      labels[e] = specialBase + 2;
    } else if (kind === DEBRIS) {
      fscA = debris.fscMin + exponential(random, debris.fscMean);
      sscA = debris.ssc[0] * Math.exp(debris.ssc[1] * g());
      wp = pulseWidth(fscA) * Math.exp(0.06 * g());
      amt[0] = debris.af[0] * Math.exp(debris.af[1] * g());
      amt[1] = amt[0] * 0.1;
      for (let m = 0; m < nMarkers; m += 1) amt[2 + m] = bgMedian[m] * 0.5 * Math.exp(0.8 * g());
      if (viability >= 0 && random() < debris.viabilityBright) amt[2 + viability] = debris.viability[0] * Math.exp(debris.viability[1] * g());
      labels[e] = specialBase + 1;
    } else {
      // Junk (air bubbles, fluidic noise): erratic scatter and fluorescence.
      fscA = 30000 * Math.exp(1.0 * g());
      sscA = 20000 * Math.exp(1.2 * g());
      wp = 0.5 + 1.5 * random();
      amt[0] = Math.exp(1.5 * g());
      amt[1] = amt[0] * 0.3;
      for (let m = 0; m < nMarkers; m += 1) amt[2 + m] = (bgMedian[m] + 50) * Math.exp(1.2 * g());
      labels[e] = specialBase + 3;
    }

    // A cell's state that changes while the tube is acquired (calcium in a flux assay): the
    // emitter amounts of the event, set from its time.
    if (config.modulate) config.modulate(e, t, kind < nPop ? 'live' : kind === DEAD ? 'dead' : kind === DOUBLET ? 'doublet' : kind === DEBRIS ? 'debris' : 'junk', kind < nPop ? kind : -1, amt, g, random);

    if (abundances) for (let k = 0; k < nEmit; k += 1) abundances[k][e] = amt[k] * abundanceScale[k];

    // Fluorescence detection: emitters through the spectral matrix, then photon and electronic noise.
    for (let j = 0; j < nDet; j += 1) raw[j] = 0;
    for (let k = 0; k < nEmit; k += 1) {
      const a = amt[k];
      if (a === 0) continue;
      for (let r = rowStart[k], end = rowStart[k + 1]; r < end; r += 1) raw[cols[r]] += a * vals[r];
    }
    if (laserCVs) {
      for (let l = 0; l < laserCVs.length; l += 1) laserFactor[l] = laserCVs[l] ? Math.exp(laserCVs[l] * g() - 0.5 * laserCVs[l] * laserCVs[l]) : 1;
      for (let j = 0; j < nDet; j += 1) raw[j] *= laserFactor[laserOf[j]];
    }
    for (let j = 0; j < nDet; j += 1) {
      const r = raw[j] * fluorGain * gains[j] + offsets[j];
      const sd = Math.sqrt((r > 0 ? r * kq[j] * gains[j] : 0) + sig[j] * sig[j]);
      let v = r + sd * g();
      if (v > maxValue) v = maxValue;
      fluor[j][e] = v;
    }

    // Scatter pulses.
    for (let s = 0; s < scatter.length; s += 1) {
      const sc = scatter[s];
      let area = (sc.source === 0 ? fscA : sscA) * sc.scale * scatterGain;
      if (sc.jitter) area *= Math.exp(sc.jitter * g());
      let a = area * (1 + 0.01 * g()) + sc.sigma * g();
      const width = wp * Math.exp(0.012 * g());
      let h = a / width + sc.sigma * 0.5 * g();
      if (a > maxValue) a = maxValue;
      if (h > maxValue) h = maxValue;
      if (a < 0) a = 0;
      if (h < 0) h = 0;
      const col = scatterCols[s];
      col.a[e] = a;
      col.h[e] = h;
      if (col.w) {
        let wv = width * instrument.widthScale;
        if (wv > maxValue) wv = maxValue;
        col.w[e] = wv;
      }
    }
    timeColumn[e] = Math.floor(t / instrument.timestep);
  }

  return {
    columns,
    order,
    labels,
    labelNames,
    state,
    times,
    duration,
    anomaly,
    windows,
    abundances,
    abundanceNames: abundances ? ['AF', 'AFM', ...panel.markers] : null,
  };
}

// --- DNA content (cell cycle) -------------------------------------------------------------------

export const CELL_CYCLE_LABELS = ['G1', 'S', 'G2/M', 'Doublets', 'Aggregates', 'Debris'];

// Simulates a DNA-content measurement of fixed, PI-stained cells: G1 at `g1` (PI-A), G2/M at
// g1 × g2Ratio, S phase spread between them, a staining CV, and the classic pitfall: two G1
// nuclei stuck together have G2 DNA content (PI-A) but a longer pulse (PI-W) and a lower
// PI-H than a G2 nucleus (Wersto et al. 2001, Cytometry 46:296). config:
//   count, instrument (with a 'PI-A' detector), phases: { G1, S, G2M } (fractions of singlet
//   cells, allocated exactly), mix: { doublets, aggregates, debris }, g1, g2Ratio, cv, rate.
export function simulateCellCycle(config, random, options = {}) {
  const { count, instrument } = config;
  const phases = { G1: 0.55, S: 0.3, G2M: 0.15, ...config.phases };
  const mix = { doublets: 0.06, aggregates: 0.015, debris: 0.045, ...config.mix };
  const g1 = config.g1 ?? 50000;
  const ratio = config.g2Ratio ?? 1.97;
  const cv = config.cv ?? 0.04;
  const rate = config.rate ?? 250;
  const detector = getDetector(instrument, 'PI-A');
  const singlet = Math.max(0, 1 - mix.doublets - mix.aggregates - mix.debris);
  const phaseSum = phases.G1 + phases.S + phases.G2M;
  // Exact counts for the singlet phases (so a stated 55 % G1 is 55 % of the singlet cells).
  const singletCount = Math.round(count * singlet);
  const phaseCounts = allocateCounts(singletCount, [phases.G1 / phaseSum, phases.S / phaseSum, phases.G2M / phaseSum]);
  const otherCounts = allocateCounts(count - singletCount, [mix.doublets, mix.aggregates, mix.debris]);
  const kinds = shuffledLabels(Int32Array.from([...phaseCounts, ...otherCounts]), random);
  const pickPhase = createPicker([phases.G1, phases.S, phases.G2M], random);
  const times = acquisitionTimes(count, rate, [], random);
  const g = createNormal(random);
  const maxValue = instrument.range - 1;
  const names = ['FSC-A', 'FSC-H', 'FSC-W', 'SSC-A', 'SSC-H', 'SSC-W', 'PI-A', 'PI-H', 'PI-W', 'Time'];
  const columns = {};
  for (const name of names) columns[name] = new Float32Array(count);
  const labels = new Int32Array(count);
  // One nucleus: DNA in G1 units, scatter areas, PI pulse width.
  const nucleus = { dna: 0, fsc: 0, ssc: 0, wp: 0, wf: 0 };
  const drawNucleus = (phase) => {
    let progress;
    if (phase === 0) progress = 0;
    else if (phase === 1) progress = random();
    else progress = 1;
    const dna = 1 + (ratio - 1) * progress;
    nucleus.dna = dna;
    nucleus.fsc = 72000 * (1 + 0.35 * progress) * Math.exp(0.12 * g());
    nucleus.ssc = 32000 * (1 + 0.25 * progress) * Math.exp(0.18 * g());
    nucleus.wp = 0.5 * (1 + Math.cbrt(dna)) * Math.exp(0.025 * g());
    nucleus.wf = 0.5 * (1 + Math.sqrt(nucleus.fsc / 72000)) * Math.exp(0.03 * g());
    return nucleus;
  };
  for (let e = 0; e < count; e += 1) {
    if ((e & 16383) === 0 && e && options.signal?.aborted) throw new Error('Simulation was canceled.');
    const kind = kinds[e];
    let dna;
    let fsc;
    let ssc;
    let wp;
    let wf;
    if (kind <= 2) {
      drawNucleus(kind);
      ({ dna, fsc, ssc, wp, wf } = nucleus);
      dna *= Math.exp(cv * g());
    } else if (kind === 3 || kind === 4) {
      const cells = kind === 3 ? 2 : 3 + (random() < 0.3 ? 1 : 0);
      dna = 0;
      fsc = 0;
      ssc = 0;
      wp = 0;
      wf = 0;
      for (let c = 0; c < cells; c += 1) {
        drawNucleus(pickPhase());
        dna += nucleus.dna * Math.exp(cv * g());
        fsc += nucleus.fsc;
        ssc += nucleus.ssc;
        // Cells in a clump pass the beam mostly end to end; a few side by side.
        const delta = c === 0 ? 1 : random() < 0.08 ? 0.15 * random() : 0.35 + 0.65 * random();
        wp += delta * nucleus.wp * (c === 0 ? 1 : 0.9);
        wf += delta * nucleus.wf * (c === 0 ? 1 : 0.9);
      }
    } else {
      // Sub-G1 apoptotic nuclei and fragments.
      dna = random() < 0.6 ? 0.55 * Math.exp(0.3 * g()) : 0.05 + 0.4 * random() ** 1.5;
      fsc = 5000 + exponential(random, 14000);
      ssc = 16000 * Math.exp(0.8 * g());
      wp = 0.5 * (1 + Math.cbrt(Math.max(dna, 0.05))) * Math.exp(0.05 * g());
      wf = 0.5 * (1 + Math.sqrt(fsc / 72000)) * Math.exp(0.05 * g());
    }
    labels[e] = kind;
    let piA = dna * g1;
    piA += Math.sqrt(piA * detector.k + detector.sigma * detector.sigma) * g();
    const piH = piA / wp + detector.sigma * 0.5 * g();
    const write = (name, v) => {
      columns[name][e] = v > maxValue ? maxValue : v;
    };
    write('PI-A', piA);
    write('PI-H', piH);
    write('PI-W', wp * instrument.widthScale);
    const scatterOut = (base, area, w, sigma) => {
      let a = area * (1 + 0.01 * g()) + sigma * g();
      let h = a / w + sigma * 0.5 * g();
      if (a < 0) a = 0;
      if (h < 0) h = 0;
      write(`${base}-A`, a);
      write(`${base}-H`, h);
      write(`${base}-W`, w * instrument.widthScale);
    };
    scatterOut('FSC', fsc, wf, 60);
    scatterOut('SSC', ssc, wf * Math.exp(0.02 * g()), 40);
    columns.Time[e] = Math.floor(times[e] / instrument.timestep);
  }
  return { columns, order: names, labels, labelNames: CELL_CYCLE_LABELS.slice(), times, duration: count ? times[count - 1] : 0, phaseCounts };
}

// --- Multi-level beads (instrument characterization) ---------------------------------------------

// Simulates a tube of multi-level calibration beads (8-peak rainbow beads and the like) for
// measuring detector efficiency Q and optical background B (Parks et al. 2017). Each bead carries
// one dye loading for every detector (its level times a lognormal factor of CV cv0, shared by the
// detectors); a detector sees signal I = loading × response, with variance
//   k·(I + background) + sigma²
// (photoelectron counting on the signal and on stray light, plus electronic noise), so its true
// Q = 1/k, B = (k·background + sigma²)/k² statistical photoelectrons and CV0 = cv0. config:
//   count, instrument, detectors: [{ name, k, sigma, background, response }], levels: bead
//   brightness of each level (response × level is its signal), cv0, rate, mix: { doublets,
//   debris }. Returns the same shape as simulateEvents ({ columns, order, labels (level index;
//   doublets and debris after the levels), labelNames, times, duration }).
export function simulateBeadRun(config, random, options = {}) {
  const { count, instrument, detectors, levels } = config;
  const cv0 = config.cv0 ?? 0.02;
  const rate = config.rate ?? 800;
  const mix = { doublets: 0.03, debris: 0.02, ...config.mix };
  const g = createNormal(random);
  const nLevels = levels.length;
  const weights = new Float64Array(nLevels + 2);
  for (let l = 0; l < nLevels; l += 1) weights[l] = (1 - mix.doublets - mix.debris) / nLevels;
  weights[nLevels] = mix.doublets;
  weights[nLevels + 1] = mix.debris;
  const labels = sampledLabels(count, weights, random);
  const labelNames = [...levels.map((_, l) => `Level ${l + 1}`), 'Doublets', 'Debris'];
  const times = acquisitionTimes(count, rate, [], random);
  const maxValue = instrument.range - 1;
  const scatter = instrument.scatter.slice(0, 2);
  const columns = {};
  const order = [];
  for (const sc of scatter) for (const part of ['A', 'H', 'W']) {
    columns[`${sc.base}-${part}`] = new Float32Array(count);
    order.push(`${sc.base}-${part}`);
  }
  for (const d of detectors) {
    columns[d.name] = new Float32Array(count);
    order.push(d.name);
  }
  columns.Time = new Float32Array(count);
  order.push('Time');
  const clip = (v) => (v > maxValue ? maxValue : v);
  for (let e = 0; e < count; e += 1) {
    if ((e & 4095) === 0 && options.signal?.aborted) throw new Error('Simulation was canceled.');
    const kind = labels[e];
    const debris = kind === nLevels + 1;
    const beads = kind === nLevels ? 2 : 1;
    // Scatter: tight for beads, pulses twice as long and twice the area for doublets.
    const width = (debris ? 0.6 : beads === 2 ? 1.9 : 1) * Math.exp(0.02 * g());
    scatter.forEach((sc, i) => {
      const base = i === 0 ? 52000 : 21000;
      const area = debris ? base * 0.12 * Math.exp(0.6 * g()) : beads * base * Math.exp(0.025 * g());
      const a = area + sc.sigma * g();
      columns[`${sc.base}-A`][e] = clip(Math.max(0, a));
      columns[`${sc.base}-H`][e] = clip(Math.max(0, a / width + sc.sigma * 0.5 * g()));
      columns[`${sc.base}-W`][e] = width * instrument.widthScale;
    });
    // Dye loading: one factor per bead, shared by the detectors.
    let loading = 0;
    if (debris) loading = levels[0] * 0.3 * Math.exp(0.8 * g());
    else for (let b = 0; b < beads; b += 1) loading += levels[beads === 2 ? Math.floor(random() * nLevels) : kind] * Math.exp(cv0 * g() - 0.5 * cv0 * cv0);
    for (const d of detectors) {
      const signal = loading * d.response;
      const variance = d.k * (signal + (d.background ?? 0)) + d.sigma * d.sigma;
      columns[d.name][e] = clip(signal + Math.sqrt(variance) * g());
    }
    columns.Time[e] = Math.floor(times[e] / instrument.timestep);
  }
  return { columns, order, labels, labelNames, times, duration: count ? times[count - 1] : 0 };
}

// The true Q (Spe per unit), B (Spe) and CV0 of a simulated bead detector (the loading is
// lognormal, so its CV is √(exp(cv0²) − 1)).
export function beadDetectorTruth(d, cv0) {
  return { Q: 1 / d.k, B: ((d.background ?? 0) * d.k + d.sigma * d.sigma) / (d.k * d.k), CV0: Math.sqrt(Math.expm1(cv0 * cv0)) };
}

// --- Mass cytometry -------------------------------------------------------------------------------

// Element symbol → isotopic mass channel name, e.g. ('Yb', 176) → 'Yb176Di'.
export function massChannelName(element, mass) {
  return `${element}${mass}Di`;
}

// Signal per bound antibody (counts) by mass: CyTOF sensitivity peaks in the lanthanide range
// (~153–176) and falls off for light (89Y) and heavy masses.
export function massSensitivity(mass) {
  return 0.0022 * (0.35 + 0.65 * Math.exp(-(((mass - 162) / 38) ** 2)));
}

// Oxide (M+16) and isotopic-impurity (M±1) spillover between mass channels. Light lanthanides
// (La–Gd) oxidize most.
export function massSpillover(masses) {
  const n = masses.length;
  const matrix = new Float64Array(n * n);
  for (let i = 0; i < n; i += 1) {
    matrix[i * n + i] = 1;
    const m = masses[i];
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const delta = masses[j] - m;
      if (delta === 16) matrix[i * n + j] = m >= 139 && m <= 160 ? 0.022 : m < 139 ? 0.01 : 0.006;
      else if (delta === 1 || delta === -1) matrix[i * n + j] = m >= 139 && m <= 176 ? 0.006 : 0.002;
    }
  }
  return matrix;
}

const MASS_SPECIAL = ['Dead cells', 'Debris', 'Doublets', 'Beads'];

// Simulates one mass cytometry sample. config:
//   count, channels: [{ name, label, mass, marker?, role: 'marker'|'bead'|'dna1'|'dna2'|'viability'|'empty' }],
//   populations (compilePopulations over config.markers), weights, markers (names, order of
//   population marker dims), mix: { dead, debris, doublets, beads }, rate, drift (fractional
//   sensitivity loss by the end), channelFactors (instrument sensitivity per channel, affects
//   beads), markerFactors (staining per marker), beadLevels: { [channel]: counts },
//   barcode: { levels: Float64Array (counts per channel for this sample's code, 0 elsewhere),
//   other: () => levels of the partner cell of a doublet (another sample's code when barcoded
//   samples are pooled) }. Barcode staining (palladium, Zunder et al. 2015) scales with cell size,
//   with a per-cell factor shared by all barcode channels.
export function simulateMassEvents(config, random, options = {}) {
  const { count, channels, populations, markers } = config;
  const nPop = populations.length;
  const nCh = channels.length;
  const nMarkers = markers.length;
  const d = CELL_DIMS.length + nMarkers;
  const mix = { dead: 0.05, debris: 0.04, doublets: 0.04, beads: 0.03, ...config.mix };
  const rate = config.rate ?? 350;
  const signal = options.signal;
  const masses = channels.map((c) => c.mass);
  const spill = massSpillover(masses);
  // Incoming spillover per target channel as sparse lists.
  const inStart = new Int32Array(nCh + 1);
  const inFrom = [];
  const inValue = [];
  for (let j = 0; j < nCh; j += 1) {
    inStart[j] = inFrom.length;
    for (let i = 0; i < nCh; i += 1) {
      if (spill[i * nCh + j]) {
        inFrom.push(i);
        inValue.push(spill[i * nCh + j]);
      }
    }
  }
  inStart[nCh] = inFrom.length;
  const sens = new Float64Array(nCh);
  const markerOf = new Int32Array(nCh).fill(-1);
  channels.forEach((c, j) => {
    sens[j] = massSensitivity(c.mass) * (config.channelFactors?.[c.name] ?? 1);
    if (c.role === 'marker') {
      markerOf[j] = markers.indexOf(c.marker);
      if (markerOf[j] >= 0) sens[j] *= config.markerFactors?.[c.marker] ?? 1;
    }
  });
  const viabilityMarker = markers.indexOf('Viability');
  const roleIndex = (role) => channels.findIndex((c) => c.role === role);
  const dna1 = roleIndex('dna1');
  const dna2 = roleIndex('dna2');
  const via = roleIndex('viability');

  const live = config.weights;
  let liveSum = 0;
  for (let p = 0; p < nPop; p += 1) liveSum += live[p];
  const liveFraction = Math.max(0, 1 - mix.dead - mix.debris - mix.doublets - mix.beads);
  const kindWeights = new Float64Array(nPop + 4);
  for (let p = 0; p < nPop; p += 1) kindWeights[p] = (live[p] / liveSum) * liveFraction;
  kindWeights[nPop] = mix.dead;
  kindWeights[nPop + 1] = mix.debris;
  kindWeights[nPop + 2] = mix.doublets;
  kindWeights[nPop + 3] = mix.beads;
  const kinds = sampledLabels(count, kindWeights, random);
  const DEAD = nPop;
  const DEBRIS = nPop + 1;
  const DOUBLET = nPop + 2;
  const pickPopulation = createPicker(live, random);
  const labelNames = [];
  const popLabel = new Int32Array(nPop);
  populations.forEach((pop, p) => {
    let index = labelNames.indexOf(pop.label);
    if (index < 0) {
      index = labelNames.length;
      labelNames.push(pop.label);
    }
    popLabel[p] = index;
  });
  const specialBase = labelNames.length;
  labelNames.push(...MASS_SPECIAL);

  const times = acquisitionTimes(count, rate, [], random);
  const nominal = count / rate;
  const duration = count ? times[count - 1] : 0;
  const out = channels.map(() => new Float32Array(count));
  const time = new Float32Array(count);
  const eventLength = new Float32Array(count);
  const center = new Float32Array(count);
  const offset = new Float32Array(count);
  const width = new Float32Array(count);
  const residual = new Float32Array(count);
  const labels = new Int32Array(count);
  const cell = new Float64Array(d);
  const other = new Float64Array(d);
  const scratch = new Float64Array(d);
  const lambda = new Float64Array(nCh);
  const g = createNormal(random);
  const maxValue = (config.range ?? 16384) - 1;
  const beadLevels = config.beadLevels ?? {};
  const bg = config.background ?? 0.15;

  const barcode = config.barcode ?? null;
  const addBarcode = (levels, amount) => {
    const shared = amount * Math.exp(0.3 * g());
    for (let j = 0; j < nCh; j += 1) if (levels[j]) lambda[j] += levels[j] * sens[j] * shared * Math.exp(0.28 * g());
  };

  // DNA content of a quiescent PBMC (mostly G0/G1, a few cycling cells).
  const dnaAmount = () => {
    const u = random();
    const content = u < 0.965 ? 1 : u < 0.985 ? 1 + random() : 2;
    return content * Math.exp(0.1 * g());
  };

  for (let e = 0; e < count; e += 1) {
    if ((e & 16383) === 0 && e && signal?.aborted) throw new Error('Simulation was canceled.');
    const t = times[e];
    const progress = Math.min(1.2, t / nominal);
    const kind = kinds[e];
    for (let j = 0; j < nCh; j += 1) lambda[j] = bg * (0.5 + 0.5 * (j % 3));
    let length;
    let res;
    let dna = 0;
    let isBead = false;
    if (kind < nPop || kind === DEAD || kind === DOUBLET) {
      const fill = (target, dying) => {
        const p = kind < nPop ? kind : pickPopulation();
        sampleCell(populations[p], g, target, scratch);
        if (dying) {
          for (let m = 0; m < nMarkers; m += 1) target[4 + m] *= 0.5;
          if (viabilityMarker >= 0) target[4 + viabilityMarker] = 1e5 * Math.exp(0.4 * g());
        }
        return p;
      };
      if (kind === DOUBLET) {
        fill(cell, random() < 0.05);
        fill(other, random() < 0.05);
        for (let k = 0; k < d; k += 1) cell[k] += other[k];
        dna = dnaAmount() + dnaAmount();
        length = 42 * Math.exp(0.15 * g());
        res = 160 * Math.exp(0.45 * g());
        labels[e] = specialBase + 2;
      } else {
        fill(cell, kind === DEAD);
        dna = dnaAmount() * (kind === DEAD ? 0.85 : 1);
        length = 23 * Math.exp(0.13 * g()) * Math.sqrt(cell[0] / 60000);
        res = 35 * Math.exp(0.5 * g());
        labels[e] = kind < nPop ? popLabel[kind] : specialBase;
      }
      for (let j = 0; j < nCh; j += 1) {
        const m = markerOf[j];
        if (m >= 0) lambda[j] += cell[4 + m] * sens[j];
      }
      if (via >= 0 && viabilityMarker >= 0) lambda[via] += cell[4 + viabilityMarker] * sens[via];
      if (barcode) {
        addBarcode(barcode.levels, Math.sqrt(Math.max(0.2, (kind === DOUBLET ? cell[0] - other[0] : cell[0]) / 60000)));
        if (kind === DOUBLET) addBarcode(barcode.other?.() ?? barcode.levels, Math.sqrt(Math.max(0.2, other[0] / 60000)));
      }
    } else if (kind === DEBRIS) {
      for (let m = 0; m < nMarkers; m += 1) cell[4 + m] = 0;
      dna = 0.08 * Math.exp(0.9 * g());
      length = 13 * Math.exp(0.25 * g());
      res = 70 * Math.exp(0.6 * g());
      for (let j = 0; j < nCh; j += 1) if (markerOf[j] >= 0) lambda[j] += 150 * sens[j] * Math.exp(0.8 * g());
      if (via >= 0 && random() < 0.5) lambda[via] += 4e4 * sens[via] * Math.exp(0.8 * g());
      if (barcode) addBarcode(barcode.levels, 0.15 * Math.exp(0.7 * g()));
      labels[e] = specialBase + 1;
    } else {
      isBead = true;
      length = 20 * Math.exp(0.1 * g());
      res = 25 * Math.exp(0.4 * g());
      const beadScale = Math.exp(0.18 * g());
      for (let j = 0; j < nCh; j += 1) {
        const level = beadLevels[channels[j].name];
        if (level) lambda[j] += level * beadScale * (config.channelFactors?.[channels[j].name] ?? 1);
      }
      labels[e] = specialBase + 3;
    }
    if (!isBead && dna1 >= 0) {
      lambda[dna1] += 260 * dna;
      lambda[dna2] += 437 * dna; // 193Ir/191Ir natural abundance 62.7 : 37.3
    }
    // Instrument sensitivity: a shared ion-cloud transmission factor per event and a slow
    // decline over the run that is steeper for heavy masses (what bead normalization corrects).
    const cloud = Math.exp(0.12 * g());
    let total = 0;
    for (let j = 0; j < nCh; j += 1) {
      const decline = 1 - (config.drift ?? 0) * progress * (0.7 + (0.6 * (masses[j] - 89)) / 120);
      lambda[j] *= cloud * decline;
    }
    // Oxide and isotopic spillover, then Poisson counting and Helios-style randomization
    // (a uniform draw in (−1, 0] added to non-zero counts).
    for (let j = 0; j < nCh; j += 1) {
      let l = 0;
      for (let r = inStart[j], end = inStart[j + 1]; r < end; r += 1) l += lambda[inFrom[r]] * inValue[r];
      const counts = poisson(random, l * Math.exp(0.08 * g()));
      let v = counts > 0 ? counts - random() : 0;
      if (v > maxValue) v = maxValue;
      out[j][e] = v;
      total += v;
    }
    time[e] = Math.floor(t * 1000);
    eventLength[e] = Math.max(8, Math.round(length));
    center[e] = 40 + 32 * Math.sqrt(total) * Math.exp(0.15 * g());
    offset[e] = 18 * Math.exp(0.6 * g());
    width[e] = eventLength[e] * 1.35 * Math.exp(0.08 * g());
    residual[e] = res;
  }
  return { channels: out, time, eventLength, center, offset, width, residual, labels, labelNames, times, duration };
}

// --- FCS assembly ---------------------------------------------------------------------------------

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// '2026-03-12' → '12-MAR-2026' (FCS 3.1 $DATE).
export function fcsDate(iso) {
  const [y, m, d] = iso.split('-').map((part) => Number.parseInt(part, 10));
  return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`;
}

// Seconds since midnight → 'hh:mm:ss' (FCS 3.1 $BTIM/$ETIM).
export function fcsClock(seconds) {
  const s = Math.max(0, Math.floor(seconds)) % 86400;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return [hh, mm, ss].map((v) => String(v).padStart(2, '0')).join(':');
}

// Standard and instrument keywords for an acquisition.
// info: { instrument, date (ISO), start (s since midnight), duration (s), fileName, tube,
//         experiment, source, flowRate (µL/min), spill, extra, seed, example }
export function acquisitionKeywords(info) {
  const instrument = info.instrument;
  const flow = info.flowRate ?? instrument.flowRate ?? 35;
  const keywords = {
    $CYT: instrument.cyt,
    $CYTSN: instrument.serial,
    $DATE: fcsDate(info.date),
    $BTIM: fcsClock(info.start),
    $ETIM: fcsClock(info.start + Math.max(1, Math.ceil(info.duration))),
    $FIL: info.fileName,
    $SRC: info.source ?? '',
    $INST: 'CytoWeave example laboratory',
    $OP: 'CytoWeave simulator',
    $SYS: `CytoWeave simulator ${SIMULATOR_VERSION}`,
    $TIMESTEP: String(instrument.timestep),
    // FCS 3.1 $VOL is in nanoliters.
    $VOL: String(Math.round(((info.duration * flow) / 60) * 1000)),
    $COM: 'Simulated data generated by CytoWeave; not a real acquisition.',
    CREATOR: `CytoWeave simulator ${SIMULATOR_VERSION}`,
    'TUBE NAME': info.tube ?? info.fileName.replace(/\.fcs$/i, ''),
    'EXPERIMENT NAME': info.experiment ?? '',
    'CYTOWEAVE SIMULATION': `example=${info.example ?? ''};seed=${info.seed ?? ''};version=${SIMULATOR_VERSION}`,
  };
  if (info.spill) keywords.$SPILLOVER = formatSpilloverKeyword(info.spill);
  return { ...keywords, ...(info.extra ?? {}) };
}

// $SPILLOVER text: "n,names...,values..." (FCS 3.1).
export function formatSpilloverKeyword({ channels, matrix }) {
  const values = Array.from(matrix, (v) => (v === 0 ? '0' : String(+v.toPrecision(6))));
  return [channels.length, ...channels, ...values].join(',');
}

// Writes an FCS 3.1 file. parameters: [{ name, label, range, voltage? }]; columns in the same order.
export function encodeFCS(parameters, columns, keywords) {
  const extra = { ...keywords };
  parameters.forEach((p, i) => {
    if (p.voltage) extra[`$P${i + 1}V`] = String(p.voltage);
  });
  return writeFCS({ parameters: parameters.map((p) => ({ name: p.name, label: p.label ?? '', range: p.range })), data: columns, keywords: extra });
}

// The smallest power of two above the largest value (a $PnR for derived or time channels).
export function rangeFor(column, minimum = 1024) {
  let max = 0;
  for (let i = 0; i < column.length; i += 1) if (column[i] > max) max = column[i];
  let range = minimum;
  while (range <= max) range *= 2;
  return range;
}

export { createRandom };
