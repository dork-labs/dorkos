/**
 * Who in a room is holding work the room has not got (spec `project-rooms`
 * §3.9).
 *
 * The reduction from what `room_repo_status` answers to what the explorer draws,
 * kept out of the component so it can be tested as the arithmetic it is. It is
 * arithmetic worth pinning: a badge that under-reports is a badge that lets work
 * sit unmerged forever, and one that over-reports is a badge people stop reading.
 *
 * @module features/file-explorer/model/pending-work
 */
import type { RoomRepoStatus } from '@dorkos/shared/room-repo';

/** One thing in a room's files that somebody has not merged yet. */
export interface PendingWork {
  /** The working copy's directory name, unique within the room. */
  slug: string;
  /**
   * Who it belongs to, as a person would say it: the agent's display name, or
   * the working copy's own name when no current member maps to it.
   */
  who: string;
  /**
   * Whether a current member of this room owns it.
   *
   * `false` is not an error state. An agent that was renamed, or whose workspace
   * moved, or that left the room, leaves its working copy behind — and the work
   * in it is still somebody's, which is exactly why the reap never removes it.
   */
  member: boolean;
  /** Commits on the branch that the room does not have. */
  ahead: number;
  /** Whether the working copy holds changes nobody committed. */
  dirty: boolean;
}

/**
 * How one row reads in a sentence: what is actually unmerged about it.
 *
 * Both halves are said when both are true, because they need different things
 * done about them: committed work is one merge away, and uncommitted work has to
 * be committed first.
 *
 * @param work - The row.
 */
export function pendingWorkSummary(work: PendingWork): string {
  const parts: string[] = [];
  if (work.ahead > 0) {
    parts.push(work.ahead === 1 ? '1 commit not merged' : `${work.ahead} commits not merged`);
  }
  if (work.dirty) parts.push('changes not committed');
  // Neither is the case a caller should reach — `pendingWorkIn` only returns
  // rows where one of them holds — except for a working copy nobody could read,
  // which is counted as work precisely because nothing knows what is in it.
  if (parts.length === 0) return 'work the room has not got';
  return parts.join(', ');
}

/**
 * Everything in this room's files that has not reached the room, in roster
 * order, with the working copies belonging to nobody after them.
 *
 * **Two sources, deliberately not reconciled.** `branches` walks the roster and
 * `strandedWorktrees` walks the directories on disk, so each sees something the
 * other cannot: a branch whose working copy the reap removed appears only in the
 * first, and a working copy belonging to nobody on the roster appears only in
 * the second. Merging them by slug keeps both visible while showing each
 * working copy once — which is what the person needs, since either kind is work
 * that will sit there until somebody deals with it.
 *
 * @param status - What the room's files answered.
 * @returns One row per working copy holding unmerged work, empty when none is.
 */
export function pendingWorkIn(status: RoomRepoStatus): PendingWork[] {
  const rows = new Map<string, PendingWork>();
  for (const branch of status.branches) {
    if (!branch.stranded) continue;
    rows.set(branch.slug, {
      slug: branch.slug,
      who: branch.agent,
      member: true,
      ahead: branch.ahead,
      dirty: branch.dirty,
    });
  }
  for (const slug of status.strandedWorktrees) {
    if (rows.has(slug)) continue;
    // Named by its directory, because that is the only name left: whoever this
    // belonged to is not on the roster any more. The counts are unknown from
    // here — this list says a tree holds something, not what — so they are
    // reported as zero rather than guessed at, and `pendingWorkSummary` says the
    // honest general thing for that row.
    rows.set(slug, { slug, who: slug, member: false, ahead: 0, dirty: false });
  }
  return [...rows.values()];
}

/**
 * How each row is named on screen: the display name, or the display name and
 * enough of its working copy to tell it from another row spelling itself the
 * same way.
 *
 * **Display names are not unique, and the badge's whole job is telling people
 * apart.** Two agents called "Claude", or a live agent beside the abandoned
 * working copy of its earlier self, would otherwise render as "Claude, Claude" —
 * which reads as a rendering bug and answers nobody's question. A slug ends in
 * the digest of the agent's workspace path, so its tail is the one thing that
 * genuinely differs.
 *
 * Only the colliding rows are marked. A room where every name is distinct reads
 * exactly as it did, because the disambiguation is bought only where it is
 * needed.
 *
 * @param pending - The rows from {@link pendingWorkIn}.
 * @returns The display string for each row, in the same order.
 */
export function pendingWorkNames(pending: PendingWork[]): string[] {
  const seen = new Map<string, number>();
  for (const work of pending) seen.set(work.who, (seen.get(work.who) ?? 0) + 1);
  return pending.map((work) =>
    (seen.get(work.who) ?? 0) > 1 ? `${work.who} (${work.slug.slice(-4)})` : work.who
  );
}

/**
 * The one line the badge shows, or `null` when there is nothing to say.
 *
 * Names are spelled out up to three, then counted: a room with eight agents mid
 * sprint would otherwise put a paragraph in a panel header, and past three names
 * the number is the part a person acts on.
 *
 * @param pending - The rows from {@link pendingWorkIn}.
 */
export function pendingWorkLabel(pending: PendingWork[]): string | null {
  if (pending.length === 0) return null;
  const names = pendingWorkNames(pending);
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}
