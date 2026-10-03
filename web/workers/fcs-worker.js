// Parses FCS files off the main thread, returning columns as transferable buffers. The file comes
// as bytes, a Blob or File (read in slices) or a URL of the CytoWeave program (read by range
// requests), so a large file is never held whole: only its columns and one part at a time.
// With `hash`, the file's SHA-256 is computed on the way.

import { blobSource, bytesSource, parseFCSAsync, urlSource } from '../lib/fcs.js';
import { SHA256 } from '../lib/sha256.js';
import { float32, transferable } from '../lib/memory.js';

async function sourceOf(payload) {
  const source = payload.source ?? { kind: 'bytes', buffer: payload.buffer };
  if (source.kind === 'bytes') return bytesSource(new Uint8Array(source.buffer));
  if (source.kind === 'blob') return blobSource(source.blob);
  if (source.kind === 'url') return urlSource(source.url, { size: source.size });
  throw new Error(`Unknown file source ${source.kind}.`);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  try {
    if (type === 'parse') {
      const source = await sourceOf(payload);
      // Bytes already in memory are hashed at once (faster); others as they are read.
      const hash = payload.hash && !source.bytes ? new SHA256() : null;
      let last = 0;
      const { version, datasets } = await parseFCSAsync(source, {
        ...(payload.options ?? {}),
        // Shared with the page (and its other workers) when the page is cross-origin isolated.
        allocate: float32,
        observe: hash ? (bytes) => hash.update(bytes) : undefined,
        onProgress: (fraction) => {
          const now = performance.now();
          if (now - last < 100) return;
          last = now;
          self.postMessage({ id, progress: [fraction, 'Reading events'] });
        },
      });
      const sha256 = payload.hash ? (hash ? hash.hex() : await sha256Hex(source.bytes)) : null;
      const transfer = [];
      const out = datasets.map((dataset) => {
        for (const column of dataset.data) transfer.push(column.buffer);
        return {
          version: dataset.version,
          keywords: dataset.keywords,
          parameters: dataset.parameters,
          eventCount: dataset.eventCount,
          data: dataset.data,
          diagnostics: dataset.diagnostics,
          crc: dataset.crc,
        };
      });
      self.postMessage({ id, result: { version, datasets: out, sha256 } }, transferable(transfer));
    } else if (type === 'hash') {
      // A file's SHA-256, reading it in parts unless it is already in memory.
      const source = await sourceOf(payload);
      if (source.bytes) {
        self.postMessage({ id, result: await sha256Hex(source.bytes) });
      } else {
        const hash = new SHA256();
        for (let at = 0; at < source.size;) {
          const part = await source.read(at, Math.min(source.size, at + 16 * 1024 * 1024));
          if (!part.length) throw new Error(`The file ended at byte ${at} while reading it.`);
          hash.update(part);
          at += part.length;
        }
        self.postMessage({ id, result: hash.hex() });
      }
    } else {
      throw new Error(`Unknown request ${type}`);
    }
  } catch (error) {
    self.postMessage({ id, error: error.message ?? String(error) });
  }
};
