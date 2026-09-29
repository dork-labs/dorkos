/** The level follower reads leveled apps at boot and on an interval, one failure at a time. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEVEL_FOLLOW_INTERVAL_MS, LevelFollower } from '../resources/level-follower.js';

describe('LevelFollower', () => {
  let followCatalog: ReturnType<typeof vi.fn<(id: string, signal: AbortSignal) => Promise<void>>>;
  let levelConnectionIds: ReturnType<typeof vi.fn<() => string[]>>;
  let follower: LevelFollower;

  beforeEach(() => {
    vi.useFakeTimers();
    followCatalog = vi.fn(async () => undefined);
    levelConnectionIds = vi.fn(() => ['connection-a', 'connection-b', 'connection-c']);
    follower = new LevelFollower({ reconciliation: { followCatalog, levelConnectionIds } });
  });

  afterEach(() => {
    follower.stop();
    vi.useRealTimers();
  });

  it('follows every leveled app once at boot, without anyone opening the card', async () => {
    follower.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(followCatalog.mock.calls.map(([id]) => id)).toEqual([
      'connection-a',
      'connection-b',
      'connection-c',
    ]);
  });

  it('follows again every interval, and not before', async () => {
    follower.start();
    await vi.advanceTimersByTimeAsync(0);
    followCatalog.mockClear();
    await vi.advanceTimersByTimeAsync(LEVEL_FOLLOW_INTERVAL_MS - 1);
    expect(followCatalog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(followCatalog).toHaveBeenCalledTimes(3);
    follower.stop();
    followCatalog.mockClear();
    await vi.advanceTimersByTimeAsync(LEVEL_FOLLOW_INTERVAL_MS);
    expect(followCatalog).not.toHaveBeenCalled();
  });

  it('goes on to the next app when one fails', async () => {
    followCatalog.mockImplementation(async (id) => {
      if (id === 'connection-b') throw new Error('catalog unreachable');
    });
    await follower.follow();
    expect(followCatalog.mock.calls.map(([id]) => id)).toEqual([
      'connection-a',
      'connection-b',
      'connection-c',
    ]);
  });

  it('never rejects, even when the list itself cannot be read', async () => {
    levelConnectionIds.mockImplementation(() => {
      throw new Error('database closed');
    });
    await expect(follower.follow()).resolves.toBeUndefined();
    expect(followCatalog).not.toHaveBeenCalled();
  });

  it('reads at most the bound in one pass', async () => {
    follower = new LevelFollower({
      reconciliation: { followCatalog, levelConnectionIds },
      maxConnections: 2,
    });
    await follower.follow();
    expect(followCatalog).toHaveBeenCalledTimes(2);
  });

  it('joins a pass already running rather than starting a second', async () => {
    let release!: () => void;
    followCatalog.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const first = follower.follow();
    const second = follower.follow();
    expect(second).toBe(first);
    release();
    await first;
    expect(levelConnectionIds).toHaveBeenCalledOnce();
  });
});
