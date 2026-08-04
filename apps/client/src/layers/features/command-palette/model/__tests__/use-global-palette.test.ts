/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { setPlatformAdapter } from '@/layers/shared/lib';
import { useGlobalPalette } from '../use-global-palette';

// Mock app store state — only the global palette fields are read directly.
// Closing other dialogs flows through the deep-link `close()` actions.
const mockState = {
  globalPaletteOpen: false,
  toggleGlobalPalette: vi.fn(),
  setGlobalPaletteOpen: vi.fn(),
};

// Deep-link `close` spies — useGlobalPalette calls these to dismiss the feature
// dialogs before opening the palette.
const mockCloseSettings = vi.fn();
const mockCloseTasks = vi.fn();

// The palette fields are faked; the two deep-link hooks are the REAL ones,
// wrapped so `close` is still observable. That matters because what `close`
// does is the whole question here: it owns both halves of a dialog's open
// signal now (URL param + store flag, DOR-839), so Cmd+K dismisses a
// store-opened dialog too. A hand-written stub would answer that question by
// assumption. Note the real hooks read the real app store (they import it
// directly, not through this barrel), which is what the assertion below reads.
vi.mock('@/layers/shared/model', async (importActual) => {
  const actual = await importActual<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAppStore: (selector?: (s: typeof mockState) => unknown) =>
      selector ? selector(mockState) : mockState,
    useSettingsDeepLink: () => {
      const real = actual.useSettingsDeepLink();
      return {
        ...real,
        close: () => {
          mockCloseSettings();
          real.close();
        },
      };
    },
    useTasksDeepLink: () => {
      const real = actual.useTasksDeepLink();
      return {
        ...real,
        close: () => {
          mockCloseTasks();
          real.close();
        },
      };
    },
  };
});

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

describe('useGlobalPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.globalPaletteOpen = false;
    // The real deep-link hooks read route state, and there is no RouterProvider
    // here. The embedded adapter is the supported router-less mode: `useSafeSearch`
    // returns an empty search and `useSafeNavigate` returns null, so `close()`
    // takes its store-only branch — which is exactly the half this file asserts on.
    setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
    // Ensure all previous hooks are unmounted so their event listeners are removed
    cleanup();
  });

  afterEach(() => {
    setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
  });

  it('returns globalPaletteOpen, setGlobalPaletteOpen, and toggleGlobalPalette', () => {
    const { result } = renderHook(() => useGlobalPalette());
    expect(result.current.globalPaletteOpen).toBe(false);
    expect(typeof result.current.setGlobalPaletteOpen).toBe('function');
    expect(typeof result.current.toggleGlobalPalette).toBe('function');
  });

  it('Cmd+K toggles the palette', () => {
    renderHook(() => useGlobalPalette());
    fireKeydown('k', { metaKey: true });
    expect(mockState.toggleGlobalPalette).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+K toggles the palette (non-Mac)', () => {
    renderHook(() => useGlobalPalette());
    fireKeydown('k', { ctrlKey: true });
    expect(mockState.toggleGlobalPalette).toHaveBeenCalledTimes(1);
  });

  it('other key combos are ignored', () => {
    renderHook(() => useGlobalPalette());
    fireKeydown('j', { metaKey: true });
    fireKeydown('k'); // no modifier
    fireKeydown('p', { metaKey: true });
    expect(mockState.toggleGlobalPalette).not.toHaveBeenCalled();
  });

  it('opening the palette closes other dialogs via deep-link close', () => {
    mockState.globalPaletteOpen = false;
    renderHook(() => useGlobalPalette());
    fireKeydown('k', { metaKey: true });

    expect(mockCloseSettings).toHaveBeenCalled();
    expect(mockCloseTasks).toHaveBeenCalled();
  });

  // The behaviour change this branch makes deliberate (DOR-839): `close()` owns
  // the store flag as well as the URL, so Cmd+K now dismisses a Settings dialog
  // opened from the sidebar, not only a deep-linked one. This harness runs the
  // embedded (router-less) branch, so what it pins is that THAT branch clears
  // the store flag; the router-present regression (a close() reverting to
  // URL-only) is pinned by use-dialog-deep-link.test.tsx and the replay-setup
  // test, which run against a real router.
  it('opening the palette clears a Settings dialog the store flag opened', async () => {
    const { useAppStore: realAppStore } =
      await vi.importActual<typeof import('@/layers/shared/model')>('@/layers/shared/model');
    realAppStore.getState().setSettingsOpen(true);

    renderHook(() => useGlobalPalette());
    fireKeydown('k', { metaKey: true });

    expect(realAppStore.getState().settingsOpen).toBe(false);
  });

  it('does not close other dialogs when palette is already open (closing it)', () => {
    mockState.globalPaletteOpen = true;
    renderHook(() => useGlobalPalette());
    fireKeydown('k', { metaKey: true });

    expect(mockCloseSettings).not.toHaveBeenCalled();
    expect(mockCloseTasks).not.toHaveBeenCalled();
    // Still toggles
    expect(mockState.toggleGlobalPalette).toHaveBeenCalledTimes(1);
  });

  it('cleans up the event listener on unmount', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const { unmount } = renderHook(() => useGlobalPalette());
    expect(addSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

    unmount();
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function));

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
