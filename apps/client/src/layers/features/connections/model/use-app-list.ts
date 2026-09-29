import { useMemo } from 'react';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import type { CatalogEntry } from '@dorkos/shared/relay-schemas';
import { useBindings, useUnclaimedChats } from '@/layers/entities/binding';
import { useConnectorCatalog, useConnectorConnections } from '@/layers/entities/connectors';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useAdapterCatalog, useRelayEnabledState } from '@/layers/entities/relay';
import { getAgentDisplayName } from '@/layers/shared/lib';
import {
  buildYourApps,
  ownedApps,
  remainingUses,
  rowMatches,
  type OwnedApps,
  type PendingSignIn,
  type YourAppRow,
} from '../lib/app-list';

/** Everything the one list needs, read from the server and shaped into rows. */
export interface AppListData {
  /** "Yours", already filtered by the search. */
  yours: YourAppRow[];
  /** Every row in "Yours", search aside (for the side panel's lookup). */
  allYours: YourAppRow[];
  /** The chat app catalog, empty while chat apps are off. */
  chatApps: CatalogEntry[];
  /** What the person already has, for deciding which uses of an app are left. */
  owned: OwnedApps;
  /** The apps "All apps" still offers, for the current search. */
  available: ConnectorCatalogService[];
  /** Catalog services by id (unfiltered), for names and sign-in companies. */
  services: ReadonlyMap<string, ConnectorCatalogService>;
  /** Agent display names by id. */
  agentNames: Readonly<Record<string, string>>;
  /** First load of "Yours" is still in flight. */
  yoursLoading: boolean;
  /** The connection list failed to load. */
  yoursError: boolean;
  /** A read of the connection list is in flight (a new app may be about to appear). */
  yoursRefreshing: boolean;
  /** Retry the connection list. */
  retryYours: () => void;
  /** The catalog query for the current search (loading, error, paging). */
  catalog: ReturnType<typeof useConnectorCatalog>;
  /** Chat apps: whether they are on, still checking, or failed to start. */
  relay: ReturnType<typeof useRelayEnabledState>;
  /** Chat apps are on, but their list failed to load. */
  chatAppsError: boolean;
  /** Retry the chat app list. */
  retryChatApps: () => void;
}

/**
 * Read everything the Connections list shows and shape it into rows: every
 * connected account, every chat app set up (the internal agent relay left
 * out), anyone waiting on a chat app, and what "All apps" still offers.
 *
 * @param query - What the person typed in the search box (already deferred).
 * @param pendingSignIn - A sign-in in progress, shown as a "Connecting" row.
 */
export function useAppList(query: string, pendingSignIn: PendingSignIn | null): AppListData {
  const searching = query.trim() !== '';
  const connections = useConnectorConnections();
  const fullCatalog = useConnectorCatalog('');
  const searchCatalog = useConnectorCatalog(query, searching);
  const relay = useRelayEnabledState();
  const chatCatalog = useAdapterCatalog(relay.enabled);
  const { data: bindings } = useBindings();
  const { data: unclaimed } = useUnclaimedChats('pending', relay.enabled);
  const { data: agentsData } = useRegisteredAgents();

  const services = useMemo(
    () =>
      new Map(
        (fullCatalog.data?.pages.flatMap((page) => page.services) ?? []).map((service) => [
          service.serviceSlug,
          service,
        ])
      ),
    [fullCatalog.data]
  );

  const agentNames = useMemo(
    () =>
      Object.fromEntries(
        (agentsData?.agents ?? []).map((agent) => [agent.id, getAgentDisplayName(agent)])
      ),
    [agentsData]
  );

  const chatApps = useMemo(
    () => (relay.enabled ? (chatCatalog.data ?? []) : []),
    [relay.enabled, chatCatalog.data]
  );
  const connectionList = useMemo(() => connections.data?.connections ?? [], [connections.data]);

  const allYours = useMemo(() => {
    const waitingByChatApp: Record<string, number> = {};
    for (const chat of unclaimed ?? []) {
      waitingByChatApp[chat.adapterId] = (waitingByChatApp[chat.adapterId] ?? 0) + 1;
    }
    return buildYourApps({
      connections: connectionList,
      chatApps,
      bindings: bindings ?? [],
      waitingByChatApp,
      agentNames,
      services,
      pendingSignIn,
    });
  }, [connectionList, chatApps, bindings, unclaimed, agentNames, services, pendingSignIn]);

  const catalog = searching ? searchCatalog : fullCatalog;
  const owned = useMemo(() => ownedApps(connectionList, chatApps), [connectionList, chatApps]);
  const available = useMemo(() => {
    return (catalog.data?.pages.flatMap((page) => page.services) ?? []).filter((service) => {
      const left = remainingUses(service, owned);
      return left.account || left.chatType !== null;
    });
  }, [catalog.data, owned]);

  return {
    yours: allYours.filter((row) => rowMatches(row, query)),
    allYours,
    chatApps,
    owned,
    available,
    services,
    agentNames,
    // Chat apps join "Yours" once their list arrives; until then the list
    // would reorder under the person, so it waits for both.
    yoursLoading:
      connections.isPending || relay.isLoading || (relay.enabled && chatCatalog.isPending),
    yoursError: connections.isError,
    yoursRefreshing: connections.isFetching,
    retryYours: () => void connections.refetch(),
    catalog,
    relay,
    chatAppsError: relay.enabled && chatCatalog.isError,
    retryChatApps: () => void chatCatalog.refetch(),
  };
}
