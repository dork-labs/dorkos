/**
 * The hold that lets an answered capability approval finish saying so.
 *
 * The registry half, in isolation. The card half — that pressing Allow engages
 * this, and that the receipt survives the refetch on the surfaces that draw it
 * — is proven against the real components in `InboxBell.test.tsx` and
 * `PinnedTriageHeader.test.tsx`.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { askExitTransition } from '@/layers/shared/lib';
import { APPROVAL_RECEIPT_SETTLE_MS, discardSettlingApprovals, useApprovalCards } from '../index';
// The two writers stay off the barrel: only the card ever holds or releases an
// approval, and a surface that could reach them from the public API could pin a
// card nobody decided.
import {
  holdDecidedApproval,
  releaseDecidedApproval,
  useHeldApprovalDecision,
} from '../model/settling-approvals';

/** A pending approval, only the fields this file reads. */
function request(id: string, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: id,
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  discardSettlingApprovals();
  vi.useRealTimers();
});

describe('the approval receipt hold', () => {
  it('keeps an answered approval listed after the server drops it', () => {
    const { result, rerender } = renderHook(
      ({ approvals }: { approvals: PendingApproval[] }) => useApprovalCards(approvals),
      { initialProps: { approvals: [request('a-1')] } }
    );

    act(() => holdDecidedApproval(request('a-1'), 'granted'));
    // The refetch: the server no longer calls it pending.
    rerender({ approvals: [] });

    expect(result.current.map((approval) => approval.approvalId)).toEqual(['a-1']);
  });

  it('lets go once the receipt has had its time', () => {
    const { result, rerender } = renderHook(
      ({ approvals }: { approvals: PendingApproval[] }) => useApprovalCards(approvals),
      { initialProps: { approvals: [] as PendingApproval[] } }
    );

    act(() => holdDecidedApproval(request('a-1'), 'denied'));
    rerender({ approvals: [] });
    expect(result.current).toHaveLength(1);

    // A hold that never released would pin a decided card to every surface that
    // draws approvals, forever.
    act(() => {
      vi.advanceTimersByTime(APPROVAL_RECEIPT_SETTLE_MS);
    });
    expect(result.current).toHaveLength(0);
  });

  it('outlasts the hold the card’s own receipt is drawn for', () => {
    // The number this has to beat is not arbitrary: `askExitTransition` holds a
    // decided card's exit back by `RESOLVE_HOLD_S` before it melts, and a
    // registry that let go first would drop the card mid-checkmark. Read off
    // the same curve rather than restated, so retuning the curve cannot leave
    // this passing against a hold that is now too short.
    const holdBeforeMelt = askExitTransition({ decided: true, reducedMotion: false }).delay * 1_000;
    const { result, rerender } = renderHook(
      ({ approvals }: { approvals: PendingApproval[] }) => useApprovalCards(approvals),
      { initialProps: { approvals: [] as PendingApproval[] } }
    );

    act(() => holdDecidedApproval(request('a-1'), 'granted'));
    rerender({ approvals: [] });

    act(() => {
      vi.advanceTimersByTime(holdBeforeMelt);
    });
    expect(result.current).toHaveLength(1);
  });

  it('never draws an approval twice while the server still lists it', () => {
    // The window between pressing Allow and the refetch landing: the request is
    // in BOTH lists. Concatenating blindly would draw two cards for one
    // approval, with two sets of buttons.
    const { result } = renderHook(() => useApprovalCards([request('a-1')]));

    act(() => holdDecidedApproval(request('a-1'), 'granted'));

    expect(result.current).toHaveLength(1);
  });

  it('prefers the server’s copy of an approval it still lists', () => {
    // The held copy is a snapshot from the moment the answer was pressed. While
    // the server still has an opinion, its row is the fresher one.
    const fromServer = request('a-1', { capabilityTitle: 'Renamed since' });
    const { result } = renderHook(() => useApprovalCards([fromServer]));

    act(() => holdDecidedApproval(request('a-1'), 'granted'));

    expect(result.current[0]?.capabilityTitle).toBe('Renamed since');
  });

  it('releases a hold whose answer the server refused', () => {
    const { result, rerender } = renderHook(
      ({ approvals }: { approvals: PendingApproval[] }) => useApprovalCards(approvals),
      { initialProps: { approvals: [] as PendingApproval[] } }
    );

    act(() => holdDecidedApproval(request('a-1'), 'granted'));
    expect(result.current).toHaveLength(1);

    // The server said no. The card goes back to the live list, and a stale hold
    // would draw it a second time from ours.
    act(() => releaseDecidedApproval('a-1'));
    rerender({ approvals: [] });

    expect(result.current).toHaveLength(0);
  });

  it('holds two answers apart', () => {
    const { result } = renderHook(() => useApprovalCards([]));

    act(() => holdDecidedApproval(request('a-1'), 'granted'));
    act(() => holdDecidedApproval(request('a-2'), 'denied'));
    act(() => releaseDecidedApproval('a-1'));

    expect(result.current.map((approval) => approval.approvalId)).toEqual(['a-2']);
  });

  it('gives a re-answered approval a FULL hold, not the leftovers of the first', () => {
    // Allow → server refuses → Allow again. The second hold must run its own
    // full window. Under a registry that releases the entry but leaves the first
    // TIMER armed, that timer fires on the old deadline and deletes the new hold
    // — the receipt vanishes partway through (the DOR-1633 shape).
    const { result, rerender } = renderHook(
      ({ approvals }: { approvals: PendingApproval[] }) => useApprovalCards(approvals),
      { initialProps: { approvals: [] as PendingApproval[] } }
    );

    act(() => holdDecidedApproval(request('a-1'), 'granted'));
    act(() => {
      vi.advanceTimersByTime(APPROVAL_RECEIPT_SETTLE_MS / 2);
    });
    act(() => releaseDecidedApproval('a-1'));
    act(() => holdDecidedApproval(request('a-1'), 'granted'));
    rerender({ approvals: [] });

    // The first hold's deadline passes. The second is only halfway through its
    // own window and must still be drawn.
    act(() => {
      vi.advanceTimersByTime(APPROVAL_RECEIPT_SETTLE_MS / 2);
    });
    expect(result.current).toHaveLength(1);

    // …and it ends on ITS deadline, not late and not never.
    act(() => {
      vi.advanceTimersByTime(APPROVAL_RECEIPT_SETTLE_MS / 2);
    });
    expect(result.current).toHaveLength(0);
  });

  it('keeps the later deadline when the same approval is held twice', () => {
    // Two mounted consumers can both hold the same request — the Inbox popover
    // and the home header are on screen together. Arming a second timer without
    // clearing the first lets timer #1 cut hold #2 short.
    const { result, rerender } = renderHook(
      ({ approvals }: { approvals: PendingApproval[] }) => useApprovalCards(approvals),
      { initialProps: { approvals: [] as PendingApproval[] } }
    );

    act(() => holdDecidedApproval(request('a-1'), 'granted'));
    act(() => {
      vi.advanceTimersByTime(APPROVAL_RECEIPT_SETTLE_MS / 2);
    });
    act(() => holdDecidedApproval(request('a-1'), 'granted'));
    rerender({ approvals: [] });

    act(() => {
      vi.advanceTimersByTime(APPROVAL_RECEIPT_SETTLE_MS / 2);
    });
    expect(result.current).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(APPROVAL_RECEIPT_SETTLE_MS / 2);
    });
    expect(result.current).toHaveLength(0);
  });

  it('leaves no timer behind when a hold is released', () => {
    // A released hold that keeps its timer is a timer with nothing to do but
    // interfere with whatever is holding that id next.
    holdDecidedApproval(request('a-1'), 'granted');
    releaseDecidedApproval('a-1');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind when everything is discarded', () => {
    // This is the whole reason `discardSettlingApprovals` exists: it is the
    // suites' teardown, and a hold that survives it fires inside an unrelated
    // case and deletes whatever that case was holding.
    holdDecidedApproval(request('a-1'), 'granted');
    holdDecidedApproval(request('a-2'), 'denied');

    discardSettlingApprovals();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('hands back the same array while nothing is settling', () => {
    // Identity matters: this sits in the render path of three surfaces, and a
    // fresh array every render would re-run every memo downstream of it.
    const approvals = [request('a-1')];
    const { result, rerender } = renderHook(() => useApprovalCards(approvals));
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(result.current).toBe(approvals);
  });

  it('remembers WHICH answer, so a card drawn from the hold is not answerable', () => {
    // A card drawn from the hold is a fresh mount with no local state. Without
    // the answer travelling with the hold it would draw Allow and Don't allow
    // over a request that is already decided.
    const { result } = renderHook(() => useHeldApprovalDecision('a-1'));
    expect(result.current).toBeUndefined();

    act(() => holdDecidedApproval(request('a-1'), 'denied'));
    expect(result.current).toBe('denied');

    act(() => releaseDecidedApproval('a-1'));
    expect(result.current).toBeUndefined();
  });
});
