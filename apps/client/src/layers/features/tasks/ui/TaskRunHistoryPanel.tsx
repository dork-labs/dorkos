import {
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  MinusCircle,
  Play,
  SkipForward,
  XCircle,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useInfiniteTaskRuns, useCancelTaskRun } from '@/layers/entities/tasks';
import { useSessionId, useDirectoryState } from '@/layers/entities/session';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/layers/shared/ui';
import type { TaskRun, TaskRunStatus } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return '< 1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/** Truncate a multi-line string to its first line, clipped at maxLen chars. */
function firstLine(text: string, maxLen = 80): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line;
}

/** Format an ISO date string as "Feb 10, 2:45 PM". */
function formatAbsoluteTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { status: TaskRun['status'] }) {
  switch (status) {
    case 'running':
      return (
        <span title="Running" aria-label="Running">
          <Loader2 className="size-3.5 animate-spin text-blue-500" />
        </span>
      );
    case 'completed':
      return (
        <span title="Completed" aria-label="Completed">
          <CheckCircle2 className="size-3.5 text-green-500" />
        </span>
      );
    case 'failed':
      return (
        <span title="Failed" aria-label="Failed">
          <XCircle className="text-destructive size-3.5" />
        </span>
      );
    case 'cancelled':
      return (
        <span title="Cancelled" aria-label="Cancelled">
          <MinusCircle className="text-muted-foreground size-3.5" />
        </span>
      );
    case 'skipped':
      // Not a failure and not a cancellation: the schedule came round while
      // DorkOS was already running as many tasks as it is allowed to, so this
      // occurrence was recorded and not run. The row's error text says so.
      return (
        <span title="Skipped — DorkOS was busy" aria-label="Skipped">
          <SkipForward className="text-muted-foreground size-3.5" />
        </span>
      );
    default:
      return null;
  }
}

/** TriggerIcon renders a Clock for scheduled runs and a Play for manual runs. */
function TriggerIcon({ trigger }: { trigger: TaskRun['trigger'] }) {
  if (trigger === 'scheduled') {
    return (
      <Clock className="text-muted-foreground/70 mr-1 inline size-3 shrink-0" aria-hidden="true" />
    );
  }
  if (trigger === 'manual') {
    return (
      <Play className="text-muted-foreground/70 mr-1 inline size-3 shrink-0" aria-hidden="true" />
    );
  }
  return null;
}

/**
 * RunTimestamp shows relative time for runs < 7 days old and absolute time
 * for older runs, with a hover tooltip showing the opposite format.
 */
function RunTimestamp({ date }: { date: string }) {
  const now = new Date();
  const parsed = new Date(date);
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const isRecent = parsed >= sevenDaysAgo;
  const displayText = isRecent ? formatRelativeTime(date) : formatAbsoluteTime(date);
  const titleText = isRecent ? formatAbsoluteTime(date) : formatRelativeTime(date);

  return (
    <time dateTime={date} title={titleText}>
      {displayText}
    </time>
  );
}

/** RunRowSkeleton provides a loading placeholder matching the 5-column grid. */
function RunRowSkeleton() {
  return (
    <div className="grid grid-cols-[20px_56px_1fr_64px_72px_20px] items-center gap-2 rounded-md px-2 py-2">
      <Skeleton className="size-3.5 rounded-full" />
      <Skeleton className="h-3 w-10" />
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-3 w-8" />
      <span />
      <span />
    </div>
  );
}

interface RunRowProps {
  run: TaskRun;
  onNavigate: (sessionId: string) => void;
  onCancel: (id: string) => void;
  isCancelling: boolean;
}

/**
 * Single run row rendered as a CSS grid.
 *
 * The outer element is a plain div. When the run has a sessionId, an invisible
 * full-coverage anchor-style overlay div handles the click so that the Cancel
 * button (a real <button>) sits outside the clickable region and avoids the
 * invalid nested-button HTML constraint.
 */
