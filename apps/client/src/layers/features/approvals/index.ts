/**
 * Approvals — the cockpit's answer to "an agent wants to do something
 * consequential" (spec `agent-trust` §3.3).
 *
 * Two surfaces show the same queue: the dashboard mounts
 * {@link PendingApprovalsSection}, and the app header carries it on every route
 * through the approvals-indicator widget, which composes the pieces below. Both
 * render the same {@link ApprovalList}, so the card a person answers is identical
 * wherever they happen to be standing.
 *
 * @module features/approvals
 */
export { PendingApprovalsSection } from './ui/PendingApprovalsSection';
export { ApprovalList } from './ui/ApprovalList';
export { ApprovalsUnavailable } from './ui/ApprovalsUnavailable';
export { usePendingApprovals } from './model/use-pending-approvals';
