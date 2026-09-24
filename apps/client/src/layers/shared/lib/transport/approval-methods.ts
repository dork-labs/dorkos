/**
 * Approvals Transport method factory (spec `agent-trust` §3.3).
 *
 * The cockpit's side of the approval primitive: read what is waiting on a
 * person, then record their decision. Decisions travel by approval id — the
 * requester's token never reaches the client.
 *
 * @module shared/lib/transport/approval-methods
 */
import type {
  ApprovalAnswer,
  ApprovalDecisionResponse,
  PendingApprovalsResponse,
} from '@dorkos/shared/approval-schemas';
import { fetchJSON } from './http-client';

/**
 * Create the approval methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createApprovalMethods(baseUrl: string) {
  return {
    listPendingApprovals(): Promise<PendingApprovalsResponse> {
      return fetchJSON(baseUrl, '/approvals/pending');
    },

    grantApproval(
      approvalId: string,
      options?: { answer?: ApprovalAnswer }
    ): Promise<ApprovalDecisionResponse> {
      return fetchJSON(baseUrl, `/approvals/${encodeURIComponent(approvalId)}/grant`, {
        method: 'POST',
        // Sent only for Always allow. An empty body is the plain one-time yes, and
        // Express 5 reads it as `undefined`, which the route already handles.
        ...(options?.answer === 'always' ? { body: JSON.stringify({ answer: 'always' }) } : {}),
      });
    },

    denyApproval(approvalId: string, reason?: string): Promise<ApprovalDecisionResponse> {
      return fetchJSON(baseUrl, `/approvals/${encodeURIComponent(approvalId)}/deny`, {
        method: 'POST',
        body: JSON.stringify(reason ? { reason } : {}),
      });
    },
  };
}
