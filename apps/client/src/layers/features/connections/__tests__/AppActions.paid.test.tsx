/**
 * Paid actions in "What agents can do" (DOR-4204 spec 1.0 §6): a paid chip
 * ends with a named Coins icon, its bucket says what the coins mean once, the
 * full list tags each paid row in words, and with a level picked paid actions
 * leave its buckets, since no level covers them (main's `actionBuckets` rule).
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorAppActions } from '@dorkos/shared/connector-resource-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AppActions } from '../ui/AppActions';

afterEach(cleanup);

/** Acme Search is a pay-per-use search app (the `tavily` service). */
const PAID: ConnectorAppActions = {
  status: 'listed',
  toolkit: 'tavily',
  toolkitVersion: '1',
  completeness: 'complete',
  fetchedAt: '2026-11-14T00:00:00.000Z',
  actions: [
    {
      operationSlug: 'TAVILY_SEARCH',
      displayName: 'Search',
      capabilityClassification: 'read',
      important: true,
    },
  ],
};

function renderPaid(level?: 'read') {
  const transport: Transport = createMockTransport();
  vi.mocked(transport.getConnectorAppActions).mockResolvedValue(PAID);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <AppActions
          toolkit="tavily"
          appName="Acme Search"
          providerInstanceId="composio:1"
          grant={
            level
              ? {
                  candidates: [
                    {
                      operationRevisionId: 'TAVILY_SEARCH-1',
                      toolkit: 'tavily',
                      operationSlug: 'TAVILY_SEARCH',
                      toolkitVersion: '1',
                      capabilityClassification: 'read',
                      retryPolicy: 'never',
                      inputSchema: {},
                      supported: true,
                    },
                  ],
                  level,
                }
              : undefined
          }
        />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('paid actions in AppActions', () => {
  it('ends a paid chip with a named icon, and says once what the coins mean', async () => {
    renderPaid();
    const look = await screen.findByTestId('app-actions-look');
    expect(within(look).getByRole('img', { name: 'spends money' })).toBeInTheDocument();
    expect(within(look).getByText('Actions marked with coins spend money.')).toBeVisible();
  });

  it('tags each paid row of the full list in words', async () => {
    renderPaid();
    await userEvent.click(await screen.findByRole('button', { name: /See all 1 action/ }));
    const all = screen.getByTestId('app-actions-all');
    expect(within(all).getByText('Spends money')).toBeVisible();
  });

  it('keeps paid actions out of a picked level, and says why', async () => {
    renderPaid('read');
    await waitFor(() => expect(screen.getByText('Nothing at this level.')).toBeVisible());
    expect(screen.getByTestId('app-actions')).toHaveTextContent(
      'Search isn’t part of “Read”. To allow it, choose exact actions.'
    );
  });
});
