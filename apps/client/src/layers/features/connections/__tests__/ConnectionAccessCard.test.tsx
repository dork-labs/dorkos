/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ConnectionAccessCard, type ConnectionAccessCardProps } from '../ui/ConnectionAccessCard';

afterEach(cleanup);

function candidate(id: string, classification: 'read' | 'write' | 'destructive') {
  return {
    operationRevisionId: id,
    toolkit: 'gmail',
    operationSlug: `gmail.${id}`,
    toolkitVersion: '1',
    capabilityClassification: classification,
    retryPolicy: 'never' as const,
    inputSchema: {},
    supported: true,
  };
}

const AGENTS = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus'].map((name) => ({
  agentId: `agent-${name.toLowerCase()}`,
  displayName: name,
}));

function preview(
  currentGrants: ConnectorReconciliationPreview['currentGrants'] = [],
  connectionId = 'connection-1'
): ConnectorReconciliationPreview {
  return {
    previewId: `preview-${connectionId}`,
    connection: {
      connectionId: connectionId as never,
      toolkit: 'gmail',
      label: connectionId === 'connection-2' ? 'personal' : 'work',
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
    candidates: [
      candidate('read-v1', 'read'),
      candidate('send-v1', 'write'),
      candidate('delete-v1', 'destructive'),
    ],
    agents: AGENTS,
    currentGrants,
    catalogComplete: true,
    createdAt: '2026-09-06T00:00:00.000Z',
    expiresAt: '2099-09-06T01:00:00.000Z',
  };
}

function account(connectionId: string, label: string): ConnectorConnectionSummary {
  return {
    connectionId: connectionId as never,
    providerInstanceId: 'managed-1' as never,
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
    agentCount: 0,
    subscriptionCount: 0,
    usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
    warnings: [],
  };
}

function renderCard(transport: Transport, props: ConnectionAccessCardProps) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <ConnectionAccessCard {...props} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('ConnectionAccessCard — page mode', () => {
  it('lists the most relevant agents first and saves only the picked agent at the chosen preset', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-gus', operationRevisionIds: ['read-v1'] }])
    );
    vi.mocked(transport.listMeshAgents).mockResolvedValue({
      agents: [{ id: 'agent-flo', isSystem: true }],
    } as never);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1', 'send-v1'] }],
    });
    const onFinished = vi.fn();
    renderCard(transport, {
      mode: 'page',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onFinished,
      onSkip: vi.fn(),
    });

    expect(await screen.findByRole('heading', { name: 'Who can use Gmail?' })).toBeInTheDocument();
    // Gus already has access, Flo is a system agent; five show before "Show all".
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox').map((box) => box.id.split('-').at(-1))).toEqual([
        'gus',
        'flo',
        'ada',
        'bo',
        'cy',
      ])
    );
    expect(screen.getByRole('checkbox', { name: 'Gus' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(7);

    await user.click(screen.getByRole('checkbox', { name: 'Bo' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-connection-1',
        grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1'] }],
      })
    );
    // The server answered with different grants than were sent: never success.
    expect(await screen.findByText(/couldn’t confirm that access was saved/i)).toBeInTheDocument();
    expect(screen.queryByText('Access updated')).not.toBeInTheDocument();
  });

  it('upgrades picked agents when the level changes and reports the confirmed result', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-ada', operationRevisionIds: ['read-v1', 'send-v1'] }],
    });
    const onFinished = vi.fn();
    renderCard(transport, {
      mode: 'page',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onFinished,
    });

    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Ada' }));
    await user.click(screen.getByRole('radio', { name: 'Read and write' }));
    await user.click(save);

    expect(await screen.findByTestId('connector-access-outcome')).toHaveTextContent(
      'Access updated'
    );
    expect(screen.getByText('Ada can use Gmail.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending sync unusable until an explicit check, without repeating the write', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-1' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'pending' },
      grants: [{ agentId: 'agent-ada', operationRevisionIds: ['read-v1'] }],
    });
    vi.mocked(transport.getConnectorConnection).mockRejectedValue(new Error('offline'));
    renderCard(transport, { mode: 'page', connectionId: 'connection-1', serviceName: 'Gmail' });

    await user.click(await screen.findByRole('checkbox', { name: 'Ada' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('connector-access-outcome')).toHaveTextContent(
      'Access update pending'
    );
    await user.click(screen.getByRole('button', { name: 'Check sync status' }));
    expect(await screen.findByText(/The access change was not repeated/)).toBeInTheDocument();
    expect(screen.queryByText('Access updated')).not.toBeInTheDocument();
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
  });

  it('opens the exact action editor for this account', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    const onEditExactActions = vi.fn();
    renderCard(transport, {
      mode: 'page',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
      onEditExactActions,
    });
    await user.click(await screen.findByRole('button', { name: 'Choose exact actions' }));
    expect(onEditExactActions).toHaveBeenCalledWith('connection-1');
  });
});

describe('ConnectionAccessCard — one agent', () => {
  it('asks which account first when two are connected, then grants only that agent', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnections).mockResolvedValue({
      connections: [account('connection-1', 'work'), account('connection-2', 'personal')],
    });
    vi.mocked(transport.previewConnectorReconciliation).mockImplementation(
      async ({ connectionId }) => preview([], connectionId)
    );
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: 'connection-2' as never,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1', 'send-v1'] }],
    });
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      serviceName: 'Gmail',
      onSkip: vi.fn(),
    });

    expect(
      await screen.findByRole('heading', { name: 'Which Gmail account?' })
    ).toBeInTheDocument();
    expect(transport.previewConnectorReconciliation).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('radio', { name: /personal/ }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Let Bo use Gmail?' })).toBeInTheDocument();
    expect(transport.previewConnectorReconciliation).toHaveBeenCalledWith({
      connectionId: 'connection-2',
    });
    expect(screen.queryByRole('button', { name: /Allow once/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Read and write' }));
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-connection-2',
        grants: [{ agentId: 'agent-bo', operationRevisionIds: ['read-v1', 'send-v1'] }],
      })
    );
    expect(await screen.findByText('Bo can read and write in Gmail.')).toBeInTheDocument();
  });

  it('goes straight to the question with one account and never overwrites exact actions', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnections).mockResolvedValue({
      connections: [account('connection-1', 'work')],
    });
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview([{ agentId: 'agent-bo', operationRevisionIds: ['read-v1', 'delete-v1'] }])
    );
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      serviceName: 'Gmail',
    });

    expect(await screen.findByText(/already has exact actions chosen/)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
  });

  it('says so when the app has no connected account', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorConnections).mockResolvedValue({ connections: [] });
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-bo',
      toolkit: 'gmail',
      serviceName: 'Gmail',
    });
    expect(await screen.findByText('No Gmail account is connected yet.')).toBeInTheDocument();
  });
});
