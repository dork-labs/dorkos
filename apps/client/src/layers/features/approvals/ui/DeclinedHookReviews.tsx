import { Button } from '@/layers/shared/ui';
import { useDeclinedHookApprovals, useAskAgainHookApproval } from '../model/use-hook-reviews';

/** Individual recovery lives in Inbox history; it never adds to the pending count. */
export function DeclinedHookReviews({ enabled }: { enabled: boolean }) {
  const query = useDeclinedHookApprovals(enabled);
  const ask = useAskAgainHookApproval();
  if (query.isError)
    return (
      <p role="alert" className="text-muted-foreground text-xs">
        Couldn’t read declined hooks. Reopen the Inbox.
      </p>
    );
  if (!query.data?.approvals.length) return null;
  return (
    <section aria-label="Declined hooks" className="space-y-2">
      {query.data.approvals.map(
        ({ approval, declineKind, canAskAgain, reviewPending, askedAgain }) => (
          <div
            key={approval.approvalId}
            data-slot="declined-hook"
            data-hook-review-id={approval.approvalId}
            className="border-border bg-background min-w-0 rounded-lg border p-3"
          >
            <h3 className="text-foreground text-sm font-medium [overflow-wrap:anywhere]">
              {approval.packageLabel ?? 'This package'}’s hooks are off
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {declineKind === 'incomplete'
                ? "You declined a request that couldn't be shown in full."
                : 'You declined these hooks.'}
            </p>
            {reviewPending ? (
              <p role="status" className="text-foreground mt-2 text-xs">
                A new request is waiting. Hooks stay off until you allow them.
              </p>
            ) : askedAgain ? (
              <p className="text-muted-foreground mt-2 text-xs">
                Asked again. The previous decline is kept.
              </p>
            ) : canAskAgain ? (
              <Button
                variant="outline"
                className="mt-2 min-h-11 w-full"
                disabled={ask.isPending}
                onClick={() => ask.mutate(approval.approvalId)}
              >
                {ask.isPending && ask.variables === approval.approvalId
                  ? 'Asking again…'
                  : 'Ask again'}
              </Button>
            ) : (
              <p className="text-muted-foreground mt-2 text-xs">Sync this folder to ask again.</p>
            )}
          </div>
        )
      )}
    </section>
  );
}
