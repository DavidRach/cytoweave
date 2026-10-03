// A promise-based client for module workers that speak the CytoWeave protocol:
// { id, type, payload } → { id, progress: [fraction, message] }* then { id, result } | { id, error }.

import { transferable } from '../lib/memory.js';

export class WorkerClient {
  constructor(url, options = {}) {
    this.url = url;
    this.max = options.max ?? 1;
    this.workers = [];
    this.pending = new Map();
    this.queue = [];
    this.nextId = 1;
  }

  spawn() {
    const worker = new Worker(new URL(this.url, import.meta.url), { type: 'module' });
    const slot = { worker, busy: false, jobId: null };
    worker.onmessage = (event) => this.receive(slot, event.data);
    worker.onerror = (event) => {
      const job = this.pending.get(slot.jobId);
      if (job) {
        this.pending.delete(slot.jobId);
        job.reject(new Error(event.message || 'The worker failed.'));
      }
      slot.busy = false;
      this.drain();
    };
    this.workers.push(slot);
    return slot;
  }

  receive(slot, message) {
    const job = this.pending.get(message.id);
    if (!job) return;
    if (message.progress) {
      job.onProgress?.(...message.progress);
      return;
    }
    this.pending.delete(message.id);
    slot.busy = false;
    slot.jobId = null;
    if (message.error) job.reject(new Error(message.error));
    else job.resolve(message.result);
    this.drain();
  }

  drain() {
    while (this.queue.length) {
      let slot = this.workers.find((w) => !w.busy);
      if (!slot && this.workers.length < this.max) slot = this.spawn();
      if (!slot) return;
      const job = this.queue.shift();
      if (job.cancelled) continue;
      slot.busy = true;
      slot.jobId = job.id;
      job.slot = slot;
      try {
        slot.worker.postMessage({ id: job.id, type: job.type, payload: job.payload }, transferable(job.transfer));
      } catch (error) {
        // The browser could not hand the data over (too large to copy, or not transferable).
        this.pending.delete(job.id);
        slot.busy = false;
        slot.jobId = null;
        job.reject(new Error(error.name === 'DataCloneError' ? `The data could not be passed to the worker: ${error.message}` : error.message));
      }
    }
  }

  // Runs a request; returns { promise, cancel }. Cancelling a running job terminates its worker.
  run(type, payload, options = {}) {
    const id = this.nextId++;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const job = { id, type, payload, transfer: options.transfer, onProgress: options.onProgress, resolve, reject, cancelled: false, slot: null };
    this.pending.set(id, job);
    this.queue.push(job);
    this.drain();
    const cancel = () => {
      if (!this.pending.has(id)) return;
      job.cancelled = true;
      this.pending.delete(id);
      if (job.slot) {
        job.slot.worker.terminate();
        this.workers = this.workers.filter((w) => w !== job.slot);
      }
      reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      this.drain();
    };
    return { promise, cancel };
  }

  call(type, payload, options) {
    return this.run(type, payload, options).promise;
  }
}
