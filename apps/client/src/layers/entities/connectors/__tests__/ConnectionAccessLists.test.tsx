/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { setPlatformAdapter } from '@/layers/shared/lib';
import {
  AgentConnectionAccessList,
  SessionConnectionAccessList,
} from '../ui/ConnectionAccessLists';

afterEach(() => {
  cleanup();
  setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
});

describe('AgentConnectionAccessList', () => {
  it('explains embedded unavailability without claiming the agent has no access', async () => {
    setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
    const transport = createMockTransport({
      getAgentConnectorConnections: vi
        .fn()
        .mockRejectedValue(new Error('Connections can only be managed in DorkOS itself.')),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>
          <AgentConnectionAccessList agentId="agent-1" />
        </TransportProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByText('Account access is unavailable here')).toBeInTheDocument();
    expect(screen.getByText(/Open DorkOS in your browser to connect services/)).toBeInTheDocument();
    expect(screen.queryByText('No account access')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('reads canonical grants and keeps pending authority unavailable', async () => {
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
          authoritySync: { status: 'pending' },
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
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(transport.getAgentConnectorConnections).toHaveBeenCalledWith('agent-1');
  });
});

it('explains disabled session access while hosted authority is still updating', async () => {
  const transport = createMockTransport();
  vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
    sessionId: 'session-1',
    agentId: 'agent-1',
    connections: [
      {
        connectionId: 'connection-1' as never,
        toolkit: 'gmail',
        label: 'work',
        access: 'disabled',
        operationRevisionIds: ['operation-1'],
        dominatingReason: 'authority_sync_required',
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
  expect(await screen.findByText('Disabled in this session')).toBeInTheDocument();
  expect(screen.getByText('Account access has not finished updating.')).toBeInTheDocument();
  expect(screen.queryByText(/actions available/)).not.toBeInTheDocument();
});
