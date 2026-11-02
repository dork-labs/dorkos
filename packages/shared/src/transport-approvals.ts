/**
 * The approvals slice of the {@link Transport} port (spec `agent-trust` §3.3):
 * read what is waiting on a person, read the full list behind a Marketplace
 * summary card (DOR-3070), and record their decision. Kept in its own module
 * like the other slices, so `transport.ts` does not grow.
 *
 * @module shared/transport-approvals
 */
import type {
  ApprovalAnswer,
  ApprovalDecisionResponse,
  ApprovalFullDetailResponse,
  PendingApprovalsResponse,
} from './approval-schemas.js';

/** Approvals: what waits on a person, and their answer. */
export interface ApprovalTransport {
  /**
   * List approvals an agent has requested and nobody has decided yet, oldest
   * first. Expired requests are excluded and no token material is returned.
   */
  listPendingApprovals(): Promise<PendingApprovalsResponse>;

  /**
   * Read the full list behind a pending Marketplace summary card (DOR-3070):
   * everything the approval is about, written out whole. Rejects with a 404
   * once the card can no longer be answered.
   *
   * @param approvalId - The approval's id, from {@link listPendingApprovals}.
   */
  getApprovalFullDetail(approvalId: string): Promise<ApprovalFullDetailResponse>;

  /**
   * Allow a pending approval, letting the requester spend its token once on
   * exactly the action it was granted for.
   *
   * With `answer: 'always'` it also sets that action to Allowed for the agent
   * that asked (spec `agent-permissions` D7), written through the permission
   * service before the agent is told, so the resumed call and the new setting
   * agree. Refused outright (409 `ALWAYS_NOT_OFFERED`) where the card's
   * `alwaysOffered` is false, rather than quietly downgraded to a one-time yes.
   *
   * @param approvalId - The approval's id, from {@link listPendingApprovals}.
   * @param options - `answer`: `'once'` (default) or `'always'`.
   */
  grantApproval(
    approvalId: string,
    options?: { answer?: ApprovalAnswer }
  ): Promise<ApprovalDecisionResponse>;

  /**
   * Refuse a pending approval.
   *
   * @param approvalId - The approval's id, from {@link listPendingApprovals}.
   * @param reason - Optional note the requester sees instead of a bare refusal.
   */
  denyApproval(approvalId: string, reason?: string): Promise<ApprovalDecisionResponse>;

  /**
   * "Not now" on a card that suggests Always allow: the suggestion never comes
   * back for this agent and action. Only a person can call this.
   *
   * @param approvalId - The approval whose card suggested it.
   */
  dismissAlwaysSuggestion(approvalId: string): Promise<{ ok: true; approvalId: string }>;
}
