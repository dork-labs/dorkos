import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

const mockToggleRightPanel = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      toggleRightPanel: mockToggleRightPanel,
    };
    return selector ? selector(state) : state;
  },
}));

import { useRightPanelShortcut } from '../model/use-right-panel-shortcut';

describe('useRightPanelShortcut', () => {
  beforeEach(() => {
    mockToggleRightPanel.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('calls toggleRightPanel on Cmd+.', () => {
    renderHook(() => useRightPanelShortcut());
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true })
      );
    });
    expect(mockToggleRightPanel).toHaveBeenCalledTimes(1);
  });

  it('calls toggleRightPanel on Ctrl+.', () => {
    renderHook(() => useRightPanelShortcut());
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '.', ctrlKey: true, bubbles: true })
      );
    });
    expect(mockToggleRightPanel).toHaveBeenCalledTimes(1);
  });

  it('does not call toggleRightPanel for unrelated keys', () => {
    renderHook(() => useRightPanelShortcut());
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
      );
    });
    expect(mockToggleRightPanel).not.toHaveBeenCalled();
  });

  it('does not call toggleRightPanel when neither meta nor ctrl is held', () => {
    renderHook(() => useRightPanelShortcut());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true }));
    });
    expect(mockToggleRightPanel).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const { unmount } = renderHook(() => useRightPanelShortcut());
    unmount();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: '.', metaKey: true, bubbles: true })
      );
    });
    expect(mockToggleRightPanel).not.toHaveBeenCalled();
  });
});
