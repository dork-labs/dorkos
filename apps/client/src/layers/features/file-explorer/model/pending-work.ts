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
import type { Transport } from '@dorkos/shared/transport';
import type { RoomRepoStatus } from '@dorkos/shared/room-repo';
import { roomKeys } from '@/layers/entities/room';
import { errorCodeOf, ROOM_HAS_NO_REPO_CODE } from '../lib/error-code';

/**
 * What asking a room where its files stand can turn out to be.
 *
 * Three outcomes rather than a value plus a rejection, because two of the three
 * are ordinary and only one of them is a fault — and the two surfaces reading
 * this need to tell them apart differently. **Nothing here ever rejects**, so a
 * repo-less room (which is most rooms) drops no breadcrumb into somebody's next
 * bug report, and neither does a room on a machine without git.
 */
export type RoomRepoStatusRead =
  /** The room answered. */
  | { kind: 'ok'; status: RoomRepoStatus }
  /** The room has no files of its own — the ordinary answer for most rooms. */
  | { kind: 'absent' }
  /** Something went wrong and this client does not know where the room stands. */
  | { kind: 'unavailable' };

/**
 * How one room's repo status is fetched and cached — the single definition, so
 * that everything asking the same question shares one cache entry.
 *
 * Two surfaces read it: the pending-work badge in the section header, and the
 * dirty-main warning above the tree. They ask about the same room at the same
 * moment, so a second key here would be a second `GET /repo/status` per panel —
 * and worse, a save refused `MAIN_CHECKOUT_DIRTY` would refresh one of them and
 * leave the other saying something else about the same room.
 *
 * **The failure is absorbed here rather than at either reader, and it is
 * absorbed into a VALUE rather than a `null`.** A rejection would be reported
 * twice — the tree directly below is asking the same server about the same room
 * and says so loudly, with a retry — while collapsing everything to `null`
 * would leave the two readers unable to tell "this room has no files" from "I
 * could not find out", which is the one distinction the warning exists to draw.
 *
 * @param transport - The port the status is read through.
 * @param roomId - The room.
 */
export function roomRepoStatusQueryOptions(transport: Transport, roomId: string) {
  return {
    queryKey: roomKeys.repoStatus(roomId),
    queryFn: async (): Promise<RoomRepoStatusRead> => {
      try {
        return { kind: 'ok', status: await transport.readRoomRepoStatus(roomId) };
      } catch (error) {
        return errorCodeOf(error) === ROOM_HAS_NO_REPO_CODE
          ? { kind: 'absent' }
          : { kind: 'unavailable' };
      }
    },
    // Nothing above can reject, so this only ever governs a bug in the function
    // itself — where three silent retries would be three of the same bug.
    retry: false,
    // Long enough that opening a room panel twice in a minute is one request,
    // short enough that neither surface is stale for a whole session. The room
    // stream is what makes them prompt; this is only the floor.
    staleTime: 30_000,
  };
}

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
