import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorSessionConnections } from '@dorkos/shared/connector-resource-schemas';
import {
  CONNECTION_READINESS_COPY,
  TURN_ON_FOR_THIS_CHAT_COPY,
} from '@dorkos/shared/connector-schemas';
import { SessionConnectionAccessList } from '@/layers/entities/connectors';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';
import { READY } from '../mock-samples';

/** An app turned off for this chat, as the server says it when the switch can turn it back on. */
const TURNED_OFF_HERE = {
  state: 'unavailable',
  reason: 'off_for_this_chat',
  fix: { action: 'turn_on_for_this_chat', fixableBy: 'person' },
  copy: {
    owner: `${CONNECTION_READINESS_COPY.off_for_this_chat.owner} ${TURN_ON_FOR_THIS_CHAT_COPY.owner}`,
    agent: CONNECTION_READINESS_COPY.off_for_this_chat.agent,
  },
} as const;

/**
 * What a chat's side panel lists: one account usable, one turned off here, one
 * still applying. All three were given to the agent, so each has the switch.
 */
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
      thisChat: 'on',
    },
    {
      connectionId: 'conn-notion',
      toolkit: 'notion',
      label: 'Acme workspace',
      source: 'this_chat',
      operationRevisionIds: [],
      readiness: TURNED_OFF_HERE,
      thisChat: 'off',
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
      thisChat: 'on',
    },
  ],
} as unknown as ConnectorSessionConnections;

/** What each account's agent was given account-wide, which turning an inherited app back on puts back. */
const AGENT_ACTIONS: Record<string, string[]> = {
  'conn-gmail-personal': ['gmail-list-v1', 'gmail-read-v1'],
  'conn-notion': ['notion-search-v1'],
  'conn-drive': ['drive-list-v1'],
};

/** The chat side panel's accounts, answered by a playground server. */
function SessionFrame() {
  const [transport] = useState(() => {
    const base = createPlaygroundTransport();
    let current = MOCK_SESSION_CONNECTIONS;
    // A playground server for the per-chat switch: off reads as turned off
    // here; on goes back to the agent's own access (shown as usable).
    const setAccess = async (_sessionId: string, connectionId: string, { on }: { on: boolean }) => {
      current = {
        ...current,
        connections: current.connections.map((row) =>
          row.connectionId !== connectionId
            ? row
            : on
              ? {
                  ...row,
                  source: 'agent',
                  thisChat: 'on',
                  operationRevisionIds: AGENT_ACTIONS[connectionId] ?? [],
                  readiness: READY,
                }
              : {
                  ...row,
                  source: 'this_chat',
                  thisChat: 'off',
                  readiness: TURNED_OFF_HERE,
                }
        ),
      } as ConnectorSessionConnections;
      return current;
    };
    return new Proxy(base, {
      get: (target, prop, receiver) =>
        prop === 'getSessionConnectorConnections'
          ? async () => current
          : prop === 'setSessionConnectorAccess'
            ? setAccess
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
      description="A chat's side panel, for each account its agent was given: usable here, or the server's one line for why not, with the owner's switch to turn it on or off for this chat alone."
    >
      <ShowcaseDemo responsive>
        <SessionFrame />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
