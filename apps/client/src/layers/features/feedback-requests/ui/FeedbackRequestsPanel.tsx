import { Bug, Lightbulb, MessageSquare, Paperclip, RefreshCw, TriangleAlert } from 'lucide-react';
import { useMyFeedback } from '@/layers/entities/feedback-requests';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { Button, Skeleton } from '@/layers/shared/ui';
import type { FeedbackListItem } from '@dorkos/shared/telemetry-events';
import { formatShippedVersionLabel } from '../lib/version-label';

const KIND_ICON: Record<FeedbackListItem['kind'], typeof Bug> = {
  bug: Bug,
  idea: Lightbulb,
  feedback: MessageSquare,
};

const KIND_LABEL: Record<FeedbackListItem['kind'], string> = {
  bug: 'Bug',
  idea: 'Idea',
  feedback: 'Feedback',
};

/**
 * Cockpit-visible status label, per design-decisions.md §7:
 * `Received → Triaged → In progress → Shipped vX.Y.Z / Closed`.
 *
 * The `v` prefix on a shipped version goes through
 * {@link formatShippedVersionLabel} — a Linear milestone/cycle name that
 * isn't a bare version (e.g. "Cycle 12") renders as-is instead of "vCycle 12",
 * agreeing with the shipped email and the public status page.
 */
function statusLabel(item: FeedbackListItem): string {
  switch (item.status) {
    case 'received':
      return 'Received';
    case 'triaged':
      return 'Triaged';
    case 'in_progress':
      return 'In progress';
    case 'shipped':
      return item.shippedVersion
        ? `Shipped ${formatShippedVersionLabel(item.shippedVersion)}`
        : 'Shipped';
    case 'closed':
      return 'Closed';
  }
}

/** Badge color per status — amber for in-flight work, green for shipped, neutral otherwise. */
function statusBadgeClasses(status: FeedbackListItem['status']): string {
  switch (status) {
    case 'in_progress':
      return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'shipped':
      return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/** Truncate a multi-line message to its first line, clipped at maxLen chars. */
function firstLine(text: string, maxLen = 140): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line;
}

/** "screenshot, transcript" attachment hint text, or null when nothing was attached. */
function attachmentHint(item: FeedbackListItem): string | null {
  const parts = [item.hasScreenshot && 'screenshot', item.hasTranscript && 'transcript'].filter(
    (part): part is string => Boolean(part)
  );
  return parts.length > 0 ? parts.join(', ') : null;
}

function FeedbackRow({ item }: { item: FeedbackListItem }) {
  const Icon = KIND_ICON[item.kind] ?? MessageSquare;
  const hint = attachmentHint(item);

  return (
    <li className="hover:bg-muted/50 flex items-start gap-3 rounded-md px-2 py-2.5 transition-colors">
      <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-sm" title={item.message}>
          {firstLine(item.message)}
        </p>
        <p className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
          <span>
            {KIND_LABEL[item.kind]} · {formatRelativeTime(item.createdAt)}
          </span>
          {hint && (
            <span className="inline-flex items-center gap-0.5">
              <span aria-hidden="true">·</span>
              <Paperclip className="size-3" aria-hidden="true" />
              {hint}
            </span>
          )}
        </p>
      </div>
      <span
        className={cn(
          'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
          statusBadgeClasses(item.status)
        )}
      >
        {statusLabel(item)}
      </span>
    </li>
  );
}

function FeedbackRowSkeleton() {
  return (
    <li className="flex items-start gap-3 rounded-md px-2 py-2.5" aria-hidden="true">
      <Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-1/3" />
      </div>
      <Skeleton className="h-4 w-16 shrink-0 rounded-full" />
    </li>
  );
}

/**
 * The "Product feedback" tracking view (feedback-pipeline Part 4, design-
 * decisions.md §7). Lists what this install has sent the DorkOS team and
 * where each report stands, keyed by the install's own pseudonymous
 * `instanceId` — no login required.
 */
export function FeedbackRequestsPanel() {
  const { data: items, isLoading, isError, refetch, isFetching } = useMyFeedback();

  if (isLoading) {
    return (
      <ul className="space-y-0.5" aria-label="Loading your reports…">
        <FeedbackRowSkeleton />
        <FeedbackRowSkeleton />
        <FeedbackRowSkeleton />
      </ul>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="bg-destructive/10 rounded-xl p-3">
          <TriangleAlert className="text-destructive size-6" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Couldn&apos;t load your reports</p>
          <p className="text-muted-foreground mt-1 text-xs">
            The feedback service is unreachable. Check that you&apos;re online and try again.
          </p>
        </div>
        <Button size="sm" onClick={() => void refetch()} disabled={isFetching} className="mt-1">
          <RefreshCw
            className={cn('mr-1.5 size-3.5', isFetching && 'animate-spin')}
            aria-hidden="true"
          />
          Retry
        </Button>
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <MessageSquare className="text-muted-foreground/50 size-8" aria-hidden="true" />
        <p className="text-sm font-medium">Nothing sent yet</p>
        <p className="text-muted-foreground max-w-xs text-xs">
          Send feedback, report a bug, or share an idea from the help menu — it&apos;ll show up
          here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {items.map((item) => (
          <FeedbackRow key={item.id} item={item} />
        ))}
      </ul>
      <p className="text-muted-foreground border-border mt-2 border-t px-2 pt-2 text-xs">
        Add your email to a report to get a note when it ships.
      </p>
    </div>
  );
}
