/**
 * Dashboard activity feature — time-grouped event feed with last-visit tracking.
 * Aggregates session and Pulse events into Today/Yesterday/Last 7 days groups.
 *
 * @module features/dashboard-activity
 */
export { RecentActivityFeed } from './ui/RecentActivityFeed';
export { useActivityFeed } from './model/use-activity-feed';
export { useLastVisited } from './model/use-last-visited';
export type { ActivityEvent, ActivityGroup } from './model/use-activity-feed';
