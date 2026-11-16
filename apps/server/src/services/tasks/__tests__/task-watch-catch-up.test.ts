import { afterEach, expect, it, vi } from 'vitest';
import { currentAuditActor, runWithAuditActor } from '../../audit/audit-context.js';
import {
  TASK_DIRECTORY_CATCH_UP_MS,
  TaskWatchCatchUp,
  drainTaskWatchWork,
} from '../watch/task-watch-catch-up.js';

function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
afterEach(() => {
  vi.useRealTimers();
});

it('settles startup once and coalesces pending cues without postponing the scan', async () => {
  vi.useFakeTimers();
  const run = vi.fn(async () => {});
  const report = vi.fn();
  const scans = new TaskWatchCatchUp(run, () => true, 100, report);
  scans.request();
  scans.begin();
  scans.begin();
  await vi.advanceTimersByTimeAsync(100);
  await scans.ready;
  expect(run).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 20; i++) {
    scans.request();
    await vi.advanceTimersByTimeAsync(40);
  }
  expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(TASK_DIRECTORY_CATCH_UP_MS - 800);
  expect(run).toHaveBeenCalledTimes(2);
  expect(report).not.toHaveBeenCalled();
  await scans.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it('allows one scan at a time and one paced dirty follow-up under continuous cues', async () => {
  vi.useFakeTimers();
  const first = held();
  const second = held();
  const run = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const scans = new TaskWatchCatchUp(run, () => true, 0, vi.fn());
  scans.begin();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 100; i++) scans.request();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(run).toHaveBeenCalledTimes(1);
  first.release();
  await scans.ready;
  await vi.advanceTimersByTimeAsync(TASK_DIRECTORY_CATCH_UP_MS - 1);
  expect(run).toHaveBeenCalledTimes(1);
  scans.request();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 100; i++) scans.request();
  let stopped = false;
  const stopping = scans.stop().then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(stopped).toBe(false);
  second.release();
  await stopping;
  expect(stopped).toBe(true);
  scans.request();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels pending startup and recovery work and resolves startup waiters on stop', async () => {
  vi.useFakeTimers();
  const run = vi.fn(async () => {});
  const scans = new TaskWatchCatchUp(run, () => true, 100, vi.fn());
  scans.begin();
  scans.request();
  await scans.stop();
  await scans.ready;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not run queued work after its root identity is replaced', async () => {
  vi.useFakeTimers();
  let active = true;
  const run = vi.fn(async () => {});
  const scans = new TaskWatchCatchUp(run, () => active, 0, vi.fn());
  scans.begin();
  await vi.advanceTimersByTimeAsync(0);
  scans.request();
  active = false;
  await vi.advanceTimersByTimeAsync(TASK_DIRECTORY_CATCH_UP_MS);
  expect(run).toHaveBeenCalledTimes(1);
  await scans.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['throw', 'reject'] as const)(
  'reports a %s failure and permits a later cue to recover',
  async (mode) => {
    vi.useFakeTimers();
    const failure = new Error('scan failed');
    const run = vi
      .fn()
      .mockImplementationOnce(() => {
        if (mode === 'throw') throw failure;
        return Promise.reject(failure);
      })
      .mockResolvedValue(undefined);
    const report = vi.fn();
    const scans = new TaskWatchCatchUp(run, () => true, 0, report);
    scans.begin();
    await vi.advanceTimersByTimeAsync(0);
    await scans.ready;
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    scans.request();
    await vi.advanceTimersByTimeAsync(TASK_DIRECTORY_CATCH_UP_MS);
    expect(run).toHaveBeenCalledTimes(2);
    await scans.stop();
  }
);

it('drains other work before surfacing even an undefined close refusal', async () => {
  const pending = held();
  let finished = false;
  let refusal: { error: unknown } | undefined;
  const stopping = drainTaskWatchWork([Promise.reject(undefined), pending.promise])
    .catch((error) => {
      refusal = { error };
    })
    .finally(() => {
      finished = true;
    });
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);
  pending.release();
  await stopping;
  expect(refusal).toEqual({ error: undefined });
});

it('runs background discovery outside the request that started its timer', async () => {
  vi.useFakeTimers();
  const seen: unknown[] = [];
  const scans = new TaskWatchCatchUp(
    async () => {
      seen.push(currentAuditActor());
    },
    () => true,
    0,
    vi.fn()
  );
  await runWithAuditActor(
    { actor: { kind: 'agent', accountId: 'agent-a', name: 'Agent A' }, surface: 'mcp' },
    async () => {
      expect(currentAuditActor()?.actor.accountId).toBe('agent-a');
      scans.begin();
      await vi.advanceTimersByTimeAsync(0);
      await scans.ready;
      scans.request();
      await vi.advanceTimersByTimeAsync(TASK_DIRECTORY_CATCH_UP_MS);
      expect(currentAuditActor()?.actor.accountId).toBe('agent-a');
    }
  );
  expect(seen).toEqual([undefined, undefined]);
  await scans.stop();
});
