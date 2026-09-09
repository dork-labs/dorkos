/**
 * The storage and single-delivery halves of telling an agent how its approval
 * ended (spec `approval-verdict-delivery`).
 *
 * Two paths can deliver one verdict — the in-session hold that resumes the tool
 * call, and the out-of-band deliverer that wakes a session which stopped waiting
 * — and BOTH wake on the same `approval_resolved` broadcast. A check-then-act
 * lets both through, which is two turns for one decision.
 *
 * `notified_at` is therefore a CLAIM, not a receipt: a conditional update that
 * changes a row only while nothing else has, exactly as `markConsumed` makes a
 * token single-use. Every test below is about that claim being decided by the
 * WRITE rather than by a read somebody did first.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { approvals, eq, type Db } from '@dorkos/db';
import { ApprovalService } from '../approval-service.js';
import { hashApprovalInput } from '../approval-input-hash.js';
import { eventFanOut } from '../../event-fan-out.js';

const BINDING = {
  capabilityId: 'mesh.unregister',
  inputHash: hashApprovalInput({ agentId: '01KXQ3P7ADJY9DSXMZW1XGWCV4' }),
};

describe('an approval remembers who asked, so a late answer can reach them', () => {
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

  /** Ask, from inside a session. Pass `null` for a session with no directory. */
  function requestFromSession(sessionId = 'session-1', cwd: string | null = '/work/repo') {
    return service.request({
      ...BINDING,
      summary: 'Unregister "scout"',
      requestingSession: { sessionId, ...(cwd === null ? {} : { cwd }) },
    });
  }

  /** Ask from a surface with no session — the external `/mcp` server. */
  function requestSessionless() {
    return service.request({ ...BINDING, summary: 'Unregister "scout"' });
  }

  describe('storage', () => {
    it('records the requesting session and its directory', () => {
      const { approvalId } = requestFromSession('session-7', '/agents/scout');
      const row = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();

      expect(row?.requestingSessionId).toBe('session-7');
      expect(row?.requestingCwd).toBe('/agents/scout');
      expect(row?.notifiedAt).toBeNull();
    });

    it('leaves all three null for a request that arrived without a session', () => {
      // The external `/mcp` surface and the introspection stub — exactly the set
      // with nowhere to deliver to. Byte-identical to the rows they always wrote.
      const { approvalId } = requestSessionless();
      const row = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();

      expect(row?.requestingSessionId).toBeNull();
      expect(row?.requestingCwd).toBeNull();
      expect(row?.notifiedAt).toBeNull();
    });

    it('records a session that carries no directory of its own', () => {
      const { approvalId } = requestFromSession('session-9', null);
      const row = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();

      expect(row?.requestingSessionId).toBe('session-9');
      expect(row?.requestingCwd).toBeNull();
    });
  });

  describe('the claim', () => {
    it('is won exactly once, however many callers race for it', () => {
      const { approvalId } = requestFromSession();

      // Both "paths" claim with nothing between them — the check-then-act shape
      // this replaces would hand `true` to both.
      const results = [
        service.claimVerdictDelivery(approvalId),
        service.claimVerdictDelivery(approvalId),
        service.claimVerdictDelivery(approvalId),
      ];

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results[0]).toBe(true);
    });

    it('stamps the row when it is won', () => {
      const { approvalId } = requestFromSession();
      service.claimVerdictDelivery(approvalId);

      const row = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
      expect(row?.notifiedAt).toEqual(expect.any(String));
    });

    it('is refused for an approval that never named a session', () => {
      // Nothing to deliver to means nothing to claim: a claim that succeeded here
      // would be a lock held forever over a delivery that can never happen.
      const { approvalId } = requestSessionless();
      expect(service.claimVerdictDelivery(approvalId)).toBe(false);
    });

    it('is refused for an approval that does not exist', () => {
      expect(service.claimVerdictDelivery('01KXQ3P7ADJY9DSXMZW1XGWCV4')).toBe(false);
    });

    it('can be released, and then won again', () => {
      // The hold claims when it STARTS waiting and releases if it gives up. Without
      // the release, a person answering at minute twenty finds the delivery spoken
      // for by a hold that has been gone for an hour.
      const { approvalId } = requestFromSession();

      expect(service.claimVerdictDelivery(approvalId)).toBe(true);
      service.releaseVerdictDelivery(approvalId);
      expect(
        db.select().from(approvals).where(eq(approvals.id, approvalId)).get()?.notifiedAt
      ).toBe(null);
      expect(service.claimVerdictDelivery(approvalId)).toBe(true);
    });

    it('is swept back at boot when only a dead process could still hold it', () => {
      // The hole this closes: a hold claims, the server restarts, and its
      // `finally` never runs. The person answers at minute twenty and the
      // deliverer is locked out by a hold that died an hour ago — the very bug
      // this feature exists to fix, one layer down.
      const { approvalId } = requestFromSession();
      expect(service.claimVerdictDelivery(approvalId)).toBe(true);

      // The restart analog: a second service over the same database, exactly as
      // boot builds one.
      const afterRestart = new ApprovalService(db);
      expect(afterRestart.releaseStaleVerdictClaims()).toBe(1);
      expect(afterRestart.claimVerdictDelivery(approvalId)).toBe(true);
    });

    it('leaves a DECIDED approval’s claim alone at boot', () => {
      // The counterpart that makes the sweep safe. A claim on a decided row means
      // the answer was delivered (or the session was gone for good); a restart
      // does not undo either, and re-offering it would be a second turn telling
      // an agent something it already acted on.
      const { approvalId } = requestFromSession();
      service.grant(approvalId);
      expect(service.claimVerdictDelivery(approvalId)).toBe(true);

      expect(new ApprovalService(db).releaseStaleVerdictClaims()).toBe(0);
      expect(service.claimVerdictDelivery(approvalId)).toBe(false);
    });
  });

  describe('the verdict a claimed delivery carries', () => {
    it('names the session, the directory, and what the person decided', () => {
      const { approvalId } = requestFromSession('session-3', '/agents/scout');
      service.grant(approvalId);

      const delivery = service.verdictDelivery(approvalId);
      expect(delivery).toEqual({
        sessionId: 'session-3',
        cwd: '/agents/scout',
        verdict: {
          approvalId,
          capabilityTitle: 'mesh.unregister',
          outcome: 'granted',
          decidedAt: expect.any(String),
        },
      });
    });

    it('carries a refusal and the reason the person gave', () => {
      const { approvalId } = requestFromSession();
      service.deny(approvalId, 'that agent is still running the nightly job');

      const delivery = service.verdictDelivery(approvalId);
      expect(delivery?.verdict.outcome).toBe('denied');
      expect(delivery?.verdict.denyReason).toBe('that agent is still running the nightly job');
    });

    it('takes the capability title from the registry, never from the requester', () => {
      // The card's identity region is derived from the capability registry so it
      // cannot be spoofed by whoever is asking, and the verdict must inherit that
      // — an agent choosing the words a person is told they approved is the whole
      // failure this guards.
      const registryBacked = new ApprovalService(db, {
        describeCapability: () => ({ title: 'Unregister an agent', tier: 'destructive' }),
      });
      const { approvalId } = registryBacked.request({
        ...BINDING,
        summary: 'Unregister "scout"',
        requestingSession: { sessionId: 'session-1' },
      });
      registryBacked.grant(approvalId);

      expect(registryBacked.verdictDelivery(approvalId)?.verdict.capabilityTitle).toBe(
        'Unregister an agent'
      );
    });

    it('is undefined while the approval is still pending', () => {
      const { approvalId } = requestFromSession();
      expect(service.verdictDelivery(approvalId)).toBeUndefined();
    });

    it('is undefined for an approval nobody can be told about', () => {
      const { approvalId } = requestSessionless();
      service.grant(approvalId);
      expect(service.verdictDelivery(approvalId)).toBeUndefined();
    });

    it('is undefined for an approval that does not exist', () => {
      expect(service.verdictDelivery('01KXQ3P7ADJY9DSXMZW1XGWCV4')).toBeUndefined();
    });
  });
});
