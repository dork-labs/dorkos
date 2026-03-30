import { ActivityFilterBar } from '@/layers/features/activity-feed-page';
import { PageHeader } from './PageHeader';

/**
 * Activity route header — page title and category filter bar.
 * Rendered in the AppShell top bar when the /activity route is active.
 */
export function ActivityHeader() {
  return (
    <PageHeader title="Activity">
      <ActivityFilterBar />
    </PageHeader>
  );
}
