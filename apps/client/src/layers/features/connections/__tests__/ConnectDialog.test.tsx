/** @vitest-environment jsdom */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ConnectDialog } from '../ui/ConnectDialog';

afterEach(cleanup);

const capabilities = {
  catalog: { status: 'available' as const },
  authentication: { status: 'available' as const },
  accounts: { status: 'available' as const },
  operations: { status: 'available' as const },
  execution: { status: 'available' as const },
  triggers: { status: 'unsupported' as const, reason: 'Events arrive in a later release.' },
};

const gmail: ConnectorCatalogService = {
  serviceSlug: 'gmail',
  displayName: 'Gmail',
  iconKey: 'gmail',
  intents: [
    {
      kind: 'account',
      displayName: 'Use a Gmail account',
      routes: [
        {
          providerInstanceId: 'byo-1' as never,
          displayName: 'My provider',
          mode: 'byo',
          custody: 'self-host',
          payer: 'operator_byo',
          capabilities,
          disclosure: 'Your account stores login access.',
          authKind: 'oauth2',
        },
        {
          providerInstanceId: 'managed-1' as never,
          displayName: 'DorkOS managed',
          mode: 'managed',
          custody: 'managed',
          payer: 'dorkos_managed',
          capabilities,
          disclosure: 'DorkOS stores login access with its provider.',
          authKind: 'oauth2',
        },
        {
          providerInstanceId: 'offline-1' as never,
          displayName: 'Unavailable provider',
          mode: 'byo',
          custody: 'external',
          payer: 'operator_byo',
          capabilities: {
            ...capabilities,
            authentication: { status: 'unsupported', reason: 'Provider is not configured.' },
          },
          disclosure: 'This provider would keep login access.',
          authKind: 'oauth2',
        },
      ],
    },
  ],
};

function renderDialog(transport = createMockTransport(), service = gmail) {
  const chooseAccess = vi.fn();
  function Host() {
    const [flowId, setFlowId] = useState<string | null>(null);
    return (
      <ConnectDialog
        service={service}
        flowId={flowId}
        onFlowIdChange={setFlowId}
        onClose={() => undefined}
        onChooseAccess={chooseAccess}
      />
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <Host />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, chooseAccess };
}

describe('ConnectDialog', () => {
  it('defaults to an available managed route, discloses custody, then waits for explicit agent access', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorAuthentication).mockResolvedValue({
      flowId: 'flow-1',
      providerInstanceId: 'managed-1' as never,
      toolkit: 'gmail',
      state: 'pending',
      authorizeUrl: 'https://provider.example/auth',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2026-09-06T01:00:00.000Z',
    });
    vi.mocked(transport.pollConnectorAuthentication).mockResolvedValue({
      flowId: 'flow-1',
      providerInstanceId: 'managed-1' as never,
      toolkit: 'gmail',
      state: 'connected',
      connectionId: 'connection-1' as never,
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2026-09-06T01:00:00.000Z',
      completedAt: '2026-09-06T00:01:00.000Z',
    });
    const { chooseAccess } = renderDialog(transport);

    expect(screen.getByTestId('connect-disclosure')).toHaveTextContent(
      'DorkOS stores login access'
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(transport.startConnectorAuthentication).toHaveBeenCalledWith(
        expect.objectContaining({ providerInstanceId: 'managed-1', toolkit: 'gmail' })
      )
    );
    expect(await screen.findByText('Gmail is connected')).toBeInTheDocument();
    expect(screen.getByText(/No agent can use it/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Choose agents/i }));
    expect(chooseAccess).toHaveBeenCalledWith('connection-1');
  });

  it('preserves an explicit provider choice and never starts an unavailable route', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.startConnectorAuthentication).mockReturnValue(new Promise(() => undefined));
    renderDialog(transport);

    await user.click(screen.getByRole('button', { name: 'Change setup' }));
    expect(screen.getByRole('button', { name: /Unavailable provider/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /My provider/i }));
    expect(screen.getByTestId('connect-disclosure')).toHaveTextContent('Your account stores');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(transport.startConnectorAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({ providerInstanceId: 'byo-1' })
    );
  });

  it('keeps custody visible beside a pending provider sign-in', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    const pending = {
      flowId: 'flow-1',
      providerInstanceId: 'managed-1' as never,
      toolkit: 'gmail',
      state: 'pending' as const,
      authorizeUrl: 'https://provider.example/auth',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2026-09-06T01:00:00.000Z',
    };
    vi.mocked(transport.startConnectorAuthentication).mockResolvedValue(pending);
    vi.mocked(transport.pollConnectorAuthentication).mockResolvedValue(pending);
    renderDialog(transport);

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('link', { name: 'Open sign-in' })).toBeInTheDocument();
    expect(screen.getByTestId('connect-disclosure')).toHaveTextContent(
      'DorkOS stores login access'
    );
  });
});
