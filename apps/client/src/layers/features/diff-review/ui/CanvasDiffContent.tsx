import { lazy, Suspense, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Check, Columns2, GitCommitHorizontal, RotateCcw, Rows2, Undo2 } from 'lucide-react';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { diffMediaKindForPath } from '@dorkos/shared/viewer-registry';
import { cn } from '@/layers/shared/lib';
import { useAppStore, useIsMobile, useTheme } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { useDiffReview } from '../model/use-diff-review';

// Lazy: the whole `@codemirror/merge` runtime lands only when a diff first
// renders — never in the main bundle (matching the file viewer's editor chunk).
const CodeMirrorDiff = lazy(() =>
  import('./CodeMirrorDiff').then((m) => ({ default: m.CodeMirrorDiff }))
);

interface CanvasDiffContentProps {
  /** Diff canvas content variant. */
  content: Extract<UiCanvasContent, { type: 'diff' }>;
  /** Id of the canvas document this viewer belongs to. */
  documentId: string;
}

/** Base name of a path, for the count line's file reference. */
function baseName(pathLike: string): string {
  const parts = pathLike.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? pathLike;
}

/** Friendly message for a baseline-load failure, keyed by the transport's coded error. */
function loadErrorMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case 'TOO_LARGE':
      return 'This file is too large to diff here.';
    case 'BINARY_FILE':
      return "This file isn't text, so it can't be shown as a text diff.";
    case 'NOT_FOUND':
      return "This file doesn't exist.";
    default:
      return "This file's changes couldn't be loaded.";
  }
}

/**
 * The per-hunk diff review surface for a text file (DOR-212).
 *
 * Loads the pre-edit baseline + current content, then renders the CodeMirror
 * merge view with an accept/reject gutter. Rejecting a hunk reverts it on disk
 * (optimistic-concurrency; a changed-underneath file shows a calm refresh banner,
 * never a blind clobber); accepting dismisses it. The header offers reject-all,
 * mark-reviewed, a side-by-side toggle (wide screens), and a compare-against
 * toggle (session snapshot vs last commit).
 */
export function CanvasDiffContent({ content }: CanvasDiffContentProps) {
  const cwd = useAppStore((s) => s.selectedCwd);
  const sessionId = useAppStore((s) => s.sessionId);
  const { theme } = useTheme();
  const isMobile = useIsMobile();
  const reduceMotion = useReducedMotion();

  const [sideBySide, setSideBySide] = useState(false);
  const [hunkCount, setHunkCount] = useState<number | null>(null);

  const review = useDiffReview({ cwd, sourcePath: content.sourcePath, sessionId });

  if (cwd === null || sessionId === null) {
    return <DiffMessage>Open a session to review changes.</DiffMessage>;
  }
  // Image diffs (2-up / swipe / onion-skin) are a later addition; until then a
  // changed image opens honestly rather than as a broken text diff.
  const mediaKind = content.mediaKind ?? diffMediaKindForPath(content.sourcePath);
  if (mediaKind === 'image') {
    return <DiffMessage>Reviewing image changes isn&rsquo;t available here yet.</DiffMessage>;
  }
  if (review.isLoading) {
    return <DiffMessage>Loading changes…</DiffMessage>;
  }
  if (review.error || !review.data) {
    return <DiffMessage>{loadErrorMessage(review.error)}</DiffMessage>;
  }

  const { baseline, current } = review.data;
  const showSideBySide = sideBySide && !isMobile;
  const nothingToReview = hunkCount === 0 || baseline === current;

  return (
    <div className="relative flex h-full flex-col">
      <DiffHeader
        fileName={baseName(content.sourcePath)}
        hunkCount={hunkCount}
        capturedFrom={review.data.capturedFrom}
        mode={review.mode}
        onModeChange={review.setMode}
        sideBySide={showSideBySide}
        canSideBySide={!isMobile}
        onToggleSideBySide={() => setSideBySide((v) => !v)}
        writing={review.writing}
        onRejectAll={() => void review.rejectAll()}
        onMarkReviewed={() => void review.markReviewed()}
      />

      <AnimatePresence>
        {review.conflict && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            className="mx-2 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
          >
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
          </motion.div>
        )}
      </AnimatePresence>

      <div className="min-h-0 flex-1">
        <Suspense fallback={<div className="text-muted-foreground p-4 text-sm">Loading diff…</div>}>
          {/* Remount on every recompute (mode / disk change) so baseline + doc
              never straddle two states; keyed on both hashes. */}
          <CodeMirrorDiff
            key={`${review.data.baselineHash}:${review.data.currentHash}:${showSideBySide ? 'split' : 'unified'}`}
            baseline={baseline}
            current={current}
            theme={theme === 'dark' ? 'dark' : 'light'}
            filename={content.sourcePath}
            sideBySide={showSideBySide}
            onRejectHunk={(reverted) => void review.rejectHunk(reverted)}
            onHunkCountChange={setHunkCount}
          />
        </Suspense>
      </div>

      {nothingToReview && (
        <div className="text-muted-foreground pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="bg-background/80 rounded-full border px-3 py-1 text-xs backdrop-blur">
            No changes left to review
          </span>
        </div>
      )}
    </div>
  );
}

