import test from 'node:test';
import assert from 'node:assert/strict';
import { probeRenderAck } from '../mechanics/mechanics-controls.mjs';
import { probeLatency } from '../mechanics/mechanics-latency.mjs';

function replaceFetch(t, fetch) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  t.after(() => Object.defineProperty(globalThis, 'fetch', descriptor));
  globalThis.fetch = fetch;
}

test('render ACK probe retains its intended assertion when unsubscribe fails', async (t) => {
  const cleanup = Error('fixture unsubscribe cleanup failure');
  let frames = 0;
  replaceFetch(t, async (url) => {
    if (url.endsWith('/subscribe')) return { json: async () => ({ viewerId: 'fixture' }) };
    if (url.endsWith('/unsubscribe')) throw cleanup;
    return {
      status: ++frames === 1 ? 200 : 409,
      headers: { get: () => '{}' },
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  });
  const s = {
    human: 'fixture-token',
    tab: { tabId: 'fixture' },
    viewer: { url: 'http://fixture.invalid', stats: () => ({ rendered: 0 }) },
  };
  await assert.rejects(probeRenderAck(s, { fault: true }), (error) => {
    assert.equal(error.failureCode, 'missing-render-ack');
    assert.equal(error.cleanupFailure, true);
    assert.equal(error.cleanupError, cleanup);
    return true;
  });
});

test('latency probe keeps primary samples and performs every inner cleanup in LIFO order', async (t) => {
  const primary = new assert.AssertionError({
    message: 'fixture input failure',
    actual: false,
    expected: true,
  });
  primary.result = { samples: 7, measurements: [{ retained: true }] };
  const unsubscribe = Error('fixture unsubscribe failure'),
    transport = Error('fixture transport close failure');
  const cleanupOrder = [];
  replaceFetch(t, async (url) => {
    if (url.endsWith('/subscribe')) return { json: async () => ({ viewerId: 'slow-fixture' }) };
    if (url.endsWith('/unsubscribe')) {
      cleanupOrder.push('unsubscribe');
      throw unsubscribe;
    }
    return { status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
  });
  const box = { x: 0, y: 0, width: 100, height: 100 };
  const locator = {
    boundingBox: async () => box,
    scrollIntoViewIfNeeded: async () => {},
    textContent: async () => '0',
  };
  const page = {
    getByRole: () => ({ click: async () => {} }),
    waitForFunction: async () => {},
    evaluate: async () => {},
    route: async () => {},
    unrouteAll: async () => {
      cleanupOrder.push('transport');
      throw transport;
    },
    locator: () => locator,
    mouse: {
      click: async () => {
        throw primary;
      },
    },
  };
  const originalCapture = async () => ({ bytes: Buffer.alloc(0) });
  let capture = originalCapture,
    installed = false;
  const manager = { getTab: () => ({ page, viewport: { width: 1280, height: 720 } }) };
  Object.defineProperty(manager, 'capture', {
    get: () => capture,
    set: (value) => {
      capture = value;
      if (installed) cleanupOrder.push('restore');
      installed = true;
    },
  });
  const s = {
    open: async () => page,
    manager,
    human: 'fixture-token',
    tab: { tabId: 'fixture', page },
    browser: { browserId: 'fixture-browser' },
    viewer: { url: 'http://fixture.invalid', stats: () => ({ dropped: 0 }) },
  };
  await assert.rejects(probeLatency(s, { samples: 1, rttMs: 150, stall: true }), (error) => {
    assert.equal(error, primary);
    assert.equal(error.result.samples, 7);
    assert.equal(error.cleanupFailure, true);
    assert.deepEqual(error.cleanupError.errors, [unsubscribe, transport]);
    return true;
  });
  assert.deepEqual(cleanupOrder, ['unsubscribe', 'transport', 'restore']);
  assert.equal((await manager.capture()).bytes.length, 0);
});

test('successful render ACK observation still surfaces a standalone cleanup failure', async (t) => {
  const cleanup = Error('fixture standalone unsubscribe failure');
  let frames = 0,
    rendered = 0;
  replaceFetch(t, async (url) => {
    if (url.endsWith('/subscribe')) return { json: async () => ({ viewerId: 'fixture' }) };
    if (url.endsWith('/unsubscribe')) throw cleanup;
    if (url.endsWith('/ack')) {
      rendered++;
      return { status: 200 };
    }
    return {
      status: ++frames === 1 ? 200 : 409,
      headers: { get: () => '{}' },
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  });
  const s = {
    human: 'fixture-token',
    tab: { tabId: 'fixture' },
    viewer: { url: 'http://fixture.invalid', stats: () => ({ rendered }) },
  };
  await assert.rejects(probeRenderAck(s), (error) => {
    assert.equal(error, cleanup);
    return true;
  });
});
