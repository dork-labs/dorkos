/**
 * The one shape a "couldn't load it, try again" panel takes.
 *
 * Four page-level surfaces had hand-rolled this, down to the same Tailwind
 * class order — copy-paste, not coincidence — so a fifth would have copied the
 * fourth (DOR-1763 finding 17.2). It is {@link EmptyState} wearing the
 * destructive tone, because "nothing here" and "nothing here because it broke"
 * are the same panel with different news.
 *
 * @module shared/ui/query-error-state
 */
import { TriangleAlert } from 'lucide-react';
import { EmptyState } from './empty-state';

/** Everything a failed-load panel renders. */
export interface QueryErrorStateProps {
  /** What failed, in one short line — "Could not load your team". */
  title: string;
  /** Why, and what to check, in one more line. */
  description: string;
  /** Ask for it again. */
  onRetry: () => void;
  /** Whether the retry is already in flight — the button waits with a spinner. */
  isRetrying?: boolean;
  className?: string;
}

/**
 * A panel saying a request failed, with one button to ask again.
 *
 * @param title - What failed, in one short line.
 * @param description - Why, and what to check.
 * @param onRetry - Ask for it again.
 * @param isRetrying - Whether the retry is already running.
 */
function QueryErrorState({
  title,
  description,
  onRetry,
  isRetrying = false,
  className,
}: QueryErrorStateProps) {
  return (
    <EmptyState
      icon={TriangleAlert}
      tone="destructive"
      headline={title}
      description={description}
      action={{ label: 'Retry', onClick: onRetry, busy: isRetrying }}
      className={className}
    />
  );
}

export { QueryErrorState };
