/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useAppTabsStore } from '@/layers/shared/model';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';

const navigate = vi.fn((_options: { href: string }) => Promise.resolve());
const router = {
  navigate: (options: { href: string }) => navigate(options),
  state: { location: { href: '/' } },
};

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouter: () => router,
}));

// `isMac` is a module constant read from `navigator.platform` at load, so the
// platform is switched through the barrel rather than the user agent.
let mockIsMac = true;
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  get isMac() {
    return mockIsMac;
  },
}));

import { useTabHistoryShortcuts } from '../model/use-tab-history-shortcuts';

/** One tab with history `/`, `/team`, `/tasks`, sitting in the middle. */
function setMiddleOfHistory(): void {
  const tab = { id: 'tab-0', href: '/team', history: ['/', '/team', '/tasks'], cursor: 1 };
  useAppTabsStore.setState({ tabs: [tab], activeTabId: tab.id });
}

/** The active tab's href. */
function activeHref(): string | undefined {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  return tabs.find((tab) => tab.id === activeTabId)?.href;
}

/** Dispatch a keydown from `target` (default `document.body`); returns whether it was taken. */
function press(
  init: KeyboardEventInit & { code?: string },
  target: EventTarget = document.body,
  { alreadyHandled = false } = {}
): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (alreadyHandled) event.preventDefault();
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Click a mouse button on `target` (default `document.body`): press and release. */
function click(button: number, target: EventTarget = document.body): void {
  for (const type of ['mousedown', 'mouseup']) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button }));
  }
}

beforeEach(() => {
  navigate.mockClear();
  sessionStorage.clear();
  mockIsMac = true;
  setMiddleOfHistory();
  enterDesktopShell();
});

afterEach(() => {
  cleanup();
  leaveDesktopShell();
  document.body.innerHTML = '';
});

describe('useTabHistoryShortcuts — keys', () => {
  it('Cmd+[ goes back and Cmd+] goes forward on a Mac', () => {
    // Purpose: the headline chords move the active tab and navigate there.
    renderHook(() => useTabHistoryShortcuts());

    expect(press({ key: '[', code: 'BracketLeft', metaKey: true })).toBe(true);
    expect(activeHref()).toBe('/');
    expect(navigate).toHaveBeenLastCalledWith({ href: '/' });

    press({ key: ']', code: 'BracketRight', metaKey: true });
    expect(activeHref()).toBe('/team');
  });

  it('uses Ctrl, not Cmd, off a Mac', () => {
    // Purpose: each platform gets its own modifier, and only that one.
    mockIsMac = false;
    renderHook(() => useTabHistoryShortcuts());

    expect(press({ key: '[', code: 'BracketLeft', metaKey: true })).toBe(false);
    expect(activeHref()).toBe('/team');

    press({ key: '[', code: 'BracketLeft', ctrlKey: true });
    expect(activeHref()).toBe('/');
  });

  it('leaves a key an editor already handled alone', () => {
    // Purpose: CodeMirror's Mod-[ outdent must not also navigate.
    renderHook(() => useTabHistoryShortcuts());

    press({ key: '[', code: 'BracketLeft', metaKey: true }, document.body, {
      alreadyHandled: true,
    });

    expect(activeHref()).toBe('/team');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves a key alone while an IME composition is open', () => {
    // Purpose: a composing keystroke belongs to the input method.
    renderHook(() => useTabHistoryShortcuts());

    expect(press({ key: '[', code: 'BracketLeft', metaKey: true, isComposing: true })).toBe(false);
    expect(activeHref()).toBe('/team');
  });

  it.each(['dialog', 'alertdialog', 'menu'])('does nothing from inside an open %s', (role) => {
    // Purpose: an open overlay owns the keyboard; the page must not move under it.
    renderHook(() => useTabHistoryShortcuts());
    const overlay = document.body.appendChild(document.createElement('div'));
    overlay.setAttribute('role', role);
    const button = overlay.appendChild(document.createElement('button'));

    expect(press({ key: '[', code: 'BracketLeft', metaKey: true }, button)).toBe(false);
    expect(activeHref()).toBe('/team');
  });

  it('leaves Shift+Cmd+[ to the tab-switching shortcut', () => {
    // Purpose: Previous tab and Back must never fire on the same press.
    renderHook(() => useTabHistoryShortcuts());

    expect(press({ key: '{', code: 'BracketLeft', metaKey: true, shiftKey: true })).toBe(false);
    expect(activeHref()).toBe('/team');
  });

  it('takes Alt+Left and Alt+Right off a Mac, but not from a text field', () => {
    // Purpose: Alt+Arrow navigates from the page, never from where you type.
    mockIsMac = false;
    renderHook(() => useTabHistoryShortcuts());
    const textarea = document.body.appendChild(document.createElement('textarea'));

    expect(press({ key: 'ArrowLeft', altKey: true }, textarea)).toBe(false);
    expect(activeHref()).toBe('/team');

    press({ key: 'ArrowLeft', altKey: true });
    expect(activeHref()).toBe('/');
    press({ key: 'ArrowRight', altKey: true });
    expect(activeHref()).toBe('/team');
  });

  it('leaves Option+Left alone on a Mac', () => {
    // Purpose: Option+Arrow is word-jump in every Mac text field.
    renderHook(() => useTabHistoryShortcuts());

    expect(press({ key: 'ArrowLeft', altKey: true })).toBe(false);
    expect(activeHref()).toBe('/team');
  });

  it('still takes Cmd+[ from a plain text field', () => {
    // Purpose: as in a browser, a textarea does nothing with the chord itself.
    renderHook(() => useTabHistoryShortcuts());
    const textarea = document.body.appendChild(document.createElement('textarea'));

    press({ key: '[', code: 'BracketLeft', metaKey: true }, textarea);
    expect(activeHref()).toBe('/');
  });
});

describe('useTabHistoryShortcuts — mouse side buttons', () => {
  it('button 3 goes back and button 4 goes forward', () => {
    // Purpose: the side buttons are the other half of browser habit.
    renderHook(() => useTabHistoryShortcuts());

    click(3);
    expect(activeHref()).toBe('/');
    click(4);
    expect(activeHref()).toBe('/team');
  });

  it('does nothing from inside an open dialog', () => {
    // Purpose: same rule as the keys — the page must not move under an overlay.
    renderHook(() => useTabHistoryShortcuts());
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');

    click(3, dialog);
    expect(activeHref()).toBe('/team');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores the ordinary buttons', () => {
    // Purpose: a left or middle click must never navigate history.
    renderHook(() => useTabHistoryShortcuts());

    click(0);
    click(1);
    expect(activeHref()).toBe('/team');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('useTabHistoryShortcuts — in a browser', () => {
  it('registers nothing, so the browser keeps its own Back', () => {
    // Purpose: outside the desktop app these keys belong to the browser.
    leaveDesktopShell();
    renderHook(() => useTabHistoryShortcuts());

    expect(press({ key: '[', code: 'BracketLeft', metaKey: true })).toBe(false);
    click(3);
    expect(activeHref()).toBe('/team');
    expect(navigate).not.toHaveBeenCalled();
  });
});
