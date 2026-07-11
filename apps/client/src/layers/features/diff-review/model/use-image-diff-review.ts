/**
 * Image diff-review actions for a single file (DOR-212 Chunk B).
 *
 * The image surface is whole-file: "restore previous" writes the baseline bytes
 * back to disk through the server-held, binary-safe revert (no bytes travel
 * from the client), and "mark reviewed" advances the baseline exactly like the
 * text surface. Failures are never silent — a failed restore/advance raises a
 * visible `writeFailed` notice, mirroring the text review model's contract.
 *
 * @module features/diff-review/model/use-image-diff-review
 */
import { useCallback, useState } from 'react';
import { useTransport } from '@/layers/shared/model';

interface UseImageDiffReviewArgs {
  /** Session working directory the path is confined within. */
  cwd: string | null;
  /** File path whose agent edits are under review. */
  sourcePath: string;
  /** Attached session whose pre-edit snapshot is the diff base. */
  sessionId: string | null;
}

/**
 * Whole-file review actions for an image diff: restore-previous (server-side
 * baseline revert), mark-reviewed (baseline advance), a cache-busting `version`
 * the `<img>` layers append so a revert/refresh visibly reloads both, and the
 * shared failed-write notice.
 */
export function useImageDiffReview({ cwd, sourcePath, sessionId }: UseImageDiffReviewArgs) {
  const transport = useTransport();
  // Bumped after every disk mutation/refresh — the <img> URLs append it so the
  // browser refetches instead of serving a stale cached layer.
  const [version, setVersion] = useState(0);
  const [writeFailed, setWriteFailed] = useState(false);
  const [writing, setWriting] = useState(false);

  const canAct = cwd !== null && sessionId !== null;

  /** Reload both image layers from disk and clear the failure notice. */
  const refresh = useCallback(() => {
    setWriteFailed(false);
    setVersion((v) => v + 1);
  }, []);

  /** Restore the baseline bytes to disk (whole-file reject). */
  const restore = useCallback(async () => {
    if (!canAct) return;
    setWriting(true);
    try {
      await transport.revertDiffBaseline(cwd as string, sourcePath, sessionId as string);
      setWriteFailed(false);
      setVersion((v) => v + 1);
    } catch {
      // The restore never landed (network/permissions/no baseline) — surface
      // it; a failed write must never look like a successful one.
      setWriteFailed(true);
    } finally {
      setWriting(false);
    }
  }, [transport, canAct, cwd, sourcePath, sessionId]);

  /** Finish the review: baseline := current disk, so later edits diff from here. */
  const markReviewed = useCallback(async () => {
    if (!canAct) return;
    try {
      await transport.advanceDiffBaseline(cwd as string, sourcePath, sessionId as string);
      refresh();
    } catch {
      setWriteFailed(true);
    }
  }, [transport, canAct, cwd, sourcePath, sessionId, refresh]);

  return {
    /** Cache-busting counter the image URLs append (`&v=`). */
    version,
    /** True after a restore/advance genuinely failed (its own banner). */
    writeFailed,
    /** True while the restore write is in flight. */
    writing,
    restore,
    markReviewed,
    refresh,
  };
}
