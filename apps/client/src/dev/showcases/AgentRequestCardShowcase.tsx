import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type {
  ConnectorAgentRequestItem,
  ConnectorReconciliationApplyRequest,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import type {
  ConnectorAppConnections,
  ConnectorCatalogService,
  ConnectorConnectionSummary,
} from '@dorkos/shared/connector-resource-schemas';
import { AgentRequestCard } from '@/layers/features/connections';
import { TransportProvider } from '@/layers/shared/model';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

const REQUEST = {
  requestId: 'request-1',
  reviewUrl: '/connections?request=request-1',
  serviceSlug: 'gmail',
  reason: 'Summarise today’s inbox',
  requestedOperations: ['gmail.list-messages'],
  requestedEvents: [],
  createdAt: '2026-09-26T10:00:00.000Z',
  expiresAt: '2099-09-26T12:00:00.000Z',
  status: 'awaiting_owner',
  sessionId: 'session-1',
  agent: { id: 'dorkbot', displayName: 'DorkBot' },
} as ConnectorAgentRequestItem;

const GMAIL: ConnectorCatalogService = {
  serviceSlug: 'gmail',
  displayName: 'Gmail',
  iconKey: 'gmail',
  signInName: 'Google',
  intents: [
    {
      kind: 'account',
      displayName: 'Use a Gmail account',
      routes: [
        {
          providerInstanceId: 'composio-1' as never,
          displayName: 'composio',
          mode: 'byo',
          custody: 'managed',
          payer: 'operator_byo',
          capabilities: {
            catalog: { status: 'available' },
            authentication: { status: 'available' },
            accounts: { status: 'available' },
            operations: { status: 'available' },
            execution: { status: 'available' },
            triggers: { status: 'unsupported', reason: 'Not yet.' },
          },
          disclosure: 'Composio stores login access.',
          authKind: 'oauth2',
          signInThrough: 'Composio',
        },
      ],
    },
  ],
};

function account(connectionId: string, label: string): ConnectorConnectionSummary {
  return {
    connectionId: connectionId as never,
    providerInstanceId: 'composio-1' as never,
    toolkit: 'gmail',
    label,
    identityHint: `${label}@example.com`,
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'byo',
    custody: 'managed',
    payer: 'operator_byo',
    agentCount: 0,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    warnings: [],
    everyAgent: null,
  };
}

function preview(connectionId: string): ConnectorReconciliationPreview {
  const candidate = (id: string, classification: 'read' | 'write') => ({
    operationRevisionId: id,
    toolkit: 'gmail',
    operationSlug: `gmail.${id}`,
    toolkitVersion: '2026-09-01',
    capabilityClassification: classification,
    retryPolicy: 'never' as const,
    inputSchema: {},
    supported: true,
  });
  return {
    previewId: `preview-${connectionId}`,
    connection: {
      connectionId: connectionId as never,
      toolkit: 'gmail',
      label: 'work',
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
    candidates: [candidate('list-messages', 'read'), candidate('send-message', 'write')],
    agents: [{ agentId: 'dorkbot', displayName: 'DorkBot' }],
    currentGrants: [],
    catalogComplete: true,
    everyAgent: { available: true, operationRevisionIds: [] },
    createdAt: '2026-09-26T00:00:00.000Z',
    expiresAt: '2099-09-26T00:00:00.000Z',
  };
}

/**
 * A playground-only server for one request card: the app with or without a
 * connected account, a sign-in that waits, and an answer that lands as granted
 * or denied so the card collapses to its record.
 */
function requestTransport(
  accounts: ConnectorConnectionSummary[],
  appConnections?: ConnectorAppConnections
): Transport {
  const base = createPlaygroundTransport();
  const pendingFlow = {
    flowId: 'flow-1',
    providerInstanceId: 'composio-1',
    toolkit: 'gmail',
    state: 'pending',
    authorizeUrl: 'https://accounts.example.com/consent',
  };
  const overrides: Partial<Record<keyof Transport, unknown>> = {
    getConnectorConnections: async () => ({ connections: accounts }),
    // With `appConnections`, no way reaches Gmail yet and that is the reason.
    getConnectorCatalog: async () =>
      appConnections
        ? {
            services: [{ ...GMAIL, intents: [{ ...GMAIL.intents[0]!, routes: [] }] }],
            warnings: [],
            appConnections,
          }
        : { services: [GMAIL], warnings: [] },
    ...(appConnections && {
      getConnectorProviders: async () => ({
        providers: [
          {
            type: 'composio',
            providerInstanceId: 'composio-1',
            configured: false,
            registered: false,
            custody: 'managed',
            disclosure: 'Composio keeps the sign-in for each app you connect.',
          },
        ],
        appConnections,
      }),
    }),
    previewConnectorReconciliation: async ({ connectionId }: { connectionId: string }) =>
      preview(connectionId),
    applyConnectorReconciliation: async (request: ConnectorReconciliationApplyRequest) => ({
      connectionId: request.previewId.replace('preview-', ''),
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: request.grants,
    }),
    startConnectorAgentRequestAuthentication: async () => pendingFlow,
    pollConnectorAgentRequestAuthentication: async () => pendingFlow,
  };
  return new Proxy(base, {
    get: (target, prop, receiver) =>
      typeof prop === 'string' && prop in overrides
        ? overrides[prop as keyof Transport]
        : (Reflect.get(target, prop, receiver) as unknown),
  });
}

function CardDemo({
  accounts,
  request = REQUEST,
  appConnections,
}: {
  accounts: ConnectorConnectionSummary[];
  request?: ConnectorAgentRequestItem;
  /** Set to show the card while no way reaches the app. */
  appConnections?: ConnectorAppConnections;
}) {
  const [transport] = useState(() => requestTransport(accounts, appConnections));
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
  );
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <AgentRequestCard request={request} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * The card an agent's request for an app draws in a chat or a room: connect
 * the app when there is no account, then the shared one-agent access question,
 * then a one-line record of the answer. Each demo runs the real card against a
 * scripted server.
 */
export function AgentRequestCardShowcase() {
  return (
    <PlaygroundSection
      title="AgentRequestCard"
      description="An agent asked for an app mid-chat. Connect it, let this one agent use it, and the card collapses to a record of the answer."
    >
      <ShowcaseLabel>No account yet: Connect, then the sign-in waits</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <CardDemo accounts={[]} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Nothing reaches Gmail because the DorkOS account isn’t linked anymore: the one-time step
        offers linking it again or a key, as equal choices
      </ShowcaseLabel>
      <ShowcaseDemo responsive>
        <CardDemo
          accounts={[]}
          appConnections={{
            ways: [{ kind: 'dorkos_account', type: 'dorkos-managed', status: 'unlinked' }],
            newApps: { status: 'setup_needed', reason: 'dorkos_account_unlinked' },
          }}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Already connected: only “Let DorkBot use Gmail?”</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <CardDemo accounts={[account('gmail-work', 'work')]} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Connected through a DorkOS account that isn’t linked anymore: connect it again
      </ShowcaseLabel>
      <ShowcaseDemo responsive>
        <CardDemo
          accounts={[
            {
              ...account('gmail-work', 'work'),
              mode: 'managed',
              wayProblem: 'dorkos_account_unlinked',
            },
          ]}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Two accounts: asks which one first</ShowcaseLabel>
      <ShowcaseDemo>
        <CardDemo accounts={[account('gmail-work', 'work'), account('gmail-home', 'home')]} />
      </ShowcaseDemo>

      <ShowcaseLabel>Answered: granted, and turned down</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="space-y-2">
          <CardDemo
            accounts={[]}
            request={
              {
                ...REQUEST,
                status: 'granted',
                connectionId: 'gmail-work' as never,
                grantedOperationRevisionIds: ['list-messages'],
                grantedEvents: [],
              } as ConnectorAgentRequestItem
            }
          />
          <CardDemo
            accounts={[]}
            request={{ ...REQUEST, status: 'denied' } as ConnectorAgentRequestItem}
          />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
