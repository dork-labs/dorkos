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
  DeclinedHookApprovalsResponse,
  ApprovalAnswer,
  ApprovalDecisionResponse,
  ApprovalFullDetailResponse,
  PendingApprovalsResponse,
} from '@dorkos/shared/approval-schemas';
import { createTransportApiClient } from './api-client';

/**
 * Create the approval methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createApprovalMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async listDeclinedHookApprovals(): Promise<DeclinedHookApprovalsResponse> {
      return api.call('approvals.getDeclinedHooks', {});
    },
    async askAgainHookApproval(approvalId: string): Promise<{ ok: true; approvalId: string }> {
      return (await api.call('approvals.createAskAgain', { path: { id: approvalId } })) as {
        ok: true;
        approvalId: string;
      };
    },
    async listPendingApprovals(): Promise<PendingApprovalsResponse> {
      return api.call('approvals.getPending', {});
    },

    async getApprovalFullDetail(approvalId: string): Promise<ApprovalFullDetailResponse> {
      return api.call('approvals.getFullDetail', { path: { id: approvalId } });
    },

    async grantApproval(
      approvalId: string,
      options?: { answer?: ApprovalAnswer }
    ): Promise<ApprovalDecisionResponse> {
      return api.call('approvals.createGrant', {
        path: { id: approvalId },
        // Sent only for Always allow. No body is the plain one-time yes, which
        // the route already handles.
        ...(options?.answer === 'always' ? { body: { answer: 'always' as const } } : {}),
      });
    },

    async denyApproval(approvalId: string, reason?: string): Promise<ApprovalDecisionResponse> {
      return api.call('approvals.deny', {
        path: { id: approvalId },
        body: reason ? { reason } : {},
      });
    },

    async dismissAlwaysSuggestion(approvalId: string): Promise<{ ok: true; approvalId: string }> {
      return (await api.call('approvals.createDismissSuggestion', {
        path: { id: approvalId },
      })) as { ok: true; approvalId: string };
    },
  };
}
