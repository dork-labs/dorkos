/**
 * Reviewing an agent's work on a room's canvas, and merging it (spec
 * `canvas-agent-seat` §8, ADR `260912-025253`).
 *
 * A `diff` document opened from a member's working copy is the one document on
 * a room's table that is not about a file somebody is reading — it is about work
 * waiting for a decision. So it renders the agent's copy against the room's own
 * `main`, in the same merge view the session diff uses, and puts the decision on
 * the header.
 *
 * Three rules the screen exists to keep:
 *
 * - **Only the operator is offered the merge.** It publishes somebody's work in
 *   everybody's name, so it is not an agent's call and not a guest's. The server
 *   refuses a non-operator either way; this decides what is drawn, so nobody is
 *   offered a button that will turn them down.
 * - **A copy that has fallen behind shows the merge service's own sentence and
 *   no button.** The refusal names the fix, and the fix is `git merge main` in a
 *   working copy that belongs to an agent — so the operator is told to ask,
 *   rather than to go and run git in somebody else's tree.
 * - **Turning a hunk down writes to the AGENT's copy**, through the ordinary
 *   file path and against the hash the diff was computed at. A file that moved
 *   underneath it is a conflict, which is the banner the session diff already
 *   has.
 *
 * @module features/diff-review/ui/RoomWorktreeDiff
 */
import { lazy, Suspense, useState } from 'react';
import { AnimatePresence, useReducedMotion } from 'motion/react';
import { Columns2, GitMerge, RotateCcw, Rows2 } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { behindMainMessage } from '@dorkos/shared/room-repo';
import { useRoom } from '@/layers/entities/room';
import { useIsMobile, useResolvedTheme } from '@/layers/shared/model';
import { Button, Input } from '@/layers/shared/ui';
import { useWorktreeDiff } from '../model/use-worktree-diff';
import { Banner, DiffMessage } from './diff-chrome';

// Lazy for the same reason the session diff is: the whole `@codemirror/merge`
// runtime lands only when a diff first renders, never in the main bundle.
const CodeMirrorDiff = lazy(() =>
  import('./CodeMirrorDiff').then((m) => ({ default: m.CodeMirrorDiff }))
);

/** Base name of a path, for the header. */
function baseName(pathLike: string): string {
  const parts = pathLike.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? pathLike;
}

/** What {@link RoomWorktreeDiff} draws. */
export interface RoomWorktreeDiffProps {
  /** The room whose `main` this is compared against. */
  roomId: string;
  /** The diff document's content, for the file name and the syntax. */
  content: Extract<UiCanvasContent, { type: 'diff' }>;
  /** The document on the room's canvas; the tree and the path come off its row. */
  documentId: string;
  /** The member whose copy it is, so the right branch row is found. */
  authorId: string;
}

/**
 * The review surface for one file in an agent's working copy.
 *
 * @param props - The room, the document and whose copy it is.
 */
export function RoomWorktreeDiff({ roomId, content, documentId, authorId }: RoomWorktreeDiffProps) {
  const resolvedTheme = useResolvedTheme();
  const isMobile = useIsMobile();
  const reduceMotion = useReducedMotion();
  const room = useRoom(roomId);
  const review = useWorktreeDiff({ roomId, documentId, authorId });

  const [sideBySide, setSideBySide] = useState(false);
  const [hunkCount, setHunkCount] = useState<number | null>(null);

  if (review.isLoading) {
    return <DiffMessage>Loading changes…</DiffMessage>;
  }
  if (review.error || !review.data) {
    return <DiffMessage>This file’s changes couldn’t be loaded.</DiffMessage>;
  }

  const { base, current } = review.data;
  const showSideBySide = sideBySide && !isMobile;

  return (
    <div className="relative flex h-full flex-col">
      <WorktreeDiffHeader
        fileName={baseName(content.sourcePath)}
        hunkCount={hunkCount}
        sideBySide={showSideBySide}
        canSideBySide={!isMobile}
        onToggleSideBySide={() => setSideBySide((v) => !v)}
        // Absent means "this source cannot say", which must not hide the action
        // from the one person who can take it — so only an explicit `false`
        // withholds it.
        isOperator={room.data?.viewerIsOperator !== false}
        branch={review.branch}
        merging={review.merging}
        merged={review.merged}
        onMerge={review.merge}
      />

      <AnimatePresence>
        {review.conflict && (
          <Banner key="conflict" tone="warn" reduceMotion={reduceMotion}>
            <span className="flex-1">This file changed since the diff was computed.</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={review.refresh}
            >
              <RotateCcw className="mr-1 size-3.5" />
              Refresh
            </Button>
          </Banner>
        )}
        {review.writeFailed && (
          <Banner key="write-failed" tone="error" reduceMotion={reduceMotion}>
            <span className="flex-1">
              That change couldn’t be written to disk. Nothing was lost. Try again.
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={review.refresh}
            >
              Dismiss
            </Button>
          </Banner>
        )}
        {review.mergeRefusal !== null && (
          <Banner key="merge-refusal" tone="error" reduceMotion={reduceMotion}>
            <span className="flex-1">{review.mergeRefusal}</span>
          </Banner>
        )}
      </AnimatePresence>

      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="text-muted-foreground p-4 text-sm">Loading diff…</div>}>
          {/* Remount on every recompute so the two copies never straddle two
              states; keyed on the working copy's own hash. */}
          <CodeMirrorDiff
            key={`${review.data.currentHash}:${showSideBySide ? 'split' : 'unified'}`}
            baseline={base}
            current={current}
            theme={resolvedTheme}
            filename={content.sourcePath}
            sideBySide={showSideBySide}
            onRejectHunk={(reverted) => void review.rejectHunk(reverted)}
            onHunkCountChange={setHunkCount}
          />
        </Suspense>
      </div>

      {(hunkCount === 0 || base === current) && (
        <div className="text-muted-foreground pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="bg-background/80 rounded-full border px-3 py-1 text-xs backdrop-blur">
            Nothing here the room hasn’t got
          </span>
        </div>
      )}
    </div>
  );
}

