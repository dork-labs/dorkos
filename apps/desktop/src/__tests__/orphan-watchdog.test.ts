import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const liveness = vi.hoisted(() => ({
  isProcessAlive: vi.fn<(pid: number) => boolean>(),
  assessProcessLiveness: vi.fn<(pid: number, referenceTime: Date) => string>(),
}));
vi.mock('@dorkos/shared/process-liveness', () => liveness);

import {
  createParentLivenessCheck,
  exitWhenOrphaned,
  ORPHAN_CHECK_INTERVAL_MS,
} from '../orphan-watchdog';

beforeEach(() => {
  liveness.isProcessAlive.mockReset();
  liveness.assessProcessLiveness.mockReset();
});

describe('createParentLivenessCheck (DOR-552, caching)', () => {
  it('runs the full corroboration on the first check', () => {
    liveness.assessProcessLiveness.mockReturnValue('live-confirmed');
    const check = createParentLivenessCheck(123, new Date('2026-01-01'));

    expect(check()).toBe(true);

    expect(liveness.assessProcessLiveness).toHaveBeenCalledTimes(1);
    expect(liveness.assessProcessLiveness).toHaveBeenCalledWith(123, new Date('2026-01-01'));
  });

  it('caches a live-confirmed result: subsequent polls use bare isProcessAlive, never re-forking the full check', () => {
    liveness.assessProcessLiveness.mockReturnValue('live-confirmed');
    liveness.isProcessAlive.mockReturnValue(true);
    const check = createParentLivenessCheck(123, new Date('2026-01-01'));

    check(); // first poll: full corroboration
    check();
    check();

    expect(liveness.assessProcessLiveness).toHaveBeenCalledTimes(1);
    // Every poll after the first is the cheap bare check instead.
    expect(liveness.isProcessAlive).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache a live-unconfirmed result: every poll re-runs the full check', () => {
    liveness.assessProcessLiveness.mockReturnValue('live-unconfirmed');
    const check = createParentLivenessCheck(123, new Date('2026-01-01'));

    check();
    check();
    check();

    // Nothing was ever confirmed, so there is nothing safe to cache.
    expect(liveness.assessProcessLiveness).toHaveBeenCalledTimes(3);
    expect(liveness.isProcessAlive).not.toHaveBeenCalled();
  });

  it('returns false and never caches when the first check finds the parent already gone', () => {
    liveness.assessProcessLiveness.mockReturnValue('gone');
    const check = createParentLivenessCheck(123, new Date('2026-01-01'));

    expect(check()).toBe(false);
    // A second poll (the caller would not normally make one after exiting,
    // but the contract should not silently start trusting a cache that was
    // never established) still runs the full check.
    check();
    expect(liveness.assessProcessLiveness).toHaveBeenCalledTimes(2);
  });

  it('re-corroborates fully once a cached-confirmed pid is observed dead (pid-liveness flip)', () => {
    liveness.assessProcessLiveness.mockReturnValue('live-confirmed');
    liveness.isProcessAlive.mockReturnValue(true);
    const check = createParentLivenessCheck(123, new Date('2026-01-01'));

    expect(check()).toBe(true); // full check, confirms and caches
    expect(check()).toBe(true); // cached: bare check only

    // The pid goes away.
    liveness.isProcessAlive.mockReturnValue(false);
    expect(check()).toBe(false);
    expect(liveness.assessProcessLiveness).toHaveBeenCalledTimes(1); // still just the first

    // A pid reuse brings a live process back under the same number. The
    // stale cache must not be trusted — this must be a fresh, full check.
    liveness.assessProcessLiveness.mockClear();
    liveness.assessProcessLiveness.mockReturnValue('gone'); // the new occupant started later
    expect(check()).toBe(false);
    expect(liveness.assessProcessLiveness).toHaveBeenCalledTimes(1);
  });

  it('degrades to bare isProcessAlive with no corroboration when parentStartedAt is null (Windows, no ps)', () => {
    liveness.isProcessAlive.mockReturnValue(true);
    const check = createParentLivenessCheck(123, null);

    expect(check()).toBe(true);
    expect(check()).toBe(true);

    expect(liveness.assessProcessLiveness).not.toHaveBeenCalled();
    expect(liveness.isProcessAlive).toHaveBeenCalledTimes(2);
  });
});

describe('exitWhenOrphaned (DOR-552, consumer)', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    exitSpy.mockRestore();
  });

  it('is a no-op with no DORKOS_PARENT_PID', () => {
    exitWhenOrphaned({});
    vi.advanceTimersByTime(ORPHAN_CHECK_INTERVAL_MS * 3);

    expect(liveness.isProcessAlive).not.toHaveBeenCalled();
    expect(liveness.assessProcessLiveness).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('is a no-op with a malformed DORKOS_PARENT_PID', () => {
    exitWhenOrphaned({ DORKOS_PARENT_PID: 'not-a-pid' });
    vi.advanceTimersByTime(ORPHAN_CHECK_INTERVAL_MS * 3);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('takes the parentStartedAt-fork path: passes a parsed Date to assessProcessLiveness on the first poll', () => {
    liveness.assessProcessLiveness.mockReturnValue('live-confirmed');

    exitWhenOrphaned({
      DORKOS_PARENT_PID: '4242',
      DORKOS_PARENT_STARTED_AT: '2026-01-01T00:00:00.000Z',
    });
    vi.advanceTimersByTime(ORPHAN_CHECK_INTERVAL_MS);

    expect(liveness.assessProcessLiveness).toHaveBeenCalledWith(
      4242,
      new Date('2026-01-01T00:00:00.000Z')
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('caches across polls through the real interval: only one assessProcessLiveness call over several ticks', () => {
    liveness.assessProcessLiveness.mockReturnValue('live-confirmed');
    liveness.isProcessAlive.mockReturnValue(true);

    exitWhenOrphaned({
      DORKOS_PARENT_PID: '4242',
      DORKOS_PARENT_STARTED_AT: '2026-01-01T00:00:00.000Z',
    });
    vi.advanceTimersByTime(ORPHAN_CHECK_INTERVAL_MS * 5);

    expect(liveness.assessProcessLiveness).toHaveBeenCalledTimes(1);
    expect(liveness.isProcessAlive).toHaveBeenCalledTimes(4);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('degrades to bare isProcessAlive with an unparseable DORKOS_PARENT_STARTED_AT (never calls assessProcessLiveness)', () => {
    liveness.isProcessAlive.mockReturnValue(true);

    exitWhenOrphaned({
      DORKOS_PARENT_PID: '4242',
      DORKOS_PARENT_STARTED_AT: 'not-a-real-date',
    });
    vi.advanceTimersByTime(ORPHAN_CHECK_INTERVAL_MS * 3);

    expect(liveness.assessProcessLiveness).not.toHaveBeenCalled();
    expect(liveness.isProcessAlive).toHaveBeenCalledTimes(3);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits the process once the parent is reported gone', () => {
    liveness.assessProcessLiveness.mockReturnValue('gone');

    exitWhenOrphaned({
      DORKOS_PARENT_PID: '4242',
      DORKOS_PARENT_STARTED_AT: '2026-01-01T00:00:00.000Z',
    });
    vi.advanceTimersByTime(ORPHAN_CHECK_INTERVAL_MS);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits the process when the pid-only (no parentStartedAt) check reports the parent gone', () => {
    liveness.isProcessAlive.mockReturnValue(false);

    exitWhenOrphaned({ DORKOS_PARENT_PID: '4242' });
    vi.advanceTimersByTime(ORPHAN_CHECK_INTERVAL_MS);

    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
