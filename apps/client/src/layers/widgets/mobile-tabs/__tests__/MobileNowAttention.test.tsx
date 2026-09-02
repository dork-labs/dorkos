/**
 * `coveredSignalIds` is what the phone's Now zone matches against to suppress
 * a row it is already drawing as a card (DOR-1391, `suppress-covered-now-items.ts`).
 * A hand-spelled copy of the id format that drifts from `deriveAttentionSignals`'s
 * own vocabulary would silently stop suppressing — the row and the card both
 * show, with no test catching it (spec `schedule-approval-experience` §C4
 * review). This pins the ids to the real vocabulary functions, not to a
 * literal string, so a legitimate change to the format still passes here.
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
import { approvalSignalId, interactionSignalId } from '@/layers/entities/attention';
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

describe('useNowAttentionSlot — coveredSignalIds', () => {
  afterEach(() => {
    cleanup();
    // The hold and the answer behind it are module-level and outlive
    // `cleanup()` by design, so a case that answered something would carry it
    // into the next one.
    discardSettlingApprovals();
    vi.clearAllMocks();
  });

  it('spells every covered id through the shared vocabulary, not a hand-written copy', async () => {
    const { result } = renderNowAttentionSlot();

    await waitFor(() => expect(result.current.coveredSignalIds).toHaveLength(2));

    // Built from the SAME functions `deriveAttentionSignals` calls — so a
    // future rename of the format (e.g. `signal-ids.ts` changes its prefix)
    // stays green here, and only a LOCAL hand-spelled drift in
    // `MobileNowAttention.tsx` goes red.
    expect(result.current.coveredSignalIds).toEqual([
      approvalSignalId('01JZ0000000000000000000001'),
      interactionSignalId('q-1'),
    ]);
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
   * The zone as the phone's Home tab mounts it, plus a probe for what the
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

  it('keeps the zone alive for a receipt the server has already stopped listing', async () => {
    // The third surface, and the one where the disappearance is worst: on a
    // phone `nothingToSay` returns `slot: null`, so answering the last approval
    // took the entire zone out of the tree in the frame its receipt would draw
    // (DOR-1411). Seeded defect: revert `shownApprovals` to `approvals` in
    // `nothingToSay` and this reds.
    renderHost();

    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));

    // The drain has LANDED, not merely been asked for.
    await screen.findByText('pending:0');

    expect(screen.getByText('Allowed')).toBeInTheDocument();
    expect(screen.queryByTestId('no-slot')).not.toBeInTheDocument();
  });

  it('does not count a settled receipt as a blockage the Now rows should hide', async () => {
    // `coveredSignalIds` suppresses a Now row because a CARD is already saying
    // the same thing is waiting. A card that has been answered is not waiting,
    // and its signal is gone from the model anyway — covering it would be
    // claiming to hide a row that no longer exists.
    const covered: (readonly string[])[] = [];
    function CoverageProbe() {
      const { coveredSignalIds } = useNowAttentionSlot();
      covered.push(coveredSignalIds);
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
          <CoverageProbe />
        </TransportProvider>
      </QueryClientProvider>
    );

    await waitFor(() => expect(covered.at(-1)).toHaveLength(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await screen.findByText('pending:0');

    // The receipt is still drawn…
    expect(screen.getByText('Allowed')).toBeInTheDocument();
    // …and it covers nothing.
    expect(covered.at(-1)).toEqual([]);
  });
});
