/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { SessionConnectorsGroup } from '../ui/SessionConnectorsGroup';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
afterEach(cleanup);

function renderGroup(transport: Transport) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <SessionConnectorsGroup sessionId="session-1" />
      </TransportProvider>
    </QueryClientProvider>
  );
}

function sessionConnection(over: Record<string, unknown> = {}) {
  return {
    connectionId: 'connection-1' as never,
    toolkit: 'gmail',
    label: 'work',
    access: 'inherited' as const,
    operationRevisionIds: ['read-v1'],
    dominatingReason: 'none' as const,
    ...over,
  };
}

describe('SessionConnectorsGroup', () => {
  it('renders nothing when the canonical session has no connection access', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [],
    });
    renderGroup(transport);
    await waitFor(() =>
      expect(transport.getSessionConnectorConnections).toHaveBeenCalledWith('session-1')
    );
    expect(screen.queryByTestId('session-connectors')).not.toBeInTheDocument();
  });

  it('keeps inherited, session-only, and disabled access distinct with a dominating reason', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [
        sessionConnection(),
        sessionConnection({
          connectionId: 'connection-2',
          label: 'personal',
          access: 'session_only',
        }),
        sessionConnection({
          connectionId: 'connection-3',
          label: 'archive',
          access: 'disabled',
          dominatingReason: 'connection_paused',
        }),
      ],
    });
    renderGroup(transport);
    expect(await screen.findByText('Inherited from agent')).toBeInTheDocument();
    expect(screen.getByText('Allowed only in this session')).toBeInTheDocument();
    expect(screen.getByText('Disabled in this session')).toBeInTheDocument();
    expect(screen.getByText('The account is paused.')).toBeInTheDocument();
  });

  it('opens the canonical owner workspace without attach or detach controls', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [sessionConnection()],
    });
    renderGroup(transport);
    await user.click(await screen.findByRole('button', { name: /Manage agent access/i }));
    expect(navigate).toHaveBeenCalledWith({ to: '/connections' });
    expect(screen.queryByRole('button', { name: /attach|detach/i })).not.toBeInTheDocument();
  });
});
