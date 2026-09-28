import { ArrowUpRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConnectorSessionEffectiveAccess } from '@dorkos/shared/connector-resource-schemas';
import {
  useAgentConnectorConnections,
  useSessionConnectorConnections,
  useSetSessionConnectorAccess,
} from '../model/use-connector-resources';
import { Badge, Button, QueryErrorState, Skeleton, Switch } from '@/layers/shared/ui';
import { serviceName } from '../lib/access-copy';
import { ServiceMark } from './ServiceMark';

/** Where a chat's usable access comes from, as its badge says it. */
const SESSION_SOURCE_COPY = {
  agent: 'Inherited from agent',
  this_chat: 'Allowed only in this session',
} as const;

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
            const usable = connection.readiness.state === 'ready';
            return (
              <li
                key={connection.connectionId}
                data-testid={`agent-connection-${connection.connectionId}`}
                className="bg-muted/40 flex min-h-11 items-center gap-3 rounded-lg px-3 py-2"
              >
                <ServiceMark
                  iconKey={connection.toolkit}
                  displayName={serviceName(connection.toolkit)}
                  className="size-7"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {serviceName(connection.toolkit)} ({connection.label})
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {connection.operationRevisionIds.length} approved{' '}
                    {connection.operationRevisionIds.length === 1 ? 'action' : 'actions'}
                    {connection.everyAgent && ' · given to every agent'}
                  </p>
                </div>
                <Badge
                  size="xs"
                  variant={usable ? 'secondary' : 'outline'}
                  title={usable ? undefined : connection.readiness.copy.owner}
                >
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

/** What the per-chat switch does, said once above the list. */
const THIS_CHAT_SWITCH_NOTE =
  'Turning an app off here only affects this chat. Turning it back on puts back the access this chat had, and never adds any.';

/** Why a switch did not change, when the server gave no reason of its own. */
const THIS_CHAT_SWITCH_FAILED = 'Couldn’t change it. Nothing changed. Try again.';

/**
 * What to say when a switch did not change. A refusal the owner can't retry
 * past (the chat is limited for another agent) is said in the server's own
 * words; anything else may pass, so it asks to try again.
 */
function switchFailure(error: Error | null): string {
  return (error as { code?: string } | null)?.code === 'session_access_other_agent'
    ? error!.message
    : THIS_CHAT_SWITCH_FAILED;
}

/**
 * Canonical effective account access shown in Session Inspector, with the
 * owner's per-chat switch on every app the agent was given account-wide.
 * Everything a row says is the server's: a switch shows where the server
 * sends `thisChat`, and an app that is off there is exactly where readiness
 * names `turn_on_for_this_chat` as the fix. The switch writes, and the list
 * shows the readiness the server answers with; it is never guessed here.
 */
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
        <>
          {connections.some((connection) => connection.thisChat) && (
            <p className="text-muted-foreground px-1 pb-1 text-xs">{THIS_CHAT_SWITCH_NOTE}</p>
          )}
          {connections.map((connection) => (
            <SessionConnectionRow
              key={connection.connectionId}
              sessionId={sessionId}
              connection={connection}
            />
          ))}
        </>
      )}
      {connections.length > 0 && footer}
    </section>
  );
}

/** One app in a chat's list: its name, the server's readiness, and the switch when it has one. */
function SessionConnectionRow({
  sessionId,
  connection,
}: {
  sessionId: string;
  connection: ConnectorSessionEffectiveAccess;
}) {
  const setAccess = useSetSessionConnectorAccess(sessionId);
  const ready = connection.readiness.state === 'ready';
  const name = `${serviceName(connection.toolkit)} (${connection.label})`;
  return (
    <div
      data-testid={`session-connection-${connection.connectionId}`}
      data-reason={connection.readiness.reason}
      className="bg-muted/40 rounded-md px-2.5 py-2"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{name}</span>
            <Badge size="xs" variant={ready ? 'secondary' : 'outline'}>
              {ready ? SESSION_SOURCE_COPY[connection.source] : 'Not available'}
            </Badge>
          </div>
          <p
            className={
              ready ? 'text-muted-foreground mt-1 text-xs' : 'text-status-warning-fg mt-1 text-xs'
            }
          >
            {ready
              ? `${connection.operationRevisionIds.length} actions available in this session.`
              : connection.readiness.copy.owner}
          </p>
        </div>
        {connection.thisChat && (
          <Switch
            aria-label={`${name} in this chat`}
            data-testid={`session-connection-switch-${connection.connectionId}`}
            checked={connection.thisChat === 'on'}
            disabled={setAccess.isPending}
            onCheckedChange={(on) =>
              setAccess.mutate({ connectionId: connection.connectionId, on })
            }
            className="mt-0.5 shrink-0"
          />
        )}
      </div>
      {/* Only while there is still a switch: a refused change refetches the
          server's view, and a row that lost its switch has nothing to try again. */}
      {setAccess.isError && connection.thisChat && (
        <p role="alert" className="text-destructive mt-1 text-xs">
          {switchFailure(setAccess.error)}
        </p>
      )}
    </div>
  );
}
