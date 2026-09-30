import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ConnectorConnectionDetail } from '@dorkos/shared/connector-resource-schemas';
import { connectionUsageLine } from '@dorkos/shared/connector-schemas';
import {
  useConnectorDisconnectImpact,
  useDisconnectConnectorConnection,
  usePauseConnectorConnection,
  useRenameConnectorConnection,
  useResumeConnectorConnection,
  useConnectionEventSubscriptions,
  useStopSharingWithEveryAgent,
} from '@/layers/entities/connectors';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  Label,
} from '@/layers/shared/ui';
import { eventNoticeLabel } from '../../lib/app-panel-copy';
import { notificationProblemHint } from '../../lib/notification-copy';
import { joinNames } from '../access/access-labels';
import { ConnectionNotifications } from '../ConnectionNotifications';
import { PanelMoreRow } from './panel-parts';

/**
 * An account panel's "More": its name, new-event notifications, exact actions,
 * pause, another account, how it's connected, and Disconnect… last, which asks
 * first and names who loses access.
 */
export function AccountPanelMore({
  detail,
  appName,
  onEditExactActions,
  onSignInAgain,
  signingIn,
  onAddAnother,
  onClose,
}: {
  detail: ConnectorConnectionDetail;
  appName: string;
  onEditExactActions: (connectionId: string) => void;
  /** Start a fresh sign-in for this account (the page opens it). */
  onSignInAgain: () => void;
  /** True while that sign-in is starting. */
  signingIn: boolean;
  onAddAnother: (toolkit: string) => void;
  onClose: () => void;
}) {
  const { connection, provider } = detail;
  const usageLine = connectionUsageLine({ payer: connection.payer, custody: provider.custody });
  const connectionId = connection.connectionId;
  const pause = usePauseConnectorConnection();
  const resume = useResumeConnectorConnection();
  const stopSharing = useStopSharingWithEveryAgent();
  // Read here too (the section below shares the cache) so a notification with
  // a problem shows on the row before anyone opens it.
  const notifications = useConnectionEventSubscriptions(
    connectionId,
    connection.lifecycle !== 'disconnected'
  );
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const disconnected = connection.lifecycle === 'disconnected';

  return (
    <Collapsible>
      <CollapsibleTrigger className="group/more text-muted-foreground hover:text-foreground focus-ring flex w-full items-center justify-between rounded-md py-1 text-sm font-semibold">
        More
        <ChevronRight
          className="size-4 transition-transform group-data-[state=open]/more:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="-mx-2 space-y-1 pt-2" data-testid="app-panel-more">
        {!disconnected && <RenameRow detail={detail} />}

        {!disconnected && (
          <Collapsible>
            <CollapsibleTrigger asChild>
              <PanelMoreRow
                label={eventNoticeLabel(connection.toolkit, appName)}
                hint={notificationProblemHint(
                  notifications.data?.pages.flatMap((page) => page.subscriptions) ?? []
                )}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="px-2 pt-2 pb-3">
              <ConnectionNotifications connectionId={connectionId} />
            </CollapsibleContent>
          </Collapsible>
        )}

        {connection.everyAgent && (
          <PanelMoreRow
            label="Stop sharing with every agent"
            hint="Agents you picked by name keep their access"
            disabled={stopSharing.isPending}
            onClick={() => stopSharing.mutate({ connectionId })}
          />
        )}
        {stopSharing.isError && (
          <p role="alert" className="text-destructive px-2 text-xs">
            Couldn’t stop sharing it. Check your connection to DorkOS, then try again.
          </p>
        )}

        {!disconnected && (
          <PanelMoreRow
            label="Exact actions per agent"
            onClick={() => onEditExactActions(connectionId)}
          />
        )}

        {connection.lifecycle === 'connected' && (
          <PanelMoreRow
            label="Pause"
            hint="Agents stop until you resume"
            disabled={pause.isPending}
            onClick={() => pause.mutate({ connectionId, input: undefined })}
          />
        )}
        {connection.lifecycle === 'paused' && (
          <PanelMoreRow
            label="Resume"
            disabled={resume.isPending}
            onClick={() => resume.mutate({ connectionId, input: undefined })}
          />
        )}

        {!disconnected && (
          <PanelMoreRow
            label="Sign in again"
            hint="Refresh its sign-in without changing who can use it"
            disabled={signingIn}
            onClick={onSignInAgain}
          />
        )}

        <PanelMoreRow
          label={`Connect another ${appName} account`}
          onClick={() => onAddAnother(connection.toolkit)}
        />

        <div className="px-2 py-2">
          <p className="text-sm font-medium">How it’s connected</p>
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
            {provider.displayName}. {provider.disclosure}
          </p>
          {usageLine && <p className="text-muted-foreground mt-1 text-xs">{usageLine}</p>}
        </div>

        {!disconnected && (
          <PanelMoreRow
            label="Disconnect…"
            destructive
            onClick={() => setConfirmDisconnect(true)}
          />
        )}
      </CollapsibleContent>

      <DisconnectConfirm
        detail={detail}
        appName={appName}
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        onDisconnected={onClose}
      />
    </Collapsible>
  );
}

