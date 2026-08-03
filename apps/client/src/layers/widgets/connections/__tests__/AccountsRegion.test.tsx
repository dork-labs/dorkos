/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { AccountsRegion } from '../ui/AccountsRegion';

afterEach(cleanup);

function renderRegion(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(<AccountsRegion />, { wrapper });
}

describe('AccountsRegion', () => {
  it('renders the honest first-run state when nothing is connectable', async () => {
    // The mock transport's default: an empty toolkit list, no error. This is a
    // settled empty state — the region names the services and the carrier.
    const transport = createMockTransport();
    renderRegion(transport);

    await waitFor(() => {
      expect(screen.getByText(/nothing can be connected yet/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Composio & Nango' })).toBeInTheDocument();
  });

  it('shows a distinct error state on a failed fetch, not the empty state', async () => {
    // A transient fetch failure must never be dressed up as "nothing can be
    // connected yet" — that hides a network problem behind a settled fact.
    const transport = createMockTransport({
      getConnectorToolkits: vi.fn().mockRejectedValue(new Error('network down')),
    });
    renderRegion(transport);

    await waitFor(() => {
      expect(screen.getByText(/couldn.t load your services/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/nothing can be connected yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('retries the fetch when the error state offers it', async () => {
    const getToolkits = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ toolkits: [], warnings: [] });
    const transport = createMockTransport({ getConnectorToolkits: getToolkits });
    renderRegion(transport);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    // The retry runs, and the settled empty state replaces the error card.
    await waitFor(() => {
      expect(screen.getByText(/nothing can be connected yet/i)).toBeInTheDocument();
    });
    expect(getToolkits).toHaveBeenCalledTimes(2);
  });

  it('leads with the service grid when services are connectable', async () => {
    const transport = createMockTransport({
      getConnectorToolkits: vi.fn().mockResolvedValue({
        toolkits: [{ slug: 'gmail', displayName: 'Gmail' }],
        warnings: [],
      }),
    });
    renderRegion(transport);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Connected' })).toBeInTheDocument();
    });
    // The first-run copy stays out of the way once something is connectable.
    expect(screen.queryByText(/nothing can be connected yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn.t load your services/i)).not.toBeInTheDocument();
  });
});
