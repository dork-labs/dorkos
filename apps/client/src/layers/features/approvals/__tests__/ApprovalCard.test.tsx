/**
 * The card a person answers — and what it says afterwards.
 *
 * The card half of the settling hold. `settling-approvals.test.ts` pins the
 * registry in isolation; this pins that the card actually engages it, that a
 * refused answer really does hand the buttons back, and — the case the whole
 * two-lifetime design exists for — that a card which did NOT itself answer
 * draws the receipt and keeps drawing it once the hold has expired.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  APPROVAL_RECEIPT_SETTLE_MS,
  discardSettlingApprovals,
  holdDecidedApproval,
} from '../model/settling-approvals';
import { ApprovalCard } from '../ui/ApprovalCard';

/** Build a pending approval, overriding only what a test cares about. */
function buildApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary: 'Uninstall "sentry-monitor"',
    requestedBy: '/Users/dev/agents/dorkbot',
    hasAgentPath: true,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    ...overrides,
  };
}

/** Render one card over a mock transport. */
function renderCard(approval: PendingApproval, overrides: Partial<Transport> = {}) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return { transport, ...render(<ApprovalCard approval={approval} />, { wrapper: Wrapper }) };
}

beforeAll(() => {
  // `sonner` toasts on a refused answer and asks for matchMedia on the way.
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

afterEach(() => {
  cleanup();
  // Both halves are module-level and outlive `cleanup()` by design — the hold's
  // timer so it can survive the card being unmounted, and the answer so it can
  // survive the hold. A suite that answered something would otherwise carry it
  // into the next case twice over.
  discardSettlingApprovals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ApprovalCard', () => {
  it('swaps the buttons for a receipt the moment an answer is pressed', async () => {
    // Before the server has said anything: the confirmation is the whole point
    // of answering in place, and it cannot wait for a round trip.
    let settle: () => void = () => {};
    const grantApproval = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ ok: true, outcome: 'granted' });
        })
    );
    renderCard(buildApproval(), { grantApproval });

    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));

    expect(grantApproval).toHaveBeenCalledWith('01JZ0000000000000000000001', undefined);
    expect(screen.getByText('Allowed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    settle();
  });

  it('says which answer it was, not merely that there was one', async () => {
    renderCard(buildApproval(), {
      denyApproval: vi.fn().mockResolvedValue({ ok: true, outcome: 'denied' }),
    });

    await userEvent.click(screen.getByRole('button', { name: "Don't allow" }));

    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
  });

  it('hands the buttons back when the server refuses the answer', async () => {
    // The 403 from the answer guard — usually "somebody else answered first".
    // A checkmark left over a request that is still sitting there answerable is
    // the one thing worse than no confirmation at all. Seeded defect: drop
    // `releaseDecidedApproval` from the error path and this reds, because the
    // recorded answer outlives the hold and nothing else ever erases it.
    //
    // Held open rather than rejected outright, so the optimistic receipt is
    // observable: a mock that rejects on the spot has already been handled by
    // the time the click's `act()` flushes, and the assertion below it could
    // never fail.
    let refuse: () => void = () => {};
    renderCard(buildApproval(), {
      grantApproval: vi.fn().mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            refuse = () => reject(new Error('nope'));
          })
      ),
    });

    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(screen.getByText('Allowed')).toBeInTheDocument();

    refuse();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument());
    expect(screen.queryByText('Allowed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Don't allow" })).toBeInTheDocument();
  });

  it('draws the receipt on a card that did not itself answer', async () => {
    // The discriminating case. This card is a SEPARATE mount from whichever one
    // was clicked — the Inbox popover, the home header and the transcript can
    // all be showing the same request at once, and only one of them holds the
    // click. A card that read a decision of its own would draw two buttons here.
    renderCard(buildApproval());
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();

    act(() => holdDecidedApproval(buildApproval(), 'granted'));

    expect(screen.getByText('Allowed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('keeps that receipt once the hold has expired, rather than reverting to buttons', async () => {
    // The bug this design closes (DOR-1411 review). The hold is a 0.6s window
    // on the LIST; a card can outlive it — the transcript's copy is drawn from
    // the message part, so the refetch never unmounts it. When the answer
    // expired with the hold, that card flashed "Allowed" and then went back to
    // offering Allow, Don't allow and a standing grant on a request that was
    // already decided. The event that would have corrected it
    // (`capability_approval_resolved`) is documented as droppable, so the
    // revert could be permanent.
    renderCard(buildApproval());

    // Fake time is installed BEFORE the hold, not after: `setTimeout` is
    // captured at call time, so a hold armed under real timers is a real timer
    // and no amount of `advanceTimersByTime` will ever fire it. Getting this
    // backwards made an earlier version of this test pass against a build that
    // deleted the answer on expiry — it never reached the expiry at all.
    vi.useFakeTimers();
    act(() => holdDecidedApproval(buildApproval(), 'denied'));
    expect(screen.getByText('Not allowed')).toBeInTheDocument();

    // Well past the hold, and past the card's own exit with it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVAL_RECEIPT_SETTLE_MS * 10);
    });
    vi.useRealTimers();

    expect(screen.getByText('Not allowed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Don't allow" })).not.toBeInTheDocument();
    // The standing-grant offer is the loudest of the three and the easiest to
    // leave behind: it is gated on `!decision`, not on the buttons above it.
    expect(
      screen.queryByRole('button', { name: /stop asking about this/i })
    ).not.toBeInTheDocument();
  });
});
