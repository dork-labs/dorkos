/**
 * The pending-approval list stays live off the global event stream (spec
 * `agent-trust` §3.3): `approval_pending` adds a card, `approval_resolved`
 * retires one, and a malformed payload is ignored rather than trusted.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useEffect, type ReactNode } from 'react';
import { render, renderHook, cleanup, waitFor, act } from '@testing-library/react';
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
    hasAgentPath: true,
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

  /**
   * Render the hook inside a probe that counts its own commits, so a spin is
   * observable as a number rather than as a hung test. Counted from an effect
   * rather than the render body: mutating anything during render is itself the
   * impurity these rules exist to catch.
   */
  function renderRenderCountingProbe(initial: PendingApproval[]) {
    const transport = createMockTransport({
      listPendingApprovals: vi.fn().mockResolvedValue({ approvals: initial }),
    });
    const onCommit = vi.fn();
    function Probe() {
      usePendingApprovals();
      useEffect(() => {
        onCommit();
      });
      return null;
    }
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <TransportProvider transport={transport}>
          <Probe />
        </TransportProvider>
      </QueryClientProvider>
    );
    return { renderCount: () => onCommit.mock.calls.length };
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

  describe('expiry', () => {
    // Nothing announces an expiry: the server enforces it when a token is
    // presented, so an approval nobody answered and no agent retried produces no
    // event at all. Without these, a dead card sits there looking answerable.
    afterEach(() => {
      vi.useRealTimers();
    });

    it('drops an approval whose window has already closed', async () => {
      const { result } = renderHookWithApprovals([
        buildApproval({ expiresAt: new Date(Date.now() - 1).toISOString() }),
      ]);

      await waitFor(() => expect(result.current.approvals).toEqual([]));
    });

    it('retires each approval as its own window closes, not all at the first one', async () => {
      vi.useFakeTimers();
      const soon = buildApproval({
        approvalId: '01JZ0000000000000000000001',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const later = buildApproval({
        approvalId: '01JZ0000000000000000000002',
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
      });
      const { result } = renderHookWithApprovals([soon, later]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.approvals).toHaveLength(2);

      // Past the first deadline only — the second must survive, which is what
      // proves the timer re-aims instead of clearing the whole list.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(result.current.approvals.map((a) => a.approvalId)).toEqual([
        '01JZ0000000000000000000002',
      ]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(121_000);
      });
      expect(result.current.approvals).toEqual([]);
    });

    it('re-arms when a timer fires early, instead of giving up on expiry', async () => {
      // A clock stepped BACKWARDS (an NTP correction, a manual change) makes the
      // timer fire while the approval is still live. The prune then removes
      // nothing and leaves the cache reference identical — the same property that
      // stops the effect looping also stops it re-running, so without an explicit
      // re-arm no timer is left armed and the card becomes immortal.
      vi.useFakeTimers();
      const start = Date.now();
      const { result } = renderHookWithApprovals([
        buildApproval({ expiresAt: new Date(start + 60_000).toISOString() }),
      ]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.approvals).toHaveLength(1);

      // Fire the armed timer with the clock behind the deadline: 61s of timer
      // time elapses while `Date.now()` only reaches 30s past the start.
      vi.setSystemTime(start + 30_000 - 61_000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(61_000);
      });
      expect(result.current.approvals).toHaveLength(1);

      // Now let the window genuinely close. Before the re-arm this stayed at 1
      // forever, because nothing was left to fire.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(result.current.approvals).toEqual([]);
    });

    it('arms no timer for a deadline further out than setTimeout can express', async () => {
      // `setTimeout` clamps any delay above 2^31-1 ms (about 24.8 days) to 1ms
      // instead of rejecting it. A timer aimed 40 days out therefore fires at
      // once, finds the row still live so the prune reports no change, and the
      // early-fire re-arm above sends it round again a millisecond later — a spin
      // in a widget the app shell mounts on EVERY route. Reachable with a correct
      // server whenever the client clock is weeks behind it.
      //
      // Deliberately on REAL timers: fake timers do not emulate the clamp, so a
      // fake-timer test cannot see this class of bug at all. The idle window is a
      // sample, not a race — a spin renders hundreds of times inside it and a
      // healthy hook renders none, so there is no margin to be flaky about.
      const fortyDaysOut = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
      const { renderCount } = renderRenderCountingProbe([
        buildApproval({ expiresAt: fortyDaysOut }),
      ]);

      await waitFor(() => expect(renderCount()).toBeGreaterThan(1));
      const settled = renderCount();
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(renderCount() - settled).toBeLessThan(5);
    });
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
