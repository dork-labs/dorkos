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
function renderNowAttentionSlot() {
  const transport = createMockTransport({
    listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
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
