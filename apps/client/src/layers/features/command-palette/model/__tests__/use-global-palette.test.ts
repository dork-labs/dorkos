/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useGlobalPalette } from '../use-global-palette';

// Mock app store state
const mockState = {
  globalPaletteOpen: false,
  toggleGlobalPalette: vi.fn(),
  setGlobalPaletteOpen: vi.fn(),
  setSettingsOpen: vi.fn(),
  setPulseOpen: vi.fn(),
  setRelayOpen: vi.fn(),
  setMeshOpen: vi.fn(),
};

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: typeof mockState) => unknown) =>
    selector ? selector(mockState) : mockState,
}));

function fireKeydown(key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}) {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        metaKey: modifiers.metaKey ?? false,
        ctrlKey: modifiers.ctrlKey ?? false,
        bubbles: true,
      }),
    );
  });
}

describe('useGlobalPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.globalPaletteOpen = false;
    // Ensure all previous hooks are unmounted so their event listeners are removed
    cleanup();
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

  it('opening the palette closes other dialogs', () => {
    mockState.globalPaletteOpen = false;
    renderHook(() => useGlobalPalette());
    fireKeydown('k', { metaKey: true });

    expect(mockState.setSettingsOpen).toHaveBeenCalledWith(false);
    expect(mockState.setPulseOpen).toHaveBeenCalledWith(false);
    expect(mockState.setRelayOpen).toHaveBeenCalledWith(false);
    expect(mockState.setMeshOpen).toHaveBeenCalledWith(false);
  });

  it('does not close other dialogs when palette is already open (closing it)', () => {
    mockState.globalPaletteOpen = true;
    renderHook(() => useGlobalPalette());
    fireKeydown('k', { metaKey: true });

    expect(mockState.setSettingsOpen).not.toHaveBeenCalled();
    expect(mockState.setPulseOpen).not.toHaveBeenCalled();
    expect(mockState.setRelayOpen).not.toHaveBeenCalled();
    expect(mockState.setMeshOpen).not.toHaveBeenCalled();
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
