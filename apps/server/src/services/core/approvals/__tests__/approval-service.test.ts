/**
 * Approval lifecycle tests (spec `agent-trust` §3.3): a token is single-use,
 * expires, is bound to one action, and is never stored in a recoverable form.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestDb } from '@dorkos/test-utils/db';
import { approvals, eq, type Db } from '@dorkos/db';
import {
  APPROVAL_SUMMARY_MAX_LENGTH,
  PendingApprovalSchema,
} from '@dorkos/shared/approval-schemas';
import { ApprovalService, APPROVAL_TTL_MS } from '../approval-service.js';
import { hashApprovalInput } from '../approval-input-hash.js';
import { eventFanOut } from '../../event-fan-out.js';

/** A binding for a plausible destructive action. */
const BINDING = {
  capabilityId: 'marketplace.uninstall',
  inputHash: hashApprovalInput({ name: 'sentry-monitor' }),
};

/** The other action a leaked token must never reach. */
const OTHER_BINDING = {
  capabilityId: 'marketplace.uninstall',
  inputHash: hashApprovalInput({ name: 'something-else' }),
};

describe('ApprovalService', () => {
  let db: Db;
  let service: ApprovalService;
  let broadcast: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = createTestDb();
    service = new ApprovalService(db);
    broadcast = vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Ask for approval of the standard action. */
  function requestOne(requestedBy = 'dorkbot') {
    return service.request({
      ...BINDING,
      summary: 'Uninstall "sentry-monitor"',
      requestedBy,
    });
  }

  describe('request', () => {
    it('returns an id, an opaque token, and an expiry one decision window out', () => {
      const before = Date.now();
      const ticket = requestOne();

      expect(ticket.approvalId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
      expect(ticket.token).toMatch(/^[0-9a-f]{32}$/);
      const window = new Date(ticket.expiresAt).getTime() - before;
      expect(window).toBeGreaterThan(APPROVAL_TTL_MS - 1000);
      expect(window).toBeLessThanOrEqual(APPROVAL_TTL_MS + 1000);
    });

    it('stores only the hash of the token, never the token', () => {
      const ticket = requestOne();

      const row = db.select().from(approvals).where(eq(approvals.id, ticket.approvalId)).get();
      expect(row?.tokenHash).toBe(createHash('sha256').update(ticket.token, 'utf8').digest('hex'));
      // No column anywhere holds the plaintext.
      expect(JSON.stringify(row)).not.toContain(ticket.token);
    });

    it('issues a distinct token per request', () => {
      expect(requestOne().token).not.toBe(requestOne().token);
    });

    it('broadcasts approval_pending with the card payload and no token', () => {
      const ticket = requestOne('ops-agent');

      expect(broadcast).toHaveBeenCalledWith('approval_pending', {
        approvalId: ticket.approvalId,
        capabilityId: 'marketplace.uninstall',
        // No registry lookup is wired here, so the title falls back to the id.
        capabilityTitle: 'marketplace.uninstall',
        tier: 'destructive',
        summary: 'Uninstall "sentry-monitor"',
        requestedBy: 'ops-agent',
        requestedAt: expect.any(String),
        expiresAt: ticket.expiresAt,
      });
      expect(JSON.stringify(broadcast.mock.calls)).not.toContain(ticket.token);
    });

    it('defaults the title to the capability id and the tier to destructive', () => {
      const ticket = service.request({
        ...BINDING,
        summary: 'Uninstall something',
      });

      const [pending] = service.listPending();
      expect(pending.approvalId).toBe(ticket.approvalId);
      expect(pending.capabilityTitle).toBe('marketplace.uninstall');
      expect(pending.tier).toBe('destructive');
      expect(pending.requestedBy).toBeUndefined();
    });
  });

  describe('consume', () => {
    it('reports pending until somebody decides', () => {
      const ticket = requestOne();
      expect(service.consume(ticket.token, BINDING)).toEqual({
        outcome: 'pending',
        approvalId: ticket.approvalId,
        expiresAt: ticket.expiresAt,
      });
    });

    it('reports granted once, then consumed — the token is single-use', () => {
      const ticket = requestOne();
      expect(service.grant(ticket.approvalId)).toBeUndefined();

      expect(service.consume(ticket.token, BINDING)).toEqual({
        outcome: 'granted',
        approvalId: ticket.approvalId,
        capabilityId: 'marketplace.uninstall',
        requestedBy: 'dorkbot',
      });
      expect(service.consume(ticket.token, BINDING)).toEqual({
        outcome: 'consumed',
        approvalId: ticket.approvalId,
      });
    });

    it('reports denied once, with the reason, then consumed', () => {
      const ticket = requestOne();
      expect(service.deny(ticket.approvalId, 'not today')).toBeUndefined();

      expect(service.consume(ticket.token, BINDING)).toEqual({
        outcome: 'denied',
        approvalId: ticket.approvalId,
        reason: 'not today',
      });
      expect(service.consume(ticket.token, BINDING)).toEqual({
        outcome: 'consumed',
        approvalId: ticket.approvalId,
      });
    });

    it('omits the reason when a denial gave none', () => {
      const ticket = requestOne();
      service.deny(ticket.approvalId);

      const result = service.consume(ticket.token, BINDING);
      expect(result).toEqual({ outcome: 'denied', approvalId: ticket.approvalId });
    });

    it('reports unknown for a token that was never issued', () => {
      expect(service.consume('deadbeef', BINDING)).toEqual({ outcome: 'unknown' });
      expect(service.consume('', BINDING)).toEqual({ outcome: 'unknown' });
    });

    it('refuses a granted token presented for a different action, without spending it', () => {
      const ticket = requestOne();
      service.grant(ticket.approvalId);

      // The confused-deputy case: consent to uninstall one package must never
      // uninstall another.
      expect(service.consume(ticket.token, OTHER_BINDING)).toEqual({
        outcome: 'mismatched',
        approvalId: ticket.approvalId,
      });
      // Still spendable for what it was actually granted for.
      expect(service.consume(ticket.token, BINDING).outcome).toBe('granted');
    });

    it('refuses a granted token presented for a different capability', () => {
      const ticket = requestOne();
      service.grant(ticket.approvalId);

      expect(
        service.consume(ticket.token, {
          capabilityId: 'marketplace.install',
          inputHash: BINDING.inputHash,
        }).outcome
      ).toBe('mismatched');
    });

    it('treats a hash of the same input written in another key order as a match', () => {
      const ticket = service.request({
        capabilityId: 'workspace.delete',
        inputHash: hashApprovalInput({ name: 'scratch', purge: true }),
        summary: 'Delete the scratch workspace',
      });
      service.grant(ticket.approvalId);

      const rebuilt = hashApprovalInput({ purge: true, name: 'scratch' });
      expect(
        service.consume(ticket.token, { capabilityId: 'workspace.delete', inputHash: rebuilt })
          .outcome
      ).toBe('granted');
    });

    it('refuses an expired approval when the token is presented, not only on sweep', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
      const ticket = requestOne();
      service.grant(ticket.approvalId);

      // Exactly at the boundary the approval is still live.
      vi.setSystemTime(new Date(Date.now() + APPROVAL_TTL_MS));
      expect(service.consume(ticket.token, BINDING).outcome).toBe('granted');

      const second = requestOne();
      service.grant(second.approvalId);
      vi.setSystemTime(new Date(Date.now() + APPROVAL_TTL_MS + 1));
      expect(service.consume(second.token, BINDING)).toEqual({
        outcome: 'expired',
        approvalId: second.approvalId,
      });
      // Written off, so a later presentation cannot be honored either.
      expect(service.consume(second.token, BINDING)).toEqual({
        outcome: 'consumed',
        approvalId: second.approvalId,
      });
    });

    it('broadcasts approval_resolved when a token is spent', () => {
      const ticket = requestOne();
      service.grant(ticket.approvalId);
      broadcast.mockClear();

      service.consume(ticket.token, BINDING);

      expect(broadcast).toHaveBeenCalledWith('approval_resolved', {
        approvalId: ticket.approvalId,
        outcome: 'consumed',
        resolvedAt: expect.any(String),
      });
    });
  });

  describe('grant and deny', () => {
    it('broadcasts approval_resolved with the decision', () => {
      const granted = requestOne();
      const denied = requestOne();
      broadcast.mockClear();

      service.grant(granted.approvalId);
      service.deny(denied.approvalId);

      expect(broadcast).toHaveBeenCalledWith('approval_resolved', {
        approvalId: granted.approvalId,
        outcome: 'granted',
        resolvedAt: expect.any(String),
      });
      expect(broadcast).toHaveBeenCalledWith('approval_resolved', {
        approvalId: denied.approvalId,
        outcome: 'denied',
        resolvedAt: expect.any(String),
      });
    });

    it('reports unknown for an id that does not exist', () => {
      expect(service.grant('01JZZZZZZZZZZZZZZZZZZZZZZZ')).toBe('unknown');
      expect(service.deny('01JZZZZZZZZZZZZZZZZZZZZZZZ')).toBe('unknown');
    });

    it('reports not_pending on a second decision', () => {
      const ticket = requestOne();
      expect(service.grant(ticket.approvalId)).toBeUndefined();
      expect(service.grant(ticket.approvalId)).toBe('not_pending');
      expect(service.deny(ticket.approvalId)).toBe('not_pending');
    });

    it('reports not_pending once the token has been spent', () => {
      const ticket = requestOne();
      service.grant(ticket.approvalId);
      service.consume(ticket.token, BINDING);
      expect(service.deny(ticket.approvalId)).toBe('not_pending');
    });

    it('reports expired and writes the approval off when the window closed', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
      const ticket = requestOne();

      vi.setSystemTime(new Date(Date.now() + APPROVAL_TTL_MS + 1));
      expect(service.grant(ticket.approvalId)).toBe('expired');
      expect(service.consume(ticket.token, BINDING)).toEqual({
        outcome: 'consumed',
        approvalId: ticket.approvalId,
      });
    });
  });

  describe('the card is described by the registry, not by the requester', () => {
    it('takes the title and tier from the capability registry', () => {
      const described = new ApprovalService(db, {
        describeCapability: (id) =>
          id === 'marketplace.install'
            ? { title: 'Install a marketplace package', tier: 'act' }
            : undefined,
      });

      described.request({
        capabilityId: 'marketplace.install',
        inputHash: BINDING.inputHash,
        summary: 'Install "sentry-monitor"',
      });

      expect(described.listPending()[0]).toMatchObject({
        capabilityTitle: 'Install a marketplace package',
        tier: 'act',
      });
    });

    it('over-warns rather than under-warns on an id the registry does not know', () => {
      const described = new ApprovalService(db, { describeCapability: () => undefined });

      described.request({
        capabilityId: 'someone.invented_this',
        inputHash: BINDING.inputHash,
        summary: 'Do something unrecognized',
      });

      expect(described.listPending()[0]).toMatchObject({
        capabilityTitle: 'someone.invented_this',
        tier: 'destructive',
      });
    });
  });

  describe('listPending', () => {
    it('lists what is waiting, oldest first, without token material', () => {
      const first = requestOne();
      const second = requestOne();

      const pending = service.listPending();
      expect(pending.map((p) => p.approvalId)).toEqual([first.approvalId, second.approvalId]);
      expect(JSON.stringify(pending)).not.toContain(first.token);
    });

    it('drops decided, spent, and expired approvals', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
      const decided = requestOne();
      const stale = requestOne();
      service.grant(decided.approvalId);

      vi.setSystemTime(new Date(Date.now() + APPROVAL_TTL_MS + 1));
      const live = requestOne();

      expect(service.listPending().map((p) => p.approvalId)).toEqual([live.approvalId]);
      expect(service.listPending().map((p) => p.approvalId)).not.toContain(stale.approvalId);
    });
  });

  describe('purgeExpired', () => {
    it('deletes long-expired rows and keeps live ones', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'));
      const old = requestOne();

      vi.setSystemTime(new Date('2026-07-24T00:00:00.000Z'));
      const fresh = requestOne();

      expect(service.purgeExpired()).toBe(1);
      expect(
        db.select().from(approvals).where(eq(approvals.id, old.approvalId)).get()
      ).toBeUndefined();
      expect(
        db.select().from(approvals).where(eq(approvals.id, fresh.approvalId)).get()
      ).toBeDefined();
    });
  });
});

