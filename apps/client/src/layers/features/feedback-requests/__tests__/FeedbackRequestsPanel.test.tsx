/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { FeedbackListItem } from '@dorkos/shared/telemetry-events';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { FeedbackRequestsPanel } from '../ui/FeedbackRequestsPanel';

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function item(overrides: Partial<FeedbackListItem> = {}): FeedbackListItem {
  return {
    id: 'row-1',
    kind: 'bug',
    message: 'Chat stopped updating after the stream dropped',
    status: 'in_progress',
    createdAt: new Date().toISOString(),
    hasScreenshot: false,
    hasTranscript: false,
    ...overrides,
  };
}

describe('FeedbackRequestsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the empty state when nothing has been sent', async () => {
    const transport = createMockTransport({ listMyFeedback: vi.fn().mockResolvedValue([]) });
    render(<FeedbackRequestsPanel />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByText('Nothing sent yet')).toBeTruthy();
    });
  });

  it('renders a loading state before data arrives', () => {
    const transport = createMockTransport({
      listMyFeedback: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    render(<FeedbackRequestsPanel />, { wrapper: createWrapper(transport) });

    expect(screen.getByLabelText('Loading your reports…')).toBeTruthy();
  });

  it('renders an error state and a working retry on a rejected read', async () => {
    const listMyFeedback = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([]);
    const transport = createMockTransport({ listMyFeedback });
    render(<FeedbackRequestsPanel />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByText("Couldn't load your reports")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(screen.getByText('Nothing sent yet')).toBeTruthy();
    });
    expect(listMyFeedback).toHaveBeenCalledTimes(2);
  });

  it('renders each row with kind, message, relative date, and status badge', async () => {
    const items = [
      item({
        id: 'row-1',
        kind: 'idea',
        message: 'Let me pin a session to the top of the list',
        status: 'shipped',
        shippedVersion: '0.56.3',
      }),
      item({
        id: 'row-2',
        kind: 'bug',
        message: 'Chat stopped updating after the stream dropped',
        status: 'in_progress',
        hasScreenshot: true,
        hasTranscript: true,
      }),
      item({
        id: 'row-3',
        kind: 'feedback',
        message: 'Love the new trust dial',
        status: 'received',
      }),
    ];
    const transport = createMockTransport({ listMyFeedback: vi.fn().mockResolvedValue(items) });
    render(<FeedbackRequestsPanel />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByText('Let me pin a session to the top of the list')).toBeTruthy();
    });

    expect(screen.getByText('Shipped v0.56.3')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    expect(screen.getByText('Received')).toBeTruthy();
    expect(screen.getByText('screenshot, transcript')).toBeTruthy();
    expect(screen.getByText(/Add your email to a report/)).toBeTruthy();
  });

  it('does not show an attachment hint when nothing was attached', async () => {
    const transport = createMockTransport({
      listMyFeedback: vi
        .fn()
        .mockResolvedValue([item({ hasScreenshot: false, hasTranscript: false })]),
    });
    render(<FeedbackRequestsPanel />, { wrapper: createWrapper(transport) });

    await waitFor(() => {
      expect(screen.getByText('Chat stopped updating after the stream dropped')).toBeTruthy();
    });
    expect(screen.queryByText('screenshot')).toBeNull();
    expect(screen.queryByText('transcript')).toBeNull();
  });
});
