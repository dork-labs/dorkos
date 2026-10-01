import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignalSource } from '../../scripts/community-deploy-live-hold.js';
import {
  guardRemovalReadsAfterCleanup,
  NAME_RELEASE_GUARD_MS,
  readRemovalNamesAfterCleanup,
  whileInterruptible,
  type RemovalReadsAfterDependencies,
} from '../../scripts/community-deploy-live-removal-reads.js';
import { FlyGraphqlContractError } from '../commands/community-deploy/fly-graphql-contract.js';

// Distinct names, so a read sent for the wrong one cannot pass by accident.
const APP = 'dorkos-gate-012345abcdef';
const BUCKET = 'dorkos-gate-bucket-9876';

afterEach(() => {
  vi.useRealTimers();
});

describe('readRemovalNamesAfterCleanup', () => {
  function clock() {
    let now = 0;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
      sleep: vi.fn(async (ms: number) => {
        now += ms;
      }),
    };
  }

  it('reads both names once when Fly frees them at once', async () => {
    const time = clock();
    const dependencies: RemovalReadsAfterDependencies = {
      isAppNameAvailable: vi.fn(async () => true),
      isTigrisNameHeld: vi.fn(async () => false),
      now: time.now,
      sleep: time.sleep,
    };
    const result = await readRemovalNamesAfterCleanup(
      { appName: APP, bucketName: BUCKET },
      dependencies
    );
    const freed = {
      reads: 1,
      first: { ok: true, held: false },
      last: { ok: true, held: false },
      releasedAfterMs: 0,
      endedBy: 'released',
    };
    expect(result).toEqual({ appName: freed, tigrisName: freed });
    expect(dependencies.isAppNameAvailable).toHaveBeenCalledWith(APP, expect.any(AbortSignal));
    expect(dependencies.isTigrisNameHeld).toHaveBeenCalledWith(BUCKET, expect.any(AbortSignal));
    expect(time.sleep).not.toHaveBeenCalled();
  });

  it('keeps reading a held name, through a failed read, until it is free', async () => {
    const time = clock();
    const answers = [false, 'fail', true];
    let call = 0;
    const result = await readRemovalNamesAfterCleanup(
      { appName: APP, bucketName: BUCKET },
      {
        isAppNameAvailable: async () => {
          const answer = answers[call++];
          if (answer === 'fail') throw new FlyGraphqlContractError('INVALID_RESPONSE');
          return answer as boolean;
        },
        isTigrisNameHeld: async () => false,
        now: time.now,
        sleep: time.sleep,
      },
      { intervalMs: 10, deadlineMs: 1_000 }
    );
    expect(result.appName).toEqual({
      reads: 3,
      first: { ok: true, held: true },
      last: { ok: true, held: false },
      releasedAfterMs: 20,
      endedBy: 'released',
    });
    expect(result.tigrisName).toMatchObject({ reads: 1, releasedAfterMs: 0 });
  });

  it('stops reading a name after three failed reads in a row', async () => {
    const time = clock();
    const isTigrisNameHeld = vi.fn(async () => {
      throw new FlyGraphqlContractError('INVALID_RESPONSE');
    });
    const result = await readRemovalNamesAfterCleanup(
      { appName: APP, bucketName: BUCKET },
      { isAppNameAvailable: async () => true, isTigrisNameHeld, now: time.now, sleep: time.sleep },
      { intervalMs: 10, deadlineMs: 1_000 }
    );
    expect(isTigrisNameHeld).toHaveBeenCalledTimes(3);
    expect(result.tigrisName).toEqual({
      reads: 3,
      first: { ok: false, code: 'gql:INVALID_RESPONSE' },
      last: { ok: false, code: 'gql:INVALID_RESPONSE' },
      releasedAfterMs: null,
      endedBy: 'failures',
    });
  });

  it('stops at the deadline and records a name Fly still holds', async () => {
    const time = clock();
    const result = await readRemovalNamesAfterCleanup(
      { appName: APP, bucketName: BUCKET },
      {
        isAppNameAvailable: async () => true,
        isTigrisNameHeld: async () => true,
        now: time.now,
        sleep: time.sleep,
      },
      { intervalMs: 10, deadlineMs: 30 }
    );
    // Reads at 0, 10 and 20ms; the deadline falls at 30ms, so no read starts there.
    expect(result.tigrisName).toEqual({
      reads: 3,
      first: { ok: true, held: true },
      last: { ok: true, held: true },
      releasedAfterMs: null,
      endedBy: 'deadline',
    });
    expect(result.appName).toMatchObject({ reads: 1, endedBy: 'released' });
  });

  it('caps each read at the time left and never sleeps past the deadline', async () => {
    const time = clock();
    const signals: AbortSignal[] = [];
    await readRemovalNamesAfterCleanup(
      { appName: APP },
      {
        isAppNameAvailable: async (_name, signal) => {
          signals.push(signal);
          time.advance(25);
          return false;
        },
        isTigrisNameHeld: async () => false,
        now: time.now,
        sleep: time.sleep,
      },
      { intervalMs: 1_000, deadlineMs: 40 }
    );
    // 25ms read, then a sleep of only the 15ms left, then the deadline: exactly one more read is
    // never started.
    expect(signals).toHaveLength(1);
    expect(time.sleep).toHaveBeenCalledWith(15, expect.any(AbortSignal));
  });

  it('stops at once when interrupted, without recording the read it cut off', async () => {
    const time = clock();
    const controller = new AbortController();
    const result = await readRemovalNamesAfterCleanup(
      { appName: APP, bucketName: BUCKET },
      {
        isAppNameAvailable: async () => false,
        isTigrisNameHeld: async (_name, signal) => {
          controller.abort();
          expect(signal.aborted).toBe(true);
          throw new Error('aborted');
        },
        now: time.now,
        sleep: time.sleep,
      },
      { signal: controller.signal }
    );
    expect(result.appName).toMatchObject({ reads: 1, endedBy: 'interrupt' });
    expect(result.tigrisName).toEqual({ ok: false, code: 'guard:INTERRUPTED' });
    expect(time.sleep).not.toHaveBeenCalled();
  });

  it('records missing names without reading', async () => {
    const isAppNameAvailable = vi.fn();
    const time = clock();
    const result = await readRemovalNamesAfterCleanup(
      { appName: undefined, bucketName: undefined },
      { isAppNameAvailable, isTigrisNameHeld: vi.fn(), now: time.now, sleep: time.sleep }
    );
    expect(result).toEqual({
      appName: { ok: false, code: 'journal:JOURNAL_APP_NAME' },
      tigrisName: { ok: false, code: 'journal:JOURNAL_BUCKET_NAME' },
    });
    expect(isAppNameAvailable).not.toHaveBeenCalled();
  });
});

