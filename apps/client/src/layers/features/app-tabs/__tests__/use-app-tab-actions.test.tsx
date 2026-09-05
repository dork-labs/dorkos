/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useAppTabsStore, type AppTab } from '@/layers/shared/model';
import { enterDesktopShell, leaveDesktopShell } from '@/test-helpers/desktop-shell';

// Resolves like the real `useNavigate`, which returns a promise that settles
// once the navigation (loaders and redirects included) has completed.
const navigate = vi.fn((_options: { href: string }) => Promise.resolve());
let locationHref = '/';

/**
 * Every action type `@tanstack/history` reports, matching the enumerations in
 * `use-dialog-deep-link.test.tsx` and `OnboardingFlow.test.tsx`. `GO` is the
 * one that matters here: it covers any popstate whose delta is not exactly ±1,
 * and leaving it out of this type is what let a multi-step Back slip past the
 * traversal check unnoticed.
 */
type HistoryActionType = 'PUSH' | 'REPLACE' | 'GO' | 'FORWARD' | 'BACK';

const historySubscribers = new Set<(opts: { action: { type: HistoryActionType } }) => void>();

const router = {
  navigate: (options: { href: string }) => navigate(options),
  // The router reports where it actually is, which the actions read after a
  // navigation settles.
  get state() {
    return { location: { href: locationHref } };
  },
  history: {
    subscribe: (cb: (opts: { action: { type: HistoryActionType } }) => void) => {
      historySubscribers.add(cb);
      return () => historySubscribers.delete(cb);
    },
  },
};

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useRouter: () => router,
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { href: locationHref } }),
}));

import { useAppTabActions, NEW_TAB_HREF } from '../model/use-app-tab-actions';
import { useAppTabsSync } from '../model/use-app-tabs-sync';
import { openTabAt } from '../model/tab-navigation';

function setTabs(hrefs: string[], activeIndex = 0): AppTab[] {
  const tabs = hrefs.map((href, index) => ({ id: `tab-${index}`, href }));
  useAppTabsStore.setState({ tabs, activeTabId: tabs[activeIndex]?.id ?? null });
  return tabs;
}

function activeHref(): string | undefined {
  const { tabs, activeTabId } = useAppTabsStore.getState();
  return tabs.find((tab) => tab.id === activeTabId)?.href;
}

beforeEach(() => {
  navigate.mockClear();
  historySubscribers.clear();
  locationHref = '/';
  sessionStorage.clear();
  // Tabs are a desktop-app feature (DOR-568), and `useAppTabsSync` no-ops
  // without the shell. The browser side is proved in `use-app-tab-shortcuts`
  // and `app-shell-slots`; this file is about the mechanics once they are on.
  enterDesktopShell();
});

afterEach(() => {
  cleanup();
  leaveDesktopShell();
});

