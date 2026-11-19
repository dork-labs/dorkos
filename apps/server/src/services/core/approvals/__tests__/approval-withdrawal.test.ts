/**
 * An agent takes back its own waiting request (DOR-4586): the card ends on every surface, the
 * audit log records it, and another agent's request, or one that already ended, is refused.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { approvals, auditEvents, eq, type Db } from '@dorkos/db';
import { ApprovalService } from '../approval-service.js';
import { hashApprovalInput } from '../approval-input-hash.js';
import { WITHDRAW_REFUSALS, withdrawOwnApproval } from '../approval-withdrawal.js';
import { eventFanOut } from '../../event-fan-out.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';

const ANA = '/agents/ana';
const BEN = '/agents/ben';

let db: Db;
let service: ApprovalService;
let resolved: { approvalId?: string; outcome?: string }[];

beforeEach(() => {
  db = createTestDb();
  service = new ApprovalService(db);
  resolved = [];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation((name, data) => {
    if (name === 'approval_resolved') resolved.push(data as { approvalId?: string });
  });
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
  });
});

afterEach(() => {
  resetAuditTrail();
  vi.restoreAllMocks();
});

/** A request Ana raised, waiting for a person. */
function anaAsks(): string {
  return service.request({
    capabilityId: 'tasks.set_mode',
    inputHash: hashApprovalInput({ id: 'nightly-sweep', mode: 'acceptEdits' }),
    summary: 'Set how a scheduled task runs',
    requestedBy: 'ana',
    requestedByPath: ANA,
  }).approvalId;
}

describe('withdrawing a request', () => {
  it('ends its own waiting request everywhere, and records who took it back', () => {
    const id = anaAsks();
    const result = withdrawOwnApproval(db, id, { agentPath: ANA, reason: 'No longer needed.' });

    expect(result).toMatchObject({ ok: true, approvalId: id });
    expect(service.listPending().map((card) => card.approvalId)).not.toContain(id);
    expect(resolved).toContainEqual(
      expect.objectContaining({ approvalId: id, outcome: 'expired' })
    );
    const row = db.select().from(approvals).where(eq(approvals.id, id)).get()!;
    // Nobody decided it, so no decision is written.
    expect(row.state).toBe('pending');
    expect(row.consumedAt).not.toBeNull();
    const audit = db.select().from(auditEvents).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'approval.withdraw', targetId: id });
    expect(JSON.stringify(audit[0])).toContain('No longer needed.');
  });

  it('refuses another agent’s request and leaves its card in place', () => {
    const id = anaAsks();
    expect(withdrawOwnApproval(db, id, { agentPath: BEN })).toEqual({
      ok: false,
      code: 'not_yours',
    });
    expect(service.listPending().map((card) => card.approvalId)).toContain(id);
    expect(resolved).toHaveLength(0);
  });

  it('refuses a request a person already answered', () => {
    const id = anaAsks();
    service.grant(id);
    resolved = [];
    expect(withdrawOwnApproval(db, id, { agentPath: ANA })).toEqual({
      ok: false,
      code: 'already_ended',
    });
    expect(db.select().from(approvals).where(eq(approvals.id, id)).get()!.state).toBe('granted');
    expect(resolved).toHaveLength(0);
  });

  it('refuses a request that ran out of time', () => {
    const id = anaAsks();
    db.update(approvals)
      .set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(approvals.id, id))
      .run();
    expect(withdrawOwnApproval(db, id, { agentPath: ANA })).toEqual({
      ok: false,
      code: 'already_ended',
    });
  });

  it('refuses a second withdrawal and an unknown id, with words an agent can act on', () => {
    const id = anaAsks();
    withdrawOwnApproval(db, id, { agentPath: ANA });
    expect(withdrawOwnApproval(db, id, { agentPath: ANA })).toMatchObject({
      code: 'already_ended',
    });
    expect(withdrawOwnApproval(db, 'no-such-id', { agentPath: ANA })).toMatchObject({
      code: 'not_found',
    });
    expect(WITHDRAW_REFUSALS.not_yours).toMatch(/Only the agent that asked/);
    expect(db.select().from(auditEvents).all()).toHaveLength(1);
  });

  it('refuses a card that records no agent, without claiming another agent asked', () => {
    const id = service.request({
      capabilityId: 'marketplace.install',
      inputHash: hashApprovalInput({ name: 'made-up-pack' }),
      summary: 'Install a package',
      requestedBy: 'ana',
    }).approvalId;
    expect(withdrawOwnApproval(db, id, { agentPath: ANA })).toEqual({
      ok: false,
      code: 'no_requester',
    });
    expect(service.listPending().map((card) => card.approvalId)).toContain(id);
  });
});
