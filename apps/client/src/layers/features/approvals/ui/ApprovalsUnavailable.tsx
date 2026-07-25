import { Button } from '@/layers/shared/ui';

export interface ApprovalsUnavailableProps {
  /** Read the list again. */
  onRetry: () => void;
}

/**
 * What a person sees when DorkOS cannot read the approval list.
 *
 * This is the one state that must never look like silence. A failed read and
 * "nothing is waiting" are the same empty space on screen, and the difference is
 * an agent sitting blocked while nobody knows to answer it. So the failure says
 * so, in plain words, and offers to try again.
 *
 * @param props - The {@link ApprovalsUnavailableProps.onRetry} handler.
 */
export function ApprovalsUnavailable({ onRetry }: ApprovalsUnavailableProps) {
  return (
    <div
      data-slot="approvals-error"
      className="bg-background/60 border-status-warning-border/40 flex min-w-0 flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center"
    >
      <p className="text-muted-foreground min-w-0 flex-1 text-xs">
        DorkOS could not check whether anything is waiting for your approval. An agent may be
        paused.
      </p>
      <Button variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
