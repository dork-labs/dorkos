/**
 * Signal is never lost by folding a section (BC-31).
 *
 * @module features/dashboard-sidebar/model/rules/roll-up-collapsed-section
 */
import type { SidebarRollup, SidebarRowModel } from '../build-sidebar-model';

/**
 * Whether a folded section keeps a row on screen: by default, any row with
 * unread of either tier.
 *
 * @param row - One row of the section.
 */
function hasUnreadSignal(row: SidebarRowModel): boolean {
  return row.unread.tier !== 'none';
}

/**
 * What a folded section still shows: the rows that are asking for the
 * operator, and whether any of its members are working.
 *
 * **Rows, not counts.** A folded header used to say "12 · 3 unread", which put
 * a number on a header and made the reader unfold the section to learn what
 * the number was about. Now the header never carries a count: a folded
 * section keeps its unread rows on screen beneath it, each one drawn exactly
 * as it is when the section is open — bold, with its own count pill where
 * something was aimed at you. Folding hides what is quiet and nothing else,
 * which is what "folding never loses signal" asks for.
 *
 * **What counts as asking is the caller's to say, and it defaults to unread.**
 * Heads up passes its own rule: its rows need the operator by definition, and
 * none of them carries an unread tier, so the unread default would let folding
 * it hide a permission prompt — the one thing it must never do.
 *
 * **The working count is asked, not inferred** — and that is the whole of
 * `isWorking`. BC-31's text is "members currently streaming", and streaming is
 * a fact about the session. A row draws ONE mark and needs-you outranks
 * streaming on it, so a member that is both blocked and streaming presents as
 * blocked; reading the count off that mark could take it to zero and lose the
 * folded header's working dot. A blocked-and-working agent is still working.
 *
 * The predicate is the caller's because the caller is where the truth is:
 * `buildLibrarySections` holds the snapshot and the room index, so it can put
 * an agent row's answer through `liveSessionIds` — the same list Heads up
 * counts — rather than through a status the row had already collapsed.
 *
 * @param rows - The section's rows, in order.
 * @param isWorking - Whether one row's subject is streaming right now,
 *   independent of the dot that row draws.
 * @param keeps - Whether a folded section keeps this row on screen. Defaults
 *   to any row with unread.
 */
export function rollUpCollapsedSection(
  rows: readonly SidebarRowModel[],
  isWorking: (row: SidebarRowModel) => boolean,
  keeps: (row: SidebarRowModel) => boolean = hasUnreadSignal
): SidebarRollup {
  const keptRows: SidebarRowModel[] = [];
  let workingCount = 0;
  for (const row of rows) {
    // A kept row is not a drag source: its section is folded, so there is
    // nowhere in it to drop, and a drag that starts there has no list to land in.
    if (keeps(row)) keptRows.push(row.draggable ? { ...row, draggable: false } : row);
    if (isWorking(row)) workingCount += 1;
  }
  return { keptRows, workingCount };
}
