/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CONNECTION_READINESS_COPY } from '@dorkos/shared/connector-schemas';
import {
  createMockConnectionReadiness,
  createMockTransport,
} from '@dorkos/test-utils/mock-factories';
import { mockConnection } from '@/dev/mock-samples';
import { ConnectionAccessDialog } from '../../ui/access/ConnectionAccessDialog';

afterEach(cleanup);
import { PREVIEW, renderWith } from './fixtures';

afterEach(cleanup);

describe('ConnectionAccessDialog', () => {
  it('says what every agent also has when the account is shared with every agent', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue({
      ...PREVIEW,
      everyAgent: { available: true, operationRevisionIds: ['read-v1', 'write-v2'] },
    });
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );
    const line = await screen.findByTestId('exact-editor-every-agent');
    expect(line).toHaveTextContent('Every agent, even future ones, also has 2 actions here.');
    expect(line).toHaveTextContent('stop sharing with every agent');
  });

  it.each([
    ['needs_review', CONNECTION_READINESS_COPY.needs_review.owner],
    ['access_update_failed', CONNECTION_READINESS_COPY.access_update_failed.owner],
  ] as const)(
    'confirms the access as it stands without an edit when the account is %s, naming why',
    async (reason, words) => {
      const user = userEvent.setup();
      const transport = createMockTransport();
      vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
      vi.mocked(transport.getConnectorConnections).mockResolvedValue({
        connections: [
          mockConnection({
            connectionId: 'connection-1' as never,
            readiness: createMockConnectionReadiness({
              state: 'needs_you',
              reason,
              fix: { action: 'review_access', fixableBy: 'person' },
            }),
          }),
        ],
      });
      vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
        connectionId: PREVIEW.connection.connectionId,
        reconciliationStatus: 'ready',
        authoritySync: { status: 'ready' },
        grants: [],
      });
      renderWith(
        transport,
        <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
      );

      expect(await screen.findByTestId('access-dialog-cause')).toHaveTextContent(words);
      await user.click(await screen.findByRole('button', { name: 'Confirm access' }));
      await waitFor(() =>
        expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
          previewId: 'preview-1',
          grants: [],
        })
      );
      expect(await screen.findByTestId('connector-access-outcome')).toHaveTextContent(
        'Access updated'
      );
    }
  );

  it('still asks for a change before saving an account that needs nothing', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );
    await screen.findByRole('group', { name: 'Access for Bo' });
    expect(screen.queryByTestId('access-dialog-cause')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save access' })).toBeDisabled();
  });

  it('submits only the changed named agent and keeps sensitive actions out of quick access', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: PREVIEW.connection.connectionId,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'ready' },
      grants: [
        { agentId: 'agent-b', operationRevisionIds: ['read-v1', 'write-v2'], level: 'read-write' },
      ],
    });
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );

    const bo = await screen.findByRole('group', { name: 'Access for Bo' });
    expect(within(bo).queryByText('Delete')).not.toBeInTheDocument();
    await user.click(within(bo).getByRole('button', { name: 'Read + write' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));

    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-1',
        grants: [
          {
            agentId: 'agent-b',
            operationRevisionIds: ['read-v1', 'write-v2'],
            level: 'read-write',
          },
        ],
      })
    );
    expect(screen.getByTestId('connector-access-outcome')).toHaveTextContent('Access updated');
  });

  it('keeps pending access unusable until an explicit authority check confirms it', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: PREVIEW.connection.connectionId,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'pending' },
      grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1'], level: 'read' }],
    });
    vi.mocked(transport.getConnectorConnection).mockResolvedValue({
      connection: {
        readiness: { state: 'ready', reason: 'usable' },
        connectionId: PREVIEW.connection.connectionId,
        reconciliationStatus: 'ready',
        authoritySync: { status: 'ready' },
      },
      agents: [
        {
          agentId: 'agent-b',
          operationRevisionIds: ['read-v1'],
          reconciliationStatus: 'ready',
          authoritySync: { status: 'ready' },
        },
      ],
    } as never);
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );

    const bo = await screen.findByRole('group', { name: 'Access for Bo' });
    await user.click(within(bo).getByRole('button', { name: 'Read' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));

    expect(await screen.findByTestId('connector-access-outcome')).toHaveTextContent(
      'Access update pending'
    );
    expect(screen.queryByText('Access updated')).not.toBeInTheDocument();
    expect(transport.getConnectorConnection).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Check if it’s done' }));
    expect(await screen.findByText('Access updated')).toBeInTheDocument();
    expect(transport.getConnectorConnection).toHaveBeenCalledTimes(1);
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
  });

  it('does not claim an older pending change after a later grant supersedes it', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: PREVIEW.connection.connectionId,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'pending' },
      grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1'], level: 'read' }],
    });
    vi.mocked(transport.getConnectorConnection).mockResolvedValue({
      connection: {
        readiness: { state: 'ready', reason: 'usable' },
        connectionId: PREVIEW.connection.connectionId,
        reconciliationStatus: 'ready',
        authoritySync: { status: 'ready' },
      },
      agents: [
        {
          agentId: 'agent-b',
          operationRevisionIds: ['write-v2'],
          reconciliationStatus: 'ready',
          authoritySync: { status: 'ready' },
        },
      ],
    } as never);
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );

    const bo = await screen.findByRole('group', { name: 'Access for Bo' });
    await user.click(within(bo).getByRole('button', { name: 'Read' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));
    expect(await screen.findByText('Access update pending')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check if it’s done' }));
    expect(await screen.findByText(/couldn’t confirm access was saved/i)).toBeInTheDocument();
    expect(screen.queryByText('Access updated')).not.toBeInTheDocument();
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
  });

  it('shows a failed authority sync and never repeats the write when its status read fails', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: PREVIEW.connection.connectionId,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'failed', reason: 'Provider confirmation timed out.' },
      grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1'], level: 'read' }],
    });
    vi.mocked(transport.getConnectorConnection).mockRejectedValue(new Error('read unavailable'));
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );

    const bo = await screen.findByRole('group', { name: 'Access for Bo' });
    await user.click(within(bo).getByRole('button', { name: 'Read' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));

    expect(await screen.findByTestId('connector-access-outcome')).toHaveTextContent(
      'Access didn’t update'
    );
    expect(screen.getByText(/Provider confirmation timed out/)).toBeInTheDocument();
    expect(screen.queryByText('Access updated')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Check if it’s done' }));
    expect(await screen.findByText(/Nothing was sent twice/)).toBeInTheDocument();
    expect(transport.getConnectorConnection).toHaveBeenCalledTimes(1);
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
  });

  it('does not claim success when the server returns different grants or a review state', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
    vi.mocked(transport.applyConnectorReconciliation)
      .mockResolvedValueOnce({
        connectionId: PREVIEW.connection.connectionId,
        reconciliationStatus: 'ready',
        authoritySync: { status: 'ready' },
        grants: [{ agentId: 'agent-b', operationRevisionIds: ['write-v2'] }],
      })
      .mockResolvedValueOnce({
        connectionId: PREVIEW.connection.connectionId,
        reconciliationStatus: 'migration_needs_reconcile',
        authoritySync: { status: 'ready' },
        grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1'], level: 'read' }],
      });
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );

    let bo = await screen.findByRole('group', { name: 'Access for Bo' });
    await user.click(within(bo).getByRole('button', { name: 'Read' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));
    expect(await screen.findByText(/couldn’t confirm access was saved/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reload current access' }));
    bo = await screen.findByRole('group', { name: 'Access for Bo' });
    await user.click(within(bo).getByRole('button', { name: 'Read' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));
    expect(await screen.findByTestId('connector-access-outcome')).toHaveTextContent(
      'Access needs review'
    );
    expect(screen.queryByText('Access updated')).not.toBeInTheDocument();
  });

  it('does not replay an ambiguous save and requires a fresh authority snapshot', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
    vi.mocked(transport.applyConnectorReconciliation).mockRejectedValue(new Error('socket closed'));
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );

    const bo = await screen.findByRole('group', { name: 'Access for Bo' });
    await user.click(within(bo).getByRole('button', { name: 'Read' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t confirm/i);
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Reload current access' }));
    expect(transport.previewConnectorReconciliation).toHaveBeenCalledTimes(2);
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
  });
});