/**
 * Two properties the cockpit and the tier gate depend on: an expired token
 * reports that it expired even when its binding is wrong, and a summary always
 * fits the card that has to render it.
 */
describe('ApprovalService — reporting and card limits', () => {
  let db: Db;
  let service: ApprovalService;

  beforeEach(() => {
    db = createTestDb();
    service = new ApprovalService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports expired, not mismatched, for a stale token with the wrong binding', () => {
    vi.useFakeTimers();
    const ticket = service.request({ ...BINDING, summary: 'Uninstall "sentry-monitor"' });
    service.grant(ticket.approvalId);

    vi.advanceTimersByTime(APPROVAL_TTL_MS + 1000);

    // Both things are wrong with this presentation. The caller needs to hear the
    // one it cannot fix by rebuilding its arguments.
    expect(service.consume(ticket.token, OTHER_BINDING)).toEqual({
      outcome: 'expired',
      approvalId: ticket.approvalId,
    });
  });

  it('still reports mismatched for a LIVE token with the wrong binding', () => {
    const ticket = service.request({ ...BINDING, summary: 'Uninstall "sentry-monitor"' });
    service.grant(ticket.approvalId);

    expect(service.consume(ticket.token, OTHER_BINDING)).toEqual({
      outcome: 'mismatched',
      approvalId: ticket.approvalId,
    });
    // Left unspent: the approval stays available for what was actually allowed.
    expect(service.consume(ticket.token, BINDING).outcome).toBe('granted');
  });

  it('shortens a summary too long for a card instead of storing an unrenderable row', () => {
    const ticket = service.request({
      ...BINDING,
      summary: 'x'.repeat(APPROVAL_SUMMARY_MAX_LENGTH + 200),
    });

    const [pending] = service.listPending();
    expect(pending.approvalId).toBe(ticket.approvalId);
    expect(pending.summary.length).toBe(APPROVAL_SUMMARY_MAX_LENGTH);
    // Parses against the schema the cockpit uses — the point of the cap.
    expect(PendingApprovalSchema.safeParse(pending).success).toBe(true);
  });

  it('leaves a summary that already fits exactly as written', () => {
    service.request({ ...BINDING, summary: 'Uninstall "sentry-monitor", keeping its saved data' });
    expect(service.listPending()[0].summary).toBe(
      'Uninstall "sentry-monitor", keeping its saved data'
    );
  });
});
