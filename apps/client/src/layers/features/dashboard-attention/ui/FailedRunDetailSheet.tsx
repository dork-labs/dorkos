import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  Badge,
  Button,
  ScrollArea,
  Skeleton,
} from '@/layers/shared/ui';
import { useInteractionStore } from '@/layers/entities/interactions';
import { useTaskRun, useCancelTaskRun } from '@/layers/entities/tasks';
import { useNavigate } from '@tanstack/react-router';
import { cn, formatCompactAge } from '@/layers/shared/lib';
import type { TaskRun } from '@dorkos/shared/types';

interface FailedRunDetailSheetProps {
  open: boolean;
  itemId: string | undefined;
  onClose: () => void;
}

/** Format milliseconds to a human-readable duration (e.g. "2m 30s"). */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * How this run ended, in the words and the colour it earns.
 *
 * Derived from the RUN, never from the notification that opened the sheet. The
 * inbox row's own signal is kind-plus-tier, which cannot tell a failure from a
 * run that was blocked (`isFailedRun`, `entities/notifications`) — so the sheet
 * used to print a hardcoded red "Failed" over whatever it was handed, and a
 * blocked run arrived reported as a breakage that never happened (DOR-2101
 * review). The run row is the ground truth and the sheet already fetches it,
 * which is why no status is denormalized onto the notification to fix this.
 *
 * @param status - The run's own terminal status.
 */
function runVerdict(status: TaskRun['status']): {
  label: string;
  badge: 'destructive' | 'secondary' | 'outline';
  /** Whether the explanation reads as a breakage (red) or a limit (amber). */
  tone: 'error' | 'warning' | 'neutral';
  /** The heading over the explanation box. */
  heading: string;
  /**
   * The sheet's own title.
   *
   * Every status gets one, not just the two that used to be special-cased: a
   * sheet headed "Run that didn't finish" over a run that finished, or over
   * one that is still going, is the same small lie the hardcoded "Failed"
   * badge was (DOR-2101 review).
   */
  title: string;
} {
  switch (status) {
    case 'blocked':
      return {
        label: 'Blocked',
        badge: 'outline',
        tone: 'warning',
        heading: 'What it needed',
        title: 'Run that couldn’t use its tools',
      };
    case 'failed':
      return {
        label: 'Failed',
        badge: 'destructive',
        tone: 'error',
        heading: 'Error',
        title: 'Run that didn’t finish',
      };
    case 'cancelled':
      return {
        label: 'Cancelled',
        badge: 'secondary',
        tone: 'neutral',
        heading: 'Stopped',
        title: 'Run that was stopped',
      };
    case 'skipped':
      return {
        label: 'Skipped',
        badge: 'secondary',
        tone: 'neutral',
        heading: 'Why',
        title: 'Run that never started',
      };
    case 'running':
      return {
        label: 'Running',
        badge: 'secondary',
        tone: 'neutral',
        heading: 'Latest',
        title: 'Run that is still going',
      };
    default:
      return {
        label: 'Completed',
        badge: 'secondary',
        tone: 'neutral',
        heading: 'Note',
        title: 'Run that finished',
      };
  }
}

/** The classes the explanation box draws in, per {@link runVerdict} tone. */
const EXPLANATION_TONE = {
  error: {
    box: 'bg-destructive/10 border-destructive/20',
    heading: 'text-destructive',
    body: 'text-destructive',
  },
  warning: {
    box: 'bg-status-warning-bg border-status-warning-border',
    heading: 'text-status-warning-fg',
    body: 'text-status-warning-fg/80',
  },
  neutral: {
    box: 'bg-muted border-border',
    heading: 'text-foreground',
    body: 'text-foreground/80',
  },
} as const satisfies Record<'error' | 'warning' | 'neutral', Record<string, string>>;

/**
 * Detail sheet for a Tasks run that wants a person's attention, showing status,
 * trigger, timeline, what went wrong (or what it was not allowed to do), output
 * summary, and available actions.
 */
