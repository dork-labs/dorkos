/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConnectorAgentRequestItem,
  ConnectorManagementReviewItem,
} from '@dorkos/shared/connector-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { NeedsYou } from '../ui/NeedsYou';

afterEach(cleanup);

const REQUEST = {
  requestId: 'request-1',
  serviceSlug: 'gmail',
  reason: 'Summarize new mail and prepare replies.',
  status: 'awaiting_owner',
  agent: { id: 'agent-1', displayName: 'Researcher' },
} as ConnectorAgentRequestItem;

const REVIEW = {
  reviewRequestId: 'review-1',
  requesterKind: 'program',
  context: {
    kind: 'pause',
    connection: { connectionId: 'c-1', toolkit: 'gmail', label: 'work' },
  },
  targetStatus: 'available',
  state: 'pending',
} as unknown as ConnectorManagementReviewItem;

function renderStrip(transport: Transport) {
  const onOpenRequest = vi.fn();
  const onOpenReview = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <NeedsYou
          services={
            new Map([
              [
                'gmail',
                {
                  serviceSlug: 'gmail',
                  displayName: 'Gmail',
                  iconKey: 'gmail',
                  intents: [{ kind: 'account', displayName: 'Account', routes: [] }],
                },
              ],
            ])
          }
          onOpenRequest={onOpenRequest}
          onOpenReview={onOpenReview}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { onOpenRequest, onOpenReview };
}

