/**
 * The approval primitive — one mechanism for "ask the person first"
 * (spec `agent-trust` §3.3).
 *
 * @module services/core/approvals
 */
export {
  ApprovalService,
  APPROVAL_TTL_MS,
  initApprovalService,
  getApprovalService,
  resetApprovalService,
  type ApprovalRequestInput,
  type ApprovalTicket,
  type ApprovalBinding,
  type ApprovalConsumeResult,
  type ApprovalDecisionFailure,
} from './approval-service.js';
export { hashApprovalInput } from './approval-input-hash.js';
export { broadcastApprovalPending, broadcastApprovalResolved } from './approval-events.js';