describe('useAppTabActions', () => {
  it('activating a tab navigates to what that tab holds', () => {
    const tabs = setTabs(['/', '/session?session=abc'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.activate(tabs[1].id);

    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
    expect(navigate).toHaveBeenCalledWith({ href: '/session?session=abc' });
  });

  it('a new tab lands on the dashboard and takes focus', () => {
    setTabs(['/team'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.create();

    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/team', NEW_TAB_HREF]);
    expect(activeHref()).toBe(NEW_TAB_HREF);
    expect(navigate).toHaveBeenCalledWith({ href: NEW_TAB_HREF });
  });

  it('closing the tab you are on shows the one that took over', () => {
    const tabs = setTabs(['/', '/team', '/tasks'], 1);
    const { result } = renderHook(() => useAppTabActions());

    result.current.close(tabs[1].id);

    expect(navigate).toHaveBeenCalledWith({ href: '/tasks' });
  });

  it('closing a background tab does not move you', () => {
    const tabs = setTabs(['/', '/team'], 1);
    const { result } = renderHook(() => useAppTabActions());

    result.current.close(tabs[0].id);

    expect(navigate).toHaveBeenCalledWith({ href: '/team' });
    expect(activeHref()).toBe('/team');
  });

  it('closeActive is a no-op on the last tab, so the window can take Cmd+W', () => {
    setTabs(['/session?session=abc'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.closeActive();

    expect(useAppTabsStore.getState().tabs).toHaveLength(1);
  });

  it('still reports a closed tab when the navigation that follows throws', () => {
    // `closeActive`'s answer decides whether the desktop shell keeps the
    // window. Reporting `false` here would close the window on top of the tab
    // that had already gone.
    setTabs(['/', '/team'], 1);
    const { result } = renderHook(() => useAppTabActions());
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    navigate.mockImplementationOnce(() => {
      throw new Error('router is wedged');
    });

    expect(result.current.closeActive()).toBe(true);
    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/']);

    warn.mockRestore();
  });

  it('indexes tabs from the left, and jumps to the last one', () => {
    setTabs(['/', '/team', '/tasks'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.activateIndex(2);
    expect(activeHref()).toBe('/tasks');

    result.current.activateLast();
    expect(activeHref()).toBe('/tasks');

    result.current.activateIndex(99);
    expect(activeHref()).toBe('/tasks');
  });

  it('steps between tabs and wraps at both ends', () => {
    setTabs(['/', '/team', '/tasks'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.activateRelative(-1);
    expect(activeHref()).toBe('/tasks');

    result.current.activateRelative(1);
    expect(activeHref()).toBe('/');
  });

  it('stepping does nothing with a single tab', () => {
    setTabs(['/'], 0);
    const { result } = renderHook(() => useAppTabActions());

    result.current.activateRelative(1);

    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('useAppTabsSync — how the location changed decides who keeps focus', () => {
  /**
   * Drive one real navigation: the router notifies its history subscribers with
   * the action type, then commits the new location. That order is what the hook
   * relies on, so the test reproduces it rather than calling the store directly.
   */
  function navigateTo(href: string, type: HistoryActionType, rerender: () => void) {
    act(() => {
      for (const subscriber of historySubscribers) subscriber({ action: { type } });
      locationHref = href;
      rerender();
    });
  }

  it('settles rather than ping-pongs after an action navigates', () => {
    const tabs = setTabs(['/', '/team'], 0);
    const { result } = renderHook(() => useAppTabActions());
    result.current.activate(tabs[1].id);

    const sync = renderHook(() => useAppTabsSync());
    navigateTo('/team', 'PUSH', sync.rerender);

    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
  });

  it('returns to the tab you came from on Back', () => {
    const tabs = setTabs(['/session?session=a', '/session?session=b'], 1);
    locationHref = '/session?session=b';
    const { rerender } = renderHook(() => useAppTabsSync());

    navigateTo('/session?session=a', 'BACK', rerender);

    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[0].id);
  });

  it('goes forward again the same way', () => {
    const tabs = setTabs(['/session?session=a', '/session?session=b'], 0);
    locationHref = '/session?session=a';
    const { rerender } = renderHook(() => useAppTabsSync());

    navigateTo('/session?session=b', 'FORWARD', rerender);

    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
  });

  it('lets the active tab adopt a location no tab holds', () => {
    setTabs(['/', '/team'], 1);
    locationHref = '/team';
    const { rerender } = renderHook(() => useAppTabsSync());

    navigateTo('/tasks', 'PUSH', rerender);

    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/', '/tasks']);
  });

  it('keeps you in your tab across a settings open/close cycle', () => {
    // BLOCKER: with a second tab at the same pathname, closing a URL-backed
    // dialog used to teleport focus to it and leave this tab parked on
    // `/?settings=open`, so coming back reopened the dialog.
    const tabs = setTabs(['/', '/'], 1);
    locationHref = '/';
    const { rerender } = renderHook(() => useAppTabsSync());

    navigateTo('/?settings=open', 'PUSH', rerender);
    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);

    navigateTo('/', 'PUSH', rerender);

    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/', '/']);
  });

  it('keeps a tab opened on an agent another tab already shows', async () => {
    // BLOCKER (the headline path): "Open in a new tab" mints a tab on the
    // transient `/session?dir=…`, which the loader redirects to the resolved
    // session. When a sibling already sat there, focus used to snap back to it
    // and the new tab was stranded on an href its own loader redirects away
    // from — a tab that could never do anything again.
    //
    // This is also the case where the redirect lands on the location the router
    // was ALREADY on, so no location change fires and the sync effect never
    // runs. Driven through the real `openTabAt` for exactly that reason: only
    // its post-navigation reconcile can rescue the tab here.
    const resolved = '/session?session=abc&dir=%2Fapi';
    setTabs([resolved], 0);
    locationHref = resolved;
    renderHook(() => useAppTabsSync());

    await act(async () => {
      openTabAt(router, '/session?dir=%2Fapi');
    });

    const tabs = useAppTabsStore.getState().tabs;
    expect(tabs.map((t) => t.href)).toEqual([resolved, resolved]);
    // The tab we opened is the one in front — not the sibling.
    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
  });

  it('adopts a loader redirect that does change the location', () => {
    // The ordinary redirect: the sync effect handles it, rule 3, no sibling
    // involved.
    setTabs(['/'], 0);
    locationHref = '/';
    const { rerender } = renderHook(() => useAppTabsSync());

    act(() => useAppTabsStore.getState().openTab('/session?dir=%2Fapi'));
    navigateTo('/session?session=abc&dir=%2Fapi', 'REPLACE', rerender);

    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual([
      '/',
      '/session?session=abc&dir=%2Fapi',
    ]);
  });

  it('treats a multi-step jump through history as a traversal', () => {
    // The Back button's context menu (or `history.go(-3)`) reports `GO`, not
    // `BACK`. Checking for BACK/FORWARD by name silently dropped these: the tab
    // you were in would overwrite itself with the old location while the tab
    // that legitimately held it sat there, leaving two tabs on one href.
    const tabs = setTabs(['/', '/team', '/tasks'], 2);
    locationHref = '/tasks';
    const { rerender } = renderHook(() => useAppTabsSync());

    navigateTo('/', 'GO', rerender);

    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[0].id);
    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/', '/team', '/tasks']);
  });

  it('treats every non-entry-creating action as a traversal', () => {
    // Defined as "not PUSH or REPLACE" so a future action type cannot quietly
    // fall through to the adopt branch.
    for (const type of ['BACK', 'FORWARD', 'GO'] as const) {
      const tabs = setTabs(['/', '/team'], 1);
      locationHref = '/team';
      const { rerender, unmount } = renderHook(() => useAppTabsSync());
      navigateTo('/', type, rerender);
      expect(useAppTabsStore.getState().activeTabId, type).toBe(tabs[0].id);
      unmount();
      historySubscribers.clear();
    }
  });

  it('does not let a traversal onto an unchanged href leak into the next navigation', () => {
    const tabs = setTabs(['/', '/team'], 1);
    locationHref = '/team';
    const { rerender } = renderHook(() => useAppTabsSync());

    // A Back that lands where we already are commits no location change...
    act(() => {
      for (const subscriber of historySubscribers) subscriber({ action: { type: 'BACK' } });
    });
    // ...so the next ordinary navigation must still be treated as one.
    navigateTo('/', 'PUSH', rerender);

    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/', '/']);
  });

  it('reconciles nothing in a browser, and writes no sessionStorage there', () => {
    // There is no strip in a browser (DOR-568), so there is nothing to keep in
    // step — and a store that never changes never persists.
    leaveDesktopShell();
    const tabs = setTabs(['/', '/team'], 1);
    locationHref = '/team';
    const { rerender } = renderHook(() => useAppTabsSync());
    sessionStorage.clear();

    navigateTo('/tasks', 'PUSH', rerender);

    expect(useAppTabsStore.getState().tabs.map((t) => t.href)).toEqual(['/', '/team']);
    expect(useAppTabsStore.getState().activeTabId).toBe(tabs[1].id);
    expect(sessionStorage.length).toBe(0);
  });
});
