import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type {
  ConnectorReconciliationApplyRequest,
  ConnectorReconciliationApplyResponse,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import {
  ConnectionAccessCard,
  type ConnectionAccessCardProps,
} from '@/layers/features/connections';
import { TransportProvider } from '@/layers/shared/model';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

const AGENT_NAMES = ['DorkBot', 'mailroom', 'Research Bot', 'Ada', 'Bo', 'Cy', 'Di', 'Ed'];

function candidate(id: string, classification: 'read' | 'write' | 'destructive') {
  return {
    operationRevisionId: id,
    toolkit: 'gmail',
    operationSlug: `gmail.${id}`,
    toolkitVersion: '2026-09-01',
    capabilityClassification: classification,
    retryPolicy: 'never' as const,
    inputSchema: {},
    supported: true,
  };
}

function preview(connectionId: string, label: string): ConnectorReconciliationPreview {
  return {
    previewId: `preview-${connectionId}`,
    connection: {
      connectionId: connectionId as never,
      toolkit: 'gmail',
      label,
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
    candidates: [
      candidate('list-messages', 'read'),
      candidate('send-message', 'write'),
      candidate('delete-message', 'destructive'),
    ],
    agents: AGENT_NAMES.map((name) => ({
      agentId: name.toLowerCase().replace(' ', '-'),
      displayName: name,
    })),
    currentGrants: [{ agentId: 'mailroom', operationRevisionIds: ['list-messages'] }],
    // "shared" starts shared with every agent (read); "managed" is through a
    // DorkOS account on a computer that cannot reach the service keeping its
    // access, the one case where every agent isn't offered (DOR-2439).
    everyAgent:
      connectionId === 'gmail-managed'
        ? { available: false, operationRevisionIds: [] }
        : {
            available: true,
            operationRevisionIds:
              connectionId === 'gmail-shared'
                ? ['list-messages']
                : connectionId === 'gmail-exact'
                  ? ['list-messages', 'send-message', 'delete-message']
                  : [],
          },
    catalogComplete: true,
    createdAt: '2026-09-26T00:00:00.000Z',
    expiresAt: '2099-09-26T00:00:00.000Z',
  };
}

function account(connectionId: string, label: string): ConnectorConnectionSummary {
  return {
    connectionId: connectionId as never,
    providerInstanceId: 'provider-1' as never,
    toolkit: 'gmail',
    label,
    identityHint: `${label}@example.com`,
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    mode: 'managed',
    custody: 'managed',
    payer: 'dorkos_managed',
    agentCount: 1,
    everyAgent: null,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    warnings: [],
  };
}

/** The account label each scripted connection shows. */
const SHOWCASE_LABELS: Record<string, string> = {
  'gmail-work': 'work',
  'gmail-shared': 'shared',
  'gmail-managed': 'managed',
  'gmail-exact': 'exact',
};

/** How the scripted server answers a save. */
type SaveAnswer = 'ready' | 'pending' | 'failed' | 'no-answer';

/**
 * A playground-only server for one card: two Gmail accounts, eight agents
 * (DorkBot marked as the system agent), and a save that answers as scripted.
 * Scoped to the showcase so no other demo inherits these fixtures.
 */
function accessTransport(answer: SaveAnswer): Transport {
  const base = createPlaygroundTransport();
  const overrides: Partial<Record<keyof Transport, unknown>> = {
    listMeshAgents: async () => ({ agents: [{ id: 'dorkbot', isSystem: true }] }),
    getConnectorConnections: async () => ({
      connections: [account('gmail-work', 'work'), account('gmail-personal', 'personal')],
    }),
    previewConnectorReconciliation: async ({ connectionId }: { connectionId: string }) =>
      preview(connectionId, SHOWCASE_LABELS[connectionId] ?? 'personal'),
    applyConnectorReconciliation: async (
      request: ConnectorReconciliationApplyRequest
    ): Promise<ConnectorReconciliationApplyResponse> => {
      if (answer === 'no-answer') throw new Error('The connection dropped before an answer.');
      return {
        connectionId: request.previewId.replace('preview-', '') as never,
        reconciliationStatus: 'ready',
        authoritySync:
          answer === 'failed'
            ? { status: 'failed', reason: 'Composio did not confirm the change.' }
            : { status: answer },
        grants: request.grants,
        ...(request.everyAgent && { everyAgent: request.everyAgent }),
      };
    },
  };
  return new Proxy(base, {
    get: (target, prop, receiver) =>
      typeof prop === 'string' && prop in overrides
        ? overrides[prop as keyof Transport]
        : (Reflect.get(target, prop, receiver) as unknown),
  });
}

function CardDemo({ answer, props }: { answer: SaveAnswer; props: ConnectionAccessCardProps }) {
  const [transport] = useState(() => accessTransport(answer));
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
  );
  const [key, setKey] = useState(0);
  const restart = () => setKey((value) => value + 1);
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <div className="max-w-md">
          <ConnectionAccessCard key={key} {...props} onSkip={restart} onFinished={restart} />
        </div>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/**
 * The shared "who can use it" card in both modes: the page's agent picker and
 * the chat's one-agent question, including the two-account question and every
 * save outcome. Each demo runs the real card against a scripted server; Skip,
 * Not now, Done and Close start it over.
 */
export function ConnectionAccessCardShowcase() {
  return (
    <PlaygroundSection
      title="ConnectionAccessCard"
      description="Who can use an app, and what can they do. The page picks agents or every agent; the chat answers for one agent and asks which account when there are two."
    >
      <ShowcaseLabel>
        Page: pick agents (mailroom already reads; untick it to see the warning)
      </ShowcaseLabel>
      <ShowcaseDemo responsive>
        <CardDemo
          answer="ready"
          props={{ mode: 'page', connectionId: 'gmail-work', serviceName: 'Gmail' }}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Page: shared with every agent (switch to Read and write to see the warning)
      </ShowcaseLabel>
      <ShowcaseDemo responsive>
        <CardDemo
          answer="ready"
          props={{ mode: 'page', connectionId: 'gmail-shared', serviceName: 'Gmail' }}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Page: every agent holds exact actions, including delete (no level, warning shown)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <CardDemo
          answer="ready"
          props={{ mode: 'page', connectionId: 'gmail-exact', serviceName: 'Gmail' }}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Page: through a DorkOS account that can’t be reached, where every agent isn’t offered
      </ShowcaseLabel>
      <ShowcaseDemo>
        <CardDemo
          answer="ready"
          props={{ mode: 'page', connectionId: 'gmail-managed', serviceName: 'Gmail' }}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>One agent, two accounts: asks which first</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <CardDemo
          answer="ready"
          props={{ mode: 'agent', agentId: 'dorkbot', toolkit: 'gmail', serviceName: 'Gmail' }}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Save reaches no answer: pick an agent, then Save</ShowcaseLabel>
      <ShowcaseDemo>
        <CardDemo
          answer="no-answer"
          props={{ mode: 'page', connectionId: 'gmail-work', serviceName: 'Gmail' }}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Sync pending: press Allow</ShowcaseLabel>
      <ShowcaseDemo>
        <CardDemo
          answer="pending"
          props={{
            mode: 'agent',
            agentId: 'dorkbot',
            toolkit: 'gmail',
            connectionId: 'gmail-work',
            serviceName: 'Gmail',
          }}
        />
      </ShowcaseDemo>

      <ShowcaseLabel>Sync failed: press Allow</ShowcaseLabel>
      <ShowcaseDemo>
        <CardDemo
          answer="failed"
          props={{
            mode: 'agent',
            agentId: 'dorkbot',
            toolkit: 'gmail',
            connectionId: 'gmail-work',
            serviceName: 'Gmail',
          }}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
