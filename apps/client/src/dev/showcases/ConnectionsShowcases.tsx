import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorProviderStatus } from '@dorkos/shared/connector-provider';
import { AccountRow, ConnectionWays } from '@/layers/features/connections';
import { cloudStatusKey } from '@/layers/features/cloud-link';
import { AccountsRegion, MessagingRegion } from '@/layers/widgets/connections';
import { connectorKeys } from '@/layers/entities/connectors';
import { CATALOG_KEY } from '@/layers/entities/relay';
import { BINDINGS_QUERY_KEY } from '@/layers/entities/binding';
import { configKeys } from '@/layers/entities/config';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ConnectionAccessCardShowcase } from './ConnectionAccessCardShowcase';

function mockAccount(over: Partial<ConnectorConnectionSummary>): ConnectorConnectionSummary {
  return {
    connectionId: 'ca_mock_1' as ConnectorConnectionSummary['connectionId'],
    providerInstanceId: 'provider-1' as ConnectorConnectionSummary['providerInstanceId'],
    toolkit: 'gmail',
    label: 'work',
    identityHint: 'work@example.com',
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'managed',
    custody: 'managed',
    payer: 'dorkos_managed',
    agentCount: 2,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 12, attemptCount: 12 },
    warnings: [],
    ...over,
  };
}

/**
 * Connections surface: the service tile, the connected-account row, the shared
 * "who can use it" access card, and — see
 * {@link AccountsRegionShowcase}, {@link MessagingRegionShowcase} — the two
 * composed regions the leaves live inside of.
 */
export function ConnectionsShowcases() {
  return (
    <>
      <PlaygroundSection
        title="AccountRow"
        description="One connected account: service icon, Gmail (work) naming, lifecycle status, and its own server-composed custody sentence."
      >
        <ShowcaseLabel>Active, managed custody</ShowcaseLabel>
        <ShowcaseDemo>
          <ul className="max-w-xl">
            <AccountRow connection={mockAccount({})} onOpenDetail={() => {}} />
          </ul>
        </ShowcaseDemo>

        <ShowcaseLabel>Two accounts of one service</ShowcaseLabel>
        <ShowcaseDemo>
          <ul className="max-w-xl space-y-2">
            <AccountRow connection={mockAccount({})} onOpenDetail={() => {}} />
            <AccountRow
              connection={mockAccount({
                connectionId: 'ca_mock_2' as ConnectorConnectionSummary['connectionId'],
                label: 'personal',
              })}
              onOpenDetail={() => {}}
            />
          </ul>
        </ShowcaseDemo>

        <ShowcaseLabel>Expired (self-host custody)</ShowcaseLabel>
        <ShowcaseDemo>
          <ul className="max-w-xl">
            <AccountRow
              connection={mockAccount({
                connectionId: 'ca_mock_3' as ConnectorConnectionSummary['connectionId'],
                toolkit: 'slack',
                label: 'team',
                authenticationStatus: 'expired',
                lifecycle: 'paused',
                mode: 'byo',
                custody: 'self-host',
                payer: 'operator_byo',
              })}
              onOpenDetail={() => {}}
            />
          </ul>
        </ShowcaseDemo>

        <ShowcaseLabel>Paused by the operator</ShowcaseLabel>
        <ShowcaseDemo>
          <ul className="max-w-xl">
            <AccountRow
              connection={mockAccount({
                connectionId: 'ca_mock_4' as ConnectorConnectionSummary['connectionId'],
                lifecycle: 'paused',
              })}
              onOpenDetail={() => {}}
            />
          </ul>
        </ShowcaseDemo>
      </PlaygroundSection>

      <ConnectionAccessCardShowcase />
      <AccountsRegionShowcase />
      <MessagingRegionShowcase />
      <ConnectionWaysShowcase />
    </>
  );
}

/**
 * Build an isolated, pre-seeded `QueryClient` for a connections-region demo.
 *
 * Every region under `/connections` reads exclusively from hooks — see
 * `AccountsRegion`/`MessagingRegion` for why — so an isolated client is the
 * only way to show them with fixture data, the same pattern
 * `MessagingConnectionsShowcase` (`RelayShowcases.tsx`) uses for the panel one
 * level down.
 *
 * @param seed - Populates the client's cache before the region mounts.
 */
function makeConnectionsQueryClient(seed: (qc: QueryClient) => void): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  seed(qc);
  return qc;
}

/**
 * `AccountsRegion` in its first-run state — no connectable services yet.
 *
 * The first-run view still reads the pending access-request collection, so the
 * showcase seeds every query the composed region needs before it mounts.
 */
