import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Check,
  Columns2,
  GitCommitHorizontal,
  Info,
  RotateCcw,
  Rows2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import type { DiffBaselineOrigin, UiCanvasContent } from '@dorkos/shared/types';
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
    case 'NOT_A_FILE':
      return 'This path is a directory, not a file.';
    default:
      return "This file's changes couldn't be loaded.";
  }
}

/**
 * Whether the diff base is NOT this session's own pre-edit snapshot — meaning
 * "reject" restores something OLDER than the operator's pre-session state (git
 * HEAD discards their uncommitted work; empty discards the whole file). Reject-
 * all is confirm-gated whenever this is true, and session mode discloses the
 * degradation plainly (server restart, bypass edits before capture landed, or
 * an evicted/oversize baseline).
 */
function isDegradedBase(capturedFrom: DiffBaselineOrigin): boolean {
  return capturedFrom === 'head' || capturedFrom === 'empty';
}

/**
 * The per-hunk diff review surface for a text file (DOR-212).
 *
 * Loads the pre-edit baseline + current content, then renders the CodeMirror
 * merge view with an accept/reject gutter. Rejecting a hunk reverts it on disk
 * (optimistic-concurrency; a changed-underneath file shows a calm refresh banner,
 * never a blind clobber, and a genuinely failed write shows its own notice —
 * never a silent no-op); accepting dismisses it. The header offers reject-all
 * (confirm-gated when the base isn't the session snapshot), mark-reviewed, a
 * side-by-side toggle (wide screens), and a compare-against toggle.
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

  const { baseline, current, capturedFrom } = review.data;
  const showSideBySide = sideBySide && !isMobile;
  const nothingToReview = hunkCount === 0 || baseline === current;

  return (
    <div className="relative flex h-full flex-col">
      <DiffHeader
        fileName={baseName(content.sourcePath)}
        hunkCount={hunkCount}
        capturedFrom={capturedFrom}
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
              That change couldn&rsquo;t be written to disk. Nothing was lost — try again.
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

/** A calm inline notice strip below the header (conflict / write-failure). */
function Banner({
  tone,
  reduceMotion,
  children,
}: {
  tone: 'warn' | 'error';
  reduceMotion: boolean | null;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
      className={cn(
        'mx-2 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-sm',
        tone === 'warn'
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'bg-destructive/10 text-destructive'
      )}
    >
      {children}
    </motion.div>
  );
}

interface DiffHeaderProps {
  fileName: string;
  hunkCount: number | null;
  capturedFrom: DiffBaselineOrigin;
  mode: 'session' | 'head';
  onModeChange: (mode: 'session' | 'head') => void;
  sideBySide: boolean;
  canSideBySide: boolean;
  onToggleSideBySide: () => void;
  writing: boolean;
  onRejectAll: () => void;
  onMarkReviewed: () => void;
}

/** How long an armed "Confirm reject all" stays armed before quietly disarming (ms). */
const REJECT_ALL_ARM_TIMEOUT_MS = 5000;

/**
 * The review header: change count, base-degradation disclosure, compare-mode
 * toggle, and the review actions. When the diff base is NOT the session's own
 * snapshot, the header says so plainly and Reject all requires a second,
 * explicit click — restoring HEAD/empty can discard the operator's own
 * uncommitted work, so it never happens on a single tap.
 */
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
  const degraded = isDegradedBase(capturedFrom);
  // Confirm-gate reject-all whenever the base isn't this session's snapshot —
  // including the deliberate "Last commit" mode, where reject-all still
  // overwrites uncommitted work.
  const needsConfirm = degraded;
  const [armed, setArmed] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    },
    []
  );

  const handleRejectAll = () => {
    if (!needsConfirm || armed) {
      setArmed(false);
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      onRejectAll();
      return;
    }
    setArmed(true);
    disarmTimer.current = setTimeout(() => setArmed(false), REJECT_ALL_ARM_TIMEOUT_MS);
  };

  const countLabel =
    hunkCount === null
      ? 'Reviewing changes'
      : hunkCount === 0
        ? 'No changes'
        : `${hunkCount} ${hunkCount === 1 ? 'change' : 'changes'}`;

  // Plain-language disclosure when session mode silently degraded (server
  // restart, capture missed, or an evicted/oversize baseline): the base is NOT
  // "since the agent started" — say what it actually is.
  const disclosure =
    mode === 'session' && degraded
      ? capturedFrom === 'head'
        ? 'No session snapshot — comparing to your last commit. Rejecting also undoes any edits you made before this session.'
        : 'No session snapshot or commit found — the whole file shows as new. Rejecting everything would empty it.'
      : null;

  return (
    <div className="border-b">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-muted-foreground truncate text-xs" title={fileName}>
            {countLabel}
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
          variant={armed ? 'destructive' : 'ghost'}
          size="sm"
          className="h-7"
          disabled={writing}
          aria-label={armed ? 'Confirm: reject all changes' : 'Reject all changes'}
          onClick={handleRejectAll}
        >
          {armed ? (
            <TriangleAlert className="mr-1 size-3.5" />
          ) : (
            <Undo2 className="mr-1 size-3.5" />
          )}
          {armed ? 'Really reject all?' : 'Reject all'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7"
          onClick={onMarkReviewed}
        >
          <Check className="mr-1 size-3.5" />
          Mark reviewed
        </Button>
      </div>

      {disclosure && (
        <div className="text-muted-foreground flex items-start gap-1.5 px-3 pb-2 text-xs">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>{disclosure}</span>
        </div>
      )}
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
