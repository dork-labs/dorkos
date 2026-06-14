import { RefreshCw, AlertTriangle } from 'lucide-react';
import { CompactResultRow } from '../primitives';

interface CompactBoundaryRowProps {
  /** What triggered compaction: manual (`/compact`) or auto (context pressure). */
  trigger?: 'manual' | 'auto';
  /** Context tokens occupying the window immediately before compaction. */
  preTokens?: number;
  /** Context tokens remaining after the summary replaced the history. */
  postTokens?: number;
  /** Set when compaction failed — renders an error surface instead of the summary. */
  failed?: boolean;
  /** Human-readable failure detail; shown below the row when `failed`. */
  error?: string;
}

/** Format a token count compactly (e.g. 52300 -> "52.3k", 840 -> "840"). */
function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Build the success summary line from the token metadata. */
function summaryText(preTokens?: number, postTokens?: number): string {
  if (preTokens === undefined) return 'Compacted context';
  if (postTokens === undefined)
    return `Compacted context — ${formatCount(preTokens)} tokens summarized`;
  return `Compacted context — ${formatCount(preTokens)} → ${formatCount(postTokens)} tokens`;
}

/**
 * Inline row marking a context-window compaction in the transcript.
 *
 * Success state ({@link CompactResultRow} with a refresh glyph): "Compacted
 * context — N → M tokens" plus a `manual`/`auto` trigger badge. Failure state
 * (amber alert glyph): "Compaction failed" with the SDK error beneath. Sourced
 * from the `compact_boundary` part folded by `projectInProgressTurn`.
 */
export function CompactBoundaryRow({
  trigger,
  preTokens,
  postTokens,
  failed,
  error,
}: CompactBoundaryRowProps) {
  if (failed) {
    return (
      <CompactResultRow
        data-testid="compact-boundary-row"
        data-failed="true"
        icon={<AlertTriangle aria-hidden="true" className="size-3 shrink-0 text-amber-500" />}
        label={<span className="text-amber-600 dark:text-amber-400">Compaction failed</span>}
      >
        {error ? <p className="text-muted-foreground mt-1 text-xs">{error}</p> : null}
      </CompactResultRow>
    );
  }

  return (
    <CompactResultRow
      data-testid="compact-boundary-row"
      icon={<RefreshCw aria-hidden="true" className="text-muted-foreground size-3 shrink-0" />}
      label={<span className="text-muted-foreground">{summaryText(preTokens, postTokens)}</span>}
      trailing={
        trigger ? (
          <span
            data-testid="compact-boundary-trigger"
            className="text-3xs text-muted-foreground/70 ml-auto font-mono uppercase"
          >
            {trigger}
          </span>
        ) : undefined
      }
    />
  );
}
