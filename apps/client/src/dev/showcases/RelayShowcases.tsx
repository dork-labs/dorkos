import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ChatAppAnswerers, ConnectionStatusBanner } from '@/layers/features/relay';
import type { RelayConnectionState } from '@/layers/entities/relay';
import { BINDINGS_QUERY_KEY } from '@/layers/entities/binding';
import type { AdapterBinding, CatalogInstance } from '@dorkos/shared/relay-schemas';

const CONNECTION_STATES: RelayConnectionState[] = ['disconnected', 'reconnecting'];

const TELEGRAM_BOT: CatalogInstance = {
  id: 'telegram-1',
  enabled: true,
  label: '@lifeos_bot',
  status: {
    id: 'telegram-1',
    type: 'telegram',
    displayName: 'Telegram',
    state: 'connected',
    messageCount: { inbound: 128, outbound: 94 },
    errorCount: 0,
  },
};

const DORKBOT_ANSWERS: AdapterBinding = {
  id: 'binding-1',
  adapterId: 'telegram-1',
  agentId: 'dorkbot',
  sessionStrategy: 'per-chat',
  label: '',
  canInitiate: false,
  canReply: true,
  canReceive: true,
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
} as AdapterBinding;

/**
 * An isolated client for one "Who answers" demo: the bindings it reads, and
 * the agents it names. Unseeded reads would resolve `null` in the playground.
 */
function makeAnswerersClient(bindings: AdapterBinding[]): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  qc.setQueryData(BINDINGS_QUERY_KEY, bindings);
  qc.setQueryData(['mesh', 'agents', undefined], {
    agents: [{ id: 'dorkbot', name: 'DorkBot', isSystem: true }],
  });
  return qc;
}

/** "Who answers" for a chat app: nobody yet (the picker), and DorkBot answering. */
function ChatAppAnswerersShowcase() {
  const nobody = useMemo(() => makeAnswerersClient([]), []);
  const dorkbot = useMemo(() => makeAnswerersClient([DORKBOT_ANSWERS]), []);
  return (
    <PlaygroundSection
      title="ChatAppAnswerers"
      description="Who answers a chat app, from its side panel: one picker when nobody does yet, and each answer opens the full binding dialog."
    >
      <ShowcaseLabel>Nobody answers yet</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={nobody}>
          <div className="max-w-md">
            <ChatAppAnswerers instance={TELEGRAM_BOT} appName="Telegram" />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>DorkBot answers</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={dorkbot}>
          <div className="max-w-md">
            <ChatAppAnswerers instance={TELEGRAM_BOT} appName="Telegram" />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Relay feature component showcases: ConnectionStatusBanner and ChatAppAnswerers. */
export function RelayShowcases() {
  return (
    <>
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

      <ChatAppAnswerersShowcase />
    </>
  );
}
