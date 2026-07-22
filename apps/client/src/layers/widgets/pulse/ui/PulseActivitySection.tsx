import { useNavigate } from '@tanstack/react-router';
import { getPlatform } from '@/layers/shared/lib';
import { useSafePathname } from '@/layers/shared/model';
import { Button, Table, TableBody } from '@/layers/shared/ui';
import { useDashboardActivity } from '@/layers/features/dashboard-activity';
import { ActivityRow } from '@/layers/features/activity-feed-page';
import { PulseSection } from './PulseSection';

/** Max activity rows shown in the Pulse teaser (the full stream lives at /activity). */
const PULSE_ACTIVITY_CAP = 5;

/**
 * The "Activity" section of the Pulse panel: a short, most-recent-first teaser of
 * recent agent activity, reusing the dashboard's {@link useDashboardActivity}
 * model and the {@link ActivityRow} rendering. Per the research's state-vs-history
 * split (Linear), this is a capped peek — "Open activity →" leads to the full,
 * filterable history stream at /activity. Collapses to a calm all-clear line when
 * there is nothing recent.
 */
export function PulseActivitySection() {
  const navigate = useNavigate();
  // "Open activity" navigates to /activity. Omit the link when it would be a
  // no-op (already there) and in the router-less Obsidian embed, where there is
  // no activity route to reach — an honest omission, not a dead-end button.
  const pathname = useSafePathname();
  const showOpenActivity = !getPlatform().isEmbedded && pathname !== '/activity';
  const { groups, isLoading } = useDashboardActivity();

  // Flatten the time-bucketed groups back into one most-recent-first list and cap
  // it. The dashboard groups by Today/Yesterday/… for scanning; Pulse wants a
  // tight teaser, so it drops the buckets and shows just the newest few.
  const items = groups.flatMap((g) => g.items).slice(0, PULSE_ACTIVITY_CAP);

  return (
    <PulseSection
      label="Activity"
      // Only declare all-clear once the query has resolved to genuinely nothing —
      // never mid-load, which would flash the all-clear before data arrives.
      empty={!isLoading && items.length === 0}
      allClear="No recent activity."
      action={
        showOpenActivity ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => navigate({ to: '/activity' })}
          >
            Open activity →
          </Button>
        ) : undefined
      }
    >
      <Table>
        <TableBody>
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))}
        </TableBody>
      </Table>
    </PulseSection>
  );
}
