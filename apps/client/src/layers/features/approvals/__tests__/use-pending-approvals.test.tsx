/**
 * The pending-approval list stays live off the global event stream (spec
 * `agent-trust` §3.3): `approval_pending` adds a card, `approval_resolved`
 * retires one, and a malformed payload is ignored rather than trusted.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

import { TransportProvider, useEventSubscription } from '@/layers/shared/model';
import { usePendingApprovals } from '../model/use-pending-approvals';

/** Build a pending approval, overriding only what a test cares about. */
function buildApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary: 'Uninstall "sentry-monitor"',
    requestedBy: 'dorkbot',
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
    ...overrides,
  };
}

describe('usePendingApprovals', () => {
  /** Handlers the hook registered, keyed by event name. */
  let handlers: Map<string, (raw: unknown) => void>;

  beforeEach(() => {
    handlers = new Map();
    vi.mocked(useEventSubscription).mockImplementation((event, handler) => {
      handlers.set(event, handler as (raw: unknown) => void);
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  /** Render the hook over a transport whose first read returns `initial`. */
  function renderHookWithApprovals(initial: PendingApproval[]) {
    const listPendingApprovals = vi.fn().mockResolvedValue({ approvals: initial });
    const transport = createMockTransport({ listPendingApprovals });
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
        >
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      );
    }
    return {
      listPendingApprovals,
      ...renderHook(() => usePendingApprovals(), { wrapper: Wrapper }),
    };
  }

  it('subscribes to both approval events', () => {
    renderHookWithApprovals([]);

    expect(useEventSubscription).toHaveBeenCalledWith('approval_pending', expect.any(Function));
    expect(useEventSubscription).toHaveBeenCalledWith('approval_resolved', expect.any(Function));
  });

  it('reads the list once on mount', async () => {
    const { listPendingApprovals, result } = renderHookWithApprovals([buildApproval()]);

    await waitFor(() => expect(result.current.approvals).toHaveLength(1));
    expect(listPendingApprovals).toHaveBeenCalledTimes(1);
  });

  it('adds a card when approval_pending arrives', async () => {
    const { result } = renderHookWithApprovals([]);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => handlers.get('approval_pending')?.(buildApproval()));

    await waitFor(() => expect(result.current.approvals).toHaveLength(1));
    expect(result.current.approvals[0].summary).toBe('Uninstall "sentry-monitor"');
  });

  it('never shows the same approval twice when an event races the fetch', async () => {
    const approval = buildApproval();
    const { result } = renderHookWithApprovals([approval]);
    await waitFor(() => expect(result.current.approvals).toHaveLength(1));

    act(() => handlers.get('approval_pending')?.(approval));

    expect(result.current.approvals).toHaveLength(1);
  });

  it('ignores an approval_pending payload that does not parse', async () => {
    const { result } = renderHookWithApprovals([]);
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => handlers.get('approval_pending')?.({ approvalId: 42 }));

    expect(result.current.approvals).toEqual([]);
  });

  it('re-reads the list when approval_resolved arrives', async () => {
    const { listPendingApprovals, result } = renderHookWithApprovals([buildApproval()]);
    await waitFor(() => expect(result.current.approvals).toHaveLength(1));
    listPendingApprovals.mockResolvedValue({ approvals: [] });

    act(() => handlers.get('approval_resolved')?.({ approvalId: '01JZ0000000000000000000001' }));

    await waitFor(() => expect(result.current.approvals).toEqual([]));
    expect(listPendingApprovals).toHaveBeenCalledTimes(2);
  });
});
