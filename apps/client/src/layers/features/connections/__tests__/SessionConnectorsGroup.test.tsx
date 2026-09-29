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

  it('opens Connections for what the agent may do account-wide', async () => {
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
  });

  it('turns an app off for this chat and shows what the server says back', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [sessionConnection({ thisChat: 'on' })],
    });
    const turnedOff = {
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [
        sessionConnection({
          source: 'this_chat',
          thisChat: 'off',
          readiness: createMockConnectionReadiness({
            state: 'unavailable',
            reason: 'off_for_this_chat',
          }),
        }),
      ],
    };
    vi.mocked(transport.setSessionConnectorAccess).mockResolvedValue(turnedOff as never);
    renderGroup(transport);

    const toggle = await screen.findByRole('switch', { name: 'Gmail (work) in this chat' });
    expect(toggle).toBeChecked();
    expect(screen.getByText(/only affects this chat/)).toBeInTheDocument();
    // The refetch after the change reads the same server state.
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue(turnedOff as never);
    await user.click(toggle);

    expect(transport.setSessionConnectorAccess).toHaveBeenCalledWith('session-1', 'connection-1', {
      on: false,
    });
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Gmail (work) in this chat' })).not.toBeChecked()
    );
    expect(screen.getByText(CONNECTION_READINESS_COPY.off_for_this_chat.owner)).toBeInTheDocument();
  });

  it('keeps the server’s state and says so when a switch does not land', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [sessionConnection({ thisChat: 'on' })],
    });
    vi.mocked(transport.setSessionConnectorAccess).mockRejectedValue(new Error('offline'));
    renderGroup(transport);

    await user.click(await screen.findByRole('switch', { name: 'Gmail (work) in this chat' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing changed');
    expect(screen.getByRole('switch', { name: 'Gmail (work) in this chat' })).toBeChecked();
  });

  it('shows the switch as on from the server even while the app itself can’t be used', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [
        sessionConnection({
          thisChat: 'on',
          readiness: createMockConnectionReadiness({
            state: 'needs_you',
            reason: 'signed_out',
            fix: { action: 'sign_in_again', fixableBy: 'person' },
          }),
        }),
      ],
    });
    renderGroup(transport);

    // On for this chat is not the same as usable: the account is signed out.
    expect(await screen.findByRole('switch', { name: 'Gmail (work) in this chat' })).toBeChecked();
    expect(screen.getByText(CONNECTION_READINESS_COPY.signed_out.owner)).toBeInTheDocument();
  });

  it('says the server’s own words when a chat is limited for another agent', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [
        sessionConnection({
          source: 'this_chat',
          thisChat: 'off',
          readiness: createMockConnectionReadiness({
            state: 'unavailable',
            reason: 'off_for_this_chat',
            fix: { action: 'turn_on_for_this_chat', fixableBy: 'person' },
          }),
        }),
      ],
    });
    vi.mocked(transport.setSessionConnectorAccess).mockRejectedValue(
      Object.assign(new Error('You limited this app in this chat for another agent.'), {
        code: 'session_access_other_agent',
        status: 409,
      })
    );
    renderGroup(transport);

    await user.click(await screen.findByRole('switch', { name: 'Gmail (work) in this chat' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You limited this app in this chat for another agent.');
    expect(alert).not.toHaveTextContent('Try again');
    expect(screen.getByRole('switch', { name: 'Gmail (work) in this chat' })).not.toBeChecked();
  });

  it('drops a refused change’s error once the server’s view has no switch left', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [sessionConnection({ thisChat: 'on' })],
    });
    vi.mocked(transport.setSessionConnectorAccess).mockRejectedValue(
      Object.assign(new Error('Nothing to switch.'), { status: 404 })
    );
    renderGroup(transport);
    const toggle = await screen.findByRole('switch', { name: 'Gmail (work) in this chat' });
    // Meanwhile the agent lost the app account-wide: the refetch has no switch.
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [sessionConnection()],
    });
    await user.click(toggle);

    await waitFor(() => expect(screen.queryByRole('switch')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers no switch on an app the agent was not given account-wide', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getSessionConnectorConnections).mockResolvedValue({
      sessionId: 'session-1',
      agentId: 'agent-1',
      connections: [
        sessionConnection({
          source: 'this_chat',
          readiness: createMockConnectionReadiness({
            state: 'unavailable',
            reason: 'off_for_this_chat',
          }),
        }),
      ],
    });
    renderGroup(transport);

    expect(await screen.findByText('Gmail (work)')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/only affects this chat/)).not.toBeInTheDocument();
  });
});
