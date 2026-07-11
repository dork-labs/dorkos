/**
 * Diff-review state + actions for a single file (DOR-212).
 *
 * Loads the pre-edit baseline and current disk content, exposes the "compare
 * against session start / last commit" mode toggle, and orchestrates the review
 * actions. Rejecting a hunk reverts it on disk through the SHIPPED optimistic-
 * concurrency write path (`transport.writeFile` with `expectedHash`): a file that
 * changed under the diff comes back a conflict — a calm "refresh" banner — never
 * a blind clobber. Accepting a hunk is a client-side dismiss handled in the
 * editor (no write). Marking reviewed advances the baseline to current so later
 * agent edits diff from the reviewed state.
 *
 * @module features/diff-review/model/use-diff-review
 */
import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiffBaselineResponse } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';

/** Which base the diff compares against — the session's pre-edit snapshot, or git HEAD. */
export type DiffCompareMode = 'session' | 'head';

/** React-query key for a file's resolved diff baseline (mode-scoped). */
function diffBaselineQueryKey(
  cwd: string,
  sourcePath: string,
  sessionId: string,
  mode: DiffCompareMode
) {
  return ['diff-baseline', cwd, sourcePath, sessionId, mode] as const;
}

interface UseDiffReviewArgs {
  /** Session working directory the path is confined within. */
  cwd: string | null;
  /** File path whose agent edits are under review. */
  sourcePath: string;
  /** Attached session whose pre-edit snapshot is the diff base. */
  sessionId: string | null;
}

/** The reject/revert outcome, mirroring the file-save hook's vocabulary. */
export type DiffWriteOutcome = 'ok' | 'conflict' | 'error' | 'idle';

/**
 * Load + review a file's agent edits. Returns the baseline DTO, the compare mode
 * toggle, and the review actions (reject a hunk, reject all, mark reviewed,
 * refresh). Rejects go through `transport.writeFile` with the current disk hash
 * so a concurrent change surfaces a conflict.
 */
export function useDiffReview({ cwd, sourcePath, sessionId }: UseDiffReviewArgs) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<DiffCompareMode>('session');
  // A reject/write hit a changed-on-disk conflict — the banner owns recovery.
  const [conflict, setConflict] = useState(false);
  // A revert/advance genuinely FAILED (network, permissions) — shown as its own
  // banner so a failed write is never a silent no-op ("never silent" is the
  // feature's contract, same as the 409 path).
  const [writeFailed, setWriteFailed] = useState(false);
  const [writing, setWriting] = useState(false);

  const canQuery = cwd !== null && sessionId !== null;
  const { data, error, isLoading } = useQuery({
    queryKey: canQuery
      ? diffBaselineQueryKey(cwd, sourcePath, sessionId, mode)
      : ['diff-baseline', 'disabled'],
    enabled: canQuery,
    queryFn: () => transport.readDiffBaseline(cwd as string, sourcePath, sessionId as string, mode),
    staleTime: 5_000,
    retry: false,
  });

  // Recompute the diff against the latest disk (refetch the baseline query),
  // leaving the conflict flag alone — so a conflict-triggered recompute keeps the
  // banner up until the operator acts.
  const revalidate = useCallback(() => {
    if (!canQuery) return;
    void queryClient.invalidateQueries({
      queryKey: diffBaselineQueryKey(cwd, sourcePath, sessionId, mode),
    });
  }, [queryClient, canQuery, cwd, sourcePath, sessionId, mode]);

  // Operator-initiated refresh (the banners' "Refresh"/"Dismiss"): clears the
  // conflict + failure notices and recomputes.
  const refresh = useCallback(() => {
    setConflict(false);
    setWriteFailed(false);
    revalidate();
  }, [revalidate]);

  /**
   * Write reverted full-file content to disk, conditional on the hash the diff
   * was computed against. A 409 surfaces the conflict banner and refetches (so
   * the operator reviews the latest); success refetches to drop the reverted
   * hunk from the recomputed diff.
   */
  const writeReverted = useCallback(
    async (revertedContent: string): Promise<DiffWriteOutcome> => {
      if (!canQuery || !data) return 'idle';
      setWriting(true);
      try {
        const result = await transport.writeFile(cwd as string, sourcePath, revertedContent, {
          expectedHash: data.currentHash,
        });
        if (result.ok) {
          setConflict(false);
          setWriteFailed(false);
          revalidate();
          return 'ok';
        }
        // File changed since the diff was computed — never clobber; keep the
        // banner up and recompute against the new disk state.
        setConflict(true);
        revalidate();
        return 'conflict';
      } catch {
        // The revert never landed (network/permissions). Surface it — a failed
        // write must never look like a successful one — and resync the doc with
        // disk so the editor's optimistic rejectChunk mutation doesn't linger.
        setWriteFailed(true);
        revalidate();
        return 'error';
      } finally {
        setWriting(false);
      }
    },
    [transport, canQuery, data, cwd, sourcePath, revalidate]
  );

  /**
   * Reject one hunk: the editor's own `rejectChunk` produces the reverted full-
   * file text (that hunk's "after" lines swapped back to baseline), which we
   * write to disk. The other hunks are untouched.
   */
  const rejectHunk = useCallback(
    (revertedContent: string) => writeReverted(revertedContent),
    [writeReverted]
  );

  /** Reject every hunk at once — write the whole baseline back to disk. */
  const rejectAll = useCallback(() => {
    if (!data) return Promise.resolve<DiffWriteOutcome>('idle');
    return writeReverted(data.baseline);
  }, [data, writeReverted]);

  /**
   * Finish the review: advance the baseline to current disk so subsequent agent
   * edits diff from the reviewed state, then refetch (the diff settles to zero
   * hunks). Advancing is meaningful only for the session base.
   */
  const markReviewed = useCallback(async () => {
    if (!canQuery) return;
    try {
      if (mode === 'session') {
        await transport.advanceDiffBaseline(cwd as string, sourcePath, sessionId as string);
      }
      refresh();
    } catch {
      // The advance never landed — surface it (the review is NOT finished) and
      // resync so the diff still reflects reality.
      setWriteFailed(true);
      revalidate();
    }
  }, [transport, canQuery, mode, cwd, sourcePath, sessionId, refresh, revalidate]);

  return {
    /** The resolved baseline DTO, or `undefined` while loading / on error. */
    data: data as DiffBaselineResponse | undefined,
    isLoading,
    error,
    /** Compare-against mode + its setter (session snapshot vs git HEAD). */
    mode,
    setMode,
    /** True after a reject hit a changed-on-disk conflict (banner shown). */
    conflict,
    /** True after a revert/advance write genuinely failed (its own banner). */
    writeFailed,
    /** True while a reject/revert write is in flight. */
    writing,
    rejectHunk,
    rejectAll,
    markReviewed,
    refresh,
  };
}
