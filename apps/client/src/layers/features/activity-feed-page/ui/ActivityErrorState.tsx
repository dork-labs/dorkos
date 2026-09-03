import { TriangleAlert } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

export interface ActivityErrorStateProps {
  /** Retries the failed fetch. */
  onRetry: () => void;
  className?: string;
}

/**
 * Shown in place of the timeline when the activity feed fails to load.
 *
 * A failed request and a genuinely quiet week produce the same empty list, so
 * `ActivityTimeline` needs a state that says which one this is — the same
 * "couldn't load, here's why, try again" shape `TeamPage` and
 * `FeedbackRequestsPanel` already use for their own feeds.
 */
export function ActivityErrorState({ onRetry, className }: ActivityErrorStateProps) {
  return (
    <div
      data-slot="activity-error-state"
      className={cn('flex flex-col items-center justify-center gap-3 py-16 text-center', className)}
    >
      <div className="bg-destructive/10 rounded-xl p-3">
        <TriangleAlert className="text-destructive size-6" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">Couldn&rsquo;t load your activity</p>
        <p className="text-muted-foreground max-w-xs text-xs">
          The DorkOS server did not answer. Check that it is still running.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