/** The account's name, changed in place. */
function RenameRow({ detail }: { detail: ConnectorConnectionDetail }) {
  const rename = useRenameConnectorConnection();
  const [label, setLabel] = useState(detail.connection.label);
  const inputId = `connection-name-${detail.connection.connectionId}`;
  const unchanged = label.trim() === '' || label.trim() === detail.connection.label;
  return (
    <form
      className="flex items-end gap-2 px-2 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (unchanged) return;
        rename.mutate({
          connectionId: detail.connection.connectionId,
          input: { label: label.trim() },
        });
      }}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={inputId}>Name</Label>
        <Input id={inputId} value={label} onChange={(event) => setLabel(event.target.value)} />
      </div>
      <Button type="submit" variant="secondary" disabled={unchanged || rename.isPending}>
        {rename.isPending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  );
}

/** "Disconnect Gmail?" naming who loses access, and only the counts that aren't zero. */
function DisconnectConfirm({
  detail,
  appName,
  open,
  onOpenChange,
  onDisconnected,
}: {
  detail: ConnectorConnectionDetail;
  appName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnected: () => void;
}) {
  const connectionId = detail.connection.connectionId;
  const impact = useConnectorDisconnectImpact(connectionId, open);
  const disconnect = useDisconnectConnectorConnection();
  const names = detail.agents.map((agent) => agent.displayName);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {appName}?</AlertDialogTitle>
          <AlertDialogDescription>
            {impact.isPending
              ? 'Checking who will lose access…'
              : impact.data
                ? disconnectImpactLine(names, impact.data)
                : 'We couldn’t check who will lose access yet.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {impact.isError && (
          <p role="alert" className="text-destructive text-sm">
            Couldn’t check who will lose access. Try again before disconnecting.
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Keep connected</AlertDialogCancel>
          <AlertDialogAction
            disabled={!impact.data || disconnect.isPending}
            className="bg-destructive hover:bg-destructive/90 dark:bg-destructive/60 text-white"
            onClick={(event) => {
              event.preventDefault();
              disconnect.mutate(
                { connectionId, input: undefined },
                {
                  onSuccess: () => {
                    onOpenChange(false);
                    onDisconnected();
                  },
                }
              );
            }}
          >
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Who loses what, said only where it is true: agents by name, then any
 * chats or notifications that stop. A zero is never read out.
 */
export function disconnectImpactLine(
  agentNames: string[],
  impact: {
    everyAgent?: boolean;
    affectedAgentCount: number;
    affectedSessionCount: number;
    affectedSubscriptionCount: number;
    pendingDeliveryCount: number;
  }
): string {
  const lines: string[] = [];
  if (impact.everyAgent) lines.push('Every agent will lose access.');
  else if (agentNames.length > 0) lines.push(`${joinNames(agentNames)} will lose access.`);
  else if (impact.affectedAgentCount > 0) {
    lines.push(
      `${impact.affectedAgentCount} ${impact.affectedAgentCount === 1 ? 'agent' : 'agents'} will lose access.`
    );
  } else lines.push('No agent uses it right now.');
  if (impact.affectedSessionCount > 0) {
    lines.push(
      `${impact.affectedSessionCount} open ${impact.affectedSessionCount === 1 ? 'chat' : 'chats'} will stop using it.`
    );
  }
  if (impact.affectedSubscriptionCount > 0) {
    lines.push(
      `${impact.affectedSubscriptionCount} ${impact.affectedSubscriptionCount === 1 ? 'notification stops' : 'notifications stop'}.`
    );
  }
  if (impact.pendingDeliveryCount > 0) {
    lines.push(
      `${impact.pendingDeliveryCount} waiting ${impact.pendingDeliveryCount === 1 ? 'delivery' : 'deliveries'} won’t be sent.`
    );
  }
  return lines.join(' ');
}
