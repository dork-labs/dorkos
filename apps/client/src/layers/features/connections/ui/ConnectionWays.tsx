import type { ReactNode } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { cloudStatusKey } from '@/layers/features/cloud-link';
import {
  appCount,
  useConnectorAppConnections,
  useConnectorConnections,
  useConnectorProviders,
  type ImpactApp,
} from '@/layers/entities/connectors';
import { useTransport } from '@/layers/shared/model';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  QueryErrorState,
  Skeleton,
} from '@/layers/shared/ui';
import { groupAppsByWay, keyWayName } from '../lib/connection-ways';
import { KeyEntry } from './KeyEntry';
import { KeyWayRow } from './KeyWayRow';
import { WayRow, type WayStatus } from './WayRow';

/** Props for {@link ConnectionWays}. */
export interface ConnectionWaysProps {
  /** Take the person to where the DorkOS account is linked and unlinked. */
  onManageAccount: () => void;
  /** Take the person to the Connections page, where apps are connected. */
  onOpenConnectionsPage: () => void;
}

/**
 * "How DorkOS reaches your apps": every way that is set up (the DorkOS
 * account, your own Composio key, your own Nango server), with its state, how
 * many apps use it, and what you can do with it; then "+ Add another way".
 *
 * The page is for apps, this is for the plumbing. Nothing here moves a login
 * from one way to another: adding a new way leaves every app where it is, and
 * the person reconnects apps one by one when they choose to.
 *
 * The DorkOS account row is read-only on purpose. Unlinking the account turns
 * off more than apps (remote access among them), so it stays in Settings ›
 * Access and this row only links there.
 */
