import { ChevronRight } from 'lucide-react';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import { EmbeddedConnectionsNotice, useConnectorConnections } from '@/layers/entities/connectors';
import { getPlatform } from '@/layers/shared/lib';
import { Badge, Button, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import { connectionStatusLabel, FALLBACK_SERVICE_ICON, SERVICE_ICONS } from '../lib/presentation';

/** Compact canonical stable-account inventory. */
export function AccountsList({
  onOpenDetail,
}: {
  /** Opens the detail surface for one stable connection. */
  onOpenDetail: (connectionId: string) => void;
}) {
  const query = useConnectorConnections();
  if (query.isPending) {
    return (
      <div className="space-y-2" aria-label="Loading connected accounts">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
      </div>
    );
  }
  if (query.isError) {
    if (getPlatform().isEmbedded) {
      return <EmbeddedConnectionsNotice title="Connected accounts are unavailable here" />;
    }
    return (
      <QueryErrorState
        title="Couldn’t load connected accounts"
        description="Try again. Nothing about your accounts was changed."
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
      />
    );
  }
  const connections = query.data?.connections ?? [];
  const connected = connections.filter((connection) => connection.lifecycle !== 'disconnected');
  const disconnected = connections.filter((connection) => connection.lifecycle === 'disconnected');
  return (
    <div className="space-y-6">
      <section aria-labelledby="connections-connected" className="space-y-3">
        <h3 id="connections-connected" className="text-sm font-semibold">
          Connected accounts
        </h3>
        {connected.length === 0 ? (
          <div className="bg-muted/40 rounded-lg p-5">
            <p className="text-sm font-medium">No accounts connected</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Connect a service, then choose exactly which agents may use it.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {connected.map((connection) => (
              <AccountRow
                key={connection.connectionId}
                connection={connection}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </ul>
        )}
      </section>
      {disconnected.length > 0 && (
        <section aria-labelledby="connections-disconnected" className="space-y-3">
          <h3 id="connections-disconnected" className="text-sm font-semibold">
            Disconnected accounts
          </h3>
          <p className="text-muted-foreground text-xs">
            These accounts cannot be used by agents. Reconnect one or remove it from Accounts.
          </p>
          <ul className="space-y-2">
            {disconnected.map((connection) => (
              <AccountRow
                key={connection.connectionId}
                connection={connection}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One stable connection row with detail as its single action. */
export function AccountRow({
  connection,
  onOpenDetail,
}: {
  /** Canonical owner-visible connection summary. */
  connection: ConnectorConnectionSummary;
  /** Opens the account detail surface. */
  onOpenDetail: (connectionId: string) => void;
}) {
  const Icon = SERVICE_ICONS[connection.toolkit.toLowerCase()] ?? FALLBACK_SERVICE_ICON;
  const service = connection.toolkit.charAt(0).toUpperCase() + connection.toolkit.slice(1);
  const healthy =
    connection.lifecycle === 'connected' &&
    connection.authenticationStatus === 'active' &&
    connection.reconciliationStatus === 'ready' &&
    connection.authoritySync.status === 'ready';
  const status = connectionStatusLabel(connection);

  return (
    <li data-testid={`connection-row-${connection.connectionId}`}>
      <Button
        variant="ghost"
        onClick={() => onOpenDetail(connection.connectionId)}
        className="bg-muted/40 hover:bg-muted/70 focus-visible:bg-muted/70 h-auto min-h-14 w-full justify-start rounded-lg px-3 py-2.5 text-left"
      >
        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">
              {service} ({connection.label})
            </span>
            <Badge size="xs" variant={healthy ? 'secondary' : 'outline'}>
              {status}
            </Badge>
          </span>
          <span className="text-muted-foreground mt-0.5 block text-xs">
            {connection.agentCount} {connection.agentCount === 1 ? 'agent' : 'agents'} ·{' '}
            {connection.mode === 'managed' ? 'Managed' : 'Your account'}
          </span>
        </span>
        <ChevronRight className="text-muted-foreground size-4 shrink-0" aria-hidden />
      </Button>
    </li>
  );
}
