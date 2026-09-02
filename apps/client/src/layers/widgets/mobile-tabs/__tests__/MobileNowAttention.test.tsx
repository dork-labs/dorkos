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
import { renderHook, cleanup, waitFor } from '@testing-library/react';
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
// Off the barrel on purpose — only a card may hold an approval — so the test
// that drives a hold reaches the module directly, exactly as the registry's own
// suite does.
import { holdDecidedApproval } from '@/layers/features/approvals/model/settling-approvals';
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
    discardSettlingApprovals();
    vi.clearAllMocks();
  });

  it('keeps the slot alive for a receipt the server has already stopped listing', async () => {
    // The third surface, and the one where the disappearance is worst: on a
    // phone `nothingToSay` returns `slot: null`, so answering the last approval
    // took the entire zone out of the tree in the frame its receipt would draw
    // (DOR-1411). Seeded defect: revert `shownApprovals` to `approvals` in
    // `nothingToSay` and this reds.
    const { result } = renderNowAttentionSlot([]);

    // Nothing pending and nothing held: the zone does not exist.
    await waitFor(() => expect(result.current.slot).toBeNull());

    await waitFor(() => {
      holdDecidedApproval(buildApproval(), 'granted');
    });

    expect(result.current.slot).not.toBeNull();
  });

  it('does not count a settled receipt as a blockage the Now rows should hide', async () => {
    // `coveredSignalIds` suppresses a Now row because a CARD is already saying
    // the same thing is waiting. A card that has been answered is not waiting,
    // and its signal is gone from the model anyway — covering it would be
    // claiming to hide a row that no longer exists. The ask beside it is
    // untouched, which is what makes this about the receipt and not about the
    // list being empty.
    const { result } = renderNowAttentionSlot([]);
    await waitFor(() => expect(result.current.coveredSignalIds).toHaveLength(1));

    await waitFor(() => {
      holdDecidedApproval(buildApproval(), 'granted');
    });

    expect(result.current.coveredSignalIds).toEqual([interactionSignalId('q-1')]);
    expect(result.current.coveredSignalIds).not.toContain(
      approvalSignalId('01JZ0000000000000000000001')
    );
  });
});
