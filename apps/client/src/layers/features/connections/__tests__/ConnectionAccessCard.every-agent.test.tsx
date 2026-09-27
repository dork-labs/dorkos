/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  ConnectionAccessCard,
  type ConnectionAccessCardProps,
} from '../ui/access/ConnectionAccessCard';

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

function preview(
  everyAgent: ConnectorReconciliationPreview['everyAgent'] = {
    available: true,
    operationRevisionIds: [],
  },
  currentGrants: ConnectorReconciliationPreview['currentGrants'] = []
): ConnectorReconciliationPreview {
  return {
    previewId: 'preview-1',
    connection: {
      connectionId: 'connection-1' as never,
      toolkit: 'gmail',
      label: 'work',
      status: 'active',
      custody: 'external',
      reconciliationStatus: 'ready',
    },
    candidates: [
      candidate('read-v1', 'read'),
      candidate('send-v1', 'write'),
      candidate('delete-v1', 'destructive'),
    ],
    agents: [
      { agentId: 'agent-ada', displayName: 'Ada' },
      { agentId: 'agent-bo', displayName: 'Bo' },
    ],
    currentGrants,
    everyAgent,
    catalogComplete: true,
    createdAt: '2026-09-06T00:00:00.000Z',
    expiresAt: '2099-09-06T01:00:00.000Z',
  };
}

