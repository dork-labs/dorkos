/**
 * Who has work this room's files have not got yet (spec `project-rooms` §3.9).
 *
 * A room's files are one clean `main` plus a working copy per agent, and an
 * agent's copy can sit ahead of the room indefinitely: nothing removes work
 * nobody merged. Without this the room shows a tidy file tree while three days
 * of somebody's work waits in a directory no person will ever open.
 *
 * **Quiet by default, and that is the design.** It renders nothing at all when
 * everything is merged, when the room has no files, and while the answer is on
 * its way. A badge that is always there is a badge nobody reads, and this one
 * only ever appears because there is something to do.
 *
 * @module features/file-explorer/ui/PendingWorkBadge
 */
import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { roomKeys } from '@/layers/entities/room';
import { useTransport } from '@/layers/shared/model';
import {
  pendingWorkIn,
  pendingWorkLabel,
  pendingWorkNames,
  pendingWorkSummary,
  roomRepoStatusQueryOptions,
} from '../model/pending-work';
import { watchRoomEntries } from '../model/room-entry-watch';

/** What {@link PendingWorkBadge} watches. */
export interface PendingWorkBadgeProps {
  /** The room whose files to report on. */
  roomId: string;
}

/**
 * The pending-work badge for one room's files.
 *
 * @param props - The room.
 */
export function PendingWorkBadge({ roomId }: PendingWorkBadgeProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();

  // **A failure is never reported here**, and the reason is that the tree
  // directly below this badge is asking the same server about the same room.
  // Whatever went wrong — the room is unreachable, this machine has no git —
  // the explorer reports it loudly, in the place with the room for a sentence
  // and a retry. A badge that went red for the same cause would be one fault
  // reported twice, in a header where nobody can act on it.
  //
  // What it must never do is claim everything is merged when it does not know.
  // It does not: anything but a real answer renders NOTHING, exactly as "nobody
  // has unmerged work" does. The badge only ever makes a positive claim.
  //
  // The shared query is what keeps that true without also flattening the two
  // non-answers into one: it resolves rather than rejects, so nothing is
  // logged, and it still says WHICH — which the dirty-main warning beside this
  // badge has to know and this one does not.
  const status = useQuery(roomRepoStatusQueryOptions(transport, roomId));

  // The same signal the file tree refreshes on, at the same rate: a merge is
  // announced in the room as an entry, and both surfaces are describing the
  // commit that merge produced. Two clocks would let the tree show a merged
  // file beside a badge still claiming it is unmerged.
  useEffect(
    () =>
      watchRoomEntries(queryClient, roomId, () => {
        void queryClient.invalidateQueries({ queryKey: roomKeys.repoStatus(roomId) });
      }),
    [queryClient, roomId]
  );

  const pending = useMemo(
    () => (status.data?.kind === 'ok' ? pendingWorkIn(status.data.status) : []),
    [status.data]
  );
  const names = pendingWorkNames(pending);
  const label = pendingWorkLabel(pending);
  if (!label) return null;

  // The same sentences twice, on purpose. `title` is what a mouse gets; the
  // sr-only copy is what a screen reader and a keyboard get, because a `title`
  // on a non-interactive span is unreachable without a pointer — so the counts
  // would have been mouse-only detail, which is the half a person needs to
  // decide whether to go and ask somebody.
  const detail = pending.map((work, index) => `${names[index]}: ${pendingWorkSummary(work)}`);

  return (
    <span
      data-slot="pending-work-badge"
      // A title rather than a popover: the names are the answer, and the detail
      // behind them is something a person checks once and acts on elsewhere.
      title={detail.join('\n')}
      className="text-muted-foreground bg-muted/50 text-2xs inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5"
    >
      <GitBranch className="size-3 flex-shrink-0" />
      {/* The visible label is truncated to fit a header, so the accessible text
          is the WHOLE claim rather than a duplicate of what fits: every name,
          and what is unmerged about each. The visible half is hidden from the
          reader so the names are not announced twice. */}
      <span className="sr-only">Not merged into the room yet. {detail.join('. ')}.</span>
      <span aria-hidden="true" className="truncate">
        {label}
      </span>
    </span>
  );
}
