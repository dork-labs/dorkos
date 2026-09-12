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
 * **Two of the three reads are the row's, not a re-derivation.** The tree comes
 * from the document's stored `resolvedCwd`, so a reject lands in the tree the
 * document was opened against; the path comes from its content. The third — how
 * far ahead and behind that copy is, and which working copy it is by slug — is
 * a LIVE read of the room's repo status, because the `aheadOfMain` on the row is
 * a snapshot taken when the document was opened and a merge decision must not be
 * made on one.
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

/** React-query key for one worktree file read against the room's own copy. */
function worktreeDiffQueryKey(roomId: string, cwd: string, sourcePath: string) {
  return ['worktree-diff', roomId, cwd, sourcePath] as const;
}

/** The two copies of one file, and the fingerprint a reject is conditional on. */
export interface WorktreeDiffPair {
  /** The room's own `main` copy — empty for a file the branch adds. */
  base: string;
  /** The agent's working copy, as it is on disk right now. */
  current: string;
  /** SHA-256 of `current`, so a reject refuses a file that moved underneath it. */
  currentHash: string;
}

/** What {@link useWorktreeDiff} is asked about. */
export interface UseWorktreeDiffArgs {
  /** The room whose `main` is the comparison. */
  roomId: string;
  /** The working copy the document was opened against — the row's own. */
  cwd: string;
  /** The file, relative to both trees. */
  sourcePath: string;
  /** The agent whose copy it is, so the right branch row is found. */
  authorId: string;
}

/**
 * Read one file out of both trees, and offer the two things a reviewer does
 * with it: turn a hunk down, or merge the whole branch.
 *
 * @param args - The room, the working copy, the file and whose copy it is.
 * @returns The pair, the branch's live position, and the review actions.
 */
export function useWorktreeDiff({ roomId, cwd, sourcePath, authorId }: UseWorktreeDiffArgs) {
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
    queryKey: worktreeDiffQueryKey(roomId, cwd, sourcePath),
    queryFn: async (): Promise<WorktreeDiffPair> => {
      const [worktree, main] = await Promise.all([
        transport.readFileContent(cwd, sourcePath),
        readRoomMainCopy(),
      ]);
      return { base: main, current: worktree.content, currentHash: worktree.hash };
    },
    staleTime: 5_000,
    retry: false,
  });

  /**
   * The room's own copy of the file, or the empty string when `main` does not
   * have it.
   *
   * A file the branch ADDS is the ordinary case for a new feature, and it is not
   * an error: the honest comparison is "nothing, then this". A file that is
   * there but cannot be sent as text — a picture, something over the room's read
   * ceiling — is a different answer and is thrown, because showing it as an
   * empty base would report every byte of it as added.
   */
  async function readRoomMainCopy(): Promise<string> {
    let answer;
    try {
      answer = await transport.readRoomFileContent(roomId, sourcePath);
    } catch {
      return '';
    }
    if (answer.body.kind !== 'text') {
      throw Object.assign(new Error('The room’s copy of this file is not text.'), {
        code: 'BINARY_FILE',
      });
    }
    return answer.body.text;
  }

  const status = useQuery(roomRepoStatusQueryOptions(transport, roomId));
  const branch: RoomBranchStatus | null =
    status.data?.kind === 'ok'
      ? (status.data.status.branches.find((row) => row.authorId === authorId) ?? null)
      : null;

  const revalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: worktreeDiffQueryKey(roomId, cwd, sourcePath),
    });
  }, [queryClient, roomId, cwd, sourcePath]);

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
        const result = await transport.writeFile(cwd, sourcePath, revertedContent, {
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
    [transport, pair.data, cwd, sourcePath, revalidate]
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
