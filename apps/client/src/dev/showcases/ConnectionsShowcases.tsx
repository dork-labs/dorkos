import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PublicConnectedAccount } from '@dorkos/shared/connector-provider';
import { ServiceTile, AccountRow } from '@/layers/features/connections';
import { AccountsRegion, MessagingRegion } from '@/layers/widgets/connections';
import { connectorKeys } from '@/layers/entities/connectors';
import { CATALOG_KEY } from '@/layers/entities/relay';
import { BINDINGS_QUERY_KEY } from '@/layers/entities/binding';
import { configKeys } from '@/layers/entities/config';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

const MANAGED_DISCLOSURE =
  'Connecting Gmail takes you to that service to sign in. Composio stores your connected ' +
  "accounts' login access in its own secure vault, not on your computer. Your agents can then " +
  'act for you; your password is never shared, and you can disconnect anytime.';

const SELF_HOST_DISCLOSURE =
  "You're connecting through your own Nango server. The keys to this connection are stored in " +
  'your database, on infrastructure you control. Nothing about this connection leaves your systems.';

function mockAccount(over: Partial<PublicConnectedAccount>): PublicConnectedAccount {
  return {
    id: 'ca_mock_1' as PublicConnectedAccount['id'],
    toolkit: 'gmail',
    label: 'work',
    status: 'active',
    custody: 'managed',
    disclosure: MANAGED_DISCLOSURE,
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
        title="ServiceTile"
        description="One connectable service on the /connections grid — service-first, a single Connect verb, provider invisible."
      >
        <ShowcaseLabel>Known services</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="grid max-w-xl grid-cols-2 gap-3 sm:grid-cols-3">
            <ServiceTile
              toolkit={{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }}
              onConnect={() => {}}
            />
            <ServiceTile
              toolkit={{ slug: 'slack', displayName: 'Slack', authKind: 'oauth2' }}
              onConnect={() => {}}
            />
            <ServiceTile
              toolkit={{ slug: 'linear', displayName: 'Linear', authKind: 'oauth2' }}
              onConnect={() => {}}
            />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Unknown service (fallback icon)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="max-w-40">
            <ServiceTile
              toolkit={{ slug: 'obscureapi', displayName: 'Obscure API', authKind: 'api-key' }}
              onConnect={() => {}}
            />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="AccountRow"
        description="One connected account: service icon, Gmail (work) naming, lifecycle status, and its own server-composed custody sentence."
      >
        <ShowcaseLabel>Active, managed custody</ShowcaseLabel>
        <ShowcaseDemo>
          <ul className="max-w-xl">
            <AccountRow account={mockAccount({})} onDisconnect={() => {}} />
          </ul>
        </ShowcaseDemo>

        <ShowcaseLabel>Two accounts of one service</ShowcaseLabel>
        <ShowcaseDemo>
          <ul className="max-w-xl space-y-2">
            <AccountRow account={mockAccount({})} onDisconnect={() => {}} />
            <AccountRow
              account={mockAccount({
                id: 'ca_mock_2' as PublicConnectedAccount['id'],
                label: 'personal',
              })}
              onDisconnect={() => {}}
            />
          </ul>
        </ShowcaseDemo>

        <ShowcaseLabel>Expired (self-host custody)</ShowcaseLabel>
        <ShowcaseDemo>
          <ul className="max-w-xl">
            <AccountRow
              account={mockAccount({
                id: 'ca_mock_3' as PublicConnectedAccount['id'],
                toolkit: 'slack',
                label: 'team',
                status: 'expired',
                custody: 'self-host',
                disclosure: SELF_HOST_DISCLOSURE,
              })}
              onDisconnect={() => {}}
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
 * The populated state (`ServiceGrid`, `AccountsList`, `AgentAccounts`) needs
 * three more seeded data sources beyond this one; left for a future pass
 * rather than guessing at their shapes here. First-run is the state every new
 * install actually starts in, so it earns its place on its own.
 */
function AccountsRegionShowcase() {
  const client = useMemo(
    () =>
      makeConnectionsQueryClient((qc) => {
        qc.setQueryData(connectorKeys.toolkits(), { toolkits: [] });
      }),
    []
  );

  return (
    <PlaygroundSection
      title="AccountsRegion"
      description="The composed panel behind Connections' Accounts region, in its first-run state — nothing connectable yet, so the region names the one-time Composio & Nango setup instead of an empty box."
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
      description="The composed panel behind Connections' Messaging region — the health bar, the live adapter, and the policy card, real components throughout."
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
