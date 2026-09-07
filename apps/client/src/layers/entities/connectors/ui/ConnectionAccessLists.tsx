import { ArrowUpRight, Cable } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  useAgentConnectorConnections,
  useSessionConnectorConnections,
} from '../model/use-connector-resources';
import { Badge, Button, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import { getPlatform } from '@/layers/shared/lib';
import { EmbeddedConnectionsNotice } from './EmbeddedConnectionsNotice';

const SESSION_ACCESS_COPY = {
  inherited: 'Inherited from agent',
  session_only: 'Allowed only in this session',
  disabled: 'Disabled in this session',
} as const;

const DOMINATING_REASON_COPY = {
  none: null,
  connection_paused: 'The account is paused.',
  connection_revoked: 'The account was disconnected.',
  authentication_required: 'The account needs to be signed in again.',
  grant_revoked: 'This access was removed.',
  session_detached: 'This session is blocked from using the account.',
  reconciliation_required: 'The account access needs review.',
  authority_sync_required: 'Account access has not finished updating.',
} as const;

function serviceName(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Canonical account grants shown from one agent profile. */
export function AgentConnectionAccessList({
  agentId,
  onManage,
}: {
  /** Exact canonical agent identifier. */
  agentId: string;
  /** Opens the owner Connections surface for access changes. */
  onManage?: () => void;
}) {
  const query = useAgentConnectorConnections(agentId);

  if (query.isPending) return <Skeleton className="h-24 w-full rounded-lg" />;
  if (query.isError) {
    if (getPlatform().isEmbedded) {
      return <EmbeddedConnectionsNotice title="Account access is unavailable here" />;
    }
    return (
      <QueryErrorState
        title="Couldn’t load account access"
        description="No access details were changed. Try again."
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
      />
    );
  }

  const connections = query.data?.connections ?? [];
  return (
    <section aria-labelledby="agent-account-access" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 id="agent-account-access" className="text-sm font-semibold">
            Account access
          </h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Accounts this agent may use for approved actions.
          </p>
        </div>
        {onManage && (
          <Button variant="ghost" size="sm" onClick={onManage}>
            Manage
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Button>
        )}
      </div>
      {connections.length === 0 ? (
        <div className="bg-muted/40 rounded-lg p-4 text-sm">
          <p className="font-medium">No account access</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Grant an account from Connections when this agent needs it.
          </p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {connections.map((connection) => {
            const usable =
              connection.lifecycle === 'connected' &&
              connection.authenticationStatus === 'active' &&
              connection.reconciliationStatus === 'ready' &&
              connection.authoritySync.status === 'ready';
            return (
              <li
                key={connection.connectionId}
                data-testid={`agent-connection-${connection.connectionId}`}
                className="bg-muted/40 flex min-h-11 items-center gap-3 rounded-lg px-3 py-2"
              >
                <Cable className="text-muted-foreground size-4 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {serviceName(connection.toolkit)} ({connection.label})
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {connection.operationRevisionIds.length} approved{' '}
                    {connection.operationRevisionIds.length === 1 ? 'action' : 'actions'}
                  </p>
                </div>
                <Badge size="xs" variant={usable ? 'secondary' : 'outline'}>
                  {usable ? 'Available' : 'Unavailable'}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Canonical effective account access shown in Session Inspector. */
export function SessionConnectionAccessList({
  sessionId,
  onManage,
  emptyAction,
  footer,
}: {
  /** Exact canonical session identifier. */
  sessionId: string;
  /** Opens the owner Connections surface for access changes. */
  onManage?: () => void;
  /** Session-owned action shown when no connection is currently available. */
  emptyAction?: ReactNode;
  /** Session-owned action shown after the current access list. */
  footer?: ReactNode;
}) {
  const query = useSessionConnectorConnections(sessionId);

  if (query.isPending) return <Skeleton className="h-16 w-full rounded-lg" />;
  if (query.isError) {
    return (
      <section data-testid="session-connectors" className="space-y-2">
        <p role="alert" className="text-destructive px-1 text-xs">
          Couldn’t load account access.
        </p>
        <Button variant="ghost" size="sm" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </section>
    );
  }

  const connections = query.data?.connections ?? [];

  return (
    <section
      data-testid="session-connectors"
      aria-labelledby="session-account-access"
      className="space-y-1"
    >
      <div className="flex items-center justify-between gap-2 px-1 pb-1">
        <h3
          id="session-account-access"
          className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
        >
          Connections
        </h3>
        {onManage && (
          <Button variant="ghost" size="xs" onClick={onManage}>
            Manage agent access
            <ArrowUpRight className="size-3" aria-hidden />
          </Button>
        )}
      </div>
      {connections.length === 0 ? (
        <div className="bg-muted/40 space-y-2 rounded-md px-2.5 py-3">
          <div>
            <p className="text-sm font-medium">No account access</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Ask this agent to request the service and actions it needs.
            </p>
          </div>
          {emptyAction}
        </div>
      ) : (
        connections.map((connection) => {
          const reason = DOMINATING_REASON_COPY[connection.dominatingReason];
          return (
            <div
              key={connection.connectionId}
              data-testid={`session-connection-${connection.connectionId}`}
              className="bg-muted/40 rounded-md px-2.5 py-2"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">
                  {serviceName(connection.toolkit)} ({connection.label})
                </span>
                <Badge
                  size="xs"
                  variant={connection.access === 'disabled' ? 'outline' : 'secondary'}
                >
                  {SESSION_ACCESS_COPY[connection.access]}
                </Badge>
              </div>
              <p
                className={
                  reason ? 'text-destructive mt-1 text-xs' : 'text-muted-foreground mt-1 text-xs'
                }
              >
                {reason ??
                  `${connection.operationRevisionIds.length} actions available in this session.`}
              </p>
            </div>
          );
        })
      )}
      {connections.length > 0 && footer}
    </section>
  );
}