/** What the header of a worktree review draws. */
interface WorktreeDiffHeaderProps {
  fileName: string;
  hunkCount: number | null;
  sideBySide: boolean;
  canSideBySide: boolean;
  onToggleSideBySide: () => void;
  isOperator: boolean;
  branch: ReturnType<typeof useWorktreeDiff>['branch'];
  merging: boolean;
  merged: boolean;
  onMerge: (summary: string) => void;
}

/**
 * The review header: what changed, whose copy it is, and — for the operator —
 * the way to bring it into the room.
 *
 * @param props - The counts, the branch's live position and the merge action.
 */
function WorktreeDiffHeader({
  fileName,
  hunkCount,
  sideBySide,
  canSideBySide,
  onToggleSideBySide,
  isOperator,
  branch,
  merging,
  merged,
  onMerge,
}: WorktreeDiffHeaderProps) {
  const [summary, setSummary] = useState<string | null>(null);

  const countLabel =
    hunkCount === null
      ? 'Reviewing changes'
      : hunkCount === 0
        ? 'No changes'
        : `${hunkCount} ${hunkCount === 1 ? 'change' : 'changes'}`;

  // Behind first: a copy the room has moved past cannot be merged whatever else
  // is true of it, and saying so is more useful than a button that refuses.
  //
  // **Except straight after a merge**, which is what puts it behind: the merge
  // commit moves the room's `main` past the branch that produced it, so leaving
  // this on would answer a merge that just worked with "the room has moved on,
  // ask them to catch up". Measured in the browser, stacked under the line
  // saying the work had landed.
  const behind = !merged && branch !== null && branch.behind > 0;
  const canMerge = isOperator && branch !== null && !behind && branch.ahead > 0 && !merged;

  return (
    <div className="border-b">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-muted-foreground truncate text-xs" title={fileName}>
            {countLabel}
          </span>
        </div>

        {canSideBySide && (
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="text-muted-foreground hover:text-foreground size-7"
            aria-pressed={sideBySide}
            aria-label={sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
            onClick={onToggleSideBySide}
          >
            {sideBySide ? <Rows2 className="size-4" /> : <Columns2 className="size-4" />}
          </Button>
        )}

        {canMerge && summary === null && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7"
            disabled={merging}
            onClick={() => setSummary(`Merge ${branch.slug}`)}
          >
            <GitMerge className="mr-1 size-3.5" />
            Merge into the room
          </Button>
        )}
      </div>

      {canMerge && summary !== null && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2">
          <Input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- Intentional: the field appears only after a deliberate press, and the press is what asked for it
            autoFocus
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            aria-label="What this work does, in one line"
            placeholder="What this work does, in one line"
            className="h-7 min-w-0 flex-1 text-xs"
          />
          <Button
            type="button"
            size="sm"
            className="h-7"
            disabled={merging || summary.trim().length === 0}
            onClick={() => onMerge(summary.trim())}
          >
            {merging ? 'Merging…' : 'Merge'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7"
            disabled={merging}
            onClick={() => setSummary(null)}
          >
            Cancel
          </Button>
        </div>
      )}

      {merged && (
        <p className="text-muted-foreground px-3 pb-2 text-xs">
          This work is in the room now, and the room has been told once.
        </p>
      )}

      {behind && branch !== null && (
        <div className="text-muted-foreground space-y-1 px-3 pb-2 text-xs">
          <p>{behindMainMessage(branch.behind, branch.ahead)}</p>
          <p>
            That is {branch.agent}’s working copy, so ask {branch.agent} to do it rather than
            running git in it yourself.
          </p>
        </div>
      )}
    </div>
  );
}
