/**
 * The "Needs attention" area of the home surface and the Pulse panel — its rows
 * and its detail sheets.
 *
 * **The heuristics that used to live here are gone.** This slice held a second
 * attention engine (`useAttentionItems`) with its own idea of what needs a
 * person — one that disagreed with `entities/attention`, the sidebar's engine,
 * about both the rules and the items. DOR-1381 deleted it. Membership now comes
 * from `entities/attention` alone; what is left here is the drawing, plus the
 * three "something went wrong" rows that were never blockages and are waiting
 * for the Inbox to absorb them (DOR-1384).
 *
 * @module features/dashboard-attention
 */
export { AttentionSignalRow } from './ui/AttentionSignalRow';
export { RecentActivityRow } from './ui/RecentActivityRow';
export { ScheduleApprovalRow } from './ui/ScheduleApprovalRow';
export { useAttentionRows } from './model/use-attention-rows';
export type { AttentionRows } from './model/use-attention-rows';
export { useRecentActivityItems } from './model/use-recent-activity-items';
export type { RecentActivityItem, RecentActivityState } from './model/use-recent-activity-items';
export { DeadLetterDetailSheet } from './ui/DeadLetterDetailSheet';
export { FailedRunDetailSheet } from './ui/FailedRunDetailSheet';
export { OfflineAgentDetailSheet } from './ui/OfflineAgentDetailSheet';
