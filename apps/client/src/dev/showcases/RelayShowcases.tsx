import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { CatalogCard, ConnectionStatusBanner, MessagingConnections } from '@/layers/features/relay';
import { CATALOG_KEY, type RelayConnectionState } from '@/layers/entities/relay';
import { BINDINGS_QUERY_KEY } from '@/layers/entities/binding';
import type { AdapterManifest, CatalogEntry } from '@dorkos/shared/relay-schemas';

const TELEGRAM_MANIFEST: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Send and receive messages via Telegram bots.',
  iconId: 'telegram',
  category: 'messaging',
  builtin: true,
  multiInstance: false,
  configFields: [
    { key: 'botToken', label: 'Bot Token', type: 'password', required: true },
    { key: 'chatId', label: 'Chat ID', type: 'text', required: true },
  ],
};

const GITHUB_MANIFEST: AdapterManifest = {
  type: 'github',
  displayName: 'GitHub',
  description: 'Automate workflows with GitHub webhooks and notifications.',
  iconId: 'github',
  category: 'automation',
  builtin: true,
  multiInstance: true,
  configFields: [
    { key: 'token', label: 'Personal Access Token', type: 'password', required: true },
    { key: 'repo', label: 'Repository', type: 'text', required: true },
  ],
};

const CONNECTION_STATES: RelayConnectionState[] = ['disconnected', 'reconnecting'];

/**
 * The adapter catalog `MessagingConnections` reads: Telegram already
 * configured and connected, GitHub still available to add.
 */
const MESSAGING_CATALOG: CatalogEntry[] = [
  {
    manifest: TELEGRAM_MANIFEST,
    instances: [
      {
        id: 'telegram-1',
        enabled: true,
        label: 'Team bot',
        status: {
          id: 'telegram-1',
          type: 'telegram',
          displayName: 'Telegram',
          state: 'connected',
          messageCount: { inbound: 128, outbound: 94 },
          errorCount: 0,
        },
      },
    ],
  },
  { manifest: GITHUB_MANIFEST, instances: [] },
];

/**
 * Build an isolated, pre-seeded `QueryClient` for a `MessagingConnections` demo.
 *
 * `MessagingConnections` takes `enabled` as a prop but reads its catalog and
 * bindings from hooks with no override, so an isolated client is the only way
 * to show it with fixture data. `BINDINGS_QUERY_KEY` must resolve to an array
 * rather than stay unseeded: `AdapterCard` destructures `useBindings()`'s
 * `data` with a default that only covers `undefined`, and the playground's
 * ambient transport resolves every unseeded query to `null`, which would
 * throw the moment the card tries to `.filter()` it.
 */
function makeMessagingQueryClient(catalog: CatalogEntry[]): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  qc.setQueryData(CATALOG_KEY, catalog);
  qc.setQueryData(BINDINGS_QUERY_KEY, []);
  return qc;
}

/** `MessagingConnections` with one connected adapter and one still available to add. */
function MessagingConnectionsShowcase() {
  const client = useMemo(() => makeMessagingQueryClient(MESSAGING_CATALOG), []);

  return (
    <PlaygroundSection
      title="MessagingConnections"
      description="The composed panel behind Connections' Messaging region — live adapters and the ones still available to add, real components throughout."
    >
      <ShowcaseDemo>
        <QueryClientProvider client={client}>
          {/* No extra padding — `MessagingRegion` renders this with none of its
              own, and its rows are tight enough on a phone width that framing
              it any narrower than the app does wraps text the app never wraps. */}
          <div className="max-w-2xl">
            <MessagingConnections enabled />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Relay feature component showcases: CatalogCard, ConnectionStatusBanner, MessagingConnections. */
export function RelayShowcases() {
  return (
    <>
      <PlaygroundSection
        title="CatalogCard"
        description="Adapter manifest card for the relay catalog browser."
      >
        <ShowcaseDemo>
          <div className="grid gap-4 sm:grid-cols-2">
            <CatalogCard manifest={TELEGRAM_MANIFEST} onAdd={() => {}} />
            <CatalogCard manifest={GITHUB_MANIFEST} onAdd={() => {}} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ConnectionStatusBanner"
        description="Relay connection state banner. Connected state renders null."
      >
        {CONNECTION_STATES.map((state) => (
          <div key={state}>
            <ShowcaseLabel>{state}</ShowcaseLabel>
            <ShowcaseDemo>
              <ConnectionStatusBanner connectionState={state} />
            </ShowcaseDemo>
          </div>
        ))}
      </PlaygroundSection>

      <MessagingConnectionsShowcase />
    </>
  );
}
