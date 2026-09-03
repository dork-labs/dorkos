import { Skeleton } from '@/layers/shared/ui';
import { TEAM_ROSTER_GRID } from './TeamRosterGrid';

/**
 * How many placeholder cards fill the grid while the roster loads.
 *
 * Six fills two full rows at the widest breakpoint (`xl:grid-cols-3`) without
 * scrolling — enough to read as a roster rather than a handful of tiles.
 */
const SKELETON_CARD_COUNT = 6;

/**
 * Placeholder cards shown on `/team` while the roster is still loading.
 *
 * Mirrors `TeamMemberCard`'s dimensions in `TeamRosterGrid`'s own grid, so the
 * layout does not jump when the real roster arrives — the same contract
 * `PackageLoadingSkeleton` and `SidebarSkeleton` keep for their own surfaces.
 */
export function TeamRosterSkeleton() {
  return (
    <div className={TEAM_ROSTER_GRID} aria-busy="true" aria-label="Loading the team">
      {Array.from({ length: SKELETON_CARD_COUNT }).map((_, i) => (
        <div key={i} className="bg-card shadow-soft flex items-start gap-3 rounded-lg border p-4">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </div>
  );
}
