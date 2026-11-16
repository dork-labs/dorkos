import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type {
  ConnectorAgentRequestItem,
  ConnectorReconciliationApplyRequest,
} from '@dorkos/shared/connector-schemas';
import {
  AgentRequestCard,
  ConnectionAccessCard,
  ConnectionAccessDialog,
} from '@/layers/features/connections';
import { TransportProvider } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import {
  READ_ONLY_ACCESS_PREVIEW,
  READ_ONLY_AGENT_REQUEST,
  READ_ONLY_CONNECTION,
} from '../mock-samples';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** Only scripted responses: these demos never read or change a real connection. */
function readOnlyTransport(): Transport {
  const overrides: Partial<Transport> = {
    getConnectorConnections: async () => ({ connections: [READ_ONLY_CONNECTION] }),
    listMeshAgents: async () => ({ agents: [] }),
    getConnectorCatalog: async () => ({ services: [], warnings: [] }),
    previewConnectorReconciliation: async () => structuredClone(READ_ONLY_ACCESS_PREVIEW),
    applyConnectorReconciliation: async (request: ConnectorReconciliationApplyRequest) => ({
      connectionId: READ_ONLY_CONNECTION.connectionId,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: request.grants,
      ...(request.everyAgent && { everyAgent: request.everyAgent }),
    }),
    resolveConnectorAgentRequest: async (
      _requestId,
      decision
    ): Promise<ConnectorAgentRequestItem> => {
      if (decision.decision === 'denied') return { ...READ_ONLY_AGENT_REQUEST, status: 'denied' };
      return {
        ...READ_ONLY_AGENT_REQUEST,
        status: 'granted',
        connectionId: READ_ONLY_CONNECTION.connectionId,
        grantedOperationRevisionIds: ['linear-read'],
        grantedEvents: [],
        notGranted: ['write'],
      };
    },
  };
  return new Proxy(createPlaygroundTransport(), {
    get: (target, prop, receiver) =>
      prop in overrides ? Reflect.get(overrides, prop) : Reflect.get(target, prop, receiver),
  });
}

function ReadOnlyDemo({ children }: { children: ReactNode }) {
  const [transport] = useState(readOnlyTransport);
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Infinity },
          mutations: { retry: false },
        },
      })
  );
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Page mode with the Read-only explanation and Scout's saved access. */
export function ReadOnlyPageDemo() {
  return (
    <ReadOnlyDemo>
      <div className="max-w-md">
        <ConnectionAccessCard mode="page" connectionId="linear-read-only" serviceName="Linear" />
      </div>
    </ReadOnlyDemo>
  );
}

function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <ReadOnlyDemo>
      <Button onClick={() => setOpen(true)}>Choose Scout’s access</Button>
      <ConnectionAccessDialog connectionId="linear-read-only" open={open} onOpenChange={setOpen} />
    </ReadOnlyDemo>
  );
}

/** The real dialog, opened on demand so its chrome never covers neighboring demos. */
export function ReadOnlyAccessDialogShowcase() {
  return (
    <PlaygroundSection
      title="ConnectionAccessDialog"
      description="Linear offers Read only. Open the dialog to see the disabled write level and its explanation."
    >
      <ShowcaseDemo responsive>
        <DialogDemo />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** The real request card before answering Scout's request for writes. */
export function ReadOnlyAgentRequestShowcase() {
  return (
    <PlaygroundSection
      title="Read-only agent request"
      description="Scout asks to change Linear, but the app has no change actions. Allow clearly gives Read only."
    >
      <ShowcaseDemo responsive>
        <ReadOnlyDemo>
          <AgentRequestCard request={READ_ONLY_AGENT_REQUEST} />
        </ReadOnlyDemo>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
