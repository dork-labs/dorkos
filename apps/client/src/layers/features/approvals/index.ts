/**
 * Approvals — the cockpit's answer to "an agent wants to do something
 * consequential" (spec `agent-trust` §3.3).
 *
 * Two surfaces show the same queue: the home tab's pinned triage header, and
 * the app header, which carries it on every route through the
 * approvals-indicator widget. Both compose the pieces below and render the same
 * {@link ApprovalList}, so the card a person answers is identical wherever they
 * happen to be standing.
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
export { ApprovalList } from './ui/ApprovalList';
// The single approval card, exported so the chat transcript can render an
// agent's held destructive capability call inline (DOR-939) — the same card a
// person answers on the home tab, resolving the same approval.
export { ApprovalCard } from './ui/ApprovalCard';
export { ApprovalsUnavailable } from './ui/ApprovalsUnavailable';
// The queue itself lives in `entities/attention` now: the sidebar's Now zone
// needs the same list, and a feature may not import a sibling feature's model.
// Re-exported here so every existing surface keeps its one import.
export { usePendingApprovals } from '@/layers/entities/attention';
export { StandingPermissionList } from './ui/StandingPermissionList';
export { StandingPermissionsUnavailable } from './ui/StandingPermissionsUnavailable';
export { StandingPermissionsSettings } from './ui/StandingPermissionsSettings';
export { AutonomyAcknowledgementRow } from './ui/AutonomyAcknowledgementRow';
export { useStandingPermissions } from './model/use-standing-permissions';
