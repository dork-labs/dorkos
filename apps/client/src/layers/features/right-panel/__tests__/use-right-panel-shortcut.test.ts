/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useAppStore } from '@/layers/shared/model';
import { useRightPanelShortcut } from '../model/use-right-panel-shortcut';

// The shortcut runs against the REAL app store, so each case asserts where the
// panel ended up. A faked store could only say the toggle was called, which
// stays green when the toggle itself stops opening the panel.
function press(init: KeyboardEventInit) {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
}

function panelOpen(): boolean {
  return useAppStore.getState().rightPanelOpen;
}

describe('useRightPanelShortcut', () => {
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ rightPanelOpen: false, rightPanelLayoutKey: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the panel on Cmd+. and closes it on the next press', () => {
    renderHook(() => useRightPanelShortcut());
    press({ key: '.', metaKey: true });
    expect(panelOpen()).toBe(true);
    press({ key: '.', metaKey: true });
    expect(panelOpen()).toBe(false);
  });

  it('opens the panel on Ctrl+.', () => {
    renderHook(() => useRightPanelShortcut());
    press({ key: '.', ctrlKey: true });
    expect(panelOpen()).toBe(true);
  });

  it('leaves the panel alone for unrelated keys', () => {
    renderHook(() => useRightPanelShortcut());
    press({ key: 'k', metaKey: true });
    expect(panelOpen()).toBe(false);
  });

  it('leaves the panel alone when neither meta nor ctrl is held', () => {
    renderHook(() => useRightPanelShortcut());
    press({ key: '.' });
    expect(panelOpen()).toBe(false);
  });

  it('stops listening on unmount', () => {
    const { unmount } = renderHook(() => useRightPanelShortcut());
    unmount();
    press({ key: '.', metaKey: true });
    expect(panelOpen()).toBe(false);
  });
});
