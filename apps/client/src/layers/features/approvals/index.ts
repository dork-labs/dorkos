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
 * The same two surfaces carry standing permissions — the operator's answer to
 * "stop asking about this agent doing this thing" (spec
 * `agent-approval-settings`). {@link StandingPermissionsSettings} is the canonical
 * home in Settings under Security, and the header panel mirrors the live list
 * through {@link StandingPermissionList}. Both, because a permission a person
 * cannot find is a dark pattern.
 *
 * @module features/approvals
 */
export { PendingApprovalsSection } from './ui/PendingApprovalsSection';
export { ApprovalList } from './ui/ApprovalList';
export { ApprovalsUnavailable } from './ui/ApprovalsUnavailable';
export { usePendingApprovals } from './model/use-pending-approvals';
export { StandingPermissionList } from './ui/StandingPermissionList';
export { StandingPermissionsUnavailable } from './ui/StandingPermissionsUnavailable';
export { StandingPermissionsSettings } from './ui/StandingPermissionsSettings';
export { useStandingPermissions } from './model/use-standing-permissions';