function RunRow({ run, onNavigate, onCancel, isCancelling }: RunRowProps) {
  const isClickable = !!run.sessionId;

  function handleRowClick() {
    if (run.sessionId) onNavigate(run.sessionId);
  }

  function handleCancel(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation();
    onCancel(run.id);
  }

  const startedLabel = run.startedAt ? formatAbsoluteTime(run.startedAt) : 'unknown time';

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- role/tabIndex/onKeyDown are conditionally set based on isClickable
    <div
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      aria-label={isClickable ? `View ${run.status} run from ${startedLabel}` : undefined}
      onClick={isClickable ? handleRowClick : undefined}
      onKeyDown={
        isClickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleRowClick();
              }
            }
          : undefined
      }
      className={cn(
        'grid grid-cols-[20px_56px_1fr_64px_72px_20px] items-center gap-2',
        'rounded-md border border-transparent px-2 py-2 text-xs transition-colors',
        isClickable && [
          'hover:bg-muted/50 hover:border-border cursor-pointer',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
        ],
        run.status === 'failed' && 'bg-destructive/5'
      )}
    >
      <StatusIcon status={run.status} />

      <span className="text-muted-foreground truncate capitalize">
        <TriggerIcon trigger={run.trigger} />
        {run.trigger}
      </span>

      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-foreground">
          {run.startedAt ? <RunTimestamp date={run.startedAt} /> : '-'}
        </span>
        {run.outputSummary && (
          <span className="text-muted-foreground truncate" title={run.outputSummary}>
            {firstLine(run.outputSummary)}
          </span>
        )}
        {run.status === 'failed' && run.error && (
          <span className="text-destructive truncate" title={run.error}>
            {firstLine(run.error)}
          </span>
        )}
      </span>

      <span className="text-muted-foreground">{formatDuration(run.durationMs)}</span>

      <span>
        {run.status === 'running' && (
          <button
            type="button"
            disabled={isCancelling}
            onClick={handleCancel}
            className={cn(
              'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
              'text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-accent-foreground',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
              'disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            Stop
          </button>
        )}
      </span>

      <span className="flex items-center justify-end">
        {isClickable && (
          <ChevronRight className="text-muted-foreground/50 size-3.5" aria-hidden="true" />
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface Props {
  scheduleId: string;
  scheduleCwd: string | null;
}

const LIMIT = 20;

/** Run history list for a Tasks schedule with status filtering and pagination. */
export function TaskRunHistoryPanel({ scheduleId, scheduleCwd }: Props) {
  const [statusFilter, setStatusFilter] = useState<TaskRunStatus | 'all'>('all');

  const status = statusFilter === 'all' ? undefined : statusFilter;
  // Every loaded page stays live (see `useInfiniteTaskRuns`): a run that finishes
  // while you are three pages down updates in place rather than spinning forever.
  // The filter is part of the query key, so changing it starts a fresh list at
  // page one without this component tracking an offset at all.
  const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteTaskRuns({
      scheduleId,
      status,
      limit: LIMIT,
    });
  const cancelTaskRun = useCancelTaskRun();
  const [, setActiveSession] = useSessionId();
  const [selectedCwd, setSelectedCwd] = useDirectoryState();

  const allRuns = useMemo<TaskRun[]>(() => data?.pages.flat() ?? [], [data]);

  const handleLoadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  const handleFilterChange = useCallback((value: string) => {
    setStatusFilter(value as TaskRunStatus | 'all');
  }, []);

  const handleNavigateToRun = useCallback(
    (sessionId: string) => {
      if (scheduleCwd && scheduleCwd !== selectedCwd) {
        setSelectedCwd(scheduleCwd, { preserveSession: true });
      }
      setActiveSession(sessionId);
    },
    [scheduleCwd, selectedCwd, setSelectedCwd, setActiveSession]
  );

  if (isLoading && allRuns.length === 0) {
    return (
      <div className="space-y-0.5" aria-label="Loading runs...">
        <RunRowSkeleton />
        <RunRowSkeleton />
        <RunRowSkeleton />
      </div>
    );
  }

  // Before the empty state, never after it: a history we could not read is not
  // a history with nothing in it, and "No runs yet" for a failed fetch is the
  // panel inventing an answer it does not have.
  if (isError && allRuns.length === 0) {
    return (
      <div className="space-y-2">
        <StatusFilterSelect value={statusFilter} onChange={handleFilterChange} />
        <div className="py-4 text-center">
          <p className="text-muted-foreground text-xs">Couldn&rsquo;t load this run history.</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="text-muted-foreground hover:text-foreground mt-1 text-xs underline-offset-4 hover:underline"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (allRuns.length === 0 && !isLoading) {
    return (
      <div className="space-y-2">
        <StatusFilterSelect value={statusFilter} onChange={handleFilterChange} />
        <p className="text-muted-foreground py-4 text-center text-xs">
          {statusFilter === 'all' ? 'No runs yet' : `No ${statusFilter} runs`}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      <StatusFilterSelect value={statusFilter} onChange={handleFilterChange} />
      {/* Column headers — desktop only */}
      <div className="sm:text-muted-foreground hidden sm:grid sm:grid-cols-[20px_56px_1fr_64px_72px_20px] sm:gap-2 sm:px-2 sm:pb-1 sm:text-xs sm:font-medium">
        <span />
        <span>Trigger</span>
        <span>Started</span>
        <span>Duration</span>
        <span />
        <span />
      </div>
      {allRuns.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          onNavigate={handleNavigateToRun}
          onCancel={(id) =>
            cancelTaskRun.mutate(id, {
              // Bare, not `.success` — both outcomes are a neutral status
              // report ("already done" / "in progress"), not a confirmation
              // that the click itself succeeded.
              onSuccess: (result) =>
                toast(
                  result.state === 'already_finished'
                    ? 'That run had already finished'
                    : 'Stopping the run'
                ),
              // No local onError: the shared mutation toast
              // (`useCancelTaskRun`'s `meta.errorLabel`) reports a failure —
              // this used to show its own on top of it.
            })
          }
          isCancelling={cancelTaskRun.isPending}
        />
      ))}
      {hasNextPage && (
        <button
          type="button"
          onClick={handleLoadMore}
          disabled={isFetchingNextPage}
          className="text-muted-foreground hover:bg-muted/50 hover:text-foreground mt-1 w-full rounded-md py-1.5 text-xs transition-colors disabled:opacity-50"
        >
          {isFetchingNextPage ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  );
}

/** Compact status filter dropdown. */
function StatusFilterSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger responsive={false} className="h-7 w-[130px] text-xs">
          <SelectValue placeholder="Filter status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          <SelectItem value="running">Running</SelectItem>
          <SelectItem value="completed">Completed</SelectItem>
          <SelectItem value="failed">Failed</SelectItem>
          <SelectItem value="cancelled">Cancelled</SelectItem>
          <SelectItem value="skipped">Skipped</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