function AccountsRegionShowcase() {
  const client = useMemo(
    () =>
      makeConnectionsQueryClient((qc) => {
        qc.setQueryData(connectorKeys.connections(), { connections: [] });
        qc.setQueryData(connectorKeys.providers(), []);
        qc.setQueryData(connectorKeys.agentRequestList('pending'), []);
        qc.setQueryData(connectorKeys.catalog(''), {
          pages: [{ services: [], warnings: [] }],
          pageParams: [undefined],
        });
      }),
    []
  );

  return (
    <PlaygroundSection
      title="AccountsRegion"
      description="The composed Accounts region in its calm first-run state, with one service action. Your own Composio or Nango key is set in Settings › Connections, which the region points to."
    >
      <ShowcaseDemo>
        <QueryClientProvider client={client}>
          {/* No extra padding here — `ConnectionsPage` renders the region
              directly inside `PageContainer` with none of its own, and this
              region's rows are tight enough on a phone width that framing it
              any narrower than the app does wraps text the app never wraps. */}
          <div className="max-w-2xl">
            <AccountsRegion />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * `MessagingRegion` with one connected adapter and nothing waiting on a
 * decision — `ClaimFeed` renders nothing in this fixture (an empty claim
 * queue), which is itself a real, honest state rather than a demo gap.
 */
function MessagingRegionShowcase() {
  const client = useMemo(
    () =>
      makeConnectionsQueryClient((qc) => {
        qc.setQueryData(configKeys.current(), { relay: { enabled: true } });
        qc.setQueryData(CATALOG_KEY, [
          {
            manifest: {
              type: 'telegram',
              displayName: 'Telegram',
              description: 'Send and receive messages via Telegram bots.',
              iconId: 'telegram',
              category: 'messaging' as const,
              builtin: true,
              multiInstance: false,
              configFields: [],
            },
            instances: [
              {
                id: 'telegram-1',
                enabled: true,
                label: 'Team bot',
                status: {
                  id: 'telegram-1',
                  type: 'telegram' as const,
                  displayName: 'Telegram',
                  state: 'connected' as const,
                  messageCount: { inbound: 128, outbound: 94 },
                  errorCount: 0,
                },
              },
            ],
          },
        ]);
        qc.setQueryData(BINDINGS_QUERY_KEY, []);
      }),
    []
  );

  return (
    <PlaygroundSection
      title="MessagingRegion"
      description="The composed panel behind Connections' Messaging region — the health bar and the live adapter, real components throughout. The claim queue renders nothing in this fixture (see TSDoc)."
    >
      <ShowcaseDemo>
        <QueryClientProvider client={client}>
          {/* See AccountsRegionShowcase — no extra padding, for the same reason. */}
          <div className="max-w-2xl">
            <MessagingRegion />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
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
 * set up yet, and a DorkOS account plus a working Composio key beside a Nango
 * key the server refused. Each gets its own client, since both read the same
 * three queries.
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
        qc.setQueryData(connectorKeys.providers(), [
          mockKey({}),
          mockKey({
            type: 'nango',
            providerInstanceId: 'provider-2' as ConnectorProviderStatus['providerInstanceId'],
            custody: 'self-host',
            disclosure: 'Your Nango server keeps your logins on a machine you run.',
          }),
        ]);
        qc.setQueryData(connectorKeys.connections(), { connections: [] });
      }),
    []
  );
  const setUp = useMemo(
    () =>
      makeConnectionsQueryClient((qc) => {
        qc.setQueryData(cloudStatusKey, {
          linked: true,
          accountLabel: 'you@example.com',
          lastHeartbeatAt: null,
        });
        qc.setQueryData(connectorKeys.providers(), [
          mockKey({ configured: true, registered: true, keyKind: 'project' }),
          mockKey({
            type: 'nango',
            providerInstanceId: 'provider-2' as ConnectorProviderStatus['providerInstanceId'],
            custody: 'self-host',
            configured: true,
            error: 'Set NANGO_ENCRYPTION_KEY on the server, then save the key again.',
          }),
        ]);
        qc.setQueryData(connectorKeys.connections(), {
          connections: [
            mockAccount({}),
            mockAccount({
              connectionId: 'ca_mock_5' as ConnectorConnectionSummary['connectionId'],
              toolkit: 'notion',
              label: 'team',
              mode: 'byo',
              payer: 'operator_byo',
            }),
            mockAccount({
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
      description="Settings › Connections: how DorkOS reaches your apps, with each way's state, how many apps use it, and Change key / Remove…."
    >
      <ShowcaseLabel>Nothing set up yet</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={empty}>
          <div className="max-w-2xl">
            <ConnectionWays onManageAccount={() => {}} onOpenConnectionsPage={() => {}} />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>DorkOS account, a working key, and a refused key</ShowcaseLabel>
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
