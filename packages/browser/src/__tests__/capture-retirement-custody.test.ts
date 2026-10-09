import { it, expect, onTestFinished, vi } from 'vitest';
import { record, configuration, deferred, tick } from './parent-fixture.js';
import { closeRecord } from '../lifecycle/close.js';
import { ownCaptureOperation, ownOperation, fenceOrdinary } from '../lifecycle/ownership.js';

it.each([false, undefined])(
  'known capture return retains exact thrown %s and the original retirement cause',
  async (cause) => {
    const owned = record();
    const returned = deferred<void>();
    const operation = ownCaptureOperation(owned, async () => {
      await returned.promise;
      throw cause;
    });
    const observed = operation.catch((value: unknown) => ({ value }));
    fenceOrdinary(owned, 'authorityRevoked');
    const closing = closeRecord(configuration(), owned);
    onTestFinished(async () => {
      returned.resolve();
      await Promise.allSettled([operation, closing]);
    });
    await tick();
    expect(owned.lifetime.ordinary.retirement.pendingCoverage.size).toBe(1);
    returned.resolve();
    expect((await observed).value).toBe(cause);
    expect((await closing).cleanup).toBe('observed');
    expect(owned.lifetime.ordinary.retirement.firstCause).toBe('authorityRevoked');
  }
);

it.each([false, undefined])(
  'unknown acquiring work cannot heal its captured gap after exact %s return',
  async (cause) => {
    const owned = record();
    const returned = deferred<void>();
    const operation = ownOperation(owned, async () => {
      await returned.promise;
      throw cause;
    });
    const observed = operation.catch((value: unknown) => ({ value }));
    fenceOrdinary(owned, 'authorityRevoked');
    const closing = closeRecord(configuration(), owned);
    onTestFinished(async () => {
      returned.resolve();
      await Promise.allSettled([operation, closing]);
    });
    returned.resolve();
    expect((await observed).value).toBe(cause);
    expect((await closing).cleanup).toBe('unverified');
    expect(owned.lifetime.ordinary.retirement.pendingCoverage.size).toBe(1);
    expect(owned.lifetime.ordinary.retirement.coverageUnavailable).toBe(true);
    expect(owned.lifetime.ordinary.retirement.firstCause).toBe('authorityRevoked');
  }
);

it('a held known capture keeps the original deadline and late return cannot heal the sealed result', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const owned = record();
  const returned = deferred<void>();
  const operation = ownCaptureOperation(owned, () => returned.promise);
  const closing = closeRecord(configuration(), owned);
  onTestFinished(async () => {
    returned.resolve();
    await Promise.allSettled([operation, closing]);
    vi.useRealTimers();
  });
  expect(owned.lifetime.inputEnd).toBe(2000);
  await vi.advanceTimersByTimeAsync(5001);
  const result = await closing;
  expect(result.cleanup).toBe('unverified');
  expect(owned.lifetime.ordinary.retirement.result!.terminal).toBe(result);
  returned.resolve();
  await operation;
  expect(await closeRecord(configuration(), owned)).toBe(result);
  expect(result.cleanup).toBe('unverified');
  expect(owned.lifetime.inputEnd).toBe(2000);
});
