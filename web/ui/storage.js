// The workspace library: workspaces and the FCS files they use, stored once each by SHA-256.
// With the CytoWeave program running, the library is a folder on disk (served at /api/library);
// served as a plain web site, it lives in the browser's origin-private file system (OPFS), with
// IndexedDB as a fallback for workspaces.

export async function detectBackend() {
  try {
    const response = await fetch('api/info', { cache: 'no-store' });
    if (!response.ok) return null;
    const info = await response.json();
    return info?.name === 'CytoWeave' ? info : null;
  } catch {
    return null;
  }
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

class BackendLibrary {
  constructor(info) {
    this.kind = 'desktop';
    this.info = info;
    this.location = info.dataDir;
  }

  async listWorkspaces() {
    const response = await fetch('api/library/workspaces', { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not list workspaces.');
    return (await response.json()).workspaces;
  }

  async loadWorkspace(id) {
    const response = await fetch(`api/library/workspaces/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('The workspace could not be opened.');
    return response.text();
  }

  async saveWorkspace(id, text) {
    const response = await fetch(`api/library/workspaces/${encodeURIComponent(id)}`, { method: 'PUT', body: text, headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? 'The workspace could not be saved.');
  }

  async deleteWorkspace(id) {
    await fetch(`api/library/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async hasFile(sha) {
    const response = await fetch(`api/library/has/${sha}`, { cache: 'no-store' });
    return response.ok && (await response.json()).exists === true;
  }

  async getFile(sha) {
    const response = await fetch(`api/library/files/${sha}`);
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  }

  async putFile(sha, bytes) {
    const response = await fetch(`api/library/files/${sha}`, { method: 'PUT', body: bytes });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? 'The file could not be stored.');
  }

  // Where the parse worker reads a stored file: by range requests, so it is never held whole.
  fileSource(sha, size) {
    return { kind: 'url', url: new URL(`api/library/files/${sha}`, location.href).href, size };
  }

  // Stores a file (a Blob or File, which the browser streams from disk, or bytes); the program
  // computes its SHA-256 while writing it. Returns { sha256, size }.
  async addFile(data) {
    const response = await fetch('api/library/files', { method: 'POST', body: data });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? 'The file could not be stored.');
    return body;
  }

  // Copies a file named on the command line (its URL, api/local/<index>) into the library, on
  // this computer. Returns { sha256, size }.
  async addLocalFile(url) {
    const index = /api\/local\/(\d+)/.exec(url)?.[1];
    if (index === undefined) throw new Error('Not a local file.');
    const response = await fetch(`api/library/local/${index}`, { method: 'POST' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? 'The file could not be stored.');
    return body;
  }
}

const DB_NAME = 'cytoweave';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('workspaces')) db.createObjectStore('workspaces');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idb(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = fn(store);
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

class BrowserLibrary {
  constructor() {
    this.kind = 'browser';
    this.location = 'this browser';
    this.dbPromise = openDB().catch(() => null);
    this.opfsPromise = navigator.storage?.getDirectory?.().catch(() => null) ?? Promise.resolve(null);
  }

  async listWorkspaces() {
    const db = await this.dbPromise;
    if (!db) return [];
    const all = await idb(db, 'workspaces', 'readonly', (store) => store.getAll());
    return (all ?? []).map(({ id, name, modified, samples, size }) => ({ id, name, modified, samples, size })).sort((a, b) => (a.modified < b.modified ? 1 : -1));
  }

  async loadWorkspace(id) {
    const db = await this.dbPromise;
    const record = db ? await idb(db, 'workspaces', 'readonly', (store) => store.get(id)) : null;
    if (!record) throw new Error('The workspace could not be opened.');
    return record.text;
  }

  async saveWorkspace(id, text) {
    const db = await this.dbPromise;
    if (!db) throw new Error('This browser does not allow saving (private window?).');
    let name = '';
    let modified = new Date().toISOString();
    let samples = 0;
    try {
      const doc = JSON.parse(text);
      name = doc.name;
      modified = doc.modified;
      samples = doc.samples?.length ?? 0;
    } catch { /* stored as given */ }
    await idb(db, 'workspaces', 'readwrite', (store) => store.put({ id, name, modified, samples, size: text.length, text }, id));
  }

  async deleteWorkspace(id) {
    const db = await this.dbPromise;
    if (db) await idb(db, 'workspaces', 'readwrite', (store) => store.delete(id));
  }

  async fileHandle(sha, create = false) {
    const root = await this.opfsPromise;
    if (!root) return null;
    try {
      const dir = await root.getDirectoryHandle('fcs', { create: true });
      return await dir.getFileHandle(`${sha}.fcs`, { create });
    } catch {
      return null;
    }
  }

  async hasFile(sha) {
    if (await this.fileHandle(sha)) return true;
    const db = await this.dbPromise;
    if (!db) return false;
    const key = await idb(db, 'files', 'readonly', (store) => store.getKey(sha));
    return key !== undefined;
  }

  async getFile(sha) {
    const handle = await this.fileHandle(sha);
    if (handle) {
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    }
    const db = await this.dbPromise;
    if (!db) return null;
    const blob = await idb(db, 'files', 'readonly', (store) => store.get(sha));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  // Stores bytes or a Blob (File) under its SHA-256.
  async putFile(sha, data) {
    const handle = await this.fileHandle(sha, true);
    if (handle?.createWritable) {
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      return;
    }
    const db = await this.dbPromise;
    if (!db) throw new Error('This browser does not allow storing files.');
    await idb(db, 'files', 'readwrite', (store) => store.put(data instanceof Blob ? data : new Blob([data]), sha));
  }

  // A stored file as a Blob for the parse worker to read in slices; null when not stored.
  async fileSource(sha) {
    const handle = await this.fileHandle(sha);
    if (handle) return { kind: 'blob', blob: await handle.getFile() };
    const db = await this.dbPromise;
    const blob = db ? await idb(db, 'files', 'readonly', (store) => store.get(sha)) : null;
    return blob ? { kind: 'blob', blob } : null;
  }
}

export function createLibrary(info) {
  if (info?.library) return new BackendLibrary(info);
  return new BrowserLibrary();
}

// Remembers small preferences (theme, layout) in localStorage, tolerating its absence.
export const prefs = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`cytoweave:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`cytoweave:${key}`, JSON.stringify(value));
    } catch { /* storage unavailable */ }
  },
};
