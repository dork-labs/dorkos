import { useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import type {
  ConnectorAppConnections,
  ConnectorConnectionSummary,
} from '@dorkos/shared/connector-resource-schemas';
import type { Transport } from '@dorkos/shared/transport';
import {
  AccountPanel,
  AppList,
  CatalogAppRowView,
  ConnectionWays,
  YourAppRowView,
  type AppListData,
  type YourAppRow,
} from '@/layers/features/connections';
import { buildYourApps } from '@/layers/features/connections/lib/app-list';
import { cloudStatusKey } from '@/layers/features/cloud-link';
import { ChatAppPanel } from '@/layers/widgets/connections/ui/ChatAppPanel';
import { connectorKeys } from '@/layers/entities/connectors';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';
import {
  MOCK_AGENT_NAMES,
  MOCK_CATALOG_SERVICES,
  MOCK_CHAT_APPS,
  MOCK_CHAT_BINDINGS,
  MOCK_CONNECTIONS,
  MOCK_GMAIL_ACTIONS,
  MOCK_GMAIL_USAGE,
  mockAccessPreview,
  mockConnection,
  mockConnectionDetail,
} from '../mock-samples';
import { ConnectionAccessCardShowcase } from './ConnectionAccessCardShowcase';
import { AgentRequestCardShowcase } from './AgentRequestCardShowcase';

const SERVICES = new Map(MOCK_CATALOG_SERVICES.map((service) => [service.serviceSlug, service]));

/** Every "Yours" row state, built by the real row logic from the fixtures. */
const ROWS: YourAppRow[] = buildYourApps({
  connections: MOCK_CONNECTIONS,
  chatApps: MOCK_CHAT_APPS,
  bindings: MOCK_CHAT_BINDINGS,
  waitingByChatApp: { 'telegram-1': 1 },
  agentNames: MOCK_AGENT_NAMES,
  services: SERVICES,
  pendingSignIn: { flowId: 'flow-github', toolkit: 'github' },
});

const NOTHING_SET_UP: ConnectorAppConnections = {
  ways: [],
  newApps: { status: 'setup_needed', reason: 'nothing_set_up' },
};

/** Minutes ago, as the ISO time the server would send. */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * The list's reads, spelled out: the list is presentational over
 * `useAppList`, so a showcase hands it the data a server would have.
 */
function listData(yours: YourAppRow[], owned: string[]): AppListData {
  const catalog = {
    data: {
      pages: [{ services: MOCK_CATALOG_SERVICES, warnings: [], appConnections: NOTHING_SET_UP }],
      pageParams: [undefined],
    },
    isPending: false,
    isError: false,
    isFetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: async () => undefined,
    refetch: async () => undefined,
  } as unknown as AppListData['catalog'];
  const ownedSet = new Set(owned);
  return {
    yours,
    allYours: yours,
    available: MOCK_CATALOG_SERVICES.filter((service) => !ownedSet.has(service.serviceSlug)),
    services: SERVICES,
    agentNames: MOCK_AGENT_NAMES,
    chatApps: MOCK_CHAT_APPS,
    owned: { accounts: ownedSet, chatApps: ownedSet },
    yoursLoading: false,
    yoursError: false,
    yoursRefreshing: false,
    retryYours: () => undefined,
    catalog,
    relay: {
      enabled: true,
      isLoading: false,
      isError: false,
      isRetrying: false,
      retry: () => undefined,
    },
    chatAppsError: false,
    retryChatApps: () => undefined,
  };
}

/** When the stalled-disconnect demo says it tries again: a few minutes after the page loads. */
const STALLED_RETRY_AT = new Date(Date.now() + 4 * 60_000).toISOString();

/** A playground server for the panels: the fixtures, answered as the real one would. */
function panelTransport(connection: ConnectorConnectionSummary): Transport {
  const base = createPlaygroundTransport();
  const overrides: Partial<Record<keyof Transport, unknown>> = {
    getConnectorConnection: async () => mockConnectionDetail(connection),
    // Answers "Finish disconnecting" with the account's own state, so a stalled
    // sign-out stays stalled and the panel shows what happens next.
    disconnectConnectorConnection: async () => ({
      connectionId: connection.connectionId,
      lifecycle: connection.lifecycle,
      authenticationStatus: connection.authenticationStatus,
      authoritySync: connection.authoritySync,
      externalCleanup:
        connection.externalCleanup === 'unknown'
          ? 'pending'
          : (connection.externalCleanup ?? 'not_required'),
    }),
    getOperatorConnectorUsage: async () => ({ items: MOCK_GMAIL_USAGE }),
    getConnectorAppActions: async () => MOCK_GMAIL_ACTIONS,
    previewConnectorReconciliation: async ({ connectionId }: { connectionId: string }) =>
      mockAccessPreview(connectionId),
    getConnectorCatalog: async () => ({ services: MOCK_CATALOG_SERVICES, warnings: [] }),
    listMeshAgents: async () => ({
      agents: [
        { id: 'dorkbot', name: 'DorkBot', isSystem: true },
        { id: 'mailroom', name: 'mailroom' },
      ],
    }),
    listMeshAgentPaths: async () => ({
      agents: [{ id: 'dorkbot', name: 'DorkBot', projectPath: '/home/you/.dork/agents/dorkbot' }],
    }),
    getBindings: async () => MOCK_CHAT_BINDINGS,
    listUnclaimedChats: async () => [
      {
        id: 'claim-1',
        adapterId: 'telegram-1',
        chatId: '42',
        channelType: 'dm',
        chatKind: 'dm',
        platformChatType: 'private',
        senderName: 'Sam',
        senderId: 'sam_k',
        chatTitle: null,
        status: 'pending',
        messageCount: 1,
        firstSeenAt: ago(10),
        lastSeenAt: ago(10),
        decidedAt: null,
        decidedAgentId: null,
      },
    ],
    getAdapterEvents: async () => ({
      events: [
        { id: 'e1', subject: 'adapter.connected', status: 'ok', sentAt: ago(1440), metadata: null },
        {
          id: 'e2',
          subject: 'adapter.message_received',
          status: 'ok',
          sentAt: ago(60),
          metadata: null,
        },
        {
          id: 'e3',
          subject: 'adapter.message_sent',
          status: 'ok',
          sentAt: ago(58),
          metadata: null,
        },
      ],
    }),
  };
  return new Proxy(base, {
    get: (target, prop, receiver) =>
      typeof prop === 'string' && prop in overrides
        ? overrides[prop as keyof Transport]
        : (Reflect.get(target, prop, receiver) as unknown),
  });
}

/** A panel body framed the way the side panel frames it, with its own server. */
function PanelFrame({
  connection,
  children,
}: {
  connection: ConnectorConnectionSummary;
  children: ReactNode;
}) {
  const [transport] = useState(() => panelTransport(connection));
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      })
  );
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <div className="bg-background max-w-md rounded-xl border p-6">{children}</div>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * The Connections page's parts (design record `connections-one-list`): every
 * row state, the list first-visit and full, both side panels, the shared
 * access card, and Settings › Connections' ways.
 */
