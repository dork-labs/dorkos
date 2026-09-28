/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport, createMockConnectionReadiness } from '@dorkos/test-utils';
import { CONNECTION_READINESS_COPY } from '@dorkos/shared/connector-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { registerComposerInsert } from '@/layers/shared/lib';
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
    source: 'agent' as const,
    operationRevisionIds: ['read-v1'],
    readiness: createMockConnectionReadiness(),
    ...over,
  };
}

describe('SessionConnectorsGroup', () => {
  it('keeps the empty session group useful and prefills the intended session composer', async () => {
    const user = userEvent.setup();
    const insert = vi.fn();
    const unregister = registerComposerInsert(insert);
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
    expect(await screen.findByTestId('session-connectors')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ask your agent' }));
    expect(insert).toHaveBeenCalledWith(
      'I need access to another service. Ask me which service and actions you need, then request only that access.'
    );
    expect(screen.getByTestId('ask-agent-for-connection-session-1')).toBeInTheDocument();
    unregister();
  });

  it('keeps inherited and chat-only access distinct, and says why an account can’t be used here', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [
        sessionConnection(),
        sessionConnection({
          connectionId: 'connection-2',
          label: 'personal',
          source: 'this_chat',
        }),
        sessionConnection({
          connectionId: 'connection-3',
          label: 'archive',
          readiness: createMockConnectionReadiness({
            state: 'paused',
            reason: 'paused',
            fix: { action: 'resume', fixableBy: 'person' },
          }),
        }),
        sessionConnection({
          connectionId: 'connection-4',
          label: 'chat',
          source: 'this_chat',
          readiness: createMockConnectionReadiness({
            state: 'unavailable',
            reason: 'off_for_this_chat',
          }),
        }),
      ],
    });
    renderGroup(transport);
    expect(await screen.findByText('Inherited from agent')).toBeInTheDocument();
    expect(screen.getByText('Allowed only in this session')).toBeInTheDocument();
    expect(screen.getAllByText('Not available')).toHaveLength(2);
    // Each unusable account says the server's own line for why.
    expect(screen.getByText(CONNECTION_READINESS_COPY.paused.owner)).toBeInTheDocument();
    expect(screen.getByText(CONNECTION_READINESS_COPY.off_for_this_chat.owner)).toBeInTheDocument();
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
