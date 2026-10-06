import assert from 'node:assert/strict';
import test from 'node:test';

// The example worker (web/workers/simulate-worker.js) as the page uses it: a message in, a result posted back.
async function generateInWorker(payload) {
  const listeners = [];
  const posted = [];
  globalThis.self = {
    addEventListener: (type, fn) => listeners.push(fn),
    postMessage: (message) => posted.push(message),
  };
  await import(`../workers/simulate-worker.js?${Math.random()}`);
  await listeners[0]({ data: { id: 1, type: 'generateExample', payload } });
  delete globalThis.self;
  const reply = posted.find((m) => m.result || m.error);
  if (reply.error) throw new Error(reply.error);
  return reply.result;
}

test('every generation option reaches the example (an option the worker did not pass was lost)', async () => {
  // The PBMC example's clogs option: D05_Unstim has a clog unless the list leaves it out.
  const base = { samples: ['D05_Unstim.fcs'], scale: 0.05 };
  const clogged = await generateInWorker({ id: 'pbmc-immunophenotyping', options: base });
  const clean = await generateInWorker({ id: 'pbmc-immunophenotyping', options: { ...base, clogs: [] } });
  const anomalous = (result) => result.files[0].meta.truth.anomalies.length;
  assert.ok(anomalous(clogged) > 0, 'the default clog');
  assert.equal(anomalous(clean), 0, 'clogs: [] reached the example');
});
