/**
 * The header approvals marker: it appears the moment an agent asks, from any
 * route; it retires when the request is decided or its window closes; it reads a
 * count for a queue; and it can be reached and opened from the keyboard alone.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectionState } from '@dorkos/shared/types';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';

/** Global stream state the widget reads; mutable so a test can drop the link. */
let mockConnectionState: ConnectionState = 'connected';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: vi.fn(),
    useEventStream: () => ({
      subscribe: vi.fn(),
      connectionState: mockConnectionState,
      failedAttempts: 0,
    }),
  };
});

import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { ApprovalsIndicator } from '../ui/ApprovalsIndicator';

/** Build a pending approval, overriding only what a test cares about. */
function buildApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary: 'Uninstall "sentry-monitor"',
    requestedBy: '/Users/dev/agents/dorkbot',
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    ...overrides,
  };
}

/** Render the marker over a mock transport. */
function renderIndicator(overrides: Partial<Transport> = {}) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return { transport, ...render(<ApprovalsIndicator />, { wrapper: Wrapper }) };
}

describe('ApprovalsIndicator', () => {
  /** Handlers the hook registered, keyed by event name. */
  let handlers: Map<string, (raw: unknown) => void>;

  beforeAll(() => {
    // ResponsivePopover asks matchMedia which shape to take; jsdom has none.
    // `matches: false` puts it on the desktop (popover) branch.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    handlers = new Map();
    mockConnectionState = 'connected';
    vi.mocked(useEventSubscription).mockImplementation((event, handler) => {
      handlers.set(event, handler as (raw: unknown) => void);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows no visible marker while nothing is waiting', async () => {
    renderIndicator({ listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }) });

    await waitFor(() =>
      expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument()
    );
  });

  it('appears the moment approval_pending arrives', async () => {
    renderIndicator({ listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }) });
    await waitFor(() =>
      expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument()
    );

    act(() => handlers.get('approval_pending')?.(buildApproval()));

    const marker = await screen.findByTestId('approvals-indicator');
    expect(marker).toHaveAccessibleName('1 request needs your approval. Open to answer it.');
  });

  it('keeps its live region mounted while quiet, so the arrival is announced', async () => {
    // A live region inserted at the same moment as its text is not reliably read
    // out. The region has to already exist when the count lands.
    renderIndicator({ listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [] }) });

    const announcer = await waitFor(() => screen.getByRole('status'));
    expect(announcer).toBeEmptyDOMElement();

    act(() => handlers.get('approval_pending')?.(buildApproval()));

    await waitFor(() =>
      expect(announcer).toHaveTextContent('1 request needs your approval. Open to answer it.')
    );
  });

  it('reads a count when several agents are waiting at once', async () => {
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [
          buildApproval(),
          buildApproval({ approvalId: '01JZ0000000000000000000002' }),
          buildApproval({ approvalId: '01JZ0000000000000000000003' }),
        ],
      }),
    });

    const marker = await screen.findByTestId('approvals-indicator');
    expect(marker).toHaveAccessibleName('3 requests need your approval. Open to answer them.');
    expect(marker).toHaveTextContent('3');
  });

  it('retires when the request is decided elsewhere', async () => {
    const listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [buildApproval()] });
    renderIndicator({ listPendingApprovals });
    await screen.findByTestId('approvals-indicator');

    // Somebody answered — in this window, another tab, or from the CLI.
    listPendingApprovals.mockResolvedValue({ approvals: [] });
    act(() => handlers.get('approval_resolved')?.({ approvalId: '01JZ0000000000000000000001' }));

    await waitFor(() =>
      expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument()
    );
  });

  it('never shows a request whose window has already closed', async () => {
    // The server excludes these from `listPending`, but a card already on screen
    // when the window closes has to go too — nothing announces an expiry.
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [buildApproval({ expiresAt: new Date(Date.now() - 1000).toISOString() })],
      }),
    });

    await waitFor(() =>
      expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument()
    );
  });

  it('retires the marker when the window closes while you are looking at it', async () => {
    vi.useFakeTimers();
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({
        approvals: [buildApproval({ expiresAt: new Date(Date.now() + 60_000).toISOString() })],
      }),
    });

    // Let the first read land, then confirm the marker is up.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('approvals-indicator')).toBeInTheDocument();

    // Sit past the deadline with nobody deciding and no agent retrying: the
    // server emits no event here, so the marker has to time itself out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument();
  });

  it('is reachable from the keyboard and opens the cards in place', async () => {
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });
    const marker = await screen.findByTestId('approvals-indicator');

    await userEvent.tab();
    expect(marker).toHaveFocus();

    await userEvent.keyboard('{Enter}');

    // The decision itself is here, not a route away.
    expect(await screen.findByText('Uninstall a marketplace package')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Don't allow" })).toBeInTheDocument();
  });

  it('says so when the list cannot be read, rather than looking like silence', async () => {
    renderIndicator({ listPendingApprovals: vi.fn().mockRejectedValue(new Error('offline')) });

    const marker = await screen.findByTestId('approvals-indicator');
    expect(marker).toHaveAccessibleName('DorkOS could not check for approvals. Open for details.');

    await userEvent.click(marker);
    expect(
      await screen.findByText(/could not check whether anything is waiting/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('stays quiet about a failed read while the link is already known to be down', async () => {
    // A server restart fails the read too. Painting an amber alarm next to the
    // connection item's existing signal would double-report one outage and dilute
    // what this marker means, which is only ever "an agent is blocked".
    mockConnectionState = 'reconnecting';
    renderIndicator({ listPendingApprovals: vi.fn().mockRejectedValue(new Error('offline')) });

    await waitFor(() =>
      expect(screen.queryByTestId('approvals-indicator')).not.toBeInTheDocument()
    );
  });

  it('still shows requests it already knows about when the link drops', async () => {
    // Suppression covers the unknown-state pill only. Cards already read are real
    // and still have to be answerable.
    mockConnectionState = 'disconnected';
    renderIndicator({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
    });

    expect(await screen.findByTestId('approvals-indicator')).toBeInTheDocument();
  });
});
