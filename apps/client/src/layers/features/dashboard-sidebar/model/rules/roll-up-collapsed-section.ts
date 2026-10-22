/**
 * Signal is never lost by folding a section (BC-31).
 *
 * @module features/dashboard-sidebar/model/rules/roll-up-collapsed-section
 */
import type { SidebarRollup, SidebarRowModel } from '../build-sidebar-model';
import type { SidebarState } from '../sidebar-state';
import { blockedSessionIdsForPath } from './live-sessions';

/**
 * Whether one row's subject is waiting on the operator — what keeps a row on
 * screen when its section is folded, beside unread (DOR-3224).
 *
 * **The same fact the row's needs-you dot is drawn from**: a session of that
 * agent is `blocked` on an approval or a question, automated runs included
 * (BC-19). **Muted rows included** (DOR-3236): mute silences chatter, never
 * a request, so a muted agent waiting on you keeps its needs-you dot and stays
 * on screen when folded. Only an agent row can answer yes: a room row carries
 * no needs-you fact yet.
 *
 * @param state - The snapshot.
 */
export function rowNeedsYou(state: SidebarState): (row: SidebarRowModel) => boolean {
  return (row) =>
    row.target.kind === 'agent' && blockedSessionIdsForPath(state, row.target.path).length > 0;
}

/**
 * What a folded section still shows: the rows that are asking for the
 * operator, how many rows it hides, and whether any of its members are working.
 *
 * **Rows, not unread counts.** A folded header used to say "12 · 3 unread",
 * which put an unread number on a header and made the reader unfold the section
 * to learn what the number was about. Now the header never carries one: a folded
 * section keeps its unread rows on screen beneath it, each one drawn exactly
 * as it is when the section is open — bold, with its own count pill where
 * something was aimed at you. Folding hides what is quiet and nothing else,
 * which is what "folding never loses signal" asks for.
 *
 * **A row waiting on you stays too** (DOR-3224). An agent with an approval or
 * a question pending and nothing unread used to fold away, so the one row that
 * most needed the operator was the one the fold hid. It is kept like an unread
 * row: drawn as it is when the section is open, in its own place, and left out
 * of the hidden count.
 *
 * **The one number it does carry is what is hidden** (DOR-3200). With no hint,
 * a folded section showing two unread rows read as an open section that had
 * lost its other ten, so the header says "· 10 more" — a count of rows, not
 * of unread, and nothing at all when the fold hides nothing.
 *
 * **The working count is asked, not inferred** — and that is the whole of
 * `isWorking`. BC-31's text is "members currently streaming", and streaming is
 * a fact about the session. A row draws ONE mark and needs-you outranks
 * streaming on it, so a member that is both blocked and streaming presents as
 * blocked; reading the count off that mark could take it to zero and lose the
 * folded header's working dot. A blocked-and-working agent is still working.
 *
 * The predicate is the caller's because the caller is where the truth is:
 * `buildSections` holds the snapshot and the room index, so it can put an agent
 * row's answer through `liveSessionIds` rather than through a status the row
 * had already collapsed.
 *
 * @param rows - The section's rows, in order.
 * @param isWorking - Whether one row's subject is streaming right now,
 *   independent of the dot that row draws.
 * @param needsYou - Whether one row's subject is waiting on the operator: the
 *   same fact as the needs-you dot that row draws when its section is open.
 */
export function rollUpCollapsedSection(
  rows: readonly SidebarRowModel[],
  isWorking: (row: SidebarRowModel) => boolean,
  needsYou: (row: SidebarRowModel) => boolean
): SidebarRollup {
  const keptRows: SidebarRowModel[] = [];
  let workingCount = 0;
  for (const row of rows) {
    // A kept row is not a drag source: its section is folded, so there is
    // nowhere in it to drop, and a drag that starts there has no list to land in.
    const kept = row.unread.tier !== 'none' || needsYou(row);
    if (kept) keptRows.push(row.draggable ? { ...row, draggable: false } : row);
    if (isWorking(row)) workingCount += 1;
  }
  return { keptRows, workingCount, hiddenCount: rows.length - keptRows.length };
}
