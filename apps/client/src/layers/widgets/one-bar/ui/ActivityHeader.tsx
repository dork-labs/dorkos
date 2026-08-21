import { ActivityFilterBar } from '@/layers/features/activity-feed-page';
import { BarTitle, OneBar } from './OneBar';

/**
 * `/activity` route bar — page title and category filter bar.
 *
 * The filters live in the bar for now. Phase H1 moves them into the page's
 * first content row, the way `/tasks` already does it.
 */
export function ActivityHeader() {
  return <OneBar identity={<BarTitle>Activity</BarTitle>} fill={<ActivityFilterBar />} />;
}
