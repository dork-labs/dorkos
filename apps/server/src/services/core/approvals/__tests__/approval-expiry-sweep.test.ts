/**
 * Making an approval nobody answered observable (spec `approval-expiry-notice`,
 * DOR-1932).
 *
 * Before this, expiry was evaluated only when somebody presented a token or
 * tried to decide a stale row. An approval that simply ran out of time with
 * nobody looking reached `settle()` never: no `approval_resolved`, no escalation
 * disarm, and no way for the agent that asked to learn its request was dead.
 *
 * The tests below are about the three properties that had to hold before that
 * could change safely: the sweep settles what nothing else would, the WRITE
 * decides who settles it, and a restart neither loses nor duplicates the notice.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { approvals, eq, type Db } from '@dorkos/db';
import {
  ApprovalService,
  APPROVAL_EXPIRY_SWEEP_MAX_MS,
  MIN_APPROVAL_TTL_MS,
} from '../approval-service.js';
import { runApprovalExpiryTick, startApprovalExpirySweep } from '../approval-expiry-sweep.js';
import { hashApprovalInput } from '../approval-input-hash.js';
import { eventFanOut } from '../../event-fan-out.js';

const BINDING = {
  capabilityId: 'mesh.unregister',
  inputHash: hashApprovalInput({ agentId: '01KXQ3P7ADJY9DSXMZW1XGWCV4' }),
};

/** Every `approval_resolved` the service broadcast during one test. */
type Resolved = { approvalId?: string; outcome?: string };

