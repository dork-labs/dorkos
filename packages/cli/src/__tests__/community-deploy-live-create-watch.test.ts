import { describe, expect, it, vi } from 'vitest';
import {
  createIntentObserver,
  describeCreateWindows,
  watchCommunityLiveCreates,
  type ObservedCreates,
} from '../../scripts/community-deploy-live-create-watch.js';
import {
  DEFAULT_CREATE_DEADLINE_MS,
  TIGRIS_CREATE_DEADLINE_MS,
} from '../commands/community-deploy/provenance/uncertain-verdict.js';

const APP = 'dorkos-gate-012345abcdef';
const REQUESTED = '2026-09-30T10:31:03.000Z';

function observed(update: Partial<ObservedCreates> = {}): ObservedCreates {
  return {
    fly: { requestedAt: '2026-09-30T10:30:10.000Z', idRecordedAt: '2026-09-30T10:30:14.000Z' },
    neon: { requestedAt: '2026-09-30T10:30:20.000Z', idRecordedAt: '2026-09-30T10:30:23.000Z' },
    tigris: { requestedAt: REQUESTED, idRecordedAt: '2026-09-30T10:31:12.000Z' },
    polls: 900,
    unreadablePolls: 0,
    ...update,
  };
}

describe('createIntentObserver', () => {
  it('keeps the first request time and the first id-recorded time for each create', () => {
    const observer = createIntentObserver();
    observer.observe({});
    observer.observe({
      pendingIntent: { provider: 'fly', requestedAt: '2026-09-30T10:30:10.000Z' },
      resources: {},
      updatedAt: '2026-09-30T10:30:10.000Z',
    });
    observer.observe({
      pendingIntent: { provider: 'fly', requestedAt: '2026-09-30T10:30:10.000Z' },
      resources: { flyAppId: APP },
      updatedAt: '2026-09-30T10:30:14.000Z',
    });
    observer.observe({
      pendingIntent: null,
      resources: { flyAppId: APP },
      updatedAt: '2026-09-30T10:30:16.000Z',
    });
    // The Neon intent was missed between two reads: only its recorded id is seen.
    observer.observe({
      pendingIntent: null,
      resources: { flyAppId: APP, neonProjectId: 'project-1' },
      updatedAt: '2026-09-30T10:30:25.000Z',
    });
    observer.unreadable();
    expect(observer.result()).toEqual({
      fly: { requestedAt: '2026-09-30T10:30:10.000Z', idRecordedAt: '2026-09-30T10:30:14.000Z' },
      neon: { requestedAt: null, idRecordedAt: '2026-09-30T10:30:25.000Z' },
      tigris: { requestedAt: null, idRecordedAt: null },
      polls: 6,
      unreadablePolls: 1,
    });
  });

  it('keeps the first request time when a resumed create writes a later one', () => {
    const observer = createIntentObserver();
    observer.observe({ pendingIntent: { provider: 'tigris', requestedAt: REQUESTED } });
    observer.observe({
      pendingIntent: { provider: 'tigris', requestedAt: '2026-09-30T11:00:00.000Z' },
    });
    expect(observer.result().tigris.requestedAt).toBe(REQUESTED);
  });

  it('ignores a provider or time it cannot trust, and counts a non-object as unreadable', () => {
    const observer = createIntentObserver();
    observer.observe({ pendingIntent: { provider: 'other', requestedAt: REQUESTED } });
    observer.observe({ pendingIntent: { provider: 'tigris', requestedAt: 'not a time' } });
    observer.observe('garbage');
    expect(observer.result()).toMatchObject({
      tigris: { requestedAt: null },
      polls: 3,
      unreadablePolls: 1,
    });
  });
});

