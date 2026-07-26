/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useAppTabsStore, type AppTab } from '@/layers/shared/model';

const navigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}));

import { useElectronCloseTab } from '../use-electron-close-tab';

function setTabs(hrefs: string[], activeIndex = 0): AppTab[] {
  const tabs = hrefs.map((href, index) => ({ id: `tab-${index}`, href }));
  useAppTabsStore.setState({ tabs, activeTabId: tabs[activeIndex]?.id ?? null });
  return tabs;
}

/** Install a desktop bridge that hands back the callback it was given. */
function installBridge() {
  const unsubscribe = vi.fn();
  let handler: (() => void) | null = null;
  const onCloseTab = vi.fn((cb: () => void) => {
    handler = cb;
    return unsubscribe;
  });
  window.electronAPI = { onCloseTab } as unknown as Window['electronAPI'];
  return { onCloseTab, unsubscribe, fire: () => handler?.() };
}

beforeEach(() => {
  navigate.mockClear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('useElectronCloseTab', () => {
  it('does nothing in the browser cockpit, where the browser owns Cmd+W', () => {
    setTabs(['/', '/agents'], 0);
    renderHook(() => useElectronCloseTab());
    // No electronAPI at all — the hook must not assume the bridge exists.
    expect(useAppTabsStore.getState().tabs).toHaveLength(2);
  });

  it('does nothing when the desktop half of the contract has not shipped', () => {
    setTabs(['/', '/agents'], 0);
    window.electronAPI = {
      onNavigate: vi.fn(() => vi.fn()),
    } as unknown as Window['electronAPI'];

    expect(() => renderHook(() => useElectronCloseTab())).not.toThrow();
    expect(useAppTabsStore.getState().tabs).toHaveLength(2);
  });

  it('closes the tab you are on and shows the one that took over', () => {
    setTabs(['/', '/agents', '/tasks'], 1);
    const bridge = installBridge();

    renderHook(() => useElectronCloseTab());
    bridge.fire();

    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/', '/tasks']);
    expect(navigate).toHaveBeenCalledWith({ href: '/tasks' });
  });

  it('stays out of the way on the last tab, so the window still closes', () => {
    setTabs(['/session?session=abc'], 0);
    const bridge = installBridge();

    renderHook(() => useElectronCloseTab());

    expect(bridge.onCloseTab).not.toHaveBeenCalled();
  });

  it('claims Cmd+W as soon as a second tab opens, and lets go when it closes', () => {
    setTabs(['/'], 0);
    const bridge = installBridge();
    const { rerender } = renderHook(() => useElectronCloseTab());
    expect(bridge.onCloseTab).not.toHaveBeenCalled();

    useAppTabsStore.getState().openTab('/agents');
    rerender();
    expect(bridge.onCloseTab).toHaveBeenCalledTimes(1);

    bridge.fire();
    rerender();
    expect(useAppTabsStore.getState().tabs).toHaveLength(1);
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', () => {
    setTabs(['/', '/agents'], 0);
    const bridge = installBridge();

    const { unmount } = renderHook(() => useElectronCloseTab());
    expect(bridge.unsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
