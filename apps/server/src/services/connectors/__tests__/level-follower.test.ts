/**
 * The level follower keeps every leveled app followed within the interval,
 * across restarts, reading only what is due, one failure at a time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEVEL_FOLLOW_INTERVAL_MS,
  LEVEL_FOLLOW_TICK_MS,
  LevelFollower,
} from '../resources/level-follower.js';

const HOUR = 60 * 60_000;
const T0 = Date.parse('2026-09-29T00:00:00.000Z');

describe('LevelFollower', () => {
  /** When, and under which version, each connection was last followed (the stamp table). */
  let stamps: Map<string, { at: number; version: string }>;
  let followCatalog: ReturnType<
    typeof vi.fn<(id: string, signal: AbortSignal, version: string) => Promise<void>>
  >;
  let levelConnectionIds: ReturnType<typeof vi.fn<() => string[]>>;
  let followers: LevelFollower[];

  /** Start a follower as a server process would, under one DorkOS version. */
  function boot(version = '1.0.0', opts: { maxConnections?: number } = {}): LevelFollower {
    const follower = new LevelFollower({
      reconciliation: {
        followCatalog,
        levelConnectionIds,
        followedSince: (id, since, appVersion) => {
          const stamp = stamps.get(id);
          return (
            stamp !== undefined && stamp.version === appVersion && stamp.at >= Date.parse(since)
          );
        },
      },
      appVersion: version,
      ...opts,
    });
    followers.push(follower);
    follower.start();
    return follower;
  }

  const followed = () => followCatalog.mock.calls.map(([id]) => id);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    stamps = new Map();
    followers = [];
    followCatalog = vi.fn(async (id, _signal, version) => {
      stamps.set(id, { at: Date.now(), version });
    });
    levelConnectionIds = vi.fn(() => ['connection-a', 'connection-b', 'connection-c']);
  });

  afterEach(() => {
    for (const follower of followers) follower.stop();
    vi.useRealTimers();
  });

  it('follows every leveled app at boot, without anyone opening the card', async () => {
    boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(followed()).toEqual(['connection-a', 'connection-b', 'connection-c']);
    expect(followCatalog.mock.calls[0]![2]).toBe('1.0.0');
  });

  it('follows an app within 12 hours of its last follow, even across a restart', async () => {
    const first = boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(followCatalog).toHaveBeenCalledTimes(3);

    // The server restarts 11 hours later: nothing is due yet.
    await vi.advanceTimersByTimeAsync(11 * HOUR);
    first.stop();
    followCatalog.mockClear();
    boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(followCatalog).not.toHaveBeenCalled();

    // One tick later, at T0 + 12 hours, every app is followed again.
    await vi.advanceTimersByTimeAsync(LEVEL_FOLLOW_TICK_MS);
    expect(Date.now()).toBe(T0 + LEVEL_FOLLOW_INTERVAL_MS);
    expect(followed()).toEqual(['connection-a', 'connection-b', 'connection-c']);
  });

  it('never lets an app go longer than the interval while it runs', async () => {
    let last = T0;
    followCatalog.mockImplementation(async (id, _signal, version) => {
      if (id === 'connection-a') {
        expect(Date.now() - last).toBeLessThanOrEqual(LEVEL_FOLLOW_INTERVAL_MS);
        last = Date.now();
      }
      stamps.set(id, { at: Date.now(), version });
    });
    boot();
    await vi.advanceTimersByTimeAsync(3 * LEVEL_FOLLOW_INTERVAL_MS);
    // Hourly ticks read only what is due: one follow per app per interval, plus boot.
    expect(followCatalog.mock.calls.filter(([id]) => id === 'connection-a')).toHaveLength(4);
  });

  it('follows everything right after an update, however recent the last follow', async () => {
    const first = boot('1.0.0');
    await vi.advanceTimersByTimeAsync(0);
    first.stop();
    followCatalog.mockClear();
    await vi.advanceTimersByTimeAsync(HOUR);
    boot('1.1.0');
    await vi.advanceTimersByTimeAsync(0);
    expect(followed()).toEqual(['connection-a', 'connection-b', 'connection-c']);
  });

  it('goes on to the next app when one fails, and tries the failed one again next tick', async () => {
    followCatalog.mockImplementation(async (id, _signal, version) => {
      if (id === 'connection-b') throw new Error('catalog unreachable');
      stamps.set(id, { at: Date.now(), version });
    });
    boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(followed()).toEqual(['connection-a', 'connection-b', 'connection-c']);
    followCatalog.mockClear();
    await vi.advanceTimersByTimeAsync(LEVEL_FOLLOW_TICK_MS);
    expect(followed()).toEqual(['connection-b']);
  });

  it('never rejects, even when the list itself cannot be read', async () => {
    levelConnectionIds.mockImplementation(() => {
      throw new Error('database closed');
    });
    const follower = boot();
    await expect(follower.follow()).resolves.toBeUndefined();
    expect(followCatalog).not.toHaveBeenCalled();
  });

  it('reads at most the bound in one pass, and the rest at the next tick', async () => {
    boot('1.0.0', { maxConnections: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(followed()).toEqual(['connection-a', 'connection-b']);
    followCatalog.mockClear();
    await vi.advanceTimersByTimeAsync(LEVEL_FOLLOW_TICK_MS);
    expect(followed()).toEqual(['connection-c']);
  });

  it('joins a pass already running rather than starting a second', async () => {
    const follower = new LevelFollower({
      reconciliation: { followCatalog, levelConnectionIds, followedSince: () => false },
      appVersion: '1.0.0',
    });
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