export function ConnectionWays({ onManageAccount, onOpenConnectionsPage }: ConnectionWaysProps) {
  const transport = useTransport();
  const cloud = useQuery({
    queryKey: cloudStatusKey,
    queryFn: () => transport.getCloudStatus(),
    staleTime: 30_000,
  });
  const providers = useConnectorProviders();
  const appConnections = useConnectorAppConnections();
  const connections = useConnectorConnections();

  if (providers.isPending || connections.isPending) {
    return (
      <div className="space-y-2" aria-label="Loading how DorkOS reaches your apps">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-16 rounded-lg" />
      </div>
    );
  }
  // Without both reads the counts would be guesses, and a Remove… that cannot
  // name what stops working is the one thing this section must never offer.
  if (providers.isError || connections.isError) {
    return (
      <QueryErrorState
        title="Couldn’t check how DorkOS reaches your apps"
        description="Try again. Nothing was changed."
        onRetry={() => {
          if (providers.isError) void providers.refetch();
          if (connections.isError) void connections.refetch();
        }}
        isRetrying={providers.isFetching || connections.isFetching}
      />
    );
  }

  const statuses = providers.data;
  const apps = groupAppsByWay(connections.data.connections, statuses);
  const linked = cloud.data?.linked === true;
  // A failed account check is not "not linked": the account row stays, says it
  // couldn't check, and offers a retry, so this section never claims nothing is
  // set up on the strength of a read that failed.
  const showAccount = linked || cloud.isError || apps.dorkosAccount.length > 0;
  const keyRows = statuses.filter(
    (status) =>
      status.configured || (apps.byKeyInstance[status.providerInstanceId]?.length ?? 0) > 0
  );
  const keysToAdd = statuses.filter((status) => !keyRows.includes(status));
  const accountToAdd = cloud.isSuccess && !showAccount;
  const nothingSetUp = !showAccount && keyRows.length === 0;

  // Still asking about the account, with nothing else to show: saying
  // "nothing set up" now could be wrong a moment later.
  if (nothingSetUp && cloud.isPending) {
    return <Skeleton className="h-16 rounded-lg" aria-label="Checking your DorkOS account" />;
  }

  // Which way new apps go through, marked only when there is a choice to see:
  // with one way set up, it is the only one, and the marker would say nothing.
  const newAppsWay =
    appConnections.data?.newApps.status === 'ready' ? appConnections.data.newApps.way : null;
  const ways = appConnections.data?.ways ?? [];
  // Linked is not the same as working: the server says whether the account's
  // way can reach apps right now.
  const accountReaches =
    ways.find((way) => way.kind === 'dorkos_account')?.status !== 'unavailable';
  const markNewApps = (showAccount ? 1 : 0) + keyRows.length > 1;

  const addWays = (
    <AddWays keys={keysToAdd} offerAccount={accountToAdd} onManageAccount={onManageAccount} />
  );

  // Never a loop. On the page, connecting an app no way reaches opens the
  // one-time step (`FirstConnectStep` inside `ConnectDialog`), which takes a
  // key in place and goes straight on to that app's sign-in; chat apps skip it.
  // And this state sets a way up right here, in the open. Neither place only
  // sends people to the other.
  if (nothingSetUp) {
    return (
      <div className="space-y-4">
        <div className="bg-muted/40 space-y-3 rounded-lg p-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Set up when you connect your first app</p>
            <p className="text-muted-foreground text-sm">
              Connect an app on the Connections page and DorkOS asks how to reach it before you sign
              in. You only answer once.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={onOpenConnectionsPage}>
            Open the Connections page
          </Button>
        </div>
        <div className="space-y-2">
          <p className="text-muted-foreground text-sm">Or set one up here now:</p>
          {addWays}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="divide-border divide-y rounded-lg border">
        {showAccount && (
          <AccountWayRow
            linked={linked}
            reachesApps={accountReaches}
            checkFailed={cloud.isError}
            retrying={cloud.isFetching}
            onRetry={() => void cloud.refetch()}
            apps={apps.dorkosAccount}
            usedForNewApps={markNewApps && newAppsWay?.kind === 'dorkos_account'}
            onManageAccount={onManageAccount}
          />
        )}
        {keyRows.map((status) => (
          <KeyWayRow
            key={status.providerInstanceId}
            status={status}
            apps={apps.byKeyInstance[status.providerInstanceId] ?? []}
            usedForNewApps={
              markNewApps && newAppsWay?.kind === 'own_key' && newAppsWay.type === status.type
            }
            way={ways.find((way) => way.kind === 'own_key' && way.type === status.type)}
          />
        ))}
      </ul>
      {(keysToAdd.length > 0 || accountToAdd) && (
        <AddWaysFold label="Add another way">{addWays}</AddWaysFold>
      )}
    </div>
  );
}

/** The DorkOS account as a way in: read-only, with a link to where it is managed. */
function AccountWayRow({
  linked,
  reachesApps,
  checkFailed,
  retrying,
  onRetry,
  apps,
  usedForNewApps,
  onManageAccount,
}: {
  linked: boolean;
  /** False when the account is linked but its way can't reach apps right now. */
  reachesApps: boolean;
  checkFailed: boolean;
  retrying: boolean;
  onRetry: () => void;
  apps: readonly ImpactApp[];
  usedForNewApps: boolean;
  onManageAccount: () => void;
}) {
  const status: WayStatus = linked
    ? reachesApps
      ? { tone: 'success', label: 'Working' }
      : { tone: 'warning', label: 'Can’t reach apps' }
    : checkFailed
      ? { tone: 'neutral', label: 'Couldn’t check' }
      : { tone: 'warning', label: 'Not linked' };
  return (
    <WayRow
      testId="connection-way-dorkos-account"
      name="Your DorkOS account"
      detail={
        checkFailed && apps.length === 0
          ? 'Couldn’t check your DorkOS account'
          : `${appCount(apps.length)} connected`
      }
      status={status}
      usedForNewApps={usedForNewApps}
      actions={
        <>
          {checkFailed && (
            <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
              {retrying ? 'Checking…' : 'Try again'}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onManageAccount}>
            Manage in Access
            <ChevronRight className="size-3.5" aria-hidden />
          </Button>
        </>
      }
    >
      {linked && !reachesApps && (
        <p className="text-muted-foreground text-xs">
          Your DorkOS account is linked, but it can’t reach apps right now. Agents can’t use the
          apps connected through it until it can.
        </p>
      )}
      {!linked && !checkFailed && apps.length > 0 && (
        <p className="text-muted-foreground text-xs">
          These apps stopped working when the account was no longer linked. Linking this computer
          again with the same DorkOS account can bring them back, unless its earlier link was
          removed from that account. Otherwise, connect them again through a way that works.
        </p>
      )}
    </WayRow>
  );
}

/** The "+ Add another way" fold. */
function AddWaysFold({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-ring flex items-center gap-1.5 rounded-md text-sm font-medium">
        <Plus className="size-4" aria-hidden />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The ways not set up yet. Each key says, in the server's own words, where
 * sign-ins will live BEFORE anyone pastes a key into it.
 */
function AddWays({
  keys,
  offerAccount,
  onManageAccount,
}: {
  keys: readonly ConnectorProviderStatus[];
  offerAccount: boolean;
  onManageAccount: () => void;
}) {
  if (keys.length === 0 && !offerAccount) {
    return <p className="text-muted-foreground text-sm">Every way this server offers is set up.</p>;
  }
  return (
    <ul className="divide-border divide-y rounded-lg border">
      {offerAccount && (
        <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <div className="min-w-0 flex-1 basis-48">
            <p className="text-sm font-medium">Your DorkOS account</p>
            <p className="text-muted-foreground text-xs">Link it in Access, then connect apps.</p>
          </div>
          <Button size="sm" variant="outline" onClick={onManageAccount}>
            Link in Access
            <ChevronRight className="size-3.5" aria-hidden />
          </Button>
        </li>
      )}
      {keys.map((status) => (
        <li
          key={status.providerInstanceId}
          data-testid={`add-connection-way-${status.type}`}
          className="space-y-2 px-4 py-3"
        >
          <p className="text-sm font-medium">{keyWayName(status.type)}</p>
          <KeyEntry status={status} />
        </li>
      ))}
    </ul>
  );
}
