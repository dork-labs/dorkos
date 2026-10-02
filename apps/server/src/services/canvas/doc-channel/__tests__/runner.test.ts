/** Scheduling hints remain bounded, serialized, and disposable without carrying authority. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DocDeliveryRunner, type DocDeliveryRunnerOptions } from '../delivery/runner.js';
import type { DocRecoveryPage } from '../delivery/resume.js';
import type { DocPumpResult } from '../delivery/pump.js';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const runners: DocDeliveryRunner[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  vi.useRealTimers();
});
function page(overrides: Partial<DocRecoveryPage> = {}): DocRecoveryPage {
  return {
    notifications: new Map(),
    selected: 0,
    hasMore: false,
    hasIntegrityMore: false,
    nextEligibleAt: null,
    retryableFailures: 0,
    ...overrides,
  };
}
function pending(overrides: Partial<DocPumpResult> = {}): DocPumpResult {
  return { admitted: 0, waiting: 0, expired: 0, cancelled: 0, nextEligibleAt: null, ...overrides };
}
function setup() {
  const resume = vi
    .fn<DocDeliveryRunnerOptions['pump']['resumeAcceptedPage']>()
    .mockResolvedValue(page());
  const run = vi.fn<DocDeliveryRunnerOptions['pump']['run']>().mockReturnValue(pending());
  const onError = vi.fn<(error: unknown) => void>();
  const runner = new DocDeliveryRunner({
    pump: { resumeAcceptedPage: resume, run },
    now: () => new Date(),
    onError,
  });
  runners.push(runner);
  return { runner, resume, run, onError };
}
function heldPage() {
  let release!: (value: DocRecoveryPage) => void;
  const promise = new Promise<DocRecoveryPage>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const at = (offset: number) => new Date(NOW + offset).toISOString();

it('coalesces 100 hints, preserves a dirty mid-await wake, and never overlaps preparation', async () => {
  const h = setup();
  const held = heldPage();
  h.resume.mockReturnValueOnce(held.promise);
  h.runner.start();
  for (let i = 0; i < 100; i++) h.runner.wake();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.resume).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 100; i++) h.runner.wake();
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.resume).toHaveBeenCalledTimes(1);
  expect(h.run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  held.release(page());
  await vi.advanceTimersByTimeAsync(0);
  expect(h.run).toHaveBeenCalledExactlyOnceWith(100);
  await vi.advanceTimersByTimeAsync(99);
  expect(h.resume).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.resume).toHaveBeenCalledTimes(2);
  expect(h.run).toHaveBeenCalledTimes(2);
});

it('frequent committed input hints do not postpone an already scheduled 100ms pass', async () => {
  const h = setup();
  h.runner.start();
  for (let i = 0; i < 9; i++) {
    await vi.advanceTimersByTimeAsync(10);
    h.runner.wake();
  }
  expect(h.resume).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10);
  expect(h.resume).toHaveBeenCalledTimes(1);
  expect(h.run).toHaveBeenCalledTimes(1);
});

it('advances independent accepted and integrity cursors, resets each at exhaustion, and wraps', async () => {
  const h = setup();
  const accepted = { id: 'receipt-100', acceptedAt: at(0) };
  const integrity = { id: 'damaged-100', acceptedAt: at(0) };
  h.resume
    .mockResolvedValueOnce(page({ selected: 100, hasMore: true, cursor: accepted }))
    .mockResolvedValueOnce(page({ hasIntegrityMore: true, integrityCursor: integrity }))
    .mockResolvedValueOnce(page());
  h.runner.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.resume.mock.calls[0]?.slice(0, 2)).toEqual([undefined, undefined]);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.resume.mock.calls[1]?.slice(0, 2)).toEqual([accepted, undefined]);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.resume.mock.calls[2]?.slice(0, 2)).toEqual([undefined, integrity]);
  await vi.advanceTimersByTimeAsync(60000);
  expect(h.resume.mock.calls[3]?.slice(0, 2)).toEqual([undefined, undefined]);
});

it('uses explicit page exhaustion independently of selected rows or unique notified sessions', async () => {
  const h = setup();
  h.resume.mockResolvedValueOnce(
    page({ selected: 100, notifications: new Map([['session', ['a', 'b']]]) })
  );
  h.runner.start();
  await vi.advanceTimersByTimeAsync(100);
  await vi.advanceTimersByTimeAsync(59999);
  expect(h.resume).toHaveBeenCalledTimes(1);
  h.resume.mockResolvedValueOnce(page({ selected: 0, hasMore: true }));
  await vi.advanceTimersByTimeAsync(1);
  await vi.advanceTimersByTimeAsync(99);
  expect(h.resume).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.resume).toHaveBeenCalledTimes(3);
});

it.each([
  { recovery: 5000, batch: 10000, delay: 4900 },
  { recovery: 120000, batch: 180000, delay: 60000 },
  { recovery: -1000, batch: 10000, delay: 100 },
])(
  'honors the earliest durable deadline with yield/retry bounds: $delay ms',
  async ({ recovery, batch, delay }) => {
    const h = setup();
    h.resume.mockResolvedValue(page({ nextEligibleAt: at(recovery) }));
    h.run.mockReturnValue(pending({ nextEligibleAt: at(batch) }));
    h.runner.start();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(h.resume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.resume).toHaveBeenCalledTimes(2);
  }
);

it('diagnoses malformed deadlines once and isolates a throwing diagnostic callback', async () => {
  const h = setup();
  h.resume.mockResolvedValue(page({ nextEligibleAt: 'not-a-deadline' }));
  h.onError.mockImplementation(() => {
    throw new Error('diagnostic unavailable');
  });
  h.runner.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.onError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: 'Invalid document delivery wake time.' })
  );
  await vi.advanceTimersByTimeAsync(59999);
  expect(h.resume).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.resume).toHaveBeenCalledTimes(2);
  expect(h.onError).toHaveBeenCalledTimes(2);
});

it('backs off retryable integrity failures despite a past accepted deadline', async () => {
  const h = setup();
  h.resume.mockResolvedValue(page({ retryableFailures: 1, nextEligibleAt: at(-1) }));
  h.runner.start();
  await vi.advanceTimersByTimeAsync(100);
  await vi.advanceTimersByTimeAsync(59999);
  expect(h.resume).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.resume).toHaveBeenCalledTimes(2);
});

it('yields between saturated pages instead of recursively draining them', async () => {
  const h = setup();
  h.resume.mockResolvedValue(page({ selected: 100, hasMore: true, hasIntegrityMore: true }));
  h.runner.start();
  await vi.advanceTimersByTimeAsync(100);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.resume).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(99);
  expect(h.resume).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.resume).toHaveBeenCalledTimes(2);
});

it('stop waits for held preparation and suppresses notifications, pending runs, and later timers', async () => {
  const h = setup();
  const held = heldPage();
  const notify = vi.fn();
  h.resume.mockImplementationOnce(async (_cursor, _integrity, shouldNotify) => {
    const result = await held.promise;
    if (shouldNotify?.()) notify();
    return result;
  });
  h.runner.start();
  await vi.advanceTimersByTimeAsync(100);
  h.runner.wake();
  let stopped = false;
  const stop = h.runner.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(h.runner.active).toBe(false);
  expect(h.resume.mock.calls[0]?.[2]?.()).toBe(false);
  held.release(page());
  await stop;
  expect(notify).not.toHaveBeenCalled();
  expect(h.run).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  h.runner.wake();
  await vi.advanceTimersByTimeAsync(120000);
  expect(h.resume).toHaveBeenCalledTimes(1);
});

it('start is idempotent and a stopped runner cannot restart', async () => {
  const h = setup();
  h.runner.wake();
  expect(vi.getTimerCount()).toBe(0);
  h.runner.start();
  h.runner.start();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.resume).toHaveBeenCalledTimes(1);
  await h.runner.stop();
  expect(() => h.runner.start()).toThrow('Document delivery runner has stopped.');
  expect(vi.getTimerCount()).toBe(0);
});

it('retains the warning cursor independently, yields bounded pages, then schedules its earlier deadline and wraps', async () => {
  const h = setup();
  const warning = { dueAt: at(0), batchId: 'warning-100' };
  const accepted = { acceptedAt: at(0), id: 'receipt-100' };
  const integrity = { acceptedAt: at(0), id: 'integrity-100' };
  h.resume
    .mockResolvedValueOnce(
      page({ hasWarningMore: true, warningCursor: warning, hasMore: true, cursor: accepted })
    )
    .mockResolvedValueOnce(
      page({
        hasIntegrityMore: true,
        integrityCursor: integrity,
        hasWarningMore: true,
        warningCursor: warning,
      })
    )
    .mockResolvedValueOnce(page({ nextEligibleAt: at(1500), hasWarningMore: false }))
    .mockResolvedValue(page());
  h.run.mockReturnValue(pending({ nextEligibleAt: at(3600000) }));
  h.runner.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.resume.mock.calls[0]?.[3]).toBeUndefined();
  await vi.advanceTimersByTimeAsync(100);
  expect(h.resume.mock.calls[1]?.[0]).toEqual(accepted);
  expect(h.resume.mock.calls[1]?.[3]).toEqual(warning);
  await vi.advanceTimersByTimeAsync(100);
  expect(h.resume.mock.calls[2]?.[0]).toBeUndefined();
  expect(h.resume.mock.calls[2]?.[1]).toEqual(integrity);
  expect(h.resume.mock.calls[2]?.[3]).toEqual(warning);
  await vi.advanceTimersByTimeAsync(1199);
  expect(h.resume).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.resume).toHaveBeenCalledTimes(4);
  expect(h.resume.mock.calls[3]?.[3]).toBeUndefined();
  expect(vi.getTimerCount()).toBe(1);
  expect(h.onError).not.toHaveBeenCalled();
});