describe('guardRemovalReadsAfterCleanup', () => {
  it('cancels the reads at its default deadline, and replaces a run that ignores that', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const guarded = guardRemovalReadsAfterCleanup((signal) => {
      seen = signal;
      return new Promise(() => {});
    });
    let settled = false;
    void guarded.then(() => {
      settled = true;
    });
    // Five minutes: the three-minute wait plus two minutes of slow reads.
    expect(NAME_RELEASE_GUARD_MS).toBe(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen?.aborted).toBe(true);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(guarded).resolves.toEqual({
      appName: { ok: false, code: 'guard:PROBE_DEADLINE' },
      tigrisName: { ok: false, code: 'guard:PROBE_DEADLINE' },
    });
  });

  it('passes an outside interrupt to the reads and keeps what they recorded', async () => {
    const outside = new AbortController();
    const partial = {
      appName: {
        reads: 2,
        first: { ok: true as const, held: true },
        last: { ok: true as const, held: true },
        releasedAfterMs: null,
        endedBy: 'interrupt' as const,
      },
      tigrisName: { ok: false as const, code: 'guard:INTERRUPTED' },
    };
    const result = guardRemovalReadsAfterCleanup(
      (signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve(partial))),
      { signal: outside.signal }
    );
    outside.abort();
    await expect(result).resolves.toBe(partial);
  });
});

describe('whileInterruptible', () => {
  it('turns Control-C, SIGTERM and SIGHUP into a cancellation, and removes its handlers after', async () => {
    const emitter = new EventEmitter();
    const signals = emitter as unknown as SignalSource;
    for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const result = await whileInterruptible(signals, async (signal) => {
        expect(emitter.listenerCount(event)).toBe(1);
        emitter.emit(event);
        return signal.aborted;
      });
      expect(result).toBe(true);
      expect(emitter.listenerCount(event)).toBe(0);
    }
  });
});
