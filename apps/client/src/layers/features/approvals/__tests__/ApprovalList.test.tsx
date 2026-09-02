/**
 * The stack of approval cards, and the cap it is honest about.
 *
 * The cap exists so a long queue is never endless, and the line under it exists
 * so a hidden request is never silent. Both are about REQUESTS — things still
 * waiting for an answer — which stopped being the same thing as "cards" the
 * moment the settling hold began merging answered ones back into this list.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { discardSettlingApprovals, holdDecidedApproval } from '../model/settling-approvals';
import { ApprovalList } from '../ui/ApprovalList';

/** Build the nth pending approval. */
function buildApproval(index: number): PendingApproval {
  return {
    approvalId: `01JZ000000000000000000000${index}`,
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: `Uninstall package ${index}`,
    tier: 'act',
    summary: `Uninstall "package-${index}"`,
    requestedBy: '/Users/dev/agents/dorkbot',
    hasAgentPath: true,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
  };
}

/** Render the list over a mock transport. */
function renderList(approvals: PendingApproval[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={createMockTransport()}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return render(<ApprovalList approvals={approvals} />, { wrapper: Wrapper });
}

/** How many cards are actually drawn. */
function cardCount() {
  return document.querySelectorAll('[data-slot="approval-card"]').length;
}

afterEach(() => {
  cleanup();
  discardSettlingApprovals();
  vi.clearAllMocks();
});

describe('ApprovalList’s cap', () => {
  it('caps a long queue and says how many it is holding back', () => {
    renderList(Array.from({ length: 8 }, (_unused, index) => buildApproval(index)));

    expect(cardCount()).toBe(6);
    expect(
      screen.getByText('2 more requests are waiting. Answer some of these to see them.')
    ).toBeInTheDocument();
  });

  it('keeps a receipt visible instead of spending a cap slot deciding against it', () => {
    // Seven waiting, one answered: six live plus one held is seven cards, and a
    // blind `slice(0, 6)` cut the receipt — the very card the hold exists to
    // keep on screen (DOR-1411 review).
    const approvals = Array.from({ length: 7 }, (_unused, index) => buildApproval(index));
    renderList(approvals);

    act(() => holdDecidedApproval(approvals[0], 'granted'));

    expect(screen.getByText('Allowed')).toBeInTheDocument();
    // Six still-waiting requests, plus the receipt. The receipt is extra, not
    // instead of one of them.
    expect(cardCount()).toBe(7);
  });

  it('counts only what is still waiting in the overflow line', () => {
    // The line is a promise about work left to do. With seven pending and one
    // answered there are six waiting — all six of them drawn — so there is
    // nothing more to see, and saying "1 more request is waiting" would be
    // false. Seeded defect: count `approvals.length` instead of the waiting
    // ones and this reds.
    const approvals = Array.from({ length: 7 }, (_unused, index) => buildApproval(index));
    renderList(approvals);

    act(() => holdDecidedApproval(approvals[0], 'granted'));

    expect(screen.queryByText(/more requests? (is|are) waiting/)).not.toBeInTheDocument();
  });

  it('still reports genuine overflow while a receipt is up', () => {
    // The other direction, so the fix above is not simply "never say anything".
    // Eight pending, one answered: seven waiting, six drawn, one really hidden.
    const approvals = Array.from({ length: 8 }, (_unused, index) => buildApproval(index));
    renderList(approvals);

    act(() => holdDecidedApproval(approvals[0], 'granted'));

    expect(
      screen.getByText('1 more request is waiting. Answer one of these to see it.')
    ).toBeInTheDocument();
  });
});
