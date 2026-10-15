/** Genuine constructor lifecycle controls; model/Room acceptance controls remain separately held. */
import { afterEach, expect, it, vi } from 'vitest';
import { authorityFixture } from '../writes/__tests__/authority-fixtures.js';
import { startCurrentRoomDueScheduler } from '../operations/room-due-scheduler.js';
import { DocChannelService } from '../service.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('refuses a prototype service without genuine constructor custody', () => {
  const impostor = Object.create(DocChannelService.prototype);
  expect(() => startCurrentRoomDueScheduler(impostor)).toThrow('genuine service constructor');
});

it('stops the genuine idle service and its maintenance timer twice without creating a model', async () => {
  const h = await authorityFixture();
  try {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    const scheduler = startCurrentRoomDueScheduler(h.http.service);
    expect(vi.getTimerCount()).toBe(before + 1);
    const firstStop = scheduler.stop();
    expect(scheduler.stop()).toBe(firstStop);
    await firstStop;
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(120000);
    expect(vi.getTimerCount()).toBe(before);
    expect(h.db.$client.inTransaction).toBe(false);
    expect(h.http.channels.getBatch('not-an-original')).toBeUndefined();
  } finally {
    await h.cleanup();
  }
});

it('does not call a replaced public committed-input subscription', async () => {
  const h = await authorityFixture();
  try {
    const publicSubscription = vi
      .spyOn(h.http.service, 'onCommittedInput')
      .mockImplementation(() => {
        throw new Error('Public replacement is not scheduler custody.');
      });
    const scheduler = startCurrentRoomDueScheduler(h.http.service);
    await scheduler.stop();
    expect(publicSubscription).not.toHaveBeenCalled();
  } finally {
    await h.cleanup();
  }
});

it('latches a genuine maintenance prepare failure including undefined and stops future work', async () => {
  const h = await authorityFixture();
  let scheduler: ReturnType<typeof startCurrentRoomDueScheduler> | undefined;
  let restorePrepare: (() => void) | undefined;
  let stopFailureObserved = false;
  let failed = false;
  let primary: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      primary = cause;
    }
  };
  try {
    vi.useFakeTimers();
    scheduler = startCurrentRoomDueScheduler(h.http.service);
    const prepare = vi.spyOn(h.db.$client, 'prepare').mockImplementationOnce(() => {
      throw undefined;
    });
    restorePrepare = () => prepare.mockRestore();
    await vi.advanceTimersByTimeAsync(60000);
    expect(prepare).toHaveBeenCalledTimes(1);
    const result = await scheduler.stop().then(
      () => ({ failed: false as const }),
      (cause: unknown) => ({ failed: true as const, cause })
    );
    stopFailureObserved = result.failed;
    expect(result).toEqual({ failed: true, cause: undefined });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.db.$client.inTransaction).toBe(false);
  } catch (cause) {
    remember(cause);
  } finally {
    // The known rejected stop is already observed above; resource release remains independent.
    try {
      restorePrepare?.();
    } catch (cause) {
      remember(cause);
    }
    try {
      await scheduler?.stop();
    } catch (cause) {
      if (!stopFailureObserved) remember(cause);
    }
    try {
      await h.cleanup();
    } catch (cause) {
      remember(cause);
    }
  }
  if (failed) throw primary;
});
