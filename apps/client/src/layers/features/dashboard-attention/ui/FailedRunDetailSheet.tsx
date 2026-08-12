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
import { formatRelativeTime } from '../lib/format-relative-time';

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
 * Detail sheet for a failed Tasks run, showing status, trigger, timeline,
 * error message, output summary, and available actions.
 */
export function FailedRunDetailSheet({ open, itemId, onClose }: FailedRunDetailSheetProps) {
  const { data: run, isLoading, isError } = useTaskRun(open ? (itemId ?? null) : null);
  const cancelMutation = useCancelTaskRun();
  const navigate = useNavigate();

  const handleViewSession = () => {
    if (!run?.sessionId) return;
    // The other half of the attention section's door (DOR-1156) — see
    // `use-attention-items`. No directory to record an agent against: a run's
    // detail carries the session and nothing else.
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

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Failed Run</SheetTitle>
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
            <p className="text-destructive py-8 text-center text-sm">Failed to load run details.</p>
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
                <Badge variant="destructive">Failed</Badge>
                <Badge variant="secondary">
                  {run.trigger === 'scheduled' ? 'Scheduled' : 'Manual'}
                </Badge>
              </div>

              {/* Timeline */}
              <div className="space-y-1 text-sm">
                {run.startedAt && (
                  <p className="text-muted-foreground">
                    Started: {formatRelativeTime(run.startedAt)} ago
                  </p>
                )}
                {run.finishedAt && (
                  <p className="text-muted-foreground">
                    Finished: {formatRelativeTime(run.finishedAt)} ago
                  </p>
                )}
                {run.durationMs != null && (
                  <p className="text-muted-foreground">
                    Duration: {formatDuration(run.durationMs)}
                  </p>
                )}
              </div>

              {/* Error message */}
              {run.error && (
                <div className="bg-destructive/10 border-destructive/20 rounded-md border p-3">
                  <p className="text-destructive text-sm font-medium">Error</p>
                  <p className="text-destructive/80 mt-1 text-sm">{run.error}</p>
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
              {cancelMutation.isPending ? 'Cancelling...' : 'Cancel'}
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