function applied(everyAgent?: { operationRevisionIds: string[] }) {
  return {
    connectionId: 'connection-1' as never,
    reconciliationStatus: 'ready' as const,
    authoritySync: { status: 'ready' as const },
    grants: [],
    ...(everyAgent && { everyAgent }),
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

const PAGE = { mode: 'page', connectionId: 'connection-1', serviceName: 'Gmail' } as const;

describe('ConnectionAccessCard — every agent (DOR-2420)', () => {
  it('shares read with every agent: no checklist, no warning, exact payload, truthful summary', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue(
      applied({ operationRevisionIds: ['read-v1'] })
    );
    renderCard(transport, PAGE);

    expect(await screen.findByRole('radio', { name: 'Only agents I pick' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Ada' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Every agent/ }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByTestId('every-agent-warning')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-1',
        grants: [],
        everyAgent: { operationRevisionIds: ['read-v1'] },
      })
    );
    expect(await screen.findByText('Every agent can read Gmail.')).toBeInTheDocument();
  });

  it('warns once, in plain words, when every agent could write, and leaves named agents alone', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    // Ada already reads by name; choosing every agent must not rewrite her.
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview(undefined, [{ agentId: 'agent-ada', operationRevisionIds: ['read-v1'] }])
    );
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue(
      applied({ operationRevisionIds: ['read-v1', 'send-v1'] })
    );
    renderCard(transport, PAGE);

    await user.click(await screen.findByRole('radio', { name: /Every agent/ }));
    await user.click(screen.getByRole('radio', { name: 'Read and write' }));
    expect(screen.getByTestId('every-agent-warning')).toHaveTextContent(
      'Every agent — including ones you add later — could send email as you.'
    );
    // Only for every agent: picking agents one by one never shows it.
    await user.click(screen.getByRole('radio', { name: 'Only agents I pick' }));
    expect(screen.queryByTestId('every-agent-warning')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Every agent/ }));

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-1',
        grants: [],
        everyAgent: { operationRevisionIds: ['read-v1', 'send-v1'] },
      })
    );
    expect(await screen.findByText('Every agent can read and write in Gmail.')).toBeInTheDocument();
  });

  it('starts on "Every agent" when shared, and stops sharing when switched back', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview({ available: true, operationRevisionIds: ['read-v1', 'send-v1'] })
    );
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue(
      applied({ operationRevisionIds: [] })
    );
    renderCard(transport, PAGE);

    expect(await screen.findByRole('radio', { name: /Every agent/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Read and write' })).toBeChecked();
    // Nothing changed yet, so nothing to save.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Only agents I pick' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-1',
        grants: [],
        everyAgent: { operationRevisionIds: [] },
      })
    );
    expect(
      await screen.findByText('No agent can use Gmail. Gmail is no longer shared with every agent.')
    ).toBeInTheDocument();
  });

  it('never reports success when the server did not save the every-agent set that was sent', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue(applied());
    renderCard(transport, PAGE);

    await user.click(await screen.findByRole('radio', { name: /Every agent/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/couldn’t confirm that access was saved/i)).toBeInTheDocument();
  });

  it('explains, and never offers, "Every agent" where it is unavailable', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview({ available: false, operationRevisionIds: [] })
    );
    renderCard(transport, PAGE);

    const every = await screen.findByRole('radio', { name: /Every agent/ });
    expect(every).toBeDisabled();
    expect(
      screen.getByText(/Not available yet for apps connected through your DorkOS account/)
    ).toBeInTheDocument();
    await user.click(every);
    expect(screen.getByRole('radio', { name: 'Only agents I pick' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('never offers "Every agent" when answering for one agent in chat', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    // Shared with every agent at Read and write; the chat answer is still about Ada alone.
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview({ available: true, operationRevisionIds: ['read-v1', 'send-v1'] })
    );
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      ...applied(),
      grants: [{ agentId: 'agent-ada', operationRevisionIds: ['read-v1'] }],
    });
    renderCard(transport, {
      mode: 'agent',
      agentId: 'agent-ada',
      toolkit: 'gmail',
      connectionId: 'connection-1',
      serviceName: 'Gmail',
    });

    const allow = await screen.findByRole('button', { name: 'Allow' });
    expect(screen.queryByRole('radio', { name: /Every agent/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Only agents I pick' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('every-agent-warning')).not.toBeInTheDocument();
    await user.click(allow);
    // Ada's own answer starts at Read, not at what every agent holds, and never sends everyAgent.
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-1',
        grants: [{ agentId: 'agent-ada', operationRevisionIds: ['read-v1'] }],
      })
    );
  });

  it('can still stop sharing when the current access cannot load', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockRejectedValue(new Error('down'));
    vi.mocked(transport.getConnectorConnection).mockResolvedValue({
      connection: {
        everyAgent: { operationRevisionIds: ['read-v1'], classifications: ['read'] },
      },
    } as never);
    vi.mocked(transport.stopSharingConnectorWithEveryAgent).mockResolvedValue({
      connectionId: 'connection-1' as never,
      revokedCount: 1,
    });
    renderCard(transport, PAGE);

    await user.click(await screen.findByRole('button', { name: 'Stop sharing with every agent' }));
    expect(transport.stopSharingConnectorWithEveryAgent).toHaveBeenCalledWith('connection-1');
    expect(
      await screen.findByText('Gmail is no longer shared with every agent.')
    ).toBeInTheDocument();
  });

  it('shows exact shared actions as they are: no level, the plain line, and the write warning', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview({ available: true, operationRevisionIds: ['read-v1', 'send-v1', 'delete-v1'] })
    );
    renderCard(transport, PAGE);

    expect(await screen.findByRole('radio', { name: /Every agent/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Read' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Read and write' })).not.toBeChecked();
    expect(
      screen.getByText('Every agent has exact actions chosen now. Pick a level to replace them.')
    ).toBeInTheDocument();
    // The shared set includes delete, so the warning says so.
    expect(screen.getByTestId('every-agent-warning')).toHaveTextContent(
      'Every agent — including ones you add later — could send and delete email as you.'
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses to call a pending every-agent save done when the saved set reads back different', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      ...applied({ operationRevisionIds: ['read-v1'] }),
      authoritySync: { status: 'pending' },
    });
    // Reading back: nothing is shared with every agent after all.
    vi.mocked(transport.getConnectorConnection).mockResolvedValue({
      connection: {
        connectionId: 'connection-1',
        reconciliationStatus: 'ready',
        authoritySync: { status: 'ready' },
        everyAgent: null,
      },
      agents: [],
    } as never);
    renderCard(transport, PAGE);

    await user.click(await screen.findByRole('radio', { name: /Every agent/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Check sync status' }));
    expect(await screen.findByText(/couldn’t confirm that access was saved/i)).toBeInTheDocument();
    expect(screen.queryByText('Access updated')).not.toBeInTheDocument();
  });
});
