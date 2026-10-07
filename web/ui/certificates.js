// Reproducibility certificates in the window: the Report view's Certificate tab (make one, verify
// one) and the verification dialog that opens when a certificate is opened (lib/certificate.js).

import { h, icon, clear, downloadBlob, formatBytes } from './dom.js';
import { showDialog, toast, progressToast } from './overlays.js';
import { buildCertificate, formatCertified, readCertificate, shortFingerprint, verifyCertificate } from '../lib/certificate.js';
import { sha256 } from '../lib/sha256.js';
import { logEvent, verifyLog } from '../lib/workspace.js';

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const safeName = (name) => String(name || 'analysis').replace(/[^\w.-]+/g, '_');
const plural = (n, word, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;

// The files of the library and this session, by checksum.
export function certificateSource(app) {
  const read = async (sha) => app.data.session.get(sha) ?? await app.library.getFile(sha).catch(() => null);
  return { fcs: (sample) => (sample.sha256 ? read(sample.sha256) : null), derived: read };
}

async function gatingMLOf(ws) {
  try {
    const { exportGatingML } = await import('../lib/gatingml.js');
    const result = exportGatingML(ws);
    return typeof result === 'string' ? result : result.xml;
  } catch {
    return null;
  }
}

// Makes a certificate of the current workspace: { bytes, certificate, warnings, fileName }. The
// workspace's change log records it (with its fingerprint).
export async function makeCertificate(app, options = {}) {
  const ws = app.store.ws;
  const built = await buildCertificate(ws, certificateSource(app), {
    version: app.version,
    includeData: options.includeData !== false,
    gatingML: await gatingMLOf(ws),
    onProgress: async (fraction, text) => {
      options.onProgress?.(fraction, text);
      await pause();
    },
  });
  const out = { ...built, fileName: `${safeName(ws.name)}.certificate.acs` };
  // Whoever shows the result does so before the log entry re-renders the views.
  await options.onMade?.(out);
  const short = shortFingerprint(built.certificate.fingerprint);
  app.store.commit(logEvent(app.store.ws, 'certify', `certificate ${short}: ${plural(built.certificate.total, 'number')} of ${plural(built.certificate.inputs.length, 'file')}${options.includeData === false ? ' (files not included)' : ''}`), 'Make a certificate');
  return out;
}

// --- The Report view's tab -----------------------------------------------------------------------

export function certificatePane(app, state) {
  const ws = app.store.ws;
  const bytes = ws.samples.reduce((sum, s) => sum + (s.size ?? 0), 0);
  const made = (ws.provenance ?? []).filter((e) => e.action === 'certify').reverse();
  const include = h('input', { type: 'checkbox', checked: state.includeData !== false, onchange: (e) => { state.includeData = e.target.checked; } });
  const result = h('div');
  const create = async () => {
    const progress = progressToast('Computing every number from the files…');
    try {
      await makeCertificate(app, {
        includeData: include.checked,
        onProgress: (f, text) => progress.update(f, text),
        onMade: (out) => {
          downloadBlob(new Blob([out.bytes], { type: 'application/zip' }), out.fileName);
          progress.done(`Certificate ${shortFingerprint(out.certificate.fingerprint)}: ${plural(out.certificate.total, 'number')}.`);
          state.last = { certificate: out.certificate, warnings: out.warnings, size: out.bytes.length };
        },
      });
    } catch (error) {
      progress.fail(`The certificate could not be made: ${error.message}`);
    }
  };
  const showResult = () => {
    clear(result);
    if (!state.last) return;
    const { certificate, warnings, size } = state.last;
    result.append(h('div.callout.ok', { style: { marginTop: '12px', display: 'block' } },
      h('div', h('strong', `Certificate ${shortFingerprint(certificate.fingerprint)}`), ` · ${plural(certificate.total, 'number')} of ${plural(certificate.inputs.length, 'file')} · ${formatBytes(size)}`),
      h('div.mono', { style: { marginTop: '4px', wordBreak: 'break-all' } }, `SHA-256 ${certificate.fingerprint}`),
      certificate.notChecked.length ? h('div', { style: { marginTop: '6px' } }, `Not computed again: ${certificate.notChecked.map((n) => n.what).join('; ')}.`) : null),
    ...warnings.map((w) => h('div.callout.warn', { style: { marginTop: '6px' } }, icon('warning'), h('span', w))));
  };
  showResult();
  return h('div',
    h('div.pane',
      h('h3', 'Reproducibility certificate'),
      h('p.muted', { style: { marginTop: 0, maxWidth: '78ch' } },
        'A certificate packs this analysis with everything needed to compute its numbers again: the workspace, the FCS files, the channels it stored, the gates as Gating-ML and the methods. It records each file\'s SHA-256, the analyses with their seeds, the change log\'s chain, MIFlowCyt and every number reported: each population\'s count in each sample, every table cell and every saved comparison. Anyone with CytoWeave can verify it: every number is computed again from the files and must be identical, bit for bit. Quote its fingerprint with the analysis.'),
      h('label.check', include, `Include the FCS files (${formatBytes(bytes)} for ${plural(ws.samples.length, 'sample')}); without them, the files are named by their checksums and supplied when verifying`),
      h('div.row', { style: { gap: '8px', marginTop: '10px' } },
        h('button.btn.primary', { type: 'button', onclick: create, disabled: !ws.samples.length }, icon('download'), 'Make a certificate'),
        h('button.btn', { type: 'button', onclick: () => pickCertificate(app) }, icon('upload'), 'Verify a certificate…')),
      result),
    made.length ? h('div.pane',
      h('h3', 'Certificates of this analysis'),
      h('table.data', h('thead', h('tr', h('th', 'Made'), h('th', 'Certificate'))),
        h('tbody', ...made.slice(0, 50).map((e) => h('tr', h('td', { style: { whiteSpace: 'nowrap' } }, new Date(e.time).toLocaleString()), h('td', e.detail)))))) : null);
}

// The change log's chain, for the Change log tab.
export function logChainNote(ws) {
  const log = verifyLog(ws);
  if (log.ok) {
    const sealed = log.sealed ? ` The first ${plural(log.sealed.entries, 'entry', 'entries')}, written before the log was chained, were chained on ${new Date(log.sealed.time).toLocaleDateString()}.` : '';
    return h('div.callout.ok', { style: { marginBottom: '10px' } }, icon('check'), h('span', `Hash-chained: each entry's SHA-256 covers the one before it, so a change to an earlier entry is detected. Head ${log.head ? log.head.slice(0, 16) : '—'}.${sealed}`));
  }
  const unchained = log.broken.every((b) => b.reason === 'not chained');
  return h(`div.callout.${unchained ? 'accent' : 'danger'}`, { style: { marginBottom: '10px' } }, icon(unchained ? 'info' : 'warning'),
    h('span', unchained ? `${plural(log.broken.length, 'entry', 'entries')} predate the chained log; they are chained at the next change.` : `The chain is broken at ${plural(log.broken.length, 'entry', 'entries')} (first: ${log.broken[0].entry.action}, ${new Date(log.broken[0].entry.time).toLocaleString()}): the log was changed outside CytoWeave.`));
}

// --- Verifying -----------------------------------------------------------------------------------

function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => {
      resolve([...input.files]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

async function pickCertificate(app) {
  const [file] = await pickFiles('.acs,.zip', false);
  if (file) await showVerification(app, new Uint8Array(await file.arrayBuffer()), file.name);
}

const VERDICT = {
  confirmed: { kind: 'ok', label: 'Confirmed', icon: 'check' },
  incomplete: { kind: 'warn', label: 'Incomplete', icon: 'warning' },
  differs: { kind: 'danger', label: 'Not confirmed', icon: 'warning' },
};

// Verifies a certificate and shows what was found. options.open() opens the analysis it holds.
export async function showVerification(app, bytes, name, options = {}) {
  let read;
  try {
    read = await readCertificate(bytes);
  } catch (error) {
    toast(`${name}: ${error.message}`, { kind: 'error' });
    return;
  }
  const supplied = new Map();
  const body = h('div');
  let report = null;
  const verify = async () => {
    clear(body);
    const status = h('p.muted', 'Computing every number again from the files…');
    const bar = h('div', { style: { width: '0%' } });
    body.append(status, h('div.progress', bar));
    try {
      report = await verifyCertificate(read, {
        version: app.version,
        data: supplied,
        onProgress: async (fraction, text) => {
          bar.style.width = `${Math.round(fraction * 100)}%`;
          status.textContent = text;
          await pause();
        },
      });
    } catch (error) {
      clear(body);
      body.append(h('div.callout.danger', icon('warning'), h('span', `The certificate could not be verified: ${error.message}`)));
      return;
    }
    render();
  };
  const supply = async () => {
    const files = await pickFiles('.fcs,.lmd');
    for (const file of files) {
      const content = new Uint8Array(await file.arrayBuffer());
      supplied.set(sha256(content), content);
    }
    if (files.length) await verify();
  };
  const render = () => {
    clear(body);
    const { certificate } = read;
    const v = VERDICT[report.verdict];
    const missing = report.inputs.filter((i) => i.status === 'missing');
    const changed = report.inputs.filter((i) => i.status === 'changed');
    body.append(
      h(`div.callout.${v.kind}`, { style: { display: 'block' } }, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, icon(v.icon), h('strong', v.label)), h('p', { style: { margin: '6px 0 0' } }, report.summary)),
      h('dl.kv', { style: { marginTop: '12px' } },
        h('dt', 'Analysis'), h('dd', certificate.workspace.name),
        h('dt', 'Certified'), h('dd', `${new Date(certificate.created).toLocaleString()} with CytoWeave ${certificate.software.version}`),
        h('dt', 'Computed in'), h('dd', certificate.software.engine ?? '—'),
        h('dt', 'Verified with'), h('dd', `CytoWeave ${app.version}${report.version.same ? '' : ' (another version)'} in ${report.engine.verifier}`),
        h('dt', 'Fingerprint'), h('dd.mono', { title: certificate.fingerprint, style: { wordBreak: 'break-all' } }, certificate.fingerprint)),
      h('div.section-title', { style: { marginTop: '14px' } }, 'What was checked'),
      h('table.data', h('tbody',
        h('tr', h('td', 'certificate.json'), h('td', report.fingerprint.ok ? 'unchanged since it was written' : h('span', { style: { color: 'var(--danger-text)' } }, 'changed after it was written'))),
        h('tr', h('td', 'Workspace'), h('td', report.workspace.ok && report.inputsMatch ? 'unchanged' : h('span', { style: { color: 'var(--danger-text)' } }, 'changed'))),
        h('tr', h('td', 'FCS files'), h('td', `${report.inputs.length - missing.length - changed.length} of ${report.inputs.length} match their SHA-256${missing.length ? `; ${missing.length} missing` : ''}${changed.length ? `; ${changed.length} changed (${changed.slice(0, 3).map((i) => i.fileName).join(', ')})` : ''}`)),
        report.derived.length ? h('tr', h('td', 'Stored channels'), h('td', `${report.derived.filter((d) => d.status === 'ok').length} of ${report.derived.length} match their SHA-256`)) : null,
        h('tr', h('td', 'Change log'), h('td', report.log.ok ? `${plural(report.log.entries, 'entry', 'entries')}, chain intact` : h('span', { style: { color: 'var(--danger-text)' } }, report.log.broken.length ? `altered: first at entry ${report.log.broken[0].index + 1} (${report.log.broken[0].action}, ${new Date(report.log.broken[0].time).toLocaleString()})` : 'not the log certified'))),
        h('tr', h('td', 'Numbers'), h('td', `${report.numbers.same.toLocaleString('en-US')} identical${report.numbers.close ? `, ${report.numbers.close.toLocaleString('en-US')} equal to 12 significant digits` : ''} of ${report.numbers.checked.toLocaleString('en-US')}${report.numbers.differ.length ? `; ${report.numbers.differ.length.toLocaleString('en-US')} differ` : ''}${report.numbers.missing ? `; ${report.numbers.missing.toLocaleString('en-US')} not computed` : ''}`)))),
      report.numbers.differ.length ? h('div',
        h('div.section-title', { style: { marginTop: '14px' } }, 'Numbers that differ'),
        h('div', { style: { maxHeight: '220px', overflow: 'auto' } }, h('table.data', h('thead', h('tr', h('th', 'Number'), h('th.r', 'Certified'), h('th.r', 'Now'))),
          h('tbody', ...report.numbers.differ.slice(0, 200).map((d) => h('tr', h('td', d.label), h('td.r.mono', formatCertified(d.recorded)), h('td.r.mono', formatCertified(d.computed)))))))) : null,
      missing.length ? h('div.callout.warn', { style: { marginTop: '12px' } }, icon('warning'), h('span', `${plural(missing.length, 'file is', 'files are')} not in the certificate: ${missing.slice(0, 4).map((i) => i.fileName).join(', ')}${missing.length > 4 ? ` and ${missing.length - 4} more` : ''}. Supply them to verify every number; they are recognized by their checksums, whatever their names.`)) : null,
      report.notChecked.length ? h('div',
        h('div.section-title', { style: { marginTop: '14px' } }, 'Not computed again'),
        h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px', fontSize: '12px', color: 'var(--text-2)' } }, ...report.notChecked.map((n) => h('li', `${n.what}: ${n.reason}.`)))) : null,
      h('div.section-title', { style: { marginTop: '14px' } }, 'MIFlowCyt'),
      h('table.data', h('tbody', ...certificate.miflowcyt.map((m) => h('tr', h('td', h(`span.badge.${m.ok ? 'ok' : 'warn'}`, m.ok ? 'documented' : 'missing')), h('td', m.item), h('td.muted', m.value || '—'))))));
    actions.innerHTML = '';
    if (missing.length) actions.append(h('button.btn', { type: 'button', onclick: supply }, icon('upload'), 'Supply the FCS files…'));
    actions.append(h('button.btn', { type: 'button', onclick: () => downloadBlob(new Blob([`${JSON.stringify({ certificate: { fingerprint: certificate.fingerprint, created: certificate.created, version: certificate.software.version, analysis: certificate.workspace.name }, ...report }, null, 1)}\n`], { type: 'application/json' }), `${safeName(certificate.workspace.name)}.verification.json`) }, icon('download'), 'Report (JSON)'));
    if (options.open) actions.append(h('button.btn', { type: 'button', onclick: () => { dialog.close(); options.open(); } }, icon('library'), 'Open the analysis'));
  };
  const actions = h('div.row', { style: { gap: '8px', marginTop: '14px', flexWrap: 'wrap' } });
  const dialog = showDialog({ title: `Certificate: ${name}`, content: h('div', body, actions), width: 'wide' });
  await verify();
}
