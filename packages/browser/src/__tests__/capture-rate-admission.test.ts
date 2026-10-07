import { expect, it, onTestFinished, vi } from 'vitest';
import { captureTab, joinTabCaptureOriginals } from '../tabs/capture.js';
import { closeRecord } from '../lifecycle/close.js';
import { configuration, deferred, fakeJPEG, tabFixture, tick } from './parent-fixture.js';

function fixture(interval = 100) {
  const h = tabFixture();
  const state = { now: 0 };
  const config = {
    ...configuration(),
    captureMinimumIntervalMilliseconds: interval,
    clock: { monotonicNow: () => state.now, wallNow: () => 1000 },
  };
  const command = () => ({
    kind: 'capture' as const,
    requestId: h.command().requestId,
    binding: { ...h.tab.binding },
  });
  const jobs: Promise<unknown>[] = [];
  const releases: (() => void)[] = [];
  const capture = () => {
    const job = captureTab(config, h.record, command());
    jobs.push(job);
    void job.catch(() => {});
    return job;
  };
  vi.useFakeTimers();
  onTestFinished(async () => {
    // Stop first releases an original scheduler wait even after assertion failure.
    try {
      h.record.lifetime.gate.stop();
      for (const release of releases) release();
      await Promise.allSettled(jobs);
      await joinTabCaptureOriginals(h.tab);
      await closeRecord(config, h.record);
    } finally {
      vi.useRealTimers();
    }
  });
  return { h, state, capture, config, releases };
}
it('shares the measured start interval across requests without disconnecting fast polling', async () => {
  const f = fixture();
  await f.capture();
  f.state.now = 99;
  const waiting = f.capture();
  await tick();
  expect(f.h.raw.screenshot).toHaveBeenCalledTimes(1);
  expect(f.h.tab.pending).toBe(1);
  f.state.now = 101;
  await vi.advanceTimersByTimeAsync(2);
  await waiting;
  expect(f.h.raw.screenshot).toHaveBeenCalledTimes(2);
  expect(f.h.tab.pending).toBe(0);
});
it('keeps queue2 while the original screenshot is held and schedules the queued request from actual prior start', async () => {
  const f = fixture();
  const held = deferred<Uint8Array>();
  f.releases.push(() => {
    held.resolve(fakeJPEG());
  });
  f.h.raw.screenshot.mockImplementation(() => held.promise);
  const first = f.capture();
  await tick();
  expect(f.h.raw.screenshot).toHaveBeenCalledTimes(1);
  const second = f.capture();
  expect(f.h.tab.pending).toBe(2);
  await expect(f.capture()).rejects.toMatchObject({ code: 'CAPTURE_QUEUE_FULL' });
  f.state.now = 50;
  held.resolve(fakeJPEG());
  await first;
  await tick();
  expect(f.h.raw.screenshot).toHaveBeenCalledTimes(1);
  f.state.now = 101;
  await vi.advanceTimersByTimeAsync(51);
  await second;
  expect(f.h.raw.screenshot).toHaveBeenCalledTimes(2);
  expect(f.h.tab.pending).toBe(0);
});
it('wakes the original scheduler on retirement and never starts its pending screenshot', async () => {
  const f = fixture(2000);
  await f.capture();
  const waiting = f.capture();
  await tick();
  expect(f.h.tab.pending).toBe(1);
  f.h.record.lifetime.gate.stop();
  await expect(waiting).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(f.h.raw.screenshot).toHaveBeenCalledTimes(1);
  expect(f.h.tab.pending).toBe(0);
  // The Page tombstone entered genuine parent retirement, which owns its own
  // observation/deadline timers independently of the now-returned capture wait.
  await closeRecord(f.config, f.h.record);
  expect(vi.getTimerCount()).toBe(0);
});

it('keeps the original native screenshot deadline after the maximum scheduling interval', async () => {
  const f = fixture(2000);
  await f.capture();
  const held = deferred<Uint8Array>();
  f.releases.push(() => {
    held.resolve(fakeJPEG());
  });
  f.h.raw.screenshot.mockImplementation(() => held.promise);
  const waiting = f.capture();
  await tick();
  expect(f.h.raw.screenshot).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1999);
  expect(f.h.raw.screenshot).toHaveBeenCalledTimes(1);
  f.state.now = 2000;
  await vi.advanceTimersByTimeAsync(1);
  expect(f.h.raw.screenshot).toHaveBeenCalledTimes(2);
  f.state.now = 3500;
  await vi.advanceTimersByTimeAsync(1500);
  held.resolve(fakeJPEG());
  const capture = await waiting;
  expect(capture.encodingMilliseconds).toBe(1500);
  expect(f.h.tab.pending).toBe(0);
});
