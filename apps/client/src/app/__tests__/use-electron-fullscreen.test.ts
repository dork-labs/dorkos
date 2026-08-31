/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup, waitFor, act } from '@testing-library/react';
import { useElectronFullscreen } from '../use-electron-fullscreen';

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('useElectronFullscreen', () => {
  it('is false in the browser/Obsidian, where window.electronAPI is absent', () => {
    const { result } = renderHook(() => useElectronFullscreen());
    expect(result.current).toBe(false);
  });

  it('subscribes to onFullscreenChange on mount and reflects what it delivers', () => {
    const unsubscribe = vi.fn();
    let deliver: (isFullScreen: boolean) => void = () => {};
    const onFullscreenChange = vi.fn((cb: (isFullScreen: boolean) => void) => {
      deliver = cb;
      return unsubscribe;
    });
    window.electronAPI = {
      onFullscreenChange,
      getFullscreenState: vi.fn(() => Promise.resolve(false)),
    } as unknown as Window['electronAPI'];

    const { result } = renderHook(() => useElectronFullscreen());

    expect(onFullscreenChange).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);

    act(() => deliver(true));
    expect(result.current).toBe(true);

    act(() => deliver(false));
    expect(result.current).toBe(false);
  });

  it('recovers the current state on mount via getFullscreenState (a remount after entering fullscreen)', async () => {
    const onFullscreenChange = vi.fn(() => vi.fn());
    const getFullscreenState = vi.fn(() => Promise.resolve(true));
    window.electronAPI = {
      onFullscreenChange,
      getFullscreenState,
    } as unknown as Window['electronAPI'];

    const { result } = renderHook(() => useElectronFullscreen());

    expect(getFullscreenState).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('unsubscribes on unmount', () => {
    const unsubscribe = vi.fn();
    const onFullscreenChange = vi.fn(() => unsubscribe);
    window.electronAPI = {
      onFullscreenChange,
      getFullscreenState: vi.fn(() => Promise.resolve(false)),
    } as unknown as Window['electronAPI'];

    const { unmount } = renderHook(() => useElectronFullscreen());
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
