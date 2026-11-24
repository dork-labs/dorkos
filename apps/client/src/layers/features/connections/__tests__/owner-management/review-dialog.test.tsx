/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectorManagementReviewItem } from '@dorkos/shared/connector-schemas';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { ManagementReviewDialog } from '../../ui/ManagementReviewDialog';
import { NeedsYou } from '../../ui/NeedsYou';

afterEach(cleanup);
import { CONNECTION_CONTEXT, PENDING_PAUSE, renderWith } from './fixtures';

afterEach(cleanup);

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
    expect(screen.getByText('Removes this account from 1 agent.')).toBeInTheDocument();
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
    expect(await screen.findByText(/Still shared with every agent/)).toBeInTheDocument();
    expect(screen.getByText('Every agent loses access.')).toBeInTheDocument();
    strip.unmount();
    renderWith(
      transport,
      <ManagementReviewDialog reviewRequestId="review-disconnect-all" open onOpenChange={vi.fn()} />
    );
    expect(await screen.findByTestId('connector-review-impact')).toHaveTextContent(
      'Every agent loses this account.'
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
      detail: 'Sign-in didn’t finish. Connect it yourself on the Connections page.',
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
      detail: 'The sign-in timed out. Connect it yourself on the Connections page.',
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
      detail: 'DorkOS can’t tell if the sign-in started. Connect it on the Connections page.',
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
