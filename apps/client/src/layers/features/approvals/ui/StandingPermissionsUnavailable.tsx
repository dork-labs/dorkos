import { Button } from '@/layers/shared/ui';

export interface StandingPermissionsUnavailableProps {
  /** Read the list again. */
  onRetry: () => void;
}

/**
 * What a person sees when DorkOS cannot read the standing-permission list.
 *
 * The same argument as {@link ApprovalsUnavailable}, pointed the other way, and it
 * is if anything sharper. There, a failed read looks like "nothing is waiting" and
 * hides an agent that is blocked. Here, a failed read looks like "nothing is
 * trusted" and hides an agent that is **not** blocked: the gate goes on
 * auto-approving under a permission the person can no longer see, and therefore
 * cannot end. An empty list is the most reassuring thing this surface can say, so
 * it is the last thing it should say when it does not know.
 *
 * Separate copy rather than a shared component, because the two say genuinely
 * different things and the sentence is the whole point of both.
 *
 * @param props - The {@link StandingPermissionsUnavailableProps.onRetry} handler.
 */
export function StandingPermissionsUnavailable({ onRetry }: StandingPermissionsUnavailableProps) {
  return (
    <div
      data-slot="standing-permissions-error"
      data-testid="standing-permissions-error"
      className="bg-background/60 border-status-warning-border/40 flex min-w-0 flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center"
    >
      <p className="text-muted-foreground min-w-0 flex-1 text-xs">
        DorkOS could not check which standing permissions are live. Some agents may still be acting
        without asking.
      </p>
      <Button variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
