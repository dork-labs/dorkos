/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ConnectionAccessCard } from '../ui/access/ConnectionAccessCard';
import { ConnectionAccessDialog } from '../ui/access/ConnectionAccessDialog';

afterEach(cleanup);

function preview(hasWrites = false): ConnectorReconciliationPreview {
  return {
    previewId: 'preview-1',
    connection: {
      connectionId: 'connection-1' as never,
      toolkit: 'linear',
      label: 'Work account',
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
    candidates: [
      ...(['read', 'write', 'destructive'] as const).map((classification) => ({
        operationRevisionId: classification,
        toolkit: 'linear',
        operationSlug: `linear.${classification}`,
        toolkitVersion: '1',
        capabilityClassification: classification,
        retryPolicy: 'never' as const,
        inputSchema: {},
        supported: classification !== 'write' || hasWrites,
      })),
      {
        operationRevisionId: 'paid-write',
        toolkit: 'apify',
        operationSlug: 'apify.run',
        toolkitVersion: '1',
        capabilityClassification: 'write',
        retryPolicy: 'never' as const,
        inputSchema: {},
        supported: true,
      },
    ],
    agents: [{ agentId: 'scout', displayName: 'Scout' }],
    currentGrants: [],
    everyAgent: { available: true, operationRevisionIds: [] },
    catalogComplete: true,
    createdAt: '2026-11-15T00:00:00.000Z',
    expiresAt: '2099-11-15T00:00:00.000Z',
  };
}

function renderWith(snapshot: ConnectorReconciliationPreview, ui: ReactNode) {
  const transport = createMockTransport();
  vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(snapshot);
  vi.mocked(transport.applyConnectorReconciliation).mockImplementation(async (input) => ({
    connectionId: snapshot.connection.connectionId,
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    grants: input.grants,
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

const readOnlyCopy = 'Only Read is available for Linear. DorkOS can’t make changes there yet.';

describe('access for an app with no write actions', () => {
  it('shows Read and its explanation in the panel, then saves Read', async () => {
    const user = userEvent.setup();
    const transport = renderWith(
      preview(),
      <ConnectionAccessCard mode="page" connectionId="connection-1" serviceName="Linear" />
    );
    expect(await screen.findByText(readOnlyCopy)).toHaveClass('text-muted-foreground', 'text-xs');
    expect(screen.queryByRole('radio', { name: 'Read and write' })).not.toBeInTheDocument();
    expect(screen.getByText('Read', { exact: true })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Scout' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-1',
        grants: [{ agentId: 'scout', operationRevisionIds: ['read'], level: 'read' }],
      })
    );
  });

  it('shows Read in the per-agent row even when the stored level is Read and write', async () => {
    const snapshot = preview();
    snapshot.currentGrants = [
      { agentId: 'scout', operationRevisionIds: ['read'], level: 'read-write' },
    ];
    renderWith(
      snapshot,
      <ConnectionAccessCard mode="page" connectionId="connection-1" serviceName="Linear" />
    );
    expect(await screen.findByLabelText('Now: Read')).toBeInTheDocument();
    expect(screen.queryByLabelText('Now: Read and write')).not.toBeInTheDocument();
  });

  it('keeps shared exact actions distinct from a Read level when no write level exists', async () => {
    const snapshot = preview();
    snapshot.everyAgent.operationRevisionIds = ['read', 'destructive'];
    renderWith(
      snapshot,
      <ConnectionAccessCard mode="page" connectionId="connection-1" serviceName="Linear" />
    );
    expect(
      await screen.findByText('Every agent has exact actions now. Pick a level to replace them.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it.each(['read', 'read-write'] as const)(
    'opens a saved %s grant on Read and disables Read + write with an explanation',
    async (level) => {
      const user = userEvent.setup();
      const snapshot = preview();
      snapshot.currentGrants = [{ agentId: 'scout', operationRevisionIds: ['read'], level }];
      const transport = renderWith(
        snapshot,
        <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
      );
      const scout = await screen.findByRole('group', { name: 'Access for Scout' });
      const write = within(scout).getByRole('button', { name: 'Read + write' });
      expect(write).toBeDisabled();
      expect(write).toHaveAttribute('aria-disabled', 'true');
      expect(write).toHaveAccessibleDescription('Not available for Linear yet.');
      expect(within(scout).getByText('Not available for Linear yet.')).toBeVisible();
      expect(within(scout).getByRole('button', { name: 'Read' })).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await user.click(write);
      await user.click(within(scout).getByRole('button', { name: 'No access' }));
      await user.click(within(scout).getByRole('button', { name: 'Read' }));
      if (level === 'read') {
        expect(screen.getByRole('button', { name: 'Save access' })).toBeDisabled();
        expect(transport.applyConnectorReconciliation).not.toHaveBeenCalled();
      } else {
        await user.click(screen.getByRole('button', { name: 'Save access' }));
        await waitFor(() =>
          expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
            previewId: 'preview-1',
            grants: [{ agentId: 'scout', operationRevisionIds: ['read'], level: 'read' }],
          })
        );
      }
    }
  );

  it('saves the selected Read level from the dialog for a new grant', async () => {
    const user = userEvent.setup();
    const transport = renderWith(
      preview(),
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );
    const scout = await screen.findByRole('group', { name: 'Access for Scout' });
    await user.click(within(scout).getByRole('button', { name: 'Read' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-1',
        grants: [{ agentId: 'scout', operationRevisionIds: ['read'], level: 'read' }],
      })
    );
  });

  it('keeps saved Read selected when writes exist, then saves Read + write when picked', async () => {
    const user = userEvent.setup();
    const snapshot = preview(true);
    snapshot.currentGrants = [{ agentId: 'scout', operationRevisionIds: ['read'], level: 'read' }];
    const transport = renderWith(
      snapshot,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );
    const scout = await screen.findByRole('group', { name: 'Access for Scout' });
    expect(within(scout).getByRole('button', { name: 'Read' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const write = within(scout).getByRole('button', { name: 'Read + write' });
    expect(write).toBeEnabled();
    expect(screen.queryByText('Not available for Linear yet.')).not.toBeInTheDocument();
    await user.click(write);
    expect(write).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Save access' }));
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-1',
        grants: [
          { agentId: 'scout', operationRevisionIds: ['read', 'write'], level: 'read-write' },
        ],
      })
    );
    expect(await screen.findByTestId('connector-access-outcome')).toHaveTextContent(
      'Access updated'
    );
  });

  it('offers Read and write without the explanation when write actions exist', async () => {
    const user = userEvent.setup();
    const transport = renderWith(
      preview(true),
      <ConnectionAccessCard mode="page" connectionId="connection-1" serviceName="Linear" />
    );
    const write = await screen.findByRole('radio', { name: 'Read and write' });
    expect(write).toBeEnabled();
    expect(screen.queryByText(readOnlyCopy)).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Scout' }));
    await user.click(write);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-1',
        grants: [
          { agentId: 'scout', operationRevisionIds: ['read', 'write'], level: 'read-write' },
        ],
      })
    );
  });
});
