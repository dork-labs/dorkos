/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
    await user.click(screen.getByRole('button', { name: /Pause work/ }));
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
});
