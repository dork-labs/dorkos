/**
 * An agent takes back a request it no longer needs (DOR-4586): one of its own
 * cards, still waiting for a person, ends at once on every surface, so it stops
 * sitting in front of the person until it runs out.
 *
 * Only the agent that asked may withdraw, and only while nobody has answered:
 * another agent's card, or one already answered, spent or expired, is refused.
 * The row ends the way an expired one does: one conditional write stamps
 * `consumedAt` and keeps `state: 'pending'`, because nobody decided it, so a
 * person's answer landing in the same millisecond and the withdrawal cannot
 * both win. The card then retires through the same funnel as every other
 * ending ({@link settleApproval}), and the audit log records who took it back.
 *
 * @module services/core/approvals/approval-withdrawal
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, gte, isNull, approvals, type Db } from '@dorkos/db';
import { recordAudit } from '../../audit/audit-trail.js';
import { discardAgentRaise } from './agent-raise/agent-raise-cards.js';
import { settleApproval } from './approval-settle.js';

/** Why a withdrawal was refused. */
export type WithdrawRefusal = 'not_found' | 'not_yours' | 'no_requester' | 'already_ended';

/** What a withdrawal did. */
export type WithdrawResult =
  { ok: true; approvalId: string; title: string } | { ok: false; code: WithdrawRefusal };

/** What an agent is told when its withdrawal was refused, by why. */
export const WITHDRAW_REFUSALS: Record<WithdrawRefusal, string> = {
  not_found: 'No request has that id.',
  not_yours: 'Another agent asked for that. Only the agent that asked can take it back.',
  no_requester: "That request doesn't record which agent asked, so it can't be taken back.",
  already_ended: 'That request already ended: it was answered, used or ran out of time.',
};

/** A folder's real path, or its resolved spelling when it cannot be read. */
function realOr(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Withdraw a waiting request the calling agent raised.
 *
 * @param db - The DorkOS database handle.
 * @param approvalId - The request's id, as its card and `approval_required` name it.
 * @param requester - The calling agent's verified home, and an optional reason.
 * @param requester.agentPath - The calling agent's verified home.
 * @param requester.reason - Why it no longer needs the answer, for the audit log.
 * @param now - The clock, for tests.
 * @returns The withdrawn request, or why it was refused.
 */
export function withdrawOwnApproval(
  db: Db,
  approvalId: string,
  requester: { agentPath: string; reason?: string },
  now: () => number = Date.now
): WithdrawResult {
  const row = db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
  if (!row) return { ok: false, code: 'not_found' };
  // A card raised with no agent's home on it (some raise paths record only a label) is nobody's
  // to take back. A home that no longer exists compares by its resolved spelling: no match.
  if (!row.requestedByPath) return { ok: false, code: 'no_requester' };
  if (realOr(row.requestedByPath) !== realOr(requester.agentPath)) {
    return { ok: false, code: 'not_yours' };
  }
  const open =
    row.state === 'pending' && !row.consumedAt && now() <= new Date(row.expiresAt).getTime();
  if (!open) return { ok: false, code: 'already_ended' };
  // The write decides the race with a person's answer and the expiry sweep: only a row still
  // waiting, and still inside its window, ends here.
  const at = new Date(now()).toISOString();
  const ended = db
    .update(approvals)
    .set({ consumedAt: at })
    .where(
      and(
        eq(approvals.id, approvalId),
        eq(approvals.state, 'pending'),
        isNull(approvals.consumedAt),
        gte(approvals.expiresAt, at)
      )
    )
    .run();
  if (ended.changes !== 1) return { ok: false, code: 'already_ended' };
  discardAgentRaise(approvalId);
  settleApproval(approvalId, 'expired');
  const title = row.capabilityTitle;
  recordAudit({
    action: 'approval.withdraw',
    operation: 'modify',
    outcome: 'ok',
    target: { type: 'approval', id: approvalId, name: title },
    change: [
      { field: 'requestedByPath', after: row.requestedByPath },
      ...(requester.reason ? [{ field: 'reason', after: requester.reason }] : []),
    ],
    summary: `${row.requestedBy ?? 'An agent'} withdrew its request: ${title}`,
  });
  return { ok: true, approvalId, title };
}
