/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TransportProvider } from '@/layers/shared/model';
import { CONTEXT_WARNING_PERCENT } from '@/layers/entities/session';
import { createMockTransport } from '@dorkos/test-utils';
import {
  shouldShowCompactionChip,
  useCompactionChip,
  COMPACTION_PENDING_RESET_MS,
} from '../use-compaction-chip';

const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: (message: string) => toastError(message),
  },
}));

describe('shouldShowCompactionChip', () => {
  // The DOR-112 spec: "usage fraction >= 0.8" — asserted here as the exact
  // percent boundary, since the hook and the copy both work in whole percent.
  // The chip now shares the one threshold source (CONTEXT_WARNING_PERCENT), so
  // this pins the shared constant the hook gates on.
  it('gates on the shared near-full threshold (80)', () => {
    expect(CONTEXT_WARNING_PERCENT).toBe(80);
  });

  it('hides when percent is unknown (null)', () => {
    expect(
      shouldShowCompactionChip({ percent: null, compactSupported: true, isStreaming: false })
    ).toBe(false);
  });

  it('hides below the threshold', () => {
    expect(
      shouldShowCompactionChip({ percent: 79, compactSupported: true, isStreaming: false })
    ).toBe(false);
  });

  it('shows right at the threshold', () => {
    expect(
      shouldShowCompactionChip({ percent: 80, compactSupported: true, isStreaming: false })
    ).toBe(true);
  });

  it('shows above the threshold when supported and idle', () => {
    expect(
      shouldShowCompactionChip({ percent: 92, compactSupported: true, isStreaming: false })
    ).toBe(true);
  });

  it('hides on an unsupported runtime even over threshold (e.g. Codex)', () => {
    expect(
      shouldShowCompactionChip({ percent: 92, compactSupported: false, isStreaming: false })
    ).toBe(false);
  });

  it('hides while a turn is streaming, even over threshold and supported', () => {
    // Requirement 1: dispatching mid-turn would 409 — hide rather than show
    // and rely on the error toast.
    expect(
      shouldShowCompactionChip({ percent: 92, compactSupported: true, isStreaming: true })
    ).toBe(false);
  });
});

