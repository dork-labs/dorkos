/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useAppStore } from '@/layers/shared/model';

import { useGlobalPalette } from '../use-global-palette';

// Everything here runs on the REAL app store and the real deep-link hooks
// (their embedded, router-less branch). Each case asserts where the palette
// and the two dialogs ended up, so a toggle that stops toggling, or a `close()`
// that stops clearing its store flag (DOR-839), turns a case red. A faked store
// could only report that a function was called.
function fireKeydown(key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}) {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        metaKey: modifiers.metaKey ?? false,
        ctrlKey: modifiers.ctrlKey ?? false,
        bubbles: true,
      })
    );
  });
}

function state() {
  return useAppStore.getState();
}

describe('useGlobalPalette', () => {
  beforeEach(() => {
    // Ensure all previous hooks are unmounted so their event listeners are removed
    cleanup();
    useAppStore.setState({ globalPaletteOpen: false, settingsOpen: false });
    useAppStore.getState().setTasksOpen(false);
  });

  it('returns the store’s palette flag and its two actions', () => {
    const { result } = renderHook(() => useGlobalPalette());
    expect(result.current.globalPaletteOpen).toBe(false);

    act(() => result.current.setGlobalPaletteOpen(true));
    expect(result.current.globalPaletteOpen).toBe(true);
    act(() => result.current.toggleGlobalPalette());
    expect(result.current.globalPaletteOpen).toBe(false);
  });

  it('Cmd+K opens the palette and the next Cmd+K closes it', () => {
    renderHook(() => useGlobalPalette());
    fireKeydown('k', { metaKey: true });
    expect(state().globalPaletteOpen).toBe(true);
    fireKeydown('k', { metaKey: true });
    expect(state().globalPaletteOpen).toBe(false);
  });

  it('Ctrl+K opens the palette (non-Mac)', () => {
    renderHook(() => useGlobalPalette());
    fireKeydown('k', { ctrlKey: true });
    expect(state().globalPaletteOpen).toBe(true);
  });

  it('other key combos are ignored', () => {
    renderHook(() => useGlobalPalette());
    fireKeydown('j', { metaKey: true });
    fireKeydown('k'); // no modifier
    fireKeydown('p', { metaKey: true });
    expect(state().globalPaletteOpen).toBe(false);
  });

  // The behaviour DOR-839 made deliberate: `close()` owns the store flag as well
  // as the URL, so Cmd+K dismisses a Settings or Tasks dialog opened from the
  // sidebar, not only a deep-linked one. The router-present branch (a close()
  // reverting to URL-only) is pinned by use-dialog-deep-link.test.tsx and the
  // replay-setup test, which run against a real router.
  it('opening the palette closes a Settings and a Tasks dialog the store opened', () => {
    state().setSettingsOpen(true);
    state().setTasksOpen(true);

    renderHook(() => useGlobalPalette());
    fireKeydown('k', { metaKey: true });

    expect(state().globalPaletteOpen).toBe(true);
    expect(state().settingsOpen).toBe(false);
    expect(state().tasksOpen).toBe(false);
  });

  it('closing the palette leaves the dialogs alone', () => {
    useAppStore.setState({ globalPaletteOpen: true });
    state().setSettingsOpen(true);
    state().setTasksOpen(true);

    renderHook(() => useGlobalPalette());
    fireKeydown('k', { metaKey: true });

    expect(state().globalPaletteOpen).toBe(false);
    expect(state().settingsOpen).toBe(true);
    expect(state().tasksOpen).toBe(true);
  });

  it('stops listening on unmount', () => {
    const { unmount } = renderHook(() => useGlobalPalette());

    unmount();
    fireKeydown('k', { metaKey: true });
    expect(state().globalPaletteOpen).toBe(false);
  });
});
