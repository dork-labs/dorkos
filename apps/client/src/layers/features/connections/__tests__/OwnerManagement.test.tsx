/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type {
  ConnectorManagementReviewItem,
  ConnectorReconciliationPreview,
} from '@dorkos/shared/connector-schemas';
import { CONNECTION_READINESS_COPY } from '@dorkos/shared/connector-schemas';
import { createMockConnectionReadiness, createMockTransport } from '@dorkos/test-utils';
import { mockConnection } from '@/dev/mock-samples';
import { TransportProvider } from '@/layers/shared/model';
import { ConnectionAccessDialog } from '../ui/access/ConnectionAccessDialog';
import { ManagementReviewDialog } from '../ui/ManagementReviewDialog';
import { NeedsYou } from '../ui/NeedsYou';

afterEach(cleanup);

const PREVIEW: ConnectorReconciliationPreview = {
  previewId: 'preview-1',
  connection: {
    connectionId: 'connection-1' as never,
    toolkit: 'gmail',
    label: 'Gmail (work)',
    status: 'active',
    custody: 'managed',
    reconciliationStatus: 'ready',
  },
  candidates: [
    {
      operationRevisionId: 'read-v1',
      toolkit: 'gmail',
      operationSlug: 'gmail.messages.list',
      toolkitVersion: '2026-08-01',
      capabilityClassification: 'read',
      retryPolicy: 'never',
      inputSchema: {},
      supported: true,
    },
    {
      operationRevisionId: 'write-v2',
      toolkit: 'gmail',
      operationSlug: 'gmail.messages.send',
      toolkitVersion: '2026-09-01',
      capabilityClassification: 'write',
      retryPolicy: 'provider_idempotency_key',
      inputSchema: {},
      supported: true,
    },
    {
      operationRevisionId: 'delete-v2',
      toolkit: 'gmail',
      operationSlug: 'gmail.messages.delete',
      toolkitVersion: '2026-09-01',
      capabilityClassification: 'destructive',
      retryPolicy: 'never',
      inputSchema: {},
      supported: true,
    },
  ],
  agents: [
    { agentId: 'agent-a', displayName: 'Ada' },
    { agentId: 'agent-b', displayName: 'Bo' },
  ],
  currentGrants: [{ agentId: 'agent-a', operationRevisionIds: ['read-v1'] }],
  everyAgent: { available: false, operationRevisionIds: [] },
  catalogComplete: true,
  createdAt: '2026-09-06T00:00:00.000Z',
  expiresAt: '2099-09-06T01:00:00.000Z',
};

const CONNECTION_CONTEXT = {
  connectionId: 'connection-1' as never,
  label: 'Gmail (work)',
  toolkit: 'gmail',
  status: 'active' as const,
  custody: 'managed' as const,
  providerDisplayName: 'Composio',
  providerStatus: 'available' as const,
  reconciliationStatus: 'ready' as const,
};

const PENDING_PAUSE: ConnectorManagementReviewItem = {
  reviewRequestId: 'review-pause',
  requesterKind: 'program',
  action: { version: 1, kind: 'pause', connectionId: 'connection-1' as never },
  context: {
    kind: 'pause',
    connection: CONNECTION_CONTEXT,
  },
  targetStatus: 'available',
  state: 'pending',
  createdAt: '2026-09-06T00:00:00.000Z',
  expiresAt: '2099-09-06T01:00:00.000Z',
};

