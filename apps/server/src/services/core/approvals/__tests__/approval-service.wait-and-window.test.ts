/**
 * How long an approval waits: `awaitDecision` never rejects or leaks its
 * listener, and the configured window can be shortened but never lengthened.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import {
  ApprovalService,
  APPROVAL_TTL_MS,
  MIN_APPROVAL_TTL_MS,
  resolveApprovalTtlMs,
} from '../approval-service.js';
import { eventFanOut } from '../../event-fan-out.js';
import { BINDING } from './approval-service.fixtures.js';

// DOR-987: `awaitDecision` promises it NEVER rejects, because a held destructive
// call must never be worse than the poll flow it replaces. Two endings skipped
// the happy path and had to be pinned: a store read that throws (the settle-race
// probe ran unguarded inside the promise executor, so its throw rejected the
// promise AND skipped `finish`, stranding the fan-out listener for the life of
// the process), and an abort.
describe('ApprovalService.awaitDecision — never rejects, never leaks its listener', () => {
  let db: Db;
  let service: ApprovalService;

  beforeEach(() => {
    db = createTestDb();
    service = new ApprovalService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('degrades to timeout when the approval store throws, and releases the listener', async () => {
    const ticket = service.request({ ...BINDING, summary: 'Uninstall "sentry-monitor"' });
    const baseline = eventFanOut.listenerCount;
    // The settle-race probe reads the row from SQLite; a store that is down (or a
    // corrupt db file) throws right there, inside the promise executor.
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('SQLITE_IOERR: disk I/O error');
    });

    // A value, never a rejection — the caller falls back to the poll payload.
    await expect(service.awaitDecision(ticket.approvalId, { timeoutMs: 60_000 })).resolves.toBe(
      'timeout'
    );
    // …and the subscription is gone, rather than accumulating one dead listener
    // per held call for the life of the process.
    expect(eventFanOut.listenerCount).toBe(baseline);
  });

  it('ends promptly on an abort, and releases the listener', async () => {
    const ticket = service.request({ ...BINDING, summary: 'Uninstall "sentry-monitor"' });
    const baseline = eventFanOut.listenerCount;
    const controller = new AbortController();

    // A cap far beyond the test's patience: only the abort can end this wait, so
    // a green here cannot be the timer's doing.
    const waiting = service.awaitDecision(ticket.approvalId, {
      timeoutMs: 10 * 60_000,
      signal: controller.signal,
    });
    controller.abort();

    await expect(waiting).resolves.toBe('timeout');
    expect(eventFanOut.listenerCount).toBe(baseline);
  });

  it('ends on an ALREADY-aborted signal without attaching anything', async () => {
    const ticket = service.request({ ...BINDING, summary: 'Uninstall "sentry-monitor"' });
    const baseline = eventFanOut.listenerCount;

    await expect(
      service.awaitDecision(ticket.approvalId, {
        timeoutMs: 10 * 60_000,
        signal: AbortSignal.abort(),
      })
    ).resolves.toBe('timeout');
    expect(eventFanOut.listenerCount).toBe(baseline);
  });
});

describe('resolveApprovalTtlMs — the window can be shortened, never lengthened', () => {
  // Shorter honoured, longer clamped to the default (a "yes" must not stay
  // spendable after the moment a person meant it), zero or negative raised to
  // the floor (a gate that refuses everything reads as broken), non-finite
  // falls back to the default rather than throwing on every destructive call.
  it.each([
    [undefined, undefined],
    [5_000, 5_000],
    [APPROVAL_TTL_MS * 10, APPROVAL_TTL_MS],
    [APPROVAL_TTL_MS + 1, APPROVAL_TTL_MS],
    [APPROVAL_TTL_MS, APPROVAL_TTL_MS],
    [MIN_APPROVAL_TTL_MS, MIN_APPROVAL_TTL_MS],
    [0, MIN_APPROVAL_TTL_MS],
    [-1, MIN_APPROVAL_TTL_MS],
    [1, MIN_APPROVAL_TTL_MS],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [Number.NEGATIVE_INFINITY, undefined],
  ])('resolves %s to %s', (configured, resolved) => {
    expect(resolveApprovalTtlMs(configured)).toBe(resolved);
  });

  it('a floored window still mints a valid expiry rather than an Invalid Date', () => {
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    try {
      const service = new ApprovalService(createTestDb(), {
        ttlMs: resolveApprovalTtlMs(Number.NaN) ?? APPROVAL_TTL_MS,
      });
      const ticket = service.request({ ...BINDING, summary: 'Uninstall it' });
      expect(Number.isNaN(new Date(ticket.expiresAt).getTime())).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('a shortened window is really enforced when a token is presented', () => {
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const service = new ApprovalService(createTestDb(), {
        ttlMs: resolveApprovalTtlMs(1_000),
      });
      const ticket = service.request({ ...BINDING, summary: 'Uninstall it' });
      service.grant(ticket.approvalId);
      vi.advanceTimersByTime(1_001);
      expect(service.consume(ticket.token, BINDING).outcome).toBe('expired');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
