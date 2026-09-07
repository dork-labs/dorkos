import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import { AccountRow } from '@/layers/features/connections';
import { AccountsRegion, MessagingRegion } from '@/layers/widgets/connections';
import { connectorKeys } from '@/layers/entities/connectors';
import { CATALOG_KEY } from '@/layers/entities/relay';
import { BINDINGS_QUERY_KEY } from '@/layers/entities/binding';
import { configKeys } from '@/layers/entities/config';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

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
 * Connections surface: the service tile, the connected-account row, and — see
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

      <AccountsRegionShowcase />
      <MessagingRegionShowcase />
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
 * The populated state (`ServiceGrid`, `AccountsList`, access review) needs
 * three more seeded data sources beyond this one; left for a future pass
 * rather than guessing at their shapes here. First-run is the state every new
 * install actually starts in, so it earns its place on its own.
 */
function AccountsRegionShowcase() {
  const client = useMemo(
    () =>
      makeConnectionsQueryClient((qc) => {
        qc.setQueryData(connectorKeys.connections(), { connections: [] });
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
      description="The composed Accounts region in its calm first-run state, with one service action and advanced provider setup kept out of the main path."
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
 * decision — `ClaimFeed` and `MessagePolicyCard` render nothing in this
 * fixture (an empty claim queue, no built-in delivery adapter configured),
 * which is itself a real, honest state rather than a demo gap.
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
      description="The composed panel behind Connections' Messaging region — the health bar and the live adapter, real components throughout. The claim queue and policy card render nothing in this fixture (see TSDoc)."
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
