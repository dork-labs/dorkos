import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorSessionConnections } from '@dorkos/shared/connector-resource-schemas';
import { CONNECTION_READINESS_COPY } from '@dorkos/shared/connector-schemas';
import { SessionConnectionAccessList } from '@/layers/entities/connectors';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';
import { READY } from '../mock-samples';

/** What a chat's side panel lists: one account usable, one turned off here, one still applying. */
const MOCK_SESSION_CONNECTIONS = {
  sessionId: 'session-demo',
  agentId: 'dorkbot',
  connections: [
    {
      connectionId: 'conn-gmail-personal',
      toolkit: 'gmail',
      label: 'personal',
      source: 'agent',
      operationRevisionIds: ['gmail-list-v1', 'gmail-read-v1'],
      readiness: READY,
    },
    {
      connectionId: 'conn-notion',
      toolkit: 'notion',
      label: 'Acme workspace',
      source: 'this_chat',
      operationRevisionIds: [],
      readiness: {
        state: 'unavailable',
        reason: 'off_for_this_chat',
        copy: CONNECTION_READINESS_COPY.off_for_this_chat,
      },
    },
    {
      connectionId: 'conn-drive',
      toolkit: 'googledrive',
      label: 'team',
      source: 'agent',
      operationRevisionIds: ['drive-list-v1'],
      readiness: {
        state: 'finishing',
        reason: 'access_updating',
        fix: { action: 'wait', fixableBy: 'dorkos' },
        copy: CONNECTION_READINESS_COPY.access_updating,
      },
    },
  ],
} as unknown as ConnectorSessionConnections;

/** The chat side panel's accounts, answered by a playground server. */
function SessionFrame() {
  const [transport] = useState(() => {
    const base = createPlaygroundTransport();
    return new Proxy(base, {
      get: (target, prop, receiver) =>
        prop === 'getSessionConnectorConnections'
          ? async () => MOCK_SESSION_CONNECTIONS
          : Reflect.get(target, prop, receiver),
    });
  });
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <div className="bg-background max-w-sm rounded-xl border p-3">
          <SessionConnectionAccessList sessionId="session-demo" />
        </div>
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** A chat's side panel list of accounts, each with the server's readiness. */
export function SessionConnectionAccessListShowcase() {
  return (
    <PlaygroundSection
      title="SessionConnectionAccessList"
      description="A chat's side panel, for each account its agent was given: usable here, or the server's one line for why not."
    >
      <ShowcaseDemo responsive>
        <SessionFrame />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
