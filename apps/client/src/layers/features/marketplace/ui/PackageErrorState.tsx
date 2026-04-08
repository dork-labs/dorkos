import { AlertTriangle, WifiOff } from 'lucide-react';
import { Button } from '@/layers/shared/ui';

/** Network-related error pattern — surfaces the offline icon. */
const NETWORK_ERROR_RE = /network|fetch|offline/i;

interface PackageErrorStateProps {
  /** The error returned by `useMarketplacePackages`. */
  error: Error;
  /** Called when the user clicks "Try again" to refetch. */
  onRetry: () => void;
}

/**
 * Error state for marketplace browse failures.
 *
 * Detects network/offline errors (via message pattern) and surfaces `WifiOff`
 * with a more specific heading. All other errors render `AlertTriangle` with a
 * generic "Something went wrong" heading. In both cases the raw error message
 * is shown and a "Try again" button triggers `onRetry`.
 *
 * @param error - Error instance from the query.
 * @param onRetry - Refetch callback bound to the parent query's `refetch`.
 */
export function PackageErrorState({ error, onRetry }: PackageErrorStateProps) {
  const isOffline = NETWORK_ERROR_RE.test(error.message);
  const Icon = isOffline ? WifiOff : AlertTriangle;
  const heading = isOffline ? 'You appear to be offline' : 'Something went wrong';

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-16 text-center">
      <Icon className="text-muted-foreground mb-4 size-10" aria-hidden />
      <h3 className="mb-2 text-base font-semibold">{heading}</h3>
      <p className="text-muted-foreground mb-4 max-w-sm text-sm">{error.message}</p>
      <Button variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