describe('watchCommunityLiveCreates', () => {
  it('reads until stopped, counts a failed read without stopping, and stops reading after', async () => {
    const revisions: unknown[] = [
      null,
      new Error('partial'),
      { pendingIntent: { provider: 'tigris', requestedAt: REQUESTED }, resources: {} },
    ];
    let calls = 0;
    const read = vi.fn(async () => {
      const next = revisions[Math.min(calls++, revisions.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    });
    const watch = watchCommunityLiveCreates(read, 1);
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3));
    const first = watch.stop();
    expect(watch.stop()).toBe(first);
    const result = await first;
    expect(result.tigris.requestedAt).toBe(REQUESTED);
    expect(result.unreadablePolls).toBe(1);
    const readsAtStop = read.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(read.mock.calls.length).toBe(readsAtStop);
  });

  it('wakes at once on stop and makes one last read that catches what changed since', async () => {
    let revision: unknown = { resources: {} };
    const read = vi.fn(async () => revision);
    // An hour between reads: only an early wake lets stop() finish inside this test.
    const watch = watchCommunityLiveCreates(read, 60 * 60_000);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    revision = {
      pendingIntent: { provider: 'neon', requestedAt: REQUESTED },
      resources: { neonProjectId: 'project-1' },
      updatedAt: '2026-09-30T10:31:05.000Z',
    };
    const result = await Promise.race([
      watch.stop(),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000)),
    ]);
    expect(result).not.toBe('hung');
    expect(read).toHaveBeenCalledTimes(2);
    expect((result as ObservedCreates).neon).toEqual({
      requestedAt: REQUESTED,
      idRecordedAt: '2026-09-30T10:31:05.000Z',
    });
  });

  it('never keeps the process alive with its timer', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const unrefs: Array<{ mock: { calls: unknown[] } }> = [];
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms: number
    ) => {
      const timer = realSetTimeout(callback, ms);
      // Only the watch's own pause uses this interval.
      if (ms === 60_123) unrefs.push(vi.spyOn(timer, 'unref'));
      return timer;
    }) as typeof setTimeout);
    try {
      const watch = watchCommunityLiveCreates(async () => null, 60_123);
      await vi.waitFor(() => expect(unrefs).toHaveLength(1));
      expect(unrefs[0]!.mock.calls).toHaveLength(1);
      await watch.stop();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('describeCreateWindows', () => {
  it('puts each request time beside the service creation time through the removal window', () => {
    const windows = describeCreateWindows(observed(), {
      fly: '2026-09-30T10:30:12Z',
      neon: '2026-09-30T10:30:19Z',
      tigris: null,
    });
    expect(windows.fly).toEqual({
      requestedAt: '2026-09-30T10:30:10.000Z',
      idRecordedAt: '2026-09-30T10:30:14.000Z',
      createdAt: '2026-09-30T10:30:12Z',
      createdMinusRequestedMs: 2_000,
      idRecordedMinusRequestedMs: 4_000,
      windowDeadlineMs: DEFAULT_CREATE_DEADLINE_MS,
      windowMarginMs: 120_000,
      withinWindow: true,
    });
    // A service clock one second behind is inside the margin.
    expect(windows.neon).toMatchObject({ createdMinusRequestedMs: -1_000, withinWindow: true });
    expect(windows.tigris).toMatchObject({
      createdAt: null,
      createdMinusRequestedMs: null,
      windowDeadlineMs: TIGRIS_CREATE_DEADLINE_MS,
      withinWindow: false,
    });
  });

  it('reports a create outside the window, and one whose request time was never seen', () => {
    const windows = describeCreateWindows(
      observed({ neon: { requestedAt: null, idRecordedAt: null } }),
      {
        fly: '2026-09-30T10:20:00Z',
        neon: '2026-09-30T10:30:19Z',
        tigris: '2026-09-30T10:31:09Z',
      }
    );
    expect(windows.fly).toMatchObject({ createdMinusRequestedMs: -610_000, withinWindow: false });
    expect(windows.neon).toMatchObject({ requestedAt: null, withinWindow: false });
    expect(windows.tigris).toMatchObject({ createdMinusRequestedMs: 6_000, withinWindow: true });
  });
});
