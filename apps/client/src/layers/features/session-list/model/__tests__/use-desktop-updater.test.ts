// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDesktopUpdater } from '../use-desktop-updater';

afterEach(() => {
  vi.restoreAllMocks();
  delete window.electronAPI;
});

describe('useDesktopUpdater', () => {
  /** Build a desktop `electronAPI` stub, capturing the status callback so tests can drive events. */
  function stubDesktop(getUpdateStatus = vi.fn().mockResolvedValue(null)) {
    const emitRef: { current?: (status: DesktopUpdateStatus) => void } = {};
    const unsubscribe = vi.fn();
    const restartToUpdate = vi.fn();
    window.electronAPI = {
      onUpdateStatus: (cb: (status: DesktopUpdateStatus) => void) => {
        emitRef.current = cb;
        return unsubscribe;
      },
      restartToUpdate,
      getUpdateStatus,
    } as unknown as ElectronAPI;
    return { emitRef, unsubscribe, restartToUpdate, getUpdateStatus };
  }

  it('reports isDesktop false and never subscribes in the browser', () => {
    const { result } = renderHook(() => useDesktopUpdater());

    expect(result.current.isDesktop).toBe(false);
    expect(result.current.status).toBeNull();
    // restart is a safe no-op when the bridge is absent.
    expect(() => result.current.restart()).not.toThrow();
  });

  it('subscribes to onUpdateStatus and exposes the latest status on desktop', () => {
    const { emitRef, unsubscribe, restartToUpdate } = stubDesktop();

    const { result, unmount } = renderHook(() => useDesktopUpdater());

    expect(result.current.isDesktop).toBe(true);
    expect(result.current.status).toBeNull();

    act(() => emitRef.current?.({ state: 'downloaded', version: '2.0.0' }));
    expect(result.current.status).toEqual({ state: 'downloaded', version: '2.0.0' });

    result.current.restart();
    expect(restartToUpdate).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('replays a downloaded update on mount via getUpdateStatus (macOS close→reopen)', async () => {
    stubDesktop(vi.fn().mockResolvedValue({ state: 'downloaded', version: '2.0.0' }));

    const { result } = renderHook(() => useDesktopUpdater());

    // No live event fired — status is recovered purely from the replay.
    await vi.waitFor(() =>
      expect(result.current.status).toEqual({ state: 'downloaded', version: '2.0.0' })
    );
  });

  it('does not let a transient status clear an already-showing downloaded card', () => {
    const { emitRef } = stubDesktop();

    const { result } = renderHook(() => useDesktopUpdater());

    act(() => emitRef.current?.({ state: 'downloaded', version: '2.0.0' }));
    expect(result.current.status).toEqual({ state: 'downloaded', version: '2.0.0' });

    // A background re-check emits checking → available; neither is actionable
    // and must not blink the card out.
    act(() => emitRef.current?.({ state: 'checking' }));
    act(() => emitRef.current?.({ state: 'available', version: '3.0.0' }));
    expect(result.current.status).toEqual({ state: 'downloaded', version: '2.0.0' });

    // A genuinely newer download progressing may replace it.
    act(() => emitRef.current?.({ state: 'downloading', percent: 10 }));
    expect(result.current.status).toEqual({ state: 'downloading', percent: 10 });
  });
});
