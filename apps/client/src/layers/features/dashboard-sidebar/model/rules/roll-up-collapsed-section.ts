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
 * **The working count is the members', and the members read Now's own source.**
 * This sums row statuses, which is what makes "N agents working" a count of
 * MEMBERS rather than of sessions — but it can only ever be as true as the rows
 * are, and for a while they were not: an agent row would not call itself working
 * until the session also turned up in the last-ten REST window, so folding a
 * section 30 seconds after a turn began silently dropped the signal BC-31 says
 * folding never loses (DOR-1137, audit D5). `agentRow` now derives its status
 * from `liveSessionIds` — the same list Now counts — and this arithmetic became
 * honest without changing.
 *
 * A live session whose directory nothing knows is in Now's number and in no
 * section's, because it is a member of nothing. That is a gap in attribution,
 * not in signal: the operator is still told something is running.
 *
 * Returns `undefined` when there is nothing to say, so a caller cannot attach
 * an empty rollup that renders as a `0`.
 *
 * @param rows - The section's rows, including any subsection's.
 */
export function rollUpCollapsedSection(
  rows: readonly SidebarRowModel[]
): SidebarSectionModel['rollup'] {
  let count = 0;
  let anyActivity = false;
  let workingCount = 0;
  for (const row of rows) {
    if (row.unread.tier === 'directed') count += row.unread.count ?? 0;
    if (row.unread.tier === 'activity') anyActivity = true;
    if (row.status === 'working') workingCount += 1;
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
