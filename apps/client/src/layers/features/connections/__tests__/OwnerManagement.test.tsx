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
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ConnectionAccessDialog } from '../ui/ConnectionAccessDialog';
import { ManagementReviews } from '../ui/ManagementReviews';

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
  it('submits only the changed named agent and keeps sensitive actions out of quick access', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(PREVIEW);
    vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
      connectionId: PREVIEW.connection.connectionId,
      reconciliationStatus: 'ready',
      grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1', 'write-v2'] }],
    });
    renderWith(
      transport,
      <ConnectionAccessDialog connectionId="connection-1" open onOpenChange={vi.fn()} />
    );

    const bo = await screen.findByRole('group', { name: 'Bo' });
    expect(within(bo).queryByText('Delete')).not.toBeInTheDocument();
    await user.click(within(bo).getByRole('button', { name: 'Read + write' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));

    await waitFor(() =>
      expect(transport.applyConnectorReconciliation).toHaveBeenCalledWith({
        previewId: 'preview-1',
        grants: [{ agentId: 'agent-b', operationRevisionIds: ['read-v1', 'write-v2'] }],
      })
    );
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

    const bo = await screen.findByRole('group', { name: 'Bo' });
    await user.click(within(bo).getByRole('button', { name: 'Read only' }));
    await user.click(screen.getByRole('button', { name: 'Save access' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t confirm/i);
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Reload current access' }));
    expect(transport.previewConnectorReconciliation).toHaveBeenCalledTimes(2);
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
  });
});

describe('ManagementReviews', () => {
  it('shows a retry when recent decisions cannot be loaded', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport();
    vi.mocked(transport.getConnectorManagementReviews).mockImplementation(async (state) => {
      if (state === 'resolved') throw new Error('history unavailable');
      return [];
    });
    renderWith(
      transport,
      <ManagementReviews selectedReviewId={null} onSelectReview={vi.fn()} onCloseReview={vi.fn()} />
    );

    const error = await screen.findByText('Couldn’t load recent decisions');
    expect(error).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(
        vi
          .mocked(transport.getConnectorManagementReviews)
          .mock.calls.filter(([state]) => state === 'resolved')
      ).toHaveLength(2)
    );
  });

  it('shows the frozen provider, custody, and affected-agent impact before disconnect', async () => {
    const disconnect: ConnectorManagementReviewItem = {
      reviewRequestId: 'review-disconnect',
      requesterKind: 'program',
      action: { version: 1, kind: 'disconnect', connectionId: 'connection-1' as never },
      context: {
        kind: 'disconnect',
        connection: CONNECTION_CONTEXT,
        affectedAgentCount: 1,
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
      <ManagementReviews
        selectedReviewId="review-disconnect"
        onSelectReview={vi.fn()}
        onCloseReview={vi.fn()}
      />
    );

    expect(await screen.findByText('Composio keeps this sign-in')).toBeInTheDocument();
    expect(screen.getByText('1 affected agent')).toBeInTheDocument();
    expect(screen.getByText('This will remove this account from 1 agent.')).toBeInTheDocument();
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
      <ManagementReviews
        selectedReviewId="review-pause"
        onSelectReview={vi.fn()}
        onCloseReview={vi.fn()}
      />
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
      <ManagementReviews
        selectedReviewId={resolving.reviewRequestId}
        onSelectReview={vi.fn()}
        onCloseReview={vi.fn()}
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
      <ManagementReviews
        selectedReviewId="review-pause"
        onSelectReview={vi.fn()}
        onCloseReview={vi.fn()}
      />
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
    vi.mocked(transport.pollConnectorFlow).mockResolvedValue({ status: 'pending' });
    renderWith(
      transport,
      <ManagementReviews
        selectedReviewId="review-connect"
        onSelectReview={vi.fn()}
        onCloseReview={vi.fn()}
      />
    );

    await user.click(await screen.findByRole('button', { name: 'Approve and continue' }));
    expect(await screen.findByText('Sign-in still required')).toBeInTheDocument();
    expect(screen.queryByText('Account connected')).not.toBeInTheDocument();
    expect(transport.pollConnectorFlow).not.toHaveBeenCalled();

    await user.click(screen.getByRole('link', { name: 'Continue to sign in' }));
    await waitFor(() => expect(transport.pollConnectorFlow).toHaveBeenCalledWith('flow-1'));
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
      <ManagementReviews
        selectedReviewId={unknown.reviewRequestId}
        onSelectReview={vi.fn()}
        onCloseReview={vi.fn()}
      />
    );

    expect(await screen.findByText('Outcome unknown')).toBeInTheDocument();
    expect(screen.getByText(/may have been applied/i)).toBeInTheDocument();
    expect(screen.queryByText('Approved and applied')).not.toBeInTheDocument();
    expect(screen.queryByText('Expired')).not.toBeInTheDocument();
  });

  it.each([
    {
      poll: { status: 'connected' as const },
      heading: 'Account connected',
      detail: 'Sign-in finished and the account is ready.',
    },
    {
      poll: { status: 'failed' as const, error: 'The sign-in link expired.' },
      heading: 'Sign-in didn’t finish',
      detail: /start a new connection request/i,
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
    vi.mocked(transport.pollConnectorFlow).mockResolvedValue(poll);
    renderWith(
      transport,
      <ManagementReviews
        selectedReviewId="review-connect-terminal"
        onSelectReview={vi.fn()}
        onCloseReview={vi.fn()}
      />
    );

    await user.click(await screen.findByRole('link', { name: 'Continue to sign in' }));
    expect(await screen.findByText(heading)).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.queryByText('Sign-in still required')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Continue to sign in' })).not.toBeInTheDocument();
  });
});
