// Event data management: importing files into the library, decoding samples on demand (in a
// worker), keeping recently used samples in memory within a budget, and keeping each loaded
// sample's compensation in step with the workspace.

import { readSpillover } from '../lib/fcs.js';
import { SampleView } from '../lib/engine.js';
import { sampleFromDataset } from '../lib/workspace.js';
import { WorkerClient } from './workers.js';

const DEFAULT_BUDGET = 1.6 * 1024 ** 3;

export class DataStore {
  constructor({ library, getWorkspace, onChange }) {
    this.library = library;
    this.getWorkspace = getWorkspace;
    this.onChange = onChange;
    this.views = new Map();
    this.loading = new Map();
    this.status = new Map();
    this.errors = new Map();
    this.lastUsed = new Map();
    this.session = new Map(); // sha256 → bytes kept for this session when the library refuses them
    this.localSources = new Map(); // sha256 → URL of a file the desktop program serves
    this.derived = new Map(); // sampleId → Map(name → { column, version })
    this.budget = DEFAULT_BUDGET;
    this.parser = new WorkerClient('../workers/fcs-worker.js', { max: Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 4) - 1)) });
    this.pinned = new Set();
  }

  statusOf(sampleId) {
    return this.status.get(sampleId) ?? 'idle';
  }

  view(sampleId) {
    const view = this.views.get(sampleId);
    if (view) {
      this.lastUsed.set(sampleId, performance.now());
      this.syncCompensation(view);
    }
    return view ?? null;
  }

  // Parses FCS bytes in a worker; returns { version, datasets, sha256 }.
  async parse(bytes, options = {}) {
    const copy = options.keep ? bytes.slice() : bytes;
    return this.parser.call('parse', { buffer: copy.buffer, hash: options.hash ?? true, options: options.parseOptions }, { transfer: [copy.buffer] });
  }

  // Imports FCS files: parses, stores in the library, and returns sample records (one per data
  // set). files: [{ name, bytes, size }]. onProgress(done, total, name).
  async importFCS(files, onProgress) {
    const records = [];
    const problems = [];
    let done = 0;
    const tasks = files.map(async (file) => {
      try {
        const keep = file.bytes.slice();
        const parsed = await this.parse(file.bytes, { hash: true });
        const sha256 = parsed.sha256;
        try {
          if (!(await this.library.hasFile(sha256))) await this.library.putFile(sha256, keep);
        } catch (error) {
          this.session.set(sha256, keep);
          problems.push(`${file.name}: kept for this session only (${error.message})`);
        }
        parsed.datasets.forEach((dataset, datasetIndex) => {
          const record = sampleFromDataset(dataset, { name: parsed.datasets.length > 1 ? `${file.name.replace(/\.(fcs|lmd)$/i, '')} [${datasetIndex + 1}].fcs` : file.name, sha256, size: file.size ?? keep.length, datasetIndex });
          records.push({ record, dataset, order: file.order ?? 0, datasetIndex });
        });
      } catch (error) {
        problems.push(`${file.name}: ${error.message}`);
      } finally {
        done += 1;
        onProgress?.(done, files.length, file.name);
      }
    });
    await Promise.all(tasks);
    records.sort((a, b) => a.order - b.order || a.datasetIndex - b.datasetIndex);
    for (const { record, dataset } of records) this.install(record, dataset);
    return { records: records.map((r) => r.record), problems };
  }

  install(record, dataset) {
    const view = new SampleView(record, dataset);
    this.views.set(record.id, view);
    this.status.set(record.id, 'loaded');
    this.lastUsed.set(record.id, performance.now());
    this.attachDerived(view);
    this.syncCompensation(view, record);
    this.evict();
  }

  // Loads a sample's events (from the library, the session or a desktop-served file).
  ensure(sampleId) {
    const existing = this.view(sampleId);
    if (existing) return Promise.resolve(existing);
    if (this.loading.has(sampleId)) return this.loading.get(sampleId);
    const ws = this.getWorkspace();
    const record = ws.samples.find((s) => s.id === sampleId);
    if (!record) return Promise.reject(new Error('Unknown sample.'));
    this.status.set(sampleId, 'loading');
    this.onChange?.(['data']);
    const promise = (async () => {
      let bytes = record.sha256 ? this.session.get(record.sha256) ?? null : null;
      if (!bytes && record.sha256) bytes = await this.library.getFile(record.sha256).catch(() => null);
      if (!bytes && record.sha256 && this.localSources.has(record.sha256)) {
        const response = await fetch(this.localSources.get(record.sha256));
        if (response.ok) bytes = new Uint8Array(await response.arrayBuffer());
      }
      if (!bytes) {
        this.status.set(sampleId, 'missing');
        throw new Error(`The data of "${record.name}" are not in the library. Add the file ${record.fileName} again to reconnect it.`);
      }
      const parsed = await this.parse(bytes, { hash: false });
      const dataset = parsed.datasets[record.datasetIndex ?? 0];
      if (!dataset) throw new Error(`"${record.fileName}" no longer has data set ${record.datasetIndex + 1}.`);
      const current = this.getWorkspace().samples.find((s) => s.id === sampleId) ?? record;
      this.install(current, dataset);
      return this.views.get(sampleId);
    })();
    this.loading.set(sampleId, promise);
    promise.then(() => {
      this.loading.delete(sampleId);
      this.errors.delete(sampleId);
      this.onChange?.(['data']);
    }, (error) => {
      this.loading.delete(sampleId);
      if (this.status.get(sampleId) !== 'missing') this.status.set(sampleId, 'error');
      this.errors.set(sampleId, error.message);
      this.onChange?.(['data']);
    });
    return promise;
  }

  // The compensation a sample should use, as { id, channels, matrix } or null.
  compensationFor(record, view) {
    const ws = this.getWorkspace();
    const id = record?.compensationId ?? 'none';
    if (id === 'none') return null;
    if (id === 'file') {
      const spill = view ? readSpillover(view.dataset.keywords, view.parameters) : null;
      return spill && !spill.identity ? { id: 'file', channels: spill.channels, matrix: Array.from(spill.matrix) } : null;
    }
    const comp = ws.compensations.find((c) => c.id === id);
    return comp ? { id: comp.id, channels: comp.channels, matrix: comp.matrix } : null;
  }

  syncCompensation(view, recordOverride) {
    const ws = this.getWorkspace();
    const record = recordOverride ?? ws.samples.find((s) => s.id === view.id);
    if (!record) return;
    view.record = record;
    const comp = this.compensationFor(record, view);
    try {
      view.setCompensation(comp);
      view.compensationError = null;
    } catch (error) {
      view.compensationError = error.message;
      view.setCompensation(null);
    }
  }

  syncAll() {
    for (const view of this.views.values()) this.syncCompensation(view);
  }

  // Derived per-event channels (clusters, embeddings, QC masks) by sample.
  setDerived(sampleId, name, column, version) {
    if (!this.derived.has(sampleId)) this.derived.set(sampleId, new Map());
    this.derived.get(sampleId).set(name, { column, version });
    const view = this.views.get(sampleId);
    if (view) view.setDerived(name, column, version);
  }

  removeDerived(name) {
    for (const [sampleId, map] of this.derived) {
      if (map.delete(name)) this.views.get(sampleId)?.removeDerived(name);
    }
  }

  attachDerived(view) {
    const map = this.derived.get(view.id);
    if (map) {
      for (const [name, { column, version }] of map) {
        if (column.length === view.eventCount) view.setDerived(name, column, version);
      }
    }
    this.restoreDerived(view);
  }

  // Stores a derived column in the library (content-addressed) and returns its reference,
  // { sha256, length }, which the workspace's derived record keeps per sample.
  async persistColumn(column) {
    const bytes = new Uint8Array(column.buffer.slice(column.byteOffset, column.byteOffset + column.byteLength));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    try {
      if (!(await this.library.hasFile(sha256))) await this.library.putFile(sha256, bytes);
    } catch {
      this.session.set(sha256, bytes);
    }
    return { sha256, length: column.length };
  }

  // Loads the derived columns a workspace records for this sample that are not yet attached.
  async restoreDerived(view) {
    const ws = this.getWorkspace();
    const tasks = [];
    for (const record of ws.derived ?? []) {
      const files = record.files?.[view.id];
      if (!files) continue;
      for (const [name, ref] of Object.entries(files)) {
        if (view.derived.has(name) || !ref?.sha256) continue;
        tasks.push((async () => {
          const bytes = this.session.get(ref.sha256) ?? await this.library.getFile(ref.sha256).catch(() => null);
          if (!bytes || bytes.byteLength !== ref.length * 4) return;
          const column = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          if (column.length !== view.eventCount) return;
          this.setDerived(view.id, name, column, ref.sha256.slice(0, 16));
        })());
      }
    }
    if (tasks.length) {
      await Promise.all(tasks);
      this.onChange?.(['data', 'derived']);
    }
  }

  totalBytes() {
    let total = 0;
    for (const view of this.views.values()) total += view.bytes;
    return total;
  }

  evict() {
    let total = this.totalBytes();
    if (total <= this.budget) return;
    const order = [...this.views.keys()].filter((id) => !this.pinned.has(id)).sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0));
    for (const id of order) {
      if (total <= this.budget * 0.8) break;
      total -= this.views.get(id).bytes;
      this.views.delete(id);
      this.status.set(id, 'idle');
    }
  }

  forget(sampleIds) {
    for (const id of sampleIds) {
      this.views.delete(id);
      this.status.delete(id);
      this.derived.delete(id);
    }
  }
}
