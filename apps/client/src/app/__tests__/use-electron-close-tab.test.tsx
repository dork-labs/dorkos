/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useAppTabsStore, type AppTab } from '@/layers/shared/model';

// Resolves like the real `useNavigate`; the tab actions reconcile in its
// `.then`, so a mock returning `undefined` would not exercise the real path.
const navigate = vi.fn((_options: { href: string }) => Promise.resolve());
const router = {
  navigate: (options: { href: string }) => navigate(options),
  state: { location: { href: '/' } },
};

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouter: () => router,
}));

import { useElectronCloseTab } from '../use-electron-close-tab';

function setTabs(hrefs: string[], activeIndex = 0): AppTab[] {
  const tabs = hrefs.map((href, index) => ({ id: `tab-${index}`, href }));
  useAppTabsStore.setState({ tabs, activeTabId: tabs[activeIndex]?.id ?? null });
  return tabs;
}

/**
 * Install a desktop bridge that hands back the callback it was given, and
 * reports the answer the way the real preload does: `true` keeps the window,
 * anything else closes it.
 */
function installBridge() {
  const unsubscribe = vi.fn();
  let handler: (() => boolean | void) | null = null;
  const onCloseTab = vi.fn((cb: () => boolean | void) => {
    handler = cb;
    return unsubscribe;
  });
  window.electronAPI = { onCloseTab } as unknown as Window['electronAPI'];
  return { onCloseTab, unsubscribe, fire: () => handler?.() === true };
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

  it('answers synchronously — the shell races the reply and the window wins ties', () => {
    setTabs(['/', '/agents'], 0);
    const bridge = installBridge();
    renderHook(() => useElectronCloseTab());

    // No await anywhere: the answer is known the moment the store write lands.
    expect(bridge.fire()).toBe(true);
  });

  it('does nothing when the desktop half of the contract has not shipped', () => {
    setTabs(['/', '/agents'], 0);
    window.electronAPI = {
      onNavigate: vi.fn(() => vi.fn()),
    } as unknown as Window['electronAPI'];

    expect(() => renderHook(() => useElectronCloseTab())).not.toThrow();
    expect(useAppTabsStore.getState().tabs).toHaveLength(2);
  });

  it('closes the tab you are on, shows the one that took over, and keeps the window', () => {
    setTabs(['/', '/agents', '/tasks'], 1);
    const bridge = installBridge();

    renderHook(() => useElectronCloseTab());
    const handled = bridge.fire();

    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/', '/tasks']);
    expect(navigate).toHaveBeenCalledWith({ href: '/tasks' });
    // `true` is what tells the shell to keep the window open. Answering `void`
    // here would close a tab AND the window on the same keystroke.
    expect(handled).toBe(true);
  });

  it('answers "not handled" on the last tab, so the window closes', () => {
    setTabs(['/session?session=abc'], 0);
    const bridge = installBridge();

    renderHook(() => useElectronCloseTab());
    const handled = bridge.fire();

    expect(handled).toBe(false);
    expect(useAppTabsStore.getState().tabs).toHaveLength(1);
  });

  it('claims the keystroke for the whole life of the shell, not per tab count', () => {
    // The last-tab rule lives in the answer, not in whether we are listening.
    // Gating the subscription on the tab count would state it twice and leave
    // the shell following whichever copy was right.
    setTabs(['/'], 0);
    const bridge = installBridge();
    const { rerender } = renderHook(() => useElectronCloseTab());
    expect(bridge.onCloseTab).toHaveBeenCalledTimes(1);

    useAppTabsStore.getState().openTab('/agents');
    rerender();
    expect(bridge.onCloseTab).toHaveBeenCalledTimes(1);
    expect(bridge.unsubscribe).not.toHaveBeenCalled();

    expect(bridge.fire()).toBe(true);
    expect(useAppTabsStore.getState().tabs).toHaveLength(1);
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
