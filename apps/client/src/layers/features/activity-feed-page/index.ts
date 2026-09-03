/**
 * Activity feed page feature — hooks and utilities for the full-page
 * activity feed at /activity.
 *
 * Provides infinite-scroll data fetching, URL-synced filter state,
 * localStorage-based last-visit tracking, and time-based grouping.
 *
 * @module features/activity-feed-page
 */

// Data fetching
export { useFullActivityFeed, ACTIVITY_QUERY_KEY } from './model/use-full-activity-feed';

// Filter state
export {
  useActivityFilters,
  type ActivityFilters,
  type UseActivityFiltersReturn,
} from './model/use-activity-filters';

// Last-visit tracking
export { useLastVisitedActivity } from './model/use-last-visited-activity';

// Keyboard navigation
export { useActivityKeyboardNav } from './model/use-activity-keyboard-nav';

// Time grouping
export {
  groupByTime,
  getTimeGroupLabel,
  type ActivityGroup,
  type TimeGroupLabel,
} from './model/time-grouping';

// UI components
export { ActivityRow, formatActivityTime } from './ui/ActivityRow';
export type { ActivityRowProps } from './ui/ActivityRow';
export { ActivityGroupHeader } from './ui/ActivityGroupHeader';
export type { ActivityGroupHeaderProps } from './ui/ActivityGroupHeader';
export { ActivityFilterBar } from './ui/ActivityFilterBar';
export type { ActivityFilterBarProps } from './ui/ActivityFilterBar';
export { ActivityEmptyState } from './ui/ActivityEmptyState';
export type { ActivityEmptyStateProps } from './ui/ActivityEmptyState';
export { ActivityErrorState } from './ui/ActivityErrorState';
export type { ActivityErrorStateProps } from './ui/ActivityErrorState';
export { ActivitySinceLastVisit } from './ui/ActivitySinceLastVisit';
export type { ActivitySinceLastVisitProps } from './ui/ActivitySinceLastVisit';
