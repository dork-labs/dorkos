/**
 * Signal is never lost by folding a section (BC-31).
 *
 * @module features/dashboard-sidebar/model/rules/roll-up-collapsed-section
 */
import type { SidebarRollup, SidebarRowModel } from '../build-sidebar-model';

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
 * **The working count is asked, not inferred** — and that is the whole of
 * `isWorking`. BC-31's text is "members currently streaming", and streaming is
 * a fact about the session. A row draws ONE mark and needs-you outranks
 * streaming on it, so a member that is both blocked and streaming presents as
 * blocked; reading the count off that mark did not merely undercount such a
 * member, it could take `workingCount` to zero, return `undefined` here, and
 * **lose the folded header's rollup entirely** — the exact thing BC-31 says
 * folding never does. A blocked-and-working agent is still working, and a
 * folded header may say both.
 *
 * The predicate is the caller's because the caller is where the truth is:
 * `buildLibrarySections` holds the snapshot and the room index, so it can put
 * an agent row's answer through `liveSessionIds` — the same list Heads up counts —
 * rather than through a status the row had already collapsed.
 *
 * A live session whose directory nothing knows is in Heads up's number and in no
 * section's, because it is a member of nothing. That is a gap in attribution,
 * not in signal: the operator is still told something is running.
 *
 * **It always answers.** It used to return `undefined` for a quiet section, so a
 * folded header said nothing at all about what was behind it. Now that every
 * header in the panel folds (D1), a size is the minimum a fold owes the person
 * who made it: "12" is what tells them the section they put away still has
 * twelve things in it. A caller that wants "nothing to say" reads the fields.
 *
 * @param rows - The section's rows, including any subsection's.
 * @param isWorking - Whether one row's subject is streaming right now,
 *   independent of the dot that row draws.
 */
export function rollUpCollapsedSection(
  rows: readonly SidebarRowModel[],
  isWorking: (row: SidebarRowModel) => boolean
): SidebarRollup {
  let unreadCount = 0;
  let anyActivity = false;
  let workingCount = 0;
  for (const row of rows) {
    if (row.unread.tier === 'directed') unreadCount += row.unread.count ?? 0;
    if (row.unread.tier === 'activity') anyActivity = true;
    if (isWorking(row)) workingCount += 1;
  }
  return {
    count: rows.length,
    unread:
      unreadCount > 0
        ? { tier: 'directed', count: unreadCount }
        : anyActivity
          ? { tier: 'activity' }
          : { tier: 'none' },
    workingCount,
  };
}
