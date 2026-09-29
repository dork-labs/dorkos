/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockConnectionReadiness, createMockTransport } from '@dorkos/test-utils';
import { CONNECTION_READINESS_COPY } from '@dorkos/shared/connector-schemas';
import { TransportProvider } from '@/layers/shared/model';

import {
  AgentConnectionAccessList,
  SessionConnectionAccessList,
} from '../ui/ConnectionAccessLists';

afterEach(() => {
  cleanup();
});

describe('AgentConnectionAccessList', () => {
  it('reads canonical grants and shows the server’s readiness for each', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getAgentConnectorConnections).mockResolvedValue({
      agentId: 'agent-1',
      connections: [
        {
          connectionId: 'connection-1' as never,
          toolkit: 'gmail',
          label: 'work',
          lifecycle: 'connected',
          authenticationStatus: 'active',
          reconciliationStatus: 'ready',
          operationRevisionIds: ['operation-1'],
          everyAgent: false,
          authoritySync: { status: 'pending' },
          readiness: createMockConnectionReadiness({
            state: 'finishing',
            reason: 'access_updating',
            fix: { action: 'wait', fixableBy: 'dorkos' },
          }),
        },
      ],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>
          <AgentConnectionAccessList agentId="agent-1" />
        </TransportProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByText('Gmail (work)')).toBeInTheDocument();
    expect(screen.getByText('1 approved action')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toHaveAttribute(
      'title',
      CONNECTION_READINESS_COPY.access_updating.owner
    );
    expect(transport.getAgentConnectorConnections).toHaveBeenCalledWith('agent-1');
  });

  it('shows each app’s logo, asking the server for one the app has no bundled mark for', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getAgentConnectorConnections).mockResolvedValue({
      agentId: 'agent-1',
      connections: [
        {
          connectionId: 'connection-2' as never,
          toolkit: 'zendesk',
          label: 'support',
          lifecycle: 'connected',
          authenticationStatus: 'active',
          reconciliationStatus: 'ready',
          operationRevisionIds: ['operation-1'],
          everyAgent: false,
          authoritySync: { status: 'ready' },
          readiness: createMockConnectionReadiness(),
        },
      ],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { container } = render(
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>
          <AgentConnectionAccessList agentId="agent-1" />
        </TransportProvider>
      </QueryClientProvider>
    );

    await screen.findByText('Zendesk (support)');
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/api/connectors/catalog/logos/zendesk'
    );
  });
});

it('says a chat can’t use an account yet while its access is still updating', async () => {
  const transport = createMockTransport();
  vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
    sessionId: 'session-1',
    agentId: 'agent-1',
    connections: [
      {
        connectionId: 'connection-1' as never,
        toolkit: 'gmail',
        label: 'work',
        source: 'agent',
        operationRevisionIds: ['operation-1'],
        readiness: createMockConnectionReadiness({
          state: 'finishing',
          reason: 'access_updating',
          fix: { action: 'wait', fixableBy: 'dorkos' },
        }),
      },
    ],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <SessionConnectionAccessList sessionId="session-1" />
      </TransportProvider>
    </QueryClientProvider>
  );
  expect(await screen.findByText('Not available')).toBeInTheDocument();
  expect(screen.getByText(CONNECTION_READINESS_COPY.access_updating.owner)).toBeInTheDocument();
  expect(screen.queryByText(/actions available/)).not.toBeInTheDocument();
});