export function ConnectionsShowcases() {
  const firstVisit = useMemo(() => listData([], []), []);
  const withApps = useMemo(
    () => listData(ROWS, ['gmail', 'notion', 'googlecalendar', 'linear', 'telegram']),
    []
  );
  const noop = () => undefined;

  return (
    <>
      <PlaygroundSection
        title="AppRow"
        description="One row per app. The row tells you the state; its right side is the one thing to do next. Built by the real row logic from fixtures."
      >
        <ShowcaseLabel>Yours: connecting, broken, review, ready, waiting, paused</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <ul className="max-w-2xl space-y-0.5">
            {ROWS.map((row) => (
              <YourAppRowView key={row.id} row={row} onOpen={noop} onAction={noop} />
            ))}
          </ul>
        </ShowcaseDemo>

        <ShowcaseLabel>
          All apps: Connect, the Chat tag, For developers, and turned off
        </ShowcaseLabel>
        <ShowcaseDemo responsive>
          <ul className="max-w-2xl space-y-0.5">
            <CatalogAppRowView
              service={MOCK_CATALOG_SERVICES[5]}
              chat={false}
              actionLabel="Connect"
              onConnect={noop}
            />
            <CatalogAppRowView
              service={MOCK_CATALOG_SERVICES[2]}
              chat
              actionLabel="Connect"
              onConnect={noop}
            />
            <CatalogAppRowView
              service={MOCK_CATALOG_SERVICES[7]}
              chat
              actionLabel="Set up"
              onConnect={noop}
            />
            <CatalogAppRowView
              service={MOCK_CATALOG_SERVICES[3]}
              chat
              actionLabel="Connect"
              unavailableLabel="Turned off"
            />
          </ul>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="AppList"
        description="The page's one list: search, Yours, then All apps with shelf chips and a small For developers group. On a first visit there is no Yours at all."
      >
        <ShowcaseLabel>First visit: nothing connected</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <div className="max-w-2xl">
            <AppListDemo data={firstVisit} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>With apps</ShowcaseLabel>
        <ShowcaseDemo responsive>
          <div className="max-w-2xl">
            <AppListDemo data={withApps} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="AccountPanel"
        description="An app account's side panel: who can use it, what that level lets agents do (Look and Change), what agents did lately, and a few things to try. Everything else is under More. A broken account puts its one fix on top."
      >
        <ShowcaseLabel>Connected</ShowcaseLabel>
        <ShowcaseDemo>
          <PanelFrame connection={MOCK_CONNECTIONS[0]}>
            <AccountPanelDemo />
          </PanelFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>Signed out</ShowcaseLabel>
        <ShowcaseDemo>
          <PanelFrame connection={mockConnection({ authenticationStatus: 'expired' })}>
            <AccountPanelDemo />
          </PanelFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>Disconnect still finishing</ShowcaseLabel>
        <ShowcaseDemo>
          <PanelFrame
            connection={mockConnection({
              lifecycle: 'disconnected',
              externalCleanup: 'pending',
              authoritySync: {
                status: 'pending',
                reason: 'DorkOS’s servers had a problem.',
                retryAt: STALLED_RETRY_AT,
              },
            })}
          >
            <AccountPanelDemo />
          </PanelFrame>
        </ShowcaseDemo>

        <ShowcaseLabel>Disconnect refused</ShowcaseLabel>
        <ShowcaseDemo>
          <PanelFrame
            connection={mockConnection({
              lifecycle: 'disconnected',
              externalCleanup: 'pending',
              authoritySync: { status: 'failed', reason: 'This instance is no longer linked.' },
            })}
          >
            <AccountPanelDemo />
          </PanelFrame>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ChatAppPanel"
        description="A chat app's side panel asks who answers. People who messaged the bot wait under it for your OK; the bot's settings are under More."
      >
        <ShowcaseDemo>
          <PanelFrame connection={MOCK_CONNECTIONS[0]}>
            <ChatAppPanel
              entry={MOCK_CHAT_APPS[0]}
              instance={MOCK_CHAT_APPS[0].instances[0]}
              onClose={noop}
            />
          </PanelFrame>
        </ShowcaseDemo>
      </PlaygroundSection>

      <ConnectionAccessCardShowcase />
      <AgentRequestCardShowcase />
      <ConnectionWaysShowcase />
    </>
  );
}

