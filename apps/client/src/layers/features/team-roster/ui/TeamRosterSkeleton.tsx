import { Skeleton } from '@/layers/shared/ui';
import { TEAM_ROSTER_GRID } from './TeamRosterGrid';

/**
 * How many placeholder cards fill the grid while the roster loads, by
 * default.
 *
 * Six fills two full rows at the widest breakpoint (`xl:grid-cols-3`) without
 * scrolling — enough to read as a roster rather than a handful of tiles. At
 * narrower breakpoints the same six cards are more rows, and do scroll; the
 * count is a fixed default rather than a per-breakpoint one because the
 * roster itself has no concept of "how many fit," and a caller who does can
 * override it via `count`, the same escape hatch `PackageLoadingSkeleton`
 * exposes for its grid.
 */
const SKELETON_CARD_COUNT = 6;

export interface TeamRosterSkeletonProps {
  /** How many placeholder cards to draw. Defaults to `SKELETON_CARD_COUNT`. */
  count?: number;
}

/**
 * Placeholder cards shown in place of the roster grid on `/team` while it is
 * still loading.
 *
 * Rendered where `TeamRosterGrid` would be — never as a stand-in for the
 * whole page — so the toolbar and any warnings above it stay mounted through
 * the load and only the roster itself appears underneath them, the same
 * contract `PackageLoadingSkeleton` keeps for `PackageGrid`.
 *
 * Each bone stack mirrors the three lines a `TeamMemberCard` draws most
 * often — name, handle, and the "what is true of this identity" line — so a
 * card's height does not visibly grow when the real content replaces it. It
 * is an approximation, not a promise: a real card can carry more lines still
 * (name provenance, "Active in the last hour," an owner attribution), so some
 * cards do gain a line or two once the roster lands.
 */
export function TeamRosterSkeleton({ count = SKELETON_CARD_COUNT }: TeamRosterSkeletonProps = {}) {
  return (
    <div className={TEAM_ROSTER_GRID} aria-busy="true" aria-label="Loading the team">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-card shadow-soft flex items-start gap-3 rounded-lg border p-4">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      ))}
    </div>
  );
}
