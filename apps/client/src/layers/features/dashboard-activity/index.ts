/**
 * Recent activity, grouped into time buckets — the model behind Pulse's
 * activity section, backed by the same server API the `/activity` tab reads.
 *
 * The dashboard's 15-item preview of it was retired with the dashboard itself
 * (team-room-home spec D3.5): the Activity tab IS that list, in full.
 *
 * @module features/dashboard-activity
 */
// No `DashboardActivityGroup` here: the type is inferred at every call site
// (Pulse destructures `groups` and maps it), and the one consumer that ever
// named it was the dashboard's preview, deleted with the dashboard.
export { useDashboardActivity, DASHBOARD_ACTIVITY_QUERY_KEY } from './model/use-activity-feed';
