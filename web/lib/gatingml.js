// ISAC Gating-ML 2.0 import and export (Spidlen et al. 2015, Cytometry A 87:683–687,
// doi:10.1002/cyto.a.22690).
//
// Gating-ML gates on transformed dimensions hold their coordinates in the transformation's output
// (scale) space, which is CytoWeave's gate space, so those coordinates are copied unchanged.
// Dimensions without a transformation are raw data values; CytoWeave represents them with the
// identity transform { type: 'linear', min: 0, max: 1 } (forward(x) = x).
//
// Mapping of transformations (Gating-ML → CytoWeave):
//   flin(T, A)            → linear { min: −A, max: T }        ((x + A) / (T + A))
//   flog(T, M)            → log { min: T·10^−M, max: T }       (log10(x / T) / M + 1)
//   fasinh(T, M, A)       → fasinh { T, M, A }
//   logicle(T, W, M, A)   → logicle { T, W, M, A }
//   hyperlog(T, W, M, A)  → hyperlog { T, W, M, A }
//   fratio(A, B, C; x, y) → a derived "ratio" channel A·(x − B) / (y − C)
// CytoWeave's biex is written as its logicle equivalent and arcsinh as the fasinh with the same
// function; a CytoWeave custom_info block restores the original spec when read back.

import { attr, child, children, element, find, numberAttr, parseXMLDocument, serializeXML, textContent } from './xml.js';
import { biexToLogicle, createTransform } from './transforms.js';
import { invertMatrix } from './compensation.js';
import { newId } from './gates.js';

export const GATING_NS = 'http://www.isac-net.org/std/Gating-ML/v2.0/gating';
export const TRANSFORMS_NS = 'http://www.isac-net.org/std/Gating-ML/v2.0/transformations';
export const DATATYPE_NS = 'http://www.isac-net.org/std/Gating-ML/v2.0/datatypes';
export const CYTOWEAVE_NS = 'urn:cytoweave:gating-ml:1';

export const IDENTITY_TRANSFORM = Object.freeze({ type: 'linear', min: 0, max: 1 });

const GATE_ELEMENTS = ['RectangleGate', 'PolygonGate', 'EllipsoidGate', 'QuadrantGate', 'BooleanGate'];
const LN10 = Math.LN10;

class SkipGate extends Error {}

// --- Transformations ------------------------------------------------------------------------

// A Gating-ML 2.0 transformation element (flin, flog, fasinh, logicle, hyperlog, fratio) as a
// CytoWeave spec: { spec, notes } | { ratio: { numerator, denominator, A, B, C } } | { error }.
export function transformFromGatingML(el) {
  const notes = [];
  const p = (name) => numberAttr(el, name, TRANSFORMS_NS) ?? numberAttr(el, name, TRANSFORMS_NS, undefined, { ignoreCase: true });
  const required = (...names) => {
    const missing = names.filter((name) => p(name) === undefined);
    return missing.length ? `${el.local} lacks the parameter${missing.length > 1 ? 's' : ''} ${missing.join(', ')}` : null;
  };
  const optionalA = () => {
    const A = p('A');
    if (A === undefined) {
      notes.push(`${el.local} has no A parameter; 0 was assumed`);
      return 0;
    }
    return A;
  };
  let spec;
  switch (el.local) {
    case 'flin': {
      const error = required('T');
      if (error) return { error };
      const T = p('T');
      const A = optionalA();
      if (!(T + A > 0)) return { error: 'flin needs T + A > 0' };
      spec = { type: 'linear', min: A ? -A : 0, max: T };
      break;
    }
    case 'flog': {
      const error = required('T', 'M');
      if (error) return { error };
      const T = p('T');
      const M = p('M');
      if (!(T > 0) || !(M > 0)) return { error: 'flog needs T > 0 and M > 0' };
      spec = { type: 'log', min: T / 10 ** M, max: T };
      break;
    }
    case 'fasinh': {
      const error = required('T', 'M');
      if (error) return { error };
      spec = { type: 'fasinh', T: p('T'), M: p('M'), A: optionalA() };
      if (!(spec.T > 0) || !(spec.M > 0)) return { error: 'fasinh needs T > 0 and M > 0' };
      break;
    }
    case 'logicle':
    case 'hyperlog': {
      const error = required('T', 'W', 'M');
      if (error) return { error };
      spec = { type: el.local, T: p('T'), W: p('W'), M: p('M'), A: optionalA() };
      break;
    }
    case 'fratio': {
      const dims = children(el, 'fcs-dimension');
      if (dims.length !== 2) return { error: 'fratio needs exactly two FCS dimensions' };
      const [numerator, denominator] = dims.map((d) => attr(d, 'name', DATATYPE_NS));
      if (!numerator || !denominator) return { error: 'fratio names no FCS parameters' };
      const error = required('A', 'B', 'C');
      if (error) return { error };
      return { ratio: { numerator, denominator, A: p('A'), B: p('B'), C: p('C') }, notes };
    }
    default:
      return { error: `the transformation "${el.local}" is not part of Gating-ML 2.0` };
  }
  try {
    createTransform(spec);
  } catch (error) {
    return { error: `${el.local}: ${error.message}` };
  }
  return { spec, notes };
}

// The Gating-ML form of a CytoWeave transform:
//   { identity: true }                  no transformation-ref (the identity linear scale)
//   { local, params }                   a Gating-ML transformation
//   { raw: true }                       write the dimension untransformed with data coordinates
//                                       (for linear scales whose flin parameters are out of range)
//   { local, params, convert: true }    a stand-in Gating-ML transformation; coordinates must be
//                                       converted to its scale (FlowJo biex → logicle)
export function transformToGatingML(spec) {
  const type = spec?.type ?? 'linear';
  switch (type) {
    case 'linear': {
      const min = spec?.min ?? 0;
      const max = spec?.max ?? 262144;
      if (min === 0 && max === 1) return { identity: true };
      const A = min ? -min : 0;
      // Gating-ML 2.0 constrains flin to T > 0 and 0 ≤ A ≤ T.
      if (max > 0 && A >= 0 && A <= max) return { local: 'flin', params: { T: max, A } };
      return { raw: true };
    }
    case 'log': {
      const min = spec.min ?? 1;
      const max = spec.max ?? 262144;
      return { local: 'flog', params: { T: max, M: Math.log10(max / min) } };
    }
    case 'logicle': return { local: 'logicle', params: { T: spec.T, W: spec.W, M: spec.M, A: spec.A ?? 0 } };
    case 'biex': {
      // Gating-ML has no FlowJo biex: write the closest logicle and convert coordinates to it.
      const { T, W, M, A } = biexToLogicle(spec);
      return { local: 'logicle', params: { T, W, M, A }, convert: true };
    }
    case 'arcsinh': {
      // asinh(x / c) rescaled to [min, max] is fasinh with T = max, M = asinh(max / c) / ln 10 and
      // A = −asinh(min / c) / ln 10: the same function, exactly.
      const c = spec.cofactor ?? 150;
      const max = spec.max ?? 262144;
      const min = spec.min ?? -c * Math.sinh(1);
      return { local: 'fasinh', params: { T: max, M: Math.asinh(max / c) / LN10, A: -Math.asinh(min / c) / LN10 } };
    }
    case 'fasinh': return { local: 'fasinh', params: { T: spec.T ?? 262144, M: spec.M ?? 4.5, A: spec.A ?? 0 } };
    case 'hyperlog': return { local: 'hyperlog', params: { T: spec.T ?? 262144, W: spec.W ?? 0.5, M: spec.M ?? 4.5, A: spec.A ?? 0 } };
    default: return { error: `the transform "${type}" has no Gating-ML equivalent` };
  }
}

