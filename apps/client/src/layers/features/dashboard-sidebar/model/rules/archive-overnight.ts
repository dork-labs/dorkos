/**
 * Today ends at 4am — what the operator has not touched since then leaves the
 * zone (BC-18).
 *
 * @module features/dashboard-sidebar/model/rules/archive-overnight
 */
// A deep import into `shared/lib`, deliberately: this module is covered by a
// source-level purity contract that forbids value-importing the `shared/lib`
// barrel, which drags in the transport and every other side effect behind it.
// The leaf module imports nothing at all. Same shape `SessionCommandItem` uses
// to reach `row-grammar`, and for the same reason.
import { overnightBoundary } from '@/layers/shared/lib/overnight-boundary';
import type { SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { lastInteractionAt } from './order-today';

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
