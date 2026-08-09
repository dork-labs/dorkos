/**
 * Today ends at 4am — what the operator has not touched since then leaves the
 * zone (BC-18).
 *
 * @module features/dashboard-sidebar/model/rules/archive-overnight
 */
import type { SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { lastInteractionAt } from './order-today';

/**
 * The hour a day turns over for a person who works late.
 *
 * Not midnight: somebody still going at 1am is having yesterday, and a sidebar
 * that empties itself under them at 00:00 is arguing with them about it.
 */
export const OVERNIGHT_BOUNDARY_HOUR = 4;

/**
 * The most recent 04:00 local that has already passed, epoch ms.
 *
 * Local rather than UTC, and computed from `now` rather than read from a clock,
 * so the boundary is a pure function of the snapshot and a test can walk it
 * across a day without mocking time. `new Date(now)` reads the host timezone,
 * which is what "04:00 local" means; no `Intl` and no implicit timezone appear
 * anywhere in this module.
 *
 * @param now - The instant to reason from, epoch ms.
 */
export function overnightBoundary(now: number): number {
  const date = new Date(now);
  const boundary = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    OVERNIGHT_BOUNDARY_HOUR,
    0,
    0,
    0
  );
  if (boundary.getTime() > now) boundary.setDate(boundary.getDate() - 1);
  return boundary.getTime();
}

/** What {@link archiveOvernight} must keep whatever the clock says. */
export interface ArchiveExemptions {
  /** The anchor's row key — where the operator is standing right now. */
  anchorKey?: string;
}

/**
 * Today's rows with the quiet ones from before the boundary removed.
 *
 * **Archival is a visibility rule and deletes nothing.** An archived row is
 * still findable in ⌘K by title and recency; what it loses is the claim on
 * eight lines of the panel that "today" makes.
 *
 * Two things are exempt. The anchor, because the conversation the operator has
 * open cannot be yesterday's business. And any row carrying a directed unread,
 * because somebody addressed them by name and the clock is not a reason to hide
 * it.
 *
 * Rows with no interaction timestamp at all — the automated reveal, anything
 * the operator has never opened — are left alone: this rule removes what has
 * gone stale, and something that was never touched has no staleness to measure.
 *
 * @param rows - Today's rows.
 * @param state - The snapshot.
 * @param exemptions - What must survive regardless.
 */
export function archiveOvernight(
  rows: readonly SidebarRowModel[],
  state: SidebarState,
  exemptions: ArchiveExemptions = {}
): SidebarRowModel[] {
  const boundary = overnightBoundary(state.now);
  return rows.filter((row) => {
    if (row.key === exemptions.anchorKey) return true;
    if (row.unread.tier === 'directed') return true;
    const at = lastInteractionAt(row, state);
    if (at === null) return true;
    return at >= boundary;
  });
}
