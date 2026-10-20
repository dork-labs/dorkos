/**
 * The answer-from-anywhere cards at the top of the phone's Home, and the count
 * they hand the Home badge: what is waiting, never what has been answered.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, renderHook, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

import { TransportProvider } from '@/layers/shared/model';
import { discardSettlingApprovals } from '@/layers/features/approvals';
import { usePendingApprovals } from '@/layers/entities/attention';
import { useNowAttentionSlot } from '../ui/MobileNowAttention';

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
    area: null,
    alwaysOffered: false,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
    ...overrides,
  };
}

/** Render the hook over a transport seeded with one approval and one ask. */
function renderNowAttentionSlot(approvals: PendingApproval[] = [buildApproval()]) {
  const transport = createMockTransport({
    listPendingApprovals: vi.fn().mockResolvedValue({ approvals }),
    listPendingInteractions: vi.fn().mockResolvedValue({
      interactions: [
        {
          sessionId: 'session-1',
          cwd: '/projects/meeting-notes',
          interaction: {
            type: 'question',
            id: 'q-1',
            startedAt: Date.now(),
            remainingMs: 600_000,
            timeoutMs: 600_000,
            questions: [],
          },
        },
      ],
    }),
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return renderHook(() => useNowAttentionSlot(), { wrapper: Wrapper });
}

describe('useNowAttentionSlot — the count', () => {
  afterEach(() => {
    cleanup();
    // The hold and the answer behind it are module-level and outlive
    // `cleanup()` by design, so a case that answered something would carry it
    // into the next one.
    discardSettlingApprovals();
    vi.clearAllMocks();
  });

  it('counts every approval and every question waiting', async () => {
    const { result } = renderNowAttentionSlot();
    await waitFor(() => expect(result.current.count).toBe(2));
    expect(result.current.slot).not.toBeNull();
  });
});

describe('useNowAttentionSlot — the settling hold', () => {
  afterEach(() => {
    cleanup();
    // The hold and the answer behind it are module-level and outlive
    // `cleanup()` by design, so a case that answered something would carry it
    // into the next one.
    discardSettlingApprovals();
    vi.clearAllMocks();
  });

  /**
   * The cards as the phone's Home tab mounts them, plus a probe for what the
   * SERVER still reports.
   *
   * Rendered rather than inspected as a value, and answered by clicking a real
   * button, because everything this suite is about happens between the click
   * and the refetch. The probe reads the same cache entry the slot does, so a
   * test can wait for the queue to be genuinely empty — `toHaveBeenCalledTimes`
   * fires when the fetch starts, before the cache is rewritten.
   */
  function NowAttentionHost() {
    const { slot } = useNowAttentionSlot();
    const { approvals } = usePendingApprovals();
    return (
      <div>
        <span data-testid="pending-approvals">{`pending:${approvals.length}`}</span>
        {slot ?? <span data-testid="no-slot" />}
      </div>
    );
  }

  /** Mount that host over a transport whose grant drains the pending list. */
  function renderHost() {
    const listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [buildApproval()] });
    const transport = createMockTransport({
      listPendingApprovals,
      listPendingInteractions: vi.fn().mockResolvedValue({ interactions: [] }),
      grantApproval: vi.fn().mockImplementation(async () => {
        // The server has recorded the answer, so the pending list comes back
        // empty on the invalidation that follows.
        listPendingApprovals.mockResolvedValue({ approvals: [] });
        return { ok: true, approvalId: '01JZ0000000000000000000001', outcome: 'granted' };
      }),
    });
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <TransportProvider transport={transport}>
          <NowAttentionHost />
        </TransportProvider>
      </QueryClientProvider>
    );
  }

  it('keeps the cards alive for a receipt the server has already stopped listing', async () => {
    // The third surface, and the one where the disappearance is worst: on a
    // phone `nothingToSay` returns `slot: null`, so answering the last approval
    // took the whole block out of the tree in the frame its receipt would draw
    // (DOR-1411). Seeded defect: revert `shownApprovals` to `approvals` in
    // `nothingToSay` and this reds.
    renderHost();

    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));

    // The drain has LANDED, not merely been asked for.
    await screen.findByText('pending:0');

    expect(screen.getByText('Allowed once')).toBeInTheDocument();
    expect(screen.queryByTestId('no-slot')).not.toBeInTheDocument();
  });

  it('does not count a settled receipt as something waiting', async () => {
    // The Home badge reads this count. A card that has been answered is not
    // waiting on anybody, so a badge that kept counting it would ask for a look
    // at something already done.
    const counts: number[] = [];
    function CountProbe() {
      counts.push(useNowAttentionSlot().count);
      return null;
    }
    const listPendingApprovals = vi.fn().mockResolvedValue({ approvals: [buildApproval()] });
    const transport = createMockTransport({
      listPendingApprovals,
      listPendingInteractions: vi.fn().mockResolvedValue({ interactions: [] }),
      grantApproval: vi.fn().mockImplementation(async () => {
        listPendingApprovals.mockResolvedValue({ approvals: [] });
        return { ok: true, approvalId: '01JZ0000000000000000000001', outcome: 'granted' };
      }),
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
      >
        <TransportProvider transport={transport}>
          <NowAttentionHost />
          <CountProbe />
        </TransportProvider>
      </QueryClientProvider>
    );

    await waitFor(() => expect(counts.at(-1)).toBe(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await screen.findByText('pending:0');

    // The receipt is still drawn…
    expect(screen.getByText('Allowed once')).toBeInTheDocument();
    // …and it counts for nothing.
    expect(counts.at(-1)).toBe(0);
  });
});
