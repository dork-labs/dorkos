/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('desktop-darwin', 'window-blurred');
});

describe('useWindowFocusDimming', () => {
  it('does nothing outside the macOS desktop shell (isDesktopDarwin false)', async () => {
    vi.resetModules();
    const { useWindowFocusDimming } = await import('../use-window-focus-dimming');

    renderHook(() => useWindowFocusDimming());
    window.dispatchEvent(new Event('blur'));

    expect(document.documentElement.classList.contains('window-blurred')).toBe(false);
  });

  it('adds window-blurred on blur and removes it on focus, gated on desktop-darwin', async () => {
    document.documentElement.classList.add('desktop-darwin');
    vi.resetModules();
    const { useWindowFocusDimming } = await import('../use-window-focus-dimming');

    renderHook(() => useWindowFocusDimming());

    window.dispatchEvent(new Event('blur'));
    expect(document.documentElement.classList.contains('window-blurred')).toBe(true);

    window.dispatchEvent(new Event('focus'));
    expect(document.documentElement.classList.contains('window-blurred')).toBe(false);
  });

  it('clears window-blurred on unmount', async () => {
    document.documentElement.classList.add('desktop-darwin');
    vi.resetModules();
    const { useWindowFocusDimming } = await import('../use-window-focus-dimming');

    const { unmount } = renderHook(() => useWindowFocusDimming());
    window.dispatchEvent(new Event('blur'));
    expect(document.documentElement.classList.contains('window-blurred')).toBe(true);

    unmount();

    expect(document.documentElement.classList.contains('window-blurred')).toBe(false);
  });
});