/** The list with a search box that works on the fixture rows. */
function AppListDemo({ data }: { data: AppListData }) {
  const [query, setQuery] = useState('');
  const noop = () => undefined;
  return (
    <AppList
      query={query}
      onQueryChange={setQuery}
      data={data}
      onOpenRow={noop}
      onRowAction={noop}
      onConnect={noop}
    />
  );
}

/** The Gmail account's panel, with every callback a no-op. */
function AccountPanelDemo() {
  const noop = () => undefined;
  return (
    <AccountPanel
      connectionId="conn-gmail-personal"
      onSignInStarted={noop}
      onEditExactActions={noop}
      onAddAnother={noop}
      onClose={noop}
    />
  );
}

/**
 * Build an isolated, pre-seeded `QueryClient` for the ways demo.
 *
 * @param seed - Populates the client's cache before the section mounts.
 */
function makeConnectionsQueryClient(seed: (qc: QueryClient) => void): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  seed(qc);
  return qc;
}

/** A key's setup status for the ways showcase. */
function mockKey(over: Partial<ConnectorProviderStatus>): ConnectorProviderStatus {
  return {
    type: 'composio',
    // The same instance the byo mock accounts below carry, so they group onto it.
    providerInstanceId: 'provider-1' as ConnectorProviderStatus['providerInstanceId'],
    configured: false,
    registered: false,
    custody: 'managed',
    disclosure:
      'Composio keeps your login access in its own secure vault. DorkOS never sees your password.',
    ...over,
  };
}