describe('useCompactionChip', () => {
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = createMockTransport();
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <TransportProvider transport={transport}>{children}</TransportProvider>;
  }

  it('is not visible below the threshold', () => {
    const { result } = renderHook(
      () =>
        useCompactionChip({
          sessionId: 's1',
          percent: 50,
          compactSupported: true,
          isStreaming: false,
        }),
      { wrapper }
    );
    expect(result.current.visible).toBe(false);
  });

  it('is visible at/above the threshold when supported and idle, carrying the live percent', () => {
    const { result } = renderHook(
      () =>
        useCompactionChip({
          sessionId: 's1',
          percent: 82,
          compactSupported: true,
          isStreaming: false,
        }),
      { wrapper }
    );
    expect(result.current.visible).toBe(true);
    expect(result.current.percent).toBe(82);
    expect(result.current.pending).toBe(false);
  });

  it('dispatches the compact intent exactly like the palette path on click', async () => {
    const { result } = renderHook(
      () =>
        useCompactionChip({
          sessionId: 's1',
          percent: 85,
          compactSupported: true,
          isStreaming: false,
        }),
      { wrapper }
    );
    act(() => {
      result.current.onCompact();
    });
    await waitFor(() =>
      expect(transport.runCommandIntent).toHaveBeenCalledWith('s1', 'compact', undefined)
    );
  });

  it('marks pending immediately on click, before the dispatch settles', async () => {
    let resolveDispatch!: (value: { sessionId: string }) => void;
    vi.mocked(transport.runCommandIntent).mockReturnValue(
      new Promise((resolve) => {
        resolveDispatch = resolve;
      })
    );
    const { result, rerender } = renderHook(
      (props: { isStreaming: boolean }) =>
        useCompactionChip({
          sessionId: 's1',
          percent: 85,
          compactSupported: true,
          isStreaming: props.isStreaming,
        }),
      { wrapper, initialProps: { isStreaming: false } }
    );

    expect(result.current.pending).toBe(false);
    act(() => {
      result.current.onCompact();
    });
    expect(result.current.pending).toBe(true);

    // The compact turn taking over (isStreaming flips true) hides the chip
    // and clears the local guard — the same signal that hid it, not a bespoke
    // stream listener.
    rerender({ isStreaming: true });
    expect(result.current.visible).toBe(false);
    expect(result.current.pending).toBe(false);

    resolveDispatch({ sessionId: 's1' });
  });

  it('re-enables the chip and toasts on a failed dispatch (e.g. SESSION_LOCKED)', async () => {
    vi.mocked(transport.runCommandIntent).mockRejectedValue({ code: 'SESSION_LOCKED' });
    const { result } = renderHook(
      () =>
        useCompactionChip({
          sessionId: 's1',
          percent: 85,
          compactSupported: true,
          isStreaming: false,
        }),
      { wrapper }
    );

    act(() => {
      result.current.onCompact();
    });
    expect(result.current.pending).toBe(true);

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(toastError).toHaveBeenCalledWith(
      'The agent is busy — try compacting again in a moment.'
    );
    // Still visible (not streaming, still over threshold) — the operator can retry.
    expect(result.current.visible).toBe(true);
  });

  it('shows the generic failure toast for a non-lock error, exactly like the palette path', async () => {
    vi.mocked(transport.runCommandIntent).mockRejectedValue(new Error('network blip'));
    const { result } = renderHook(
      () =>
        useCompactionChip({
          sessionId: 's1',
          percent: 85,
          compactSupported: true,
          isStreaming: false,
        }),
      { wrapper }
    );

    act(() => {
      result.current.onCompact();
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(toastError).toHaveBeenCalledWith("Couldn't compact the conversation.");
  });

  it('ignores a second click while a dispatch is already pending', async () => {
    let resolveDispatch!: (value: { sessionId: string }) => void;
    vi.mocked(transport.runCommandIntent).mockReturnValue(
      new Promise((resolve) => {
        resolveDispatch = resolve;
      })
    );
    const { result } = renderHook(
      () =>
        useCompactionChip({
          sessionId: 's1',
          percent: 85,
          compactSupported: true,
          isStreaming: false,
        }),
      { wrapper }
    );

    act(() => {
      result.current.onCompact();
      result.current.onCompact();
    });
    expect(transport.runCommandIntent).toHaveBeenCalledTimes(1);
    resolveDispatch({ sessionId: 's1' });
  });

  describe('pending watchdog (COMPACTION_PENDING_RESET_MS)', () => {
    // Reconnect-coalescing edge: after a 202, a reconnect can replay the
    // compact turn's turn_start + turn_end in one batch, so React never
    // commits isStreaming === true and the primary reset never fires. The
    // watchdog is the honest fallback — without it the chip spins forever.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('resets pending when no streaming commit ever arrives within the window', async () => {
      const { result } = renderHook(
        () =>
          useCompactionChip({
            sessionId: 's1',
            percent: 85,
            compactSupported: true,
            isStreaming: false,
          }),
        { wrapper }
      );

      act(() => {
        result.current.onCompact();
      });
      // Flush the (successful) dispatch promise — 202 accepted, so the
      // dispatch itself never clears pending.
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.pending).toBe(true);

      // One tick short of the window: still honestly in flight.
      act(() => {
        vi.advanceTimersByTime(COMPACTION_PENDING_RESET_MS - 1);
      });
      expect(result.current.pending).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.pending).toBe(false);
      // The chip is clickable again — the server's lock (409) guards any
      // genuine double-dispatch, so re-enabling is safe.
      expect(result.current.visible).toBe(true);
    });

    it('cancels the watchdog when the streaming commit does arrive', async () => {
      const { result, rerender } = renderHook(
        (props: { isStreaming: boolean }) =>
          useCompactionChip({
            sessionId: 's1',
            percent: 85,
            compactSupported: true,
            isStreaming: props.isStreaming,
          }),
        { wrapper, initialProps: { isStreaming: false } }
      );

      act(() => {
        result.current.onCompact();
      });
      await act(async () => {
        await Promise.resolve();
      });

      // The normal path: the compact turn starts streaming and clears pending.
      rerender({ isStreaming: true });
      expect(result.current.pending).toBe(false);

      // The turn settles; usage stays over threshold so the chip returns.
      // A stale watchdog firing here would be harmless (pending is already
      // false) but must not throw or double-fire — advance past the window
      // to prove the timer was cancelled cleanly.
      rerender({ isStreaming: false });
      act(() => {
        vi.advanceTimersByTime(COMPACTION_PENDING_RESET_MS * 2);
      });
      expect(result.current.pending).toBe(false);
      expect(result.current.visible).toBe(true);
    });
  });
});
