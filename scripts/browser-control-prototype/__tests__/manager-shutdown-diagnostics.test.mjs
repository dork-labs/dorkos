import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BrowserManager, BrowserManagerError } from '../manager.mjs';

function subject(close) {
  const manager = Object.create(BrowserManager.prototype);
  Object.assign(manager, { browsers: new Map(), opening: new Set(), proxyPromise: null });
  let released = false;
  const record = {
    browserId: `browser-${randomUUID()}`,
    tabIds: new Set(),
    context: { close },
    process: null,
    reservation: { release: () => (released = true) },
    status: 'running',
  };
  manager.browsers.set(record.browserId, record);
  return { manager, record, released: () => released };
}

test('close rejection retains fixed classification without raw error secrets', async () => {
  const secret = 'https://private.invalid/?token=fixture-secret';
  const { manager, record, released } = subject(async () => {
    throw Object.assign(Error(secret), { code: secret });
  });
  await assert.rejects(manager.closeBrowser(record.browserId), (error) => {
    assert.equal(error.code, 'BROWSER_STOP_FAILED');
    assert.equal(error.stopFailureCode, 'CONTEXT_CLOSE_REJECTED');
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!error.stack.includes(secret));
    return true;
  });
  assert.equal(record.status, 'stop-failed');
  assert.equal(released(), false);
});

test('held close hits the unchanged two-second deadline and preserves reservation', async () => {
  let finish;
  const { manager, record, released } = subject(() => new Promise((resolve) => (finish = resolve)));
  const start = performance.now();
  try {
    await assert.rejects(manager.closeBrowser(record.browserId), (error) => {
      assert.equal(error.code, 'BROWSER_STOP_FAILED');
      assert.equal(error.stopFailureCode, 'CONTEXT_CLOSE_TIMEOUT');
      return true;
    });
    assert.ok(performance.now() - start >= 1900);
    assert.equal(record.status, 'stop-failed');
    assert.equal(released(), false);
  } finally {
    finish();
  }
});

test('shutdown summaries retain known fixed causes and map unknown codes without secrets', async () => {
  const { manager, record } = subject(async () => {
    throw Error('fixture-private-stderr');
  });
  const knownId = `browser-${randomUUID()}`;
  const unknownId = `browser-${randomUUID()}`;
  for (const browserId of [knownId, unknownId])
    manager.browsers.set(browserId, { ...record, browserId });
  const stop = manager.stop.bind(manager);
  manager.stop = async (target) => {
    if (target.browserId === knownId) throw new BrowserManagerError('PROCESS_IDENTITY_UNAVAILABLE');
    if (target.browserId === unknownId) throw new BrowserManagerError('fixture-private-url');
    return stop(target);
  };
  await assert.rejects(manager.shutdown(), (error) => {
    assert.equal(error.code, 'SHUTDOWN_FAILED');
    assert.deepEqual(error.failures, [
      {
        browserId: record.browserId,
        code: 'BROWSER_STOP_FAILED',
        stopFailureCode: 'CONTEXT_CLOSE_REJECTED',
      },
      { browserId: knownId, code: 'PROCESS_IDENTITY_UNAVAILABLE' },
      { browserId: unknownId, code: 'CLEANUP_FAILED' },
    ]);
    assert.equal(error.omittedFailures, 0);
    assert.ok(!JSON.stringify(error).includes('fixture-private'));
    return true;
  });
});

test('shutdown summaries bound entries and refuse untrusted browser identifiers', async () => {
  const { manager, record } = subject(async () => {});
  manager.browsers.clear();
  for (let i = 0; i < 40; i++) {
    const browserId = i === 0 ? 'fixture-private-path' : `browser-${randomUUID()}`;
    manager.browsers.set(browserId, { ...record, browserId });
  }
  manager.stop = async () => {
    throw Error('fixture-private-stderr');
  };
  await assert.rejects(manager.shutdown(), (error) => {
    assert.equal(error.failures.length, 32);
    assert.equal(error.omittedFailures, 8);
    assert.equal(error.failures[0].browserId, '[unknown-browser]');
    assert.ok(error.failures.every((failure) => failure.code === 'CLEANUP_FAILED'));
    assert.ok(!JSON.stringify(error).includes('fixture-private'));
    assert.ok(JSON.stringify(error).length < 5000);
    return true;
  });
});