describe('an approval nobody answers stops being invisible', () => {
  let db: Db;
  let service: ApprovalService;
  let resolved: Resolved[];

  beforeEach(() => {
    db = createTestDb();
    // A one-second window, so a test can watch a real approval actually run out
    // of time rather than asserting against a mocked clock.
    service = new ApprovalService(db, { ttlMs: MIN_APPROVAL_TTL_MS });
    resolved = [];
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation((name, data) => {
      if (name === 'approval_resolved') resolved.push(data as Resolved);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Ask for something, from a session that could be told the answer. */
  function ask(sessionId: string | null = 'session-1') {
    return service.request({
      ...BINDING,
      summary: 'Unregister "scout"',
      ...(sessionId === null ? {} : { requestingSession: { sessionId, cwd: '/work/repo' } }),
    });
  }

  /** Drag one row's deadline into the past without waiting for it. */
  function expire(approvalId: string, msAgo = 1_000) {
    db.update(approvals)
      .set({ expiresAt: new Date(Date.now() - msAgo).toISOString() })
      .where(eq(approvals.id, approvalId))
      .run();
  }

  describe('the sweep', () => {
    it('settles an approval whose window closed with nobody looking', () => {
      // The whole bug in one test: before the sweep existed, nothing in this
      // sequence produced an event, because no token was ever presented.
      const { approvalId } = ask();
      expire(approvalId);

      expect(resolved).toHaveLength(0);
      expect(service.sweepExpired()).toBe(1);

      expect(resolved).toEqual([expect.objectContaining({ approvalId, outcome: 'expired' })]);
    });

    it('leaves an approval whose window is still open alone', () => {
      const { approvalId } = ask();

      expect(service.sweepExpired()).toBe(0);
      expect(resolved).toHaveLength(0);
      const row = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
      expect(row?.consumedAt).toBeNull();
    });

    it('settles an approval exactly once across repeated sweeps', () => {
      // A sweep runs every minute forever; settling the same row on every tick
      // would wake the agent about one dead request over and over.
      const { approvalId } = ask();
      expire(approvalId);

      expect(service.sweepExpired()).toBe(1);
      expect(service.sweepExpired()).toBe(0);
      expect(service.sweepExpired()).toBe(0);
      expect(resolved.filter((r) => r.approvalId === approvalId)).toHaveLength(1);
    });

    it('never settles a row a person actually decided', () => {
      // A granted row that later passes its deadline is not an expiry — the
      // person answered, and the agent must be told what they said.
      const { approvalId } = ask();
      expect(service.grant(approvalId)).toBeUndefined();
      resolved.length = 0;
      expire(approvalId);

      expect(service.sweepExpired()).toBe(0);
      expect(resolved).toHaveLength(0);
    });

    it('leaves the row pending rather than inventing a decision nobody made', () => {
      // `consumedAt` is what marks a swept row finished. Writing a
      // decision-shaped state for an ending nobody chose would put a lie in the
      // audit trail — and `releaseStaleVerdictClaims` reads exactly this shape.
      const { approvalId } = ask();
      expire(approvalId);
      service.sweepExpired();

      const row = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
      expect(row?.state).toBe('pending');
      expect(row?.consumedAt).not.toBeNull();
      expect(row?.decidedAt).toBeNull();
    });

    it('settles a sessionless approval too, so escalation still disarms', () => {
      // Nothing can be DELIVERED for a row with no session, but the card still
      // has to retire and the escalation clock still has to stop.
      const { approvalId } = ask(null);
      expire(approvalId);

      expect(service.sweepExpired()).toBe(1);
      expect(resolved).toEqual([expect.objectContaining({ approvalId, outcome: 'expired' })]);
    });
  });

  describe('the write decides, not the read', () => {
    it('does not settle twice when a token is presented in the same instant', () => {
      // `consume` writes an expired row off too. Both paths call `markConsumed`
      // first, so exactly one of them can win the row — the other must fall
      // through silently rather than broadcasting a second ending.
      const { approvalId, token } = ask();
      expire(approvalId);

      const consumed = service.consume(token, BINDING);
      expect(consumed).toEqual({ outcome: 'expired', approvalId });

      expect(service.sweepExpired()).toBe(0);
      expect(resolved.filter((r) => r.approvalId === approvalId)).toHaveLength(1);
    });

    it('makes a later consume report the row as already spent', () => {
      const { approvalId, token } = ask();
      expire(approvalId);
      expect(service.sweepExpired()).toBe(1);

      // The agent retries after the sweep got there first. It learns the token is
      // spent rather than being told a second, contradictory ending.
      expect(service.consume(token, BINDING)).toEqual({ outcome: 'consumed', approvalId });
      expect(resolved.filter((r) => r.approvalId === approvalId)).toHaveLength(1);
    });
  });

  describe('a restart neither loses nor duplicates the notice', () => {
    it('keeps the delivery receipt on an expiry that was already delivered', () => {
      // The defect this feature would otherwise introduce, and the reason
      // `releaseStaleVerdictClaims` grew a `consumedAt IS NULL` clause.
      //
      // A swept row stays `state: 'pending'`. Until expiry became observable,
      // "pending with a claim" could only mean a live in-session hold, so the
      // boot sweep released every one of them. With this feature that shape is
      // ALSO what a correctly-delivered expiry notice looks like — and handing
      // its claim back re-opens a delivery that already happened.
      const { approvalId } = ask();
      expire(approvalId);
      service.sweepExpired();
      expect(service.claimVerdictDelivery(approvalId)).toBe(true);

      // The restart.
      expect(service.releaseStaleVerdictClaims()).toBe(0);

      const row = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
      expect(
        row?.notifiedAt,
        'a delivered expiry notice lost its receipt on restart — it would be delivered twice'
      ).not.toBeNull();
    });

    it('still frees a claim held by a hold that the restart killed', () => {
      // The clause must not break what the boot sweep was written for: an
      // unspent pending row claimed by a hold that no longer exists.
      const { approvalId } = ask();
      expect(service.claimVerdictDelivery(approvalId)).toBe(true);

      expect(service.releaseStaleVerdictClaims()).toBe(1);
      const row = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
      expect(row?.notifiedAt).toBeNull();
    });
  });

  describe('what the agent is told', () => {
    it('composes an expiry notice naming the deadline, not the sweep', () => {
      // The sweep's cadence is an implementation detail. Reporting when it
      // happened to notice would tell the agent the wrong time.
      const { approvalId } = ask('session-4');
      expire(approvalId, 5_000);
      const deadline = db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .get()?.expiresAt;
      service.sweepExpired();

      expect(service.verdictDelivery(approvalId)).toEqual({
        sessionId: 'session-4',
        cwd: '/work/repo',
        verdict: {
          approvalId,
          capabilityTitle: 'mesh.unregister',
          outcome: 'expired',
          endedAt: deadline,
        },
      });
    });

    it('has nothing to deliver for an approval with no session', () => {
      const { approvalId } = ask(null);
      expire(approvalId);
      service.sweepExpired();

      expect(service.verdictDelivery(approvalId)).toBeUndefined();
    });

    it('has nothing to deliver while the window is still open', () => {
      const { approvalId } = ask();
      expect(service.verdictDelivery(approvalId)).toBeUndefined();
    });
  });

  describe('the cadence tracks the window it polices', () => {
    it('sweeps no slower than the decision window', () => {
      // `DORKOS_APPROVAL_TTL_MS` exists so a harness can watch an approval lapse.
      // A flat 60s sweep would make a one-second window sit unobserved for a
      // minute, which defeats the variable entirely (DOR-498).
      const short = new ApprovalService(db, { ttlMs: 2_000 });
      expect(short.expirySweepIntervalMs).toBe(2_000);
    });

    it('caps the interval on the ordinary two-hour window', () => {
      expect(new ApprovalService(db).expirySweepIntervalMs).toBe(APPROVAL_EXPIRY_SWEEP_MAX_MS);
    });

    it('refuses to spin on a nonsensically short window', () => {
      // `ApprovalServiceOptions.ttlMs` is constructor API and does not pass
      // through `resolveApprovalTtlMs`, so a caller really can hand over `5`.
      expect(new ApprovalService(db, { ttlMs: 5 }).expirySweepIntervalMs).toBe(MIN_APPROVAL_TTL_MS);
    });
  });

  describe('one tick settles before it purges', () => {
    it('announces a row that lapsed while the server was down past retention', () => {
      // The ordering is load-bearing exactly once: after the server has been DOWN
      // for longer than the 24h retention window. Purge first and the row is
      // DELETED by the very pass that should have announced it, so the one
      // approval whose agent most needs telling is the one silently dropped.
      //
      // Driven through `runApprovalExpiryTick` rather than two calls in a test,
      // because that function existing IS the fix: boot and the interval both run
      // it, so neither can get the order wrong on its own.
      const { approvalId } = ask();
      expire(approvalId, 25 * 60 * 60 * 1000);

      const result = runApprovalExpiryTick(service);

      expect(result.settled).toBe(1);
      expect(result.purged).toBe(1);
      expect(
        resolved.map((r) => r.approvalId),
        'a long-dead approval was deleted before anything announced it'
      ).toEqual([approvalId]);
    });

    it('purges even when settling throws', () => {
      const throwing = {
        sweepExpired: vi.fn(() => {
          throw new Error('database is locked');
        }),
        purgeExpired: vi.fn(() => 4),
      };

      expect(runApprovalExpiryTick(throwing)).toEqual({ settled: 0, purged: 4 });
    });

    it('settles even when purging throws', () => {
      const throwing = {
        sweepExpired: vi.fn(() => 2),
        purgeExpired: vi.fn(() => {
          throw new Error('database is locked');
        }),
      };

      expect(runApprovalExpiryTick(throwing)).toEqual({ settled: 2, purged: 0 });
    });
  });

  describe('the timer that drives it', () => {
    it('settles and purges on every tick, not only at boot', () => {
      vi.useFakeTimers();
      const source = {
        sweepExpired: vi.fn(() => 0),
        purgeExpired: vi.fn(() => 0),
      };

      const stop = startApprovalExpirySweep(source, 1_000);
      vi.advanceTimersByTime(3_000);
      stop();

      expect(source.sweepExpired).toHaveBeenCalledTimes(3);
      // The retention purge only ever ran once, at boot — so a server up for a
      // month never trimmed the table after its first second.
      expect(source.purgeExpired).toHaveBeenCalledTimes(3);
    });

    it('keeps sweeping after a tick throws', () => {
      // A store that is momentarily unreadable must not silently kill the timer
      // and return expiry to being unobservable.
      vi.useFakeTimers();
      const sweepExpired = vi
        .fn<() => number>()
        .mockImplementationOnce(() => {
          throw new Error('database is locked');
        })
        .mockImplementation(() => 0);
      const purgeExpired = vi.fn(() => 0);

      const stop = startApprovalExpirySweep({ sweepExpired, purgeExpired }, 1_000);
      expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
      stop();

      expect(sweepExpired).toHaveBeenCalledTimes(2);
      // A failed settle must not cost the purge its tick either.
      expect(purgeExpired).toHaveBeenCalledTimes(2);
    });

    it('stops when told to', () => {
      vi.useFakeTimers();
      const source = {
        sweepExpired: vi.fn(() => 0),
        purgeExpired: vi.fn(() => 0),
      };

      const stop = startApprovalExpirySweep(source, 1_000);
      stop();
      vi.advanceTimersByTime(5_000);

      expect(source.sweepExpired).not.toHaveBeenCalled();
    });
  });
});
