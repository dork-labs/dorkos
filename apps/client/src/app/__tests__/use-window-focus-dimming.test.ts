/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
// A plain string constant, safe as a static import even though the hook
// itself is re-imported dynamically per test below (to pick up a fresh
// `isDesktopDarwin` read after toggling the class) — its value never changes
// across a module reload.
import { WINDOW_BLURRED_CLASS } from '../use-window-focus-dimming';

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('desktop-darwin', WINDOW_BLURRED_CLASS);
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('useWindowFocusDimming', () => {
  it('does nothing outside the macOS desktop shell (isDesktopDarwin false)', async () => {
    vi.resetModules();
    const { useWindowFocusDimming } = await import('../use-window-focus-dimming');
    let deliver: (focused: boolean) => void = () => {};
    window.electronAPI = {
      onFocusChange: vi.fn((cb: (focused: boolean) => void) => {
        deliver = cb;
        return vi.fn();
      }),
      getFocusState: vi.fn(() => Promise.resolve(true)),
    } as unknown as Window['electronAPI'];

    renderHook(() => useWindowFocusDimming());
    act(() => deliver(false));

    expect(document.documentElement.classList.contains(WINDOW_BLURRED_CLASS)).toBe(false);
  });

  it('does nothing when window.electronAPI.onFocusChange is absent (browser/Obsidian)', async () => {
    document.documentElement.classList.add('desktop-darwin');
    vi.resetModules();
    const { useWindowFocusDimming } = await import('../use-window-focus-dimming');

    renderHook(() => useWindowFocusDimming());
    // No electronAPI at all — must not throw, and must not dim.
    expect(document.documentElement.classList.contains(WINDOW_BLURRED_CLASS)).toBe(false);
  });

  it('toggles window-blurred from the main process focus/blur channel, not DOM events (DOR-254 review)', async () => {
    document.documentElement.classList.add('desktop-darwin');
    vi.resetModules();
    const { useWindowFocusDimming } = await import('../use-window-focus-dimming');
    let deliver: (focused: boolean) => void = () => {};
    window.electronAPI = {
      onFocusChange: vi.fn((cb: (focused: boolean) => void) => {
        deliver = cb;
        return vi.fn();
      }),
      getFocusState: vi.fn(() => Promise.resolve(true)),
    } as unknown as Window['electronAPI'];

    renderHook(() => useWindowFocusDimming());

    act(() => deliver(false));
    expect(document.documentElement.classList.contains(WINDOW_BLURRED_CLASS)).toBe(true);

    act(() => deliver(true));
    expect(document.documentElement.classList.contains(WINDOW_BLURRED_CLASS)).toBe(false);

    // A DOM `blur` on the document (what clicking into an iframe fires, with
    // no OS focus change at all) must NOT dim the app — that was the bug.
    act(() => window.dispatchEvent(new Event('blur')));
    expect(document.documentElement.classList.contains(WINDOW_BLURRED_CLASS)).toBe(false);
  });

  it('recovers the current state on mount via getFocusState (a remount while the window lacks focus)', async () => {
    document.documentElement.classList.add('desktop-darwin');
    vi.resetModules();
    const { useWindowFocusDimming } = await import('../use-window-focus-dimming');
    const getFocusState = vi.fn(() => Promise.resolve(false));
    window.electronAPI = {
      onFocusChange: vi.fn(() => vi.fn()),
      getFocusState,
    } as unknown as Window['electronAPI'];

    await act(async () => {
      renderHook(() => useWindowFocusDimming());
      await Promise.resolve();
    });

    expect(getFocusState).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains(WINDOW_BLURRED_CLASS)).toBe(true);
  });

  it('does not let a stale getFocusState reply clobber a live event that arrived first', async () => {
    document.documentElement.classList.add('desktop-darwin');
    vi.resetModules();
    const { useWindowFocusDimming } = await import('../use-window-focus-dimming');
    let deliver: (focused: boolean) => void = () => {};
    let resolveReplay: (focused: boolean) => void = () => {};
    window.electronAPI = {
      onFocusChange: vi.fn((cb: (focused: boolean) => void) => {
        deliver = cb;
        return vi.fn();
      }),
      getFocusState: vi.fn(() => new Promise<boolean>((resolve) => (resolveReplay = resolve))),
    } as unknown as Window['electronAPI'];

    renderHook(() => useWindowFocusDimming());

    // A real blur lands before the replay's answer does.
    act(() => deliver(false));
    expect(document.documentElement.classList.contains(WINDOW_BLURRED_CLASS)).toBe(true);

    // The replay resolves with what was true when it was requested (focused)
    // — now stale. Applying it would wrongly clear the dim.
    await act(async () => resolveReplay(true));
    expect(document.documentElement.classList.contains(WINDOW_BLURRED_CLASS)).toBe(true);
  });

  it('clears window-blurred on unmount', async () => {
    document.documentElement.classList.add('desktop-darwin');
    vi.resetModules();
    const { useWindowFocusDimming } = await import('../use-window-focus-dimming');
    let deliver: (focused: boolean) => void = () => {};
    window.electronAPI = {
      onFocusChange: vi.fn((cb: (focused: boolean) => void) => {
        deliver = cb;
        return vi.fn();
      }),
      getFocusState: vi.fn(() => Promise.resolve(true)),
    } as unknown as Window['electronAPI'];

    const { unmount } = renderHook(() => useWindowFocusDimming());
    act(() => deliver(false));
    expect(document.documentElement.classList.contains(WINDOW_BLURRED_CLASS)).toBe(true);

    unmount();

    expect(document.documentElement.classList.contains(WINDOW_BLURRED_CLASS)).toBe(false);
  });

  it('unsubscribes on unmount', async () => {
    document.documentElement.classList.add('desktop-darwin');
    vi.resetModules();
    const { useWindowFocusDimming } = await import('../use-window-focus-dimming');
    const unsubscribe = vi.fn();
    window.electronAPI = {
      onFocusChange: vi.fn(() => unsubscribe),
      getFocusState: vi.fn(() => Promise.resolve(true)),
    } as unknown as Window['electronAPI'];

    const { unmount } = renderHook(() => useWindowFocusDimming());
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