/**
 * `ConnectionWays` (Settings › Connections, DOR-2419) in its two shapes: nothing
 * set up yet, and a DorkOS account plus a working Composio key (marked as the
 * one new apps use) beside a Nango key the server refused.
 */
function ConnectionWaysShowcase() {
  const empty = useMemo(
    () =>
      makeConnectionsQueryClient((qc) => {
        qc.setQueryData(cloudStatusKey, {
          linked: false,
          accountLabel: null,
          lastHeartbeatAt: null,
        });
        qc.setQueryData(connectorKeys.providers(), {
          providers: [
            mockKey({}),
            mockKey({
              type: 'nango',
              providerInstanceId: 'provider-2' as ConnectorProviderStatus['providerInstanceId'],
              custody: 'self-host',
              disclosure: 'Your Nango server keeps your logins on a machine you run.',
            }),
          ],
          appConnections: NOTHING_SET_UP,
        });
        qc.setQueryData(connectorKeys.connections(), { connections: [] });
      }),
    []
  );
  const setUp = useMemo(
    () =>
      makeConnectionsQueryClient((qc) => {
        const composio = { kind: 'own_key' as const, type: 'composio', status: 'ready' as const };
        qc.setQueryData(cloudStatusKey, {
          linked: true,
          accountLabel: 'you@example.com',
          lastHeartbeatAt: null,
        });
        qc.setQueryData(connectorKeys.providers(), {
          providers: [
            mockKey({ configured: true, registered: true, keyKind: 'project' }),
            mockKey({
              type: 'nango',
              providerInstanceId: 'provider-2' as ConnectorProviderStatus['providerInstanceId'],
              custody: 'self-host',
              configured: true,
              error: 'Set NANGO_ENCRYPTION_KEY on the server, then save the key again.',
            }),
          ],
          appConnections: {
            ways: [{ kind: 'dorkos_account', type: 'dorkos-managed', status: 'ready' }, composio],
            newApps: { status: 'ready', way: composio },
          },
        });
        qc.setQueryData(connectorKeys.connections(), {
          connections: [
            mockConnection({}),
            mockConnection({
              connectionId: 'ca_mock_5' as ConnectorConnectionSummary['connectionId'],
              toolkit: 'notion',
              label: 'team',
              mode: 'byo',
              payer: 'operator_byo',
            }),
            mockConnection({
              connectionId: 'ca_mock_6' as ConnectorConnectionSummary['connectionId'],
              toolkit: 'linear',
              label: 'work',
              mode: 'byo',
              payer: 'operator_byo',
            }),
          ],
        });
      }),
    []
  );

  return (
    <PlaygroundSection
      title="ConnectionWays"
      description="Settings › Connections: how DorkOS reaches your apps, with each way's state, how many apps use it, which one new apps use, and Change key / Remove…."
    >
      <ShowcaseLabel>Nothing set up yet</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={empty}>
          <div className="max-w-2xl">
            <ConnectionWays onManageAccount={() => {}} onOpenConnectionsPage={() => {}} />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>
        DorkOS account, a working key used for new apps, and a refused key
      </ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={setUp}>
          <div className="max-w-2xl">
            <ConnectionWays onManageAccount={() => {}} onOpenConnectionsPage={() => {}} />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
