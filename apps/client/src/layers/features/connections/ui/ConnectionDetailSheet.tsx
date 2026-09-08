import { useState } from 'react';
import { Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import {
  useConnectorConnection,
  useConnectorDisconnectImpact,
  useConnectorUsage,
  useDisconnectConnectorConnection,
  usePauseConnectorConnection,
  useRenameConnectorConnection,
  useReconnectConnectorConnection,
  useResumeConnectorConnection,
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
  Badge,
  Button,
  Input,
  Label,
  QueryErrorState,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Skeleton,
} from '@/layers/shared/ui';
import { connectionStatusLabel } from '../lib/presentation';
import { ConnectionNotifications } from './ConnectionNotifications';

function displayToolkit(toolkit: string): string {
  return toolkit
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

interface ConnectionDetailSheetProps {
  /** Stable connection selected from inventory. */
  connectionId: string | null;
  /** Close the detail surface. */
  onClose: () => void;
  /** Open the exact revision access editor. */
  onManageAccess: (connectionId: string) => void;
  /** Resume a durable reconnect flow in the URL. */
  onReconnect: (flowId: string) => void;
}

/** Detail surface for label, access, lifecycle, event capability, and usage. */
export function ConnectionDetailSheet({
  connectionId,
  onClose,
  onManageAccess,
  onReconnect,
}: ConnectionDetailSheetProps) {
  const detail = useConnectorConnection(connectionId);
  const usage = useConnectorUsage(connectionId);
  const rename = useRenameConnectorConnection();
  const reconnect = useReconnectConnectorConnection();
  const pause = usePauseConnectorConnection();
  const resume = useResumeConnectorConnection();
  const disconnect = useDisconnectConnectorConnection();
  const [editedLabel, setEditedLabel] = useState<{ connectionId: string; value: string } | null>(
    null
  );
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const impact = useConnectorDisconnectImpact(connectionId, confirmDisconnect);

  const mutationError =
    rename.error ?? reconnect.error ?? pause.error ?? resume.error ?? disconnect.error;
  const connection = detail.data?.connection;
  const label =
    editedLabel?.connectionId === connectionId ? editedLabel.value : (connection?.label ?? '');

  return (
    <>
      <ResponsiveDialog open={Boolean(connectionId)} onOpenChange={(open) => !open && onClose()}>
        <ResponsiveDialogContent
          className="max-h-[92vh] sm:max-w-xl [&>[data-slot=dialog-content-close]]:absolute [&>[data-slot=dialog-content-close]]:top-4 [&>[data-slot=dialog-content-close]]:right-4 [&>[data-slot=dialog-content-close]]:m-0 [&>[data-slot=dialog-content-close]]:opacity-100"
          data-testid="connection-detail"
        >
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {connection
                ? `${displayToolkit(connection.toolkit)} (${connection.label})`
                : 'Account details'}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Access, account health, and recorded usage for this connection.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-6 pb-5">
            {detail.isPending ? (
              <div className="space-y-3" aria-label="Loading account details">
                <Skeleton className="h-24 rounded-lg" />
                <Skeleton className="h-36 rounded-lg" />
              </div>
            ) : detail.isError ? (
              <QueryErrorState
                title="Couldn’t load account details"
                description="Try again. The account was not changed."
                onRetry={() => void detail.refetch()}
                isRetrying={detail.isFetching}
              />
            ) : detail.data ? (
              <>
                <section aria-labelledby="connection-overview" className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 id="connection-overview" className="text-sm font-semibold">
                      Account
                    </h3>
                    <div className="flex gap-1.5">
                      <Badge
                        size="xs"
                        variant={connection?.lifecycle === 'connected' ? 'secondary' : 'outline'}
                      >
                        {connection?.lifecycle}
                      </Badge>
                      <Badge size="xs" variant="outline">
                        {connection?.mode === 'managed' ? 'Managed' : 'Your account'}
                      </Badge>
                    </div>
                  </div>
                  <form
                    className="flex items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (
                        !connectionId ||
                        label.trim() === '' ||
                        label.trim() === connection?.label
                      )
                        return;
                      rename.mutate({ connectionId, input: { label: label.trim() } });
                    }}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <Label htmlFor="connection-detail-label">Label</Label>
                      <Input
                        id="connection-detail-label"
                        value={label}
                        onChange={(event) => {
                          if (connectionId) {
                            setEditedLabel({ connectionId, value: event.target.value });
                          }
                        }}
                      />
                    </div>
                    <Button
                      type="submit"
                      variant="secondary"
                      disabled={rename.isPending || label.trim() === connection?.label}
                    >
                      {rename.isPending ? 'Saving…' : 'Save'}
                    </Button>
                  </form>
                  <div className="bg-muted/40 rounded-lg p-3">
                    <p className="text-sm font-medium">{detail.data.provider.displayName}</p>
                    <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                      {detail.data.provider.disclosure}
                    </p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {connection?.payer === 'dorkos_managed'
                        ? 'DorkOS covers service usage.'
                        : 'Service usage is billed to you.'}
                    </p>
                  </div>
                  {connection && (
                    <div className="grid gap-2 text-sm sm:grid-cols-2">
                      <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-lg px-3 py-2.5">
                        <span className="text-muted-foreground">Authentication</span>
                        <Badge size="xs" variant="outline">
                          {connection.authenticationStatus === 'active'
                            ? 'Signed in'
                            : connection.authenticationStatus === 'pending'
                              ? 'Pending'
                              : 'Sign-in needed'}
                        </Badge>
                      </div>
                      <div className="bg-muted/40 flex items-center justify-between gap-2 rounded-lg px-3 py-2.5">
                        <span className="text-muted-foreground">Agent access</span>
                        <Badge size="xs" variant="outline">
                          {connectionStatusLabel(connection)}
                        </Badge>
                      </div>
                    </div>
                  )}
                  {connection?.authoritySync.status === 'failed' && (
                    <p role="alert" className="text-destructive text-sm">
                      Access sync failed: {connection.authoritySync.reason}
                    </p>
                  )}
                </section>

                <section aria-labelledby="connection-access" className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 id="connection-access" className="text-sm font-semibold">
                        Agent access
                      </h3>
                      <p className="text-muted-foreground text-xs">
                        {detail.data.sessions.affectedCount} sessions may be affected by changes.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => connectionId && onManageAccess(connectionId)}
                    >
                      Edit access
                    </Button>
                  </div>
                  {detail.data.agents.length === 0 ? (
                    <p className="bg-muted/40 rounded-lg p-3 text-sm">
                      No agents can use this account.
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {detail.data.agents.map((agent) => (
                        <li
                          key={agent.agentId}
                          className="bg-muted/40 flex min-h-10 items-center justify-between gap-2 rounded-lg px-3 py-2"
                        >
                          <span className="truncate text-sm">{agent.displayName}</span>
                          <Badge size="xs" variant="secondary">
                            {agent.operationRevisionIds.length}{' '}
                            {agent.operationRevisionIds.length === 1 ? 'action' : 'actions'}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {connectionId && <ConnectionNotifications connectionId={connectionId} />}

                <section aria-labelledby="connection-usage" className="space-y-2">
                  <h3 id="connection-usage" className="text-sm font-semibold">
                    Recent usage
                  </h3>
                  {connection?.usage.status === 'unavailable' ? (
                    <p className="text-muted-foreground text-sm">
                      Usage is unavailable: {connection.usage.reason}
                    </p>
                  ) : usage.isError ? (
                    <div className="space-y-2">
                      <p role="alert" className="text-destructive text-sm">
                        Couldn’t load recent usage.
                      </p>
                      <Button size="sm" variant="ghost" onClick={() => void usage.refetch()}>
                        Try again
                      </Button>
                    </div>
                  ) : (
                    <>
                      <p className="text-muted-foreground text-sm">
                        {connection?.usage.logicalOperationCount ?? 0} logical operations,{' '}
                        {connection?.usage.attemptCount ?? 0} attempts.
                      </p>
                      {(usage.data?.items.length ?? 0) > 0 && (
                        <ul className="space-y-1">
                          {usage.data?.items.slice(0, 5).map((item) => (
                            <li
                              key={`${item.logicalOperationId}-${item.attemptIndex}`}
                              className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-2.5 py-2 text-xs"
                            >
                              <span className="truncate">{item.operationSlug}</span>
                              <Badge
                                size="xs"
                                variant={item.outcome === 'success' ? 'secondary' : 'outline'}
                              >
                                {item.outcome ?? 'pending'}
                              </Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </section>

                {mutationError && (
                  <p
                    role="alert"
                    className="text-destructive bg-destructive/5 rounded-lg p-3 text-sm"
                  >
                    We couldn’t confirm that change. The latest account state has been reloaded.
                  </p>
                )}

                <section aria-labelledby="connection-lifecycle" className="space-y-3">
                  <h3 id="connection-lifecycle" className="text-sm font-semibold">
                    Account controls
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {connection?.lifecycle === 'paused' ? (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          connectionId && resume.mutate({ connectionId, input: undefined })
                        }
                        disabled={resume.isPending}
                      >
                        <Play className="size-4" aria-hidden /> Resume
                      </Button>
                    ) : connection?.lifecycle === 'connected' ? (
                      <Button
                        variant="secondary"
                        onClick={() =>
                          connectionId && pause.mutate({ connectionId, input: undefined })
                        }
                        disabled={pause.isPending}
                      >
                        <Pause className="size-4" aria-hidden /> Pause
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      onClick={() =>
                        connectionId &&
                        reconnect.mutate(
                          { connectionId },
                          { onSuccess: (result) => onReconnect(result.flowId) }
                        )
                      }
                      disabled={reconnect.isPending}
                    >
                      <RefreshCw className="size-4" aria-hidden /> Reconnect
                    </Button>
                    {connection?.lifecycle !== 'disconnected' && (
                      <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>
                        <Trash2 className="size-4" aria-hidden /> Disconnect
                      </Button>
                    )}
                  </div>
                </section>
              </>
            ) : null}
          </ResponsiveDialogBody>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this account?</AlertDialogTitle>
            <AlertDialogDescription>
              {impact.isPending
                ? 'Checking what will lose access…'
                : impact.data
                  ? `${impact.data.affectedAgentCount} agents, ${impact.data.affectedSessionCount} sessions, and ${impact.data.affectedSubscriptionCount} subscriptions will lose access. ${impact.data.pendingDeliveryCount} pending deliveries will stop.`
                  : 'We could not confirm the impact yet.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {impact.isError && (
            <p role="alert" className="text-destructive text-sm">
              Couldn’t load the disconnect impact. Try again before disconnecting.
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction
              disabled={!impact.data || disconnect.isPending}
              className="bg-destructive hover:bg-destructive/90 text-white"
              onClick={() => {
                if (!connectionId) return;
                disconnect.mutate(
                  { connectionId, input: undefined },
                  {
                    onSuccess: () => {
                      setConfirmDisconnect(false);
                      onClose();
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
    </>
  );
}
