/**
 * Signal is never lost by folding a section (BC-31).
 *
 * @module features/dashboard-sidebar/model/rules/roll-up-collapsed-section
 */
import type { SidebarRowModel, SidebarSectionModel } from '../build-sidebar-model';

/**
 * What a folded section still says: how many messages were aimed at the
 * operator inside it, and how many of its members are working.
 *
 * **The tiers do not add up into each other.** The badge counts tier-2 only —
 * a numbered badge means "this many things were addressed to you", and folding
 * a channel with four hundred unread messages must not produce a 400. The
 * `'activity'` tier survives as a bold header when any member has ordinary
 * unread and none has directed unread, which is the same two-tier rule a row
 * follows.
 *
 * **The working count is asked, not read off the dot** — and that is the whole
 * of `isWorking`. A row draws ONE status, and `deriveRowStatus` ranks
 * `needs-you` above `streaming`, so an agent that is both blocked and streaming
 * reports `needs-you`. Counting `status === 'working'` therefore did not merely
 * undercount such a member: with nothing else set in the section, `workingCount`
 * fell to zero, this function returned `undefined`, and **the folded header lost
 * its rollup entirely** — the exact thing BC-31 says folding never does. BC-31's
 * text is "members currently streaming", and streaming is a fact about the
 * session, not a slot in a dot's priority order. A blocked-and-working agent is
 * still working, and a folded header may say both.
 *
 * The predicate is the caller's because the caller is where the truth is:
 * `buildLibrarySections` holds the snapshot and the room index, so it can put
 * an agent row's answer through `liveSessionIds` — the same list Now counts —
 * rather than through a status the row had already collapsed.
 *
 * A live session whose directory nothing knows is in Now's number and in no
 * section's, because it is a member of nothing. That is a gap in attribution,
 * not in signal: the operator is still told something is running.
 *
 * Returns `undefined` when there is nothing to say, so a caller cannot attach
 * an empty rollup that renders as a `0`.
 *
 * @param rows - The section's rows, including any subsection's.
 * @param isWorking - Whether one row's subject is streaming right now,
 *   independent of the dot that row draws.
 */
export function rollUpCollapsedSection(
  rows: readonly SidebarRowModel[],
  isWorking: (row: SidebarRowModel) => boolean
): SidebarSectionModel['rollup'] {
  let count = 0;
  let anyActivity = false;
  let workingCount = 0;
  for (const row of rows) {
    if (row.unread.tier === 'directed') count += row.unread.count ?? 0;
    if (row.unread.tier === 'activity') anyActivity = true;
    if (isWorking(row)) workingCount += 1;
  }
  if (count === 0 && !anyActivity && workingCount === 0) return undefined;
  return {
    unread:
      count > 0
        ? { tier: 'directed', count }
        : anyActivity
          ? { tier: 'activity' }
          : { tier: 'none' },
    workingCount,
  };
}