describe('NeedsYou', () => {
  it('lists each waiting decision in plain words and opens its own dialog', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectorAgentRequests: vi.fn().mockResolvedValue([REQUEST]),
      getConnectorManagementReviews: vi.fn().mockResolvedValue([REVIEW]),
    });
    const { onOpenRequest, onOpenReview } = renderStrip(transport);

    expect(await screen.findByRole('heading', { name: 'Needs you' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Researcher wants to use Gmail/ }));
    expect(onOpenRequest).toHaveBeenCalledWith('request-1');
    await user.click(
      screen.getByRole('button', { name: /A program asks to pause Gmail \(work\)/ })
    );
    expect(screen.getByText('Agents can’t use it until you resume it.')).toBeInTheDocument();
    expect(onOpenReview).toHaveBeenCalledWith('review-1');
  });

  it('renders nothing at all when nothing waits', async () => {
    const transport = createMockTransport({
      getConnectorAgentRequests: vi.fn().mockResolvedValue([]),
      getConnectorManagementReviews: vi.fn().mockResolvedValue([]),
    });
    renderStrip(transport);
    // Let both reads settle before asserting absence.
    await vi.waitFor(() => expect(transport.getConnectorManagementReviews).toHaveBeenCalled());
    expect(screen.queryByTestId('needs-you')).not.toBeInTheDocument();
  });

  it('says when its reads fail, with a retry, instead of vanishing', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      getConnectorAgentRequests: vi.fn().mockRejectedValue(new Error('offline')),
      getConnectorManagementReviews: vi.fn().mockResolvedValue([]),
    });
    renderStrip(transport);

    expect(await screen.findByText('Couldn’t check for waiting requests.')).toBeInTheDocument();
    vi.mocked(transport.getConnectorAgentRequests).mockResolvedValue([REQUEST]);
    // The waiting-requests line's own retry (agents' approvals have a line of their own).
    const waitingLine = screen.getByText('Couldn’t check for waiting requests.');
    await user.click(within(waitingLine).getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('button', { name: /Researcher wants to use Gmail/ })
    ).toBeInTheDocument();
  });

  it('keeps an approved change it could not confirm, and drops a plain decided one', async () => {
    const decided = (id: string, resolution: Record<string, unknown>) =>
      ({
        ...REVIEW,
        reviewRequestId: id,
        state: 'approved',
        resolvedAt: new Date().toISOString(),
        resolution,
      }) as unknown as ConnectorManagementReviewItem;
    const transport = createMockTransport({
      getConnectorAgentRequests: vi.fn().mockResolvedValue([]),
      getConnectorManagementReviews: vi.fn(async (state) =>
        state === 'resolved'
          ? [
              decided('review-unknown', { kind: 'outcome_unknown' }),
              decided('review-done', { kind: 'applied' }),
            ]
          : []
      ),
    });
    const { onOpenReview } = renderStrip(transport);
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole('button', { name: /Check Gmail \(work\) before another change/ })
    );
    expect(onOpenReview).toHaveBeenCalledWith('review-unknown');
    expect(screen.queryByTestId('needs-you-review-review-done')).not.toBeInTheDocument();
  });

  it('keeps a just-approved connect without reading its sign-in, which would move it on', async () => {
    const approvedConnect = {
      ...REVIEW,
      reviewRequestId: 'review-connect',
      action: {
        version: 1,
        kind: 'connect',
        providerInstanceId: 'p-1',
        toolkit: 'gmail',
        label: 'work',
      },
      context: {
        kind: 'connect',
        providerInstanceId: 'p-1',
        providerDisplayName: 'Composio',
        toolkit: 'gmail',
        label: 'work',
      },
      state: 'approved',
      resolvedAt: new Date().toISOString(),
      resolution: {
        kind: 'connect_authentication_required',
        reviewRequestId: 'review-connect',
        authentication: { flowId: 'flow-open' },
      },
    } as unknown as ConnectorManagementReviewItem;
    const transport = createMockTransport({
      getConnectorAgentRequests: vi.fn().mockResolvedValue([]),
      getConnectorManagementReviews: vi.fn(async (state) =>
        state === 'resolved' ? [approvedConnect] : []
      ),
      pollConnectorAuthentication: vi
        .fn()
        .mockResolvedValue({ flowId: 'flow-open', state: 'pending' }),
    });
    renderStrip(transport);
    expect(
      await screen.findByText('Approved: finish signing in to Gmail (work)')
    ).toBeInTheDocument();
  });

  it('drops an approved connect once its sign-in could no longer be finished, even on an open page', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], shouldAdvanceTime: true });
    try {
      const approvedAt = (minutesAgo: number, id: string) =>
        ({
          ...REVIEW,
          reviewRequestId: id,
          action: { version: 1, kind: 'connect', providerInstanceId: 'p-1', toolkit: 'gmail' },
          context: {
            kind: 'connect',
            providerInstanceId: 'p-1',
            providerDisplayName: 'Composio',
            toolkit: 'gmail',
            label: id,
          },
          state: 'approved',
          resolvedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
          resolution: {
            kind: 'connect_authentication_required',
            reviewRequestId: id,
            authentication: { flowId: `flow-${id}` },
          },
        }) as unknown as ConnectorManagementReviewItem;
      const transport = createMockTransport({
        getConnectorAgentRequests: vi.fn().mockResolvedValue([]),
        getConnectorManagementReviews: vi.fn(async (state) =>
          state === 'resolved' ? [approvedAt(14, 'fresh'), approvedAt(16, 'expired')] : []
        ),
      });
      renderStrip(transport);

      // The sign-in lives 15 minutes: one approved 14 minutes ago still asks,
      // one approved 16 minutes ago no longer does.
      expect(
        await screen.findByText('Approved: finish signing in to Gmail (fresh)')
      ).toBeInTheDocument();
      expect(screen.queryByText(/Gmail \(expired\)/)).not.toBeInTheDocument();

      // Left open two more minutes, the page ages the fresh one out too.
      await act(async () => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      expect(screen.queryByTestId('needs-you')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('a request another agent approved (DOR-3959)', () => {
    /** A granted request, with who approved it as the server puts it on the item. */
    const granted = (requestId: string, hoursAgo?: number, extra: object = {}) =>
      ({
        ...REQUEST,
        requestId,
        status: 'granted',
        ...(hoursAgo !== undefined && {
          approvedBy: {
            agentId: 'agent-pm',
            displayName: 'DorkOS PM',
            approvedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
            ...extra,
          },
        }),
      }) as ConnectorAgentRequestItem;
    const transportWith = (lists: {
      pending?: ConnectorAgentRequestItem[];
      resolved?: ConnectorAgentRequestItem[] | Error;
    }) =>
      createMockTransport({
        getConnectorAgentRequests: vi.fn(async (state) => {
          if (state !== 'resolved') return lists.pending ?? [];
          if (lists.resolved instanceof Error) throw lists.resolved;
          return lists.resolved ?? [];
        }),
        getConnectorManagementReviews: vi.fn().mockResolvedValue([]),
      });

    it('stays as a done item for the day, with who approved it and nothing to press', async () => {
      renderStrip(transportWith({ resolved: [granted('request-2', 2)] }));

      const row = await screen.findByTestId('needs-you-approved-request-2');
      expect(row).toHaveTextContent('Researcher asked to use Gmail');
      expect(row).toHaveTextContent('Approved by DorkOS PM · Read only');
      expect(row.querySelector('time')).toHaveTextContent('2h');
      expect(row.querySelector('button')).toBeNull();
    });

    it('never shows an approved request as still asking, while its agent picks the answer up', async () => {
      renderStrip(transportWith({ pending: [granted('request-3', 0)] }));

      expect(await screen.findByTestId('needs-you-approved-request-3')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /wants to use Gmail/ })).not.toBeInTheDocument();
    });

    it('drops it after a day, or as soon as the person undid it', async () => {
      renderStrip(
        transportWith({
          resolved: [
            granted('fresh', 23),
            granted('old', 25),
            granted('undone', 1, { undoneAt: new Date().toISOString() }),
          ],
        })
      );

      // The fresh one proves the reads landed; the other two are gone beside it.
      expect(await screen.findByTestId('needs-you-approved-fresh')).toBeInTheDocument();
      expect(screen.queryByTestId('needs-you-approved-old')).not.toBeInTheDocument();
      expect(screen.queryByTestId('needs-you-approved-undone')).not.toBeInTheDocument();
    });

    it('keeps a granted request no agent approved off the done list', async () => {
      renderStrip(transportWith({ pending: [REQUEST], resolved: [granted('by-person')] }));

      expect(
        await screen.findByRole('button', { name: /Researcher wants to use Gmail/ })
      ).toBeInTheDocument();
      expect(screen.queryByTestId('needs-you-approved-by-person')).not.toBeInTheDocument();
    });

    it('says so when it can’t load agents’ approvals, rather than leaving a gap', async () => {
      const user = userEvent.setup();
      const transport = transportWith({ resolved: new Error('offline') });
      renderStrip(transport);

      const line = await screen.findByTestId('needs-you-approvals-failed');
      expect(line).toHaveTextContent('Couldn’t load agent approvals.');
      vi.mocked(transport.getConnectorAgentRequests).mockResolvedValue([granted('later', 1)]);
      await user.click(within(line).getByRole('button', { name: 'Try again' }));
      expect(await screen.findByTestId('needs-you-approved-later')).toBeInTheDocument();
    });
  });

  it('stops asking about an unconfirmed change after a week', async () => {
    const decided = (days: number, id: string) =>
      ({
        ...REVIEW,
        reviewRequestId: id,
        state: 'approved',
        resolvedAt: new Date(Date.now() - days * 86_400_000).toISOString(),
        resolution: { kind: 'outcome_unknown' },
      }) as unknown as ConnectorManagementReviewItem;
    const transport = createMockTransport({
      getConnectorAgentRequests: vi.fn().mockResolvedValue([]),
      getConnectorManagementReviews: vi.fn(async (state) =>
        state === 'resolved' ? [decided(6, 'recent'), decided(8, 'old')] : []
      ),
    });
    renderStrip(transport);
    expect(await screen.findByTestId('needs-you-review-recent')).toBeInTheDocument();
    expect(screen.queryByTestId('needs-you-review-old')).not.toBeInTheDocument();
  });

  it('a mini app asking to read only links to its own page, with no decision in the link', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const transport = createMockTransport({
      getConnectorAgentRequests: vi.fn().mockResolvedValue([]),
      getConnectorManagementReviews: vi.fn().mockResolvedValue([]),
      getMiniAppAccess: vi.fn().mockResolvedValue({
        waiting: [
          {
            extensionId: 'flow-owner',
            extensionName: 'Flow',
            service: 'gmail',
            operations: ['GMAIL_LIST_MESSAGES'],
            reason: 'new',
          },
        ],
        allowed: [],
      }),
    });
    renderStrip(transport);

    const row = await screen.findByRole('button', { name: /Flow wants to read Gmail/ });
    expect(screen.queryByRole('button', { name: /approve|allow/i })).not.toBeInTheDocument();
    await user.click(row);
    expect(assign).toHaveBeenCalledWith(
      '/api/connectors/mini-app-access/page?extension=flow-owner&service=gmail'
    );
    vi.unstubAllGlobals();
  });
});
