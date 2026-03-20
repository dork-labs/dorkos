import { useState } from 'react';
import { AlertTriangle, Eye, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  useAggregatedDeadLetters,
  useDismissDeadLetterGroup,
  useDeliveryMetrics,
} from '@/layers/entities/relay';
import type { AggregatedDeadLetter } from '@/layers/entities/relay';
import { formatTimeAgo } from '../lib/format-time';

/** Map of rejection reason codes to display label and badge variant. */
const REASON_CONFIG: Record<string, { label: string; className: string }> = {
  hop_limit: {
    label: 'Hop Limit',
    className: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  },
  ttl_expired: {
    label: 'TTL Expired',
    className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  },
  cycle_detected: {
    label: 'Cycle Detected',
    className: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  },
  budget_exhausted: {
    label: 'Budget Exhausted',
    className: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  },
};

/** Fallback config for unknown reason codes. */
const DEFAULT_REASON_CONFIG = {
  label: 'Unknown',
  className: 'bg-muted text-muted-foreground',
};

/** Format a time range from two ISO timestamps into a compact relative string. */
function formatTimeRange(firstSeen: string, lastSeen: string): string {
  const first = formatTimeAgo(firstSeen);
  const last = formatTimeAgo(lastSeen);
  if (first === last) return last;
  return `${first} — ${last}`;
}

interface AggregatedCardProps {
  group: AggregatedDeadLetter;
}

/** Single aggregated failure card showing collapsed dead letters for a source + reason pair. */
function AggregatedCard({ group }: AggregatedCardProps) {
  const [sampleOpen, setSampleOpen] = useState(false);
  const dismissMutation = useDismissDeadLetterGroup();
  const reasonConfig = REASON_CONFIG[group.reason] ?? DEFAULT_REASON_CONFIG;

  return (
    <div className="rounded-lg border border-red-200 bg-red-50/50 p-3 dark:border-red-900/40 dark:bg-red-950/20">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{group.source}</span>
            <Badge className={cn('shrink-0 border-0 text-xs font-normal', reasonConfig.className)}>
              {reasonConfig.label}
            </Badge>
            <Badge variant="destructive" className="shrink-0 tabular-nums">
              {group.count.toLocaleString()}
            </Badge>
          </div>
          <p className="text-muted-foreground text-xs">
            {formatTimeRange(group.firstSeen, group.lastSeen)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {group.sample != null && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setSampleOpen(true)}
              >
                <Eye className="mr-1 size-3" />
                View Sample
              </Button>
              <Dialog open={sampleOpen} onOpenChange={setSampleOpen}>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Sample Envelope</DialogTitle>
                    <DialogDescription>
                      Representative failure from {group.source} ({reasonConfig.label})
                    </DialogDescription>
                  </DialogHeader>
                  <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 font-mono text-xs">
                    {JSON.stringify(group.sample, null, 2)}
                  </pre>
                </DialogContent>
              </Dialog>
            </>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground h-7 px-2 text-xs"
                disabled={dismissMutation.isPending}
              >
                <Trash2 className="mr-1 size-3" />
                Mark Resolved
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Mark dead letters as resolved?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will dismiss {group.count} dead letter{group.count !== 1 ? 's' : ''} from{' '}
                  <span className="font-medium">{group.source}</span> ({reasonConfig.label}). This
                  action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    dismissMutation.mutate({ source: group.source, reason: group.reason })
                  }
                >
                  Mark Resolved
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}

interface DeadLetterSectionProps {
  /** When false, the query is skipped (Relay feature gate). Defaults to true. */
  enabled?: boolean;
}

/**
 * Aggregated failure cards for dead-lettered relay messages.
 *
 * Collapses identical dead letters into grouped cards by source + reason.
 * Each card shows the count, time range, and provides "View Sample" and
 * "Dismiss All" actions. Renders nothing when there are no dead letters.
 *
 * @param enabled - When false, skips the query entirely.
 */
export function DeadLetterSection({ enabled = true }: DeadLetterSectionProps) {
  const { data: groups = [], isLoading } = useAggregatedDeadLetters(enabled);
  const { data: metrics } = useDeliveryMetrics();
  const budgetRejections = metrics?.budgetRejections;
  const hasBudgetRejections =
    budgetRejections && Object.values(budgetRejections).some((v) => v > 0);

  if (isLoading || groups.length === 0) return null;

  return (
    <div className="space-y-2">
      {hasBudgetRejections && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
            Budget rejections: {budgetRejections.hopLimit} hop limit,{' '}
            {budgetRejections.cycleDetected} cycles, {budgetRejections.budgetExhausted} budget,{' '}
            {budgetRejections.ttlExpired} TTL
          </p>
        </div>
      )}
      {groups.map((group) => (
        <AggregatedCard key={`${group.source}:${group.reason}`} group={group} />
      ))}
    </div>
  );
}
