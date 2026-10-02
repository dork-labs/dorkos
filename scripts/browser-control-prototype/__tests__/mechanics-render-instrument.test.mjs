import test from 'node:test';
import assert from 'node:assert/strict';
import { instrumentRenderBoundary } from '../mechanics/mechanics-render-instrument.mjs';

test('combined receipt records frontend render time before hashing and network rather than response time', async (t) => {
  const names = ['document', 'performance', 'fetch', 'crypto', 'measured'];
  const original = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  let clock = 10,
    input,
    finishHash;
  const sent = [];
  const canvas = {
    width: 1,
    height: 1,
    addEventListener: (name, listener) => {
      assert.equal(name, 'pointerdown');
      input = listener;
    },
    getContext: () => ({ getImageData: () => ({ data: new Uint8Array([1, 2, 3, 4]) }) }),
  };
  function inject(name, value) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  inject('document', { querySelector: () => canvas });
  inject('performance', { now: () => clock });
  inject('fetch', async (url) => {
    sent.push({ url, time: clock });
    return { fixture: true };
  });
  inject('crypto', {
    subtle: {
      digest: async () =>
        new Promise((resolve) => {
          finishHash = () => resolve(new Uint8Array(32));
        }),
    },
  });
  await instrumentRenderBoundary({ evaluate: (callback) => callback() });
  input();
  assert.equal(globalThis.measured.inputAt, 10);
  await globalThis.fetch('/frame', { body: JSON.stringify({ viewerId: 'fixture' }) });
  assert.equal(globalThis.measured.acks.length, 0);
  const receipt = { captureSequence: 1, tabId: 'canonical', byteLength: 10 };
  clock = 25;
  const next = globalThis.fetch('/frame', {
    body: JSON.stringify({ viewerId: 'fixture', receipt }),
  });
  assert.equal(typeof finishHash, 'function', 'COMBINED_RENDER_BOUNDARY_MISSING');
  // Delayed hashing/transport must not become the measured render boundary.
  clock = 200;
  finishHash();
  await next;
  assert.equal(globalThis.measured.acks[0].time, 25);
  assert.deepEqual(globalThis.measured.acks[0].receipt, receipt);
  assert.equal(globalThis.measured.acks[0].hash, '00'.repeat(32));
  assert.deepEqual(sent, [
    { url: '/frame', time: 10 },
    { url: '/frame', time: 200 },
  ]);
  clock = 230;
  const legacy = globalThis.fetch('/ack', {
    body: JSON.stringify({ receipt: { ...receipt, captureSequence: 2 } }),
  });
  clock = 500;
  finishHash();
  await legacy;
  assert.equal(globalThis.measured.acks[1].time, 230);
  assert.equal(globalThis.measured.acks[1].receipt.captureSequence, 2);
});
