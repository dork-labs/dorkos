import { useState } from 'react';
import { toast } from 'sonner';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from '@/layers/shared/ui';
import {
  disconnectAgentsLine,
  disconnectOutcome,
  unknownDisconnectAgentsLine,
  useCommunityDisconnectImpact,
  useEndCommunityConnection,
} from '@/layers/entities/community';

/** Props for {@link DisconnectCommunityDialog}. */
export interface DisconnectCommunityDialogProps {
  /** The Community to disconnect from, or `null` when the dialog is closed. */
  connection: CommunityConnectionDescriptor | null;
  onOpenChange: (open: boolean) => void;
  /** Runs after the server confirmed and this Community's local state is gone. */
  onDisconnected: (connection: CommunityConnectionDescriptor) => void;
}

/**
 * Confirm, then disconnect this installation from one space (a "community"
 * in code).
 *
 * Only this installation's connection ends. The person stays a member of the
 * space, and every other space and this DorkOS keep their state. The agents
 * this installation added to the space are removed there, so the confirmation
 * names them first, and the result names any that could not be removed so the
 * person can finish on the space's own site.
 */
export function DisconnectCommunityDialog({
  connection,
  onOpenChange,
  onDisconnected,
}: DisconnectCommunityDialogProps) {
  const end = useEndCommunityConnection();
  const impact = useCommunityDisconnectImpact(connection);
  const [shown, setShown] = useState(connection);
  if (connection !== null && connection !== shown) setShown(connection);
  const label = shown?.label ?? 'this space';
  // A request still waiting for approval never added an agent, so there is nothing to check.
  const agents = shown?.status === 'pending' ? [] : impact.data?.agents;
  // Wait only while a read is actually running. A read that failed, or never started, must not
  // hold Disconnect back: the server removes the agents either way, so say that instead.
  const checking = agents === undefined && impact.fetchStatus === 'fetching';
  const agentsLine = agents
    ? disconnectAgentsLine(label, agents)
    : checking
      ? null
      : unknownDisconnectAgentsLine(label);

  function confirm() {
    if (!connection) return;
    end.mutate(connection, {
      onSuccess: (result) => {
        onOpenChange(false);
        const outcome = disconnectOutcome(connection.label, result);
        if (outcome.tone === 'success') toast.success(outcome.message);
        else toast.warning(outcome.message, { duration: 15_000 });
        onDisconnected(connection);
      },
    });
  }

  return (
    <AlertDialog
      open={connection !== null}
      onOpenChange={(next) => {
        if (!next) end.reset();
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect this DorkOS from {label}?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Its channels leave this app. You stay a member of {label}, and you can connect again
                later.
              </p>
              {agentsLine && <p className="text-foreground">{agentsLine}</p>}
              {checking && <p>Checking for agents you added from here…</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {impact.isError && agents === undefined && !checking && (
          <div
            role="alert"
            className="flex flex-col items-start gap-2 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3"
          >
            <p className="text-destructive">Couldn’t check which of your agents are on {label}.</p>
            <Button size="sm" variant="outline" onClick={() => void impact.refetch()}>
              Check again
            </Button>
          </div>
        )}
        {end.isError && (
          <p role="alert" className="text-destructive text-sm">
            Couldn’t disconnect. Check that DorkOS is running, then try again.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={end.isPending}>Keep connected</AlertDialogCancel>
          <Button variant="destructive" disabled={end.isPending || checking} onClick={confirm}>
            {end.isPending ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