interface DiffHeaderProps {
  fileName: string;
  hunkCount: number | null;
  capturedFrom: string;
  mode: 'session' | 'head';
  onModeChange: (mode: 'session' | 'head') => void;
  sideBySide: boolean;
  canSideBySide: boolean;
  onToggleSideBySide: () => void;
  writing: boolean;
  onRejectAll: () => void;
  onMarkReviewed: () => void;
}

/** The review header: change count, compare-mode toggle, and the review actions. */
function DiffHeader({
  fileName,
  hunkCount,
  capturedFrom,
  mode,
  onModeChange,
  sideBySide,
  canSideBySide,
  onToggleSideBySide,
  writing,
  onRejectAll,
  onMarkReviewed,
}: DiffHeaderProps) {
  const countLabel =
    hunkCount === null
      ? 'Reviewing changes'
      : hunkCount === 0
        ? 'No changes'
        : `${hunkCount} ${hunkCount === 1 ? 'change' : 'changes'}`;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-muted-foreground truncate text-xs" title={fileName}>
          {countLabel}
          {capturedFrom === 'empty' && hunkCount !== 0 ? ' · new file' : ''}
        </span>
      </div>

      {/* Compare-against toggle — session snapshot (default) vs last commit. */}
      <div className="flex items-center rounded-md border p-0.5">
        <ModeButton active={mode === 'session'} onClick={() => onModeChange('session')}>
          Session start
        </ModeButton>
        <ModeButton active={mode === 'head'} onClick={() => onModeChange('head')}>
          <GitCommitHorizontal className="mr-1 size-3" />
          Last commit
        </ModeButton>
      </div>

      {canSideBySide && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-7"
          aria-pressed={sideBySide}
          aria-label={sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
          onClick={onToggleSideBySide}
        >
          {sideBySide ? <Rows2 className="size-4" /> : <Columns2 className="size-4" />}
        </Button>
      )}

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7"
        disabled={writing}
        onClick={onRejectAll}
      >
        <Undo2 className="mr-1 size-3.5" />
        Reject all
      </Button>
      <Button type="button" variant="secondary" size="sm" className="h-7" onClick={onMarkReviewed}>
        <Check className="mr-1 size-3.5" />
        Mark reviewed
      </Button>
    </div>
  );
}

/** A pill button inside the compare-mode segmented control. */
function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center rounded px-2 py-0.5 text-xs transition-colors',
        active
          ? 'bg-secondary text-secondary-foreground'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

/** Centered muted message for empty/error/loading diff states. */
function DiffMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center p-8 text-center">
      <p>{children}</p>
    </div>
  );
}