export function FailedRunDetailSheet({ open, itemId, onClose }: FailedRunDetailSheetProps) {
  const { data: run, isLoading, isError } = useTaskRun(open ? (itemId ?? null) : null);
  const cancelMutation = useCancelTaskRun();
  const navigate = useNavigate();

  const handleViewSession = () => {
    if (!run?.sessionId) return;
    // The other half of the Recent-Activity rows' door (DOR-1156) — those
    // rows are Inbox notifications now, so the door is opened by
    // `notificationLink` in `entities/notifications`. No directory to record an
    // agent against: a run's detail carries the session and nothing else.
    useInteractionStore.getState().recordOpened('session', run.sessionId);
    void navigate({
      to: '/session',
      search: { session: run.sessionId },
    });
  };

  const handleCancel = () => {
    if (!run) return;
    cancelMutation.mutate(run.id);
  };

  const verdict = run ? runVerdict(run.status) : null;
  const explanation = verdict ? EXPLANATION_TONE[verdict.tone] : null;

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent side="right">
        <SheetHeader>
          {/* From the run, like the badge and the box below it. A blocked run
              DID finish — it just was not allowed to do anything — and the old
              fixed title was the second thing on this sheet that told a person
              something untrue about it. Before the run loads there is nothing
              to be exact about, so neutral wording stands in. */}
          <SheetTitle>{verdict?.title ?? 'Run that needs a look'}</SheetTitle>
          <SheetDescription>{itemId ? itemId.slice(0, 8) : 'Unknown'}</SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4">
          {isLoading && (
            <div className="space-y-4">
              <Skeleton className="h-6 w-24" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-20 w-full" />
            </div>
          )}

          {isError && (
            <p className="text-destructive py-8 text-center text-sm">Couldn’t load this run.</p>
          )}

          {!isLoading && !isError && !run && (
            <p className="text-muted-foreground py-8 text-center text-sm">
              This item has been resolved.
            </p>
          )}

          {run && (
            <div className="space-y-4">
              {/* Status and trigger badges */}
              <div className="flex gap-2">
                <Badge variant={verdict!.badge}>{verdict!.label}</Badge>
                <Badge variant="secondary">
                  {run.trigger === 'scheduled' ? 'Scheduled' : 'Manual'}
                </Badge>
              </div>

              {/* Timeline */}
              <div className="space-y-1 text-sm">
                {run.startedAt && (
                  <p className="text-muted-foreground">
                    Started: {formatCompactAge(run.startedAt)} ago
                  </p>
                )}
                {run.finishedAt && (
                  <p className="text-muted-foreground">
                    Finished: {formatCompactAge(run.finishedAt)} ago
                  </p>
                )}
                {run.durationMs != null && (
                  <p className="text-muted-foreground">
                    Duration: {formatDuration(run.durationMs)}
                  </p>
                )}
              </div>

              {/* What went wrong — or, for a blocked run, what it was denied.
                  Nothing broke there, so it must not draw in the failure red. */}
              {run.error && (
                <div className={cn('rounded-md border p-3', explanation!.box)}>
                  <p className={cn('text-sm font-medium', explanation!.heading)}>
                    {verdict!.heading}
                  </p>
                  <p className={cn('mt-1 text-sm', explanation!.body)}>{run.error}</p>
                </div>
              )}

              {/* Output summary */}
              {run.outputSummary && (
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs font-medium">Output</p>
                  <pre className="bg-muted max-h-48 overflow-auto rounded-md p-3 font-mono text-xs">
                    {run.outputSummary}
                  </pre>
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        <SheetFooter>
          {run?.sessionId && (
            <Button variant="default" onClick={handleViewSession}>
              View Session
            </Button>
          )}
          {run?.status === 'running' && (
            <Button
              variant="destructive"
              onClick={handleCancel}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? 'Cancelling…' : 'Cancel'}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