function renderWith(transport: Transport, ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
}

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
    expect(line).toHaveTextContent(
      'Every agent also has 2 actions here through “Every agent”, including agents you add later.'
    );
    expect(line).toHaveTextContent('stop sharing this account with every agent');
  });

  it('marks the older of an action listed twice in the exact-actions list', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    const send = PREVIEW.candidates.find((c) => c.operationRevisionId === 'write-v2')!;
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue({
      ...PREVIEW,
      candidates: [
        ...PREVIEW.candidates,
        { ...send, operationRevisionId: 'write-v1', toolkitVersion: '2026-08-01' },
      ],
    });
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );

    const bo = await screen.findByRole('group', { name: 'Access for Bo' });
    await user.click(within(bo).getByRole('button', { name: 'Advanced' }));
    const rows = within(bo).getAllByRole('listitem');
    const sendRows = rows.filter((row) => row.textContent?.includes('Send'));
    expect(sendRows).toHaveLength(2);
    expect(sendRows.filter((row) => row.textContent?.includes('Older version'))).toHaveLength(1);
  });

  it('says nothing about every agent when it is not shared', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );
    await screen.findByRole('group', { name: 'Access for Bo' });
    expect(screen.queryByTestId('exact-editor-every-agent')).not.toBeInTheDocument();
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
      grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1', 'write-v2'] }],
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
        grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1', 'write-v2'] }],
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
      grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1'] }],
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
      grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1'] }],
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
    expect(await screen.findByText(/couldn’t confirm that access was saved/i)).toBeInTheDocument();
    expect(screen.queryByText('Access updated')).not.toBeInTheDocument();
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
  });

  it('explains that a pending removal has already ended locally', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: PREVIEW.connection.connectionId,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'pending' },
      grants: [{ agentId: 'agent-a', operationRevisionIds: [] }],
    });
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );

    const ada = await screen.findByRole('group', { name: 'Access for Ada' });
    await user.click(within(ada).getByRole('button', { name: 'No access' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));

    expect(await screen.findByText(/Access you removed has already ended/)).toBeInTheDocument();
    expect(screen.queryByText(/remains unavailable/)).not.toBeInTheDocument();
  });

  it('shows a failed authority sync and never repeats the write when its status read fails', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: PREVIEW.connection.connectionId,
      reconciliationStatus: 'ready',
      authoritySync: { status: 'failed', reason: 'Provider confirmation timed out.' },
      grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1'] }],
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
    expect(await screen.findByText(/DorkOS didn’t send it again/)).toBeInTheDocument();
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
        grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1'] }],
      });
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );

    let bo = await screen.findByRole('group', { name: 'Access for Bo' });
    await user.click(within(bo).getByRole('button', { name: 'Read' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));
    expect(await screen.findByText(/couldn’t confirm that access was saved/i)).toBeInTheDocument();

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

describe('ManagementReviewDialog', () => {
  it('shows the app, its status and where its sign-in is kept in plain words, and the impact, before disconnect', async () => {
    const disconnect: ConnectorManagementReviewItem = {
      reviewRequestId: 'review-disconnect',
      requesterKind: 'program',
      action: { version: 1, kind: 'disconnect', connectionId: 'connection-1' as never },
      context: {
        kind: 'disconnect',
        connection: CONNECTION_CONTEXT,
        affectedAgentCount: 1,
        everyAgent: false,
        affectedOperations: [],
      },
      targetStatus: 'available',
      state: 'pending',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2099-09-06T01:00:00.000Z',
    };
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorManagementReviews).mockImplementation(async (state) =>
      state === 'pending' ? [disconnect] : []
    );
    vi.mocked(transport.getConnectorManagementReview).mockResolvedValue(disconnect);
    renderWith(
      transport,
      <ManagementReviewDialog reviewRequestId="review-disconnect" open onOpenChange={vi.fn()} />
    );

    expect(await screen.findByText('Kept in Composio’s vault')).toBeInTheDocument();
    // Plain words, never the stored app id or status value.
    expect(screen.getByText('Gmail')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('gmail')).not.toBeInTheDocument();
    expect(screen.queryByText('active')).not.toBeInTheDocument();
    expect(screen.getByText('This will remove this account from 1 agent.')).toBeInTheDocument();
  });

  it('marks the older of two identical-looking actions with a quiet hint', async () => {
    const twice: ConnectorManagementReviewItem = {
      reviewRequestId: 'review-twice',
      requesterKind: 'program',
      action: { version: 1, kind: 'disconnect', connectionId: 'connection-1' as never },
      context: {
        kind: 'disconnect',
        connection: CONNECTION_CONTEXT,
        affectedAgentCount: 1,
        everyAgent: false,
        affectedOperations: [
          {
            operationRevisionId: 'send-old',
            operationSlug: 'gmail.send',
            toolkitVersion: '2026-08-01',
            capabilityClassification: 'destructive',
          },
          {
            operationRevisionId: 'send-new',
            operationSlug: 'gmail.send',
            toolkitVersion: '2026-09-01',
            capabilityClassification: 'destructive',
          },
        ],
      },
      targetStatus: 'available',
      state: 'pending',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2099-09-06T01:00:00.000Z',
    };
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorManagementReview).mockResolvedValue(twice);
    renderWith(
      transport,
      <ManagementReviewDialog reviewRequestId="review-twice" open onOpenChange={vi.fn()} />
    );

    expect(await screen.findAllByText('Send')).toHaveLength(2);
    expect(screen.getAllByText('Older version')).toHaveLength(1);
    // The class reads as a risk, never as a verb the action may not be.
    expect(screen.getAllByText('High risk')).toHaveLength(2);
    expect(screen.queryByText(/2026-0/)).not.toBeInTheDocument();
  });

  it('says plainly when an agent keeps access through every agent, and when every agent loses it', async () => {
    const removal: ConnectorManagementReviewItem = {
      reviewRequestId: 'review-remove',
      requesterKind: 'program',
      action: {
        version: 1,
        kind: 'remove_agent_access',
        connectionId: 'connection-1' as never,
        agentId: 'agent-a',
      },
      context: {
        kind: 'remove_agent_access',
        connection: CONNECTION_CONTEXT,
        agent: { agentId: 'agent-a', displayName: 'Research Bot' },
        affectedOperations: [],
        keptThroughEveryAgent: [
          {
            operationRevisionId: 'read-v1',
            operationSlug: 'gmail.read',
            toolkitVersion: 'v1',
            capabilityClassification: 'read',
          },
        ],
      },
      targetStatus: 'available',
      state: 'pending',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2099-09-06T01:00:00.000Z',
    };
    const disconnect: ConnectorManagementReviewItem = {
      ...removal,
      reviewRequestId: 'review-disconnect-all',
      action: { version: 1, kind: 'disconnect', connectionId: 'connection-1' as never },
      context: {
        kind: 'disconnect',
        connection: CONNECTION_CONTEXT,
        affectedAgentCount: 0,
        everyAgent: true,
        affectedOperations: [],
      },
    };
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorManagementReviews).mockImplementation(async (state) =>
      state === 'pending' ? [removal, disconnect] : []
    );
    vi.mocked(transport.getConnectorManagementReview).mockImplementation(async (id) =>
      id === 'review-remove' ? removal : disconnect
    );
    const view = renderWith(
      transport,
      <ManagementReviewDialog reviewRequestId="review-remove" open onOpenChange={vi.fn()} />
    );

    expect(await screen.findByTestId('connector-review-every-agent-kept')).toHaveTextContent(
      'Research Bot keeps 1 action on'
    );
    expect(screen.getByTestId('connector-review-every-agent-kept')).toHaveTextContent(
      'stop sharing'
    );
    view.unmount();

    // The "Needs you" strip summarises both before either is opened.
    const strip = renderWith(
      transport,
      <NeedsYou services={new Map()} onOpenRequest={vi.fn()} onOpenReview={vi.fn()} />
    );
    expect(await screen.findByText(/still shared with every agent/)).toBeInTheDocument();
    expect(screen.getByText('Every agent loses access.')).toBeInTheDocument();
    strip.unmount();
    renderWith(
      transport,
      <ManagementReviewDialog reviewRequestId="review-disconnect-all" open onOpenChange={vi.fn()} />
    );
    expect(await screen.findByTestId('connector-review-impact')).toHaveTextContent(
      'This will remove this account from every agent.'
    );
  });

  it('offers deny only when the frozen target is unavailable', async () => {
    const unavailable: ConnectorManagementReviewItem = {
      ...PENDING_PAUSE,
      targetStatus: 'unavailable',
    };
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorManagementReviews).mockResolvedValue([]);
    vi.mocked(transport.getConnectorManagementReview).mockResolvedValue(unavailable);
    renderWith(
      transport,
      <ManagementReviewDialog reviewRequestId="review-pause" open onOpenChange={vi.fn()} />
    );

    expect(await screen.findByText('This request can’t be approved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('shows an in-flight decision as resolving without offering another decision', async () => {
    const resolving: ConnectorManagementReviewItem = {
      ...PENDING_PAUSE,
      state: 'resolving',
      resolvedAt: '2026-09-06T00:10:00.000Z',
    };
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorManagementReviews).mockImplementation(async (state) =>
      state === 'resolved' ? [resolving] : []
    );
    vi.mocked(transport.getConnectorManagementReview).mockResolvedValue(resolving);
    renderWith(
      transport,
      <ManagementReviewDialog
        reviewRequestId={resolving.reviewRequestId}
        open
        onOpenChange={vi.fn()}
      />
    );

    expect(await screen.findByText('Applying change')).toBeInTheDocument();
    expect(screen.getByTestId('connector-review-outcome')).toHaveAttribute(
      'data-outcome',
      'resolving'
    );
    expect(screen.queryByRole('button', { name: /approve|deny/i })).not.toBeInTheDocument();
  });

  it('requires a durable refetch after an ambiguous decision response without replaying it', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorManagementReviews).mockResolvedValue([]);
    vi.mocked(transport.getConnectorManagementReview).mockResolvedValue(PENDING_PAUSE);
    vi.mocked(transport.resolveConnectorManagementReview).mockRejectedValue(
      new Error('response lost')
    );
    renderWith(
      transport,
      <ManagementReviewDialog reviewRequestId="review-pause" open onOpenChange={vi.fn()} />
    );

    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t confirm/i);
    expect(transport.resolveConnectorManagementReview).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reload request' }));
    await waitFor(() => expect(transport.getConnectorManagementReview).toHaveBeenCalledTimes(2));
    expect(transport.resolveConnectorManagementReview).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Deny' })).toBeInTheDocument();
  });

  it('shows authentication as required after approval, then polls only after the owner continues', async () => {
    const user = userEvent.setup();
    const connect: ConnectorManagementReviewItem = {
      reviewRequestId: 'review-connect',
      requesterKind: 'program',
      action: {
        version: 1,
        kind: 'connect',
        providerInstanceId: 'provider-1' as never,
        toolkit: 'gmail',
        label: 'work',
      },
      context: {
        kind: 'connect',
        providerInstanceId: 'provider-1' as never,
        providerDisplayName: 'Composio',
        toolkit: 'gmail',
        label: 'work',
      },
      targetStatus: 'available',
      state: 'pending',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2099-09-06T01:00:00.000Z',
    };
    const approved: ConnectorManagementReviewItem = {
      reviewRequestId: 'review-connect',
      requesterKind: 'program',
      action: {
        version: 1,
        kind: 'connect',
        providerInstanceId: 'provider-1' as never,
        toolkit: 'gmail',
        label: 'work',
      },
      context: {
        kind: 'connect',
        providerInstanceId: 'provider-1' as never,
        providerDisplayName: 'Composio',
        toolkit: 'gmail',
        label: 'work',
      },
      targetStatus: 'available',
      state: 'approved',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2099-09-06T01:00:00.000Z',
      resolvedAt: '2026-09-06T00:10:00.000Z',
      resolution: {
        kind: 'connect_authentication_required',
        reviewRequestId: 'review-connect',
        authentication: { flowId: 'flow-1', authorizeUrl: 'https://example.test/sign-in' },
      },
    };
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorManagementReviews).mockResolvedValue([]);
    vi.mocked(transport.getConnectorManagementReview).mockResolvedValue(connect);
    vi.mocked(transport.resolveConnectorManagementReview).mockResolvedValue({ review: approved });
    vi.mocked(transport.pollConnectorAuthentication).mockResolvedValue({
      flowId: 'flow-1',
      providerInstanceId: 'provider-1' as never,
      toolkit: 'gmail',
      state: 'pending',
      createdAt: '2026-09-06T00:10:00.000Z',
      expiresAt: '2099-09-06T01:00:00.000Z',
    });
    renderWith(
      transport,
      <ManagementReviewDialog reviewRequestId="review-connect" open onOpenChange={vi.fn()} />
    );

    await user.click(await screen.findByRole('button', { name: 'Approve and continue' }));
    expect(await screen.findByText('Sign-in still required')).toBeInTheDocument();
    expect(screen.queryByText('Account connected')).not.toBeInTheDocument();
    expect(transport.pollConnectorAuthentication).not.toHaveBeenCalled();

    await user.click(screen.getByRole('link', { name: 'Continue to sign in' }));
    await waitFor(() =>
      expect(transport.pollConnectorAuthentication).toHaveBeenCalledWith('flow-1')
    );
    expect(await screen.findByText('Waiting for sign-in')).toBeInTheDocument();
    expect(screen.queryByText('Sign-in still required')).not.toBeInTheDocument();
  });

  it('shows an indeterminate approved action without claiming it applied or expired', async () => {
    const unknown: ConnectorManagementReviewItem = {
      ...PENDING_PAUSE,
      state: 'approved',
      resolvedAt: '2026-09-06T00:10:00.000Z',
      resolution: { kind: 'outcome_unknown' },
    };
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorManagementReviews).mockResolvedValue([]);
    vi.mocked(transport.getConnectorManagementReview).mockResolvedValue(unknown);
    renderWith(
      transport,
      <ManagementReviewDialog
        reviewRequestId={unknown.reviewRequestId}
        open
        onOpenChange={vi.fn()}
      />
    );

    expect(await screen.findByText('Outcome unknown')).toBeInTheDocument();
    expect(screen.getByText(/may have been applied/i)).toBeInTheDocument();
    expect(screen.queryByText('Approved and applied')).not.toBeInTheDocument();
    expect(screen.queryByText('Expired')).not.toBeInTheDocument();
  });

  it.each([
    {
      poll: {
        flowId: 'flow-terminal',
        providerInstanceId: 'provider-1' as never,
        toolkit: 'gmail',
        state: 'connected' as const,
        connectionId: 'connection-1' as never,
        createdAt: '2026-09-06T00:10:00.000Z',
        expiresAt: '2099-09-06T01:00:00.000Z',
        completedAt: '2026-09-06T00:11:00.000Z',
      },
      heading: 'Account connected',
      detail: 'Sign-in finished and the account is ready.',
    },
    {
      poll: {
        flowId: 'flow-terminal',
        providerInstanceId: 'provider-1' as never,
        toolkit: 'gmail',
        state: 'failed' as const,
        reason: 'The sign-in link expired.',
        createdAt: '2026-09-06T00:10:00.000Z',
        expiresAt: '2099-09-06T01:00:00.000Z',
        completedAt: '2026-09-06T00:11:00.000Z',
      },
      heading: 'Sign-in didn’t finish',
      detail: 'Sign-in didn’t finish. You can connect it yourself on the Connections page.',
    },
    {
      poll: {
        flowId: 'flow-terminal',
        providerInstanceId: 'provider-1' as never,
        toolkit: 'gmail',
        state: 'expired' as const,
        createdAt: '2026-09-06T00:10:00.000Z',
        expiresAt: '2026-09-06T01:00:00.000Z',
        completedAt: '2026-09-06T01:00:00.000Z',
      },
      heading: 'Sign-in didn’t finish',
      detail:
        'The sign-in took too long and ended. You can connect it yourself on the Connections page.',
    },
    {
      poll: {
        flowId: 'flow-terminal',
        providerInstanceId: 'provider-1' as never,
        toolkit: 'gmail',
        state: 'start_unknown' as const,
        reason: 'The provider response was lost.',
        createdAt: '2026-09-06T00:10:00.000Z',
        expiresAt: '2026-09-06T01:00:00.000Z',
        completedAt: '2026-09-06T00:10:01.000Z',
      },
      heading: 'Sign-in didn’t finish',
      detail:
        'DorkOS couldn’t tell whether the sign-in started. You can connect it yourself on the Connections page.',
    },
  ])('shows the terminal authentication state as $heading', async ({ poll, heading, detail }) => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    const approved: ConnectorManagementReviewItem = {
      reviewRequestId: 'review-connect-terminal',
      requesterKind: 'program',
      action: {
        version: 1,
        kind: 'connect',
        providerInstanceId: 'provider-1' as never,
        toolkit: 'gmail',
        label: 'work',
      },
      context: {
        kind: 'connect',
        providerInstanceId: 'provider-1' as never,
        providerDisplayName: 'Composio',
        toolkit: 'gmail',
        label: 'work',
      },
      targetStatus: 'available',
      state: 'approved',
      createdAt: '2026-09-06T00:00:00.000Z',
      expiresAt: '2099-09-06T01:00:00.000Z',
      resolvedAt: '2026-09-06T00:10:00.000Z',
      resolution: {
        kind: 'connect_authentication_required',
        reviewRequestId: 'review-connect-terminal',
        authentication: { flowId: 'flow-terminal', authorizeUrl: 'https://example.test/sign-in' },
      },
    };
    vi.mocked(transport.getConnectorManagementReviews).mockResolvedValue([]);
    vi.mocked(transport.getConnectorManagementReview).mockResolvedValue(approved);
    vi.mocked(transport.pollConnectorAuthentication).mockResolvedValue(poll);
    renderWith(
      transport,
      <ManagementReviewDialog
        reviewRequestId="review-connect-terminal"
        open
        onOpenChange={vi.fn()}
      />
    );

    await user.click(await screen.findByRole('link', { name: 'Continue to sign in' }));
    expect(await screen.findByText(heading)).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.queryByText('Sign-in still required')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Continue to sign in' })).not.toBeInTheDocument();

    // A fresh page load receives no obsolete authorize URL for a terminal flow.
    cleanup();
    if (approved.resolution.kind === 'connect_authentication_required') {
      delete approved.resolution.authentication.authorizeUrl;
    }
    renderWith(
      transport,
      <ManagementReviewDialog
        reviewRequestId="review-connect-terminal"
        open
        onOpenChange={vi.fn()}
      />
    );
    expect(await screen.findByText(heading)).toBeInTheDocument();
    expect(screen.queryByText('Sign-in still required')).not.toBeInTheDocument();
  });
});
