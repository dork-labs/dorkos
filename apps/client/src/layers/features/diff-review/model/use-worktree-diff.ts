/**
 * Reviewing one agent's working copy against the room's own (spec
 * `canvas-agent-seat` §8).
 *
 * The session diff compares a file to what it looked like before this session
 * touched it. A room worktree diff asks a different question — what does this
 * agent's copy hold that the room's `main` does not — so it reads two different
 * places: the file in the agent's working copy, and the same path in the room's
 * own checkout. Everything after that is the surface the session diff already
 * has: the same merge view, the same per-hunk gutter, and the same
 * optimistically-concurrent write for a hunk that is turned down.
 *
 * **It goes through the ROOM, not the file API**, and that is not a shortcut. A
 * member's working copy lives under the DorkOS data directory, which the raw
 * file surfaces are deliberately confined out of (`lib/boundary.ts`) — so
 * `transport.readFileContent` on a worktree is refused on any install whose
 * boundary is a project directory, which is every install that sets one. It was
 * refused in the browser before this hook was changed. The room routes name a
 * DOCUMENT instead, and the tree and the path both come off that row, so a
 * reject lands in the tree the document was opened against and no directory is
 * ever a caller's to choose.
 *
 * The third read is a LIVE one: how far ahead and behind that copy is, and which
 * working copy it is by slug, come from the room's repo status — the
 * `aheadOfMain` on the row is a snapshot taken when the document was opened, and
 * a merge decision must not be made on one.
 *
 * @module features/diff-review/model/use-worktree-diff
 */
import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RoomBranchStatus } from '@dorkos/shared/room-repo';
import { roomKeys } from '@/layers/entities/room';
import { roomRepoStatusQueryOptions } from '@/layers/features/file-explorer';
import { useTransport } from '@/layers/shared/model';
import type { DiffWriteOutcome } from './use-diff-review';

/** React-query key for one worktree diff, by the document it is about. */
function worktreeDiffQueryKey(roomId: string, documentId: string) {
  return ['worktree-diff', roomId, documentId] as const;
}

/** What {@link useWorktreeDiff} is asked about. */
export interface UseWorktreeDiffArgs {
  /** The room whose `main` is the comparison. */
  roomId: string;
  /** The `diff` document on its canvas; the tree and the path come off its row. */
  documentId: string;
  /** The agent whose copy it is, so the right branch row is found. */
  authorId: string;
}

/**
 * Read one file out of both trees, and offer the two things a reviewer does
 * with it: turn a hunk down, or merge the whole branch.
 *
 * @param args - The room, the document and whose copy it is.
 * @returns The pair, the branch's live position, and the review actions.
 */
export function useWorktreeDiff({ roomId, documentId, authorId }: UseWorktreeDiffArgs) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  // A reject hit a file that had changed underneath it — the banner owns
  // recovery, exactly as it does on the session diff.
  const [conflict, setConflict] = useState(false);
  // A reject genuinely failed to write. Its own banner, because a failed write
  // must never look like a successful one.
  const [writeFailed, setWriteFailed] = useState(false);
  const [writing, setWriting] = useState(false);
  const [mergeRefusal, setMergeRefusal] = useState<string | null>(null);

  const pair = useQuery({
    queryKey: worktreeDiffQueryKey(roomId, documentId),
    queryFn: () => transport.readRoomCanvasDiff(roomId, documentId),
    staleTime: 5_000,
    retry: false,
  });

  const status = useQuery(roomRepoStatusQueryOptions(transport, roomId));
  const branch: RoomBranchStatus | null =
    status.data?.kind === 'ok'
      ? (status.data.status.branches.find((row) => row.authorId === authorId) ?? null)
      : null;

  const revalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: worktreeDiffQueryKey(roomId, documentId) });
  }, [queryClient, roomId, documentId]);

  /** The banners' "Refresh"/"Dismiss": clear the notices and read both trees again. */
  const refresh = useCallback(() => {
    setConflict(false);
    setWriteFailed(false);
    revalidate();
  }, [revalidate]);

  /**
   * Turn one hunk down: write the reverted whole file back into the AGENT's
   * working copy, conditional on the hash the diff was computed against.
   *
   * The same write the session diff makes, against a different tree. A file that
   * moved underneath it comes back a conflict, which is control flow and not an
   * error — the banner offers the recompute.
   */
  const rejectHunk = useCallback(
    async (revertedContent: string): Promise<DiffWriteOutcome> => {
      const held = pair.data;
      if (!held) return 'idle';
      setWriting(true);
      try {
        const result = await transport.writeRoomCanvasDiff(roomId, documentId, {
          content: revertedContent,
          expectedHash: held.currentHash,
        });
        if (result.ok) {
          setConflict(false);
          setWriteFailed(false);
          revalidate();
          return 'ok';
        }
        setConflict(true);
        revalidate();
        return 'conflict';
      } catch {
        setWriteFailed(true);
        revalidate();
        return 'error';
      } finally {
        setWriting(false);
      }
    },
    [transport, pair.data, roomId, documentId, revalidate]
  );

  /**
   * Merge the whole branch into the room's `main`.
   *
   * **Whole branch, not the hunks on screen**, which is what the action says:
   * the merge is git's, and a diff the reviewer scrolled past lands with the one
   * they read. A refusal is kept as the server's own sentence, because the room
   * has better words for "you cannot merge this yet" than this screen does.
   */
  const merge = useMutation({
    mutationFn: async (summary: string) => {
      if (!branch) throw new Error('No working copy to merge');
      return transport.mergeRoomMain(roomId, { summary, worktree: branch.slug });
    },
    onMutate: () => setMergeRefusal(null),
    onSuccess: () => {
      // The room's `main` moved, so every number on this screen is one merge out
      // of date — including the diff itself, which is now empty.
      void queryClient.invalidateQueries({ queryKey: roomKeys.repoStatus(roomId) });
      revalidate();
    },
    onError: (error) => setMergeRefusal(refusalSentence(error)),
  });

  return {
    /** The two copies, or `undefined` while loading or on error. */
    data: pair.data,
    isLoading: pair.isLoading || status.isLoading,
    error: pair.error,
    /** The branch's live position, or `null` when the room could not say. */
    branch,
    /** True once the room answered and named no working copy for this agent. */
    hasNoBranch: status.data?.kind === 'ok' && branch === null,
    conflict,
    writeFailed,
    writing,
    rejectHunk,
    refresh,
    /** Run the merge. Rejects nothing — the refusal lands in `mergeRefusal`. */
    merge: (summary: string) => merge.mutate(summary),
    merging: merge.isPending,
    /** The server's own words for a merge it would not do, or `null`. */
    mergeRefusal,
    /** True once a merge landed, so the screen can say so. */
    merged: merge.isSuccess,
  };
}

/**
 * The sentence to show for a merge the room refused.
 *
 * The server's own message wherever there is one — it names the fix, and this
 * screen does not know the room's rules well enough to paraphrase them.
 *
 * @param error - Whatever the transport threw.
 * @returns The sentence.
 */
function refusalSentence(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message.length > 0 ? message : 'That didn’t work. Try again in a moment.';
}
