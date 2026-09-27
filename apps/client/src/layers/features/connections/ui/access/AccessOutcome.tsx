import { Check, Clock3, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import type { AccessReconciliation } from '../../model/use-access-reconciliation';

interface AccessOutcomeProps {
  /** The access decision whose outcome is reported. */
  access: AccessReconciliation;
  /** What a confirmed save means, in the caller's words. */
  savedDetail?: string;
}

/**
 * The honest result of one access write: couldn't confirm, updated, needs
 * review, pending, or failed. Renders nothing while no write has an outcome.
 * Never says "updated" unless the server confirmed exactly what was sent and
 * its sync is ready.
 */
export function AccessOutcome({
  access,
  savedDetail = 'Access is ready for the agents you changed.',
}: AccessOutcomeProps) {
  const { saveOutcome } = access;
  const pendingAdds = saveOutcome?.grants.some((grant) => grant.operationRevisionIds.length > 0);
  const pendingRemovals = saveOutcome?.grants.some(
    (grant) => grant.operationRevisionIds.length === 0
  );
  const syncCheckFailed = access.syncCheckFailed && (
    <p role="alert" className="text-destructive text-sm">
      Couldn’t check the current sync status. The access change was not repeated.
    </p>
  );

  if (access.needsRefresh) {
    return (
      <div className="border-destructive/30 bg-destructive/5 space-y-3 rounded-lg border p-4">
        <div className="flex items-start gap-3">
          <ShieldAlert className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p role="alert" className="text-sm font-medium">
              We couldn’t confirm that access was saved
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              Reload the current access before making another change.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="h-auto min-h-9 whitespace-normal"
          onClick={access.refresh}
        >
          <RefreshCw className="size-4" aria-hidden />
          Reload current access
        </Button>
      </div>
    );
  }
  if (access.saved) {
    return (
      <div className="border-status-success/30 bg-status-success/5 flex items-start gap-3 rounded-lg border p-4">
        <Check className="text-status-success mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p data-testid="connector-access-outcome" className="text-sm font-medium">
            Access updated
          </p>
          <p className="text-muted-foreground mt-1 text-sm">{savedDetail}</p>
        </div>
      </div>
    );
  }
  if (access.needsReconciliation) {
    return (
      <div className="border-status-warning/30 bg-status-warning/5 flex items-start gap-3 rounded-lg border p-4">
        <ShieldAlert className="text-status-warning-dot mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p data-testid="connector-access-outcome" className="text-sm font-medium">
            Access needs review
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            Available actions changed. Reload the current access before making another change.
          </p>
        </div>
      </div>
    );
  }
  if (saveOutcome?.authoritySync.status === 'pending') {
    return (
      <div className="border-status-warning/30 bg-status-warning/5 space-y-3 rounded-lg border p-4">
        <div className="flex items-start gap-3">
          <Clock3 className="text-status-warning-dot mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p data-testid="connector-access-outcome" className="text-sm font-medium">
              Access update pending
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {pendingAdds && pendingRemovals
                ? 'Removed access is already closed. New access stays unavailable until synchronization finishes.'
                : pendingRemovals
                  ? 'Removed access is already closed. The service is still removing access.'
                  : 'New access is saved but remains unavailable until synchronization finishes.'}
            </p>
          </div>
        </div>
        {syncCheckFailed}
      </div>
    );
  }
  if (saveOutcome?.authoritySync.status === 'failed') {
    return (
      <div className="border-destructive/30 bg-destructive/5 space-y-3 rounded-lg border p-4">
        <div className="flex items-start gap-3">
          <ShieldAlert className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p data-testid="connector-access-outcome" role="alert" className="text-sm font-medium">
              Access sync failed
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {saveOutcome.authoritySync.reason} Agents cannot use this change. Check your account
              setup, then try again.
            </p>
          </div>
        </div>
        {syncCheckFailed}
      </div>
    );
  }
  return null;
}
