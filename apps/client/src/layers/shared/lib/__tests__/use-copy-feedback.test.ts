// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { toast } from 'sonner';
import { useCopyFeedback } from '../use-copy-feedback';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Stub `navigator.clipboard.writeText` to resolve or reject on demand. */
function stubClipboard(behavior: 'resolve' | 'reject') {
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText:
        behavior === 'resolve'
          ? vi.fn().mockResolvedValue(undefined)
          : vi.fn().mockRejectedValue(new Error('denied')),
    },
    writable: true,
    configurable: true,
  });
}

describe('useCopyFeedback', () => {
  it('starts idle: copied and failed both false', () => {
    stubClipboard('resolve');
    const { result } = renderHook(() => useCopyFeedback());
    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBe(false);
  });

  it('sets copied true after a successful copy', async () => {
    stubClipboard('resolve');
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => {
      await result.current.copy('hello');
    });

    expect(result.current.copied).toBe(true);
    expect(result.current.failed).toBe(false);
  });

  it('awaits the clipboard write', async () => {
    stubClipboard('resolve');
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => {
      await result.current.copy('some text');
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('some text');
  });

  it('sets failed true, not copied, when the clipboard write throws', async () => {
    stubClipboard('reject');
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => {
      await result.current.copy('hello');
    });

    expect(result.current.copied).toBe(false);
    expect(result.current.failed).toBe(true);
  });

  it('never rejects — a clipboard failure is reported through state, not a throw', async () => {
    stubClipboard('reject');
    const { result } = renderHook(() => useCopyFeedback());

    await expect(result.current.copy('hello')).resolves.toBe(false);
  });

  it('resolves true on success and false on failure, for a caller that needs the outcome directly', async () => {
    stubClipboard('resolve');
    const { result: ok } = renderHook(() => useCopyFeedback());
    await expect(ok.current.copy('hello')).resolves.toBe(true);

    stubClipboard('reject');
    const { result: bad } = renderHook(() => useCopyFeedback());
    await expect(bad.current.copy('hello')).resolves.toBe(false);
  });

  it('reverts copied to false after the timeout', async () => {
    stubClipboard('resolve');
    const { result } = renderHook(() => useCopyFeedback({ timeoutMs: 1500 }));

    await act(async () => {
      await result.current.copy('hello');
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current.copied).toBe(false);
  });

  it('reverts failed to false after the timeout', async () => {
    stubClipboard('reject');
    const { result } = renderHook(() => useCopyFeedback({ timeoutMs: 1500 }));

    await act(async () => {
      await result.current.copy('hello');
    });
    expect(result.current.failed).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(result.current.failed).toBe(false);
  });

  it('respects a custom timeout duration', async () => {
    stubClipboard('resolve');
    const { result } = renderHook(() => useCopyFeedback({ timeoutMs: 500 }));

    await act(async () => {
      await result.current.copy('hello');
    });

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.copied).toBe(false);
  });

  it('defaults to no toast', async () => {
    stubClipboard('resolve');
    const { result } = renderHook(() => useCopyFeedback());

    await act(async () => {
      await result.current.copy('hello');
    });

    expect(toast.success).not.toHaveBeenCalled();
  });

  it('fires a success toast when toastOnSettle is set', async () => {
    stubClipboard('resolve');
    const { result } = renderHook(() => useCopyFeedback({ toastOnSettle: true }));

    await act(async () => {
      await result.current.copy('hello');
    });

    expect(toast.success).toHaveBeenCalledWith('Copied');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('fires an error toast when toastOnSettle is set and the write fails', async () => {
    stubClipboard('reject');
    const { result } = renderHook(() => useCopyFeedback({ toastOnSettle: true }));

    await act(async () => {
      await result.current.copy('hello');
    });

    expect(toast.error).toHaveBeenCalledWith("Couldn't copy to the clipboard");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not let an earlier copy cut a later one short (successive copies / double-click)', async () => {
    stubClipboard('resolve');
    const { result } = renderHook(() => useCopyFeedback({ timeoutMs: 1000 }));

    await act(async () => {
      await result.current.copy('first');
    });
    expect(result.current.copied).toBe(true);

    // Halfway through the first window, copy again. The second call must get
    // its own full window rather than inherit whatever was left of the
    // first's — without cancelling the first call's timer, this app would
    // watch its own success state flicker off mid-read on a second copy.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {
      await result.current.copy('second');
    });
    expect(result.current.copied).toBe(true);

    // The FIRST call's timer would fire right here (500ms + 500ms = 1000ms
    // since the first copy). Still true proves it was cancelled, not just
    // that both happen to agree.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.copied).toBe(true);

    // The second call's own full window has now elapsed.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.copied).toBe(false);
  });

  it('clears its pending revert timer on unmount', async () => {
    stubClipboard('resolve');
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const { result, unmount } = renderHook(() => useCopyFeedback());

    await act(async () => {
      await result.current.copy('hello');
    });
    clearTimeoutSpy.mockClear();

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
