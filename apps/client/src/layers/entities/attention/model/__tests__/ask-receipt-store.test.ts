/**
 * @vitest-environment jsdom
 *
 * DOR-1633: settleAsk's removal timer must be cancellable, or a re-answered
 * Ask can have its second settling hold cut short by the first timer.
 *
 * Real-path edge (traced in the issue): settleAsk(X), server 403,
 * forgetAskReceipt(X), user re-answers, settleAsk(X) again — the FIRST
 * timer fired and removed X early, cutting the second hold to ~900ms.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import {
  clearAskReceipts,
  forgetAskReceipt,
  settleAsk,
  useSettlingAsks,
} from '../ask-receipt-store';

const INTERACTION: PendingInteractionDTO = {
  type: 'approval',
  id: 'tc-1',
  startedAt: Date.parse('2026-08-18T10:00:00.000Z'),
  remainingMs: 600_000,
  toolName: 'Bash',
  input: '{}',
  hasSuggestions: false,
};

const ASK: InteractionPendingEvent = {
  sessionId: 'session-1',
  cwd: '/projects/alpha',
  interaction: INTERACTION,
};

beforeEach(() => {
  vi.useFakeTimers();
  clearAskReceipts();
});

afterEach(() => {
  clearAskReceipts();
  vi.useRealTimers();
});

describe('settleAsk removal timer', () => {
  it('does not remove a re-settled ask early because of a stale first timer', () => {
    const { result } = renderHook(() => useSettlingAsks());

    // First settle, then the server refuses and the caller forgets it.
    act(() => settleAsk(ASK));
    act(() => vi.advanceTimersByTime(300));
    act(() => forgetAskReceipt(ASK.interaction.id));

    // Re-answered: settles again.
    act(() => settleAsk(ASK));

    // 900ms after the SECOND settle (= 1200ms after the first) is exactly
    // when the stale first timer would have fired, pre-fix, and removed the
    // id early even though the second hold has 300ms left to run.
    act(() => vi.advanceTimersByTime(900));
    expect(result.current.some((held) => held.interaction.id === ASK.interaction.id)).toBe(true);

    // The second timer's own deadline: now it is gone.
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.some((held) => held.interaction.id === ASK.interaction.id)).toBe(false);
  });

  it('clearAskReceipts cancels in-flight timers instead of leaking them across tests', () => {
    const { result } = renderHook(() => useSettlingAsks());

    // Deliberately NOT "settle, clear, advance, assert not-held": that shape
    // passes even without cancelling the timer, because clearAskReceipts's
    // own setState already empties `settling` — an uncancelled timer's later
    // removal is then a silent no-op the test would never notice. This
    // mirrors the stale-timer shape above instead, going through
    // clearAskReceipts rather than forgetAskReceipt.
    act(() => settleAsk(ASK));
    act(() => vi.advanceTimersByTime(300));
    act(() => clearAskReceipts());

    // Re-settled after the clear. If the FIRST timer were still scheduled
    // (not cancelled by clearAskReceipts), it fires 900ms from here — the
    // same 1200ms-from-first-settle mark as the stale-timer test above —
    // and removes this second hold ~300ms early.
    act(() => settleAsk(ASK));
    act(() => vi.advanceTimersByTime(900));
    expect(result.current.some((held) => held.interaction.id === ASK.interaction.id)).toBe(true);

    // The second timer's own deadline: now it is gone.
    act(() => vi.advanceTimersByTime(300));
    expect(result.current.some((held) => held.interaction.id === ASK.interaction.id)).toBe(false);
  });

  it('a second settleAsk for the same id before the first timer fires is a no-op', () => {
    const { result } = renderHook(() => useSettlingAsks());

    act(() => settleAsk(ASK));
    act(() => settleAsk(ASK));
    expect(
      result.current.filter((held) => held.interaction.id === ASK.interaction.id)
    ).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1_200));
    expect(result.current).toHaveLength(0);
  });
});
