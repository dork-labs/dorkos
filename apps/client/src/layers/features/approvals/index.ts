/**
 * Approvals — the cockpit's answer to "an agent wants to do something
 * consequential" (spec `agent-trust` §3.3).
 *
 * @module features/approvals
 */
export { PendingApprovalsSection } from './ui/PendingApprovalsSection';
export { ApprovalCard, type ApprovalCardProps } from './ui/ApprovalCard';
export {
  usePendingApprovals,
  PENDING_APPROVALS_QUERY_KEY,
  type PendingApprovalsState,
} from './model/use-pending-approvals';
export { useGrantApproval, useDenyApproval } from './model/use-approval-decision';
