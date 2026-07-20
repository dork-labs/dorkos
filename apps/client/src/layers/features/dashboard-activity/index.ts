/**
 * Dashboard activity feature — recent activity feed backed by the server API.
 * Renders a compact preview of the full activity feed at /activity.
 *
 * @module features/dashboard-activity
 */
export { RecentActivityFeed } from './ui/RecentActivityFeed';
export { useDashboardActivity, DASHBOARD_ACTIVITY_QUERY_KEY } from './model/use-activity-feed';
export type { DashboardActivityGroup } from './model/use-activity-feed';
