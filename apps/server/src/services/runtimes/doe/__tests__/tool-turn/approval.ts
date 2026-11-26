import { ApprovalService, hashApprovalInput } from '../../../../core/approvals/index.js';
import { awaitCapabilityApproval } from '../../../../core/capabilities/capability-approval-hold.js';
import type { RuntimeToolTurnFacts } from '../../../../core/connections-lease/index.js';
import type { toolTurnFixture } from './fixture.js';

const pending: Array<{ approvals: ApprovalService; id: string; held: Promise<unknown> }> = [];

/** Real approval producer on the actual caller's queue and cancellation signal. */
export function hold(
  f: Awaited<ReturnType<typeof toolTurnFixture>>,
  facts: RuntimeToolTurnFacts,
  subject: string
) {
  const approvals = new ApprovalService(f.db);
  const ticket = approvals.request({
    capabilityId: 'test.update',
    inputHash: hashApprovalInput({ subject }),
    summary: 'Owned approval',
    requestingSession: { sessionId: 's1', cwd: f.desk },
  });
  const held = awaitCapabilityApproval(
    { approvals, session: facts.session, signal: facts.signal },
    {
      status: 'approval_required',
      capabilityId: 'test.update',
      capabilityTitle: 'Owned approval',
      tier: 'destructive',
      approvalId: ticket.approvalId,
      approvalToken: ticket.token,
      expiresAt: ticket.expiresAt,
      reason: 'no_approval',
      message: 'Approval required.',
      retry: { channel: 'mcp-argument', field: 'approvalToken', instructions: 'Retry.' },
    }
  );
  pending.push({ approvals, id: ticket.approvalId, held });
  return { approvals, ticket, held };
}

/** Drain test-owned waits even when an intentionally broken lifetime fails an assertion. */
export async function settleHolds(): Promise<void> {
  const errors: unknown[] = [];
  for (const entry of pending.splice(0)) {
    try {
      entry.approvals.deny(entry.id);
      await entry.held;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Owned approval cleanup failed');
}