// Do two specs define the same function (to 1e-9 of the scale over the axis)?
export function sameTransformFunction(a, b) {
  // Bounds (boundMin, boundMax) must agree; the functions are compared without them.
  const bound = (spec, name) => (Number.isFinite(spec?.[name]) ? spec[name] : null);
  if (bound(a, 'boundMin') !== bound(b, 'boundMin') || bound(a, 'boundMax') !== bound(b, 'boundMax')) return false;
  const unbounded = (spec) => {
    const { boundMin, boundMax, ...rest } = spec ?? {};
    return rest;
  };
  try {
    const ta = createTransform(unbounded(a));
    const tb = createTransform(unbounded(b));
    for (let k = 0; k <= 10; k += 1) {
      const y = -0.1 + (1.2 * k) / 10;
      const x = tb.inverse(y);
      if (!Number.isFinite(x)) continue;
      if (Math.abs(ta.forward(x) - y) > 1e-9) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// --- Ellipses -----------------------------------------------------------------------------------

// CytoWeave ellipse { center, radii, angle } from a 2 × 2 covariance matrix and Gating-ML's
// distanceSquare: (x − μ)ᵀ Σ⁻¹ (x − μ) ≤ d². With Σ = R diag(λ₁, λ₂) Rᵀ the radii are
// sqrt(d²·λ) and the angle is that of the first eigenvector. Returns null when Σ is not
// positive definite.
export function ellipseFromCovariance(center, covariance, distanceSquare = 1) {
  const a = covariance[0][0];
  const b = (covariance[0][1] + covariance[1][0]) / 2;
  const c = covariance[1][1];
  const det = a * c - b * b;
  const l1 = (a + c) / 2 + Math.hypot((a - c) / 2, b);
  // λ₂ = det / λ₁ rather than mean − spread: gates in raw data units mix axes whose variances
  // differ by ten orders of magnitude, where the subtraction loses every digit.
  const l2 = det / l1;
  if (!(l1 > 0) || !(l2 > 0) || !(distanceSquare > 0)) return null;
  // Principal-axis angle of the larger eigenvalue, in (−π/2, π/2].
  let angle = 0.5 * Math.atan2(2 * b, a - c);
  if (angle <= -Math.PI / 2) angle += Math.PI;
  return { center: [center[0], center[1]], radii: [Math.sqrt(distanceSquare * l1), Math.sqrt(distanceSquare * l2)], angle };
}

// The covariance matrix (with distanceSquare 1) of a CytoWeave ellipse: Σ = R diag(rx², ry²) Rᵀ.
export function covarianceFromEllipse({ radii, angle = 0 }) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rx2 = radii[0] * radii[0];
  const ry2 = radii[1] * radii[1];
  const off = (rx2 - ry2) * sin * cos;
  return [[rx2 * cos * cos + ry2 * sin * sin, off], [off, rx2 * sin * sin + ry2 * cos * cos]];
}

// --- Import ---------------------------------------------------------------------------------

function customInfo(el) {
  const block = child(el, 'custom_info');
  if (!block) return null;
  const info = find(block, 'info', CYTOWEAVE_NS);
  if (info) {
    return {
      name: attr(info, 'name'),
      type: attr(info, 'type'),
      color: attr(info, 'color'),
      spec: attr(info, 'spec'),
      channel: attr(info, 'channel'),
      compensation: attr(info, 'compensation'),
      ontology: attr(info, 'ontology'),
      quadrants: Object.fromEntries(children(info, 'quadrant').map((q) => [attr(q, 'id'), { name: attr(q, 'name'), color: attr(q, 'color'), type: attr(q, 'type'), ontology: attr(q, 'ontology') }])),
    };
  }
  // Other tools (Cytobank, FlowJo) keep a population name in their own custom_info blocks.
  const named = find(block, 'name');
  if (named && textContent(named).trim()) return { name: textContent(named).trim(), quadrants: {} };
  for (const el2 of [block, ...block.children]) {
    const name = attr(el2, 'name');
    if (name) return { name, quadrants: {} };
  }
  return null;
}

function coordinateValue(el) {
  const value = numberAttr(el, 'value', DATATYPE_NS);
  if (value !== undefined) return value;
  const text = textContent(el).trim();
  return text === '' ? Number.NaN : Number(text);
}

function sanitizeId(value) {
  let id = String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!/^[A-Za-z_]/.test(id)) id = `_${id}`;
  return id;
}

// Imports a Gating-ML 2.0 document (text, bytes or a parsed xml.js element).
// Returns { gates, compensations, transforms, derived, warnings }: gates carry fresh ids and
// parentId links, compensations are CytoWeave compensation objects for each spectrumMatrix,
// transforms lists the document's transformations ({ id, spec } or ratio descriptions), and
// derived lists ratio channels to create ({ kind: 'ratio', inputs, outputs, params }).
export function importGatingML(input, options = {}) {
  const warnings = [];
  const doc = input && typeof input === 'object' && input.local ? { root: input, warnings: [] } : parseXMLDocument(input);
  for (const w of doc.warnings) warnings.push(`XML: ${w}`);
  const { root } = doc;
  if (root.local !== 'Gating-ML') throw new Error(`This is not a Gating-ML document (its root element is <${root.name}>).`);
  if (root.ns && root.ns !== GATING_NS) {
    if (/v1\.5/i.test(root.ns)) warnings.push('This is a Gating-ML 1.5 document; CytoWeave reads Gating-ML 2.0, so transformations and some gates may not import.');
    else warnings.push(`Unexpected Gating-ML namespace "${root.ns}"; the document was read as Gating-ML 2.0.`);
  }
  const created = options.now ?? new Date().toISOString();

  // Transformations.
  const transformById = new Map();
  const transforms = [];
  const derived = [];
  for (const t of children(root, 'transformation')) {
    const id = attr(t, 'id', TRANSFORMS_NS);
    const body = t.children.find((c) => c.local !== 'custom_info');
    if (!id || !body) {
      warnings.push('A transformation without an id or a definition was ignored.');
      continue;
    }
    const result = transformFromGatingML(body);
    for (const note of result.notes ?? []) warnings.push(`Transformation "${id}": ${note}.`);
    if (result.error) {
      warnings.push(`Transformation "${id}" could not be read (${result.error}); gates that use it were skipped.`);
      transformById.set(id, result);
      continue;
    }
    const info = customInfo(t);
    // boundMin / boundMax (Gating-ML 2.0 §5.1): transformed values are clamped to them.
    const bounds = {};
    for (const name of ['boundMin', 'boundMax']) {
      const value = numberAttr(t, name, TRANSFORMS_NS);
      if (value === undefined) continue;
      if (Number.isFinite(value)) bounds[name] = value;
      else warnings.push(`Transformation "${id}": its ${name} is not a number and was ignored.`);
    }
    if (result.ratio) {
      const channel = info?.channel ?? id;
      const { numerator, denominator, A, B, C } = result.ratio;
      derived.push({ id: newId('d'), kind: 'ratio', params: { A, B, C }, seed: null, inputs: [numerator, denominator], outputs: [channel], created, meta: { origin: 'imported', gatingMLId: id } });
      transforms.push({ id, type: 'ratio', channel, numerator, denominator, A, B, C });
      transformById.set(id, { ratio: result.ratio, channel, bounds });
      continue;
    }
    let spec = { ...result.spec, ...bounds };
    if (info?.spec) {
      try {
        const original = JSON.parse(info.spec);
        if (sameTransformFunction(original, spec)) spec = original;
        else if (original?.type === 'biex' && spec.type === 'logicle') warnings.push(`Transformation "${id}" was a FlowJo biexponential, which Gating-ML stores as its closest logicle; the logicle is used here.`);
        else warnings.push(`Transformation "${id}": its CytoWeave description disagrees with its Gating-ML parameters; the Gating-ML parameters were used.`);
      } catch {
        warnings.push(`Transformation "${id}": unreadable CytoWeave description ignored.`);
      }
    }
    transformById.set(id, { spec });
    transforms.push({ id, spec });
  }

  // Compensation (spectrum) matrices.
  const matrices = new Map();
  const compensations = [];
  for (const m of children(root, 'spectrumMatrix')) {
    const id = attr(m, 'id', TRANSFORMS_NS);
    const names = (tag) => children(child(m, tag), 'fcs-dimension').map((d) => attr(d, 'name', DATATYPE_NS));
    const fluorochromes = names('fluorochromes');
    const detectors = names('detectors');
    const rows = children(m, 'spectrum').map((row) => children(row, 'coefficient').map((c) => numberAttr(c, 'value', TRANSFORMS_NS, Number.NaN)));
    const where = `Spectrum matrix "${id}"`;
    if (!id) {
      warnings.push('A spectrumMatrix without an id was ignored.');
      continue;
    }
    const inverted = String(attr(m, 'matrix-inverted-already', TRANSFORMS_NS) ?? 'false').toLowerCase() === 'true';
    // A spectrum matrix has a row of detector coefficients per fluorochrome; an inverted one (the
    // unmixing matrix itself) has a row of fluorochrome coefficients per detector.
    const [rowCount, rowLength] = inverted ? [detectors.length, fluorochromes.length] : [fluorochromes.length, detectors.length];
    if (!fluorochromes.length || !detectors.length || rows.length !== rowCount || rows.some((r) => r.length !== rowLength) || rows.flat().some((v) => !Number.isFinite(v))) {
      warnings.push(`${where} is incomplete (it needs one row of ${inverted ? 'fluorochrome coefficients per detector, as it is marked inverted' : 'detector coefficients per fluorochrome'}) and was ignored.`);
      matrices.set(id, { error: true });
      continue;
    }
    if (fluorochromes.length !== detectors.length) {
      // Spectral unmixing: each fluorochrome becomes a channel computed from the raw detectors by
      // ordinary least squares, W = Sᵀ(S Sᵀ)⁻¹ (detectors × fluorochromes), unless given inverted.
      const f = fluorochromes.length;
      const d = detectors.length;
      let unmixing;
      if (inverted) {
        unmixing = rows.flat();
      } else {
        const gram = [];
        for (let i = 0; i < f; i += 1) for (let j = 0; j < f; j += 1) gram.push(rows[i].reduce((sum, v, k) => sum + v * rows[j][k], 0));
        let inverse;
        try {
          inverse = invertMatrix(gram, f);
        } catch {
          warnings.push(`${where}: its fluorochrome spectra are linearly dependent, so it cannot unmix; it was ignored.`);
          matrices.set(id, { error: true });
          continue;
        }
        unmixing = [];
        for (let k = 0; k < d; k += 1) for (let j = 0; j < f; j += 1) {
          let sum = 0;
          for (let i = 0; i < f; i += 1) sum += rows[i][k] * inverse[i * f + j];
          unmixing.push(sum);
        }
      }
      derived.push({ id: newId('d'), kind: 'unmix', name: id, inputs: detectors.slice(), outputs: fluorochromes.slice(), params: { matrix: unmixing }, created, meta: { origin: 'imported', gatingMLId: id } });
      matrices.set(id, { unmix: true, fluorochromes, detectors });
      continue;
    }
    const n = detectors.length;
    let matrix = Float64Array.from(rows.flat());
    if (inverted) {
      try {
        matrix = invertMatrix(matrix, n);
      } catch {
        warnings.push(`${where} is marked as already inverted but cannot be inverted back; it was ignored.`);
        matrices.set(id, { error: true });
        continue;
      }
    }
    const compensation = { id: newId('c'), name: id, channels: detectors.slice(), matrix: Array.from(matrix), source: 'imported', gatingMLId: id };
    if (fluorochromes.some((f, i) => f !== detectors[i])) compensation.fluorochromes = fluorochromes.slice();
    compensations.push(compensation);
    matrices.set(id, { compensation, fluorochromes, detectors });
  }

  // Ratio inputs named by a matrix's fluorochromes (compensated dimensions) are read from the
  // detector channel of the same matrix row, where CytoWeave keeps the compensated values.
  for (const record of derived.filter((d) => d.kind === 'ratio')) {
    record.inputs = record.inputs.map((name) => {
      for (const m of matrices.values()) {
        const i = m.compensation ? m.fluorochromes.indexOf(name) : -1;
        if (i >= 0) return m.detectors[i];
      }
      return name;
    });
  }

  // Gate records, with CytoWeave ids assigned up front so references may point forward.
  const records = [];
  const idMap = new Map();
  const quadrantGateIds = new Set();
  let unnamed = 0;
  for (const el of root.children) {
    if (!GATE_ELEMENTS.includes(el.local)) continue;
    let gmlId = attr(el, 'id', GATING_NS);
    if (!gmlId) {
      unnamed += 1;
      gmlId = `unnamed-${el.local}-${unnamed}`;
      warnings.push(`A ${el.local} without an id was named "${gmlId}".`);
    }
    if (idMap.has(gmlId) || quadrantGateIds.has(gmlId)) {
      warnings.push(`The gate id "${gmlId}" is used twice; the second gate was ignored.`);
      continue;
    }
    const record = { el, gmlId, parentGmlId: attr(el, 'parent_id', GATING_NS) ?? null, info: customInfo(el) };
    if (el.local === 'QuadrantGate') {
      quadrantGateIds.add(gmlId);
      record.quadrants = [];
      for (const q of children(el, 'Quadrant')) {
        const qid = attr(q, 'id', GATING_NS);
        if (!qid || idMap.has(qid)) {
          warnings.push(`QuadrantGate "${gmlId}": a Quadrant without a unique id was ignored.`);
          continue;
        }
        idMap.set(qid, newId('g'));
        record.quadrants.push({ el: q, gmlId: qid });
      }
    } else {
      idMap.set(gmlId, newId('g'));
    }
    records.push(record);
  }

  let missingCompensationRef = false;
  const parseDimension = (dimEl, where) => {
    const transformationRef = attr(dimEl, 'transformation-ref', GATING_NS);
    let compensationRef = attr(dimEl, 'compensation-ref', GATING_NS);
    const fcs = child(dimEl, 'fcs-dimension');
    const newDimension = child(dimEl, 'new-dimension');
    let channel;
    let transform = IDENTITY_TRANSFORM;
    if (newDimension) {
      const ref = attr(newDimension, 'transformation-ref', GATING_NS);
      const t = transformById.get(ref);
      if (!t?.ratio) throw new SkipGate(`${where}: its new-dimension refers to "${ref}", which is not a readable fratio transformation`);
      channel = t.channel;
      transform = { ...IDENTITY_TRANSFORM, ...t.bounds };
      compensationRef ??= attr(newDimension, 'compensation-ref', GATING_NS);
    } else {
      channel = attr(fcs, 'name', DATATYPE_NS) ?? attr(child(dimEl, 'parameter'), 'name') ?? attr(dimEl, 'name');
      if (!channel) throw new SkipGate(`${where}: a dimension names no FCS parameter`);
    }
    if (transformationRef) {
      const t = transformById.get(transformationRef);
      if (!t) throw new SkipGate(`${where}: it refers to the unknown transformation "${transformationRef}"`);
      if (t.error) throw new SkipGate(`${where}: its transformation "${transformationRef}" could not be read`);
      if (t.ratio) {
        // A ratio referenced like an ordinary transformation: read it as the derived dimension.
        channel = t.channel;
        transform = { ...IDENTITY_TRANSFORM, ...t.bounds };
      } else {
        transform = t.spec;
      }
    }
    if (compensationRef === undefined) {
      missingCompensationRef = true;
      compensationRef = 'uncompensated';
    }
    // The CytoWeave compensation reference the dimension keeps (see engine.js): the file's
    // matrix, none, or an imported matrix.
    let compensation = compensationRef === 'FCS' ? 'file' : 'uncompensated';
    if (compensationRef !== 'FCS' && compensationRef !== 'uncompensated') {
      const m = matrices.get(compensationRef);
      if (!m) {
        warnings.push(`${where}: unknown compensation "${compensationRef}"; the dimension was read as uncompensated.`);
        compensationRef = 'uncompensated';
      } else if (m.error) {
        throw new SkipGate(`${where}: its compensation "${compensationRef}" could not be read`);
      } else if (m.unmix) {
        // Unmixed dimensions are the fluorochrome channels computed from the raw detectors.
        compensation = 'uncompensated';
      } else {
        // Compensated dimensions are named by fluorochrome; CytoWeave keeps the compensated values
        // in the detector channel of the same matrix row.
        const i = m.fluorochromes.indexOf(channel);
        if (i >= 0) channel = m.detectors[i];
        compensation = m.compensation.id;
      }
    }
    return { channel, transform: { ...transform }, compensationRef, compensation };
  };

  const gates = [];
  const skipped = new Map();
  const helpers = new Map();
  const base = (id, gmlId, name, info, record, dims) => {
    const gate = {
      id,
      name: name ?? gmlId,
      parentId: null,
      type: null,
      // A CytoWeave export marks gates that follow each sample's compensation; other documents'
      // dimensions keep the compensation they name.
      dims: dims.map((d) => (info?.compensation === 'sample' ? { channel: d.channel, transform: d.transform } : { channel: d.channel, transform: d.transform, compensation: d.compensation })),
      geometry: null,
      scope: null,
      overrides: {},
      meta: { origin: 'imported', source: 'gating-ml', gatingMLId: gmlId, compensation: dims.map((d) => d.compensationRef) },
    };
    if (info?.color) gate.color = info.color;
    const term = /^(CL:\d{7})\s+(.+)$/.exec(info?.ontology ?? '');
    if (term) gate.ontology = { id: term[1], label: term[2], status: 'confirmed', source: 'gating-ml' };
    if (record.parentGmlId) {
      const parentId = idMap.get(record.parentGmlId);
      if (parentId) gate.parentId = parentId;
      else if (quadrantGateIds.has(record.parentGmlId)) warnings.push(`Gate "${gmlId}" names the QuadrantGate "${record.parentGmlId}" as its parent rather than one of its quadrants; it was imported at the top level.`);
      else warnings.push(`Gate "${gmlId}" names the unknown parent "${record.parentGmlId}"; it was imported at the top level.`);
    }
    return gate;
  };

  for (const record of records) {
    const { el, gmlId, info } = record;
    const where = `${el.local} "${gmlId}"`;
    try {
      switch (el.local) {
        case 'RectangleGate': {
          const dimEls = children(el, 'dimension');
          const dims = dimEls.map((d) => parseDimension(d, where));
          const bounds = dimEls.map((d) => [numberAttr(d, 'min', GATING_NS, null), numberAttr(d, 'max', GATING_NS, null)]);
          if (bounds.some(([lo, hi]) => lo === null && hi === null)) warnings.push(`${where}: a dimension has neither min nor max (it was read as unbounded).`);
          const gate = base(idMap.get(gmlId), gmlId, info?.name, info, record, dims);
          if (dims.length === 1) {
            gate.type = 'range';
            gate.geometry = { min: bounds[0][0], max: bounds[0][1] };
            if (info?.type === 'split' && (bounds[0][0] === null) !== (bounds[0][1] === null)) {
              gate.type = 'split';
              gate.geometry = bounds[0][0] === null ? { threshold: bounds[0][1], side: 'lo' } : { threshold: bounds[0][0], side: 'hi' };
            }
          } else if (dims.length === 2) {
            gate.type = 'rectangle';
            gate.geometry = { min: [bounds[0][0], bounds[1][0]], max: [bounds[0][1], bounds[1][1]] };
          } else {
            gate.type = 'rectangle';
            gate.geometry = { min: bounds.map((b) => b[0]), max: bounds.map((b) => b[1]) };
          }
          gates.push(gate);
          break;
        }
        case 'PolygonGate': {
          const dims = children(el, 'dimension').map((d) => parseDimension(d, where));
          if (dims.length !== 2) throw new SkipGate(`${where} has ${dims.length} dimensions; polygon gates need 2`);
          const vertices = children(el, 'vertex').map((v) => children(v, 'coordinate').map(coordinateValue));
          if (vertices.length < 3) throw new SkipGate(`${where} has fewer than 3 vertices`);
          if (vertices.some((v) => v.length !== 2 || !v.every(Number.isFinite))) throw new SkipGate(`${where} has a vertex without two numeric coordinates`);
          const gate = base(idMap.get(gmlId), gmlId, info?.name, info, record, dims);
          gate.type = 'polygon';
          gate.geometry = { vertices };
          gates.push(gate);
          break;
        }
        case 'EllipsoidGate': {
          const dims = children(el, 'dimension').map((d) => parseDimension(d, where));
          const mean = children(child(el, 'mean'), 'coordinate').map(coordinateValue);
          const covariance = children(child(el, 'covarianceMatrix'), 'row').map((row) => children(row, 'entry').map(coordinateValue));
          const d2 = coordinateValue(child(el, 'distanceSquare') ?? { attrs: {}, children: [], text: '' });
          const n = dims.length;
          if (mean.length !== n || covariance.length !== n || covariance.some((r) => r.length !== n) || ![...mean, ...covariance.flat(), d2].every(Number.isFinite)) {
            throw new SkipGate(`${where} lacks a complete mean, covariance matrix or distanceSquare`);
          }
          const gate = base(idMap.get(gmlId), gmlId, info?.name, info, record, dims);
          if (n === 2) {
            const ellipse = ellipseFromCovariance(mean, covariance, d2);
            if (!ellipse) throw new SkipGate(`${where} has a covariance matrix that is not positive definite`);
            gate.type = 'ellipse';
            gate.geometry = ellipse;
          } else if (n === 1) {
            const half = Math.sqrt(d2 * covariance[0][0]);
            if (!(half > 0)) throw new SkipGate(`${where} has a non-positive variance`);
            gate.type = 'range';
            gate.geometry = { min: mean[0] - half, max: mean[0] + half };
            warnings.push(`${where} is one-dimensional and was imported as a range; an event exactly on its upper end is now outside.`);
          } else {
            gate.type = 'ellipsoid';
            gate.geometry = { mean, covariance, distanceSquare: d2 };
          }
          gates.push(gate);
          break;
        }
        case 'QuadrantGate':
          gates.push(...importQuadrantGate(record, where));
          break;
        case 'BooleanGate':
          gates.push(...importBooleanGate(record, where));
          break;
        default:
          break;
      }
    } catch (error) {
      if (!(error instanceof SkipGate)) throw error;
      const ids = record.quadrants ? record.quadrants.map((q) => idMap.get(q.gmlId)) : [idMap.get(gmlId)];
      for (const id of ids) skipped.set(id, record.gmlId);
      warnings.push(`${error.message}; the gate was skipped.`);
    }
  }

  function importQuadrantGate(record, where) {
    const { el, gmlId, info } = record;
    const dividers = children(el, 'divider').map((d) => ({
      id: attr(d, 'id', GATING_NS),
      dim: parseDimension(d, where),
      values: children(d, 'value').map((v) => Number(textContent(v).trim())).sort((a, b) => a - b),
    }));
    if (!dividers.length) throw new SkipGate(`${where} has no dividers`);
    if (dividers.some((d) => !d.values.length || !d.values.every(Number.isFinite))) throw new SkipGate(`${where} has a divider without numeric values`);
    const single = dividers.every((d) => d.values.length === 1);
    const quadLink = newId('q');
    const splitLinks = dividers.map(() => newId('s'));
    const out = [];
    for (const q of record.quadrants) {
      const qinfo = { ...(info?.quadrants?.[q.gmlId] ?? {}), compensation: info?.compensation };
      const intervals = dividers.map(() => null);
      for (const position of children(q.el, 'position')) {
        const ref = attr(position, 'divider_ref', GATING_NS);
        const location = numberAttr(position, 'location', GATING_NS);
        const k = dividers.findIndex((d) => d.id === ref);
        if (k < 0 || location === undefined) {
          warnings.push(`${where}: Quadrant "${q.gmlId}" has a position for an unknown divider "${ref}" (ignored).`);
          continue;
        }
        // Interval index: the number of divider values at or below the location.
        intervals[k] = dividers[k].values.filter((v) => v <= location).length;
      }
      const used = dividers.map((d, k) => k).filter((k) => intervals[k] !== null);
      const qrecord = { ...record, parentGmlId: record.parentGmlId };
      const make = (dims) => base(idMap.get(q.gmlId), q.gmlId, qinfo.name, qinfo, qrecord, dims);
      let gate;
      if (single && dividers.length <= 2 && used.length === 2) {
        gate = make(dividers.map((d) => d.dim));
        const right = intervals[0] === 1;
        const up = intervals[1] === 1;
        gate.type = 'quadrant';
        gate.geometry = { center: [dividers[0].values[0], dividers[1].values[0]], quadrant: `${up ? 'U' : 'L'}${right ? 'R' : 'L'}` };
        gate.linkId = quadLink;
      } else if (single && used.length === 1) {
        const k = used[0];
        gate = make([dividers[k].dim]);
        gate.type = 'split';
        gate.geometry = { threshold: dividers[k].values[0], side: intervals[k] === 1 ? 'hi' : 'lo' };
        gate.linkId = splitLinks[k];
      } else if (used.length === 0) {
        gate = make(dividers.map((d) => d.dim));
        if (dividers.length === 1) {
          gate.type = 'range';
          gate.geometry = { min: null, max: null };
        } else {
          gate.type = 'rectangle';
          gate.geometry = { min: dividers.map(() => null), max: dividers.map(() => null) };
        }
        warnings.push(`${where}: Quadrant "${q.gmlId}" has no positions and covers every event.`);
      } else {
        // Dividers with several values: each quadrant is a box of half-open intervals.
        const bounds = used.map((k) => {
          const values = dividers[k].values;
          const i = intervals[k];
          return [i > 0 ? values[i - 1] : null, i < values.length ? values[i] : null];
        });
        gate = make(used.map((k) => dividers[k].dim));
        if (used.length === 1) {
          gate.type = 'range';
          gate.geometry = { min: bounds[0][0], max: bounds[0][1] };
        } else {
          gate.type = 'rectangle';
          gate.geometry = { min: bounds.map((b) => b[0]), max: bounds.map((b) => b[1]) };
        }
      }
      gate.meta.gatingMLQuadrantGate = gmlId;
      out.push(gate);
    }
    if (!out.length) throw new SkipGate(`${where} has no Quadrant elements`);
    return out;
  }

  function importBooleanGate(record, where) {
    const { el, gmlId, info } = record;
    const opEl = el.children.find((c) => ['and', 'or', 'not'].includes(c.local));
    if (!opEl) throw new SkipGate(`${where} has no and, or or not element`);
    const refs = children(opEl, 'gateReference').map((r) => ({
      ref: attr(r, 'ref', GATING_NS),
      complement: String(attr(r, 'use-as-complement', GATING_NS) ?? 'false').toLowerCase() === 'true',
    }));
    if (!refs.length) throw new SkipGate(`${where} references no gates`);
    if (opEl.local === 'not' && refs.length !== 1) throw new SkipGate(`${where}: "not" takes exactly one gate reference`);
    if (opEl.local !== 'not' && refs.length < 2) warnings.push(`${where}: "${opEl.local}" with a single operand was imported as written.`);
    const unknown = refs.find(({ ref }) => !idMap.has(ref));
    if (unknown) throw new SkipGate(`${where} references the unknown gate "${unknown.ref}"`);
    const out = [];
    const operands = refs.map(({ ref, complement }) => {
      const id = idMap.get(ref);
      if (!complement) return id;
      // use-as-complement: every event outside the referenced gate's population. A hidden root
      // "not" gate expresses it, as CytoWeave's not = parent − operand.
      let helper = helpers.get(id);
      if (!helper) {
        helper = {
          id: newId('g'),
          name: `NOT ${ref}`,
          parentId: null,
          type: 'boolean',
          dims: [],
          geometry: { op: 'not', operands: [id] },
          scope: null,
          overrides: {},
          meta: { origin: 'imported', source: 'gating-ml', helper: true, complementOf: ref, note: `Complement of "${ref}" (Gating-ML use-as-complement)` },
        };
        helpers.set(id, helper);
        out.push(helper);
      }
      return helper.id;
    });
    const gate = base(idMap.get(gmlId), gmlId, info?.name, info, record, []);
    gate.type = 'boolean';
    gate.geometry = { op: opEl.local, operands };
    delete gate.meta.compensation;
    out.push(gate);
    return out;
  }

  if (missingCompensationRef) warnings.push('Some dimensions have no compensation-ref; they were read as uncompensated.');

  // Gates whose parent or operands were skipped cannot be evaluated.
  let changed = true;
  while (changed) {
    changed = false;
    for (const gate of gates) {
      if (skipped.has(gate.id)) continue;
      const deps = [gate.parentId, ...(gate.type === 'boolean' ? gate.geometry.operands : [])].filter(Boolean);
      const missing = deps.find((d) => skipped.has(d));
      if (missing) {
        skipped.set(gate.id, gate.meta.gatingMLId ?? gate.name);
        if (!gate.meta.helper) warnings.push(`Gate "${gate.meta.gatingMLId}" depends on the skipped gate "${skipped.get(missing)}" and was skipped too.`);
        changed = true;
      }
    }
  }
  const kept = gates.filter((g) => !skipped.has(g.id));
  return { gates: orderGates(kept, warnings), compensations, transforms, derived, warnings };
}

// Parents (and boolean operands) before the gates that depend on them; cycles are reported.
function orderGates(gates, warnings) {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const state = new Map();
  const out = [];
  const visit = (gate) => {
    const s = state.get(gate.id);
    if (s === 2) return;
    if (s === 1) {
      warnings.push(`Gate "${gate.meta?.gatingMLId ?? gate.name}" is part of a reference cycle.`);
      return;
    }
    state.set(gate.id, 1);
    const deps = [gate.parentId, ...(gate.type === 'boolean' ? gate.geometry.operands : [])];
    for (const dep of deps) if (dep && byId.has(dep)) visit(byId.get(dep));
    state.set(gate.id, 2);
    out.push(gate);
  };
  for (const gate of gates) visit(gate);
  return out;
}

// --- Export ---------------------------------------------------------------------------------

function formatNumber(value) {
  if (!Number.isFinite(value)) throw new SkipGate(`the non-finite number ${value} cannot be written to Gating-ML`);
  return String(value === 0 ? 0 : value);
}

// Writes a workspace's gates, their transformations and the workspace's compensation matrices as
// a Gating-ML 2.0 document. Returns { xml, warnings }.
// options: { gateIds (subset; ancestors and boolean operands are added), sampleId (use that
// sample's gate overrides and compensation), compensationRef ('FCS' | 'uncompensated' | a
// compensation id), customInfo (default true: CytoWeave names, colors and specs), pretty }.
export function exportGatingML(workspace, options = {}) {
  const warnings = [];
  const allGates = workspace.gates ?? [];
  const byId = new Map(allGates.map((g) => [g.id, g]));
  const withInfo = options.customInfo ?? true;
  const sampleId = options.sampleId ?? null;

  // Which gates to write.
  let selected = allGates;
  if (options.gateIds) {
    const wanted = new Set();
    const add = (id) => {
      const gate = byId.get(id);
      if (!gate || wanted.has(id)) return;
      wanted.add(id);
      if (gate.parentId) add(gate.parentId);
      if (gate.type === 'boolean') for (const op of gate.geometry?.operands ?? []) add(op);
    };
    for (const id of options.gateIds) add(id);
    selected = allGates.filter((g) => wanted.has(g.id));
  }
  const excluded = new Map();
  const exportable = new Set(['rectangle', 'range', 'polygon', 'ellipse', 'ellipsoid', 'quadrant', 'split', 'boolean']);
  for (const gate of selected) {
    if (gate.type === 'category') excluded.set(gate.id, 'category gates (on cluster or QC labels) cannot be expressed in Gating-ML');
    else if (!exportable.has(gate.type)) excluded.set(gate.id, `the gate type "${gate.type}" cannot be expressed in Gating-ML`);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const gate of selected) {
      if (excluded.has(gate.id)) continue;
      let reason = null;
      if (gate.parentId && !byId.has(gate.parentId)) reason = 'its parent gate does not exist';
      else if (gate.parentId && excluded.has(gate.parentId)) reason = `its parent "${byId.get(gate.parentId).name}" was not exported`;
      else if (gate.type === 'boolean') {
        const bad = (gate.geometry?.operands ?? []).find((id) => !byId.has(id) || excluded.has(id));
        if (bad) reason = byId.has(bad) ? `its operand "${byId.get(bad).name}" was not exported` : 'an operand gate does not exist';
      }
      if (reason) {
        excluded.set(gate.id, reason);
        changed = true;
      }
    }
  }
  for (const [id, reason] of excluded) warnings.push(`Gate "${byId.get(id).name}" was not exported: ${reason}.`);
  const gates = orderGates(selected.filter((g) => !excluded.has(g.id)), []);

  // Identifiers (xs:ID values share one space in the document).
  const used = new Set();
  const claim = (wish) => {
    const stem = sanitizeId(wish);
    let id = stem;
    for (let k = 2; used.has(id); k += 1) id = `${stem}_${k}`;
    used.add(id);
    return id;
  };

  // Compensation matrices.
  const compensations = workspace.compensations ?? [];
  const matrixIds = new Map();
  const matrixElements = [];
  for (const comp of compensations) {
    const n = comp.channels?.length ?? 0;
    if (!n || comp.matrix?.length !== n * n || !Array.from(comp.matrix).every((v) => Number.isFinite(Number(v)))) {
      warnings.push(`Compensation "${comp.name ?? comp.id}" is malformed and was not exported.`);
      continue;
    }
    const id = claim(comp.id ?? comp.name);
    matrixIds.set(comp.id, id);
    const names = (tag) => element(tag, {}, comp.channels.map((c) => element('data-type:fcs-dimension', { 'data-type:name': c })));
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      const coefficients = [];
      for (let j = 0; j < n; j += 1) coefficients.push(element('transforms:coefficient', { 'transforms:value': formatNumber(Number(comp.matrix[i * n + j])) }));
      rows.push(element('transforms:spectrum', {}, coefficients));
    }
    const info = withInfo && comp.name ? element('data-type:custom_info', {}, [element('cytoweave:info', { name: comp.name, source: comp.source })]) : null;
    matrixElements.push(element('transforms:spectrumMatrix', { 'transforms:id': id, 'transforms:matrix-inverted-already': 'false' }, [
      info, names('transforms:fluorochromes'), names('transforms:detectors'), ...rows,
    ]));
  }

  // Which compensation the gates' dimensions refer to.
  const samples = (workspace.samples ?? []).filter((s) => !sampleId || s.id === sampleId);
  let compRef = options.compensationRef ?? null;
  let compensatedChannels = new Set();
  const compById = (id) => compensations.find((c) => c.id === id);
  if (!compRef) {
    const ids = [...new Set(samples.map((s) => s.compensationId ?? 'none'))];
    const usedComps = ids.filter((id) => id !== 'none').map(compById).filter(Boolean);
    if (!usedComps.length) compRef = 'uncompensated';
    else if (usedComps.every((c) => c.source === 'file')) compRef = 'FCS';
    else if (usedComps.length === 1 && ids.length === 1) compRef = usedComps[0].id;
    else {
      const chosen = usedComps.find((c) => c.source !== 'file') ?? usedComps[0];
      compRef = chosen.id;
      warnings.push(`The samples use different compensations; the exported gates refer to "${chosen.name ?? chosen.id}". Export per sample (options.sampleId) to keep each sample's compensation.`);
    }
    if (ids.includes('none') && usedComps.length) warnings.push('Some samples are uncompensated while others are compensated; the exported gates refer to compensated data.');
  }
  let compRefId = compRef;
  if (compRef === 'FCS') {
    const fileComps = compensations.filter((c) => c.source === 'file');
    for (const c of fileComps.length ? fileComps : compensations) for (const ch of c.channels) compensatedChannels.add(ch);
    if (!compensatedChannels.size) {
      for (const s of samples) for (const ch of s.channels ?? []) if (ch.type === 'fluorescence') compensatedChannels.add(ch.name);
    }
    if (!compensatedChannels.size) compensatedChannels = null; // unknown: every non-scatter, non-time channel
  } else if (compRef !== 'uncompensated') {
    const comp = compById(compRef);
    if (!comp || !matrixIds.has(comp.id)) {
      warnings.push(`The compensation "${compRef}" is not in the workspace; the gates were written as uncompensated.`);
      compRef = 'uncompensated';
    } else {
      compRefId = matrixIds.get(comp.id);
      compensatedChannels = new Set(comp.channels);
    }
  }
  const derivedRecords = workspace.derived ?? [];
  const derivedOf = (channel) => derivedRecords.find((d) => (d.outputs ?? []).includes(channel));
  // Unmixing (non-square spectrum) matrices of the gates' unmixed channels: written inverted, a
  // row of fluorochrome coefficients per detector.
  const unmixIds = new Map();
  const unmixFor = (record) => {
    let id = unmixIds.get(record.id);
    if (!id) {
      id = claim(record.name ?? record.id);
      unmixIds.set(record.id, id);
      const f = record.outputs.length;
      const names = (tag, list) => element(tag, {}, list.map((c) => element('data-type:fcs-dimension', { 'data-type:name': c })));
      matrixElements.push(element('transforms:spectrumMatrix', { 'transforms:id': id, 'transforms:matrix-inverted-already': 'true' }, [
        names('transforms:fluorochromes', record.outputs), names('transforms:detectors', record.inputs),
        ...record.inputs.map((_, i) => element('transforms:spectrum', {}, record.outputs.map((__, j) => element('transforms:coefficient', { 'transforms:value': formatNumber(Number(record.params.matrix[i * f + j])) })))),
      ]));
    }
    return id;
  };
  const pinnedWarned = new Set();
  const compensationFor = (channel, pinned) => {
    const d = derivedOf(channel);
    if (d?.kind === 'unmix') return unmixFor(d);
    // A dimension that names its own compensation (see engine.js) keeps it.
    if (pinned === 'uncompensated') return 'uncompensated';
    if (pinned === 'file') return 'FCS';
    if (pinned !== undefined && pinned !== null) {
      if (matrixIds.has(pinned)) return matrixIds.get(pinned);
      if (!pinnedWarned.has(pinned)) {
        pinnedWarned.add(pinned);
        warnings.push(`A gate names the compensation "${pinned}", which is not in the workspace; its dimensions were written with the samples' compensation.`);
      }
    }
    if (compRef === 'uncompensated') return 'uncompensated';
    const source = d?.kind === 'ratio' ? d.inputs?.[0] : channel;
    if (compensatedChannels === null) return /^(FSC|SSC|Time|Event)/i.test(source ?? '') ? 'uncompensated' : compRefId;
    return compensatedChannels.has(source) ? compRefId : 'uncompensated';
  };

  // Transformations, deduplicated by the CytoWeave spec they came from.
  const transformElements = [];
  const transformIds = new Map();
  const ratioIds = new Map();
  const derivedWarned = new Set();
  const convertedWarned = new Set();
  const transformPlan = (spec) => {
    let plan = transformToGatingML(spec);
    const bounded = Number.isFinite(spec?.boundMin) || Number.isFinite(spec?.boundMax);
    // A bounded identity scale needs a transformation to carry its bounds: flin with T = 1, A = 0.
    if (plan.identity && bounded) plan = { local: 'flin', params: { T: 1, A: 0 } };
    if (plan.error || plan.identity || plan.raw) return plan;
    const key = createTransform(spec).key;
    let id = transformIds.get(key);
    if (!id) {
      const pretty = { flin: 'Linear', flog: 'Log', fasinh: 'Asinh', logicle: 'Logicle', hyperlog: 'Hyperlog' }[plan.local];
      id = claim(`${pretty}_${transformIds.size + 1}`);
      transformIds.set(key, id);
      const params = {};
      for (const [name, value] of Object.entries(plan.params)) params[`transforms:${name}`] = formatNumber(value);
      const info = withInfo ? element('data-type:custom_info', {}, [element('cytoweave:info', { spec: JSON.stringify(spec) })]) : null;
      const attrs = { 'transforms:id': id };
      for (const name of ['boundMin', 'boundMax']) if (Number.isFinite(spec?.[name])) attrs[`transforms:${name}`] = formatNumber(spec[name]);
      transformElements.push(element('transforms:transformation', attrs, [info, element(`transforms:${plan.local}`, params)]));
    }
    return { ...plan, id };
  };
  const ratioFor = (channel) => {
    const d = derivedOf(channel);
    if (!d || d.kind === 'unmix') return null;
    if (d.kind !== 'ratio' || d.inputs?.length !== 2) {
      if (!derivedWarned.has(channel)) {
        derivedWarned.add(channel);
        warnings.push(`The channel "${channel}" is derived (${d.kind}); Gating-ML readers need it present in the FCS data under that name.`);
      }
      return null;
    }
    let id = ratioIds.get(d.id);
    if (!id) {
      id = claim(`Ratio_${channel}`);
      ratioIds.set(d.id, id);
      const { A = 1, B = 0, C = 0 } = d.params ?? {};
      const info = withInfo ? element('data-type:custom_info', {}, [element('cytoweave:info', { channel })]) : null;
      transformElements.push(element('transforms:transformation', { 'transforms:id': id }, [info, element('transforms:fratio', { 'transforms:A': formatNumber(A), 'transforms:B': formatNumber(B), 'transforms:C': formatNumber(C) }, [
        element('data-type:fcs-dimension', { 'data-type:name': d.inputs[0] }),
        element('data-type:fcs-dimension', { 'data-type:name': d.inputs[1] }),
      ])]));
    }
    return id;
  };

  // Each dimension's writer: the dimension element and the map from gate (scale) coordinates to
  // the coordinates written.
  const dimensionPlan = (dim, gateName) => {
    const plan = transformPlan(dim.transform);
    if (plan.error) throw new SkipGate(`Gate "${gateName}": ${plan.error}`);
    const attrs = { 'gating:compensation-ref': compensationFor(dim.channel, dim.compensation) };
    if (plan.id) attrs['gating:transformation-ref'] = plan.id;
    const ratio = ratioFor(dim.channel);
    const inner = ratio
      ? element('gating:new-dimension', { 'gating:transformation-ref': ratio })
      : element('data-type:fcs-dimension', { 'data-type:name': dim.channel });
    let map = (v) => v;
    let slopeAt = () => 1;
    if (plan.raw) {
      const t = createTransform(dim.transform);
      map = (v) => t.inverse(v);
      const scale = t.inverse(1) - t.inverse(0);
      slopeAt = () => scale;
    } else if (plan.convert) {
      const from = createTransform(dim.transform);
      const to = createTransform({ type: 'logicle', ...plan.params });
      map = (v) => to.forward(from.inverse(v));
      slopeAt = (v) => (map(v + 1e-4) - map(v - 1e-4)) / 2e-4;
      if (!convertedWarned.has(plan.id)) {
        convertedWarned.add(plan.id);
        warnings.push(`${createTransform(dim.transform).label} (FlowJo) has no Gating-ML equivalent; it was written as the closest logicle (W ${formatNumber(plan.params.W)}) with gate coordinates converted to it: exact for rectangle, range and quadrant boundaries, approximate along polygon edges and ellipse outlines.`);
      }
    }
    return { attrs, inner, map, slopeAt, linearRaw: plan.raw };
  };
  const dimensionElement = (plan, extra = {}) => element('gating:dimension', { ...plan.attrs, ...extra }, [plan.inner]);
  const coordinate = (value) => element('gating:coordinate', { 'data-type:value': formatNumber(value) });
  // Open (null or infinite) bounds are left out, which Gating-ML reads as unbounded.
  const mapBound = (plan, value) => {
    if (value === null || value === undefined) return undefined;
    const mapped = plan.map(value);
    return Number.isFinite(mapped) ? formatNumber(mapped) : undefined;
  };

  const gateIds = new Map();
  // Quadrant and split gates write as QuadrantGates; group linked gates that share a parent,
  // dimensions and divider position.
  const groups = new Map();
  for (const gate of gates) {
    if (gate.type !== 'quadrant' && gate.type !== 'split') continue;
    const geometry = (sampleId && gate.overrides?.[sampleId]) || gate.geometry;
    const where = gate.type === 'quadrant' ? geometry.center : [geometry.threshold];
    const dims = gate.dims.map((d) => `${d.channel}|${createTransform(d.transform).key}`).join(';');
    const key = `${gate.type}|${gate.linkId ?? gate.id}|${gate.parentId ?? ''}|${dims}|${where.join(',')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(gate);
  }
  for (const gate of gates) gateIds.set(gate.id, claim(gate.id));
  const groupIds = new Map();
  for (const [key, members] of groups) groupIds.set(key, claim(`${members[0].type === 'quadrant' ? 'Quadrants' : 'Split'}_${members[0].linkId ?? members[0].id}`));

  const infoElement = (attrs, kids = []) => (withInfo ? element('data-type:custom_info', {}, [element('cytoweave:info', attrs, kids)]) : null);
  // compensation="sample": the gate follows each sample's compensation in CytoWeave, so a
  // re-import leaves its dimensions unpinned.
  // A confirmed Cell Ontology term travels as "CL:0000624 CD4-positive, alpha-beta T cell".
  const gateInfo = (gate) => ({ name: gate.name, type: gate.type, color: gate.color, compensation: gate.dims?.length && gate.dims.every((d) => d.compensation === undefined || d.compensation === null) ? 'sample' : undefined, ontology: gate.ontology?.status === 'confirmed' ? `${gate.ontology.id} ${gate.ontology.label}` : undefined });
  const gateAttrs = (gate, id) => {
    const attrs = { 'gating:id': id };
    if (gate.parentId) attrs['gating:parent_id'] = gateIds.get(gate.parentId);
    return attrs;
  };
  const gateElements = [];
  const writtenGroups = new Set();
  for (const gate of gates) {
    const id = gateIds.get(gate.id);
    const geometry = (sampleId && gate.overrides?.[sampleId]) || gate.geometry;
    if (!sampleId && gate.overrides && Object.keys(gate.overrides).length) {
      warnings.push(`Gate "${gate.name}" has sample-specific adjustments; Gating-ML holds one geometry per gate, so its shared geometry was written (export per sample with options.sampleId to keep them).`);
    }
    try {
      switch (gate.type) {
        case 'polygon': {
          const plans = gate.dims.map((d) => dimensionPlan(d, gate.name));
          gateElements.push(element('gating:PolygonGate', gateAttrs(gate, id), [
            infoElement(gateInfo(gate)),
            ...plans.map((p) => dimensionElement(p)),
            ...geometry.vertices.map(([x, y]) => element('gating:vertex', {}, [coordinate(plans[0].map(x)), coordinate(plans[1].map(y))])),
          ]));
          break;
        }
        case 'rectangle': {
          const plans = gate.dims.map((d) => dimensionPlan(d, gate.name));
          const dimEls = plans.map((p, k) => dimensionElement(p, { 'gating:min': mapBound(p, geometry.min?.[k]), 'gating:max': mapBound(p, geometry.max?.[k]) }));
          gateElements.push(element('gating:RectangleGate', gateAttrs(gate, id), [infoElement(gateInfo(gate)), ...dimEls]));
          break;
        }
        case 'range': {
          const plan = dimensionPlan(gate.dims[0], gate.name);
          gateElements.push(element('gating:RectangleGate', gateAttrs(gate, id), [
            infoElement(gateInfo(gate)),
            dimensionElement(plan, { 'gating:min': mapBound(plan, geometry.min), 'gating:max': mapBound(plan, geometry.max) }),
          ]));
          break;
        }
        case 'ellipse': {
          const plans = gate.dims.map((d) => dimensionPlan(d, gate.name));
          const covariance = covarianceFromEllipse(geometry);
          // Data-space and converted dimensions scale the covariance by the local axis slopes.
          const slopes = plans.map((p, k) => p.slopeAt(geometry.center[k]));
          for (let i = 0; i < 2; i += 1) for (let j = 0; j < 2; j += 1) covariance[i][j] *= slopes[i] * slopes[j];
          gateElements.push(element('gating:EllipsoidGate', gateAttrs(gate, id), [
            infoElement(gateInfo(gate)),
            ...plans.map((p) => dimensionElement(p)),
            element('gating:mean', {}, [coordinate(plans[0].map(geometry.center[0])), coordinate(plans[1].map(geometry.center[1]))]),
            element('gating:covarianceMatrix', {}, covariance.map((row) => element('gating:row', {}, row.map((v) => element('gating:entry', { 'data-type:value': formatNumber(v) }))))),
            element('gating:distanceSquare', { 'data-type:value': '1' }),
          ]));
          break;
        }
        case 'ellipsoid': {
          const plans = gate.dims.map((d) => dimensionPlan(d, gate.name));
          const { mean, distanceSquare } = geometry;
          const slopes = plans.map((p, k) => p.slopeAt(mean[k]));
          const covariance = geometry.covariance.map((row, i) => row.map((v, j) => v * slopes[i] * slopes[j]));
          gateElements.push(element('gating:EllipsoidGate', gateAttrs(gate, id), [
            infoElement(gateInfo(gate)),
            ...plans.map((p) => dimensionElement(p)),
            element('gating:mean', {}, mean.map((v, k) => coordinate(plans[k].map(v)))),
            element('gating:covarianceMatrix', {}, covariance.map((row) => element('gating:row', {}, row.map((v) => element('gating:entry', { 'data-type:value': formatNumber(v) }))))),
            element('gating:distanceSquare', { 'data-type:value': formatNumber(distanceSquare) }),
          ]));
          break;
        }
        case 'quadrant':
        case 'split': {
          const key = [...groups.keys()].find((k) => groups.get(k).includes(gate));
          if (writtenGroups.has(key)) break;
          writtenGroups.add(key);
          const members = groups.get(key);
          const groupId = groupIds.get(key);
          const plans = gate.dims.map((d) => dimensionPlan(d, gate.name));
          const values = gate.type === 'quadrant' ? geometry.center : [geometry.threshold];
          const dividerIds = plans.map((_, k) => claim(`${groupId}_${['x', 'y'][k]}`));
          const dividers = plans.map((p, k) => element('gating:divider', { 'gating:id': dividerIds[k], ...p.attrs }, [p.inner, element('gating:value', {}, [], formatNumber(p.map(values[k])))]));
          // A location inside the quadrant's interval, near the divider so it stays on-scale.
          const location = (k, hi) => {
            const v = plans[k].map(values[k]);
            if (hi) return formatNumber(v < 1 ? (v + 1) / 2 : 2 * v);
            return formatNumber(v > 0 ? v / 2 : v - 1);
          };
          const quadrantEls = members.map((member) => {
            const g = (sampleId && member.overrides?.[sampleId]) || member.geometry;
            const sides = member.type === 'quadrant' ? [g.quadrant[1] === 'R', g.quadrant[0] === 'U'] : [g.side === 'hi'];
            return element('gating:Quadrant', { 'gating:id': gateIds.get(member.id) }, sides.map((hi, k) => element('gating:position', { 'gating:divider_ref': dividerIds[k], 'gating:location': location(k, hi) })));
          });
          const attrs = { 'gating:id': groupId };
          if (gate.parentId) attrs['gating:parent_id'] = gateIds.get(gate.parentId);
          const info = withInfo ? element('data-type:custom_info', {}, [element('cytoweave:info', { type: gate.type, compensation: gateInfo(gate).compensation }, members.map((m) => element('cytoweave:quadrant', { id: gateIds.get(m.id), name: m.name, color: m.color, type: m.type, ontology: gateInfo(m).ontology })))]) : null;
          gateElements.push(element('gating:QuadrantGate', attrs, [info, ...dividers, ...quadrantEls]));
          break;
        }
        case 'boolean': {
          const op = geometry.op;
          let operands = (geometry.operands ?? []).map((o) => gateIds.get(o));
          if (!['and', 'or', 'not'].includes(op) || !operands.length) throw new SkipGate(`Gate "${gate.name}" has an invalid boolean definition`);
          if (op === 'not' && operands.length > 1) {
            // CytoWeave's not excludes the union of its operands; Gating-ML's takes one reference,
            // so the union is written as its own OR gate.
            const unionId = claim(`${id}_union`);
            gateElements.push(element('gating:BooleanGate', { 'gating:id': unionId }, [
              infoElement({ name: `${gate.name} (union of excluded gates)`, type: 'boolean' }),
              element('gating:or', {}, operands.map((ref) => element('gating:gateReference', { 'gating:ref': ref }))),
            ]));
            operands = [unionId];
          }
          // Gating-ML's and/or need two references; repeating the single operand is equivalent.
          if (op !== 'not' && operands.length === 1) operands = [operands[0], operands[0]];
          gateElements.push(element('gating:BooleanGate', gateAttrs(gate, id), [
            infoElement(gateInfo(gate)),
            element(`gating:${op}`, {}, operands.map((ref) => element('gating:gateReference', { 'gating:ref': ref }))),
          ]));
          break;
        }
        default:
          break;
      }
    } catch (error) {
      if (!(error instanceof SkipGate)) throw error;
      warnings.push(`${error.message}; the gate was not exported.`);
    }
  }

  const rootAttrs = {
    'xmlns:gating': GATING_NS,
    'xmlns:transforms': TRANSFORMS_NS,
    'xmlns:data-type': DATATYPE_NS,
  };
  if (withInfo) rootAttrs['xmlns:cytoweave'] = CYTOWEAVE_NS;
  const header = withInfo ? element('data-type:custom_info', {}, [element('cytoweave:info', {
    creator: 'CytoWeave',
    workspace: workspace.name,
    exported: options.now ?? new Date().toISOString(),
  })]) : null;
  const root = element('gating:Gating-ML', rootAttrs, [header, ...transformElements, ...matrixElements, ...gateElements]);
  return { xml: serializeXML(root, { pretty: options.pretty ?? true }), warnings };
}
