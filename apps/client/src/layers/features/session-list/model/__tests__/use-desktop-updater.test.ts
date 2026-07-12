// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDesktopUpdater } from '../use-desktop-updater';

afterEach(() => {
  vi.restoreAllMocks();
  delete window.electronAPI;
});

describe('useDesktopUpdater', () => {
  it('reports isDesktop false and never subscribes in the browser', () => {
    const { result } = renderHook(() => useDesktopUpdater());

    expect(result.current.isDesktop).toBe(false);
    expect(result.current.status).toBeNull();
    // restart/check are safe no-ops when the bridge is absent.
    expect(() => result.current.restart()).not.toThrow();
    expect(() => result.current.check()).not.toThrow();
  });

  it('subscribes to onUpdateStatus and exposes the latest status on desktop', () => {
    let emit: ((status: DesktopUpdateStatus) => void) | undefined;
    const unsubscribe = vi.fn();
    const restartToUpdate = vi.fn();
    const checkForUpdates = vi.fn();

    window.electronAPI = {
      onUpdateStatus: (cb: (status: DesktopUpdateStatus) => void) => {
        emit = cb;
        return unsubscribe;
      },
      restartToUpdate,
      checkForUpdates,
    } as unknown as ElectronAPI;

    const { result, unmount } = renderHook(() => useDesktopUpdater());

    expect(result.current.isDesktop).toBe(true);
    expect(result.current.status).toBeNull();

    act(() => emit?.({ state: 'downloaded', version: '2.0.0' }));
    expect(result.current.status).toEqual({ state: 'downloaded', version: '2.0.0' });

    result.current.restart();
    expect(restartToUpdate).toHaveBeenCalledTimes(1);

    result.current.check();
    expect(checkForUpdates).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
