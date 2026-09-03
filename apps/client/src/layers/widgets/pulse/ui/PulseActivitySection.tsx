import { useNavigate } from '@tanstack/react-router';
import { getPlatform } from '@/layers/shared/lib';
import { useIsMobile, useSafePathname } from '@/layers/shared/model';
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
 *
 * **Except on /activity itself with the panel docked beside it, where it draws
 * nothing.** A teaser exists to point at a place you are not; beside the full
 * feed it showed the same rows at the same timestamps, twice on one screen,
 * and spent a quarter of the panel saying nothing (DOR-1759). That condition
 * is geometry, not just route: on a narrow viewport the panel is a slide-over
 * Sheet that COVERS /activity rather than sitting beside it
 * (`RightPanelContainer`), so there the feed underneath is not on screen and
 * the teaser still draws.
 */
export function PulseActivitySection() {
  const navigate = useNavigate();
  // "Open activity" navigates to /activity. Omitted in the router-less Obsidian
  // embed, where there is no activity route to reach — an honest omission, not a
  // dead-end button. On /activity the whole section is gone, so the link has no
  // second way to be a no-op.
  const pathname = useSafePathname();
  const showOpenActivity = !getPlatform().isEmbedded;
  // The de-dup below only holds when the panel is actually DOCKED beside the
  // feed it is de-duping — on a narrow viewport it is a slide-over Sheet that
  // covers /activity instead (`RightPanelContainer`).
  const isMobile = useIsMobile();
  const { groups, isLoading } = useDashboardActivity();

  // Beside the feed itself, this section is the feed again. Say nothing — but
  // only where the panel is genuinely beside it (see the mobile note above).
  if (pathname === '/activity' && !isMobile) return null;

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
