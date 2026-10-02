// Parses FCS files off the main thread and hashes them, returning columns as transferable buffers.

import { parseFCS } from '../lib/fcs.js';

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  try {
    if (type === 'parse') {
      const bytes = new Uint8Array(payload.buffer);
      const sha256 = payload.hash ? await sha256Hex(bytes) : null;
      const { version, datasets } = parseFCS(bytes, payload.options ?? {});
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
      self.postMessage({ id, result: { version, datasets: out, sha256 } }, transfer);
    } else if (type === 'hash') {
      self.postMessage({ id, result: await sha256Hex(new Uint8Array(payload.buffer)) });
    } else {
      throw new Error(`Unknown request ${type}`);
    }
  } catch (error) {
    self.postMessage({ id, error: error.message ?? String(error) });
  }
};
