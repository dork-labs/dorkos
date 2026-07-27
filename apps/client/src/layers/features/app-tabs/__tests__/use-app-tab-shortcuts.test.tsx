/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useAppTabsStore, type AppTab } from '@/layers/shared/model';
import { SHORTCUTS } from '@/layers/shared/lib';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';

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

import { useAppTabShortcuts } from '../model/use-app-tab-shortcuts';
import { NEW_TAB_HREF } from '../model/use-app-tab-actions';

function setTabs(hrefs: string[], activeIndex = 0): AppTab[] {
  const tabs = hrefs.map((href, index) => ({ id: `tab-${index}`, href }));
  useAppTabsStore.setState({ tabs, activeTabId: tabs[activeIndex]?.id ?? null });
  return tabs;
}

function activeHref(): string | undefined {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  return tabs.find((tab) => tab.id === activeTabId)?.href;
}

/** Dispatch a keydown the way a real keyboard would, `code` included. */
function press(init: KeyboardEventInit & { code: string }): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  navigate.mockClear();
  sessionStorage.clear();
  // These chords are a desktop-app feature; the browser case is its own block
  // at the bottom of this file.
  enterDesktopShell();
});

afterEach(() => {
  cleanup();
  leaveDesktopShell();
});

describe('useAppTabShortcuts', () => {
  it('opens a new tab on the dashboard', () => {
    setTabs(['/agents'], 0);
    renderHook(() => useAppTabShortcuts());

    expect(press({ key: 't', code: 'KeyT', metaKey: true })).toBe(true);

    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/agents', NEW_TAB_HREF]);
    expect(navigate).toHaveBeenCalledWith({ href: NEW_TAB_HREF });
  });

  it('works with Ctrl as well as Cmd', () => {
    setTabs(['/agents'], 0);
    renderHook(() => useAppTabShortcuts());

    press({ key: 't', code: 'KeyT', ctrlKey: true });

    expect(useAppTabsStore.getState().tabs).toHaveLength(2);
  });

  it('leaves plain and Alt-modified keys alone', () => {
    setTabs(['/agents'], 0);
    renderHook(() => useAppTabShortcuts());

    expect(press({ key: 't', code: 'KeyT' })).toBe(false);
    expect(press({ key: 't', code: 'KeyT', metaKey: true, altKey: true })).toBe(false);
    expect(useAppTabsStore.getState().tabs).toHaveLength(1);
  });

  it('jumps to a tab by number', () => {
    setTabs(['/', '/agents', '/tasks'], 0);
    renderHook(() => useAppTabShortcuts());

    press({ key: '2', code: 'Digit2', metaKey: true });

    expect(activeHref()).toBe('/agents');
  });

  it('treats 9 as the last tab, however many there are', () => {
    setTabs(['/', '/agents', '/tasks'], 0);
    renderHook(() => useAppTabShortcuts());

    press({ key: '9', code: 'Digit9', metaKey: true });

    expect(activeHref()).toBe('/tasks');
  });

  it('does nothing for a number past the end of the strip', () => {
    setTabs(['/', '/agents'], 0);
    renderHook(() => useAppTabShortcuts());

    press({ key: '5', code: 'Digit5', metaKey: true });

    expect(activeHref()).toBe('/');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('steps right and left, wrapping at both ends', () => {
    setTabs(['/', '/agents', '/tasks'], 0);
    renderHook(() => useAppTabShortcuts());

    // Shift+[ and Shift+] produce `{`/`}`, so the handler matches on `code`.
    press({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true });
    expect(activeHref()).toBe('/tasks');

    press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true });
    expect(activeHref()).toBe('/');
  });

  it('ignores a shifted key that is not a bracket', () => {
    setTabs(['/', '/agents'], 0);
    renderHook(() => useAppTabShortcuts());

    expect(press({ key: 'T', code: 'KeyT', metaKey: true, shiftKey: true })).toBe(false);
    expect(useAppTabsStore.getState().tabs).toHaveLength(2);
  });

  it('stops listening once the shell unmounts', () => {
    setTabs(['/agents'], 0);
    const { unmount } = renderHook(() => useAppTabShortcuts());
    unmount();

    press({ key: 't', code: 'KeyT', metaKey: true });

    expect(useAppTabsStore.getState().tabs).toHaveLength(1);
  });

  it('registers everything the shortcuts panel advertises', () => {
    // The panel is a promise; a shortcut listed there and wired nowhere is a lie.
    setTabs(['/', '/agents'], 0);
    renderHook(() => useAppTabShortcuts());

    expect(SHORTCUTS.NEW_TAB.key).toBe('mod+t');
    expect(press({ key: 't', code: 'KeyT', metaKey: true })).toBe(true);

    expect(SHORTCUTS.SELECT_TAB.key).toBe('mod+1-9');
    expect(press({ key: '1', code: 'Digit1', metaKey: true })).toBe(true);

    expect(SHORTCUTS.PREVIOUS_TAB.key).toBe('mod+shift+[');
    expect(press({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true })).toBe(true);

    expect(SHORTCUTS.NEXT_TAB.key).toBe('mod+shift+]');
    expect(press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true })).toBe(true);
  });
});

describe('useAppTabShortcuts in a browser', () => {
  beforeEach(() => {
    leaveDesktopShell();
  });

  it('does not touch the browser’s own tab keys', () => {
    // Cmd/Ctrl+T, Cmd/Ctrl+1-9 and Cmd/Ctrl+Shift+[/] address the BROWSER's
    // tabs here. Cancelling one would break a key the person did not aim at us
    // (DOR-568), so nothing is registered at all — every press comes back
    // uncancelled.
    setTabs(['/', '/agents'], 0);
    renderHook(() => useAppTabShortcuts());

    expect(press({ key: 't', code: 'KeyT', metaKey: true })).toBe(false);
    expect(press({ key: '1', code: 'Digit1', metaKey: true })).toBe(false);
    expect(press({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true })).toBe(false);
    expect(press({ key: '}', code: 'BracketRight', metaKey: true, shiftKey: true })).toBe(false);
  });

  it('leaves the tab set and sessionStorage alone', () => {
    setTabs(['/', '/agents'], 1);
    renderHook(() => useAppTabShortcuts());
    sessionStorage.clear();

    press({ key: 't', code: 'KeyT', metaKey: true });
    press({ key: '1', code: 'Digit1', metaKey: true });

    expect(useAppTabsStore.getState().tabs).toHaveLength(2);
    expect(activeHref()).toBe('/agents');
    expect(navigate).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });
});
