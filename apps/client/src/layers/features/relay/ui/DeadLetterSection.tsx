import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useDeadLetters } from '@/layers/entities/relay';
import type { DeadLetter } from '@/layers/entities/relay';

/** Map of rejection reason codes to display label and badge variant. */
const REASON_CONFIG: Record<string, { label: string; className: string }> = {
  hop_limit: { label: 'Hop Limit', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
  ttl_expired: { label: 'TTL Expired', className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400' },
  cycle_detected: { label: 'Cycle Detected', className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
  budget_exhausted: { label: 'Budget Exhausted', className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
};

/** Fallback config for unknown reason codes. */
const DEFAULT_REASON_CONFIG = {
  label: 'Unknown',
  className: 'bg-muted text-muted-foreground',
};

/** Format an ISO timestamp as a relative time string. */
function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface DeadLetterRowProps {
  item: DeadLetter;
}

/** Single dead-letter row with red left border and expandable envelope detail. */
function DeadLetterRow({ item }: DeadLetterRowProps) {
  const [expanded, setExpanded] = useState(false);
  const reasonConfig = REASON_CONFIG[item.reason] ?? DEFAULT_REASON_CONFIG;

  return (
    <div className="border-l-2 border-red-500 pl-3">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded py-1.5 text-left transition-colors hover:bg-muted/50"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {item.messageId}
        </span>
        <Badge
          className={cn('shrink-0 text-xs font-normal border-0', reasonConfig.className)}
        >
          {reasonConfig.label}
        </Badge>
        <span className="shrink-0 text-xs text-muted-foreground">
          {formatTimeAgo(item.failedAt)}
        </span>
      </button>

      {expanded && (
        <div className="pb-2 pr-2 pt-1">
          <span className="text-xs font-medium text-muted-foreground">Envelope</span>
          <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted p-2 font-mono text-xs">
            {JSON.stringify(item.envelope, null, 2)}
          </pre>
          <p className="mt-1 text-xs text-muted-foreground">
            Endpoint: <span className="font-mono">{item.endpointHash}</span>
          </p>
        </div>
      )}
    </div>
  );
}

interface DeadLetterSectionProps {
  /** Optional endpoint hash to scope dead-letter results. */
  endpointHash?: string;
  /** When false, the query is skipped (Relay feature gate). Defaults to true. */
  enabled?: boolean;
}

/**
 * Collapsible section listing dead-lettered relay messages.
 *
 * Renders nothing when the list is empty. Shows an AlertTriangle header
 * with a count badge; each row has a red 2px left border and a
 * color-coded rejection reason badge.
 *
 * @param endpointHash - Optional endpoint hash filter.
 * @param enabled - When false, skips the query entirely.
 */
export function DeadLetterSection({ endpointHash, enabled = true }: DeadLetterSectionProps) {
  const [open, setOpen] = useState(false);
  const filters = endpointHash != null ? { endpointHash } : undefined;
  const { data: deadLetters = [], isLoading } = useDeadLetters(filters, enabled);

  if (isLoading || deadLetters.length === 0) return null;

  const ChevronIcon = open ? ChevronDown : ChevronRight;

  return (
    <div className="border-t">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
        aria-expanded={open}
      >
        <AlertTriangle className="size-4 shrink-0 text-red-500" />
        <span className="flex-1 text-sm font-medium">Dead Letters</span>
        <Badge variant="destructive" className="shrink-0 tabular-nums">
          {deadLetters.length}
        </Badge>
        <ChevronIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="space-y-1 px-3 pb-3">
          {deadLetters.map((item) => (
            <DeadLetterRow key={item.messageId} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
