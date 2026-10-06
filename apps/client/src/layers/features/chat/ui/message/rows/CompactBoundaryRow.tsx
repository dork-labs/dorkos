import { RefreshCw, AlertTriangle } from 'lucide-react';
import { CompactResultRow } from '@/layers/shared/ui';
import { agentCompactionLabel, formatTokenCount } from '../../../lib/format-compaction';

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
  /** Set when the agent asked for this summary itself (DOR-2732). */
  requestedBy?: 'agent';
  /** How full the conversation was when the agent asked, 0–100. */
  contextPercent?: number;
}

/** Build the success summary line from the token metadata. */
function summaryText(preTokens?: number, postTokens?: number): string {
  if (preTokens === undefined) return 'Compacted context';
  if (postTokens === undefined)
    return `Compacted context · ${formatTokenCount(preTokens)} tokens summarized`;
  return `Compacted context · ${formatTokenCount(preTokens)} → ${formatTokenCount(postTokens)} tokens`;
}

/**
 * Inline row marking a context-window compaction in the transcript.
 *
 * Success state ({@link CompactResultRow} with a refresh glyph): "Compacted
 * context · N → M tokens" plus a `manual`/`auto` trigger badge. Failure state
 * (amber alert glyph): "Couldn’t compact" with the SDK error beneath. A summary
 * the agent asked for reads "Summarized at 89% (asked by the agent)" instead of
 * the token line, with no trigger badge — who asked is the whole story. Sourced
 * from the `compact_boundary` part folded by `projectInProgressTurn`.
 */
export function CompactBoundaryRow({
  trigger,
  preTokens,
  postTokens,
  failed,
  error,
  requestedBy,
  contextPercent,
}: CompactBoundaryRowProps) {
  if (failed) {
    return (
      <CompactResultRow
        data-testid="compact-boundary-row"
        data-failed="true"
        icon={
          <AlertTriangle aria-hidden="true" className="text-status-warning-dot size-3 shrink-0" />
        }
        label={
          <span className="text-status-warning-fg">
            {requestedBy === 'agent' ? 'Couldn’t compact (asked by the agent)' : 'Couldn’t compact'}
          </span>
        }
      >
        {error ? <p className="text-muted-foreground mt-1 text-xs">{error}</p> : null}
      </CompactResultRow>
    );
  }

  if (requestedBy === 'agent') {
    return (
      <CompactResultRow
        data-testid="compact-boundary-row"
        data-requested-by="agent"
        icon={<RefreshCw aria-hidden="true" className="text-muted-foreground size-3 shrink-0" />}
        label={
          <span className="text-muted-foreground">{agentCompactionLabel(contextPercent)}</span>
        }
      />
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
